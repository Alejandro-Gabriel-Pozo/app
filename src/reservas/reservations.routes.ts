/**
 * @file reservations.routes.ts
 *
 * Permisos por endpoint:
 *
 * GET  /reservations                  — FRONT_DESK (OWNER, ADMIN, RECEPTIONIST)
 * POST /reservations/search           — FRONT_DESK (A7.2, 23/08/2026: `search`
 *      es PII, va en el body — reemplaza el `?search=` que tenía GET arriba)
 * GET  /reservations/:id              — FRONT_DESK
 * POST /reservations                  — BOOKING (empleados + CUSTOMER desde portal)
 * PUT  /reservations/:id              — FRONT_DESK
 * GET  /reservations/:id/price-preview            — FRONT_DESK
 * POST /reservations/:id/confirm-price-adjustment — MANAGEMENT (a propósito,
 *      no FRONT_DESK — separa "quien edita fechas" de "quien autoriza la
 *      plata", ver comentario en la ruta)
 * POST /reservations/:id/confirm      — FRONT_DESK
 * POST /reservations/:id/cancel       — FRONT_DESK
 * POST /reservations/:id/cancel-with-credit-note — EMISOR_NOTA_CREDITO
 *      (bloque 3.3-b2, ADR común cancelar-con-NC §6.6 — escape
 *      administrativo: cancela con Factura B viva emitiendo una NC)
 * GET  /reservations/:id/cancellation-refund/preview — FRONT_DESK (C2)
 * POST /reservations/:id/cancellation-refund/confirm — FRONT_DESK (C2,
 *      acción manual separada de /cancel -- ver CancellationRefundService)
 * POST /reservations/:id/complete     — FRONT_DESK
 * POST /reservations/:id/schedule-request         — BOOKING (empleados + CUSTOMER)
 * POST /reservations/:id/schedule-request/approve — FRONT_DESK
 * POST /reservations/:id/schedule-request/reject  — FRONT_DESK
 *
 * Los 3 endpoints de schedule-request (18/08/2026, pendientes-2026-08-18.md
 * punto N) están detrás de requireModule(ModuleKey.ALOJAMIENTO) — a
 * diferencia del resto de este router, que no está gateado por módulo
 * porque reservas la usan varios rubros (no solo alojamiento). Ver
 * buildStayService() más abajo.
 *
 * authenticate() fue removido de cada handler: app.ts lo aplica
 * globalmente sobre /api/* antes de tenantMiddleware. Tenerlo dos
 * veces causaba 401 UNAUTHORIZED porque el segundo intento re-leía
 * el header Authorization en un contexto donde req.user ya existía
 * pero el flujo bifurcaba.
 *
 * ## Transacciones (fix C1)
 * buildReservationService usa buildTenantTransactionManager(req) —
 * construido sobre el pool raw del TENANT, no el pool de plataforma.
 * Ver src/db/tenant-context.ts para el detalle.
 *
 * ## Validación (resource-locks, gestión + wiring)
 * POST y PUT antes NO validaban con Zod — hacían `...req.body` directo
 * hacia el service. Ahora usan CreateReservationSchema/UpdateReservationSchema
 * (src/api/schemas/request.schemas.ts), que ya existían pero nunca se
 * llamaban. De paso: `id` se genera server-side con randomUUID() en vez de
 * confiar en un `req.body.id` que ni siquiera estaba documentado — antes,
 * si el caller no lo mandaba, `new Reservation({id: undefined, ...})`
 * explotaba con un TypeError crudo (`undefined.trim()`) en vez de un 400 claro.
 *
 * ## Asignación diferida (auditoría de deuda estructural, item #4)
 * POST /reservations acepta `resourceId` (recurso puntual, flujo de
 * siempre) O `categoryId` (el servicio elige el primer recurso libre de
 * esa categoría vía ReservationService.findAvailableResourceInCategory).
 * Si no hay ninguno libre, responde 409 NO_RESOURCE_AVAILABLE en vez de
 * crear la reserva.
 *
 * ## Respuestas — toReservationDto (encontrado al construir detalle/edición)
 * Todos los handlers antes respondían con `res.json(reservation)` — el
 * objeto de dominio crudo. `Reservation.status` es un getter sobre el campo
 * privado `_status`; `JSON.stringify` de una clase NO serializa getters
 * (solo propiedades propias), así que el JSON real tenía `_status`, nunca
 * `status`. `customer` también viajaba como la instancia completa de
 * `Customer` (con `displayName`/`contactMethods`, sin `fullName`/`email`
 * planos — esos también son getters). El frontend esperaba `status` y
 * `customer.fullName`/`email` desde siempre; nunca los recibió. Ahora todas
 * las respuestas pasan por `toReservationDto()` (el mismo mapper que ya
 * usaba customer.routes.ts).
 */

