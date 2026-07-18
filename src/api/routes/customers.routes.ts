/**
 * @file customers.routes.ts
 * @description Gestión de clientes por parte de empleados (ADMIN/RECEPTIONIST).
 *
 * ## Aislamiento multi-tenant
 * Cada handler instancia SqlCustomerRepository(req.db!) con el SqlClient
 * inyectado por tenantMiddleware. El ! es seguro: el middleware siempre
 * asigna req.db antes de llegar a estos handlers.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authorize } from '../middleware/auth.middleware.wrapper.js';
import { AppContainer } from '../../container.js';
import { Customer } from '../../domain/entities.js';
import { UserRole } from '../../types/enums.js';
import { SqlCustomerRepository } from '../../repositories/sql.customer.repository.js';

const MANAGERS = [UserRole.ADMIN, UserRole.RECEPTIONIST] as const;

const CreateCustomerSchema = z.object({
  fullName: z.string({ required_error: 'fullName es obligatorio' }).min(1),
  email: z.string({ required_error: 'email es obligatorio' }).email('email debe tener un formato válido'),
});

function toCustomerDto(customer: Customer) {
  return { id: customer.id, fullName: customer.fullName, email: customer.email ?? '' };
}

export function createCustomersRouter(_container: AppContainer): Router {
  const router = Router();

  router.get('/:id', authorize(MANAGERS), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const repo = new SqlCustomerRepository(req.db!);
      const id = String(req.params['id']);
      const customer = await repo.getById(id);
      if (!customer) {
        res.status(404).json({ code: 'CUSTOMER_NOT_FOUND', message: `No existe un cliente con id "${id}"` });
        return;
      }
      res.json(toCustomerDto(customer));
    } catch (err) { next(err); }
  });

  router.get('/', authorize(MANAGERS), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const email = req.query['email'];
      if (typeof email !== 'string' || !email.trim()) {
        res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Query param "email" es obligatorio.' });
        return;
      }
      const repo = new SqlCustomerRepository(req.db!);
      const customer = await repo.getByEmail(email);
      res.json(customer ? toCustomerDto(customer) : null);
    } catch (err) { next(err); }
  });

  router.post('/', authorize(MANAGERS), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const repo = new SqlCustomerRepository(req.db!);
      const body = CreateCustomerSchema.parse(req.body);

      const existing = await repo.getByEmail(body.email);
      if (existing) {
        res.status(409).json({
          code: 'CUSTOMER_ALREADY_EXISTS',
          message: `Ya existe un cliente con email ${body.email}.`,
          customer: toCustomerDto(existing),
        });
        return;
      }

      const customer = new Customer(randomUUID(), body.fullName, body.email);
      await repo.save(customer);
      res.status(201).json(toCustomerDto(customer));
    } catch (err) { next(err); }
  });

  return router;
}
