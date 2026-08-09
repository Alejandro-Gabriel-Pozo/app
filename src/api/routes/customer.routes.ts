/**
 * @file customer.routes.ts
 * @description Portal público para clientes — registro, login y gestión de sus reservas.
 *
 * ## Aislamiento multi-tenant
 * Antes, este router usaba `container` (la BD global del proceso) sin
 * saber para qué negocio era cada registro/reserva — incompatible con
 * que `resources`/`reservations` ya viven en la BD propia de cada tenant.
 *
 * Ahora:
 * - Rutas públicas (`register`/`login`/`availability`) reciben `:businessSlug`
 *   en la URL y resuelven el tenant en cada request vía
 *   `platformRepo.findBySlug()` + `getTenantClient()` / `getTenantRawPool()`.
 * - Rutas autenticadas (`/me/*`) resuelven el tenant desde `business_id`
 *   en el JWT del cliente (ver `CustomerAuthService`), ya que el negocio
 *   no cambia dentro de una misma sesión.
 *
 * ## Cambios — fix/ts-compile-errors
 * - buildService() usa buildTransactionManagerFromPool(tenantPool) en vez
 *   de buildTenantTransactionManager(req). customer.routes.ts resuelve el
 *   pool directamente (sin tenantMiddleware), así que la variante pool-first
 *   es la correcta aquí. Ver docs en tenant-context.ts.
 * - registerLimiter y loginLimiter se castean a RequestHandler para
 *   compatibilidad con exactOptionalPropertyTypes: true (TS2379).
 *   express-rate-limit@7 define RateLimitRequestHandler con propiedades
 *   opcionales como `T | undefined` en vez de `T?`, lo que viola la flag.
 *   El cast es seguro — RateLimitRequestHandler es un RequestHandler válido.
 *
 * ## Rutas
 *
 * ### Públicas (sin autenticación)
 * POST   /api/customer/:businessSlug/register
 * POST   /api/customer/:businessSlug/login
 * GET    /api/customer/:businessSlug/availability
 *
 * ### Protegidas (requieren JWT con role=CUSTOMER, business_id incluido)
 * GET    /api/customer/me
 * DELETE /api/customer/me
 * GET    /api/customer/me/reservations
 * POST   /api/customer/me/reservations
 * PATCH  /api/customer/me/reservations/:id
 * POST   /api/customer/me/reservations/:id/cancel
 */

import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import type pg from 'pg';
import { AppContainer } from '../../container.js';
import { CustomerAuthService } from '../../security/customer.auth.service.js';
import { authenticate, authorize } from '../../security/auth.middleware.js';
import { toReservationDto } from '../mappers/reservation.mapper.js';
import { UserRole, ReservationStatus, BusinessStatus } from '../../types/enums.js';
import { PlatformRepository } from '../../platform/platform.repository.js';
import {
  getTenantClient,
  getTenantRawPool,
  TenantNotFoundError,
  TenantInactiveError,
  TenantNotReadyError,
} from '../../platform/tenant.middleware.js';
import { buildTransactionManagerFromPool } from '../../db/tenant-context.js';
import { SqlClient } from '../../repositories/sql.client.js';
import { SqlResourceRepository }    from '../../repositories/sql.resource.repository.js';
import { SqlReservationRepository } from '../../repositories/sql.reservation.repository.js';
import { SqlCustomerRepository }    from '../../repositories/sql.customer.repository.js';
import { SqlOccupancyRepository }   from '../../repositories/sql.occupancy.repository.js';
import { SqlCategoryRepository }    from '../../repositories/sql.category.repository.js';
import { SqlDomainEventRepository } from '../../repositories/sql.domain-event.repository.js';
import { ReservationService }       from '../../services/reservation.service.js';

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

// express-rate-limit@7 define RateLimitRequestHandler con propiedades
// opcionales como `T | undefined` en lugar de `T?`. Con
// exactOptionalPropertyTypes: true eso no satisface el overload de
// RequestHandler de Express (TS2379). El cast es seguro en runtime.
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
}) as unknown as RequestHandler;

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
}) as unknown as RequestHandler;

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
// Helpers de resolución de tenant
// ---------------------------------------------------------------------------

