/**
 * @file platform.routes.ts
 * @description Rutas de gestión de plataforma — solo para SUPERADMIN.
 *
 * ## Rutas
 *
 * Todas requieren JWT con platformRole=SUPERADMIN (via requirePlatformRole).
 * No pasan por tenantMiddleware ni por el stack de auth por-tenant.
 *
 * ### Negocios
 * POST  /platform/businesses                 — registrar nuevo tenant
 * GET   /platform/businesses                 — listar todos (paginado)
 * GET   /platform/businesses/:id             — detalle de un negocio
 * PATCH /platform/businesses/:id             — actualizar nombre/plan/status
 * POST  /platform/businesses/:id/suspend     — suspender tenant
 * POST  /platform/businesses/:id/activate    — reactivar tenant suspendido
 *
 * ### Stats
 * GET   /platform/stats                      — KPIs globales de la plataforma
 *
 * ## Provisioning
 * Al registrar un negocio (POST /platform/businesses), el endpoint:
 * 1. Persiste el negocio en estado PENDING
 * 2. Lanza el provisioning de Supabase en background (no bloquea la respuesta)
 * 3. Cuando el proyecto Supabase está activo, actualiza el negocio a ACTIVE
 *
 * ## Seguridad
 * - PLATFORM_JWT_SECRET distinto de JWT_SECRET (contextos separados)
 * - Ninguna ruta de este router aplica tenantMiddleware
 * - El router se monta en app.ts ANTES de tenantMiddleware
 */

import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requirePlatformRole } from '../../security/platform.auth.middleware.js';
import {
  PlatformRepository,
  CreateBusinessInput,
} from '../../platform/platform.repository.js';
import {
  provisionBusinessDatabase,
  encryptConnectionString,
  runSchemaOnNewDatabase,
} from '../../platform/supabase.provisioner.js';
import { PlatformRole, BusinessPlan, BusinessStatus } from '../../types/enums.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Schemas de validación
// ---------------------------------------------------------------------------

const CreateBusinessSchema = z.object({
  name:       z.string().min(2).max(100),
  slug:       z.string().min(2).max(50).regex(/^[a-z0-9-]+$/, {
    message: 'El slug solo puede contener letras minúsculas, números y guiones',
  }),
  plan:       z.nativeEnum(BusinessPlan).default(BusinessPlan.FREE),
  ownerEmail: z.string().email(),
});

const UpdateBusinessSchema = z.object({
  name:   z.string().min(2).max(100).optional(),
  plan:   z.nativeEnum(BusinessPlan).optional(),
  status: z.nativeEnum(BusinessStatus).optional(),
});

const ListBusinessesQuerySchema = z.object({
  page:   z.coerce.number().int().min(1).default(1),
  limit:  z.coerce.number().int().min(1).max(100).default(20),
  status: z.nativeEnum(BusinessStatus).optional(),
});

// ---------------------------------------------------------------------------
// Factory del router
// ---------------------------------------------------------------------------

