/**
 * @file companies.routes.ts
 * @description Empresas multipropiedad (17/08/2026, docs/diseno-empresas-
 * multipropiedad.md) — alta de una company y vínculo del negocio del
 * usuario autenticado a ella. Mismo criterio que admin.routes.ts: opera
 * SOLO sobre `req.user!.businessId!` (el negocio del propio caller), nunca
 * un businessId arbitrario del body — así ningún MANAGEMENT de un negocio
 * puede vincular/desvincular OTRO negocio sin que su propio staff lo pida
 * explícitamente (con el `companyId` compartido fuera de banda). No
 * depende de req.db — solo toca la BD central de plataforma, por eso se
 * monta junto a admin.routes.ts, antes de tenantMiddleware.
 *
 * GET  /api/companies/me      — MANAGEMENT — empresa a la que pertenece el negocio propio (o null)
 * POST /api/companies         — MANAGEMENT + plan ENTERPRISE — crea una company y vincula el negocio propio
 * POST /api/companies/link    — MANAGEMENT + plan ENTERPRISE — vincula el negocio propio a una company existente (SIN aprobación, sin cambios)
 *
 * GET /me existe porque, sin él, el frontend no tiene forma de saber si el
 * negocio ya pertenece a una empresa antes de ofrecer "crear"/"vincular" —
 * el riesgo real es que alguien cree una empresa nueva sin saber que ya
 * estaba vinculado a otra, desvinculándola sin darse cuenta (linkBusinessToCompany
 * simplemente sobreescribe company_id, no hay confirmación en el medio).
 * A propósito SIN requirePlan(): un negocio que dejó de ser ENTERPRISE
 * (downgrade) sigue pudiendo ver a qué empresa pertenece.
 *
 * ## Gate de plan ENTERPRISE (18/08/2026, pendientes-2026-08-18.md, deuda
 * estructural — aclarado por el dueño: empresas multipropiedad es la
 * feature que define el plan ENTERPRISE). `requirePlan()`
 * (security/plan.middleware.ts) en los POST que ESTABLECEN un vínculo
 * nuevo — crear/vincular directo/pedir vínculo es lo que se gatea, no
 * seguir usando una company ya vinculada ni aprobar/rechazar un pedido
 * ajeno (mismo criterio "no gatear cada operación downstream" que ya regía
 * el catálogo compartido en sí, ver diseno-empresas-multipropiedad.md).
 *
 * ## D-05/P-03 — solicitud + aprobación en dos pasos (24/09/2026, Wave 15,
 * docs/diseno-wave15-sesion-saga-aprovisionamiento-2026-09-24.md §3, gate
 * `architecture-governor` APROBADO CON CONDICIONES)
 *
 * POST /api/companies/link-requests             — MANAGEMENT + plan ENTERPRISE — pide vincular el negocio propio a una company existente. Crea `company_link_requests` en PENDING, NO vincula nada todavía.
 * POST /api/companies/link-requests/:id/approve — MANAGEMENT + guard de pertenencia — aprueba: corre `linkBusinessToCompany()` en la MISMA transacción que resuelve la solicitud.
 * POST /api/companies/link-requests/:id/reject  — MANAGEMENT + guard de pertenencia — rechaza: solo resuelve la solicitud, no vincula nada.
 *
 * **Path corregido respecto del boceto original del diseño** (que ponía
 * approve/reject bajo `/platform/companies/:companyId/...`): `/platform/*`
 * (app.ts, `authenticatePlatform()`) es el universo de superadmin, clave
 * separada (`PLATFORM_JWT_SECRET`), `req.platformUser`, sin relación con
 * `Roles.MANAGEMENT` ni con membership de negocio — estructuralmente
 * incompatible con "cualquier MANAGEMENT de la company destino aprueba".
 * Por eso viven acá, mismo router y mismo prefijo `/api/companies` que
 * `POST /link`.
 *
 * **Guard de pertenencia (`assertEligibleApprover()`, condición 1 del
 * gate)** — que el actor tenga `Roles.MANAGEMENT` no alcanza: tiene que
 * tener MANAGEMENT de un negocio YA vinculado a `target_company_id` de la
 * solicitud, no de cualquier negocio del sistema. Mismo patrón que
 * `requireOwnReservation()` (`api/routes/customer.routes.ts`, RBAC-OWN-001):
 * resuelve el dueño real desde la BD (`findBusinessesByCompanyId()`,
 * platform.repository.ts, ya existía) y lo compara contra
 * `req.user!.businessId!` del actor autenticado — nunca un `businessId` de
 * la URL o el body.
 *
 * **Caso borde bootstrap (condición 2 del gate)** — si `target_company_id`
 * no tiene NINGÚN negocio vinculado todavía, no existe ningún MANAGEMENT
 * elegible por definición. `assertEligibleApprover()` chequea
 * `linkedBusinesses.length === 0` ANTES del `.some()` de membership y
 * lanza `CompanyHasNoEligibleApproverError` (409) explícito — nunca deja
 * que el `.some()` sobre un array vacío devuelva `false` en silencio
 * (indistinguible de "hay aprobadores, este no es uno"). El primer vínculo
 * de una company nueva (alta manual, vía superadmin) queda fuera de
 * alcance de este bloque — ver §3.2 del diseño.
 *
 * **`POST /link` (vínculo directo) NO se toca.** El diseño original
 * hablaba de "reemplazar su efecto inmediato" — decisión de producto
 * (¿deprecar/retirar ese endpoint?) que este bloque deja explícitamente
 * SIN resolver, no asumida acá: sigue existiendo tal cual, sin cambios de
 * comportamiento. Ver el reporte de esta implementación para el detalle.
 *
 * **Por qué NO usa `domain/audit.ts::recordFieldChanges()`.** El diseño
 * original lo sugería como "el patrón obligatorio del repo", pero ese
 * patrón graba contra `audit_log` (BD de TENANT, vía `AuditLogRepository`)
 * — `company_link_requests` vive en la BD de PLATAFORMA, y el único
 * mecanismo de auditoría de plataforma real (`PlatformAuditLogRepository`
 * / `platform_audit_log`) documenta explícitamente que su `changed_by` es
 * un `platform_user` (superadmin), no un `identity` de negocio (ver su
 * propio docblock en platform.schema.sql) — no es el actor de este flujo.
 * Verificado por grep (24/09/2026): `recordFieldChanges`/`updateWithAudit`
 * no se usa en NINGÚN archivo de `src/platform/` hoy, salvo mencionado en
 * un docblock para el caso cross-DB de `RoleService`. El precedente real
 * de este repo para esta MISMA forma (fila-solicitud en la BD de
 * plataforma con status/resolved_by/resolved_at) es `user_invitations`
 * (BLOQUE INVITACIONES, platform.schema.sql) — tampoco usa una fila de
 * audit_log aparte; A6.5 ("toda transición deja rastro: quién, cuándo,
 * desde qué estado") lo satisfacen las columnas de la fila en sí. Este
 * bloque sigue ese precedente, no el `recordFieldChanges()` sugerido en el
 * boceto — desviación señalada explícitamente en el reporte de esta
 * implementación para que quede confirmada, no asumida en silencio.
 */

