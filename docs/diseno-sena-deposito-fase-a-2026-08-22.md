# Diseño — Seña/depósito, Fase A (núcleo sin gateway)

Resuelve **C1** (`pendientes-2026-08-22.md`) en su primera fase. El pedido
original del dueño llegó como un documento propio y mucho más grande que
C1 —`spec-cobro-facturacion-sena-saldo (1).md` (adjunto en
`App - frontend/`, fuera de este repo) — que además de la seña define
integración con gateway de pago y facturación corporate consolidada. Ese
documento completo queda como referencia de diseño a largo plazo; este
archivo cubre **solo la Fase A**, que el dueño eligió explícitamente por
`AskUserQuestion` (22/08/2026) para no bloquear la seña en dos proyectos
externos (elegir proveedor de pago, diseñar cuentas corrientes corporate)
que no hacen falta para la mayoría de las reservas.

**Fuera de este documento, explícitamente diferido:**
- **Fase B** — `paymentCaptureMethod='gateway_link'`, webhook, hold corto
  para canal `web`, auto-release automático. Depende de que el negocio
  tenga o elija un proveedor de pago real.
- **Fase C** — `BillingEntity` separado de `Guest`, `BillingPolicy`
  (facturación consolidada, ciclos, `dueDays`, "facturar ahora"), cuentas
  por cobrar/statements corporate. El subsistema más grande de los tres.

En Fase A **no existen** `bookingSource`/`paymentCaptureMethod` como
columnas — son exclusivos de la lógica de Fase B (decidir automático vs.
manual) y no tienen ningún efecto sin gateway. Agregarlos ahora sería
diseñar para un requerimiento hipotético (regla del proyecto, ver
`CLAUDE.md` raíz). En Fase A el cobro y la factura de los dos hitos son
**siempre manuales** — un operador los carga.

---

## 1. Decisiones de negocio confirmadas (22/08/2026, con el dueño)

1. **Dónde vive el %/monto de seña**: política general del negocio +
   override, ambos niveles activos.
2. **Facturación**: comprobante propio — Factura B de la seña, otra
   Factura B del saldo. Dos comprobantes por reserva, no uno.
3. **Trigger de cobro/factura (Fase A)**: manual en los dos hitos — un
   operador registra el cobro cuando el cliente paga, y eso dispara la
   factura de ese hito. Nada automático todavía (eso es Fase B).
4. **Granularidad del override de %**: los 3 niveles que ya usa D9 para
   tarifas especiales — ítem > categoría > bucket completo
   (ALOJAMIENTO/TURNOS/SERVICIOS). Sin nivel `billingEntity`/cliente en
   Fase A (eso depende de Fase C, que no existe todavía).
5. **Sin política de seña configurada, confirmar sigue sin exigir ningún
   pago** (22/08/2026, segunda ronda de `AskUserQuestion` — hallazgo
   durante el diseño, ver sección 6). `deposit_amount` default es `0`, NO
   `totalPrice` — un depósito 100% implícito hubiera exigido pago previo
   para confirmar CUALQUIER reserva con precio, en TODO negocio, tenga o
   no seña configurada. Con `0`, el gate (`DepositNotPaidError`) nunca se
   activa y el mecanismo de CHARGE colapsa a una sola CHARGE por el
   total, PENDING, en `reservation.confirmed` — bit por bit el
   comportamiento de siempre, sin rama de código aparte.

---

## 2. Los tres niveles (CARGO / COBRO / FACTURA) — vocabulario fijado

Mismo vocabulario que el documento largo del dueño, restringido a Fase A:

| Nivel | Qué es | Automático en Fase A |
|---|---|---|
| **CARGO** (`FinancialTransaction.type='CHARGE'`) | Deuda registrada en el ledger. No implica cobro. | **Sí**, en `reservation.confirmed` — depósito `SETTLED` (ya cobrado, gate lo garantiza) + saldo `PENDING` en el mismo evento. Ver sección 6. |
| **COBRO** (`type='PAYMENT'`) | Plata que efectivamente entró. | No — un operador lo carga (`CustomerAccountService.recordPayment`, extendido con `reservationId`). |
| **FACTURA** | Comprobante AFIP. | No — el operador la emite después de registrar el cobro (flujo ya existente de `invoice.service.ts`, sin cambios estructurales — ver sección 6). |

La FACTURA nunca se dispara por el CARGO, se dispara por el COBRO
confirmado — regla explícita del dueño, sin excepción en Fase A (la
excepción de cuenta corriente corporate es Fase C).

---

## 3. Estados de reserva — un estado nuevo, no un rename