import { Router }                        from 'express';
import type { Request, Response }        from 'express';
import type { ReservationFilters }       from './reservation.repository.js';
import { randomUUID }                    from 'node:crypto';
import type { ReservationStatus }        from '../types/enums.js';
import { authorize }                     from '../security/auth.middleware.js';
import { Roles }                         from '../security/roles.js';
import { requireModule }                 from '../security/module.middleware.js';
import { ModuleKey }                     from '../types/enums.js';
import type { AppContainer }             from '../container.js';
import { ReservationService }            from './reservation.service.js';
import type { ReservationCustomer }      from './reservation-customer.entities.js';
import { SqlReservationRepository }      from './sql.reservation.repository.js';
import { SqlResourceRepository }         from './sql.resource.repository.js';
import { SqlOccupancyRepository }        from './sql.occupancy.repository.js';
import { SqlCategoryRepository }         from './sql.category.repository.js';
import { SqlDomainEventRepository }      from '../repositories/sql.domain-event.repository.js';
import { SqlResourceLockRepository }     from './sql.resource-lock.repository.js';
import { SqlBookableServiceRepository }  from './sql.bookable-service.repository.js';
import { SqlCustomerRepository }         from '../clientes-finanzas/sql.customer.repository.js';
import { SqlCustomerRateRepository }     from '../clientes-finanzas/sql.customer-rate.repository.js';
import { SqlOperatingHoursRepository }   from '../platform/sql.operating-hours.repository.js';
import { SqlHousekeepingRepository }     from '../pms-estadias/housekeeping.repository.js';
import { SqlMaintenanceWindowRepository } from '../pms-estadias/sql.maintenance-window.repository.js';
import { SqlStayRepository }             from '../pms-estadias/stay.repository.js';
import { StayService }                   from '../pms-estadias/stay.service.js';
import { SqlFinancialTransactionRepository } from '../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlBusinessProfileRepository }  from '../repositories/sql.business-profile.repository.js';
import { SqlNumberSequenceRepository }   from '../repositories/sql.number-sequence.repository.js';
import { SqlDepositPolicyRepository }    from './sql.deposit-policy.repository.js';
import { SqlCancellationPolicyRepository } from './sql.cancellation-policy.repository.js';
import { CancellationRefundService }     from './cancellation-refund.service.js';
import { SqlInvoiceRepository }          from '../facturacion/sql.invoice.repository.js';
import { buildTenantTransactionManager } from '../db/tenant-context.js';
import { CreateReservationSchema, UpdateReservationSchema, SearchReservationsSchema, GetReservationsQuerySchema, CancelWithCreditNoteSchema } from '../api/schemas/request.schemas.js';
import { ZodError } from 'zod';
import { RequestScheduleChangeSchema, ApproveScheduleChangeSchema } from '../api/schemas/stay.schemas.js';
import { toReservationDto }              from '../api/mappers/reservation.mapper.js';
import { SqlAuditLogRepository }         from '../repositories/audit-log.repository.js';
import { buildInvoiceService }           from '../facturacion/invoices.routes.js';
import { CancelReservationWithCreditNoteService } from '../facturacion/cancel-reservation-with-credit-note.service.js';
import { ReservationCancelForCreditNote } from './reservation-cancel-for-credit-note.js';
import { authorizeCreditNoteCancellation } from '../facturacion/cancel-with-credit-note.js';
import {
  DomainError,
  ReservationNotFoundError,
  InvalidReservationError,
  CreditNoteReservationNoLiveInvoiceError,
  CreditNoteReservationMultiInvoiceError,
  CreditNoteMixedStayError,
  CreditNoteConsolidatedFullReversalError,
  CreditNoteReservationInvoiceSetChangedError,
  CreditNoteIssuedReservationNotCancellableError,
  CreditNoteCancellationPendingError,
  CreditNoteCancellationRejectedError,
  AfipRequestRejectedError,
  AfipNotConfiguredError,
} from '../domain/errors.js';
import { logger } from '../logger.js';

