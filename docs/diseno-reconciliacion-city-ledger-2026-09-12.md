# Diseño — Reconciliación de City Ledger (Caso 3 residuo Q2 + Caso 4)

## 1. Contexto

`AccountsReceivableService.transferStayBalanceToReceivable()`
(`src/clientes-finanzas/accounts-receivable.service.ts:135-208`) transfiere
el saldo pendiente de una estadía a una cuenta por cobrar de una empresa
(City Ledger): crea un `PAYMENT` que salda el folio del huésped, un `CHARGE`
`SETTLED` contra la empresa por el mismo monto, y una fila
`accounts_receivable` (`PENDIENTE_FACTURAR` → `FACTURADO` → `COBRADO`, R12,
nunca vuelve atrás) que trackea la deuda.

Dos investigaciones separadas de esta sesión (`docs/investigacion-decisiones-
bloqueado-2026-09-12.md`, casos 3 y 4) identificaron el mismo gap estructural
por dos caminos distintos: **no existe ningún mecanismo para corregir un
cargo ya transferido y `SETTLED` contra una empresa, cuando algo del lado de
la estadía cambia después de la transferencia.**

### 1.1 Los dos disparadores

**Disparador A — Caso 3 residuo Q2.** Desde el fix de `checkOut()` (bloque
1, commit `ad28d2e`), `getNetBalanceByStayId()` incluye `PENDING` —
concretamente un `ADJUSTMENT` de precio de una reserva `CONFIRMED`
(`ReservationService.confirmPriceAdjustment()`,
`src/reservas/reservation.service.ts:665-762`) que recién liquida a
`SETTLED` cuando la reserva se completa (`settleByReservationId()`,
`sql.financial-transaction.repository.ts:280-289` — actualiza SOLO
`status`, nunca `amount`; el ledger es append-only,
`sql.financial-transaction.repository.ts:45-47`). Si ese `ADJUSTMENT` se
transfirió a una empresa mientras estaba `PENDING`, y después:
- la reserva se completa con un ajuste MENOR al transferido (imposible hoy
  porque `amount` nunca cambia — pero si el operador hace un segundo
  `confirmPriceAdjustment()` negativo antes de completar, el saldo real cae), o
- la reserva se cancela (`handleReservationCancelled`,
  `src/workers/outbox.handlers.ts:225-270` → `voidByReservationId()`,
  `sql.financial-transaction.repository.ts:357-404`, anula el `ADJUSTMENT`
  salvo que ya tenga comprobante fiscal vivo),

el folio del huésped queda saldado con un `PAYMENT` que compensó un monto
que ya no corresponde, y la empresa quedó con un `CHARGE` `SETTLED` de más.

**Disparador B — Caso 4.** El escape de cancelación con Nota de Crédito de
una orden (`CancelOrderWithCreditNoteService`,
`src/facturacion/cancel-order-with-credit-note.service.ts:325-384`) crea un
`ADJUSTMENT` compensatorio con `stayId` (heredado del `CHARGE` que revierte,
línea 336) pero **`reservationId: null`** (línea 383) — mientras que el
`CHARGE` que `transferStayBalanceToReceivable()` le abre a la empresa lleva
`reservationId: stay.reservationId` **sin** `stayId` (omitido a propósito,
`accounts-receivable.service.ts:168-177`, para no reabrir el folio del
huésped). El `ADJUSTMENT` del escape nunca alcanza el lado de la empresa en
el ledger — la empresa queda facturada/cobrada por un cargo que fiscalmente
ya se anuló.

**Por qué es un solo mecanismo, no dos.** Ambos disparadores terminan en el
mismo estado inconsistente (una `accounts_receivable` cuyo `amount`
congelado ya no representa lo que la estadía realmente generó) y requieren
la misma operación de fondo: anular la AR/CHARGE viejo con una fila
compensatoria (nunca editar `amount` — el ledger y `accounts_receivable`
son TRANSACCIÓN, R12) y, si corresponde, transferir el monto correcto.
Construir dos mecanismos paralelos sería duplicar la misma lógica con dos
puntos de entrada — se descarta.

### 1.2 Hallazgo colateral (bug verificable, no de diseño)

`voidByReservationId()` anula por `reservation_id` **sin filtrar por
`customer_id`** (`sql.financial-transaction.repository.ts:357-404`). El
`CHARGE` de la empresa lleva `reservationId: stay.reservationId` — si la
reserva se cancela y ese `CHARGE` no tiene comprobante fiscal vivo, **queda
`VOIDED` automáticamente hoy**, pero la fila `accounts_receivable` sigue
`PENDIENTE_FACTURAR` con su `amount` intacto (`resolveInvoiceLinkage`
devuelve `NONE` sobre un `financialTransactionId` que apunta a un `CHARGE`
`VOIDED`, y `markInvoiced()`/`markCollected()` lo dejan pasar por el
fallback legacy). Efecto: la empresa puede terminar cobrada por una deuda
que el ledger ya anuló. **No está en el alcance de este diseño** — es un
bug de código independiente, con su propia ancla en
`docs/pendientes-2026-09-12.md` (`requiere query` antes de confirmarlo
contra producción). El mecanismo que este documento diseña SÍ lo cubre
indirectamente: una vez construido, la reconciliación explícita reemplaza
el auto-`VOIDED` silencioso como el camino correcto para este caso también.

## 2. Grounding ERP

Dos rondas (`docs/investigacion-decisiones-bloqueado-2026-09-12.md` Caso 4,
y una ronda dedicada a Caso 3 Q2 el 12/09/2026, misma sesión) sobre Cloudbeds,
Odoo, ERPNext, Dolibarr, QloApps (+ Oracle OPERA supletorio):

- **Nivel 1 — existe en 4 de 5** (todos salvo QloApps, que no tiene City
  Ledger de empresa). Cloudbeds lo tiene con nombre propio (*Transfer back
  to folio* / *void invoice + credit note*).
