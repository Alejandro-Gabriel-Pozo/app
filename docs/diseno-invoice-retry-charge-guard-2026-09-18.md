# Diseño — `CITY-LEDGER-GUARD-RETRY-EMITS-001`: guard de estado en `retryExisting()` (Wave 13, Zona 2, 18/09/2026)

**Estado:** `APPROVED WITH CONDITIONS` recibido en la ronda 4 (gate
`architecture-governor`, 21/09/2026, condiciones D1-D4, todas doc-only —
aplicadas más abajo). El gate declaró explícitamente que, aplicadas D1-D4,
el diseño queda **READY FOR IMPLEMENTATION**, sin necesitar una 5ta ronda.
Ningún `.ts` ni `CLAUDE.md` tocado todavía por este documento — commit y
push siguen requiriendo autorización explícita y separada del dueño, igual
que la implementación misma (no autorizada todavía en esta conversación).

**Insumo:** `docs/plan-ejecucion-integral-2026-09-16.md` (Veredicto de Zona 2,
Apéndices I.1/I.2) + el veredicto HOLD de la ronda 1 (F1-F5) + el veredicto
`APPROVED WITH CONDITIONS` de la ronda 2 (C1-C6) + el veredicto **HOLD** de
la ronda 3 (H1-H7 — 5 de las 6 condiciones de la ronda 2 verificaron limpio;
HOLD por una ubicación nueva que el propio gate encontró al re-derivar C1
contra código vivo, más 2 condiciones aplicadas de forma defectuosa).

## -2. Qué cambió desde la ronda 3 (H1-H7, gate `architecture-governor`)

- **H1 (§12, nueva ubicación encontrada por el gate — §4.0 reset):**
  `invoice.service.ts:508`/docblock `:491-505` (`resolveAccountsReceivableWarning()`)
  es un CUARTO consumidor del discriminador `tx.type === 'REFUND'|'ADJUSTMENT'`,
  con un censo propio ("Los 3 únicos productores...") que el censo de 5
  productores de C1 (§6) prueba falso — y no solo en cantidad: su argumento
  de `stayId` tampoco vale para los productores 4 y 5. Se agrega como
  decisión 1 de la lista de docblocks a resolver (§12), ACTUALIZAR en el
  mismo commit. Se declara por qué se pasó por alto en la ronda 2 (el censo
  buscó escrituras de `reversedInvoiceId`, no lectores del discriminador).
- **H2 (§7, Nivel 2, caso 1):** la prueba "no se llamó `createWithClient()`
  de nuevo" no discriminaba nada — el guard fresco de `:656` también lanza
  ANTES de `createWithClient()` (`:696`), así que es cierta en los dos
  caminos. Reemplazada por un caso gemelo (1-bis, sin revertir la AR) que sí
  discrimina: el `id` devuelto tiene que ser el `invoiceId` sembrado, no uno
  nuevo.
- **H3 (§3.3):** los 2 falsos negativos nuevos (acoplamiento al receptor,
  `DEFINITION_FILES` inerte) se movieron del changelog de la ronda 2 al
  cuerpo de §3.3, con instrucción explícita de que el docblock del archivo
  nuevo los declare — mismo criterio que `lock-order.test.ts` y que la
  cerca de §6.
- **H4 (§2):** ancla corregida — `:528`/`:538` eran las líneas que ESCRIBEN
  `reversedInvoiceId`, no el guard de estado-ya-`CANCELLED`. Guards reales:
  `cancel-order-with-credit-note.service.ts:247,281-290`;
  `cancel-reservation-with-credit-note.service.ts:297,349-371`.
- **H5 (§12):** la fila de `invoices.routes.ts:155` decía "mismo motivo
  estructural" — su docblock real da un motivo distinto (rol dedicado
  `Roles.EMISOR_NOTA_CREDITO`, decisión del dueño 13/09/2026). Corregida:
  es un co-lector del discriminador, no un co-asumidor de la propiedad
  estructural de §2.
- **H6 (§3):** anclas de la precondición "sin tx, sin lock" corregidas —
  `:562`/`:570` son el comentario, las llamadas reales están en `:565`/`:573`.
- **H7 (§3.2):** `resolved.filter((ar) => ar != null)` pasa a fail-loud
  (mismo criterio que `loadChargesForConsolidatedInvoice()`) — si el
  comentario de esa rama dice "invariante ya establecido", un `null` ahí es
  la invariante rota, no un caso normal a filtrar en silencio.

## -1. Qué cambió desde la ronda 2 (C1-C6, gate `architecture-governor`)

- **C1 (§2, §6):** el censo de productores de `reversedInvoiceId` no-nulo
  pasa de 3 a 6 sitios reales (`type: 'REFUND'|'ADJUSTMENT'`) — se agregan
  `workers/outbox.handlers.ts::handleReservationPriceAdjusted()` (`:504-540`)
  y las 2 patas de `AccountsReceivableService.reverseTransfer()`
  (`:897-930`). Se declara explícitamente el motivo por el que solo 3 de los
  6 pueden llegar a `retryExisting()`: `buildCreditNote()` (`invoice.service.ts:1066`)
  es la ÚNICA vía de creación de una fila `invoices` para `REFUND`/`ADJUSTMENT`,
  y falla cerrado si `tx.reversedInvoiceId` es falsy — así que un `reversedInvoiceId`
  no-nulo es condición NECESARIA para que la fila llegue a `retryExisting()`,
  no una casualidad del filtro de la cerca. 4to FN declarado (si `:1066`
  se relaja, la cerca deja de alcanzar). Segundo argumento independiente
  agregado (la rama NC de `:601-607` retorna antes del bloque transaccional,
  así que ningún guard fresco corrió nunca sobre REFUND/ADJUSTMENT).
- **C2 (§7, Nivel 2, caso 1):** se corrige la forma del seed — `idempotency_key`
  tiene que ser literalmente `invoice:<financialTransactionId>` y
  `financial_transaction_id` no-nulo, o la llamada cae al camino FRESCO (no
  al retry) y el test queda verde por el motivo equivocado.
- **C3 (§7, Nivel 1, caso 5):** se retracta la afirmación de que los fakes ya
  alcanzan sin cambios — `FakeAccountsReceivableRepo` necesita un `lockCalls`
  nuevo para poder verificar el orden de locks del caso 5.
- **C4 (§3.1):** se corrige la justificación de la equivalencia
  `localeCompare` ≡ `.sort()` default — no es "strings ASCII" (falso en
  general, ver el propio `payment-application.ts`), es "los dos IDs son
  siempre UUID v4 en minúscula, largo fijo" (verificado: único generador,
  `accounts-receivable.service.ts:492`, `randomUUID()`).
- **C5 (§3.3):** se declaran 2 falsos negativos propios de la cerca nueva
  que el precedente (`lock-order.test.ts`) no tiene: acoplamiento al nombre
  del receptor (`accountsReceivableRepo|arRepo`), y `DEFINITION_FILES`
  inerte bajo ese regex.
- **C6 (§3, §12):** se anclan los 2 call-sites de `retryExisting()` que
  faltaban en la precondición "nunca corre dentro de la tx de un caller"
  (los FAST-PATH de idempotencia de los 2 orquestadores de escape); se
  agregan a §12 los 2 productores nuevos de C1 como filas "descartadas, con
  motivo" y un tercer consumidor del mismo discriminador
  (`invoices.routes.ts:155`); se resuelven, una por una, las 3 citas de otros
  docblocks que describen el predicado de bloqueo de `retryExisting()` como
  una lista cerrada.

## 0. Qué cambió desde la ronda 1 (para facilitar la re-revisión)

- **F1/F2 (orden de locks):** `assertChargesStillInvoiceable()` ya NO ordena
  por `financial_transaction_id` para el caso multi-fila. Se extrae un
  comparador canónico nuevo, `canonicalAccountsReceivableLockOrder()`
  (mismo archivo y mismo patrón que `canonicalInvoiceLockOrder()`,
  `payment-application.ts`), y el guard fresco consolidado
  (`invoice.service.ts:875`) se adapta con un cambio de UNA línea para usarlo
  también — mismo comparador en los dos únicos sitios que lockean más de una
  `accounts_receivable` a la vez. Cerca nueva (§3.3) mirroring `lock-order.test.ts`.
- **F3:** la constante de §6 se declara explícitamente como el 13er artefacto
  manual del repo, con el `CLAUDE.md` a actualizar en el mismo commit.
- **F4:** §2/§2.1 rehechas contra guard 8-bis real (`resolveInvoiceLinkage()`),
  no contra el lock de la AR solamente. La fila AR-REVERTIDO se angosta a
  `REJECTED`/`FAILED_UNCERTAIN(!afipContacted)`; la fila orden/reserva
  `CANCELLED` no cambia. §7 nivel 2 reescrito para sembrar esos 2 estados.
- **F5:** se retira la afirmación de que el `CHECK` de schema cubre la mitad
  de datos de la cerca nueva (no aplica a esta propiedad) y se declaran sus
  3 falsos negativos propios.
- **Ítems menores:** `chargeTxs` vacío en el camino consolidado ahora es
  fail-loud (invariante violado, no no-op silencioso); `assertChargesStillInvoiceable()`
  ya no abre una transacción vacía para un retry 100% NC; se declara
  `FinancialTransactionNotFoundError` como superficie de error nueva de
  `retryExisting()`; se declara "`retryExisting()` nunca corre dentro de la
  tx de un caller" como precondición anclada.
- **§12 nueva:** matriz de impacto actualizada con las 2 ubicaciones que la
  ronda 1 no había mapeado (`payment-application.ts::canonicalInvoiceLockOrder()`,
  `lock-order.test.ts`) + `CLAUDE.md`.

## 1. El bug, en una frase

`InvoiceService.retryExisting()` (`invoice.service.ts:1478`) — el único punto
de reentrada de los 6 call-sites de producción que pueden pegarle a
`requestInvoice()`/`requestConsolidatedInvoice()` — reintenta un comprobante
existente (`PENDING`/`REJECTED`/`FAILED_UNCERTAIN` sin incertidumbre) sin
volver a chequear si el estado que el guard original protegía (AR revertida,
orden/reserva cancelada) cambió **entre el primer intento y el reintento**.
El guard de Wave 12 (`AR-REVERTIDO`) y los guards `ORDER-10`/`RESERVA-10`
solo corren en el camino FRESCO (primera vez), nunca en el de reintento.

