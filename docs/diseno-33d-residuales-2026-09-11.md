# Diseño: cierre de los 2 residuales de 3.3-d

**Fecha:** 2026-09-11 (madrugada, sesión que empezó el 10/09). **Gate:**
`architecture-governor`, ronda 1 pendiente de envío. Últimos 2 ítems del
listado de 8 que el dueño pidió encarar. Ambos "no urgentes, 0 casos
reales hoy" en `docs/pendientes-2026-09-10.md` -- se encaran igual porque
el dueño pidió cerrar la sesión.

## 0. Grounding ERP (residual 1, hecho vía fork -- reportado completo)

**Odoo 19 tiene el patrón exacto, a nivel de LÍNEA.**
`account.partial.reconcile` (`addons/account/models/account_partial_reconcile.py:10-24`)
vincula pares de **`account.move.line`** (no de `account.move`/documento
completo): `debit_move_id`/`credit_move_id` son líneas puntuales,
`amount` es lo matcheado entre ESE par. El estado de reconciliación
(`account.move.line.reconciled`) se computa por línea, a partir de la
suma de partials que la tocan -- no por el documento entero.
`_update_matching_number()` (`:193-238`) arma un grafo de líneas
conectadas por partials; una línea sin partials que cubran su residual
completo queda "no reconciliada" aunque el documento tenga OTRAS líneas
ya cubiertas.

**ERPNext reconcilia a nivel de DOCUMENTO completo** (`Payment Entry`,
`payment_entry.py:360,379-386`, `allocated_amount` vs `outstanding_amount`
por `reference_doctype`+`reference_name` -- la Sales Invoice ENTERA, sin
desglose por `Sales Invoice Item`). Es el precedente de lo que este repo
YA hace hoy (F4 por factura entera) -- confirma que es un patrón real,
pero el que el residual señala como insuficiente para el caso
consolidado.

**QloApps** no tiene facturación consolidada multi-reserva -- no aporta
precedente.

**Conclusión citable:** reconciliación por PAR (línea/reserva de origen,
no documento completo) es un patrón ERP real y maduro (Odoo), no una
invención ad-hoc -- mismo criterio que `resolveRefundableForPair()` ya
usa para el MONTO, extendido acá al ESTADO de reconciliación.

## 1. Residual 1 (consolidada-parcial) -- diseño

### 1.1 Qué falla hoy, exacto

`classifyReservationLiveInvoice()` (`sql.invoice.repository.ts:595-652`),
para cada Factura B viva ligada a la reserva (directa o vía
`invoice_charges` para consolidadas), hace dos chequeos sobre la
FACTURA ENTERA:

1. **F4** (`isInvoiceFullyCompensatedByIssuedCreditNotes`,
   `:633-634`): ¿la suma de NC `ISSUED` cubre el `imp_total` de la
   factura completa?
2. **Ledger** (`:639-649`): ¿TODAS las filas `REFUND`/`ADJUSTMENT` que
   revierten esa factura (`reversed_invoice_id = f.id`, sin filtrar por
   `reservation_id`) están `SETTLED`?

Para una reserva R dentro de una factura CONSOLIDADA (N reservas), el
escape emite una NC que cubre SOLO la porción de R
(`resolveRefundableForPair()`, ya implementado y grounded). Consecuencia:
**los dos chequeos preguntan por algo más grande de lo que R puede
resolver por sí sola** -- F4 nunca da 100% a menos que TODAS las
reservas de la consolidada también se cancelen con NC; el ledger cuenta
reversiones de OTRAS reservas de la misma factura. `classifyReservationLiveInvoice()`
devuelve `NOT_RECONCILED` para siempre para R, aunque su porción esté
perfectamente compensada.

**Esto es un falso POSITIVO en la bandeja, no un hueco de seguridad
fiscal** -- ya documentado como tal en el docblock de
`UnreconciledLiveInvoice` (`invoice.entities.ts`). El escape en sí sigue
protegido por otras capas (F4 sobre la factura entera bloquea la
emisión de una NC que no compensa realmente esa porción -- ver
`resolveRefundableForPair`, que es fail-closed ante ambigüedad). Lo que
se corrige acá es la CLASIFICACIÓN posterior (bandeja + severidad de
log en `registrarDesenlace`), no el guard de emisión de la NC.

