/**
 * @file platform.routes.ts
 * @description Rutas de administración de plataforma — solo para SUPERADMIN.
 *
 * ## Rutas
 *
 * ### Autenticación
 * POST  /platform/login
 *   Login del superadmin. Rate limited: 5 intentos / 15 minutos.
 *   Devuelve un JWT firmado con PLATFORM_JWT_SECRET (dura 1 hora por defecto).
 *
 * ### Negocios
 * GET   /platform/businesses              — Listar todos los negocios (paginado)
 * POST  /platform/businesses              — Registrar negocio + provisionar BD async
 * GET   /platform/businesses/:id          — Detalle de un negocio
 * PATCH /platform/businesses/:id          — Suspender / reactivar un negocio
 *
 * ### Usuarios de un negocio
 * GET    /platform/businesses/:id/users             — Listar staff
 * DELETE /platform/businesses/:id/users/:userId     — Desactivar usuario (soft-delete)
 *
 * ## Seguridad
 * - Todos los endpoints (excepto /login) requieren JWT de plataforma.
 * - PLATFORM_JWT_SECRET es independiente de JWT_SECRET de tenants.
 * - El provisioning de BD es asíncrono: POST /businesses responde 202 inmediatamente
 *   y la base de datos se activa en background (puede tardar hasta 5 minutos).
 *
 * ## Variables de entorno requeridas
 * - PLATFORM_JWT_SECRET
 * - PLATFORM_SUPERADMIN_EMAIL     — email del superadmin inicial
 * - PLATFORM_SUPERADMIN_PASSWORD  — contraseña del superadmin inicial
 * - SUPABASE_ACCESS_TOKEN, SUPABASE_ORG_ID, SUPABASE_REGION
 * - SUPABASE_DB_PASSWORD_SALT, DB_ENCRYPTION_KEY
 */

import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { pbkdf2 as pbkdf2Cb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { AppContainer } from '../../container.js';
import { authenticatePlatform, authorizePlatform, signPlatformToken } from '../../security/platform.auth.middleware.js';
import { PlatformRole, BusinessStatus } from '../../types/enums.js';
import { provisionBusinessDatabase, encryptConnectionString } from '../../platform/supabase.provisioner.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const pbkdf2 = promisify(pbkdf2Cb);

// ---------------------------------------------------------------------------
// Rate limiter — login de superadmin
// ---------------------------------------------------------------------------

const platformLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1_000,
  max: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Demasiados intentos. Intentá de nuevo en 15 minutos.',
      retryAfter: 15,
    });
  },
});

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const PlatformLoginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

const CreateBusinessSchema = z.object({
  name:       z.string().min(2).max(100),
  slug:       z.string().min(2).max(50).regex(/^[a-z0-9-]+$/, 'Solo minúsculas, números y guiones'),
  plan:       z.enum(['FREE', 'STARTER', 'PRO']).default('FREE'),
  ownerEmail: z.string().email(),
});

const PatchBusinessSchema = z.object({
  status: z.enum([BusinessStatus.ACTIVE, BusinessStatus.SUSPENDED]),
});