Confirmado en esta ronda: exactamente 4 `this.issue()` call-sites
(`invoice.service.ts:606` NC fresca, `:728` individual fresca, `:931`
consolidada fresca, `:1489` retry) y exactamente 2 entradas a
`retryExisting()` (`:549`, `:779`). `reconcileAfterFailure()` solo se
alcanza desde adentro de `issue()`. Sin quinto camino.

## 2. Radio real — quién necesita el guard y quién no (C-a, C-b, F4)

**Fila orden/reserva `CANCELLED` — sin cambios respecto a la ronda 1.**
`cancelOrder()`/`cancelReservation()` no consultan `accounts_receivable` en
absoluto — nada angosta esta fila, sigue siendo un bypass real, alcanzable
para CUALQUIER estado retriable de `Invoice` (`PENDING`, `REJECTED`,
`FAILED_UNCERTAIN` con o sin `afipContacted`), tanto individual como
consolidada.

**Fila AR pasa a `REVERTIDO` — re-derivada contra guard 8-bis real
(F4), no contra el lock solamente.** Guard 8-bis
(`accounts-receivable.service.ts:871-885`) resuelve `resolveInvoiceLinkage(charge.id)`
y **rechaza la reversa** (`ArReversalRequiresCreditNoteError`) cuando:

- `linkage.kind === 'ISSUED'` y la clasificación es `NOT_RECONCILED`, o
- `linkage.kind === 'NOT_ISSUED'` y `linkage.status === 'PENDING'`, o
- `linkage.kind === 'NOT_ISSUED'` y `linkage.status === 'FAILED_UNCERTAIN' && linkage.afipContacted`.

`retryExisting()` (`invoice.service.ts:1478-1480`) solo AVANZA (no hace
early-return) para `existing.status` en:
`PENDING`, `REJECTED`, `FAILED_UNCERTAIN && !afipContacted`,
`FAILED_UNCERTAIN && afipContacted && uncertainClearedAt`.

**Intersección de las dos condiciones (para que la carrera exista, hace
falta que `retryExisting()` avance Y que `reverseTransfer()` haya podido
revertir):**

| `existing.status` | `retryExisting()` avanza | Guard 8-bis permite revertir | ¿Fila AR-REVERTIDO alcanzable? |
|---|---|---|---|
| `PENDING` | Sí | **No** (`linkage.status === 'PENDING'` bloquea) | **No** — la reversa nunca llega a completarse mientras la factura siga `PENDING` |
| `REJECTED` | Sí | Sí (`NOT_ISSUED`, `REJECTED` no está en la lista de bloqueo) | **Sí** |
| `FAILED_UNCERTAIN`, `!afipContacted` | Sí | Sí (mismo motivo) | **Sí** |
| `FAILED_UNCERTAIN`, `afipContacted && uncertainClearedAt` | Sí | **No** (`afipContacted` bloquea, sin mirar `uncertainClearedAt`) | **No** |

**Conclusión corregida:** la fila AR-REVERTIDO del bug es real pero más
angosta de lo que la ronda 1 declaró — solo alcanzable cuando el comprobante
que se reintenta quedó `REJECTED` o `FAILED_UNCERTAIN` con
`afipContacted=false` (AFIP nunca llegó a confirmar nada). Para `PENDING` y
para el caso ya resuelto manualmente (`uncertainClearedAt`), `reverseTransfer()`
rechaza la reversa por sí solo — no hace falta el guard de este diseño para
esos dos casos, porque la AR nunca llega a `REVERTIDO` mientras existan.
**Esto no reduce el alcance del fix** (§3 sigue re-chequeando SIEMPRE, sin
mirar qué status tenía la factura) — reduce el conjunto de escenarios reales
donde la carrera puede materializarse, lo cual sí importa para diseñar el
test de nivel 2 (§7).

**Discriminador `tx.type` — sin cambios respecto a la ronda 1 (C-a heredado
correctamente).** Apéndice I.1: la propiedad estructural es *"¿el estado que
la fila referencia pudo cambiar DESPUÉS de que la fila naciera?"*. Para
`CHARGE`, sí. Para los 3 productores que REALMENTE pueden llegar a
`retryExisting()` con un `REFUND`/`ADJUSTMENT` (censo completo y el porqué
de "3 de 6" en §6, C1 del gate ronda 2), no (verificado en código:
`ReservationNotCancelledError` de `confirmRefund()`,
`cancellation-refund.service.ts:159`; los guards de estado-ya-`CANCELLED` de
los dos orquestadores de escape — **ancla corregida (H4 del gate ronda 3):
`:528`/`:538` son las líneas que ESCRIBEN `reversedInvoiceId`, no el guard
en sí** — el guard real es `cancel-order-with-credit-note.service.ts:247`
(FAST-PATH, `priorOrder.status === 'CANCELLED'`) y `:281-290` (tx1, mismo
chequeo bajo lock); `cancel-reservation-with-credit-note.service.ts:297`
(FAST-PATH, `priorReservation.status === ReservationStatus.CANCELLED`) y
`:349-371` (tx1, mismo chequeo bajo lock, con el caso `InvalidReservationError`
de invariante roto si no hay ADJUSTMENT del escape)). `tx.type` es hoy un
proxy seguro de esa propiedad — el mecanismo que detecta si deja de serlo
es §6.

### 2.1 — C-b: alcanzabilidad real de la carrera en B, contra guard 8-bis (F4)

La ronda 1 citó guard 8-bis pero derivó la reachability contra el LOCK de la
AR (`:850-852`), no contra el guard mismo (`:871-885`). Repetido acá con la
cita correcta: la tabla de §2 aplica igual a B (consolidada) que a A-CHARGE
(individual) — el guard 8-bis no distingue de qué camino vino la factura, solo
mira `resolveInvoiceLinkage(charge.id)` por cargo. Carrera **concurrente**
(dos llamadas a `requestConsolidatedInvoice()` leyendo `pending` antes de que
la reversión commitee) solo puede materializarse si la factura que resulta
`existing` en la segunda llamada terminó `REJECTED` o
`FAILED_UNCERTAIN(!afipContacted)` — ninguna llamada fresca dentro de esta
misma carrera puede haber dejado la factura `PENDING` y a la vez permitir que
`reverseTransfer()` ya haya revertido la AR (8-bis se lo impide mientras siga
`PENDING`). El guard nuevo (§3) cierra esta ventana igual, re-lockeando la
MISMA AR con el MISMO comparador que usa `reverseTransfer()` (AR antes que
orden/reserva) — quien pierda la carrera por el lock bloquea, lee el estado
post-commit del ganador, y si es `REVERTIDO` el reintento aborta.

**Residuo no cerrado — heredado, no nuevo:** la ventana entre el COMMIT del
guard de retry y la llamada real a `issue()` (que corre fuera de la
transacción, a propósito, para no sostener locks de fila durante una llamada
de red a AFIP). Mismo residuo que ya acepta `requestInvoice()` hoy — no es
una regresión de este diseño.

## 3. El fix — guard compartido, orden de locks canónico (C-a; F1/F2)

**Por qué vive en `retryExisting()`:** la rama NC de `requestInvoice()`
(`:601-607`) arma la NC y retorna **antes** de llegar al
`transactionManager.run()` de `:624` — un guard puesto ahí adentro nunca
vería 5 de los 6 call-sites. `retryExisting()` es el único punto por el que
pasan los 6.

**Precondición anclada, declarada explícitamente (ítem menor de la ronda 1,
completada en C6 de la ronda 2 — faltaban 2 de los 4 indirectos):**
`retryExisting()` nunca corre dentro de la transacción de un caller —
verificado en los 4 call-sites indirectos, los 2 por orquestador (FAST-PATH
de idempotencia + camino normal, cada uno "sin tx, sin lock" en su propio
comentario) — **ancla corregida (H6 del gate ronda 3): `:562`/`:570` son la
línea del comentario "AFIP: emitir la NC (fuera de toda tx, sin lock)", la
llamada real está 3 líneas después**:
`cancel-order-with-credit-note.service.ts:253` (FAST-PATH) y `:565` (llamada
del camino normal, comentario en `:562`); `cancel-reservation-with-credit-note.service.ts:299`
(FAST-PATH) y `:573` (llamada del camino normal, comentario en `:570`) — y
los 2 directos (`invoices.routes.ts:206,231`, ninguno abre transacción antes
de llamar al service). El
`transactionManager.run()` que este diseño agrega adentro de
`retryExisting()` es siempre la única transacción de la operación — no hay
riesgo de que quede anidada dentro de otra.

### 3.1 — Orden de locks para AR: comparador canónico, no un `.sort()` nuevo (F1)

**Hallazgo de la ronda 1, mío, corregido:** el guard fresco consolidado
(`invoice.service.ts:875`) ordena por **`ar.id`** con `.sort()` default. Mi
propuesta original ordenaba por **`financial_transaction_id`** con
`localeCompare`. Clave distinta, comparador distinto — riesgo real de ABBA
entre una llamada fresca (nueva, sobre el subconjunto `pending` restante) y
una llamada de retry (sobre el conjunto de cargos ya fijado de la factura
existente) si comparten ≥2 filas de `accounts_receivable`.

**Resolución — mismo patrón que `LOCK-ORDER-001` (`payment-application.ts:52-69`,
`canonicalInvoiceLockOrder()`), generalizado a `accounts_receivable`:**

```ts
// payment-application.ts, junto a canonicalInvoiceLockOrder() — mismo
// bounded context (clientes-finanzas), mismo motivo de existir.
export function canonicalAccountsReceivableLockOrder<T>(
  items: readonly T[],
  getAccountsReceivableId: (item: T) => string,
): T[] {
  return [...items].sort((a, b) => getAccountsReceivableId(a).localeCompare(getAccountsReceivableId(b)));
}
```

**Dos call-sites, mismo comparador, desde el día uno:**