### 1.2 Diseño -- clasificador por par (CORREGIDO, ronda 1 del gate -- Finding A)

**Corrección de un error de hecho en la versión anterior de esta
sección**: decía "denominador NETO ... consistente: NETO en los dos
lados". Es falso. `resolveRefundableForPair(...).attributedTotal`
(`refund-attribution.ts:233`) es `attributedNeto + attributedIva` --
BRUTO, no neto. El error no era solo de redacción: si alguien más tarde
"corrigiera" la inconsistencia aparente cambiando el denominador a
`attributedNeto` (el campo que sí es neto, `:229`), reintroduciría
exactamente el fail-open de ~21% que `docs/pendientes-2026-09-10.md`
advierte (numerador bruto contra denominador neto). La fórmula de abajo
sí es correcta -- lo que estaba mal era la explicación de por qué.

**Lo que "NETO" significa acá, y lo que NO significa:** la decisión del
dueño de usar NETO (grounding ERPNext, `taxes_and_totals.ts:612-614`) es
sobre la BASE DE PRORRATEO dentro de `distributeGroupAmount()`
(`refund-attribution.ts:119-155`, reparte `subtotal` -- el neto
congelado por ítem -- entre reservas dentro de cada grupo de tasa). Es
una decisión sobre CÓMO REPARTIR, no sobre QUÉ CANTIDAD comparar al
final. La comparación final es **bruto contra bruto**, mismo criterio
que F4 (`imp_total` de la factura vs. `SUM(nc.imp_total)`,
`cancel-with-credit-note.ts:89-94` -- las dos cantidades incluyen IVA).

Nueva función pura en `cancel-with-credit-note.ts` (mismo archivo que
F4, mismo criterio de "doctrina en un lugar"):

```ts
export function isReservationPortionFullyCompensatedByIssuedCreditNotes(
  attributedTotal: number,      // resolveRefundableForPair(...).attributedTotal -- BRUTO (neto+IVA), NO attributedNeto
  issuedCreditNoteTotalForReservation: number,  // BRUTO -- ver §1.2-numerador
): boolean {
  return round2(attributedTotal - issuedCreditNoteTotalForReservation) <= CREDIT_NOTE_COMPENSATION_TOLERANCE;
}
```

Mismo criterio de tolerancia (1 centavo, redondeo) que F4 -- no una
tolerancia nueva.

**El numerador -- `issuedCreditNoteTotalForReservation`, query corregida
(Finding B del gate).** La versión anterior proponía
`SUM(DISTINCT nc.imp_total)`, que dedupliza por VALOR, no por fila --
dos NC distintas que cubren la misma reserva con el mismo importe
(dos reversiones parciales de igual monto) colapsarían en una sola,
recreando en silencio el falso positivo que este bloque existe para
sacar. La forma correcta, calcada del propio patrón de
`getIssuedCreditNoteCompensationTotal()` (F4, líneas 401-413 de
`sql.invoice.repository.ts`, que ya resuelve exactamente este problema
de dedup para el caso "factura entera"):

```sql
SELECT COALESCE(SUM(dedup.imp_total), 0) AS attributed_compensated
  FROM (
    SELECT DISTINCT nc.nc_invoice_id, nc.imp_total
      FROM financial_transactions r
      JOIN (${NC_LINKAGE_UNION}) nc ON nc.reverting_ft_id = r.id
      JOIN invoice_items ii ON ii.invoice_id = nc.nc_invoice_id AND ii.reservation_id = $2
     WHERE r.reversed_invoice_id = $1
       AND r.type IN ('REFUND', 'ADJUSTMENT')
       AND nc.status = 'ISSUED'
       AND nc.cbte_tipo = ANY($3::int[])
  ) dedup
```

Tres cosas que preserva de F4, a propósito, no accidentalmente:
1. **Reusa `NC_LINKAGE_UNION`** (`sql.invoice.repository.ts:93-101`) en
   vez de copiar a mano el UNION individual/consolidada por tercera vez
   -- ese archivo ya documenta (`:84-91`) que un tercer camino
   desalineado a mano es un hueco conocido; esta query es el CUARTO
   consumidor, no un cuarto camino.
2. **Mantiene `nc.cbte_tipo = ANY($3)`** -- sin este filtro, cualquier
   comprobante (no solo NC) que apunte a la FT revertidora sumaría su
   `imp_total`, fail-open. Documentado como riesgo explícito en F4
   (`:349-352`).
