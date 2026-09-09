# ZULU Hub — Continuidad operativa

- **Fecha de corte:** 2026-09-09, segundo corte del mismo día — `app-main`
  local en `6d55876` (5 commits sobre lo desplegado, ver §1). El primer
  corte de hoy recomendaba `3.3-d` como próximo bloque; **ya está resuelto**
  (§2, ítem 5). No repitas ese trabajo si estás retomando desde acá.
- **Reemplaza a:** `docs/zulu-hub-continuidad-2026-09-08.md` (arco del
  bloque B-núcleo+órdenes cerrado, deploy `9b651f2`). Ese documento sigue
  siendo la referencia de ese arco — no se reescribe acá.
- **Para qué:** que una sesión nueva sepa dónde quedó el proyecto y qué
  sigue, sin depender del historial conversacional.
- **Etiquetas:** `mapa-del-sistema` `continuidad`

---

## 1. Estado de producción

| Repo | `origin/main` | En producción | Local |
|---|---|---|---|
| `app-main` | `e1b70bb` (sin cambio desde el corte anterior) | Deploy vivo sigue siendo el de `9b651f2` — **nada de lo de hoy está deployado**. | `6d55876`, **ahead 6** de `origin/main`: `d6f35a9` (gate diseño), `5a64ae2` (3.3-b1), `9b8209a` (docs precondición), `b0f9d93` (3.3-b2), `766eb84` (docs reconciliación), `6d55876` (3.3-d). Un push de esto es **fast-forward de 6 commits**, no de uno — incluye la ruta HTTP nueva con su RBAC. |
| `appfrontend-main` | `613c206` | Sin cambio. | Sin cambio, no tocado hoy. |

> Verificar siempre con `git ls-remote origin refs/heads/main` antes de
> asumir que algo de esto llegó a producción.

## 2. Qué se hizo hoy (09/09/2026)

1. **Precondición de #29 cumplida** (`docs/pendientes-2026-09-08.md` #29):
   `prices_include_iva=TRUE` en las 2 tenants, 0 reservas con >1 factura
   viva en datos reales, grounding `auditor-circuitos-erp`. Registrado en
   `9b8209a`.
2. **Bloque 3.3-b1** (`5a64ae2`) — orquestador
   `CancelReservationWithCreditNoteService` + puerto
   `ReservationCancelForCreditNote`. SIN ruta en ese commit. 21 unitarios +
   4 integración real + 4 mutaciones. Suite 2006/2006.
3. **Bloque 3.3-b2** (`b0f9d93`) — ruta
   `POST /api/reservations/:id/cancel-with-credit-note` +
   `authorize(Roles.EMISOR_NOTA_CREDITO)` + RBAC completo. El gate corrigió
   3 errores antes de codear (error post-AFIP mapeado a 400 en vez de 422,
   6 códigos sin mapear en `error.middleware.ts`, respuesta sin
   `toReservationDto()`). Suite 2013/2013.
4. **Docs-only** (`766eb84`) — reconcilia anclas stale que el propio 3.3-b2
   volvió falsas en `CLAUDE.md`, el plan canónico y `pendientes`.
5. **Bloque 3.3-d** (`6d55876`) — `classifyReservationLiveInvoice()` +
   reconciliación de `handleReservationCancelled`, espejo de
   `classifyOrderLiveInvoice()`/`handleOrderCancelled()`. **El pasivo de
   deploy que 3.3-b2 creó queda retirado SOLO para "factura DIRECTA +
   reserva SIN `PAYMENT` propio ni filas anuladas previas"** — 2
   residuales medidos contra Postgres real, no cerrados (consolidada-parcial;
   reserva con seña propia vía `recordPayment()`). Mediciones read-only de
   producción (2 tenants): 0 reservas `CANCELLED` con comprobante vivo hoy
   (0 de 28 en Demo); 0 reservas con `PAYMENT` propio y 0 en consolidada,
   de 15 con algún cargo. **El residual es real como mecanismo, pero su
   tamaño en producción hoy es 0.** 4 mutaciones + 9/9 integración real.
   Suite 2017/2018. Detalle completo y firma de triage para el runbook en
   `pendientes-2026-09-08.md` #27 ítem 1.

## 3. Deuda declarada de hoy, ninguna bloqueante

- ~~Catch inline 409 en las dos rutas de escape~~ **✅ RESUELTO (mismo día,
  commit posterior a este corte)** — las dos rutas delegan a
  `error.middleware.ts` salvo una excepción declarada
  (`InvalidReservationError` en reservas). Ver `pendientes-2026-09-08.md`
  #27, ítem "Deuda declarada de paso".
- ~~`AFIP_NOT_CONFIGURED`: 422 inline, 503 en el middleware~~ **✅
  RECONCILIADO al valor del middleware (503)** en el mismo commit —
  reversión explícita de la divergencia "deliberada" que este mismo corte
  había declarado horas antes; el motivo original (simetría entre los dos
  escapes) sobrevive porque los dos cambian juntos.
- **Texto "la orden ..." de `CreditNoteCancellationPendingError`/
  `...RejectedError`** reusado tal cual del lado reservas (mensaje
  incorrecto, `.code` correcto) — `domain/errors.ts` append-only en los 3
  bloques, corregir el texto toca clases existentes.
- **Comentarios stale en `outbox.handlers.ts`** introducidos por 3.3-d: el
  docblock de `opts` de `registrarDesenlace()` sigue diciendo "SOLO lo pasa
  `handleOrderCancelled`" — desde `6d55876` son dos callers. Bloque aparte,
  comment-only, no mezclar con código funcional.
- **Harness de integración salteable en silencio:** `describe.skipIf(skipIfNoDb)`
  saltea TODA la suite sin `TEST_DATABASE_URL` en el entorno del proceso,
  `exit 0` sin haber corrido nada. Escribir esto en el runbook antes de
  confiar en "CI verde" como evidencia de que la suite de integración corrió.

## 4. Próximo bloque

**Ya no hay un bloque de código bloqueante para decidir push/deploy** — los
tres (`3.3-b1`, `3.3-b2`, `3.3-d`) están resueltos localmente. Lo que
sigue es una decisión del dueño, no un gate técnico:

- **Push/deploy de los 6 commits.** El residual de 3.3-d está medido en 0
  en producción hoy (§2 ítem 5), pero eso es una foto, no una garantía —
  si el uso de seña por reserva (`recordPayment()`) crece, hay que
  remedirlo. Antes de pushear: escribir la firma de triage de
  `pendientes-2026-09-08.md` #27 ítem 1 en el runbook de deploy
  (`docs/conocimiento/runbook-deploy-render.md`) — si se deploya sin eso,
  guardia ve `logger.error` sin forma de clasificarlo.
- **Bloques de código pendientes, ninguno bloqueante:** `3.3-c` (cablear F4
  en `findBlockingInvoiceLinkage()`, firma congelada), `3.3-e` (índice de
  rendimiento), el clasificador por PAR `(invoiceId, reservationId)` que
  cerraría el residual consolidada-parcial, y ensanchar la guarda de
  `handleReservationCancelled` para el caso `PAYMENT` propio (cambia
  semántica compartida con `registrarDesenlace()`, gate propio).
