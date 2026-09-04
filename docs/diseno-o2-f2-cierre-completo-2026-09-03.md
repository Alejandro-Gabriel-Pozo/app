# Diseño — O2-F2: cierre completo (accounts_receivable ↔ invoices)

- **Fecha:** 03/09/2026.
- **Continúa:** `docs/continuidad-o2-f2-facturas-consolidadas-2026-09-03.md` (checkpoint de discovery, CERRADO — no reabrir su investigación, solo su implementación).
- **Autor:** sesión de implementación, autorizada explícitamente por el dueño para cerrar O2-F2 completo (F2.1 a F2.5), scope: **solo O2-F2**.

## 1. Decisiones de negocio (§5 del checkpoint) — resueltas

### §5.1 — Filas AR legacy sin `financial_transaction_id`

**Decisión del dueño (03/09/2026):** los tenants actuales son de prueba/demostración
(usados para encontrar errores, no producción con plata real de clientes) — así
que el fallback legacy (`markCollected()` crea un `PAYMENT` sin `settledInvoiceId`
cuando `accounts_receivable.financial_transaction_id IS NULL`) se **mantiene sin
cambios**, documentado como deuda técnica aceptada. No se bloquea el cobro de esas
filas ni se migran datos.

Esto coincide con el propio comentario ya existente en `schema.sql:3121`
("el tenant de prueba de hoy... queda sin backfill posible"), escrito el
23/08/2026 — no es una decisión nueva desconectada del código, es la misma
lectura que ya tenía el schema.

**Alcance de la decisión:** aplica solo a filas donde
`financial_transaction_id IS NULL`. El día que haya producción real con
clientes reales, esta decisión debe revisarse — no es válida indefinidamente,
es válida mientras los tenants sean de prueba.

### §5.2 — Alcance del cierre

**Decisión del dueño (03/09/2026):** cierre completo, no subentrega parcial.
Entran F2.1 (visibilidad — JOIN excluye consolidadas), F2.2 (falta endpoint de
listado), F2.3 (doble cobro), F2.4 (idempotencia) y F2.5 (frontend verificado).

## 2. Resolución de `invoiceId` desde una fila AR

Confirmado contra el código real (no solo el checkpoint):

**Camino individual (per-reservation):** `invoices.financial_transaction_id`
apunta directo al mismo id que `accounts_receivable.financial_transaction_id`
(el CHARGE que `transferStayBalanceToReceivable()` creó). Confirmado en
`InvoiceService.finalizeIssued()` (`invoice.service.ts:727-744`): busca la fila
AR por `getByFinancialTransactionId(issued.financialTransactionId)` — la misma
relación, en sentido inverso.

**Camino consolidado:** `invoices.financial_transaction_id` es `NULL`
(`schema.sql:3139`); el vínculo real vive en `invoice_charges.financial_transaction_id`
→ `invoice_charges.invoice_id`, con índice único sobre `financial_transaction_id`
(`schema.sql:3162`) — un mismo cargo no puede terminar en dos facturas.
Confirmado en `InvoiceService.requestConsolidatedInvoice()`
(`invoice.service.ts:479`): arma `invoice_charges` con
`financialTransactionId: ar.financialTransactionId`.

**Método nuevo:** `InvoiceRepository.getInvoiceIdByFinancialTransactionId(financialTransactionId)`
prueba primero `invoices` (individual, `status='ISSUED'`), después
`invoice_charges` (consolidada). Un solo query, `COALESCE`. Devuelve `null` si
ninguno matchea (no debería pasar si `financial_transaction_id` no es null y el
AR llegó a FACTURADO — ver §3).

## 3. `markCollected()` — diseño final

