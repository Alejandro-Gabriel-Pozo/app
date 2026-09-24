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
 * ## Cambios — feat/resource-locks (Paso 3)
 * - buildService() agrega SqlResourceLockRepository como séptimo argumento
 *   de ReservationService.
 *
 * ## Cambios — reserva por duración (resource-locks, gestión + wiring)
 * - buildService() agrega SqlBookableServiceRepository como octavo argumento.
 * - CreateCustomerReservationSchema acepta `serviceId` opcional y `endTime`
 *   pasa a opcional (se deriva de duration_minutes si no viene). Este es el
 *   único flujo de reserva real hoy en producción — antes nunca mandaba
 *   serviceId, así que resource_locks quedaba inerte pese a que el motor
 *   de bloqueo ya funcionaba en ReservationService.
 *
 * ## Rutas
 *
 * ### Públicas (sin autenticación)
 * POST   /api/customer/:businessSlug/register
 * POST   /api/customer/:businessSlug/login
 * POST   /api/customer/:businessSlug/login/google
 * GET    /api/customer/:businessSlug/availability
 * POST   /api/customer/logout
 *
 * ### Protegidas (requieren JWT con role=CUSTOMER, business_id incluido)
 * GET    /api/customer/me
 * DELETE /api/customer/me
 * POST   /api/customer/refresh
 * GET    /api/customer/me/reservations
 * POST   /api/customer/me/reservations
 * PATCH  /api/customer/me/reservations/:id
 * POST   /api/customer/me/reservations/:id/cancel
 *
 * ## Cookie httpOnly del portal (19/08/2026, docs/pendientes-2026-08-18.md
 * punto P)
 * Mismo patrón que B2 aplicó al panel de staff (docs/pendientes-2026-08-13.md):
 * register/login/login-google setean `AUTH_COOKIE_NAME_CUSTOMER` además de
 * devolver el token en el body (coexistencia, no reemplazo — cualquier
 * consumidor que lea el body sigue funcionando). `logout` limpia la cookie
 * sin requerir autenticación (igual que `/api/auth/logout` de staff — es
 * idempotente, funciona aunque la cookie ya haya vencido). `refresh`
 * re-firma el token del cliente YA autenticado con un `exp` nuevo, mismo
 * criterio que `POST /api/auth/refresh` de staff (`me.routes.ts`) pero para
 * clientes — no hace falta releer nada de la tenant DB, `authenticate()` ya
 * verificó la firma y el `exp` del token vigente.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import type pg from 'pg';
import type { AppContainer } from '../../container.js';
import { CustomerAuthService } from '../../security/customer.auth.service.js';
import {
  authenticate,
  authorize,
  setCustomerAuthCookie,
  clearCustomerAuthCookie,
  signToken,
} from '../../security/auth.middleware.js';
import { parseExpiresIn } from '../../security/auth.service.js';
import { resolveSessionTtl } from '../../security/session-ttl.js';
import { getJwtSecret, getJwtExpiresInRaw } from '../../config/env.js';
import { Roles } from '../../security/roles.js';
import { toReservationDto } from '../mappers/reservation.mapper.js';
import { ReservationStatus, BusinessStatus, UserRole } from '../../types/enums.js';
import type { PlatformRepository } from '../../platform/platform.repository.js';
import {
  getTenantClient,
  getTenantRawPool,
  TenantNotFoundError,
  TenantInactiveError,
  TenantNotReadyError,
} from '../../platform/tenant.middleware.js';
import { ensureTenantWorker } from '../../workers/outbox.registry.js';
import { buildTransactionManagerFromPool } from '../../db/tenant-context.js';
import type { SqlClient } from '../../repositories/sql.client.js';
import { SqlResourceRepository }     from '../../reservas/sql.resource.repository.js';
import { SqlDepositPolicyRepository } from '../../reservas/sql.deposit-policy.repository.js';
import { SqlBusinessProfileRepository } from '../../repositories/sql.business-profile.repository.js';
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';
import { SqlNumberSequenceRepository } from '../../repositories/sql.number-sequence.repository.js';
import { SqlCancellationPolicyRepository } from '../../reservas/sql.cancellation-policy.repository.js';
import { SqlReservationRepository }  from '../../reservas/sql.reservation.repository.js';
import type { Reservation }          from '../../reservas/Reservation.js';
import { SqlCustomerRepository }     from '../../clientes-finanzas/sql.customer.repository.js';
import { SqlOccupancyRepository }    from '../../reservas/sql.occupancy.repository.js';
import { SqlCategoryRepository }     from '../../reservas/sql.category.repository.js';
import { SqlDomainEventRepository }  from '../../repositories/sql.domain-event.repository.js';
import { SqlResourceLockRepository } from '../../reservas/sql.resource-lock.repository.js';
import { SqlBookableServiceRepository } from '../../reservas/sql.bookable-service.repository.js';
import { SqlCustomerRateRepository } from '../../clientes-finanzas/sql.customer-rate.repository.js';
import { SqlOperatingHoursRepository } from '../../platform/sql.operating-hours.repository.js';
import { SqlMaintenanceWindowRepository } from '../../pms-estadias/sql.maintenance-window.repository.js';
import { SqlAuditLogRepository } from '../../repositories/audit-log.repository.js';
import { ReservationService }        from '../../reservas/reservation.service.js';

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

