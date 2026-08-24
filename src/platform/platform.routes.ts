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
import { authenticatePlatform, authorizePlatform } from './platform.auth.middleware.js';
import type { Business } from './platform.repository.js';
import { provisionTenantDatabase } from './neon-provisioning.js';
import { applyTenantSchema, encryptConnectionString } from './tenant-db.setup.js';
import { PlatformRole } from '../types/enums.js';

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

// L (23/08/2026) — a diferencia del status, cambiar de plan no tiene
// transiciones restringidas (cualquier plan a cualquier plan, en
// cualquier dirección).
const UpdateBusinessPlanSchema = z.object({
  plan: z.nativeEnum(BusinessPlan),
});

// L (23/08/2026) — editar plan_limits/plan_limit_allowed_roles/
// plan_limit_allowed_permission_groups desde el superadmin. `null` en los
// numéricos = sin límite (mismo criterio que la columna real);
// `allowedRoleNames`/`allowedPermissionGroups` vacíos = sin restricción
// ('ALL' en la forma resuelta que consume el resto del código).
const NullableNonNegativeInt = z.number().int().min(0).nullable();
const UpdatePlanLimitsSchema = z.object({
  maxCategories: NullableNonNegativeInt,
  maxResources: NullableNonNegativeInt,
  maxActiveMemberships: NullableNonNegativeInt,
  maxCustomRoles: NullableNonNegativeInt,
  allowedRoleNames: z.array(z.string()),
  allowedPermissionGroups: z.array(z.string()),
});

// L (23/08/2026) — editar los grupos de permiso de un preset de rol de
// fábrica. Solo permission_groups: el `name` es fijo (los 5 presets no se
// crean/borran desde acá, ver docblock de la ruta).
const UpdateRolePresetSchema = z.object({
  permissionGroups: z.array(z.string()),
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

  // L (23/08/2026, docs/rbac-matriz-endpoints.md) — hasta acá solo exigía
  // authenticatePlatform() sin restringir por PlatformRole. Sin efecto
  // práctico hoy (un solo PlatformRole posible, un solo actor de
  // plataforma hardcodeado) pero es exactamente el mismo agujero que
  // admin.routes.ts ya cerró el 19/08/2026 — cerrarlo acá también antes
  // de que un panel de superadmin real agregue una segunda cuenta/rol.
  router.use(authenticatePlatform(), authorizePlatform([PlatformRole.SUPERADMIN]));

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

  // PATCH /platform/businesses/:id/plan — L (23/08/2026). Antes el único
  // camino para cambiar el plan de un negocio ya creado era un UPDATE a
  // mano en la BD central (pendientes-2026-08-18.md). No reconcilia
  // memberships/roles que queden fuera de los límites del plan nuevo — ver
  // docblock de PlatformRepository.updateBusinessPlan().
  router.patch(
    '/businesses/:id/plan',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body     = UpdateBusinessPlanSchema.parse(req.body);
        const business = await platformRepository.findById(String(req.params['id']));
        if (!business) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Negocio no encontrado' });
          return;
        }
        if (business.plan === body.plan) {
          res.status(400).json({ code: 'SAME_PLAN', message: `El negocio ya está en el plan ${body.plan}.` });
          return;
        }
        await platformRepository.updateBusinessPlan(business.id, body.plan);
        const updated = await platformRepository.findById(business.id);
        res.json({ message: `Plan actualizado a ${body.plan}`, business: updated ? toBusinessDto(updated) : null });
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

  // GET/PUT /platform/plan-limits — L (23/08/2026). Antes solo editable
  // por script/migración versionada (pendientes-2026-08-18.md, decisión
  // "no por ahora" del 19/08, reabierta esta sesión). `:plan` tiene que
  // ser uno de los 4 valores de BusinessPlan que ya tienen fila en
  // plan_limits -- no se crean/borran planes desde acá (ver docblock de
  // PlatformRepository.listRolePresets() para el mismo criterio aplicado
  // a presets).
  router.get(
    '/plan-limits',
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        res.json(await platformRepository.listPlanLimits());
      } catch (err) { next(err); }
    },
  );

  router.put(
    '/plan-limits/:plan',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const plan = String(req.params['plan']);
        if (!Object.values(BusinessPlan).includes(plan as BusinessPlan)) {
          res.status(400).json({ code: 'INVALID_PLAN', message: `'${plan}' no es un plan válido.` });
          return;
        }
        const body = UpdatePlanLimitsSchema.parse(req.body);
        const updated = await platformRepository.updatePlanLimits(plan as BusinessPlan, body);
        res.json(updated);
      } catch (err) { next(err); }
    },
  );

  // GET/PUT /platform/role-presets — L (23/08/2026). Catálogo global de
  // los 5 roles de fábrica (OWNER/ADMIN/RECEPTIONIST/HOUSEKEEPING/WAITER)
  // que se copian a `roles` al crear un negocio (provisionSystemRoles()).
  // Editar acá NO afecta negocios ya provisionados -- solo los que se
  // creen de ahí en adelante. No se pueden agregar/borrar presets (un rol
  // de fábrica nuevo requiere tocar código en varios lugares que asumen
  // estos 5 nombres, no es solo una fila de config).
  router.get(
    '/role-presets',
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        res.json(await platformRepository.listRolePresets());
      } catch (err) { next(err); }
    },
  );

  router.put(
    '/role-presets/:name',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = UpdateRolePresetSchema.parse(req.body);
        const updated = await platformRepository.updateRolePresetPermissionGroups(String(req.params['name']), body.permissionGroups);
        if (!updated) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Preset de rol no encontrado' });
          return;
        }
        res.json(updated);
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
