/**
 * @file customer.routes.ts
 * @description Portal público para clientes — registro, login y gestión de sus reservas.
 *
 * ## Rutas
 *
 * ### Públicas (sin autenticación)
 * POST   /api/customer/register    — crear cuenta
 * POST   /api/customer/login       — obtener JWT de cliente
 * GET    /api/customer/availability/:resourceType — ver disponibilidad
 *
 * ### Protegidas (requieren JWT con role=CUSTOMER)
 * GET    /api/customer/me                        — ver perfil propio
 * DELETE /api/customer/me                        — eliminar cuenta (anonimización GDPR)
 * GET    /api/customer/me/reservations           — ver mis reservas
 * POST   /api/customer/me/reservations           — crear reserva propia
 * PATCH  /api/customer/me/reservations/:id       — modificar reserva propia (solo PENDING)
 * POST   /api/customer/me/reservations/:id/cancel — cancelar reserva propia
 *
 * ## Restricciones de seguridad
 * - Un cliente SOLO puede ver, modificar y cancelar SUS propias reservas.
 * - Un cliente no puede ver datos de otros clientes.
 * - La modificación solo está permitida si la reserva está en PENDING.
 * - La cancelación está permitida en PENDING (sin restricción de tiempo)
 *   o en CONFIRMED con al menos CANCEL_ADVANCE_MS de antelación.
 * - DELETE /me anonimiza los datos personales y anula el password hash;
 *   el token JWT actual queda implícitamente invalidado (próximo login fallará).
 * - /register y /login están limitados por rate limiting (ver abajo).
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
import { UserRole, ResourceType, ReservationStatus } from '../../types/enums.js';
import { PreferenceDetailsByResource } from '../../types/preferences.types.js';
import { validateDetailsForType } from '../schemas/request.schemas.js';

// ---------------------------------------------------------------------------
// Política de cancelación
// ---------------------------------------------------------------------------

/**
 * Antelación mínima para cancelar una reserva CONFIRMED.
 * 24 horas expresadas en milisegundos — cambiar aquí para ajustar la política.
 */
const CANCEL_ADVANCE_MS = 24 * 60 * 60 * 1_000;

/** Estados desde los que un cliente puede cancelar su reserva. */
const CANCELLABLE_STATUSES: ReservationStatus[] = [
  ReservationStatus.PENDING,
  ReservationStatus.CONFIRMED,
];

// ---------------------------------------------------------------------------
// Rate limiters — evitan abuso en endpoints públicos costosos (PBKDF2)
// ---------------------------------------------------------------------------

/**
 * /register: máximo 5 intentos por IP cada 15 minutos.
 * Más restrictivo porque implica PBKDF2 + escritura en BD.
 */
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

/**
 * /login: máximo 10 intentos por IP cada 15 minutos.
 * Mitiga fuerza bruta sobre cuentas existentes.
 */
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
// Schemas de validación
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
  resourceType: z.nativeEnum(ResourceType),
  resourceId:   z.string().min(1),
  startTime:    z.string().datetime(),
  endTime:      z.string().datetime(),
  details:      z.record(z.unknown()).default({}),
});

/**
 * Schema para PATCH /api/customer/me/reservations/:id.
 *
 * Todos los campos son opcionales — se fusionan con los valores existentes
 * de la reserva en el servicio. Al menos uno debe estar presente (validado
 * en el servicio).
 */
const UpdateCustomerReservationSchema = z.object({
  startTime: z.string().datetime().optional(),
  endTime:   z.string().datetime().optional(),
  details:   z.record(z.unknown()).optional(),
});

const AvailabilityQuerySchema = z.object({
  startTime: z.string().datetime(),
  endTime:   z.string().datetime(),
});

// ---------------------------------------------------------------------------
// Helper: extrae customerId del token o responde 403
// ---------------------------------------------------------------------------

