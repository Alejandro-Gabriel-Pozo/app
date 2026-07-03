/**
 * @file reports.routes.ts
 * @description Rutas de reportes de ocupación.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { AppContainer } from '../../container.js';
import { authorize } from '../../security/auth.middleware.js';
import { UserRole } from '../../types/enums.js';
import {
  DateRangeQuerySchema,
  SummaryQuerySchema,
  UnderutilizedQuerySchema,
} from '../schemas/request.schemas.js';

const REPORT_READERS = [UserRole.ADMIN, UserRole.RECEPTIONIST] as const;

export function createReportsRouter(container: AppContainer): Router {
  const router = Router();

  /**
   * @swagger
   * /api/reports/occupancy:
   *   get:
   *     summary: Reporte diario de ocupación
   *     tags: [Reports]
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - name: startDate
   *         in: query
   *         required: true
   *         schema: { type: string, format: date-time }
   *       - name: endDate
   *         in: query
   *         required: true
   *         schema: { type: string, format: date-time }
   *     responses:
   *       200: { description: Lista de filas de ocupación diaria }
   *       400: { description: Parámetros de fecha inválidos }
   *       401: { description: No autenticado }
   *       403: { description: Rol sin permiso (WAITER) }
   */
  router.get(
    '/occupancy',
    authorize(REPORT_READERS),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const query = DateRangeQuerySchema.parse(req.query);
        const report = await container.reportService.generateOccupancyReport(
          new Date(query.startDate),
          new Date(query.endDate),
        );
        res.json(report);
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * @swagger
   * /api/reports/summary:
   *   get:
   *     summary: Resumen ejecutivo de ocupación
   *     tags: [Reports]
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - name: startDate
   *         in: query
   *         required: true
   *         schema: { type: string, format: date-time }
   *       - name: endDate
   *         in: query
   *         required: true
   *         schema: { type: string, format: date-time }
   *       - name: limit
   *         in: query
   *         schema: { type: integer, minimum: 1, maximum: 100, default: 5 }
   *     responses:
   *       200: { description: Resumen de ocupación }
   *       400: { description: Parámetros inválidos }
   *       401: { description: No autenticado }
   *       403: { description: Rol sin permiso (WAITER) }
   */
  router.get(
    '/summary',
    authorize(REPORT_READERS),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const query = SummaryQuerySchema.parse(req.query);
        const summary = await container.reportService.generateOccupancySummary(
          new Date(query.startDate),
          new Date(query.endDate),
          query.limit,
        );
        res.json(summary);
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * @swagger
   * /api/reports/underutilized:
   *   get:
   *     summary: Recursos subutilizados
   *     tags: [Reports]
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - name: startDate
   *         in: query
   *         required: true
   *         schema: { type: string, format: date-time }
   *       - name: endDate
   *         in: query
   *         required: true
   *         schema: { type: string, format: date-time }
   *       - name: threshold
   *         in: query
   *         schema: { type: number, minimum: 0, maximum: 1, default: 0.3 }
   *     responses:
   *       200: { description: Lista de recursos subutilizados }
   *       400: { description: Parámetros inválidos }
   *       401: { description: No autenticado }
   *       403: { description: Rol sin permiso (WAITER) }
   */
  router.get(
    '/underutilized',
    authorize(REPORT_READERS),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const query = UnderutilizedQuerySchema.parse(req.query);
        // getUnderutilizedResources acepta (startDate, endDate, threshold) — 3 args
        const result = await container.reportService.getUnderutilizedResources(
          new Date(query.startDate),
          new Date(query.endDate),
          query.threshold,
        );
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
