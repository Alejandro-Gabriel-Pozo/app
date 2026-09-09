# Continuidad — D+A (reversión gobernada de pagos) y máquina de estados de órdenes

- **Fecha de corte:** 2026-09-02, sesión cerrada por el dueño con instrucción explícita de
  guardar estado, sin commitear el diff pendiente.
- **Para qué:** que una sesión nueva sepa exactamente dónde quedó este trabajo — qué está
  commiteado, qué diff hay aplicado pero sin commitear, qué diseño está aprobado pero sin
  implementar, y en qué orden seguir — sin depender del historial conversacional.
- **No repite** el razonamiento completo de cada decisión (eso vive en la conversación /
  en los mensajes al agente de diseño). Es un mapa de estado verificado, no un resumen narrativo.
- **Regla de lectura:** todo lo marcado `[V]` fue verificado contra el repo real en esta
  sesión (git, grep, lectura de archivo, o query SQL). No asumir que sigue siendo cierto sin
  re-verificar si pasó tiempo o si otra sesión tocó el repo.

---

## 0-bis. Correcciones de la sesión del 02/09 (posterior al cierre) — **leer antes que §1**

Cuatro afirmaciones de este documento quedaron mal o desactualizadas. Se corrigen **in place** más
abajo y se resumen acá. El texto original no se borra: se marca como superado, con el motivo.