/**
 * Devuelve el customerId del JWT autenticado, o envía 403 y retorna null.
 * Usar en todos los handlers protegidos de este router para uniformidad.
 */
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
  // POST /api/customer/register — público (rate limited)
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
  // POST /api/customer/login — público (rate limited)
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
  // GET /api/customer/availability/:resourceType — público
  // -------------------------------------------------------------------------
  router.get(
    '/availability/:resourceType',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const resourceType = String(req.params.resourceType) as ResourceType;
        if (!Object.values(ResourceType).includes(resourceType)) {
          res.status(400).json({ code: 'INVALID_RESOURCE_TYPE', message: `Tipo inválido. Valores válidos: ${Object.values(ResourceType).join(', ')}` });
          return;
        }

        const query = AvailabilityQuerySchema.parse(req.query);
        const startTime = new Date(query.startTime);
        const endTime   = new Date(query.endTime);

        if (endTime <= startTime) {
          res.status(400).json({ code: 'INVALID_DATE_RANGE', message: 'endTime debe ser posterior a startTime' });
          return;
        }

        const allResources = await container.resourceRepository.getByType(resourceType);

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
          resourceType,
          startTime: startTime.toISOString(),
          endTime:   endTime.toISOString(),
          available: available.map((r) => ({
            id:        r.id,
            name:      r.name,
            basePrice: r.basePrice,
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
  // GET /api/customer/me — perfil del cliente autenticado
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
        res.json({ id: customer.id, fullName: customer.fullName, email: customer.email });
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /api/customer/me — eliminar cuenta (anonimización GDPR)
  // -------------------------------------------------------------------------
  /**
   * @swagger
   * /api/customer/me:
   *   delete:
   *     summary: Eliminar cuenta del cliente (derecho al olvido)
   *     description: |
   *       Anonimiza todos los datos personales del cliente (nombre, email,
   *       contraseña). Las reservas pasadas se conservan sin datos
   *       identificables para integridad del historial del negocio.
   *
   *       El JWT actual queda implícitamente invalidado: cualquier intento
   *       de login posterior con las credenciales originales fallará.
   *
   *       Esta acción es **irreversible**.
   *     tags: [Customer Portal]
   *     security:
   *       - BearerAuth: []
   *     responses:
   *       204:
   *         description: Cuenta eliminada correctamente (sin cuerpo de respuesta)
   *       401:
   *         $ref: '#/components/responses/Unauthorized'
   *       404:
   *         description: Cliente no encontrado (ya eliminado o inexistente)
   *       409:
   *         description: La cuenta ya fue eliminada previamente
   */
  router.delete(
    '/me',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const customerId = requireCustomerId(req, res);
        if (!customerId) return;

        const anonymized = await container.customerRepository.anonymize(customerId);

        if (!anonymized) {
          // anonymize() retorna false si el cliente no existe o ya fue anonimizado
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

        // 204 No Content — estándar REST para eliminación exitosa
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/customer/me/reservations — mis reservas
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
  // POST /api/customer/me/reservations — crear reserva propia
  // -------------------------------------------------------------------------
  router.post(
    '/me/reservations',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = CreateCustomerReservationSchema.parse(req.body);
        validateDetailsForType(body.resourceType, body.details);

        const customerId = requireCustomerId(req, res);
        if (!customerId) return;

        const customerEntity = await container.customerRepository.getById(customerId);
        if (!customerEntity) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Cliente no encontrado' });
          return;
        }

        const reservation = await container.reservationService.createReservation({
          id:           randomUUID(),
          resourceId:   body.resourceId,
          customer:     new Customer(customerEntity.id, customerEntity.fullName, customerEntity.email),
          startTime:    new Date(body.startTime),
          endTime:      new Date(body.endTime),
          details:      body.details as PreferenceDetailsByResource[ResourceType],
        });

        res.status(201).json(toReservationDto(reservation));
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /api/customer/me/reservations/:id — modificar reserva propia
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
  // POST /api/customer/me/reservations/:id/cancel — cancelar reserva propia
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
