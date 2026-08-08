/**
 * @file resources.routes.ts
 *
 * Permisos por endpoint:
 *
 * GET  /resources          — STAFF (todos los empleados, incluyendo HOUSEKEEPING)
 * GET  /resources/:id      — STAFF
 * POST /resources          — MANAGEMENT (OWNER, ADMIN)
 * PUT  /resources/:id      — MANAGEMENT
 * DELETE /resources/:id    — MANAGEMENT
 *
 * El servicio se construye por request usando req.db (SqlClient del tenant
 * inyectado por tenantMiddleware). Patrón idéntico a housekeeping y stays.
 */

import { Router } from 'express';
import { authenticate, authorize } from '../../security/auth.middleware.js';
import { Roles } from '../../security/roles.js';
import { SqlResourceRepository } from '../../repositories/sql.resource.repository.js';
import { randomUUID } from 'node:crypto';

export function createResourcesRouter(): Router {
  const router = Router();

  // ── GET /resources ─────────────────────────────────────────────────────────
  router.get(
    '/',
    authenticate(),
    authorize(Roles.STAFF),
    async (req, res, next) => {
      try {
        const repo = new SqlResourceRepository(req.db);
        const resources = await repo.getAll();
        res.json(resources);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /resources/:id ─────────────────────────────────────────────────────
  router.get(
    '/:id',
    authenticate(),
    authorize(Roles.STAFF),
    async (req, res, next) => {
      try {
        const repo = new SqlResourceRepository(req.db);
        const resource = await repo.getById(req.params['id'] as string);
        if (!resource) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Recurso no encontrado' });
          return;
        }
        res.json(resource);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── POST /resources ────────────────────────────────────────────────────────
  router.post(
    '/',
    authenticate(),
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const repo = new SqlResourceRepository(req.db);
        const { BookableResource } = await import('../../domain/entities.js');
        const resource = new BookableResource(
          req.body.id ?? randomUUID(),
          req.body.name,
          Number(req.body.basePrice ?? req.body.base_price ?? 0),
          req.body.categoryId ?? req.body.category_id,
          req.body.visualData ?? req.body.visual_data ?? null,
        );
        await repo.save(resource);
        res.status(201).json(resource);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── PUT /resources/:id ─────────────────────────────────────────────────────
  router.put(
    '/:id',
    authenticate(),
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const repo = new SqlResourceRepository(req.db);
        const existing = await repo.getById(req.params['id'] as string);
        if (!existing) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Recurso no encontrado' });
          return;
        }
        const { BookableResource } = await import('../../domain/entities.js');
        const updated = new BookableResource(
          existing.id,
          req.body.name      ?? existing.name,
          Number(req.body.basePrice ?? req.body.base_price ?? existing.basePrice),
          req.body.categoryId ?? req.body.category_id ?? existing.categoryId,
          req.body.visualData ?? req.body.visual_data ?? existing.visualData ?? null,
        );
        await repo.save(updated);
        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── DELETE /resources/:id ──────────────────────────────────────────────────
  router.delete(
    '/:id',
    authenticate(),
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const repo = new SqlResourceRepository(req.db);
        const deleted = await repo.delete(req.params['id'] as string);
        if (!deleted) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Recurso no encontrado' });
          return;
        }
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
