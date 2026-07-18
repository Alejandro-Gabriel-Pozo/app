/**
 * @file reports.routes.ts
 * @description Rutas de reportes de ocupación.
 *
 * ## Aislamiento multi-tenant
 * Cada handler instancia SqlOccupancyRepository(req.db!) y ReportService
 * con el SqlClient inyectado por tenantMiddleware.
 * El ! es seguro: tenantMiddleware siempre asigna req.db antes de estos handlers.
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
import { SqlOccupancyRepository } from '../../repositories/sql.occupancy.repository.js';
import { ReportService }          from '../../services/report.service.js';

const REPORT_READERS = [UserRole.ADMIN, UserRole.RECEPTIONIST] as const;

export function createReportsRouter(_container: AppContainer): Router {
  const router = Router();

  router.get('/occupancy', authorize(REPORT_READERS), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = DateRangeQuerySchema.parse(req.query);
      const reportService = new ReportService(new SqlOccupancyRepository(req.db!));
      const report = await reportService.generateOccupancyReport(new Date(query.startDate), new Date(query.endDate));
      res.json(report);
    } catch (err) { next(err); }
  });

  router.get('/summary', authorize(REPORT_READERS), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = SummaryQuerySchema.parse(req.query);
      const reportService = new ReportService(new SqlOccupancyRepository(req.db!));
      const summary = await reportService.generateOccupancySummary(new Date(query.startDate), new Date(query.endDate), query.limit);
      res.json(summary);
    } catch (err) { next(err); }
  });

  router.get('/underutilized', authorize(REPORT_READERS), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = UnderutilizedQuerySchema.parse(req.query);
      const reportService = new ReportService(new SqlOccupancyRepository(req.db!));
      const result = await reportService.getUnderutilizedResources(new Date(query.startDate), new Date(query.endDate), query.threshold);
      res.json(result);
    } catch (err) { next(err); }
  });

  return router;
}