1. **Guard fresco consolidado** (`invoice.service.ts:875`) — cambio de UNA
   línea, preservando el resto del bloque sin tocar: `for (const
   accountsReceivableId of [...pending.map((ar) => ar.id)].sort())` pasa a
   `for (const ar of canonicalAccountsReceivableLockOrder(pending, (ar) =>
   ar.id))` (el resto del loop usa `ar.id` en vez de `accountsReceivableId`
   para llamar a `getByIdWithLock`). **Comportamiento idéntico, justificación
   corregida (C4 del gate ronda 2):** no es "strings ASCII" en general —
   `localeCompare` y `.sort()` default SÍ pueden divergir para ASCII (mayúsculas
   vs. minúsculas invierten orden entre code-units y colación CLDR raíz,
   varias clases de puntuación también). La equivalencia real es más angosta
   y es la que importa acá: `accounts_receivable.id` tiene un único generador
   en todo el repo (`accounts-receivable.service.ts:492`, `id: randomUUID()`),
   así que todo valor que este comparador ordena es un UUID v4 en minúscula,
   largo fijo, guiones en offsets fijos — para ese alfabeto los dos
   comparadores reducen a comparación posicional de hex y coinciden siempre.
   Mismo argumento, más preciso, que ya usa `payment-application.ts:63-65`
   ("da igual mientras ... los ids sean UUID", no "ASCII"). No es un refactor
   de la lógica de guardia, es adoptar el comparador compartido en el ÚNICO
   lugar de este
   archivo donde hoy hay un `.sort()` ad-hoc. Esto es la única línea tocada
   de código YA verificado contra Postgres real (`invoice-accounts-receivable-reversed-guard.integration.test.ts`)
   — el resto de ese guard (qué se lockea, en qué orden respecto a
   orden/reserva, el error que lanza) no cambia.
2. **Guard nuevo de retry** (`assertChargesStillInvoiceable()`, abajo).

### 3.2 — `assertChargesStillInvoiceable()`, con el caso de 1 fila resuelto aparte

Un solo lock nunca puede formar un ciclo (mismo criterio que
`SINGLE_INVOICE_CALLERS`/`SINGLE_AR_CALLERS`, §3.3) — así que el retry
individual (`existing.financialTransactionId` no nulo, 1 `CHARGE`) sigue
usando `getByFinancialTransactionIdWithLock()` directo, sin pasar por el
comparador canónico (no hace falta ordenar un conjunto de 1). El retry
consolidado (≥2 `CHARGE`) sí lo necesita.

```ts
/**
 * CHARGE-STATE-GUARD-001 (Wave 13, Zona 2, docs/diseno-invoice-retry-charge-guard-2026-09-18.md)
 * -- re-valida, antes de reintentar un comprobante existente, que el estado
 * que el guard ORIGINAL de la primera vez protegía sigue siendo válido.
 * Solo aplica a CHARGE (ver §2 del diseño para el porqué de `tx.type` como
 * discriminador seguro hoy) -- REVERTIDO-INVOICE-ID-CONVENTION-001 extendida
 * (§6 del diseño) es el mecanismo que detecta si eso deja de ser cierto.
 */
private async assertChargesStillInvoiceable(client: SqlClient, chargeTxs: FinancialTransaction[]): Promise<void> {
  // chargeTxs siempre no-vacío acá -- el caller filtra y decide si abrir
  // la transacción (ver retryExisting() abajo, ítem menor "no abrir un
  // BEGIN/COMMIT vacío para un retry 100% NC").
  if (chargeTxs.length === 1) {
    // Un solo lock -- no hay ABBA que ordenar. Mismo método que el guard
    // fresco individual (`:656`).
    const [tx] = chargeTxs;
    const ar = await this.accountsReceivableRepo.getByFinancialTransactionIdWithLock(client, tx.id);
    if (ar && ar.status === 'REVERTIDO') throw new AccountsReceivableReversedCannotInvoiceError(ar.id);
  } else {
    // >1 -- ABBA real si no coincide con el guard fresco consolidado
    // (§3.1). Resolución SIN lock de `ar.id` por cargo -- segura acá (a
    // diferencia del guard fresco INDIVIDUAL, que motivó
    // getByFinancialTransactionIdWithLock: ver accounts-receivable.repository.ts:137-151
    // para esa razón original, que NO transfiere sin más a este camino).
    // Un cargo que llega acá viene de getChargeIdsForInvoice() de una
    // factura consolidada YA armada a partir de AR `pending` -- su
    // existencia es un invariante ya establecido (R12, nunca hard-delete),
    // no una carrera contra una creación en curso; lo único que se lee sin
    // lock es `ar.id`, PK inmutable desde el INSERT, nunca stale. El
    // `status`, que sí puede cambiar, se relee bajo FOR UPDATE abajo.
    // Fail-loud, no filter mudo (H7 del gate ronda 3, mismo criterio que
    // loadChargesForConsolidatedInvoice() -- si el comentario de arriba
    // dice "invariante ya establecido", un `null` acá es esa invariante
    // rota, no un caso normal a saltear en silencio.
    const resolved = await Promise.all(
      chargeTxs.map(async (tx) => {
        const ar = await this.accountsReceivableRepo.getByFinancialTransactionId(tx.id);
        if (!ar) {
          throw new Error(`assertChargesStillInvoiceable(): el cargo "${tx.id}" (parte de una factura consolidada) no tiene accounts_receivable -- invariante roto (todo cargo de invoice_charges viene de un AR pending).`);
        }
        return ar;
      }),
    );
    for (const ar of canonicalAccountsReceivableLockOrder(resolved, (a) => a.id)) {
      const locked = await this.accountsReceivableRepo.getByIdWithLock(client, ar.id);
      if (locked && locked.status === 'REVERTIDO') throw new AccountsReceivableReversedCannotInvoiceError(locked.id);
    }
  }

  const orderIds = [...new Set(chargeTxs.map((tx) => tx.orderId).filter((id): id is string => id != null))].sort();
  for (const orderId of orderIds) {
    const order = await this.orderRepo.getByIdForUpdate(client, orderId);
    if (order && order.status === 'CANCELLED') throw new OrderCancelledCannotInvoiceError(orderId);
  }
  const reservationIds = [...new Set(chargeTxs.map((tx) => tx.reservationId).filter((id): id is string => id != null))].sort();
  for (const reservationId of reservationIds) {
    const reservation = this.reservationRepo.getByIdWithLock
      ? await this.reservationRepo.getByIdWithLock(client, reservationId)
      : await this.reservationRepo.getById(reservationId);
    if (reservation && reservation.status === ReservationStatus.CANCELLED) throw new ReservationCancelledCannotInvoiceError(reservationId);
  }
}
```

**`retryExisting()` modificado** (agrega el guard antes de contactar AFIP,
después de los dos early-return ya existentes; filtra y decide si abre
transacción ANTES de llamar al guard — ítem menor, evita un
`BEGIN`/`COMMIT` vacío para un retry 100% NC/REFUND):

```ts
private async retryExisting(existing: Invoice): Promise<Invoice> {
  if (existing.status === 'ISSUED') return existing;
  if (existing.status === 'FAILED_UNCERTAIN' && existing.afipContacted && !existing.uncertainClearedAt) return existing;

  const txs = existing.financialTransactionId
    ? [await this.requireFinancialTransaction(existing.financialTransactionId)]
    : await this.loadChargesForConsolidatedInvoice(existing.id);

  const chargeTxs = txs.filter((tx) => tx.type === 'CHARGE');
  if (chargeTxs.length > 0) {
    await this.transactionManager.run((client) => this.assertChargesStillInvoiceable(client, chargeTxs));
  }

  // ... resto sin cambios (credentials, profile, issue())
}
```

`requireFinancialTransaction()` — helper trivial (`getById` +
`FinancialTransactionNotFoundError` si falta), mismo patrón que `:573-574`
de `requestInvoice()`, ahora con 2 call-sites. **Declarado explícitamente
(ítem menor):** esto agrega `FinancialTransactionNotFoundError` como
superficie de error nueva de `retryExisting()` — estructuralmente
inalcanzable bajo R12 (`financial_transactions` nunca se hard-deletea), pero
declarado en vez de dejarlo implícito, mismo criterio que el resto de este
documento.

**`loadChargesForConsolidatedInvoice()` — fail-loud si el invariante de
"toda consolidada tiene ≥1 cargo" se rompe (ítem menor, honest-degradation):**

```ts
private async loadChargesForConsolidatedInvoice(invoiceId: string): Promise<FinancialTransaction[]> {
  const chargeIds = await this.invoiceRepo.getChargeIdsForInvoice(invoiceId);
  if (chargeIds.length === 0) {
    throw new Error(`retryExisting(): la factura consolidada "${invoiceId}" no tiene ningún cargo en invoice_charges -- invariante roto (toda consolidada se crea con ≥1 AR pendiente).`);
  }
  return Promise.all(chargeIds.map((id) => this.requireFinancialTransaction(id)));
}
```

**Alcance deliberadamente acotado — el resto de los guards frescos no se
toca.** Fuera del cambio de UNA línea de §3.1 (necesario para F1), las
implementaciones de `requestInvoice()` (`:656-694`) y
`requestConsolidatedInvoice()` (`:887-900`) no se refactorizan para compartir
código con `assertChargesStillInvoiceable()`. El guard nuevo es código
enteramente nuevo, sin ruta previa que perturbar, con sus dos call-sites
(retry individual, retry consolidada) compartiendo una implementación desde
el día uno — no hay una "segunda copia" que pueda divergir. El riesgo que
señaló el grounding ERP era sobre el guard NUEVO, no sobre una tercera copia
del guard viejo.

### 3.3 — Cerca nueva: `ACCOUNTS-RECEIVABLE-LOCK-ORDER-001` (F2)

Ubicación previamente no mapeada por este diseño: `payment-application.ts::canonicalInvoiceLockOrder()`
y `src/tests/architecture/lock-order.test.ts` (`LOCK-ORDER-001`) — el
precedente exacto de este mismo problema, ya resuelto una vez para
`invoices`, con su propia advertencia textual: *"Antes del 05/09/2026 esto
eran dos `.sort()` ad-hoc en archivos distintos, coincidiendo por casualidad
mantenida a mano ... un revisor de arquitectura llegó a aprobar un cambio
dando ese cierre por pendiente sin haber releído el otro lado."* — exactamente
el riesgo que F1 encontró acá. `lock-order.test.ts` está scopeado a
primitivas de `invoices` (`LOCK_CALL_RE`) — no cubre `accounts_receivable`,
así que no basta con reusarlo; hace falta un sibling.