```
ar = arRepo.getById(id)
si no existe -> AccountReceivableNotFoundError
si ar.status === 'COBRADO' -> return ar   (idempotente, ver §5 más abajo)
si ar.status !== 'FACTURADO' -> InvalidAccountsReceivableTransitionError

invoiceId = ar.financialTransactionId
  ? invoiceRepo.getInvoiceIdByFinancialTransactionId(ar.financialTransactionId)
  : null

transactionManager.run:
  si invoiceId:
    { appliedAmount, excessAmount } = applyCappedPaymentToInvoice(invoiceRepo, client, invoiceId, ar.amount)
      -- mismo lock que recordPayment() (FOR UPDATE OF i, A8.1/A8.2) --
    PAYMENT(applied, settledInvoiceId=invoiceId, idempotencyKey=`ar-collect:${id}`)
    si excessAmount > 0:
      PAYMENT(excess, settledInvoiceId=null, idempotencyKey=`ar-collect:${id}:sin-asignar`)
  si no (fallback legacy, §5.1):
    PAYMENT(ar.amount, settledInvoiceId=null, idempotencyKey=`ar-collect:${id}`)

  updated = arRepo.markCollectedWithClient(client, id)
  si updated -> return updated
  si no (concurrencia real: otra transacción ya commiteó el mismo cobro
         idempotente entre nuestro getById() inicial y este punto):
    current = arRepo.getById(id)   -- fuera de `client`, misma lectura que ya
                                       usa createPaymentChunkWithClient para
                                       dedupe (pool, no la transacción abierta)
    si current.status === 'COBRADO' -> return current   (idempotente)
    si no -> throw (invariante roto de verdad, no concurrencia esperada)
```

## 4. Primitiva compartida — decisión #7 del checkpoint aplicada

`src/clientes-finanzas/payment-application.ts` (nuevo). Dos funciones puras,
extraídas de `CustomerAccountService.recordPayment()`/`createPaymentChunkWithClient`
sin cambiar su comportamiento (mismo output, mismos tests O2-F1 en verde):

- `applyCappedPaymentToInvoice(invoiceRepo, client, invoiceId, requestedAmount)`
  — capa el `getOutstandingForUpdate()` + `Math.min` que antes vivía inline en
  `recordPayment()`.
- `createIdempotentPaymentWithClient(financialRepo, client, tx)` — antes era
  el método privado `createPaymentChunkWithClient` de `CustomerAccountService`.

Por qué no una llamada service-a-service: rompería bounded context
(`AccountsReceivableService` no debe depender de `CustomerAccountService` ni
viceversa — ver `app-main/CLAUDE.md` "Bounded contexts"). Una primitiva a nivel
de módulo, sin estado, que recibe el `client` transaccional ya abierto, no cruza
ningún límite — es exactamente el patrón que ya usa
`domain/audit.ts::updateWithAudit()`.

`CustomerAccountService.recordPayment()` se refactoriza para llamar a las
mismas dos funciones en vez de su copia inline/privada — **sin cambiar su
comportamiento observable**. Los 20 tests unitarios + 4 de integración de O2-F1
(incluida la concurrencia real, factura 1000 + dos pagos de 600) se vuelven a
correr después del refactor para confirmarlo antes de tocar nada más.

## 5. Idempotencia de `markCollected()`

Antes: repetir `markCollected()` sobre una fila ya `COBRADO` lanzaba
`InvalidAccountsReceivableTransitionError` (409) — un reintento de red se veía
como un error de negocio.

Ahora: `ar.status === 'COBRADO'` devuelve la fila tal cual, sin tocar la base.
Sigue siendo genuinamente inválido (409) cobrar algo que nunca llegó a
`FACTURADO` (`PENDIENTE_FACTURAR` → `markCollected()` directo). El test unitario
`accounts-receivable.service.test.ts` ("rechaza si ya está COBRADO") se
actualiza para reflejar esto — es un cambio de comportamiento deliberado, no
una regresión.

## 6. Visibilidad — F2.1 y F2.2

**F2.1** — `getOutstandingByCustomerId()` (`sql.invoice.repository.ts:130`) hace
`JOIN financial_transactions ft ON ft.id = i.financial_transaction_id`, que
excluye toda factura consolidada (`financial_transaction_id IS NULL` a
propósito). Fix: permitir `i.financial_transaction_id IS NULL` (consolidada,
siempre válida — nunca se genera para un `REFUND`) O `ft.type = 'CHARGE'`
(individual, filtro original preservado). Efecto colateral bueno: el modal de
conciliación de "Registrar Pago" (`CustomerAccountService.getOutstandingInvoices()`,
que llama a este mismo método) empieza a mostrar consolidadas sin tocarlo.

**F2.2** — no existe endpoint para listar las facturas de un cliente (cualquier
estado, no solo con saldo). Se extiende `GET /api/invoices` con
`?customerId=...` (nuevo, junto al `?financialTransactionId=...` existente),
respaldado por `InvoiceRepository.getByCustomerId()` nuevo — mismo patrón de
la ruta ya existente, mismo rol (`FRONT_DESK`), sin gate de módulo (mismo
criterio que el resto de los GET de facturación: un DOCUMENTO fiscal ya emitido
no puede quedar detrás de un entitlement revocable, `invoices.routes.ts:14-20`).

