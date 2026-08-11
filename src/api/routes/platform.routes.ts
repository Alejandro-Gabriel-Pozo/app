/**
 * @file platform.routes.ts
 * @description Rutas de gestión de plataforma — exclusivas para SUPERADMIN.
 */

import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PlatformContainer } from '../../../src/platform/platform.container.js';
import { BusinessPlan, BusinessStatus } from '../../types/enums.js';
import { authenticatePlatform } from '../../security/platform.auth.middleware.js';
import {
  provisionBusinessDatabase,
  runSchemaOnNewDatabase,
  encryptConnectionString,
  loadTenantSchema,
} from '../../platform/supabase.provisioner.js';
import type { PlatformRepository, Business } from '../../platform/platform.repository.js';

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
        provisionInBackground(businessId, body.name, platformRepository).catch((err) => {
          console.error(`[platform] Error provisionando negocio ${businessId}:`, err);
        });
        res.status(202).json({
          message: 'Negocio registrado. Provisionando base de datos en segundo plano (hasta 5 min).',
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

  return router;
}

async function provisionInBackground(
  businessId: string,
  businessName: string,
  platformRepository: PlatformRepository,
): Promise<void> {
  console.log(`[platform] Iniciando provisioning para negocio ${businessId}...`);
  const provisioned = await provisionBusinessDatabase(businessId, businessName);
  const schemaSQL   = await loadTenantSchema();
  await runSchemaOnNewDatabase(provisioned.connectionString, schemaSQL);
  const encrypted = await encryptConnectionString(provisioned.connectionString);
  await platformRepository.activateBusiness(businessId, provisioned.projectId, encrypted);
  console.log(`[platform] ✅ Negocio ${businessId} provisionado y activo.`);
}

function toBusinessDto(b: Business) {
  return {
    id: b.id, name: b.name, slug: b.slug, plan: b.plan, status: b.status,
    ownerEmail: b.ownerEmail, supabaseProjectId: b.supabaseProjectId,
    createdAt: b.createdAt, updatedAt: b.updatedAt,
  };
}