3. **Dedup por fila `(nc_invoice_id, imp_total)`**, no por valor.

**El JOIN nuevo** (`invoice_items ii ON ii.invoice_id = nc.nc_invoice_id
AND ii.reservation_id = $2`) filtra a las NC cuyas líneas pertenecen a
la reserva R -- ver §1.6 para el detalle de POR QUÉ esto es seguro
(depende de qué genera esas líneas, no del schema).

El resultado es el **BRUTO (neto+IVA) de la NC completa que cubre esa
reserva** -- ver §1.6 sobre cuándo "la NC completa" es 1:1 con la
reserva (no siempre, hay una excepción declarada) y cuándo no lo es,
a diferencia de la factura original que es 1:N).

**El denominador** es `resolveRefundableForPair(...).attributedTotal`
(`refund-attribution.ts:233`, ya implementado) -- BRUTO, como el
numerador. Los dos lados de la comparación son bruto; el NETO grounded
en ERPNext vive un nivel más abajo, dentro del prorrateo por grupo de
tasa (§1.2, párrafo de corrección arriba) -- no confundir los dos.

### 1.3 Fix del ledger (divergencia 2, mismo bloque) -- CORREGIDO, ronda 2 del gate, Condición 1

**El fail-back de §1.7 tiene que cubrir los DOS chequeos, no solo el
fiscal.** La versión anterior de esta sección aplicaba el scope a
`reservation_id` sin condición -- eso significa que en el camino
`BLOCKED` (§1.7: Nivel A, 9/11 facturas de Demo) el clasificador
quedaría con un chequeo MIXTO: fiscal por factura entera (comportamiento
viejo) + ledger scoped a la reserva (comportamiento nuevo). Para una
consolidada Nivel A eso es una regresión nueva -- el ledger scoped
devuelve un conjunto de filas estrictamente más chico, así que
`total === 0` dispara más seguido y el resultado se corre hacia
`NOT_RECONCILED` -- exactamente el falso positivo que este bloque existe
para sacar, reintroducido en la mayoría de facturas reales de un
tenant. El §1.7 decía "cero regresión declarada" y eso solo era cierto
para la mitad fiscal.

**Corregido: el scope del ledger sigue la MISMA rama que el fiscal.**
```
resultado = resolveRefundableForPair(...)
si resultado.kind === 'RESOLVED':
    fiscal:  attributedTotal vs numerador por par (§1.2)
    ledger:  WHERE reversed_invoice_id = $1 AND reservation_id = $2
             AND type IN ('REFUND', 'ADJUSTMENT')   -- scoped
si resultado.kind === 'BLOCKED':
    fiscal:  imp_total de la factura vs compensación total (F4 tal cual, :633-634)
    ledger:  WHERE reversed_invoice_id = $1
             AND type IN ('REFUND', 'ADJUSTMENT')   -- SIN scope, tal cual hoy (:639-649)
```
Las dos mitades preguntan siempre por el MISMO sujeto (la porción de R
si se pudo resolver; la factura entera si no) -- evita mezclar "¿la
porción de R está compensada?" con "¿las reversiones de la factura
ENTERA están settled?", que es justo cómo nació la divergencia 2
original. Con esto, el camino `BLOCKED` es byte-a-byte el
comportamiento de hoy en los dos chequeos, no solo en uno.

### 1.4 Dónde se cablea -- CORREGIDO, ronda 1 del gate, Finding C

**El supuesto original era falso.** Decía "las órdenes no tienen
facturación consolidada multi-orden". El gate lo verificó contra el
código y lo contradice: `InvoiceService.requestConsolidatedInvoice()`
(`invoice.service.ts:481`) consolida TODAS las filas `accounts_receivable`
pendientes de un cliente-empresa, y en `:540-541` arma y lockea
(`FOR UPDATE`) tanto `orderIds` como `reservationIds` a partir de esas
filas -- la unidad de consolidación es el LOTE de cuentas por cobrar del
cliente-empresa, no "reservas". Nada en ese camino restringe el lote a
cargos de reserva. El gate no terminó de trazar si un lote
multi-orden es alcanzable HOY con los datos reales (depende de qué
filas de `accounts_receivable` apuntan a qué, vía
`accounts-receivable.service.ts:176`) -- pendiente, no cerrado.

