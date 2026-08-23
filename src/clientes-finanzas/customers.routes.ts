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
import { recordFieldChanges } from '../domain/audit.js';
import { SqlResourceRepository } from '../reservas/sql.resource.repository.js';
import { SqlReservationRepository } from '../reservas/sql.reservation.repository.js';
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
import { SqlAfipCredentialsRepository } from '../facturacion/sql.afip-credentials.repository.js';
import { PadronService } from '../facturacion/padron.service.js';

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

        if (body.displayName !== undefined) {
          const updated = new Customer(
            existing.id,
            body.displayName,
            existing.contactMethods,
            existing.kind,
            existing.active,
            existing.customerNumber,
          );
          await repo.save(updated);
        }

        if (body.kind !== undefined || body.active !== undefined) {
          await repo.updateKindAndActive(
            id,
            body.kind ?? existing.kind,
            body.active ?? existing.active,
          );
        }

        if (body.enableCurrentAccount !== undefined) {
          await repo.setCurrentAccountEnabled(id, body.enableCurrentAccount);
        }

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
  router.get(
    '/',
    authorize(Roles.FRONT_DESK),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const repo = new SqlCustomerRepository(req.db!);
        const { email, name, currentAccountEnabled } = req.query;

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
        // filtro vive en SqlCustomerRepository.getAll(), no acá.
        //
        // Sin filtros: listado completo — lo necesita la pantalla de
        // Clientes del dashboard para mostrar una tabla navegable, no solo
        // búsqueda puntual (antes esto daba 400).
        const customers = await repo.getAll(currentAccountEnabled === 'true');
        res.json(customers.map(toCustomerDto));
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
        await rateRepo.deactivate(rateId);

        if (before?.active) {
          const auditLogRepo = new SqlAuditLogRepository(req.db!);
          await recordFieldChanges(
            auditLogRepo,
            'customer_rates',
            rateId,
            [{ field: 'active', oldValue: true, newValue: false }],
            req.user!.id,
          );
        }

        res.status(204).send();
      } catch (err) { next(err); }
    },
  );

  // GET /customers/:id/account — estado de cuenta (balance + transacciones)
  router.get(
    '/:id/account',
    authorize(Roles.FRONT_DESK),
    requireModule(container, ModuleKey.CUENTAS_CORRIENTES),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const service = new CustomerAccountService(
          new SqlFinancialTransactionRepository(req.db!),
          new SqlCustomerRepository(req.db!),
          new SqlBusinessProfileRepository(req.db!),
        );
        const statement = await service.getStatement(String(req.params['id']));
        res.json(statement);
      } catch (err) { next(err); }
    },
  );

  // POST /customers/:id/payments — registra un pago manual (idempotente)
  router.post(
    '/:id/payments',
    authorize(Roles.FRONT_DESK),
    requireModule(container, ModuleKey.CUENTAS_CORRIENTES),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = RecordPaymentSchema.parse(req.body);
        if (body.reservationId) {
          const reservation = await new SqlReservationRepository(req.db!, new SqlResourceRepository(req.db!)).getById(body.reservationId);
          if (!reservation) throw new ReservationNotFoundError(body.reservationId);
        }
        const service = new CustomerAccountService(
          new SqlFinancialTransactionRepository(req.db!),
          new SqlCustomerRepository(req.db!),
          new SqlBusinessProfileRepository(req.db!),
        );
        const tx = await service.recordPayment({
          customerId: String(req.params['id']),
          businessId: req.user!.businessId as string,
          amount: body.amount,
          ...(body.paymentMethod && { paymentMethod: body.paymentMethod }),
          ...(body.cardInstallments !== undefined && { cardInstallments: body.cardInstallments }),
          ...(body.cardSurchargeAmount !== undefined && { cardSurchargeAmount: body.cardSurchargeAmount }),
          ...(body.notes && { notes: body.notes }),
          ...(body.idempotencyKey && { idempotencyKey: body.idempotencyKey }),
          ...(body.reservationId && { reservationId: body.reservationId }),
        });
        res.status(201).json(tx);
      } catch (err) { next(err); }
    },
  );

  return router;
}
