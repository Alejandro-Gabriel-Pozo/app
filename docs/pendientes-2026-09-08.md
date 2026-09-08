# Pendientes — Lunes 8 de Septiembre 2026

Arrastra lo que seguía abierto en `pendientes-2026-09-06.md` (no hubo archivo
para el 07/09 — la sesión que empujó los sub-bloques 4 y 5 del ADR trabajó
in-place en el de 09-06; el `architecture-governor` lo marcó como desvío menor).
Los ítems cerrados quedan marcados allá in-place, no se repite el detalle acá.

**Alcance de la sesión 07→08/09:**
1. Sub-bloque 4 del ADR común "cancelar con NC" (`ef27e42`): orquestador
   `CancelOrderWithCreditNoteService` + ruta `POST /api/orders/:id/cancel-with-credit-note`
   (`authorize(Roles.EMISOR_NOTA_CREDITO)`) + secuencia N1.a.
2. Sub-bloque 5: (a) F4 en `findBlockingInvoiceLinkage()` **cerrada sin cablear**
   (`af2b2b5`) — divergía de ERPNext/Odoo + estado inalcanzable; (b) reconciliación
   del residual #3 en `registrarDesenlace()` (`20366b1`); (c) cerca de convención
   `reversed_invoice_id` — **mitad de código** (`0baf2b6`).
3. Los 6 commits (`af2b2b5`..`cf47763`) **pusheados y deployados**, CI 5/5 verde
   (job `integration` contra `postgres:16-alpine` incluido — cierra el flake de
   `credit-note-compensation.integration.test.ts` con evidencia local).
4. **Plan total** de cierre del ADR restante + deuda estructural, armado con
   `erp-audit-orchestrator` (lifecycle + dependencias + secuencia) y
   `auditor-circuitos-erp` (grounding ERPNext / Odoo 19 / QloApps):
   `docs/plan-cierre-cancelacion-nc-y-deuda-estructural-2026-09-08.md`.

**Disciplina de evidencia:** `[V]` verificado contra el árbol real / Postgres real;
`[P]` decisión propuesta, no final; `[H]` hipótesis sin verificar.

**Estado git al abrir:** `app-main` HEAD = `origin/main` = `cf47763` (verificado
`git ls-remote`), working tree limpio. `appfrontend-main` = `613c206`, sin tocar.
Push y deploy = autorización aparte del dueño.

---

## 🔴 Abierto — registrado por primera vez (08/09/2026)

