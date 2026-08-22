/**
 * @file platform.routes.ts
 * @description Rutas de gestión de plataforma — exclusivas para SUPERADMIN.
 */

import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PlatformContainer } from './platform.container.js';
import { BusinessPlan, BusinessStatus } from '../types/enums.js';
import { authenticatePlatform } from './platform.auth.middleware.js';
import type { Business } from './platform.repository.js';
import { provisionTenantDatabase } from './neon-provisioning.js';
import { applyTenantSchema, encryptConnectionString } from './tenant-db.setup.js';

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

function firstString(val: unknown): string | undefined {
  if (val === undefined || val === null) return undefined;
  if (Array.isArray(val)) return String(val[0]);
  return String(val);
}

export function createPlatformRouter(container: PlatformContainer): Router {
  const router = Router();
  const { platformRepository, platformAuthService } = container;

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
      } catch (err) { next(err); }
    },
  );

  router.get(
    '/businesses',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        let businesses = await platformRepository.listAll();
        const status = firstString(req.query['status']);
        const plan   = firstString(req.query['plan']);
        if (status) businesses = businesses.filter((b) => b.status === status);
        if (plan)   businesses = businesses.filter((b) => b.plan   === plan);
        res.json({ businesses: businesses.map(toBusinessDto), total: businesses.length });
      } catch (err) { next(err); }
    },
  );

  router.post(
    '/businesses',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = CreateBusinessSchema.parse(req.body);
        const slugTaken = await platformRepository.findBySlug(body.slug);
        if (slugTaken) {
          res.status(409).json({
            code: 'SLUG_OR_EMAIL_TAKEN',
            message: 'Ya existe un negocio con ese slug.',
          });
          return;
        }
        const businessId = randomUUID();
        const business   = await platformRepository.createBusiness({
          id: businessId, name: body.name, slug: body.slug, plan: body.plan, ownerEmail: body.ownerEmail,
        });
        // Sin auto-provisioning (code review agosto 2026) — ver tenant-db.setup.ts.
        // El negocio queda PENDING; alguien con token de PLATAFORMA (19/08/2026 --
        // antes era autoservicio del dueño del negocio, ver admin.routes.ts) debe
        // llamar POST /api/admin/set-tenant-url con { businessId, databaseUrl } de
        // una connection string ya creada (y con schema.sql ya aplicado) para activarlo.
        res.status(201).json({
          message: 'Negocio registrado en estado PENDING. Falta activar su base de datos manualmente.',
          business: toBusinessDto(business),
        });
      } catch (err) { next(err); }
    },
  );

  router.get(
    '/businesses/:id',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const business = await platformRepository.findById(String(req.params['id']));
        if (!business) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Negocio no encontrado' });
          return;
        }
        res.json(toBusinessDto(business));
      } catch (err) { next(err); }
    },
  );

  router.patch(
    '/businesses/:id/status',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body     = UpdateBusinessStatusSchema.parse(req.body);
        const business = await platformRepository.findById(String(req.params['id']));
        if (!business) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Negocio no encontrado' });
          return;
        }
        if (business.status === BusinessStatus.CANCELLED) {
          res.status(400).json({ code: 'INVALID_TRANSITION', message: 'Un negocio cancelado no puede cambiar de estado.' });
          return;
        }
        if (business.status === body.status) {
          res.status(400).json({ code: 'SAME_STATUS', message: `El negocio ya está en estado ${body.status}.` });
          return;
        }
        await platformRepository.updateBusinessStatus(business.id, body.status as BusinessStatus);
        if (body.reason) {
          console.info(`[platform] Negocio ${business.id} (${business.name}) → ${body.status}. Motivo: ${body.reason}`);
        }
        const updated = await platformRepository.findById(business.id);
        res.json({ message: `Estado actualizado a ${body.status}`, business: updated ? toBusinessDto(updated) : null });
      } catch (err) { next(err); }
    },
  );

  // POST /platform/businesses/:id/provision — le da al superadmin un botón
  // de "reintentar" para un negocio que quedó PENDING (registro público con
  // el auto-provisioning de business.routes.ts caído, o un negocio creado
  // acá mismo vía POST /businesses, que nunca auto-provisiona). Misma
  // secuencia que business.routes.ts: provisionTenantDatabase() →
  // applyTenantSchema() → encryptConnectionString() → activateBusiness().
  router.post(
    '/businesses/:id/provision',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const business = await platformRepository.findById(String(req.params['id']));
        if (!business) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Negocio no encontrado' });
          return;
        }
        if (business.dbUrlEncrypted) {
          res.status(400).json({ code: 'ALREADY_PROVISIONED', message: 'Este negocio ya tiene una base de datos asignada.' });
          return;
        }

        const { connectionString } = await provisionTenantDatabase(business.slug);
        const schemaVersion = await applyTenantSchema(connectionString);
        const encrypted     = await encryptConnectionString(connectionString);
        await platformRepository.activateBusiness(business.id, 'neon-branch', encrypted);
        await platformRepository.updateSchemaVersion(business.id, schemaVersion);

        const updated = await platformRepository.findById(business.id);
        res.json({ message: 'Base de datos aprovisionada y negocio activado.', business: updated ? toBusinessDto(updated) : null });
      } catch (err) { next(err); }
    },
  );

  return router;
}

function toBusinessDto(b: Business) {
  return {
    id: b.id, name: b.name, slug: b.slug, plan: b.plan, status: b.status,
    ownerEmail: b.ownerEmail, supabaseProjectId: b.supabaseProjectId,
    hasTenantDb: b.dbUrlEncrypted !== null,
    createdAt: b.createdAt, updatedAt: b.updatedAt,
  };
}
