import { Router, Request, Response, NextFunction } from 'express';
import { AppContainer } from '../../container.js';
import { DateRangeQuerySchema } from '../schemas/request.schemas.js';

export function createReportsRouter(container: AppContainer): Router {
  const router = Router();

  router.get(
    '/occupancy',
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

  router.get(
    '/summary',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const query = DateRangeQuerySchema.parse(req.query);
        const limit = req.query.limit
          ? parseInt(String(req.query.limit), 10)
          : 5;
        const summary = await container.reportService.generateOccupancySummary(
          new Date(query.startDate),
          new Date(query.endDate),
          limit,
        );
        res.json(summary);
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/underutilized',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const query = DateRangeQuerySchema.parse(req.query);
        const threshold = req.query.threshold
          ? parseFloat(String(req.query.threshold))
          : 30;
        const resources =
          await container.reportService.getUnderutilizedResources(
            new Date(query.startDate),
            new Date(query.endDate),
            threshold,
          );
        res.json(resources);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