`ReservationStatus` hoy (`src/types/enums.ts`, `Reservation.ts`
`ALLOWED_TRANSITIONS`): `PENDING → CONFIRMED → COMPLETED`, más
`CANCELLED` desde `PENDING` o `CONFIRMED`.

**No se renombra `PENDING` a "Requested"** (A5.5, criterios-negocio.md —
usar los nombres que ya existen). `PENDING` ya es, en los hechos, "pedida,
bloqueando disponibilidad, todavía no confirmada" — exactamente lo que el
documento del dueño llama "Requested". Ni la UI ni el código necesitan un
vocabulario nuevo para lo que ya existe.

**Se agrega `EXPIRED`**, estado terminal nuevo, distinto de `CANCELLED`:

```
PENDING   → [CONFIRMED, CANCELLED, EXPIRED]   (EXPIRED: nuevo)
CONFIRMED → [CANCELLED, COMPLETED]             (sin cambios)
CANCELLED → []                                 (sin cambios)
COMPLETED → []                                 (sin cambios)
EXPIRED   → []                                 (nuevo, terminal)
```

**Por qué no reusar `CANCELLED`:** A6.5 (criterios-negocio.md) exige que
toda transición deje rastro de quién la disparó. Una reserva cancelada
por el cliente/staff y una reserva que venció sin pago son hechos de
negocio distintos (el primero es una decisión, el segundo es la ausencia
de una) — mezclarlos en el mismo estado pierde esa distinción en
reportes y en el propio dueño no pudiendo diferenciar "se arrepintió" de
"nunca pagó". El *trigger* de `EXPIRED` es siempre el worker nuevo
(sección 7), nunca un usuario — coherente con A6.6 (el servidor, no la
UI, decide qué transición es válida y quién la ejecuta).

`Reservation.ts` gana un método `expire()` — mismo patrón que `cancel()`
ya existente, sin lógica nueva de negocio en el agregado (la decisión de
CUÁNDO expirar vive en el worker, no acá).

---

## 4. Columnas nuevas en `reservations`

```sql
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS deposit_amount DECIMAL(12,2);
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS deposit_due_by TIMESTAMPTZ;
```

- **`deposit_amount`** — el monto de seña YA RESUELTO al crear la
  reserva (resolución de la jerarquía ítem>categoría>bucket>general,
  sección 5), congelado ahí (R9, criterios-datos.md — una transacción no
  depende del estado presente del maestro/política). Si la política de
  seña del negocio cambia después, las reservas ya creadas no se
  recalculan — mismo criterio que `totalPrice`/`lines`. NOT NULL, default
  implícito `0` sin política configurada (confirmado con el dueño,
  22/08/2026, segunda ronda — ver decisión 5 de la sección 1): `0`
  significa "el gate de `confirmReservation()` no aplica", NO un depósito
  100% -- ver sección 6 para la mecánica completa.
- **`deposit_due_by`** — instante (A4.1, TIMESTAMPTZ UTC) hasta el cual
  la reserva puede seguir `PENDING` sin seña cobrada. Lo calcula
  `ReservationService.createReservation()` a partir de una ventana de
  horas configurable **por negocio** (A2.9 — nunca una constante de
  código), ej. `business_profile.deposit_hold_hours`. Si el negocio no
  configuró esa ventana (`NULL`), no hay vencimiento — la reserva queda
  `PENDING` indefinidamente hasta que la cobren o la cancelen a mano (el
  worker de la sección 7 no la toca).

No hace falta tocar `financial_transactions` — **ya tiene**
`reservation_id` (nullable, `ON DELETE SET NULL`, agregado en una sesión
previa para el gap de POS) y **ya tiene** `status` con
`PENDING/SETTLED/FAILED/VOIDED`. La sección 6 explica el único cambio de
comportamiento real que hace falta ahí.

---

## 5. Jerarquía de resolución del % de seña — reutiliza el resolver de D9

Mismo patrón exacto que `ReservationPricingService`/`OrderPricingService`
(ítem > categoría > bucket > default), con un nivel más al final (política
general del negocio) porque acá SIEMPRE hay que resolver a algo — a
diferencia de una tarifa especial (que puede simplemente no aplicar y
dejar el precio base), una reserva sin ninguna regla de seña configurada
cae al default del negocio, que puede ser 0% (= sin seña) si el dueño no
configuró nada.

**Tabla nueva** `deposit_policies` — mismo scope de 4 vías que
`rate_catalog`/`customer_rates` usaban ANTES de que D9 les agregara
`product_id` (acá no hace falta — la seña es un concepto de reservas, no
de POS), y sin nivel cliente (Fase A no tiene `billingEntity`):

