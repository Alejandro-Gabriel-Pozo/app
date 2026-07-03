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
// Tipos
// ---------------------------------------------------------------------------

interface AuthenticatedPlatformUser {
  id: string;
  email: string;
  role: string;
  [key: string]: unknown;
}

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
// Helpers
// ---------------------------------------------------------------------------

/** Normaliza query params que pueden ser string | string[] a string */
function firstString(val: string | string[] | undefined): string | undefined {
  if (val === undefined) return undefined;
  return Array.isArray(val) ? val[0] : val;
}

// ---------------------------------------------------------------------------
// Middleware de autenticación de plataforma
// ---------------------------------------------------------------------------

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
      const rawPayload = jwtService.verify(token);
      // Cast via unknown para evitar TS2352 entre JwtPayload y Record<string,unknown>
      const payload = rawPayload as unknown as AuthenticatedPlatformUser;

      if (payload.platform_role !== PlatformRole.SUPERADMIN) {
        res.status(403).json({
          code: 'FORBIDDEN',
          message: 'Acceso restringido a SUPERADMIN de plataforma',
        });
        return;
      }

      (req as Request & { platformUser: AuthenticatedPlatformUser }).platformUser = payload;
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

  router.use(authenticatePlatform());

  // -------------------------------------------------------------------------
  // GET /platform/stats
  // -------------------------------------------------------------------------
  router.get(
    '/stats',
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const allBusinesses = await platformRepository.listAll();

        const byPlan: Record<string, number> = {};
        const byStatus: Record<string, number> = {};

        for (const b of allBusinesses) {
          byPlan[b.plan]     = (byPlan[b.plan]     ?? 0) + 1;
          byStatus[b.status] = (byStatus[b.status] ?? 0) + 1;
        }

        res.json({
          total:     allBusinesses.length,
          active:    byStatus[BusinessStatus.ACTIVE]    ?? 0,
          pending:   byStatus[BusinessStatus.PENDING]   ?? 0,
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
  // GET /platform/businesses
  // -------------------------------------------------------------------------
  router.get(
    '/businesses',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        let businesses = await platformRepository.listAll();

        const status = firstString(req.query['status'] as string | string[] | undefined);
        const plan   = firstString(req.query['plan']   as string | string[] | undefined);
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
  // POST /platform/businesses
  // -------------------------------------------------------------------------
  router.post(
    '/businesses',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = CreateBusinessSchema.parse(req.body);

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
  // GET /platform/businesses/:id
  // -------------------------------------------------------------------------
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
  // PATCH /platform/businesses/:id/status
  // -------------------------------------------------------------------------
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

async function provisionInBackground(
  businessId: string,
  businessName: string,
  platformRepository: import('../../platform/platform.repository.js').PlatformRepository,
): Promise<void> {
  console.log(`[platform] Iniciando provisioning para negocio ${businessId}...`);

  const provisioned = await provisionBusinessDatabase(businessId, businessName);

  const schemaPath = resolve(__dirname, '../../db/schema.sql');
  const schemaSQL  = await readFile(schemaPath, 'utf-8');

  const { runSchemaOnNewDatabase } = await import(
    '../../platform/supabase.provisioner.js'
  );
  await runSchemaOnNewDatabase(provisioned.connectionString, schemaSQL);

  const encrypted = await encryptConnectionString(provisioned.connectionString);
  await platformRepository.activateBusiness(
    businessId,
    provisioned.projectId,
    encrypted,
  );

  console.log(`[platform] ✅ Negocio ${businessId} provisionado y activo.`);
}

// ---------------------------------------------------------------------------
// DTO
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
    createdAt:        b.createdAt,
    updatedAt:        b.updatedAt,
  };
}