import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import { authorize } from '../api/middleware/auth.middleware.wrapper.js';
import { Roles } from '../security/roles.js';
import { requirePlan } from '../security/plan.middleware.js';
import { BusinessPlan } from '../types/enums.js';
import type { AppContainer } from '../container.js';
import type { PlatformRepository } from './platform.repository.js';
import type { CompanyRepository } from './company.repository.js';
import {
  CompanyLinkRequestNotFoundError,
  CompanyLinkRequestAlreadyPendingError,
  CompanyLinkRequestInvalidTransitionError,
  CompanyLinkRequestNotEligibleApproverError,
  CompanyHasNoEligibleApproverError,
} from '../domain/errors.js';
import { z } from 'zod';

const CreateCompanySchema = z.object({ name: z.string().min(1).max(255) });
const LinkCompanySchema   = z.object({ companyId: z.string().min(1) });
const CreateLinkRequestSchema = z.object({ companyId: z.string().min(1) });

/**
 * Guard de pertenencia (condición 1 del gate, ver docblock del archivo) +
 * caso borde bootstrap (condición 2). Exportada para poder testearla en
 * aislamiento además de vía la cadena completa de `POST .../approve|reject`.
 */
export async function assertEligibleApprover(
  platformRepo: PlatformRepository,
  targetCompanyId: string,
  approverBusinessId: string,
): Promise<void> {
  const linkedBusinesses = await platformRepo.findBusinessesByCompanyId(targetCompanyId);
  if (linkedBusinesses.length === 0) {
    throw new CompanyHasNoEligibleApproverError(targetCompanyId);
  }
  const isEligible = linkedBusinesses.some((b) => b.id === approverBusinessId);
  if (!isEligible) {
    throw new CompanyLinkRequestNotEligibleApproverError(approverBusinessId, targetCompanyId);
  }
}

