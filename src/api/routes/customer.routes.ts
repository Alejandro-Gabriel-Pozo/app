/**
 * @file customer.routes.ts
 * @description Portal público para clientes — registro, login y gestión de sus reservas.
 *
 * ## Rutas
 *
 * ### Públicas (sin autenticación)
 * POST  /api/customer/register    — crear cuenta
 * POST  /api/customer/login       — obtener JWT de cliente
 * GET   /api/customer/availability/:resourceType — ver disponibilidad
 *
 * ### Protegidas (requieren JWT con role=CUSTOMER)
 * GET   /api/customer/me                        — ver perfil propio
 * GET   /api/customer/me/reservations           — ver mis reservas
 * POST  /api/customer/me/reservations           — crear reserva propia
 * PATCH /api/customer/me/reservations/:id       — modificar reserva propia (solo PENDING)
 * POST  /api/customer/me/reservations/:id/cancel — cancelar reserva propia
 *
 * ## Restricciones de seguridad
 * - Un cliente SOLO puede ver, modificar y cancelar SUS propias reservas.
 * - Un cliente no puede ver datos de otros clientes.
 * - La modificación solo está permitida si la reserva está en PENDING.
 * - La cancelación está permitida en PENDING (sin restricción de tiempo)
 *   o en CONFIRMED con al menos CANCEL_ADVANCE_MS de antelación.
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
  /**
   * @swagger
   * /api/customer/register:
   *   post:
   *     summary: Registrar cuenta de cliente
   *     tags: [Customer Portal]
   *     security: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [fullName, email, password]
   *             properties:
   *               fullName: { type: string, example: "María López" }
   *               email:    { type: string, format: email, example: "maria@example.com" }
   *               password: { type: string, minLength: 8, example: "MiClave123!" }
   *     responses:
   *       201:
   *         description: Cuenta creada — devuelve JWT listo para usar
   *       400:
   *         description: Datos inválidos o email ya registrado
   *       429:
   *         description: Demasiados intentos — rate limit excedido
   */
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
  /**
   * @swagger
   * /api/customer/login:
   *   post:
   *     summary: Login de cliente
   *     tags: [Customer Portal]
   *     security: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [email, password]
   *             properties:
   *               email:    { type: string, format: email }
   *               password: { type: string }
   *     responses:
   *       200:
   *         description: Login exitoso — devuelve JWT
   *       401:
   *         description: Credenciales inválidas
   *       429:
   *         description: Demasiados intentos — rate limit excedido
   */
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
  /**
   * @swagger
   * /api/customer/availability/{resourceType}:
   *   get:
   *     summary: Ver recursos disponibles en un rango horario
   *     description: Endpoint público — no requiere autenticación.
   *     tags: [Customer Portal]
   *     security: []
   *     parameters:
   *       - name: resourceType
   *         in: path
   *         required: true
   *         schema: { type: string, enum: [CABIN, TOUR_SEAT, RESTAURANT_TABLE, SPA] }
   *       - name: startTime
   *         in: query
   *         required: true
   *         schema: { type: string, format: date-time }
   *       - name: endTime
   *         in: query
   *         required: true
   *         schema: { type: string, format: date-time }
   *     responses:
   *       200:
   *         description: Lista de recursos disponibles en el rango solicitado
   *       400:
   *         description: Parámetros de fecha inválidos
   */
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
  /**
   * @swagger
   * /api/customer/me:
   *   get:
   *     summary: Ver perfil del cliente autenticado
   *     tags: [Customer Portal]
   *     security:
   *       - BearerAuth: []
   *     responses:
   *       200:
   *         description: Datos del cliente
   *       401:
   *         $ref: '#/components/responses/Unauthorized'
   */
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
  // GET /api/customer/me/reservations — mis reservas
  // -------------------------------------------------------------------------
  /**
   * @swagger
   * /api/customer/me/reservations:
   *   get:
   *     summary: Ver mis reservas
   *     tags: [Customer Portal]
   *     security:
   *       - BearerAuth: []
   *     responses:
   *       200:
   *         description: Lista de reservas del cliente autenticado
   */
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
  /**
   * @swagger
   * /api/customer/me/reservations:
   *   post:
   *     summary: Crear una reserva
   *     tags: [Customer Portal]
   *     security:
   *       - BearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [resourceType, resourceId, startTime, endTime]
   *             properties:
   *               resourceType: { type: string, enum: [CABIN, TOUR_SEAT, RESTAURANT_TABLE, SPA] }
   *               resourceId:   { type: string }
   *               startTime:    { type: string, format: date-time }
   *               endTime:      { type: string, format: date-time }
   *               details:      { type: object }
   *     responses:
   *       201:
   *         description: Reserva creada en estado PENDING
   *       400:
   *         description: Validación fallida
   *       409:
   *         description: Recurso no disponible en el rango solicitado
   */
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
  /**
   * @swagger
   * /api/customer/me/reservations/{id}:
   *   patch:
   *     summary: Modificar una reserva propia
   *     description: |
   *       Permite actualizar el rango horario y/o los detalles de una reserva
   *       en estado PENDING. Todos los campos son opcionales — se fusionan con
   *       los valores existentes. Al menos uno debe estar presente.
   *     tags: [Customer Portal]
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: string }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               startTime: { type: string, format: date-time }
   *               endTime:   { type: string, format: date-time }
   *               details:   { type: object, description: "Preferencias según el tipo de recurso" }
   *     responses:
   *       200:
   *         description: Reserva actualizada
   *       400:
   *         description: Datos inválidos o ningún campo enviado
   *       403:
   *         description: La reserva no pertenece al cliente autenticado
   *       404:
   *         description: Reserva no encontrada
   *       409:
   *         description: La reserva no está en PENDING o el recurso no está disponible
   */
  router.patch(
    '/me/reservations/:id',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const reservationId = String(req.params.id);

        const customerId = requireCustomerId(req, res);
        if (!customerId) return;

        // Verificar existencia y ownership antes de pasar al servicio
        const existing = await container.reservationRepository.getById(reservationId);
        if (!existing) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Reserva no encontrada' });
          return;
        }
        if (existing.customer.id !== customerId) {
          res.status(403).json({ code: 'FORBIDDEN', message: 'No tenés permiso para modificar esta reserva' });
          return;
        }

        // Estado validado en el router para devolver 409 antes de parsear el body
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
  /**
   * @swagger
   * /api/customer/me/reservations/{id}/cancel:
   *   post:
   *     summary: Cancelar una reserva propia
   *     description: |
   *       Cancela una reserva propia según el estado:
   *       - **PENDING**: sin restricción de tiempo.
   *       - **CONFIRMED**: requiere al menos 24 horas de antelación respecto a `startTime`.
   *       - Otros estados (COMPLETED, CANCELLED): no permitido.
   *     tags: [Customer Portal]
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Reserva cancelada
   *       403:
   *         description: La reserva no pertenece al cliente autenticado
   *       404:
   *         description: Reserva no encontrada
   *       409:
   *         description: La reserva ya no puede cancelarse (COMPLETED o CANCELLED)
   *       422:
   *         description: Cancelación muy tardía — reserva CONFIRMED dentro de las próximas 24h
   */
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

        // Verificar que el estado sea cancelable por el cliente
        if (!CANCELLABLE_STATUSES.includes(reservation.status)) {
          res.status(409).json({
            code: 'INVALID_STATUS',
            message: `No se puede cancelar una reserva en estado ${reservation.status}.`,
          });
          return;
        }

        // Para reservas CONFIRMED: verificar antelación mínima de 24h
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