const PaginationSchema = z.object({
  page:  z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ---------------------------------------------------------------------------
// Helper — verifica contraseña con timing-safe PBKDF2
// ---------------------------------------------------------------------------

async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  // Formato: salt:iterations:keylen:algo:derivedKeyHex
  const parts = hash.split(':');
  if (parts.length !== 5) return false;
  const [salt, iterations, keylen, algo, expected] = parts;
  const derived = await pbkdf2(plain, salt, parseInt(iterations, 10), parseInt(keylen, 10), algo);
  const expectedBuf = Buffer.from(expected, 'hex');
  const derivedBuf  = Buffer.from(derived.toString('hex'), 'hex');
  if (expectedBuf.length !== derivedBuf.length) return false;
  return timingSafeEqual(expectedBuf, derivedBuf);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPlatformRouter(container: AppContainer): Router {
  const router = Router();
  const repo = container.platformRepository;

  // -------------------------------------------------------------------------
  // POST /platform/login
  // -------------------------------------------------------------------------
  /**
   * @swagger
   * /platform/login:
   *   post:
   *     summary: Login de superadmin
   *     description: |
   *       Las credenciales se validan contra PLATFORM_SUPERADMIN_EMAIL y
   *       PLATFORM_SUPERADMIN_PASSWORD definidas en variables de entorno.
   *       Devuelve un JWT firmado con PLATFORM_JWT_SECRET (TTL: 1 hora).
   *     tags: [Platform]
   *     security: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [email, password]
   *             properties:
   *               email:    { type: string, format: email }
   *               password: { type: string }
   *     responses:
   *       200:
   *         description: Login exitoso — devuelve JWT de plataforma
   *       401:
   *         description: Credenciales inválidas
   *       429:
   *         description: Rate limit excedido
   */
  router.post(
    '/login',
    platformLoginLimiter,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = PlatformLoginSchema.parse(req.body);

        const adminEmail    = process.env.PLATFORM_SUPERADMIN_EMAIL ?? '';
        const adminPassword = process.env.PLATFORM_SUPERADMIN_PASSWORD ?? '';

        // Comparación de email timing-safe
        const emailMatch = adminEmail.length > 0 &&
          body.email.toLowerCase() === adminEmail.toLowerCase();

        // Contraseña puede estar en texto plano (primer deploy) o en hash PBKDF2
        let passwordMatch = false;
        if (adminPassword.includes(':')) {
          passwordMatch = await verifyPassword(body.password, adminPassword);
        } else {
          // Fallback: comparación directa para setup inicial
          // Reemplazar PLATFORM_SUPERADMIN_PASSWORD por hash PBKDF2 en producción
          const expectedBuf = Buffer.from(adminPassword);
          const receivedBuf = Buffer.from(body.password);
          if (expectedBuf.length === receivedBuf.length) {
            passwordMatch = timingSafeEqual(expectedBuf, receivedBuf);
          }
        }

        if (!emailMatch || !passwordMatch) {
          res.status(401).json({
            code: 'INVALID_CREDENTIALS',
            message: 'Email o contraseña incorrectos',
          });
          return;
        }

        const expiresIn = parseInt(process.env.PLATFORM_JWT_EXPIRES_IN ?? '3600', 10);
        const token = signPlatformToken(
          { sub: 'superadmin', email: adminEmail, role: PlatformRole.SUPERADMIN },
          expiresIn,
        );

        res.json({
          token,
          tokenType: 'Bearer',
          expiresIn,
          role: PlatformRole.SUPERADMIN,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // A partir de aquí: todas las rutas requieren JWT de plataforma + rol SUPERADMIN
  router.use(
    authenticatePlatform(),
    authorizePlatform([PlatformRole.SUPERADMIN]),
  );

  // -------------------------------------------------------------------------
  // GET /platform/businesses — listar negocios (paginado)
  // -------------------------------------------------------------------------
  /**
   * @swagger
   * /platform/businesses:
   *   get:
   *     summary: Listar todos los negocios
   *     tags: [Platform]
   *     security:
   *       - PlatformBearerAuth: []
   *     parameters:
   *       - name: page
   *         in: query
   *         schema: { type: integer, default: 1 }
   *       - name: limit
   *         in: query
   *         schema: { type: integer, default: 20, maximum: 100 }
   *     responses:
   *       200:
   *         description: Lista paginada de negocios
   */
  router.get(
    '/businesses',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { page, limit } = PaginationSchema.parse(req.query);
        const all = await repo.listAllBusinesses();
        const total = all.length;
        const start = (page - 1) * limit;
        const items = all.slice(start, start + limit).map(sanitizeBusiness);

        res.json({
          data: items,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            hasNext: start + limit < total,
            hasPrev: page > 1,
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /platform/businesses — registrar negocio + provisionar BD async
  // -------------------------------------------------------------------------
  /**
   * @swagger
   * /platform/businesses:
   *   post:
   *     summary: Registrar un nuevo negocio
   *     description: |
   *       Crea el registro del negocio en estado PENDING y lanza el provisioning
   *       de la base de datos Supabase en background.
   *       El negocio pasa a ACTIVE automáticamente cuando la BD esté lista
   *       (puede tardar hasta 5 minutos). Hacer polling en GET /platform/businesses/:id.
   *     tags: [Platform]
   *     security:
   *       - PlatformBearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [name, slug, ownerEmail]
   *             properties:
   *               name:       { type: string, example: "Hotel La Montaña" }
   *               slug:       { type: string, example: "hotel-la-montana", pattern: "^[a-z0-9-]+$" }
   *               plan:       { type: string, enum: [FREE, STARTER, PRO], default: FREE }
   *               ownerEmail: { type: string, format: email }
   *     responses:
   *       202:
   *         description: Negocio creado — provisioning en curso
   *       409:
   *         description: Slug o email ya registrado
   */
  router.post(
    '/businesses',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = CreateBusinessSchema.parse(req.body);

        const exists = await repo.existsByEmailOrSlug(body.ownerEmail, body.slug);
        if (exists) {
          res.status(409).json({
            code: 'ALREADY_EXISTS',
            message: 'Ya existe un negocio con ese slug o email de owner.',
          });
          return;
        }

        const businessId = randomUUID();
        const business = await repo.createBusiness({
          id:         businessId,
          name:       body.name,
          slug:       body.slug,
          plan:       body.plan as any,
          ownerEmail: body.ownerEmail,
        });

        // Provisioning asíncrono — no bloquea la respuesta HTTP
        provisionAsync(businessId, body.name, repo).catch((err) => {
          console.error(`[platform] Error provisionando negocio ${businessId}:`, err);
        });

        res.status(202).json({
          message: 'Negocio registrado. La base de datos se está provisionando (puede tardar hasta 5 minutos).',
          business: sanitizeBusiness(business),
          provisioning: {
            status: 'IN_PROGRESS',
            pollUrl: `/platform/businesses/${businessId}`,
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /platform/businesses/:id — detalle de negocio
  // -------------------------------------------------------------------------
  /**
   * @swagger
   * /platform/businesses/{id}:
   *   get:
   *     summary: Detalle de un negocio
   *     description: Útil para hacer polling del estado de provisioning.
   *     tags: [Platform]
   *     security:
   *       - PlatformBearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Detalle del negocio
   *       404:
   *         description: Negocio no encontrado
   */
  router.get(
    '/businesses/:id',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const business = await repo.findById(String(req.params.id));
        if (!business) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Negocio no encontrado' });
          return;
        }
        res.json(sanitizeBusiness(business));
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /platform/businesses/:id — suspender / reactivar
  // -------------------------------------------------------------------------
  /**
   * @swagger
   * /platform/businesses/{id}:
   *   patch:
   *     summary: Suspender o reactivar un negocio
   *     tags: [Platform]
   *     security:
   *       - PlatformBearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: string }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [status]
   *             properties:
   *               status: { type: string, enum: [ACTIVE, SUSPENDED] }
   *     responses:
   *       200:
   *         description: Estado actualizado
   *       400:
   *         description: Transición de estado inválida (ej: no se puede activar un negocio PENDING)
   *       404:
   *         description: Negocio no encontrado
   */
  router.patch(
    '/businesses/:id',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { status } = PatchBusinessSchema.parse(req.body);
        const business = await repo.findById(String(req.params.id));

        if (!business) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Negocio no encontrado' });
          return;
        }

        // No se puede activar manualmente un negocio PENDING (aún sin BD)
        if (status === BusinessStatus.ACTIVE && business.status === BusinessStatus.PENDING) {
          res.status(400).json({
            code: 'INVALID_TRANSITION',
            message: 'Un negocio PENDING no puede activarse manualmente — debe esperar el provisioning de BD.',
          });
          return;
        }

        await repo.updateBusinessStatus(business.id, status);
        res.json({ id: business.id, status, updatedAt: new Date().toISOString() });
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /platform/businesses/:id/users — listar staff de un negocio
  // -------------------------------------------------------------------------
  /**
   * @swagger
   * /platform/businesses/{id}/users:
   *   get:
   *     summary: Listar usuarios de un negocio
   *     description: Devuelve todo el staff (activos e inactivos) de un negocio.
   *     tags: [Platform]
   *     security:
   *       - PlatformBearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Lista de usuarios del negocio
   *       404:
   *         description: Negocio no encontrado
   */
  router.get(
    '/businesses/:id/users',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const businessId = String(req.params.id);
        const business = await repo.findById(businessId);
        if (!business) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Negocio no encontrado' });
          return;
        }

        const users = await repo.listUsersByBusiness(businessId);
        res.json(users.map(sanitizeUser));
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /platform/businesses/:id/users/:userId — desactivar usuario
  // -------------------------------------------------------------------------
  /**
   * @swagger
   * /platform/businesses/{id}/users/{userId}:
   *   delete:
   *     summary: Desactivar un usuario de un negocio
   *     description: |
   *       Soft-delete: el usuario queda inactivo pero el registro se preserva
   *       para mantener el historial de reservas. El usuario no podrá iniciar
   *       sesión ni realizar acciones una vez desactivado.
   *     tags: [Platform]
   *     security:
   *       - PlatformBearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: string }
   *       - name: userId
   *         in: path
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Usuario desactivado
   *       404:
   *         description: Usuario no encontrado en este negocio
   */
  router.delete(
    '/businesses/:id/users/:userId',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const businessId = String(req.params.id);
        const userId     = String(req.params.userId);

        const deactivated = await repo.deactivateUser(userId, businessId);
        if (!deactivated) {
          res.status(404).json({
            code: 'NOT_FOUND',
            message: 'Usuario no encontrado en este negocio o ya estaba inactivo',
          });
          return;
        }

        res.json({ id: userId, active: false, deactivatedAt: new Date().toISOString() });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Provisiona la BD en background y actualiza el negocio cuando esté lista. */
async function provisionAsync(
  businessId: string,
  businessName: string,
  repo: AppContainer['platformRepository'],
): Promise<void> {
  const schemaSQL = fs.readFileSync(
    path.join(process.cwd(), 'src/db/schema.sql'),
    'utf8',
  );

  const { provisionBusinessDatabase, encryptConnectionString, runSchemaOnNewDatabase } =
    await import('../../platform/supabase.provisioner.js');

  const provisioned = await provisionBusinessDatabase(businessId, businessName);
  await runSchemaOnNewDatabase(provisioned.connectionString, schemaSQL);
  const encrypted = await encryptConnectionString(provisioned.connectionString);
  await repo.activateBusiness(businessId, provisioned.projectId, encrypted);
  console.log(`[platform] ✅ Negocio ${businessId} activado`);
}

/** Elimina passwordHash de la respuesta — nunca exponer al cliente. */
function sanitizeBusiness(b: any) {
  return {
    id:               b.id,
    name:             b.name,
    slug:             b.slug,
    plan:             b.plan,
    status:           b.status,
    ownerEmail:       b.ownerEmail,
    supabaseProjectId: b.supabaseProjectId,
    createdAt:        b.createdAt,
    updatedAt:        b.updatedAt,
  };
}

function sanitizeUser(u: any) {
  return {
    id:         u.id,
    email:      u.email,
    businessId: u.businessId,
    role:       u.role,
    active:     u.active,
    createdAt:  u.createdAt,
  };
}