function buildReservationService(req: Request): ReservationService {
  const db                    = req.db;
  const resourceRepo          = new SqlResourceRepository(db);
  const reservationRepo       = new SqlReservationRepository(db, resourceRepo);
  const occupancyRepo         = new SqlOccupancyRepository(db);
  const categoryRepo          = new SqlCategoryRepository(db);
  const domainEventRepo       = new SqlDomainEventRepository(db);
  const resourceLockRepo      = new SqlResourceLockRepository(db);
  const bookableServiceRepo   = new SqlBookableServiceRepository(db);
  const customerRateRepo      = new SqlCustomerRateRepository(db);
  const operatingHoursRepo    = new SqlOperatingHoursRepository(db);
  const maintenanceWindowRepo = new SqlMaintenanceWindowRepository(db);
  const transactionManager    = buildTenantTransactionManager(req);
  const depositPolicyRepo     = new SqlDepositPolicyRepository(db);
  const businessProfileRepo   = new SqlBusinessProfileRepository(db);
  const financialTransactionRepo = new SqlFinancialTransactionRepository(db);
  const invoiceRepo           = new SqlInvoiceRepository(db);
  const numberSequenceRepo    = new SqlNumberSequenceRepository(db);
  return new ReservationService(
    reservationRepo,
    resourceRepo,
    occupancyRepo,
    categoryRepo,
    domainEventRepo,
    transactionManager,
    resourceLockRepo,
    bookableServiceRepo,
    customerRateRepo,
    operatingHoursRepo,
    maintenanceWindowRepo,
    depositPolicyRepo,
    businessProfileRepo,
    financialTransactionRepo,
    invoiceRepo,
    numberSequenceRepo,
  );
}

/**
 * C2 (23/08/2026, docs/diseno-cancelacion-notas-credito-c2-2026-08-23.md) —
 * separado de buildReservationService() a propósito: es un servicio propio,
 * no un método más de ReservationService.
 */
function buildCancellationRefundService(req: Request): CancellationRefundService {
  const db = req.db;
  return new CancellationRefundService(
    new SqlReservationRepository(db, new SqlResourceRepository(db)),
    new SqlCancellationPolicyRepository(db),
    new SqlFinancialTransactionRepository(db),
    new SqlInvoiceRepository(db),
    new SqlBusinessProfileRepository(db),
    buildTenantTransactionManager(req),
  );
}

/**
 * Composition root del orquestador del escape "cancelar con Nota de
 * Crédito" del lado reservas (bloque 3.3-b2, ADR común cancelar-con-NC
 * §6.6). Espejo de `buildCancelOrderWithCreditNoteService()`
 * (`pos-menu/orders.routes.ts`): reusa `buildInvoiceService()` de
 * `invoices.routes.ts` para el `InvoiceService` (gate `architecture-governor`
 * 09/09/2026, condición (a): reuso seguro -- `InvoiceService` ya es
 * reserva-consciente, y `facturacion/ -> pos-menu/` es la dirección
 * sancionada por `.dependency-cruiser.cjs`, no un hueco) y cablea el
 * adaptador de puerto `ReservationCancelForCreditNote`. Todo desde
 * `req.db!` (mismo pool de tenant -> misma transacción, `DEFENSIVE_DEVELOPING.md`
 * §3).
 */