| # | Qué decía | Qué es cierto sobre el árbol real |
|---|---|---|
| 1 | "hay **6** rutas untracked" (§1) | Son **7**. Falta declarar `docs/continuidad-da-orden-estados-2026-09-02.md` — este mismo archivo. La regla de staging por ruta explícita no cambia; el número sí |
| 2 | §1: "el resultado **sí** llegó" · §6: "su resultado **nunca** llegó" | **Contradicción interna sin resolver.** §1 se actualizó al cierre y §6 quedó viejo. Ninguna de las dos versiones sirve como evidencia: la revisión del `architecture-governor` sobre ORDER-03-b **hay que rehacerla contra este árbol**, cuyo alcance además ya no es el mismo (ver #4) |
| 3 | "**no ejecutada contra Postgres real** (sin `TEST_DATABASE_URL`)" (§1, §2) | **Obsoleto para este árbol.** `TEST_DATABASE_URL` está cargado en `.env` y funciona: `npm run test:integration` corrió entero el 02/09 — **50 tests en verde, 109 s**, incluidos dos de concurrencia real (2 y 10 requests simultáneos → exactamente 1 éxito). La limitación se conserva abajo como **registro histórico de lo que se creyó al escribir esos commits**, no como estado actual |
| 4 | §5: "Orden de prioridad vigente… 1. ORDER-04 · 2. ORDER-03-a · 3. ORDER-03-b" | **Superado por instrucción del dueño del 02/09.** ORDER-03-b **deja de ser un bloque aislado**: se integra a un slice de integridad de órdenes junto con ORDER-04, ORDER-05 y ORDER-06 (dos de esos tres son hallazgos nuevos, ver §0-quater). El diff actual **no se commitea** todavía |

### 0-ter. Nombres exactos de los documentos que este archivo cita de memoria

Se citan mal seguido. Los reales, verificados con `ls` el 02/09:

- `docs/vision-identidad-operativa-auditabilidad-2026-09-01.md` — **`auditabilidad`**, no `auditability`
- `docs/diseno-fiscal-profile-resolver-2026-09-01.md`
- `docs/pendientes-2026-09-02.md` · `docs/indice-conocimiento.md`
- El runbook de deploy vive en `docs/conocimiento/`, no en `docs/`

### 0-quater. Brechas nuevas encontradas el 02/09 que este documento no registra

Verificadas contra el árbol, con ancla. No estaban en §4 porque no se conocían: `ORDER-05`
(`reserveStock` no es idempotente por orden — doble reserva y **dos CHARGE** con dos
`confirmOrder` concurrentes; una de las dos reservas queda tomada para siempre), `ORDER-06`
(`voidByOrderId` anula `PENDING` **y `SETTLED`** sin mirar el estado de la orden: el mismo
defecto que ORDER-03-b cerró del lado *liquidar*, intacto del lado *anular*), `ORDER-07`,
`ORDER-08`, `ORDER-10`, `ORDER-11`, `ORDER-12`, `CAJA-ORD-01`, `AUDIT-ORD-01`,
`EVT-ORF-01` y `ORDER-13`. `ORDER-05` **responde el `[H]` que §3 dejó abierto** sobre
`reserveStock`: sí se puede reservar dos veces.

**`ORDER-13`, encontrado al diseñar la allowlist de creación del cargo:** el `catch` de
`dispatch()` no relanza (`outbox.worker.ts:267-325`), así que `poll()` sigue con el evento
siguiente. Si `financial:order.confirmed` falla, `order.completed` puede procesarse **antes de
que el CHARGE exista**: liquida cero filas, el evento se marca despachado igual, y el cargo queda
`PENDING` para siempre sin señal. `inventory.handlers.ts:25-38` documenta y resuelve
exactamente este desorden para `confirmed`/`cancelled` con el casillero compartido de
`stock_movements`; **el lado financiero no tiene equivalente**.

### 0-quinquies. Verificado contra PostgreSQL real el 02/09

Base descartable sobre `TEST_DATABASE_URL`, `schema.sql` completo, sentencias **copiadas
literal** de producción, carreras determinísticas (T1 toma el lock de la fila y commitea; T2
emite su sentencia bloqueada y reevalúa su predicado recién después). **19/19 chequeos con el
resultado esperado.** Esto convierte ORDER-04, ORDER-05 y ORDER-09 de razonamiento sobre el
código en comportamiento observado:

| # | Qué se probó | Resultado |
|---|---|---|
| E1 | Dos reservas de 6 sobre stock 10 | Sólo una gana; `reserved_quantity` queda en 6. La guarda de disponibilidad **sí** aguanta concurrencia real |
| E2 | Dos reservas de 3 **de la misma orden** sobre stock 10 | **Las dos ganan** → 6 reservados para una orden que necesita 3. No hay clave por orden (`ORDER-05`) |
| E3 | Dos `order.confirmed` con `event.id` distinto · el mismo reintentado | **2 CHARGE, $600 sobre una orden de $300** · el reintento del mismo evento **no** duplica |
| E4 | Segundo `OUT` sobre el mismo `order_item_id` | Rechazado (`23505`): se consolidan 3 y **quedan 3 reservados huérfanos** que ningún camino libera |
| E5 | `cancelWithClient` (ya corregido) contra `updateWithClient` (incondicional) | La cancelación commitea y el confirm **la pisa igual**: queda `CONFIRMED` con `cancelled_at` puesto — estado imposible (`ORDER-04`) |
| E6 | Reserva en transacción abortada, sola y con conflicto de índice | Revierte entera en los dos casos |
| E7 | Guarda de ORDER-03-b con la orden `CONFIRMED` / `CANCELLED` / `COMPLETED` | Rechaza · rechaza · liquida. `payment_method` **no** se contamina en los rechazos |
| E7-e | Un `PAYMENT` `PENDING` de la misma orden | **Se liquida igual** — `ORDER-09` confirmado como defecto vivo del diff actual |

El script vive fuera del repositorio (scratchpad de la sesión) a propósito: verificar no era
autorización para agregar archivos a `src/`. Los tests reales se escriben en el slice O3, y ahí
el criterio sube: `ORDER-05` hay que probarlo **a nivel de la unidad de negocio** — dos
`confirmOrder` concurrentes de la misma orden produciendo **como máximo una reserva efectiva y
un CHARGE**. El índice único y la idempotencia de `event.id` por separado **no alcanzan**: E4-b
y E3-c muestran que cada mecanismo funciona, y aun así E2-b y E3-b muestran que el invariante de
negocio se rompe igual.

### 0-sexies. Dos hallazgos más, posteriores al primer registro

**`ORDER-14` — nadie escribe `orders.confirmed_at`.** Apareció al definir qué sello temporal
lleva cada transición en la primitiva. `cancelWithClient` sella `cancelled_at`,
`completeWithClient` sella `completed_at`, `markServed` sella `served_at`; `confirmOrder` pasa
por `updateWithClient`, que sólo toca `status` y `updated_at`. La columna es nullable, sin
`DEFAULT` y sin trigger: **está en `NULL` para todas las órdenes que existieron**. Los cuatro
reportes que filtran por ella devuelven siempre vacío. **Se cruza con D7**, que en pendientes
figura como problema de visibilidad de UI: aunque se resolviera esa visibilidad, los paneles
mostrarían cero. El sellado entra en O1; **el histórico no se recupera con un backfill
inventado** —`updated_at` es lo último que le pasó a la fila, no la confirmación— así que los
reportes tienen que **distinguir `NULL` histórico de cero resultados reales** en vez de mentir
con un cero.

**`INV-ORF-01` — reservas de stock que ningún camino libera.** Registrado como hallazgo de
inventario **independiente**, no dentro de `ORDER-05`: éste es una de sus dos causas (la otra es
la compensación de dead-letter perdiendo la carrera del casillero,
`workers/inventory.handlers.ts:51-82`) y, sobre todo, **arreglar `ORDER-05` no borra las
reservas huérfanas que ya existan**. Detalle completo —tipo, origen, impacto y criterio de cierre
en tres partes— en `docs/pendientes-2026-09-02.md`.

---

## 0. Cómo llegamos acá — una frase

Auditoría de completitud del ERP → mayor severidad encontrada: **no había forma de revertir un
pago mal cargado** → diseño largo de "D+A" (reversión gobernada de pagos + atribución/auditoría),
revisado en ~20 rondas adversariales por el dueño actuando explícitamente como auditor de ERP →
al diseñar la primera guarda real (Bloque 0 de facturación), aparecieron condiciones de carrera
reales en `cancelOrder`/`completeOrder`/`confirmOrder` que **no tienen nada que ver con pagos
per se** pero sí con la misma familia de problema (transición de estado descartando el resultado
del `UPDATE`, o sin condición alguna) → se desvió el trabajo a cerrar esa familia de bugs
primero, porque son la base sobre la que el resto de D+A se apoya.

---

## 1. Estado de Git — verificado en esta sesión, justo antes del cierre

`[V]` Todo en `app-main`. `appfrontend-main` no se tocó en ningún momento de esta sesión.

| | |
|---|---|
| `HEAD` | `feb153a` |
| `origin/main` | `088fd4b` |
| Ahead/behind | **4 por delante, 0 por detrás** |
| Push realizado | **Ninguno.** Los 4 commits siguen 100% locales |

**Los 4 commits locales, en orden:**

1. `f6b24aa` — docs: registrar HOLD de diseño levantado (fiscal + identidad operativa)
2. `68c0848` — docs: reconciliar pendientes con el HOLD de diseño levantado
3. `0e0ee9e` — fix(pos-menu): cerrar carrera de cancelación de órdenes (**ORDER-01/02**)
4. `feb153a` — fix(pos-menu): cerrar carrera de completar órdenes (**ORDER-03-a**)

**Diff aplicado sobre el árbol de trabajo, NO commiteado** (por instrucción explícita del dueño
al cerrar la sesión — "no hagas commit"): **ORDER-03-b**, 5 archivos:

```
 M src/clientes-finanzas/financial-transaction.repository.ts
 M src/clientes-finanzas/sql.financial-transaction.repository.test.ts
 M src/clientes-finanzas/sql.financial-transaction.repository.ts
 M src/workers/outbox.handlers.test.ts
 M src/workers/outbox.handlers.ts
```

`[V]` Verificado antes de escribir esto: `tsc --noEmit` exit 0, `lint` exit 0, `lint:arch` sin
violaciones, **1738 tests en verde** (0 fallas).

**El `architecture-governor` (`aab03b94d1e2a8490`) terminó su revisión justo antes del cierre de
la sesión — el resultado sí llegó.**
> **CORRECCIÓN 02/09 (ver §0-bis #2):** §6 de este mismo documento afirma lo contrario ("su
> resultado nunca llegó"). La contradicción no se resuelve a favor de ninguna de las dos:
> **la revisión hay que rehacerla contra el árbol actual**, cuyo alcance además cambió. Lo que
> sigue se conserva como registro de lo que se anotó al cierre, no como aprobación vigente.

Decisión que se anotó entonces: **APROBADO CON CONDICIONES**, todas sobre el **mensaje de
commit**, ninguna exige tocar código. Antes de pedirle autorización de commit al
dueño, el mensaje tiene que declarar:

1. **La interacción con ORDER-04, en castellano llano** — esto es lo más importante que encontró
   el governor y no estaba anticipado: hoy `COMPLETED` es terminal por el camino legítimo
   (`cancelOrder` ya bloquea desde `COMPLETED`), así que la guarda de ORDER-03-b nunca rechaza una
   liquidación válida — **salvo** que la carrera de ORDER-04 saque a la orden de `COMPLETED` de
   vuelta a `CONFIRMED`. Si eso pasa entre la emisión del evento y el poll del worker: **antes**
   de este diff, el cargo se liquidaba igual (mal, con contaminación permanente de
   `payment_method`/tarjeta); **después**, el cargo queda `PENDING` (recuperable) con solo un
   `logger.warn` como huella. Es un modo de falla nuevo y silencioso que este mismo commit
   introduce, mejor que el anterior pero no cerrado — lo cierra ORDER-04.
2. Que ORDER-03-b queda **parcialmente cumplido**: la guarda sí, la señal durable no (ya está en
   el comentario del código, falta en el mensaje de commit).
3. Respuestas explícitas a las secciones 2 y 3 de `docs/DEFENSIVE_DEVELOPING.md` (obligatorio en
   este repo cuando no hay PR) — el governor las verificó y salen limpias: `SqlClient` del tenant
   vía `outbox.registry.ts:63`, sin `TransactionManager` nuevo, sin eventos nuevos. Faltaba
   **escribirlas**, no resolverlas.
4. Límite de evidencia: la guarda está verificada por aserción sobre el string SQL y razonamiento
   sobre el schema — **no ejecutada contra Postgres real** (sin `TEST_DATABASE_URL`). **[OBSOLETO
   02/09, ver §0-bis #3: `TEST_DATABASE_URL` existe y la suite de integración corre — 50 tests en
   verde. La condición sigue valiendo como *pendiente de ejecutar*, ya no como *imposible*.]**
   La no-reintentabilidad está verificada a nivel handler (`outbox.worker.ts` leído directamente por
   el governor, no solo confiado), **no** de punta a punta con un `OutboxWorker` real.

**Staging:** enumerar los 5 paths a mano, nunca `-A`/`-a` — hay ~~6~~ **7** rutas untracked que
se colarían (corregido el 02/09, ver §0-bis #1).

**Hallazgo aparte de gobernanza, no bloqueante pero señalado por el governor para que el dueño lo
sepa:** hay un servidor MCP de Neon activo con *"Write mode active. Destructive tools are
exposed"*, y quedaron untracked `.claude/skills/neon/`, `.claude/skills/neon-postgres/`,
`skills-lock.json`. El `CLAUDE.md` raíz advierte que la contención del gate de gobernanza depende
de que nada en el entorno pueda escribir/pushear/deployar sin pasar por `Bash` — un MCP con
capacidad de escritura no pasa por ese matcher. No bloquea nada de este trabajo; revisar antes de
cualquier tarea de schema.

**Sugerencias menores del governor, no bloqueantes, quedan para cuando se retome:**
`return result.rowCount ?? 0` (`sql.financial-transaction.repository.ts:361` aprox.) confunde
"el driver no informó" con "0 filas" — a diferencia de los métodos hermanos en
`sql.order.repository.ts`, que fallan cerrado ante `undefined`. El governor evaluó la consecuencia
real como acotada (el `UPDATE` sigue siendo todo-o-nada; lo único que se pierde es precisión en el
log) y sugiere un comentario de una línea, no un cambio de comportamiento — eso sería otro bloque.
También notó, como **dato preexistente sin tocar en este diff**, que `settleByOrderId` no filtra
por `type` como sí hace `voidByOrderId` (`type IN ('CHARGE','ADJUSTMENT')`) — liquidaría un
`PAYMENT` `PENDING` de la orden si existiera. No introducido acá, no autorizado a tocarlo acá.

**Untracked, sin relación con este trabajo, presentes desde antes y sin tocar (6):**
`.claude/skills/neon-postgres/`, `.claude/skills/neon/`, `.reviews/`, `docs/erp-auditoria-v2/`,
`docs/programa-auditoria-completitud-erp-2026-09-01.md`, `skills-lock.json`.

**Séptimo untracked, omitido al escribir esto (corregido el 02/09):**
`docs/continuidad-da-orden-estados-2026-09-02.md` — **este mismo archivo**. Sí tiene relación
directa con el trabajo, y el hallazgo más urgente del proyecto vive sólo acá: no está en
`origin/main` ni en ningún `pendientes-*.md`.

---

## 2. Qué hace cada commit/diff — resumen técnico

### `0e0ee9e` — ORDER-01/02 (cancelOrder)

`cancelOrder` leía el estado de la orden fuera de la transacción y descartaba el resultado del
`UPDATE` condicional. Consecuencia: cancelar dos veces "tenía éxito" las dos veces (evento
duplicado), y con un `completeOrder` concurrente ganando la carrera, se publicaba
`order.cancelled` igual → el worker anulaba (`voidByOrderId`) los cargos de una orden ya
`COMPLETED` y cobrada.

Corrección: `getByIdForUpdate` (nuevo, `SELECT ... FOR UPDATE` dentro de la transacción real),
`cancelWithClient` devuelve `{order, changed}`, evento solo si `changed === true`. Tres ramas:
cambió (evento) / ya `CANCELLED` (200 idempotente) / no cancelable (409 fail-closed, cualquier
estado ≠ `DRAFT`/`CONFIRMED`, incluido desconocido).

**Limitaciones declaradas en el propio commit:** sin test de concurrencia real (sin
`TEST_DATABASE_URL` en este entorno — **[OBSOLETO 02/09, ver §0-bis #3: sí hay
`TEST_DATABASE_URL` en `.env` y la suite de integración corre contra Postgres real. Lo que falta
es escribir el test, no el entorno.]**), ramas `!changed`/`rowCount undefined` sin cobertura
alcanzable con los dobles disponibles.

### `feb153a` — ORDER-03-a (completeOrder)

Mismo defecto, simétrico, en `completeOrder`. Corrección idéntica en forma. Dos cambios de
contrato HTTP **confirmados explícitamente por el dueño** antes del commit:
- Completar una orden ya `COMPLETED` pasa de 409 a **200 idempotente** (deliberado, para
  reintentos/doble-submit; el panel oculta el botón en ese estado, así que el radio real es
  bajo).
- Precedencia de errores: estado de la orden (409) se evalúa **antes** que `cardSurchargeAmount`
  inválido (400) — antes era al revés.

**Declara explícitamente en el mensaje:** `ORDER-03-b` (ver abajo) sigue abierto, con cita exacta
a `outbox.handlers.ts:243`.

### Diff sin commitear — ORDER-03-b (`handleOrderCompleted`)

`settleByOrderId` liquidaba el cargo (`PENDING → SETTLED`, más `payment_method`/`shift_id`/datos
de tarjeta) por `order_id`, sin volver a verificar el estado real de la orden. Un evento
`order.completed` viejo, duplicado o procesado después de que la orden cambió de estado podía
liquidar (y contaminar con datos de pago) el cargo de una orden que en realidad quedó
`CANCELLED`.

Corrección: la condición `EXISTS (... o.status = 'COMPLETED' AND o.business_id = ft.business_id
...)` se agregó **dentro de la misma sentencia `UPDATE`** (no como `SELECT` previo) — atómico,
sin ventana. Si no se cumple, no se escribe absolutamente nada. El handler distingue: `0` filas →
**no lanza**, retorna normal (el rechazo de negocio no se reintenta indefinidamente); excepción
real → **propaga** (el worker sí reintenta fallos técnicos). Se agregó un `logger.warn`
estructurado, declarado explícitamente en el propio código como **limitación temporal, no
solución**: no es durable ni consultable, solo log de servidor — eso requiere la tabla de
incidentes (ver §4, todavía no autorizada).

`[V]` Antes de diseñar esto se corrieron dos queries de solo lectura contra producción: eventos
`order.completed` espurios (**0 filas**) y cargos `SETTLED` sobre órdenes no `COMPLETED` (**0
filas**). Sin exposición histórica conocida.

---

## 3. El hallazgo más importante para la sesión siguiente: `BRECHA-ORDER-04`

Encontrado por el agente de diseño mientras verificaba las premisas de ORDER-03-b (si
`COMPLETED`/`CANCELLED` son terminales). **Es peor que los tres anteriores.**

`[V]` `confirmOrder` (`DRAFT → CONFIRMED`) usa `updateWithClient`, que ejecuta
`UPDATE orders SET status = $1 WHERE id = $N` — **sin ninguna condición sobre el estado
previo**. No es "condicional con resultado descartado" como los otros tres: es una escritura
**incondicional**. Si una cancelación concurrente commitea en la ventana (la validación de
`confirmOrder` también corre fuera de la transacción), `confirmOrder` puede **sobrescribir
`CANCELLED` con `CONFIRMED`**, reservar stock y publicar `order.confirmed` — que **crea un CHARGE
nuevo**. No es un evento espurio sobre algo existente: es la resurrección completa de una orden
terminada, con dinero nuevo de por medio.

**El dueño ya decidió: es la prioridad máxima de todo el trabajo pendiente — antes que R0, antes
que retomar D+A propiamente dicho.**

### Diseño ya entregado por el agente (sin diff todavía)

- `confirmWithClient` dedicado, `WHERE id = $1 AND status = 'DRAFT'`, inspecciona `{order,
  changed}` — simétrico a los otros tres.
- La rama idempotente (`ya CONFIRMED`) **no debe reservar stock** — a diferencia de
  cancel/complete, acá la idempotencia del comando es "no repetir los efectos", no solo "no
  repetir el evento".
- Secuencia completa, matriz de concurrencia (`confirm` vs `cancel`, `confirm` vs `complete`, dos
  `confirm` concurrentes) y criterios de aceptación `ORD4-01` a `ORD4-11` ya están en la
  conversación (agente `a7db571bf458f8e41`, penúltima entrega).

### Dos preguntas abiertas — **bloquean el diff, sin resolver al cierre de esta sesión**

1. **¿Se confirma quitar `status?: OrderStatus` de `UpdateOrderInput`?** `[V]` Hoy es la única
   vía genérica de escritura de estado además de las tres transiciones dedicadas — sin quitarla,
   ORDER-04 arregla `confirmOrder` pero deja la puerta abierta a que un futuro llamador
   reintroduzca el mismo problema. Toca una entidad compartida (`order.entities.ts`), por eso el
   agente pidió confirmación explícita antes de tocarla, no lo asumió.
2. **¿Se autoriza verificar `productService.reserveStock`?** Solo lectura. Hace falta para
   confirmar o descartar si dos `confirmOrder` concurrentes sobre la misma orden `DRAFT` podrían
   reservar stock dos veces (el agente lo marcó `[H]`, sin verificar, docblock de
   `processed_events` menciona un "casillero único de `stock_movements`" pero no se confirmó que
   aplique acá).

**Primer paso real de la sesión que retome este bloque:** reenviar estas dos preguntas al dueño
(o decidirlas si ya las decidió fuera de esta sesión), y recién ahí pedirle al agente de diseño
el diff exacto de ORDER-04.

---

## 4. Registro de brechas — estado y dependencias

| ID | Severidad | Estado | Nota |
|---|---|---|---|
| `BRECHA-ORDER-01` (doble cancelación, evento duplicado) | S2 | **Cerrada** en `0e0ee9e` | — |
| `BRECHA-ORDER-02` (carrera cancel/complete, void indebido) | S1 | **Cerrada** en `0e0ee9e` | — |
| `BRECHA-ORDER-03-a` (misma familia en completeOrder) | S1 | **Cerrada** en `feb153a` | — |
| `BRECHA-ORDER-03-b` (liquidación sin re-verificar orden) | S1 | **Guarda cerrada** en diff sin commitear; **señal durable pendiente** de tabla de incidentes | Parcialmente cumplido a propósito, declarado así |
| **`BRECHA-ORDER-04`** (confirmOrder incondicional, resurrección) | **S1, prioridad máxima** | **Abierta.** Diseño listo, diff bloqueado por las 2 preguntas de §3 | — |
| `FACT-INV-BIZID-001` (`requestInvoice` no compara `businessId` del movimiento) | S1 candidata, eleva a S0 si hay exposición cross-tenant | Abierta, registrada en `docs/pendientes-2026-09-02.md` | Precondición del Bloque 0 de D+A |
| Gap C1-C (`JOIN` descarta facturas consolidadas) | S1 | Abierta, ya conocida antes de esta sesión | Bloquea D+A Bloque 1b específicamente |
| `CONTRACT-COVERAGE-001` (ex-`CONTRACT-001`, ver nota) | S2 | Abierta | Bloquea el paso 3 (rechazo duro) de la transición de idempotencia del cobro en D+A |
| `BRECHA-REFUND-01` (`confirmRefund` no idempotente, puede duplicar Nota de Crédito con CAE propio) | S1 | Abierta | Bloquea E3b (ver §5) |
| `BRECHA-AUDIT-01` (ningún intento fiscal rechazado deja rastro) | S2 | Abierta | Depende de extensión de `audit_log` |
| `AUDIT-DOC-001` (`erp-auditoria-v2/` sin versionar) | — | Abierta, deuda documental | No es urgente pero está señalada |
| `DA-CONT-001` (la especificación completa de D+A no existe en ningún documento, solo en conversación) | — | Abierta | Ver §6 |

**Nota sobre `CONTRACT-COVERAGE-001` (09/09/2026, gate `architecture-governor`):**
`CONTRACT-001` se partió en dos al cerrar sus componentes #2 (cerca que
cruza `spec.ts` contra rutas reales) y #3 (los 3 paths rotos que dejaba
pasar) — ver `docs/pendientes-2026-09-08.md`, sección Higiene, commits
`a96aa90`+`cf59908`. El componente #1 (documentación incompleta — ~24
routers y ~40 endpoints sin ninguna entrada en `spec.ts`) sigue abierto
bajo `CONTRACT-COVERAGE-001` y **sigue bloqueando esta fila**: la cerca
nueva verifica que lo documentado no mienta, no que lo no documentado
llegue a documentarse. Evidencia parcial que NO cierra esta precondición:
`/docs`/`openapi.json` no se sirven en producción desde `0170ee5`
(01/09/2026) y el dueño confirmó ese día que nadie fuera del equipo usa
`/docs` (`src/api/docs-exposure.ts:43`) — eso descarta "consumidor externo
que lee el spec", pero no dice nada de un consumidor que pegue contra el
endpoint de cobro sin haber leído el spec, que es lo que el paso 3
necesita descartar.