/** Body de POST /:businessSlug/login/google (punto 5/E5, 15/08/2026). */
const GoogleLoginCustomerSchema = z.object({
  idToken: z.string().min(1, { message: 'idToken es obligatorio' }),
});

const CreateCustomerReservationSchema = z.object({
  categoryId: z.string().min(1),
  resourceId: z.string().min(1),
  serviceId:  z.string().min(1).optional(),
  startTime:  z.string().datetime(),
  // Opcional: si no viene, se deriva de duration_minutes del serviceId.
  endTime:    z.string().datetime().optional(),
  details:    z.record(z.unknown()).default({}),
}).refine(
  (data) => data.endTime || data.serviceId,
  { message: 'endTime es obligatorio si no se especifica serviceId (para derivar la duración)', path: ['endTime'] },
).refine(
  (data) => !data.endTime || new Date(data.endTime) > new Date(data.startTime),
  { message: 'endTime debe ser posterior a startTime', path: ['endTime'] },
);

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
  const lockRepo        = new SqlResourceLockRepository(client);
  const bookableServiceRepo = new SqlBookableServiceRepository(client);
  const customerRateRepo = new SqlCustomerRateRepository(client);
  const operatingHoursRepo = new SqlOperatingHoursRepository(client);
  const maintenanceWindowRepo = new SqlMaintenanceWindowRepository(client);
  const depositPolicyRepo = new SqlDepositPolicyRepository(client);
  const businessProfileRepo = new SqlBusinessProfileRepository(client);
  const financialTransactionRepo = new SqlFinancialTransactionRepository(client);
  const invoiceRepo = new SqlInvoiceRepository(client);
  const numberSequenceRepo = new SqlNumberSequenceRepository(client);
  const cancellationPolicyRepo = new SqlCancellationPolicyRepository(client);
  // D-10 (15/09/2026, docs/decisiones-auditoria-fase2-2026-09-15.md #8) --
  // confirmReservation()/cancelReservation()/completeReservation() ahora
  // auditan (A6.5), ver reservation-audit.ts. Este router usa `client`
  // (el SqlClient del tenant resuelto por slug), no `req.db` -- mismo
  // patrón que el resto de los repos de esta función.
  const auditLogRepo = new SqlAuditLogRepository(client);

  const reservationService = new ReservationService(
    reservationRepo,
    resourceRepo,
    occupancyRepo,
    categoryRepo,
    domainEventRepo,
    buildTransactionManagerFromPool(tenantPool),
    lockRepo,
    bookableServiceRepo,
    customerRateRepo,
    operatingHoursRepo,
    maintenanceWindowRepo,
    depositPolicyRepo,
    businessProfileRepo,
    financialTransactionRepo,
    invoiceRepo,
    numberSequenceRepo,
    cancellationPolicyRepo,
    auditLogRepo,
  );

  return { reservationService, reservationRepo, resourceRepo, customerRepo, numberSequenceRepo };
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

