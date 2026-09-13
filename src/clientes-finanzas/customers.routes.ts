/**
 * @file customers.routes.ts
 * @description Gestión de clientes por parte de empleados (ADMIN/RECEPTIONIST).
 *
 * ## Aislamiento multi-tenant
 * Cada handler instancia SqlCustomerRepository(req.db!) con el SqlClient
 * inyectado por tenantMiddleware.
 *
 * ## Modelo
 * - display_name es el campo canónico (antes fullName).
 * - email es opcional: se almacena en customer_contact_methods, no en customers.
 * - Se puede crear un cliente sin email (ej: walk-in con solo nombre y teléfono).
 */

import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authorize } from '../api/middleware/auth.middleware.wrapper.js';
import { requireModule } from '../security/module.middleware.js';
import { ModuleKey } from '../types/enums.js';
import type { AppContainer } from '../container.js';
import type { ContactMethod } from './customer.entities.js';
import { Customer } from './customer.entities.js';
import { Roles } from '../security/roles.js';
import { SqlCustomerRepository } from './sql.customer.repository.js';
import { SqlNumberSequenceRepository } from '../repositories/sql.number-sequence.repository.js';
import { SqlCustomerRateRepository } from './sql.customer-rate.repository.js';
import type { CreateCustomerRateDto } from './customer-rate.repository.js';
import { SqlRateCatalogRepository } from './sql.rate-catalog.repository.js';
import { SqlAuditLogRepository } from '../repositories/audit-log.repository.js';
import { diffFields, recordFieldChangesWithClient } from '../domain/audit.js';
import { SqlResourceRepository } from '../reservas/sql.resource.repository.js';
import { SqlReservationRepository } from '../reservas/sql.reservation.repository.js';
import { SqlStayRepository } from '../pms-estadias/stay.repository.js';
import { SqlCategoryRepository } from '../reservas/sql.category.repository.js';
import { SqlBookableServiceRepository } from '../reservas/sql.bookable-service.repository.js';
import { SqlProductRepository } from '../pos-menu/sql.product.repository.js';
import { ProductNotFoundError } from '../pos-menu/product.service.js';
import { SqlFinancialTransactionRepository } from './sql.financial-transaction.repository.js';
import { SqlBusinessProfileRepository } from '../repositories/sql.business-profile.repository.js';
import { CustomerAccountService } from './customer-account.service.js';
import {
  UpdateCustomerSchema, AssignTagSchema, CreateCustomerRateSchema, RecordPaymentSchema,
} from '../api/schemas/request.schemas.js';
import { CustomerRateConflictError, ResourceNotFoundError, RateCatalogEntryNotFoundError, CategoryNotFoundError, ReservationNotFoundError } from '../domain/errors.js';
import { BookableServiceNotFoundError } from '../reservas/bookable-service.service.js';
import { cuitSchema } from '../api/schemas/common.schemas.js';
import { SqlCustomerTaxProfileRepository } from './sql.customer-tax-profile.repository.js';
import { SqlBillingPolicyRepository } from './sql.billing-policy.repository.js';
import { SqlAfipCredentialsRepository } from '../facturacion/sql.afip-credentials.repository.js';
import { PadronService } from '../facturacion/padron.service.js';
import { SqlInvoiceRepository } from '../facturacion/sql.invoice.repository.js';
import { buildTenantTransactionManager } from '../db/tenant-context.js';

// I9 (23/08/2026, pendientes-2026-08-23.md — verificación de auditoría
// externa): antes solo se auditaba customer_rates de este archivo, nunca
// los campos propios del Cliente (displayName/kind/active/
// enableCurrentAccount) — hueco real confirmado contra el código.
const AUDIT_ENTITY_CUSTOMER = 'customers';

// ---------------------------------------------------------------------------
// Schemas de validación
// ---------------------------------------------------------------------------

const ContactMethodSchema = z.object({
  channel: z.enum(['EMAIL', 'PHONE', 'WHATSAPP']),
  value:   z.string().min(1),
  isPrimary: z.boolean().default(false),
});

/**
 * Creación de cliente.
 * - displayName (o fullName como alias legacy) — obligatorio.
 * - email — atajo opcional: si se provee se convierte en un ContactMethod EMAIL primario.
 * - contactMethods — array completo opcional, prevalece sobre email si ambos presentes.
 */
const CreateCustomerSchema = z.object({
  displayName:    z.string().min(1).optional(),
  fullName:       z.string().min(1).optional(),   // alias legacy
  email:          z.string().email().optional(),
  contactMethods: z.array(ContactMethodSchema).optional(),
}).superRefine((data, ctx) => {
  if (!data.displayName && !data.fullName) {
    ctx.addIssue({ code: 'custom', message: 'displayName es obligatorio', path: ['displayName'] });
  }
});

const CUIT_LIKE_TYPES = new Set(['CUIT', 'CUIL']);