**Consecuencia:** `classifyReservationLiveInvoice()` se queda como el
único que recibe el fix por par en ESTE bloque, pero el motivo real ya
NO es "las órdenes no pueden consolidar" (falso) -- es que:
1. El caso reachable hoy (0/15, medido) es del lado reservas.
2. Ampliar a `classifyOrderLiveInvoice()` en el mismo commit duplica la
   superficie de riesgo sin caso real que lo justifique -- mismo
   criterio de "un bloque chico por vez" que ya se usó en
   `OUTBOX-BACKOFF-01` para dejar `company_catalog_propagation_queue`
   afuera.
3. **El hueco del lado órdenes queda registrado como residual abierto
   nuevo** (`ORDER-CONSOLIDATED-PARTIAL-01`, ver `docs/pendientes-2026-09-10.md`
   tras el cierre de este bloque), no declarado inexistente.

`classifyOrderLiveInvoice()` sigue usando F4 por factura entera, sin
cambios en este bloque -- correcto por alcance, no por imposibilidad
estructural.

Dentro de `classifyReservationLiveInvoice()`: se calcula SIEMPRE la
porción por par (no un `if (consolidada)` sobre la forma del dato) --
para una factura INDIVIDUAL la porción de la única reserva coincide con
la factura entera, así que el mismo camino da la misma respuesta que
F4 daba antes. Ver §1.7 para el caso en que el par NO se puede resolver
(`BLOCKED`) -- ahí SÍ hay una bifurcación, pero es sobre un resultado
tipado que el resolver ya devuelve, no sobre una propiedad de forma del
dato ("¿es consolidada?").

### 1.5 Impacto en `listUnreconciledLiveInvoices()` y en `registrarDesenlace`

Ambos consumen `classifyReservationLiveInvoice()` -- el fix se propaga
solo, sin tocar esos dos archivos. El falso positivo de la bandeja
desaparece para el caso consolidado-parcial; `registrarDesenlace()`
deja de escalar a "grave" una reserva de consolidada correctamente
reconciliada por su propia NC.

### 1.6 Matriz extendida -- productores de `invoice_items.reservation_id` (Finding E del gate)

La versión anterior solo nombraba `creditNoteLinesFromInvoiceItems`. Hay
2 productores más, los dos en `invoice.service.ts`, que cambian qué
tan segura es la premisa "la NC del escape es 1:1 con la reserva":

**1. `buildCreditNote()` tiene TRES ramas, no una:**
- Reversión total (`:754-757`) -- copia TODAS las líneas de la factura,
  incluidas las de OTRAS reservas. Si esta rama se usa sobre una
  reserva R de una consolidada, la NC resultante tiene `imp_total` =
  factura ENTERA pero líneas de VARIAS reservas -- el JOIN nuevo
  (`ii.reservation_id = R`) la encuentra igual, y contarla en su
  totalidad contra el `attributedTotal` de R da la respuesta correcta
  (la NC compensa MÁS que la porción de R, así que R queda
  sobre-compensada, nunca sub-compensada -- fail-closed en la dirección
  seria), **pero por una razón distinta a la que decía la versión
  anterior** ("1:1 con la reserva" es falso para esta rama).
- Rama por par (`:794-833`) -- filtra a una sola reserva. Acá sí es 1:1.
- Rama proporcional legacy (`:861-871`) -- emite **una línea sintética**
  con `subtotal: amountToReverse` (**BRUTO**, en una columna que en
  todos los demás casos es NETO) y `reservationId: tx.reservationId ?? null`.

**El invariante que mantiene seguro el numerador no es del schema, es
una PROPIEDAD DE ESTAS TRES RAMAS**: "ninguna NC lleva líneas de más de
una reserva mientras cubre MENOS que la factura entera". Si una cuarta
rama apareciera, o la rama 3 emitiera múltiples líneas, el numerador
podría quedar fail-open sin que nada lo detecte. **Declarado acá, en el
docblock de la función nueva (§1.2), y en el propio `buildCreditNote()`**
como precondición de la que depende código en otro archivo.

