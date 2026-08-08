/**
 * @file reports.routes.ts
 *
 * Permisos:
 * - Reportes operativos (ocupación, ingresos) — MANAGEMENT (OWNER, ADMIN)
 * - HOUSEKEEPING y RECEPTIONIST no tienen acceso a reportes financieros
 */

import { Router } from 'express';
import { authenticate, authorize } from '../../security/auth.middleware.js';
import { Roles } from '../../security/roles.js';
import type { ReportService } from '../../services/report.service.js';

export function createReportsRouter(service: ReportService): Router {
  const router = Router();

  // ── GET /reports/occupancy ─────────────────────────────────────────────────
  router.get(
    '/occupancy',
    authenticate(),
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId!;
        const { from, to } = req.query as { from: string; to: string };
        const report = await service.getOccupancyReport(businessId, from, to);
        res.json(report);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /reports/revenue ───────────────────────────────────────────────────
  router.get(
    '/revenue',
    authenticate(),
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId!;
        const { from, to } = req.query as { from: string; to: string };
        const report = await service.getRevenueReport(businessId, from, to);
        res.json(report);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