---

## 5. El diseño de D+A propiamente dicho — dónde quedó, resumido

Todo esto está **diseñado y aprobado en principio por el dueño en ~20 rondas de revisión**, pero
**nada de esto está implementado ni tiene diff todavía** — quedó pausado cuando aparecieron los
bugs de ORDER-*.

- **Bloque 0** (facturación): whitelist de tipo/estado/existencia/duplicidad para
  `requestInvoice`, más aislamiento por `businessId` (que resultó ser `FACT-INV-BIZID-001`, una
  brecha real). Diseño completo, con matriz de 30+ casos negativos literales del dueño, todos
  respondidos. **Encontró la condición de carrera original** que llevó a descubrir todo lo de
  ORDER-*: la validación de elegibilidad corre fuera de la transacción de creación de la factura.
- **Bloque 1a** (identidad del "acto de cobro"): sin tabla nueva, columna de identidad replicada
  por fila + total declarado, invariantes en 3 capas (estructural/transaccional/verificación).
  Diseño cerrado.
- **Bloque 1b** (tipo `PAYMENT_REVERSAL`, reversión real): **bloqueado por Gap C1-C**, no se iba a
  diseñar en detalle hasta resolver eso.
- **R0** (barrera fail-closed contra cancelar algo con comprobante fiscal): dos ventanas de
  carrera identificadas (validación→persistencia, cerrable con lock; commit→emisión ARCA, **no**
  cerrable con lock — necesita coordinación con el lado de cancelación). Diseño de R0-a/R0-b
  completo. **R0-c** (señal durable) choca con la misma tabla de incidentes que ORDER-03-b.
