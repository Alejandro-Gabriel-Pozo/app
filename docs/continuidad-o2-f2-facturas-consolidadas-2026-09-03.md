# Checkpoint transferible — O2-F2: facturas consolidadas y cobro corporativo

**Fecha:** 03/09/2026. **Rama de este checkpoint:** `docs/o2-f2-checkpoint-2026-09-03`
(creada sobre `fix/o2-f1-payment-allocation-overapplication`, que todavía no
está mergeada a `main`). **Autor:** sesión de auditoría autodirigida del
circuito O2 — Order-to-Cash financiero, continuación directa del cierre de
Orders (H1/v46, ORDER-16) y de O2-F1.

**Propósito de este documento:** que otra persona (u otra sesión) pueda
continuar O2-F2 sin repetir la investigación de campo. Todo lo marcado `[V]`
está verificado contra código real y/o PostgreSQL real en esta sesión — no
es una lectura de docs.

---

## 1. Qué está cerrado

```
Orders:                          CERRADO (H1/v46, ORDER-16 — ver pendientes-2026-09-03.md)
O2-F1 (sobreaplicación de pagos): CERRADA — backend y persistencia
O2-F2 Discovery / Due Diligence:  CERRADA (este documento la cierra)
O2-F2 Implementación:             PENDIENTE
O2-F2 Frontend:                   NO VERIFICABLE — repositorio no adjunto a ninguna sesión hasta ahora
O2 completo:                      ABIERTO
```

"O2-F2 Discovery cerrada" significa: la causa raíz está identificada con
evidencia de código, reproducida contra Postgres real con dos escenarios
(saldo-no-baja y doble-cobro), auditada una segunda vez de forma
independiente (agente separado, sin ver el hallazgo previo hasta el final),
y el diseño de la corrección está delimitado con sus decisiones de negocio
pendientes explícitas. **No** significa que el defecto esté corregido.

## 2. Qué está confirmado (evidencia, no hipótesis)

### 2.1 — El defecto central: `markCollected()` no vincula su `PAYMENT` a la factura

`AccountsReceivableService.markCollected()`
(`src/clientes-finanzas/accounts-receivable.service.ts:195-225`) hace
`FACTURADO → COBRADO`: crea un `PAYMENT` `SETTLED` por `ar.amount` completo
(líneas 203-212) — **sin `settledInvoiceId`**. Causa estructural:
`accounts_receivable.invoice_ref` (`schema.sql:2341`) es un `VARCHAR(255)`
de **display** (`"0001-00001234"`), nunca un FK a `invoices.id`; el propio
comentario del schema (23/08/2026) ya lo declaraba así.

`[V]` Reproducido contra Postgres real dos veces (esta sesión y, de forma
independiente, por un segundo agente auditor sin el detalle previo):

```
Factura consolidada ISSUED: 1000
Saldo antes de markCollected():  1000
markCollected() → AR: COBRADO, PAYMENT: 1000, settled_invoice_id: NULL
Saldo después de markCollected(): 1000   ← no bajó nada
```

### 2.2 — Doble cobro real, no solo teórico

`[V]` Reproducido contra Postgres real: `markCollected()` (camino AR) +
`recordPayment(allocations)` (camino de conciliación normal, ya corregido
por O2-F1) sobre la **misma** factura:

```
Camino 1 (AR):           markCollected() → PAYMENT 1000, sin vínculo
Camino 2 (conciliación): recordPayment(allocations=[{invoiceId, amount:1000}])
                          → getOutstandingForUpdate ve la factura "libre" → aplica 1000
Total PAYMENT SETTLED contra la empresa: 2000, sobre una factura de 1000
```

**Aporte del segundo auditor (independiente), no visto antes:** trazó la
cadena de explotación completa, no solo el síntoma. `getOutstandingForUpdate()`
(`src/facturacion/sql.invoice.repository.ts:97-128`) calcula el saldo de
una factura consolidada **por `id` directo, a propósito** (para poder
calcular saldo de consolidadas en absoluto) — así que si un operador tiene
el `invoiceId` (UUID) por cualquier vía, `recordPayment()` lo acepta sin
objeción después de que `markCollected()` ya cobró esa misma factura por
AR. Verificó además que **no existe ningún endpoint que liste facturas
consolidadas por cliente** (`invoices.routes.ts` solo tiene `GET /:id`,
`GET /:id/pdf`, `GET /?financialTransactionId=` — este último no sirve para
consolidadas porque su `financial_transaction_id` es `NULL`). Esto reduce
la superficie práctica del bug pero no lo elimina, y es la razón por la que
**eleva la severidad de "gap de visibilidad" a "camino de doble cobro
alcanzable"**: el circuito de Caja/CxC debería marcarse **❌**, no ⚠️, en
cualquier tenant con City Ledger corporativo real.

