/**
 * @file customer.routes.ts
 * @description Portal público para clientes — registro, login y gestión de sus reservas.
 *
 * ## Rutas
 *
 * ### Públicas (sin autenticación)
 * POST   /api/customer/register    — crear cuenta
 * POST   /api/customer/login       — obtener JWT de cliente
 * GET    /api/customer/availability — ver disponibilidad por categoría
 *
 * ### Protegidas (requieren JWT con role=CUSTOMER)
 * GET    /api/customer/me                        — ver perfil propio
 * DELETE /api/customer/me                        — eliminar cuenta (anonimización GDPR)
 * GET    /api/customer/me/reservations           — ver mis reservas
 * POST   /api/customer/me/reservations           — crear reserva propia
 * PATCH  /api/customer/me/reservations/:id       — modificar reserva propia (solo PENDING)
 * POST   /api/customer/me/reservations/:id/cancel — cancelar reserva propia
 */

import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { AppContainer } from '../../container.js';
import { Customer } from '../../domain/entities.js';
import { CustomerAuthService } from '../../security/customer.auth.service.js';
import { authenticate, authorize } from '../../security/auth.middleware.js';
import { toReservationDto } from '../mappers/reservation.mapper.js';
import { UserRole, ReservationStatus } from '../../types/enums.js';

// ---------------------------------------------------------------------------
// Política de cancelación
// ---------------------------------------------------------------------------

const CANCEL_ADVANCE_MS = 24 * 60 * 60 * 1_000;

const CANCELLABLE_STATUSES: ReservationStatus[] = [
  ReservationStatus.PENDING,
  ReservationStatus.CONFIRMED,
];

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Demasiados intentos de registro. Intentá de nuevo en 15 minutos.',
      retryAfter: 15,
    });
  },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Demasiados intentos de inicio de sesión. Intentá de nuevo en 15 minutos.',
      retryAfter: 15,
    });
  },
});

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const RegisterCustomerSchema = z.object({
  fullName: z.string().min(2).max(100),
  email:    z.string().email(),
  password: z.string().min(8, { message: 'La contraseña debe tener al menos 8 caracteres' }),
});

const LoginCustomerSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

const CreateCustomerReservationSchema = z.object({
  categoryId: z.string().min(1),
  resourceId: z.string().min(1),
  startTime:  z.string().datetime(),
  endTime:    z.string().datetime(),
  details:    z.record(z.unknown()).default({}),
});

const UpdateCustomerReservationSchema = z.object({
  startTime: z.string().datetime().optional(),
  endTime:   z.string().datetime().optional(),
  details:   z.record(z.unknown()).optional(),
});