- **R1** (idempotencia de `confirmRefund`): diseño completo, bloqueado por verificar que
  `CancellationRefundService` cumpla 8 condiciones — **no las cumple hoy** (no emite/coordina NC
  de forma garantizada, no es idempotente, puede duplicar CAE). Por eso `E3b` (derivar a Nota de
  Crédito real) está bloqueada y se decidió `E3a` (barrera fail-closed temporal,
  `INVOICE_REQUIRES_CREDIT_NOTE`, 409) como paso intermedio — **tampoco implementado todavía**.
- **Tabla de incidentes** (persistencia durable de conflictos fiscales/de negocio, con estado de
  resolución, severidad, actor, correlation ID): **campos ya definidos por el dueño**, pero
  **ningún DDL autorizado**. Es la pieza que le falta a R0-c y a la mitad de señal de ORDER-03-b.

**Orden de prioridad vigente al cierre de la sesión** (el dueño lo reordenó explícitamente,
reemplaza cualquier orden anterior):

1. **ORDER-04** — máxima prioridad.
2. ORDER-03-a — ya commiteado (`feb153a`).
3. ORDER-03-b — diff aplicado, sin commitear.
4. R0-a / R0-b.
5. R0-c (tabla de incidentes, DDL separado).
6. R1 (idempotencia de `confirmRefund`).
7. E3b / Nota de Crédito real.
8. D+A Bloque 1b (bloqueado por Gap C1-C).