function buildCancelReservationWithCreditNoteService(req: Request): CancelReservationWithCreditNoteService {
  const db = req.db!;
  const reservationRepo = new SqlReservationRepository(db, new SqlResourceRepository(db));
  return new CancelReservationWithCreditNoteService(
    buildInvoiceService(req),
    new SqlFinancialTransactionRepository(db),
    new SqlInvoiceRepository(db),
    reservationRepo,
    new ReservationCancelForCreditNote(
      reservationRepo,
      new SqlDomainEventRepository(db),
      new SqlAuditLogRepository(db),
    ),
    buildTenantTransactionManager(req),
  );
}

/**
 * StayService orquesta el flujo de horario de check-in/check-out (18/08/2026,
 * pendientes-2026-08-18.md punto N) — se monta acá (no en /api/stays) porque
 * los 3 endpoints nuevos toman un `reservationId`, no un `stayId`: un pedido
 * de horario puede hacerse ANTES del check-in (todavía no existe la Stay).
 */
function buildStayService(req: Request): StayService {
  const db              = req.db;
  const stayRepo         = new SqlStayRepository(db);
  const resourceRepo     = new SqlResourceRepository(db);
  const reservationRepo  = new SqlReservationRepository(db, resourceRepo);
  const housekeepingRepo = new SqlHousekeepingRepository(db);
  const financialRepo    = new SqlFinancialTransactionRepository(db);
  const businessProfileRepo = new SqlBusinessProfileRepository(db);
  return new StayService(stayRepo, reservationRepo, housekeepingRepo, financialRepo, businessProfileRepo);
}

/**
 * Arma la respuesta de GET /reservations y POST /reservations/search — con
 * page+limit el envelope paginado (PaginatedResponse<T>), sin ellos el
 * array plano de siempre (compatibilidad hacia atrás, K2). Un solo lugar
 * para las dos rutas: la única diferencia entre ellas es DE DÓNDE sale
 * `search` (query string vs. body, A7.2), no qué se hace con él.
 */
