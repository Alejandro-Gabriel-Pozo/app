/**
 * @file reports.routes.ts
 *
 * Permisos:
 * - Reportes operativos (ocupación) — MANAGEMENT (OWNER, ADMIN)
 * - HOUSEKEEPING y RECEPTIONIST no tienen acceso a reportes
 */

import { Router } from 'express';
import { authenticate, authorize } from '../../security/auth.middleware.js';
import { Roles } from '../../security/roles.js';
import type { ReportService } from '../../services/report.service.js';

export function createReportsRouter(service: ReportService): Router {
  const router = Router();

  // ── GET /reports/occupancy ─────────────────────────────────────────────────
  // Reporte diario de ocupación por recurso en un período.
  // Query params: from=YYYY-MM-DD, to=YYYY-MM-DD
  router.get(
    '/occupancy',
    authenticate(),
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const { from, to } = req.query as { from: string; to: string };
        const report = await service.generateOccupancyReport(
          new Date(from),
          new Date(to),
        );
        res.json(report);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /reports/occupancy/summary ────────────────────────────────────────
  // Resumen ejecutivo: promedio, top/bottom recursos.
  // Query params: from=YYYY-MM-DD, to=YYYY-MM-DD, limit=5 (opcional)
  router.get(
    '/occupancy/summary',
    authenticate(),
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const { from, to, limit } = req.query as { from: string; to: string; limit?: string };
        const topLimit = limit ? parseInt(limit, 10) : 5;
        const summary = await service.generateOccupancySummary(
          new Date(from),
          new Date(to),
          topLimit,
        );
        res.json(summary);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