---

## 6. Agentes en background — no persisten entre sesiones

- **Agente de diseño `a7db571bf458f8e41`** ("Diseño de reversión gobernada y auditoría de
  pagos"): tiene todo el contexto de las ~20 rondas de D+A y de los 4 bloques ORDER-*. **Es un
  agente en background de esta sesión — no hay garantía de que siga vivo o accesible en una
  sesión nueva.** Si no lo está, hay que re-armar el contexto desde este documento y desde
  `docs/pendientes-2026-09-02.md` antes de volver a delegarle diseño.
- **Agente `architecture-governor` (`aab03b94d1e2a8490`)**: estaba revisando el diff de
  ORDER-03-b cuando la sesión se cerró. ~~**Su resultado nunca llegó.**~~ **CONTRADICE A §1**,
  que dice que sí llegó y quedó aprobado con condiciones (ver §0-bis #2). Esta línea quedó
  vieja: §1 se actualizó al cierre y §6 no. La conclusión operativa es la misma por los dos
  caminos: **no asumir que el diff está aprobado — volver a lanzar la revisión contra el árbol
  actual.**

**Consecuencia práctica:** toda la especificación de D+A (Bloque 0/1a/1b, R0/R1/E3, tabla de
incidentes) vive **únicamente en la conversación de esta sesión y en la memoria de un agente que
puede no persistir** — es exactamente `DA-CONT-001` (§4), y ahora es más urgente: si se pierde el
acceso al agente, hay que reconstruir el diseño desde cero o desde los mensajes ya enviados. **No
se resolvió en esta sesión** — quedó señalado, no versionado.

---

## 7. Qué NO se tocó en esta sesión (para que quede explícito)

`appfrontend-main` (ningún archivo). Reservas. Caja. Schema (`CURRENT_SCHEMA_VERSION` sigue en
44 — ningún bloque de esta sesión requirió DDL). Permisos/RBAC. `docs/pendientes-2026-09-02.md`
(no se actualizó con ORDER-01/02/03-a/03-b/04 — es una tarea pendiente, señalada por el propio
`architecture-governor` como violación de la regla del proyecto de que todo pase por ese
archivo). Ningún push. Ningún deploy.

---

## 8. Primer paso recomendado para la sesión que retome esto

1. Verificar git fresco (`git fetch` + `rev-parse HEAD`/`origin/main` + `status`) — confirmar que
   este documento sigue describiendo el estado real; si alguien más tocó el repo, no confiar en
   §1.
2. Releer este documento completo antes de tocar nada.
3. ~~**La revisión del governor sobre ORDER-03-b ya llegó y está aprobada con condiciones**~~ —
   **SUPERADO 02/09.** §1 y §6 se contradicen (§0-bis #2) y, además, el alcance cambió: por
   instrucción del dueño **el diff de ORDER-03-b no se commitea aislado** — se revisa dentro de
   un slice de integridad de órdenes junto con ORDER-04, ORDER-05 y ORDER-06. La revisión hay
   que rehacerla sobre ese alcance, no sobre el diff de 5 archivos.
4. **El propio governor recomendó, como "next block", un commit de documentación ANTES de
   ORDER-04**: agregar a `docs/pendientes-2026-09-02.md` las filas de ORDER-01/02 (resuelto,
   `0e0ee9e`), ORDER-03-a (resuelto, `feb153a`), ORDER-03-b (estado según se decida commitear o
   no) y **ORDER-04** (abierto, prioridad máxima, con ancla exacta
   `src/pos-menu/order.service.ts:503-505` y `src/pos-menu/sql.order.repository.ts:353-355`) —
   describiendo la consecuencia (dinero nuevo sobre una orden cancelada), no el mecanismo, según
   la regla 3 del propio `pendientes-2026-09-02.md`/`CLAUDE.md`. Motivo: hoy **cero** archivos de
   `docs/` mencionan esta familia de bugs — si la sesión se corta sin ese commit, el hallazgo
   más urgente del proyecto no tiene ancla en el repositorio, solo en este documento.
5. ~~Decidir con el dueño las 2 preguntas de §3~~ — **RESUELTAS el 02/09.** (a) Quitar `status`
   de `UpdateOrderInput`: **confirmado**, condicionado a que el radio siga siendo un solo
   llamador interno — re-verificado el 02/09 y sigue siéndolo (`order.service.ts:520`; ninguna
   ruta HTTP, ningún test, y `ordenes.update` del dataProvider del frontend es `notSupported`).
   (b) Verificar `reserveStock`: **autorizado y hecho** — es un incremento condicionado por
   disponibilidad, sin ninguna clave por orden, así que **sí se puede reservar dos veces**
   (`ORDER-05`). Criterio de cierre fijado por el dueño: dos `confirmOrder` concurrentes dejan
   **una sola reserva y como máximo un CHARGE**.
6. Recién ahí, retomar al agente de diseño (si sigue vivo) o re-armar el encargo de ORDER-04
   desde cero con este documento como contexto.