/**
 * Perfil fiscal (customer_tax_profiles, schema v27). `taxIdType` sigue el
 * mismo criterio de texto libre que `business_profile.taxIdType` — sin
 * catálogo cerrado en código, ARCA expone el suyo propio
 * (PadronService.getIvaReceptorTypes). El dígito verificador SÍ se valida
 * cuando el tipo declarado es CUIT/CUIL (cuitSchema, mismo chequeo mod-11
 * que ya usa business_profile) -- otros tipos (DNI, pasaporte extranjero)
 * quedan como texto sin ese chequeo, no tiene sentido aplicárselo.
 */
const AddressInputSchema = z.object({
  line1:      z.string().trim().min(1),
  line2:      z.string().trim().min(1).nullable().optional(),
  city:       z.string().trim().min(1).nullable().optional(),
  state:      z.string().trim().min(1).nullable().optional(),
  postalCode: z.string().trim().min(1).nullable().optional(),
  country:    z.string().trim().length(2).transform((v) => v.toUpperCase()),
});

const UpsertTaxProfileSchema = z.object({
  legalName:    z.string().trim().min(1),
  taxId:        z.string().trim().min(1),
  taxIdType:    z.string().trim().min(1).max(20),
  taxCondition: z.string().trim().min(1).nullable().optional(),
  address:      AddressInputSchema.nullable().optional(),
}).superRefine((data, ctx) => {
  if (!CUIT_LIKE_TYPES.has(data.taxIdType.toUpperCase())) return;
  const result = cuitSchema.safeParse(data.taxId);
  if (!result.success) {
    ctx.addIssue({
      code: 'custom',
      message: result.error.issues[0]?.message ?? 'CUIT/CUIL inválido',
      path: ['taxId'],
    });
    return;
  }
  data.taxId = result.data; // normalizado sin guiones -- lo que se persiste.
});

/** C1-Fase C (23/08/2026) — BillingPolicy por cliente. cycleCustomDays solo tiene sentido con cycleFrequency='custom_days'. */
const UpsertBillingPolicySchema = z.object({
  requiresSenaToConfirm: z.boolean(),
  invoicingScope: z.enum(['per_reservation', 'consolidated']),
  invoicingTrigger: z.enum(['on_completion', 'scheduled']),
  cycleFrequency: z.enum(['weekly', 'monthly', 'custom_days']).nullable().optional(),
  cycleCustomDays: z.number().int().positive().nullable().optional(),
  dueDays: z.number().int().min(0),
}).superRefine((data, ctx) => {
  if (data.cycleFrequency === 'custom_days' && !data.cycleCustomDays) {
    ctx.addIssue({ code: 'custom', message: 'cycleCustomDays es obligatorio con cycleFrequency="custom_days"', path: ['cycleCustomDays'] });
  }
});

const LookupByCuitSchema = z.object({ cuit: cuitSchema });
const LookupByDniSchema = z.object({
  dni: z.string().trim().regex(/^\d{7,8}$/, 'DNI debe tener 7 u 8 dígitos, sin puntos'),
});

// G1 (23/08/2026) — CUIT (11 dígitos) o DNI (7-8), body nunca query string
// (mismo motivo A7.2 que los dos schemas de arriba). Sin regex de longitud
// fija a propósito: busca contra `customer_tax_profiles.tax_id` tal cual
// está cargado, que puede incluir DNIs de clientes extranjeros u otros
// formatos -- una búsqueda que no encuentra nada devuelve `[]`, no un 400.
const SearchByTaxIdSchema = z.object({
  taxId: z.string().trim().min(1).max(50),
});

// A7.2 (23/08/2026, pendientes-2026-08-23.md) — `search` es nombre/email
// tipeado por el usuario, mismo tipo de dato que taxId arriba: nunca en
// query string. Body, mismo criterio. page/limit no son PII, viajan igual
// para no duplicar la llamada.
const SearchCustomersSchema = z.object({
  search: z.string().trim().min(1).max(200),
  currentAccountEnabled: z.boolean().optional(),
  page: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
});

// ---------------------------------------------------------------------------
// DTO de salida
// ---------------------------------------------------------------------------

function toCustomerDto(customer: Customer) {
  return {
    id:          customer.id,
    /** Número operativo (D6, 22/08/2026) — formatear con `businessProfile.customerNumberPrefix` (ej. "CLI-000045"). */
    customerNumber: customer.customerNumber,
    displayName: customer.displayName,
    /** @deprecated usar contactMethods */
    fullName:    customer.displayName,
    email:       customer.email,
    kind:        customer.kind,
    active:      customer.active,
    /** F1-Pieza 1 (23/08/2026) — tipificación para Cuentas Corrientes. */
    enableCurrentAccount: customer.enableCurrentAccount,
    contactMethods: customer.contactMethods.map((cm) => ({
      id:        cm.id,
      channel:   cm.channel,
      value:     cm.value,
      isPrimary: cm.isPrimary,
    })),
  };
}

