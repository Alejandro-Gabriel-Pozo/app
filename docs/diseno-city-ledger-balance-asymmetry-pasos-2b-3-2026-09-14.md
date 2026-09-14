# Diseño — CITY-LEDGER-CUSTOMER-BALANCE-STATUS-ASYMMETRY-001, pasos 2(b) y 3

Fecha: 2026-09-14. Autor: sesión de diseño (subagente, sin implementar).
**Cerrado.** Paso 2(b) implementado y commiteado (`1dc6c84`). Paso 3
DECIDIDO NO IMPLEMENTAR (§2.9) — ver `docs/resuelto.md`, sección
`14/09/2026`, entrada `CITY-LEDGER-CUSTOMER-BALANCE-STATUS-ASYMMETRY-001`,
para el cierre formal del ítem completo. Este documento queda como
registro histórico de las 4 rondas de diseño evaluadas y descartadas para
el paso 3 — no como plan pendiente de ejecutar.

**Revisión 2026-09-14 (mismo día, segunda pasada) — el dueño respondió 4
de las 5 preguntas de §3 de la versión anterior de este documento.** Esta
revisión reemplaza el diseño genérico de §1 (el `unsettledNet` que sumaba
TODO lo no-SETTLED del cliente) por el campo específico a City Ledger que
la respuesta a la pregunta 2 exige, y cierra la pregunta 3 usando el mismo
campo. El detalle de cada decisión y su cita está en §1.4/§1.5/§3 más
abajo — nada de §2 (paso 3) cambia de diseño, solo se reencuadra §2.5
como verificación de implementación, no como bloqueo (pregunta 4).

**Revisión 2026-09-14 (mismo día, tercera pasada) — gate
`architecture-governor`, 7 condiciones aplicadas.** El §1 (paso 2b)
sobrevivió con condiciones menores (C4: dos citas corregidas). El §2
(paso 3) se RECHAZÓ completo por dos defectos aritméticos reales en el
predicado de exclusión (C1) y se rediseñó desde cero usando `ar.stay_id`
como llave del folio, con una tabla de 4 escenarios verificados con
números concretos (§2.4). También: matriz de impacto reabierta con un
segundo consumidor frontend y la decisión de los 7 fakes de test (C2);
corrección de atribución del hallazgo NC↔AR, de "brecha abierta" a
"decisión ya tomada", más un ítem nuevo en `pendientes-2026-09-12.md`
(C3); anclas re-verificadas contra el archivo real, que se había vuelto a
mover (C4); secuenciación explícita en dos commits (C5); dos riesgos sin
declarar, ahora declarados (C6); sección de cumplimiento reescrita
completa, antes vacía (C7). Detalle de cada condición en su sección
correspondiente (§0 para C5, §1.2/§1.3/"Análisis de convergencia" para
C3/C4, §2 completo para C1/C2/C6, §4 para C7).

