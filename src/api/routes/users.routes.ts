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
 *
 * ## Nombres de métodos de PlatformRepository
 * - listUsersByBusiness(businessId)              ← GET /
 * - findUserByIdAndBusiness(id, businessId)      ← GET /:id
 * - createPlatformUser(input)                    ← POST /
 * - updateUser(userId, businessId, input)        ← PUT /:id  (orden: id, businessId, input)
 * - deactivateUser(userId, businessId)           ← DELETE /:id (soft-delete)
 */

import { Router } from 'express';
import { authenticate, authorize } from '../../security/auth.middleware.js';
import { Roles } from '../../security/roles.js';
import { UserRole } from '../../types/enums.js';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../../security/auth.middleware.js';
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
        const businessId = req.user!.businessId as string;
        const users = await platformRepo.listUsersByBusiness(businessId);
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
        const businessId = req.user!.businessId as string;
        const user = await platformRepo.findUserByIdAndBusiness(
          req.params['id'] as string,
          businessId,
        );
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
        const businessId = req.user!.businessId as string;

        if (req.body.role === UserRole.OWNER) {
          res.status(400).json({
            code: 'INVALID_ROLE',
            message: 'El rol OWNER se asigna automáticamente al crear el negocio.',
          });
          return;
        }

        const passwordHash = await hashPassword(req.body.password as string);
        const user = await platformRepo.createPlatformUser({
          id:           req.body.id ?? randomUUID(),
          email:        req.body.email as string,
          businessId,
          role:         req.body.role as string,
          passwordHash,
        });
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
        const businessId = req.user!.businessId as string;
        const userId = req.params['id'] as string;

        if (req.body.role === UserRole.OWNER) {
          res.status(400).json({
            code: 'INVALID_ROLE',
            message: 'No se puede asignar el rol OWNER desde la API.',
          });
          return;
        }

        const input: { email?: string; role?: string; passwordHash?: string } = {};
        if (req.body.email)    input.email = req.body.email as string;
        if (req.body.role)     input.role  = req.body.role as string;
        if (req.body.password) input.passwordHash = await hashPassword(req.body.password as string);

        const updated = await platformRepo.updateUser(userId, businessId, input);
        if (!updated) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Usuario no encontrado' });
          return;
        }
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
        const businessId = req.user!.businessId as string;
        await platformRepo.deactivateUser(req.params['id'] as string, businessId);
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
