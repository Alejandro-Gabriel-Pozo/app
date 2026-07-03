/**
 * @file platform.routes.ts
 * @description Rutas de gestión de plataforma — exclusivas para SUPERADMIN.
 *
 * ## Autenticación
 * Las rutas protegidas requieren JWT con `platform_role: SUPERADMIN`.
 * El middleware `authenticatePlatform()` verifica este claim.
 *
 * ## Rutas
 *
 * ### Públicas
 * POST  /platform/login                    — obtener JWT de SUPERADMIN
 *
 * ### Protegidas (requieren JWT SUPERADMIN)
 * GET   /platform/businesses               — listar todos los negocios
 * POST  /platform/businesses               — registrar negocio + provisionar BD async
 * GET   /platform/businesses/:id           — detalle de un negocio
 * PATCH /platform/businesses/:id/status    — cambiar estado (ACTIVE/SUSPENDED/CANCELLED)
 * GET   /platform/stats                    — estadísticas globales de la plataforma
 *
 * ## Notas de diseño
 * - El provisioning de BD Supabase es asíncrono: `POST /businesses` responde
 *   202 inmediatamente con status=PENDING y dispara el provisioning en background.
 *   El SUPERADMIN puede consultar el estado con `GET /businesses/:id`.
 * - `PATCH /businesses/:id/status` con `SUSPENDED` bloquea el tenant en el
 *   middleware de tenant pero NO borra datos.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { JwtService } from '../../security/jwt.service.js';
import { PlatformContainer } from '../../../src/platform/platform.container.js';
import { BusinessPlan, BusinessStatus, PlatformRole } from '../../types/enums.js';
import {
  provisionBusinessDatabase,
  encryptConnectionString,
} from '../../platform/supabase.provisioner.js';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const PlatformLoginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

const CreateBusinessSchema = z.object({
  name:       z.string().min(2).max(100),
  slug:       z.string().min(2).max(40).regex(/^[a-z0-9-]+$/, {
    message: 'El slug solo puede contener letras minúsculas, números y guiones',
  }),
  plan:       z.nativeEnum(BusinessPlan),
  ownerEmail: z.string().email(),
});

const UpdateBusinessStatusSchema = z.object({
  status: z.enum([
    BusinessStatus.ACTIVE,
    BusinessStatus.SUSPENDED,
    BusinessStatus.CANCELLED,
  ] as [string, ...string[]]),
  reason: z.string().max(500).optional(),
});

// ---------------------------------------------------------------------------
// Middleware de autenticación de plataforma
// ---------------------------------------------------------------------------

/**
 * Verifica que el JWT tenga `platform_role: SUPERADMIN`.
 * Independiente de `authenticate()` de los tenants para evitar
 * que un token de negocio pueda acceder a rutas de plataforma.
 */
function authenticatePlatform() {
  const jwtService = new JwtService();

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ code: 'MISSING_TOKEN', message: 'Token de autenticación requerido' });
      return;
    }

    const token = authHeader.slice(7);
    try {
      const payload = await jwtService.verify(token);

      // Verificar que sea explícitamente un token de plataforma
      if ((payload as Record<string, unknown>).platform_role !== PlatformRole.SUPERADMIN) {
        res.status(403).json({
          code: 'FORBIDDEN',
          message: 'Acceso restringido a SUPERADMIN de plataforma',
        });
        return;
      }

      // Guardar el payload en req para uso en handlers
      (req as Request & { platformUser: Record<string, unknown> }).platformUser = payload as Record<string, unknown>;
      next();
    } catch {
      res.status(401).json({ code: 'INVALID_TOKEN', message: 'Token inválido o expirado' });
    }
  };
}

// ---------------------------------------------------------------------------
// Factory del router
// ---------------------------------------------------------------------------