```sql
CREATE TABLE IF NOT EXISTS deposit_policies (
  id                  VARCHAR(255)   PRIMARY KEY,
  business_id         VARCHAR(255)   NOT NULL,
  resource_id         VARCHAR(255)   REFERENCES resources(id) ON DELETE CASCADE,
  service_id          VARCHAR(255)   REFERENCES bookable_services(id) ON DELETE CASCADE,
  category_id         VARCHAR(255)   REFERENCES resource_categories(id) ON DELETE CASCADE,
  bucket              VARCHAR(20)    CHECK (bucket IN ('ALOJAMIENTO','TURNOS','SERVICIOS')),
  percentage          DECIMAL(5,2)   CHECK (percentage > 0 AND percentage <= 100),
  active              BOOLEAN        NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_deposit_policy_scope CHECK (
    (CASE WHEN resource_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN service_id  IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN category_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN bucket      IS NOT NULL THEN 1 ELSE 0 END) = 1
  )
);
```

Nota: **`bucket` acá NO incluye `'PRODUCTOS'`** — la seña es un concepto
de reservas (alojamiento/turnos/servicios), no de venta de POS. `products`
queda fuera de este scope a propósito (distinto de D9, que sí lo incluye
porque ahí se trata de tarifas de precio, no de señas de reserva).

**Política general del negocio** — columna nueva en `business_profile`
(ya el lugar de otras políticas configurables del negocio, ej.
`default_check_in_time`), no una tabla aparte:

```sql
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS default_deposit_percentage DECIMAL(5,2)
  CHECK (default_deposit_percentage IS NULL OR (default_deposit_percentage > 0 AND default_deposit_percentage <= 100));
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS deposit_hold_hours INTEGER
  CHECK (deposit_hold_hours IS NULL OR deposit_hold_hours > 0);
```

`NULL` en ambas = el negocio no usa seña (comportamiento hoy, sin
cambios) — `deposit_amount` se resuelve a `0` para toda reserva nueva,
`confirmReservation()` no exige ningún pago previo (decisión 5, sección
1) y `handleReservationConfirmed` sigue creando una sola CHARGE por el
total, PENDING — el flujo de siempre, sin rama de código aparte.

**Resolución** (nuevo método en `ReservationPricingService`, mismo
servicio que ya resuelve tarifas especiales — no uno paralelo):

```
resolveDepositAmount(resource, category, totalPrice):
  policy = buscar en deposit_policies, activa, para este resourceId
           OR serviceId OR categoryId OR bucket (isLodging → ALOJAMIENTO/TURNOS,
           si no → SERVICIOS) — la más específica gana, igual criterio de
           ORDER BY que D9.
  percentage = policy?.percentage ?? business.default_deposit_percentage
  if percentage is NULL: return 0   // sin seña -- el gate no aplica
  return round(totalPrice * percentage / 100, 2)   // A3.3, un solo redondeo
```

---

## 6. CARGO en los 2 hitos

Investigando `outbox.handlers.ts`/`sql.financial-transaction.repository.ts`/
`stay.service.ts` para diseñar esto aparece un mecanismo existente que al
principio pareció un problema (ver historial de este documento) y que en
realidad, entendido bien, resuelve el diseño de la seña **sin tocar el
gate de checkout que ya existe** — nada de lo de abajo cambia
`settleByReservationId`, `voidByReservationId`, `getNetBalanceByStayId`
ni `StayService.checkOut()`.

**Cómo funciona HOY (una sola CHARGE, sin seña) — entendido correctamente:**
- `SETTLED` no significa "se cobró" — significa "este cargo ya es
  definitivo, el folio dejó de estar abierto a ajustes". Un `PAYMENT`
  manual se crea siempre `SETTLED` directo (es un hecho ya consumado, no
  hay nada que "cerrar" después).
- `reservation.confirmed` → crea la `CHARGE` del total, `PENDING`
  (todavía puede haber `ADJUSTMENT`s — cambios de fecha/habitación, late
  check-out, etc. — mientras dura la estadía).
- `POST /reservations/:id/complete` (manual, FRONT_DESK) → `settleByReservationId()`
  cierra el folio: la `CHARGE` + cualquier `ADJUSTMENT` pendiente pasan a
  `SETTLED` en bloque, ya no aceptan más cambios.
- `StayService.checkOut()` recién ahí puede bloquear con sentido: compara
  `SETTLED` CHARGE/ADJUSTMENT (ya cerrados) contra `SETTLED` PAYMENT
  (lo que entró) — **el procedimiento real es `/complete` ANTES de
  checkout**, no al revés. Antes de `/complete`, el folio sigue "abierto"
  y el balance no es el dato relevante todavía.

