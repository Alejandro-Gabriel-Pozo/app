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
 */

import { Router } from 'express';
import { authenticate, authorize } from '../../security/auth.middleware.js';
import { Roles } from '../../security/roles.js';
import type { ResourceService } from '../../services/resource.service.js';

export function createResourcesRouter(service: ResourceService): Router {
  const router = Router();

  // ── GET /resources ─────────────────────────────────────────────────────────
  router.get(
    '/',
    authenticate(),
    authorize(Roles.STAFF),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId!;
        const resources = await service.listResources(businessId);
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
        const businessId = req.user!.businessId!;
        const resource = await service.getResourceById(req.params.id!, businessId);
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
        const businessId = req.user!.businessId!;
        const resource = await service.createResource({ ...req.body, businessId });
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
        const businessId = req.user!.businessId!;
        const updated = await service.updateResource(req.params.id!, req.body, businessId);
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
        const businessId = req.user!.businessId!;
        await service.deleteResource(req.params.id!, businessId);
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
