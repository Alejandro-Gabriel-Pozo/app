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
1. `arRepo.lockForUpdate(client, id)` — mismo patrón de concurrencia que
   `markCollected()` (evita una reversa y un `markCollected()` concurrentes
   sobre la misma fila).
2. Guard: si `ar.status === 'FACTURADO' || ar.status === 'COBRADO'` →
   `throw new ArReversalRequiresCreditNoteError(id, ar.status)` — enruta al
   circuito de NC existente (decisión §3.2), este método NO los maneja.
3. Guard: si `ar.status === 'REVERTIDO'` → idempotente, devuelve el estado
   actual sin re-ejecutar (mismo criterio que `markCollected()` sobre
   `COBRADO`).
4. Crea el `ADJUSTMENT` compensatorio contra `ar.companyCustomerId`,
   `amount: -ar.amount` (negativo — ver §4.2, corrección del gate),
   `reversedInvoiceId: null` SIEMPRE (invariante que lo excluye de NC, ver
   §4.2), `notes` con el motivo. Campo de documento de origen
   (`reservationId`/`stayId`): ver §7 pregunta nueva, sin resolver.
5. `arRepo.markRevertedWithClient(client, id, { reversedBy, reason,
   reversalTransactionId })`.
6. Si `correctedBalance` viene y es `> 0`: reusa la lógica interna de
   `transferStayBalanceToReceivable()` (extraída a un helper privado
   compartido, no duplicada) para crear el `PAYMENT`+`CHARGE`+AR nueva por
   el monto corregido, con `replacesArId: ar.id`.
7. Devuelve ambas filas.

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

- **`handleReservationCompleted`/`handleReservationCancelled`**
  (`outbox.handlers.ts`): después de `settleByReservationId()`/
  `voidByReservationId()`, si la reserva tiene un `stay_id` con AR asociada
  (`arRepo.getByStayId(stayId)`, filtrando estados no-terminales), loguear
  estructurado (mismo patrón que `evento: cobro_ar_factura_ya_cubierta` en
  `markCollected()`) — NO bloquear el handler, NO revertir automático (la
  decisión sigue siendo del operador). Sin UI nueva en este bloque — el log
  es la mitigación mínima; una alerta/bandeja para el operador queda
  declarada como bloque aparte, no decidida.