## 7. Qué NO cambia

- El camino per-reservation existente (`financial_transaction_id` poblado en
  `invoices`) — sin tocar.
- `invoice_ref` sigue siendo texto de display, no se convierte en FK.
- Ninguna factura ni fila `accounts_receivable` histórica se edita — A3.8
  (financieras: solo INSERT).
- O2-F1 no se reabre — se refactoriza su código interno preservando su
  comportamiento (§4), no su contrato ni sus decisiones de negocio.

## 7.1 — Hallazgo crítico durante la implementación: el lock de O2-F1 no era seguro bajo concurrencia genuina

**No estaba en el alcance previsto de O2-F2, pero apareció al escribir el test
de concurrencia real que el propio checkpoint exige (§9) — se corrigió acá
porque `getOutstandingForUpdate()` es la primitiva compartida con O2-F1
(§4), no un archivo nuevo.**

El primer test de concurrencia real (`markCollected()` + `recordPayment()`
simultáneos contra la misma factura, `Promise.all`) falló de forma
**determinística** (4/4 corridas): total aplicado 2000 sobre una factura de
1000 — exactamente el defecto que O2-F2 se propuso cerrar, reapareciendo por
una vía distinta.

**Causa raíz, aislada con una reproducción mínima contra Postgres real
(Neon), fuera de cualquier capa de servicio:** `getOutstandingForUpdate()`
hacía `SELECT (subconsultas correlacionadas contra financial_transactions)
FROM invoices i WHERE i.id = $1 FOR UPDATE OF i` en **una sola sentencia**.
Si esa sentencia tiene que **esperar** el lock (otra transacción lo tenía
tomado) y esa otra transacción **no modificó la fila de `invoices`** (sólo
insertó en `financial_transactions`, tabla distinta — exactamente el caso de
`markCollected()`/`recordPayment()`), Postgres no vuelve a tomar una foto
nueva para las subconsultas correlacionadas al desbloquear: la sentencia
"gana" el lock pero **lee con la foto de antes de esperar**. Confirmado
directamente: dentro de la MISMA transacción, inmediatamente después de esa
sentencia, un `SELECT` plano sobre `financial_transactions` **sí** veía la
fila recién commiteada por la otra transacción — sólo la sentencia con `FOR
UPDATE` bloqueada quedaba con la foto vieja.

**Por qué el test de concurrencia de O2-F1 (factura 1000, dos pagos de 600)
nunca lo detectó:** no es que el mecanismo fuera correcto — es que su
timing (dos llamadas idénticas, con el mismo costo de round-trips antes de
la transacción) nunca disparó una espera **real** por el lock en esa
corrida particular. El mecanismo tenía el defecto desde que se escribió
(23/08 → O2-F1, 03/09); simplemente ningún test hasta ahora lo puso en la
situación exacta que lo dispara (una transacción más rápida en llegar al
lock que la otra, con la más lenta bloqueándose de verdad).

**Fix, verificado con la MISMA reproducción mínima antes de tocar el código
de servicio:** partir `getOutstandingForUpdate()` en dos sentencias dentro
de la misma transacción — `SELECT 1 FROM invoices WHERE id = $1 FOR UPDATE`
(sólo el lock, sin subconsultas que puedan quedar con foto vieja) y después
`SELECT (mismas subconsultas) FROM invoices i WHERE i.id = $1` (sentencia
nueva, corre DESPUÉS de obtener el lock, con una foto tomada en ese momento
— ya no puede quedar vieja). Sin cambio de contrato: mismo `client`, misma
transacción, mismo tipo de retorno.

**Verificación:** la reproducción mínima (fuera de la suite) pasó de fallar
2000/1000 a devolver 0 correctamente; el test de concurrencia real de O2-F2
pasó 4/4 corridas tras el fix; **la suite de concurrencia de O2-F1 (factura
1000, dos pagos de 600) se re-corrió después del fix y sigue en verde**
(sigue dando exactamente 1000 aplicado, 200 sin asignar); toda la suite de
integración completa (14 archivos, 113 tests, `--no-file-parallelism`,
Postgres real) se re-corrió después del fix sin regresiones.

**Alcance de este fix:** un archivo (`sql.invoice.repository.ts`), un
método (`getOutstandingForUpdate`), sin cambio de firma ni de contrato. No
reabre ninguna decisión de negocio de O2-F1 — corrige que la garantía de
concurrencia que O2-F1 ya declaraba cerrada **se sostenga de verdad** bajo
cualquier orden de llegada, no sólo bajo el orden que su propio test
ejercitaba.