**2. `resolveOrderItemLine()` (`:288-306`)** setea `reservationId:
item.reservationId` para ítems de orden de tipo `RESERVATION` -- las
facturas de ORIGEN orden también pueden llevar `invoice_items.reservation_id`.
Nota aparte, sin afirmar que sea un bug vivo (no verificado si es
alcanzable): esa función devuelve `orderItemId` Y `reservationId` no
nulos a la vez, mientras `chk_invoice_item_origin`
(`src/db/schema.sql:2996-2999`) es un XOR estricto -- o el camino es
inalcanzable, o revienta al insertar. Ya tiene historia de auditoría
(`docs/diseno-factura-borrador-2026-08-31.md` §17). No se toca en este
bloque -- si resulta ser un bug vivo, es su propio bloque con su propio
gate, no un rider acá.

### 1.7 `resolveRefundableForPair()` puede devolver `BLOCKED` -- fail-back declarado (Finding D del gate)

**Hueco real que la versión anterior no contemplaba.**
`resolveRefundableForPair()` devuelve `BLOCKED` (no un número) en 3
casos (`refund-attribution.ts:105-109`, `:165-178`): sin `invoice_items`
(facturas Nivel A, **9 de las 11 facturas de la tenant `Demo` están en
este caso**, medido `refund-attribution.ts:46-48`), la reserva pedida
no aparece en ningún ítem, o un grupo de tasa sin entrada congelada en
`afip_request.Iva[]`.

El diseño anterior no decía qué hace el clasificador nuevo con
`BLOCKED`. Las dos respuestas obvias son malas:
- Tratar `BLOCKED` como NO reconciliado → **regresión real**: TODA
  factura Nivel A (la mayoría de las reales, 9/11 en Demo) pasa a dar
  falso positivo permanente en la bandeja, incluidas facturas
  INDIVIDUALES que F4-factura-entera clasificaba bien hoy. El fix
  empeora exactamente lo que existe para arreglar.
- Tratar `BLOCKED` como reconciliado → fail-open.

**Decisión de diseño: fail-back declarado a F4-factura-entera.**
```
resultado = resolveRefundableForPair(...)
si resultado.kind === 'RESOLVED':
    comparar attributedTotal vs numerador por par (§1.2)
si resultado.kind === 'BLOCKED':
    comparar imp_total de la factura vs compensación total (F4 tal cual
    existe hoy, sql.invoice.repository.ts:633-634) -- comportamiento
    IDÉNTICO al actual para el caso Nivel A / anomalía, sin regresión.
```
Esto sigue siendo "un solo camino" en el sentido que importa
(DEFENSIVE_DEVELOPING §1.5, un solo camino por responsabilidad): no es
un `if (¿es consolidada?)` sobre una propiedad de forma del dato, es un
fail-back sobre un RESULTADO TIPADO que el resolver ya devuelve. El
comportamiento actual queda intacto en todo caso donde la maquinaria
nueva no puede hablar (Nivel A, anomalías) -- cero regresión declarada,
no solo asumida.

### 1.8 Wiring -- `client` explícito, no `this.db` (Finding F del gate)

`classifyReservationLiveInvoice(client, reservationId)` recibe un
`client` explícito y TODAS sus queries lo usan. El helper obvio para
leer `invoice_items`/`afip_request` de la factura --
`getItemsByInvoiceId()` (`sql.invoice.repository.ts:951`) -- usa
`this.db`, NO un parámetro `client`. Usarlo acá cambiaría de conexión en
silencio (la pregunta exacta de DEFENSIVE_DEVELOPING §3: ¿`req.db` o el
pool del `TransactionManager`?). En el camino del outbox `db` es el
`SqlClient` del tenant que cablea `outbox.registry.ts`, así que hoy no
es fatal -- pero es la misma clase de mezcla que ya causó incidentes en
este repo. **Las queries nuevas para `invoice_items`/`afip_request`
tienen que tomar `client` como parámetro explícito, no reusar
`getItemsByInvoiceId()` ni `getById()` tal cual están.**

### 1.9 Riesgo declarado, no resuelto en este bloque

**3.3-d residual 1 original citaba "0/15 reservas en factura
consolidada"** -- sin casos reales, este fix no tiene forma de
verificarse con datos de producción. Todo el testing es de integración
fabricada (mismo patrón que `unreconciled-live-invoices.integration.test.ts`).

