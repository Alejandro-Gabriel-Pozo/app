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
 * ## exactOptionalPropertyTypes — req.params
 * Express tipifica req.params[key] como `string | string[]` (puede ser un
 * array si la misma clave aparece repetida en la URL, ej. /a?x=1&x=2).
 * Con exactOptionalPropertyTypes=true el cast `as string` no alcanza cuando
 * el valor se pasa como argumento a una función que espera `string`.
 *
 * Regla: usar SIEMPRE `String(req.params['key'])` en lugar de
 * `req.params['key'] as string`. String() coerce cualquier valor primitivo
 * a string — incluso arrays — de forma segura y sin error de TS.
 *
 * NO hacer:
 *   service.startTask(req.params['id']!, businessId)   // TS2345
 *   service.startTask(req.params['id'] as string, businessId) // TS2345
 *
 * SÍ hacer:
 *   service.startTask(String(req.params['id']), businessId)   // ✅
 */

import { Router } from 'express';
import { authenticate, authorize } from '../../security/auth.middleware.js';
import { Roles } from '../../security/roles.js';
import type { HousekeepingService } from '../../services/housekeeping.service.js';
import { HousekeepingStatus } from '../../domain/housekeeping-task.js';

export function createHousekeepingRouter(service: HousekeepingService): Router {
  const router = Router();

  // ── GET /housekeeping?date=YYYY-MM-DD ──────────────────────────────────────
  router.get(
    '/',
    authenticate(),
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
    authenticate(),
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
    authenticate(),
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
    authenticate(),
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
    authenticate(),
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
    authenticate(),
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId!;
        const task = await service.createTask({
          ...req.body,
          businessId,
          scheduledFor: new Date(req.body.scheduledFor as string),
        });
        res.status(201).json(task.toJSON());
      } catch (err) { next(err); }
    },
  );

  // ── POST /housekeeping/:id/assign ───────────────────────────────────────
  router.post(
    '/:id/assign',
    authenticate(),
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId!;
        const task = await service.assignTask({
          taskId: String(req.params['id']),
          userId: req.body.userId as string,
          businessId,
        });
        res.json(task.toJSON());
      } catch (err) { next(err); }
    },
  );

  // ── POST /housekeeping/:id/start ─────────────────────────────────────────
  router.post(
    '/:id/start',
    authenticate(),
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
    authenticate(),
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
    authenticate(),
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
    authenticate(),
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
    authenticate(),
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
