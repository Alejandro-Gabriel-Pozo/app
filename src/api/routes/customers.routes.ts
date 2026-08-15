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
import { authorize } from '../middleware/auth.middleware.wrapper.js';
import { requireModule } from '../../security/module.middleware.js';
import { ModuleKey } from '../../types/enums.js';
import type { AppContainer } from '../../container.js';
import type { ContactMethod } from '../../domain/customer.entities.js';
import { Customer } from '../../domain/customer.entities.js';
import { Roles } from '../../security/roles.js';
import { SqlCustomerRepository } from '../../repositories/sql.customer.repository.js';
import { SqlCustomerRateRepository } from '../../repositories/sql.customer-rate.repository.js';
import { SqlResourceRepository } from '../../repositories/sql.resource.repository.js';
import { SqlBookableServiceRepository } from '../../repositories/sql.bookable-service.repository.js';
import { SqlFinancialTransactionRepository } from '../../repositories/sql.financial-transaction.repository.js';
import { CustomerAccountService } from '../../services/customer-account.service.js';
import {
  UpdateCustomerSchema, AssignTagSchema, CreateCustomerRateSchema, RecordPaymentSchema,
} from '../schemas/request.schemas.js';
import { CustomerRateConflictError, ResourceNotFoundError } from '../../domain/errors.js';
import { BookableServiceNotFoundError } from '../../services/bookable-service.service.js';

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

// ---------------------------------------------------------------------------
// DTO de salida
// ---------------------------------------------------------------------------

function toCustomerDto(customer: Customer) {
  return {
    id:          customer.id,
    displayName: customer.displayName,
    /** @deprecated usar contactMethods */
    fullName:    customer.displayName,
    email:       customer.email,
    kind:        customer.kind,
    active:      customer.active,
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

        const refreshed = await repo.getById(id);
        const tags = await repo.getTagsByCustomerId(id);
        res.json({ ...toCustomerDto(refreshed!), tags });
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

  // GET /customers?email=...  o  GET /customers?name=...  o  GET /customers (todos)
  router.get(
    '/',
    authorize(Roles.FRONT_DESK),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const repo = new SqlCustomerRepository(req.db!);
        const { email, name } = req.query;

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

        // Sin filtros: listado completo — lo necesita la pantalla de
        // Clientes del dashboard para mostrar una tabla navegable, no solo
        // búsqueda puntual (antes esto daba 400).
        const customers = await repo.getAll();
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

        const customer = new Customer(customerId, displayName, contactMethods);
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

        if (body.resourceId) {
          const resource = await new SqlResourceRepository(req.db!).getById(body.resourceId);
          if (!resource) throw new ResourceNotFoundError(body.resourceId);
        }
        if (body.serviceId) {
          const service = await new SqlBookableServiceRepository(req.db!).findById(body.serviceId);
          if (!service) throw new BookableServiceNotFoundError(body.serviceId);
        }

        const rateRepo = new SqlCustomerRateRepository(req.db!);
        try {
          const rate = await rateRepo.create({
            id: randomUUID(),
            businessId: req.user!.businessId as string,
            customerId,
            ...(body.resourceId && { resourceId: body.resourceId }),
            ...(body.serviceId && { serviceId: body.serviceId }),
            price: body.price,
            ...(body.notes && { notes: body.notes }),
          });
          res.status(201).json(rate);
        } catch (dbErr) {
          // Índice único parcial (uq_customer_rates_customer_resource/_service) —
          // ya existe un override activo para este cliente+recurso o cliente+servicio.
          if ((dbErr as { code?: string }).code === '23505') {
            throw new CustomerRateConflictError();
          }
          throw dbErr;
        }
      } catch (err) { next(err); }
    },
  );

  // DELETE /customers/:id/rates/:rateId — desactiva (soft), idempotente
  router.delete(
    '/:id/rates/:rateId',
    authorize(Roles.MANAGEMENT),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const rateRepo = new SqlCustomerRateRepository(req.db!);
        await rateRepo.deactivate(String(req.params['rateId']));
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
        const service = new CustomerAccountService(
          new SqlFinancialTransactionRepository(req.db!),
          new SqlCustomerRepository(req.db!),
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
        });
        res.status(201).json(tx);
      } catch (err) { next(err); }
    },
  );

  return router;
}
