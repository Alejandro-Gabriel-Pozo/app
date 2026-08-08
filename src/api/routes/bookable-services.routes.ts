/**
 * @file bookable-services.routes.ts
 * @description Rutas REST para servicios agendables y sus horarios.
 *
 * GET    /api/bookable-services
 * POST   /api/bookable-services
 * GET    /api/bookable-services/:id
 * PUT    /api/bookable-services/:id
 * DELETE /api/bookable-services/:id
 *
 * GET    /api/bookable-services/:id/schedules
 * POST   /api/bookable-services/:id/schedules
 * PUT    /api/bookable-services/:id/schedules/:scheduleId
 * DELETE /api/bookable-services/:id/schedules/:scheduleId
 *
 * ## Aislamiento multi-tenant
 * buildService() instancia SqlBookableServiceRepository con req.db
 * (inyectado por tenantMiddleware). No hay estado compartido entre tenants.
 *
 * ## exactOptionalPropertyTypes — Zod parse y DTOs opcionales
 * Con exactOptionalPropertyTypes=true en tsconfig, un objeto
 * `{ dayOfWeek: undefined }` NO es assignable a `{ dayOfWeek?: number }`.
 * Zod infiere las propiedades opcionales como `T | undefined` (la clave
 * siempre existe en el objeto parseado, con valor undefined si el campo
 * no vino en el body).
 *
 * Solución: usar `omitUndefined()` para producir un objeto donde las
 * claves con valor undefined directamente no existen.
 *
 * NO hacer:
 *   service.updateSchedule(id, body)  // body tiene { dayOfWeek: undefined } → TS2379
 *
 * SÍ hacer:
 *   service.updateSchedule(id, omitUndefined(body))  // solo claves con valor
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { ZodError } from 'zod';
import { authorize } from '../../security/auth.middleware.js';
import { UserRole } from '../../types/enums.js';
import { BookableServiceService, BookableServiceNotFoundError, ServiceScheduleNotFoundError, ScheduleConflictError } from '../../services/bookable-service.service.js';
import { SqlBookableServiceRepository } from '../../repositories/sql.bookable-service.repository.js';
import {
  CreateBookableServiceSchema,
  UpdateBookableServiceSchema,
  CreateServiceScheduleSchema,
  UpdateServiceScheduleSchema,
} from '../schemas/bookable-service.schemas.js';
import type { AppContainer } from '../../container.js';

/**
 * Elimina las claves cuyo valor es `undefined` del objeto dado.
 * Necesario para cumplir exactOptionalPropertyTypes: el resultado solo
 * contiene claves con valor real, lo que lo hace assignable a un DTO
 * con propiedades opcionales.
 */
function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

function buildService(req: Request): BookableServiceService {
  return new BookableServiceService(new SqlBookableServiceRepository(req.db!));
}

function param(req: Request, key: string): string {
  return String(req.params[key]);
}

export function createBookableServicesRouter(_container: AppContainer): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /api/bookable-services
  // -------------------------------------------------------------------------
  router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const services = await buildService(req).listServices();
      res.json(services);
    } catch (err) { next(err); }
  });

  // -------------------------------------------------------------------------
  // POST /api/bookable-services
  // -------------------------------------------------------------------------
  router.post('/', authorize([UserRole.ADMIN]), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body    = CreateBookableServiceSchema.parse(req.body);
      const service = await buildService(req).createService(body);
      res.status(201).json(service);
    } catch (err) {
      if (err instanceof ZodError) { res.status(400).json({ code: 'VALIDATION_ERROR', errors: err.errors }); return; }
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/bookable-services/:id
  // -------------------------------------------------------------------------
  router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const service = await buildService(req).getServiceById(param(req, 'id'));
      res.json(service);
    } catch (err) {
      if (err instanceof BookableServiceNotFoundError) { res.status(404).json({ code: 'NOT_FOUND', message: err.message }); return; }
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // PUT /api/bookable-services/:id
  // -------------------------------------------------------------------------
  router.put('/:id', authorize([UserRole.ADMIN]), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body    = omitUndefined(UpdateBookableServiceSchema.parse(req.body));
      const service = await buildService(req).updateService(param(req, 'id'), body);
      res.json(service);
    } catch (err) {
      if (err instanceof ZodError) { res.status(400).json({ code: 'VALIDATION_ERROR', errors: err.errors }); return; }
      if (err instanceof BookableServiceNotFoundError) { res.status(404).json({ code: 'NOT_FOUND', message: err.message }); return; }
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /api/bookable-services/:id
  // -------------------------------------------------------------------------
  router.delete('/:id', authorize([UserRole.ADMIN]), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await buildService(req).deleteService(param(req, 'id'));
      res.status(204).send();
    } catch (err) {
      if (err instanceof BookableServiceNotFoundError) { res.status(404).json({ code: 'NOT_FOUND', message: err.message }); return; }
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/bookable-services/:id/schedules
  // -------------------------------------------------------------------------
  router.get('/:id/schedules', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const schedules = await buildService(req).listSchedules(param(req, 'id'));
      res.json(schedules);
    } catch (err) {
      if (err instanceof BookableServiceNotFoundError) { res.status(404).json({ code: 'NOT_FOUND', message: err.message }); return; }
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/bookable-services/:id/schedules
  // -------------------------------------------------------------------------
  router.post('/:id/schedules', authorize([UserRole.ADMIN]), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body     = CreateServiceScheduleSchema.parse(req.body);
      const schedule = await buildService(req).addSchedule(param(req, 'id'), body);
      res.status(201).json(schedule);
    } catch (err) {
      if (err instanceof ZodError) { res.status(400).json({ code: 'VALIDATION_ERROR', errors: err.errors }); return; }
      if (err instanceof BookableServiceNotFoundError) { res.status(404).json({ code: 'NOT_FOUND', message: err.message }); return; }
      if (err instanceof ScheduleConflictError) { res.status(409).json({ code: 'SCHEDULE_CONFLICT', message: err.message }); return; }
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // PUT /api/bookable-services/:id/schedules/:scheduleId
  // -------------------------------------------------------------------------
  router.put('/:id/schedules/:scheduleId', authorize([UserRole.ADMIN]), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // omitUndefined: Zod parsea campos opcionales ausentes como { key: undefined }.
      // exactOptionalPropertyTypes rechaza eso — omitimos las claves undefined
      // para producir un objeto que cumpla UpdateServiceScheduleDTO.
      const body     = omitUndefined(UpdateServiceScheduleSchema.parse(req.body));
      const schedule = await buildService(req).updateSchedule(param(req, 'scheduleId'), body);
      res.json(schedule);
    } catch (err) {
      if (err instanceof ZodError) { res.status(400).json({ code: 'VALIDATION_ERROR', errors: err.errors }); return; }
      if (err instanceof ServiceScheduleNotFoundError) { res.status(404).json({ code: 'NOT_FOUND', message: err.message }); return; }
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /api/bookable-services/:id/schedules/:scheduleId
  // -------------------------------------------------------------------------
  router.delete('/:id/schedules/:scheduleId', authorize([UserRole.ADMIN]), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await buildService(req).removeSchedule(param(req, 'scheduleId'));
      res.status(204).send();
    } catch (err) {
      if (err instanceof ServiceScheduleNotFoundError) { res.status(404).json({ code: 'NOT_FOUND', message: err.message }); return; }
      next(err);
    }
  });

  return router;
}