**Por qué la seña no encaja en ese mismo patrón:** una seña tiene que
estar cobrada ANTES de confirmar — no puede esperar a que el folio se
cierre semanas después, en el checkout. Necesita su propio punto de
"esto ya es definitivo", independiente del cierre de folio del saldo.

**Diseño: el gate no depende de que exista una CHARGE — las dos CHARGE
nacen juntas, recién al confirmar, con estados distintos:**

1. **`confirmReservation()`, nuevo gate, ANTES de `reservation.confirm()`**:
   si `deposit_amount > 0`, exige `SUM(PAYMENT SETTLED de esta
   reservationId) >= deposit_amount` — método nuevo en el repositorio,
   `getSettledPaymentTotalForReservation(reservationId)`. El chequeo lee
   `PAYMENT`s, no depende de que exista ninguna `CHARGE` todavía — un
   operador puede registrar el cobro de la seña (`recordPayment` con
   `reservationId`) en cualquier momento mientras la reserva sigue
   `PENDING`, sin que exista un `CHARGE` que "espere" ese pago. Si no
   alcanza: `DepositNotPaidError` (nuevo, 409).
2. **`handleReservationConfirmed` (outbox), reescrito** — antes creaba
   UNA `CHARGE(totalPrice)` `PENDING`; ahora, ya con la seña garantizada
   cobrada (paso 1 ya corrió), crea DOS:
   - `CHARGE(depósito)` `SETTLED` **directo** — no es "pendiente de
     cobro", ya se cobró, es un hecho consumado (mismo criterio que un
     `PAYMENT` manual, que también nace `SETTLED`). Si `deposit_amount`
     es `0`, no se crea.
   - `CHARGE(saldo = totalPrice - deposit_amount)` `PENDING` — el mismo
     rol que la única `CHARGE` de antes: flota durante la estadía, acepta
     `ADJUSTMENT`s (`confirmPriceAdjustment`, sin cambios), se salda
     recién al completar. Si dá `0` (seña = 100%), no se crea — mismo
     guard que ya existía para `totalPrice <= 0`.
   Dos `idempotencyKey` distintas (`"${event.id}:CHARGE:DEPOSIT"`/
   `"${event.id}:CHARGE:BALANCE"`) — un reintento del evento no duplica
   ninguna de las dos.
3. **`/complete` y `checkOut()` — CERO cambios.** `settleByReservationId()`
   sigue cerrando lo que esté `PENDING` de esa reserva (ahora es solo el
   saldo + ajustes, la seña ya nació `SETTLED`). `getNetBalanceByStayId`
   sigue sumando igual — la seña ya cobrada compensa exactamente su
   propia `CHARGE` `SETTLED`, neteando a 0 sin intervención nueva.
4. **Reserva sin política de seña** (`deposit_amount = 0`, decisión 5,
   sección 1): el gate del paso 1 nunca se activa, no se crea
   `CHARGE(depósito)`, y el saldo calculado da `totalPrice` completo —
   **una sola CHARGE, PENDING, igual que hoy.** Es la misma rama de
   código con `deposit=0`, no un camino aparte.

**Al vencer el hold (worker, sección 7):** una reserva que expira nunca
llegó a `confirmReservation()`, así que nunca tuvo `CHARGE` creada (paso
2 corre recién ahí) — no hay nada que voidear en el caso normal. El
worker igual llama a `voidByReservationId` después de expirar, de forma
defensiva (no tiene costo, cubre si el modelo de creación de la CHARGE
cambia más adelante). Antes de expirar, también revisa si ya se registró
un `PAYMENT` que cubre la seña (`getSettledPaymentTotalForReservation`)
— si ya se cobró pero nadie confirmó a tiempo, NO expira: queda `PENDING`
para que el staff la confirme a mano en vez de perder un cobro real por
una carrera contra el reloj del hold.

**Limitación conocida, NO resuelta en esta fase (ligada a C2):** cancelar
una reserva `CONFIRMED` cuya seña ya se cobró y facturó deja el `PAYMENT`
`SETTLED` sin contrapartida una vez que `handleReservationCancelled`
voidea la `CHARGE` (A3.9 — "todo movimiento tiene contrapartida" queda
roto un instante). Requiere Nota de Crédito (C2), que no existe. Ya
estaba anotado en la sección 9 como fuera de alcance; queda más preciso
acá con el mecanismo real que lo produce.

---

## 7. Worker de expiración del hold