const AvailabilityQuerySchema = z.object({
  startTime:  z.string().datetime(),
  endTime:    z.string().datetime(),
  categoryId: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function requireCustomerId(req: Request, res: Response): string | null {
  const customerId = req.user?.customerId;
  if (!customerId) {
    res.status(403).json({
      code: 'FORBIDDEN',
      message: 'Ruta exclusiva para clientes autenticados',
    });
    return null;
  }
  return customerId;
}

// ---------------------------------------------------------------------------
// Factory del router
// ---------------------------------------------------------------------------

export function createCustomerRouter(container: AppContainer): Router {
  const router = Router();
  const customerAuthService = new CustomerAuthService(container.customerRepository);

  // -------------------------------------------------------------------------
  // POST /api/customer/register
  // -------------------------------------------------------------------------
  router.post(
    '/register',
    registerLimiter,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = RegisterCustomerSchema.parse(req.body);
        const result = await customerAuthService.register(body);
        res.status(201).json({
          message: 'Cuenta creada exitosamente',
          token: result.token,
          tokenType: 'Bearer',
          customer: result.customer,
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EMAIL_TAKEN') {
          res.status(400).json({ code: 'EMAIL_TAKEN', message: (err as Error).message });
          return;
        }
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/customer/login
  // -------------------------------------------------------------------------
  router.post(
    '/login',
    loginLimiter,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = LoginCustomerSchema.parse(req.body);
        const result = await customerAuthService.login(body);
        res.json({
          token: result.token,
          tokenType: 'Bearer',
          customer: result.customer,
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'INVALID_CREDENTIALS') {
          res.status(401).json({ code: 'INVALID_CREDENTIALS', message: 'Email o contraseña incorrectos' });
          return;
        }
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/customer/availability — público
  // Filtra recursos disponibles por rango de tiempo.
  // Opcionalmente filtra por categoryId.
  // -------------------------------------------------------------------------
  router.get(
    '/availability',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const query = AvailabilityQuerySchema.parse(req.query);
        const startTime = new Date(query.startTime);
        const endTime   = new Date(query.endTime);

        if (endTime <= startTime) {
          res.status(400).json({ code: 'INVALID_DATE_RANGE', message: 'endTime debe ser posterior a startTime' });
          return;
        }

        let allResources = await container.resourceRepository.getAll();

        if (query.categoryId) {
          allResources = allResources.filter((r) => r.categoryId === query.categoryId);
        }

        const busyResourceIds = new Set<string>();
        await Promise.all(
          allResources.map(async (resource) => {
            const active = await container.reservationRepository.getActiveForResourceInRange(
              resource.id,
              startTime,
              endTime,
            );
            if (active.length > 0) busyResourceIds.add(resource.id);
          }),
        );

        const available = allResources.filter((r) => !busyResourceIds.has(r.id));

        res.json({
          categoryId: query.categoryId ?? null,
          startTime:  startTime.toISOString(),
          endTime:    endTime.toISOString(),
          available:  available.map((r) => ({
            id:         r.id,
            name:       r.name,
            categoryId: r.categoryId,
            basePrice:  r.basePrice,
          })),
          total: available.length,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // A partir de aquí: requieren JWT con role=CUSTOMER
  // -------------------------------------------------------------------------
  router.use(authenticate(), authorize([UserRole.CUSTOMER]));

  // -------------------------------------------------------------------------
  // GET /api/customer/me
  // -------------------------------------------------------------------------
  router.get(
    '/me',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const customerId = requireCustomerId(req, res);
        if (!customerId) return;

        const customer = await container.customerRepository.getById(customerId);
        if (!customer) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Cliente no encontrado' });
          return;
        }
        res.json({ id: customer.id, fullName: customer.fullName, email: customer.email ?? '' });
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /api/customer/me
  // -------------------------------------------------------------------------
  router.delete(
    '/me',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const customerId = requireCustomerId(req, res);
        if (!customerId) return;

        const anonymized = await container.customerRepository.anonymize(customerId);

        if (!anonymized) {
          const existing = await container.customerRepository.getById(customerId);
          if (!existing) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Cliente no encontrado' });
          } else {
            res.status(409).json({
              code: 'ALREADY_DELETED',
              message: 'La cuenta ya fue eliminada previamente.',
            });
          }
          return;
        }

        res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/customer/me/reservations
  // -------------------------------------------------------------------------
  router.get(
    '/me/reservations',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const customerId = requireCustomerId(req, res);
        if (!customerId) return;

        const reservations = await container.reservationRepository.getByCustomerId(customerId);
        res.json(reservations.map(toReservationDto));
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/customer/me/reservations
  // -------------------------------------------------------------------------
  router.post(
    '/me/reservations',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = CreateCustomerReservationSchema.parse(req.body);

        const customerId = requireCustomerId(req, res);
        if (!customerId) return;

        const customerEntity = await container.customerRepository.getById(customerId);
        if (!customerEntity) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Cliente no encontrado' });
          return;
        }

        const reservation = await container.reservationService.createReservation({
          id:         randomUUID(),
          resourceId: body.resourceId,
          customer:   new Customer(customerEntity.id, customerEntity.fullName, customerEntity.email ?? ''),
          startTime:  new Date(body.startTime),
          endTime:    new Date(body.endTime),
          details:    body.details,
        });

        res.status(201).json(toReservationDto(reservation));
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /api/customer/me/reservations/:id
  // -------------------------------------------------------------------------
  router.patch(
    '/me/reservations/:id',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const reservationId = String(req.params.id);

        const customerId = requireCustomerId(req, res);
        if (!customerId) return;

        const existing = await container.reservationRepository.getById(reservationId);
        if (!existing) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Reserva no encontrada' });
          return;
        }
        if (existing.customer.id !== customerId) {
          res.status(403).json({ code: 'FORBIDDEN', message: 'No tenés permiso para modificar esta reserva' });
          return;
        }

        if (existing.status !== ReservationStatus.PENDING) {
          res.status(409).json({
            code: 'INVALID_STATUS',
            message: `Solo se pueden modificar reservas en estado PENDING. Estado actual: ${existing.status}`,
          });
          return;
        }

        const body = UpdateCustomerReservationSchema.parse(req.body);

        if (!body.startTime && !body.endTime && !body.details) {
          res.status(400).json({
            code: 'NO_CHANGES',
            message: 'Debés enviar al menos un campo para modificar: startTime, endTime o details',
          });
          return;
        }

        const updated = await container.reservationService.updateReservation(
          reservationId,
          {
            startTime: body.startTime ? new Date(body.startTime) : undefined,
            endTime:   body.endTime   ? new Date(body.endTime)   : undefined,
            details:   body.details,
          },
        );

        res.json(toReservationDto(updated));
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/customer/me/reservations/:id/cancel
  // -------------------------------------------------------------------------
  router.post(
    '/me/reservations/:id/cancel',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const reservationId = String(req.params.id);

        const customerId = requireCustomerId(req, res);
        if (!customerId) return;

        const reservation = await container.reservationRepository.getById(reservationId);
        if (!reservation) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Reserva no encontrada' });
          return;
        }

        if (reservation.customer.id !== customerId) {
          res.status(403).json({ code: 'FORBIDDEN', message: 'No tenés permiso para cancelar esta reserva' });
          return;
        }

        if (!CANCELLABLE_STATUSES.includes(reservation.status)) {
          res.status(409).json({
            code: 'INVALID_STATUS',
            message: `No se puede cancelar una reserva en estado ${reservation.status}.`,
          });
          return;
        }

        if (reservation.status === ReservationStatus.CONFIRMED) {
          const msUntilStart = reservation.startTime.getTime() - Date.now();
          if (msUntilStart < CANCEL_ADVANCE_MS) {
            const hoursLeft = Math.max(0, Math.floor(msUntilStart / (1000 * 60 * 60)));
            res.status(422).json({
              code: 'CANCELLATION_TOO_LATE',
              message:
                `Las reservas confirmadas solo pueden cancelarse con al menos 24 horas de antelación. ` +
                `Tu reserva comienza en ${hoursLeft} hora(s). Contactá al establecimiento para asistencia.`,
            });
            return;
          }
        }

        const cancelled = await container.reservationService.cancelReservation(reservationId);
        res.json(toReservationDto(cancelled));
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
