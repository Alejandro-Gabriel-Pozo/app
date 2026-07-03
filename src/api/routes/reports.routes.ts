/**
 * @file reports.routes.ts
 * @description Rutas de reportes de ocupación.
 *
 * Todos los endpoints requieren autenticación (el middleware `authenticate()` se
 * aplica globalmente en `app.ts` para todo `/api/*`).
 *
 * ## Cambios respecto a la versión anterior
 * - `limit` y `threshold` ahora se validan con Zod (`SummaryQuerySchema` y
 *   `UnderutilizedQuerySchema`) en lugar de `parseInt`/`parseFloat` sin validación.
 *   Un valor inválido (ej. `limit=-1`, `threshold=abc`) retorna HTTP 400 con
 *   detalle del error en lugar de producir `NaN` silencioso.
 *
 * ## Roles por endpoint
 * Los reportes contienen información sensible de negocio — restringidos a
 * `ADMIN` y `RECEPTIONIST`. `WAITER` recibe 403.
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

/** Roles que pueden acceder a reportes de negocio */
const REPORT_READERS = [UserRole.ADMIN, UserRole.RECEPTIONIST] as const;

export function createReportsRouter(container: AppContainer): Router {
  const router = Router();

  /**
   * @swagger
   * /api/reports/occupancy:
   *   get:
   *     summary: Reporte diario de ocupación
   *     description: >
   *       Devuelve una fila por recurso por día con los minutos ocupados
   *       y la tasa de ocupación calculada.
   *     tags: [Reports]
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - name: startDate
   *         in: query
   *         required: true
   *         schema: { type: string, format: date-time }
   *         example: "2026-07-01T00:00:00.000Z"
   *       - name: endDate
   *         in: query
   *         required: true
   *         schema: { type: string, format: date-time }
   *         example: "2026-07-31T23:59:59.000Z"
   *     responses:
   *       200:
   *         description: Lista de filas de ocupación diaria
   *       400:
   *         description: Parámetros de fecha inválidos
   *       401:
   *         description: No autenticado
   *       403:
   *         description: Rol sin permiso (WAITER)
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
   *     description: >
   *       Devuelve métricas agregadas del período: ocupación promedio,
   *       top recursos más y menos utilizados.
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
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 100
   *           default: 5
   *         description: Cantidad de recursos en cada ranking (top/bottom)
   *     responses:
   *       200:
   *         description: Resumen de ocupación
   *       400:
   *         description: Parámetros inválidos (ej. limit < 1 o no numérico)
   *       401:
   *         description: No autenticado
   *       403:
   *         description: Rol sin permiso (WAITER)
   */
  router.get(
    '/summary',
    authorize(REPORT_READERS),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // SummaryQuerySchema valida y coerciona `limit` desde string a int.
        // Un valor inválido (negativo, decimal, texto) lanza ZodError → HTTP 400.
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
   *     description: >
   *       Devuelve los recursos cuya tasa de ocupación promedio en el período
   *       está por debajo del umbral indicado.
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
   *         required: false
   *         schema:
   *           type: number
   *           minimum: 0
   *           maximum: 1
   *           default: 0.3
   *         description: Umbral de ocupación (0.0–1.0). Recursos por debajo de este valor se incluyen.
   *       - name: limit
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 100
   *           default: 10
   *     responses:
   *       200:
   *         description: Lista de recursos subutilizados
   *       400:
   *         description: Parámetros inválidos
   *       401:
   *         description: No autenticado
   *       403:
   *         description: Rol sin permiso (WAITER)
   */
  router.get(
    '/underutilized',
    authorize(REPORT_READERS),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const query = UnderutilizedQuerySchema.parse(req.query);

        const result = await container.reportService.getUnderutilizedResources(
          new Date(query.startDate),
          new Date(query.endDate),
          query.threshold,
          query.limit,
        );
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