- **Nivel 2 — unánime:** fila de reversa nueva, nunca edición del monto
  original (ERPNext `make_reverse_gl_entries()`, Dolibarr
  "una vez validada, nunca se modifica", Odoo "la NC es el único método
  legal para corregir una factura validada"). Siempre disparado por un
  humano con permiso contable — cero precedente de corrección automática.
  El tratamiento cambia según si ya hay documento fiscal sellado
  (Dolibarr: *replacement invoice* sin pago vs. *credit note* con pago;
  Odoo: reset-to-draft si no hay lock vs. NC si lo hay).
- **Divergencia real (donde el grounding no cierra una sola respuesta):**
  reversa total + re-transferencia (Cloudbeds, único PMS) vs. ajuste
  parcial sobre la misma fila (Odoo/ERPNext/OPERA, genéricos). — resuelto
  por decisión del dueño, ver §3.

## 3. Decisiones del dueño (12/09/2026, `AskUserQuestion`)

1. **Forma de la corrección: reversa completa + re-transferencia**
   (Cloudbeds), no ajuste parcial sobre la AR existente. Consistente con
   que `accounts_receivable` ya es TRANSACCIÓN inmutable en este repo.
2. **Estados cubiertos: los 3** (`PENDIENTE_FACTURAR`, `FACTURADO`,
   `COBRADO`). `PENDIENTE_FACTURAR` se corrige internamente (sin documento
   fiscal — `markInvoiced()` no emite ninguno real, `accounts-
   receivable.service.ts:217-221`); `FACTURADO`/`COBRADO` enrutan al
   circuito de NC de escape que ya existe
   (`POST /orders|reservations/:id/cancel-with-credit-note`), no se
   construye un camino nuevo para esos dos.
3. **Excedente cuando ya está `COBRADO`: misma regla que el Caso 5**
   (`investigacion-decisiones-bloqueado-2026-09-12.md:259-267`) — crédito a
   favor de la empresa en su cuenta corriente por defecto; devolución real
   de dinero es la excepción explícita, no aditiva.
4. **Rol autorizado: `Roles.EMISOR_NOTA_CREDITO` — Y `Roles.MANAGEMENT` a la
   vez** (decisión revisada, ver punto 7 abajo — la versión original de
   este documento solo pedía `EMISOR_NOTA_CREDITO`; el gate
   `architecture-governor` encontró la asimetría de roles antes de
   aprobar).

**No decidido explícitamente, recomendación técnica sin objeción esperada:**
sin ventana temporal de corrección — 4 de los 5 sistemas de referencia no la
tienen (solo OPERA, supletorio, fuera del set de 5).

**Ronda 2 de decisiones (tras la corrección REFUND→ADJUSTMENT del gate,
mismo día):**

5. **Visibilidad fiscal de la fila `ADJUSTMENT` compensatoria: EXCLUIDA
   explícitamente de la construcción de Nota de Crédito.** Es una reversa
   puramente interna (`PENDIENTE_FACTURAR`, sin documento fiscal, por
   diseño de este mismo bloque) — mecanismo de exclusión en §4.2.
6. **UI en `appfrontend-main` para disparar la reversa: follow-up sin
   fecha.** El mecanismo backend es lo urgente; la pantalla espera a medir
   volumen real de uso. Hasta que exista, la única forma de disparar
   `POST /:id/reverse` es `curl`/Postman contra el endpoint autenticado.
7. **Asimetría RECEPTIONIST (tiene `EMISOR_NOTA_CREDITO`, no
   `MANAGEMENT`)/rol custom con `MANAGEMENT` sin `EMISOR_NOTA_CREDITO`:
   la ruta exige los DOS permisos a la vez**, no uno solo — mecanismo en
   §4.4.

**Ronda 3 de decisiones (13/09/2026, `AskUserQuestion`):**

8. **Filtro de listado (§7 punto 8): mostrar, con estado visible.**
   `listByCompany()`/`getByCompanyCustomerId()` NO agregan ningún
   parámetro de filtro nuevo al contrato de listado (se descartó
   filtrar por default o exigir un toggle `includeReverted?`) — las
   filas `REVERTIDO` aparecen mezcladas con el resto, con su estado
   claramente marcado, para no esconder que hubo una corrección. El
   tratamiento visual distinto (badge/color en vez de solo el texto del
   status) queda como decisión de UI de `appfrontend-main`, a resolver
   junto con el Bloque 2 -- **no** "cuando exista la pantalla": la
   pantalla que consume `listByCompany()` ya existe hoy
   (`appfrontend-main/src/app/dashboard/reportes/page.tsx`, vía
   `accountsReceivableApi.listByCompany()`); lo que sigue sin fecha es
   la pantalla para DISPARAR la reversa (`POST /:id/reverse`, punto 6 de
   esta sección). Esa pantalla de listado hoy tiene `AR_STATUS_LABEL`
   (`reportes/page.tsx`) con solo 3 claves -- sin ampliar ese `Record` y
   el union TS junto con el Bloque 2, una fila `REVERTIDO` real se
   renderiza con la celda de estado VACÍA, lo contrario de "mostrar, con
   estado visible" que esta decisión pide. Ver
   `ACCOUNTS-RECEIVABLE-STATUS-REVERTIDO-TS-001` en
   `docs/pendientes-2026-09-12.md`.

## 4. Mecanismo — PENDIENTE_FACTURAR (el único que este bloque implementa en código nuevo)

### 4.1 Clasificación (`criterios-negocio`)

- **`accounts_receivable`**: ya clasificada TRANSACCIÓN (bloque
  `BLOQUE 9 — CUENTAS POR COBRAR` en `schema.sql` — buscar por ese título,
  no citar por línea ni por la frase completa envuelta en el comentario
  (corrección del gate: la frase original citada acá partía en dos líneas
  de comentario SQL y no matcheaba ningún grep; mismo criterio que
  SCHEMA-ANCHOR-DRIFT-001, pero el fragmento tiene que ser
  grep-eable de una sola línea — "nunca se edita, solo avanza de", R12).
  Este diseño la respeta: no hay ningún `UPDATE ... SET amount`, la
  corrección es una fila NUEVA + un estado terminal nuevo.
- **La fila compensatoria contra `financial_transactions`**: mismo tipo
  (TRANSACCIÓN) que cualquier otra fila del ledger — se crea, nunca se
  edita ni se borra (R12/criterios-datos.md).
- **A2.x (tenant):** todo movimiento nuevo lleva `businessId` heredado del
  `input`, sin excepción — mismo patrón que `transferStayBalanceToReceivable`.
- **A3.x (dinero):** el monto de la fila compensatoria es el MISMO `amount`
  original en valor absoluto (reversa total, no parcial — decisión §3.1);
  la moneda se hereda de la AR original, no se re-resuelve.
- **A6.5 (rastro de transición):** la AR pasa a un estado terminal nuevo
  (`REVERTIDO`, ver §4.2) con `reversed_by`/`reversed_at`/`reversed_reason`
  — mismo patrón que `housekeeping_override_*`/`balance_override_*` ya
  usado 2 veces en este repo (v41, v49).
- **A6.6 (permiso condiciona la transición, no solo la UI):** dos
  `authorize()` estándar en cadena (`MANAGEMENT` Y `EMISOR_NOTA_CREDITO`,
  decisión §3.7/§4.4) — 2 call-sites nuevos en la matriz de conteo, no un
  chequeo inline (ver §7.1).

### 4.2 Schema — nuevo estado terminal + rastro (schema v52)

**Pre-flight ejecutado (condición bloqueante del gate, ronda 4, 12/09/2026)
— ANTES de escribir el `ALTER` de más abajo, se corrió
`SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE
conrelid = 'accounts_receivable'::regclass;` contra los dos tenants
reales (Neon, `ancient-king-17098519`): `br-snowy-tree-ax5wmq70`
(Demo/producción) y `br-square-leaf-axzvu903` (Hotel Los Álamos).
Confirmado en **ambos**: el constraint de `status` se llama, tal cual,
`accounts_receivable_status_check` (el nombre autogenerado por Postgres
para un CHECK de columna sin nombre explícito en el `CREATE TABLE`
original). El `DROP CONSTRAINT IF EXISTS` de abajo apunta a ese nombre
real, no a uno asumido — evita el modo de falla que el gate señaló:
si el nombre real fuera otro, el `DROP` sería un no-op silencioso y
quedarían el CHECK viejo (3 valores) y el nuevo (4) vigentes a la vez,
rechazando `REVERTIDO` recién al llegar al Bloque 2, sin error visible
en este deploy.

```sql
-- accounts_receivable gana un 4° estado, terminal, fuera de la cadena
-- PENDIENTE_FACTURAR → FACTURADO → COBRADO (R12 sigue cumpliéndose: solo
-- avanza, nunca vuelve atrás -- REVERTIDO es un destino nuevo, no un
-- regreso a PENDIENTE_FACTURAR).
ALTER TABLE accounts_receivable DROP CONSTRAINT IF EXISTS accounts_receivable_status_check;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_accounts_receivable_status') THEN
    ALTER TABLE accounts_receivable ADD CONSTRAINT chk_accounts_receivable_status
      CHECK (status IN ('PENDIENTE_FACTURAR', 'FACTURADO', 'COBRADO', 'REVERTIDO'));
  END IF;
END $$;
-- (mismo guard pg_constraint ya adoptado en schema v51 -- CURRENT_SCHEMA_VERSION
--  en el momento de este bloque, ver docs/resuelto.md 12/09/2026)

ALTER TABLE accounts_receivable ADD COLUMN IF NOT EXISTS reversed_by VARCHAR(255);
ALTER TABLE accounts_receivable ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE accounts_receivable ADD COLUMN IF NOT EXISTS reversed_reason VARCHAR(500);
-- motivo obligatorio a nivel aplicación (no CHECK NOT NULL -- las 3 filas
-- son NULL para toda AR que nunca se revirtió, mismo criterio que
-- balance_override_*/housekeeping_override_*).

-- Vínculo hacia la fila compensatoria en financial_transactions -- permite
-- auditar "esta AR se revirtió con ESTA fila exacta del ledger".
-- ON DELETE NO ACTION explícito (decisión propia, no analogía): R12
-- ("TRANSACCIÓN nunca se edita, solo avanza de estado") implica que una
-- fila de financial_transactions nunca se hard-deletea -- no hay camino
-- de negocio que dispare este DELETE. accounts_receivable.financial_
-- transaction_id (columna ya existente, distinta de ésta) tiene
-- ON DELETE SET NULL, pero esa FK cubre otro caso (la transacción que
-- generó el cargo original, ver BLOQUE 9) y no es una analogía correcta
-- para ésta -- la corrección de este mismo párrafo la retira; ver gate
-- ronda 4. Si en el futuro se decide permitir borrar filas del ledger,
-- esta FK es la que hay que revisar primero.
ALTER TABLE accounts_receivable ADD COLUMN IF NOT EXISTS reversal_transaction_id VARCHAR(255)
  REFERENCES financial_transactions(id) ON DELETE NO ACTION;

-- Si la reversa deja un saldo real corregido, la AR NUEVA que se crea
-- apunta a la que reemplaza (0 o 1 predecesora, nunca al revés -- la vieja
-- no sabe de la nueva en el momento de crearse REVERTIDO, se linkea
-- después dentro de la misma transacción). NULL = transferencia original,
-- no una corrección. ON DELETE NO ACTION explícito por el mismo motivo:
-- ninguna AR se hard-deletea (mismo estatus de "transacción" que
-- financial_transactions a los efectos de R12).
ALTER TABLE accounts_receivable ADD COLUMN IF NOT EXISTS replaces_ar_id VARCHAR(255)
  REFERENCES accounts_receivable(id) ON DELETE NO ACTION;
```

**Addendum — SUPERSEDED (14/09/2026, commit `5ae9044`, Bloque 3a). No se
implementó como estaba escrito acá.** La versión anterior de este párrafo
proponía `guest_reversal_transaction_id` en `accounts_receivable` —
simétrico a `reversal_transaction_id` (arriba) pero hacia la pata del
huésped. El dueño, en la misma sesión, preguntó por qué no adoptar
directo el patrón que Odoo/ERPNext ya usan (`reversed_entry_id`/
`reversal_of` — auto-referencia DENTRO del propio ledger, verificado en
código real). **No está en el grounding de §2 de este documento** — es
de una ronda de grounding COMPLEMENTARIA, despachada esa misma sesión
específicamente sobre este punto (no sobre el diseño general de §1-§3);
el detalle completo vive en el mensaje del commit `5ae9044`, no en este
ADR. Esa ronda + revisión de otros dominios (ningún otro
módulo tiene este patrón, es acotado a `clientes-finanzas`/`facturacion`)
llevó a una resolución mejor y MÁS CHICA que agregar una columna dedicada
por pata: **`financial_transactions.reversed_transaction_id`** —
auto-referencial, un solo campo genérico para TODA reversa del ledger, no
uno nuevo por feature. Con ese campo, tanto `reversal_transaction_id`
(arriba, v52) como el `guest_reversal_transaction_id` que este párrafo
proponía quedan REDUNDANTES: la misma trazabilidad sale de `SELECT * FROM
financial_transactions WHERE reversed_transaction_id = <id de la fila
original>`, para cualquiera de las dos patas, sin necesitar un puntero
dedicado en `accounts_receivable`. Implementado (schema v53→v54,
`5ae9044`): `reversal_transaction_id` se RETIRÓ del schema (0 call sites,
0 filas en producción — costo cero); `guest_reversal_transaction_id`
nunca se agregó. Detalle completo del campo nuevo, sus 2 CHECK y el
cambio al guard de `insert()`: `src/db/schema.sql` (buscar
`reversed_transaction_id`, no citar por línea — mismo criterio que
`SCHEMA-ANCHOR-DRIFT-001`) y el mensaje de `5ae9044`. No es el rediseño
de dos capas ni el posteo diferido (los dos evaluados y descartados con
evidencia esa misma sesión — Odoo se retiró del modelo de dos capas en
2019, a ERPNext el modelo de reversa le tomó 2.5 años) — es generalizar
un patrón de una sola columna.

**Corrección del gate `architecture-governor` (bloqueante, ronda 1):** la
versión original de este documento proponía `type: 'REFUND'` para la fila
compensatoria — **error de signo real**, no cosmético. En este ledger
`REFUND` lleva el MISMO signo que `CHARGE` en el saldo del cliente
(`getNetBalanceByCustomerId`, `sql.financial-transaction.repository.ts`:
`CASE type WHEN 'CHARGE' THEN amount WHEN 'ADJUSTMENT' THEN amount WHEN
'PAYMENT' THEN -amount WHEN 'REFUND' THEN amount END` — significa "plata
devuelta AL cliente", que AUMENTA lo que debe, no lo reduce; su propio
docblock ya documenta el bug de producción del 23/08/2026 que corrigió
exactamente esta confusión: *"Un REFUND revierte un PAYMENT … necesita el
signo OPUESTO"*). Con `REFUND` positivo contra la empresa, `reverseTransfer()`
habría dejado la cuenta corriente de la empresa en el DOBLE de la deuda
original en vez de en cero.

**Primitivo correcto: `type: 'ADJUSTMENT'`, `amount` NEGATIVO.** Es el
mismo tipo y el mismo patrón que ya usa
`CancelOrderWithCreditNoteService` (`cancel-order-with-credit-note.service.ts`)
para revertir un `CHARGE`: `type: 'ADJUSTMENT', amount: round2(-charge.amount)`.
El `CHECK chk_financial_transactions_amount` permite explícitamente que
`ADJUSTMENT` sea negativo (es el único tipo al que se lo permite —
"no hace falta tocar esas queries" es la razón de diseño original de esa
excepción). Contra `ar.companyCustomerId`, `status: 'SETTLED'` directo
(mismo criterio que toda reversa ya asentada, no hay "reversa pendiente"),
`notes` citando el motivo y la AR que revierte.

**Visibilidad fiscal — decidida (§3.5): EXCLUIDA de la construcción de NC.
Corrección del gate (ronda 2): el mecanismo que había diseñado
originalmente (filtrar ~15 queries de `sql.invoice.repository.ts` por
`reversal_transaction_id`) era innecesario y se retira — la exclusión YA
existe, por construcción, sin tocar una sola query.**

Verificado por el gate contra el código real: TODO camino hacia una NC
exige `reversedInvoiceId` no-nulo. `InvoiceService.buildCreditNote()` lo
chequea como PRIMER guard (`if (!tx.reversedInvoiceId) throw new
InvoiceNotReversibleError(tx.id)`, fail-loud, no silencioso), y las 16
queries de `sql.invoice.repository.ts` que participan de la construcción
de NC están TODAS acotadas por `reversed_invoice_id` (`= $1`, el join
`r.reversed_invoice_id = i.id`, o `IS NOT NULL` según el caso — ninguna
selecciona `type IN ('REFUND','ADJUSTMENT')` sin esa condición). El
`ADJUSTMENT` compensatorio de este diseño nace, por definición, SIN
documento fiscal — se crea con `reversedInvoiceId: null` — así que ya
cae fuera de cada una de esas 16 queries y del guard de
`buildCreditNote()`, sin ningún filtro nuevo.

**El invariante a declarar (no a construir):** el `ADJUSTMENT`
compensatorio de `reverseTransfer()` se crea SIEMPRE con
`reversedInvoiceId: null`. Documentarlo explícito en el docblock del
método (para que nadie lo cambie sin darse cuenta de la consecuencia) y
agregar UN test que lo verifique en las dos puntas: (a) la fila que crea
`reverseTransfer()` tiene `reversedInvoiceId: null`; (b) llamar
`buildCreditNote()`/`requestInvoice()` contra esa fila lanza
`InvoiceNotReversibleError`. Ese test es la cerca — si algún día alguien
le pone un `reversedInvoiceId` a esta fila, falla ruidoso ahí, no en
silencio. Ventaja sobre el diseño original: cero acoplamiento nuevo entre
`facturacion` (dueño de `sql.invoice.repository.ts`) y
`clientes-finanzas` (dueño de `accounts_receivable`) — este repo ya
declara ese tipo de acoplamiento invisible a `lint:arch` como excepción
sancionada en otro lado (`RESERVA-10`,
`sql.financial-transaction.repository.ts`) y no hace falta sumar uno
nuevo para nada.

### 4.3 Servicio — `AccountsReceivableService.reverseTransfer()`

**Corrección del gate `architecture-governor` (bloqueante, previa a
implementar — 13/09/2026, tras `CITY-LEDGER-CUSTOMER-BALANCE-STATUS-ASYMMETRY-001`
paso 1, commit `8f11d19`):** la versión anterior de esta sección solo
compensaba la pata EMPRESA (paso 5 de más abajo) — la pata del HUÉSPED no
aparecía en ningún paso. Eso contradice la propia decisión §3.1 de este
documento ("reversa completa", no ajuste parcial) y el propio grounding
de §2 (Cloudbeds, único de los 5 sistemas con City Ledger, nombra la
operación de referencia *"Transfer back to folio"* — devolver el cargo
al folio del huésped, no solo anular el lado de la empresa; §2 documenta
el NOMBRE de la operación de Cloudbeds, no un comportamiento observado —
leer ahí "reabre el folio" es una inferencia razonable a partir del
nombre y consistente con la decisión §3.1, no un dato de grounding
directo, y se declara así). Implementar §4.3 tal como estaba dejaba todo
stay revertido con saldo ≠ 0: el `PAYMENT` sintético (`SETTLED`) del
huésped seguía intacto, así que el folio quedaba saldado por un pago que
nunca existió mientras la empresa ya no debía nada. En el caso más simple
(nada más se movió desde la transferencia) el saldo total del stay pasaba
de "correcto pero mal localizado" (folio en 0, empresa debe) a "perdido"
(folio en 0, empresa no debe, nadie debe) — pero el caso que en realidad
motiva este bloque (Disparador A, §1.1: un `ADJUSTMENT` de precio bajó
DESPUÉS de transferir) deja el folio del huésped en NEGATIVO, no en cero
— un crédito fantasma a favor del huésped, mismo patrón de bug que
`ASYMMETRY-001` ya encontró del lado del agregado por cliente, acá del
lado del folio por estadía.

**Dependencia real, y por qué esta corrección no era posible antes de
hoy:** solo existe una forma de encontrar la pata del huésped desde una
fila de AR desde `8f11d19` (13/09/2026, mismo día), que agregó
`accounts_receivable.guest_payment_transaction_id`. Antes de ese commit
esta sección no podía haberse escrito distinto — la columna no existía.

**Precondición declarada — filas sin vínculo (pre-`8f11d19`):** ese
commit NO hizo backfill de `guest_payment_transaction_id` para AR ya
existentes (mismo criterio que `financial_transaction_id`/
`invoice_source`), así que toda AR creada ANTES de `8f11d19` tiene esa
columna en `NULL`. Sin backfill, no hay forma de encontrar CUÁL `PAYMENT`
corresponde (podría haber más de uno por estadía, y ningún otro campo lo
distingue) — **`reverseTransfer()` sobre una de esas filas falla fuerte,
no degrada** (guard nuevo, paso 4 de más abajo): hacer una reversa
"parcial" (solo pata empresa) sería exactamente la misma regresión que el
gate ya encontró y revirtió en el paso 3 de `ASYMMETRY-001` — ahí sobre
el agregado de saldo, acá sobre esta operación. Mismo criterio R15 que ya
sostiene `ON DELETE NO ACTION` en esa columna.

**Finding B del gate, medido — no argumentado desde la cronología de
commits.** El gate pidió medir, contra los dos tenants reales (Neon,
proyecto `ancient-king-17098519`), (1) cuántas filas de
`accounts_receivable` existen hoy y (2) cuántas estadías tienen más de un
`PAYMENT` `SETTLED` (la ambigüedad que justifica no intentar resolver la
pata del huésped por `stayId` a mano en vez de por el vínculo nuevo).
Medido el 14/09/2026, `SELECT count(*)` de solo lectura contra
`br-snowy-tree-ax5wmq70` (producción) y `br-square-leaf-axzvu903` (Hotel
Los Álamos): **0 filas de `accounts_receivable` en los dos tenants, 0
estadías con más de un `PAYMENT` `SETTLED` en los dos tenants.** Al
momento de medir, la columna `guest_payment_transaction_id` todavía no
estaba aplicada en producción, así que el primer `count` verificó la
tabla entera, no la columna — estado de push verificable en el momento
que se lea esto con `git log origin/main --oneline | grep 8f11d19`, no
citado acá como hecho fijo del texto (mismo criterio ya establecido en
`CLAUDE.md` raíz, incidente 11/09/2026: el estado de push cambia en el
instante del `git push`, citarlo en presente es garantía de que el texto
quede desactualizado).

Esto cambia la severidad real de Finding B, pero **no en la dirección que
una lectura apurada sugeriría.** Hoy no existe NINGUNA fila de
`accounts_receivable` en producción, en ningún tenant — así que el guard
fail-loud del paso 4 no va a rechazar ninguna reversa real el día que
`8f11d19` + este bloque se desplieguen juntos. **Corrección (Condición
C2 del gate, ronda 2, 13/09/2026): la ventana de riesgo real NO es "entre
el deploy de `8f11d19` y el deploy de este bloque" — esa ventana está
estructuralmente VACÍA, porque `8f11d19` agrega la columna Y la puebla en
el mismo commit** (`transferStayBalanceToReceivable()` genera
`guestPaymentId` y lo escribe en la fila de AR en la misma transacción
que crea la columna referencia). **La ventana que sí está abierta es la
anterior: toda AR que se cree en producción DESDE la medición del
14/09/2026 HASTA que `8f11d19` se despliegue queda con
`guest_payment_transaction_id` en `NULL` para siempre — sin backfill,
esas filas nunca van a ser reversables por este mecanismo.** Sin cota
temporal conocida (depende de cuándo se autorice y despliegue `8f11d19`,
no de este bloque). El conteo en 0 de hoy hace que esa ventana, MEDIDA
HOY, no tenga ninguna fila adentro todavía — pero la ventana en sí sigue
abierta hasta que `8f11d19` se despliegue, no hasta que se mida. La
pregunta de backfill histórico pierde urgencia por el conteo en 0, no
porque la ventana se haya cerrado. Igual queda **fuera de alcance de este
bloque** (mismo universo ya declarado "no autorizado" para
`CITY-LEDGER-OVERTRANSFER-PAYMENT-001` en `docs/pendientes-2026-09-12.md`
— necesita su propio `AskUserQuestion` + `irreversible-action-gate`).

```
async reverseTransfer(input: {
  accountReceivableId: string;
  reversedBy: string;       // identity_id, MISMO criterio que transferredBy
  reason: string;           // obligatorio, no opcional -- A6.5
  correctedBalance?: number; // si se omite, no hay saldo real corregido:
                              // reversa pura, sin AR nueva
}): Promise<{ reverted: AccountReceivable; replacement: AccountReceivable | null }>
```

Lógica (una sola transacción, `TransactionManager.run`):
1. `arRepo.getByIdWithLock(client, id)` — mismo patrón de concurrencia que
   `markCollected()` (evita una reversa y un `markCollected()` concurrentes
   sobre la misma fila).
2. Guard: si `ar.status === 'FACTURADO' || ar.status === 'COBRADO'` →
   `throw new ArReversalRequiresCreditNoteError(id, ar.status)` — enruta al
   circuito de NC existente (decisión §3.2), este método NO los maneja.
3. Guard: si `ar.status === 'REVERTIDO'` → idempotente, devuelve el estado
   actual sin re-ejecutar (mismo criterio que `markCollected()` sobre
   `COBRADO`).
4. **Guard nuevo:** si `ar.guestPaymentTransactionId == null` →
   `throw new ArReversalMissingGuestLinkError(id)` (ver arriba — falla
   fuerte, no reversa parcial).
5. **RESUELTO (14/09/2026, commit `5ae9044`, Bloque 3a — ver §7 punto 7
   cerrado más abajo). CORRECCIÓN 14/09/2026 (gate `architecture-governor`,
   ronda 3 de Bloque 3c-ii, Finding 1 — contradicción directa detectada
   contra esta misma fila, no una mejora propuesta sin evidencia): el
   `reservationId: null` de la redacción anterior queda SUPERSEDIDO por
   `reservationId: charge.reservationId`.** La protección de `null` que
   §1.2 documenta es correcta para la pata HUÉSPED (paso 6: el `PAYMENT`
   original nunca llevó `reservationId`, así que si su `ADJUSTMENT`
   compensatorio sí lo llevara, un `voidByReservationId()` posterior
   anularía solo esa fila, revirtiendo la reversa misma) pero NO transfiere
   a la pata EMPRESA: acá la contraparte real es el `CHARGE` original, que
   SÍ lleva `reservationId` desde que se creó. Dejar el `ADJUSTMENT` en
   `null` garantiza la asimetría que este mecanismo existe para evitar —
   `voidByReservationId()` matchea `reservation_id`/`type`/`status` más un
   sub-predicado POR FILA (`NOT EXISTS` de factura viva, scoped por
   `ft.id`); con `CHARGE.reservationId` seteado y `ADJUSTMENT.reservationId`
   en `null`, una futura cancelación de la reserva puede anular el `CHARGE`
   sin alcanzar nunca al `ADJUSTMENT` — deuda fantasma de signo invertido,
   mismo patrón de bug que `ASYMMETRY-001`. Pinear
   `reservationId: charge.reservationId` hace que esa futura cancelación
   evalúe el mismo `NOT EXISTS` sobre las DOS filas y las anule juntas
   cuando corresponda. La protección real contra `voidByReservationId()`
   no es "sin `reservationId`" — es el guard de factura-en-vuelo evaluado
   ANTES de escribir la fila (paso 8-bis, nuevo, ver abajo), que bloquea la
   reversa entera si el `CHARGE` tiene una factura viva o en vuelo; sin el
   paso 8-bis este pin sería insuficiente, con él es necesario y correcto.

   Crea el `ADJUSTMENT` compensatorio contra
   `ar.companyCustomerId`, `amount: -ar.amount` (negativo — ver §4.2,
   corrección del gate), `status: 'SETTLED'` directo, `reversedInvoiceId:
   null` SIEMPRE (invariante que lo excluye de NC, ver §4.2),
   `reservationId: charge.reservationId, stayId: null` (ver corrección de
   arriba — `stayId` sigue en `null` sin cambios, esta fila no participa de
   ningún folio), `reversedTransactionId:
   ar.financialTransactionId` (**el campo que resuelve Finding A** — el
   `CHARGE` original de la empresa que esta fila corrige, mismo mecanismo
   general de `financial_transactions.reversed_transaction_id`, ver §4.2),
   `notes` con el motivo. Ya NO choca con el guard de `insert()`
   (F1-Pieza 2) — `reservationId`/`reversedTransactionId` cuentan como
   documento de origen válido desde `5ae9044`, generalizando el guard en
   vez de necesitar una excepción acotada a este único call site.

   **Paso 8-bis (nuevo — corre entre este paso y la lectura del `CHARGE`
   con lock, antes de escribir cualquiera de los dos `ADJUSTMENT`; cierra
   Finding 1 de raíz, no como parche del pin de arriba).** Reusa el
   predicado ya establecido de `transferStayBalanceToReceivable()`
   (`resolveInvoiceLinkage()` + `classifyReservationLiveInvoice()`,
   `accounts-receivable.service.ts:257-321`) contra el `CHARGE` original:
   si tiene una factura `ISSUED` no reconciliada, o `NOT_ISSUED` con
   estado `PENDING`/`FAILED_UNCERTAIN` (AFIP contactado), lanza
   `ArReversalRequiresCreditNoteError` y no escribe nada. `charge.reservationId`
   se lee con guard explícito (`charge.reservationId ? await
   classifyReservationLiveInvoice(...) : 'NOT_RECONCILED' as const`), nunca
   con `!` — el CHECK de origen en BD permite `<= 1` de los 3 campos de
   origen, así que un `CHARGE` legacy sin `reservationId` es DB-legal
   aunque el guard de aplicación de hoy no debería producir uno nuevo así;
   con `!` el `undefined` coerciona a `NULL` vía el driver y el resultado
   fail-closed sería accidental, no declarado. `resolveInvoiceLinkage()` no
   recibe `client` — corre en una conexión separada del pool del tenant
   mientras la transacción de `reverseTransfer()` sigue abierta en la
   primera (lectura fresca, más nueva que el `ar.status` pre-tx pero no
   transaccionalmente consistente con el lock ya tomado; sin riesgo de
   deadlock, es un `SELECT` sin `FOR UPDATE`) — sexta instancia de la
   deuda de clase `CITY-LEDGER-AR-NESTED-CONN-001`
   (`docs/pendientes-2026-09-12.md`), a registrar en el commit de
   implementación, no acá.

   **Precondición sin guardar todavía (Condición C2 del gate, ronda
   Bloque 3b, 14/09/2026) — a resolver en el Bloque 3c, no acá.**
   `ar.financialTransactionId` es nullable en la interfaz TS
   (`accounts-receivable.repository.ts`) y la columna tiene `ON DELETE
   SET NULL` (a diferencia de `guest_payment_transaction_id`, `ON DELETE
   NO ACTION`) — a diferencia del paso 4 (que sí guarda explícito con
   `ArReversalMissingGuestLinkError` si `guestPaymentTransactionId` es
   `null`), este paso NO tiene guard simétrico si
   `ar.financialTransactionId` fuera `null`. Alcance real hoy: toda AR
   creada por `transferStayBalanceToReceivable()` setea las dos columnas
   juntas, así que el caso "una sí, la otra no" es angosto — pero el tipo
   es nullable, y el Bloque 3c tiene que decidir explícito qué pasa si
   ocurre (guard nuevo simétrico al del paso 4, o alguna otra resolución),
   no asumir que nunca pasa.
6. **Paso nuevo — pata del huésped, sin la cual esta operación no es una
   "reversa completa":** lee la fila `financial_transactions` de
   `ar.guestPaymentTransactionId` (**corrección, Condición C6 del gate,
   ronda 2:** no porque el `customerId` del huésped sea inalcanzable de
   otra forma — `stays.customer_id`, vía `ar.stayId`, también lo da —
   sino porque leer el `PAYMENT` mismo garantiza que el `ADJUSTMENT`
   compensatorio pega exactamente contra el `customerId` que ESE
   `PAYMENT` tocó, sin depender de que el `customerId` de la estadía hoy
   sea el mismo que cuando se transfirió). Crea un SEGUNDO `ADJUSTMENT`
   compensatorio, contra ESE `customerId`,
   `status: 'SETTLED'` directo (a propósito — `getNetBalanceByCustomerId()`
   solo cuenta `SETTLED`; si esta fila naciera `PENDING` reabriría el
   folio vía `getNetBalanceByStayId()`, que SÍ cuenta `PENDING`, pero
   dejaría el saldo por cliente todavía subdeclarado — las dos vistas
   divergirían), `notes: "Reversa de transferencia a cuenta por cobrar —
   empresa ${ar.companyCustomerId}"` (simétrico al `notes` que
   `transferStayBalanceToReceivable()` ya escribe en el `PAYMENT`
   original), `amount: +ar.amount` (POSITIVO — cancela el `-amount` que el `PAYMENT`
   original aporta al agregado, `CASE type WHEN 'PAYMENT' THEN -amount …`,
   mismo docblock de `getNetBalanceByCustomerId()`), `stayId: ar.stayId`
   (a propósito, a diferencia del paso anterior: **REABRE el folio del
   huésped** — es literalmente lo que "Transfer back to folio" significa,
   el huésped vuelve a deber el monto en su propio folio),
   `reservationId: null` (si la reserva se cancela DESPUÉS de la reversa,
   `voidByReservationId()` anularía también esta fila si llevara
   `reservationId`, revirtiendo la reversa misma — mismo riesgo que §1.2
   documenta para el `CHARGE` original), `reversedInvoiceId: null`
   SIEMPRE (mismo invariante que la pata empresa — esta fila tampoco
   participa nunca de una NC), `reversedTransactionId:
   ar.guestPaymentTransactionId` (mismo mecanismo general del paso 5 —
   acá no era estrictamente necesario para pasar el guard, `stayId:
   ar.stayId` ya alcanza, pero se agrega igual por la trazabilidad: sin
   él, esta fila no declara qué corrige, solo la del paso 5 lo haría).
7. `arRepo.markRevertedWithClient(client, id, { reversedBy, reason })` —
   la AR solo guarda el rastro de auditoría (quién, cuándo, por qué). Ya
   NO necesita `reversalTransactionId`/`guestReversalTransactionId` como
   parámetros (esas columnas se retiraron/nunca se agregaron, ver §4.2) —
   la trazabilidad hacia las dos filas compensatorias sale de consultar
   `financial_transactions WHERE reversed_transaction_id IN
   (ar.financialTransactionId, ar.guestPaymentTransactionId)`, no de
   columnas dedicadas en `accounts_receivable`. **Mismo hueco que el paso
   5 (declarado ahí, no repetido acá dos veces):** si
   `ar.financialTransactionId` fuera `null`, ese `IN (...)` simplemente
   matchea menos filas, sin avisar — degradación silenciosa, no falla
   fuerte. Mismo Bloque 3c la tiene que cerrar junto con la precondición
   del paso 5, no por separado.
8. Si `correctedBalance` viene y es `> 0`: reusa la lógica interna de
   `transferStayBalanceToReceivable()` (extraída a un helper privado
   compartido, no duplicada) para crear el `PAYMENT`+`CHARGE`+AR nueva por
   el monto corregido, con `replacesArId: ar.id`. **Nota de secuencia
   (no diseño cerrado, análisis completo queda para el bloque de
   implementación):** este paso corre DESPUÉS del paso 6 — el folio ya
   está reabierto por el monto completo cuando el re-transfer vuelve a
   saldarlo por el monto corregido; si `correctedBalance < ar.amount`, el
   huésped queda debiendo la diferencia en su propio folio, que es el
   comportamiento correcto (esa diferencia nunca debió transferirse). La
   interacción con Q1/`checkOut()` (saldo `PENDING` incluido desde el fix
   de Bloque 1) queda para el S4.0 del bloque de implementación real, no
   para este documento.
9. Devuelve ambas filas (`reverted`, `replacement`).

### 4.4 Ruta — `POST /accounts-receivable/:id/reverse`

**Exige los DOS permisos a la vez (decisión §3.7)** — dos `authorize()`
en cadena, no uno solo. `authorize()` es pertenencia a un conjunto, no
jerarquía (`auth.middleware.ts`): encadenar dos middlewares que cada uno
exige un grupo distinto los combina en AND (Express solo sigue a la
siguiente función si la anterior llamó a `next()`), sin necesidad de un
chequeo inline nuevo.

```
router.post(
  '/:id/reverse',
  authorize(Roles.MANAGEMENT),
  authorize(Roles.EMISOR_NOTA_CREDITO),
  async (req, res, next) => { ... },
);
```

Body: `{ reason: string, correctedBalance?: number }`. `reversedBy` sale de
`req.user!.id` (mismo patrón que `transferredBy` en la ruta de transferencia
original). Documentar en la tabla de permisos del docblock del router
(`accounts-receivable.routes.ts:10-16`) y en
`docs/rbac-matriz-endpoints.md`. **RBAC: son 2 call-sites de `authorize()`
nuevos, no 1** — `EXPECTED_AUTHORIZE_CALL_SITES` +2 (ver §6).

**Dos salvedades sobre este patrón, señaladas por el gate (ronda 2), no
bloqueantes pero a tener presente al implementar:**
- **Sin precedente en el repo.** Grep de todo `*.routes.ts`: 0 ocurrencias
  de dos `authorize(Roles.X)` encadenados sobre la misma ruta hoy — esta
  sería la primera composición AND de grupos de permiso. Nombrarlo como
  tal en el commit real, no presentarlo como un patrón ya establecido.
- **La sección 2 de la matriz no representa un AND.** El formato hoy es
  `- MÉTODO \`path\` — \`GRUPO\`` (un solo grupo por fila).
  `accounts-receivable.routes.ts` está en `EXCLUDED_FILES`
  (`rbac-matrix-section2-sync.test.ts`), así que esta ruta no rompe nada
  todavía — pero el bloque futuro que normalice esos 11 archivos a
  bullets (declarado, sin decidir, en `CLAUDE.md`) va a necesitar decidir
  cómo representar un AND antes de tocar este archivo. La cerca de conteo
  (`rbac-matrix-sync`) sí protege parcialmente el AND (borrar uno de los
  dos `authorize()` baja el conteo y pone la suite roja) pero es más
  débil que `CN-ESCAPE-CONTAINMENT-001` (que congela el GRUPO exacto, no
  solo la cantidad) — evaluar si esta ruta merece el mismo tratamiento
  cuando se implemente.

### 4.5 Detección/visibilidad (mitigación de costo bajo, sin la cual el operador nunca se entera)

Dos puntos donde el sistema ya sabe que puede haber una AR afectada y hoy no
lo dice en ningún lado:

- **`handleReservationCancelled` -- IMPLEMENTADO (Bloque 3a, 13/09/2026,
  gate `architecture-governor`, commit `d48a6e8`).** Después de
  `voidByReservationId()`, si la reserva tiene un `stay_id` con AR
  asociada, loguear estructurado (`evento:
  reservation_cancelled_con_ar_viva`, mismo patrón que `evento:
  cobro_ar_factura_ya_cubierta` en `markCollected()`) — NO bloquea el
  handler, NO revierte automático (la decisión sigue siendo del
  operador; fail-open si la lectura de detección falla). El filtro real
  es `!== 'REVERTIDO'` (cast a `string`), **no** "estados no-terminales"
  como decía una versión anterior de este párrafo -- `COBRADO` está
  INCLUIDO a propósito: una empresa que ya pagó un cargo que el ledger
  acaba de anular es el caso más grave, no uno a excluir. Sin UI nueva en
  este bloque — el log es la mitigación mínima; una alerta/bandeja para
  el operador queda declarada como bloque aparte, no decidida.
  Verificación contra Postgres real pendiente -- ver
  `CITY-LEDGER-BLOQUE3A-INTEGRATION-VERIFY-001` en
  `docs/pendientes-2026-09-12.md`.
- **`handleReservationCompleted` -- IMPLEMENTADO** (`AskUserQuestion`,
  13/09/2026: diseñar la comparación de montos, opción A de las 3
  planteadas; mecanismo en §4.6; implementado en `c9b1fd2`, verificado
  solo a nivel unitario -- ver `CITY-LEDGER-BLOQUE3B-INTEGRATION-VERIFY-001`
  en `docs/pendientes-2026-09-12.md` para la verificación contra Postgres
  real, todavía sin correr). Detección por EXISTENCIA (el mecanismo de
  arriba) NO sirve acá: por construcción, `checkOut()` exige saldo
  `<= 0`, y `transferStayBalanceToReceivable()` es lo que lo habilita --
  o sea que TODA reserva de City Ledger normal llega a `completed` con
  una AR `PENDIENTE_FACTURAR` colgada del stay. Detección por existencia
  dispararía siempre, en el camino feliz, no en una anomalía. La
  anomalía real de este lado es de MONTO (§1.1 Disparador A).
- **Escape de NC de orden -- IMPLEMENTADO** (`CancelOrderWithCreditNoteService`,
  Bloque 6 §9.2, 13/09/2026, commit `0f2aa24`): expone la AR existente
  (`getByStayId`) en la respuesta cuando la haya — ya recomendado en el
  Caso 4 original, mitigación de costo cero. Su gemelo de reservas
  (`CancelReservationWithCreditNoteService`) también lo tiene, mismo
  commit.

### 4.6 Mecanismo — comparación de montos en `handleReservationCompleted` (Bloque 3b, DECIDIDO 13/09/2026, IMPLEMENTADO en `c9b1fd2`, verificado solo a nivel unitario)

**Por qué existencia no alcanza acá, y por qué monto sí.** Toda reserva de
City Ledger normal llega a `completed` con una AR `PENDIENTE_FACTURAR`
colgada del stay (§4.5, bullet 2 de arriba) -- existencia dispararía en el
100% de los casos, sin señalar nada. La anomalía real (§1.1 Disparador A)
es que el ledger de la estadía haya cambiado DESPUÉS de la transferencia:
un segundo `confirmPriceAdjustment()` (`reservation.service.ts:665-762`,
solo aplica a reservas `CONFIRMED`, crea un `ADJUSTMENT` `PENDING` nuevo
con `amount` firmado) que ajusta el total hacia arriba o abajo.

**Mecanismo: recalcular el saldo neto del stay y compararlo contra cero.**
`FinancialTransactionRepository.getNetBalanceByStayId(stayId)`
(`sql.financial-transaction.repository.ts:893-911`) suma
`CHARGE`+`ADJUSTMENT` y resta `PAYMENT` (más `REFUND` sumado) sobre
`PENDING`+`SETTLED`, **filtrando por `WHERE stay_id = $1`** -- corrección
de una versión anterior de este párrafo, que decía "sin filtrar por
`stay_id`". El invariante nace en la TRANSFERENCIA, no en el check-out:
`transferStayBalanceToReceivable()` (`accounts-receivable.service.ts:219`)
lee `balance = getNetBalanceByStayId(stayId)` y crea el `PAYMENT`
sintético por ESE MISMO número. **"0 exacto" es relativo al saldo medido
en esa lectura, no una garantía absoluta**: la lectura (`:219`) ocurre
FUERA de la transacción y ANTES del lock (la transacción abre en `:226`,
el lock de la reserva en `:230`) -- una fila nueva con el mismo `stay_id`
que commitee en esa ventana (ej. un `handleOrderConfirmed` concurrente,
que lockea la ORDEN, no la reserva) queda fuera del `PAYMENT` sintético.
Esto no debilita el mecanismo -- una fila así es plata real sin
compensar, el detector daría un verdadero positivo, no un falso -- pero
no es una garantía transaccional para apoyar algo más duro (un `CHECK`,
un guard bloqueante) el día de mañana. **No es lo mismo que el invariante
de `checkOut()`**: desde el 12/09/2026 `checkOut()` acepta
`overridePendingBalance` (rol MANAGEMENT, `stay.service.ts:250-259`) que
cierra la estadía con saldo positivo a propósito -- el check-out ya NO
garantiza saldo `<= 0` en general, solo la transferencia lo garantiza
para el saldo que efectivamente leyó. Si nada más toca el `stay_id`
después, el saldo medido sigue en `0` para siempre. El
`settleByReservationId()` que corre antes de este bloque **no
cambia el número** (`SET status='SETTLED' WHERE status='PENDING'`, y
`getNetBalanceByStayId` ya suma `PENDING`+`SETTLED` por igual) -- correrlo
antes es disciplina de orden (el trabajo real primero, la detección
después, fail-open), no parte del cálculo.

No hace falta comparar contra `ar.amount` fila por fila: el saldo neto del
stay YA ES la comparación (`ar.amount` es exactamente lo que ese saldo
valía al momento de transferir, y el `PAYMENT` sintético lo dejó en cero
desde ese punto). Evita reabrir la ambigüedad de "¿contra cuál AR, si hay
más de una?" cuando un stay se transfirió más de una vez (no hay `UNIQUE`
sobre `accounts_receivable.stay_id`, `schema.sql`).

**Ubicación exacta:** dentro de `handleReservationCompleted`
(`outbox.handlers.ts:233-316`), DESPUÉS de
`financialRepo.settleByReservationId(reservationId)` (`:246`) -- mismo lugar
relativo que Bloque 3a usa en `handleReservationCancelled` (después de
`voidByReservationId()`), por la misma disciplina de orden. Mismas dos
precondiciones de guarda, en el mismo orden. El wiring del registry no
cruzó ninguna dependencia nueva su borde (`stayRepo`/`accountsReceivableRepo`
ya llegaban a `registerFinancialHandlers`, `outbox.handlers.ts:119` /
`outbox.registry.ts:145`) -- lo que cambió fue la firma de
`handleReservationCompleted` y su call-site (`:151`); al momento de
diseñar esto, ningún test invocaba ese handler, así que el cambio de
firma no rompió nada existente. **Implementado en `c9b1fd2`**, con 12
tests nuevos con mocks (`src/workers/outbox.handlers.test.ts`, describe
`handleReservationCompleted (City Ledger Bloque 3b...)`) -- ver
`CITY-LEDGER-BLOQUE3B-INTEGRATION-VERIFY-001` en
`docs/pendientes-2026-09-12.md` para lo que sigue sin correr contra
Postgres real:
1. `stayRepo.findByReservation(reservationId, event.businessId)` -- si no
   hay stay (reserva sin estadía, o pre-check-in, o la reserva se
   completó ANTES de que existiera transferencia), no hay nada que
   reconciliar, salir.
2. `accountsReceivableRepo.getByStayId(stay.id)`, filtrado `!==
   'REVERTIDO'` (mismo cast, mismo motivo que Bloque 3a) -- si viene
   vacío, este stay nunca se transfirió a una empresa, no hay AR que
   reconciliar, salir.
3. Solo si pasó (1) y (2): `financialRepo.getNetBalanceByStayId(stay.id)`
   -- si `round2(balance) !== 0` (reuso de `src/domain/money.ts::round2`,
   evita falsos positivos por arrastre de punto flotante; sin tolerancia
   adicional tipo `CREDIT_NOTE_COMPENSATION_TOLERANCE` -- esa constante
   absorbe el desfase entre DOS documentos redondeados independientemente
   -- NC vs. factura --, y acá los dos lados salen del mismo `SUM()` de
   una sola query sobre `DECIMAL(12,2)`, sin segundo redondeo que
   absorber; consecuencia aceptada: el detector va a avisar por 1
   centavo, consistente con ser un `warn` que no bloquea nada) --
   loguear estructurado con el monto de la divergencia y las AR
   encontradas. NO bloquea el handler, NO revierte ni ajusta nada --
   mismo principio que Bloque 3a y que el resto de este documento (la
   decisión de reconciliar es del operador, vía el Bloque 2 cuando
   exista).

**Causas reales que mueven el saldo del stay después de una
transferencia** (reemplaza una versión anterior de este párrafo que
nombraba `REFUND` -- ningún productor real de `REFUND` setea `stay_id`:
`cancellation-refund.service.ts:329-342` setea `reservationId`, no
`stayId`, así que un `REFUND` nunca entra en este cálculo): un
`ADJUSTMENT` de precio nuevo (`confirmPriceAdjustment()`, arriba); un
cargo nuevo a la habitación (`handleOrderConfirmed`, `outbox.handlers.ts:676`,
"cargo a la habitación" con `stay_id` seteado); un `CHARGE` de
`approveScheduleChange()` (`stay.service.ts:470`, late check-out/early
check-in); o un `ADJUSTMENT` del escape de NC de una orden de la estadía
(`cancel-order-with-credit-note.service.ts:355`, hereda `stay_id` del
`CHARGE` que revierte).

**Falsos positivos declarados, no resueltos en este bloque (mismo
criterio que Bloque 3a: fallan del lado de avisar de más, no de callar).**
**FP-1:** la transferencia (`stays.routes.ts:203-222`, MANAGEMENT) NO
exige check-out, solo `balance > 0` -- el huésped puede seguir alojado
después de transferido, pedir algo con cargo a la habitación o un late
check-out, y pagarlo él mismo. Ese pago entra por
`CustomerAccountService.recordPayment()` (`customer-account.service.ts:137-152,
265-296`), que **nunca setea `stay_id`** -- no compensa el cargo nuevo a
ojos de este cálculo. El saldo queda positivo permanentemente sin que
nada esté mal en el City Ledger; el detector avisa igual. **FP-2:** si un
MANAGEMENT ya revisó y aceptó un saldo residual al cerrar el check-out
con `overridePendingBalance`, el detector vuelve a levantar la mano sobre
lo mismo sin saber que un humano ya lo miró. Ninguno de los dos invalida
el mecanismo -- la política declarada es "cualquier causa que mueva el
saldo de cero amerita la misma señal" -- pero el mensaje del log tiene
que nombrar LO MEDIDO (el saldo no cerró en cero), no una causa
específica, para no mandar al operador a buscar un problema donde puede
haber sido un desayuno.

**Falsos negativos declarados, no resueltos en este bloque.** **FN-1:**
si `reservation.price_adjusted` falla transitoriamente en el outbox y
`reservation.completed` se procesa primero (el worker no relanza el
evento que falló antes de seguir con el siguiente -- mismo mecanismo que
motivó T-01, `outbox.handlers.ts:703-724`), este detector lee el saldo
ANTES de que el ajuste pendiente llegue, no ve nada, y el ajuste puede
quedar sin liquidar nunca. **FN-2:** si la reserva se completa ANTES de
que exista la transferencia, la precondición 2 sale por vacío y el
mecanismo nunca corre para ese stay -- la ventana de detección es
exactamente "transferencia → completado", que también es la única
ventana en la que puede aparecer un `ADJUSTMENT` nuevo (`confirmPriceAdjustment`
exige `CONFIRMED`). Acotado a propósito, no un hueco a cerrar en este
bloque.

**Concurrencia con Bloque 3a -- descartada, no un caso a manejar.**
`Reservation.ts:77-86`: `CONFIRMED → [CANCELLED, COMPLETED]`, y las dos
transiciones son terminales (`[COMPLETED]: []`, `[CANCELLED]: []`) bajo
el mismo lock (`requireReservationWithLock`). Una reserva no puede emitir
`reservation.completed` Y `reservation.cancelled` -- los dos detectores
nunca corren sobre el mismo stay por el mismo motivo.

**Dependencia real con el Bloque 2, declarada acá, no resuelta:**
`reverseTransfer()` (sin implementar) tiene que crear su contrapartida
CON `stay_id` -- si revierte la transferencia sin compensar el `PAYMENT`
sintético que sí lleva `stay_id`, toda estadía revertida queda con saldo
≠ 0 y este mecanismo dispara en cada una. El filtro `!== 'REVERTIDO'`
cubre el caso "AR completamente revertida" (sale por vacío), no el caso
mixto (una AR revertida + una re-transferida sobre el mismo stay).
Precondición del Bloque 2, no de este.

**Evento propuesto:** `reservation_completed_ar_divergencia` (paralelo a
`reservation_cancelled_con_ar_viva` de Bloque 3a) -- payload: `tenant`,
`reservationId`, `stayId`, `balance` (el saldo neto, con signo --
positivo = la estadía quedó con un cargo sin compensar desde la
transferencia; negativo = un `ADJUSTMENT` de crédito posterior a la
transferencia bajó el saldo -- **nunca** "sobrepago": `chk_financial_transactions_amount`
(`schema.sql:2238-2246`) exige `amount >= 0` salvo `ADJUSTMENT`, así que
un saldo negativo solo puede venir de un `ADJUSTMENT` negativo, jamás de
un pago de más -- el sobrepago es estructuralmente invisible para este
cálculo, ver el hallazgo adyacente más abajo), y la misma proyección de
AR que usa Bloque 3a (`accountsReceivableId`, `companyCustomerId`,
`status`, `amount`). Mensaje del log: describe lo medido ("el saldo neto
de la estadía no quedó en cero después de completar la reserva -- puede
ser un ajuste de precio posterior a la transferencia, un cargo nuevo a la
habitación, o una nota de crédito sobre una orden de la estadía"), nunca
afirma que la AR quedó desalineada como hecho cierto.

**Fail-open, mismo criterio que Bloque 3a:** el trabajo real
(`settleByReservationId()`) ya commiteó antes de este bloque -- una falla
de lectura acá no puede propagar y mandar a reintento algo que ya se
completó. Try/catch envolviendo las 3 lecturas (stay, AR, saldo), con su
propio evento de fallo (`reservation_completed_ar_deteccion_fallida`,
mismo patrón que `reservation_cancelled_ar_deteccion_fallida`).

**Qué NO decide este mecanismo:** no distingue la CAUSA de la divergencia
entre las 4 nombradas arriba -- cualquier causa que mueva el saldo neto
de cero es igual de digna de que el operador la revise, y distinguir
causas sin necesidad real sería diseño especulativo. No resuelve FP-1/FP-2
(silenciar por `overridePendingBalance`, por ejemplo) ni FN-1/FN-2.
Tampoco decide qué hacer con la divergencia (eso es exactamente lo que el
Bloque 2 -- `reverseTransfer()` -- construye).

**Hallazgo adyacente, preexistente, fuera de alcance de este bloque:**
un pago parcial del huésped posterior al check-in tampoco baja
`getNetBalanceByStayId()` (mismo motivo que FP-1: `recordPayment()` no
setea `stay_id`) -- `transferStayBalanceToReceivable()` puede transferir
a la empresa MÁS de lo que el huésped realmente debe. No se toca en este
bloque; ítem propio en `docs/pendientes-2026-09-12.md`, con ancla en
`customer-account.service.ts:137-152` + `sql.financial-transaction.repository.ts:872-880`.

## 5. Mecanismo — FACTURADO/COBRADO (fuera del alcance de este bloque)

Decisión §3.2: enrutan al circuito de NC de escape ya existente
(`cancel-with-credit-note`). Este documento NO diseña código nuevo para
esos dos estados — el trabajo, si hace falta alguno, es verificar que ese
circuito ya maneja correctamente una `accounts_receivable` vinculada
cuando corrige el `financial_transaction_id` que la AR referencia (no
verificado todavía). Bloque aparte, después de que `reverseTransfer()`
(PENDIENTE_FACTURAR) esté en producción y se pueda medir si `FACTURADO`/
`COBRADO` tienen volumen real (residuo de Caso 4, sin decidir: "volumen
real... probablemente 0 en ambos tenants").

## 6. Impacto declarado (`DEFENSIVE_DEVELOPING.md` §2/§3 + matriz completa)

**Matriz original (ronda 1) + los 6 consumidores que el gate
`architecture-governor` encontró y que faltaban — ninguno bloquea el
diseño, pero cada uno necesita su línea de trabajo en el bloque de
implementación real:**

| Ubicación | Qué toca | Riesgo si se ignora |
|---|---|---|
| `src/api/routes/` (ruta nueva `POST /:id/reverse`) | DEFENSIVE_DEVELOPING §3 aplica | — (ya declarado) |
| `req.db` vs pool de plataforma | Sin cambios de wiring — mismo patrón que el resto de `AccountsReceivableService`, `req.db` vía `TransactionManager` inyectado, nunca `getPlatformRawPool()` | — (ya declarado) |
| RBAC (`EXPECTED_AUTHORIZE_CALL_SITES`, `docs/rbac-matriz-endpoints.md`) | **+2 call-sites** (decisión §3.7: `MANAGEMENT` Y `EMISOR_NOTA_CREDITO` en cadena, no 1 solo) | — (ya declarado, número corregido) |
| Schema (`CURRENT_SCHEMA_VERSION`) | v52 (ya aplicado, `b82d828`) para `REVERTIDO`/`reversed_*`/`replaces_ar_id`. **Corrección 14/09/2026 (commit `5ae9044`, Bloque 3a) — reemplaza la corrección del 13/09/2026 de esta misma fila, que quedó vieja el mismo día: NO se agregó `guest_reversal_transaction_id` (superseded, ver §4.2 addendum) — en cambio, v53→v54 sumó `financial_transactions.reversed_transaction_id` (auto-referencial, mecanismo GENERAL de reversa del ledger, no una columna dedicada por pata) y RETIRÓ `accounts_receivable.reversal_transaction_id` (v52, redundante con el campo nuevo). `reverseTransfer()` (Bloque 3c) no debe ningún bump de schema más para esto — el mecanismo ya está completo.** | — (ya declarado, número corregido) |
| `reversed-invoice-id-convention.test.ts::WRITE_SITES` (§7 punto 9) | `3 → 4` — el `ADJUSTMENT` compensatorio de la pata huésped (§4.3 paso 6) escribe `reversedInvoiceId: null` explícito, igual que la pata empresa | Sin actualizar el número, la suite queda roja apenas se implementa — no es opcional |
| **`AccountReceivable` (TS) vs `accounts_receivable` (schema v52)** (hallazgo del gate, ronda 3 de Bloque 3c-ii) | `reversed_by`/`reversed_at`/`reversed_reason`/`replaces_ar_id` existen en `schema.sql` desde v52 pero **cero** ocurrencias en `src/**/*.ts` — ni en la interfaz `AccountReceivable`, ni en `mapRow` de `sql.accounts-receivable.repository.ts`. `markRevertedWithClient()` (paso 7) escribe los primeros 3; el paso 8 (`correctedBalance`) necesita `replacesArId` en `postStayTransfer()` (firma a extender, ya pre-autorizado en el docblock de `49583cc`) y en `createWithClient`. Bloque 3c-ii tiene que declarar explícito si `reversed_by/at/reason` son write-only o si redondean de vuelta a la entidad — no dejarlo implícito, mismo criterio que ya se aplicó a `status` | Mismo modo de falla que el drift que este bloque entero vino a cerrar (`AccountsReceivableStatus` de 3 valores vs. 4 en BD) — repetirlo en 4 columnas más sin declararlo explícito reproduce el problema un nivel más abajo |
| **`sql.accounts-receivable.repository.ts::getReportByPeriod`** | `SUM(ar.amount)` y `COUNT(*)` sin filtro, más 3 `FILTER (WHERE ar.status = ...)` que solo cubren los 3 estados viejos | **Alto** — con `REVERTIDO` sumando al total pero sin bucket propio, `totalAmount ≠ pending+invoiced+collected` en `GET /api/reports/accounts-receivable`, y un par original+reemplazo duplica el total del cierre de mes |
| **`appfrontend-main/src/lib/finanzas/types.ts`** — `AccountsReceivableStatus` (unión de 3 valores) | Contrato cross-repo, sin CI compartida que lo detecte | Rompe en silencio hasta que alguien vea el síntoma en producción |
| **`appfrontend-main/src/app/dashboard/reportes/page.tsx`** — `AR_STATUS_LABEL: Record<AccountsReceivableStatus, string>` | Mapa de labels sin la 4ª clave | Una fila `REVERTIDO` renderiza `undefined` — en blanco, sin crash, mal en silencio |
| **Mismo archivo, botones de acción** | No hay UI para `POST /:id/reverse` en ningún lado de `appfrontend-main` | El mecanismo queda inalcanzable desde el producto — curl únicamente, hasta que se decida construir la UI (ver §7.5) |
| **`rbac-matrix-section2-sync.test.ts`** — `EXCLUDED_FILES['clientes-finanzas/accounts-receivable.routes.ts']` | `hiddenCount: 3` fijo + `docBullets` congelado | Una 4ª ruta protegida pone la suite roja si no se actualiza el número en el mismo commit |
| **`docs/inventario-rutas.md`** | Inventario de existencia (`CONTRACT-COVERAGE-001`) | Queda stale hasta `npm run docs:routes` |
| **Mount de `app.ts`** — `requireModule(CUENTAS_CORRIENTES)` | La ruta nueva hereda ese gate de módulo, no solo el rol | Un tenant sin el módulo recibe 404/403 antes de llegar al chequeo de rol — declarar esto explícito, no asumirlo |
| **`InvoiceService.requestConsolidatedInvoice()`** (hallazgo del gate, ronda 2) | Segundo escritor concurrente sin lock: lee `getPendingByCompanyCustomerId()` SIN lock, emite una factura AFIP real (CAE, irreversible), y recién después marca cada AR `FACTURADO` con `UPDATE ... WHERE status = 'PENDIENTE_FACTURAR'` best-effort (0 filas si ya cambió, sin log) | **Crítico** — si `reverseTransfer()` toma el lock de una AR y commitea ENTRE la lectura y el `markInvoiced` de este camino, AFIP ya emitió una factura real por un monto que el ledger ya revirtió, sin ningún rastro (el `UPDATE` no afecta filas y no hay `catch` que lo note). `arRepo.lockForUpdate()` de `reverseTransfer()` NO serializa contra este camino porque este camino nunca toma ese lock. Ver §7, pregunta de concurrencia ampliada |
| **`InvoiceService.finalizeIssued()`** (hallazgo del gate, ronda 3 — TERCER escritor, más silencioso que el anterior) | Camino PER-RESERVATION de emisión (`POST /api/invoices` → `requestInvoice()` → `issue()`/`reconcileAfterFailure()`, `invoice.service.ts:1160-1176`), distinto de `requestConsolidatedInvoice()` (que cierra sus N filas aparte porque llega con `financialTransactionId` nulo). Emite el CAE AFIP primero, y DESPUÉS: `const ar = await getByFinancialTransactionId(...); if (ar && ar.status === 'PENDIENTE_FACTURAR') { await markInvoiced(...) }` | **Más grave que `requestConsolidatedInvoice()`:** acá no hay ni siquiera el `UPDATE` best-effort — es un `if` en memoria. Si `reverseTransfer()` ya commiteó `REVERTIDO` antes de que este `if` corra, la condición simplemente no entra, `markInvoiced` nunca se llama, y el `catch` que envuelve el bloque (`logger.error('no se pudo cerrar el gap de accounts_receivable')`) NUNCA se dispara porque no hay ninguna excepción — el `if` que no entra no es un error. Factura fiscal real emitida contra un cargo ya revertido, CERO rastro en logs. Ver §7.2(b), ampliada para cubrir los dos caminos |
| **`listByCompany()`/`getByCompanyCustomerId()`** (hallazgo del gate, ronda 2) | Sin filtro de `status` — devuelve TODO, incluido `REVERTIDO` una vez que exista | Decidido (§3.8, §7 punto 8): sin filtro nuevo, se muestra con estado visible. No requiere cambio del contrato HTTP de listado -- SÍ requiere ampliar el union TS y `AR_STATUS_LABEL` de la pantalla que ya consume este listado en `appfrontend-main`, junto con el Bloque 2 (`ACCOUNTS-RECEIVABLE-STATUS-REVERTIDO-TS-001`) |

## 7. Preguntas abiertas (algunas para el dueño, algunas para el gate — marcadas cada una)

1. **Gate, resuelta.** Los dos `authorize()` de la ruta nueva (`MANAGEMENT`
   Y `EMISOR_NOTA_CREDITO`, decisión §3.7) SON call-sites estándar →
   `EXPECTED_AUTHORIZE_CALL_SITES` +2 (número real de base a confirmar
   contra el archivo al momento de implementar) + fila en la matriz +
   `EXCLUDED_FILES.hiddenCount` de `accounts-receivable.routes.ts` 3 → 4.
   La asimetría de roles que motivó esta pregunta ya no aplica — exigir
   los dos permisos a la vez la cierra por construcción (ver punto 6 más
   abajo, resuelto).
2. **Gate, re-encuadrada por el gate (ronda de HOLD), AMPLIADA en la ronda 2
   con un segundo escritor — ninguno de los dos se resuelve en este
   documento, quedan para el bloque de implementación real.**
   - **(a) `voidByReservationId()` vs. `reverseTransfer()`.** No es "¿hace
     falta lock cruzado para una edición de `amount`?" (el `CHARGE` nunca
     se edita, eso ya lo sabíamos). El riesgo real es de CONCURRENCIA:
     `voidByReservationId()` (disparado por `handleReservationCancelled`,
     un worker de outbox) puede estar anulando el MISMO `CHARGE` original
     al `VOIDED` en el mismo instante en que `reverseTransfer()` corre —
     dos reversas del mismo cargo, una desde el camino de cancelación de
     reserva, otra desde este mecanismo nuevo. Hace falta un lock sobre la
     fila `financial_transactions` del `CHARGE` original
     (`SELECT ... FOR UPDATE`) DENTRO de la transacción de
     `reverseTransfer()`.

     **Ampliado (Condición D del gate, 13/09/2026, tras la corrección de
     §4.3 que agrega la pata del huésped):** este análisis hablaba solo
     del `CHARGE` de la empresa — con el paso 6 nuevo de §4.3, el
     `PAYMENT` sintético del huésped (`ar.guestPaymentTransactionId`) es
     igualmente sujeto de la reversa, y en teoría el mismo riesgo de
     concurrencia aplica de ese lado. **Corrección (Condición C1 del gate,
     ronda 2, 13/09/2026):** una versión anterior de este párrafo decía
     que `voidByReservationId()` "no filtra por `type`" — falso, y además
     mezclaba dos hallazgos distintos: el de §1.2 es sobre el filtro de
     `customer_id` que falta, no de `type`. El `UPDATE` real de
     `voidByReservationId()` restringe explícito a
     `ft.type IN ('CHARGE', 'ADJUSTMENT')` (todo lo demás cae en su
     contador de diagnóstico `tipo_no_liquidable`), con un fix de
     producción del 23/08/2026 documentado en el propio docblock del
     método — "NO toca `PAYMENT`/`REFUND`". El `PAYMENT` del huésped está
     protegido por DOS hechos independientes, no uno: nunca lleva
     `reservationId` (`transferStayBalanceToReceivable()`) Y su `type` lo
     excluye estructuralmente de ese `UPDATE`. Hoy no hay ningún camino
     conocido que anule ese `PAYMENT` concurrentemente con
     `reverseTransfer()`. Queda para el bloque de implementación real, no
     resuelto acá — la ausencia de riesgo conocido HOY no es garantía de
     que no aparezca uno nuevo si el diseño de `PAYMENT` cambia.

     **Nota `DEFENSIVE_DEVELOPING.md` §3, declarada (no "sin impacto" por
     accidente):** el paso 6 de §4.3 necesita leer la fila
     `financial_transactions` de `ar.guestPaymentTransactionId` para
     resolver el `customerId` del huésped. `FinancialTransactionRepository`
     no expone una variante `WithClient` de esa lectura (solo `getById`,
     sobre el pool del tenant) — así que esa lectura corre FUERA de la
     transacción de `reverseTransfer()`, sobre el pool normal, no sobre
     el `client` de la tx. Benigno en la práctica (la fila es `SETTLED` e
     inmutable, R12, sin lectura sucia posible), pero es una decisión a
     declarar explícita en el commit real, mismo criterio que la adopción
     de huérfanos de `transferStayBalanceToReceivable()` (fuera de tx a
     propósito, ya documentada como tal en ese método).
   - **(b) LOS DOS caminos de emisión de factura AFIP, no solo uno —
     hallazgo ampliado en la ronda 3 del gate: no es solo concurrencia,
     son dos caminos que emiten un documento fiscal REAL sin ningún
     lock.**
     - **`InvoiceService.requestConsolidatedInvoice()`** (consolidada, N
       filas de AR a la vez): lee `getPendingByCompanyCustomerId()` sin
       lock, emite la factura AFIP (CAE, irreversible), y recién después
       hace `UPDATE accounts_receivable SET status='FACTURADO' WHERE
       id=$1 AND status='PENDIENTE_FACTURAR'` por fila, best-effort — si
       `reverseTransfer()` ya commiteó esa AR a `REVERTIDO` en el medio,
       el `UPDATE` no afecta ninguna fila y ni siquiera loguea el
       desajuste (no lanza, así que el `try/catch` que lo rodea nunca se
       entera).
     - **`InvoiceService.finalizeIssued()`** (per-reservation, `POST
       /api/invoices` → `requestInvoice()` → `issue()`/
       `reconcileAfterFailure()`, `invoice.service.ts:1160-1176`) — más
       silencioso todavía: acá ni siquiera hay un `UPDATE`, es un `if (ar
       && ar.status === 'PENDIENTE_FACTURAR')` en memoria. Si
       `reverseTransfer()` ya commiteó antes, el `if` simplemente no
       entra — `markInvoiced` nunca se llama y el `catch` que envuelve el
       bloque no se dispara porque no hay ninguna excepción. Factura
       fiscal real contra un cargo ya revertido, CERO rastro en logs.
     El lock de `reverseTransfer()` sobre la fila AR **no sirve contra
     ninguno de los dos** — ninguno de los dos caminos toma ese lock, así
     que no hay nada que serializar. Cerrar esto puede exigir tocar el
     propio camino de emisión AFIP en los dos lugares (leer bajo lock
     antes de emitir, o re-chequear el estado DESPUÉS de emitir y antes
     de dar la factura por buena) — un cambio sobre una ruta que emite
     documentos fiscales reales merece su PROPIO gate, no se resuelve
     como efecto colateral de este bloque.
   Los dos (a y b) quedan pendientes de diseñar en el bloque de
   implementación real, con su propio gate si tocan código fuera de
   `AccountsReceivableService`.
3. **Gate, resuelta:** la extracción del helper compartido con
   `transferStayBalanceToReceivable()` (paso 6 de §4.3) es un **refactor
   previo, en su propio commit, sin cambio de comportamiento**, probado
   por la suite existente de `accounts-receivable.service.test.ts` antes
   de escribir una sola línea del mecanismo nuevo — refactor y
   comportamiento nuevo en el mismo commit destruye la propiedad de
   "el diff es la evidencia" que este repo usa para revisar.
4. **Dueño, resuelta (§3.5) — mecanismo corregido en la ronda 2 del gate:**
   la fila `ADJUSTMENT` compensatoria de una reversa `PENDIENTE_FACTURAR`
   queda EXCLUIDA de la construcción de Nota de Crédito. El gate encontró
   que el filtro por `reversal_transaction_id` que proponía la ronda 1 era
   innecesario — la exclusión ya es estructural (`reversedInvoiceId: null`
   más el guard de `buildCreditNote()` y el scope de las 16 queries de
   `sql.invoice.repository.ts`, ver §4.2). Se declara como invariante +
   test, no como filtro nuevo.
5. **Dueño, resuelta (§3.6):** sin UI en `appfrontend-main` por ahora —
   follow-up sin fecha. `POST /:id/reverse` se dispara por `curl`/Postman
   hasta que se decida construir la pantalla.
6. **Dueño, resuelta (§3.7):** la ruta de reversa exige los DOS permisos a
   la vez (`MANAGEMENT` Y `EMISOR_NOTA_CREDITO`, dos `authorize()` en
   cadena — §4.4), no se acepta la asimetría. Cierra por construcción el
   caso `RECEPTIONIST` (tiene `EMISOR_NOTA_CREDITO`, no `MANAGEMENT`) y el
   caso simétrico (rol custom con `MANAGEMENT` sin `EMISOR_NOTA_CREDITO`)
   — ninguno de los dos, solo, alcanza para ejecutar la reversa.
7. **Nueva (hallazgo del gate, ronda 2), técnica — resuelta acá, no
   escalada al dueño porque es plomería interna, no comportamiento
   visible para el negocio.** ¿Qué documento de origen lleva el
   `ADJUSTMENT` compensatorio — `reservationId` (como el `CHARGE` que
   revierte), `stayId`, o ninguno? Las 3 opciones tienen un modo de falla
   real: `reservationId` expone la fila al bug de `voidByReservationId()`
   (§1.2) — si la reserva se cancela DESPUÉS de la reversa, ese camino
   anularía también la fila compensatoria, revirtiendo la reversa misma
   mientras la AR queda `REVERTIDO`; `stayId` reabre el folio del
   huésped, exactamente el efecto que el `CHARGE` original evita omitiendo
   ese campo (`accounts-receivable.service.ts`, bloque `companyChargeId`);
   ninguno de los dos pierde la trazabilidad de documento de origen
   (F1-Pieza 2). **Resolución:** `reservationId: null, stayId: null` —
   **legal**: el CHECK `chk_financial_transactions_order_or_reservation`
   (`schema.sql`, BLOQUE 22) es `(...) <= 1` — "como máximo uno", no
   "exactamente uno" — así que ambos NULL a la vez no viola nada (si
   hubiera sido `= 1`, esta resolución habría roto un CHECK de producción
   sin que nadie lo notara hasta el primer `INSERT`). La trazabilidad no
   se pierde porque ya existe un camino mejor:
   `accounts_receivable.reversal_transaction_id` (§4.2) apunta a esta
   fila exacta, y `accounts_receivable.stay_id` (columna ya existente)
   sigue siendo la trazabilidad de la AR hacia la estadía — y
   `CustomerAccountService.getStatement()` lee por `customer_id`, sin
   filtrar por origen, así que la fila compensatoria aparece igual en la
   cuenta corriente de la empresa, que es donde el operador la tiene que
   ver. Sin comportamiento visible divergente para el negocio, no
   ameritaba `AskUserQuestion` — es plomería interna.

   **REABIERTO (Finding A del gate `architecture-governor`, 13/09/2026,
   ronda "Design gate: ADR §4.3 guest-leg correction") — la resolución de
   arriba es INSERTABLE-FALSA, no solo "sin comportamiento visible
   divergente".** La cita a "F1-Pieza 2" del párrafo anterior hablaba de
   trazabilidad documental como convención, no del guard real que la
   aplica en código. Ese guard existe, es un `throw` de aplicación (no
   solo el CHECK de Postgres que este punto sí verificó), y vive en
   `SqlFinancialTransactionRepository.insert()` (buscar el texto *"un
   {tx.type} necesita al menos un documento de origen"*, no citar por
   línea — mismo criterio `SCHEMA-ANCHOR-DRIFT-001`): rechaza CUALQUIER
   `CHARGE`/`ADJUSTMENT` con `reservationId`, `orderId` Y `stayId` los
   tres `null` a la vez. El CHECK de Postgres (`<= 1`, "a lo sumo uno")
   permite `null/null`; este guard de aplicación NO — exige `>= 1`, no
   `<= 1`. La resolución `reservationId: null, stayId: null` de este
   punto viola ese guard: `reverseTransfer()`, implementado tal como este
   documento lo describe hoy, lanzaría ese `Error` en el paso 5 de §4.3
   en CADA llamada, antes de llegar siquiera al paso 6 nuevo. Verificado
   además que el guard está vivo, no dormido: los dos escritores de
   `ADJUSTMENT` que ya existen en el repo (`cancel-reservation-with-credit-note.service.ts`
   / `cancel-order-with-credit-note.service.ts`) siempre setean
   `reservationId` y/o `stayId` — ninguno prueba el camino `null/null`.

   **Opciones — el dueño pidió grounding ERP sobre este caso completo
   (14/09/2026, `AskUserQuestion`: "Grounding para todo el caso
   abordado") antes de elegir, mismo patrón ya usado para "declarar vs.
   alinear" en `ASYMMETRY-001` — no es una decisión tomada todavía, es un
   pedido de más evidencia. Grounding pendiente de despachar/completar;
   estas 3 son las opciones sobre la mesa, no una lista final:**
   - **(a) Setear `reservationId` en la pata empresa** — la MENOS novedosa
     de las tres: mismo patrón exacto que ya usan los dos escritores de
     `ADJUSTMENT` existentes en el repo
     (`cancel-reservation-with-credit-note.service.ts`,
     `cancel-order-with-credit-note.service.ts`), sin tocar ningún guard
     compartido. El costo: reabre exactamente el riesgo que este punto
     había descartado — si la reserva se cancela DESPUÉS de la reversa,
     `voidByReservationId()` (§1.2) anularía también esta fila
     compensatoria, revirtiendo la reversa misma mientras la AR queda
     `REVERTIDO` — un estado inconsistente sin que nada lo detecte.
   - **(b) Sancionar una excepción explícita y acotada en el guard de
     `insert()`** para este único write site (mismo espíritu que otras
     excepciones ya documentadas en el repo, ej. el acoplamiento
     sancionado `RESERVA-10` en `sql.financial-transaction.repository.ts`),
     apoyada en el argumento que este mismo punto ya hizo: la
     trazabilidad real no depende del documento de origen clásico para
     esta fila — `accounts_receivable.reversal_transaction_id` /
     `guest_reversal_transaction_id` (§4.2 addendum) ya apuntan a ella
     desde la AR, un camino más específico que `reservationId`/`stayId`.
     Requiere tocar código de un guard compartido (`insert()`), que
     revisa TODO `CHARGE`/`ADJUSTMENT` del repo, no solo el de este
     bloque — el riesgo a pesar antes de elegir esta opción es que la
     excepción quede mal acotada y abra la puerta a otros callers sin
     documento de origen por accidente.
   - **(c) `stayId` en la pata empresa, no `orderId` sintético — con un
     costo real ya identificable, no "no evaluado".** `accounts-receivable.service.ts`
     ya documenta en código por qué el `CHARGE` original de la empresa
     omite `stayId` a propósito: `getNetBalanceByStayId()` suma por
     `stay_id` SIN filtrar por `customer_id` (bloque `companyChargeId`),
     así que una fila de la EMPRESA con `stayId` seteado se sumaría al
     folio del HUÉSPED. Para el `ADJUSTMENT` compensatorio (negativo,
     `-ar.amount`) el efecto es el mismo problema en sentido inverso: si
     esta pata llevara `stayId: ar.stayId`, restaría del folio del
     huésped exactamente cuando el paso 6 lo está reabriendo con
     `+ar.amount` — cancelándolo parcial o totalmente sin que sea la
     intención. Esta opción compite en desventaja con (a)/(b), no es una
     alternativa neutral — se deja registrada para que el grounding la
     pueda descartar con este argumento en vez de "no evaluado".
   Ninguna de las tres se implementa sin que el grounding + decisión del
   dueño cierren esto — este bloque no arranca código hasta resolver.

   **CERRADO (14/09/2026, commit `5ae9044`, Bloque 3a) — ni (a), ni (b),
   ni (c).** El grounding pedido (Odoo/ERPNext verificados en código real:
   `reversed_entry_id`/`reversal_of`, auto-referencia dentro del propio
   ledger) más la pregunta directa del dueño ("¿por qué no adoptamos ese
   patrón directo, en vez de excepcionar el guard puntual?") llevaron a
   una **cuarta opción**, superior a las tres originales: generalizar el
   guard de `insert()` para aceptar un documento de origen de LEDGER
   (`reversedTransactionId`, campo nuevo auto-referencial en
   `financial_transactions` — ver §4.2), no solo de negocio
   (`reservationId`/`orderId`/`stayId`). Con esto:
   - (a) queda descartada — el riesgo de `voidByReservationId()` que
     motivó reabrir este punto nunca se corre, `reservationId` sigue en
     `null` en los dos `ADJUSTMENT` compensatorios (§4.3 pasos 5 y 6).
   - (b) queda superada — no hace falta una excepción puntual a este
     único call site: el guard se generaliza para cualquier reversa
     futura del ledger, no solo la de este bloque, con el CHECK de BD
     (`type = 'ADJUSTMENT'` únicamente) sosteniendo el límite en vez de
     un `if` de excepción a mano.
   - (c) queda sin necesidad de evaluarse — el argumento que la
     descartaba (colisión con `getNetBalanceByStayId()`) seguía siendo
     válido, pero ya no hacía falta elegir entre las tres: la cuarta
     opción no tiene ese costo.
   Detalle completo, verificación del gate y las 2 condiciones que aplicó
   (una de schema — evitar agregar y borrar `reversal_transaction_id` en
   la misma corrida de `schema.sql`; una de documentación — declarar esta
   misma ventana de deriva): mensaje del commit `5ae9044`.

   **CORRECCIÓN 14/09/2026 (gate `architecture-governor`, ronda 3 de
   Bloque 3c-ii, Finding 1) — el punto "(a) queda descartada" de arriba ya
   NO es correcto para la pata EMPRESA.** La cuarta opción (campo
   auto-referencial) resuelve el problema de TRAZABILIDAD de origen —
   deja de depender de `reservationId`/`stayId` para pasar el guard de
   `insert()` — pero no resuelve, por sí sola, el riesgo de asimetría de
   `voidByReservationId()` que motivó descartar (a): ese riesgo depende de
   si el `ADJUSTMENT` LLEVA o no `reservationId`, no de si lo NECESITA
   para pasar el guard. Con `reservationId: null` en la pata empresa (como
   este punto cerró), una cancelación posterior de la reserva anula el
   `CHARGE` original (si no tiene factura viva) pero nunca alcanza al
   `ADJUSTMENT` compensatorio — deuda fantasma de signo invertido, mismo
   patrón que `ASYMMETRY-001`, verificado en el gate de ronda 3. La
   resolución final, ver §4.3 paso 5: la pata EMPRESA SÍ lleva
   `reservationId: charge.reservationId` (variante de la opción (a),
   readmitida para esta pata únicamente), protegida por un guard nuevo
   (paso 8-bis, factura-en-vuelo) que bloquea la reversa entera si el
   `CHARGE` tiene una factura viva o en curso — la combinación de (a)
   parcial + 8-bis es la que efectivamente cierra Finding A, no el campo
   auto-referencial solo. La pata HUÉSPED (paso 6) SÍ mantiene
   `reservationId: null` sin cambios — su riesgo era el inverso (ver
   razonamiento en §4.3 paso 5) y la cuarta opción sí lo resuelve completo
   ahí, sin necesitar 8-bis para esa pata.
8. **Dueño, resuelta (§3.8, ronda 3, 13/09/2026):** `listByCompany()`/
   `getByCompanyCustomerId()` no filtran por `status` — una vez que
   `REVERTIDO` exista, aparece igual que cualquier otra fila en el panel
   de gestión de cuentas por cobrar de una empresa. La pregunta era si el
   panel debía mostrar las revertidas (con su estado visible, para no
   esconder que hubo una corrección), filtrarlas por default, o marcarlas
   distinto de alguna forma. Decidido: mostrar, con estado visible, sin
   agregar filtro nuevo al contrato de listado — el tratamiento visual
   distinto queda como decisión de UI de `appfrontend-main`, no de este
   mecanismo. Bloque 2 de §8 ya puede escribir el contrato de la API de
   listado sin esta pregunta pendiente.
9. **Técnica, resuelta acá (13/09/2026) — representación, no
   comportamiento visible para el negocio.** ¿El `ADJUSTMENT`
   compensatorio escribe `reversedInvoiceId: null` explícito, o lo omite
   (el campo es opcional)? **Resolución: explícito, `reversedInvoiceId:
   null` SIEMPRE** (ya así en §4.2/§4.3, sin cambio) — no por
   default del lenguaje, a propósito. Costo verificado:
   `src/tests/architecture/reversed-invoice-id-convention.test.ts` define
   `WRITE_RE` sobre el literal `reversedInvoiceId:` seguido de cualquier
   valor (incluido `null`) excluyendo declaraciones de tipo — un write
   explícito de `null` SÍ matchea `WRITE_RE` y hace falta sumar el
   archivo nuevo a `WRITE_SITES` (`3 → 4`) y el mismo write tiene que
   setear `type: 'REFUND'` o `'ADJUSTMENT'` (lo hace: `'ADJUSTMENT'`, dos
   veces — pata empresa y pata huésped). **Condición E del gate
   (13/09/2026), no cubierta por el párrafo original:** el mismo test
   también aserta `expect(WRITE_SITES.length).toBe(3)` (guard
   anti-vacuidad, aparte del array) — ese literal tiene que pasar a `4`
   EN EL MISMO commit, o la suite queda roja aunque el array ya tenga la
   entrada nueva. Dos ediciones en ese archivo, no una. Se prefiere explícito sobre
   omitir porque es exactamente el caso que ese test existe para
   vigilar: un campo que decide si una fila puede terminar en una Nota de
   Crédito es más seguro escrito a la vista, con la cerca reaccionando a
   propósito, que dejado a que el default de TypeScript lo resuelva en
   silencio.
10. **Técnica, resuelta acá (13/09/2026) — formato, no comportamiento
    visible.** La sección 2 de `docs/rbac-matriz-endpoints.md` no tenía
    forma de representar un AND de dos grupos en una fila (formato hoy:
    `- MÉTODO \`path\` — \`GRUPO\``, un solo grupo). `accounts-receivable.routes.ts`
    sigue en `EXCLUDED_FILES` de `rbac-matrix-section2-sync.test.ts`
    (prosa, no bullets parseables) — este bloque no rompe esa cerca
    todavía, pero el bullet que documenta la ruta a mano en la sección 2
    sí necesita un formato consistente para cuando ese archivo se
    normalice. **Resolución: `` `GRUPO_A` **Y** `GRUPO_B` ``** (dos
    grupos entre backticks, conector en negrita) — mismo espíritu que el
    formato prosa ya usado para un AND condicional en
    `invoices.routes.ts` (línea 178 de la matriz: "`FRONT_DESK` (+
    `requireModule(FACTURACION)`; … exige **además** `MANAGEMENT`…)"),
    adaptado a un AND incondicional de dos `authorize()` reales. Aplicar
    este formato a la fila nueva de `POST /:id/reverse` en el bloque de
    implementación (§4.4/§6) y dejarlo como convención para la próxima
    vez que una ruta encadene dos `authorize()`.
11. **Dueño, pendiente de acuse (Condición F del gate, 13/09/2026) —
    consecuencia visible para el negocio, no plomería.** El paso 6 nuevo
    de §4.3 REABRE el folio del huésped (`stayId: ar.stayId` en el
    `ADJUSTMENT` de la pata huésped). Una estadía con una transferencia a
    City Ledger ya está normalmente `CHECKED_OUT` (la transferencia es lo
    que habilitó ese check-out con saldo `<= 0`) — después de la reversa,
    es una estadía CERRADA con saldo POSITIVO otra vez, visible en
    `StayService.getFolio()`. No rompe ningún invariante
    (`overridePendingBalance` ya permite saldo ≠ 0 en una estadía
    cerrada), pero §3.6 ya decidió que no hay UI para disparar
    `POST /:id/reverse` — así que tampoco hay pantalla que le muestre a
    nadie ese saldo reabierto ni un camino para cobrarlo. Sin UI en este
    bloque (decisión ya tomada, no se reabre), pero el dueño tiene que
    tener presente esta consecuencia antes de autorizar el mecanismo: hoy
    la única forma de que alguien vea ese saldo es yendo a buscarlo a
    mano (`GET` del folio, o el propio log de auditoría de la reversa).

## 8. Bloques de implementación sugeridos (orden, no decisión)

1. Schema v52 (nuevo estado + columnas) — bloque propio, gate propio. El
   `ALTER`/guard de `chk_accounts_receivable_status` va DESPUÉS del
   `CREATE TABLE IF NOT EXISTS accounts_receivable` en `schema.sql` (ya
   es así en §4.2) — un tenant nuevo instala el CHECK inline de 3 valores
   primero y depende de ese orden para terminar en 4. Este bloque es
   inerte en producción hasta que exista `reverseTransfer()`: ninguna
   fila puede llegar a `REVERTIDO` solo con el schema — ni la
   concurrencia de §7.2 ni el filtro de listado de §7.8 son alcanzables
   todavía, no hace falta resolverlas antes de este bloque.
2. `AccountsReceivableService.reverseTransfer()` + ruta + RBAC + tests.
   **El union TS `AccountsReceivableStatus` se mueve ACÁ, no en el
   bloque 1** — vive en dos repos sin CI compartida
   (`src/clientes-finanzas/accounts-receivable.repository.ts` y
   `appfrontend-main/src/lib/finanzas/types.ts`); ampliar el backend
   antes de tener el mecanismo real que produce `REVERTIDO` reproduciría
   el modo de falla de `ROLES-CATALOG-DRIFT-001` (un catálogo que cambia
   de un lado sin que el otro se entere). Los dos se actualizan juntos,
   en este bloque -- junto con `AR_STATUS_LABEL` y los otros
   consumidores de estado de `reportes/page.tsx`, ver §6 y
   `ACCOUNTS-RECEIVABLE-STATUS-REVERTIDO-TS-001` en
   `docs/pendientes-2026-09-12.md` para el detalle completo, no
   duplicado acá.
3. Detección/visibilidad en los 2 handlers de outbox (§4.5). **Los dos
   lados ya se hicieron, separados y ANTES del Bloque 2** -- ninguno
   dependía de `reverseTransfer()` para tener sentido, a diferencia de lo
   que este punto asumía: `handleReservationCancelled` (Bloque 3a,
   13/09/2026, `d48a6e8`) y `handleReservationCompleted` (Bloque 3b,
   13/09/2026, diseño en §4.6, implementado en `c9b1fd2`) -- verificación
   contra Postgres real de los dos, todavía pendiente, ver
   `CITY-LEDGER-BLOQUE3A-INTEGRATION-VERIFY-001` y
   `CITY-LEDGER-BLOQUE3B-INTEGRATION-VERIFY-001` en
   `docs/pendientes-2026-09-12.md`.
4. Bug colateral `voidByReservationId()` sin filtro de `customer_id`
   (§1.2) — bloque independiente, no bloquea 1-3.
5. FACTURADO/COBRADO (§5) — diferido, sin decisión de si se construye.
6. Guard de facturación previa a la transferencia + exposición del
   escape de NC (§9) — encontrado por el gate `architecture-governor`
   durante Bloque 5 (Caso 5 residual 3, 12-13/09/2026), independiente de
   1-5, no depende de `reverseTransfer()`. **Implementado:** §9.2
   (exposición, `0f2aa24`/`04da4b4`) y §9.1 (guard duro, `d75296a`) — ver
   ambas secciones más abajo. §9.4 (tercera ubicación del mismo concepto,
   del lado de la emisión — exposición, decisión del dueño "Exponer, no
   bloquear", commit `bc5cb46`) también implementada — ver esa sección
   más abajo. Estado de push de estos 4 commits: consultar
   `git log origin/main --oneline | grep <hash>` en el momento, no
   asumirlo de este texto.

## 9. Guard de facturación previa (Bloque 6, 13/09/2026)

**Hallazgo (gate `architecture-governor`, verificando el Caso 5 residual
3 de Bloque 5):** `cancelReservationWithCreditNote()` no filtra por
`customer_id` al traer los cargos de una reserva
(`getByReservationId()` es `WHERE reservation_id = $1`, sin más) — así
que si la estadía de esa reserva ya se transfirió a una empresa
(`AccountsReceivableService.transferStayBalanceToReceivable()`), el
`CHARGE` de la empresa entra en el mismo cálculo. Combinado con el
`PAYMENT` sintético que la transferencia crea contra el huésped (satura
su folio a $0 sin plata real), el escape de NC puede generarle al
huésped un `ADJUSTMENT` (crédito) por una factura cuyo cargo original ya
fue neutralizado por el traspaso — crédito fantasma, mientras el
`CHARGE` de la empresa sigue vivo sin tocarse. El mismo hueco existe en
`cancelOrderWithCreditNoteService()` (órdenes cargadas a una estadía
también llevan `stayId`).

Medido contra el código real (no solo inferido): hoy hay **3 sub-casos**
distintos, no uno — `PENDIENTE_FACTURAR` y `FACTURADO`-manual
(`markInvoiced()` sin factura AFIP real) dejan pasar el crédito fantasma
en silencio; `FACTURADO`-consolidada (`requestConsolidatedInvoice()`) ya
bloquea hoy, mismo por accidente, con
`CreditNoteReservationMultiInvoiceError` — mensaje equivocado ("elegí
qué factura revertir" en vez de "hay una deuda corporativa viva").

**Grounding ERP** (Cloudbeds, Oracle OPERA, Odoo, ERPNext, Dolibarr,
QloApps — `auditor-circuitos-erp`, 12/09/2026): ningún sistema de
referencia corrige los dos lados automático. Cloudbeds es el único que
modela el traspaso como transferencia reversible con vínculo bidireccional
al folio de origen (`"Route" bloqueado si la transacción está "Locked"
por un comprobante fiscal vivo`); su guard vive del lado de la
TRANSFERENCIA, no de la Nota de Crédito. Odoo/ERPNext/Dolibarr no
bloquean la NC — la dejan proceder y exponen el desbalance resultante
para que un humano lo cierre (ERPNext: *Unreconcile Payment*, v15;
Dolibarr: conversión a descuento con `fk_soc`/`fk_facture_source`
apuntando siempre al tercero y factura de origen). Ningún sistema deja
que el crédito caiga en la contraparte equivocada — pero la razón de
fondo (el "pago" que saldó la factura del huésped fue plata real en los
5 sistemas) no aplica acá: el `PAYMENT` de este repo es sintético.

**Decisiones del dueño (`AskUserQuestion`, 13/09/2026):**

1. **Guard en la transferencia — SÍ, bloquear.**
   `transferStayBalanceToReceivable()` rechaza si algún `CHARGE` de la
   estadía ya tiene una factura `ISSUED` viva al huésped (mismo criterio
   que "Locked transaction" de Cloudbeds) — previene que el estado malo
   se forme. No contradice la decisión §3.2 (esa decisión es sobre
   corregir una AR ya existente, no sobre crear una nueva).
2. **Guard en la NC — exponer, no bloquear.** Para el caso que el guard
   de arriba NO cubre (se transfiere SIN invoice previo, y recién
   después se factura al huésped): la NC procede igual (§3.2 ya decide
   que `FACTURADO`/`COBRADO` usan este escape), pero se detecta la AR
   viva para esa estadía y se expone -- mismo patrón que
   `AccountsReceivableService.markCollected()` (campo `collection`
   aditivo + `logger.warn`) -- para que management lo revise.

### 9.1 Mecanismo — guard de transferencia (implementado, commit `d75296a`; extendido a facturas en vuelo, commit `b09555a`)

**Corrección del gate (ronda 1, 13/09/2026):** el predicado original
(`resolveInvoiceLinkage() === ISSUED`) es MÁS ANGOSTO que la definición
de "comprobante vivo" que este repo ya usa para esta pregunta exacta —
no mira si la factura ya fue revertida al 100% por NC. Falso positivo
concreto: una orden de POS cargada a la estadía, facturada y CANCELADA
CON NC (factura totalmente compensada) antes de intentar la
transferencia — con el predicado angosto, `transferStayBalanceToReceivable()`
queda bloqueada PARA SIEMPRE, sin ningún camino de salida (no existe
"des-emitir"). El guard hermano de reservas (`findBlockingInvoiceLinkage()`,
RESERVA-10) usa el mismo predicado angosto, así que "ISSUED pelado" es
consistente con los guards existentes pero NO con la corrección fiscal —
dos respuestas razonables, no algo que el implementador deba resolver
solo (mismo criterio que D5, `CLAUDE.md` raíz). **Decisión del dueño
(`AskUserQuestion`, 13/09/2026): predicado FUERTE — reusar
`InvoiceRepository.classifyReservationLiveInvoice()`/`classifyOrderLiveInvoice()`**
(`RECONCILED` | `NOT_RECONCILED`, ya combinan F4 + reversa del ledger
`SETTLED` — el mismo predicado que el escape de NC ya usa para saber si
un `CARGO_CON_COMPROBANTE_VIVO` es una anomalía real o un caso
reconciliado, ver `outbox.handlers.ts`).

Consecuencia mecánica de elegir el predicado fuerte (declarada por el
gate): `classify*` recibe un `SqlClient`, así que el guard corre DENTRO
de la transacción (no antes de abrirla, como decía la versión anterior
de este texto) y `AccountsReceivableService` necesita ampliar su
`Pick<InvoiceRepository, ...>` inyectado (hoy
`'getOutstandingForUpdate' | 'resolveInvoiceLinkage'`) con
`'classifyReservationLiveInvoice' | 'classifyOrderLiveInvoice'` — 8
sitios de construcción (2 producción, 6 test).

En `AccountsReceivableService.transferStayBalanceToReceivable()`: dentro
de la transacción, con `reservationRepo.getByIdWithLock(client, stay.reservationId)`
como primera operación (serializa contra `InvoiceService.requestInvoice()`,
que toma el mismo lock — `invoice.service.ts:451-453`/`:604-606` — mismo
patrón que `reservation.service.ts:858-862` ya documenta), traer los
`CHARGE` de la estadía y, para cada uno:

1. **Pre-filtro, load-bearing, no cosmético — `resolveInvoiceLinkage(charge.id)` primero.**
   Si no da `ISSUED`, `continue` sin llamar a `classify*`. Es obligatorio
   llamarlo ANTES de `classify*`, no en paralelo ni como optimización:
   `classifyReservationLiveInvoice()`/`classifyOrderLiveInvoice()` devuelven
   `NOT_RECONCILED` en DOS casos distintos que el nombre no distingue — "hay
   una Factura B viva sin compensar" Y "nunca se facturó nada" (fail-closed
   documentado en el propio docblock del método). Sin este pre-filtro,
   `classify*` solo bloquearía TODA transferencia, incluida la inmensa
   mayoría de estadías que nunca tuvieron una factura — no un caso raro, el
   camino normal. Cubierto por un test que lo prueba de verdad (no solo que
   pasa): `invoiceRepo.classifyCalls` en 0 cuando no hay ningún `ISSUED`, y un
   segundo test que fija `NOT_RECONCILED` para esa misma reserva a propósito
   — si el pre-filtro se borrara, ESE test fallaría (verificado por mutación,
   condición C1 del gate, 13/09/2026).
2. **Solo si hay un `ISSUED`**, `classifyReservationLiveInvoice()`/
   `classifyOrderLiveInvoice()` según tenga `reservationId` u `orderId`. Si
   da `NOT_RECONCILED` (factura viva, no compensada), lanzar
   `StayChargeAlreadyInvoicedError(stayId, invoiceId, 'ISSUED')` — nueva
   clase, mismo archivo que `CompanyCustomerRequiredError`/`NoBalanceToTransferError`,
   mapeada a 422 en `error.middleware.ts` (mismo grupo que
   `COMPANY_CUSTOMER_REQUIRED`/`CREDIT_NOTE_*`: "documento fiscal ya
   emitido, acción no completa, no reintentar"). El 3er parámetro
   (`invoiceStatus`, unión angosta `'ISSUED' | 'PENDING' | 'FAILED_UNCERTAIN'`)
   se agregó en la extensión "en vuelo" de más abajo -- el mensaje de este
   caso se conserva verbatim, no se degradó a uno genérico.
2-bis. **`NOT_ISSUED` EN VUELO -- extensión resuelta (13/09/2026, commit
   `b09555a`, decisión del dueño vía `AskUserQuestion`, ver antes "Fuera de
   alcance" más abajo, ahora cerrado).** Si `linkage.kind === 'NOT_ISSUED'`
   y (`status === 'PENDING'`, o `status === 'FAILED_UNCERTAIN'` con
   `afipContacted: true`), bloquea directo -- **sin** llamar a `classify*`
   para esta rama: ese método pregunta "¿esta Factura B YA VIVA fue
   compensada al 100% por NC?", y sobre un comprobante que ni siquiera se
   sabe si AFIP emitió no hay nada que reconciliar. Mismo predicado exacto
   que el guard hermano `ReservationService.findBlockingInvoiceLinkage()`
   (`reservas/reservation.service.ts:864-875`). `REJECTED` nunca bloquea
   (ni acá ni en el hermano) -- AFIP ya dijo que no.
   Lanza `StayChargeAlreadyInvoicedError(stayId, invoiceId, linkage.status)`.
   **Camino de salida de cada estado (doctrina de la ronda 1 -- nada
   bloquea sin salida):** `PENDING` se resuelve a `ISSUED` (vía
   `retryExisting()`, idempotente por `invoice:<ftId>` -- una fila
   `PENDING` huérfana por un proceso muerto se destraba reintentando la
   emisión, no queda huérfana para siempre) o a `REJECTED` (deja de
   bloquear); `FAILED_UNCERTAIN` con `afipContacted` se destraba con la
   reconciliación humana que este repo ya modela para ese estado.
   **No se unifica con el guard de `markInvoiced()`/`markCollected()`** de
   este mismo archivo (que sí bloquean con CUALQUIER `NOT_ISSUED`, incluido
   `REJECTED`) -- miran un SUJETO distinto: ahí es
   `ar.financialTransactionId` (el CHARGE contra la EMPRESA que este mismo
   método crea), acá son los CHARGE del HUÉSPED. Predicados distintos a
   propósito, no una inconsistencia a limpiar.
   **Efecto colateral positivo, verificado por el gate, no buscado:** para
   cargos ligados a una reserva, el lock de `reservations` que ya toma este
   guard (ver más abajo) también serializa contra la ventana COMMITTEADA en
   la que `InvoiceService.requestInvoice()` deja la factura en `PENDING`
   mientras espera la respuesta de AFIP (dentro del mismo
   `transactionManager.run()` que toma el lock de `reservations` antes de
   insertar la fila de `invoices` -- `invoice.service.ts::requestInvoice()`,
   sin cita de línea a propósito, ver nota de anclaje más abajo) -- cierra
   buena parte del residuo de concurrencia declarado más abajo para el
   camino reserva. No cambia nada para cargos de orden ni solo-estadía.
   **Límite cerrado (13/09/2026, gate `architecture-governor`, commit
   `ea3e4a1`):** este predicado ya tenía, al momento de este commit
   (`b09555a`), CERO cobertura de integración contra Postgres real ni
   prueba de la carrera real contra un `requestInvoice()` concurrente --
   toda la evidencia era unitaria sobre fakes. Confirmado contra Postgres
   real y con un test de concurrencia con brazo de control, ver
   `docs/resuelto.md`, `CITY-LEDGER-GUARD-INVOICE-INFLIGHT-VERIFY-001`.
3. **Cargo *solo-estadía* (sin `reservationId` NI `orderId` — legal por el
   CHECK `chk_financial_transactions_order_or_reservation`: "a lo sumo
   uno", no "exactamente uno") con un `ISSUED` encima: fail-closed, bloquea
   sin camino de salida.** No hay entidad (reserva/orden) contra la cual
   llamar `classify*`, así que no se puede distinguir "vivo" de "ya
   reconciliado" — se trata como vivo. Es la misma clase de bloqueo
   permanente que el dueño rechazó en la ronda 1 de este mismo bloque (ver
   más arriba), en versión angosta: mitigado HOY porque **ningún camino de
   producción crea un CHARGE solo-estadía** — los 4 sitios de creación
   (`stay.service.ts:471`, `outbox.handlers.ts:192`/`:206`,
   `accounts-receivable.service.ts:264`) siempre setean `reservationId` u
   `orderId`. Defensivo, no un riesgo vivo — pero si algún día un camino
   nuevo crea un cargo solo-estadía facturable, este guard lo bloquearía sin
   salida y hay que revisarlo antes, no después (registrado como pendiente,
   ver `docs/pendientes-2026-09-12.md`, `CITY-LEDGER-GUARD-STANDALONE-CHARGE-001`).

**Residuo de concurrencia declarado, no cerrado por este bloque — corregido
13/09/2026, y de nuevo tras la revisión de cierre de la extensión "en
vuelo" (mismo día, gate `architecture-governor`, commit `b09555a` +
follow-up de docs):** el único lock que este guard toma es `reservations`
(`stay.reservationId`).

Para cargos ligados a una **reserva**, cuando `requestInvoice()` corre
PRIMERO (ya tomó el lock, la transferencia queda esperando), ese lock
cierra la carrera en las dos ventanas de ESA dirección: el `INSERT`
inicial en `PENDING` (dentro del mismo `transactionManager.run()` que
toma el lock de `reservations` -- el commit de esa transacción, no una
línea puntual, es el borde real donde la fila `PENDING` queda visible
para otra conexión; ancla por método, `invoice.service.ts::requestInvoice()`,
no por rango de línea -- corregido 13/09/2026, gate
`architecture-governor`, la cita anterior a `:450-488` había quedado
desactualizada por `bc5cb46`) y el `ISSUED` final tras confirmar con
AFIP -- la extensión "en vuelo"
de 2-bis hace que la ventana `PENDING` committeada también quede
cubierta, no solo el estado final. **Esto son dos ventanas de la MISMA
dirección (`requestInvoice()` primero), no "las dos direcciones que
importan" como afirmaba una versión anterior de este párrafo** -- esa
frase fue un error de esta misma sesión, encontrado por el gate al
revisar el cierre.

**La dirección contraria -- la transferencia corre PRIMERO -- ya no
carece de señal, pero sigue sin guard, por decisión del dueño.**
`transferStayBalanceToReceivable()` toma el lock, no ve ninguna factura
(todavía no existe ninguna), crea el `PAYMENT` del huésped + el `CHARGE`
de la empresa + la fila de AR, y commitea. `InvoiceService.requestInvoice()`
corre DESPUÉS, sobre el MISMO cargo del huésped -- sus únicos guards
siguen siendo la idempotencia propia, `resolveInvoiceLinkage()` sobre ese
mismo `ftId`, y los guards de orden/reserva `CANCELLED`
(`invoice.service.ts:344-457`); **ninguno bloquea si la estadía ya se
transfirió a una empresa.** Sale una Factura B al huésped por un cargo
cuyo saldo económico ya está en la cuenta corriente de la empresa -- el
mismo crédito fantasma que este bloque entero (§9) existe para prevenir,
por la dirección que §9.1 no cubre. Preexistente desde el diseño
original de §9.1, no introducido por la extensión "en vuelo" -- esa
extensión angosta la ventana de una dirección, nunca ensancha la otra.
El dueño decidió (`AskUserQuestion`, "Exponer, no bloquear") no cerrar
esto con un guard sino con exposición -- ver §9.4 más abajo (implementado,
commit `bc5cb46`). Cerrado en ese sentido en
`docs/resuelto.md` (`CITY-LEDGER-GUARD-INVOICE-ORDER-OPEN-001`, `bc5cb46`);
el residuo de `retryExisting()` que §9.4 no cierra queda en
`docs/pendientes-2026-09-12.md`, `CITY-LEDGER-GUARD-RETRY-EMITS-001`.

Los cargos ligados a una **orden** (`orderId`) siguen sin quedar
serializados en ninguna dirección -- `requestInvoice()` para una orden
lockea `orders`, no `reservations`, y este guard no toma ese lock. Los
cargos *solo-estadía* tampoco tienen agregado que lockear. Para esos dos
casos el guard sigue siendo best-effort (lee sin lock propio), y la red
real contra la carrera es §9.2 (expone, no previene). No se agrega lock
de `orders` a la transferencia en este bloque (el orden canónico de
locks está documentado en `invoice.service.ts:585` y tocarlo es su
propio gate).

### 9.2 Mecanismo — exposición en el escape de NC (implementado, commit `0f2aa24`)

En los dos orquestadores (`cancel-reservation-with-credit-note.service.ts`
y `cancel-order-with-credit-note.service.ts`), DENTRO de tx1 (no antes),
justo después de resolver `stayId` (ya lo hacen los dos, para heredarlo
en el `ADJUSTMENT`) y antes de crear/adoptar el `ADJUSTMENT`: si
`stayId !== null` y el nuevo `accountsReceivableRepo` (opcional, 7°
parámetro del constructor) está presente, `arRepo.getByStayId(stayId)`
(tipo compartido `AccountsReceivableRepoForCancel`/`AccountsReceivableWarningEntry`
en `cancel-with-credit-note.ts`, wireado en `reservations.routes.ts`/
`orders.routes.ts` con `new SqlAccountsReceivableRepository(db)`),
filtrando `(ar.status as string) !== 'REVERTIDO'` (cast a `string`, NO se
amplía `AccountsReceivableStatus` en este bloque — ver comentario en el
código, mismo criterio que evitó `ROLES-CATALOG-DRIFT-001`: el tipo se
amplía junto con `reverseTransfer()`, Bloque 2 de §8). Si queda alguna
fila: se agrega al resultado (`accountsReceivableWarning`) y
`logger.warn({ evento: 'nc_escape_con_ar_viva', ... })` — no lanza, no
bloquea.

**Correcciones del gate aplicadas (ronda 1, condiciones del commit 1):**
1. `reservations.routes.ts` serializa campo por campo
   (`res.json({ reservation: toReservationDto(...), ... })`, nunca
   `res.json(result)`) — se agregó `accountsReceivableWarning` ahí
   explícito; sin este cambio quedaba descartado en silencio del lado
   reservas mientras órdenes (que sí hace `res.json(result)`) lo
   exponía — asimetría entre los dos escapes.
2. El fast-path idempotente de los dos orquestadores retorna ANTES de
   tx1 -- `stayId` nunca se resuelve ahí, así que ese camino nunca emite
   el warning (declarado en el código, no un vacío accidental).
3. **Corregido en ronda 2** (el texto original de esta condición
   afirmaba de más): la lectura se LLAMA adentro del callback de tx1,
   después del lock (`FOR UPDATE` de `reservations`/N10 de `orders`), pero
   `AccountsReceivableRepoForCancel.getByStayId()` NO recibe `client` --
   usa su propia conexión del pool del tenant, no la de la transacción.
   Lo que el lock SÍ garantiza: una `transferStayBalanceToReceivable()`
   concurrente que necesite el mismo lock no puede commitear mientras tx1
   sigue abierta -- el valor forense no se pierde por esa carrera. Lo que
   NO garantiza: la lectura no ve escrituras sin commitear de tx1 ni
   participa de su rollback -- da igual hoy (solo lectura). Mismo patrón
   sin `client` que otras 4 lecturas ya existentes de ese mismo tx1 -- no
   es una clase de riesgo nueva, pero queda como deuda con ancla (ver
   `docs/pendientes-2026-09-12.md`, `CITY-LEDGER-AR-NESTED-CONN-001`):
   convertir las 5 a `*WithClient()`
   (convención `createWithClient()` que el repo ya usa) es su propio
   bloque.
4. **La superficie real HOY es solo el `logger.warn`** — cero
   referencias a estos dos escapes en `appfrontend-main/src` (verificado
   por el gate, ronda 1 Y ronda 2). El campo en la respuesta HTTP existe
   para cuando exista una UI, no hay ninguna consumiéndolo todavía.
5. **Agregado en ronda 2** (hallazgo del gate: "62 tests pasaron sin
   tocar los archivos de test" probaba ausencia de regresión, no que la
   rama nueva funcionara -- ningún fake pasaba el 7° parámetro del
   constructor, `accountsReceivableRepo` era `undefined` en el 100% de
   las 2158+304 pruebas): `undefined`, NUNCA `[]`, normalizado en los dos
   servicios antes de devolver -- sin esto, cualquier estadía SIN AR (el
   caso mayoritario) serializaba `"accountsReceivableWarning": []` en vez
   de omitir la clave, 3 estados en vez de los 2 que el docblock ya
   declaraba. Y 6 tests unitarios nuevos (3 por orquestador, con un fake
   `AccountsReceivableRepoForCancel`) que SÍ ejercitan la rama: AR viva →
   entrada expuesta; solo `REVERTIDO` → filtrada, `undefined`; sin
   `stayId` → `undefined` sin consultar el repo.

### 9.3 Fuera de alcance de este bloque

- Reversar la AR de verdad (`reverseTransfer()`) sigue siendo el Bloque 2
  de §8 — la exposición de 9.2 es forense, no corrige nada por sí sola.
- No se toca `PENDIENTE_FACTURAR` del lado de la NC más allá de la
  exposición de 9.2 — el guard de 9.1 es lo que previene la mayoría de
  los casos nuevos hacia adelante.
- UI del frontend para mostrar `accountsReceivableWarning` — bloque
  aparte, no decidido.
- Corregir el mensaje de `CreditNoteReservationMultiInvoiceError` para
  el caso "hay deuda corporativa viva" (el gate lo identificó como
  bloqueo accidental con diagnóstico equivocado) — bloque aparte.

### 9.4 Tercera ubicación — exposición en la emisión (implementado, commit `bc5cb46`)

El gate identificó una TERCERA ubicación del mismo concepto que ni 9.1
(guard en la transferencia) ni 9.2 (exposición en la NC) previenen: un
guard del lado de la EMISIÓN ("no facturar al huésped un cargo de una
estadía YA transferida a una empresa"). Cubre el orden inverso — se
transfiere primero (sin invoice), y DESPUÉS alguien factura al huésped —
que 9.1 no ve (no había invoice todavía al momento de transferir) y que
9.2 solo expone, no previene.

**Decisión del dueño (13/09/2026, `AskUserQuestion`, tras un agente de
investigación que confirmó el mecanismo real y armó las opciones):
"Exponer, no bloquear"** — mismo tratamiento que §9.2. La Factura B (o la
NC) sale igual, es un documento fiscal real y AFIP no sabe nada de la
cuenta corriente interna; se expone un campo aditivo +
`logger.warn({ evento: 'factura_con_ar_viva', ... })` para revisión
manual de management.

**Mecanismo (`InvoiceService.requestInvoice()`), 1 ronda de gate
(HOLD → APPROVED WITH CONDITIONS):**
- `Pick<AccountsReceivableRepository, ...>` inyectado suma
  `'getByStayId'`.
- Tipo de retorno aditivo `RequestInvoiceResult extends Invoice { accountsReceivableWarning?: AccountsReceivableWarningEntry[] }`
  — mismo patrón que `AccountReceivableMarkCollectedResult` (§F1-Pieza 3)
  y que §9.2, reusando LOS MISMOS 2 tipos que §9.2 ya definió
  (`cancel-with-credit-note.ts:53-61`), sin duplicarlos.
- `resolveAccountsReceivableWarning(tx)`, privado, llamado justo después
  de resolver `tx` (antes del fork `tx.type === 'REFUND'/'ADJUSTMENT'`):
  `getByStayId(tx.stayId)`, filtra `!== 'REVERTIDO'`, normaliza
  `undefined` — nunca `[]` — si no hay nada que revisar.
- **Acotado a Factura B normal, a propósito — NO aplica a Nota de
  Crédito** (`tx.type` `REFUND`/`ADJUSTMENT`, `return undefined`
  explícito como primera línea del método). El gate encontró en la ronda
  de diseño que cubrir NC acá duplicaría el campo en el MISMO payload
  HTTP: los 2 orquestadores del escape con NC (§9.2) heredan `stayId` en
  el `ADJUSTMENT` que crean y YA calculan/exponen este mismo warning por
  su propio camino (`creditNote.accountsReceivableWarning` +
  `result.accountsReceivableWarning` hermano, calculados por 2 caminos
  distintos) — rompería el contrato "presente si y solo si hay algo que
  revisar" que §9.2 ya documentó. El único productor de `REFUND` del
  repo (`cancellation-refund.service.ts`) nunca setea `stayId`, así que
  el método corta ahí igual. El hueco angosto que queda (facturar un
  `ADJUSTMENT` huérfano, nunca facturado por ninguno de los 2
  orquestadores, directo por `POST /api/invoices`) es territorio de
  `docs/diseno-salida-manual-nc-y-reapertura-b3-2026-09-12.md:274`, que
  ya planea tocar `requestInvoice()` — no se cierra acá.
- **Sin filtro redundante `ar.financialTransactionId !== tx.id`.** El
  `CHARGE` que `transferStayBalanceToReceivable()` crea contra la
  EMPRESA nunca lleva `stayId` (a propósito, `accounts-receivable.service.ts:292-315`,
  invariante fijado por test en `accounts-receivable.service.test.ts:320`)
  — facturar ESE cargo (el camino legítimo, F1-Pieza 3/C1-Fase C) nunca
  llega con `tx.stayId` no nulo, así que el `if (!tx.stayId) return undefined;`
  ya lo excluye. Un filtro redundante ahí sería código muerto sin cerca
  que lo pruebe — el gate pidió sacarlo y anclar el invariante real en un
  comentario en su lugar.
- Evento de log propio, `factura_con_ar_viva` — NO reusa
  `nc_escape_con_ar_viva` (§9.2), son 2 mecanismos distintos y las
  consultas de log tienen que poder separarlos.

**Residuo declarado, no cerrado en este bloque (el gate lo encontró y
ofreció como alternativa a cerrarlo acá):** `retryExisting()` (el
fast-path idempotente de `requestInvoice()`, que corre ANTES de resolver
`tx`) puede terminar emitiendo el comprobante de verdad si el estado
previo es `PENDING`, `REJECTED`, o `FAILED_UNCERTAIN` sin `afipContacted`
— no solo devolver un comprobante ya `ISSUED` como en §9.2. Escenario
real: factura rechazada por AFIP (`REJECTED`, sin AR todavía) →
transferencia corre después (§9.1 no bloquea `REJECTED`) → reintento del
mismo POST → `retryExisting()` → `issue()` real, sin warning ni log. Ver
`docs/pendientes-2026-09-12.md`, `CITY-LEDGER-GUARD-RETRY-EMITS-001`.

**Tests:** 6 nuevos en `invoice.service.test.ts` (con AR viva → warning +
log; sin AR → `undefined`, clave ausente, sin log; `REVERTIDO` →
filtrada; sin `stayId` (cargo de la empresa) → `undefined`, ni siquiera
consulta el repo; `ADJUSTMENT` con AR viva → no expone, no consulta;
`REFUND` con AR viva → no expone, no consulta). Mutación verificada dos
veces: sacar el scoping NC pone en rojo exactamente los 2 tests de
NC; sacar la normalización a `undefined` pone en rojo exactamente los 2
tests que esperan la clave ausente. 8 fakes de `AccountsReceivableRepository`
en tests actualizados con `getByStayId` (1 unitario + 7 de integración,
todos no-op salvo el unitario). Suite completa 2190/2190 (+6), sin
regresión. *(La suite de integración no se cita acá a propósito -- los 7
stubs tocados por este commit son no-op y no la mueven; cualquier
conteo de integración pertenece al commit que efectivamente la
modifique, no a este.)*

**Sin cobertura de integración contra Postgres real específica de este
campo** (el predicado depende del SQL real de `getByStayId()`), ni
prueba end-to-end por HTTP — declarado, no cerrado
(`CITY-LEDGER-GUARD-INVOICE-EMIT-VERIFY-001`,
`docs/pendientes-2026-09-12.md`).

**Sin superficie de UI, declarado:** `accountsReceivableWarning` (acá y en
§9.2) tiene 0 consumidores en `appfrontend-main/src` — la exposición
llega solo a logs de servidor y al JSON crudo de la respuesta; management
no tiene todavía una pantalla que se lo muestre
(`CITY-LEDGER-GUARD-NO-UI-SURFACE-001`, `docs/pendientes-2026-09-12.md`).

**Predicado "AR viva" triplicado, declarado:** el mismo filtro
`status !== 'REVERTIDO'` + mapeo a `AccountsReceivableWarningEntry` vive
3 veces (orden NC, reserva NC, y este método) sin extraer a un helper
compartido (`CITY-LEDGER-GUARD-AR-VIVA-PREDICATE-TRIPLE-001`,
`docs/pendientes-2026-09-12.md`).
