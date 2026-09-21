# Diseño — `CITY-LEDGER-AR-DOUBLE-TRANSFER-001` (Wave 13, Zona 1)

18/09/2026. Propuesta de diseño, no implementada todavía. Cubre las 7
condiciones que `architecture-governor` dejó explícitas al cerrar la fase
de descubrimiento (`docs/plan-ejecucion-integral-2026-09-16.md`, Apéndice
I, fila de Zona 1).

## 1. El bug (recordatorio, ya verificado en 3 rondas de descubrimiento)

`linkStayToReservationCharges()`
(`src/clientes-finanzas/sql.financial-transaction.repository.ts:951-960`):

```sql
UPDATE financial_transactions SET stay_id = $1 WHERE reservation_id = $2 AND stay_id IS NULL
```

El CHARGE de empresa que crea `postStayTransfer()`
(`accounts-receivable.service.ts:479-492`) nace con `reservation_id` SET
y `stay_id` NULL a propósito. El `WHERE` de arriba no distingue esa fila
de un CHARGE huérfano legítimo — una segunda transferencia sobre la misma
estadía (o un re-check-in) la adopta, el folio vuelve a dar saldo
positivo, y la misma deuda se transfiere a la empresa dos veces.

## 2. Predicado elegido — C1

**α∧β**, con la columna nombrada explícitamente:

```sql
UPDATE financial_transactions
   SET stay_id = $1
 WHERE reservation_id = $2
   AND stay_id IS NULL
   AND reversed_transaction_id IS NULL
   AND NOT EXISTS (
         SELECT 1 FROM accounts_receivable ar
          WHERE ar.financial_transaction_id = financial_transactions.id
       )
```

**Por qué α∧β y no un candidato más chico:**

- **α solo** (`reversed_transaction_id IS NULL`) cierra
  `CITY-LEDGER-AR-STAY-ADOPTION-RACE-001` (evita adoptar la pata
  `ADJUSTMENT` compensatoria de `reverseTransfer()` mientras está en
  vuelo) pero no toca este hallazgo — el CHARGE de empresa de una
  transferencia vieja nunca tiene `reversed_transaction_id` seteado, es
  el ORIGEN, no una reversa.
- **β solo** (`NOT EXISTS ... financial_transaction_id`) cierra este
  hallazgo pero no la ventana de carrera de RACE-001.
- **γ** (filtrar por `type`) se descartó con evidencia en la ronda de
  descubrimiento: rompe la semántica ya cerrada de
  `CITY-LEDGER-OVERTRANSFER-PAYMENT-001` (la adopción es
  deliberadamente type-agnóstica — también adopta `ADJUSTMENT`/`REFUND`
  huérfanos, decisión del dueño registrada en `resuelto.md`).
- **α∧β** cierra los dos hallazgos abiertos que colisionan en este mismo
  `WHERE`, preserva la semántica cerrada (no filtra por `type`), y es la
  única combinación que no reabre nada.

**Columna exacta:** `accounts_receivable.financial_transaction_id` —
**no** `guest_payment_transaction_id`. El orquestador de la ronda de
descubrimiento corrigió un riesgo que yo mismo había planteado mal: esa
segunda columna es estructuralmente inadoptable (su única fila productora
nace con `reservation_id NULL`, falla la primera cláusula del `WHERE` por
construcción), así que no hace falta nombrarla en el `NOT EXISTS` — no
protege nada que no esté ya protegido, y agregarla sería ruido, no
defensa.