async function respondWithReservationsList(
  repo: SqlReservationRepository,
  filters: ReservationFilters,
  res: Response,
): Promise<void> {
  if (filters.page !== undefined && filters.limit !== undefined) {
    const { page, limit, ...countFilters } = filters;
    const [reservations, total] = await Promise.all([
      repo.getFiltered(filters),
      repo.countFiltered(countFilters),
    ]);
    res.json({
      data: reservations.map(toReservationDto),
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
    return;
  }
  const reservations = await repo.getFiltered(filters);
  res.json(reservations.map(toReservationDto));
}

export function createReservationsRouter(container: AppContainer): Router {
  const router = Router();

  // ── GET /reservations ──────────────────────────────────────────────────────
  // K2 (23/08/2026, pendientes-2026-08-23.md, SC16) — antes llamaba a
  // getAll() (deprecado), sin leer query params: siempre un SELECT sin
  // LIMIT sobre toda la tabla. `getFiltered`/`countFiltered` ya existían
  // implementados (sql.reservation.repository.ts), solo faltaba wirear la
  // ruta. Sin page/limit en la query, se mantiene el array plano de
  // siempre (compatibilidad hacia atrás) — con page/limit, devuelve el
  // envelope paginado que el frontend ya tipa (PaginatedResponse<T>,
  // lib/http.ts). `search` YA NO va acá — ver POST /reservations/search
  // (A7.2, 23/08/2026: era PII viajando en query string).
  router.get(
    '/',
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const resourceRepo = new SqlResourceRepository(req.db);
        const repo         = new SqlReservationRepository(req.db, resourceRepo);
        const { status, resourceId, customerId, from, to, isLodging, page, limit } = GetReservationsQuerySchema.parse(req.query);
        const filters = {
          ...(status     !== undefined && { status: status as ReservationStatus }),
          ...(resourceId !== undefined && { resourceId }),
          ...(customerId !== undefined && { customerId }),
          ...(from       !== undefined && { from: new Date(from) }),
          ...(to         !== undefined && { to:   new Date(to) }),
          ...(isLodging  !== undefined && { isLodging }),
          ...(page !== undefined && limit !== undefined && { page, limit }),
        };
        await respondWithReservationsList(repo, filters, res);
      } catch (err) {
        if (err instanceof ZodError) { res.status(400).json({ code: 'VALIDATION_ERROR', errors: err.errors }); return; }
        next(err);
      }
    },
  );

  // POST /reservations/search — { search } en el body, nunca en la URL
  // (A7.2: nombre/email tipeado por el usuario es PII). Reemplaza el
  // `?search=` que tenía GET /reservations hasta esta sesión (K2,
  // pendientes-2026-08-23.md).
  router.post(
    '/search',
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const body = SearchReservationsSchema.parse(req.body);
        const resourceRepo = new SqlResourceRepository(req.db);
        const repo         = new SqlReservationRepository(req.db, resourceRepo);
        const filters = {
          search: body.search,
          ...(body.status     !== undefined && { status: body.status as ReservationStatus }),
          ...(body.resourceId !== undefined && { resourceId: body.resourceId }),
          ...(body.customerId !== undefined && { customerId: body.customerId }),
          ...(body.from       !== undefined && { from: new Date(body.from) }),
          ...(body.to         !== undefined && { to:   new Date(body.to) }),
          ...(body.isLodging  !== undefined && { isLodging: body.isLodging }),
          ...(body.page !== undefined && body.limit !== undefined && { page: body.page, limit: body.limit }),
        };
        await respondWithReservationsList(repo, filters, res);
      } catch (err) { next(err); }
    },
  );

  // ── GET /reservations/:id ────────────────────────────────────────────────
  router.get(
    '/:id',
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const resourceRepo = new SqlResourceRepository(req.db);
        const repo         = new SqlReservationRepository(req.db, resourceRepo);
        const reservation  = await repo.getById(req.params['id']!);
        if (!reservation) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Reserva no encontrada' });
          return;
        }
        res.json(toReservationDto(reservation));
      } catch (err) { next(err); }
    },
  );

  // ── POST /reservations ─────────────────────────────────────────────────────
  router.post(
    '/',
    authorize(Roles.BOOKING),
    async (req, res, next) => {
      try {
        const body = CreateReservationSchema.parse(req.body);

        const customerEntity = await new SqlCustomerRepository(req.db).getById(body.customer.id);
        if (!customerEntity) {
          res.status(404).json({ code: 'CUSTOMER_NOT_FOUND', message: `Cliente con id "${body.customer.id}" no encontrado` });
          return;
        }
        // Reservas ya no depende de la clase Customer completa de
        // clientes-finanzas (Fase 7, D1) -- se proyecta acá, en el borde,
        // a la representación mínima que el dominio de reservas necesita.
        const customer: ReservationCustomer = {
          id:       customerEntity.id,
          fullName: customerEntity.fullName,
          email:    customerEntity.email,
        };

        const service = buildReservationService(req);

        // resourceId directo (flujo de siempre) o resuelto por categoría
        // (asignación diferida — ver findAvailableResourceInCategory).
        let resourceId = body.resourceId;
        if (!resourceId && body.categoryId) {
          const available = await service.findAvailableResourceInCategory({
            categoryId: body.categoryId,
            startTime:  new Date(body.startTime),
            ...(body.serviceId !== undefined && { serviceId: body.serviceId }),
            ...(body.endTime   !== undefined && { endTime: new Date(body.endTime) }),
          });
          if (!available) {
            res.status(409).json({
              code:    'NO_RESOURCE_AVAILABLE',
              message: `No hay ningún recurso disponible de la categoría "${body.categoryId}" en ese rango.`,
            });
            return;
          }
          resourceId = available.id;
        }

        const reservation = await service.createReservation({
          id:         randomUUID(),
          resourceId: resourceId!, // garantizado por el refine de CreateReservationSchema + el bloque anterior
          customer,
          startTime:  new Date(body.startTime),
          details:    body.details,
          ...(body.serviceId !== undefined && { serviceId: body.serviceId }),
          ...(body.endTime   !== undefined && { endTime: new Date(body.endTime) }),
          ...(body.adultos   !== undefined && { adultos: body.adultos }),
          ...(body.ninos     !== undefined && { ninos: body.ninos }),
          ...(body.ratePlanId !== undefined && { ratePlanId: body.ratePlanId }),
        });
        res.status(201).json(toReservationDto(reservation));
      } catch (err) { next(err); }
    },
  );

  // ── PUT /reservations/:id ────────────────────────────────────────────────
  router.put(
    '/:id',
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const body = UpdateReservationSchema.parse(req.body);
        const service = buildReservationService(req);
        const updated = await service.updateReservation(req.params['id']!, {
          ...(body.startTime  !== undefined && { startTime: new Date(body.startTime) }),
          ...(body.endTime    !== undefined && { endTime: new Date(body.endTime) }),
          ...(body.details    !== undefined && { details: body.details }),
          ...(body.resourceId !== undefined && { resourceId: body.resourceId }),
          ...(body.adultos    !== undefined && { adultos: body.adultos }),
          ...(body.ninos      !== undefined && { ninos: body.ninos }),
          ...(body.ratePlanId !== undefined && { ratePlanId: body.ratePlanId }),
        });
        res.json(toReservationDto(updated));
      } catch (err) { next(err); }
    },
  );

  // ── GET /reservations/:id/price-preview ─────────────────────────────────
  // 19/08/2026, pendientes-2026-08-18.md punto I — solo lectura, compara el
  // totalPrice congelado de una reserva CONFIRMED contra lo que costaría
  // hoy con sus fechas/recurso actuales. `null` si no aplica (no está
  // CONFIRMED, o no hay diferencia).
  router.get(
    '/:id/price-preview',
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const service = buildReservationService(req);
        const preview = await service.previewPriceAdjustment(req.params['id']!);
        res.json(preview);
      } catch (err) { next(err); }
    },
  );

  // ── POST /reservations/:id/confirm-price-adjustment ─────────────────────
  // Aplica el ajuste que price-preview mostró — nunca automático, siempre
  // a pedido explícito de un empleado (decisión del dueño, mismo punto I).
  // Roles.MANAGEMENT a propósito, NO FRONT_DESK como el resto de este
  // router: PUT /:id (el que edita las fechas que generan el ajuste) sí es
  // FRONT_DESK — si esta ruta también lo fuera, la misma persona podría
  // editar Y autorizar el cargo/nota de crédito resultante con dos clicks
  // seguidos, sin una segunda mirada real. Separar el rol es lo que hace
  // que "revisión manual" sea una revisión de verdad.
  router.post(
    '/:id/confirm-price-adjustment',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const service     = buildReservationService(req);
        const reservation = await service.confirmPriceAdjustment(
          req.params['id']!,
          req.user!.businessId as string,
          req.user!.id,
        );
        res.json(toReservationDto(reservation));
      } catch (err) { next(err); }
    },
  );

  // ── POST /reservations/:id/confirm ──────────────────────────────────────
  router.post(
    '/:id/confirm',
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const service     = buildReservationService(req);
        const reservation = await service.confirmReservation(
          req.params['id']!,
          req.user!.businessId as string,
        );
        res.json(toReservationDto(reservation));
      } catch (err) { next(err); }
    },
  );

  // ── POST /reservations/:id/cancel ───────────────────────────────────────
  router.post(
    '/:id/cancel',
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const service     = buildReservationService(req);
        const reservation = await service.cancelReservation(
          req.params['id']!,
          req.user!.businessId as string,
        );
        res.json(toReservationDto(reservation));
      } catch (err) { next(err); }
    },
  );

  // ── POST /reservations/:id/cancel-with-credit-note ──────────────────────
  // ADR común cancelar-con-NC (bloque 3.3-b2, §6.6). Escape administrativo:
  // cancela una reserva con Factura B viva EMITIENDO una Nota de Crédito.
  // `authorize` con el grupo dedicado `EMISOR_NOTA_CREDITO` (no `FRONT_DESK`
  // -- capa i de la contención del ADR §4). 2do caller de
  // `authorizeCreditNoteCancellation()` (el 1ro es el escape de órdenes):
  // `confirmedBy` sale del JWT verificado server-side, NUNCA del body (A2.2).
  //
  // Validación con `safeParse` + `{path,message}[]`, NO `.parse()`/`ZodError`
  // como el resto de este archivo -- desvío DELIBERADO: los dos escapes
  // (órdenes y reservas) comparten `CancelWithCreditNoteSchema` y el mismo
  // flujo de frontend, así que responden con la misma forma de error. Mismo
  // criterio que `orders.routes.ts:316-358` (`buildCancelOrderWithCreditNoteService`).
  //
  // `res.json({ reservation: toReservationDto(...), ... })`, NUNCA
  // `res.json(result)` a secas -- `Reservation.status`/`customer`/`resource`
  // son getters (docblock de este archivo, líneas 62-73); serializar la
  // instancia cruda perdería `status` (quedaría `_status`) igual que el bug
  // que motivó `toReservationDto()` en primer lugar.
  router.post(
    '/:id/cancel-with-credit-note',
    authorize(Roles.EMISOR_NOTA_CREDITO),
    async (req: Request, res: Response, next) => {
      const parsed = CancelWithCreditNoteSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          code: 'VALIDATION_ERROR',
          errors: parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
        });
        return;
      }
      const reservationId = req.params['id']!;
      try {
        const auth = authorizeCreditNoteCancellation({
          confirmedBy: req.user!.id,
          reason: parsed.data.reason,
          scope: { kind: 'RESERVATION', reservationId },
        });
        const result = await buildCancelReservationWithCreditNoteService(req).cancelReservationWithCreditNote(reservationId, auth);
        res.json({
          reservation: toReservationDto(result.reservation),
          creditNote: result.creditNote,
          adjustmentId: result.adjustmentId,
          originalInvoiceId: result.originalInvoiceId,
          emitted: result.emitted,
        });
      } catch (err) {
        // MID-LOG-001 -- este handler resuelve el error inline con
        // `res.status().json()` y NO pasa por `error.middleware.ts`, así que
        // la política de logging de DomainError se aplica acá (mismo
        // criterio que `orders.routes.ts`). Endpoint de bajo volumen
        // (`EMISOR_NOTA_CREDITO`): se loguea todo fallo. Sin `err.message`
        // (trae ids/montos, A7.1) -- `reservationId` ya lo tenemos.
        if (err instanceof DomainError) {
          logger.warn(
            { code: err.code, reservationId, businessId: req.user?.businessId ?? null },
            '[reservations] cancel-with-credit-note fallo',
          );
        }
        if (err instanceof ReservationNotFoundError) res.status(404).json({ code: 'RESERVATION_NOT_FOUND', message: err.message });
        // InvalidReservationError inline -> 409 (transición inválida /
        // invariante rota, ambas PRE-AFIP -- nada pasó). Diverge del 400
        // genérico de `error.middleware.ts` (`INVALID_RESERVATION`, "request
        // mal armado") a propósito: acá el código es el mismo pero el
        // contexto (estado de la reserva, no forma del body) pide 409,
        // gate `architecture-governor` 09/09/2026.
        else if (err instanceof InvalidReservationError) res.status(409).json({ code: 'INVALID_RESERVATION', message: err.message });
        else if (err instanceof CreditNoteReservationNoLiveInvoiceError) res.status(409).json({ code: err.code, message: err.message });
        else if (err instanceof CreditNoteReservationMultiInvoiceError) res.status(409).json({ code: err.code, message: err.message });
        else if (err instanceof CreditNoteMixedStayError) res.status(409).json({ code: err.code, message: err.message });
        else if (err instanceof CreditNoteConsolidatedFullReversalError) res.status(409).json({ code: err.code, message: err.message });
        else if (err instanceof CreditNoteIssuedReservationNotCancellableError) res.status(422).json({ code: err.code, message: err.message });
        else if (err instanceof CreditNoteReservationInvoiceSetChangedError) res.status(422).json({ code: err.code, message: err.message });
        else if (err instanceof CreditNoteCancellationPendingError) res.status(422).json({ code: err.code, message: err.message });
        else if (err instanceof AfipRequestRejectedError) res.status(409).json({ code: err.code, message: err.message });
        else if (err instanceof CreditNoteCancellationRejectedError) res.status(409).json({ code: err.code, message: err.message });
        // AFIP_NOT_CONFIGURED -- 422 acá, 503 en error.middleware.ts. Misma
        // divergencia deliberada que orders.routes.ts (declarada, no
        // corregida -- gate `architecture-governor` 09/09/2026): mantiene
        // los dos escapes simétricos entre sí.
        else if (err instanceof AfipNotConfiguredError) res.status(422).json({ code: err.code, message: err.message });
        else if (err instanceof DomainError) res.status(409).json({ code: err.code, message: err.message });
        else next(err);
      }
    },
  );

  // ── GET /reservations/:id/cancellation-refund/preview ───────────────────
  // C2 -- no persiste nada, mismo criterio que GET .../price-preview.
  router.get(
    '/:id/cancellation-refund/preview',
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const service = buildCancellationRefundService(req);
        const preview = await service.previewRefund(
          req.params['id']!,
          req.user!.businessId as string,
        );
        res.json(preview);
      } catch (err) { next(err); }
    },
  );

  // ── POST /reservations/:id/cancellation-refund/confirm ──────────────────
  // C2 -- acción manual separada de /cancel (mismo criterio que
  // confirm-price-adjustment): crea la(s) fila(s) REFUND en el ledger, no
  // emite la Nota de Crédito acá (ver docblock de CancellationRefundService).
  router.post(
    '/:id/cancellation-refund/confirm',
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const service = buildCancellationRefundService(req);
        const refunds = await service.confirmRefund(
          req.params['id']!,
          req.user!.businessId as string,
          req.user!.id,
        );
        res.status(201).json(refunds);
      } catch (err) { next(err); }
    },
  );

  // ── POST /reservations/:id/complete ─────────────────────────────────────
  router.post(
    '/:id/complete',
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const service     = buildReservationService(req);
        const reservation = await service.completeReservation(
          req.params['id']!,
          req.user!.businessId as string,
        );
        res.json(toReservationDto(reservation));
      } catch (err) { next(err); }
    },
  );

  // ── POST /reservations/:id/schedule-request ─────────────────────────────
  // Roles.BOOKING (empleados + CUSTOMER desde portal, mismo criterio que
  // POST /reservations) — el pedido de horario lo puede iniciar el huésped.
  router.post(
    '/:id/schedule-request',
    authorize(Roles.BOOKING),
    requireModule(container, ModuleKey.ALOJAMIENTO),
    async (req, res, next) => {
      try {
        const body = RequestScheduleChangeSchema.parse(req.body);
        const stayService = buildStayService(req);
        const reservation = await stayService.requestScheduleChange({
          reservationId: req.params['id']!,
          ...(body.requestedCheckInTime  !== undefined && { requestedCheckInTime: body.requestedCheckInTime }),
          ...(body.requestedCheckOutTime !== undefined && { requestedCheckOutTime: body.requestedCheckOutTime }),
        });
        res.json(toReservationDto(reservation));
      } catch (err) { next(err); }
    },
  );

  // ── POST /reservations/:id/schedule-request/approve ─────────────────────
  router.post(
    '/:id/schedule-request/approve',
    authorize(Roles.FRONT_DESK),
    requireModule(container, ModuleKey.ALOJAMIENTO),
    async (req, res, next) => {
      try {
        const body = ApproveScheduleChangeSchema.parse(req.body);
        const stayService = buildStayService(req);
        const reservation = await stayService.approveScheduleChange({
          reservationId: req.params['id']!,
          businessId:    req.user!.businessId as string,
          approvedBy:    req.user!.id,
          ...(body.chargeAmount !== undefined && { chargeAmount: body.chargeAmount }),
        });
        res.json(toReservationDto(reservation));
      } catch (err) { next(err); }
    },
  );

  // ── POST /reservations/:id/schedule-request/reject ──────────────────────
  router.post(
    '/:id/schedule-request/reject',
    authorize(Roles.FRONT_DESK),
    requireModule(container, ModuleKey.ALOJAMIENTO),
    async (req, res, next) => {
      try {
        const stayService = buildStayService(req);
        const reservation = await stayService.rejectScheduleChange(
          req.params['id']!,
          req.user!.id,
        );
        res.json(toReservationDto(reservation));
      } catch (err) { next(err); }
    },
  );

  return router;
}