**Nuevo:** `src/tests/architecture/accounts-receivable-lock-order.test.ts`,
mismo esqueleto que `lock-order.test.ts` (mismo `stripComments()`,
`findTsFiles()`, misma forma de allowlist-con-motivo verificado en las dos
direcciones). **Su docblock tiene que declarar, además del FN #3 heredado
citado abajo, estos 2 falsos negativos PROPIOS (H3 del gate ronda 3 — el
precedente, `lock-order.test.ts`, lista los suyos en su propio header; esta
cerca nueva hace lo mismo, no los deja solo en el changelog de este
documento):**

1. **Acoplamiento al nombre del receptor.** `LOCK_CALL_RE` exige que la
   llamada use literalmente `accountsReceivableRepo.` o `arRepo.` como
   receptor — el precedente (`lock-order.test.ts`) no tiene este
   acoplamiento (matchea el nombre del método solo, con `client` como
   argumento). Un caller futuro que reciba el repositorio bajo otro nombre
   de campo (ej. `accountsReceivableRepository`) es invisible para esta
   cerca.
2. **`DEFINITION_FILES` es inerte bajo este regex, a diferencia del
   precedente.** En `lock-order.test.ts`, excluir `payment-application.ts`
   SÍ importa (`getOutstandingForUpdate(client` matchea la firma de la
   función real ahí). Acá, `LOCK_CALL_RE` exige el receptor
   `accountsReceivableRepo|arRepo` — ninguno de los 3 archivos de
   `DEFINITION_FILES` tiene una llamada con ese receptor (son la interfaz y
   su implementación SQL, que definen `getByIdWithLock`/`getByFinancialTransactionIdWithLock`
   sin receptor de por medio). La exclusión se mantiene por simetría con el
   precedente, no porque haga falta.

```ts
const MULTI_AR_CALLERS = ['facturacion/invoice.service.ts'];

const SINGLE_AR_CALLERS: Record<string, string> = {
  'clientes-finanzas/accounts-receivable.service.ts':
    'markCollected() (:661) y reverseTransfer() (:852) -- un lock por método, en métodos distintos, nunca dos AR a la vez en la misma transacción.',
};

const DEFINITION_FILES = new Set([
  'clientes-finanzas/accounts-receivable.repository.ts',
  'clientes-finanzas/sql.accounts-receivable.repository.ts',
  'clientes-finanzas/payment-application.ts',
]);

const LOCK_CALL_RE =
  /\b(?:accountsReceivableRepo|arRepo)\.getByIdWithLock\s*\(\s*client\b|\b(?:accountsReceivableRepo|arRepo)\.getByFinancialTransactionIdWithLock\s*\(\s*client\b/;
```

