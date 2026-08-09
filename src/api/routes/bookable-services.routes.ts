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
 *
 * Con exactOptionalPropertyTypes=true en tsconfig, hay dos clases de problema:
 *
 * CLASE A — Zod infiere `{ description?: string | undefined }` pero el DTO
 * espera `{ description?: string }` (sin `| undefined` explícito).
 * Pasar el objeto crudo viola TS2379.
 *
 * CLASE B — omitUndefined<T>() que retorna `Partial<T>` también falla
 * porque `Partial<T>` convierte `string` en `string | undefined`.
 *
 * Solución: `stripUndefined<T>()` — retorna `T` (no `Partial<T>`).
 * El cast `as unknown as T` es seguro porque:
 * 1. Las claves con valor undefined no están en el objeto resultante.
 * 2. Un objeto sin una clave opcional ES assignable a un tipo con esa
 *    clave como `prop?: string` (la clave ausente ≡ propiedad no presente).
 * 3. Solo se usa en el límite router→servicio, no dentro de dominio.
 *
 * NO hacer:
 *   service.createService(body)                         // body.description: string|undefined → TS2379
 *   service.updateService(id, omitUndefined(body))       // Partial<T>.categoryId: string|undefined → TS2379
 *
 * SÍ hacer:
 *   service.createService(stripUndefined(body))          // T sin claves undefined → ✅
 *   service.updateService(id, stripUndefined(body))      // T sin claves undefined → ✅
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { ZodError } from 'zod';
import { authorize } from '../../security/auth.middleware.js';
import { UserRole } from '../../types/enums.js';
import {
  BookableServiceService,
  BookableServiceNotFoundError,
  ServiceScheduleNotFoundError,
  ScheduleConflictError,
} from '../../services/bookable-service.service.js';
import { SqlBookableServiceRepository } from '../../repositories/sql.bookable-service.repository.js';
import {
  CreateBookableServiceSchema,
  UpdateBookableServiceSchema,
  CreateServiceScheduleSchema,
  UpdateServiceScheduleSchema,
} from '../schemas/bookable-service.schemas.js';
import type { AppContainer } from '../../container.js';

/**
 * Elimina las claves cuyo valor es `undefined` del objeto dado y
 * retorna el resultado como `T`.
 *
 * ## Por qué `T` en lugar de `Partial<T>`
 * `Partial<T>` añade `| undefined` a cada propiedad, lo que vuelve a
 * violar exactOptionalPropertyTypes al pasarlo a un servicio cuyo DTO
 * tiene `prop?: string` (sin `| undefined`).
 * Retornar `T` es correcto porque un objeto sin la clave `description`
 * cumple `{ description?: string }` con exactOptionalPropertyTypes=true.
 *
 * El `as unknown as T` es un escape hatch controlado, solo en el límite
 * router→servicio donde Zod puede generar claves con valor undefined.
 * Nunca usar dentro de lógica de dominio.
 */
function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as unknown as T;
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
      // stripUndefined: Zod puede parsear description como string|undefined
      // (si el campo no vino en el body). CreateBookableServiceDTO.description?
      // no acepta undefined con exactOptionalPropertyTypes.
      const body    = stripUndefined(CreateBookableServiceSchema.parse(req.body));
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
      // stripUndefined: ver doc en cabecera. Retorna T (no Partial<T>)
      // para cumplir UpdateBookableServiceDTO con exactOptionalPropertyTypes.
      const body    = stripUndefined(UpdateBookableServiceSchema.parse(req.body));
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
      // stripUndefined: Zod parsea campos opcionales ausentes como { key: undefined }.
      // exactOptionalPropertyTypes rechaza eso — stripUndefined elimina las claves
      // undefined y retorna T (no Partial<T>) para cumplir UpdateServiceScheduleDTO.
      const body     = stripUndefined(UpdateServiceScheduleSchema.parse(req.body));
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