- **Escape de NC de orden** (`CancelOrderWithCreditNoteService`): exponer
  la AR existente (`getByStayId`) en la respuesta cuando la haya — ya
  recomendado en el Caso 4 original, mitigación de costo cero.

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
| Schema (`CURRENT_SCHEMA_VERSION`) | v51 → v52 | — (ya declarado) |
| **`sql.accounts-receivable.repository.ts::getReportByPeriod`** | `SUM(ar.amount)` y `COUNT(*)` sin filtro, más 3 `FILTER (WHERE ar.status = ...)` que solo cubren los 3 estados viejos | **Alto** — con `REVERTIDO` sumando al total pero sin bucket propio, `totalAmount ≠ pending+invoiced+collected` en `GET /api/reports/accounts-receivable`, y un par original+reemplazo duplica el total del cierre de mes |
| **`appfrontend-main/src/lib/finanzas/types.ts`** — `AccountsReceivableStatus` (unión de 3 valores) | Contrato cross-repo, sin CI compartida que lo detecte | Rompe en silencio hasta que alguien vea el síntoma en producción |
| **`appfrontend-main/src/app/dashboard/reportes/page.tsx`** — `AR_STATUS_LABEL: Record<AccountsReceivableStatus, string>` | Mapa de labels sin la 4ª clave | Una fila `REVERTIDO` renderiza `undefined` — en blanco, sin crash, mal en silencio |
| **Mismo archivo, botones de acción** | No hay UI para `POST /:id/reverse` en ningún lado de `appfrontend-main` | El mecanismo queda inalcanzable desde el producto — curl únicamente, hasta que se decida construir la UI (ver §7.5) |
| **`rbac-matrix-section2-sync.test.ts`** — `EXCLUDED_FILES['clientes-finanzas/accounts-receivable.routes.ts']` | `hiddenCount: 3` fijo + `docBullets` congelado | Una 4ª ruta protegida pone la suite roja si no se actualiza el número en el mismo commit |
| **`docs/inventario-rutas.md`** | Inventario de existencia (`CONTRACT-COVERAGE-001`) | Queda stale hasta `npm run docs:routes` |
| **Mount de `app.ts`** — `requireModule(CUENTAS_CORRIENTES)` | La ruta nueva hereda ese gate de módulo, no solo el rol | Un tenant sin el módulo recibe 404/403 antes de llegar al chequeo de rol — declarar esto explícito, no asumirlo |
| **`InvoiceService.requestConsolidatedInvoice()`** (hallazgo del gate, ronda 2) | Segundo escritor concurrente sin lock: lee `getPendingByCompanyCustomerId()` SIN lock, emite una factura AFIP real (CAE, irreversible), y recién después marca cada AR `FACTURADO` con `UPDATE ... WHERE status = 'PENDIENTE_FACTURAR'` best-effort (0 filas si ya cambió, sin log) | **Crítico** — si `reverseTransfer()` toma el lock de una AR y commitea ENTRE la lectura y el `markInvoiced` de este camino, AFIP ya emitió una factura real por un monto que el ledger ya revirtió, sin ningún rastro (el `UPDATE` no afecta filas y no hay `catch` que lo note). `arRepo.lockForUpdate()` de `reverseTransfer()` NO serializa contra este camino porque este camino nunca toma ese lock. Ver §7, pregunta de concurrencia ampliada |
| **`InvoiceService.finalizeIssued()`** (hallazgo del gate, ronda 3 — TERCER escritor, más silencioso que el anterior) | Camino PER-RESERVATION de emisión (`POST /api/invoices` → `requestInvoice()` → `issue()`/`reconcileAfterFailure()`, `invoice.service.ts:1160-1176`), distinto de `requestConsolidatedInvoice()` (que cierra sus N filas aparte porque llega con `financialTransactionId` nulo). Emite el CAE AFIP primero, y DESPUÉS: `const ar = await getByFinancialTransactionId(...); if (ar && ar.status === 'PENDIENTE_FACTURAR') { await markInvoiced(...) }` | **Más grave que `requestConsolidatedInvoice()`:** acá no hay ni siquiera el `UPDATE` best-effort — es un `if` en memoria. Si `reverseTransfer()` ya commiteó `REVERTIDO` antes de que este `if` corra, la condición simplemente no entra, `markInvoiced` nunca se llama, y el `catch` que envuelve el bloque (`logger.error('no se pudo cerrar el gap de accounts_receivable')`) NUNCA se dispara porque no hay ninguna excepción — el `if` que no entra no es un error. Factura fiscal real emitida contra un cargo ya revertido, CERO rastro en logs. Ver §7.2(b), ampliada para cubrir los dos caminos |
| **`listByCompany()`/`getByCompanyCustomerId()`** (hallazgo del gate, ronda 2) | Sin filtro de `status` — devuelve TODO, incluido `REVERTIDO` una vez que exista | Ver §7, pregunta nueva sobre si el panel de gestión de AR debe mostrar las revertidas, filtrarlas, o marcarlas distinto |

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
8. **Nueva (hallazgo del gate, ronda 2), para el dueño:** `listByCompany()`/
   `getByCompanyCustomerId()` no filtran por `status` — una vez que
   `REVERTIDO` exista, aparece igual que cualquier otra fila en el panel
   de gestión de cuentas por cobrar de una empresa. ¿El panel debe
   mostrar las revertidas (con su estado visible, para no esconder que
   hubo una corrección), filtrarlas por default, o marcarlas distinto de
   alguna forma? Sin decidir — bloque 2 de §8 no puede escribir la UI (ni
   siquiera el contrato de la API de listado) sin esto.

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
   en este bloque.
3. Detección/visibilidad en los 2 handlers de outbox (§4.5) — puede ir en
   el mismo bloque que 2, o separado si el gate prefiere acotar el radio.
4. Bug colateral `voidByReservationId()` sin filtro de `customer_id`
   (§1.2) — bloque independiente, no bloquea 1-3.
5. FACTURADO/COBRADO (§5) — diferido, sin decisión de si se construye.
6. Guard de facturación previa a la transferencia + exposición del
   escape de NC (§9) — encontrado por el gate `architecture-governor`
   durante Bloque 5 (Caso 5 residual 3, 12-13/09/2026), independiente de
   1-5, no depende de `reverseTransfer()`. **Implementado, commiteado,
   sin pushear todavía:** §9.2 (exposición, `0f2aa24`/`04da4b4`) y §9.1
   (guard duro, `d75296a`) — ver ambas secciones más abajo. §9.4 (tercera
   ubicación del mismo concepto, del lado de la emisión — exposición,
   decisión del dueño "Exponer, no bloquear", commit `bc5cb46`) también
   implementada — ver esa sección más abajo.

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
