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

import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authorize } from '../middleware/auth.middleware.wrapper.js';
import { AppContainer } from '../../container.js';
import { Customer, ContactMethod } from '../../domain/entities.js';
import { UserRole } from '../../types/enums.js';
import { SqlCustomerRepository } from '../../repositories/sql.customer.repository.js';

const MANAGERS = [UserRole.ADMIN, UserRole.RECEPTIONIST] as const;

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

export function createCustomersRouter(_container: AppContainer): Router {
  const router = Router();

  // GET /customers/:id
  router.get(
    '/:id',
    authorize(MANAGERS),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const repo = new SqlCustomerRepository(req.db!);
        const customer = await repo.getById(String(req.params['id']));
        if (!customer) {
          res.status(404).json({ code: 'CUSTOMER_NOT_FOUND', message: 'Cliente no encontrado' });
          return;
        }
        res.json(toCustomerDto(customer));
      } catch (err) { next(err); }
    },
  );

  // GET /customers?email=...  o  GET /customers?name=...
  router.get(
    '/',
    authorize(MANAGERS),
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

        res.status(400).json({
          code: 'VALIDATION_ERROR',
          message: 'Se requiere al menos un query param: email o name.',
        });
      } catch (err) { next(err); }
    },
  );

  // POST /customers
  router.post(
    '/',
    authorize(MANAGERS),
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

  return router;
}