**C4 (gate de diseño, 18/09/2026) — por qué `reversed_invoice_id` NO
está en el predicado, a propósito.** Hay dos columnas de nombre parecido
y semántica distinta: `reversed_transaction_id` (`schema.sql:~3487`,
la que usa α — auto-referencial DENTRO de `financial_transactions`,
producida solo por `reverseTransfer()`) y `reversed_invoice_id`
(`schema.sql:3416`, `CHECK type IN ('REFUND','ADJUSTMENT')` — la que
usan los `ADJUSTMENT` de una Nota de Crédito para apuntar a la factura
que compensan). Los `ADJUSTMENT` de NC **tienen que seguir siendo
adoptables** por `linkStayToReservationCharges()` — son cargos legítimos
de la reserva/estadía, no filas de City Ledger — así que el predicado
deliberadamente NO excluye por `reversed_invoice_id`. Si alguien lee
"`reversed_transaction_id`" y lo confunde con "`reversed_invoice_id`" al
tocar este `WHERE` en el futuro, terminaría excluyendo por accidente
todos los `ADJUSTMENT` de NC de la adopción — dejado escrito acá para
que no pase.

**Concurrencia — por qué β no tiene ventana de carrera propia.** β lee
`accounts_receivable` fuera de la transacción de
`transferStayBalanceToReceivable()` (`accounts-receivable.service.ts:307`,
"FUERA de la transacción a propósito"), lo cual bajo READ COMMITTED
sería en principio un riesgo de visibilidad — salvo que el CHARGE de
empresa y su fila de AR se insertan en la MISMA transacción, dentro de
`postStayTransfer()` (`:479-500`). No hay ventana en la que el CHARGE
sea visible sin su AR todavía. **Esta seguridad es una propiedad de la
atomicidad de `postStayTransfer()`, no del predicado** — si alguna vez
se separan esos dos INSERT en transacciones distintas, β vuelve a quedar
expuesto a la misma carrera. Registrado para que quien toque
`postStayTransfer()` en el futuro lo sepa.

## 3. Celda 7 — resuelta, no indeterminada (C2)