**Costo N×M, señalado por el gate, no resuelto acá:**
`listUnreconciledLiveInvoices()` (`sql.invoice.repository.ts:700-706`)
recorre un conjunto de candidatos SIN paginar ni acotar, y es alcanzable
por HTTP (`invoices.routes.ts:151`). El clasificador por par agrega
queries nuevas por candidato -- amplifica el costo por invocación de esa
ruta. Los dos consumidores además difieren en tolerancia a fallo: el
outbox envuelve el clasificador en un try/catch fail-closed
(`outbox.handlers.ts:197-206`); la ruta HTTP no. Ninguno de los dos se
toca en este bloque -- paginación/límite de la bandeja es su propio
ítem, ya candidato a quedar registrado en pendientes si no se encara
ahora.

## 2. Residual 2 (reserva con PAYMENT propio) -- diseño

### 2.1 Descubrimiento de la matriz -- CORREGIDO, ronda 1 del gate

**La versión anterior solo analizó 3 de los 6 valores posibles del lado
reserva, y no analizó el lado orden en absoluto.** Corregido acá con
los 2 conjuntos completos.

**Lado reserva -- `rechazosDeReserva()` (`sql.financial-transaction.repository.ts:312-322`),
6 valores, no 3:**
- `RESERVA_INEXISTENTE`, `RESERVA_ESTADO_NO_ELEGIBLE`, `ESTADO_DESCONOCIDO`
  -- en el contexto de `handleReservationCancelled` la reserva YA debe
  estar `CANCELLED` (el evento solo se dispara post-transición), así que
  estos 3 deberían dar 0 -- pero es un argumento a sostener, no un
  supuesto a saltear (`estado_desconocido` además duplica conteo con
  `reserva_no_elegible` por diseño declarado en el propio comentario del
  archivo, `:409-421`). Ninguno de los 3 entra al allowlist -- son
  anomalías genuinas, nunca benignas.
- `con_comprobante_vivo` → `CARGO_CON_COMPROBANTE_VIVO` -- SIEMPRE
  presente cuando el escape corrió (la CHARGE original, y la propia
  ADJUSTMENT compensatoria si la NC apunta a ella con
  `financial_transaction_id` -- verificado: el contador es un booleano
  por candidato-set, así que dos filas "vivas" siguen emitiendo UN solo
  string `CARGO_CON_COMPROBANTE_VIVO`, no lo duplican).
- `tipo_no_liquidable` (`ft_type NOT IN ('CHARGE','ADJUSTMENT')`) →
  `TIPO_NO_LIQUIDABLE` -- **alcanzable siempre que la reserva tuvo un
  `PAYMENT` (seña vía `recordPayment()`, camino común -- C1-Fase A) o un
  `REFUND` previo** en su historia. No hace falta que ese REFUND/PAYMENT
  tenga relación con el escape en sí -- basta que exista en la tabla.
- `anulados` (`ft_status IN ('VOIDED','FAILED')`) → `CARGO_ANULADO` --
  alcanzable si algún intento previo de CHARGE/ADJUSTMENT quedó
  VOIDED/FAILED antes del que terminó vivo (ej. un reintento de
  facturación fallido).

**Combinaciones reachable identificadas, lado reserva (mínimo 4, no 3):**
1. `{CARGO_CON_COMPROBANTE_VIVO}` -- caso limpio, el único que hoy pasa
   el guard exacto.
2. `{CARGO_CON_COMPROBANTE_VIVO, TIPO_NO_LIQUIDABLE}` -- reserva con
   seña cobrada (muy común, cualquier reserva con depósito).
3. `{CARGO_CON_COMPROBANTE_VIVO, CARGO_ANULADO}` -- reintento de cargo
   fallido antes del vigente.
4. `{CARGO_CON_COMPROBANTE_VIVO, TIPO_NO_LIQUIDABLE, CARGO_ANULADO}` --
   combinación de 2+3.

