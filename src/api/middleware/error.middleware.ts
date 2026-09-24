/**
 * @file error.middleware.ts
 * @description Handler global de errores de Express.
 *
 * ## Orden de evaluación
 * 1. ZodError              → 400 VALIDATION_ERROR
 * 2. ValidationError       → 400 + issues mapeados
 * 3. DomainError           → status según domainErrorStatus()
 * 4. Cualquier otro error  → 500 INTERNAL_ERROR
 *
 * ## Notas sobre 402 y 503
 * PlanLimitError y los errores de plataforma se capturan localmente
 * en cada router (categories.routes.ts, etc.) antes de llegar aquí.
 * Los casos en domainErrorStatus() son una red de seguridad para si
 * algún router olvida capturarlos y los propaga con next(err).
 *
 * ## Códigos sin mapeo explícito
 * Si aparece un DomainError.code nuevo sin case en el switch, se loguea
 * y se devuelve 500. Agregar el case correspondiente en domainErrorStatus.
 */

import type { Request, Response, NextFunction } from 'express';
import { ZodError }                        from 'zod';
import type { DomainIssue } from '../../domain/errors.js';
import { DomainError, ValidationError } from '../../domain/errors.js';
import { logger } from '../../logger.js';

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      code:    'VALIDATION_ERROR',
      message: 'Datos de entrada inválidos',
      errors:  err.flatten(),
    });
    return;
  }

  if (err instanceof ValidationError) {
    const errors = err.issues
      ? new ZodError(
          err.issues.map((issue: DomainIssue) => ({
            ...issue,
            code:    'custom' as const,
            params:  {},
          }))
        ).flatten()
      : {};

    res.status(400).json({
      code:    err.code,
      message: err.message,
      errors,
    });
    return;
  }

  if (err instanceof DomainError) {
    const status = domainErrorStatus(err);
    // MID-LOG-001 (08/09/2026, plan-cierre-cancelacion-nc-y-deuda-estructural
    // bloque 0.2) -- política declarada de logging de `DomainError`.
    //
    // Se loguea SÓLO lo que mapea a >= 409: carreras (409), violaciones de
    // regla de negocio (422), dependencia externa caída (503), y un `code`
    // sin mapeo (500, vía `default:` de abajo). Los 4xx de cliente rutinario
    // (400 validación / 401 / 404 no-encontrado) NO se loguean -- son ruido
    // de alto volumen que ahoga la señal.
    //
    // EXCLUSIONES DELIBERADAS, no accidentes del umbral numérico:
    //  - 403 (`FORBIDDEN`, `FISCAL_PROFILE_LOCKED`): los eventos de autorización
    //    van a `audit_log`, no a este canal.
    //  - 402 (`PLAN_LIMIT_REACHED`, `ROLE_NOT_AVAILABLE_IN_PLAN`, ...): se
    //    capturan localmente en los routers y son señal de upsell, no de bug.
    //
    // NUNCA `err.message`: los mensajes de dominio traen ids de cliente,
    // montos y razones sociales (A7.1). Se loguea `code` + `status` + método
    // + PATH (sin query string -- A7.2: `GET /api/customers` todavía recibe
    // `email`/`name` por query, deuda pre-existente; el path solo lleva el id
    // de recurso, que no es PII) + tenant. Mismo criterio que la línea
    // anterior de `REFUND_BASE_CHANGED`, que logueaba sólo `{ code }`.
    //
    // LIMITACIÓN (actualizada 09/09/2026 -- las dos rutas de escape con
    // Nota de Crédito, órdenes y reservas, YA delegan acá vía `next(err)`):
    // sigue habiendo rutas puntuales que resuelven un error inline con
    // `res.status().json()` sin pasar por acá -- p. ej. la única excepción
    // declarada de `reservations.routes.ts` (`InvalidReservationError` en
    // el escape, que necesita un status distinto del mapeo global de este
    // archivo y loguea por su cuenta). No hay una cerca que barra el repo
    // buscando ese patrón; verificado a mano el 09/09/2026 que ningún otro
    // `*.routes.ts` lo tiene.
    if (status >= 409) {
      logger.warn(
        {
          code: err.code,
          status,
          method: req.method,
          url: req.originalUrl.split('?')[0],
          businessId: req.user?.businessId ?? null,
        },
        '[errorHandler] DomainError',
      );
    }
    res.status(status).json({
      code:    err.code,
      message: err.message,
    });
    return;
  }

  // Error genérico no tipado — loguear siempre para detectar fugas
  logger.error({ err }, '[errorHandler] Error no manejado');
  res.status(500).json({
    code:    'INTERNAL_ERROR',
    message: 'Error interno del servidor',
  });
}