/**
 * Construye los repos y el ReservationService para un tenant dado su pool raw.
 * Usa buildTransactionManagerFromPool (variante pool-first) porque este router
 * resuelve el pool directamente, sin pasar por tenantMiddleware.
 */
function buildService(client: SqlClient, tenantPool: pg.Pool) {
  const resourceRepo    = new SqlResourceRepository(client);
  const reservationRepo = new SqlReservationRepository(client, resourceRepo);
  const customerRepo    = new SqlCustomerRepository(client);
  const occupancyRepo   = new SqlOccupancyRepository(client);
  const categoryRepo    = new SqlCategoryRepository(client);
  const domainEventRepo = new SqlDomainEventRepository(client);

  const reservationService = new ReservationService(
    reservationRepo,
    resourceRepo,
    occupancyRepo,
    categoryRepo,
    domainEventRepo,
    buildTransactionManagerFromPool(tenantPool),
  );

  return { reservationService, reservationRepo, resourceRepo, customerRepo };
}

/** Resuelve el SqlClient y el pool raw del tenant a partir del slug en la URL pública. */
async function resolveTenantBySlug(
  slug: string,
  platformRepo: PlatformRepository,
): Promise<{ client: SqlClient; tenantPool: pg.Pool; businessId: string }> {
  const business = await platformRepo.findBySlug(slug);
  if (!business) throw new TenantNotFoundError(slug);
  if (business.status !== BusinessStatus.ACTIVE) {
    throw new TenantInactiveError(business.id, business.status);
  }
  if (!business.dbUrlEncrypted) throw new TenantNotReadyError(business.id);
  const client     = await getTenantClient(business.id, platformRepo);
  const tenantPool = getTenantRawPool(business.id);
  return { client, tenantPool, businessId: business.id };
}

type TenantError = TenantNotFoundError | TenantInactiveError | TenantNotReadyError;

function isTenantError(err: unknown): err is TenantError {
  return (
    err instanceof TenantNotFoundError ||
    err instanceof TenantInactiveError ||
    err instanceof TenantNotReadyError
  );
}

function respondTenantError(err: TenantError, res: Response): void {
  if (err instanceof TenantNotFoundError) {
    res.status(404).json({ code: 'BUSINESS_NOT_FOUND', message: 'Negocio no encontrado' });
    return;
  }
  if (err instanceof TenantInactiveError) {
    res.status(403).json({ code: 'BUSINESS_INACTIVE', message: `Negocio inactivo (estado: ${err.status})` });
    return;
  }
  res.status(503).json({
    code: 'BUSINESS_NOT_READY',
    message: 'La base de datos del negocio aún está siendo provisionada',
  });
}

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

