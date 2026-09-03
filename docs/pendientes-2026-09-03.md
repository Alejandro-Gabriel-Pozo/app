# Pendientes — Jueves 3 de Septiembre 2026

Arrastra lo que seguía abierto en `pendientes-2026-09-02.md`. Los ítems cerrados
quedan allá marcados, no se repiten acá.

**Alcance de esta sesión:** higiene documental y preservación de evidencia,
autorizadas explícitamente por el dueño. **No se tocó código, schema, frontend,
O5, ORDER-15 funcional, O1-b funcional, Caja, Refund, Gap C1-C ni
`TRANSICION_SERVIR`.** Sin `git add -A`: staging por ruta explícita. Sin commit
ni push hasta que el dueño revise el diff documental.

**Disciplina de evidencia**, igual que los archivos anteriores: `[V]` verificado
contra el árbol real de `origin/main` en esta sesión; `[P]` decisión propuesta,
no final; `[H]` hipótesis sin verificar.

---

## Contexto de sesión (03/09/2026)

| Evento | Qué |
|---|---|
| Reconciliación del handoff | `Handoff_para_agente_nuevo___Order_Lifecycle_Integrity_v1.md` (documento externo, no versionado) describía el árbol hasta `843a9ad`. **Quedó superado por `origin/main = e794fd3`** — ver abajo |
| Estado de Git `[V]` | El handoff (documento externo, no versionado) describe un **estado histórico** del árbol, hasta `843a9ad` — no el estado actual. **Al redactar esta fila (previo al fast-forward):** `HEAD = 843a9ad`, **10 commits por detrás de `origin/main = e794fd3`, 0 por delante**; el `pull` sería **fast-forward puro**. **Estado actual `[V]`:** fast-forward ejecutado; `HEAD` local = `e8c550b` (este documento) **+** `1002e04` (ORDER-16 — auditoría del sello `served_at`), **2 commits por delante de `origin/main = e794fd3`, 0 por detrás, sin push**. Cadena propia, sin merges ajenos. |
| Preservación de evidencia | El untracked `src/tests/integration/outbox-worker.integration.test.ts` (el archivo del handoff) se **copió** fuera del repositorio, sin borrarlo, sin mezclarlo y sin reemplazarlo. Manifiesto con hashes y comparación de cobertura en el scratchpad de la sesión |
| Hallazgo de higiene `[V]` | Ese archivo es el **único** de los siete untracked que colisiona con el fast-forward. Los otros seis no |

### El handoff quedó superado — registro explícito