export function createPlatformRouter(platformRepository: PlatformRepository): Router {
  const router = Router();

  // Todas las rutas de este router requieren SUPERADMIN
  router.use(requirePlatformRole(PlatformRole.SUPERADMIN));

  // -------------------------------------------------------------------------
  // POST /platform/businesses — registrar + provisionar nuevo tenant
  // -------------------------------------------------------------------------
  /**
   * @swagger
   * /platform/businesses:
   *   post:
   *     summary: Registrar nuevo negocio y provisionar su base de datos
   *     description: |
   *       Crea el registro del negocio en estado PENDING y lanza el provisioning
   *       de Supabase en background. La respuesta es inmediata (202 Accepted).
   *       El negocio pasa a ACTIVE cuando la BD esté lista (~1-3 min).
   *     tags: [Platform - SUPERADMIN]
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
   *               name:       { type: string, example: "Hotel Patagonia" }
   *               slug:       { type: string, example: "hotel-patagonia", description: "Identificador único, solo minúsculas y guiones" }
   *               plan:       { type: string, enum: [FREE, PRO, ENTERPRISE], default: FREE }
   *               ownerEmail: { type: string, format: email, example: "admin@hotelpatagonia.com" }
   *     responses:
   *       202:
   *         description: Negocio registrado — provisioning iniciado en background
   *       400:
   *         description: Datos inválidos o slug/email ya existente
   */
  router.post(
    '/businesses',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = CreateBusinessSchema.parse(req.body);

        // Verificar unicidad de slug y ownerEmail
        const exists = await platformRepository.existsByEmailOrSlug(body.ownerEmail, body.slug);
        if (exists) {
          res.status(400).json({
            code: 'ALREADY_EXISTS',
            message: 'Ya existe un negocio con ese email de dueño o ese slug.',
          });
          return;
        }

        const businessId = randomUUID();
        const input: CreateBusinessInput = {
          id:         businessId,
          name:       body.name,
          slug:       body.slug,
          plan:       body.plan,
          ownerEmail: body.ownerEmail,
        };

        const business = await platformRepository.createBusiness(input);

        // Provisioning en background — no bloquea la respuesta HTTP
        provisionAndActivate(businessId, body.name, platformRepository).catch((err) => {
          console.error(`[platform] Error provisionando negocio ${businessId}:`, err);
        });

        res.status(202).json({
          message: 'Negocio registrado. Provisioning de base de datos iniciado en background.',
          business: toBusinessDto(business),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /platform/businesses — listar todos los negocios (paginado)
  // -------------------------------------------------------------------------
  /**
   * @swagger
   * /platform/businesses:
   *   get:
   *     summary: Listar todos los negocios de la plataforma
   *     tags: [Platform - SUPERADMIN]
   *     security:
   *       - PlatformBearerAuth: []
   *     parameters:
   *       - name: page
   *         in: query
   *         schema: { type: integer, default: 1 }
   *       - name: limit
   *         in: query
   *         schema: { type: integer, default: 20, maximum: 100 }
   *       - name: status
   *         in: query
   *         schema: { type: string, enum: [PENDING, ACTIVE, SUSPENDED, CANCELLED] }
   *     responses:
   *       200:
   *         description: Lista paginada de negocios
   */
  router.get(
    '/businesses',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const query = ListBusinessesQuerySchema.parse(req.query);
        const allBusinesses = await platformRepository.listAllBusinesses(query.status);

        // Paginación manual sobre el array (listAllBusinesses ya filtra por status)
        const total  = allBusinesses.length;
        const offset = (query.page - 1) * query.limit;
        const items  = allBusinesses.slice(offset, offset + query.limit);

        res.json({
          data: items.map(toBusinessDto),
          pagination: {
            page:       query.page,
            limit:      query.limit,
            total,
            totalPages: Math.ceil(total / query.limit),
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /platform/businesses/:id — detalle de un negocio
  // -------------------------------------------------------------------------
  /**
   * @swagger
   * /platform/businesses/{id}:
   *   get:
   *     summary: Obtener detalle de un negocio
   *     tags: [Platform - SUPERADMIN]
   *     security:
   *       - PlatformBearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Datos del negocio
   *       404:
   *         description: Negocio no encontrado
   */
  router.get(
    '/businesses/:id',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const business = await platformRepository.findById(String(req.params.id));
        if (!business) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Negocio no encontrado' });
          return;
        }
        res.json(toBusinessDto(business));
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /platform/businesses/:id — actualizar nombre/plan/status
  // -------------------------------------------------------------------------
  /**
   * @swagger
   * /platform/businesses/{id}:
   *   patch:
   *     summary: Actualizar datos de un negocio
   *     tags: [Platform - SUPERADMIN]
   *     security:
   *       - PlatformBearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: string }
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               name:   { type: string }
   *               plan:   { type: string, enum: [FREE, PRO, ENTERPRISE] }
   *               status: { type: string, enum: [PENDING, ACTIVE, SUSPENDED, CANCELLED] }
   *     responses:
   *       200:
   *         description: Negocio actualizado
   *       404:
   *         description: Negocio no encontrado
   */
  router.patch(
    '/businesses/:id',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const businessId = String(req.params.id);
        const body = UpdateBusinessSchema.parse(req.body);

        const existing = await platformRepository.findById(businessId);
        if (!existing) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Negocio no encontrado' });
          return;
        }

        const updated = await platformRepository.updateBusiness(businessId, body);
        res.json(toBusinessDto(updated!));
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /platform/businesses/:id/suspend — suspender tenant
  // -------------------------------------------------------------------------
  /**
   * @swagger
   * /platform/businesses/{id}/suspend:
   *   post:
   *     summary: Suspender un tenant activo
   *     description: |
   *       Cambia el estado del negocio a SUSPENDED.
   *       Los usuarios del negocio recibirán 403 en sus próximas requests
   *       (tenantMiddleware verifica el status del negocio).
   *     tags: [Platform - SUPERADMIN]
   *     security:
   *       - PlatformBearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Tenant suspendido
   *       400:
   *         description: El negocio ya está suspendido o no está en estado suspendible
   *       404:
   *         description: Negocio no encontrado
   */
  router.post(
    '/businesses/:id/suspend',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const businessId = String(req.params.id);
        const business = await platformRepository.findById(businessId);

        if (!business) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Negocio no encontrado' });
          return;
        }

        if (business.status === BusinessStatus.SUSPENDED) {
          res.status(400).json({
            code: 'ALREADY_SUSPENDED',
            message: 'El negocio ya está suspendido',
          });
          return;
        }

        if (business.status !== BusinessStatus.ACTIVE) {
          res.status(400).json({
            code: 'INVALID_STATUS',
            message: `No se puede suspender un negocio en estado ${business.status}`,
          });
          return;
        }

        const updated = await platformRepository.updateBusiness(businessId, {
          status: BusinessStatus.SUSPENDED,
        });

        res.json({
          message: 'Tenant suspendido. Los usuarios del negocio recibirán 403 en sus próximas requests.',
          business: toBusinessDto(updated!),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /platform/businesses/:id/activate — reactivar tenant suspendido
  // -------------------------------------------------------------------------
  /**
   * @swagger
   * /platform/businesses/{id}/activate:
   *   post:
   *     summary: Reactivar un tenant suspendido
   *     tags: [Platform - SUPERADMIN]
   *     security:
   *       - PlatformBearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Tenant reactivado
   *       400:
   *         description: El negocio no está suspendido
   *       404:
   *         description: Negocio no encontrado
   */
  router.post(
    '/businesses/:id/activate',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const businessId = String(req.params.id);
        const business = await platformRepository.findById(businessId);

        if (!business) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Negocio no encontrado' });
          return;
        }

        if (business.status !== BusinessStatus.SUSPENDED) {
          res.status(400).json({
            code: 'INVALID_STATUS',
            message: `Solo se puede reactivar un negocio SUSPENDED. Estado actual: ${business.status}`,
          });
          return;
        }

        const updated = await platformRepository.updateBusiness(businessId, {
          status: BusinessStatus.ACTIVE,
        });

        res.json({
          message: 'Tenant reactivado correctamente.',
          business: toBusinessDto(updated!),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /platform/stats — KPIs globales
  // -------------------------------------------------------------------------
  /**
   * @swagger
   * /platform/stats:
   *   get:
   *     summary: KPIs globales de la plataforma
   *     tags: [Platform - SUPERADMIN]
   *     security:
   *       - PlatformBearerAuth: []
   *     responses:
   *       200:
   *         description: Métricas agregadas de todos los negocios
   */
  router.get(
    '/stats',
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const stats = await platformRepository.getPlatformStats();
        res.json(stats);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

/**
 * Provisiona la BD de Supabase y activa el negocio.
 * Se llama en background (sin await en el handler).
 */
async function provisionAndActivate(
  businessId: string,
  businessName: string,
  repo: PlatformRepository,
): Promise<void> {
  console.log(`[platform] Iniciando provisioning para negocio ${businessId}`);

  const provisioned = await provisionBusinessDatabase(businessId, businessName);
  const encryptedUrl = await encryptConnectionString(provisioned.connectionString);

  // Cargar y aplicar el schema en la nueva BD
  const schemaPath = join(__dirname, '../../db/schema.sql');
  const schemaSQL  = readFileSync(schemaPath, 'utf-8');
  await runSchemaOnNewDatabase(provisioned.connectionString, schemaSQL);

  // Marcar como ACTIVE en la BD central
  await repo.activateBusiness(businessId, provisioned.projectId, encryptedUrl);

  console.log(`[platform] ✅ Negocio ${businessId} activo y listo`);
}

/**
 * DTO público de Business — nunca expone dbUrlEncrypted ni campos internos.
 */
function toBusinessDto(business: {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  ownerEmail: string;
  supabaseProjectId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id:               business.id,
    name:             business.name,
    slug:             business.slug,
    plan:             business.plan,
    status:           business.status,
    ownerEmail:       business.ownerEmail,
    supabaseProjectId: business.supabaseProjectId,
    createdAt:        business.createdAt,
    updatedAt:        business.updatedAt,
  };
}