/**
 * Arma la respuesta de GET /customers y POST /customers/search — con
 * page+limit el envelope paginado (PaginatedResponse<T>), sin ellos el
 * array plano de siempre (compatibilidad hacia atrás, ver K2). Un solo
 * lugar para las dos rutas: la única diferencia entre ellas es DE DÓNDE
 * sale `search` (query string vs. body, A7.2), no qué se hace con él.
 */
async function respondWithCustomerList(
  repo: SqlCustomerRepository,
  filters: { onlyCurrentAccountEnabled: boolean; search?: string; page?: number; limit?: number },
  res: Response,
): Promise<void> {
  if (filters.page !== undefined && filters.limit !== undefined) {
    const { page, limit, ...countFilters } = filters;
    const [customers, total] = await Promise.all([
      repo.getFiltered(filters),
      repo.countFiltered(countFilters),
    ]);
    res.json({
      data: customers.map(toCustomerDto),
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
    return;
  }
  const customers = await repo.getFiltered(filters);
  res.json(customers.map(toCustomerDto));
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createCustomersRouter(container: AppContainer): Router {
  const router = Router();

  // GET /customers/:id
  router.get(
    '/:id',
    authorize(Roles.FRONT_DESK),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const repo = new SqlCustomerRepository(req.db!);
        const id = String(req.params['id']);
        const customer = await repo.getById(id);
        if (!customer) {
          res.status(404).json({ code: 'CUSTOMER_NOT_FOUND', message: 'Cliente no encontrado' });
          return;
        }
        const tags = await repo.getTagsByCustomerId(id);
        res.json({ ...toCustomerDto(customer), tags });
      } catch (err) { next(err); }
    },
  );

  // PATCH /customers/:id — actualiza displayName/kind/active
  router.patch(
    '/:id',
    authorize(Roles.FRONT_DESK),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const repo = new SqlCustomerRepository(req.db!);
        const id = String(req.params['id']);
        const existing = await repo.getById(id);
        if (!existing) {
          res.status(404).json({ code: 'CUSTOMER_NOT_FOUND', message: 'Cliente no encontrado' });
          return;
        }

        const body = UpdateCustomerSchema.parse(req.body);

        // Auditoría (R8/A9.4, I9) — diff contra lo que realmente vino en
        // el body y el estado ANTES de escribir, mismo patrón que
        // resources.routes.ts/CategoryService/ProductService. Las 3
        // escrituras condicionales + el INSERT de auditoría comparten la
        // MISMA transacción (25/08/2026, paso 1 del handoff de RBAC/
        // auditoría) — si alguna falla a mitad de camino, ninguna queda.
        const changes = diffFields(existing, {
          displayName:          body.displayName,
          kind:                 body.kind,
          active:               body.active,
          enableCurrentAccount: body.enableCurrentAccount,
        });

        const auditLogRepo = new SqlAuditLogRepository(req.db!);
        await buildTenantTransactionManager(req).run(async (client) => {
          if (body.displayName !== undefined) {
            const updated = new Customer(
              existing.id,
              body.displayName,
              existing.contactMethods,
              existing.kind,
              existing.active,
              existing.customerNumber,
            );
            await repo.saveEntityWithClient!(client, updated);
          }

          if (body.kind !== undefined || body.active !== undefined) {
            await repo.updateKindAndActiveWithClient!(
              client,
              id,
              body.kind ?? existing.kind,
              body.active ?? existing.active,
            );
          }

          if (body.enableCurrentAccount !== undefined) {
            await repo.setCurrentAccountEnabledWithClient!(client, id, body.enableCurrentAccount);
          }

          if (changes.length > 0) {
            await recordFieldChangesWithClient(client, auditLogRepo, AUDIT_ENTITY_CUSTOMER, id, changes, req.user!.id);
          }
        });

        const refreshed = await repo.getById(id);
        const tags = await repo.getTagsByCustomerId(id);
        res.json({ ...toCustomerDto(refreshed!), tags });
      } catch (err) { next(err); }
    },
  );

  // ── Perfil fiscal (customer_tax_profiles, schema v27) + padrón de ARCA ──
  // Roles.MANAGEMENT en las cinco rutas: mismo criterio de sensibilidad que
  // afip-credentials.repository.ts y business-profile "Datos fiscales" —
  // CUIT/razón social/domicilio de un cliente es un escalón más sensible
  // que el ABM normal de clientes (FRONT_DESK). Todas detrás de
  // requireModule(FACTURACION): customer_tax_profiles existe para
  // facturar, no tiene sentido sin ese módulo habilitado.
  const facturacionGate = requireModule(container, ModuleKey.FACTURACION);

  // GET /customers/:id/tax-profile — null si el cliente todavía no cargó datos fiscales.
  router.get(
    '/:id/tax-profile',
    facturacionGate,
    authorize(Roles.MANAGEMENT),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const profile = await new SqlCustomerTaxProfileRepository(req.db!).getByCustomerId(String(req.params['id']));
        res.json(profile);
      } catch (err) { next(err); }
    },
  );

  // PUT /customers/:id/tax-profile — crea o actualiza (un perfil por cliente, ver docblock de la entidad).
  router.put(
    '/:id/tax-profile',
    facturacionGate,
    authorize(Roles.MANAGEMENT),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const id = String(req.params['id']);
        const repo = new SqlCustomerRepository(req.db!);
        const existing = await repo.getById(id);
        if (!existing) {
          res.status(404).json({ code: 'CUSTOMER_NOT_FOUND', message: 'Cliente no encontrado' });
          return;
        }
        const body = UpsertTaxProfileSchema.parse(req.body);
        const profile = await new SqlCustomerTaxProfileRepository(req.db!).upsert(id, {
          legalName: body.legalName,
          taxId: body.taxId,
          taxIdType: body.taxIdType,
          ...(body.taxCondition !== undefined && { taxCondition: body.taxCondition }),
          ...(body.address !== undefined && {
            address: body.address && {
              line1: body.address.line1,
              line2: body.address.line2 ?? null,
              city: body.address.city ?? null,
              state: body.address.state ?? null,
              postalCode: body.address.postalCode ?? null,
              country: body.address.country,
            },
          }),
        });
        res.json(profile);
      } catch (err) { next(err); }
    },
  );

  // GET /customers/:id/billing-policy — null si el cliente usa la política
  // default (ver docblock de BillingPolicy). C1-Fase C, 23/08/2026.
  router.get(
    '/:id/billing-policy',
    facturacionGate,
    authorize(Roles.MANAGEMENT),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const policy = await new SqlBillingPolicyRepository(req.db!).getByCustomerId(String(req.params['id']));
        res.json(policy);
      } catch (err) { next(err); }
    },
  );

  // PUT /customers/:id/billing-policy — crea o actualiza (una política por cliente).
  router.put(
    '/:id/billing-policy',
    facturacionGate,
    authorize(Roles.MANAGEMENT),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const id = String(req.params['id']);
        const existing = await new SqlCustomerRepository(req.db!).getById(id);
        if (!existing) {
          res.status(404).json({ code: 'CUSTOMER_NOT_FOUND', message: 'Cliente no encontrado' });
          return;
        }
        const body = UpsertBillingPolicySchema.parse(req.body);
        const policy = await new SqlBillingPolicyRepository(req.db!).upsert(id, {
          requiresSenaToConfirm: body.requiresSenaToConfirm,
          invoicingScope: body.invoicingScope,
          invoicingTrigger: body.invoicingTrigger,
          cycleFrequency: body.cycleFrequency ?? null,
          cycleCustomDays: body.cycleCustomDays ?? null,
          dueDays: body.dueDays,
        });
        res.json(policy);
      } catch (err) { next(err); }
    },
  );

  function buildPadronService(req: Request): PadronService {
    return new PadronService(
      new SqlBusinessProfileRepository(req.db!),
      new SqlAfipCredentialsRepository(req.db!),
    );
  }

  // POST /customers/padron/lookup-by-cuit — { cuit } en el body, nunca en
  // la URL (A7.2, criterios-negocio.md: PII nunca en query strings/paths,
  // quedan en logs de acceso y proxies). `null` si el CUIT no existe en
  // el padrón -- no es un error, es una respuesta válida.
  router.post(
    '/padron/lookup-by-cuit',
    facturacionGate,
    authorize(Roles.MANAGEMENT),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { cuit } = LookupByCuitSchema.parse(req.body);
        const result = await buildPadronService(req).getTaxpayerByCuit(cuit);
        res.json(result);
      } catch (err) { next(err); }
    },
  );

  // POST /customers/padron/lookup-by-dni — resuelve el CUIT/CUIL asociado
  // a un DNI (para autocompletar cuando el cliente solo dio el documento).
  router.post(
    '/padron/lookup-by-dni',
    facturacionGate,
    authorize(Roles.MANAGEMENT),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { dni } = LookupByDniSchema.parse(req.body);
        const cuit = await buildPadronService(req).resolveCuitByDni(dni);
        res.json({ cuit });
      } catch (err) { next(err); }
    },
  );

  // GET /customers/padron/iva-receptor-types — catálogo OFICIAL de ARCA,
  // sin PII (no hace falta POST acá). Reemplaza/confirma la lista
  // hardcodeada de afip-catalog.constants.ts ahora que hay certificado
  // real -- ver docblock de ese archivo.
  router.get(
    '/padron/iva-receptor-types',
    facturacionGate,
    authorize(Roles.MANAGEMENT),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const claseCmp = typeof req.query['claseCmp'] === 'string' ? req.query['claseCmp'] : undefined;
        const types = await buildPadronService(req).getIvaReceptorTypes(claseCmp);
        res.json(types);
      } catch (err) { next(err); }
    },
  );

  // POST /customers/:id/tags — find-or-create por nombre + asignar
  router.post(
    '/:id/tags',
    authorize(Roles.FRONT_DESK),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const repo = new SqlCustomerRepository(req.db!);
        const id = String(req.params['id']);
        const existing = await repo.getById(id);
        if (!existing) {
          res.status(404).json({ code: 'CUSTOMER_NOT_FOUND', message: 'Cliente no encontrado' });
          return;
        }

        const { tagName } = AssignTagSchema.parse(req.body);
        const tag = await repo.findOrCreateTagByName(tagName.trim());
        await repo.addTag(id, tag.id);

        const tags = await repo.getTagsByCustomerId(id);
        res.status(201).json({ ...toCustomerDto(existing), tags });
      } catch (err) { next(err); }
    },
  );

  // DELETE /customers/:id/tags/:tagId
  router.delete(
    '/:id/tags/:tagId',
    authorize(Roles.FRONT_DESK),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const repo = new SqlCustomerRepository(req.db!);
        const id = String(req.params['id']);
        await repo.removeTag(id, String(req.params['tagId']));
        res.status(204).send();
      } catch (err) { next(err); }
    },
  );

  // GET /customers?email=...  o  GET /customers?name=...  o
  // GET /customers?currentAccountEnabled=true  o  GET /customers (todos)
  // `search` (nombre O email) YA NO va acá — ver POST /customers/search
  // (A7.2, 23/08/2026: era PII viajando en query string).
  router.get(
    '/',
    authorize(Roles.FRONT_DESK),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const repo = new SqlCustomerRepository(req.db!);
        const { email, name, currentAccountEnabled, page, limit } = req.query;

        if (typeof email === 'string' && email.trim()) {
          const customer = await repo.getByEmail(email.trim());
          res.json(customer ? toCustomerDto(customer) : null);
          return;
        }

        if (typeof name === 'string' && name.trim()) {
          const customers = await repo.searchByName(name.trim());
          res.json(customers.map(toCustomerDto));
          return;
        }

        // F1-Pieza 1 (23/08/2026) — filtro RÍGIDO de base para el panel de
        // Cuentas Corrientes, spec del dueño: "los huéspedes sin este
        // atributo no deben aparecer bajo ninguna circunstancia". El
        // filtro vive en SqlCustomerRepository.getFiltered(), no acá.
        const onlyCurrentAccountEnabled = currentAccountEnabled === 'true';

        // Con page/limit en la query, devuelve el envelope paginado
        // (PaginatedResponse<T>, igual que /api/reservations); sin ellos,
        // el array plano de siempre — la pantalla de Cuentas Corrientes no
        // manda paginación, necesita la lista completa filtrada.
        const filters = typeof page === 'string' && typeof limit === 'string'
          ? { onlyCurrentAccountEnabled, page: Number(page), limit: Number(limit) }
          : { onlyCurrentAccountEnabled };
        await respondWithCustomerList(repo, filters, res);
      } catch (err) { next(err); }
    },
  );

  // POST /customers/search — { search } en el body, nunca en la URL
  // (A7.2: nombre/email tipeado por el usuario es PII, mismo criterio que
  // /search-by-tax-id más abajo). Reemplaza el `?search=` que tenía
  // GET /customers hasta esta sesión (K2, pendientes-2026-08-23.md).
  router.post(
    '/search',
    authorize(Roles.FRONT_DESK),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = SearchCustomersSchema.parse(req.body);
        const repo = new SqlCustomerRepository(req.db!);
        const filters = {
          onlyCurrentAccountEnabled: body.currentAccountEnabled ?? false,
          search: body.search,
          ...(body.page !== undefined && body.limit !== undefined && { page: body.page, limit: body.limit }),
        };
        await respondWithCustomerList(repo, filters, res);
      } catch (err) { next(err); }
    },
  );

  // POST /customers/search-by-tax-id — { taxId } en el body, nunca en la
  // URL (A7.2: el CUIT/DNI es PII, no puede quedar en logs de acceso/
  // proxies -- mismo criterio que /padron/lookup-by-cuit más arriba).
  // Devuelve un array: tax_id no tiene unicidad a nivel de base.
  router.post(
    '/search-by-tax-id',
    authorize(Roles.FRONT_DESK),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { taxId } = SearchByTaxIdSchema.parse(req.body);
        const repo = new SqlCustomerRepository(req.db!);
        const customers = await repo.searchByTaxId(taxId);
        res.json(customers.map(toCustomerDto));
      } catch (err) { next(err); }
    },
  );

  // POST /customers
  router.post(
    '/',
    authorize(Roles.FRONT_DESK),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const repo = new SqlCustomerRepository(req.db!);
        const body = CreateCustomerSchema.parse(req.body);

        const displayName = (body.displayName ?? body.fullName)!;
        const customerId  = randomUUID();

        // Construir contactMethods: prioridad al array explícito, fallback al email simple
        let contactMethods: ContactMethod[];
        if (body.contactMethods && body.contactMethods.length > 0) {
          contactMethods = body.contactMethods.map((cm, i) => ({
            id:        `ccm-${randomUUID()}`,
            channel:   cm.channel,
            value:     cm.value,
            isPrimary: cm.isPrimary ?? i === 0,
          }));
        } else if (body.email) {
          contactMethods = [{
            id:        `ccm-${customerId}`,
            channel:   'EMAIL',
            value:     body.email,
            isPrimary: true,
          }];
        } else {
          contactMethods = [];
        }

        // Verificar duplicado por email primario si hay uno
        const primaryEmail = contactMethods.find(
          (cm) => cm.channel === 'EMAIL' && cm.isPrimary,
        )?.value;
        if (primaryEmail) {
          const existing = await repo.getByEmail(primaryEmail);
          if (existing) {
            res.status(409).json({
              code: 'CUSTOMER_ALREADY_EXISTS',
              message: `Ya existe un cliente con email ${primaryEmail}.`,
              customer: toCustomerDto(existing),
            });
            return;
          }
        }

        const customerNumber = await new SqlNumberSequenceRepository(req.db!).next('CUSTOMER');
        const customer = new Customer(customerId, displayName, contactMethods, 'INDIVIDUAL', true, customerNumber);
        await repo.save(customer);
        res.status(201).json(toCustomerDto(customer));
      } catch (err) { next(err); }
    },
  );

  // GET /customers/:id/rates — listar tarifas especiales activas
  router.get(
    '/:id/rates',
    authorize(Roles.FRONT_DESK),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const rateRepo = new SqlCustomerRateRepository(req.db!);
        const rates = await rateRepo.getByCustomerId(String(req.params['id']));
        res.json(rates);
      } catch (err) { next(err); }
    },
  );

  // POST /customers/:id/rates — crear tarifa especial (cliente+recurso o cliente+servicio)
  router.post(
    '/:id/rates',
    authorize(Roles.MANAGEMENT),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const customerId = String(req.params['id']);
        const customerRepo = new SqlCustomerRepository(req.db!);
        const customer = await customerRepo.getById(customerId);
        if (!customer) {
          res.status(404).json({ code: 'CUSTOMER_NOT_FOUND', message: 'Cliente no encontrado' });
          return;
        }

        const body = CreateCustomerRateSchema.parse(req.body);
        const businessId = req.user!.businessId as string;
        const base = { id: randomUUID(), businessId, customerId, ...(body.notes && { notes: body.notes }) };

        // D5 (pendientes-2026-08-19.md) — dos formas de armar el DTO: desde
        // un preset del catálogo (rateCatalogId es una referencia VIVA —
        // decisión del dueño, corregida 22/08/2026 antes de cualquier
        // deploy real: el % NO se copia acá, se resuelve con JOIN en cada
        // lectura, ver sql.customer-rate.repository.ts) o ad hoc (tal cual
        // venía antes). CreateCustomerRateSchema ya garantizó que no
        // vinieron mezclados los dos modos.
        //
        // D9-Parte 2 (pendientes-2026-08-22.md) — el "target" ahora es uno
        // de 5: resourceId/serviceId/productId (ÍTEM), categoryId
        // (CATEGORÍA) o bucket (BUCKET). productId/bucket='PRODUCTOS' ya
        // están habilitados -- OrderPricingService (pos-menu) los consulta
        // de verdad al resolver el precio de un ítem de orden.
        let dto: CreateCustomerRateDto;

        if (body.rateCatalogId) {
          const catalogEntry = await new SqlRateCatalogRepository(req.db!).findById(body.rateCatalogId, businessId);
          if (!catalogEntry || !catalogEntry.active) throw new RateCatalogEntryNotFoundError(body.rateCatalogId);

          // El scope SÍ se copia (lo necesitan los índices únicos y la
          // resolución por ítem/categoría/bucket) -- solo el % queda vivo.
          const target = catalogEntry.resourceId  ? { resourceId: catalogEntry.resourceId }
            : catalogEntry.serviceId  ? { serviceId: catalogEntry.serviceId }
            : catalogEntry.productId  ? { productId: catalogEntry.productId }
            : catalogEntry.categoryId ? { categoryId: catalogEntry.categoryId }
            : { bucket: catalogEntry.bucket! };
          dto = { ...base, ...target, rateCatalogId: catalogEntry.id };
        } else {
          if (body.resourceId) {
            const resource = await new SqlResourceRepository(req.db!).getById(body.resourceId);
            if (!resource) throw new ResourceNotFoundError(body.resourceId);
          }
          if (body.serviceId) {
            const service = await new SqlBookableServiceRepository(req.db!).findById(body.serviceId);
            if (!service) throw new BookableServiceNotFoundError(body.serviceId);
          }
          if (body.productId) {
            const product = await new SqlProductRepository(req.db!).getById(body.productId);
            if (!product) throw new ProductNotFoundError(body.productId);
          }
          if (body.categoryId) {
            const category = await new SqlCategoryRepository(req.db!).findById(body.categoryId);
            if (!category) throw new CategoryNotFoundError(body.categoryId);
          }

          const target = body.resourceId  ? { resourceId: body.resourceId }
            : body.serviceId  ? { serviceId: body.serviceId }
            : body.productId  ? { productId: body.productId }
            : body.categoryId ? { categoryId: body.categoryId }
            : { bucket: body.bucket! };
          dto = body.price !== undefined
            ? { ...base, ...target, fixedPrice: body.price }
            : { ...base, ...target, discountPercentage: body.discountPercentage! };
        }

        const rateRepo = new SqlCustomerRateRepository(req.db!);
        try {
          const rate = await rateRepo.create(dto);
          res.status(201).json(rate);
        } catch (dbErr) {
          // Índice único parcial (uq_customer_rates_customer_resource/_service) —
          // ya existe un override activo para este cliente+recurso o cliente+servicio.
          if ((dbErr as { code?: string }).code === '23505') {
            throw new CustomerRateConflictError();
          }
          throw dbErr;
        }
      } catch (err) {
        // ProductNotFoundError (pos-menu/product.service.ts) no es un
        // DomainError -- domainErrorStatus() no lo mapea, se captura acá
        // localmente (D9-Parte 2), mismo criterio que confirmOrder() en
        // orders.routes.ts.
        if (err instanceof ProductNotFoundError) { res.status(404).json({ code: 'PRODUCT_NOT_FOUND', message: (err as Error).message }); return; }
        next(err);
      }
    },
  );

  // DELETE /customers/:id/rates/:rateId — desactiva (soft), idempotente
  //
  // Auditado (R8, entity='customer_rates') a propósito, distinto de
  // entity='rate_catalog' (rate-catalog.service.ts) -- esto es "alguien
  // tocó la tarifa DE ESTE cliente puntual", no "cambió una entrada de
  // catálogo que de rebote movió el precio de N clientes" (D5,
  // pendientes-2026-08-19.md, seguimiento del 22/08/2026).
  router.delete(
    '/:id/rates/:rateId',
    authorize(Roles.MANAGEMENT),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const businessId = req.user!.businessId as string;
        const rateId = String(req.params['rateId']);
        const rateRepo = new SqlCustomerRateRepository(req.db!);

        const before = await rateRepo.findById(rateId, businessId);

        // Si de verdad estaba activa, deactivate() + el INSERT de auditoría
        // comparten transacción (25/08/2026, paso 1 del handoff de RBAC/
        // auditoría) — si no había nada que auditar, deactivate() solo
        // (idempotente, no necesita atomicidad con nada más).
        if (before?.active) {
          const auditLogRepo = new SqlAuditLogRepository(req.db!);
          await buildTenantTransactionManager(req).run(async (client) => {
            await rateRepo.deactivateWithClient!(client, rateId);
            await recordFieldChangesWithClient(
              client,
              auditLogRepo,
              'customer_rates',
              rateId,
              [{ field: 'active', oldValue: true, newValue: false }],
              req.user!.id,
            );
          });
        } else {
          await rateRepo.deactivate(rateId);
        }

        res.status(204).send();
      } catch (err) { next(err); }
    },
  );

  // I4 (23/08/2026) — conciliación de pagos, mismo criterio de composición
  // que buildCancellationRefundService en reservations.routes.ts.
  function buildCustomerAccountService(req: Request): CustomerAccountService {
    return new CustomerAccountService(
      new SqlFinancialTransactionRepository(req.db!),
      new SqlCustomerRepository(req.db!),
      new SqlBusinessProfileRepository(req.db!),
      new SqlInvoiceRepository(req.db!),
      buildTenantTransactionManager(req),
    );
  }

  // GET /customers/:id/account — estado de cuenta (balance + transacciones)
  //
  // INVOICE-CHARGES-GUARD-FRONTEND-02 (11/09/2026, Bloque 2, gate
  // `architecture-governor`) -- enriquece con `coveredByConsolidatedTransactionIds`
  // SOLO si el negocio tiene FACTURACION habilitado (decisión del dueño:
  // esta ruta está gateada por CUENTAS_CORRIENTES, no por FACTURACION, y
  // un negocio sin ese módulo no debe pagar el costo de la query ni recibir
  // ese dato -- los 2 módulos son independientes, `requireModule()` no lo
  // exige). El chequeo vive ACÁ, no en `CustomerAccountService` (que se
  // mantiene tenant-puro, sin conocimiento de módulos de plataforma --
  // mismo principio que separa `req.db` de `getPlatformRawPool()`).
  //
  // `requireModule()` (arriba, línea de este mismo router) ya llama
  // `container.getBusinessModuleGates()` y descarta el resultado -- este
  // segundo fetch es una consulta más a la BD de plataforma por request.
  // Aceptado a propósito (dejar los gates en `req` toca middleware
  // compartido, bloque aparte) pero con el MISMO manejo de error que
  // `requireModule()` para no degradar silenciosamente a 500 si la
  // plataforma no responde.
  router.get(
    '/:id/account',
    authorize(Roles.FRONT_DESK),
    requireModule(container, ModuleKey.CUENTAS_CORRIENTES),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const statement = await buildCustomerAccountService(req).getStatement(String(req.params['id']));

        let gates: Record<string, { enabled: boolean }>;
        try {
          gates = await container.getBusinessModuleGates(req.user!.businessId as string);
        } catch {
          res.status(503).json({
            code: 'PLATFORM_UNAVAILABLE',
            message: 'No se pudo verificar los módulos habilitados del negocio.',
          });
          return;
        }

        if (!gates[ModuleKey.FACTURACION]?.enabled) {
          res.json(statement);
          return;
        }

        const chargeIds = statement.transactions.filter((tx) => tx.type === 'CHARGE').map((tx) => tx.id);
        const invoiceRepo = new SqlInvoiceRepository(req.db!);
        const covered = await invoiceRepo.getFinancialTransactionIdsCoveredByConsolidated(chargeIds);
        // INVOICE-CHARGES-BUTTON-DEADEND-01 (11/09/2026, gate architecture-governor,
        // opción B): mismo predicado que `covered` de arriba, pero con el
        // invoiceId -- para que el frontend arme un link preciso cargo→factura
        // en vez de mandar a la lista completa del cliente. `covered`/
        // `coveredByConsolidatedTransactionIds` se mantienen sin tocar durante
        // la ventana de deploy (compatibilidad hacia atrás con un frontend viejo).
        const coveredInvoiceIds = await invoiceRepo.getConsolidatedInvoiceIdsForFinancialTransactions(chargeIds);
        res.json({
          ...statement,
          coveredByConsolidatedTransactionIds: [...covered],
          coveredByConsolidatedInvoices: [...coveredInvoiceIds].map(([financialTransactionId, invoiceId]) => ({
            financialTransactionId,
            invoiceId,
          })),
        });
      } catch (err) { next(err); }
    },
  );

  // GET /customers/:id/outstanding-invoices — facturas ISSUED con saldo
  // pendiente, para el modal de conciliación de "Registrar Pago" (I4).
  router.get(
    '/:id/outstanding-invoices',
    authorize(Roles.FRONT_DESK),
    requireModule(container, ModuleKey.CUENTAS_CORRIENTES),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const invoices = await buildCustomerAccountService(req).getOutstandingInvoices(String(req.params['id']));
        res.json(invoices);
      } catch (err) { next(err); }
    },
  );

  // POST /customers/:id/payments — registra un pago manual (idempotente).
  // `allocations` (I4) — qué factura(s) salda este pago y cuánto de cada
  // una; omitido = comportamiento previo, un pago genérico sin destino.
  router.post(
    '/:id/payments',
    authorize(Roles.FRONT_DESK),
    requireModule(container, ModuleKey.CUENTAS_CORRIENTES),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = RecordPaymentSchema.parse(req.body);
        // `CITY-LEDGER-OVERTRANSFER-PAYMENT-001` (13/09/2026) -- resuelve
        // `stayId` acá, no en el servicio (bounded context:
        // `clientes-finanzas` no importa la entidad rica de
        // `pms-estadias`, mismo patrón ya usado para `reservationId` unas
        // líneas arriba). Solo si la estadía está `CHECKED_IN` -- texto
        // literal de la decisión del dueño ("cuando la reserva tiene una
        // estadía ACTIVA"). `findByReservation()` trae la más reciente
        // sin filtrar por status (una reserva puede tener más de una
        // estadía: `idx_stays_reservation_active` es un índice PARCIAL,
        // `WHERE status = 'CHECKED_IN'`) -- una `CHECKED_OUT`/`NO_SHOW`
        // NO cuenta como activa, y pasarle ese `stayId` movería el saldo
        // de un folio ya cerrado.
        let stayId: string | null = null;
        if (body.reservationId) {
          const reservation = await new SqlReservationRepository(req.db!, new SqlResourceRepository(req.db!)).getById(body.reservationId);
          if (!reservation) throw new ReservationNotFoundError(body.reservationId);
          const stay = await new SqlStayRepository(req.db!).findByReservation(body.reservationId, req.user!.businessId as string);
          if (stay && stay.status === 'CHECKED_IN') stayId = stay.id;
        }
        const txs = await buildCustomerAccountService(req).recordPayment({
          customerId: String(req.params['id']),
          businessId: req.user!.businessId as string,
          amount: body.amount,
          ...(body.paymentMethod && { paymentMethod: body.paymentMethod }),
          ...(body.cardInstallments !== undefined && { cardInstallments: body.cardInstallments }),
          ...(body.cardSurchargeAmount !== undefined && { cardSurchargeAmount: body.cardSurchargeAmount }),
          ...(body.notes && { notes: body.notes }),
          ...(body.idempotencyKey && { idempotencyKey: body.idempotencyKey }),
          ...(body.reservationId && { reservationId: body.reservationId }),
          ...(stayId && { stayId }),
          ...(body.allocations && { allocations: body.allocations }),
        });
        res.status(201).json(txs);
      } catch (err) { next(err); }
    },
  );

  return router;
}