function domainErrorStatus(error: DomainError): number {
  switch (error.code) {

    // --- 400 Bad Request ---
    // INSUFFICIENT_STOCK (product.service.ts) no tenía case acá -- caía al
    // 500 genérico salvo que el router la capturara localmente (como ya
    // hacía orders.routes.ts). La agrega el endpoint de merma (Fase 2,
    // 17/08/2026, docs/diseno-inventario-carve-out.md) porque también la
    // lanza; de paso cierra el mismo hueco en /:id/stock/decrement, que no
    // la capturaba localmente y dependía de esta red de seguridad.
    //
    // INVALID_STOCK_MOVEMENT (27/08/2026, A6.1 -- STOCK_MOVEMENT_RULES en
    // repositories/stock-movement.repository.ts): el movimiento no respeta
    // las reglas declaradas para su propio tipo (ubicación, motivo de merma,
    // notas). Es un request mal armado, no una regla de negocio que dependa
    // del estado -- mismo criterio que INVALID_RESERVATION.
    case 'INVALID_RESERVATION':
    case 'INVALID_CUSTOMER':
    case 'INVALID_RESOURCE':
    case 'UNSUPPORTED_RESOURCE_TYPE':
    case 'VALIDATION_ERROR':
    case 'INSUFFICIENT_STOCK':
    case 'PRODUCT_NOT_COMPOSITE':
    case 'RECIPE_CYCLE':
    case 'RECIPE_NOT_DEFINED':
    case 'BUSINESS_NOT_IN_COMPANY':
    case 'RATE_PLAN_NOT_AVAILABLE':
    case 'INVALID_RATE_PLAN_VALIDITY':
    case 'INVALID_MAINTENANCE_WINDOW_DATES':
    case 'INVALID_STOCK_MOVEMENT':
      return 400;

    // --- 422 Unprocessable Entity ---
    // El request es válido pero viola una regla de negocio (mismo criterio
    // que INVALID_CATEGORY en resources.routes.ts). AFIP_REQUEST_REJECTED:
    // el request llegó bien formado, pero AFIP rechazó el comprobante por
    // una regla de negocio suya — mismo criterio.
    // LODGING_REQUIRES_SERVICE (27/08/2026, docs/diseno-precio-servicio-vs-
    // recurso-2026-08-27.md): el request está bien formado -- `serviceId` es
    // opcional en el esquema porque un turno o una mesa legítimamente no lo
    // llevan. Lo que se viola es una regla de negocio: en una categoría de
    // ALOJAMIENTO el precio vive en el servicio, así que la reserva tiene
    // que declarar cuál. Mismo criterio que COMPANY_CUSTOMER_REQUIRED.
    //
    // ADR común cancelar-con-NC (sub-bloque 4) -- CREDIT_NOTE_CANCELLATION_PENDING
    // y CREDIT_NOTE_ISSUED_ORDER_NOT_CANCELLABLE: el escape los resuelve inline
    // en `orders.routes.ts` y no llegan acá por el camino normal; se mapean
    // igual (red de seguridad + para un futuro caller que haga `next(err)`,
    // ej. una ruta de reservas). Mismo 422 que la ruta = "quedó pendiente / no
    // cancelable, revisión manual" (D1).
    //
    // Bloque 3.3-b2 (09/09/2026, gate `architecture-governor`) -- los mismos
    // dos casos, lado reservas. `CREDIT_NOTE_RESERVATION_INVOICE_SET_CHANGED`:
    // ventana tx1->tx2, la NC se emitió pero la reserva no se pudo cancelar
    // porque el conjunto de facturas vivas cambió. `CREDIT_NOTE_ISSUED_RESERVATION_NOT_CANCELLABLE`:
    // la NC se emitió pero la reserva cambió a un estado terminal
    // (COMPLETED/EXPIRED) antes de tx2. Las cuatro son "documento fiscal ya
    // emitido o pendiente, acción no completó, no reintentar" -- 422, nunca
    // 400/409. El comentario va acá arriba, no entre los case: un case con
    // cuerpo solo-comentario deja de contar como vacío y eslint
    // (no-fallthrough) pide un break (ver el bloque 402 más abajo).
    //
    // Bloque 6, §9.1 (13/09/2026) -- STAY_CHARGE_ALREADY_INVOICED entra al
    // mismo grupo: documento fiscal ya emitido, acción no completa, no
    // reintentar.
    // Bloque 3c-ii (14/09/2026, gate architecture-governor, Finding B) --
    // AR_REVERSAL_REQUIRES_CREDIT_NOTE entra acá, mismo grupo semántico
    // que sus hermanos CREDIT_NOTE_* -- literalmente redirige al circuito
    // de Nota de Crédito. Los otros 3 códigos nuevos de reverseTransfer()
    // NO entran acá -- van al grupo 409 de más abajo, son precondición de
    // estado del recurso, no documento fiscal en juego.
    //
    // M3 (14/09/2026) -- `CREDIT_NOTE_ORDER_INVOICE_SET_CHANGED`: espejo
    // exacto de `CREDIT_NOTE_RESERVATION_INVOICE_SET_CHANGED` del lado
    // órdenes (mismo hallazgo, mismo guard, mismo grupo semántico -- la NC
    // ya se emitió pero la orden no se pudo cancelar porque el conjunto de
    // facturas vivas cambió entre tx1 y tx2).
    // ADR `ISSUE-BEFORE-REVERSE-WINDOW-001` (23/09/2026), Bloque 3, §3.14
    // (P-1) -- `AFIP_VOUCHER_NOT_FOUND`/`AFIP_VOUCHER_MISMATCH`: el request
    // llegó bien formado (POST /api/invoices/:id/reconcile-with-afip con un
    // cbteNro real), pero lo que afirma no está respaldado por AFIP (no se
    // encontró, o no es consistente con esta factura) -- mismo grupo que
    // AFIP_REQUEST_REJECTED.
    case 'COMPANY_CUSTOMER_REQUIRED':
    case 'LODGING_REQUIRES_SERVICE':
    case 'AFIP_REQUEST_REJECTED':
    case 'AFIP_VOUCHER_NOT_FOUND':
    case 'AFIP_VOUCHER_MISMATCH':
    case 'UNSUPPORTED_IVA_RATE':
    case 'CREDIT_NOTE_CANCELLATION_PENDING':
    case 'CREDIT_NOTE_ISSUED_ORDER_NOT_CANCELLABLE':
    case 'CREDIT_NOTE_ORDER_INVOICE_SET_CHANGED':
    case 'CREDIT_NOTE_RESERVATION_INVOICE_SET_CHANGED':
    case 'CREDIT_NOTE_ISSUED_RESERVATION_NOT_CANCELLABLE':
    case 'STAY_CHARGE_ALREADY_INVOICED':
    case 'AR_REVERSAL_REQUIRES_CREDIT_NOTE':
      return 422;

    // --- 401 Unauthorized ---
    case 'AUTH_ERROR':
    case 'UNAUTHORIZED':
      return 401;

    // --- 402 Payment Required ---
    // Red de seguridad: PlanLimitError se captura localmente en los routers.
    // Si por algún motivo llega aquí, devolvemos 402 igual. Mismo criterio
    // para ROLE_NOT_AVAILABLE_IN_PLAN (17/08/2026, F2) -- el problema no es
    // un número agotado sino una capacidad no incluida en el plan, pero la
    // semántica HTTP y el mensaje ("actualizá tu plan") son los mismos.
    // PERMISSION_GROUP_NOT_AVAILABLE_IN_PLAN (L, 23/08/2026) -- mismo
    // criterio: techo de permisos de un rol CUSTOM por plan, capacidad no
    // incluida, no un número agotado.
    //
    // Los tres case comparten cuerpo a propósito. El comentario va acá
    // arriba y no entre los case porque un case cuyo "cuerpo" es solo un
    // comentario deja de contar como vacío para no-fallthrough y la regla
    // lo reporta como si faltara un break (eslint, allowEmptyCase: false).
    case 'PLAN_LIMIT_REACHED':
    case 'ROLE_NOT_AVAILABLE_IN_PLAN':
    case 'PERMISSION_GROUP_NOT_AVAILABLE_IN_PLAN':
      return 402;

    // --- 403 Forbidden ---
    // FISCAL_PROFILE_LOCKED (D3, pendientes-2026-08-19.md): el request es
    // válido y el rol tiene MANAGEMENT, pero no OWNER_ONLY -- mismo criterio
    // semántico que FORBIDDEN, code propio para que el frontend distinga
    // "no tenés este permiso en general" de "esto puntual quedó bloqueado".
    // D-05/P-03 §3.2, condición 1 del gate (24/09/2026, Wave 15) --
    // COMPANY_LINK_REQUEST_NOT_ELIGIBLE_APPROVER: el guard de pertenencia
    // de assertEligibleApprover() (companies.routes.ts) -- el actor tiene
    // Roles.MANAGEMENT, pero no del negocio que ya está vinculado a la
    // company destino. Mismo grupo semántico que FORBIDDEN -- rol
    // correcto, recurso equivocado. El comentario va acá arriba, no entre
    // los case (no-fallthrough, ver bloque 402 de este archivo).
    case 'FORBIDDEN':
    case 'FISCAL_PROFILE_LOCKED':
    case 'COMPANY_LINK_REQUEST_NOT_ELIGIBLE_APPROVER':
      return 403;

    // --- 404 Not Found ---
    // CREDIT_NOTE_REQUEST_NOT_FOUND (Bloque 5 del ADR común cancelar-con-NC,
    // 15/09/2026, §6.5 bis) -- GET /api/credit-note-requests/:id sin fila
    // real, mismo grupo que el resto de *_NOT_FOUND de acá abajo.
    case 'RESOURCE_NOT_FOUND':
    case 'RESERVATION_NOT_FOUND':
    case 'CATEGORY_NOT_FOUND':
    case 'ORDER_NOT_FOUND':
    case 'BOOKABLE_SERVICE_NOT_FOUND':
    case 'SERVICE_SCHEDULE_NOT_FOUND':
    case 'HOUSEKEEPING_TASK_NOT_FOUND':
    case 'STAY_NOT_FOUND':
    case 'CUSTOMER_RATE_NOT_FOUND':
    case 'CUSTOMER_NOT_FOUND':
    case 'WASTE_REASON_NOT_FOUND':
    case 'CONSUMPTION_DESTINATION_NOT_FOUND':
    case 'SERVICE_ITEM_NOT_FOUND':
    case 'CANCELLATION_POLICY_NOT_FOUND':
    case 'RECIPE_ITEM_NOT_FOUND':
    case 'PRODUCT_NOT_SHARED':
    case 'COMPANY_PRODUCT_NOT_FOUND':
    case 'RATE_PLAN_NOT_FOUND':
    case 'FINANCIAL_TRANSACTION_NOT_FOUND':
    case 'INVOICE_NOT_FOUND':
    case 'RATE_CATALOG_ENTRY_NOT_FOUND':
    case 'ACCOUNT_RECEIVABLE_NOT_FOUND':
    case 'MAINTENANCE_WINDOW_NOT_FOUND':
    // D-05/P-03 (24/09/2026, Wave 15) -- COMPANY_LINK_REQUEST_NOT_FOUND
    // entra al mismo grupo: GET/POST sobre un id de company_link_requests
    // que no existe. El comentario va acá arriba, no entre los case
    // (no-fallthrough, ver bloque 402 de este archivo).
    case 'CREDIT_NOTE_REQUEST_NOT_FOUND':
    case 'COMPANY_LINK_REQUEST_NOT_FOUND':
      return 404;

    // --- 409 Conflict ---
    // AFIP_REQUEST_UNCERTAIN: no es "no encontrado" ni "mal pedido" — es un
    // estado de conflicto real (no se sabe si AFIP ya lo procesó), A8.6.
    // ORDER_STATE_UNKNOWN (order.service.ts, ORDER-04): `orders.status` fuera
    // del enum; se resuelve inline como 409 en `orders.routes.ts` (4 sitios),
    // acá caía al `default:` → 500. Red de seguridad para un `next(err)` futuro.
    //
    // ADR común cancelar-con-NC (sub-bloque 4) -- CREDIT_NOTE_CANCELLATION_REJECTED
    // (AFIP rechazó), CREDIT_NOTE_MULTI_INVOICE (la NC abarcaría >1 factura),
    // ORDER_INVOICE_HAS_NO_LINES (la factura origen no tiene líneas): el escape
    // los resuelve inline en `orders.routes.ts` y no llegan acá por el camino
    // normal; se mapean igual (red de seguridad + futuro caller con `next(err)`).
    // Mismo 409 que la ruta.
    //
    // Bloque 3.3-b2 (09/09/2026, gate `architecture-governor`) --
    // CREDIT_NOTE_RESERVATION_NO_LIVE_INVOICE/_MULTI_INVOICE/MIXED_STAY/
    // CONSOLIDATED_FULL_REVERSAL: escape de reservas, misma familia que
    // CREDIT_NOTE_MULTI_INVOICE arriba -- el request está bien formado, pero
    // el estado real de la reserva no admite ESTE escape puntual (sin
    // factura viva -> usá la cancelación normal; >1 factura viva -> pool
    // mixto sin pedirlo, fail-closed; stay_id mixto o borde de consolidada
    // al 100% -> el ADJUSTMENT no se puede atribuir sin ambigüedad). Ninguno
    // llamó a AFIP todavía. El comentario va acá arriba, no entre los case
    // (no-fallthrough, ver bloque 402).
    //
    // Bloque 1 de `credit_note_request` (repositorio + entidades, schema v57,
    // sin wiring en ningún orquestador todavía) -- CREDIT_NOTE_REQUEST_INVALID_TRANSITION
    // (ver el case junto a CREDIT_NOTE_AMBIGUOUS_SUBJECT más abajo): transición
    // inválida de la máquina de estados propia del workflow (A6.3). Mismo
    // grupo semántico que INVALID_TRANSITION de más arriba: request bien
    // formado, el estado actual del recurso no admite la operación.
    //
    // ADR `ISSUE-BEFORE-REVERSE-WINDOW-001` (23/09/2026), Bloque 3, §3.9/§3.14
    // -- precondición de estado que ya cambió (no regla de negocio violada),
    // mismo grupo semántico que `CREDIT_NOTE_REQUEST_INVALID_TRANSITION` de
    // acá abajo: `INVOICE_ALREADY_ISSUED`/`INVOICE_MANUAL_RESOLUTION_PRECONDITION_FAILED`
    // (A-2), `INVOICE_UNCERTAIN_CLEAR_PRECONDITION_FAILED` (N6),
    // `INVOICE_HAS_OPEN_CREDIT_NOTE_REQUEST` (N-1),
    // `CREDIT_NOTE_REQUEST_NOT_IN_MANUAL_REVIEW` (P-2),
    // `INVOICE_RESOLUTION_CAE_MISMATCH`/`INVOICE_RESOLUTION_STATE_CONFLICT`
    // (decisiones 1/2 del dueño), `INVOICE_VOUCHER_NUMBER_ALREADY_REGISTERED`
    // (gap 4(c)), `AFIP_RECONCILIATION_PRECONDITION_FAILED` ("AFIP prevalece").
    //
    // Bloque 2c (23/09/2026, gate `architecture-governor`, ronda 15-bis, §3.2/
    // §3.16) -- RETRY_INVOICE_IN_FLIGHT: la toma exclusiva de retryExisting()
    // no encontró la factura en un estado reintentable (doble click, o ya no
    // reintentable por otro motivo) -- mismo grupo semántico, precondición de
    // estado que ya cambió, no regla de negocio violada.
    // Deliberadamente SIN mapeo (caen al 500 genérico, honest-degradation):
    // `INVOICE_RECONCILIATION_UNEXPECTED_STATE`/`INVOICE_ISSUED_COMPROBANTE_MISMATCH`
    // -- invariante roto real, ningún 4xx describe algo que el cliente pueda
    // "corregir" reintentando (ver sus propios docblocks en domain/errors.ts).
    // El comentario va acá arriba, no entre los case (no-fallthrough, ver
    // bloque 402 de este archivo).
    //
    // D-05/P-03 (24/09/2026, Wave 15) -- las tres precondiciones de estado
    // de `company_link_requests` (companies.routes.ts, más abajo en este
    // mismo grupo): ALREADY_PENDING (índice único parcial,
    // R6-equivalente) e INVALID_TRANSITION (mismo grupo semántico que
    // CREDIT_NOTE_REQUEST_INVALID_TRANSITION, arriba) son precondición de
    // estado del recurso, request bien formado. HAS_NO_ELIGIBLE_APPROVER
    // (condición 2 del gate, caso borde bootstrap) entra al mismo grupo
    // por sugerencia explícita del gate de diseño: no es que el actor no
    // tenga permiso (eso es 403, ver COMPANY_LINK_REQUEST_NOT_ELIGIBLE_APPROVER
    // más arriba) -- es que la operación no puede completarse todavía dado
    // el estado real de la empresa destino (cero negocios vinculados),
    // reintentable una vez que alguien la resuelva (alta manual del
    // primer negocio).
    case 'INVALID_RESERVATION_CONFLICT':
    case 'ORDER_NOT_EDITABLE':
    case 'INVALID_TRANSITION':
    case 'ORDER_STATE_UNKNOWN':
    case 'SCHEDULE_CONFLICT':
    case 'RESERVATION_NOT_CONFIRMED':
    case 'RESOURCE_OCCUPIED':
    case 'RESOURCE_NOT_READY_FOR_CHECKIN':
    case 'CUSTOMER_RATE_CONFLICT':
    // Wave 12 (18/09/2026, gate architecture-governor, §7.2(b)) -- ACCOUNTS_RECEIVABLE_REVERSED_CANNOT_INVOICE
    // entra al mismo grupo que ACCOUNTS_RECEIVABLE_ALREADY_INVOICED de acá abajo: precondición de estado del
    // recurso (AR ya revertida) no cumplida, request bien formado. Guard-espejo de los 3 AR_REVERSAL_* de acá
    // abajo (esos rechazan revertir con comprobante vivo; este rechaza facturar con cargo revertido).
    //
    // Bloque 3c-ii (14/09/2026, gate architecture-governor, Finding B) --
    // los 3 códigos de reverseTransfer() que NO son "documento fiscal ya
    // emitido" (ver AR_REVERSAL_REQUIRES_CREDIT_NOTE, grupo 422 más
    // arriba) son precondición de estado del recurso no cumplida --mismo
    // grupo que ACCOUNTS_RECEIVABLE_ALREADY_INVOICED/AR_INVOICE_NOT_ISSUED,
    // el precedente más cercano por ser del mismo dominio AR. El comentario
    // va acá arriba, no entre los case (no-fallthrough, ver bloque 402).
    case 'NO_BALANCE_TO_TRANSFER':
    case 'STAY_BALANCE_OWED':
    case 'ACCOUNTS_RECEIVABLE_ALREADY_INVOICED':
    case 'ACCOUNTS_RECEIVABLE_REVERSED_CANNOT_INVOICE':
    case 'AR_REVERSAL_MISSING_GUEST_LINK':
    case 'AR_REVERSAL_MISSING_COMPANY_LINK':
    case 'AR_REVERSAL_CHARGE_NOT_SETTLED':
    case 'NOTHING_TO_INVOICE':
    case 'MAINTENANCE_WINDOW_CONFLICT':
    case 'MAINTENANCE_WINDOW_ALREADY_CLOSED':
    case 'PRODUCT_HAS_STOCK':
    case 'INVALID_OVERRIDE_TRANSITION':
    case 'DUPLICATE_RATE_PLAN_NAME':
    case 'NEXT_ARRIVAL_CONFLICT':
    case 'NO_PRICE_ADJUSTMENT_PENDING':
    case 'DEPOSIT_NOT_PAID':
    case 'AFIP_REQUEST_UNCERTAIN':
    case 'INVOICE_NOT_ISSUED':
    case 'AR_INVOICE_NOT_ISSUED':
    case 'AFIP_RECONCILIATION_PENDING':
    case 'RATE_CATALOG_ENTRY_CONFLICT':
    case 'RESOURCE_NAME_CONFLICT':
    case 'RESERVATION_NOT_CANCELLED':
    case 'NOTHING_TO_REFUND':
    case 'REFUND_BASE_CHANGED':
    case 'REFUND_INVOICE_SET_CHANGED':
    case 'INVOICE_NOT_REVERSIBLE':
    case 'ORDER_CHARGE_INVOICED':
    case 'ORDER_CANCELLED_CANNOT_INVOICE':
    case 'RESERVATION_CHARGE_INVOICED':
    case 'RESERVATION_CANCELLED_CANNOT_INVOICE':
    case 'CREDIT_NOTE_CANCELLATION_REJECTED':
    case 'CREDIT_NOTE_MULTI_INVOICE':
    case 'ORDER_INVOICE_HAS_NO_LINES':
    case 'CREDIT_NOTE_CAP_EXCEEDED':
    case 'CREDIT_NOTE_PAIR_CAP_EXCEEDED':
    case 'CREDIT_NOTE_ATTRIBUTION_BLOCKED':
    case 'CREDIT_NOTE_ATTRIBUTION_MISMATCH':
    case 'RESERVATION_ON_CONSOLIDATED_INVOICE':
    case 'CREDIT_NOTE_RESERVATION_NO_LIVE_INVOICE':
    case 'CREDIT_NOTE_RESERVATION_MULTI_INVOICE':
    case 'CREDIT_NOTE_MIXED_STAY':
    case 'CREDIT_NOTE_CONSOLIDATED_FULL_REVERSAL':
    case 'CREDIT_NOTE_AMBIGUOUS_SUBJECT':
    case 'CREDIT_NOTE_REQUEST_INVALID_TRANSITION':
    case 'INVOICE_ALREADY_ISSUED':
    case 'INVOICE_MANUAL_RESOLUTION_PRECONDITION_FAILED':
    case 'INVOICE_UNCERTAIN_CLEAR_PRECONDITION_FAILED':
    case 'INVOICE_HAS_OPEN_CREDIT_NOTE_REQUEST':
    case 'CREDIT_NOTE_REQUEST_NOT_IN_MANUAL_REVIEW':
    case 'INVOICE_RESOLUTION_CAE_MISMATCH':
    case 'INVOICE_RESOLUTION_STATE_CONFLICT':
    case 'INVOICE_VOUCHER_NUMBER_ALREADY_REGISTERED':
    case 'AFIP_RECONCILIATION_PRECONDITION_FAILED':
    case 'RETRY_INVOICE_IN_FLIGHT':
    case 'COMPANY_LINK_REQUEST_ALREADY_PENDING':
    case 'COMPANY_LINK_REQUEST_INVALID_TRANSITION':
    case 'COMPANY_HAS_NO_ELIGIBLE_APPROVER':
      return 409;

    // --- 503 Service Unavailable ---
    // Red de seguridad: PLATFORM_UNAVAILABLE se captura localmente en los routers.
    // AFIP_NOT_CONFIGURED: mismo criterio que BUSINESS_NOT_READY -- la
    // funcionalidad depende de un recurso externo (certificado AFIP) que
    // todavía no está disponible para este negocio, no es un error del
    // request en sí. AFIP_RECONCILIATION_UNAVAILABLE (Bloque 3, §3.14, P-1) --
    // mismo grupo: no se pudo consultar AFIP para reconciliar, reintentable
    // por el operador con solo volver a apretar el botón.
    case 'AFIP_NOT_CONFIGURED':
    case 'AFIP_PADRON_UNAVAILABLE':
    case 'AFIP_RECONCILIATION_UNAVAILABLE':
    case 'PLATFORM_UNAVAILABLE':
    case 'BUSINESS_NOT_READY':
      return 503;

    default:
      // DomainError con code no mapeado — es un bug del servidor.
      // Logueamos para detectar codes nuevos que necesiten mapeo explícito.
      logger.error({ code: error.code }, '[errorHandler] DomainError sin mapeo de status');
      return 500;
  }
}