Salen de la auditoría del `erp-audit-orchestrator` sobre el ADR + `pendientes-2026-09-06.md`.
Los tres **estaban registrados** en `pendientes-2026-09-06.md` (el #19 y el #21
como sub-filas del ítem 5, el #20 nunca escalado) y **ninguno llegó a la lista de
trabajo**. Dos son condiciones formales del re-gate del `architecture-governor`.
Modo de falla del incidente del 25/08 (`CLAUDE.md` raíz): lo que queda fuera de la
categoría que alguien relee cada sesión, desaparece del radar.

### #19 — Cerca de arquitectura capa (iv) del ADR · 🔴 abierto

`src/tests/architecture/` tiene 4 archivos (`api-auth-gate-order.test.ts`,
`customer-portal-ownership-guard.test.ts`, `lock-order.test.ts`,
`reversed-invoice-id-convention.test.ts`) y **ninguno** impide que
`src/pos-menu/order.service.ts` o `src/reservas/reservation.service.ts` importen
`src/facturacion/cancel-with-credit-note.ts` /
`src/facturacion/cancel-order-with-credit-note.service.ts`.

**La cerca es ESTRECHA, NO una regla de dependency-cruiser `facturacion↔pos-menu`.**
`tsPreCompilationDeps: true` (`.dependency-cruiser.cjs:139`) hace que los
`import type` sí se vean, y hoy hay ~16 imports legítimos
`pos-menu|reservas → facturacion`, incluido
`src/pos-menu/order-cancel-for-credit-note.ts:47`
(`import type { OrderCancelPort } from '../facturacion/cancel-order-with-credit-note.service.js'`
— es el adaptador de puerto del sub-bloque 4, `class OrderCancelForCreditNote implements OrderCancelPort`,
y **debe quedar exento**). Una regla amplia rompería `lint:arch` en esos 16.
La cerca correcta: **`order.service.ts` y `reservation.service.ts` específicamente
no importan el núcleo** (`cancel-with-credit-note.ts` /
`cancel-order-with-credit-note.service.ts`), + conteo de call-sites de
`authorizeCreditNoteCancellation()`, + ausencia de flag de bypass en
`cancelOrder`/`cancelReservation`/`findBlockingInvoiceLinkage`. Patrón
`lock-order.test.ts` (allowlist + `stripComments` + falsos negativos declarados +
prueba de mutación).

Es el sub-bloque 6/7 de B-núcleo+órdenes (`pendientes-2026-09-06.md:715-716`) y
una condición formal del re-gate (ADR §4: *"junto con (i) es lo que realmente
impide el code path"*). **Familia ADR, no deuda estructural.** → bloque 1.2 del plan.

### #20 — Test del arqueo (condición 4 del re-gate) · 🔴 abierto

Grep `shift_id|CashMovements|arqueo` en
`src/tests/integration/cancel-order-with-credit-note.integration.test.ts`:
**0 hits.** La restricción (i) de N1.a ("el `UPDATE` dirigido sólo toca `status`,
nunca `shift_id`/`payment_method` — un movimiento de caja fantasma") está
implementada vía `settleByIdsWithClient` pero **sin cerca de test**. ADR §10
condición nueva 4: *"tras el escape, el turno `OPEN` no cambia — `getCashMovementsTotal()`
idéntico antes y después"*. → bloque 1.3 del plan.

### #21 — Tope N5 (acumulado por factura revertida) NO implementado · 🔴 abierto · **fail-open fiscal**

`buildCreditNote()` (`src/facturacion/invoice.service.ts`, rama ~`:745-795`) no
consulta `getIssuedCreditNoteCompensationTotal()` ni ningún tope antes de armar la
NC. La idempotencia es `invoice:<financialTransactionId>` — **por transacción, no
por factura revertida.** N transacciones revertidoras distintas contra el mismo
`reversed_invoice_id` pueden cada una emitir su NC total sin tope contra `imp_total`.
El ADR §3 N5 lo exige con forma dura (*"se LANZA al excederse... nunca clamp"*,
precedente ERPNext `StockOverReturnError`).
- **Órdenes: inalcanzable** — clave `cancel-order-with-cn:<orderId>`, 1:1 con la orden.
- **Reservas: alcanzable** — `confirmRefund()` crea N filas `REFUND` con el mismo
  `reversedInvoiceId` (reparto LIFO); cada una facturable por `POST /api/invoices`,
  que **no filtra por `type` en la ruta** (`src/facturacion/invoices.routes.ts:82-98`).
  Hoy lo contiene el frontend (`appfrontend-main/src/app/dashboard/cuentas-corrientes/page.tsx:304`,
  gatea `tx.type === 'CHARGE'`), **no el dominio**.
- **Con B-reservas pasa a ser el camino normal.** Debe cerrarse ANTES de B-reservas.
→ bloque 2.4 del plan (bajo lock / con el monto congelado de `credit_note_request`).

---

## ✅ Correcciones de estado aplicadas a `pendientes-2026-09-06.md` (in-place, 08/09)

- Gate final de B-núcleo+órdenes: **condiciones 6 y 7 marcadas HECHAS** con ancla
  de test. **Faltan 3, 4, 5** (no "3-7"). Condición **5 reasignada a B-reservas**
  (F4 sin cablear la vuelve vacua del lado órdenes).
- Verificaciones que quedaron abiertas y ahora cerradas por lectura de código:
  (1) el residuo "crash entre AFIP-OK y tx2" **autosana** re-invocando el escape
  (fast-path exige `CANCELLED`, `cancel-order-with-credit-note.service.ts:156-157`
  → cae a tx1 → reusa `existing` `:248` → `retryExisting()` devuelve la NC ya
  ISSUED sin re-emitir, `invoice.service.ts:897-899`); (2) el frontend gatea
  `POST /api/invoices` a `type === 'CHARGE'` en los dos call-sites.

---

## 🟠 Deuda menor detectada (08/09)

- **CI: techo "19 suites" stale → son 24.** ✅ RESUELTO (bloque 0.1 del plan,
  08/09): `.github/workflows/ci.yml` — comentario del job `integration`
  actualizado 19→24, contando con el **mismo glob recursivo que corre CI**
  (`vitest.integration.config.ts:25`,
  `find src/tests/integration -name '*.test.ts' | wc -l`), declarado que el
  número es a mano y qué lo desactualiza (suite nueva bajo
  `src/tests/integration/`, subcarpetas incluidas). `timeout-minutes: 20` sin
  cambio (~10x margen: única corrida medida = 22 suites / 104 s contra
  `postgres:16-alpine` local, `zulu-hub-continuidad-2026-09-07.md`). Continuidad
  09-07 reconciliada in-place. Pendiente opcional: cerca que cuente los archivos
  con ese glob + `stripComments` y falle si el comentario diverge (patrón
  `EXPECTED_AUTHORIZE_CALL_SITES`) — bloque aparte.
- **Comentario stale en `src/facturacion/sql.invoice.repository.ts` ~`:314-318`:**
  dice que el hueco cruzado de F4 está *"registrado como bloqueante de B-reservas"*.
  El ADR N2.a lo resolvió como doctrina. Corregir junto con el bloque 1.4 (3-ter).

- **#1 — CHECK `chk_financial_transactions_reversed_invoice_type` (schema v46→v47)**
  — ✅ RESUELTO (bloque 1.1 del plan, `3bcf5ab`, 08/09, pusheado + deployado +
  verificado). `CHECK (reversed_invoice_id IS NULL OR type IN ('REFUND','ADJUSTMENT'))`
  sobre `financial_transactions`. Cierra la **mitad de datos** de la condición 3
  del re-gate (la mitad de código = `reversed-invoice-id-convention.test.ts`,
  `0baf2b6`).
  - **Ensayo** en rama descartable `ensayo-v47-2026-09-08` (`br-morning-math-axljb1yc`,
    copia de producción Demo con 20 FT reales): CHECK aplicado + def correcta;
    `INSERT type='CHARGE'` + `reversed_invoice_id` → **rechazado** (`23514`);
    filas `REFUND`/`ADJUSTMENT` + `reversed_invoice_id` y `CHARGE`/`REFUND` + NULL
    → OK; **`schema.sql` completo reaplicado con las filas revertidoras presentes
    → sin error**, `convalidated: true`.
  - **Deploy** `dep-daftmg15efls73b7jon0` (live). `[migrate-tenants] Versión
    objetivo: v47` → `✅ biz-demo-01 — migrado a v47` + `✅ cd6cd508… — migrado a
    v47` (los dos "migrado", no "ya estaba al día"). Verificación de producción:
    `pg_get_constraintdef` = la def esperada en las 2 tenants; 0 filas no
    conformes en las 2; `schema_migrations MAX = 47` en las 2;
    `businesses.schema_version = 47`: cerrado por construcción, no solo por el
    log. `migrate-tenants.ts:65` corre
    `platformRepo.updateSchemaVersion(business.id, 47)` con el `business.id` que
    salió de `platformRepo.listAll()` sobre esa misma tabla en la misma corrida
    (`:50,:56`), así que el `UPDATE businesses SET schema_version WHERE id = $2`
    no puede matchear 0 filas. (El log `✅ migrado a v47` prueba "no tiró
    excepción", que por sí solo no descarta un `UPDATE` de 0 filas —
    `updateSchemaVersion` no chequea `rowCount`; lo que lo descarta es el
    origen del id.) Corroboración empírica: si el puntero no se hubiera movido,
    `tenant.middleware.ts:91` estaría logueando un warning por request en el log
    de runtime de Render post-tráfico — no aparece. Sin filas `ensayo-v47-*` en
    producción (0 en Demo). Ningún ALTER a mano contra producción — lo hizo el
    deploy vía `migrate:tenants`.
  - **Ramas Neon (runbook — registrar propósito/origen/estado):**
    · `respaldo-pre-v47-demo-2026-09-08` (`br-steep-sunset-axxvv9il`) — backup
      durable, desde `production` (Demo) @ LSN `0/478E368` / 09:39 UTC 08/09,
      `no_compute`. **Punto de retorno pristino, NO tocar.**
    · `ensayo-v47-2026-09-08` (`br-morning-math-axljb1yc`) — rama de ensayo,
      desde `production` @ mismo LSN, con compute. Ya cumplió su función; borrable
      cuando se cierre el bloque.
    · Alamos: sin backup — 0 filas, 0 FT; un backup de tabla vacía no da punto de
      retorno útil. Declarado.
    · Se borró `ensayo-v46-served-at-2026-09-03` (`br-calm-mode-ax1ltup4`) para
      liberar un slot (límite de 10 ramas del proyecto Neon), **autorizado
      explícitamente por el usuario para esa rama puntual**. Era el ensayo del
      bump v45→v46 (columnas de sello de `orders`), en producción desde el
      03/09. **Registro incompleto contra el runbook** (falta LSN/origen,
      resultado del ensayo y estado final — los 4 que el runbook pide antes de
      borrar); la rama ya no existe, no se recupera. Nota de proceso: la próxima
      vez que un límite de slots fuerce un borrado, capturar los 4 antes.
  - **Rollback declarado en el commit** (`3bcf5ab`): no es "git revert y listo"
    — el revert deja el constraint vivo + `schema_version` en 47 → warning por
    request. Rollback real = re-landear, o dropear el constraint a mano en las 2
    tenants + bajar `schema_version`.
- **`MID-LOG-001`** — ✅ RESUELTO (bloque 0.2 del plan, 08/09).
  `src/api/middleware/error.middleware.ts`: política declarada — todo `DomainError`
  que mapea a `>= 409` (carreras, reglas de negocio, dependencia externa, code sin
  mapeo) se loguea `warn` con `{ code, status, method, url, businessId }`, **nunca
  `err.message`** (trae ids/montos/razón social, A7.1). Los 4xx de cliente
  rutinario (400/401/403/404) no. Reemplaza el special-case de
  `REFUND_BASE_CHANGED`.
  - `domainErrorStatus` gana los 5 codes del escape
    (`CREDIT_NOTE_CANCELLATION_PENDING`/`_ISSUED_ORDER_NOT_CANCELLABLE` → 422;
    `CREDIT_NOTE_CANCELLATION_REJECTED`/`CREDIT_NOTE_MULTI_INVOICE`/`ORDER_INVOICE_HAS_NO_LINES`
    → 409, alineados con el ladder inline de la ruta). Antes caían al `default:`
    → 500 + "sin mapeo".
  - **El escape (`POST /api/orders/:id/cancel-with-credit-note`) resuelve el
    error inline y NO pasa por el middleware** → `orders.routes.ts` gana un
    `logger.warn({ code, orderId, businessId })` al tope del `catch` para
    `DomainError` (endpoint de bajo volumen, se loguea todo fallo). Esto es lo
    que hace visible la rama D1 del ADR §7.
  - `url` = **path solo** (`req.originalUrl.split('?')[0]`) — A7.2: `GET
    /api/customers` todavía recibe `email`/`name` por query string (deuda
    pre-existente); el path solo lleva el id de recurso. Umbral `>= 409`:
    403/402 excluidos **a propósito** (autz va a `audit_log`; 402 es upsell),
    dicho en el comentario para que no se lea como accidente numérico.
  - `ORDER_STATE_UNKNOWN` también agregado al 409 (misma familia — inline como
    409 en 4 sitios de `orders.routes.ts`, antes caía al `default:` → 500).
  - Test: `error.middleware.test.ts` nuevo (8) — 422/409 se loguean con la
    forma exacta y sin `message`; 404/400 no; code sin mapeo → 500 +
    `logger.error` una vez; sin `req.user` → `businessId: null`; **query
    string nunca viaja al log**; `ORDER_STATE_UNKNOWN` → 409.
  - **Divergencias ladder inline (`orders.routes.ts`) vs `domainErrorStatus`**
    (pre-existentes del sub-bloque 4, NO se tocan acá — sólo se registran):
    `AFIP_NOT_CONFIGURED` 422 ruta / 503 middleware; `AFIP_REQUEST_REJECTED`
    409 ruta / 422 middleware. Reconciliarlas es cambio de contrato (chequeo
    de frontend) — bloque propio.
  - **Deuda que queda:** dos políticas de logging conviven — el escape loguea
    **todo** `DomainError` (incl. 404, por bajo volumen), el middleware sólo
    `>= 409`. Las rutas que resuelven inline sin `next(err)` (el escape, los
    guards de reservas del portal) no pasan por el middleware. Una convención
    "todo `*.routes.ts` delega los `DomainError` al middleware salvo
    divergencia de status declarada" reconciliaría las dos — bloque propio.
- **Doble lectura por el repo en vez de por `client`** en
  `cancel-order-with-credit-note.service.ts`: la deuda (i) de `ef27e42` menciona
  `:269`; el mismo defecto está también en `:248`. Arreglar las dos o declarar por
  qué no. → bloque 1.5 del plan.

---

## Arrastrado de `pendientes-2026-09-06.md` — abierto, detalle allá

**ADR "cancelar con NC" — resto:** ~~CHECK `reversed_invoice_id` mitad de datos (#1)~~ ✅ `3bcf5ab` ·
3-ter filtro `cbte_tipo` (#2) · 4 filas de deuda de `ef27e42` (#3) · B3
(`credit_note_request` + bandeja + `?status=`) (#4) · B-reservas
(`getByReservationId` UNION, subcasos directa/consolidada/pool mixto,
`EXPIRED-FACT-01`, F4 en reservas, 5 caracterizaciones) (#5) · Anexo A1/A2/A4 ·
Frontend (3 catálogos sin `EMISOR_NOTA_CREDITO`, copy falsa `roles-de-fabrica`,
consumir `description`/`kind` del dead-letter).

**Deuda estructural:** Residual B-1 + `REFUND-INT-GUARD-001` · `MID-LOG-001` ·
`POOL-STARV-001` · `CONCIL-INCONSIST-01` (absorbe INV-ORF-01 + pt1 ORDER-13) ·
`OUTBOX-RETRY-HIST-01` · `OUTBOX-BACKOFF-01` · `OUTBOX-DL-COMPENSATOR-01` ·
`OUTBOX-DL-THROTTLE-RESET-01` 🟠 · `EMAIL-FROMNAME-RFC5322-01` 🟠 · CI techo · A7.6.

**Seguridad:** `SEC-ROT-001` (runbook ✅, falta código 2-claves + `reencrypt-secrets.ts`
+ IV 16→12) · `RBAC-SYNC-001 §4` · `FACT-INV-BIZID-001`/`FAILOPEN-001` (re-etiquetar).

**Higiene:** desfase de fecha "08/09"→"07/09" en ~5 docs (verificar si sigue
aplicando tras esta sesión, que sí es del 08) · DA-CONT-001 · DOC-ANCLA-001 ·
CONTRACT-001 · ficha M10 stale.

**Backlog de producto (sin fecha):** Gap C1-C · AR-FACT-NO-ISSUED-01 Fases 2-8 ·
FACT-BORRADOR-001 (v2.8) · C1-B (bloqueada por proveedor) · C2/C3 · D7 (5 endpoints
de reportes sin consumidor) · ORDER-10 B4 (período contable — sesión con el
contador) · circuito POS-caja (ORDER-12 / CAJA-ORD-01 / AUDIT-ORD-01) · heredados
(Redis, BullMQ, downgrade, datos demo en prod).

---

## Higiene

- Commit de docs de esta sesión: los 6 del arco (`af2b2b5`..`cf47763`) ya
  incluyen los updates de `pendientes-2026-09-06.md` in-place. Este archivo +
  el plan + las correcciones de estado van en un commit de docs aparte.