`[V]` La cadena que el handoff daba por última (`… → 843a9ad`) tiene diez commits
más en `origin/main`: `ebf1053` (diagnóstico de Servir, PR #41), `fb0d08a`
(schema v46, PR #42), `c3e12ca` (continuidad y cierre, PR #43), `627e6fd` (O4
contra Postgres real, PR #44), `27ef985` (reconciliación de §3, PR #45), más los
cinco merge commits. Tres secciones del handoff dejan de ser estado actual: la
"próxima tarea inmediata" (ya ejecutada), el "hallazgo prioritario Servir" (ya
cerrado) y "O4 preparado pero no commiteado" (ya commiteado, con otro archivo).

**El handoff no se borra ni se archiva como falso:** sigue siendo la única fuente
escrita de tres hallazgos que nunca llegaron a ningún `pendientes-*.md` — que es
justamente por lo que existen las tres primeras filas de la sección siguiente.

---

## 🔴 Abierto — registrado por primera vez (03/09/2026)

Los tres primeros ítems **existían sólo en el handoff**, un documento externo sin
versionar. Verificado con `grep` sobre `docs/` completo en `origin/main`: ninguno
aparece en ningún archivo del repositorio. Es el modo de falla que `CLAUDE.md`
documenta como incidente del 25/08 — lo que no llega a `pendientes-*.md`
desaparece del radar sin que nadie lo haya decidido.

### EVT-ID-01 — el identificador de un evento no tiene el tipo que el código declara

| Dimensión | |
|---|---|
| **Definición** | `DomainEvent.id` está declarado `number`, pero la columna es `BIGSERIAL` y el driver `pg`, sin type parser registrado, la entrega como **string** en runtime. El tipo declarado y el valor real no coinciden |
| **Consecuencia** | Hoy **ninguna visible**: todos los consumos son parámetros de query (donde Postgres coacciona) o campos de log. El riesgo es futuro y silencioso — la primera comparación con `===`, la primera aritmética o el primer uso como clave de `Map` va a fallar sin error, no con una excepción |
| **Severidad** | **S3.** No hay defecto de comportamiento observable hoy; es una mentira de tipo que anula la garantía que el `tsc` aparenta dar en ese punto |
| **Evidencia** | `[V]` `src/repositories/domain-event.repository.ts:5` declara `id?: number`. `src/repositories/sql.domain-event.repository.ts:36` mapea `id: row.id` **sin coerción**. `markDispatched` (`:108`), `recordFailure` (`:122`) y `retryDeadLettered` (`:156`) lo reciben tipado `number`. El propio archivo de O4 en `origin/main` lo documenta en su cabecera (`src/tests/integration/outbox-worker.integration.test.ts:66-77`) y define un helper `numId()` para **no quedar acoplado al defecto** en vez de arreglarlo |
| **Dependencia** | Ninguna bloqueante. Relacionada con O4 (la suite ya convive con esto). El handoff lo marcó explícitamente "no tocar sin autorización" |
| **Criterio de cierre** | Decidir la forma correcta —`string` en el tipo, o un type parser registrado para `int8`— y aplicarla en un bloque propio, con verificación de que ningún consumidor actual dependía de la coerción implícita. **Cambiar el tipo sin revisar consumidores es la forma de romperlo de verdad** |
| **Siguiente acción** | Ninguna funcional. Queda registrado y esperando priorización |

### ORDER-15 — anular y liquidar no coinciden en qué tipo de movimiento alcanzan

| Dimensión | |
|---|---|
| **Definición** | La liquidación por orden alcanza sólo `CHARGE`; la anulación por orden alcanza `CHARGE` **y** `ADJUSTMENT`. Los dos caminos que deberían ser simétricos tratan distinto al mismo movimiento |
| **Consecuencia** | Un ajuste sobre una orden se puede anular pero nunca se liquida: queda `PENDING` para siempre, sin que ningún camino lo cierre y sin señal de que quedó colgado |
| **Severidad** | **S3 hoy, revisable.** Depende de una pregunta de negocio todavía sin responder: si los ajustes sobre órdenes son un concepto real de este ERP. Si lo son, sube |
| **Evidencia** | `[V]` `src/clientes-finanzas/sql.financial-transaction.repository.ts:401` (`AND ft.type IN ('CHARGE')`, en `settleChargesByOrderId`) contra `:575` (`AND ft.type IN ('CHARGE','ADJUSTMENT')`, en `voidByOrderId`). La asimetría **ya está declarada en el código** en `:552-555`, con la aclaración de que queda declarada y no resuelta a propósito |
| **Dependencia** | Bloqueado por una decisión de producto, no por código: ¿existen ajustes sobre órdenes? Cruza con ORDER-09 (un `PAYMENT` pendiente de la orden) — misma familia de "qué tipos alcanza cada camino", distinto síntoma |
| **Criterio de cierre** | Respuesta del dueño a la pregunta de negocio; después, alinear los dos filtros en el mismo sentido y probar contra PostgreSQL real que un `ADJUSTMENT` de orden termina en un estado terminal por los dos caminos, no sólo por uno |
| **Siguiente acción** | Plantearle la pregunta al dueño. **No tocar el filtro** hasta tener la respuesta |

### O1-b — los reportes no distinguen "no consta" de "cero"

| Dimensión | |
|---|---|
| **Definición** | Los reportes de POS y CRM filtran por `confirmed_at`. Esa columna estuvo en `NULL` para todas las órdenes anteriores al sellado que introdujo O1 (`d7bb254`), y no se puede rellenar con una fuente confiable. Hoy esas órdenes salen del filtro sin que el reporte lo diga |
| **Consecuencia** | Un período previo a O1 se muestra como **cero ventas**, indistinguible de un período en el que realmente no se vendió nada. El reporte no miente en el dato: miente en el silencio |
| **Severidad** | **S2.** Es un dato de gestión que se lee como hecho y no lo es |
| **Evidencia** | `[V]` `src/pos-menu/sql.order.repository.ts:557`, `:586`, `:618` y `src/clientes-finanzas/sql.customer.repository.ts:394` filtran por `confirmed_at`. **Las anclas se movieron respecto de `pendientes-2026-09-02.md`** (allá figuran como `:520`, `:549`, `:581`): O1 desplazó las líneas. Las de este archivo son las verificadas hoy |
| **Dependencia** | Es la contracara de **ORDER-14**, que sí está registrado. ORDER-14 cerró el sellado hacia adelante (entró en O1); O1-b es qué hacer con lo de atrás. **Sin backfill inventado** — decisión ya tomada por el dueño el 02/09 |
| **Criterio de cierre** | Que cada reporte declare el corte: distinguir explícitamente "sin datos anteriores a la fecha del sellado" de "cero en el período". Es cambio de presentación y de contrato de lectura, no de datos |
| **Siguiente acción** | Ninguna todavía. Diseño pendiente, sin autorización |

### ORDER-16 — servir una orden no deja ningún rastro de quién lo hizo · ✅ RESUELTO (03/09/2026)

**Cerrada.** El dueño respondió la pregunta de negocio (opción **b**: Servir es
auditable). **D1 = sí, solo `audit_log`, SIN domain event; D9 = solo `CONFIRMED`**
(`COMPLETED`/`CANCELLED` → 409 `ORDER_NOT_SERVABLE`). Fix en **`1002e04`**
(`fix(pos-menu): ORDER-16 -- Servir deja rastro de quien lo hizo (A6.5)`),
pusheado a `origin/main` (`e794fd3..b05d964`, fast-forward) y desplegado por
Render auto-deploy. Sin DDL, sin migración, sin bump de `CURRENT_SCHEMA_VERSION`.
Gate: `architecture-governor` APROBADO CON CONDICIONES (C1–C4) + criterios
A6.5/A6.1/A6.3/A6.6/A9.4/R8. Tests: E-U1..E-U5 (unit) + E-I1..E-I6 (integración
Postgres real, incl. rollback por fallo del repo de auditoría y por actor
ausente). `[V]` **Verificado en vivo** contra `biz-demo-01` (Neon
`ancient-king-17098519`, branch `production`), orden
`bf8b235d-90c0-4fd2-ac43-4eb9d02c6213`: `served_at = 2026-09-03T17:31:41.581Z`,
**1** fila `audit_log` `field='served_at'`, `old_value=NULL`, `new_value` = sello
exacto, `changed_by='ident-454141dab8fba2c55bc2d81247a629a4'` (actor real); cero
deltas por Servir (`order_items=1`, `financial_transactions=1`, `domain_events=2`
—`order.confirmed`+`order.completed`, ninguno de serve—, `dead_letter=0`).

**Sigue abierto (fuera del alcance de este fix):** **D6** (des-servir), **D7**
(retención → `A7.6`), **D8** (mostrar `servedAt` + actor en el detalle de la
orden — frontend), y **`O5`** (gestión operativa durable de incidentes).

La fila de abajo se conserva como registro del estado previo al cierre.

| Dimensión | |
|---|---|
| **Definición** | `markServed()` sella `served_at` pero no emite evento de dominio ni graba fila en `audit_log`. Es la única transición del ciclo de vida de una orden sin rastro fuera de la columna misma. Tampoco recibe actor: su firma no tiene `changedBy`, y la ruta no le pasa el usuario |
| **Consecuencia** | Servir es **irreversible** —no existe des-servir— y decide si cancelar restaura el stock. Un "Servir" apretado sobre la orden equivocada le quita para siempre a esa orden la restitución de inventario al cancelarse, y **no hay forma de saber quién lo hizo**: ni en la base, ni en un log, ni en pantalla |
| **Severidad** | **S2.** No corrompe datos ni pierde plata por sí solo; deja sin reconstruir un acto irreversible con efecto patrimonial. Misma clase que `BRECHA-AUDIT-01` |
| **Evidencia** | `[V]` `src/pos-menu/order.service.ts:747` (`markServed(id: string)`, sin `changedBy`; el docblock `:741-746` declara explícito que no emite evento). `src/pos-menu/orders.routes.ts:209` no pasa `req.user!.id`, a diferencia de `:190` para confirmar. El efecto sobre inventario: `order.service.ts:720` (`wasServed`) → `src/workers/inventory.handlers.ts:287` (`if (wasServed) continue`). No existe reversa: la allowlist completa está en `src/pos-menu/order.repository.ts:82-98`. Confirmado además contra las dos bases reales el 03/09 — cada orden tiene exactamente 2 filas de `audit_log`, ninguna para el sello de `servedAt` |
| **Dependencia** | `audit_log` **ya tiene la forma necesaria** (`src/db/schema.sql:2378`, una fila por campo): la variante con auditoría no requiere DDL, ni migración, ni bump de `CURRENT_SCHEMA_VERSION`. Cruza con `AUDIT-ORD-01` (misma familia de atribución) y con `A7.6` (no existe política de retención escrita para `audit_log` ni `domain_events` — verificado por grep, sin purga en ningún punto del repo) |
| **Criterio de cierre** | Que todo sellado de `served_at` posterior al bloque tenga exactamente una fila de auditoría con actor real, en la misma transacción que el sello, sin efectos nuevos sobre stock, cargos ni eventos; y que servir dos veces siga dejando una sola fila. Las órdenes servidas antes se leen como "no consta", nunca como "no se sirvió" |
| **Siguiente acción** | ~~**Decisión del dueño.** Sin diff hasta entonces~~ → **HECHO.** Fix `1002e04`, desplegado y verificado en vivo. |

#### ORDER-16 · decisiones — estado al cierre (03/09/2026)

Las `[P]` de la sesión se elevaron a decisión del dueño y se implementaron en
`1002e04`, salvo D6/D7/D8 que quedan fuera de alcance.

| # | Decisión | Estado |
|---|---|---|
| D1 | ¿Servir se audita? ¿Con evento propio, sólo `audit_log`, o nada? | **RESUELTA:** sólo `audit_log`, SIN domain event. Aplicada. |
| D2 | Forma de la fila: `field='served_at'` o un `status` sintético | **RESUELTA:** `field='served_at'`, `old_value=NULL`, `new_value` = sello ISO-8601. Aplicada. |
| D3 | Actor: `changedBy` real desde la ruta, o `SYSTEM_ACTOR` | **RESUELTA:** actor real (`req.user!.id`). Aplicada — verificado en vivo (`ident-454141…`). |
| D4 | Atomicidad con el sello | **RESUELTA:** misma transacción (`transactionManager.run`). Rollback probado en E-I5/E-I6. |
| D5 | ¿La rama idempotente (servir dos veces) audita? | **RESUELTA:** no. El INSERT vive sólo en la rama `CAMBIO`; `YA_ESTABA` es 200 idempotente sin fila. |
| D6 | Reversibilidad: ¿se agrega un "des-servir"? | **Abierta, fuera de alcance.** `[P]` no en este bloque: cambia `wasServed` y la restitución de stock — diseño de inventario propio. |
| D7 | Retención de esas filas | **Abierta, fuera de alcance.** Remite a `A7.6`: sin política global ni volumen medido. Este fix suma ~1 fila por orden servida. |
| D8 | Visibilidad: mostrar `servedAt` y su actor en el detalle de la orden | **Abierta, fuera de alcance.** `[V]` hoy el detalle no muestra `servedAt` (`appfrontend-main`, `src/app/dashboard/ordenes/[id]/page.tsx:385-400`). Bloque de frontend separado. |
| **D9** | **¿Servir admite una orden `COMPLETED`, o sólo `CONFIRMED`?** | **RESUELTA:** sólo `CONFIRMED`. `COMPLETED`/`CANCELLED` → 409 `ORDER_NOT_SERVABLE`. `TRANSICION_SERVIR` sin tocar; fijada con tests (E-I2/E-I3, E-U2/E-U3). |

**Por qué D9 no es cosmética `[V]`:** hoy backend y frontend coinciden en admitir
sólo `CONFIRMED` —`TRANSICION_SERVIR` declara `desde: ['CONFIRMED']`
(`src/pos-menu/order.repository.ts:96-98`) y el panel sólo muestra el botón con
`status === 'CONFIRMED' && !servedAt` (`appfrontend-main`,
`src/app/dashboard/ordenes/page.tsx:301-308`)— pero **coinciden por omisión, no
por una decisión registrada**. `wasServed` decide si cancelar restaura stock:
admitir `COMPLETED` abriría un camino para cambiar retroactivamente esa respuesta
sobre una orden ya cobrada. Si el dueño decide (a), la fila de auditoría de
ORDER-16 ancla la decisión con evidencia; si decide (b), ORDER-16 deja de ser
opcional y pasa a ser precondición.

**Brecha de trazabilidad — ~~declarada y no resuelta~~ CERRADA (03/09/2026):**
D1 se resolvió por (b) y se implementó en `1002e04`. Todo sellado de `served_at`
posterior al deploy deja exactamente una fila de `audit_log` con actor real, en
la misma transacción que el sello (verificado en vivo, orden `bf8b235d`). Las
órdenes servidas antes del fix conservan `served_at` con valor y **cero** filas
de auditoría — se leen como "no consta quién", nunca como "no se sirvió". Sin
backfill.

---

## ✅ Cerrado — verificado en esta sesión

### H1 / schema v46 — servir dejó de fallar en producción · ✅ RESUELTO (03/09/2026)

`[V]` **Consecuencia que se cerró:** marcar una orden como servida devolvía error
de servidor en producción y el dato nunca se guardaba.

Causa raíz: las cuatro columnas de sello (`confirmed_at`, `cancelled_at`,
`completed_at`, `served_at`) estaban declaradas sólo dentro del
`CREATE TABLE IF NOT EXISTS orders` — un no-op sobre una base donde la tabla ya
existía. `served_at` nunca se creó en `biz-demo-01`, y el `UPDATE` respondía
`42703`, que no es `DomainError` y caía al 500 genérico.

Corregido por **schema v46** (`fb0d08a`, PR #42, merge `bb0161f`): cuatro
`ALTER TABLE … ADD COLUMN IF NOT EXISTS` idempotentes, **sin backfill a
propósito** (`NULL` = "no consta", no "no se sirvió"). Desplegado
(`dep-dacoej67bikc73fcmnqg`, `live`) y verificado contra los dos tenants: v46 en
`schema_migrations`, 14 columnas en `orders`, la orden histórica intacta.
Prueba end-to-end en producción hecha por el titular sobre la orden
`4774b63a-…`: creada → confirmada → **servida** → completada.

**Nota de método:** la "regla de decisión" del handoff enumeraba cuatro causas
posibles (regla de estado, allowlist, repositorio, feedback de UI). **Ninguna era
la causa**: fue drift de schema. La lista estaba bien construida hacia adentro
del código y ciega hacia el estado real de la base. Vale como aprendizaje, no
como reproche.

**Lo que este cierre NO cierra:** el "defecto de feedback" que el handoff
mencionaba en cuarto lugar sigue abierto — ver D8 de ORDER-16.

### ORDER-11 — el alta de órdenes desde el panel · ✅ RESUELTO (`9a08417`, frontend)

`[V]` Figuraba como abierto en `pendientes-2026-09-02.md` y ya estaba resuelto en
`appfrontend-main` (`9a08417`, "hacer recorrible el alta de órdenes"): el panel
dejó de mandar el precio que el backend rechaza y el total pasó a mostrarse como
estimado. La fila quedó sin marcar en el archivo del 02/09; se cierra acá.

### O4 — cobertura técnica del outbox contra PostgreSQL real · ✅ CERRADO EN SU ALCANCE

`[V]` Verificado por conteo, **sin reabrir el veredicto**: 19 tests en
`src/tests/integration/outbox-worker.integration.test.ts` (`origin/main`), 9 de
ellos en `describe('SqlDomainEventRepository — mecánica real')`. Coincide con lo
declarado en `continuidad-order-lifecycle-integrity-v1-2026-09-03.md` §3.

**Lo que O4 no es, y conviene no confundir:** O4 prueba que el mecanismo hace lo
que dice. **O5** —gestión operativa durable de incidentes— sigue **abierto, sin
diseño ni diff**, y no se tocó.

**Hueco de cobertura detectado al comparar con el archivo preservado `[V]`:** dos
ramas de `dispatch()` tienen cobertura **sólo unitaria**, sin equivalente contra
Postgres real — un evento sin ningún handler registrado, y un evento con una
versión sin handler (A10.4). El archivo untracked que se preservó sí las cubría
(sus tests `O4-03` y `O4-11`). **No se portaron**: sería código de test, fuera de
la autorización de higiene documental de esta sesión.

---

## Continuación — circuito O2 (Order-to-Cash financiero), sesión posterior (03/09/2026)

Sesión distinta a la de higiene documental de arriba — Orders ya estaba cerrado
(H1/v46, ORDER-16), y esta sesión se autodirigió al circuito **O2**. Sí tocó
código: `src/facturacion/invoice.repository.ts`,
`src/facturacion/sql.invoice.repository.ts`,
`src/clientes-finanzas/customer-account.service.ts`, tests y
`docs/diseno-truncamiento-pagos-o2-f1-2026-09-03.md`. **No tocó** Caja,
Facturación AFIP, Refund/C2, ni `O1-b`/`ORDER-15`/A7.6 de la sección de arriba.

### O2-F1 — sobreaplicación de pagos (`recordPayment` con `allocations`) · ✅ CERRADO — BACKEND Y PERSISTENCIA (03/09/2026)

`[V]` **Consecuencia que se cerró:** `CustomerAccountService.recordPayment()`
con `allocations` aplicaba el monto pedido contra una factura sin verificar su
saldo real — podía sobre-aplicar (incluso con dos pagos concurrentes contra la
misma factura, sin ningún lock).

Decisión del dueño (opción B, truncamiento controlado): cada allocation se
aplica como máximo hasta el saldo vigente (releído con `SELECT ... FOR UPDATE
OF i` dentro de la misma transacción — nuevo
`InvoiceRepository.getOutstandingForUpdate()`); el excedente se preserva
siempre, en una única fila `PAYMENT` sin asociar, nunca se pierde ni se
rechaza el pago completo; `outstanding` nunca queda negativo. También
consolida allocations duplicadas a la misma factura y cierra un gap de
idempotencia que esa rama tenía desde I4 (no miraba el retorno `null` de
`createWithClient()` en un reintento).

**Evidencia:** `[V]` commit `a2aaf40` en la rama
`fix/o2-f1-payment-allocation-overapplication` — **NO mergeada a
`origin/main`, sin PR abierto todavía**. `tsc --noEmit`, `lint`, `lint:arch`
limpios. 1792 tests unitarios (20 en
`customer-account.service.test.ts`, 6 nuevos para O2-F1) + 107 de integración
contra Postgres real (13 archivos, 4 nuevos en
`src/tests/integration/customer-account-payment.integration.test.ts`,
incluida concurrencia real: dos `recordPayment()` simultáneos, dos pools
separados, contra una factura de 1000 pagando 600 cada uno → aplicado total
exactamente 1000, excedente exactamente 200, saldo final 0). Diseño en
`docs/diseno-truncamiento-pagos-o2-f1-2026-09-03.md`.

**Por qué "backend y persistencia" y no "end-to-end":** no hay repositorio de
frontend adjunto a esta sesión — no se puede verificar que la UI muestre
recibido/aplicado/sin-asignar/saldo a favor. El contrato de
`POST /:id/payments` (array de `FinancialTransaction[]`, `amount` +
`settledInvoiceId` por fila) parece suficiente para que el frontend arme esa
vista sin cambios de contrato — pero eso es una hipótesis de compatibilidad,
no una verificación frontend. **No cerrar como end-to-end hasta esa
verificación.**

**Siguiente acción:** ninguna de código. Rama lista para PR — pendiente de
que el dueño autorice abrirlo/mergearlo.

### O2-F2 — facturas consolidadas y cobro corporativo · Discovery CERRADA (03/09/2026)

**Actualizado tras una segunda auditoría independiente (mismo día) y reproducción
real contra Postgres.** Ya no es solo un hallazgo de visibilidad — se confirmó
un camino de **doble cobro real** en `AccountsReceivableService.markCollected()`.
Detalle completo, evidencia, matriz de relaciones, diseño propuesto y
decisiones pendientes: **`docs/continuidad-o2-f2-facturas-consolidadas-2026-09-03.md`**
(checkpoint transferible, rama `docs/o2-f2-checkpoint-2026-09-03`). Acá solo
el resumen — no dupliques el detalle, andá al checkpoint.

| Dimensión | |
|---|---|
| **Definición** | Dos causas relacionadas pero distintas: (1) `getOutstandingByCustomerId()` excluye facturas consolidadas del listado por el `JOIN` (visibilidad); (2) `AccountsReceivableService.markCollected()` (`accounts-receivable.service.ts:195-225`) crea un `PAYMENT` sin `settledInvoiceId` — el saldo de la factura nunca refleja un cobro hecho por el camino de `accounts_receivable` |
| **Consecuencia** | **Elevada de S2 a severidad alta/crítica** tras reproducción: una factura consolidada cobrada vía `markCollected()` sigue viéndose con saldo completo, y si alguien la concilia también por `recordPayment(allocations)` (camino ya corregido por O2-F1), el sistema acepta un segundo cobro real — confirmado con Postgres real: factura de 1000, total cobrado 2000 |
| **Severidad** | S1 para el subhallazgo de aplicación (O2-F2.3) — riesgo de doble cobro real en cualquier tenant con City Ledger corporativo activo. S2 para visibilidad pura (O2-F2.1/.2) |
| **Evidencia** | `[V]` Reproducción real en `src/tests/integration/scratch-o2-f2-ar-invoice-gap.integration.test.ts` (2 tests, Postgres real, commiteado en `docs/o2-f2-checkpoint-2026-09-03`). Código: `accounts-receivable.service.ts:203-212` (PAYMENT sin settledInvoiceId), `accounts-receivable.repository.ts:36` (`invoiceRef` es string de display, no FK), `sql.invoice.repository.ts:97-128` (`getOutstandingForUpdate` calcula por id directo, sin saber del cobro de AR) |
| **Dependencia** | Ninguna bloqueante de O2-F1 (cerrada, sin reabrir). Cruza con C1-Fase C (consolidadas) y con el cierre de `accounts_receivable` |
| **Criterio de cierre** | Ver §9 del checkpoint — resolución de `invoiceId` desde AR (individual y consolidada), lock compartido con `recordPayment()`, idempotencia, tests de concurrencia real |
| **Siguiente acción** | Decisión de negocio pendiente (§5 del checkpoint: filas AR legacy sin `financial_transaction_id`, alcance del cierre) antes de crear la rama de implementación `fix/o2-f2-accounts-receivable-invoice-linkage` |

### Estado formal de O2 (03/09/2026, actualizado)

| Ítem | Estado |
|---|---|
| O2-F1 | **CERRADA** — backend, datos e integración (Postgres real, incl. concurrencia). No mergeada a `main` todavía |
| O2-F2 Discovery/Due Diligence | **CERRADA** — ver checkpoint dedicado |
| O2-F2 Implementación | **PENDIENTE** — bloqueada por dos decisiones de negocio (§5 del checkpoint) |
| Frontend O2 | **NO VERIFICABLE** en esta sesión — repositorio de frontend no disponible |
| O2 completo | **ABIERTO** |

---

## 🔴 Arrastrado de `pendientes-2026-09-02.md`

**Sin re-verificar en esta sesión, salvo donde se indica.** Su estado se conserva
porque nadie lo cerró, no porque se haya vuelto a comprobar. No leer esta lista
como auditada de nuevo.

- **Familia ORDER-\*** — ORDER-05, ORDER-06, ORDER-07, ORDER-09, ORDER-10 y
  ORDER-13 siguen abiertos. **ORDER-03-b no está cerrado.** ORDER-14 cerró el
  sellado hacia adelante en O1; el rescate de lo histórico es **O1-b**, arriba.
- **INV-ORF-01** — reservas de stock que ningún camino libera.
- **EVT-ORF-01** — `reservation.expired` se emite y ningún handler lo escucha.
  **Cruza con D1 de ORDER-16**: es el precedente que desaconseja crear un
  `order.served` sin consumidor.
- **CAJA-ORD-01**, **AUDIT-ORD-01**, **ORDER-12**.
- **Seguridad / aislamiento:** FACT-INV-BIZID-001 (S1 candidata, sube a S0 si se
  demuestra exposición cross-tenant), SEC-ROT-001, RBAC-OWN-001, RBAC-SYNC-001,
  RBAC-MOUNT-001, FAILOPEN-001.
- **Documentales:** AUDIT-DOC-001, DA-CONT-001, DOC-ANCLA-001, CONTRACT-001,
  "RBAC mecanismos 1 y 2" (sigue sin referente, esperando al dueño).
- **Backlog de producto:** Gap C1-C, FISCAL-CBTE-001, FACT-BORRADOR-001,
  C1-Fase A, C2, C3, D7, frontend visual (SEM-001, SEM-002, TOAST-003, A11Y-001,
  overlays de Superadmin), heredados (Redis rate-limit, BullMQ, etapas 2-3 de
  downgrade, datos demo en la base real).
- **A7.6 — política de retención escrita:** `[V]` **re-verificado hoy**, sigue
  abierto. No hay purga ni política para `audit_log` ni `domain_events` en ningún
  punto del repositorio (grep completo sobre `src/`). Es la dependencia de D7 de
  ORDER-16.

---

## Higiene pendiente — estado

**Actualizado 03/09/2026:** los puntos 1 y 2 ya se ejecutaron. El fast-forward
a `e794fd3` se hizo; este archivo se commiteó **después**, en `e8c550b`; y
`1002e04` (ORDER-16) se apoya encima. El punto 3 sigue abierto.

1. ✅ **El fast-forward a `e794fd3`.** `[V]` Fue fast-forward puro. El único
   untracked que lo bloqueaba —`src/tests/integration/outbox-worker.integration.test.ts`—
   se preservó fuera del repositorio (hashes y comparación de cobertura) y en
   `origin/main` ya vive una versión propia (PR #44). Resuelto.
2. ✅ **Este archivo, commiteado después del fast-forward, no antes** (`e8c550b`).
   Commitear antes habría convertido un fast-forward limpio en un merge
   innecesario. Hecho en ese orden.
3. **Portar `O4-03` y `O4-11`** al archivo de `origin/main` — bloque de código de
   test, con su propia autorización. **Sigue abierto.**

---

## Nota de método

Este archivo **no volvió a auditar** los ítems arrastrados: los declara
arrastrados y lo dice. Lo que sí se verificó de punta a punta en esta sesión es
lo que aparece con `[V]` y ancla — el estado de Git, las cuatro filas nuevas, los
dos cierres, y el hueco de cobertura de O4. Las anclas de O1-b se re-verificaron
porque O1 había desplazado las líneas que citaba el archivo del 02/09; las del
resto no se tocaron.
