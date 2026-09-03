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
| Estado de Git `[V]` | `HEAD = 843a9ad`, `origin/main = e794fd3` (confirmado con `git ls-remote`), **10 commits por detrás, 0 por delante**. `git merge-base --is-ancestor` confirma que el `pull` sería **fast-forward puro**, sin merge |
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

### ORDER-16 — servir una orden no deja ningún rastro de quién lo hizo

| Dimensión | |
|---|---|
| **Definición** | `markServed()` sella `served_at` pero no emite evento de dominio ni graba fila en `audit_log`. Es la única transición del ciclo de vida de una orden sin rastro fuera de la columna misma. Tampoco recibe actor: su firma no tiene `changedBy`, y la ruta no le pasa el usuario |
| **Consecuencia** | Servir es **irreversible** —no existe des-servir— y decide si cancelar restaura el stock. Un "Servir" apretado sobre la orden equivocada le quita para siempre a esa orden la restitución de inventario al cancelarse, y **no hay forma de saber quién lo hizo**: ni en la base, ni en un log, ni en pantalla |
| **Severidad** | **S2.** No corrompe datos ni pierde plata por sí solo; deja sin reconstruir un acto irreversible con efecto patrimonial. Misma clase que `BRECHA-AUDIT-01` |
| **Evidencia** | `[V]` `src/pos-menu/order.service.ts:747` (`markServed(id: string)`, sin `changedBy`; el docblock `:741-746` declara explícito que no emite evento). `src/pos-menu/orders.routes.ts:209` no pasa `req.user!.id`, a diferencia de `:190` para confirmar. El efecto sobre inventario: `order.service.ts:720` (`wasServed`) → `src/workers/inventory.handlers.ts:287` (`if (wasServed) continue`). No existe reversa: la allowlist completa está en `src/pos-menu/order.repository.ts:82-98`. Confirmado además contra las dos bases reales el 03/09 — cada orden tiene exactamente 2 filas de `audit_log`, ninguna para el sello de `servedAt` |
| **Dependencia** | `audit_log` **ya tiene la forma necesaria** (`src/db/schema.sql:2378`, una fila por campo): la variante con auditoría no requiere DDL, ni migración, ni bump de `CURRENT_SCHEMA_VERSION`. Cruza con `AUDIT-ORD-01` (misma familia de atribución) y con `A7.6` (no existe política de retención escrita para `audit_log` ni `domain_events` — verificado por grep, sin purga en ningún punto del repo) |
| **Criterio de cierre** | Que todo sellado de `served_at` posterior al bloque tenga exactamente una fila de auditoría con actor real, en la misma transacción que el sello, sin efectos nuevos sobre stock, cargos ni eventos; y que servir dos veces siga dejando una sola fila. Las órdenes servidas antes se leen como "no consta", nunca como "no se sirvió" |
| **Siguiente acción** | **Decisión del dueño.** Sin diff hasta entonces |

#### ORDER-16 · decisiones abiertas

**Ninguna de estas es final.** Se registran para que la decisión quede trazada
cuando se tome, no para darla por tomada.

| # | Decisión | Estado |
|---|---|---|
| D1 | ¿Servir se audita? ¿Con evento propio, sólo `audit_log`, o nada? | Abierta. `[P]` sólo `audit_log`, sin evento: no hay ningún consumidor para un `order.served`, y agregarlo sería un segundo caso deliberado de `EVT-ORF-01` (evento emitido que nadie escucha) |
| D2 | Forma de la fila: `field='served_at'` o un `status` sintético | Abierta. `[P]` `field='served_at'` — el `status` no cambió, y escribir que sí sería falsear la tabla que existe para no falsear |
| D3 | Actor: `changedBy` real desde la ruta, o `SYSTEM_ACTOR` | Abierta. `[P]` actor real: sin él la fila no responde la única pregunta que justifica escribirla |
| D4 | Atomicidad con el sello | Abierta. `[P]` misma transacción, patrón ya establecido en `docs/conocimiento/playbook-audit-log-transaccional.md` |
| D5 | ¿La rama idempotente (servir dos veces) audita? | Abierta. `[P]` no — convertiría el doble-submit del panel en ruido permanente |
| D6 | Reversibilidad: ¿se agrega un "des-servir"? | Abierta. `[P]` no en este bloque: cambia `wasServed` y por lo tanto si el stock se restaura — es decisión de inventario, con su propio diseño |
| D7 | Retención de esas filas | Abierta. `[P]` remitir a `A7.6`, declarándolo: no hay política global ni volumen medido, y fijar un número sin eso es inventarlo |
| D8 | Visibilidad: mostrar `servedAt` y su actor en el detalle de la orden | Abierta. `[P]` sí, en bloque de frontend separado. `[V]` hoy el detalle muestra confirmado/completado/cancelado y **no** `servedAt` (`appfrontend-main`, `src/app/dashboard/ordenes/[id]/page.tsx:385-400`) |
| **D9** | **¿Servir admite una orden `COMPLETED`, o sólo `CONFIRMED`?** | **Abierta.** Es la 8ª pregunta del handoff, la única de las ocho **sin responder**. `[P]` **mantener sólo `CONFIRMED`** — pero es una propuesta, **no una decisión final**, y no se implementa nada hasta que el dueño resuelva |

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

**Brecha de trazabilidad, declarada y no resuelta:** mientras D1 siga abierta, la
ausencia de evento y auditoría propios para Servir **sigue siendo una brecha de
trazabilidad de ERP**, no un detalle de implementación pendiente. Se registra
como tal a propósito: que esté esperando decisión no la vuelve inocua.

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

## Higiene pendiente, no ejecutada — requiere autorización

1. **El fast-forward a `e794fd3`.** `[V]` Es fast-forward puro. El **único**
   untracked que lo bloquea es
   `src/tests/integration/outbox-worker.integration.test.ts`; ya está preservado
   fuera del repositorio, con hashes y comparación de cobertura. Falta la
   decisión del dueño sobre qué hacer con el original.
2. **Este archivo, commiteado después del fast-forward, no antes.** `HEAD` está
   10 commits atrás: commitear acá primero convertiría un fast-forward limpio en
   un merge innecesario.
3. **Portar `O4-03` y `O4-11`** al archivo de `origin/main` — bloque de código de
   test, con su propia autorización.

---

## Nota de método

Este archivo **no volvió a auditar** los ítems arrastrados: los declara
arrastrados y lo dice. Lo que sí se verificó de punta a punta en esta sesión es
lo que aparece con `[V]` y ancla — el estado de Git, las cuatro filas nuevas, los
dos cierres, y el hueco de cobertura de O4. Las anclas de O1-b se re-verificaron
porque O1 había desplazado las líneas que citaba el archivo del 02/09; las del
resto no se tocaron.