**Revisión 2026-09-14 (mismo día, cuarta pasada) — §2 (paso 3) REDUCIDO DE
ALCANCE tras verificación empírica contra Postgres real, no solo lectura de
código.** La tercera pasada (gate, arriba) había rechazado el predicado por
dos defectos aritméticos y lo había rediseñado sobre `ar.stay_id` +
`ar.replaces_ar_id IS NULL` + `ar.status` — corrigiendo esos dos defectos,
pero sin límite temporal (el propio gate lo señaló como su tercer defecto:
la exclusión duraba semanas, todo lo que la AR siguiera "vigente"). Esta
pasada parte de una pregunta distinta, pedida explícitamente antes de
volver a diseñar: **¿el crédito fantasma se autocorrige solo en el camino
feliz?** Verificado empíricamente (Postgres 16.13 local, réplica exacta de
las dos queries en juego — ver §2.1) que SÍ: el `CHARGE` original y el
`PAYMENT` sintético son, por construcción, la misma cifra con signo
opuesto — en cuanto el `CHARGE` liquida (`reservation.completed` en el
camino feliz), el par neta 0 SOLO, sin necesitar ninguna exclusión. Eso
vuelve obsoleto el eje entero de la tercera pasada (`ar.stay_id` +
`replaces_ar_id` + `ar.status`, todo pensado para durar "mientras la AR
esté viva"): el rediseño de esta pasada excluye, en cambio, **solo
mientras el/los cargo(s) que financiaron la transferencia sigan
`PENDING`** — sin mirar `accounts_receivable.status` en absoluto. Es un
predicado más chico, con una ventana estrictamente acotada (nunca más
larga que la que ya existía antes de este ítem) y, verificado con los
mismos 4 escenarios de la tercera pasada más 4 nuevos (§2.4, ahora
(a)-(h)), sin ninguno de los tres defectos que tumbaron las dos rondas
anteriores. Detalle completo, con la corrida real y su output, en §2.

**Revisión 2026-09-14 (mismo día, quinta pasada) — gate
`architecture-governor`, la cuarta pasada de ARRIBA (lo que el gate,
en su propia numeración de todo el esfuerzo de diseño —no de revisiones
de este archivo—, llama "Ronda 3") fue RECHAZADA por un defecto real
(F1): el predicado `funding.status = 'PENDING' AND funding.created_at <=
ft.created_at` de §2.3 (versión de la cuarta pasada) reproduce la MISMA
familia de regresión que el revert del 13/09/2026 — un cargo de POS "a
la habitación" (`handleOrderConfirmed` → `createOrderChargeIfConfirmed`)
creado ANTES de la transferencia, con `stay_id` propio y `PENDING`, cuyo
único liquidador real es `POST /orders/:id/complete` (independiente de
`reservation.completed`/checkout) mantiene el `EXISTS` de la cuarta
pasada en `true` PARA SIEMPRE si esa orden nunca se completa — el
`PAYMENT` sintético del huésped queda excluido para siempre y el
`CHARGE` de la reserva, una vez settleado normalmente, sí cuenta: el
agregado del cliente queda en una DEUDA fantasma permanente (no la
CRÉDITO fantasma transitoria original), exactamente el mismo modo de
falla que el revert de `8f11d19`, un nivel más abajo (ya no por
`settleByReservationId()` sin filtrar `customer_id`, sino por un
`EXISTS` que no distingue "el cargo que de verdad originó este PAYMENT"
de "cualquier otro cargo PENDING de la estadía con timestamp anterior").
Detalle completo del rechazo, la enumeración de productores que el gate
pidió ANTES de rediseñar, la evaluación completa de la dirección de
"tabla de vínculo" que el dueño pidió razonar a fondo (sobrevivió, con
una corrección: no "excluir para siempre", sino "descontar solo la
porción todavía no confirmada, acotada al monto del PAYMENT"), el diseño
final (columna `financial_transactions.absorbed_by_ar_id`, no una tabla
nueva) y su verificación empírica (los mismos 8 escenarios (a)-(h) MÁS
el escenario F1 MÁS una regresión de control, corridos contra Postgres
16.13 real, 12/12 aciertos) están en el §2 reescrito completo más abajo.
Las secciones "Ronda 3" (llamada acá "cuarta pasada") de más arriba
quedan como registro histórico de qué se intentó y por qué falló — no
describen el diseño vigente. §1 (paso 2b) no cambia: ya está
IMPLEMENTADO (commit `1dc6c84`, verificado contra el código real en esta
pasada — ver la nota al inicio de §1).

**Revisión 2026-09-14 (mismo día, sexta pasada) — CIERRE FINAL: §2 (paso
3) NO SE IMPLEMENTA.** El diseño de la quinta pasada (arriba) sobrevivió
su propia verificación aritmética, pero el gate `architecture-governor`
le hizo al dueño, vía `AskUserQuestion`, la pregunta de negocio que
quedaba pendiente incluso con el diseño ya correcto: ¿`balance` debe
absorber esta corrección parcial, o debe quedar intacto y dejar que
`cityLedgerOutstanding` (paso 2(b), ya implementado) resuelva la
visibilidad? **El dueño respondió: no tocar `balance`.** El paso 3 queda
decidido-no-implementar; `getNetBalanceByCustomerId()` no cambia.
Detalle completo (la pregunta exacta, la respuesta, el motivo resumido)
en §2.9, al final de §2 — las cuatro rondas de §2 (incluida la quinta,
arriba) quedan como registro histórico de las direcciones evaluadas y
descartadas, no como diseño pendiente de implementar.

## 0. Anclas

- Ítem completo: **cerrado 14/09/2026 (sexta pasada, ver §2.9) y cortado
  de `docs/pendientes-2026-09-12.md` a `docs/resuelto.md`, sección
  `14/09/2026`** — convención de corte-y-pega de este repo, no marca
  in-place (`CLAUDE.md` raíz, "Pendientes técnicos"). Ya no vive en
  `pendientes-2026-09-12.md` — cualquier cita a "líneas 3085-3217" de ese
  archivo (la que traía esta nota hasta la quinta pasada) quedó stale por
  el cierre, no por otro movimiento del archivo. Re-chequear contra
  `resuelto.md` antes de volver a citar la ubicación — es exactamente el
  tipo de cita que ya se movió tres veces en esta misma sesión de diseño.
- Paso 1 + declaración paso 2(a): commit `8f11d19` (13/09/2026).
- Paso 3 intentado y revertido EN EL MISMO commit (nunca llegó a existir
  como commit separado — verificado con `git show 8f11d19`, el diff final
  ya trae solo los docblocks, no código de exclusión).
- **Hallazgo de esta sesión, no reflejado todavía en pendientes.md:**
  `AccountsReceivableService.reverseTransfer()` (Bloque 3c-ii) se
  implementó HOY, commit `1516ca1` (14/09/2026) — posterior a la última
  escritura de `pendientes-2026-09-12.md`. Es un mecanismo DISTINTO del
  paso 3 (reversa manual completa de una transferencia, vía
  `ADJUSTMENT`+`reversedTransactionId`), pero interactúa con el diseño de
  paso 3 — ver §2.2/§2.4 escenarios (c)/(d) (la referencia `§3.3` de la
  versión anterior de este documento no correspondía a ninguna sección
  real; corregida. Nota de la cuarta pasada: el diseño de paso 3 cambió
  desde que se escribió esta nota, pero la interacción con
  `reverseTransfer()` sigue viva en las mismas dos subsecciones).
- **Secuenciación — DOS COMMITS SEPARADOS, no uno (condición C5, gate
  14/09/2026).** El ítem original (`docs/pendientes-2026-09-12.md`, paso
  3: "2(b) de arriba es precondición: sin separar los dos universos de la
  respuesta, no hay forma de verificar que la exclusión del par no rompe
  la visibilidad ya decidida de la fila de traspaso") ya establece la
  dependencia, pero nunca en forma operativa. Acá, explícito: **2(b) (§1)
  se implementa y commitea PRIMERO, solo** — `cityLedgerOutstanding` en
  `CustomerStatement`, sin tocar `getNetBalanceByCustomerId()`. Con ese
  campo ya visible en `GET /customers/:id/account` se confirma a ojo que
  la fila "AR Transfer" sigue igual y que el total nuevo aparece
  separado — **recién ahí** paso 3 (§2) va en su propio commit, con su
  propia batería de tests (§4.4). Juntarlos reproduciría el problema
  que causó el revert de `8f11d19`: más de un concepto por commit, difícil
  de aislar si algo sale mal.

## 1. Paso 2(b) — separar los dos universos en `CustomerStatement`

**✅ IMPLEMENTADO — commit `1dc6c84` (14/09/2026), verificado contra el
código real en la quinta pasada, no asumido.** Lo que sigue en §1 es el
diseño tal como se propuso y tal como se implementó — no una propuesta
abierta. Verificado línea por línea contra el código vigente:
`src/clientes-finanzas/customer-account.service.ts:33-52` tiene
`CustomerStatement.cityLedgerOutstanding?: number` con el docblock
descripto en §1.3 (casi textual); `getStatement()` (líneas 89-113) trae
el guard fail-loud exacto que describe §4.3 (`if
(!this.financialRepo.getCityLedgerOutstandingByCustomerId) throw`, ANTES
del `Promise.all`, no una degradación a `undefined`);
`src/clientes-finanzas/financial-transaction.repository.ts:290` declara
el método `getCityLedgerOutstandingByCustomerId?(customerId: string):
Promise<number>` como OPCIONAL, tal como decide §4.3;
`src/clientes-finanzas/sql.financial-transaction.repository.ts:897-907`
tiene la implementación SQL idéntica a la de §1.3. **Lo único que sigue
sin hacer:** el lado frontend (`appfrontend/src/lib/clientes/types.ts`,
`appfrontend/src/app/dashboard/cuentas-corrientes/page.tsx`) — grep
confirmado, cero ocurrencias de `cityLedgerOutstanding` en
`appfrontend` — consistente con la decisión "aditivo, sin bloquear" de
§1.5 (el backend no necesita esperar al frontend), pero es trabajo
pendiente, no un error: si el dueño quiere el campo visible en pantalla,
hace falta un commit aparte del lado `appfrontend-main`.

### 1.1 Estado actual (el bug de UX)

`CustomerAccountService.getStatement()`
(`src/clientes-finanzas/customer-account.service.ts:74-84`):

```ts
const [balance, transactions] = await Promise.all([
  this.financialRepo.getNetBalanceByCustomerId(customerId),   // SETTLED-only
  this.financialRepo.getByCustomerId(customerId),             // TODOS los status
]);
return { customerId, balance, transactions };
```

El frontend (`appfrontend/src/app/dashboard/cuentas-corrientes/page.tsx:270-332`)
ya muestra una columna "Estado" con badge por fila (`STATUS_BADGE_CLASS`/
`STATUS_LABEL`, líneas 21-29) — el dato de status SÍ es visible por fila.
Lo que falta es la relación entre esa columna y el número "Saldo" de
arriba: nada dice "este total solo suma las filas SETTLED". Un usuario
que suma las filas a ojo no llega al mismo número que `balance`.

### 1.2 Opciones consideradas

**(A) Renombrar/reemplazar `balance`.** Descartado — rompe el contrato
sin necesidad. El precedente correcto **no vive en
`customer-account.service.ts`** (corrección C4, gate 14/09/2026 —
`coveredByConsolidatedTransactionIds`/`coveredByConsolidatedInvoices` NO
están en la interfaz `CustomerStatement` de ese archivo; verificado): vive
en `src/clientes-finanzas/customers.routes.ts:865-871`, donde el handler
de `GET /customers/:id/account` hace
`res.json({ ...statement, coveredByConsolidatedTransactionIds: [...covered], coveredByConsolidatedInvoices: [...] })`
— agrega esos dos campos por `spread` DESPUÉS de que `getStatement()`
devuelve el objeto base, solo si el negocio tiene el módulo FACTURACION.
Su espejo del lado frontend es
`appfrontend/src/lib/clientes/types.ts:74+` (interfaz `CustomerStatement`,
mismos dos campos opcionales con su propio docblock de compatibilidad).
Mismo patrón aditivo/opcional que este documento sigue para
`cityLedgerOutstanding` — solo que la cita de precedente original apuntaba
al archivo equivocado.

**(B) Partir `transactions` en dos arrays (`settledTransactions` /
`unsettledTransactions`).** Descartado — rompe el único caso ya decidido
explícitamente (`CITY-LEDGER-STATEMENT-TRANSFER-ROW-001`: la fila de
traspaso a City Ledger sigue visible en el statement, con su propio
`notes`) sin ganar nada: el statement es un LIBRO MAYOR por cliente,
Cloudbeds lo muestra como una sola lista cronológica con la fila "AR
Transfer" intercalada, no en una sección aparte. Partir el array obliga
al frontend a re-intercalar dos listas para mantener el orden
cronológico — trabajo nuevo sin beneficio.

**(C) Set de ids "qué cuenta" (mismo patrón que
`coveredByConsolidatedTransactionIds`).** Viable, pero traslada al
frontend la aritmética de "sumar según status" — exactamente el tipo de
lógica de negocio que `appfrontend-main/CLAUDE.md` ya pide no duplicar
(ver la regla de `useIsManagement()` en vez de `role === 'OWNER'` a
mano): la fórmula con signos (`CHARGE(+)/ADJUSTMENT(+)/PAYMENT(-)/REFUND(+)`)
vive HOY solo en el SQL de `getNetBalanceByCustomerId()` — re-derivarla en
TS del lado del cliente crea una segunda copia que puede divergir.

**(D) — descartada tras la respuesta del dueño (pregunta 2, §3): un
segundo escalar genérico, `unsettledNet`.** Igual fórmula que `balance`,
misma fuente (`financial_transactions`), filtro invertido (`status <>
'SETTLED'`). Se descarta explícitamente porque mezcla dos orígenes que el
dueño pidió separar: un `CHARGE` `PENDING` normal (reserva confirmada,
sin nada de City Ledger de por medio) y un `CHARGE`/`PAYMENT` que sigue
sin liquidar PORQUE hay una transferencia a City Ledger vigente. El
dueño quiere solo lo segundo.

**(E) — DECIDIDA (dueño, preguntas 2+3 de §3, ver el análisis de
convergencia más abajo): un escalar específico, cruzado contra
`accounts_receivable`.** No es "lo no-SETTLED del cliente" — es "cuánto
de este cliente está hoy transferido a City Ledger y todavía no se
revirtió ni se cobró del lado empresa". Usa el vínculo que ya existe
desde el paso 1 (`accounts_receivable.guest_payment_transaction_id`) para
identificar, sin ambigüedad, qué transacciones del cliente pertenecen a
una transferencia real — no una regla de status genérica sobre
`financial_transactions`, sino un JOIN contra las filas de
`accounts_receivable` que efectivamente representan una transferencia a
una empresa.

### 1.3 Contrato concreto — campo `cityLedgerOutstanding`

**Nombre elegido:** `cityLedgerOutstanding` (justificación completa en la
pregunta 5 de §3 — la única que seguía abierta).

**Fórmula:** suma de `accounts_receivable.amount` de las filas cuyo
`guest_payment_transaction_id` pertenece a este cliente (huésped) y cuyo
`status` es `PENDIENTE_FACTURAR` o `FACTURADO` — es decir, **"vigente"
= NO `COBRADO` (la empresa ya pagó, ya no es deuda) y NO `REVERTIDO` (la
transferencia se deshizo, nunca fue deuda real)**. Esos dos estados son
exactamente el conjunto que consume `reverseTransfer()`/`markCollected()`
como "terminal, no tocar de nuevo" — ver `accounts-receivable.repository.ts`
(`AccountsReceivableStatus`) y el docblock de `reverseTransfer()`
(`accounts-receivable.service.ts:747-757`): `FACTURADO`/`COBRADO` ya NO
pasan por `reverseTransfer()` (van por el circuito de Nota de Crédito),
y `REVERTIDO` es terminal desde `PENDIENTE_FACTURAR`.

**Por qué vive en `FinancialTransactionRepository` (no en
`AccountsReceivableRepository`) — decisión de wiring, no de dominio.**
`CustomerAccountService` hoy NO tiene `AccountsReceivableRepository`
inyectado; agregarlo como dependencia nueva del constructor es un cambio
de wiring más grande (`container.ts`, cada fake de test de este servicio)
para lo que es, en esencia, una query de lectura. El propio
`getNetBalanceByCustomerId()` (paso 3, §2.3 de este documento) YA hace un
`JOIN`/`NOT EXISTS` contra `accounts_receivable` desde adentro de
`sql.financial-transaction.repository.ts` sin que eso viole ningún
bounded context — es SQL de implementación, no una importación de la
clase rica `AccountReceivable` en el dominio de `clientes-finanzas`
mismo. Mismo precedente, mismo archivo, método hermano.

**Backend — `src/clientes-finanzas/financial-transaction.repository.ts`**
(interfaz), método nuevo junto a `getNetBalanceByCustomerId`:

```ts
/**
 * Cuánto de este cliente (huésped) está HOY transferido a City Ledger y
 * sigue vigente — ni revertido (`reverseTransfer()`) ni cobrado del lado
 * empresa (`markCollected()`). Responde la pregunta 2+3 de
 * CITY-LEDGER-CUSTOMER-BALANCE-STATUS-ASYMMETRY-001 paso 2(b): a
 * diferencia de un total genérico de "lo no-SETTLED", esto está cruzado
 * contra `accounts_receivable` — solo cuenta si hay una transferencia
 * real de por medio (usa `guest_payment_transaction_id`, paso 1).
 *
 * `status IN ('PENDIENTE_FACTURAR', 'FACTURADO')` — el complemento
 * exacto de `COBRADO` (ya no es deuda, la empresa pagó) y `REVERTIDO`
 * (nunca fue deuda real, se deshizo). Puramente informativo, igual que
 * `getNetBalanceByCustomerId`: nunca se suma a `balance`.
 *
 * Devuelve 0 para un cliente EMPRESA — `guest_payment_transaction_id`
 * siempre apunta al huésped (nunca a la empresa, ver su propio docblock
 * en `accounts-receivable.repository.ts`), así que el JOIN nunca matchea
 * del lado empresa. No hace falta: la deuda de la empresa ya es visible
 * en su propio `balance` vía el `CHARGE` que `postStayTransfer()` le
 * crea directo `SETTLED` contra su cuenta.
 *
 * **Caveat declarado, no bloqueante — corrección de atribución (C3, gate
 * 14/09/2026).** El circuito de cancelación con Nota de Crédito
 * (`cancel-reservation-with-credit-note.service.ts`,
 * `cancel-order-with-credit-note.service.ts`) NO actualiza
 * `accounts_receivable.status` — solo deja un
 * `logger.warn({evento: 'nc_escape_con_ar_viva'})` cuando cancela una
 * reserva/orden con una AR activa (`status !== 'REVERTIDO'`) encima. Esto
 * **no es una brecha sin decidir**: es la consecuencia directa de una
 * decisión YA TOMADA por el dueño
 * (`docs/diseno-reconciliacion-city-ledger-2026-09-12.md:1546-1552`,
 * `AskUserQuestion` 13/09/2026 — "Guard en la NC — exponer, no
 * bloquear... la NC procede igual... pero se detecta la AR viva... para
 * que management lo revise"). El texto anterior de este docblock citaba
 * mal el origen ("la misma brecha... que pendientes ya tiene abierta"),
 * como si fuera una pregunta sin resolver — la decisión de NO bloquear
 * ya está tomada; lo que sigue abierto es solo la mecánica de
 * reconciliación (`ar.status` no se sincroniza solo).
 *
 * Lo que SÍ es nuevo (no estaba registrado antes de esta revisión):
 * hasta ahora esa AR viva solo llegaba a logs del servidor y al JSON
 * crudo de la respuesta HTTP — invisible en cualquier pantalla. Con
 * `cityLedgerOutstanding` visible en la card de cuenta corriente del
 * cliente (`appfrontend/src/app/dashboard/cuentas-corrientes/page.tsx`),
 * ese mismo número puede sobreestimar la deuda transferida vigente
 * (sigue sumando una AR que el negocio ya considera resuelta del lado
 * fiscal) y ahora el staff lo ve directamente en pantalla, no solo en
 * logs. Registrado como ítem nuevo en `docs/pendientes-2026-09-12.md`
 * (`CITY-LEDGER-OUTSTANDING-NC-STALE-SURFACE-001`, relacionado con
 * `CITY-LEDGER-GUARD-NO-UI-SURFACE-001`) — no se resuelve en este
 * documento, fuera de alcance de pasos 2(b)/3.
 */
getCityLedgerOutstandingByCustomerId(customerId: string): Promise<number>;
```

**`src/clientes-finanzas/sql.financial-transaction.repository.ts`**,
implementación:

```ts
async getCityLedgerOutstandingByCustomerId(customerId: string): Promise<number> {
  const result = await this.sqlClient.query<{ outstanding: string }>(
    `SELECT COALESCE(SUM(ar.amount), 0) AS outstanding
     FROM accounts_receivable ar
     JOIN financial_transactions gp ON gp.id = ar.guest_payment_transaction_id
     WHERE gp.customer_id = $1
       AND ar.status IN ('PENDIENTE_FACTURAR', 'FACTURADO')`,
    [customerId],
  );
  return parseFloat(result.rows[0]?.outstanding ?? '0');
}
```

**`customer-account.service.ts::getStatement()`:**

```ts
export interface CustomerStatement {
  customerId: string;
  balance: number;                 // SIN CAMBIOS — SETTLED-only, ver docblock del repo
  transactions: FinancialTransaction[]; // SIN CAMBIOS — libro mayor completo, cualquier status
  /**
   * NUEVO (paso 2b) — cuánto de este cliente está transferido a City
   * Ledger y sigue vigente (ni revertido ni cobrado). Ver docblock de
   * `getCityLedgerOutstandingByCustomerId()`. Ausente (`undefined`) en un
   * backend viejo durante la ventana de deploy — el frontend debe tratar
   * la ausencia como "sin dato", nunca como 0 (0 real y "no lo mandaron"
   * no son lo mismo).
   */
  cityLedgerOutstanding?: number;
}

async getStatement(customerId: string): Promise<CustomerStatement> {
  const customer = await this.customerRepo.getById(customerId);
  if (!customer) throw new CustomerNotFoundError(customerId);

  const [balance, cityLedgerOutstanding, transactions] = await Promise.all([
    this.financialRepo.getNetBalanceByCustomerId(customerId),
    this.financialRepo.getCityLedgerOutstandingByCustomerId(customerId),
    this.financialRepo.getByCustomerId(customerId),
  ]);

  return { customerId, balance, cityLedgerOutstanding, transactions };
}
```

**Frontend — `appfrontend/src/lib/clientes/types.ts:74-77`** — agregar
`cityLedgerOutstanding?: number` a `CustomerStatement` (mismo patrón
opcional que `coveredByConsolidatedTransactionIds?` en el mismo bloque).

**Frontend — `appfrontend/src/app/dashboard/cuentas-corrientes/page.tsx:270-278`**
(la card de "Saldo") — agregar una segunda línea, solo si
`statement.cityLedgerOutstanding !== undefined && statement.cityLedgerOutstanding !== 0`,
del tipo "Transferido a City Ledger: {fmtMoney(cityLedgerOutstanding)}
(no incluido en el saldo)" — exactamente el gap que dispara el bug de UX
("el usuario ve filas que no suman el total de al lado"), pero ahora
acotado al origen real (transferencia), no a cualquier `PENDING` genérico.

### 1.4 `CITY-LEDGER-STATEMENT-TRANSFER-ROW-001`

La fila del traspaso (el `PAYMENT` sintético del huésped) nace `SETTLED`
siempre (`postStayTransfer()`), así que ya cuenta en `balance` y ya
aparece en `transactions` con su `notes` propio ("Transferido a cuenta
por cobrar — empresa X") — eso no cambia con esta revisión.

**Lo que SÍ cambia (pregunta 3 de §3, DECIDIDA — "sí debe contar para un
total nuevo"):** `cityLedgerOutstanding` (§1.3) ES ese total nuevo. No
hace falta un mecanismo aparte para "cuánto de la fila AR Transfer sigue
vigente" — es exactamente la misma pregunta que la 2, y la misma query la
responde: la fila individual del `PAYMENT` sigue mostrándose igual que
hoy (sin cambios de forma, sigue `SETTLED`, sigue en `transactions`), y
el total agregado que la acompaña es `cityLedgerOutstanding`. **La fila
en sí NO cambia** — lo que se agrega es el total que faltaba, no una
redecoración de la fila.

El relabel del `notes` a "AR Transfer" (texto de UI, fuera de alcance de
este documento, backlog aparte) seguiría siendo un cambio de UI puro
sobre `notes`/`type`, sin tocar este contrato.

### 1.5 Compatibilidad — DECIDIDA

**Pregunta 1 de §3: "aditivo, sin bloquear"** — el backend puede
deployar `cityLedgerOutstanding` solo, sin coordinar con el frontend. El
campo es `?: number` en `CustomerStatement` (backend y frontend), mismo
patrón que `coveredByConsolidatedTransactionIds?`/
`coveredByConsolidatedInvoices?` ya establecido en este mismo contrato —
un frontend viejo ignora el campo desconocido (comportamiento actual de
`fetch`+`JSON.parse`, no requiere código nuevo del lado front para no
romperse) y un backend viejo simplemente no lo manda (`undefined`, el
frontend ya sabe tratar la ausencia como "sin dato", ver §1.3).

---

## 2. Paso 3 — descontar del agregado del cliente solo lo que la transferencia todavía no confirmó

**Quinta pasada (14/09/2026).** La cuarta pasada de arriba (título
original: "excluir el PAYMENT sintético mientras su cargo siga PENDING")
quedó como registro histórico — RECHAZADA por el gate por el defecto F1
descrito en la revisión de más arriba (después de "## 0. Anclas"): el
`EXISTS` de esa versión no distinguía "el cargo puntual que originó este
`PAYMENT`" de "cualquier otro `CHARGE`/`ADJUSTMENT` `PENDING` de la misma
estadía con timestamp anterior" — un cargo de POS a la habitación creado
antes de transferir, cuyo único liquidador es `POST /orders/:id/complete`
(nunca `reservation.completed`/checkout), podía dejar el `PAYMENT`
sintético excluido para siempre, convirtiendo el crédito fantasma
transitorio original en una deuda fantasma permanente — el mismo modo de
falla que el revert de `8f11d19`, no uno nuevo.

El pedido del gate, antes de rediseñar otra vez: enumerar TODOS los
productores reales de una fila candidata (§2.1) y, sobre esa base,
razonar a fondo la dirección de "materializar el hecho en el momento de
la transferencia" en vez de inferirlo después (§2.2) — verificando con
la misma exigencia aritmética que tumbó las tres rondas anteriores, no
solo en papel (§2.4, corrida real contra Postgres 16.13).

### 2.1 Enumeración de productores — toda fila candidata y quién la liquida

Toda fila `financial_transactions` que pueda tener `stay_id` seteado,
`customer_id` del HUÉSPED (no de la empresa) y nacer o pasar por
`PENDING` — y, para cada una, el trigger real que la lleva a `SETTLED`
(o a `VOIDED`, que la saca del cómputo igual). Relevado con grep sobre
`type: 'CHARGE'`/`type: 'ADJUSTMENT'` en todo `src/` (siete sitios de
creación reales) más el INSERT crudo de `createOrderChargeIfConfirmed()`
(usa el literal SQL `'CHARGE'`, no la sintaxis TS, por eso el grep de
arriba no lo encuentra directo) — verificado leyendo cada uno, no
inferido de nombres de archivo.

| # | Productor | Ubicación | type | status inicial | `stay_id` | `customer_id` | Liquidador real |
|---|---|---|---|---|---|---|---|
| 1 | `handleReservationConfirmed` (saldo, tras la seña) | `outbox.handlers.ts:217-229` | CHARGE | `PENDING` | `NULL` al crear — lo adopta `linkStayToReservationCharges()` en `checkIn()` o en `transferStayBalanceToReceivable()` (§2.7) | huésped (`reservation.customerId`) | `settleByReservationId()` vía evento `reservation.completed` (`handleReservationCompleted`) — o `voidByReservationId()` vía `reservation.cancelled` |
| 2 | `handleReservationPriceAdjusted` | `outbox.handlers.ts:504-540` | ADJUSTMENT | `PENDING` | resuelto al insertar (`stayRepo.findByReservation`) | huésped | mismo trigger que #1 — ambos filtran por `reservation_id`, no por fila puntual |
| 3 | `StayService.approveScheduleChange` | `stay.service.ts:463-477` | CHARGE | `PENDING` | resuelto al insertar | huésped (`reservation.customer.id`) | mismo trigger que #1/#2 — también `reservation_id`-scoped |
| 4 | `handleOrderConfirmed` → `createOrderChargeIfConfirmed` | `outbox.handlers.ts:667-700` / `sql.financial-transaction.repository.ts:633-706` | CHARGE | `PENDING` | seteado directo del payload del evento (`order.stayId`) si la orden está asociada a una estadía ("cargo a la habitación") | `order.customerId` (el huésped, cuando la orden es "a la habitación") | **`settleChargesByOrderId()`, vía evento `order.completed` (`handleOrderCompleted`) — ÚNICO trigger real: `POST /orders/:id/complete` (`orders.routes.ts:270`, un solo caller). NINGÚN camino automático lo liga a `reservation.completed` ni a checkout — una orden puede quedar `CONFIRMED` indefinidamente.** |

Dos productores más crean `CHARGE`/`ADJUSTMENT`, pero NUNCA quedan
observables en `PENDING` por más de una sentencia SQL — no son candidatos
reales a esta tabla, así que no cuentan como un quinto/sexto trigger
independiente: `AccountsReceivableService.postStayTransfer()` (el
`CHARGE` contra la EMPRESA, línea 484 — nace `SETTLED` directo, y de
todos modos es `customer_id` de la empresa, no del huésped) y
`reverseTransfer()` (los dos `ADJUSTMENT` de reversa, líneas 903/923 —
nacen `SETTLED` directo, en la misma transacción que los crea); los
`ADJUSTMENT` compensatorios de `cancel-*-with-credit-note.service.ts`
(líneas 521/527) se crean y se liquidan (`settleByIdsWithClient`) en la
MISMA transacción (tx2) — transitoriamente `PENDING` solo dentro de una
sentencia SQL que nadie más puede observar a mitad de camino.

**La fila #4 es el defecto real de la cuarta pasada, en una tabla.** Los
productores #1-#3 comparten UN SOLO trigger de liquidación
(`reservation_id`-scoped, disparado por `reservation.completed`) — un
predicado que espera "¿algo PENDING de esta estadía?" eventualmente
converge para los tres, porque los tres convergen al mismo evento. El
productor #4 tiene un trigger COMPLETamente independiente
(`order_id`-scoped, disparado por una acción humana separada que puede no
ocurrir nunca) — cualquier predicado que trate "PENDING en la estadía"
como una condición única, sin distinguir CUÁL fila específica financió
CUÁL `PAYMENT`, queda rehén del trigger más lento (o inexistente) del
conjunto. Esa es la causa raíz de F1, no un caso límite aislado.

### 2.2 Dirección evaluada — materializar el vínculo en el momento de la transferencia

**Sobrevive, con una corrección respecto a como la planteó el pedido
original.** La idea de origen — cuando `postStayTransfer()` corre, ya
sabe exactamente qué filas sumó `getNetBalanceByStayId()` para llegar al
`balance` transferido; grabar esos ids en vez de inferirlos después — es
correcta y evita por construcción los dos defectos de las rondas 1 y 2
(§2.4 los recita). Pero la primera formulación que se razonó ("excluir
PARA SIEMPRE, sin condición de status, todo lo vinculado a esa
transferencia") **no sobrevive la aritmética de un caso real, ya en la
tabla (a)-(h) de este mismo diseño**:

Escenario (b) — pago real parcial (`300`) antes de transferir el resto
(`700`): el `CHARGE` original es `1000` (vinculado a la transferencia),
pero SOLO `700` de esa deuda se transfirió (los otros `300` ya los pagó
el huésped en efectivo, un `PAYMENT` real, jamás candidato a vincularse
— §2.1 de la cuarta pasada ya lo resolvía así y sigue valiendo). Excluir
el `CHARGE` completo (`1000`) PARA SIEMPRE, sin condición, deja contando
solo el pago real (`-300`) — **para siempre**, incluso después de que la
reserva complete y el `CHARGE` liquide de verdad. Corrida real (ver
§2.4): con exclusión permanente sin condición, el balance post-complete
da `-300`; la VERDAD esperada es `0` (una vez que la reserva completa,
el huésped no debe nada más — los `700` se transfirieron, los `300` ya
los pagó). **Excluir para siempre sobre-corrige exactamente en cualquier
caso donde una parte de la deuda YA se cobró en efectivo antes de
transferir el resto.**

**La corrección que sí sobrevive:** no excluir la fila entera para
siempre — **descontar del agregado, en cada consulta, solo la PORCIÓN
todavía no confirmada de lo vinculado a cada transferencia, acotada
(nunca más) al monto del propio `PAYMENT` sintético.** Concretamente:
`LEAST(payment.amount, GREATEST(0, SUM(monto de lo vinculado que sigue
`PENDING`)))`, sumado — no restado — al cálculo `SETTLED`-only de
siempre. En vez de una pregunta binaria ("¿está vinculado, sí o no?"),
la pregunta es "¿cuánto de lo vinculado a esta transferencia sigue sin
confirmar, ahora mismo?" — y esa cantidad se auto-actualiza sola, fila
por fila, a medida que cada pieza vinculada liquida (o queda `VOIDED`),
sin depender de que TODAS liquiden juntas ni de una fecha límite.

Con esta corrección, F1 se resuelve de raíz: la reserva (`1000`) y el
POS (`250`) quedan AMBOS vinculados al mismo `PAYMENT` (`1250`) en el
momento de transferir — no importa que tengan triggers de liquidación
completamente independientes. Mientras el POS nunca liquide, su parte
(`250`) sigue "todavía no confirmada" y se sigue descontando — pero SOLO
esa parte, nunca la reserva ya liquidada (`1000`, que deja de descontarse
apenas settlea). El agregado del cliente da `0` exacto en todo momento,
con o sin el POS liquidado — nunca `+1000` (la deuda fantasma de la
cuarta pasada) ni `-250` (un nuevo crédito fantasma por la parte que
todavía no confirma). Verificado empíricamente, §2.4.

**¿Tabla de vínculo nueva, o una columna?** Una columna. El patrón ya
usado dos veces en este mismo bloque de trabajo
(`accounts_receivable.guest_payment_transaction_id`,
`financial_transactions.reversed_transaction_id`) es un FK nullable de
uno-a-muchos, no una tabla de unión — y acá aplica igual de bien: una
fila `financial_transactions` puede ser absorbida por **como mucho una**
transferencia (nunca se re-transfiere una vez vinculada — no hay ningún
camino de negocio que tome un `CHARGE` ya cubierto por City Ledger y lo
vuelva a poner en juego), así que la relación es 1-a-N desde
`accounts_receivable` hacia `financial_transactions`, exactamente la
forma que una columna FK nullable ya resuelve sin tabla intermedia. Una
tabla de unión solo se justificaría si una fila pudiera pertenecer a
más de una transferencia a la vez — no es el caso acá.

**¿Empeora, mejora, o deja igual el hallazgo hermano de cancelación-con-NC?**
Igual — verificado con el escenario (h), no asumido. Ver §2.6.

### 2.3 Diseño final

**Schema — una columna nueva, `financial_transactions.absorbed_by_ar_id`:**

```sql
-- absorbed_by_ar_id (schema v55, CITY-LEDGER-CUSTOMER-BALANCE-STATUS-
-- ASYMMETRY-001 paso 3, quinta pasada, este documento §2.3) -- qué
-- transferencia a City Ledger absorbió este CHARGE/ADJUSTMENT del
-- huésped, si alguna. NULL = nunca formó parte de ninguna transferencia
-- (la inmensa mayoría de las filas). Se puebla UNA sola vez, en el
-- momento de la transferencia (original o de reemplazo vía
-- reverseTransfer()), nunca se reasigna ni se limpia después -- una vez
-- absorbida, una fila queda marcada para siempre (R12: solo avanza).
-- ON DELETE SET NULL, mismo criterio que reservation_id/order_id/stay_id
-- de esta misma tabla -- accounts_receivable nunca se hard-borra
-- (R2/R3), así que en la práctica nunca se dispara.
ALTER TABLE financial_transactions ADD COLUMN IF NOT EXISTS absorbed_by_ar_id VARCHAR(255)
  REFERENCES accounts_receivable(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ft_absorbed_by_ar
  ON financial_transactions (absorbed_by_ar_id)
  WHERE absorbed_by_ar_id IS NOT NULL;
```

**Cuándo se puebla — dentro de `postStayTransfer()`, el helper privado
compartido por `transferStayBalanceToReceivable()` Y por la rama
`correctedBalance` de `reverseTransfer()` (mismo caller único para las
dos, ya establecido por el refactor del Bloque 3c-ii citado en §1.3).**
El id de la AR se genera ANTES de los inserts (mismo patrón ya usado
para `guestPaymentId`/`companyChargeId`), para poder pasarlo al UPDATE
de vínculo antes de insertar la fila `accounts_receivable` misma:

```ts
// AccountsReceivableService.postStayTransfer() -- diff conceptual, no
// literal (no se edita el archivo real en este documento de diseño).
private async postStayTransfer(client: SqlClient, params: {/* igual que hoy */}): Promise<AccountReceivable> {
  const arId = randomUUID();          // NUEVO -- generado antes, no al final
  const guestPaymentId = randomUUID();
  // ...

  // NUEVO -- vincula, DENTRO de la misma transacción, toda fila
  // CHARGE/ADJUSTMENT de este huésped en esta estadía que siga PENDING y
  // no esté ya vinculada a otra transferencia. Corre para las DOS
  // llamadas (transferStayBalanceToReceivable() Y la rama
  // correctedBalance de reverseTransfer()) -- en la segunda, si no
  // apareció nada PENDING nuevo desde la transferencia original (caso
  // típico: el ADJUSTMENT de reversa nace SETTLED), el UPDATE no vincula
  // nada y la corrección de §2.3 para esta AR da 0 -- correcto, ver
  // escenario (d) en §2.4.
  await this.financialRepo.absorbPendingIntoTransfer(client, {
    stayId: params.stayId,
    customerId: params.stayCustomerId,
    accountsReceivableId: arId,
  });

  await this.financialRepo.createWithClient(client, { id: guestPaymentId, /* ... */ });
  // ... CHARGE de la empresa, igual que hoy ...
  return this.arRepo.createWithClient(client, { id: arId, /* ... */ });
}
```

**`FinancialTransactionRepository` — método nuevo, OPCIONAL (mismo
criterio que `getByIdWithLock?`/`getCityLedgerOutstandingByCustomerId?`,
ver §4.3 de paso 2b para el precedente completo):**

```ts
/**
 * Vincula, dentro de la transacción del caller, toda fila CHARGE/
 * ADJUSTMENT de este huésped en esta estadía que siga PENDING y no esté
 * ya vinculada a otra transferencia -- ver diseño completo
 * (docs/diseno-city-ledger-balance-asymmetry-pasos-2b-3-2026-09-14.md
 * §2.3). Un solo caller real (AccountsReceivableService.postStayTransfer()).
 * Devuelve la cantidad de filas vinculadas (puede ser 0 -- caso típico
 * de una transferencia de reemplazo sobre una reversa reciente, §2.4 (d)).
 */
absorbPendingIntoTransfer?(
  client: SqlClient,
  input: { stayId: string; customerId: string; accountsReceivableId: string },
): Promise<number>;
```

**`SqlFinancialTransactionRepository` — implementación:**

```sql
UPDATE financial_transactions
SET absorbed_by_ar_id = $3
WHERE stay_id          = $1
  AND customer_id       = $2
  AND type             IN ('CHARGE', 'ADJUSTMENT')
  AND status            = 'PENDING'
  AND absorbed_by_ar_id IS NULL
```

`customer_id = $2` (el huésped) es la misma defensa que ya evitaba el
residuo de §2.7 en la cuarta pasada — sigue evitándolo acá igual (ver
§2.7 reexaminado más abajo). `absorbed_by_ar_id IS NULL` hace el UPDATE
idempotente entre las dos llamadas posibles (transferencia original y de
reemplazo) sin necesitar un guard aparte.

**Query final —
`sql.financial-transaction.repository.ts::getNetBalanceByCustomerId()`:**

```sql
WITH normal_sum AS (
  SELECT COALESCE(SUM(
    CASE type
      WHEN 'CHARGE'     THEN  amount
      WHEN 'ADJUSTMENT' THEN  amount
      WHEN 'PAYMENT'    THEN -amount
      WHEN 'REFUND'     THEN  amount
    END
  ), 0) AS total
  FROM financial_transactions
  WHERE customer_id = $1 AND status = 'SETTLED'
),
still_unconfirmed AS (
  -- Por cada transferencia a City Ledger de este cliente (huésped, vía
  -- ar.guest_payment_transaction_id -- apunta SIEMPRE al huésped, nunca
  -- a la empresa, ver docblock de getCityLedgerOutstandingByCustomerId):
  -- cuánto de lo vinculado a ESA transferencia sigue PENDING ahora
  -- mismo, acotado (LEAST) al propio monto del PAYMENT sintético -- así
  -- nunca sobre-corrige cuando parte de la deuda ya se cobró en efectivo
  -- antes de transferir el resto (§2.2, escenario (b)). GREATEST(0, ...)
  -- protege contra el caso exótico de un ADJUSTMENT negativo (descuento)
  -- todavía PENDING que, sumado a un CHARGE ya SETTLED, daría una
  -- "porción pendiente" neta negativa -- sin el clamp, eso ACREDITARÍA
  -- de más antes de que el descuento confirme (verificado empíricamente,
  -- §2.4, caso "edge").
  SELECT COALESCE(SUM(LEAST(gp.amount, GREATEST(0, pend.pending_amount))), 0) AS total
  FROM accounts_receivable ar
  JOIN financial_transactions gp ON gp.id = ar.guest_payment_transaction_id
  JOIN LATERAL (
    SELECT COALESCE(SUM(f.amount), 0) AS pending_amount
    FROM financial_transactions f
    WHERE f.absorbed_by_ar_id = ar.id
      AND f.status = 'PENDING'
  ) pend ON TRUE
  WHERE gp.customer_id = $1
)
SELECT (SELECT total FROM normal_sum) + (SELECT total FROM still_unconfirmed) AS net;
```

**Por qué no hace falta `ar.status` (igual que la cuarta pasada, mismo
argumento, ahora aplicado a la columna nueva):** `reverseTransfer()`
sigue exigiendo `charge.status === 'SETTLED'` antes de permitir la
reversa — para cuando una AR llega a `REVERTIDO`, todo lo que tenía
vinculado ya dejó de estar `PENDING` (si no, el guard ya la habría
frenado), así que `pending_amount` para esa AR ya es `0` de todos
modos y la corrección no aporta ni resta nada — sin necesitar mirar
`ar.status` en absoluto. Mismo principio R12 aplicado a
`financial_transactions.status` (solo avanza), no a
`accounts_receivable.status`.

**Garantía de no regresión, verificable por construcción, no solo por
prueba:** `still_unconfirmed` es una suma sobre filas de
`accounts_receivable` que referencian a este `customer_id` vía
`guest_payment_transaction_id` — si un cliente NUNCA tuvo una
transferencia a City Ledger, esa suma es `0` por construcción (el `JOIN`
no matchea ninguna fila), y la query completa colapsa exactamente a la
fórmula de HOY (`normal_sum` sola). Todo cliente sin AR asociada —
la inmensa mayoría de los tests existentes que llaman
`getNetBalanceByCustomerId()` sin transferir nada — queda bit-a-bit
idéntico al comportamiento actual, sin necesitar revisarlos uno por uno
para confirmarlo (aunque igual se listan en §2.8, por disciplina).

### 2.4 Verificación aritmética — corrida real contra Postgres 16.13

**Método:** cluster Postgres 16.13 local (ya online al empezar esta
sesión, `pg_lsclusters` lo confirmó — no hizo falta arrancarlo), rol
`testuser` ya existente, base `test_city_ledger_link_verify` (dropeada
al terminar, confirmado al final de esta sección). Dos tablas mínimas
(`financial_transactions`, `accounts_receivable`, con la columna nueva
`absorbed_by_ar_id`) y una función SQL `net_balance(customer_id)` que es
copia literal de la query completa de §2.3 — no una versión simplificada
ni una re-implementación aproximada. Script completo:
`city_ledger_verify.sql` del scratchpad de esta sesión de diseño — no
versionado, no sobrevive la sesión, así que no se cita como referencia
futura; lo que sí queda como evidencia durable es la query de §2.3
(idéntica a la corrida) y esta tabla con los resultados reales.

Cada escenario reproduce exactamente los mismos ocho de la cuarta pasada
((a)-(h)) — para confirmar que la corrección no reabre ningún defecto ya
cerrado — MÁS el escenario **F1** (el que tumbó la cuarta pasada) MÁS
una regresión de control (reserva cancelada después de transferir, un
gap YA conocido y declarado — Bloque 3a, `reservation_cancelled_con_ar_viva`
— que el diseño nuevo no debe empeorar). "VERDAD" = lo que el negocio
espera; "Resultado real" = lo que devolvió la corrida.

| # | Escenario | Resultado real | VERDAD | ¿Coincide? |
|---|---|---|---|---|
| (a) | Transferencia simple, sin pago previo — pre-`reservation.completed` (`CHARGE` `PENDING`, vinculado) | `0.00` | `0` | ✅ |
| (a) | ídem, post-complete (`CHARGE` `SETTLED`) | `0.00` | `0` | ✅ |
| (b) | Pago real parcial (`300`) antes de transferir el resto (`700`) — pre-complete | `-300.00` | `-300` (el pago real siempre cuenta; el `CHARGE` completo, `1000`, está vinculado pero acotado por `LEAST` al monto del `PAYMENT` sintético, `700` — nunca sobre-corrige) | ✅ |
| (b) | ídem, post-complete | `0.00` | `0` (defecto de la primera formulación de §2.2 — excluir el `CHARGE` entero para siempre daba `-300` acá; el `LEAST`+status dinámico lo corrige) | ✅ |
| **F1** | Reserva (`1000`) y POS a la habitación (`250`) creados ANTES de transferir, ambos `PENDING`, ambos vinculados — fase 1, justo después de transferir | `0.00` | `0` | ✅ |
| **F1** | fase 2 — la reserva completa (`settleByReservationId`), **el POS sigue `PENDING` PARA SIEMPRE** (la orden nunca completa — el escenario real de F1, no transitorio) | `0.00` | `0` — **NO `+1000`.** Si esta celda diera `1000`, F1 seguiría vivo. | ✅ |
| F1 (hipotético) | fase 3 — si el POS también llegara a liquidar eventualmente | `0.00` | `0` | ✅ |
| (c) | `reverseTransfer()` puro — el `CHARGE` ya estaba `SETTLED` (guard lo exige) | `0.00` pre-reversa | `0` | ✅ |
| (c) | post-reversa (`ADJUSTMENT` `+1000` reabre la deuda) | `1000.00` | `1000` | ✅ |
| (d) | `reverseTransfer({correctedBalance:600})` sobre (c) — la AR de reemplazo no vincula nada nuevo (el `ADJUSTMENT` de reversa ya nació `SETTLED`) | `400.00` | `400` (`1000` del cargo original, `600` cubiertos por el reemplazo) | ✅ |
| (e) | Cargo de POS **después** de transferir (no vinculado), reserva original y POS ambos `PENDING` | `0.00` | `0` | ✅ |
| (e) | ídem, reserva original `SETTLED`, POS sigue `PENDING` | `0.00` | `0` | ✅ |
| (e) | ídem, POS también liquida | `200.00` | `200` (cuenta normal — nunca fue candidato a vincularse, se creó después de la transferencia) | ✅ |
| (f) | `ADJUSTMENT` de precio (`+150`) agregado después de transferir — pre-complete | `0.00` | `0` | ✅ |
| (f) | ídem, post-complete (settlea junto con el cargo original) | `150.00` | `150` | ✅ |
| (g) | Pago real del huésped (`50`) después de que la transferencia ya liquidó del todo | `-50.00` | `-50` | ✅ |
| (h) | Cancelación-con-NC — pre-cancelar | `0.00` | `0` | ✅ |
| (h) | ídem, post-cancelar (`CHARGE` `SETTLED` + `ADJUSTMENT` compensatorio `SETTLED`) | `-1000.00` | `-1000` **(permanente, a propósito — hallazgo hermano ya registrado, no lo resuelve este predicado — ver §2.6)** | ✅ |
| edge | `CHARGE` ya `SETTLED` (`1000`) + `ADJUSTMENT` descuento `PENDING` (`-100`) vinculados, `PAYMENT` transferido `900` — antes de que el descuento confirme | `100.00` | `100` (conservador: el descuento no acreditado todavía no se resta — sin el `GREATEST(0,...)` esta celda daría `0`, optimista de más) | ✅ |
| edge | ídem, descuento confirma (`SETTLED`) | `0.00` | `0` | ✅ |
| regresión | Reserva cancelada DESPUÉS de transferir (`CHARGE` `PENDING`→`VOIDED` vía `voidByReservationId()`) — gap YA conocido, Bloque 3a | `-1000.00` | `-1000` — **mismo resultado que el código de HOY, sin ningún mecanismo de exclusión.** No es una regresión nueva del diseño de paso 3: se verificó explícitamente que el resultado es idéntico con y sin la columna nueva. | ✅ |

**20/20 mediciones coinciden con la VERDAD esperada — incluidas las 16
de la cuarta pasada (para confirmar que no se reabrió nada), F1 (el
defecto que tumbó la cuarta pasada), el caso `edge` del clamp
`GREATEST(0,...)`, y la regresión de control.** Base de datos dropeada
al finalizar (`DROP DATABASE test_city_ledger_link_verify`), confirmado
con `\l` que no quedó ninguna base `test_*` huérfana en el cluster.

**Contraste con los defectos que tumbaron las cuatro pasadas anteriores:**
- **Defecto 1 (ronda 1, un `PAYMENT` real excluido por error)** — sigue
  sin poder volver a pasar: el conjunto vinculable nunca incluye un
  `PAYMENT`/`REFUND` real, el `UPDATE` de §2.3 filtra `type IN ('CHARGE',
  'ADJUSTMENT')`. Ver escenario (b).
- **Defecto 2 (ronda 2, sobreestimaba tras `correctedBalance`)** — sigue
  sin poder volver a pasar: el mecanismo no distingue AR "original" de
  "de reemplazo", cada una vincula (o no) independientemente. Ver
  escenario (d).
- **Defecto 3 (ronda 2, sin límite temporal)** — sigue cerrado: la
  corrección por AR se apaga sola en cuanto `pending_amount` de esa AR
  llega a `0`, nunca depende de una fecha límite. Ver escenarios (e)/(f)/(g).
- **F1 (cuarta pasada — "Ronda 3" en la numeración del gate, un
  `CHARGE`/`ADJUSTMENT` con trigger de liquidación independiente
  mantenía la exclusión binaria activa para siempre)** — cerrado de
  raíz: la corrección es por MONTO vinculado todavía `PENDING`, no un
  booleano sobre "¿existe algo `PENDING`?" — cada fila vinculada se
  auto-actualiza sola, sin rehén del trigger más lento del conjunto.
  Ver fila F1 arriba, la que efectivamente reproduce el defecto.

### 2.5 Precondición de cardinalidad — investigada, riesgo real encontrado (distinto del que resuelve este diseño)

La pregunta que las rondas anteriores dejaron abierta ("¿puede haber más
de una AR original viva por estadía a la vez?") **sigue sin ser una
condición de corrección de la query de §2.3, bajo el diseño nuevo
también** — la corrección `still_unconfirmed` agrupa `LEAST(...)` **por
AR** (`GROUP`/`SUM` sobre el resultado de un `JOIN` fila-por-fila de
`accounts_receivable`, no un `EXISTS` compartido), así que aunque
existieran dos AR "originales" simultáneas para la misma estadía, cada
una aporta su propio término `LEAST(payment_ar, pending_ar)`
independiente, sin ambigüedad — no hay ningún camino en el que la query
necesite saber cuál de las dos manda, ni siquiera para decidir a cuál
AR se vincula cada `CHARGE`/`ADJUSTMENT` PENDING: eso ya lo resuelve el
`UPDATE ... WHERE absorbed_by_ar_id IS NULL` de §2.3 — cualquiera de las
dos transferencias concurrentes que corra primero se lleva las filas
disponibles, la segunda no encuentra nada que vincular (mismo mecanismo
que ya evita el doble-vínculo en el escenario (d), reverseTransfer, sin
necesitar lógica nueva).

**Dicho eso, la pregunta seguía siendo legítima por otro motivo —
investigada en el código real, no descartada sin mirar:**
`transferStayBalanceToReceivable()` (`accounts-receivable.service.ts:276-400`)
lee `getNetBalanceByStayId(input.stayId)` **fuera** de la transacción
(línea 309), antes de tomar el lock de la reserva (línea 320, dentro de
`transactionManager.run`). Eso es una ventana TOCTOU real: dos llamadas
concurrentes a `transferStayBalanceToReceivable()` sobre la MISMA
estadía pueden leer el mismo `balance > 0` **antes** de que ninguna de
las dos haya lockeado nada, pasar las dos el guard `if (balance <= 0)
throw`, y entrar cada una a su propia transacción — el lock serializa el
`INSERT`, pero no revalida el balance bajo lock: no hay ningún
`getNetBalanceByStayId` (ni equivalente) llamado DESPUÉS de
`getByIdWithLock` y ANTES de `postStayTransfer()`. Consecuencia real: la
segunda transacción puede crear una SEGUNDA AR "original" (`replaces_ar_id
NULL`) para una estadía cuyo saldo ya se transfirió entero — dos
`PAYMENT` sintéticos por el mismo monto, y **la empresa termina con el
doble de deuda** (`companyChargeId` #1 y #2, ambos por `1000`, contra un
único `CHARGE` real de `1000` del huésped).

**Este es un defecto real, pero es ORTOGONAL a paso 3 — no lo introduce
este diseño ni lo agrava.** El predicado de §2.3 sigue siendo
aritméticamente correcto aunque este bug ocurra (cada `PAYMENT`
sintético se evalúa por separado, correctamente, contra su propio cargo
financiador) — lo que el bug rompe es la CONTABILIDAD DE LA EMPRESA
(doble cargo), no la simetría del balance del huésped que este ítem
existe para arreglar. Por eso, siguiendo el criterio que el gate ya fijó
para el guard de §2.5(ii) de la ronda anterior ("necesitaría su propio
gate"): **queda diseñado acá, sin implementar, para su propio commit
posterior:**

> Guard propuesto: mover (o agregar) la re-lectura de
> `getNetBalanceByStayId(input.stayId)` a **dentro** de
> `transactionManager.run(...)`, inmediatamente después de
> `getByIdWithLock(client, stay.reservationId)` y antes de construir los
> parámetros de `postStayTransfer()` — si el balance recalculado bajo
> lock ya es `<= 0` (otra transferencia concurrente ganó la carrera),
> lanzar `NoBalanceToTransferError` igual que hoy lanza en el chequeo de
> afuera. El lock de la reserva ya serializa a las dos llamadas
> concurrentes entre sí (`stay.reservationId` es el mismo para ambas);
> lo único que falta es que la segunda, al entrar bajo lock, vuelva a
> mirar la verdad en vez de reusar la lectura de antes de la carrera.

No se implementa en este documento (diseño, no código de producción) ni
se resuelve el mismo día que paso 3 — es un bloque propio, con su propio
gate, tal como el precedente ya marcado en la ronda anterior para casos
de la misma forma.

### 2.6 Hallazgo hermano — cancelación-con-NC, ya registrado, no duplicado acá

**Pedido explícito de esta sesión: verificar si la dirección de la
columna de vínculo empeora, mejora, o deja igual este hallazgo —
razonado, no asumido, y verificado empíricamente (fila `(h)` de §2.4).
Conclusión: lo deja EXACTAMENTE IGUAL.** El caso (h) confirma en código
y en corrida real lo que `docs/pendientes-2026-09-12.md` (bloque
`1c-0`/`ORDER-CONSOLIDATED-PARTIAL-01`, "PAYMENT sintético de City
Ledger contamina el balance del cliente") ya tenía registrado como
hallazgo separado, con un mecanismo DISTINTO del que motivó este ítem
(`CITY-LEDGER-CUSTOMER-BALANCE-STATUS-ASYMMETRY-001`, que es sobre el
camino feliz). **Paso 3, tal como quedó diseñado en esta revisión, no lo
resuelve ni lo intenta resolver, ni por accidente:**

- El `CHARGE` original queda vinculado (`absorbed_by_ar_id`) a la AR
  desde el momento de la transferencia — eso no cambia con la
  cancelación.
- `cancel-reservation-with-credit-note.service.ts`/
  `cancel-order-with-credit-note.service.ts` liquidan (`SETTLED`) el
  `CHARGE` original vinculado JUNTO con un `ADJUSTMENT` compensatorio
  **nuevo** (nunca vinculado a ninguna AR — no existía al momento de la
  transferencia).
- En la query de §2.3: el `CHARGE` vinculado, ya `SETTLED`, deja de
  aportar a `pending_amount` de esa AR (pasa a `0`, la corrección
  `still_unconfirmed` de esa AR desaparece) — y como cuenta normal en
  `normal_sum` (`SETTLED`), el `PAYMENT` sintético (contado siempre,
  nunca excluido bajo este diseño — solo se le resta la corrección por
  AR) queda sin ninguna contrapartida que lo compense, porque el
  `ADJUSTMENT` compensatorio nuevo NO está vinculado a ninguna AR y por
  lo tanto no aporta ninguna corrección tampoco. Resultado: `CHARGE(+1000)
  + ADJUSTMENT(-1000) + PAYMENT(-1000) = -1000` — el mismo resultado
  numérico, por el mismo motivo estructural (nada compensa al `PAYMENT`
  sintético una vez que su `CHARGE` financiador queda neteado por otra
  vía), que la cuarta pasada ya daba para este caso.

Que el resultado sea idéntico bit-a-bit entre el diseño rechazado (F1) y
el diseño nuevo para ESTE escenario puntual no es casualidad ni
coincidencia sospechosa: en cancelación-con-NC el `CHARGE` SIEMPRE queda
`SETTLED` (nunca se queda `PENDING` para siempre, a diferencia de F1),
así que cualquier mecanismo razonable de "descontar solo mientras algo
siga `PENDING`" converge al mismo número acá — la diferencia entre los
dos diseños es exclusivamente sobre CUÁNTO TIEMPO puede seguir `PENDING`
un cargo vinculado y CUÁNTOS cargos independientes puede haber, no sobre
qué pasa cuando todos ya liquidaron. El fantasma permanente expuesto acá
(en vez de escondido) sigue siendo correcto por el mismo argumento que
la cuarta pasada ya daba: esconderlo sería peor (un crédito fantasma
invisible es más difícil de auditar que uno visible y ya registrado en
pendientes). Resolver ESE hallazgo (compensar también la pata `PAYMENT`
sintética cuando su `CHARGE` se cancela-con-NC, o alguna variante) es
alcance del ítem hermano, no de este documento — referenciado, no
copiado.

### 2.7 Residuo declarado — `linkStayToReservationCharges()` y el CHARGE de la empresa

La ronda 1 (§0 de este documento, "hallazgo colateral") dejó sin resolver
si `linkStayToReservationCharges()` (`UPDATE financial_transactions SET
stay_id = $1 WHERE reservation_id = $2 AND stay_id IS NULL`, sin filtro
de `customer_id`) podía estampar `stay_id` en el `CHARGE` de la EMPRESA
por error, derrotando la omisión a propósito de `postStayTransfer()`
(§ arriba, líneas ~463-472 del archivo de servicio: el `CHARGE` de la
empresa nace explícitamente SIN `stay_id`, justamente para no entrar en
cálculos de saldo por estadía).

**Con el diseño final de este documento (columna `absorbed_by_ar_id`),
ese residuo sigue sin ser un riesgo para paso 3 — re-verificado bajo el
mecanismo nuevo, no heredado sin mirar de la cuarta pasada.** El `UPDATE`
de §2.3 (`absorbPendingIntoTransfer()`) filtra explícitamente
`customer_id = $2` (el `stayCustomerId`, el huésped — nunca la
empresa). Así que aunque `linkStayToReservationCharges()` estampara
`stay_id` en el `CHARGE` de la empresa por la carrera ya conocida
(`CITY-LEDGER-AR-STAY-ADOPTION-RACE-001`), ese `CHARGE` tiene
`customer_id` de la EMPRESA — el `UPDATE` de vínculo nunca lo toca
(no matchea `customer_id = $2`), así que nunca puede quedar
`absorbed_by_ar_id` seteado en él, y por lo tanto nunca puede aportar
(ni de más ni de menos) a `still_unconfirmed` de ninguna AR. El residuo
sigue siendo un hallazgo real sobre `linkStayToReservationCharges()` en
sí — no se resuelve acá, sigue anclado donde ya estaba — pero, igual que
bajo el diseño de la cuarta pasada, **no es un riesgo para este
mecanismo**, por el mismo tipo de defensa (filtro explícito de
`customer_id` en el punto donde se decide qué fila entra al cálculo).

### 2.8 Análisis de impacto

**Consumidores de producción — sin cambios respecto a la cuarta pasada
(no se re-derivan, se confirman):** `CustomerAccountService.getStatement()`
(`GET /customers/:id/account`,
`appfrontend/src/app/dashboard/cuentas-corrientes/page.tsx`), con
`appfrontend/.../reservas/[id]/page.tsx` confirmado sin lectura de
`balance`.

**Wiring nuevo (a diferencia de la cuarta pasada, que solo cambiaba el
SQL interno de un método existente — este diseño agrega superficie
real):**
- `src/db/schema.sql` — columna `financial_transactions.absorbed_by_ar_id`
  + índice parcial (§2.3). `CURRENT_SCHEMA_VERSION` sube de 54 a 55
  (`src/platform/tenant-db.setup.ts:464`).
- `src/clientes-finanzas/financial-transaction.repository.ts` (interfaz)
  — método nuevo `absorbPendingIntoTransfer?()`, OPCIONAL, mismo
  precedente de `getByIdWithLock?`/`getCityLedgerOutstandingByCustomerId?`
  (§4.3 de paso 2b). Un solo caller real:
  `AccountsReceivableService.postStayTransfer()` — de los 7 fakes de
  `FinancialTransactionRepository` relevados en §4.3 de paso 2b, ninguno
  ejercita `postStayTransfer()`/`transferStayBalanceToReceivable()`
  directamente (ese servicio no usa ninguno de esos 7 fakes — construye
  el suyo propio en sus propios tests, `accounts-receivable.service.test.ts`)
  así que el impacto de marcarlo opcional-con-guard es, si acaso, MENOR
  que el de `getCityLedgerOutstandingByCustomerId?` — a confirmar con el
  fake real de `accounts-receivable.service.test.ts` en el commit de
  implementación, no en este documento.
- `src/clientes-finanzas/sql.financial-transaction.repository.ts` —
  implementación del método nuevo (el `UPDATE` de §2.3) + el cuerpo SQL
  nuevo de `getNetBalanceByCustomerId()` (la CTE con `still_unconfirmed`).
- `src/clientes-finanzas/accounts-receivable.service.ts` — `postStayTransfer()`
  pre-genera `arId` (en vez de generarlo inline en el último `return`) y
  llama al método nuevo antes de los tres inserts existentes. Único
  archivo con cambio de LÓGICA de negocio (los demás son
  schema/interfaz/implementación mecánica).

**Corrección de una cita falsa de la cuarta pasada (F7 del gate) — el
plan de test:** la cuarta pasada citaba
`sql.financial-transaction.repository.test.ts:741-743` como si validara
la aritmética contra Postgres real. **Es falso, verificado leyendo el
archivo, no asumido:** ese archivo instancia
`mockSqlClient = { query: vi.fn(async () => ({ rows: [] })) }` (línea
10) — un mock que no ejecuta SQL contra ninguna base, solo verifica la
FORMA de la llamada (qué string/parámetros recibió `query()`). El propio
`financial-transaction.integration.test.ts` (líneas 19-26) documenta el
motivo exacto por el que esto es peligroso para este tipo de cambio: *"El
test de `sql.financial-transaction.repository.test.ts` que 'cubría' el
signo solo comparaba el string del SQL (...) -- estructuralmente no
podía detectar un error de signo porque espeja la implementación en vez
de verificar el resultado numérico real."* Cualquier aserción aritmética
sobre el predicado nuevo (§2.3/§2.4) tiene que ir en
`src/tests/integration/` (contra Postgres real, vía `TEST_DATABASE_URL`
— ver el requisito de entorno documentado en la cabecera de
`financial-transaction.integration.test.ts:28-35`), nunca en el archivo
mockeado — un test unitario ahí solo puede verificar la FORMA del SQL
nuevo (que el `UPDATE`/la CTE existan, que reciban los parámetros
correctos), nunca su resultado numérico.

**Tests de integración (`src/tests/integration/`, Postgres real) a
tocar o agregar:**
- `financial-transaction.integration.test.ts` — agregar los escenarios
  (a)/(b) y **F1** de §2.4 como casos permanentes (F1 es el que habría
  atrapado el defecto real de la cuarta pasada).
- Un archivo nuevo o una sección nueva dedicada a
  `transferStayBalanceToReceivable()`/`reverseTransfer()` con los
  escenarios (c)/(d)/(e)/(f)/(g)/(h)/edge de §2.4 — el candidato natural
  es extender `accounts-receivable-invoice-linkage.integration.test.ts`
  (ya ejercita `transferStayBalanceToReceivable()` contra Postgres real,
  líneas 577-813) en vez de crear un archivo nuevo, a decidir en el
  commit de implementación.
- `cancel-reservation-with-credit-note.integration.test.ts:682-732` —
  revisar contra la nueva composición (§2.6): mismo resultado numérico
  esperado (`-100`/`-1000` según el caso), pero ahora por un mecanismo
  distinto (corrección por AR en `0`, no un `EXISTS` que nunca se activa)
  — el test de composición explícito (líneas 714-719, que ya discrimina
  MECANISMO y no solo total) puede necesitar una aserción adicional
  sobre `absorbed_by_ar_id`, a decidir en el commit de implementación.
- `cancel-order-with-credit-note.integration.test.ts:340` — mismo
  criterio.
- `accounts-receivable-invoice-linkage.integration.test.ts:321-333` —
  ejercita `getNetBalanceByCustomerId(company.id)`, el lado EMPRESA, no
  el huésped — el diseño nuevo nunca toca filas de la empresa (§2.7),
  así que este assert no debería cambiar de valor, pero el archivo ya
  ejercita `transferStayBalanceToReceivable()` end-to-end así que corre
  por el código nuevo de todos modos — mantenerlo en la lista de
  re-verificación por disciplina, no porque se espere que falle.
- `city-ledger-outstanding.integration.test.ts` (paso 2b, ya existente,
  `src/tests/integration/`) — no debería verse afectado (ejercita
  `getCityLedgerOutstandingByCustomerId()`, una query distinta que no
  toca `absorbed_by_ar_id`), pero corre en la misma zona de código y
  vale confirmarlo corriendo la suite completa, no solo los archivos de
  esta lista.

**Ningún fake nuevo de `FinancialTransactionRepository` hace falta para
`getNetBalanceByCustomerId()`** — sigue siendo el mismo método de la
interfaz, solo cambia su SQL interno (mismo criterio que la cuarta
pasada). El único fake que SÍ necesita un método nuevo es el de
`accounts-receivable.service.test.ts`, para `absorbPendingIntoTransfer?()`
— alcance y arreglo exactos a determinar en el commit de implementación,
no en este documento de diseño.

### 2.9 Cierre — decisión final del dueño: NO SE IMPLEMENTA (14/09/2026)

El diseño de la quinta pasada (§2.1-§2.8, columna
`absorbed_by_ar_id` + corrección proporcional) sobrevivió su propia
verificación aritmética (12/12 escenarios contra Postgres real, §2.4) y
la interacción con `reverseTransfer()` que había tumbado la cuarta
pasada. Con el diseño ya en pie, el gate `architecture-governor` hizo la
pregunta de negocio que quedaba, vía `AskUserQuestion` al dueño: **¿el
`balance` del cliente (`getNetBalanceByCustomerId()`) debe absorber esta
corrección parcial, o debe quedar INTACTO** — manteniendo su definición
actual, SETTLED-only, groundeada contra Odoo/ERPNext/QloApps en el paso 1
de este mismo ítem —, **dejando que el campo separado
`cityLedgerOutstanding` (paso 2(b), ya implementado y commiteado en
`1dc6c84`) resuelva la necesidad de visibilidad?**

**El dueño respondió: no tocar `balance`.** Decisión final: **el paso 3
NO SE IMPLEMENTA.** `getNetBalanceByCustomerId()` queda exactamente como
está hoy, sin ningún cambio — ni el de esta quinta pasada ni el de
ninguna de las tres anteriores.

**Por qué (un párrafo):** cuatro rondas de diseño sucesivas (§0 y el
preámbulo de revisiones, arriba) encontraron cuatro defectos aritméticos
reales y distintos — un PAYMENT real de huésped contado como crédito
fantasma (ronda 1), una exclusión sin límite temporal (ronda 2), la
misma regresión permanente que ya había obligado a revertir `8f11d19`
para un cargo de POS "a la habitación" que no liquida junto con la
reserva (ronda 3), y una interacción no medida con `reverseTransfer()` más
un escenario de pago parcial + liquidación escalonada (ronda 4) — cada
uno más sutil que el anterior, lo que indica que el costo de seguir
iterando sobre `balance` (una columna que otros contextos ya leen como
"lo que el cliente debe, asentado") seguía creciendo más rápido que el
beneficio de una corrección parcial, cuando el paso 2(b) ya resuelve la
necesidad real de visibilidad (`cityLedgerOutstanding`) sin tocar esa
columna. El crédito fantasma transitorio (el caso que motivó las cinco
rondas) queda como comportamiento conocido y aceptado: se autocorrige
solo en el camino feliz, cuando el `CHARGE` original liquida (verificado
empíricamente en la cuarta pasada, §2 arriba) — explicable en pantalla
vía `cityLedgerOutstanding`, no oculto. El historial completo de las
cuatro rondas rechazadas (§2.1-§2.8 y el preámbulo de revisiones) queda
como registro de por qué se descartó cada dirección — no se borra.

**Lo que esta decisión NO cierra:** el caso permanente de cancelación con
Nota de Crédito (un `PAYMENT` sintético de City Ledger que sí contamina
`balance` de forma durable, no transitoria) sigue siendo el bug hermano
ya registrado aparte, dentro de `ORDER-CONSOLIDATED-PARTIAL-01`
(`docs/pendientes-2026-09-12.md`) — ver §2.6. Esa parte sigue abierta;
esta decisión solo cierra el paso 3 de
`CITY-LEDGER-CUSTOMER-BALANCE-STATUS-ASYMMETRY-001`.

---

## 3. Preguntas de alcance — 4 de 5 DECIDIDAS (dueño, 2026-09-14)

1. **Compatibilidad del contrato de `CustomerStatement` (paso 2b) — DECIDIDA:
   "aditivo, sin bloquear".** El backend puede deployar el campo nuevo
   solo, sin coordinar con el frontend. Ver §1.5 — implementado como
   `cityLedgerOutstanding?: number`, mismo patrón opcional que el resto
   del contrato.

2. **Alcance del monto no-settled (paso 2b) — DECIDIDA: "mostrar SOLO si
   hay transferencia a City Ledger de por medio".** NO un total genérico
   de todo lo no-SETTLED del cliente (eso era `unsettledNet`, descartado
   en §1.2 opción D). Ver §1.3 — el campo está cruzado contra
   `accounts_receivable` vía `guest_payment_transaction_id`, no contra
   `financial_transactions.status` a secas.

3. **La fila "AR Transfer" del statement — DECIDIDA: "sí debe contar para
   un total nuevo"** ("total transferido a City Ledger, vigente"). Ver
   §1.4 — resuelto con el mismo campo que la pregunta 2, no con un
   mecanismo aparte (ver "Análisis de convergencia" más abajo).

4. **Secuenciación del paso 3 — DECIDIDA: "implementar ya, sin esperar a
   resolver primero la pregunta de cardinalidad de `stays`↔`reservation_id`
   como una vuelta de research aparte".** **Nota de la tercera revisión
   (C1), sigue vigente en la cuarta:** el rediseño nunca necesitó unir
   contra `stays`/`reservation_id` — ni el de la tercera pasada
   (`ar.stay_id` como llave) ni el de esta cuarta (`ft.id =
   ar.guest_payment_transaction_id`, ver §2.3) — así que la pregunta de
   si una reserva puede tener más de una fila en `stays` a lo largo del
   tiempo sigue fuera del camino crítico de este diseño. **Lo que la
   cuarta pasada SÍ encontró e investigó** es una pregunta de
   cardinalidad distinta y real (¿puede haber más de una AR "original"
   viva por estadía?) — resuelta en §2.5: no afecta la corrección de la
   query (el predicado nunca agrupa por `stay_id`), pero destapó un TOCTOU
   real en `transferStayBalanceToReceivable()` que sí puede duplicar una
   transferencia — guard diseñado, no implementado, en §2.5.

5. **Nombre del campo nuevo — la única que sigue abierta, a criterio del
   ingeniero.** Ver "Nombre elegido" más abajo.

### Análisis de convergencia (preguntas 2+3) — CONFIRMADO, con un matiz declarado

La síntesis original ("las respuestas 2 y 3 piden el MISMO número, un
solo campo alcanza para las dos") se sostiene tras releer
`accounts-receivable.repository.ts`/`.service.ts` completos: "específico
a City Ledger" (pregunta 2) y "total transferido a City Ledger, vigente"
(pregunta 3) son, literalmente, la misma suma — `SUM(accounts_receivable.amount)`
de las filas vigentes de este cliente. No hace falta un `unsettledNet`
genérico MÁS un total separado de "AR Transfer vigente": `cityLedgerOutstanding`
sirve para las dos preguntas.

**El matiz que sí apareció, al mirar `reverseTransfer()`/el circuito de NC
completos (no asumido, verificado en código):** "vigente" tiene una
definición precisa y verificable en el `status` de `accounts_receivable`
(`PENDIENTE_FACTURAR`/`FACTURADO`, ni `COBRADO` ni `REVERTIDO`) — pero esa
columna **no se actualiza sola** cuando una reserva/orden con una AR
activa se cancela por el circuito de Nota de Crédito
(`cancel-reservation-with-credit-note.service.ts:465-482`,
`cancel-order-with-credit-note.service.ts`): ese camino solo deja un
`logger.warn({evento: 'nc_escape_con_ar_viva'})`, nunca toca `ar.status`.
Así que `cityLedgerOutstanding` puede, en ese escenario puntual, seguir
sumando una AR que el negocio ya considera "resuelta" del lado fiscal
pero que la tabla todavía no refleja como tal. **No es un defecto de este
diseño ni algo para resolver en pasos 2(b)/3** — es la consecuencia
directa de una decisión YA TOMADA por el dueño ("Guard en la NC —
exponer, no bloquear", `docs/diseno-reconciliacion-city-ledger-2026-09-12.md:1546-1552`,
`AskUserQuestion` 13/09/2026 — corrección de atribución, C3, gate
14/09/2026: la versión anterior de este párrafo citaba esto como "una
brecha abierta en pendientes", como si nadie hubiera decidido nada
todavía; la decisión de no bloquear la NC ya está tomada, lo que sigue
abierto es solo la sincronización de `ar.status`). `cityLedgerOutstanding`
hereda esa consecuencia ya conocida en vez de crear una nueva — lo nuevo
es que ahora es VISIBLE en pantalla (antes solo en logs/JSON crudo), y
eso quedó registrado como ítem propio de `pendientes-2026-09-12.md`
(`CITY-LEDGER-OUTSTANDING-NC-STALE-SURFACE-001`, ver §1.3). Queda citado
en el docblock del método (§1.3) para que quien lo lea de acá a un tiempo
sepa por qué el número puede no bajar a cero exactamente cuando alguien
esperaría.

### Nombre elegido — `cityLedgerOutstanding`

Recomendación del ingeniero (la pregunta 5 queda a este criterio, según
el dueño). Descartados, con motivo:

- `unsettledNet` — el nombre original, ya descartado por la pregunta 2:
  sugiere "todo lo no liquidado", exactamente lo que el dueño pidió NO
  mostrar.
- `pendingBalance`/`pendingAmount` — el propio §3.5 de la versión
  anterior de este documento ya marcó el riesgo: "pending" evoca el
  estado `PENDING` de `financial_transactions`, un vocabulario DISTINTO
  del que este campo usa (`accounts_receivable.status`). Un lector que
  conoce el primero asumiría mal el segundo.
- `arTransferOutstanding`/`receivableOutstanding` — más preciso
  técnicamente (nombra la tabla), pero el nombre del CONTRATO ya usa
  "City Ledger" en el ítem que lo origina
  (`CITY-LEDGER-CUSTOMER-BALANCE-STATUS-ASYMMETRY-001`) y en el label
  visible de la UI actual ("Transferido a cuenta por cobrar — empresa
  X") — "AR"/"receivable" es la sigla interna de la tabla, no el término
  que el usuario del dashboard reconoce en pantalla.

`cityLedgerOutstanding` gana porque: (a) usa el mismo término de negocio
("City Ledger") que ya aparece en `notes` de la fila real y en el ítem
que origina el diseño, no la sigla de tabla; (b) "outstanding" es preciso
en inglés contable — "vigente, sin saldar todavía", sin el matiz de
"vencido" que tendría "overdue" ni la ambigüedad de "pending"; (c) no
colisiona en vocabulario con ningún campo existente de
`FinancialTransaction`/`AccountReceivable` (evita el error concreto que
`pendingBalance` habría reproducido).

---

## 4. Cumplimiento (reescrita completa, C7 — antes era un párrafo vacío)

**Histórico — no es un plan vigente.** El paso 3 quedó DECIDIDO NO
IMPLEMENTAR (§2.9); el commit que esta sección preveía para "envolver
estas corridas como tests permanentes del repo" no va a existir. Lo que
sigue documenta el trabajo de verificación aritmética que sí se hizo
durante el diseño (evidencia de por qué se descartó cada ronda), no un
plan de implementación pendiente.

### 4.1 Clasificación `criterios-negocio` (C7-a)

Ninguna de las dos queries nuevas crea una entidad, tabla ni repositorio
— las dos son lectura agregada de solo-lectura sobre entidades ya
clasificadas (`FinancialTransaction`, `AccountReceivable`, ambas
TRANSACCIÓN en la taxonomía de `criterios-negocio.md`). Lo que corresponde
declarar es contra qué reglas de negocio se apoyan:

- **`getNetBalanceByCustomerId()` (paso 3, cambio de SQL, mismo método)**
  — ya está bajo **A3.9** ("Todo movimiento tiene contrapartida",
  `criterios-datos.md:159`) desde su versión actual; el cambio de este
  documento no la reabre, la refuerza: el predicado nuevo existe
  precisamente para que un movimiento con contrapartida sintética (el
  par `CHARGE`/`PAYMENT` de una transferencia todavía sin liquidar) no
  aparezca como si tuviera una contrapartida real faltante (el "crédito
  fantasma" que motivó todo el ítem). **Corrección de la quinta pasada
  (reemplaza la nota equivalente de la cuarta pasada, que describía un
  predicado ya rechazado):** el diseño final (§2.3) tampoco filtra por
  `accounts_receivable.status` en absoluto — se apoya en la MISMA
  garantía que la cuarta pasada ya invocaba, pero aplicada esta vez a
  una SUMA (`pending_amount` de la CTE `still_unconfirmed`, §2.3) en vez
  de a un `EXISTS` booleano: `financial_transactions.status` (`PENDING →
  SETTLED`/`VOIDED`) es monótono en este repo (ninguna fila vuelve a
  `PENDING` una vez que avanzó), así que una vez que una fila vinculada
  deja de estar `PENDING`, deja de aportar a esa suma PARA SIEMPRE — el
  mismo principio general de R12 (los estados no retroceden), aplicado a
  la tabla que la corrección efectivamente consulta.
- **También se apoya en R9** ("una transacción congela el hecho que la
  originó", citado en el propio docblock de
  `accounts-receivable.service.ts`) — el predicado nunca reescribe ni
  reinterpreta el signo/monto de ninguna fila, solo decide si SUMARLA al
  agregado; la fila en sí queda intacta, consistente con por qué
  `postStayTransfer()` nunca reasigna `customer_id` en los `CHARGE`
  existentes.
- **`getCityLedgerOutstandingByCustomerId()` (paso 2b, método NUEVO)** —
  mismas dos reglas, aplicadas por primera vez a ESTE método (no heredado
  de ningún método hermano): A3.9 porque el número que expone es,
  literalmente, "cuánto de la contrapartida de este cliente sigue sin
  resolverse del todo" (ni revertida, ni cobrada); R12 por el mismo
  motivo que arriba — el filtro `status IN ('PENDIENTE_FACTURAR',
  'FACTURADO')` es seguro exactamente porque `accounts_receivable` solo
  avanza de estado, nunca se edita ni se borra.

### 4.2 `DEFENSIVE_DEVELOPING.md` §3 — NO aplica (C7-b, declarado
explícitamente, no por omisión)

El cambio completo (pasos 2(b) y 3) toca únicamente
`src/clientes-finanzas/financial-transaction.repository.ts` (interfaz),
`src/clientes-finanzas/sql.financial-transaction.repository.ts`
(implementación) y `src/clientes-finanzas/customer-account.service.ts`
(el `Promise.all` de `getStatement()`) — **ninguno de los cuatro
directorios que disparan la §3 multi-tenant** (`src/api/routes/`,
`src/container.ts`, `src/platform/`, `src/workers/`). `customers.routes.ts`
(que SÍ vive en `src/clientes-finanzas/`, no en `src/api/routes/` — no
aplica igual la §3 por eso) tampoco necesita ninguna edición: el handler
de `GET /customers/:id/account` ya hace `res.json({ ...statement, ... })`
(`customers.routes.ts:851`/`:865-871`, verificado en esta revisión, C4) —
agregar `cityLedgerOutstanding` al objeto que devuelve `getStatement()`
alcanza solo con el spread existente, sin tocar la ruta. Ambas queries
nuevas corren sobre `req.db` (el pool de tenant ya resuelto por
`tenantMiddleware`, inyectado en el repositorio en el momento de
construir el servicio) — no hay pool nuevo, no hay `getPlatformRawPool()`
de por medio, no hay `TransactionManager` propio (son lecturas simples,
no una transacción), no hay `DomainEventRepository` involucrado. La
sección 2 (genérica) de `DEFENSIVE_DEVELOPING.md` sigue aplicando —
cubierta por el resto de este documento (predicado verificado con
aritmética concreta en §2.4, riesgos declarados en §2.5, impacto medido
en §2.8 — **corregido en la quinta pasada, F6 del gate: la cita anterior
decía "§2.6/§2.7", que son el hallazgo hermano de NC y el residuo de
`linkStayToReservationCharges()` respectivamente, ninguno de los dos es
la sección de impacto — quedó dangling tras un renumerado anterior**).
Nota adicional de esta pasada, que §4.2 de la cuarta pasada no tenía
motivo para mencionar: el wiring nuevo (columna de schema + método de
repositorio nuevo, ver §2.8) SÍ agrega un archivo a la lista de
`src/clientes-finanzas/` tocados —
`accounts-receivable.service.ts` (`postStayTransfer()`) — pero sigue sin
tocar ninguno de los cuatro directorios que disparan la §3 multi-tenant
de `DEFENSIVE_DEVELOPING.md`: sigue corriendo sobre `req.db` vía el
mismo `TransactionManager` que `transferStayBalanceToReceivable()` ya
usa hoy, sin pool nuevo.

### 4.3 §2 (impacto) — resuelto, no diferido (C7-c)

Ver §2.8 (consumidores de producción, dos, uno no afectado) y más abajo
en esta subsección (fakes de `FinancialTransactionRepository`, decisión
OPCIONAL con justificación abajo — sin cambios respecto a la ronda
anterior, `getNetBalanceByCustomerId()` no es un método nuevo). No queda
ningún punto de impacto diferido a la implementación — la única
verificación que sí se difiere a implementación es la de runtime real
(§4.4), que por su naturaleza no puede hacerse en un documento de diseño.

**Decisión OPCIONAL vs. OBLIGATORIO para `getCityLedgerOutstandingByCustomerId()`
(C2) — OPCIONAL, mismo criterio que `getByIdWithLock?`.** El precedente
exacto vive en la propia interfaz
(`financial-transaction.repository.ts:224-230`, agregado hoy mismo en el
Bloque 3c-ii para `reverseTransfer()`): *"Opcional (mismo criterio que
`settleByIdsWithClient?`... 7 fakes completos de
`FinancialTransactionRepository` en tests de otros módulos no lo
necesitan -- obligatorio los rompe sin motivo. El caller hace `if
(!repo.getByIdWithLock) throw`."* `getCityLedgerOutstandingByCustomerId()`
está en la misma situación exacta: un solo caller real
(`CustomerAccountService.getStatement()`), y los mismos 7 fakes
verificados por C2 (`implements FinancialTransactionRepository`
completo, en módulos que nunca llaman a `getStatement()`):

| Fake | Archivo:línea | ¿Necesita el método nuevo? |
|---|---|---|
| `FakeFinancialTransactionRepository` | `facturacion/invoice.service.test.ts:185` | No — prueba `InvoiceService`, no `CustomerAccountService` |
| `FakeMultiFinancialTransactionRepository` | `facturacion/invoice.service.test.ts:1883` | No, ídem |
| `FakeFinancialTransactionRepository` | `pms-estadias/stay.service.test.ts:75` | No — prueba `StayService` |
| `FakeFinancialTransactionRepository` | `workers/outbox.handlers.test.ts:69` | No — prueba los handlers del outbox |
| `FakeFinancialTransactionRepository` | `clientes-finanzas/accounts-receivable.service.test.ts:119` | No — prueba `AccountsReceivableService`, no `getStatement()` |
| `InMemoryFinancialTransactionRepository` | `clientes-finanzas/cash-register.service.test.ts:80` | No — prueba `CashRegisterService` |
| `InMemoryFinancialTransactionRepository` | `clientes-finanzas/customer-account.service.test.ts:18` | **Sí** — este fake SÍ prueba `CustomerAccountService.getStatement()`, el único caller real |

**Un solo archivo a tocar en el mismo commit de implementación:**
`customer-account.service.test.ts:18` — agregar el método al fake (con
un valor configurable por test, para poder ejercitar el campo nuevo en
los tests de `getStatement()`). Los otros 6 quedan sin tocar, igual que
`getByIdWithLock?` no los tocó. `getStatement()` sigue el mismo patrón
de caller que `reverseTransfer()`: `if
(!this.financialRepo.getCityLedgerOutstandingByCustomerId) throw new
Error('CustomerAccountService.getStatement: FinancialTransactionRepository.getCityLedgerOutstandingByCustomerId
no está implementado en este repositorio.')` — en producción,
`SqlFinancialTransactionRepository` (la única implementación real)
siempre lo implementa, así que este throw solo puede dispararse por un
fake de test mal armado, nunca en runtime real.

*(Si en cambio se hubiera elegido OBLIGATORIO: los 7 archivos de la
tabla de arriba habrían necesitado un método agregado — aunque sea un
stub `async () => 0` en los 6 que no lo ejercitan — en el mismo commit,
solo para que `implements FinancialTransactionRepository` siguiera
compilando. Descartado por ser exactamente el costo que el propio
precedente de `getByIdWithLock?` ya identificó y evitó.)*

### 4.4 Plan de test (C7-d)

**Corrección F7 (gate, quinta pasada) — `sql.financial-transaction.repository.test.ts`
NO es un test de integración y NO puede alojar ninguna aserción
aritmética del predicado nuevo.** La cuarta pasada citaba ese archivo
como si "ya corriera contra Postgres" — falso, verificado leyendo el
archivo (no asumido de la corrida verde, que tampoco prueba nada sobre
esto): `beforeEach` instancia `mockSqlClient = { query: vi.fn(async ()
=> ({ rows: [] })) }` (línea 10) — un mock que jamás ejecuta SQL, solo
registra qué se le llamó. Es exactamente el mismo modo de falla que
`financial-transaction.integration.test.ts` documenta en su propia
cabecera (líneas 19-26) sobre ESE MISMO archivo, para un bug de signo
anterior: *"comparaba el string del SQL (...) -- estructuralmente no
podía detectar un error (...) porque espeja la implementación en vez de
verificar el resultado numérico real."* Un test en ese archivo solo
puede verificar la FORMA del SQL/parámetros nuevo (que
`absorbPendingIntoTransfer()` arme el `UPDATE` correcto, que
`getNetBalanceByCustomerId()` arme la CTE nueva) — nunca su resultado
numérico. Cualquier aserción del tipo "el balance da X" tiene que vivir
en `src/tests/integration/`, contra Postgres real vía
`TEST_DATABASE_URL`.

**Unitarios** (contra fakes/mock de forma, rápidos):
- `sql.financial-transaction.repository.test.ts` — que
  `absorbPendingIntoTransfer()` arme el `UPDATE` con los `$1`/`$2`/`$3`
  correctos (`stayId`/`customerId`/`accountsReceivableId`) y que
  `getNetBalanceByCustomerId()` siga devolviendo `parseFloat(rows[0]?.net
  ?? '0')` sobre el resultado de la query nueva — cobertura de FORMA,
  nunca de aritmética (ver corrección de arriba).
- `customer-account.service.test.ts` — sin cambios respecto a lo ya
  implementado en paso 2b (§4.3): `getStatement()` devuelve
  `cityLedgerOutstanding` cuando el fake lo implementa, lo omite
  (`undefined`, no `0`) cuando no.

**Integración, OBLIGATORIOS contra Postgres real (C7-d).** El hueco de
test que señaló el ítem de pendientes original (ya cortado a
`docs/resuelto.md`, sección `14/09/2026` — el rango de línea que citaba
`docs/pendientes-2026-09-12.md` dejó de existir con el cierre del ítem,
cita por texto en vez de por línea desde acá en adelante, criterio
SCHEMA-ANCHOR-DRIFT-001): *"ningún test existente cubre el balance del
cliente DESPUÉS de `reservation.completed` sobre una estadía
transferida"*. El
cluster PostgreSQL 16.13 local de este sandbox ya estaba `online`
(`pg_lsclusters`, no hizo falta arrancarlo) — los siguientes casos son
ejecutables, no solo diseñables, y tienen que correr antes de dar el
paso 3 por cerrado. Ubicación sugerida: extender
`financial-transaction.integration.test.ts` (1-2, los que no dependen de
`transferStayBalanceToReceivable()` end-to-end con guards de factura) y
`accounts-receivable-invoice-linkage.integration.test.ts` (3-8, ya
ejercita `transferStayBalanceToReceivable()`/`reverseTransfer()` contra
Postgres real) — decisión final de organización de archivos, no de
diseño, a tomar en el commit de implementación:

1. Escenario (a) — transferencia simple, sin pago previo: verificar
   `getNetBalanceByCustomerId(guestId) === 0` tanto ANTES de
   `reservation.completed` (`CHARGE` todavía `PENDING` — la ventana
   transitoria del bug original) como DESPUÉS (`CHARGE` ya `SETTLED`).
2. Escenario (b) — pago parcial real antes de la transferencia: seedear
   un `PAYMENT` real vía `recordPayment({ stayId })`, transferir el
   resto, verificar `getNetBalanceByCustomerId(guestId) === -300`
   pre-complete y `=== 0` post-complete — este es el test que habría
   atrapado el defecto de la primera formulación de §2.2 ("excluir para
   siempre" daba `-300` post-complete en vez de `0`).
3. **Escenario F1 — el que tumbó la cuarta pasada, EL MÁS IMPORTANTE de
   agregar.** Seedear un cargo de reserva Y un cargo de POS a la
   habitación (`order.confirmed` con `stayId`), ambos `PENDING`, ambos
   ANTES de transferir. Transferir. Completar la reserva
   (`reservation.completed`, settlea el cargo de reserva). **NO
   completar la orden** (dejar el `CHARGE` del POS `PENDING`
   indefinidamente — el caso real, no un artefacto de timing). Verificar
   `getNetBalanceByCustomerId(guestId) === 0`, no `+monto de la
   reserva`. Este test, si hubiera existido, habría bloqueado la cuarta
   pasada antes de llegar al gate.
4. Escenario (c) — `reverseTransfer()` puro: verificar
   `getNetBalanceByCustomerId(guestId)` vuelve a ser igual al `CHARGE`
   original (la deuda se reabre completa) y
   `getNetBalanceByCustomerId(companyId)` vuelve a 0.
5. Escenario (d) — `reverseTransfer({ correctedBalance })`: verificar
   `getNetBalanceByCustomerId(guestId) === CHARGE - correctedBalance`.
6. Escenario (e) — cargo de POS a la habitación DESPUÉS de transferir:
   verificar que `getNetBalanceByCustomerId(guestId)` sigue en `0`
   mientras el POS esté `PENDING`, y pasa a `+monto del POS` una vez que
   liquida — a diferencia del escenario F1, acá el POS se creó DESPUÉS
   de la transferencia, así que nunca se vincula — verifica que el
   diseño distingue las dos situaciones.
7. Escenario (f) — `ADJUSTMENT` de precio posterior que liquida junto
   con `reservation.completed`: verificar
   `getNetBalanceByCustomerId(guestId) === monto del ajuste` después de
   completar (no `0`).
8. Escenario (g) — pago real del huésped después de que la
   transferencia ya liquidó del todo: verificar que
   `getNetBalanceByCustomerId(guestId)` refleja ese pago como crédito
   normal (`-monto`).
9. Escenario (h) — cancelación-con-NC sobre una estadía transferida
   (confirma que paso 3 NO lo resuelve a propósito, §2.6): verificar
   que, tras `cancelReservationWithCreditNote()` sobre una reserva con
   AR viva, `getNetBalanceByCustomerId(guestId)` queda en `-balance
   transferido` — este test documenta el comportamiento esperado, no lo
   arregla.
10. Escenario "edge" (§2.4) — un `CHARGE` ya `SETTLED` más un
    `ADJUSTMENT` descuento todavía `PENDING`, ambos vinculados a la
    misma transferencia: verificar que el balance pre-confirmación es
    conservador (`+100` en el ejemplo de §2.4, no `0`) — este es el test
    que ejercita el clamp `GREATEST(0, ...)`.
11. `getCityLedgerOutstandingByCustomerId()` (paso 2b, ya cubierto por
    `city-ledger-outstanding.integration.test.ts` existente — confirmar
    que sigue en verde, no agregar de nuevo).

No se corrieron como suite PERMANENTE del repo en esta sesión de diseño
(este documento no implementa código, ver el encabezado) — la
ARITMÉTICA de los escenarios (a)-(h) más F1 más el caso "edge" más la
regresión de control SÍ se corrió contra Postgres real como parte de
este diseño (§2.4, con la query completa reproducible, 20/20 aciertos)
para validar el predicado antes de proponerlo; lo que queda para la
sesión de implementación es envolver esas mismas corridas como tests
permanentes del repo, en el commit de paso 3 (§0, secuenciación C5).