`invoice.service.ts` cae en `MULTI_AR_CALLERS`: tiene que contener una
llamada real a `canonicalAccountsReceivableLockOrder(` (misma aserción que
`lock-order.test.ts:144-150`, mismos falsos negativos declarados — no
verifica que la llamada envuelva el array que de verdad alimenta el loop de
lock, FN #3 heredado).

**Registro (para no reabrir esta lista después):** este allowlist no es de
los 12 numerados en `CLAUDE.md` (esos son RBAC/Contratos, `lock-order.test.ts`
nunca se numeró ahí tampoco) — se documenta acá como precedente directo, sin
número, mismo criterio que `MOUNT_TO_ROUTES_FILE`/`EXCLUDED_PATHS` de
`CONTRACT-001` (chico, con motivo, sin necesitar entrar a la cuenta corrida).

## 4. Consolidada (B) no tiene "la fila" — sin cambios respecto a la ronda 1

`existing.financialTransactionId` es `null` para una consolidada
(`invoice.service.ts:907`, confirmado, no `:908` — esa era la cita stale del
apéndice, no de este documento). `getChargeIdsForInvoice()` (`invoice.repository.ts:385`,
implementación `sql.invoice.repository.ts:1175-1189`) devuelve el `UNION` de
`invoices.financial_transaction_id` e `invoice_charges.financial_transaction_id`
— para una consolidada solo la rama `invoice_charges` aporta filas.

**100%-CHARGE por construcción, filtro defensivo no innecesario (respuesta a
la pregunta 5 de la ronda 1, sin cambios):** correcto por construcción
(`invoice_charges` sale de `pending`, que solo referencia `CHARGE` vía
`postStayTransfer()`) — el filtro `chargeTxs = txs.filter(type === 'CHARGE')`
se mantiene igual, sin asumir la invariante, porque TAMBIÉN es lo que hace
correcto al camino individual (una NC retry pasa por el mismo helper y tiene
que no-opear).

**Política de rechazo (R15, heredada):** si CUALQUIER cargo del lote falla
el guard, se rechaza el lote entero.

## 5. Errores — reusados, no nuevos (R14)

`AccountsReceivableReversedCannotInvoiceError`, `OrderCancelledCannotInvoiceError`,
`ReservationCancelledCannotInvoiceError` — ya existen. `FinancialTransactionNotFoundError`
— ya existe, nueva superficie de alcance (declarado en §3.2, estructuralmente
inalcanzable bajo R12).

## 6. C-c — detección de un productor futuro que rompa el proxy `tx.type` (F3, F5, C1 del gate ronda 2)

**Censo completo, corregido (C1): 6 sitios reales que escriben
`type: 'REFUND'|'ADJUSTMENT'`, no 3.** Verificados línea por línea en esta
ronda:

| # | Sitio | `reversedInvoiceId` | ¿Llega a `retryExisting()`? |
|---|---|---|---|
| 1 | `cancel-order-with-credit-note.service.ts:521/528` | no-null (`originalInvoiceId`) | Sí |
| 2 | `cancel-reservation-with-credit-note.service.ts:527/538` | no-null (`originalInvoiceId`) | Sí |
| 3 | `cancellation-refund.service.ts:381/385` | no-null (`chunk.reversedInvoiceId`, vía variable — FN #5 ya declarado de la cerca madre) en la rama con factura; **`null`** en la rama `:372` sin asignar | Sí (rama con factura); No (rama `null`, ver fila 6) |
| 4 | `accounts-receivable.service.ts:907,927` (`reverseTransfer()`, 2 patas) | literal `null` explícito | No |
| 5 | `workers/outbox.handlers.ts::handleReservationPriceAdjusted()` (`:504-540`) | **ausente del todo** (el `create()` de `:526-538` ni siquiera setea el campo) | No |
| 6 | `cancellation-refund.service.ts:372` (rama sin asignar del reparto) | literal `null` | No |

**"6 sitios" acá vs. "5 productores" en §12/§12-decisión-1 — no es una
inconsistencia, es el mismo censo contado distinto (D4 del gate ronda 4).**
Esta tabla cuenta FILAS de código (6, filas 1-6); `resolveAccountsReceivableWarning()`
(§12, decisión 1) y `invoice.service.ts:1412` (§12, nueva fila D2) cuentan
PRODUCTORES/call-sites reales (5): las filas 3 y 6 son las DOS ramas del
mismo reparto en `cancellation-refund.service.ts` (`:367` con factura,
`:372` sin asignar) que alimentan la MISMA llamada a
`createIdempotentPaymentWithClient()` (`:376-386`) — un solo call-site,
dos filas de esta tabla porque el `push` a `chunks` ocurre en dos ramas
distintas del código. Cuando se corrija el docblock de `:491-505` (§12,
decisión 1), citar el CENSO de productores (5, o mejor, citar esta sección
del documento) — no el conteo de 6 filas, que es un detalle de esta tabla,
no del número de productores reales.

**Por qué solo 3 de los 6 pueden llegar a `retryExisting()` — mecanismo
declarado, no una casualidad del filtro de la cerca.** `buildCreditNote()`
(`invoice.service.ts:1066`) es la ÚNICA vía de creación de una fila
`invoices` para `REFUND`/`ADJUSTMENT` (la rama NC de `requestInvoice()`,
`:601-607`, es la única que la llama) y falla cerrado en su primera línea:
`if (!tx.reversedInvoiceId) throw new InvoiceNotReversibleError(tx.id)`. Sin
fila `invoices`, no hay `idempotencyKey` que resolver, y sin eso
`retryExisting()` nunca se invoca para esa transacción. Por eso `reversedInvoiceId`
no-nulo es condición **NECESARIA** (no solo observada) para que una fila
`REFUND`/`ADJUSTMENT` llegue a `retryExisting()` — es lo que hace correcto
filtrar la cerca nueva por "valor no-nulo", no una coincidencia de los 3
productores de hoy. Los sitios 4-6 (literal `null` o campo ausente) quedan
estructuralmente afuera por este gate, no por buena suerte.

**Segundo argumento, independiente del censo de productores (agregado en
esta ronda, C1):** la rama NC de `requestInvoice()` (`:601-607`) retorna
**antes** de llegar al `transactionManager.run()` de `:624` — el bloque
donde viven TODOS los guards frescos (AR-REVERTIDO, ORDER-10, RESERVA-10).
Así que, estructuralmente, ningún guard fresco corrió NUNCA sobre una fila
`REFUND`/`ADJUSTMENT`, para ningún productor, pasado o futuro — exentar a
estos 2 tipos del guard nuevo de retry (§3) preserva exactamente esa
simetría con el camino fresco, sin necesitar el censo de productores en
absoluto. El censo (y la cerca de §6) siguen siendo necesarios por una
razón distinta: detectar si algún día aparece un productor cuyo `reversedInvoiceId`
referencia un estado que SÍ puede cambiar después de nacer — ahí `tx.type`
dejaría de ser un proxy seguro de "no hace falta re-chequear", aunque el
guard fresco siga sin haber corrido nunca sobre él.

**Mecanismo de la cerca, no prosa — mismo patrón que los 12 artefactos
manuales ya vigentes.** Se extiende `src/tests/architecture/reversed-invoice-id-convention.test.ts`
(`REVERSED-INVOICE-ID-CONVENTION-001`) reusando su enumeración existente
(`WRITE_SITES`, `writeLines()`, `stripComments()`) en vez de crear un
enumerador nuevo. **Nota de alcance:** `WRITE_SITES` de la cerca madre
enumera por ARCHIVO (4 entradas hoy) y ya incluye los archivos de los
sitios 1-4 de la tabla de arriba; los sitios 5-6 (`outbox.handlers.ts`, y
la rama `null` de `cancellation-refund.service.ts`) NO agregan una entrada
nueva a `WRITE_SITES` porque ese archivo no escribe `reversedInvoiceId` en
absoluto (sitio 5) o porque `cancellation-refund.service.ts` ya está en la
lista por su OTRA rama (sitio 6) — la cerca nueva de este documento filtra
DENTRO de esos archivos por valor no-nulo, no agrega archivos nuevos al
censo de la cerca madre.

**Un `it()` nuevo, con su PROPIO id y docblock (F5 -- no comparte aserción
con la de la cerca madre, para que las dos invariantes queden separables):**

```ts
/**
 * RETRY-EXISTING-NC-PRODUCER-SAFETY-001 (Wave 13, Zona 2,
 * docs/diseno-invoice-retry-charge-guard-2026-09-18.md §6) -- distinto del
 * `it()` de arriba: esa aserción protege que `reversedInvoiceId` solo se
 * escriba en filas REFUND/ADJUSTMENT (integridad de datos); esta protege
 * que `InvoiceService.retryExisting()` (`assertChargesStillInvoiceable()`)
 * pueda seguir tratando esos 2 tipos como estructuralmente exentos del
 * guard de CHARGE.
 *
 * FALSOS NEGATIVOS PROPIOS -- NO heredados del `CHECK`
 * `chk_financial_transactions_reversed_invoice_type` (ese solo impone
 * `type IN ('REFUND','ADJUSTMENT')`, nada sobre CUÁNDO nace la fila
 * respecto del cambio de estado que referencia -- la propiedad que esta
 * cerca vigila no tiene contraparte a nivel schema):
 *  1. Un SEGUNDO productor agregado DENTRO de un archivo ya en la
 *     allowlist es invisible -- la cerca es a nivel archivo (mismo FN #1
 *     de la cerca madre).
 *  2. `NON_NULL_WRITE_RE` es textual ("el valor asignado no es el literal
 *     `null`") -- un write vía variable (`cancellation-refund.service.ts:385`,
 *     `reversedInvoiceId: chunk.reversedInvoiceId`) es un ejemplo YA VIVO
 *     de esto, no hipotético: pasa la cerca porque el `chunk` se construye
 *     con `invoice.id` (no-null) en la línea de arriba, verificado a mano,
 *     no por el regex.
 *  3. SQL crudo fuera del repo -- invisible, sin backstop de schema para
 *     ESTA propiedad (a diferencia de la cerca madre, que sí tiene el
 *     `CHECK` como mitad de datos).
 *  4. Depende enteramente de que `buildCreditNote()` (`invoice.service.ts:1066`)
 *     siga siendo la ÚNICA vía de creación de una fila `invoices` para
 *     REFUND/ADJUSTMENT y siga fallando cerrado si `reversedInvoiceId` es
 *     falsy -- eso es lo que hace que "valor no-nulo" sea necesario para
 *     llegar a `retryExisting()` (ver §6 del diseño). Si esa guarda se
 *     relaja alguna vez, esta cerca deja de alcanzar sin que nada lo avise
 *     -- no hay backstop de arquitectura para ESE cambio específico.
 */
const NC_PRODUCERS_SAFE_FOR_RETRY_TYPE_SHORTCUT = [
  'facturacion/cancel-order-with-credit-note.service.ts',
  'facturacion/cancel-reservation-with-credit-note.service.ts',
  'reservas/cancellation-refund.service.ts',
].sort();

it('los productores reales de reversedInvoiceId no-nulo son exactamente los que InvoiceService.retryExisting() trata como exentos del guard de CHARGE', () => {
  // reusa `files`/`stripComments`/`writeLines` del describe de arriba;
  // filtra a las líneas cuyo valor asignado NO es el literal `null`.
  ...
  expect(nonNullSites.sort()).toEqual(NC_PRODUCERS_SAFE_FOR_RETRY_TYPE_SHORTCUT);
});
```

**Registro — 13er artefacto manual del repo (F3, cuenta corrida del
`CLAUDE.md`, 12mo = `CITY-LEDGER-REVERSE-ROUTE-GROUP-FREEZE-001`,
17/09/2026, verificado esta ronda: `grep` confirma "duodécimo" en
`CLAUDE.md`):** `NC_PRODUCERS_SAFE_FOR_RETRY_TYPE_SHORTCUT` se agrega a
`CLAUDE.md` (sección RBAC/Contratos, mismo lugar que los otros 12) **en el
mismo commit** que la implementa — no después. Texto propuesto para esa
entrada: motivo de existir, el censo completo de 6 sitios y por qué solo 3
llegan a `retryExisting()` (el gate de `buildCreditNote()`, citado arriba),
y el mensaje de falla dirigiendo a re-derivar la propiedad estructural
antes de sumar un productor nuevo (mismo texto que el mensaje del `expect`
de arriba).

**Nota — dos allowlists nuevas, una sola numerada.** Este mismo bloque
también crea `accounts-receivable-lock-order.test.ts` (§3.3,
`MULTI_AR_CALLERS`/`SINGLE_AR_CALLERS`), que NO entra en la cuenta corrida
de `CLAUDE.md` — mismo criterio que `lock-order.test.ts`, su precedente
directo, que tampoco está numerado ahí (verificado, cero resultados de
`grep lock-order CLAUDE.md`). Se deja esta nota explícita para que quien
lea el commit no tenga que re-derivar por qué un bloque que agrega DOS
allowlists solo numera UNA.

## 7. Estrategia de test (C-d)

**Nivel 1 — unitario, con los fakes ya existentes en `invoice.service.test.ts`,
con UNA excepción declarada (C3 del gate ronda 2, ver caso 5 abajo).**
Confirmado en esta ronda que la premisa de la ronda de descubrimiento
("ningún unit test del repo valida hoy un cambio de predicado en
`retryExisting()` sin Postgres real") era **incorrecta** —
`invoice.service.test.ts:2121` ya es exactamente eso (un test de la lógica
de predicado de `retryExisting()`, con fakes, sin Postgres). Los fakes que
los casos 1-4 y 6 necesitan ya existen y hacen lo que se les pide:
`FakeAccountsReceivableRepo` (`:384-441`, implementa los 2 métodos de lock +
un simulador de interleaving `revertOnLock`), `FakeMultiFinancialTransactionRepository`
(`:2435-2457`, resuelve por id), `FakeMultiOrderRepository`/`FakeMultiReservationRepository`
(`:2468-2492`, registran `lockCalls`), `FakeInvoiceRepository.getChargeIdsForInvoice`
(`:142-164`, resuelve desde el mapa que `createWithClient` puebla). **Retractado
para el caso 5 (C3):** esa afirmación NO vale para el caso 5 —
`FakeAccountsReceivableRepo` no tiene un `lockCalls` propio, y el caso 5
necesita uno nuevo (ver abajo). Casos:

1. Retry individual de un `CHARGE` cuya AR está `REVERTIDO` → lanza
   `AccountsReceivableReversedCannotInvoiceError`, no llega a `issue()`.
2. Retry individual de un `CHARGE` cuya orden/reserva está `CANCELLED` →
   lanza el error correspondiente.
3. Retry individual de un `REFUND`/`ADJUSTMENT` (los 2 productores del
   escape + C2) con la AR/orden/reserva en cualquier estado → **no**
   re-chequea, procede a `issue()` — regresión negativa, protege la
   clasificación de la fila 3 de la matriz (Apéndice I.1).
4. Retry consolidado (≥2 cargos) donde 1 de N falla el guard → se rechaza
   el LOTE completo (R15).
5. Retry consolidado con todos los cargos limpios, orden de lock
   verificado vía `lockCalls` → coincide con `canonicalAccountsReceivableLockOrder()`
   sobre los `ar.id` involucrados, no con el orden de `chargeTxs` de
   entrada. **Requiere trabajo nuevo en el fake (C3 del gate ronda 2):**
   `FakeAccountsReceivableRepo` (`invoice.service.test.ts:384-441`) no
   registra un `lockCalls` hoy — hay que agregarle uno (mismo patrón que
   `FakeMultiOrderRepository`/`FakeMultiReservationRepository`,
   `:2468-2492`) para que este caso pueda verificar el orden real. Ese fake es
   compartido con las aserciones de Wave 12 en `:2413` y `:2877` — agregar
   `lockCalls` no puede cambiar su comportamiento actual para esos dos
   tests, solo agregar la instrumentación.
6. `loadChargesForConsolidatedInvoice()` con `getChargeIdsForInvoice()`
   devolviendo `[]` → lanza el error de invariante roto (§3.2), no
   no-opea.

**Declarado explícitamente (`FakeTransactionManager.run()`, `:377-381`):**
entrega un `client` dummy — no simula locks reales. El Nivel 1 no puede
probar orden de locks contra Postgres de verdad; eso es exactamente lo que
prueba el Nivel 2, por eso F1 se resolvió a nivel de DISEÑO (comparador
compartido) y no se dejó para que un test lo detectara después.

**Nivel 2 — integración contra Postgres real (`describe.skipIf(skipIfNoDb)`),
reescrito con los estados que §2/§2.1 (F4) mostraron alcanzables:**

`invoice-retry-charge-guard.integration.test.ts`, mismo patrón que
`invoice-accounts-receivable-reversed-guard.integration.test.ts` (fake AFIP
credentials, `clientFactory` propio) y que `invoice-mark-failed-transactional.integration.test.ts`
(seed directo por SQL del estado de `invoices`, sin pasar por el flujo
completo de emisión):

1. **AR-REVERTIDO en retry individual, estado real alcanzable.** Seedear una
   factura individual directo por SQL con `status: 'REJECTED'` (mismo patrón
   que `seedPendingInvoice()` de `invoice-mark-failed-transactional.integration.test.ts:67-78`,
   **NO copiado literal — corrección C2 del gate ronda 2:** esa función
   sembraba `financial_transaction_id: NULL` e `idempotency_key: 'idem-<uuid>'`
   porque su propio test no pasa por `requestInvoice()`. Este seed nuevo
   necesita, a diferencia de ese template, `financial_transaction_id`
   **no-nulo** (apuntando al `CHARGE` real) e `idempotency_key` **literalmente**
   `invoice:<financialTransactionId>` — el formato exacto que
   `requestInvoice()` arma en `:547` (`` `invoice:${input.financialTransactionId}` ``).
   Sin ese formato exacto, el `getByIdempotencyKey()` de `:548` no encuentra
   `existing`, la llamada cae al camino FRESCO (no a `retryExisting()`), y
   como `INVOICE_STATUSES_CONSUMING_CHARGE` (`invoice.entities.ts:41`)
   excluye `REJECTED`, el guard cruzado de `:569` tampoco frena nada — el
   test terminaría lanzando el MISMO error pero desde el guard fresco
   YA EXISTENTE de `:656`, sin haber ejercitado ni una línea del código
   nuevo de este diseño. Con la clave y el `financial_transaction_id`
   correctos: revertir la AR con `AccountsReceivableService.reverseTransfer()`
   de verdad (8-bis lo permite para `REJECTED`, confirmado en §2); llamar
   `requestInvoice()` con el mismo `financialTransactionId` y esperar
   `AccountsReceivableReversedCannotInvoiceError`.

   **Prueba positiva de que se ejercitó el camino de retry, corregida (H2
   del gate ronda 3 — la propuesta anterior no discriminaba nada):** "no se
   llamó `createWithClient()` de nuevo" NO sirve — en el camino FRESCO el
   guard de `:656` también lanza ANTES de `createWithClient()` (`:696`), así
   que esa aserción es cierta en los dos caminos por igual, seed correcto o
   no. La prueba real es un caso GEMELO, sin revertir la AR: sembrar la
   misma factura `REJECTED` con la misma clave correcta, llamar
   `requestInvoice()` SIN revertir nada, y verificar que el `id` del
   resultado es **exactamente** el `invoiceId` sembrado (no uno nuevo) y que
   sigue habiendo una sola fila en `invoices` para ese `financial_transaction_id`
   — solo el camino de retry puede devolver la fila YA EXISTENTE con su
   mismo `id`; si el seed hubiera fallado (clave o `financial_transaction_id`
   mal formados) y la llamada hubiera caído al camino fresco, ese camino
   NUNCA reusa un `id` preexistente — crea uno nuevo (`randomUUID()` en
   `:618`) o, si el `financial_transaction_id` no fuera único, colisionaría
   contra `idx_invoices_idempotency_key`. Este caso gemelo (llamarlo 1-bis)
   es el que efectivamente prueba que el seed llevó por `retryExisting()`;
   el caso 1 (con la AR revertida) reusa la misma seed ya validada por 1-bis
   y agrega la reversión para ejercitar el guard nuevo en sí.
2. **Concurrencia real en consolidada.** Dos conexiones: una corriendo
   `reverseTransfer()`, otra `requestConsolidatedInvoice()` sobre una
   factura ya sembrada `REJECTED` (mismo seed que el caso 1, multiplicado a
   N cargos vía `invoice_charges`) — sincronizadas con un lock artificial
   (mismo patrón que la concurrencia ya probada en
   `reservation-availability.service.integration.test.ts`). Confirma que la
   ventana de carrera de §2.1 queda cerrada, exactamente una de las dos
   operaciones tiene éxito, la otra rechaza con el error correcto, nunca se
   emite un CAE real contra el cargo revertido.
3. **Orden de lock real coincide entre el guard fresco y el de retry
   (reescrito 22/09/2026, `WAVE13-ZONA2-DEADLOCK-REPRO-RESIDUE-001`, gate
   `architecture-governor` — diseño consultado como decisión de diseño, no
   solo pre-commit).**

   **Corrección factual sobre el texto original de este punto:** "antes de
   F1 esto deadlockeaba (reproducible)" nunca describió un estado real de
   código commiteado — `assertChargesStillInvoiceable()` nació en el mismo
   commit que introdujo `canonicalAccountsReceivableLockOrder()`
   (`7906a26`, esta misma Wave/Zona) ya usando el comparador canónico;
   `git log -S"assertChargesStillInvoiceable"` confirma que no existió
   nunca una versión sin canonizar en el historial. No hay commit anterior
   contra el cual reproducir el deadlock original — el texto era una
   proyección de riesgo escrita ANTES de implementar el fix, no una
   observación de un estado real.

   Investigación adicional (22/09/2026) mostró además que un caso 3 literal
   — una carrera genuina fresco-vs-retry sobre el MISMO conjunto de AR
   solapadas — es estructuralmente casi imposible de construir. **Corregido
   en el gate (22/09/2026): NO es porque la idempotencia sea por
   COMPAÑÍA** — la clave de la rama consolidada es
   `` `invoice:consolidated:${hashIds(financialTransactionIds)}` ``
   (`requestConsolidatedInvoice()`, cita por nombre), un hash del CONJUNTO
   de cargos, no de la compañía; la de la rama individual es
   `` `invoice:${input.financialTransactionId}` `` (`requestInvoice()`,
   cita por nombre), por cargo. La conclusión de todos modos se sostiene,
   por dos razones distintas: (1) si el conjunto de cargos de la segunda
   llamada es EXACTAMENTE el mismo, el hash coincide y cae por
   `retryExisting()` igual; (2) si el conjunto es distinto pero SOLAPA con
   uno ya facturado, el guard anti double-billing
   (`getInvoicedFinancialTransactionIds()`, rama `invoice_charges`,
   status-blind a propósito — ver su propio docblock) lo frena ahí, antes
   de llegar a emitir nada — respaldado por
   `idx_invoice_charges_ft` (`src/db/schema.sql:3684`, `UNIQUE`). En
   ninguno de los dos casos se llega a una carrera fresco-vs-retry real
   sobre AR solapadas. Presentado al dueño (`AskUserQuestion`), quien
   eligió mandar la ambigüedad a `architecture-governor` en vez de simular
   un guard no-canónico o saltear el ítem.

   **Diseño aprobado por el gate — observación determinística del orden de
   locks, no un intento de deadlock:** en vez de perseguir una carrera real
   entre los dos sitios (que además de infeasible sería no-determinística),
   el test ejercita cada sitio (`fresco`, `retry`) por separado, k veces
   (k = posición 0..N-1 dentro del orden canónico de N=3 AR de una misma
   compañía), y verifica el FINGERPRINT exacto del orden de locks vía
   `pg_blocking_pids()` + sondas `SELECT ... FOR UPDATE NOWAIT`:

   1. Se siembra una compañía "discriminante" — reintentando la
      generación hasta que el orden canónico (`canonicalAccountsReceivableLockOrder`)
      difiera TANTO del orden de inserción como del orden por
      `financialTransactionId`, para que el test pueda distinguir "orden
      canónico real" de las dos mutaciones candidatas de un vistazo.
   2. Una conexión "holder" toma `BEGIN; SELECT ... FOR UPDATE` sobre la AR
      en la posición `k` del orden canónico (para el sitio `retry`, sobre
      una factura consolidada ya sembrada `REJECTED`).
   3. Se dispara el servicio real (`requestConsolidatedInvoice()`, sin
      esperar la promesa) y se poll-ea `pg_blocking_pids()` hasta confirmar
      que el proceso del servicio quedó bloqueado exactamente por el
      `pid` del holder.
   4. Con el servicio bloqueado ahí, una segunda conexión "probe" intenta
      `FOR UPDATE NOWAIT` sobre cada AR `j != k`: se espera `55P03`
      (`lock_not_available`) para todo `j < k` (ya tomadas por el
      servicio, en orden) y éxito para todo `j > k` (todavía libres) — el
      fingerprint completo "prefijo tomado / sufijo libre" en la posición
      exacta que el orden canónico predice. La misma conexión "probe"
      también intenta `FOR UPDATE NOWAIT` sobre las filas de
      `reservations` involucradas y espera ÉXITO — el servicio no debe
      haberlas tomado todavía en este punto (AR-antes-que-reservations,
      la dimensión que motivó el deadlock real de Wave 12); esta sonda es
      la que M3a/M3b ejercitan.
   5. Se libera el holder (`ROLLBACK`), se espera la promesa real (éxito),
      se limpian las dos conexiones.

   Implementado en `invoice-retry-charge-guard.integration.test.ts`
   (`describe('§7 caso 3 (reescrito)...')`, 6 arms: sitio × k ∈ {0,1,2}).
   **Garantía estadística del diseño (N=3, derivada en el gate 22/09/2026,
   corregida en la ronda 2 -- la formulación general de la ronda 1
   contradecía sus propios casos puntuales):** con un orden mutado F
   distinto del canónico E, el arm k solo puede "pasar" (no discriminar)
   si F ubica a `E[k]` exactamente en la posición k **y** el CONJUNTO de
   elementos anteriores en F es exactamente `{E[0], ..., E[k-1]}` (el
   orden interno de ese prefijo no es observable por la sonda -- el
   fingerprint solo distingue "tomado" de "libre", no el orden entre
   tomados). Con N=3 eso da: el arm **k=1 discrimina SIEMPRE** (pasar
   exigiría F[0]=E[0] y F[1]=E[1], lo que fuerza F=E, ya descartado por
   `seedDiscriminatingCompany()`); los arms **k=0 y k=2 discriminan en 4 de
   las 5 permutaciones erróneas posibles** de 3 elementos (k=0 no
   discrimina solo si F=[E0,E2,E1]; k=2 solo si F=[E1,E0,E2]) — así que un
   solo arm de los 3 puede fallar en discriminar en una corrida dada, nunca
   dos. Esta garantía es específica de N=3 y hay que re-derivarla si N
   cambia.

   **Evidencia de mutación, corrida contra Postgres real (cluster local,
   22/09/2026), no deducida:**
   - **M1** (guard de retry, `assertChargesStillInvoiceable()`, rama `>1`
     — `canonicalAccountsReceivableLockOrder()` reemplazada por
     `.sort()` sobre `financialTransactionId`): 2 de 3 arms `retry`
     fallaron con el assertion error esperado (`AR de posición N no se
     pudo lockear...`/`...se pudo lockear pero no debía`) — `retry k=1`
     entre ellos, como la garantía de arriba exige siempre; `retry k=0` no
     discriminó esta corrida puntual, consistente con la garantía (F
     coincidió con E en la posición 0 en el orden mutado que salió
     sembrado). Los 3 arms `fresco` y los 2 tests preexistentes se
     mantuvieron verdes. Revertido, `git diff --stat` confirmó 0 residuo,
     8/8 verde de nuevo.
   - **M2** (guard fresco, `requestConsolidatedInvoice()`, loop de AR —
     se quita `canonicalAccountsReceivableLockOrder()` y se itera
     `pending` sin ordenar): los 3 arms `fresco` fallaron, consistente con — pero no
     garantizado más fuerte que — la misma cota estadística que M1 (el
     resultado 3/3 de esta corrida puntual es uno de los desenlaces
     posibles, no el único que la garantía permite). Los 3 arms `retry` y
     los 2 tests preexistentes se mantuvieron verdes. Revertido,
     `git diff --stat` confirmó 0 residuo, 8/8 verde de nuevo.
   - **M3a** (guard fresco, `requestConsolidatedInvoice()` — el loop de
     `reservationIds` movido ANTES que el loop de AR, recreando la versión
     de Wave 12 que deadlockeaba): los 3 arms `fresco` fallaron los 3, con
     el error real de Postgres `could not obtain lock on row in relation
     "reservations"` en la sonda `FOR UPDATE NOWAIT` — corregido en la
     ronda 2 del gate: los locks de fila no se liberan a mitad de
     transacción, así que la causa no es que el servicio "soltara" el
     lock tarde. Es que, con el orden mutado, el servicio YA había tomado
     el lock de `reservations` ANTES de entrar a la fase de AR (en el
     orden correcto lo toma recién DESPUÉS) — la sonda choca contra un
     lock que el servicio sostiene mientras está bloqueado en la AR de la
     posición k, en vez de encontrarlo libre como predice el orden
     canónico. Los 3 arms `retry` y los 2 tests preexistentes se
     mantuvieron verdes. Revertido, `git diff --stat` confirmó 0 residuo,
     8/8 verde de nuevo.
   - **M3b** (guard de retry, `assertChargesStillInvoiceable()` — mismo
     movimiento del lock de `reservations` antes que el de AR, rama `>1`):
     los 3 arms `retry` fallaron los 3, mismo error real de Postgres sobre
     `reservations`. Los 3 arms `fresco` y los 2 tests preexistentes se
     mantuvieron verdes. Revertido, `git diff --stat` confirmó 0 residuo,
     8/8 verde de nuevo.
   - M3a/M3b (ejecutadas 22/09/2026, ronda 2 del gate — la ronda 1 las
     había marcado opcionales; revisado tras notar que son exactamente la
     dimensión que el residuo original nombraba, "el orden
     AR-antes-que-reservations que Wave 12 reprodujo... no la
     reproducción dinámica") completan la cobertura declarada en el paso 4
     del diseño: la sonda de `reservations FOR UPDATE NOWAIT` (que M1/M2
     nunca ejercitan, porque no tocan ese lock) SÍ falla cuando el orden
     AR-vs-reservations se invierte, en los dos sitios.

   **Hallazgo nuevo, separado, NO resuelto por este bloque (HOLD explícito
   del gate):** durante esta investigación se encontró una 4ª dirección del
   agujero "doble comprobante" — ver
   `WAVE13-ZONA2-CONSOLIDATED-RETRY-DUPLICATE-CAE-001` en
   `docs/pendientes-2026-09-12.md`. El gate fue explícito: esto requiere
   una decisión de negocio vía `AskUserQuestion` antes de cualquier diseño
   de fix — no se resuelve como parte del trabajo del caso 3.

Sin `TEST_DATABASE_URL` en este entorno de diseño original, el Nivel 2
quedó registrado con verificación de Postgres real pendiente. Los casos 1
y 2 ya se habían cerrado el 21/09/2026 (`WAVE13-ZONA2-INTEGRATION-TIER-UNEXECUTED-001`
en `docs/resuelto.md`: 2/2 verde, 13 corridas consecutivas, 0 flakes,
Postgres 16.13 local). **El caso 3 cierra acá, el 22/09/2026**: corrido
contra un cluster Postgres 16 local (5 corridas consecutivas de la suite
completa, 8/8 verde, 0 flakes) más la evidencia de mutación M1/M2/M3a/M3b
de arriba. El Nivel 1 ya corría y se verificaba en este entorno desde el
diseño original.

## 8. Secuenciación — `diseno-salida-manual-nc-y-reapertura-b3-2026-09-12.md`

Sin cambios respecto a la ronda 1: este diseño agrega el guard ANTES de la
lógica de reintento existente, sin tocar qué payload usa `retryExisting()`
ni crear una rama nueva de emisión — no invalida M1/M2 de ese documento.

## 9. Anclas citadas en este documento (verificadas 18/09/2026, ronda 2)

- `invoice.service.ts:541-549, 565-571, 601-607, 624-694, 656-694, 759-796,
  829-900, 875-900, 907, 1478-1496`.
- `invoice.repository.ts:385`; `sql.invoice.repository.ts:1175-1189`
  (`getChargeIdsForInvoice`).
- `accounts-receivable.service.ts:661` (`markCollected`, single),
  `:850-885` (`reverseTransfer`, guard 8-bis completo incl. `resolveInvoiceLinkage`).
- `accounts-receivable.repository.ts:104-195`: `:135` (`getByFinancialTransactionId`,
  sin lock), `:137-151` (docblock de `getByFinancialTransactionIdWithLock`,
  el motivo original que NO transfiere sin más al camino consolidado — ver
  §3.2), `:153` (`getByFinancialTransactionIdWithLock`), `:195`
  (`getByIdWithLock`).
- `payment-application.ts:52-69` (`canonicalInvoiceLockOrder`, precedente
  directo de §3.1).
- `src/tests/architecture/lock-order.test.ts` (`LOCK-ORDER-001`, precedente
  directo de §3.3).
- `invoice.entities.ts:24-30` (docblock `INVOICE_STATUSES_CONSUMING_CHARGE`).
- `reversed-invoice-id-convention.test.ts:106-111` (`WRITE_SITES`, 4
  entradas).
- `cancellation-refund.service.ts:159` (`ReservationNotCancelledError`),
  `:367,385` (chunk intermedio, valor no-null vía variable).
- `cancel-order-with-credit-note.service.ts:528`,
  `cancel-reservation-with-credit-note.service.ts:538,570`.
- `cancel-order-with-credit-note.service.ts:562`; `invoices.routes.ts:206,231`.
- `invoice-accounts-receivable-reversed-guard.integration.test.ts`,
  `invoice-mark-failed-transactional.integration.test.ts` (patrones de
  seed/fake reusados en §7 nivel 2).

## 10. Criterios de negocio

- **A8.x (concurrencia):** núcleo de este diseño — comparador de locks
  compartido y fenced (§3.1/§3.3) para `accounts_receivable`, no dos
  `.sort()` coincidiendo a mano. **Acotado a AR, a propósito (residuo
  declarado, gate de pre-commit ronda 1):** el orden de orden/reserva
  DENTRO de `assertChargesStillInvoiceable()` sigue siendo un `.sort()`
  ad-hoc que coincide, textualmente, con el de los guards frescos — mismo
  patrón que `ACCOUNTS-RECEIVABLE-LOCK-ORDER-001` existe para prevenir, un
  nivel más abajo, sin fence. Ver §11.
- **R14 (un solo vehículo de rechazo por causa):** los errores lanzados ya
  existen; `FinancialTransactionNotFoundError` es la única superficie nueva,
  reusada de otro call-site del mismo archivo.
- **R15 (no facturar parcial en silencio):** heredado sin cambios.
- **A6.x (transiciones de estado):** no se agrega ningún estado nuevo — el
  guard solo LEE estado existente.
- **honest-degradation:** `loadChargesForConsolidatedInvoice()` falla
  ruidoso ante un invariante roto en vez de no-opear en silencio (§3.2).
- No se clasifica ninguna entidad nueva.

## 11. Rollback / alcance

Revertir = quitar la llamada a `assertChargesStillInvoiceable()` de
`retryExisting()`, la línea de `canonicalAccountsReceivableLockOrder()` del
guard fresco consolidado (vuelve al `.sort()` ad-hoc anterior, comportamiento
idéntico para UUIDs), y borrar los 2 métodos + la cerca nueva de §3.3 + el
`it()` nuevo de §6 — no toca schema, no toca datos, reversible con un solo
commit.

Fuera de alcance de este bloque: `diseno-salida-manual-nc-y-reapertura-b3-2026-09-12.md`
(§8), Zona 3 (`POOL-MIXTO-MANUAL-01`), `POOL-MIXTO-CONSOLIDADA-INDIVIDUAL-001`,
`CITY-LEDGER-CROSS-STAY-ADOPTION-001`.

**Residuo declarado (gate de pre-commit, ronda 1, corroborando §10):** el
`.sort()` default de orden/reserva dentro de `assertChargesStillInvoiceable()`
es una segunda copia ad-hoc del mismo orden que ya usan los guards frescos
(`requestInvoice()`/`requestConsolidatedInvoice()`, texto idéntico) — no
fenced, mismo patrón que `ACCOUNTS-RECEIVABLE-LOCK-ORDER-001` (§3.3) existe
para prevenir un nivel más arriba (AR), aplicado ahora a orden/reserva. Hoy
es comportamentalmente idéntico (default `.sort()` de string IDs, sin
riesgo de ABBA real), así que se deja SIN fence a propósito, alcance
congelado por este bloque — no un olvido. Fencearlo (tercera cerca de
lock-order, esta vez para orden/reserva) queda como bloque futuro, sin
gate propio todavía.

## 12. Matriz de impacto (actualizada, ronda 3 — C6 agrega los productores descartados, un tercer consumidor del mismo discriminador, y 3 docblocks a resolver)

| Ubicación | Rol en este diseño | Se toca |
|---|---|---|
| `invoice.service.ts::retryExisting()` | Guard nuevo agregado | Sí |
| `invoice.service.ts::requestConsolidatedInvoice()` (`:875`) | Orden de lock, 1 línea | Sí |
| `invoice.service.ts::requestInvoice()` (`:656-694`) | Guard fresco individual, sin cambios | No |
| `payment-application.ts` | Home del comparador canónico nuevo, precedente directo | Sí (función nueva) |
| `src/tests/architecture/lock-order.test.ts` | Precedente directo, scope distinto (invoices) | No (no se extiende — se replica el patrón, no el archivo) |
| `src/tests/architecture/accounts-receivable-lock-order.test.ts` | Cerca nueva | Sí (archivo nuevo) |
| `src/tests/architecture/reversed-invoice-id-convention.test.ts` | `it()` nuevo, mismo describe | Sí |
| `accounts-receivable.repository.ts` | Sin cambios de contrato — `getByFinancialTransactionId()` (sin lock) ya existe, se reusa | No |
| `accounts-receivable.service.ts` (`reverseTransfer`, guard 8-bis) | Consultado para la re-derivación de §2/§2.1, sin cambios | No |
| `/home/user/app/CLAUDE.md` | Registro del 13er artefacto manual | Sí (mismo commit que la cerca) |
| `invoice.service.test.ts` | Casos de Nivel 1 nuevos | Sí |
| `invoice-retry-charge-guard.integration.test.ts` | Nivel 2, archivo nuevo | Sí |
| `workers/outbox.handlers.ts::handleReservationPriceAdjusted()` (`:504-540`) | Productor #5 del censo de §6 — **descartado**: no setea `reversedInvoiceId` en absoluto, nunca puede llegar a `buildCreditNote()` ni a `retryExisting()` | No |
| `accounts-receivable.service.ts::reverseTransfer()` (`:897-930`) | Productor #4 del censo de §6 — **descartado**: las 2 patas escriben `reversedInvoiceId: null` explícito, mismo gate | No |
| `invoices.routes.ts:155` (`requireManagementForCompanyCharge()`) | **Ancla corregida (H5 del gate ronda 3): NO es el mismo motivo estructural.** Su docblock (`:113-130`) da una razón distinta y ya escrita: es el fork de Nota de Crédito, decisión del dueño 13/09/2026 (`AskUserQuestion`), que ya tiene su propio rol dedicado (`Roles.EMISOR_NOTA_CREDITO`, deliberadamente por debajo de `MANAGEMENT`, `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` §10 q7). Es un **co-lector** del mismo discriminador `tx.type === 'REFUND' \|\| 'ADJUSTMENT'`, no un co-asumidor de la propiedad estructural de §2 — se registra igual para que §6 (FN #1) sepa que hay un tercer lugar que lee este `tx.type`, con su propio motivo, distinto del de este diseño | No |
| `invoice.service.ts:508` (`resolveAccountsReceivableWarning()`, docblock `:491-505`) | **Cuarto consumidor del mismo discriminador — su censo queda falsificado por C1.** Ver decisión **1** abajo | Sí, docblock a corregir |
| `invoice.service.ts:1702-1718` (docblock de `transitionCreditNoteRequestAfterFailure()`) | Describe el predicado de bloqueo de `retryExisting()` como lista cerrada (`ISSUED`, `FAILED_UNCERTAIN&afipContacted`) — ver decisión abajo | Sí, 1 cláusula agregada |
| `invoice.entities.ts:24-30` (docblock `INVOICE_STATUSES_CONSUMING_CHARGE`) | Misma clase de cita — ver decisión abajo | No, staleness aceptada |
| `invoice.repository.ts:320-329` + `sql.invoice.repository.ts:674-692` (docblock de `getInFlightCreditNoteTotalForUpdate()`, cita "condición C1 del gate 08/09/2026") | Bypass DISTINTO de `retryExisting()` (tope de NC, no guard de CHARGE) — ver decisión abajo | No, staleness aceptada (con motivo) |
| `afip-catalog.constants.ts:47-53` (docblock de `CBTE_TIPOS_NOTA_CREDITO`) | **Quinto lector del discriminador (D1 del gate ronda 4).** Se acopla por invariante al routing de `requestInvoice()` (*"`if (tx.type === 'REFUND' \|\| tx.type === 'ADJUSTMENT')`: ese branch produce siempre una NC"*) — no hace censo de productores, solo asume que la rama de `:601` existe y produce NC. Este diseño no toca `:601` — verificado, no se toca | No |
| `invoice.service.ts:1412` + docblock `:1415-1427` | **Sexto lector — MISMA clase de censo cerrado que H1, pero verificado CONSISTENTE con el censo de 5 productores de §6 (D2 del gate ronda 4).** Dice *"Los dos únicos productores reales de un ADJUSTMENT con `reversedInvoiceId` puesto ... siempre setean exactamente uno"* — cruzado contra §6: cierto (los 2 orquestadores del escape son los únicos productores de `ADJUSTMENT` con `reversedInvoiceId` no-nulo; el propio docblock ya nombra a `reverseTransfer()` como escritor de `null` y anticipa "un futuro tercer productor"). No se toca | No |

### Las 4 citas de otros docblocks sobre el predicado/discriminador de `retryExisting()` (C6, + H1 de la ronda 3)

Los cuatro describen, en algún grado, "lo que `retryExisting()` bloquea o
qué transacciones son REFUND/ADJUSTMENT" — ninguno es el predicado que este
diseño toca (ninguno cambia los 2 early-return de `:1479-1480`), pero cada
uno merece una decisión explícita en vez de quedar sin revisar. La
numeración empieza en el hallazgo más grave (H1, encontrado por el propio
gate al re-derivar C1) y sigue con los 3 ya resueltos en la ronda 2:

1. **`invoice.service.ts:508`/docblock `:491-505` (`resolveAccountsReceivableWarning()`)
   — ACTUALIZAR en el mismo commit (H1 del gate ronda 3, encontrado por el
   propio gate al re-derivar el censo de C1, no por este diseño).** El
   docblock dice, textual, *"Los 3 únicos productores de esos tipos en el
   repo son `cancellation-refund.service.ts` (`REFUND`, nunca setea
   `stayId` -- este método corta antes igual) y los 2 orquestadores del
   escape con NC (`ADJUSTMENT`, heredan `stayId` Y YA calculan/exponen este
   mismo warning por su propio camino)"* — el censo de C1 (§6) prueba esto
   falso en cantidad (son 5 productores de `type: 'REFUND'|'ADJUSTMENT'`,
   no 3) **y en el argumento mismo**: `reverseTransfer()` (productor #4,
   `accounts-receivable.service.ts:897-930`) SÍ setea `stayId` en su pata
   huésped (`stayId: lockedAr.stayId`, no-null) y NO calcula este warning
   por ningún camino propio; `handleReservationPriceAdjusted()` (productor
   #5, `workers/outbox.handlers.ts:531`) también setea `stayId` (`stay?.id
   ?? null`) y tampoco lo calcula. El comportamiento de
   `resolveAccountsReceivableWarning()` no cambia (sigue cortando en `:508`
   para cualquier `REFUND`/`ADJUSTMENT`, `tx.type` alcanza) — lo que está
   mal es la JUSTIFICACIÓN escrita de por qué cortar ahí es seguro. Se
   corrige el censo del comentario a los 5 productores reales (o se cita
   §6 de este documento en vez de repetir la lista, para no tener 2 censos
   que puedan divergir de nuevo) y se corrige/quita el argumento de
   `stayId` para los productores 4 y 5, que no aplica.
2. **`invoice.service.ts:1702-1718` — ACTUALIZAR en el mismo commit.** El
   docblock razona sobre "si un operador reintenta una factura `REJECTED` ...
   y el reintento vuelve a fallar (`REJECTED` o `FAILED_UNCERTAIN` otra vez)"
   — asumiendo implícitamente que la ÚNICA forma en que un retry "falla" es
   llegando a `issue()`/`reconcileAfterFailure()`. Con este diseño, un retry
   puede fallar ANTES de eso (el guard nuevo lanza y la fila de `invoices`
   ni se toca) — `transitionCreditNoteRequestAfterFailure()` ni se invoca en
   ese caso, así que el razonamiento del docblock no queda falso, pero su
   enumeración de "cómo puede fallar un retry" queda incompleta para un
   lector futuro. Se agrega UNA cláusula corta señalando que el guard de
   CHARGE (`assertChargesStillInvoiceable()`) es una tercera forma de
   fallar, anterior a `issue()`, que este método nunca ve.
3. **`invoice.entities.ts:24-30` — SIN CAMBIOS, staleness aceptada.** Describe
   el predicado de `retryExisting()` como "más fino (`ISSUED` +
   `FAILED_UNCERTAIN` con `afipContacted`)" únicamente para contrastarlo con
   `INVOICE_STATUSES_CONSUMING_CHARGE` — sigue siendo exacto para ese
   contraste puntual (los 2 early-return no cambian). No se toca.
4. **`invoice.repository.ts:320-329` / `sql.invoice.repository.ts:674-692`
   ("condición C1 del gate 08/09/2026") — SIN CAMBIOS, staleness aceptada,
   con motivo explícito porque a primera vista parece la MISMA clase de bug
   que este diseño arregla.** Es un bypass DISTINTO: ese C1 es sobre el tope
   de NC en vuelo (N5, `getInFlightCreditNoteTotalForUpdate()`) que
   `buildCreditNote()` chequea SOLO en el camino fresco de REFUND/ADJUSTMENT
   — nunca sobre el guard de estado de un `CHARGE` (AR-REVERTIDO/orden/reserva)
   que este diseño agrega. El guard nuevo de este documento (§3) NUNCA
   corre sobre filas REFUND/ADJUSTMENT (§2, discriminador `tx.type`), así
   que no toca ni cierra ni reabre ese C1 — sigue exactamente en el estado
   que su propio docblock declara ("hoy INALCANZABLE ... este C1 sigue
   dependiendo de que exista un segundo escritor real por factura ...
   bloque posterior de B-reservas, no este"). Se deja sin editar a propósito,
   con esta nota acá para que quien lea los dos documentos juntos no los
   confunda como el mismo hallazgo.
