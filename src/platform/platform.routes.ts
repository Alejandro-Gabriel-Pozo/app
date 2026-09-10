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
import { recordPlatformChanges } from './platform-audit-log.repository.js';
import { diffFields } from '../domain/audit.js';

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
//
// L (25/08/2026, pendientes-2026-08-25.md) — `membershipIdsToDeactivate`
// nuevo: "degradación asistida", Etapa 1 (decisión confirmada con el
// dueño, alcance acotado a asientos -- NO roles, eso queda para otra
// sesión). Si el negocio queda con más asientos activos de los que el
// plan nuevo permite, el handler rechaza con 409 y devuelve la lista de
// quién los ocupa -- el superadmin elige a quién desactivar y reintenta
// el mismo PATCH con esos ids acá. Sin esto: mismo comportamiento laxo de
// siempre (rechaza igual, sin aplicar nada).
const UpdateBusinessPlanSchema = z.object({
  plan: z.nativeEnum(BusinessPlan),
  membershipIdsToDeactivate: z.array(z.string()).optional(),
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
  const { platformRepository, platformAuthService, platformAuditLogRepository } = container;

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
        // El cambio de estado y su rastro van en la MISMA transacción
        // (28/08/2026, Fase 2): suspender un negocio le corta el acceso a
        // todo su personal, es de lo más disputable que hace el superadmin.
        // Antes no quedaba registro de quién ni cuándo en ningún lado.
        await platformRepository.runInTransaction(async (client) => {
          await platformRepository.updateBusinessStatus(business.id, body.status as BusinessStatus, client);
          await recordPlatformChanges(
            client,
            platformAuditLogRepository,
            { businessId: business.id, entity: 'businesses', entityId: business.id, changedBy: req.platformUser!.id },
            // `reason` viaja como campo propio, no concatenado al valor: es un
            // dato aparte y hasta hoy solo iba a console.info (se perdía con
            // el log). oldValue null — no había motivo previo que reemplazar.
            [
              { field: 'status', oldValue: business.status, newValue: body.status },
              ...(body.reason ? [{ field: 'status_reason', oldValue: null, newValue: body.reason }] : []),
            ],
          );
        });
        const updated = await platformRepository.findById(business.id);
        res.json({ message: `Estado actualizado a ${body.status}`, business: updated ? toBusinessDto(updated) : null });
      } catch (err) { next(err); }
    },
  );

  // PATCH /platform/businesses/:id/plan — L (23/08/2026). Antes el único
  // camino para cambiar el plan de un negocio ya creado era un UPDATE a
  // mano en la BD central (pendientes-2026-08-18.md).
  //
  // L (25/08/2026, pendientes-2026-08-25.md) — "degradación asistida",
  // Etapa 1 (decisión confirmada con el dueño; alcance acotado a
  // ASIENTOS, no roles -- eso queda sin resolver para otra sesión). Si el
  // negocio va a quedar con más membresías activas de las que el plan
  // nuevo permite, el cambio de plan NO se aplica todavía: responde 409
  // con la lista de quién ocupa cada asiento para que el superadmin elija
  // a quién desactivar, y reintente el mismo PATCH pasando
  // `membershipIdsToDeactivate`. Con la lista puesta, desactiva esas
  // membresías (mismo `deactivateMembership()` que DELETE /users/:id,
  // dejando el rastro A6.5 de quién lo hizo -- acá, el superadmin) y
  // recién ahí aplica el plan nuevo, todo antes de confirmar 200.
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

        const newLimits = await platformRepository.getPlanLimits(body.plan);
        if (!newLimits) {
          res.status(500).json({ code: 'PLAN_LIMITS_NOT_CONFIGURED', message: `El plan '${body.plan}' no tiene límites configurados en plan_limits.` });
          return;
        }

        if (Number.isFinite(newLimits.maxActiveMemberships)) {
          const currentActive = await platformRepository.findActiveStaffMembershipsByBusiness(business.id);
          if (currentActive.length > newLimits.maxActiveMemberships) {
            const excess = currentActive.length - newLimits.maxActiveMemberships;
            const requestedIds = new Set(body.membershipIdsToDeactivate ?? []);
            const validSelected = currentActive.filter((m) => requestedIds.has(m.id));

            // Todo o nada: si la selección no alcanza, no se desactiva a
            // NADIE todavía -- elegir "2 de 3" no debe dejar a esas 2 sin
            // acceso mientras el superadmin sigue decidiendo la tercera.
            if (validSelected.length < excess) {
              res.status(409).json({
                code: 'SEAT_LIMIT_EXCEEDS_NEW_PLAN',
                message: `El plan '${body.plan}' permite ${newLimits.maxActiveMemberships} asiento(s) — este negocio tiene ${currentActive.length} activo(s). ` +
                  'Elegí a quién desactivar y reintentá con membershipIdsToDeactivate.',
                newLimit: newLimits.maxActiveMemberships,
                currentActive: currentActive.length,
                excess,
                activeMemberships: currentActive.map((m) => ({
                  id: m.id, fullName: m.fullName, email: m.email, roleName: m.roleName, createdAt: m.createdAt,
                })),
              });
              return;
            }

            for (const m of validSelected) {
              await platformRepository.deactivateMembership(m.id, business.id, req.platformUser!.id);
            }
          }
        }

        // Las desactivaciones de membresías de arriba ya dejaron su propio
        // rastro A6.5 en `memberships` (deactivated_by/deactivated_at) — acá
        // se audita el cambio de plan en sí, que es lo que no quedaba en
        // ningún lado.
        await platformRepository.runInTransaction(async (client) => {
          await platformRepository.updateBusinessPlan(business.id, body.plan, client);
          await recordPlatformChanges(
            client,
            platformAuditLogRepository,
            { businessId: business.id, entity: 'businesses', entityId: business.id, changedBy: req.platformUser!.id },
            [{ field: 'plan', oldValue: business.plan, newValue: body.plan }],
          );
        });

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

        // business_id NULL: editar un plan afecta a TODOS los negocios de ese
        // plan, presentes y futuros. Es el cambio de mayor alcance de todo el
        // panel y era el que menos rastro dejaba.
        const before = (await platformRepository.listPlanLimits()).find((p) => p.plan === plan);

        const updated = await platformRepository.runInTransaction(async (client) => {
          const result = await platformRepository.updatePlanLimits(plan as BusinessPlan, body, client);
          await recordPlatformChanges(
            client,
            platformAuditLogRepository,
            { businessId: null, entity: 'plan_limits', entityId: plan, changedBy: req.platformUser!.id },
            // `before` puede no existir si el plan no tenía fila (no debería:
            // se seedean los 4 juntos). Con undefined, diffFields reporta
            // todos los campos como cambio — es lo correcto, no hay estado
            // anterior conocido que declarar igual.
            diffFields(before ?? {}, body),
          );
          return result;
        });

        res.json(updated);
      } catch (err) { next(err); }
    },
  );

  // GET/PUT /platform/role-presets — L (23/08/2026). Catálogo global de
  // los 5 roles de fábrica (OWNER/ADMIN/RECEPTIONIST/HOUSEKEEPING/WAITER).
  // Corrección (09/09/2026, gate `architecture-governor`): "editar acá NO
  // afecta negocios ya provisionados" era FALSO para agregar un grupo --
  // solo era cierto para el camino TS de `provisionSystemRoles()` (que
  // efectivamente solo lee esto al CREAR un negocio). El backfill SQL de
  // `platform.schema.sql:341-346` corre en CADA ARRANQUE del proceso
  // (`server.ts:33-53`, no solo en deploy), hace CROSS JOIN de todos los
  // negocios contra los presets, y copia cada permission_group agregado a
  // TODOS los negocios existentes -- `ON CONFLICT DO NOTHING`, así que
  // agrega pero nunca borra. Sacar un par SEEDEADO (los 23 de
  // `platform.schema.sql:311-322`) tampoco persiste: el seed lo
  // re-inserta en el próximo arranque. No hay vía de revocación en ningún
  // panel (`role.service.ts:182` bloquea editar roles `isSystem`) --
  // sacarle un grupo a un negocio existente exige SQL a mano contra la BD
  // de plataforma. No se pueden agregar/borrar presets (un rol de fábrica
  // nuevo requiere tocar código en varios lugares que asumen estos 5
  // nombres, no es solo una fila de config).
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
        const name = String(req.params['name']);

        const before = (await platformRepository.listRolePresets()).find((p) => p.name === name);
        if (!before) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Preset de rol no encontrado' });
          return;
        }

        // business_id NULL, igual que plan_limits: editar un preset cambia
        // con qué permisos nace todo negocio creado de acá en adelante.
        const updated = await platformRepository.runInTransaction(async (client) => {
          const result = await platformRepository.updateRolePresetPermissionGroups(name, body.permissionGroups, client);
          await recordPlatformChanges(
            client,
            platformAuditLogRepository,
            { businessId: null, entity: 'role_presets', entityId: name, changedBy: req.platformUser!.id },
            diffFields(before, { permissionGroups: body.permissionGroups }),
          );
          return result;
        });

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
