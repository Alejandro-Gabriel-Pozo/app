/**
 * @file customer.routes.ts
 * @description Portal público para clientes — registro, login y gestión de sus reservas.
 *
 * ## Rutas
 *
 * ### Públicas (sin autenticación)
 * POST /api/customer/register    — crear cuenta
 * POST /api/customer/login       — obtener JWT de cliente
 * GET  /api/customer/availability/:resourceType — ver disponibilidad
 *
 * ### Protegidas (requieren JWT con role=CUSTOMER)
 * GET  /api/customer/me                — ver perfil propio
 * GET  /api/customer/me/reservations   — ver mis reservas
 * POST /api/customer/me/reservations   — crear reserva propia
 * POST /api/customer/me/reservations/:id/cancel — cancelar reserva propia
 *
 * ## Restricciones de seguridad
 * - Un cliente SOLO puede ver y cancelar SUS propias reservas.
 * - Un cliente no puede ver datos de otros clientes.
 * - La cancelación solo está permitida si la reserva está en PENDING.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppContainer } from '../../container.js';
import { Customer } from '../../domain/entities.js';
import { CustomerAuthService } from '../../security/customer.auth.service.js';
import { authenticate, authorize } from '../../security/auth.middleware.js';
import { toReservationDto } from '../mappers/reservation.mapper.js';
import { UserRole, ResourceType, ReservationStatus } from '../../types/enums.js';
import { PreferenceDetailsByResource } from '../../types/preferences.types.js';
import { validateDetailsForType } from '../schemas/request.schemas.js';

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

const AvailabilityQuerySchema = z.object({
  startTime: z.string().datetime(),
  endTime:   z.string().datetime(),
});

// ---------------------------------------------------------------------------
// Factory del router
// ---------------------------------------------------------------------------

export function createCustomerRouter(container: AppContainer): Router {
  const router = Router();
  const customerAuthService = new CustomerAuthService(container.customerRepository);

  // -------------------------------------------------------------------------
  // POST /api/customer/register — público
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
   */
  router.post(
    '/register',
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
  // POST /api/customer/login — público
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
   */
  router.post(
    '/login',
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
        const resourceType = req.params.resourceType as ResourceType;
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

        // Todos los recursos del tipo solicitado
        const allResources = await container.resourceRepository.getByType(resourceType);

        // Reservas activas que bloquean en ese rango
        const busyResourceIds = new Set<string>();
        for (const resource of allResources) {
          const active = await container.reservationRepository.getActiveForResourceInRange(
            resource.id,
            startTime,
            endTime,
          );
          if (active.length > 0) busyResourceIds.add(resource.id);
        }

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
        const customerId = req.user!.customerId!;
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
        const customerId = req.user!.customerId!;
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

        const customerId = req.user!.customerId!;
        const customerEntity = await container.customerRepository.getById(customerId);
        if (!customerEntity) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Cliente no encontrado' });
          return;
        }

        const reservation = await container.reservationService.createReservation({
          id:           randomUUID(),
          resourceType: body.resourceType,
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
  // POST /api/customer/me/reservations/:id/cancel — cancelar reserva propia
  // -------------------------------------------------------------------------
  /**
   * @swagger
   * /api/customer/me/reservations/{id}/cancel:
   *   post:
   *     summary: Cancelar una reserva propia
   *     description: Solo se pueden cancelar reservas en estado PENDING.
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
   *         description: La reserva ya no puede cancelarse (estado != PENDING)
   */
  router.post(
    '/me/reservations/:id/cancel',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const reservationId = req.params.id;
        const customerId    = req.user!.customerId!;

        const reservation = await container.reservationRepository.getById(reservationId);
        if (!reservation) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Reserva no encontrada' });
          return;
        }

        // Verificar que la reserva pertenece al cliente autenticado
        if (reservation.customer.id !== customerId) {
          res.status(403).json({ code: 'FORBIDDEN', message: 'No tenés permiso para cancelar esta reserva' });
          return;
        }

        // Solo se pueden cancelar reservas PENDING
        if (reservation.status !== ReservationStatus.PENDING) {
          res.status(409).json({
            code: 'INVALID_STATUS',
            message: `Solo se pueden cancelar reservas en estado PENDING. Estado actual: ${reservation.status}`,
          });
          return;
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
