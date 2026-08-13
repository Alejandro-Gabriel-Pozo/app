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

  // ── GET /reports/occupancy/by-category ───────────────────────────────────
  // Ocupación agrupada por categoría de recurso.
  // Query params: from=YYYY-MM-DD, to=YYYY-MM-DD
  router.get(
    '/occupancy/by-category',
    authenticate(),
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const { from, to } = req.query as { from: string; to: string };
        const report = await service.generateOccupancyByResourceType(
          new Date(from),
          new Date(to),
        );
        res.json(report);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /reports/occupancy/underutilized ──────────────────────────────────
  // Recursos con ocupación por debajo de un umbral.
  // Query params: from=YYYY-MM-DD, to=YYYY-MM-DD, threshold=30 (opcional, %)
  router.get(
    '/occupancy/underutilized',
    authenticate(),
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const { from, to, threshold } = req.query as {
          from: string;
          to: string;
          threshold?: string;
        };
        const thresholdValue = threshold ? parseFloat(threshold) : 30;
        const resources = await service.getUnderutilizedResources(
          new Date(from),
          new Date(to),
          thresholdValue,
        );
        res.json(resources);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /reports/accounts-receivable ──────────────────────────────────────
  // Cuentas por cobrar agrupadas por empresa, para el cierre de mes (A1, paso 5).
  // Query params: from=YYYY-MM-DD, to=YYYY-MM-DD
  router.get(
    '/accounts-receivable',
    authenticate(),
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const { from, to } = req.query as { from: string; to: string };
        const report = await service.generateAccountsReceivableReport(
          new Date(from),
          new Date(to),
        );
        res.json(report);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── DELETE /reports/occupancy/purge ───────────────────────────────────────
  // Elimina registros de ocupación anteriores a una fecha.
  // Query params: before=YYYY-MM-DD
  router.delete(
    '/occupancy/purge',
    authenticate(),
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const { before } = req.query as { before: string };
        const deleted = await service.purgeOldRecords(new Date(before));
        res.json({ deleted });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