Nuevo `ReservationHoldExpiryWorker` — mismo patrón que `OutboxWorker`
(`setInterval` + método `poll()`, `src/workers/outbox.worker.ts`), sin
reinventar un mecanismo de scheduling nuevo.

```
poll():
  reservas = buscar PENDING con deposit_due_by < NOW()
  para cada una:
    si ya hay un PAYMENT SETTLED que cubre deposit_amount: no expirar
      (se cobró pero nadie confirmó a tiempo -- lo resuelve el staff a mano)
    si no, en su propia transacción (una reserva vencida no bloquea a las
    demás si falla):
      reservation.expire()
      guardar
      emitir evento de dominio reservation.expired (auditoría — A6.5)
    voidByReservationId(reservation.id)   // defensivo -- en el caso normal
                                            // no hay ninguna CHARGE creada
                                            // todavía (ver sección 6), sin
                                            // efecto práctico hoy
```

Cumple A8.7 (criterios-negocio.md) — la liberación del hold no depende de
que el usuario cancele explícitamente, corre sola con un límite de tiempo
real, igual criterio que ya se aplicó a `reserved_quantity` de inventario.

---

## 8. Facturación — sin cambios estructurales

`Invoice.financialTransactionId` ya es 1:1 contra una `FinancialTransaction`
puntual (`invoice.service.ts`, idempotencia `invoice:${financialTransactionId}`).
Con dos `CHARGE` por reserva (seña + saldo) en vez de una, "un comprobante
por hito" sale gratis: el operador factura la `CHARGE` de la seña cuando
corresponde, y por separado la del saldo — mismo endpoint, mismo servicio,
sin tocar `invoice.entities.ts` ni `invoice.service.ts`.

---

## 9. Superficie de cambio (Fase A)

- **Schema:** `reservations` +2 columnas (`deposit_amount` NOT NULL
  default `0` vía backfill, `deposit_due_by` nullable), `business_profile`
  +2 columnas, tabla nueva `deposit_policies` (4 columnas de scope +
  `percentage` + `active`), constraint `chk_deposit_policy_scope`,
  `ReservationStatus` +1 valor (`EXPIRED`) + constraint de status
  actualizado.
- **Tocado:** `Reservation.ts` (`expire()`, `ALLOWED_TRANSITIONS`,
  `depositAmount`/`depositDueBy` en `ReservationProps`, default `0`),
  `ReservationService.createReservation()` (resuelve `deposit_amount`/
  `deposit_due_by`, sin crear ninguna `CHARGE` todavía),
  `ReservationService.confirmReservation()` (nuevo gate
  `DepositNotPaidError`, corre ANTES de `reservation.confirm()`),
  `ReservationPricingService` (`resolveDepositAmount()`, nueva dependencia
  opcional `IDepositPolicyRepository`), `CustomerAccountService.
  recordPayment()` (acepta `reservationId`), `outbox.handlers.ts`
  (`handleReservationConfirmed` reescrito: de 1 CHARGE(total) PENDING a
  CHARGE(depósito) SETTLED + CHARGE(saldo) PENDING), `financial-
  transaction.repository.ts` (método nuevo
  `getSettledPaymentTotalForReservation`, sin tocar los existentes),
  worker nuevo `reservation-hold-expiry.worker.ts` (usa
  `voidByReservationId`/`getSettledPaymentTotalForReservation` tal cual
  existen), `outbox.registry.ts` (arranca/detiene el worker nuevo por
  tenant, mismo ciclo de vida que `OutboxWorker`).
- **No tocado (confirmado en sección 6, no solo supuesto):**
  `handleReservationCompleted`, `settleByReservationId`,
  `voidByReservationId` (firma sin cambios, aunque en el caso normal no
  encuentra nada que voidear — ver sección 6), `getNetBalanceByStayId`/
  `ByCustomerId`, `StayService.checkOut()`/`checkIn()`,
  `confirmPriceAdjustment()`, `invoice.entities.ts`/`invoice.service.ts`
  (sección 8), `Customer`/`CustomerTaxProfile` (Fase C, no Fase A). Notas
  de Crédito (C2) siguen bloqueadas por no existir soporte de NC/ND —
  cancelar una reserva `CONFIRMED` con seña ya cobrada/facturada queda
  anotado como limitación conocida de esta fase (final de la sección 6),
  no resuelto acá.
- **Migración de datos:** `deposit_amount` se backfillea a `0` (sin
  política, sin cambio de comportamiento) para toda reserva existente;
  `deposit_due_by` nullable, sin backfill necesario.

**Tamaño:** algo mayor a D9 completo (Parte 1 + Parte 2 juntas) — toca un
estado nuevo, un worker nuevo, y el evento `reservation.confirmed`.