export function createCompaniesRouter(
  platformRepo: PlatformRepository,
  companyRepo: CompanyRepository,
  container: AppContainer,
): Router {
  const router = Router();

  router.get('/me', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const business = await platformRepo.findById(req.user!.businessId!);
      if (!business?.companyId) {
        res.json({ companyId: null, companyName: null });
        return;
      }
      const company = await companyRepo.findCompanyById(business.companyId);
      res.json({ companyId: business.companyId, companyName: company?.name ?? null });
    } catch (err) { next(err); }
  });

  router.post('/', authorize(Roles.MANAGEMENT), requirePlan(container, BusinessPlan.ENTERPRISE), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = CreateCompanySchema.parse(req.body);
      const businessId = req.user!.businessId!;

      const company = await companyRepo.createCompany(body.name);
      await platformRepo.linkBusinessToCompany(businessId, company.id);

      res.status(201).json(company);
    } catch (err) {
      next(err);
    }
  });

  router.post('/link', authorize(Roles.MANAGEMENT), requirePlan(container, BusinessPlan.ENTERPRISE), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = LinkCompanySchema.parse(req.body);
      const businessId = req.user!.businessId!;

      const company = await companyRepo.findCompanyById(body.companyId);
      if (!company) {
        res.status(404).json({ code: 'COMPANY_NOT_FOUND', message: `Empresa ${body.companyId} no encontrada.` });
        return;
      }

      await platformRepo.linkBusinessToCompany(businessId, company.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // ---------------------------------------------------------------------
  // D-05/P-03 — solicitud + aprobación en dos pasos (24/09/2026, Wave 15)
  // ---------------------------------------------------------------------

  router.post('/link-requests', authorize(Roles.MANAGEMENT), requirePlan(container, BusinessPlan.ENTERPRISE), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = CreateLinkRequestSchema.parse(req.body);
      const businessId = req.user!.businessId!;
      const identityId = req.user!.id;

      const company = await companyRepo.findCompanyById(body.companyId);
      if (!company) {
        res.status(404).json({ code: 'COMPANY_NOT_FOUND', message: `Empresa ${body.companyId} no encontrada.` });
        return;
      }

      try {
        const request = await companyRepo.createLinkRequest({
          requestingBusinessId: businessId,
          targetCompanyId: company.id,
          requestedByIdentityId: identityId,
        });
        res.status(201).json(request);
      } catch (dbErr) {
        // uq_company_link_requests_pending (platform.schema.sql) -- mismo
        // criterio que ResourceNameConflictError en resources.routes.ts.
        if ((dbErr as { code?: string }).code === '23505') {
          throw new CompanyLinkRequestAlreadyPendingError(businessId, company.id);
        }
        throw dbErr;
      }
    } catch (err) {
      next(err);
    }
  });

  router.post('/link-requests/:id/approve', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = String(req.params['id']);
      const approverBusinessId = req.user!.businessId!;
      const approverIdentityId = req.user!.id;

      const request = await companyRepo.findLinkRequestById(id);
      if (!request) throw new CompanyLinkRequestNotFoundError(id);
      if (request.status !== 'PENDING') {
        throw new CompanyLinkRequestInvalidTransitionError(id, request.status);
      }

      // Condición 1 + condición 2 del gate -- ver docblock del archivo.
      await assertEligibleApprover(platformRepo, request.targetCompanyId, approverBusinessId);

      // Aprobar = resolver la solicitud (guardado por WHERE status='PENDING',
      // cierra la carrera de doble-aprobación) + vincular el negocio, mismo
      // commit (atomic-state-mutation) -- si el segundo paso fallara, la
      // solicitud NO puede quedar APPROVED con el negocio sin vincular.
      const resolved = await platformRepo.runInTransaction(async (client) => {
        const updated = await companyRepo.resolveLinkRequestWithClient(id, 'APPROVED', approverIdentityId, client);
        if (!updated) {
          // Otra transacción concurrente ganó la carrera entre el check de
          // arriba y este UPDATE (doble click / doble approve). No hay
          // "estado a medias" -- este UPDATE no tocó ninguna fila, así que
          // tampoco corre linkBusinessToCompany().
          throw new CompanyLinkRequestInvalidTransitionError(id, 'no-pending');
        }
        await platformRepo.linkBusinessToCompany(updated.requestingBusinessId, updated.targetCompanyId, client);
        return updated;
      });

      res.json(resolved);
    } catch (err) {
      next(err);
    }
  });

  router.post('/link-requests/:id/reject', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = String(req.params['id']);
      const approverBusinessId = req.user!.businessId!;
      const approverIdentityId = req.user!.id;

      const request = await companyRepo.findLinkRequestById(id);
      if (!request) throw new CompanyLinkRequestNotFoundError(id);
      if (request.status !== 'PENDING') {
        throw new CompanyLinkRequestInvalidTransitionError(id, request.status);
      }

      await assertEligibleApprover(platformRepo, request.targetCompanyId, approverBusinessId);

      // Rechazar es una sola escritura (no toca `businesses`) -- no
      // necesita la transacción explícita del approve.
      const resolved = await companyRepo.resolveLinkRequestWithClient(id, 'REJECTED', approverIdentityId);
      if (!resolved) {
        throw new CompanyLinkRequestInvalidTransitionError(id, 'no-pending');
      }

      res.json(resolved);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
