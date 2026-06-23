import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { AppContainer } from '../../container.js';
import { Customer } from '../../domain/entities.js';
import { ReservationNotFoundError } from '../../domain/errors.js';
import { routeParam } from '../utils/params.js';
import { ResourceType } from '../../types/enums.js';
import { PreferenceDetailsByResource } from '../../types/preferences.types.js';
import { toReservationDto } from '../mappers/reservation.mapper.js';
import {
  CreateReservationSchema,
  validateDetailsForType,
} from '../schemas/request.schemas.js';

export function createReservationsRouter(container: AppContainer): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const reservations = await container.reservationRepository.getAll();
      res.json(reservations.map(toReservationDto));
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = routeParam(req.params.id);
      const reservation = await container.reservationService.getReservation(id);
      if (!reservation) {
        throw new ReservationNotFoundError(id);
      }
      res.json(toReservationDto(reservation));
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = CreateReservationSchema.parse(req.body);
      validateDetailsForType(body.resourceType, body.details);

      const reservation = await container.reservationService.createReservation({
        id: randomUUID(),
        resourceType: body.resourceType,
        resourceId: body.resourceId,
        customer: new Customer(
          body.customer.id,
          body.customer.fullName,
          body.customer.email,
        ),
        startTime: new Date(body.startTime),
        endTime: new Date(body.endTime),
        details: body.details as PreferenceDetailsByResource[ResourceType],
      });

      res.status(201).json(toReservationDto(reservation));
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/:id/confirm',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = routeParam(req.params.id);
        const reservation = await container.reservationService.confirmReservation(
          id,
        );
        res.json(toReservationDto(reservation));
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/:id/cancel',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = routeParam(req.params.id);
        const reservation = await container.reservationService.cancelReservation(
          id,
        );
        res.json(toReservationDto(reservation));
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/:id/complete',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = routeParam(req.params.id);
        const reservation = await container.reservationService.completeReservation(
          id,
        );
        res.json(toReservationDto(reservation));
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
