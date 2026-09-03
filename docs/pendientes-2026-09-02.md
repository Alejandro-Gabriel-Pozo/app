# Pendientes — Miércoles 2 de Septiembre 2026

Arrastra lo que seguía abierto en `pendientes-2026-09-01.md`. Los ítems
cerrados quedan allá marcados, no se repiten acá.

**Arrastre re-chequeado** según la regla de `CLAUDE.md` ("Pendientes —
revalidar antes de arrastrar"): las anclas de los ítems que cambiaron de
estado hoy, o que se cruzaron directamente contra `f6b24aa`, se
re-verificaron contra el código o el documento real; las del resto se
conservan sin re-verificar y se declara así explícitamente en cada bullet,
igual que hizo el archivo anterior.

**Reconciliación documental de esta sesión:** bloque separado, ejecutado
después de `f6b24aa` ("docs: registrar HOLD de diseño levantado"), con
autorización del dueño limitada a este archivo y a `pendientes-2026-09-01.md`.
No toca código, schema, permisos, D+A, Caja, ni el propio `f6b24aa`.

---

## Contexto de sesión (02/09/2026)

| Commit / evento | Qué |
|---|---|
| `f6b24aa` | HOLD de diseño levantado para `diseno-fiscal-profile-resolver-2026-09-01.md` y `vision-identidad-operativa-auditabilidad-2026-09-01.md`, HOLD de implementación explícitamente distinguido y vigente. Documental puro. Local, **sin push** — decisión pendiente aparte. |
| `architecture-governor`, 2 pasadas | Encontró y forzó corregir: autocontradicción en `indice-conocimiento.md`, ancla de línea rota en `mapa-companies-vs-locations-2026-09-01.md` (`:52`→`:58`), afirmaciones de `vision-...md §5` apoyadas en material sin versionar y sin marcar `[P]`, y una segunda vuelta que encontró `mapa-...md:121` todavía afirmando "siguen en HOLD" tras la primera corrección. |
| D+A — especificación final de Bloque 0 y contrato de Bloque 1a | Agente de diseño (`a7db571bf458f8e41`), 8 rondas de revisión auditora del dueño. Diff propuesto y criterios de aceptación completos para Bloque 0; contrato con invariantes en tres capas (estructural/transaccional/verificación) para Bloque 1a. **Ninguno de los dos autorizado a implementarse todavía.** Bloque 1b en HOLD, bloqueado por Gap C1-C (ver abajo). Ver §"Encontrado hoy" para el riesgo de continuidad de este trabajo. |

---

## 🔴 Abierto — encontrado hoy (02/09/2026)

**Precisión de alcance:** "encontrado hoy" significa **nuevo para este
inventario de pendientes**, no necesariamente nuevo para el sistema. Los
tres ítems de esta sección —la brecha de validación de `businessId`, el
corpus de auditoría sin versionar, la especificación de D+A sin
persistir— probablemente existían como deuda antes de esta sesión; lo que
pasó hoy es que se formalizaron con evidencia y quedaron registrados por
primera vez.

### FACT-INV-BIZID-001 — `requestInvoice()` nunca valida que el movimiento pertenezca al negocio del pedido

**Hallazgo del agente de diseño D+A, verificado por esta sesión con grep directo.**

`RequestInvoiceInput.businessId` existe como campo del input
(`app-main/src/facturacion/invoice.service.ts:72`) y se **reenvía** sin
validar hacia la factura que se crea, en las tres ramas de emisión (`:362`,
`:460`, `:649`). **En ningún punto de `requestInvoice()` se compara contra
el `businessId` real del `financial_transaction` que se está facturando** —
verificado con `grep -n businessId invoice.service.ts`, 5 ocurrencias
totales, ninguna es una comparación.

**Severidad preliminar: S1 candidata.** La falta de comparación entre el
`businessId` solicitado y el `businessId` real del movimiento es, por sí
sola, una brecha de validación de pertenencia/aislamiento de tenant en un
ERP multi-tenant — eso alcanza para registrar S1 sin esperar a resolver la
pregunta de explotabilidad. **Se eleva a S0 si se demuestra exposición
cross-tenant real** (que un usuario autenticado pueda facturar o acceder a
movimientos de un `businessId` que no es el suyo).

| Dimensión | Clasificación |
|---|---|
| Falta de comparación entre `businessId` solicitado y `businessId` real del movimiento | **[V]** — verificado con grep, 5 ocurrencias, ninguna compara |
| Existencia de exposición cross-tenant real | **[H]** — pendiente de probar contra la arquitectura de aislamiento y permisos |
| Severidad preliminar | **S1 candidata; eleva a S0 si se demuestra impacto cross-tenant** |
| Dependencia | Revisión del modelo `companies`/`locations` (`mapa-companies-vs-locations-2026-09-01.md`), aislamiento de tenant y autorización de facturación |
| Criterio de cierre | Prueba negativa que impida facturar un movimiento de otro `businessId`, más prueba positiva de que el `businessId` correcto sigue funcionando |

La pregunta abierta sobre `companies`/`locations` (si una misma BD puede
contener movimientos de más de un `businessId`) modifica el **impacto y la
explotabilidad**, no borra el riesgo ni justifica dejar la severidad sin
clasificar.

**Cruce de dependencias (regla permanente del dueño, ver
`docs/erp-auditoria-v2/` y las rondas de revisión D+A):**

| Relación | Con qué |
|---|---|
| Bloqueante | Ninguna todavía — es un hallazgo nuevo, no bloquea nada en curso |
| Precondición | De cerrar el Bloque 0 de D+A con el listón más alto: el diff propuesto de Bloque 0 (§1.1 de la especificación) ya prevé agregar esta guarda como parte de la elegibilidad fiscal, pero no está autorizado a implementarse |
| Dependencia informativa | El modelo `companies`/`locations` (`mapa-companies-vs-locations-2026-09-01.md`), que determina la explotabilidad real |
| Relacionada pero independiente | Ninguna |

**Requiere:** decisión del dueño sobre si amerita verificación urgente fuera
del ciclo normal de Bloque 0, o si espera a la autorización de ese bloque.

### AUDIT-DOC-001 — corpus de auditoría de completitud sin versionar, mismo riesgo que tenían los dos HOLD antes de `f6b24aa`

`docs/erp-auditoria-v2/` (21 fichas, 158 hallazgos, 431 anclas) y
`docs/programa-auditoria-completitud-erp-2026-09-01.md` (borrador v1.0,
**superado** por el v2 de `erp-auditoria-v2/00-programa-v2.md`) siguen
**sin `git add`, sin commit, sin seguimiento** — verificado con
`git status --short` en `app-main`, ambos como `??`.

Es el mismo tipo de riesgo de continuidad que tenían
`diseno-fiscal-profile-resolver-2026-09-01.md` y
`vision-identidad-operativa-auditabilidad-2026-09-01.md` antes de esta
sesión: si se pierde el disco local o el árbol de trabajo, este material —
que ya se está citando como fuente `[DA]` en las rondas de D+A — desaparece
sin dejar rastro en `origin/main`.

**Requiere:** decisión del dueño sobre versionarlo, en su propio bloque
documental separado (mismo patrón que `f6b24aa`: preflight, revisión de
`architecture-governor`, staging por ruta explícita, autorización de
commit y de push por separado). No es parte del alcance de esta
reconciliación.

### DA-CONT-001 — la especificación de D+A vive solo en conversación de agente, no en un documento versionado

Las 8 rondas de diseño y revisión de D+A (Bloque 0 completo, Bloque 1a
completo, clasificación de Gap C1-C, transición de idempotencia) no tienen
todavía ningún archivo propio en `docs/`. Existen únicamente en la
transcripción de esta sesión y en la memoria del agente de diseño.

**El riesgo es de continuidad y reproducibilidad, no de inexistencia
conceptual.** La especificación existe — es madura, pasó 8 rondas de
revisión auditora, y está citada con precisión en esta misma
reconciliación (Gap C1-C, CONTRACT-001, FACT-INV-BIZID-001 arriba). Lo que
falta es el soporte: un `git clone` limpio, una sesión nueva, o un agente
distinto no puede reconstruir ninguna de estas decisiones — a diferencia de
`diseno-fiscal-profile-resolver-2026-09-01.md` y
`vision-identidad-operativa-auditabilidad-2026-09-01.md`, que si algo salía
mal antes de `f6b24aa` existían al menos en el disco local. Esos dos ya son
fuentes válidas de contexto y decisiones previas, versionadas por
`f6b24aa`; el corpus de auditoría (`AUDIT-DOC-001`) y esta especificación
de D+A son una deuda documental **adicional y separada**, no una
invalidación de lo ya versionado.

**Requiere:** decisión del dueño sobre cuándo y cómo persistir esta
especificación (documento propio, o esperar a que el Bloque 0 se autorice y
documentar junto con la implementación). No se resuelve en esta
reconciliación — solo se registra para que no se pierda en silencio.

### Familia ORDER-* — integridad del ciclo de vida de una orden

Trece hallazgos sobre el mismo ciclo: confirmar, completar y cancelar una
orden, y los efectos financieros y de inventario que eso dispara. Tres
cerrados, uno con diff aplicado sin commitear, nueve abiertos. Cada fila
describe **la consecuencia**, no el mecanismo (regla 3), con ancla
verificable (regla 1). El mapa completo, la matriz de estados y el plan de
slices viven en `docs/continuidad-da-orden-estados-2026-09-02.md`.

| ID | Consecuencia | Estado | Ancla |
|---|---|---|---|
| ORDER-01/02 | Cancelar dos veces publicaba un segundo evento; con un completar concurrente se anulaban los cargos de una orden ya cobrada | ✅ RESUELTO (`0e0ee9e`) | — |
| ORDER-03-a | Lo mismo al completar: se liquidaba el cargo de una orden que había quedado cancelada | ✅ RESUELTO (`feb153a`) | — |
| ORDER-03-b | Un evento viejo o duplicado liquidaba —y contaminaba con datos de pago— el cargo de una orden que nunca se completó | Diff aplicado **sin commitear**. Entra a O2; **no se commitea aislado** (decisión del dueño, 02/09) | `sql.financial-transaction.repository.ts:315` |
| **ORDER-04** | **Una orden cancelada puede volver a confirmarse y generar un cargo nuevo**: plata nueva sobre algo que el negocio dio por terminado | Abierto — **prioridad máxima**, slice O1 | `order.service.ts:503-505`<br>`sql.order.repository.ts:353-357` |
| **ORDER-05** | **Dos confirmaciones simultáneas de la misma orden cobran dos veces y dejan stock reservado que nadie libera**: ese producto deja de poder venderse | Abierto — slice O1 | `sql.inventory-level.repository.ts:71-84` |
| **ORDER-06** | **Se puede anular un cobro ya realizado** sin mirar si la orden está cancelada — la guarda se puso al liquidar y no al anular | Abierto — slice O2 | `sql.financial-transaction.repository.ts:365-376` |
| ORDER-07 | Se crea un cargo sin verificar que la orden esté confirmada | Abierto — slice O2 | `outbox.handlers.ts:210-241` |
| ORDER-08 | "Marcar como servida" puede responder que sí sin haber hecho nada | Abierto — slice O1 | `order.service.ts:712-720` |
| ORDER-09 | Un pago pendiente de la orden se liquidaría junto con los cargos | Abierto — slice O2 | `sql.financial-transaction.repository.ts:344-362` |
| **ORDER-10** | **Se puede cancelar una orden ya facturada**: queda una factura con CAE apuntando a un movimiento anulado, sin nota de crédito | Abierto — slice O4 | `invoice.service.ts:304-316` |
| **ORDER-11** | **Desde el panel no se puede crear una orden ni agregarle un ítem**: el frontend manda un precio que el backend rechaza desde el 22/08 (`6bc6358`, ya en `origin/main`) | Abierto — bloque F1, **otro repo** | `api/schemas/request.schemas.ts:184-186`<br>appfrontend: `app/dashboard/ordenes/page.tsx:171-176` |
| ORDER-12 | El panel nunca informa el medio de pago: la caja no registra el efectivo del POS | Abierto — bloque F2 | appfrontend: `lib/ordenes/api.ts:22` |
| **ORDER-13** | **Si el evento de confirmación se demora, el de completado liquida cero y el cargo queda pendiente para siempre**, sin que nadie se entere | Abierto — slice O2 | `outbox.worker.ts:267-325` (el `catch` de `dispatch()` no relanza) |
| CAJA-ORD-01 | Anular un cargo en efectivo ya imputado a un turno abierto baja el esperado sin contrapartida: el arqueo marca sobrante sin explicación | Abierto — bloque C1 | `sql.cash-register-shift.repository.ts:64-84` |
| AUDIT-ORD-01 | Un cargo puede pasar de pendiente a anulado sin que quede registro de quién ni por qué | Abierto — bloque A1 | `workers/outbox.registry.ts:82` |
| **ORDER-14** | **Los reportes de POS devuelven siempre vacío**: ventas por producto, ticket promedio, tarifas aplicadas y el reporte por cliente filtran por una fecha de confirmación que nunca se escribe | Abierto — el sellado entra en O1; el rescate de lo histórico es bloque aparte | `sql.order.repository.ts:520`, `:549`, `:581`<br>`sql.customer.repository.ts:394` |
| EVT-ORF-01 | `reservation.expired` se emite y ningún handler lo escucha | Abierto — fuera de esta familia | `workers/reservation-hold-expiry.worker.ts:110` |

**ORDER-03-b NO está cerrado.** Se dice explícito porque el diff aplicado
podría leerse como si lo estuviera: su guarda funciona —verificada contra
PostgreSQL real, ver abajo— pero (a) liquida un `PAYMENT` de la misma orden,
que es `ORDER-09` vivo adentro del propio diff; (b) devuelve un cero
indistinguible para siete causas distintas; (c) colapsa "el driver no informó"
con "cero filas"; y (d) su única huella es un log de proceso, no una señal
durable. **No se commitea aislado**: entra a O2 corregido.

### INV-ORF-01 — reservas de stock que ningún camino libera

**Hallazgo de inventario, independiente de la familia ORDER-*.** Se registra
aparte a propósito: `ORDER-05` es una de sus causas, no su definición, y
**arreglar `ORDER-05` no borra las reservas huérfanas que ya existan**.

| Dimensión | |
|---|---|
| **Tipo** | Reserva de stock tomada (`inventory_levels.reserved_quantity`) que nunca se consolida ni se libera. No hay estado "huérfano": es una diferencia entre lo reservado y lo que los movimientos justifican |
| **Origen** | Dos caminos distintos. **(a)** Dos confirmaciones concurrentes de la misma orden reservan dos veces, pero el índice único parcial de `stock_movements (order_item_id) WHERE movement_type IN ('OUT','RESERVATION_RELEASED')` sólo deja consolidar una — la otra queda tomada (`ORDER-05`). **(b)** La compensación de dead-letter de `order.confirmed` pierde la carrera del casillero y no libera, trade-off ya documentado en `workers/inventory.handlers.ts:51-82` |
| **Impacto** | El disponible se calcula como `stock_quantity - reserved_quantity`. Una reserva huérfana baja el disponible **para siempre**: el producto deja de poder venderse aunque el stock físico esté ahí. No hay alerta, no hay pantalla que lo muestre, y no aparece como faltante en ningún reporte |
| **Verificado** | **[V]** contra PostgreSQL real el 02/09: dos reservas de 3 sobre stock 10 quedan en 6 reservados; el segundo `OUT` sobre el mismo `order_item_id` lo rechaza el índice (`23505`); se consolidan 3 y **quedan 3 reservados que ningún camino toca** |
| **Criterio de cierre** | Tres cosas, no una: **(1)** una consulta que detecte la diferencia entre `reserved_quantity` y lo que los `stock_movements` justifican, para saber cuánto hay hoy; **(2)** un camino de reconciliación para lo existente —corrección de datos, con su propia autorización—; **(3)** prueba contra PostgreSQL real de que después de O1 dos confirmaciones concurrentes ya no generan ninguna nueva |
| **Requiere** | Decisión del dueño sobre (2): liberar automáticamente lo huérfano es tocar inventario real de un negocio en operación |

**Verificado contra PostgreSQL real el 02/09.** Base descartable creada sobre
`TEST_DATABASE_URL` con `schema.sql` completo, sentencias **copiadas literal**
de producción, y carreras forzadas de forma determinística: T1 abre
transacción y toma el lock de la fila; T2 emite la suya sin esperarla y queda
bloqueada; recién con el `COMMIT` de T1 reevalúa su predicado. Es la ventana
real de `READ COMMITTED`, no una simulación. **19 chequeos, los 19 con el
resultado esperado.** Esto deja de ser razonamiento sobre el código y pasa a
ser comportamiento observado.

| # | Chequeo | Resultado observado | Qué prueba |
|---|---|---|---|
| E1-a | Dos reservas de 6 sobre stock 10: quién gana | Sólo una | La guarda de disponibilidad **sí** aguanta concurrencia real |
| E1-b | `reserved_quantity` resultante | 6, no 12 | Ídem |
| E2-a | Dos reservas de 3 **de la misma orden** sobre stock 10 | **Las dos ganan** | `ORDER-05`: no hay ninguna clave por orden |
| E2-b | `reserved_quantity` resultante | 6 para una orden que necesita 3 | `ORDER-05` · `INV-ORF-01` |
| E3-a | Dos `order.confirmed` con `event.id` distinto | Los dos insertan | `ORDER-05`: la idempotencia es del evento, no de la orden |
| E3-b | Total financiero de la orden | **2 cargos, $600 sobre una orden de $300** | `ORDER-05` |
| E3-c | El mismo `event.id` reintentado | No duplica | La idempotencia que **sí** funciona |
| E4-a | Primer `OUT` sobre el `order_item_id` | Entra | Consolidación normal |
| E4-b | Segundo `OUT` sobre el mismo `order_item_id` | Rechazado (`23505`) | El índice protege la consolidación |
| E4-c | Consecuencia sobre el stock | Se consolidan 3, **quedan 3 reservados huérfanos** | `INV-ORF-01`: el índice no protege la reserva |
| E5-a | Cancelación concurrente contra la escritura incondicional de `status` | Las dos sentencias afectan una fila | `ORDER-04` |
| E5-b | Estado final de la orden | `CONFIRMED` **con `cancelled_at` puesto** | `ORDER-04`: fila imposible, y consultable como query histórica |
| E6-a | Reserva dentro de una transacción abortada | `reserved_quantity` vuelve a 0 | El rollback funciona |
| E6-b | Reserva + conflicto de índice en la misma transacción | Revierte entera | Ídem, con error real de por medio |
| E7-a | Guarda de ORDER-03-b, orden `CONFIRMED` | No liquida | La guarda hace lo que dice |
| E7-b | Guarda de ORDER-03-b, orden `CANCELLED` | No liquida | Ídem |
| E7-c | `payment_method` tras los dos rechazos | Sigue nulo | No contamina: era el punto del diff |
| E7-d | Guarda de ORDER-03-b, orden `COMPLETED` | Liquida | Camino feliz intacto |
| E7-e | Un `PAYMENT` `PENDING` de la misma orden | **Se liquida igual** | `ORDER-09` **vivo dentro del diff actual** |

El script vive fuera del repositorio (scratchpad de la sesión): verificar no
era autorización para agregar archivos a `src/`. Los tests reales se escriben
en el slice O3, y ahí el criterio sube — `ORDER-05` hay que probarlo **a nivel
de la unidad de negocio** (dos `confirmOrder` concurrentes de la misma orden
produciendo como máximo una reserva efectiva y un CHARGE), no sentencia por
sentencia como acá.

**Decisiones del dueño ya tomadas sobre esta familia (02/09):** quitar
`status` de `UpdateOrderInput` (radio re-verificado: un solo llamador
interno); primitiva única `transitionWithClient` en vez de cuatro
implementaciones paralelas; `409 ORDER_STATE_UNKNOWN` distinto de
`INVALID_TRANSITION`; reintento diferido con techo propio para el caso de
ORDER-13; sellar `confirmed_at` dentro de la primitiva (ORDER-14) **sin
backfill histórico sin fuente confiable**; liquidar por orden **sólo tipo
`CHARGE`**; y **no commitear el diff de ORDER-03-b aislado**.

**Nota de método — desvío declarado de la regla de archivos por fecha.** Estos
hallazgos se descubrieron el 02/09 y se registran acá, en el archivo de esa
fecha, aunque el bloque se escribió después. No se abrió un
`pendientes-2026-09-03.md`: la autorización del dueño para este commit está
limitada **exactamente** a dos archivos, y abrir uno nuevo la excedería. El
próximo archivo de pendientes arrastra esta sección.

### Corrección de una limitación que se venía arrastrando

*"Sin `TEST_DATABASE_URL` en este entorno"* quedó registrado como limitación
en cuatro lugares: los mensajes de `0e0ee9e` y `feb153a`, la revisión del
`architecture-governor` sobre ORDER-03-b, y un comentario de código en
`src/clientes-finanzas/sql.financial-transaction.repository.ts:74`.

**Es obsoleto para este árbol.** La variable está cargada en `.env` y la
suite corre: `npm run test:integration` → **50 tests en verde**, incluidos
dos de concurrencia real. Lo que faltaba era escribir los tests, no el
entorno. Se conserva la historia; deja de valer como estado actual.

**El comentario de código no se tocó en este commit**, a propósito: ese
archivo forma parte del diff sin commitear de ORDER-03-b y este bloque es
documental puro. Se corrige en O2, que reescribe esa misma sentencia.

*(Nota aparte sobre ese comentario: su argumento de fondo tampoco dependía
de `TEST_DATABASE_URL`. Justificaba un guard de aplicación en vez de un
`CHECK` por no poder verificar si alguna fila vieja **de producción** ya
violaba el invariante — y para eso `TEST_DATABASE_URL`, que apunta a un
branch vacío, nunca habría servido. La decisión sigue siendo correcta; la
razón escrita, no.)*

---

## 🔄 Actualizado hoy — el estado cambió

### FISCAL-CBTE-001 — reformulado: el HOLD del documento se dividió

El hallazgo de código **no cambió** — re-verificado hoy: `cbteTipo` sigue
fijo en `CBTE_TIPO_FACTURA_B` en los tres puntos de emisión
(`invoice.service.ts:368`, `:466`, `:540`; antes solo se citaban los dos
primeros).

**Lo que sí cambió es el estado del documento que lo analiza.**
`docs/diseno-fiscal-profile-resolver-2026-09-01.md` — antes: "análisis y
diseño, HOLD". Ahora, tras `f6b24aa`: **HOLD de diseño levantado; HOLD de
implementación vigente**, sujeto a autorización específica y separada. La
hipótesis `[H]` sobre `getIvaReceptorTypes()` sigue sin confirmar, sin
cambios — depende de un certificado ARCA real, no de esta reconciliación.

**Nota para evitar colisión futura:** el Bloque 0 de D+A también toca
`invoice.service.ts` (`requestInvoice()`), pero para un problema distinto
—elegibilidad por tipo/estado del movimiento, no selección de letra de
comprobante—. La especificación de D+A ya declaró esta restricción de
diseño explícitamente (guarda de entrada previa e independiente del
branching de comprobante) para no estorbar al resolver fiscal cuando ese
bloque se autorice.

### Gap C1-C — clasificación de dependencia agregada por D+A

Ancla re-verificada hoy: los dos `JOIN` (no `LEFT JOIN`) de
`sql.invoice.repository.ts:108` (`getOutstandingByCustomerId`) y `:133`
(`getByReservationId`) siguen descartando en silencio las facturas
consolidadas (`financial_transaction_id` nulo). Sin cambios de código.

**Lo que se agrega:** la especificación de D+A lo clasificó formalmente
como **precondición bloqueante del Bloque 1b** (no del Bloque 0 ni del
1a) — el Bloque 1b necesita agregar el término de restitución de saldo en
esas mismas líneas, y hacerlo sobre un `JOIN` que ya descarta filas
produciría una conciliación parcialmente correcta sin señal. **No entra al
alcance de D+A por estar conectado** — sigue siendo su propio pendiente,
con su propia autorización.

**Sin exposición hoy** — sin cambios: las 11 facturas de la base son de
homologación.

### CONTRACT-001 — nueva dependencia: precondición del paso 3 de idempotencia de D+A

Sin re-verificación de fondo hoy (no se tocó código de contrato/OpenAPI).
**Lo que se agrega:** D+A necesita descartar consumidores externos del
endpoint de cobro antes de autorizar el rechazo duro por falta de clave de
idempotencia (paso 3 de la transición, ver contexto de sesión). Sin
`CONTRACT-001` resuelto, ese paso no se puede autorizar — es la misma
brecha, con un consumidor concreto nuevo.

---

## 🔴 Abierto — arrastrado del 01/09

Detalle completo en `pendientes-2026-09-01.md`. Esta sección distingue dos
estados que **no son lo mismo** y no deben leerse como equivalentes:

### Re-verificados hoy, confirmados abiertos con evidencia fresca

- **DOC-ANCLA-001** — `docs/rbac-matriz-endpoints.md:9` sigue citando `src/tests/governance/rbac-matrix-sync.test.ts` (no existe); el archivo real está en `src/tests/security/` (línea 56 del mismo documento ya lo dice bien — la contradicción interna sigue sin resolver). Confirmado con `ls`/`grep` hoy.

*(`FISCAL-CBTE-001`, `Gap C1-C` y la mitad "hallazgo de código" de las secciones de arriba también fueron re-verificados hoy — están en "Actualizado hoy" para no duplicar la entrada.)*

### Arrastrados sin re-verificación — continuidad, no nueva evidencia

**No se inspeccionaron en esta ronda.** Su estado se conserva porque nadie
lo cerró ni lo tocó, no porque se haya vuelto a comprobar hoy. No leer esta
lista como "auditada de nuevo".

- **RBAC-SYNC-001** (mitad abierta) — nada verifica la sección 4 de la matriz contra `PUBLIC_ROUTES` del test.
- **RBAC-MOUNT-001** (mitad abierta) — ninguna cerca valida el orden de montaje de `src/app.ts`.
- **FACT-BORRADOR-001** — diseño de factura como borrador editable, v2.8, **en HOLD** — documento distinto (`diseno-factura-borrador-2026-08-31.md`), no tocado por `f6b24aa`, sin matices nuevos.
- **SEC-ROT-001** — `DB_ENCRYPTION_KEY` sin procedimiento de rotación.
- **RBAC-OWN-001** — ownership dentro de un tenant sin guard ni test negativo.
- **C3** — líneas de factura: falta backend **y** pantalla de detalle.
- **C1-Fase A** — CRUD de `deposit_policies`. Backend inexistente, 3 decisiones del dueño abiertas.
- **D7** — reportes POS/CRM: 2 paneles CRM libres, 3 POS condicionados a `useModuloVisible('POS_RESTAURANTE')`.
- **C2** — "Cancelar reserva" no usa el preview/confirm de reembolso.
- **Frontend visual:** SEM-001, SEM-002, TOAST-003, A11Y-001, 6 overlays de Superadmin. Última verificación al número de línea: 01/09, no hoy.
- **Backend/infra:** prueba E2E del Outbox (la corre el dueño), FAILOPEN-001.
- **Deuda activa:** rate plans no reutilizables entre servicios (`service_id NOT NULL` abierto), `resource_locks` sin categoría.
- **Heredados:** Redis rate-limit, BullMQ, etapas 2-3 de downgrade, C1-Fase B (bloqueada hasta que el negocio elija proveedor), datos demo en la base real.

### Sin arrastrar — requiere decisión del dueño antes de reescribirse

- **RBAC — mecanismos 1 y 2** — el propio archivo del 01/09 ya lo marcaba
  "⚠️ fila sin referente, requiere la memoria del dueño o se borra". Por la
  regla 1 de `CLAUDE.md` ("un ítem sin referente no se arrastra: se
  reescribe o se borra"), **no se copia a este archivo tal cual**. Queda
  pendiente que el dueño provea el referente (qué son los "mecanismos 1 y
  2") para reescribirlo, o confirme que se borra definitivamente.

### Histórico, no activo

- **D6 → D6-FRONTEND-001 → cerrado.** `D6` (línea original del 31/08, "UI
  pura, confirmado") quedó **superado/reemplazado** por `D6-FRONTEND-001` el
  01/09 al descubrirse que no era UI pura (brecha RBAC:
  `RECEPTIONIST` sin `MANAGEMENT`). `D6-FRONTEND-001` se cerró hoy con
  evidencia — ver el marcador ✅ RESUELTO (02/09/2026) in-place en
  `pendientes-2026-09-01.md`, sección "🔴 Abierto — encontrado hoy
  (01/09/2026)". **No es un pendiente activo**, pero la
  cadena de sustitución —motivo, sucesor, evidencia de cierre— se conserva
  acá a propósito: un ítem reemplazado no se deja huérfano.

---

## Nota de método

Esta reconciliación no volvió a auditar de punta a punta los 13 ítems
arrastrados del 31/08 vía `pendientes-2026-09-01.md` — eso es el trabajo de
`docs/erp-auditoria-v2/` (todavía sin versionar, ver `AUDIT-DOC-001`), no el
de un archivo de pendientes diario. Se re-verificaron con evidencia fresca
los ítems directamente cruzados contra `f6b24aa` y contra la especificación
de D+A de esta sesión; el resto se conserva con la misma disciplina que ya
usaba el archivo anterior — declarado, no asumido.
