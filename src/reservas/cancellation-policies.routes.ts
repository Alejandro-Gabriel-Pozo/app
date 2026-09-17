/**
 * @file cancellation-policies.routes.ts
 * @description Rutas REST para el catálogo de tramos de cancelación
 * (C2, docs/diseno-cancelacion-notas-credito-c2-2026-08-23.md).
 *
 * GET    /api/cancellation-policies        — MANAGEMENT
 * GET    /api/cancellation-policies/:id    — MANAGEMENT
 * POST   /api/cancellation-policies        — MANAGEMENT
 * PUT    /api/cancellation-policies/:id    — MANAGEMENT
 * DELETE /api/cancellation-policies/:id    — MANAGEMENT
 *
 * Config de catálogo del negocio, mismo criterio de roles que
 * waste-reasons.routes.ts — CRUD completo a diferencia de deposit_policies
 * (que hoy no tiene rutas), porque acá el negocio administra varios tramos,
 * no un único override.
 *
 * ## Aislamiento multi-tenant
 * buildService() instancia SqlCancellationPolicyRepository usando req.db
 * (SqlClient del tenant inyectado por tenantMiddleware). findAll()/create()
 * reciben req.businessId! explícito.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { authorize } from '../security/auth.middleware.js';
import { Roles } from '../security/roles.js';
import { CancellationPolicyService } from './cancellation-policy.service.js';
import { SqlCancellationPolicyRepository } from './sql.cancellation-policy.repository.js';
import { SqlAuditLogRepository } from '../repositories/audit-log.repository.js';
import { CreateCancellationPolicySchema, UpdateCancellationPolicySchema } from '../api/schemas/cancellation-policy.schemas.js';
import type { AppContainer } from '../container.js';
import { buildTenantTransactionManager } from '../db/tenant-context.js';

export function createCancellationPoliciesRouter(_container: AppContainer): Router {
  const router = Router();

  function buildService(req: Request): CancellationPolicyService {
    return new CancellationPolicyService(
      new SqlCancellationPolicyRepository(req.db!),
      new SqlAuditLogRepository(req.db!),
      buildTenantTransactionManager(req),
    );
  }

  router.get('/', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service  = buildService(req);
      const policies = await service.listPolicies(req.businessId!);
      res.json(policies);
    } catch (err) { next(err); }
  });

  router.get('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = buildService(req);
      const policy  = await service.getPolicyById(String(req.params['id']));
      res.json(policy);
    } catch (err) { next(err); }
  });

  router.post('/', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body    = CreateCancellationPolicySchema.parse(req.body);
      const service = buildService(req);
      const policy  = await service.createPolicy(req.businessId!, body.minDaysBeforeCheckin, body.refundPercentage, body.policyResolutionTiming);
      res.status(201).json(policy);
    } catch (err) {
      next(err);
    }
  });

  router.put('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body    = UpdateCancellationPolicySchema.parse(req.body);
      const service = buildService(req);
      const policy  = await service.updatePolicy(
        String(req.params['id']),
        {
          ...(body.minDaysBeforeCheckin !== undefined && { minDaysBeforeCheckin: body.minDaysBeforeCheckin }),
          ...(body.refundPercentage     !== undefined && { refundPercentage:     body.refundPercentage }),
          ...(body.active               !== undefined && { active:               body.active }),
          ...(body.policyResolutionTiming    !== undefined && { policyResolutionTiming:    body.policyResolutionTiming }),
        },
        req.user!.id,
      );
      res.json(policy);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = buildService(req);
      await service.deactivatePolicy(String(req.params['id']));
      res.status(204).send();
    } catch (err) { next(err); }
  });

  return router;
}
