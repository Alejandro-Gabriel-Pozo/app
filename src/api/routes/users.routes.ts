/**
 * @file users.routes.ts
 *
 * Permisos por endpoint:
 *
 * GET    /users          — MANAGEMENT (OWNER, ADMIN)
 * GET    /users/:id      — MANAGEMENT
 * POST   /users          — MANAGEMENT
 * PUT    /users/:id      — MANAGEMENT
 * DELETE /users/:id      — OWNER_ONLY (solo el propietario puede eliminar usuarios)
 *
 * Nota: el rol OWNER no puede ser asignado desde la API — se asigna al crear
 * el negocio en la plataforma. El endpoint de creación lo rechaza explícitamente.
 *
 * Los usuarios son entidades de plataforma (tabla `users` en PLATFORM_DATABASE_URL).
 * El router recibe `platformRepo` como parámetro de fábrica para operar sobre
 * esa BD, en lugar de req.db (BD del tenant).
 */

import { Router } from 'express';
import { authenticate, authorize } from '../../security/auth.middleware.js';
import { Roles } from '../../security/roles.js';
import { UserRole } from '../../types/enums.js';
import type { PlatformRepository } from '../../platform/platform.repository.js';

export function createUsersRouter(platformRepo: PlatformRepository): Router {
  const router = Router();

  // ── GET /users ─────────────────────────────────────────────────────────────
  router.get(
    '/',
    authenticate(),
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId!;
        const users = await platformRepo.findUsersByBusiness(businessId);
        res.json(users);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /users/:id ─────────────────────────────────────────────────────────
  router.get(
    '/:id',
    authenticate(),
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId!;
        const user = await platformRepo.findUserById(req.params.id!, businessId);
        if (!user) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Usuario no encontrado' });
          return;
        }
        res.json(user);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── POST /users ────────────────────────────────────────────────────────────
  router.post(
    '/',
    authenticate(),
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId!;

        if (req.body.role === UserRole.OWNER) {
          res.status(400).json({
            code: 'INVALID_ROLE',
            message: 'El rol OWNER se asigna automáticamente al crear el negocio.',
          });
          return;
        }

        const user = await platformRepo.createUser({ ...req.body, businessId });
        res.status(201).json(user);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── PUT /users/:id ─────────────────────────────────────────────────────────
  router.put(
    '/:id',
    authenticate(),
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId!;

        if (req.body.role === UserRole.OWNER) {
          res.status(400).json({
            code: 'INVALID_ROLE',
            message: 'No se puede asignar el rol OWNER desde la API.',
          });
          return;
        }

        const updated = await platformRepo.updateUser(req.params.id!, req.body, businessId);
        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── DELETE /users/:id — solo OWNER ─────────────────────────────────────────
  router.delete(
    '/:id',
    authenticate(),
    authorize(Roles.OWNER_ONLY),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId!;
        await platformRepo.deleteUser(req.params.id!, businessId);
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