/**
 * RBAC-OWN-001 (docs/pendientes-2026-08-30.md; triage 07/09/2026) — guard de
 * pertenencia del portal de cliente. El aislamiento ENTRE negocios ya es
 * estructural (una BD por tenant); lo que NO lo es, y depende de que cada
 * ruta lo enhebre a mano, es que dentro de un mismo negocio el cliente A no
 * opere sobre la reserva del cliente B. Este helper centraliza el patrón
 * "traer la reserva por :id → 404 si no existe → 403 si no es del cliente
 * autenticado" que estaba copiado en `PATCH /me/reservations/:id` y en
 * `/cancel`. Devuelve la reserva ya verificada, o `null` si ya respondió
 * (el caller hace `return`). `accion` va en el texto del 403.
 */
export async function requireOwnReservation(
  reservationId: string,
  customerId: string,
  reservationRepo: { getById(id: string): Promise<Reservation | undefined> },
  res: Response,
  accion: string,
): Promise<Reservation | null> {
  const reservation = await reservationRepo.getById(reservationId);
  if (!reservation) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Reserva no encontrada' });
    return null;
  }
  if (reservation.customer.id !== customerId) {
    res.status(403).json({
      code: 'FORBIDDEN',
      message: `No tenés permiso para ${accion} esta reserva`,
    });
    return null;
  }
  return reservation;
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
        const { customerRepo, numberSequenceRepo } = buildService(client, getTenantRawPool(businessId));
        const authService = new CustomerAuthService(customerRepo, businessId, numberSequenceRepo);
        const result = await authService.register(body);
        setCustomerAuthCookie(res, result.token, result.expiresIn);

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
        const { customerRepo, numberSequenceRepo } = buildService(client, getTenantRawPool(businessId));
        const authService = new CustomerAuthService(customerRepo, businessId, numberSequenceRepo);
        const result = await authService.login(body);
        setCustomerAuthCookie(res, result.token, result.expiresIn);

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
  // POST /api/customer/:businessSlug/login/google (punto 5/E5, 15/08/2026)
  // A diferencia de /login, SÍ auto-crea un customer nuevo si el email no
  // existe todavía (self-service) — ver docblock de
  // CustomerAuthService.loginWithGoogle().
  // -------------------------------------------------------------------------
  router.post(
    '/:businessSlug/login/google',
    loginLimiter,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const slug = String(req.params.businessSlug);
        const { client, businessId } = await resolveTenantBySlug(slug, platformRepo);

        const body = GoogleLoginCustomerSchema.parse(req.body);
        const { customerRepo, numberSequenceRepo } = buildService(client, getTenantRawPool(businessId));
        const authService = new CustomerAuthService(customerRepo, businessId, numberSequenceRepo);
        const result = await authService.loginWithGoogle(body.idToken);
        setCustomerAuthCookie(res, result.token, result.expiresIn);

        res.json({
          token: result.token,
          tokenType: 'Bearer',
          customer: result.customer,
        });
      } catch (err) {
        if (isTenantError(err)) { respondTenantError(err, res); return; }
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'GOOGLE_TOKEN_INVALID') {
          res.status(401).json({ code, message: 'El token de Google no es válido.' });
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
  // POST /api/customer/logout — pública, sin autenticación (mismo criterio
  // que /api/auth/logout de staff: limpiar una cookie ya vencida/ausente no
  // debería fallar).
  // -------------------------------------------------------------------------
  router.post('/logout', (_req: Request, res: Response): void => {
    clearCustomerAuthCookie(res);
    res.status(204).end();
  });

  // -------------------------------------------------------------------------
  // A partir de aquí: requieren JWT con role=CUSTOMER (business_id incluido)
  // -------------------------------------------------------------------------
  router.use(authenticate(), authorize(Roles.CUSTOMER_ONLY));

  // Resuelve req.db para el negocio del cliente autenticado — mismo campo
  // que usa tenantMiddleware, aunque ese middleware nunca llega a correr
  // sobre este router (se monta antes, y además ignora role=CUSTOMER).
  //
  // CUSTOMER-PORTAL-NO-OUTBOX-WORKER-001 (11/09/2026, gate
  // `architecture-governor`, decisión del dueño): sin este `ensureTenantWorker`,
  // un negocio con tráfico ÚNICAMENTE de portal nunca arrancaba
  // `OutboxWorker`/`ReservationHoldExpiryWorker` -- este router sí escribe a
  // `domain_events` (`buildService()` construye `ReservationService` con
  // `SqlDomainEventRepository`), y esos eventos quedaban insertados sin
  // despachar nunca. Costo aceptado, no un efecto colateral escondido:
  // `ensureTenantWorker` arranca DOS timers por tenant, no uno
  // (`outbox.registry.ts` -- `OutboxWorker` 5s + `ReservationHoldExpiryWorker`
  // 60s), y si el negocio nunca había tenido tráfico de staff, el primer
  // arranque de `ReservationHoldExpiryWorker` barre de una sola vez todas las
  // holds vencidas acumuladas, con efecto financiero real (anula las
  // transacciones asociadas). Idempotente por diseño
  // (`workers.has(businessId)` en `ensureTenantWorker`) -- llamarlo en cada
  // request del portal después de la primera vez es un lookup de `Map`, sin
  // costo real.
  router.use(async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const businessId = req.user?.businessId;
      if (!businessId) {
        res.status(401).json({ code: 'UNAUTHORIZED', message: 'Token no contiene business_id' });
        return;
      }
      req.db = await getTenantClient(businessId, platformRepo);
      ensureTenantWorker(businessId, req.db, getTenantRawPool(businessId), platformRepo);
      next();
    } catch (err) {
      if (isTenantError(err)) { respondTenantError(err, res); return; }
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // Wave 15 item 2 (24/09/2026, D-04 opción A, revocación real de sesión —
  // docs/diseno-wave15-sesion-saga-aprovisionamiento-2026-09-24.md §2.2).
  //
  // A diferencia del staff, `authenticate()` NO chequea `token_version`
  // para tokens CUSTOMER -- se saltea esa rama a propósito
  // (`security/auth.middleware.ts::authenticate()`, mismo motivo que nunca
  // llamó a `resolveMembershipContext` para clientes: la revocación de
  // clientes vive en otra BD, la del tenant, no en la de plataforma). Este
  // middleware es el lugar que cierra ese hueco para el portal.
  //
  // Decisión de costo del gate (24/09/2026, ver §2.2 del documento citado):
  // el staff resuelve esto GRATIS (mismo viaje a BD que ya hacía
  // `getMembershipContext()` en cada request de `/api/*`). El portal NO
  // tiene un lookup por-request equivalente -- el middleware de arriba
  // solo resuelve la conexión al tenant, no lee la fila del customer --
  // así que esta SÍ es una query nueva por request autenticado del portal.
  // Se acepta como su propio lookup mínimo (opción (a) de la decisión de
  // costo, en vez de forzar una fusión artificial con algo que no
  // comparte forma): una sola columna, corre UNA vez por request (acá, no
  // repetida por cada ruta), y el valor resuelto (`storedTokenVersion`) se
  // guarda en `req.user.tokenVersion` para que `POST /refresh` más abajo
  // no tenga que volver a consultarlo.
  //
  // Mismo código de mecanismo que el lado staff (coerción `?? 0`, nunca
  // "sin verificar") pero código de respuesta DISTINTO a propósito:
  // `MEMBERSHIP_INACTIVE` no tiene sentido para un cliente (no tiene
  // "membresía" a un negocio) -- `SESSION_REVOKED` es un código nuevo,
  // propio del portal.
  // -------------------------------------------------------------------------
  router.use(async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const customerId = req.user?.customerId;
      if (!customerId) { next(); return; }

      const storedTokenVersion = await new SqlCustomerRepository(req.db!).getTokenVersion(customerId);
      const claimedTokenVersion = req.user?.tv ?? 0;

      if (storedTokenVersion === null || storedTokenVersion !== claimedTokenVersion) {
        res.status(401).json({
          code: 'SESSION_REVOKED',
          message: 'Tu sesión ya no es válida. Iniciá sesión de nuevo.',
        });
        return;
      }

      req.user!.tokenVersion = storedTokenVersion;
      next();
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/customer/categories
  // GET /api/customer/bookable-services
  //
  // P-01/D-03 (Wave 2, 16/09/2026, docs/decisiones-plan-integral-2026-09-16.md).
  // Antes, el portal leía este mismo catálogo pegándole directo a las rutas
  // de STAFF (`GET /api/categories`, `GET /api/bookable-services`,
  // `authorize(Roles.BOOKING)` — CUSTOMER satisface BOOKING). Eso está roto
  // (500) desde el 03/07/2026 (`tenantMiddleware` no fijaba `req.db` para
  // tokens CUSTOMER en rutas de staff -- ver `d2da231`) y el fix real
  // de D-03 (rechazo por ACTOR en `tenantMiddleware`, ver ese archivo) lo
  // vuelve 403 deliberado en vez de 500 accidental -- pero no lo arregla:
  // el wizard "Nueva reserva" del portal (categoría → servicio →
  // disponibilidad) necesita este catálogo para funcionar, con o sin D-03.
  // Camino dedicado, mismo patrón que `/me/reservations` (no reabrir el
  // paso por rutas de staff, `CUSTOMER-TOKEN-STAFF-ROUTE-500-001`): repos
  // instanciados sobre `req.db` (ya resuelto arriba), solo lectura, sin
  // `authorize()` adicional -- el `router.use(authorize(Roles.CUSTOMER_ONLY))`
  // de más arriba ya cubre todo este router.
  //
  // Divergencia deliberada y CONDICIONADA (gate `architecture-governor`,
  // ronda 2, 16/09/2026, DEFENSIVE_DEVELOPING.md §5/§6): estas 2 rutas
  // instancian el repo directo, salteando CategoryService/BookableServiceService
  // (que el resto del repo sí usa). Hoy es equivalente byte a byte --
  // ambos servicios son wrappers de una línea sobre `repo.findAll()`, sin
  // auditoría ni `TransactionManager` de por medio -- pero es un SEGUNDO
  // camino de lectura para la misma responsabilidad. Gatillo de revisión:
  // si `listCategories()`/`listServices()` alguna vez gana lógica propia
  // (filtro por módulo/plan, mapper distinto, lo que sea), este camino
  // queda desincronizado en silencio -- ahí hay que pasar estas 2 rutas
  // por el servicio real, no seguir duplicando el `findAll()` a mano.
  // -------------------------------------------------------------------------
  router.get(
    '/categories',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const categories = await new SqlCategoryRepository(req.db!).findAll();
        res.json(categories);
      } catch (err) { next(err); }
    },
  );

  router.get(
    '/bookable-services',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const services = await new SqlBookableServiceRepository(req.db!).findAll();
        res.json(services);
      } catch (err) { next(err); }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/customer/me
  //
  // `?businessSlug=X` opcional (19/08/2026, portal a cookie httpOnly): la
  // cookie del portal es del dominio entero (`path: '/'`), así que un
  // cliente logueado en el negocio A cuya cookie viaja igual al visitar el
  // portal del negocio B tiene que verse como "no logueado" ahí, no como
  // logueado-con-los-datos-de-A. Sin `businessSlug`, se comporta igual que
  // antes (usado por callers que ya conocen el contexto del negocio por
  // otra vía).
  // -------------------------------------------------------------------------
  router.get(
    '/me',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const customerId = requireCustomerId(req, res);
        if (!customerId) return;

        const expectedSlug = typeof req.query.businessSlug === 'string' ? req.query.businessSlug : undefined;
        if (expectedSlug) {
          const business = await platformRepo.findBySlug(expectedSlug);
          if (!business || business.id !== req.user!.businessId) {
            res.status(401).json({ code: 'UNAUTHORIZED', message: 'Sesión de otro negocio' });
            return;
          }
        }

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
  // POST /api/customer/refresh — re-firma el token con un exp nuevo, mismo
  // criterio que POST /api/auth/refresh de staff (me.routes.ts).
  //
  // Wave 15 (24/09/2026, docs/diseno-wave15-sesion-saga-aprovisionamiento-
  // 2026-09-24.md §1/§2) — ya NO es pura re-firma en memoria:
  // 1. TTL (item 1) -- `resolveSessionTtl()` resuelve el override por
  //    negocio en vez del `JWT_EXPIRES_IN` fijo. Es TTL configurable, NO
  //    un idle-timeout real -- ver `security/session-ttl.ts` para la
  //    distinción completa.
  // 2. `tv` (item 2) -- el middleware de revocación de arriba YA leyó el
  //    `token_version` actual del customer para esta misma request y lo
  //    dejó en `req.user.tokenVersion`; se reusa acá para no volver a
  //    consultarlo (una sola query nueva por request en todo este router,
  //    no dos).
  // -------------------------------------------------------------------------
  router.post(
    '/refresh',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const customerId = req.user?.customerId;
      const businessId = req.user?.businessId;
      if (!customerId || !businessId) {
        res.status(401).json({ code: 'UNAUTHORIZED', message: 'No autenticado' });
        return;
      }

      try {
        const ttl = await resolveSessionTtl(platformRepo, 'customer', parseExpiresIn(getJwtExpiresInRaw()), businessId);
        const tv = req.user?.tokenVersion ?? 0;
        const token = signToken(
          { sub: customerId, role: UserRole.CUSTOMER, customer_id: customerId, business_id: businessId, tv },
          getJwtSecret(),
          ttl,
        );
        setCustomerAuthCookie(res, token, ttl);
        res.status(200).json({ token, tokenType: 'Bearer', expiresIn: ttl });
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

        // Reservas ya no depende de la clase Customer completa de
        // clientes-finanzas (Fase 7, docs/auditoria-modularidad.md D1) --
        // se proyecta acá, en el borde, a la representación mínima que
        // el dominio de reservas necesita.
        const reservation = await reservationService.createReservation({
          id:         randomUUID(),
          resourceId: body.resourceId,
          customer:   { id: customerEntity.id, fullName: customerEntity.fullName, email: customerEntity.email },
          startTime:  new Date(body.startTime),
          details:    body.details,
          ...(body.serviceId !== undefined && { serviceId: body.serviceId }),
          ...(body.endTime   !== undefined && { endTime: new Date(body.endTime) }),
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
        const existing = await requireOwnReservation(reservationId, customerId, reservationRepo, res, 'modificar');
        if (!existing) return;

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
        const reservation = await requireOwnReservation(reservationId, customerId, reservationRepo, res, 'cancelar');
        if (!reservation) return;

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

        // D-10 -- changedBy = el cliente autenticado dueño de la reserva
        // (ya verificado por requireOwnReservation() arriba); audit_log.changed_by
        // no tiene FK (identity_id libre, ver schema.sql BLOQUE 10) así que
        // un id de cliente es tan válido acá como un identity_id de staff.
        const cancelled = await reservationService.cancelReservation(reservationId, businessId, customerId);
        res.json(toReservationDto(cancelled));
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
