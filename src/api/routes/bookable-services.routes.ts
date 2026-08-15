/**
 * @file bookable-services.routes.ts
 * @description Rutas REST para servicios agendables y sus horarios.
 *
 * GET    /api/bookable-services                              — BOOKING
 * POST   /api/bookable-services                             — MANAGEMENT
 * GET    /api/bookable-services/:id                         — BOOKING
 * PUT    /api/bookable-services/:id                         — MANAGEMENT
 * DELETE /api/bookable-services/:id                         — MANAGEMENT
 *
 * GET    /api/bookable-services/:id/schedules               — BOOKING
 * POST   /api/bookable-services/:id/schedules               — MANAGEMENT
 * PUT    /api/bookable-services/:id/schedules/:scheduleId   — MANAGEMENT
 * DELETE /api/bookable-services/:id/schedules/:scheduleId   — MANAGEMENT
 *
 * GET    /api/bookable-services/:id/resource-locks           — STAFF (no BOOKING — no es visible para CUSTOMER)
 * PUT    /api/bookable-services/:id/resource-locks           — MANAGEMENT (reemplaza el set completo)
 *
 * ## Roles
 * - MANAGEMENT (OWNER, ADMIN): escritura — crear, editar, borrar servicios y schedules.
 * - BOOKING (OWNER, ADMIN, RECEPTIONIST, CUSTOMER): lectura — el portal del cliente
 *   necesita listar servicios disponibles para armar una reserva.
 *
 * ## Validación y errores de dominio
 * ZodError se propaga con next(err) al errorHandler global (error.middleware.ts),
 * que lo captura como primer caso y devuelve 400 VALIDATION_ERROR con err.flatten().
 * Los DomainError (BookableServiceNotFoundError, ScheduleConflictError, etc.)
 * también se propagan con next(err) — domainErrorStatus() en error.middleware.ts
 * ya mapea cada code al status HTTP correcto. Antes cada handler repetía un
 * `if (err instanceof X) res.status(...).json(...)` que duplicaba ese mapeo
 * (jscpd C2, docs/analysis/duplication/) — sacado el 13/08/2026. No agregar
 * de vuelta: si un code nuevo necesita status, el lugar es domainErrorStatus().
 *
 * ## Aislamiento multi-tenant
 * buildService() instancia SqlBookableServiceRepository con req.db
 * (inyectado por tenantMiddleware). No hay estado compartido entre tenants.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { authorize } from '../../security/auth.middleware.js';
import { Roles }     from '../../security/roles.js';
import { BookableServiceService } from '../../services/bookable-service.service.js';
import { ResourceLockService } from '../../services/resource-lock.service.js';
import { SqlBookableServiceRepository } from '../../repositories/sql.bookable-service.repository.js';
import { SqlResourceLockRepository }    from '../../repositories/sql.resource-lock.repository.js';
import { SqlResourceRepository }        from '../../repositories/sql.resource.repository.js';
import { SqlReservationRepository }     from '../../repositories/sql.reservation.repository.js';
import { SqlOccupancyRepository }       from '../../repositories/sql.occupancy.repository.js';
import { SqlCategoryRepository }        from '../../repositories/sql.category.repository.js';
import { SqlDomainEventRepository }     from '../../repositories/sql.domain-event.repository.js';
import { SqlCustomerRateRepository }    from '../../repositories/sql.customer-rate.repository.js';
import { SqlOperatingHoursRepository }  from '../../platform/sql.operating-hours.repository.js';
import { SqlHousekeepingRepository }    from '../../repositories/housekeeping.repository.js';
import { SqlAuditLogRepository }        from '../../repositories/audit-log.repository.js';
import { ReservationService }           from '../../services/reservation.service.js';
import { buildTenantTransactionManager } from '../../db/tenant-context.js';
import {
  CreateBookableServiceSchema,
  UpdateBookableServiceSchema,
  CreateServiceScheduleSchema,
  UpdateServiceScheduleSchema,
} from '../schemas/bookable-service.schemas.js';
import { ReplaceResourceLocksSchema } from '../schemas/resource-lock.schemas.js';
import type { AppContainer } from '../../container.js';

function buildService(req: Request): BookableServiceService {
  return new BookableServiceService(
    new SqlBookableServiceRepository(req.db!),
    new SqlAuditLogRepository(req.db!),
  );
}

function buildResourceLockService(req: Request): ResourceLockService {
  return new ResourceLockService(
    new SqlResourceLockRepository(req.db!),
    new SqlBookableServiceRepository(req.db!),
    new SqlResourceRepository(req.db!),
    buildTenantTransactionManager(req),
  );
}

function buildReservationService(req: Request): ReservationService {
  const db = req.db!;
  const resourceRepo = new SqlResourceRepository(db);
  return new ReservationService(
    new SqlReservationRepository(db, resourceRepo),
    resourceRepo,
    new SqlOccupancyRepository(db),
    new SqlCategoryRepository(db),
    new SqlDomainEventRepository(db),
    buildTenantTransactionManager(req),
    new SqlResourceLockRepository(db),
    new SqlBookableServiceRepository(db),
    new SqlCustomerRateRepository(db),
    new SqlOperatingHoursRepository(db),
    new SqlHousekeepingRepository(db),
  );
}

function param(req: Request, key: string): string {
  return String(req.params[key]);
}

export function createBookableServicesRouter(_container: AppContainer): Router {
  const router = Router();

  // ── GET /api/bookable-services ─────────────────────────────────────────────
  router.get('/', authorize(Roles.BOOKING), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const services = await buildService(req).listServices();
      res.json(services);
    } catch (err) { next(err); }
  });

  // ── POST /api/bookable-services ────────────────────────────────────────────
  router.post('/', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body    = CreateBookableServiceSchema.parse(req.body);
      const service = await buildService(req).createService(body);
      res.status(201).json(service);
    } catch (err) { next(err); }
  });

  // ── GET /api/bookable-services/:id ─────────────────────────────────────────
  router.get('/:id', authorize(Roles.BOOKING), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const service = await buildService(req).getServiceById(param(req, 'id'));
      res.json(service);
    } catch (err) { next(err); }
  });

  // ── PUT /api/bookable-services/:id ─────────────────────────────────────────
  router.put('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body    = UpdateBookableServiceSchema.parse(req.body);
      const service = await buildService(req).updateService(param(req, 'id'), body, req.user!.id);
      res.json(service);
    } catch (err) { next(err); }
  });

  // ── DELETE /api/bookable-services/:id ──────────────────────────────────────
  router.delete('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await buildService(req).deleteService(param(req, 'id'));
      res.status(204).send();
    } catch (err) { next(err); }
  });

  // ── GET /api/bookable-services/:id/schedules ───────────────────────────────
  router.get('/:id/schedules', authorize(Roles.BOOKING), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const schedules = await buildService(req).listSchedules(param(req, 'id'));
      res.json(schedules);
    } catch (err) { next(err); }
  });

  // ── POST /api/bookable-services/:id/schedules ──────────────────────────────
  router.post('/:id/schedules', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body     = CreateServiceScheduleSchema.parse(req.body);
      const schedule = await buildService(req).addSchedule(param(req, 'id'), body);
      res.status(201).json(schedule);
    } catch (err) { next(err); }
  });

  // ── PUT /api/bookable-services/:id/schedules/:scheduleId ──────────────────
  router.put('/:id/schedules/:scheduleId', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body     = UpdateServiceScheduleSchema.parse(req.body);
      const schedule = await buildService(req).updateSchedule(param(req, 'scheduleId'), body);
      res.json(schedule);
    } catch (err) { next(err); }
  });

  // ── DELETE /api/bookable-services/:id/schedules/:scheduleId ───────────────
  router.delete('/:id/schedules/:scheduleId', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await buildService(req).removeSchedule(param(req, 'scheduleId'));
      res.status(204).send();
    } catch (err) { next(err); }
  });

  // ── GET /api/bookable-services/:id/resource-locks ──────────────────────────
  // Roles.STAFF (no BOOKING): los recursos físicos bloqueados no son visibles
  // para CUSTOMER — exponen nombres de recursos internos (ej. "Estilista Ana").
  router.get('/:id/resource-locks', authorize(Roles.STAFF), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const locks = await buildResourceLockService(req).listForService(param(req, 'id'));
      res.json(locks);
    } catch (err) { next(err); }
  });

  // ── PUT /api/bookable-services/:id/resource-locks ──────────────────────────
  // Reemplaza el set completo — el frontend siempre manda el set deseado
  // entero (checkbox list), no altas/bajas puntuales.
  router.put('/:id/resource-locks', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body  = ReplaceResourceLocksSchema.parse(req.body);
      const locks = await buildResourceLockService(req).replaceForService(param(req, 'id'), body.resourceIds);
      res.json(locks);
    } catch (err) { next(err); }
  });

  // ── GET /api/bookable-services/:id/available-slots?resourceId=X&date=YYYY-MM-DD
  // Roles.BOOKING (incluye CUSTOMER) — turnos libres para un servicio "slot"
  // en un recurso puntual, ese día. Ver docs/conocimiento-del-negocio.md.
  router.get('/:id/available-slots', authorize(Roles.BOOKING), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const resourceId = req.query['resourceId'];
      const dateStr     = req.query['date'];
      if (typeof resourceId !== 'string' || !resourceId) {
        res.status(400).json({ code: 'VALIDATION_ERROR', message: 'resourceId es obligatorio' });
        return;
      }
      if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        res.status(400).json({ code: 'VALIDATION_ERROR', message: 'date es obligatorio, formato YYYY-MM-DD' });
        return;
      }

      const slots = await buildReservationService(req).getAvailableSlots(
        param(req, 'id'),
        resourceId,
        new Date(`${dateStr}T00:00:00.000Z`),
      );
      res.json({ slots });
    } catch (err) { next(err); }
  });

  return router;
}