**Lado orden -- `rechazosDe()` (`sql.financial-transaction.repository.ts:487-499`),
CONJUNTO DE VALORES DISTINTO, 8 valores, no analizado en la versión
anterior** (corregida la enumeración, ronda 2 del gate -- Condición 2:
tenía 9 nombres bajo un conteo de 8; `CARGO_YA_EXISTE` existe en el tipo
`EfectoRechazo` pero lo emite el camino de CREACIÓN de cargo, no
`voidByOrderId()` -- no pertenece a esta lista):
`ORDEN_INEXISTENTE`, `ORDEN_DE_OTRO_NEGOCIO`,
`ORDEN_ESTADO_NO_ELEGIBLE`, `ESTADO_DESCONOCIDO`,
`CARGO_YA_SETTLED`, `CARGO_ANULADO`, `TIPO_NO_LIQUIDABLE`,
`CARGO_CON_COMPROBANTE_VIVO`. El predicado de §2.3 se propone aplicar
también al call site de `handleOrderCancelled` (`:487-491`) -- ese
predicado se estaba justificando SOLO con el razonamiento del lado
reserva. Verificado antes de proponerlo igual:
- `ya_settled` está HARDCODEADO a `0::int` en `voidByOrderId`
  (`:783`) -- `CARGO_YA_SETTLED` es inalcanzable ahí, no afecta.
- `tipo_no_liquidable` usa el MISMO `ft_type NOT IN ('CHARGE','ADJUSTMENT')`
  en los dos lados (`:431` reserva, `:787` orden) -- la propia
  ADJUSTMENT que crea el escape nunca lo dispara. Bien -- si lo
  disparara, cada escape de orden tropezaría con esto.
- **`TIPO_NO_LIQUIDABLE` del lado orden es, hoy, probablemente un
  NO-OP**: revisé cada productor no-test de `PAYMENT`
  (`customer-account.service.ts:144,268,296`,
  `accounts-receivable.service.ts:136,357,398`) y de `REFUND`
  (`cancellation-refund.service.ts:335`) -- **ninguno setea `orderId`**.
  "Probablemente no-op hoy" queda escrito acá, no descartado por
  supuesto -- si algún día un productor nuevo crea un PAYMENT/REFUND con
  `orderId`, el allowlist ya lo cubre sin tener que volver a tocar este
  archivo.

### 2.2 Guard actual -- TRES call sites con la misma condición exacta, no dos

Contradicción a corregir respecto de lo que decía `pendientes-2026-09-10.md`
("dos guardas"): son **tres** call sites físicos con
`rechazos.length === 1 && rechazos[0] === 'CARGO_CON_COMPROBANTE_VIVO'`:
- `outbox.handlers.ts:189-193` (`handleReservationCancelled`, decide si
  vale la pena llamar a `classifyReservationLiveInvoice`).
- `outbox.handlers.ts:487-491` (`handleOrderCancelled`, mismo patrón
  para `classifyOrderLiveInvoice`).
- `outbox.handlers.ts:336-340` (dentro de `registrarDesenlace()`, decide
  la severidad del log).

Ensanchar solo `registrarDesenlace()` no alcanza: si el pre-check de
`handleReservationCancelled`/`handleOrderCancelled` sigue exigiendo el
match exacto, `comprobanteReconciliado` nunca llega a `true` en
presencia de un co-rechazo benigno -- ni siquiera se llama a
`classify*LiveInvoice()`. Los TRES tienen que usar el mismo predicado.

### 2.3 Predicado propuesto -- allowlist positivo (forma que ya pidió el gate)

```ts
/**
 * Co-rechazos que NO indican una anomalía cuando ya se sabe (por afuera,
 * vía classify*LiveInvoice) que el comprobante fiscal está reconciliado.
 * TIPO_NO_LIQUIDABLE: la reserva tiene un PAYMENT/REFUND histórico, sin
 * relación con la operación de void en sí (voidByReservationId/voidByOrderId
 * nunca tocan esas filas). CARGO_ANULADO -- ver §2.4, condicionado.
 */
const CO_RECHAZOS_BENIGNOS_SI_RECONCILIADO: ReadonlySet<EfectoRechazo> = new Set([
  'TIPO_NO_LIQUIDABLE',
]);

function esComprobanteVivoConCoRechazosBenignos(rechazos: readonly EfectoRechazo[]): boolean {
  return rechazos.includes('CARGO_CON_COMPROBANTE_VIVO')
    && rechazos.every((r) => r === 'CARGO_CON_COMPROBANTE_VIVO' || CO_RECHAZOS_BENIGNOS_SI_RECONCILIADO.has(r));
}
```

Reemplaza el exact-match en los 3 call sites de §2.2.

### 2.4 `CARGO_ANULADO` -- NO lo incluyo en el allowlist, pregunta abierta para el gate