export function createCustomerRouter(
  container: AppContainer,
  platformRepo: PlatformRepository,
): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // POST /api/customer/:businessSlug/register
  // -------------------------------------------------------------------------
  router.post(
    '/:businessSlug/register',
    registerLimiter,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const slug = String(req.params.businessSlug);
        const { client, businessId } = await resolveTenantBySlug(slug, platformRepo);

        const body = RegisterCustomerSchema.parse(req.body);
        const { customerRepo } = buildService(client, getTenantRawPool(businessId));
        const authService = new CustomerAuthService(customerRepo, businessId);
        const result = await authService.register(body);

        res.status(201).json({
          message: 'Cuenta creada exitosamente',
          token: result.token,
          tokenType: 'Bearer',
          customer: result.customer,
        });
      } catch (err) {
        if (isTenantError(err)) { respondTenantError(err, res); return; }
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
  // POST /api/customer/:businessSlug/login
  // -------------------------------------------------------------------------
  router.post(
    '/:businessSlug/login',
    loginLimiter,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const slug = String(req.params.businessSlug);
        const { client, businessId } = await resolveTenantBySlug(slug, platformRepo);

        const body = LoginCustomerSchema.parse(req.body);
        const { customerRepo } = buildService(client, getTenantRawPool(businessId));
        const authService = new CustomerAuthService(customerRepo, businessId);
        const result = await authService.login(body);

        res.json({
          token: result.token,
          tokenType: 'Bearer',
          customer: result.customer,
        });
      } catch (err) {
        if (isTenantError(err)) { respondTenantError(err, res); return; }
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
  // GET /api/customer/:businessSlug/availability — público
  // -------------------------------------------------------------------------
  router.get(
    '/:businessSlug/availability',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const slug = String(req.params.businessSlug);
        const { client, businessId } = await resolveTenantBySlug(slug, platformRepo);

        const query = AvailabilityQuerySchema.parse(req.query);
        const startTime = new Date(query.startTime);
        const endTime   = new Date(query.endTime);

        if (endTime <= startTime) {
          res.status(400).json({ code: 'INVALID_DATE_RANGE', message: 'endTime debe ser posterior a startTime' });
          return;
        }

        const { resourceRepo, reservationRepo } = buildService(client, getTenantRawPool(businessId));
        let allResources = await resourceRepo.getAll();

        if (query.categoryId) {
          allResources = allResources.filter((r) => r.categoryId === query.categoryId);
        }

        const busyResourceIds = new Set<string>();
        await Promise.all(
          allResources.map(async (resource) => {
            const active = await reservationRepo.getActiveForResourceInRange(
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
        if (isTenantError(err)) { respondTenantError(err, res); return; }
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // A partir de aquí: requieren JWT con role=CUSTOMER (business_id incluido)
  // -------------------------------------------------------------------------
  router.use(authenticate(), authorize([UserRole.CUSTOMER]));

  // Resuelve req.db para el negocio del cliente autenticado — mismo campo
  // que usa tenantMiddleware, aunque ese middleware nunca llega a correr
  // sobre este router (se monta antes, y además ignora role=CUSTOMER).
  router.use(async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const businessId = req.user?.businessId;
      if (!businessId) {
        res.status(401).json({ code: 'UNAUTHORIZED', message: 'Token no contiene business_id' });
        return;
      }
      req.db = await getTenantClient(businessId, platformRepo);
      next();
    } catch (err) {
      if (isTenantError(err)) { respondTenantError(err, res); return; }
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/customer/me
  // -------------------------------------------------------------------------
  router.get(
    '/me',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const customerId = requireCustomerId(req, res);
        if (!customerId) return;

        const { customerRepo } = buildService(req.db!, getTenantRawPool(req.user!.businessId!));
        const customer = await customerRepo.getById(customerId);
        if (!customer) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Cliente no encontrado' });
          return;
        }
        res.json({ id: customer.id, fullName: customer.displayName, email: customer.email ?? '' });
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

        const { customerRepo } = buildService(req.db!, getTenantRawPool(req.user!.businessId!));
        const anonymized = await customerRepo.anonymize(customerId);

        if (!anonymized) {
          const existing = await customerRepo.getById(customerId);
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

        const { reservationRepo } = buildService(req.db!, getTenantRawPool(req.user!.businessId!));
        const reservations = await reservationRepo.getByCustomerId(customerId);
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

        const { reservationService, customerRepo } = buildService(req.db!, getTenantRawPool(req.user!.businessId!));
        const customerEntity = await customerRepo.getById(customerId);
        if (!customerEntity) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Cliente no encontrado' });
          return;
        }

        const reservation = await reservationService.createReservation({
          id:         randomUUID(),
          resourceId: body.resourceId,
          customer:   customerEntity,
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

        const { reservationService, reservationRepo } = buildService(req.db!, getTenantRawPool(req.user!.businessId!));
        const existing = await reservationRepo.getById(reservationId);
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

        const updated = await reservationService.updateReservation(
          reservationId,
          {
            ...(body.startTime !== undefined && { startTime: new Date(body.startTime) }),
            ...(body.endTime   !== undefined && { endTime:   new Date(body.endTime) }),
            ...(body.details   !== undefined && { details:   body.details }),
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

        const businessId = req.user!.businessId!;

        const { reservationService, reservationRepo } = buildService(req.db!, getTenantRawPool(businessId));
        const reservation = await reservationRepo.getById(reservationId);
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

        const cancelled = await reservationService.cancelReservation(reservationId, businessId);
        res.json(toReservationDto(cancelled));
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