export function createPlatformRouter(container: PlatformContainer): Router {
  const router = Router();
  const { platformRepository, platformAuthService } = container;

  // -------------------------------------------------------------------------
  // POST /platform/login — público
  // -------------------------------------------------------------------------
  /**
   * @swagger
   * /platform/login:
   *   post:
   *     summary: Login de SUPERADMIN
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
   *       200: { description: JWT de SUPERADMIN }
   *       401: { description: Credenciales inválidas }
   *       503: { description: Plataforma no configurada }
   */
  router.post(
    '/login',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body   = PlatformLoginSchema.parse(req.body);
        const result = await platformAuthService.login(body);
        res.json(result);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'INVALID_CREDENTIALS') {
          res.status(401).json({ code, message: 'Email o contraseña incorrectos' });
          return;
        }
        if (code === 'PLATFORM_AUTH_NOT_CONFIGURED') {
          res.status(503).json({ code, message: (err as Error).message });
          return;
        }
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // A partir de aquí: requieren JWT SUPERADMIN
  // -------------------------------------------------------------------------
  router.use(authenticatePlatform());

  // -------------------------------------------------------------------------
  // GET /platform/stats — estadísticas globales
  // -------------------------------------------------------------------------
  /**
   * @swagger
   * /platform/stats:
   *   get:
   *     summary: Estadísticas globales de la plataforma
   *     tags: [Platform]
   *     security: [{ BearerAuth: [] }]
   *     responses:
   *       200:
   *         description: Totales por plan y estado
   */
  router.get(
    '/stats',
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        // Obtener todos los negocios para calcular stats en memoria
        // En producción esto debería ser una query agregada en SQL;
        // para el volumen actual (< 1000 negocios) este enfoque es suficiente.
        const allBusinesses = await platformRepository.listAll();

        const byPlan: Record<string, number> = {};
        const byStatus: Record<string, number> = {};

        for (const b of allBusinesses) {
          byPlan[b.plan]     = (byPlan[b.plan]     ?? 0) + 1;
          byStatus[b.status] = (byStatus[b.status] ?? 0) + 1;
        }

        res.json({
          total:    allBusinesses.length,
          active:   byStatus[BusinessStatus.ACTIVE]    ?? 0,
          pending:  byStatus[BusinessStatus.PENDING]   ?? 0,
          suspended: byStatus[BusinessStatus.SUSPENDED] ?? 0,
          cancelled: byStatus[BusinessStatus.CANCELLED] ?? 0,
          byPlan,
          byStatus,
          generatedAt: new Date().toISOString(),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /platform/businesses — listar negocios
  // -------------------------------------------------------------------------
  /**
   * @swagger
   * /platform/businesses:
   *   get:
   *     summary: Listar todos los negocios registrados
   *     tags: [Platform]
   *     security: [{ BearerAuth: [] }]
   *     parameters:
   *       - name: status
   *         in: query
   *         schema: { type: string, enum: [PENDING, ACTIVE, SUSPENDED, CANCELLED] }
   *       - name: plan
   *         in: query
   *         schema: { type: string, enum: [FREE, STARTER, PRO] }
   *     responses:
   *       200: { description: Lista de negocios }
   */
  router.get(
    '/businesses',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        let businesses = await platformRepository.listAll();

        // Filtros opcionales por query param
        const { status, plan } = req.query;
        if (status) businesses = businesses.filter((b) => b.status === status);
        if (plan)   businesses = businesses.filter((b) => b.plan   === plan);

        res.json({
          businesses: businesses.map(toBusinessDto),
          total: businesses.length,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /platform/businesses — registrar nuevo negocio
  // -------------------------------------------------------------------------
  /**
   * @swagger
   * /platform/businesses:
   *   post:
   *     summary: Registrar un nuevo negocio y provisionar su BD
   *     description: |
   *       Responde 202 inmediatamente. El provisioning de la BD Supabase
   *       ocurre en background (puede tardar hasta 5 minutos).
   *       Consultá el estado con GET /platform/businesses/:id.
   *     tags: [Platform]
   *     security: [{ BearerAuth: [] }]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [name, slug, plan, ownerEmail]
   *             properties:
   *               name:       { type: string, example: "Hotel Patagonia" }
   *               slug:       { type: string, example: "hotel-patagonia" }
   *               plan:       { type: string, enum: [FREE, STARTER, PRO] }
   *               ownerEmail: { type: string, format: email }
   *     responses:
   *       202: { description: Negocio creado — provisioning en progreso }
   *       409: { description: Email o slug ya registrado }
   */
  router.post(
    '/businesses',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = CreateBusinessSchema.parse(req.body);

        // Verificar unicidad antes de crear
        const exists = await platformRepository.existsByEmailOrSlug(body.ownerEmail, body.slug);
        if (exists) {
          res.status(409).json({
            code: 'SLUG_OR_EMAIL_TAKEN',
            message: 'Ya existe un negocio con ese slug o email de propietario.',
          });
          return;
        }

        const businessId = randomUUID();
        const business   = await platformRepository.createBusiness({
          id:         businessId,
          name:       body.name,
          slug:       body.slug,
          plan:       body.plan,
          ownerEmail: body.ownerEmail,
        });

        // Provisioning asíncrono — no bloquea la respuesta
        provisionInBackground(businessId, body.name, platformRepository).catch((err) => {
          console.error(`[platform] Error provisionando negocio ${businessId}:`, err);
        });

        res.status(202).json({
          message: 'Negocio registrado. Provisionando base de datos en segundo plano (hasta 5 min).',
          business: toBusinessDto(business),
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
   *     summary: Ver detalle de un negocio
   *     tags: [Platform]
   *     security: [{ BearerAuth: [] }]
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200: { description: Datos del negocio }
   *       404: { description: Negocio no encontrado }
   */
  router.get(
    '/businesses/:id',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const business = await platformRepository.findById(req.params.id);
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
  // PATCH /platform/businesses/:id/status — suspender / activar / cancelar
  // -------------------------------------------------------------------------
  /**
   * @swagger
   * /platform/businesses/{id}/status:
   *   patch:
   *     summary: Cambiar estado de un negocio
   *     description: |
   *       - SUSPENDED: bloquea acceso del tenant (tenant middleware retorna 403)
   *       - ACTIVE: reactiva el acceso
   *       - CANCELLED: marca como cancelado (no se puede revertir)
   *     tags: [Platform]
   *     security: [{ BearerAuth: [] }]
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
   *               status: { type: string, enum: [ACTIVE, SUSPENDED, CANCELLED] }
   *               reason: { type: string, maxLength: 500 }
   *     responses:
   *       200: { description: Estado actualizado }
   *       400: { description: Transición de estado inválida }
   *       404: { description: Negocio no encontrado }
   */
  router.patch(
    '/businesses/:id/status',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body     = UpdateBusinessStatusSchema.parse(req.body);
        const business = await platformRepository.findById(req.params.id);

        if (!business) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Negocio no encontrado' });
          return;
        }

        // Validar transición de estado
        if (business.status === BusinessStatus.CANCELLED) {
          res.status(400).json({
            code: 'INVALID_TRANSITION',
            message: 'Un negocio cancelado no puede cambiar de estado.',
          });
          return;
        }

        if (business.status === body.status) {
          res.status(400).json({
            code: 'SAME_STATUS',
            message: `El negocio ya está en estado ${body.status}.`,
          });
          return;
        }

        await platformRepository.updateBusinessStatus(
          business.id,
          body.status as BusinessStatus,
        );

        if (body.reason) {
          console.info(
            `[platform] Negocio ${business.id} (${business.name}) → ${body.status}. ` +
            `Motivo: ${body.reason}`,
          );
        }

        const updated = await platformRepository.findById(business.id);
        res.json({
          message: `Estado actualizado a ${body.status}`,
          business: updated ? toBusinessDto(updated) : null,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

// ---------------------------------------------------------------------------
// Provisioning en background
// ---------------------------------------------------------------------------

/**
 * Llama al provisioner de Supabase y actualiza el negocio en la BD central
 * con el projectId y la connection string cifrada.
 *
 * Se ejecuta fuera del ciclo request/response — los errores se loguean
 * pero no son fatales para el servidor.
 */
async function provisionInBackground(
  businessId: string,
  businessName: string,
  platformRepository: import('../../platform/platform.repository.js').PlatformRepository,
): Promise<void> {
  console.log(`[platform] Iniciando provisioning para negocio ${businessId}...`);

  // 1. Crear el proyecto en Supabase
  const provisioned = await provisionBusinessDatabase(businessId, businessName);

  // 2. Ejecutar el schema del tenant en la nueva BD
  const schemaPath = resolve(__dirname, '../../db/schema.sql');
  const schemaSQL  = await readFile(schemaPath, 'utf-8');

  const { runSchemaOnNewDatabase } = await import(
    '../../platform/supabase.provisioner.js'
  );
  await runSchemaOnNewDatabase(provisioned.connectionString, schemaSQL);

  // 3. Cifrar y guardar la connection string en la BD central
  const encrypted = await encryptConnectionString(provisioned.connectionString);
  await platformRepository.activateBusiness(
    businessId,
    provisioned.projectId,
    encrypted,
  );

  console.log(`[platform] ✅ Negocio ${businessId} provisionado y activo.`);
}

// ---------------------------------------------------------------------------
// DTO — nunca exponer db_url_encrypted ni password hashes
// ---------------------------------------------------------------------------

function toBusinessDto(b: import('../../platform/platform.repository.js').Business) {
  return {
    id:               b.id,
    name:             b.name,
    slug:             b.slug,
    plan:             b.plan,
    status:           b.status,
    ownerEmail:       b.ownerEmail,
    supabaseProjectId: b.supabaseProjectId,
    // db_url_encrypted NUNCA se expone en la API
    createdAt:        b.createdAt,
    updatedAt:        b.updatedAt,
  };
}