Investigado, no asumido: `CARGO_ANULADO` significa "alguna fila
candidata tiene `ft_status IN ('VOIDED','FAILED')`". Para que ESA MISMA
fila también contribuya a `CARGO_CON_COMPROBANTE_VIVO` necesitaría
tener un comprobante `ISSUED`/`PENDING`/`FAILED_UNCERTAIN(afipContacted)`
vinculado -- una fila FAILED/VOIDED con un comprobante fiscal REAL
vinculado es una combinación rara que **podría** indicar una anomalía
genuina (¿cómo terminó FAILED/VOIDED una transacción que tiene un
comprobante AFIP real?), no necesariamente el caso benigno de "un
intento de cargo fallido antes del vigente" que describí en §2.1 combinación 3.
El contador actual (booleano por candidato-set) no distingue "la fila
ANULADA es la MISMA que la vivA" de "son dos filas DISTINTAS" -- no
tengo forma de diferenciar los dos casos con el query actual sin
reescribirlo para devolver el detalle por fila, no por contador
agregado.

**No decido esto sola.** Dejo `CARGO_ANULADO` FUERA del allowlist en la
propuesta (§2.3) -- la opción conservadora, sigue escalando a "grave"
si aparece. Pregunta para el gate: ¿coincidís en dejarlo afuera hasta
poder diferenciar por fila, o hay evidencia de que la combinación
descrita es imposible por otro motivo que no estoy viendo (ej. un CHECK
de schema, o el orden de escritura de `financial_transactions` que lo
impida estructuralmente)?

**Confirmado por el gate, ronda 1 (`sql.financial-transaction.repository.ts:428-429`):**
de acuerdo en dejarlo afuera. Verificado por el gate: `anulados` se
calcula DENTRO del CTE `candidatos`, que lee la foto ANTERIOR al propio
`UPDATE` de esta sentencia (`:428-429`) -- refleja historia, no las
escrituras de ESTE llamado. En el escenario del escape, el handler no
anula nada (la CHARGE queda protegida por el comprobante vivo, la
ADJUSTMENT compensatoria queda protegida una vez su NC está `ISSUED` --
las dos excluidas por el mismo `NOT EXISTS` de `:390-402`), así que
`aplicadas = 0` y el handler no puede fabricar su propio
`CARGO_ANULADO` por redelivery. La única fuente alcanzable sigue siendo
una fila VOIDED/FAILED genuinamente anterior -- la ambigüedad de arriba
queda intacta y sin resolver (un booleano por candidato-set no puede
distinguir "la fila anulada es la viva" de "son dos filas distintas"),
ningún CHECK de schema la cierra. Conservador es correcto. Queda
registrado como residual nombrado con este ancla, para no re-derivarlo
de cero en una sesión futura.

### 2.5 Riesgo declarado

Igual que residual 1: 0 casos reales, todo el testing es fabricado.
`CARGO_ANULADO` queda con el comportamiento actual (escala a grave) --
no es una regresión, es no tocarlo hasta resolver la ambigüedad de §2.4.

## 3. Alcance de este bloque -- 2 commits separados, mismo criterio que OUTBOX-BACKOFF-01

- **Commit A (residual 1):** `cancel-with-credit-note.ts` (función
  nueva), `sql.invoice.repository.ts` (query nueva + fix del ledger +
  cableado en `classifyReservationLiveInvoice`), tests de integración
  fabricados (mismo patrón que `unreconciled-live-invoices.integration.test.ts`).
- **Commit B (residual 2):** `outbox.handlers.ts` (predicado compartido,
  3 call sites), tests unitarios (mismo patrón que
  `outbox.handlers.test.ts`, con fakes -- no requiere Postgres real
  porque `registrarDesenlace()` no toca la BD).

Sin schema nuevo en ninguno de los dos. Sin cambio de comportamiento
observable para el camino feliz (factura individual, sin co-rechazos)
en ninguno de los dos commits.

**Registro pendiente en `docs/pendientes-2026-09-10.md` (a hacer en el
mismo commit que cierre este bloque):** nuevo ítem
`ORDER-CONSOLIDATED-PARTIAL-01` -- el mismo hueco que resuelve el
Commit A del lado reservas (F4 por factura entera en vez de por par)
sigue existiendo del lado órdenes, sin caso real medido hoy, motivo
real declarado en §1.4 (no "las órdenes no consolidan" -- eso es falso
-- sino "alcance de un bloque a la vez").
