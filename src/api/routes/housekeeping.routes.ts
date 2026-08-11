/**
 * @file housekeeping.routes.ts
 *
 * ## Permisos por endpoint
 *
 * | Endpoint | Roles |
 * |---|---|
 * | GET  /housekeeping               | STAFF (tablero diario — todos ven) |
 * | GET  /housekeeping/me            | HOUSEKEEPING (mis tareas) |
 * | GET  /housekeeping/status/:s     | HOUSEKEEPING_AND_MANAGEMENT |
 * | GET  /housekeeping/resource/:id  | STAFF |
 * | GET  /housekeeping/:id           | STAFF |
 * | POST /housekeeping               | MANAGEMENT (planificar turno) |
 * | POST /housekeeping/:id/assign    | MANAGEMENT (asignar empleado) |
 * | POST /housekeeping/:id/start     | HOUSEKEEPING (el asignado inicia) |
 * | POST /housekeeping/:id/complete  | HOUSEKEEPING |
 * | POST /housekeeping/:id/inspect   | HOUSEKEEPING_AND_MANAGEMENT |
 * | POST /housekeeping/:id/out-of-service | MANAGEMENT |
 * | POST /housekeeping/:id/reset     | MANAGEMENT |
 *
 * authenticate() fue removido de cada handler: app.ts lo aplica
 * globalmente sobre /api/* antes de tenantMiddleware. Doble authenticate()
 * causaba 401 UNAUTHORIZED al re-leer el header en el segundo pase.
 *
 * ## exactOptionalPropertyTypes — req.params
 * Usar SIEMPRE `String(req.params['key'])` en lugar de `as string`.
 */

import { Router } from 'express';
import { authorize } from '../../security/auth.middleware.js';
import { Roles } from '../../security/roles.js';
import type { HousekeepingService } from '../../services/housekeeping.service.js';
import { HousekeepingStatus } from '../../domain/housekeeping-task.js';
import { CreateHousekeepingTaskSchema, AssignHousekeepingTaskSchema } from '../schemas/housekeeping.schemas.js';

export function createHousekeepingRouter(service: HousekeepingService): Router {
  const router = Router();

  // ── GET /housekeeping?date=YYYY-MM-DD ──────────────────────────────────────
  router.get(
    '/',
    authorize(Roles.STAFF),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId!;
        const date = req.query['date']
          ? new Date(req.query['date'] as string)
          : new Date();
        const tasks = await service.getTasksByDate(businessId, date);
        res.json(tasks.map(t => t.toJSON()));
      } catch (err) { next(err); }
    },
  );

  // ── GET /housekeeping/me ─────────────────────────────────────────────────
  router.get(
    '/me',
    authorize(Roles.STAFF),
    async (req, res, next) => {
      try {
        const { businessId, id: userId } = req.user!;
        const tasks = await service.getTasksByAssignee(userId, businessId!);
        res.json(tasks.map(t => t.toJSON()));
      } catch (err) { next(err); }
    },
  );

  // ── GET /housekeeping/status/:status ─────────────────────────────────────
  router.get(
    '/status/:status',
    authorize(Roles.HOUSEKEEPING_AND_MANAGEMENT),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId!;
        const tasks = await service.getTasksByStatus(
          businessId,
          String(req.params['status']) as HousekeepingStatus,
        );
        res.json(tasks.map(t => t.toJSON()));
      } catch (err) { next(err); }
    },
  );

  // ── GET /housekeeping/resource/:resourceId ──────────────────────────────
  router.get(
    '/resource/:resourceId',
    authorize(Roles.STAFF),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId!;
        const tasks = await service.getTasksByResource(
          String(req.params['resourceId']),
          businessId,
        );
        res.json(tasks.map(t => t.toJSON()));
      } catch (err) { next(err); }
    },
  );

  // ── GET /housekeeping/:id ───────────────────────────────────────────────
  router.get(
    '/:id',
    authorize(Roles.STAFF),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId!;
        const task = await service.getTaskById(String(req.params['id']), businessId);
        if (!task) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Tarea no encontrada' });
          return;
        }
        res.json(task.toJSON());
      } catch (err) { next(err); }
    },
  );

  // ── POST /housekeeping ──────────────────────────────────────────────────
  router.post(
    '/',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId!;
        const body = CreateHousekeepingTaskSchema.parse(req.body);
        const task = await service.createTask({
          businessId,
          resourceId: body.resourceId,
          shift: body.shift,
          scheduledFor: new Date(body.scheduledFor),
          ...(body.notes !== undefined && { notes: body.notes }),
        });
        res.status(201).json(task.toJSON());
      } catch (err) { next(err); }
    },
  );

  // ── POST /housekeeping/:id/assign ───────────────────────────────────────
  router.post(
    '/:id/assign',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId!;
        const body = AssignHousekeepingTaskSchema.parse(req.body);
        const task = await service.assignTask({
          taskId: String(req.params['id']),
          userId: body.userId,
          businessId,
        });
        res.json(task.toJSON());
      } catch (err) { next(err); }
    },
  );

  // ── POST /housekeeping/:id/start ─────────────────────────────────────────
  router.post(
    '/:id/start',
    authorize(Roles.STAFF),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId!;
        const task = await service.startTask(String(req.params['id']), businessId);
        res.json(task.toJSON());
      } catch (err) { next(err); }
    },
  );

  // ── POST /housekeeping/:id/complete ──────────────────────────────────────
  router.post(
    '/:id/complete',
    authorize(Roles.STAFF),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId!;
        const task = await service.completeTask(
          String(req.params['id']),
          businessId,
          req.body.notes as string | undefined,
        );
        res.json(task.toJSON());
      } catch (err) { next(err); }
    },
  );

  // ── POST /housekeeping/:id/inspect ───────────────────────────────────────
  router.post(
    '/:id/inspect',
    authorize(Roles.HOUSEKEEPING_AND_MANAGEMENT),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId!;
        const inspectorId = req.user!.id;
        const task = await service.inspectTask(
          String(req.params['id']),
          businessId,
          inspectorId,
        );
        res.json(task.toJSON());
      } catch (err) { next(err); }
    },
  );

  // ── POST /housekeeping/:id/out-of-service ───────────────────────────────
  router.post(
    '/:id/out-of-service',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId!;
        const task = await service.setOutOfService(
          String(req.params['id']),
          businessId,
          req.body.reason as string | undefined,
        );
        res.json(task.toJSON());
      } catch (err) { next(err); }
    },
  );

  // ── POST /housekeeping/:id/reset ─────────────────────────────────────────
  router.post(
    '/:id/reset',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId!;
        const task = await service.resetToPending(String(req.params['id']), businessId);
        res.json(task.toJSON());
      } catch (err) { next(err); }
    },
  );

  return router;
}