Traza completa de `requestConsolidatedInvoice()` (`erp-audit-orchestrator`,
18/09/2026): el CHARGE de empresa **sí** puede terminar en `frozenCharges`
del escape de NC de reservas
(`cancel-reservation-with-credit-note.service.ts`). La hipótesis de
trabajo ("nunca comparten factura con el huésped, así que nunca entran a
`frozenCharges`") era correcta en la premisa y falsa en la conclusión:
`frozenCharges` se arma contra la factura que **gana la resolución** de
`liveInvoiceIdsForReservation()`, y después de una transferencia esa
factura suele ser la consolidada de la empresa — cuya intersección con
la reserva son precisamente los CHARGE de empresa.

Tres mecanismos concretos encontrados, los tres **cerrados por este
predicado** para el camino del CHARGE de empresa:

- **C.1** — `CreditNoteMixedStayError` (`:420-422`) se dispara hoy en el
  escenario de doble transferencia: C1 queda con `stay_id = S` (adoptado
  por la transferencia #2), C2 nace con `stay_id` NULL, `distinctStayIds
  = {S, null}` → tamaño 2 → error. **Con α∧β, C1 nunca se adopta — los
  dos quedan `NULL`, `distinctStayIds = {null}`, el guard pasa.**
  Paso intermedio que sostiene esta conclusión (agregado en el gate de
  diseño, C3): `frozenCharges` solo puede contener CHARGE de empresa
  cuando la factura que gana `liveInvoiceIdsForReservation()` es la
  consolidada — y una factura consolidada contiene SOLO CHARGE de
  empresa (`requestConsolidatedInvoice()` factura los
  `financial_transaction_id` de filas `accounts_receivable`, cuyo único
  productor es `postStayTransfer()`), nunca cargos del huésped. Una
  reserva con cargos del huésped Y de empresa facturados por separado ya
  cae en `CreditNoteReservationMultiInvoiceError` (pool mixto) ANTES de
  llegar a este guard — así que cuando `frozenCharges` no está vacío, es
  homogéneo por construcción: o todo CHARGE de empresa, o todo CHARGE de
  huésped, nunca mezclado.
  **C.1 es un cambio real de comportamiento observable de un camino
  fiscal, no solo un guard que deja de dispararse (C3):** hoy ese
  escenario tira `CreditNoteMixedStayError` y bloquea
  `cancelReservationWithCreditNote()`; con el fix, la operación
  PROCEDE y crea un `ADJUSTMENT` con `stayId: null`. Dirección
  consistente con el principio ya declarado en este repo
  (`docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md`:
  "la app no le dice al cliente cómo trabajar; le permite formalizar
  electrónicamente una decisión que el cliente ya tomó") — el bloqueo
  actual era un efecto secundario del bug de doble transferencia, no una
  protección deliberada contra este escenario específico.
- **C.2** — con una sola adopción (re-check-in o transferencia única
  adoptada), el guard no ve el problema porque *todos* los cargos
  congelados quedan uniformemente en `stay_id = S` — pero eso persiste
  una sub-declaración del folio que el comentario de `:413-418` dice
  estar evitando. **Con α∧β, el CHARGE de empresa nunca cambia de
  `stay_id` después de creado — vuelve a ser el diseño original: siempre
  `NULL`, consistente.**
- **C.3** — `assertRevertsExpectedInvoice` (`:484-503`) re-deriva
  `stayId` en cada reintento; si `linkStayToReservationCharges()` muta
  la columna entre `tx1` y un reintento, la comparación falla con un
  `Error` pelado (500), permanente para esa reserva. **Con α∧β, el
  CHARGE de empresa no puede mutar después de tener AR — la ventana de
  mutación deja de existir para este mecanismo.**

**Lo que α∧β NO cierra, y por qué es correcto que no lo haga:**
`CITY-LEDGER-CROSS-STAY-ADOPTION-001` (hallazgo E.1, registrado por
separado en `docs/pendientes-2026-09-12.md`) — el mismo síntoma
(`CreditNoteMixedStayError`) pero disparado por CHARGEs del **huésped**
adoptados a través de dos estadías distintas sobre la misma reserva
(check-out + re-check-in), sin ningún CHARGE de empresa involucrado. β
es específico de filas referenciadas desde `accounts_receivable` — un
CHARGE de huésped nunca lo está, así que β no lo toca. Es un mecanismo
estructuralmente distinto (huésped contra sí mismo, no huésped contra
empresa) y su propio análisis de si vale un predicado más amplio queda
fuera de este bloque — mezclarlo acá sería resolver dos preguntas de
diseño distintas con una sola respuesta apurada.

También queda fuera, registrado aparte:
`POOL-MIXTO-CONSOLIDADA-INDIVIDUAL-001` — un mecanismo de pool mixto
completamente independiente de este bug (existe hoy con `stay_id`
correcto), encontrado como efecto colateral de la misma traza. No lo
toca este predicado porque no tiene relación causal con la adopción.

## 4. El `Error` pelado de `:493-500` — C3

Con α∧β, el mecanismo C.3 que lo hacía alcanzable (mutación del CHARGE
de empresa entre `tx1` y un reintento) queda cerrado. **No se cambia el
tipo de error en este bloque** — seguiría siendo un `Error` genérico en
vez de un `DomainError`, pero eso es una decisión de manejo de errores
sin relación con el predicado de adopción, y tocarlo acá sería alcance
fuera de lo que este bug pide. Se registra como riesgo residual: el
mecanismo E.1 (huésped contra huésped) puede seguir alcanzando la misma
línea por un camino distinto, así que la fragilidad del tipo de error
sigue viva — candidato a su propio bloque, no de este.

## 5. Hueco legacy — C4

β es ciego a filas de `accounts_receivable`/`financial_transactions`
anteriores a que existiera la columna `financial_transaction_id`
(`schema.sql:3639-3642`, "sin backfill posible"). Es una propiedad
permanente del diseño de la columna, no deuda que este bloque deba
cerrar; queda registrada en el propio hallazgo de pendientes.

**C1/C2 (gate de diseño, 18/09/2026) — medición contra los DOS tenants
reales, no solo uno.** El bloque de descubrimiento había medido un solo
tenant. Corrida en el gate de diseño, 18/09/2026:

```sql
-- proyecto Neon ancient-king-17098519, branch production (br-snowy-tree-ax5wmq70)
SELECT count(*) AS ar_count,
       count(*) FILTER (WHERE financial_transaction_id IS NOT NULL AND stay_id IS NULL)
         AS company_charge_orphan_candidates
FROM accounts_receivable;
-- ar_count: 0, company_charge_orphan_candidates: 0

-- proyecto Neon ancient-king-17098519, branch tenant-hotel-los-alamos (br-square-leaf-axzvu903)
SELECT (SELECT count(*) FROM accounts_receivable) AS ar_count,
       (SELECT count(*) FROM reservations) AS reservations_count,
       (SELECT count(*) FROM invoices) AS invoices_count;
-- ar_count: 0, reservations_count: 0, invoices_count: 0
```

**Los dos tenants dan 0 filas en `accounts_receivable`.** Respuesta
explícita a la pregunta hacia adelante que el gate señaló que faltaba
(C2 — "¿hay data ya adoptada hoy que este fix deja sin corregir?"): **no
hay ninguna fila ya adoptada, en ningún tenant medido, porque no hay
ninguna fila de AR todavía** — el mecanismo de City Ledger no se usó
todavía en producción. No hace falta remediación de datos. Esto es un
hallazgo medido, no una omisión: si en el futuro aparece una fila de AR
ya adoptada antes de este fix, ese caso queda exactamente en el hueco
legacy de arriba (sin backfill posible) y hereda el mismo tratamiento.

## 6. Estrategia de test — C5

Ninguno de los 7 test doubles de `linkStayToReservationCharges()` en el
repo puede validar un cambio de predicado (los 7 devuelven constantes).
La única cobertura posible es integración contra Postgres real:

**Tests nuevos, `src/tests/integration/`:**
1. **Doble transferencia — resultado único fijado (C5, gate de diseño):**
   transferencia #1 por monto A (600) → segundo cargo nuevo sobre la
   misma estadía por monto B (100, `B > 0` a propósito, para que el caso
   sea determinístico y no dependa de una rama condicional) → intento de
   transferencia #2. **Resultado esperado, uno solo:** se crea AR#2 por
   exactamente B (100) — NO por A+B (700, el bug) y NO se rechaza con
   `NoBalanceToTransferError` (hay saldo real de B por transferir, sería
   incorrecto bloquearlo). El CHARGE de empresa C1 de la transferencia #1
   sigue con `stay_id NULL` después del intento #2 (no fue adoptado).
2. **Re-check-in no adopta el CHARGE de empresa.** Transferencia sobre
   estadía S1 → check-out de S1 → re-check-in (S2) sobre la misma
   reserva → verificar que el CHARGE de empresa sigue con `stay_id
   NULL` después del check-in de S2 (hoy quedaría adoptado a S2).
3. **RACE-001 sigue protegido.** Reproducir el escenario ya cubierto por
   `reverse-transfer.integration.test.ts` para confirmar que α sigue
   excluyendo la pata `ADJUSTMENT` de una reversa en vuelo — no debería
   cambiar de comportamiento, pero se re-corre para confirmar que α∧β no
   interactúa mal con α sola.
4. **Semántica de `OVERTRANSFER-PAYMENT-001` preservada.** Un `REFUND`/
   `ADJUSTMENT` huérfano de RESERVA (no de empresa, sin AR) sigue
   adoptándose normalmente — confirma que β no lo bloquea (no está
   referenciado desde ninguna AR).

**Test existente a corregir en el mismo commit (C6, gate de diseño —
reencuadrado):** `reverse-transfer.integration.test.ts:296-345` — el
comentario (`:299-309`) afirma que el escenario que construye a mano
(`UPDATE financial_transactions SET stay_id = $1 WHERE id = $2` directo,
sin pasar por `linkStayToReservationCharges()`) es *"exactamente lo que
pasaría en la realidad"*. Eso deja de ser cierto por el camino GENERAL
(re-check-in ya no adopta el CHARGE de empresa con α∧β) — pero **no dejó
de ser cierto del todo**: es exactamente el escenario del hueco legacy
declarado en la sección anterior (una fila ya adoptada antes de este fix,
o una fila pre-columna que β no puede ver) más el caso ya medido en
C1/C2 (si algún día aparece una fila así). El test se corrige para dejar
de afirmar que es "el camino real de HOY" y pasa a describirse como
**cobertura de regresión del hueco legacy declarado** — más valioso que
"escenario sintético", porque documenta exactamente qué conjunto de
filas sigue expuesto después del fix. Aprovechar el mismo commit para
corregir la deriva de ancla en su propio comentario: `:306` cita
`stay.service.ts:233-238`, el caller real hoy está en `:235-238`.

## 7. Docblock a corregir — C6

`financial-transaction.repository.ts:528-537` (interfaz), línea `:534-535`:
dice *"Llamado desde StayService.checkIn() una sola vez"* — falso desde
`CITY-LEDGER-OVERTRANSFER-PAYMENT-001` (13/09/2026), hay 2 callers de
producción (`stay.service.ts:235`, `accounts-receivable.service.ts:307`).
Se corrige en el mismo commit que el predicado, junto con una línea
explicando el nuevo `WHERE` (α∧β) y por qué excluye lo que excluye.

## 8. Anclas — C7

Ya corregidas en `docs/pendientes-2026-09-12.md` (bloque de docs previo,
sin commitear): las 4 citas originales (`:921`→`:951`, `:243`→`:307`,
`:245`→`:309`, `:390-399`→`:458-477`) y el resumen del predicado elegido
con la resolución de la celda 7.

## 9. Alcance del cambio y rollback

**Radio:** una sola sentencia SQL, en un solo método
(`linkStayToReservationCharges()`), con 2 callers de producción. Sin
migración de schema (las columnas `reversed_transaction_id` y
`financial_transaction_id` ya existen, de Waves anteriores). Sin cambio
de firma, sin cambio de contrato con `appfrontend-main`.

**Reversión:** `git revert` del commit — el `WHERE` vuelve al estado
anterior, sin efecto sobre filas ya escritas (el predicado nuevo solo
angosta qué se adopta, no reescribe nada ya adoptado). Ninguna fila
escrita bajo el predicado nuevo necesita remediación si se revierte: una
fila que no fue adoptada porque el predicado la excluyó simplemente
sigue con `stay_id NULL`, el mismo estado que tenía antes de este
cambio.

**Verificación de runtime:** ninguna posible en este entorno (sin
`TEST_DATABASE_URL`). Los 4 tests de integración nuevos quedan para
correr cuando el dueño habilite Postgres real, o contra la branch
disponible de Neon si el dueño autoriza usarla para este propósito
(mismo patrón ya usado en Wave 12 para `reverseTransfer()`).

## Criterios de negocio (skill `criterios-negocio`)

`financial_transactions`/`accounts_receivable` ya clasificadas
TRANSACCIÓN (sesión previa). No se crea entidad nueva, no se toca
unicidad de nombres, no se toca dinero (no cambia ningún monto — cambia
qué filas se agrupan bajo qué `stay_id`), no se toca aislamiento
multi-tenant (el `WHERE` sigue filtrado por `reservation_id`/`stay_id`
dentro de la misma conexión de tenant), no se agrega una transición de
estado nueva. R2/R15 no aplican (no es un `findById` ni un batch
parcial). A8.x (concurrencia) ya cubierto por el análisis de α sobre
RACE-001, sin cambios de lock nuevos en este bloque.