### 2.3 — Lo que SÍ está bien, verificado (no asumir roto lo que no lo está)

- `doMarkCollected()` (`sql.accounts-receivable.repository.ts:119-127`):
  `UPDATE ... WHERE status='FACTURADO'` atómico, dentro de la misma
  transacción que el `PAYMENT` — dos clicks concurrentes sobre la MISMA
  fila AR no duplican el `PAYMENT` (el segundo hace rollback completo). El
  riesgo no es concurrencia dentro de `markCollected()`, es la ausencia
  total de cruce con el módulo de facturas.
- El balance agregado de la cuenta corriente (`getNetBalanceByCustomerId`)
  SÍ refleja el `PAYMENT` de `markCollected()` — el defecto es específico
  de la derivación **por factura**, no del ledger crudo.
- El vínculo hacia adelante `accounts_receivable → financial_transactions
  (CHARGE) → invoice_charges → invoices` existe con FKs reales — lo que
  falta es el camino de **vuelta** (de "ya se cobró" hacia "la factura lo
  sabe"), que estructuralmente sí es resoluble (ver §4).
- Cero cobertura de test de esto en toda la suite antes de esta sesión —
  `accounts-receivable.service.test.ts:371-402` tiene 4 tests de
  `markCollected()`, ninguno verifica `settledInvoiceId`.

### 2.4 — Subhallazgos, clasificación consolidada

```
O2-F2.1 — Visibilidad: getOutstandingByCustomerId() excluye consolidadas por el JOIN (financial_transaction_id IS NULL)
O2-F2.2 — Saldo consolidado: mismo síntoma que .1, pero ni siquiera hay endpoint de listado para descubrirlas
O2-F2.3 — markCollected() desconectado de invoices — CONFIRMADO con reproducción real, doble cobro incluido, severidad ALTA/CRÍTICA (no solo visibilidad)
O2-F2.4 — Idempotencia operativa de markCollected(): reintento post-commit devuelve 409 en vez de respuesta idempotente (no duplica dinero, solo ergonomía)
O2-F2.5 — Frontend: no verificable, repositorio no adjunto
```

## 3. Qué NO debe tocarse

- La rama `fix/o2-f1-payment-allocation-overapplication` y sus commits
  `a2aaf40` (fix) y `4195870` (doc) — O2-F1 está cerrada, no reabrir por
  este hallazgo distinto.
- La lógica ya verificada de capado de pagos en
  `CustomerAccountService.recordPayment()` — funciona correctamente para
  lo que controla (aplicación vía conciliación manual); el defecto está en
  `AccountsReceivableService.markCollected()`, un camino de aplicación
  *distinto* que nunca la consulta.
- `main` — nada de este trabajo se mergeó todavía.
- No usar `accounts_receivable.invoice_ref` como si fuera una FK confiable
  bajo ninguna circunstancia — es texto de display, sin unicidad
  garantizada, sin relación validada con `invoices` a nivel de base.
- No crear un `PAYMENT` adicional "para arreglar" el saldo — cualquier
  corrección tiene que pasar por resolver el vínculo real, no por
  compensar con otro movimiento.

## 4. Decisiones de diseño ya tomadas (no reabrir sin que se pida)

1. El pago recibido se conserva completo siempre (mismo principio que
   O2-F1, Opción B del dueño).
2. La aplicación a la factura se limita al saldo vigente (capado, no
   sobre-aplicación) — misma regla ya autorizada, se reaplica acá.
3. El excedente queda sin asignar / como saldo a favor — no se pierde, no
   se rechaza el cobro completo.
4. `invoices.status = 'ISSUED'` **no significa "pagada"** — sigue sin
   existir (ni se propone) un estado `PAID` persistido; `outstanding`
   sigue derivándose en lectura.
5. La aplicación del `PAYMENT` de `markCollected()` debe ser idempotente
   (mismo criterio que `recordPayment()`).
6. La carrera entre `markCollected()` y `recordPayment()` se serializa
   sobre la **fila de `invoices`** — mismo mecanismo de O2-F1
   (`getOutstandingForUpdate`, `FOR UPDATE OF i`), no un mecanismo nuevo.
   Ambos caminos deben tomar el mismo lock antes de aplicar.
7. No duplicar la lógica de capado/excedente mediante una llamada
   service-a-service entre `AccountsReceivableService` y
   `CustomerAccountService` (rompería el criterio de bounded context de
   este repo, ver `CLAUDE.md`) — extraerla a una primitiva compartida a
   nivel de módulo financiero que reciba el `client` transaccional ya
   abierto.
8. Candidato técnico para resolver `invoiceId` desde una fila AR (a
   evaluar, no una decisión cerrada de implementación automática):

   **Factura individual (per-reservation):**
   ```
   accounts_receivable.financial_transaction_id → invoices.financial_transaction_id → invoices.id
   ```

   **Factura consolidada (C1-Fase C):**
   ```
   accounts_receivable.financial_transaction_id → invoice_charges.financial_transaction_id → invoice_charges.invoice_id
   ```

   Cualquier implementación tiene que probar los dos caminos, no solo uno
   — verificado que son estructuralmente distintos (`sql.invoice.repository.ts:214-215`,
   comentario propio: "solo facturas consolidadas pasan `charges`").

## 5. Decisiones de negocio que el responsable todavía debe tomar

### 5.1 — Filas AR legacy sin `financial_transaction_id`

`accounts_receivable.financial_transaction_id` es nullable — filas creadas
antes de que esa columna existiera (comentario propio en
`accounts-receivable.repository.ts:43`) no tienen forma estructural de
resolver ninguna factura. Opciones, sin resolver:

1. Bloquear el cobro de esas filas hasta reconciliar a mano.
2. Mantener el comportamiento actual (PAYMENT sin vínculo) como fallback
   legacy explícito, documentado como deuda técnica aceptada.
3. Migración/reconciliación de datos previa, antes de habilitar el fix.

Recomendación de esta sesión (no vinculante): 1 o 3 — un fallback silencioso
(opción 2) reproduciría el mismo defecto para un subconjunto de filas.
**Decisión del dueño, no de quien implemente.**

### 5.2 — Alcance del cierre de O2-F2

Definir si se acepta cerrar O2-F2.3/O2-F2.4 como **subentrega técnica**
(el defecto de aplicación/doble cobro corregido, con tests), dejando
O2-F2.1/O2-F2.2 (visibilidad/listado) y O2-F2.5 (frontend) como trabajo
aparte dentro del mismo issue — o si se exige el cierre end-to-end
completo de una sola vez. Afecta directamente el orden de implementación
y qué PR se abre primero.

## 6. Archivos relevantes (leer antes de tocar código)

```
src/clientes-finanzas/accounts-receivable.service.ts       (markCollected() — el defecto)
src/clientes-finanzas/sql.accounts-receivable.repository.ts (doMarkCollected() SQL, atómico y correcto en su propio alcance)
src/clientes-finanzas/accounts-receivable.repository.ts     (entidad AccountReceivable — sin invoiceId, solo invoiceRef/financialTransactionId)
src/facturacion/invoice.service.ts                          (requestConsolidatedInvoice() — cómo nace la factura consolidada, usa AFIP real)
src/facturacion/sql.invoice.repository.ts                   (getOutstandingForUpdate/getOutstandingByCustomerId — fórmula de saldo, ya usa el lock correcto)
src/facturacion/invoice.repository.ts                       (interfaz, docblocks con el razonamiento de O2-F1)
src/clientes-finanzas/customer-account.service.ts            (recordPayment() — la mitad que SÍ funciona, patrón a replicar)
src/clientes-finanzas/sql.financial-transaction.repository.ts (settled_invoice_id, reversed_invoice_id — columnas del vínculo)
src/db/schema.sql                                            (accounts_receivable:2304-2341, invoices:2698-2725, invoice_charges:3154-3166)
src/tests/integration/scratch-o2-f2-ar-invoice-gap.integration.test.ts (reproducción real — ver §7)
```

## 7. Test a promover a regresión permanente

`src/tests/integration/scratch-o2-f2-ar-invoice-gap.integration.test.ts`
(commiteado junto con este documento, en esta misma rama — nombre `scratch-*`
**a propósito sin renombrar todavía**: el diseño de la corrección no está
aprobado, renombrarlo ahora insinuaría una cobertura de regresión que
todavía no existe). Contiene 2 tests contra Postgres real
(`TEST_DATABASE_URL`), ambos verificados pasando en esta sesión:

1. `factura consolidada ISSUED (1000) -- AR FACTURADO -- markCollected() -- el saldo de la factura NO baja`
2. `doble camino: markCollected() + recordPayment(allocations) contra la MISMA factura -- ambos "aplican" el pago completo`

**Cuándo promoverlo:** después de aprobar el diseño (§4/§5), renombrar a
algo como `accounts-receivable-invoice-linkage.integration.test.ts`,
adaptar las aserciones al comportamiento CORREGIDO (saldo SÍ baja, segundo
camino queda capado a 0 en vez de aplicar de nuevo) y sumarlo a la suite
real. Hasta entonces, sirve como reproducción del defecto — no invertir
sus aserciones para "hacerlo pasar en verde" antes de que el fix exista.

## 8. Rama a crear para la implementación

`fix/o2-f2-accounts-receivable-invoice-linkage`, creada desde `main`
**después** de que O2-F1 (`fix/o2-f1-payment-allocation-overapplication`)
se mergee — para no arrastrar una base no mergeada. Si por algún motivo se
implementa antes de ese merge, crearla desde
`fix/o2-f1-payment-allocation-overapplication` en su lugar y dejarlo
anotado en el PR. **No creada todavía por esta sesión.**

## 9. Criterios de aceptación antes de cerrar O2-F2.3/O2-F2.4

**Factura individual:**
```
CHARGE → factura individual → AR FACTURADO → markCollected()
→ PAYMENT vinculado (settledInvoiceId) → saldo de factura 0 → AR COBRADO
```

**Factura consolidada:**
```
N CHARGES → invoice consolidada → N invoice_charges → AR FACTURADO → markCollected()
→ PAYMENT vinculado a invoice → saldo 0 → AR COBRADO
```

**Concurrencia real** (`markCollected() ↔ recordPayment()`, Postgres real,
mismo patrón de dos pools separados que O2-F1):
```
cobro total aplicado <= saldo de la factura
sin PAYMENT duplicado
sin saldo negativo
sin AR e invoice en estados contradictorios (AR=COBRADO con invoice.outstanding > 0 no debería poder pasar más)
```

**Idempotencia** de `markCollected()`:
```
repetir el mismo cobro devuelve el resultado ya existente
no crea un segundo PAYMENT
no re-aplica el importe
no devuelve un error operativo (409) si el primer cobro ya confirmó -- salvo que sea genuinamente inválido
```

**Validación técnica antes de cualquier push** (mismo estándar que O2-F1):
`tsc --noEmit`, `lint`, `lint:arch` limpios; suite unitaria completa;
suite de integración completa contra Postgres real, `--no-file-parallelism`.

## 10. Siguiente paso exacto

1. El responsable de negocio decide §5.1 (AR legacy) y §5.2 (alcance de
   cierre).
2. Con esas dos decisiones, aprobar o ajustar el diseño de §4.
3. Crear la rama de §8.
4. Implementar: resolución de `invoiceId` (individual + consolidada) →
   extraer la primitiva financiera compartida → lock + capado + excedente
   → idempotencia de `markCollected()`.
5. Promover el test de §7 a regresión permanente, adaptado al
   comportamiento corregido.
6. Sumar tests unitarios, de integración Postgres real y de concurrencia
   real (§9).
7. Validar (tsc/lint/lint:arch/unit/integration) antes de cualquier push.
8. Verificar frontend cuando exista repositorio adjunto.
9. Documentar el cierre definitivo, mismo formato que este documento.

---

## No hacer (heredado de esta sesión, sigue vigente)

- No tocar O2-F1 ni `main`.
- No usar `invoice_ref` como vínculo estructural.
- No crear un `PAYMENT` huérfano como fallback silencioso para "tapar" el
  saldo.
- No cerrar O2-F2 corrigiendo solo el listado (F2.1/F2.2) sin resolver la
  aplicación (F2.3).
- No cerrar O2-F2 corrigiendo solo la aplicación (F2.3) sin que quede
  explícitamente registrado qué de F2.1/F2.2/F2.5 sigue abierto (según lo
  que decida §5.2).
- No eliminar ni reescribir el test de §7 sin conservar antes su
  reproducción original (esta versión queda en el historial de git desde
  este commit, eso ya lo resuelve).
- No commitear, pushear ni abrir PR de la implementación sin autorización
  explícita del responsable — este documento es evidencia y diseño, no
  autorización para implementar.
- No declarar frontend verificado sin repositorio adjunto.

## Estado formal de transferencia

```
Orders:                            CERRADO
O2-F1:                             CERRADA — backend y persistencia
O2-F2 Discovery/Due Diligence:     CERRADA (este documento)
O2-F2 Diseño funcional:            PRESENTADO — pendiente de decisiones §5.1/§5.2
O2-F2 Implementación:              PENDIENTE
O2-F2 Frontend:                    NO VERIFICABLE — repositorio no disponible
O2 completo:                       ABIERTO
Test diagnóstico:                  CONSERVADO EN GIT (esta rama, commiteado con este documento)
Rama de este checkpoint:           docs/o2-f2-checkpoint-2026-09-03
Rama de implementación futura:     fix/o2-f2-accounts-receivable-invoice-linkage (no creada)
Siguiente responsable:             decidir §5.1 y §5.2 → aprobar diseño → crear rama → implementar
```