## 7.2 — Limitación menor registrada (architecture-governor, tercera pasada)

`ar` y `invoiceId` se resuelven antes de abrir la transacción y no se releen
después del lock de la fila AR (§7.3 abajo) — funciona porque el
`idempotencyKey` es 1:1 con la fila y el PAYMENT + `COBRADO` commitean
atómicamente juntos; el único interleaving posible es que `invoiceId`
resuelva a `null` (fallback legacy) porque la factura todavía no era
`ISSUED` en el instante exacto de la lectura — alcanzable sólo por la ruta
manual `mark-invoiced`, impacto bajo, degrada hacia un camino ya sancionado
por el dueño (§1).

## 7.3 — O2F2-A: el lock de la factura no alcanza para `markCollected() × markCollected()`

Ver `docs/pendientes-2026-09-03.md` (sección O2-F2) para la cronología
completa del hallazgo, el fix insuficiente inicial y el experimento
rojo-verde que confirmó el fix real. Resumen: el fix de §7.1 (lock +
lectura separados) resuelve `markCollected() × recordPayment()`, pero
**no** resuelve dos `markCollected()` sobre la MISMA fila AR corriendo en
paralelo — ahí el recurso que compite es la fila `accounts_receivable`, no
la factura. Fix: `SELECT 1 FROM accounts_receivable WHERE id = $1 FOR
UPDATE` como primera sentencia de la transacción, antes del chequeo de
idempotencia. Orden de locks verificado sin riesgo de deadlock ABBA (único
`FOR UPDATE` sobre `accounts_receivable` en todo `src/`; `markInvoiced()`
corre fuera de transacción, sobre el pool).

## 7.4 — O2F2-B: la misma carrera en `recordPayment()`, resuelta con advisory lock

`erp-audit-orchestrator` encontró la misma forma del defecto en
`CustomerAccountService.recordPayment()` (O2-F1, ya mergeada). `architecture-governor`
recomendó registrarlo aparte, sin corregirlo en este bloque, dado que toca
una feature ya cerrada y el fix no es un copy-paste de O2F2-A. **El dueño,
consultado explícitamente, pidió corregirlo en este mismo bloque** — se
priorizó esa instrucción.

Diferencia clave con O2F2-A: `markCollected()` tiene una fila
`accounts_receivable` real y 1:1 con su `idempotencyKey` para lockear;
`recordPayment()` no — su `idempotencyKey` lo provee el caller y cubre N
allocations, no hay una fila que represente "esta operación" antes de que
exista. Fix: `SELECT pg_advisory_xact_lock(hashtext($1))` sobre el
`idempotencyKey`, como primera operación de la transacción, sólo cuando el
caller manda una clave. Serializa toda llamada concurrente que comparta esa
clave (el escenario real: un reintento de transporte con la request
original todavía en vuelo) sin necesitar una fila física — se libera solo
al COMMIT/ROLLBACK (`_xact`), mismo ciclo de vida que un lock de fila.

Mismo estándar de verificación que O2F2-A: experimento rojo-verde (lock
deshabilitado temporalmente → 3/6 corridas en rojo del test nuevo; lock
restaurado → 8/8 en verde).

## 8. Criterios de aceptación (heredados de §9 del checkpoint, sin cambios)

Factura individual y consolidada: `CHARGE → AR FACTURADO → markCollected() →
PAYMENT vinculado (settledInvoiceId) → saldo de factura 0 → AR COBRADO`.
Concurrencia real (dos pools, `markCollected()` vs `recordPayment()` sobre la
misma factura): cobro total aplicado ≤ saldo, sin PAYMENT duplicado, sin saldo
negativo, sin AR/invoice en estados contradictorios. Idempotencia: repetir el
mismo cobro no crea un segundo PAYMENT ni devuelve 409.

Validación técnica antes de cualquier commit: `tsc --noEmit`, `lint`,
`lint:arch` limpios; suite unitaria completa; suite de integración completa
contra Postgres real, `--no-file-parallelism`.

## 9. No hacer

- No commitear ni pushear sin autorización explícita del dueño — este
  documento habilita implementar, no pushear.
- No tocar Caja, Refund/C2, `O1-b`, `ORDER-15`, A7.6 — fuera de alcance
  ("solo O2-F2").
- No migrar ni tocar filas AR legacy (§5.1 — decisión tomada, no reabrir).
