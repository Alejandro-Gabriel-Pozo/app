# ADR — cerrar la ventana reintento-de-factura vs. reversa (`ISSUE-BEFORE-REVERSE-WINDOW-001`)

**Fecha:** 23/09/2026. **Estado (ronda 11, propuesta — pendiente de verificación por el gate
`architecture-governor`; ver Historial de revisión, entradas ronda 9, ronda 10 y ronda 11): 1 y 2a
están COMMITEADOS (ver "Estado real del código" más abajo) — **C5 ya está satisfecha, no queda
pendiente** (`DUPLICATE-CAE-001`, `d55d08a`, commiteado antes que 2a, `3216849`; §5 exige releer
`retryExisting()` sobre ese diff real antes de tocar los mismos dos archivos, ya verificado al
implementar 2a). 2b sigue en el working tree, gate propio en paralelo, fuera de alcance de esta
ronda. **3 y 4 siguen en HOLD — esta ronda 11 CORRIGE lo que la ronda 10 del gate encontró mal en
la propuesta de ronda 9 para esos dos bloques (ver el veredicto completo citado en el Historial,
entrada ronda 10) y diseña la extensión de §3.14 (P-1, "AFIP prevalece") a partir de una decisión
de negocio NUEVA del dueño tomada en esta sesión (ver más abajo); no vuelve a diseñar 3/4 de
cero.**

**Estado real del código (corregido en esta ronda, P2(b) — el encabezado de la ronda 6 seguía
diciendo "Bloques 2a-2b: diseño listo, sin código todavía" y "sin código en ninguno de los 6" pese
a que 1 y 2a ya estaban commiteados, sin que nadie lo hubiera actualizado):** Bloque 1
(`getAllLinkedInvoicesWithClient()` + guard 8-bis de `reverseTransfer()` fila por fila) está
COMMITEADO (`bcba224`). Bloque 2a (columna `pending_since` + backfill + escritores nuevos
actualizados, sin el CHECK todavía) está COMMITEADO (`3216849`). Bloque 2b (el CHECK
`chk_invoices_pending_since` + backfill inverso) está IMPLEMENTADO en el working tree, con su
propio gate de pre-commit corriendo EN PARALELO a este — no se toca ni se revisa en esta ronda.
Bloques 3 y 4: diseño corregido en ronda 7, otra vez en ronda 9, y otra vez en ronda 11 (este
cambio), **sin código todavía**. 2c/5/6: sin cambios de esta ronda — 2c en HOLD por N7, 5 depende
de 2c, 6 no revisado salvo el `motivo` nuevo de §3.10 (documentado, no implementado).

**Corrección (ronda 14, ver Historial de revisión más abajo) — todo este encabezado (líneas 3-25)
quedó stale y no se reescribe de nuevo por la misma razón que P2(b) ya señaló sobre el de ronda 6:
otra foto fija con fecha de vencimiento repite el mismo modo de falla. Estado real: ver "Historial
de revisión" (entrada más reciente) y `git log`/`git status` — no esta sección.** En particular:
Bloque 2b ya NO está "corriendo en paralelo" — está COMMITEADO (`2c9b423`). Bloque 3 ya tiene
código (revisado y aprobado por el gate de pre-commit, ver entrada ronda 14) — la frase "sin código
todavía" de arriba quedó desactualizada apenas se implementó.

**Dos decisiones de negocio del dueño (`AskUserQuestion`, esta sesión — reemplazan el criterio de
"reconciliar y auto-cerrar" que tenía la propuesta de la ronda 6 para §3.9, "Resolución de
ubicación A"):**
1. **Conflicto de estado de NC** (el operador declara en la bandeja de reconciliación manual un
   desenlace que CONTRADICE el estado real de la factura — ej. declara `NO_EMITIDA` pero AFIP ya
   la emitió de verdad): **"Rechaza y deja abierta"** — el sistema devuelve el estado real al
   operador (409) y `credit_note_request` queda abierta para que la vuelva a confirmar con el dato
   correcto. NO se auto-cierra con una corrección silenciosa.
2. **Discrepancia de CAE** (el operador declara `EMITIDA` con un número de comprobante/CAE que
   DIFIERE del que ya está registrado en la factura — posible error de tipeo, o dos comprobantes
   AFIP reales): **"Rechaza, queda para revisión fiscal"** — tampoco se auto-cierra; rechaza la
   resolución y la deja visible en el reporte de reconciliación (d, §3.10) para que un humano la
   revise, en vez de cerrarla como si nada hubiera pasado.

Resumen de las resoluciones corregidas (detalle completo en §3.9 y en el Historial de revisión,
entrada ronda 7): **ubicación A** — el guard de status de `markIssuedWithClient()`
(`WHERE ... AND status <> 'ISSUED'`, `InvoiceAlreadyIssuedError`, 409) queda ACOTADO al camino
AUTOMÁTICO (`finalizeIssued()`); el camino MANUAL (`resolveCreditNoteRequestManually()`, rama
`EMITIDA`) escribe por un método nuevo con un predicado ESTRICTO, espejo exacto del que N6 ya le
dio a `markUncertainClearedWithClient()` (hueco A-2, la ronda 6 aplicaba el mismo guard ancho a
las dos llamadas — incorrecto). Cuando ese predicado estricto no matchea (alguien más ya decidió
el desenlace real de la factura), el método reclasifica bajo lock —factura primero, solicitud
después— y aplica las dos decisiones de arriba: cierra sin volver a escribir SOLO si el desenlace
declarado COINCIDE con la verdad real (idempotente, ya no hace falta ningún prefijo sintético en
`resolutionNote`); si DIFIERE, rechaza sin cerrar. **ubicación B** — sin cambios de mecanismo
respecto a la ronda 6 (el rechazo de `retryExisting()` sobre una factura `PENDING` sigue naciendo
en el Bloque 4 como guard de solo lectura, reusado sin redefinir por 2c): lo que corrige esta
ronda es una afirmación FALSA sobre esa misma resolución (P2(a), ver el párrafo siguiente), no el
mecanismo en sí.

**Corrección P2(a) — afirmación falsa presente en la propuesta de la ronda 6, en cuatro lugares
(§3.2, §3.7, el bullet de 2c en §6, y el Historial): decía que la rama "sin fila" de la toma
exclusiva de 2c es "defensa en profundidad redundante, no la primera línea" y "no alcanzable en la
práctica" para `retryExisting()`. ES FALSO, corregido en los cuatro lugares en este mismo cambio:
dos `retryExisting()` concurrentes sobre una fila `REJECTED` (o `FAILED_UNCERTAIN` limpiada) leen
ese status, no `PENDING` — así que el guard de Bloque 4 (que solo mira `existing.status ===
'PENDING'`) no bloquea a NINGUNA de las dos, y la rama "sin fila" del `UPDATE ... RETURNING` de 2c
es la ÚNICA protección real contra ese doble click, no una capa redundante. El propio §7 ya tiene
un test para exactamente este caso ("Doble click: dos `retryExisting()` concurrentes... el otro
recibe 409"), que contradecía el texto que lo rodeaba.**

Otras correcciones de esta ronda, alcance autorizado por el gate — solo documentación (ver
Historial, entrada ronda 7, para el detalle completo): la política de `finalizeIssued()` cuando su
propio guard de status salta (P3 — cuatro caminos alcanzables, no solo el que asumía la ronda 6);
cuatro ubicaciones nuevas del Bloque 3 (A-2, resumida arriba; A-3, bug previo y vivo, independiente
de este ADR, registrado en `docs/pendientes-2026-09-12.md`; A-4, la reconciliación tiene que mirar
también el estado de la SOLICITUD, no solo el de la factura; A-6, callejón sin salida de la
bandeja `/uncertain`); cuatro correcciones de texto en la ubicación B (B-1 a B-4, ver §6/§3.7/§7).

**Bloque 1 implementado** (pre-commit gate aprobado con las condiciones C1-C4 de esa ronda ya
aplicadas): `getAllLinkedInvoicesWithClient()` + guard 8-bis de `reverseTransfer()` reescrito fila
por fila.
**Hallazgo que cierra:** `WAVE13-ZONA2-CONSOLIDATED-RETRY-ISSUE-BEFORE-REVERSE-WINDOW-001`
(`docs/pendientes-2026-09-12.md`). **No se une con** `WAVE13-ZONA2-CONSOLIDATED-RETRY-DUPLICATE-CAE-001`
(hallazgo hermano, mismo archivo, gate separado en curso) — comparten la raíz (un cargo con
más de una factura ligada) y el mismo punto de entrada (`retryExisting()`, antes de `issue()`),
pero son mecanismos distintos. Ver §5 (secuencia).

**Dos decisiones de negocio NUEVAS del dueño (`AskUserQuestion`, esta sesión, ronda 9 — desbloquean
dos preguntas que quedaban abiertas en el texto de ronda 7):**

1. **Salida para una factura `CHARGE`, o una NC con solicitud ya `CERRADA`, que quedó
   `FAILED_UNCERTAIN` cuando AFIP en realidad SÍ emitió el comprobante (P-1):**
   **"Reconciliar contra AFIP"** — el sistema consulta el comprobante real contra AFIP mismo
   (`getVoucherInfo()`, ver §3.14) en vez de que el operador tipee un CAE a mano. Elimina el riesgo
   de tipeo/discrepancia que motivó la decisión 2 de ronda 7 (arriba) para el caso en que existe
   una salida más segura: la fuente de verdad es AFIP, no lo que el operador recuerda o copia mal.
   Mecanismo nuevo, ruta nueva (§3.14), mismo RBAC que el resto de esta bandeja
   (`Roles.EMISOR_NOTA_CREDITO`).
2. **Guard raíz de A-3, acotado al alcance de este ADR (P-2):** **"Exigir `EN_REVISION_MANUAL` para
   resolver"** — `POST /credit-note-requests/:id/resolve` (`resolveCreditNoteRequestManually()`)
   exige ahora, bajo lock, que `credit_note_request` esté en `EN_REVISION_MANUAL`; una solicitud
   todavía `PENDIENTE` se rechaza con 409 (`CreditNoteRequestNotInManualReviewError`, ver §3.9,
   "P-2"). Cierra, PARA ESTE call-site puntual, la mitad operativa de A-3 que A-2 (ronda 7) no
   cerraba — A-2 ya impedía la CORRUPCIÓN de dato (ver §3.9, "P-2"), pero un intento prematuro
   seguía terminando en un 500 genérico (`InvoiceReconciliationUnexpectedStateError`) en vez de un
   409 correctamente clasificado. NO es el arreglo completo de A-3 (`ALLOWED_CREDIT_NOTE_REQUEST_TRANSITIONS.PENDIENTE`
   sigue permitiendo `PENDIENTE -> CERRADA` en el tipo, y `POST /resolve` sigue siendo el único otro
   caller de `transitionWithClient()` fuera del camino automático — ver `CREDIT-NOTE-REQUEST-PENDIENTE-RESOLVE-GUARD-001`
   en `docs/pendientes-2026-09-12.md`, narrowed en esta ronda) — decisión explícita del dueño de
   acotar el alcance a este call-site, no a la máquina de estados entera.
   **Precisión de alcance (ronda 11, residuo #3 del veredicto de ronda 10 del gate):** P-2 rechaza
   una resolución mientras `credit_note_request` SIGA `PENDIENTE` en el instante en que esta
   reclasificación toma su propio lock sobre la solicitud (§3.9, "Por qué P-2 no necesita invertir
   el orden de locks") — no es una garantía de que TODO desenlace de la carrera termine
   específicamente en el 409 de P-2: una solicitud que arranca `PENDIENTE` puede perder esa carrera
   contra el camino automático ANTES de que este lock se tome, y en ese caso termina resuelta por
   N-2 (§3.9) con el mismo desenlace correcto (409, sin corromper nada) por un camino distinto —
   ver la corrección de ronda 11 en §3.9, "Reevaluación de alcance tras P-2". La solidez de P-2
   (que ninguna resolución corrompa un CAE real) depende de que los 3 escritores que llevan una
   factura a `FAILED_UNCERTAIN` ambiguo transicionen `credit_note_request` a `EN_REVISION_MANUAL`
   en la MISMA transacción que la factura — verificado en código HOY para
   `issue()`/`reconcileAfterFailure()`, pero **todavía un REQUISITO de implementación, no un hecho
   verificado, para el `UPDATE` del worker de §3.3 (Bloque 4), que no tiene código todavía** — la
   condición de test obligatoria vive en la sección del Bloque 4 en §6, no duplicada acá.

**Una decisión de negocio NUEVA del dueño, ronda 11 (`AskUserQuestion`, esta sesión) — extiende
P-1, no lo reemplaza:**

3. **"AFIP prevalece" — qué hace `reconcile-with-afip` (§3.14) cuando encuentra un comprobante AFIP
   real para una factura que el operador YA declaró `NO_EMITIDA` a mano** (`uncertain_cleared_at`
   poblado, factura otra vez reintentable por `retryExisting()`): **el comprobante real de AFIP
   GANA** — se escribe y la factura pasa a `ISSUED` con el comprobante real, sin importar la
   declaración manual `NO_EMITIDA` previa. Cierra el hueco #5 del veredicto de la ronda 10 del gate
   (el diseño de ronda 9 dejaba este caso como un 500 sin mapear, en silencio, para esa
   combinación puntual de estados). AFIP es, en este ADR, la fuente de verdad más fuerte que
   existe — más que un CAE tipeado a mano (camino puramente manual) y más que una declaración
   `NO_EMITIDA` también tipeada a mano — ver §3.14, sección "AFIP prevalece sobre una declaración
   manual previa", para el mecanismo completo (predicado extendido, escritor nuevo y exclusivo de
   este caso, por qué NO se comparte con el camino puramente manual de
   `resolveCreditNoteRequestManually()`, que sigue rigiéndose por la decisión 1 de ronda 7 —
   "rechaza, no auto-cierra" — para las discrepancias que el operador declara a mano sin
   verificación independiente).

## 1. El problema

`retryExisting()` (`invoice.service.ts`, ver su propio docblock) re-valida bajo lock el estado
que el guard fresco protegía (`assertChargesStillInvoiceable()`), COMMITEA esa transacción, y
recién DESPUÉS llama a AFIP — con la factura todavía en `REJECTED` (o `FAILED_UNCERTAIN`
limpiada) en ese momento. Si `AccountsReceivableService.reverseTransfer()` toma el lock de la
AR y commitea una reversa DURANTE esa ventana, el retry puede terminar marcando la factura
`ISSUED` con un CAE real sobre un cargo cuya AR ya quedó `REVERTIDO`.

El camino FRESCO no tiene este problema: `createWithClient()` inserta la fila con
`status: 'PENDING'` ANTES de llamar a AFIP, dentro de la misma transacción que el guard, y el
guard 8-bis de `reverseTransfer()` ya respeta ese marcador. El reintento es el único camino que
no lo hace.

## 2. Grounding y decisión de mecanismo (ya cerrado, no reabrir)

`auditor-circuitos-erp` (22/09/2026): 4 de 5 sistemas de referencia (Odoo, Frappe/india_compliance,
Cloudbeds) bloquean la operación opuesta mientras el documento está "en vuelo", nunca de forma
terminal — con salida humana. El candidato "lock sostenido durante la llamada de red" (Odoo 16)
se descarta — ya rechazado por este mismo ADR de City Ledger (`docs/diseno-reconciliacion-city-ledger-2026-09-12.md`
§2.1) y por el grounding (costo de conexión de pool).

Decisiones del dueño (`AskUserQuestion`, 22-23/09/2026, todas confirmadas):

- **Mecanismo:** marcar la factura "en vuelo" DENTRO de la transacción del guard del reintento
  (mismo patrón que el camino fresco), con salida humana para el caso colgado.
- **Liberación de un marcador colgado:** vencimiento automático por tiempo + salida manual
  disponible antes de eso (aplica a los DOS caminos, fresco y reintento).
- **Reporte de reconciliación:** se agrega como complemento, no reemplaza 1-2.
- **Desbloqueo del guard 8-bis tras `NO_EMITIDA` manual:** el guard respeta `uncertainClearedAt`
  — si está poblado, deja de bloquear (mismo criterio que `retryExisting()` ya usa para no
  reintentar una `FAILED_UNCERTAIN` limpiada).
- **RBAC del reporte (d):** `MANAGEMENT` (mismo nivel que el resto de `accounts-receivable`).
- **Alcance NC:** los reintentos de Nota de Crédito (`REFUND`/`ADJUSTMENT`) llevan la misma
  marca "en vuelo" que `CHARGE` — no queda un hueco simétrico sin resolver.
- **Salida antes del vencimiento automático (`AskUserQuestion`, ronda 2 del gate):** NO existe —
  mientras la marca esté fresca (dentro de la ventana de `N`), cualquier reintento nuevo se
  rechaza con 409 sin excepción. La única salida es esperar el vencimiento automático (o que el
  intento en curso resuelva solo). No hay un "Force Unlock" manual antes de eso — se descarta a
  propósito el riesgo de que un operador libere la marca mientras la llamada a AFIP sigue
  realmente en curso, que reabriría la ventana que este bloque entero viene a cerrar.
- **RBAC de la salida manual para `CHARGE`** (`AskUserQuestion`, ronda 2 del gate):
  `Roles.EMISOR_NOTA_CREDITO` — mismo grupo que su endpoint hermano de NC
  (`POST /credit-note-requests/:id/resolve`), por consistencia operativa (misma naturaleza de
  decisión: "confirmé contra AFIP que no hay CAE real"), aunque el nombre del grupo tenga
  semántica de Nota de Crédito y esta ruta cubra `CHARGE`.

Este documento diseña el CÓMO de esas 8 decisiones. Ronda 1 de este ADR (22/09/2026) volvió con
HOLD del gate — 9 huecos reales encontrados. Ronda 2 (23/09/2026) volvió con HOLD otra vez sobre
el documento corregido — 8 huecos nuevos, esta vez en el propio texto del ADR (una firma que no
alcanza a hacer lo que el resto del documento le pide, un predicado de toma exclusiva que no
excluía nada en la práctica, un worker que nunca iba a actuar por precisión de timestamps, y
consumidores del método compartido sin analizar). Esta es la versión que responde a esa ronda.
No se reabre el mecanismo (§2 de arriba ya está cerrado), solo se completa el diseño técnico.

## 3. Huecos encontrados en la ronda 1 y su resolución

### 3.1 El guard 8-bis no bloquea siempre (hueco #1 del gate, corregido ronda 2)

`resolveInvoiceLinkage()` (`sql.invoice.repository.ts`) devuelve UNA sola fila
(`ORDER BY (status = 'ISSUED') DESC, id LIMIT 1`) cuando un cargo tiene más de una factura
ligada — caso alcanzable hoy (una consolidada `REJECTED` no bloquea que el mismo cargo se
facture individual, y viceversa; ver el docblock de `getInvoicedFinancialTransactionIds()`).
El caso concreto que el guard pierde HOY (antes de este bloque, sin necesitar el bloque 2
todavía): una consolidada `REJECTED` + una individual fresca `PENDING` sobre el mismo cargo (o
una `ISSUED` reconciliada + otra factura `PENDING`) — el guard puede quedarse mirando la fila
equivocada y dejar pasar la reversa mientras la OTRA factura sigue viva o en vuelo.

**Ronda 1 proponía un booleano (`hasLiveOrInFlightInvoice()`). Incorrecto — el gate lo marcó
como regresión real:** el guard 8-bis de hoy no es un solo predicado sobre el conjunto de
facturas ligadas, es una evaluación FILA POR FILA con reglas distintas según el status
(`accounts-receivable.service.ts`, dentro de `reverseTransfer()`):

| Status de la factura ligada | ¿Bloquea reverseTransfer() hoy? |
|---|---|
| `ISSUED` | Sí, salvo que `classifyReservationLiveInvoice()` la reconozca como ya cubierta por NC |
| `PENDING` | Sí, siempre |
| `FAILED_UNCERTAIN` con `afipContacted = true` | Sí |
| `FAILED_UNCERTAIN` con `afipContacted = false` | **No** |
| `REJECTED` | No |

Un `EXISTS` sobre `INVOICE_STATUSES_CONSUMING_CHARGE` (que incluye `FAILED_UNCERTAIN` sin
distinguir `afipContacted`) empezaría a bloquear el caso `FAILED_UNCERTAIN` con
`afipContacted = false` — una reversa que HOY está permitida, y que no tiene salida propia (nadie
la lista, y la única forma de destrabarla sería reintentar, es decir contactar AFIP). Eso es
peor que el problema que este bloque viene a cerrar, no se hace.

**Resolución corregida — NO tocar `resolveInvoiceLinkage()`** (mismo argumento de blast radius
que la ronda 1 — 9 call-sites de producción verificados en código esta sesión:
`accounts-receivable.service.ts:364,529,611,872`, `order.service.ts:421`,
`reservation.service.ts:950`, `cancel-order-with-credit-note.service.ts:216`,
`cancel-reservation-with-credit-note.service.ts:262`, `invoice.service.ts:577` — confirmado por
el gate en la ronda 2, corrige el "8" de la ronda 1), **pero el método nuevo devuelve TODAS las
filas ligadas, no un booleano**, y recibe `client` (corre dentro de la transacción de
`reverseTransfer()`, no en una conexión separada del pool — evita sumar otra instancia de
`CITY-LEDGER-AR-NESTED-CONN-001`):

```ts
/**
 * Guard 8-bis de reverseTransfer() ÚNICAMENTE -- a diferencia de
 * resolveInvoiceLinkage() (que devuelve LA MEJOR fila, LIMIT 1, cuando
 * hay más de una), esta devuelve TODAS las filas ligadas al cargo -- el
 * guard 8-bis necesita evaluar cada una con su propia regla (ver tabla
 * del ADR ISSUE-BEFORE-REVERSE-WINDOW-001 §3.1; un booleano agregado
 * pierde esa distinción y produce una regresión real). Mismo UNION ALL
 * (invoices directo + invoice_charges) que resolveInvoiceLinkage(), sin
 * ORDER BY/LIMIT.
 */
getAllLinkedInvoicesWithClient(
  client: SqlClient,
  financialTransactionId: string,
): Promise<Array<{ id: string; status: InvoiceStatus; afipContacted: boolean; uncertainClearedAt: Date | null }>>;
```

**Corrección al implementar el bloque 1 (pre-commit, no cambia el diseño):** la firma REAL del
bloque 1 omite `uncertainClearedAt` — ese campo solo hace falta para el ajuste de §3.8
(`uncertainClearedAt == null` en la condición de bloqueo), que es del bloque 2c, no de este. El
bloque 1 devuelve `Array<{ id, status, afipContacted }>`, sin ese campo; se agrega recién cuando
se implemente el bloque 2c.

Guard 8-bis: por cada fila devuelta, aplica exactamente la tabla de arriba (más el ajuste de
`uncertainClearedAt` de §3.8, que entra en el bloque 2, no en este). Si CUALQUIER fila bloquea,
rechaza con `ArReversalRequiresCreditNoteError` (422) — este bloque no introduce el error 409
nuevo (eso es §3.7/§3.2, bloque 2); mantiene el comportamiento y el tipo de error actuales,
fila por fila, en vez de por una sola fila elegida arbitrariamente.

**Dos precisiones confirmadas por el gate en la ronda 3, verificadas contra
`accounts-receivable.service.ts:871-885`:**
- Una fila `ISSUED` bloquea también cuando `charge.reservationId` es `null` — en ese caso el
  código cae directo a `'NOT_RECONCILED'` sin llamar a `classify*` (no hay entidad contra la
  cual reconciliar). La tabla de arriba lo resume como "salvo que `classifyReservationLiveInvoice()`
  la reconozca como cubierta" — precisamente ese caso es uno de los dos en que NO se llega a
  llamarla.
- `classifyReservationLiveInvoice()` evalúa la RESERVA, no la fila de factura — da el mismo
  resultado para cualquier fila `ISSUED` del mismo lote. Se llama como mucho una vez (si hay
  alguna fila `ISSUED` con `reservationId`), no una vez por fila `ISSUED` — los tests existentes
  que cuentan `classifyCalls` siguen esperando como máximo 1 llamada.

**Cambio de comportamiento intencional, declarado (fail-closed):** con una sola fila el guard de
hoy y el de este bloque coinciden siempre. Con más de una fila, el guard de hoy podía elegir la
fila "equivocada" y dejar pasar una reversa que debía bloquear (el hueco de arriba); el de este
bloque bloquea si CUALQUIERA de las filas bloquea. El cambio va en una sola dirección — el guard
se endurece, nunca se afloja — así que no hay riesgo de bloquear una reversa que hoy pasa
correctamente.

**Corrección de deriva en la interfaz existente** (encontrada por el gate, no introducida por
este bloque): el docblock de `resolveInvoiceLinkage()` en `invoice.repository.ts` dice
`ORDER BY created_at DESC` y "no debería haber más de una fila" — el SQL real ordena por `id`, y
el propio código reconoce (comentario en `sql.invoice.repository.ts`, `resolveInvoiceLinkage()`)
que más de una fila SÍ es alcanzable. Se corrige ese docblock en el mismo commit del bloque 1,
sin cambiar el método en sí.

### 3.2 La marca "en vuelo" necesita toma exclusiva (hueco #2, corregido ronda 2)

Sin una toma exclusiva, dos reintentos concurrentes sobre la misma factura (doble click, dos
requests) pasan los dos por `PENDING` y llaman los dos a `createNextVoucher()` — dos CAE reales,
el segundo `markIssued()` pisa al primero sin condición.

**Ronda 1 tenía dos defectos reales, marcados por el gate:**
1. El precedente citado ("mismo patrón optimista que ya usan los `markXWithClient()`
   existentes") no existe — `markIssuedWithClient()`/`markFailedWithClient()` actualizan con
   `WHERE id = $1` sin condición de status, no hay ningún patrón optimista previo en este
   archivo. Este bloque lo introduce, no lo reusa.
2. El predicado `WHERE status = $2` (el status observado al leer `existing`, FUERA de la
   transacción) tiene una ventana propia: entre esa lectura y la toma, la fila puede haber
   pasado a `FAILED_UNCERTAIN` con `afipContacted = true` y luego haber sido limpiada
   (`uncertainClearedAt` poblado, ver §3.5) — un predicado que solo mira el status observado
   antes no refleja la reintentabilidad real en el momento de la toma.

**Resolución corregida:** el predicado de la toma no usa el status leído afuera — codifica la
condición completa de reintentabilidad, evaluada en el momento del `UPDATE`:

```sql
UPDATE invoices
   SET status = 'PENDING', pending_since = NOW()
 WHERE id = $1
   AND (
     status = 'REJECTED'
     OR (status = 'FAILED_UNCERTAIN' AND (NOT afip_contacted OR uncertain_cleared_at IS NOT NULL))
   )
 RETURNING id
```

Si `RETURNING` no devuelve fila, alguien más ya tomó el reintento, o la factura ya no es
reintentable por otro motivo (`ISSUED`, o `FAILED_UNCERTAIN` sin limpiar) — se rechaza con el
error 409 nuevo de §3.7.

**Dónde corre — dentro de la MISMA transacción que los locks de AR de
`assertChargesStillInvoiceable()`, no "adyacente" a ella** (la ronda 1 decía "adyacente", el
gate lo marcó insuficiente): es lo único que serializa la toma contra `reverseTransfer()`, que
también lockea la AR primero. Si la toma corriera en una transacción separada, hay una ventana
entre el commit de los locks de AR y el commit de la toma donde `reverseTransfer()` podría
intercalarse.

**Qué hace `retryExisting()` cuando encuentra la factura YA `PENDING`** (residuo señalado por el
gate, decisión del dueño ya confirmada en §2): un `PENDING` fresco no matchea ninguna rama del
`WHERE` de arriba (no es `REJECTED` ni `FAILED_UNCERTAIN`), así que el `UPDATE` no devuelve fila y
el reintento se rechazaría con 409 sin excepción, sin importar si el `PENDING` es propio (otro
reintento en curso) o del camino fresco. **Movido a Bloque 4 (ronda 6, ver Historial de revisión,
ubicación B) — este `WHERE` ya no es quien produce ESE caso puntual (`PENDING` ya asentado) en la
práctica:** desde Bloque 4, `retryExisting()` corta ANTES de llegar acá con un guard de solo
lectura sobre `existing.status === 'PENDING'` (§3.7 y §6), así que un `PENDING` YA ASENTADO (el que
el guard de Bloque 4 puede ver, porque está en el `existing` que se leyó al principio del método)
no llega vivo hasta esta transacción por el camino de `retryExisting()`. **Corrección P2(a),
ronda 7, terminología corregida otra vez en ronda 9 (residuo de la ronda 8 del gate: la sustancia
ya estaba bien desde ronda 7, la descripción seguía llamándolo "la rama `PENDING`" cuando el
`WHERE` de arriba NO TIENE esa rama — solo tiene `REJECTED`/`FAILED_UNCERTAIN`) — el caso "sin
fila" de este `UPDATE ... RETURNING` NO es defensa en profundidad redundante para
`retryExisting()`, sigue siendo la primera línea para el caso que el guard de Bloque 4 no puede
ver por construcción:** el guard de Bloque 4 lee `existing.status` UNA vez, antes de abrir esta
transacción — dos `retryExisting()` concurrentes sobre la MISMA fila `REJECTED` (o
`FAILED_UNCERTAIN` limpiada) leen los dos ese status, no `PENDING`, así que el guard de Bloque 4
no bloquea a NINGUNA de las dos y las dos llegan hasta acá. Lo que decide cuál de las dos gana es
el LOCK de fila que el propio `UPDATE` toma: la primera en tomarlo matchea `REJECTED`/
`FAILED_UNCERTAIN`, escribe `status = 'PENDING'` y libera el lock al commitear; la segunda,
que estuvo esperando ese lock, lo obtiene recién después, re-evalúa su propio `WHERE` contra la
fila YA `PENDING` (el estado que dejó la primera) — ninguna de las dos ramas del `WHERE` matchea
un status `PENDING`, así que su `UPDATE` no devuelve ninguna fila ("sin fila") y esa transacción
es la que se rechaza con el 409 nuevo (§3.7). Es el mecanismo de toma exclusiva — nada en el
`WHERE` menciona `PENDING` explícitamente; es la CONSECUENCIA de que, una vez que la primera
transacción ya escribió `PENDING`, ninguna rama vuelve a matchear — la ÚNICA protección real
contra ese doble click. Sin este mecanismo (si la toma no tomara el lock de fila de forma
exclusiva, p. ej. dos `UPDATE`s corriendo contra copias en lecturas separadas), las dos
transacciones podrían matchear la misma rama `REJECTED`/`FAILED_UNCERTAIN` del `WHERE` y las dos
ganarían la toma, llamando las dos a `createNextVoucher()`. Es exactamente el caso que el test de
§7 ("Doble click: dos `retryExisting()` concurrentes... el otro recibe 409, caso 'sin fila'")
verifica. No hay liberación manual antes del vencimiento automático (decisión confirmada en §2) —
la única salida es esperar.

### 3.3 El worker necesita UPDATE condicionado (hueco #3, primera mitad — corregido ronda 2)

Un `UPDATE ... SET status = 'FAILED_UNCERTAIN'` sin condición puede pisar un `ISSUED` que llegó
entre la lectura del worker y su escritura.

**Ronda 1 tenía un defecto real:** `WHERE pending_since = $2` (comparando contra el valor leído
en un `SELECT` previo) nunca iba a matchear — `node-pg` convierte `timestamptz` a `Date` de JS,
que trunca a precisión de milisegundos, mientras que `NOW()` en Postgres tiene precisión de
microsegundos. La igualdad falla siempre, sin error visible — el worker nunca actuaría.

**Resolución corregida — una sola sentencia, sin `SELECT` previo separado:**

```sql
UPDATE invoices
   SET status = 'FAILED_UNCERTAIN', afip_contacted = true, pending_since = NULL,
       uncertain_cleared_at = NULL
 WHERE status = 'PENDING'
   AND pending_since < NOW() - $1::interval
 RETURNING id, financial_transaction_id
```

`uncertain_cleared_at = NULL` es obligatorio en este mismo `UPDATE` (hueco N4, ronda 3 del
gate) — mismo motivo que §3.5: si esta fila hubiera sido limpiada por un operador en un ciclo
`FAILED_UNCERTAIN` anterior y después volvió a `PENDING` por un reintento nuevo, el valor viejo
de `uncertain_cleared_at` quedaría poblado y `retryExisting()` la trataría como "ya limpiada"
sin que ningún humano la haya revisado esta vez.

Bajo READ COMMITTED, Postgres re-evalúa el `WHERE` de cada fila candidata al tomar su lock de
escritura — si otra transacción tomó la fila (nuevo reintento, o `markIssued`/`markFailed`)
entre que el worker la vio como candidata y que intenta escribirla, la re-evaluación ya no
matchea (el `status` cambió) y esa fila se salta sola, sin condición de carrera. No hace falta
una columna de token adicional.

### 3.4 Piso de `N` (hueco #3, segunda mitad)

`AFIP_REQUEST_TIMEOUT_MS = 20_000` (`afip-request.timeout.ts`), pero `issue()` encadena hasta 4
llamadas (`getLastVoucher` → `createNextVoucher` → [si falla] `getLastVoucher` → `getVoucherInfo`)
— techo real ~80s, no 20s (ya documentado en ese mismo archivo). El timer de aplicación NO
cancela el socket TCP — una respuesta tardía de AFIP puede llegar después del timeout.

**Resolución:** `N = 10 minutos` por defecto (bien por encima del techo de ~80s, con margen para
jitter de red y para que una respuesta tardía del socket todavía tenga tiempo de proceder antes
de que el worker la declare colgada). Configurable, no hardcodeado sin nombre — mismo criterio
que el resto de timeouts de esta Wave (Wave 9, `src/config/env.ts`).

### 3.5 `uncertainClearedAt` puede quedar viejo (hueco #4)

Ningún método existente lo vuelve a `NULL` — si una factura ya limpiada vuelve a caer en
`FAILED_UNCERTAIN` con `afipContacted` (ej. un reintento posterior falla de nuevo, de forma
incierta), el campo viejo sigue poblado y esquiva el chequeo de `retryExisting()` que evita
reintentar a ciegas.

**Resolución:** cualquier UPDATE que lleve una factura A `FAILED_UNCERTAIN` con
`afip_contacted = true` (el `markFailedWithClient()` existente, y el UPDATE nuevo del worker
§3.3) debe poner `uncertain_cleared_at = NULL` explícitamente, no dejarlo con el valor anterior.
Se corrige en `markFailedWithClient()` — defecto latente preexistente del camino NC, no
introducido por este bloque, pero se cierra acá porque el mecanismo nuevo lo vuelve mucho más
alcanzable (antes hacía falta una secuencia rara para pisarlo; con un worker automático que
corre solo, la secuencia se vuelve rutinaria).

**Asignación de bloque (hueco de §6, ronda 4 del gate — este fix no estaba asignado a ningún
bloque):** el fix de `markFailedWithClient()` va en el **Bloque 2c**, junto con el resto de §3.8
— es prerrequisito de que el guard 8-bis relajado de 2c sea correcto (si `markFailedWithClient()`
no resetea el campo, una factura recién re-fallada podría heredar un `uncertain_cleared_at` viejo
y el guard la trataría como ya limpiada sin revisión real). El `UPDATE` del worker (§3.3) ya trae
`uncertain_cleared_at = NULL` en su propio SQL — eso va en el Bloque 4, sin depender de este fix.

### 3.6 Única fuente de verdad para "en vuelo" (hueco #7, corregido ronda 2 — schema y migración)

**Resolución:** el único indicador es `status = 'PENDING'`. La columna nueva se llama
`pending_since` (no `retry_started_at` — cubre TAMBIÉN el camino fresco, que hoy no registra
desde cuándo está `PENDING`, ver `sql.invoice.repository.ts` nota C3 sobre la deuda de `PENDING`
colgada por muerte del proceso).

**Corrección ronda 2 — el `ALTER ... ADD CONSTRAINT` suelto de la ronda 1 no es correcto para
este repo:** `schema.sql` se reaplica completo e idempotente a cada tenant en cada deploy
(`npm run migrate:tenants`), y los `CHECK` de este archivo viven dentro de bloques `DO`
idempotentes (patrón ya usado varias veces en `schema.sql`, ej. las columnas nuevas de City
Ledger), no como `ALTER TABLE ... ADD CONSTRAINT` directo (que falla en el segundo deploy si la
constraint ya existe). Además, un `CHECK` agregado sin backfill previo rompe el deploy en
cualquier tenant que ya tenga filas `PENDING` con `pending_since NULL` — el build entero cae
(R15), no solo este bloque.

```sql
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS pending_since TIMESTAMPTZ;

-- Backfill ANTES del CHECK -- toda PENDING existente hoy nace del camino
-- fresco (este bloque es el primero que hace que retryExisting() también
-- pase por PENDING), así que created_at es la aproximación correcta para
-- las filas ya existentes -- no una invención, es la fecha real en que
-- esa fila entró en PENDING la única vez que pudo hacerlo hasta ahora.
UPDATE invoices SET pending_since = created_at WHERE status = 'PENDING' AND pending_since IS NULL;

-- Backfill inverso (obligatorio en 2b, hueco N1 ronda 4 -- ver más abajo por
-- qué). Limpia el residuo que deja la instancia de código ANTERIOR a 2a si
-- sigue atendiendo tráfico durante la ventana de deploy: su
-- markIssuedWithClient()/markFailedWithClient() sacan la fila de PENDING sin
-- limpiar pending_since (no la conocen), dejando filas NO-PENDING con
-- pending_since poblado -- exactamente lo que el CHECK de abajo rechaza. No
-- reemplaza al backfill directo, corre además de él.
UPDATE invoices SET pending_since = NULL WHERE status <> 'PENDING' AND pending_since IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoices_pending_since') THEN
    ALTER TABLE invoices ADD CONSTRAINT chk_invoices_pending_since
      CHECK ((status = 'PENDING') = (pending_since IS NOT NULL));
  END IF;
END $$;
```

**Corrección N2 (ronda 3 del gate, aplicada en ronda 4):** la versión anterior de este bloque
tenía un `DROP CONSTRAINT IF EXISTS chk_invoices_pending_since;` suelto antes del `DO $$`. Además
de no ser SQL válido por sí solo (le falta `ALTER TABLE invoices`), es exactamente el patrón que
este mismo documento prohíbe en su propia convención de evolución idempotente de schema: un DROP
antes del check-and-create fuerza revalidar la constraint contra toda la tabla en cada deploy,
derrotando el propósito del `IF NOT EXISTS`. Precedente verificado:
`chk_accounts_receivable_status` (schema v52) no lleva ningún DROP previo. Se retira sin
reemplazo — el `DO $$ ... END $$;` ya es idempotente por sí mismo.

El backfill directo con `created_at` es seguro PORQUE hasta este bloque `retryExisting()` nunca
vuelve a poner `PENDING` (solo el INSERT inicial lo hace) — no hay ninguna `PENDING` existente hoy
que esté "en vuelo por un reintento" sin haberlo estado también en su creación. Esto deja de ser
cierto en cuanto este bloque se despliega, así que el orden importa: el backfill corre como
parte del MISMO deploy que agrega la columna, antes de que cualquier reintento pueda volver a
poner `PENDING`.

**`CURRENT_SCHEMA_VERSION`** (`src/platform/tenant-db.setup.ts`) sube en este mismo bloque —
dispara `DEFENSIVE_DEVELOPING.md` §3 (toca `src/platform/`), a completar en el commit.

**El backfill directo NO puede gatearse por versión de schema (hueco N1, ronda 4 del gate) —
tiene que volver a correr en 2b también.** Las dos sentencias `UPDATE` de arriba son idempotentes
(la directa solo toca filas con `pending_since IS NULL`; la inversa solo filas con
`pending_since IS NOT NULL`), así que repetirlas en el deploy de 2b no tiene costo — es la única
forma de que 2b quede correcto también contra un tenant cuyo deploy de 2a haya corrido con la
instancia vieja todavía sirviendo tráfico (ver el punto siguiente), no solo contra el camino
feliz de "2a ya corrió limpio, 2b solo agrega el CHECK".

**Por qué hace falta el backfill inverso (hueco N1, ronda 4 del gate — el caso que la versión
anterior de este texto no cubría):** `migrate:tenants` corre dentro del `buildCommand` de
`render.yaml` — la instancia de código ANTERIOR a 2a sigue atendiendo tráfico durante toda la
ventana de deploy de 2a. Esa instancia vieja no conoce `pending_since`: su
`markIssuedWithClient()`/`markFailedWithClient()` (`sql.invoice.repository.ts`) sacan la fila de
`PENDING` con un `UPDATE` que no toca esa columna. Si el backfill directo de 2a ya le puso
`pending_since` a una fila (porque estaba `PENDING` en el momento del backfill) y la instancia
vieja la mueve a `ISSUED`/`REJECTED`/`FAILED_UNCERTAIN` un instante después, la fila queda con
`status <> 'PENDING'` y `pending_since` poblado — exactamente lo que el CHECK de 2b rechaza. Sin
el backfill inverso, `migrate:tenants` en el deploy de 2b falla contra esas filas → el build
entero cae (R15) → todos los deploys quedan bloqueados, no solo este.

**Registro en el inventario de DML (hueco N1, ronda 4 del gate — corregido en ronda 5, C3):** las
dos sentencias `UPDATE` son una fila nueva CADA UNA en `docs/inventario-dml-schema-2026-09-16.md`,
que hoy cuenta 21/21 sentencias de `schema.sql`, sin ninguna de estas dos. **No van en el mismo
commit** — la sentencia directa (backfill) existe desde 2a; la inversa (normalización) recién
existe desde 2b (no hay SQL de 2b sin el CHECK que la motiva). Por eso: **fila 22, sentencia
directa, en el commit que implemente 2a. Fila 23, sentencia inversa, en el commit que implemente
2b** — cada una con el formato de ese documento (columna, línea real de `schema.sql` en el commit
que la agrega, guard antes, clasificación, guard después) — **no en este bloque de diseño**,
porque `schema.sql` todavía no tiene este SQL.

Clasificación real (no "auto-limitantes desde que corren" — esa frase mezclaba dos ventanas
distintas del mismo SQL, corregido acá): en la ventana de 2a, ANTES de que 2b agregue el CHECK, la
sentencia directa (`pending_since = created_at WHERE status = 'PENDING' AND pending_since IS
NULL`, fila 22) es de **disparo abierto benigno**, sin gateo por versión, con el mismo argumento
que ya justifica no gatearla: si vuelve a dispararse en un deploy posterior, corrige (deja
`pending_since` poblado donde corresponde), nunca daña un dato correcto. Desde que 2b agrega
`chk_invoices_pending_since`, las dos sentencias (fila 22, directa, y fila 23, inversa) quedan
**auto-limitantes por el CHECK** — el mismo precedente que la fila 8 de ese documento (guardada
por un CHECK equivalente), no un motivo nuevo. Confirmar esta clasificación contra el código real
al implementar 2a/2b, no darla por sentada de este texto.

**Rollback de 2b (hueco N1, ronda 4 del gate):** revertir el commit de 2b NO saca el CHECK de la
base. `schema.sql` en este repo solo agrega — un rollback de código hace que `migrate:tenants`
vuelva a correr el `schema.sql` del commit anterior (sin el `ADD CONSTRAINT`), pero el constraint
que YA se aplicó contra la base real en el deploy de 2b sigue ahí, porque nada lo dropea. Volver a
código anterior a 2a (que inserta `PENDING` sin `pending_since`) con el CHECK todavía puesto en la
base rompería ese código en el primer `INSERT`/`UPDATE` que lo viole. El rollback de 2b, si hace
falta llegar hasta ahí, requiere un paso manual explícito además de revertir el commit:
`ALTER TABLE invoices DROP CONSTRAINT chk_invoices_pending_since;` contra cada tenant, antes de (o
en el mismo cambio que) desplegar el código anterior a 2a.

**Alcance de fixtures de test afectados por el CHECK de 2b (hueco N1, ronda 4 del gate):** la
columna `invoices.pending_since` no tiene `DEFAULT` que la derive de `status` — cualquier
`INSERT` crudo de una factura `'PENDING'` sin `pending_since` explícito viola el CHECK apenas esté
puesto. Grep real corrido esta sesión (`insert into invoices` cruzado contra los que además usan
status `'PENDING'` para `invoices` — literal, por parámetro por defecto de un helper, o por
`it.each`) da **12 archivos**:

- `src/tests/integration/accounts-receivable-invoice-linkage.integration.test.ts`
- `src/tests/integration/cancellation-refund.integration.test.ts`
- `src/tests/integration/classify-order-live-invoice-pair-classifier.integration.test.ts`
- `src/tests/integration/classify-reservation-live-invoice-pair.integration.test.ts`
- `src/tests/integration/consolidated-invoice-toctou.integration.test.ts`
- `src/tests/integration/credit-note-cap.integration.test.ts`
- `src/tests/integration/credit-note-compensation.integration.test.ts`
- `src/tests/integration/credit-note-request-repository.integration.test.ts`
- `src/tests/integration/invoice-mark-failed-transactional.integration.test.ts`
- `src/tests/integration/refund-issued-race.integration.test.ts`
- `src/tests/integration/reverse-transfer.integration.test.ts`
- `src/tests/integration/unreconciled-live-invoices.integration.test.ts`

Cada uno inserta al menos una factura `'PENDING'` por SQL crudo (directo, o vía un helper de seed
con ese valor por default o por parámetro) sin `pending_since`. Verificado que quedan FUERA de
este alcance, a propósito: los archivos cuyo `'PENDING'` es de otra entidad (reserva, orden, hold,
`financial_transactions`) — `audit-log-transactional`, `cancel-order-with-credit-note`,
`cancel-reservation-with-credit-note` (su `'PENDING'` es de `financial_transactions`),
`charge-uniqueness`, `customer-portal-ownership`, `customer-token-staff-route-ownership`,
`financial-transaction` (ídem), `invoice-order-reservation-item`, `invoice-order-service-item`,
`order-flow`, `reservation-price-adjustment-stay`, `reservations-unpaginated-limit` — y los que sí
insertan `invoices` pero solo con `'ISSUED'`/`'REJECTED'`/`'FAILED_UNCERTAIN'`:
`classify-order-live-invoice-pair.integration.test.ts` (sin sufijo `-classifier`),
`credit-note-cap-service`, `credit-note-lines`, `credit-note-pair-cap`, `customer-account-payment`,
`for-key-share-lock-semantics`, `order-effects`, `reservation.service.integration.test.ts`,
`schema-redeploy-idempotent`. El alcance de 2b incluye agregar `pending_since` (a `created_at`, o
a cualquier valor reciente si el test no lo usa) a cada `INSERT`/helper de la lista de 12, en el
mismo commit que agrega el CHECK — de lo contrario el tier de integración se pone rojo contra
Postgres real apenas se implemente 2b.

**Pre-flight ENTRE 2a Y 2b (antes del deploy de 2b — corregido en ronda 5: no "antes de 2a/2b",
`pending_since` todavía no existe antes de 2a) (hueco N1, ronda 4 del gate; corregido en ronda 5,
C4) — dos verificaciones, además de la de §4:**
1. Confirmar PRIMERO la identidad real del commit que está sirviendo el tráfico después del
   deploy de 2a — no alcanza con que `/health` responda 200 (eso confirma que el proceso está
   vivo, no cuál código corre). Confirmar el SHA real desplegado (Render expone el commit del
   deploy activo) antes de asumir que la instancia vieja (sin `pending_since`) ya dejó de atender
   tráfico.
2. Consulta de solo lectura por tenant, medida DOS VECES separadas en el tiempo (no una sola
   lectura puntual): `SELECT count(*) FROM invoices WHERE (status = 'PENDING') <> (pending_since
   IS NOT NULL);`. **"Bloquea hasta confirmar 0" no se puede exigir acá** — ese conteo en 0 es
   precisamente lo que las dos sentencias de backfill que 2b re-ejecuta (arriba: la directa, para
   una `PENDING` que 2a no llegó a backfillear; la inversa, para el caso N1) recién dejan, dentro
   de su propia transacción de deploy; pedirlo en 0 ANTES de desplegar 2b invitaría a correr el
   UPDATE de forma manual contra producción, fuera del mecanismo versionado. La lectura correcta
   de las dos medidas: si el conteo CRECE entre la primera y la segunda, hay un escritor que el
   backfill de 2a no cubrió — HOLD, investigar antes de desplegar 2b. Si el conteo se mantiene
   ESTABLE (mayor o igual a 0, sin crecer), es el residuo esperado (de cualquiera de los dos
   casos) que las dos sentencias de backfill que 2b re-ejecuta van a limpiar en su misma
   transacción de deploy — no bloquea.

**Esto NO reemplaza la verificación de §4 — son dos gates distintos, en momentos distintos
(inconsistencia §4 vs. esta sección, cerrada en ronda 4 del gate; corregido otra vez en ronda 9,
residuo B-1 de la ronda 8 del gate — misma frase stale "antes de activar el worker" que §4/§6/
pendientes.md tenían):** el pre-flight de arriba mide el volumen y la consistencia de
`pending_since` ENTRE el deploy de 2a Y el de 2b, antes de desplegar 2b. El de §4 mide cuántas
filas `PENDING`/`FAILED_UNCERTAIN` sin `uncertain_cleared_at` existen ANTES de DESPLEGAR el Bloque
4 completo (guard + worker, B-1) — para no convertir en `FAILED_UNCERTAIN` filas que nunca
estuvieron realmente coladas. Las dos condiciones son NECESARIAS, no alternativas: son gates en
momentos distintos del mismo plan de deploy (2a→2b vs. 4), no dos formas de decir lo mismo.

Todo escritor que saque una factura de `PENDING` sin limpiar `pending_since` falla en la base,
no en silencio. Call-sites a tocar: `createWithClient()` (setea `pending_since = NOW()` junto
con el INSERT), `markIssuedWithClient()`/`markFailedWithClient()` (`pending_since = NULL`), la
toma exclusiva nueva de §3.2, y el UPDATE del worker de §3.3.

### 3.7 Mensaje de error distinto para "en vuelo" vs. "necesita NC", y qué hace `retryExisting()` con un `PENDING` (error nace en bloque 4, ronda 6 — reusado por bloque 2c)

`ArReversalRequiresCreditNoteError` (`accounts-receivable.service.ts`) dice *"...la corrección
tiene que hacerse con una Nota de Crédito, no con `reverseTransfer()`"* — engañoso para el caso
"hay una emisión genuinamente en vuelo, reintentá en un momento" (ya lo es hoy para el `PENDING`
transitorio del camino fresco, sin este bloque).

**Resolución:** nuevo error `RetryInvoiceInFlightError(invoiceId)` (código `RETRY_INVOICE_IN_FLIGHT`,
`src/domain/errors.ts`), mapeado a **409** (no 422 — es una precondición temporal que se resuelve
sola con el tiempo, mismo grupo semántico que el resto de errores 409 de "carrera en curso" ya
listados en `error.middleware.ts`, no el grupo 422 de "regla de negocio violada"). **Corrección de
origen (ronda 6, ubicación B — ver Historial de revisión):** este error NO nace en la toma
exclusiva de §3.2/Bloque 2c, como decía la versión anterior de este texto — nace en **Bloque 4**
(§6), como guard de solo lectura al principio de `retryExisting()`
(`if (existing.status === 'PENDING') throw new RetryInvoiceInFlightError(existing.id);`, sin query
nueva — `existing` ya está en memoria). Cuando 2c se implemente, su toma exclusiva (§3.2) **reusa
el mismo error, sin redefinirlo**, para el caso en que su propio `UPDATE ... RETURNING` no
encuentre fila. **Corrección P2(a), ronda 7 — ese caso SÍ sigue siendo alcanzable en la práctica
para `retryExisting()`, incluso con Bloque 4 desplegado (la versión de ronda 6 decía lo
contrario):** el guard de Bloque 4 solo protege contra reintentar una fila que YA está `PENDING` en
el momento en que `existing` se leyó — no protege contra dos `retryExisting()` concurrentes sobre
la MISMA fila `REJECTED`/`FAILED_UNCERTAIN` limpiada, que los dos leen ese status (no `PENDING`),
pasan el guard de Bloque 4 sin problema, y llegan igual hasta la toma exclusiva de 2c — ahí es
donde el `UPDATE ... RETURNING` decide cuál de las dos gana. Sigue siendo la protección correcta
para cualquier otro caller que tome la fila sin pasar por el guard de Bloque 4, y TAMBIÉN la
protección correcta para `retryExisting()` en ese caso concreto — no un caso residual. **Política
confirmada por el dueño en §2: siempre 409 mientras la marca esté fresca, sin excepción, sin
liberación manual antes del vencimiento automático — el guard de Bloque 4 ya implementa esa
política en su totalidad para el caso `PENDING` YA ASENTADO** (no hace falta que distinga "fresca"
de "vencida": mientras el worker de §3.3 no la reclamó, el `status` de la fila sigue siendo
`PENDING` — apenas vence, el worker la mueve a `FAILED_UNCERTAIN` y el guard de Bloque 4 deja de
aplicar, cae en el guard ya existente de `FAILED_UNCERTAIN`/`afipContacted` sin
`uncertainClearedAt`, ver más abajo). **Residuo real, corregido en esta misma ronda (B-2 — la
versión de ronda 6 describía mal este residuo, mezclándolo con el caso de arriba):** el guard de
Bloque 4 lee `existing.status` UNA sola vez, sin tomar lock, ANTES de abrir la transacción de
`retryExisting()` — la única ventana que deja abierta, DESPUÉS de que 2c exista, es que otro actor
ponga la fila en `PENDING` en el instante exacto entre esa lectura y este guard; la toma exclusiva
transaccional de 2c también cierra ESE caso, con su propio `UPDATE ... RETURNING` bajo lock. **Esta
ventana NO puede darse ANTES de que 2c exista** (nada vuelve a poner `PENDING` una fila hasta que
2c se implemente — el único origen de `PENDING` hasta entonces es el camino fresco, que no pasa por
acá), así que no hace falta mitigarla antes: el residuo real de ANTES de 2c es el del párrafo de
arriba (dos `REJECTED`/`FAILED_UNCERTAIN` concurrentes, ya cerrado por la toma exclusiva de 2c
apenas se implemente, no por este guard de solo lectura).

Distinto del guard 8-bis de `reverseTransfer()` (§3.1) — ese sigue usando
`ArReversalRequiresCreditNoteError` (422) para TODOS sus casos de bloqueo, incluido `PENDING`
(ver la tabla de §3.1): el 409 nuevo es específico de `retryExisting()` rechazando un reintento
concurrente, no de `reverseTransfer()` rechazando una reversa. No se unifican los dos errores —
son dos operaciones distintas rechazando por motivos relacionados pero no idénticos.

**B-4 (ronda 7) — dos huecos de documentación, distintos del residuo de arriba:**
1. **Docblocks a actualizar en la implementación del Bloque 4, dos, no uno:** la ronda 6 solo
   nombraba el de `retryExisting()` (`invoice.service.ts` — hoy clasifica `PENDING` como parte de
   "el resto ... reintento seguro"; deja de serlo). Falta también el de
   `transitionCreditNoteRequestAfterFailure()` (`invoice.service.ts` — buscar por nombre, no por
   línea), que hoy documenta "solo bloquea `ISSUED` y `FAILED_UNCERTAIN` sin limpiar" sin mencionar
   que, desde este bloque, una fila `PENDING` tampoco es alcanzable ahí vía `retryExisting()` (el
   guard nuevo corta antes de que ese método pueda tocarla por ese camino).
2. **Orden de precedencia frente al guard de `DUPLICATE-CAE-001`** (`assertNoOtherLiveInvoiceForCharges()`,
   ver el docblock de `retryExisting()` citado en §5): el guard `PENDING` de este bloque corre
   PRIMERO, junto a los dos guards de solo lectura que ya existen hoy al principio del método
   (`ISSUED`, `FAILED_UNCERTAIN` sin limpiar) — ANTES de que el método llegue a filtrar
   `chargeTxs`/llamar a `assertNoOtherLiveInvoiceForCharges()`/abrir la transacción de
   `assertChargesStillInvoiceable()`. Motivo: los tres guards de arriba son lecturas puras sobre
   `existing` (sin query, sin lock) — correrlos primero rechaza el caso más barato (y más común: un
   reintento sobre una fila que ya no está en un estado reintentable) antes de pagar el costo de
   una consulta a la base o de abrir una transacción para nada. No cambia NINGÚN comportamiento de
   `DUPLICATE-CAE-001` — ese guard sigue viendo exactamente los mismos casos que antes (los que
   pasan los tres guards de solo lectura), solo que ahora hay un guard más adelante en la fila.

### 3.8 Guard 8-bis respeta `uncertainClearedAt` (decisión del dueño, §2) — bloque 2, no bloque 1

Guard 8-bis, rama `FAILED_UNCERTAIN` con `afipContacted`: agrega
`&& fila.uncertainClearedAt == null` a la condición de bloqueo de esa fila en la tabla de §3.1
(`getAllLinkedInvoicesWithClient()` ya trae ese campo). Mismo criterio que `retryExisting()` ya
aplica en su propio chequeo temprano.

**Corrección de secuencia (hueco B2 de la ronda 2 del gate):** este cambio NO va en el bloque 1
(§3.1) — va en el bloque 2, en el MISMO commit que la toma exclusiva de §3.2. Si se relajara el
guard 8-bis antes de que exista la marca `PENDING` con toma exclusiva, se abriría una ventana
PEOR que la actual: hoy una `FAILED_UNCERTAIN` limpiada con `afipContacted` bloquea la reversa
mientras `retryExisting()` la reintenta (aunque el status siga diciendo `FAILED_UNCERTAIN`, no
`PENDING`) — relajar el guard sin que el reintento ya marque `PENDING` primero dejaría pasar una
reversa en plena emisión.

### 3.9 Salida manual para facturas `CHARGE` (hueco de la pregunta 2 del gate — el más grande)

La bandeja del Bloque 5 del ADR común cancelar-con-NC (§6.5 bis, ya implementado en producción —
no el Bloque 5 de ESTE ADR, en §6) (`resolveCreditNoteRequestManually()`) está acotada a
`credit_note_request` — filas que solo existen para `tx.type === 'ADJUSTMENT'`
(`invoice.service.ts`). Una factura `CHARGE` que el worker de vencimiento (§3.3) lleve a
`FAILED_UNCERTAIN` no tiene NINGUNA salida dentro del sistema hoy — viola directamente el
principio de "salida propia" que motivó este mecanismo en primer lugar.

**Resolución — bandeja nueva, no extender `credit_note_request`** (su máquina de estados es de
NC, no de facturas en general; extenderla mezclaría dos conceptos, mismo criterio que este repo
ya aplicó al NO fusionar `ESCAPE_ROUTES` con `CITY-LEDGER-REVERSE-ROUTE-GROUP-FREEZE-001`,
CLAUDE.md):

- `GET /api/invoices/uncertain` — lista facturas `FAILED_UNCERTAIN` con `afip_contacted = true`
  y `uncertain_cleared_at IS NULL`. **Criterio de exclusión corregido (A-6, ronda 7 — ver más
  abajo en esta sección para el caso que motiva el cambio):** excluye las que tienen una
  `credit_note_request` propia **que siga ABIERTA** (`PENDIENTE`/`EN_REVISION_MANUAL` — esas
  siguen su propio camino, ver abajo); **NO excluye** las que tienen una `credit_note_request`
  propia ya `CERRADA` — esa factura no tiene ningún otro lugar donde aparecer, y excluirla (como
  hacía la versión anterior de este bullet, sin mirar el estado de la solicitud) la deja sin
  ninguna bandeja. RBAC: `MANAGEMENT` (mismo criterio que la decisión ya tomada para el reporte
  (d), §3.10 — ambos exponen estado de facturación sin reconciliar). Se registra ANTES de
  `GET /api/invoices/:id` en `invoices.routes.ts` — mismo motivo ya documentado en ese archivo
  para otras rutas de segmento fijo (`/uncertain` matchearía como `:id` si se registra después).
- `POST /api/invoices/:id/mark-not-issued` — mismo efecto que
  `resolveCreditNoteRequestManually()` con `outcome: 'NO_EMITIDA'`: llama a
  `markUncertainClearedWithClient()`. **Corrección (hueco N6, ronda 3 del gate):**
  `markUncertainClearedWithClient()` hoy actualiza con `WHERE id = $1`, sin condición de status
  (`sql.invoice.repository.ts`). La ronda 3 de este documento decía que esto era "seguro en el
  Bloque 5 del ADR común cancelar-con-NC porque `credit_note_request` ya trae su propia máquina de
  estados como guard previo" —
  **inexacto (precisión de la ronda 4): esa máquina de estados protege el estado de la SOLICITUD
  de NC (`credit_note_request.status`), no el estado de la FACTURA (`invoices.status`), que es lo
  que realmente importa acá** (ver el bullet de N6 al final de esta sección, con el caso real
  donde esa diferencia rompe algo). Esta ruta nueva tampoco tenía ningún guard de estado de
  factura. Este bloque agrega el predicado a la condición del `UPDATE`:
  `WHERE id = $1 AND status = 'FAILED_UNCERTAIN' AND afip_contacted AND uncertain_cleared_at IS NULL`
  — si no matchea (la factura ya se limpió, ya se resolvió sola, o nunca estuvo en ese estado),
  rechaza en vez de escribir un estado inconsistente. **Rechaza
  con un error dedicado (`InvoiceHasOpenCreditNoteRequestError`, código
  `INVOICE_HAS_OPEN_CREDIT_NOTE_REQUEST`, 409, fail-loud, no silencioso) si la factura tiene una
  `credit_note_request` propia que sigue ABIERTA** (`PENDIENTE`/`EN_REVISION_MANUAL`) — esa
  combinación va por `POST /credit-note-requests/:id/resolve`, no por acá; dos salidas para el
  mismo caso serían dos fuentes de verdad divergentes (hueco B7 del gate, ronda 2). **Corrección
  N-1 (ronda 8 del gate, aplicada en ronda 9) — antes rechazaba si la factura tenía CUALQUIER
  `credit_note_request` ligada, sin mirar su estado; eso es exactamente el mismo error, en espejo,
  que A-6 (más abajo en esta sección) ya corrigió para la exclusión de `/uncertain`: una factura
  con `credit_note_request` ya `CERRADA` que vuelve a `FAILED_UNCERTAIN` (secuencia real,
  documentada en el docblock de `transitionCreditNoteRequestAfterFailure()`) no tenía NINGUNA
  salida — `/resolve` la rechaza (`transitionWithClient()` no permite `CERRADA -> CERRADA`) y
  `mark-not-issued` también la rechazaba (por tener CUALQUIER `credit_note_request` ligada, sin
  distinguir CERRADA de abierta). Con el predicado narrowed a "sigue ABIERTA", una factura con
  `credit_note_request` ya `CERRADA` PASA este guard y puede resolverse por acá — es, junto con
  `/uncertain` (A-6) y la reconciliación contra AFIP nueva (§3.14, P-1), su salida real.** RBAC:
  **`Roles.EMISOR_NOTA_CREDITO`** (decisión del dueño, §2). Este predicado es el MISMO
  para automático y manual desde siempre (no hay dos llamadas distintas a este método) — A-2 (ver
  más abajo) es un problema del método hermano `markIssuedWithClient()`, que SÍ tiene dos callers
  con necesidades distintas; `markUncertainClearedWithClient()` no lo tiene.
- **El worker de vencimiento (§3.3) también decide, por `tx.type`, a qué salida deriva cada
  factura que expira:** si la factura tiene una `credit_note_request` propia (`ADJUSTMENT`), el
  mismo `UPDATE` del worker llama, dentro de la MISMA transacción,
  `transitionCreditNoteRequestAfterFailure(client, ..., 'EN_REVISION_MANUAL')` (mismo método que
  ya usan `issue()`/`reconcileAfterFailure()` en sus propias transiciones de fallo) — así la
  bandeja de NC existente la ve. Si no tiene `credit_note_request` (`CHARGE`, o `REFUND` sin
  NC), queda en la bandeja nueva de `/uncertain` de arriba.
- Ambas rutas nuevas: sumar a `EXPECTED_AUTHORIZE_CALL_SITES`, `rbac-matriz-endpoints.md`
  sección 4/2, `docs/inventario-rutas.md` (`npm run docs:routes`), y evaluar si necesitan
  entrada en `NO_CONSUMER_ROUTES` (no van a tener consumidor en `appfrontend-main` hasta que se
  construya la pantalla — igual que las dos bandejas existentes del Bloque 5 del ADR común
  cancelar-con-NC, ya en esa lista).
- **N6 (ronda 4 del gate; ubicación A encontrada en ronda 5, ver Historial de revisión) — el
  predicado de arriba también alcanza al Bloque 5 del ADR común cancelar-con-NC (§6.5 bis, ya
  implementado en producción — no el Bloque 5 de ESTE ADR, en §6)
  (`resolveCreditNoteRequestManually()`, `invoice.service.ts` — buscar por nombre, no por línea),
  y ESO es un cambio de comportamiento de ESTE bloque (3), no un efecto colateral gratis del
  predicado de este mismo bloque (3):** `resolveCreditNoteRequestManually()` llama al MISMO
  `markUncertainClearedWithClient()` que el predicado de arriba protege — no es un método
  distinto. Caso de §3.13 (factura que pasa a `ISSUED` tarde mientras la solicitud de NC sigue
  `EN_REVISION_MANUAL`): HOY, sin el predicado, el código escribe `uncertain_cleared_at` sobre
  una factura ya `ISSUED` y cierra la solicitud como `NO_EMITIDA` — una escritura sin sentido
  sobre un estado terminal. CON el predicado de este bloque aplicado, el mismo caso cae en el
  `throw new Error(...)` genérico que hoy vive en `markUncertainClearedWithClient()`
  (`sql.invoice.repository.ts`) — mejor que escribir un estado inconsistente, pero termina en un
  **500 sin tipar**, no en una respuesta que el operador pueda entender. Este bloque agrega:
  **(a)** un error tipado nuevo, `InvoiceUncertainClearPreconditionError(invoiceId)` (código
  `INVOICE_UNCERTAIN_CLEAR_PRECONDITION_FAILED`, `src/domain/errors.ts`), que
  `markUncertainClearedWithClient()` lance en vez del `throw new Error(...)` genérico cuando el
  `UPDATE` no matchea (distinguiendo esa causa de un `id` que directamente no existe — ver el
  patrón de desambiguación en la resolución de ubicación A, más abajo), mapeado a **409** en
  `error.middleware.ts` (mismo grupo semántico que el 409 de §3.7 — precondición que ya cambió, no
  regla de negocio violada) y propagado también hacia `resolveCreditNoteRequestManually()`, que
  hoy no espera ningún error de esa llamada — ver ahí mismo cómo lo atrapa, no lo deja pasar como
  un 409 crudo;
  **(b)** un test de integración que reproduzca el caso de §3.13 llamando específicamente a
  `resolveCreditNoteRequestManually()` (no solo al flujo genérico de `mark-not-issued` de
  arriba), confirmando que rechaza en vez de escribir sobre una factura ya `ISSUED` (ver
  resolución de ubicación A — ronda 7 cambia el desenlace de "auto-cierra reflejando la verdad" a
  "rechaza", el error tipado y el predicado de acá no cambian).

  **Resolución de ubicación A — corregida en ronda 7 (encontrada en ronda 5, primera propuesta en
  ronda 6; el gate encontró el hueco A-2 en la propuesta de ronda 6, y el dueño tomó las 2
  decisiones de negocio citadas en el encabezado, que reemplazan el criterio de "auto-cerrar
  reflejando la verdad real" que tenía la ronda 6):** con el 409 de N6 puesto, la rama `EMITIDA`
  de `resolveCreditNoteRequestManually()` tenía el mismo problema en espejo — llama a
  `markIssuedWithClient()` SIN condición de status, sobrescribiendo los campos AFIP (`cae`,
  `cbte_nro`, `cae_vto`, `afip_response`, `issued_at`) de una factura ya `ISSUED` con datos
  cargados a mano por el operador. Choca con §8 (factura `ISSUED` es un documento inmutable), y el
  ADR no declaraba ninguna salida real después de ese choque — hueco real, no solo de redacción.

  **A-2 (ronda 6 del gate) — el guard que la ronda 6 proponía para `markIssuedWithClient()`
  (`WHERE ... AND status <> 'ISSUED'`) NO puede ser el mismo para las dos llamadas que lo usan:**
  automática (`finalizeIssued()`, vía `markIssued()`) y manual
  (`resolveCreditNoteRequestManually()`, rama `EMITIDA`) necesitan predicados DISTINTOS —
  `<> 'ISSUED'` es correcto para la automática (`finalizeIssued()` completa una emisión que ya
  estaba genuinamente en curso, sin importar en cuál de los estados previos concretos estaba la
  fila) pero, aplicado a la MANUAL, dejaría que un operador declare `EMITIDA` sobre una `PENDING`
  con una llamada a AFIP realmente en curso, o sobre una `REJECTED` (AFIP ya dijo que no — un
  operador no debería poder "declarar emitida" una factura rechazada sin pasar por el circuito que
  corresponde). **Resolución — dos métodos, no un parámetro en uno solo** (mismo criterio de
  nomenclatura que ya separa `markIssued`/`markIssuedWithClient`: un método por contrato de
  escritura, no una rama condicional adentro):
  - `markIssuedWithClient()` (`sql.invoice.repository.ts`) queda EXACTAMENTE como la proponía la
    ronda 6 — `WHERE ... AND status <> 'ISSUED'` — pero pasa a ser de uso EXCLUSIVO del camino
    AUTOMÁTICO (`finalizeIssued()`). Sobre `RETURNING` vacío: `SELECT status FROM invoices WHERE
    id = $1` de desambiguación; `status = 'ISSUED'` → `InvoiceAlreadyIssuedError(invoiceId)`
    (código `INVOICE_ALREADY_ISSUED`, 409); id inexistente → el `throw new Error(...)` genérico ya
    existente (invariante roto real, no cambia). **Política de `finalizeIssued()` frente a este
    guard: ver P3, más abajo en esta misma sección** — un guard que salta ACÁ no tiene la misma
    salida simple que en el camino manual, porque no hay ningún operador esperando una respuesta
    HTTP a quien devolverle un 409 útil.
  - **Método nuevo, exclusivo del camino MANUAL:** `markIssuedFromManualResolutionWithClient()`
    (`sql.invoice.repository.ts`/`invoice.repository.ts`), mismo predicado ESTRICTO que N6 ya le
    dio a `markUncertainClearedWithClient()` — la factura tiene que estar genuinamente en la
    ambigüedad que la bandeja existe para resolver, ni más ni menos:
    ```sql
    UPDATE invoices
       SET cbte_nro = $2, cae = $3, cae_vto = $4, afip_response = $5,
           status = 'ISSUED', issued_at = NOW(), pending_since = NULL
     WHERE id = $1
       AND status = 'FAILED_UNCERTAIN' AND afip_contacted AND uncertain_cleared_at IS NULL
     RETURNING *
    ```
    Sobre `RETURNING` vacío: mismo patrón de desambiguación, error nuevo
    `InvoiceManualResolutionPreconditionError(invoiceId)` (código
    `INVOICE_MANUAL_RESOLUTION_PRECONDITION_FAILED`, 409, mismo grupo semántico que
    `InvoiceUncertainClearPreconditionError` — deliberadamente un nombre DISTINTO al de N6 en vez
    de reusar ese, para no perder de qué rama vino el guard cuando `resolveCreditNoteRequestManually()`
    decide qué hacer después; ver reclasificación, abajo).

  **(2) `resolveCreditNoteRequestManually()` atrapa el guard que corresponda a la rama que corrió
  (`InvoiceManualResolutionPreconditionError` en `EMITIDA`, `InvoiceUncertainClearPreconditionError`
  en `NO_EMITIDA`) y reclasifica bajo lock — orden factura primero, solicitud después (A-4,
  hueco nuevo de ronda 6, ver abajo por qué en ESE orden), aplicando las 2 decisiones de negocio
  del dueño (encabezado) en vez del criterio "auto-cierra reflejando la verdad" que tenía la ronda
  6:**
  - Lee el estado actual de la factura bajo lock
    (`InvoiceRepository.getReconciliationSnapshotForUpdate(client, invoiceId): Promise<{ status:
    InvoiceStatus; afipContacted: boolean; uncertainClearedAt: Date | null; cbteNro: number | null;
    cae: string | null } | null>` — **firma ampliada en ronda 7**: la propuesta de ronda 6 solo
    traía `status`/`uncertainClearedAt`; la clasificación de acá necesita también `afipContacted`
    (para poder repetir el predicado estricto en código, no solo en SQL — ver A-4) y `cbteNro`/`cae`
    (para poder comparar el CAE declarado contra el real, decisión 2). `SELECT status,
    afip_contacted, uncertain_cleared_at, cbte_nro, cae FROM invoices WHERE id = $1 FOR UPDATE`,
    mismo criterio de lectura-bajo-lock que los 4 `FOR UPDATE` que N7 ya cita).
  - **A-4 (ronda 6 del gate) — lockea TAMBIÉN la `credit_note_request`, inmediatamente después de
    la factura.** Método nuevo `CreditNoteRequestRepository.findByIdForUpdate(client, id):
    Promise<CreditNoteRequest | null>` (`SELECT ... FOR UPDATE`) — mismo orden de lock que el resto
    de este método (factura primero, solicitud después, ver el residuo de lock-order más abajo en
    esta sección). Con la fila lockeada, tres casos por `lockedRequest.state`, no dos — el de
    `PENDIENTE` es NUEVO de esta ronda (P-2):
    - **`PENDIENTE` (P-2, ronda 9, decisión de negocio del dueño — ver encabezado del documento) —
      rechaza sin escribir nada, sin mirar el estado de la factura:** `throw new
      CreditNoteRequestNotInManualReviewError(lockedRequest.id, lockedRequest.state)` (código
      `CREDIT_NOTE_REQUEST_NOT_IN_MANUAL_REVIEW`, 409). Cierra, para ESTE call-site, la mitad
      operativa de A-3 (`docs/pendientes-2026-09-12.md`) que A-2 por sí solo no cerraba: A-2 ya
      impedía la CORRUPCIÓN de dato en una carrera contra el camino automático (ver el razonamiento
      completo más abajo, "Por qué P-2 no necesita invertir el orden de locks"), pero un intento
      genuinamente prematuro (la solicitud todavía `PENDIENTE`, el camino automático ni siquiera
      falló una vez) terminaba, antes de esta ronda, cayendo en el `default:` de la clasificación de
      abajo (`InvoiceReconciliationUnexpectedStateError`, 500 sin clasificar) en vez de un 409
      accionable que le diga al operador "esta solicitud todavía no llegó a revisión manual".
    - **`CERRADA` — corregido (N-2, ronda 8 del gate, aplicado en ronda 9; la versión de ronda 7
      la devolvía SIN reclasificar de forma INCONDICIONAL, lo que tragaba en silencio dos
      conflictos reales que la decisión 1 del dueño (encabezado) exige rechazar con 409, no
      absorber):** idempotente-SOLO-SI `lockedRequest.resolutionOutcome === input.outcome` (y,
      cuando `input.outcome === 'EMITIDA'`, TAMBIÉN `input.cbteNro === snapshot.cbteNro &&
      input.cae === snapshot.cae` contra la factura ya lockeada arriba) — en ese caso devuelve
      `lockedRequest` tal cual, sin volver a escribir nada. Si NO coincide, `logger.warn({
      creditNoteRequestId: lockedRequest.id, invoiceId, declaredOutcome: input.outcome,
      recordedOutcome: lockedRequest.resolutionOutcome, resolvedBy: input.resolvedBy }, ...)` y
      `throw new InvoiceResolutionStateConflictError(invoiceId, lockedRequest.resolutionOutcome ??
      'CERRADA_SIN_DESENLACE')` (mismo tipo/409 que la decisión 1 más abajo — reusado, no un tercer
      error nuevo: la semántica es la misma, "lo que declarás no coincide con lo que el sistema ya
      sabe", solo que acá lo que el sistema ya sabe está grabado en `credit_note_request` en vez de
      en `invoices.status`). **Los DOS casos reales que esto cierra (el gate, ronda 8):** (a) un
      `REJECTED` tardío auto-cerró la solicitud con `resolutionOutcome: null`
      (`transitionCreditNoteRequestAfterFailure()`, rama automática) y el operador ahora declara
      `EMITIDA` — con la versión de ronda 7 esto devolvía 200 silencioso sin escribir el CAE real
      que el operador tiene; con N-2, `null !== 'EMITIDA'` → 409, el operador se entera de que algo
      no cierra en vez de creer que ya quedó resuelto. (b) dos operadores resuelven concurrentemente
      con desenlaces DISTINTOS — el segundo en llegar ve la fila ya `CERRADA` con el desenlace del
      primero; si difiere del suyo, 409 en vez de un 200 que esconde la discrepancia. Caso que SIGUE
      siendo idempotente sin 409 (el único que sobrevive de la ronda 7): doble-submit con el MISMO
      desenlace declarado (ver más abajo, "Doble-submit genuino").
      **Reevaluación de alcance tras P-2 (pedida por el gate, ronda 8) — con P-2 ya rechazando
      `PENDIENTE` en la entrada de arriba, ¿sigue siendo alcanzable este caso `CERRADA` desde una
      solicitud que arrancó `PENDIENTE`? Corrección ronda 11 (residuo #1 del veredicto de ronda 10
      del gate — el razonamiento de acá abajo era contradictorio con el propio mecanismo de P-2
      descripto dos bullets más adelante, y la conclusión era falsa; el MECANISMO y el DESENLACE —
      409 vía N-2 — no cambian, se corrige solo el razonamiento):** **sí sigue siendo alcanzable,
      inclusive desde una llamada FRESCA que arranca con la solicitud `PENDIENTE`.** La frase
      anterior de esta misma sección decía que ese caso "se rechaza en el paso de arriba, antes de
      tocar la factura" — contradice el mecanismo real de P-2 (bullet "Por qué P-2 no necesita
      invertir el orden de locks", más abajo): el guard de P-2 vive DENTRO de la reclasificación de
      A-4, corre DESPUÉS de que el `UPDATE` optimista de A-2 ya falló (RETURNING vacío) y DESPUÉS de
      que la factura ya está lockeada — nunca "antes de tocar la factura". Concretamente: `request`
      `PENDIENTE` + factura genuinamente `PENDING` en vuelo → el `UPDATE` optimista de A-2 falla (la
      factura no está `FAILED_UNCERTAIN`, sin importar el estado de la solicitud) → esta transacción
      entra a la reclasificación y empieza a lockear factura y luego solicitud bajo `FOR UPDATE` —
      pero ANTES de que esta transacción alcance a tomar el lock de `credit_note_request`, el camino
      AUTOMÁTICO puede commitear primero: la factura pasa a `REJECTED` y, en la MISMA transacción
      automática, la solicitud se auto-cierra `CERRADA` con `resolutionOutcome: null`
      (`transitionCreditNoteRequestAfterFailure()`, rama `REJECTED`). Cuando esta transacción manual
      finalmente toma su lock sobre `credit_note_request`, ya NO ve `PENDIENTE` — ve `CERRADA` con
      `resolutionOutcome: null` — así que NUNCA llega a evaluar el guard de P-2 en absoluto: cae
      directo en la rama `CERRADA` de arriba (N-2), que compara `null !== input.outcome` y rechaza
      con `InvoiceResolutionStateConflictError` (409). El desenlace es correcto (409, la solicitud
      queda sin tocar) — pero la RUTA que lo produce es N-2, no P-2, y la entrada SÍ arrancó
      `PENDIENTE`, contra lo que decía el texto anterior. Es, de hecho, el MISMO escenario (a) que
      el bullet de arriba ya describe ("un `REJECTED` tardío auto-cerró la solicitud... y el
      operador ahora declara `EMITIDA`") — la única corrección es que (a) SÍ puede empezar desde una
      solicitud `PENDIENTE`, no solo desde `EN_REVISION_MANUAL` como asumía la frase "por el camino
      de una llamada FRESCA" de la versión anterior. **Conclusión corregida: con P-2 aplicado, el
      caso `CERRADA` reclasificado por N-2 SIGUE siendo alcanzable desde una entrada `PENDIENTE`
      fresca (vía la carrera con el auto-cierre `REJECTED`, arriba) además de (a) el cierre
      automático sobre una solicitud que ya estaba `EN_REVISION_MANUAL` y (b) la carrera de
      doble-submit entre dos entradas `EN_REVISION_MANUAL` — las tres rutas terminan en el mismo
      código de N-2, ninguna deja un 500.** Esto no cambia el código de N-2 (sigue haciendo falta
      para las tres) ni el de P-2 (sigue rechazando correctamente cualquier solicitud que SIGA
      `PENDIENTE` en el instante en que esta transacción toma su propio lock) — lo que cambia es que
      el test de N-2 (§7) tiene que sembrar explícitamente también la variante "solicitud arranca
      `PENDIENTE`, la carrera con el auto-cierre `REJECTED` gana antes de que esta transacción tome
      su lock", no asumir que esa combinación de estado inicial es inalcanzable.
    - **`EN_REVISION_MANUAL` (camino feliz de la reclasificación, sin cambios de ronda 9) —
      clasifica por el estado REAL de la factura contra lo que el operador DECLARÓ, ver abajo.**
    **Por qué P-2 no necesita invertir el orden de locks (pregunta del gate, ronda 8 — "¿el guard de
    P-2 rompe el orden factura-primero de A-4?"):** no lo rompe porque no hace falta que lo rompa.
    El guard de P-2 vive DENTRO de esta misma reclasificación — es decir, corre DESPUÉS de que el
    `UPDATE` optimista de A-2 ya falló (RETURNING vacío) y de que la factura YA está lockeada (el
    orden factura-primero de A-4 se preserva sin cambios). La pregunta genuina es otra: ¿puede
    `credit_note_request` estar `PENDIENTE` MIENTRAS la factura está genuinamente en el estado
    ambiguo que el guard de A-2 espera (`FAILED_UNCERTAIN` con `afip_contacted` y sin
    `uncertain_cleared_at`)? **No — verificado contra los 2 escritores que YA EXISTEN en código
    (`issue()` rama `FAILED_UNCERTAIN`, `reconcileAfterFailure()` rama `FAILED_UNCERTAIN`) y
    EXIGIDO como requisito de implementación para el tercero, el `UPDATE` del worker de §3.3, que
    todavía no tiene código** (corrección ronda 11, residuo #3 del veredicto de ronda 10 del gate —
    la versión anterior de este texto decía "verificado exhaustivamente" para los TRES, tratando al
    worker como un hecho ya comprobado cuando es diseño sin implementar): los 2 escritores
    existentes llaman a `transitionCreditNoteRequestAfterFailure(client, ..., 'EN_REVISION_MANUAL')`
    DENTRO DE LA MISMA transacción que escribe la factura (ver sus propios docblocks —
    `markFailedWithClient()` y la transición de `credit_note_request` commitean juntos, un solo
    commit) — verificado en HEAD. **El `UPDATE` del worker de §3.3 tiene que hacer exactamente lo
    mismo, y su gate de pre-commit (Bloque 4) tiene que probarlo con un test de integración
    dedicado, no darlo por sentado del diseño de este ADR** — ver §6, bullet "Bloque 4", condición
    de test nueva de ronda 11 (ronda 10 del gate, condición (i) sobre Bloque 4). Hasta que ese test
    exista y pase, la solidez de P-2 sobre el tercer escritor es una PROPIEDAD DE DISEÑO exigida, no
    un hecho verificado contra código real. Asumiendo que el requisito se cumple: no existe ningún
    camino que deje una factura en ese estado ambiguo con su `credit_note_request`
    todavía `PENDIENTE` — las dos escrituras son atómicas, siempre. Consecuencia: cuando A-2's
    `UPDATE` optimista SÍ matchea (la factura está genuinamente ambigua), la solicitud NUNCA puede
    estar `PENDIENTE` en ese instante — así que el guard de P-2, colocado DESPUÉS de que A-2 ya
    falló, es suficiente por construcción: el único momento en que P-2 puede ver `PENDIENTE` es
    precisamente cuando A-2 también falló (porque la factura NO está en el estado ambiguo todavía —
    el camino automático ni siquiera arrancó, o sigue genuinamente `PENDING` en vuelo), que es
    exactamente el caso "500 genérico" que P-2 mejora a un 409 clasificado. No hace falta lockear
    `credit_note_request` ANTES que la factura para cerrar A-3 en este call-site.
    **Test de regresión "fila ya CERRADA (terminal, A6.4)" (`invoice.service.test.ts`) — sin
    cambios, confirmado que sigue sin verse tocado por P-2 ni por N-2:** esa fila está seedeada con
    la factura en un estado que NO dispara el guard estricto de A-2 (sigue siendo la ambigüedad
    esperada, el `UPDATE` optimista MATCHEA), así que el flujo llega, como siempre, directo a
    `transitionWithClient()` SIN pasar por esta reclasificación — ni el guard de P-2 (`PENDIENTE`)
    ni el de N-2 (`CERRADA` idempotente-si-coincide) corren nunca para ese test, porque los dos
    viven dentro de la reclasificación y esa llamada nunca entra ahí. `transitionWithClient()` sigue
    rechazando con `CreditNoteRequestInvalidTransitionError` sin ser atrapada, mismo comportamiento
    de siempre.

    **Clasificación de la rama `EN_REVISION_MANUAL`** (`input.outcome`, `input.cbteNro`/`input.cae`
    si `outcome === 'EMITIDA'`) — **sin cambios de código respecto a la ronda 7 salvo el bullet
    nuevo de ronda 11 (residuo #2 de la ronda 10 del gate), marcado abajo:**
    - `status === 'ISSUED'` && `input.outcome === 'EMITIDA'` && `cbteNro`/`cae` COINCIDEN con lo ya
      grabado → **idempotente, no es conflicto** (double-submit con datos idénticos, u otro
      operador ya cerró con el mismo CAE real) → cierra con `resolutionOutcome: 'EMITIDA'`, SIN
      volver a escribir la factura (ya está `ISSUED` con esos valores).
    - `status === 'ISSUED'` && `input.outcome === 'EMITIDA'` && `cbteNro`/`cae` DIFIEREN →
      **decisión 2 del dueño (discrepancia de CAE) — rechaza, no cierra.**
      `logger.error({ creditNoteRequestId, invoiceId, declared: { cbteNro: input.cbteNro, cae:
      input.cae }, real: { cbteNro: snapshot.cbteNro, cae: snapshot.cae }, resolvedBy:
      input.resolvedBy }, ...)` (severidad `error`, no `warn` — es una discrepancia fiscal real,
      posible error de tipeo o dos comprobantes AFIP distintos, necesita revisión humana) y lanza
      `InvoiceResolutionCaeMismatchError(invoiceId)` (código `INVOICE_RESOLUTION_CAE_MISMATCH`,
      409 — a diferencia del error de P3 más abajo, ESTE 409 sí es accionable para quien lo recibe:
      el operador que lo disparó, que ahora sabe que tiene que parar y verificar contra AFIP en vez
      de seguir). `credit_note_request` queda SIN TOCAR (sigue `EN_REVISION_MANUAL`, visible en la
      bandeja para reintentarla con el dato correcto) — no se llama a `transitionWithClient()` en
      absoluto en esta rama.
    - `status === 'ISSUED'` && `input.outcome === 'NO_EMITIDA'` → **decisión 1 del dueño (conflicto
      de estado) — rechaza, no cierra.** `logger.warn({ creditNoteRequestId, invoiceId,
      declaredOutcome: 'NO_EMITIDA', realStatus: 'ISSUED', resolvedBy: input.resolvedBy }, ...)` y
      lanza `InvoiceResolutionStateConflictError(invoiceId, 'ISSUED')` (código
      `INVOICE_RESOLUTION_STATE_CONFLICT`, 409). `credit_note_request` sin tocar, igual que arriba.
    - `status === 'FAILED_UNCERTAIN'` && `uncertainClearedAt != null` (ya limpiada por otra
      resolución) && `input.outcome === 'NO_EMITIDA'` → **idempotente** (mismo desenlace que el
      operador declara) → cierra con `resolutionOutcome: 'NO_EMITIDA'`, sin volver a escribir.
    - `status === 'FAILED_UNCERTAIN'` && `uncertainClearedAt != null` && `input.outcome ===
      'EMITIDA'` → **decisión 1 del dueño, espejo** → rechaza con
      `InvoiceResolutionStateConflictError(invoiceId, 'NO_EMITIDA')`, `logger.warn(...)`, sin
      tocar la solicitud.
    - **NUEVO (ronda 11, residuo #2 del veredicto de ronda 10 del gate) —
      `status === 'FAILED_UNCERTAIN' && afipContacted && uncertainClearedAt == null`** (exactamente
      la ambigüedad que el guard de A-2 esperaba, ver arriba "Por qué P-2 no necesita invertir el
      orden de locks"): **este caso es DISTINTO del catch-all de abajo — es reachable y
      recuperable, no un invariante roto.** Ocurre por la misma clase de carrera que el bullet
      `CERRADA`/N-2 ya describe, pero con el camino automático resolviendo hacia la AMBIGÜEDAD en
      vez de hacia `REJECTED`: `request` `EN_REVISION_MANUAL` o `PENDIENTE` + factura `PENDING` en
      vuelo → el `UPDATE` optimista de A-2 de ESTA llamada falla (la factura todavía no es
      `FAILED_UNCERTAIN`) → mientras esta transacción reclasifica y toma sus locks, el camino
      automático (`issue()`/`reconcileAfterFailure()`/el worker de §3.3) commitea PRIMERO,
      dejando la factura `FAILED_UNCERTAIN`+`afip_contacted`+`uncertain_cleared_at IS NULL` y,
      EN LA MISMA transacción automática, la solicitud `EN_REVISION_MANUAL` (§3.9, "Por qué P-2 no
      necesita invertir el orden de locks" — los 2 escritores existentes ya lo garantizan hoy; el
      worker lo tiene que garantizar también, ver la condición de test de §6). Cuando esta
      transacción manual toma sus locks, ve EXACTAMENTE el estado que A-2 esperaba — pero el
      `UPDATE` de A-2 de ESTA llamada YA CORRIÓ y ya falló, antes de que ese estado existiera; no se
      vuelve a intentar. **Decisión de diseño (elegida sobre reintentar el escritor bajo el lock ya
      sostenido, por ser más simple y no necesitar código nuevo):** se declara un 500 TRANSITORIO Y
      RETRYABLE — `InvoiceReconciliationUnexpectedStateError(invoiceId, status)`, el MISMO tipo que
      el catch-all de abajo (no se agrega un error nuevo), pero documentado acá como recuperable sin
      intervención humana: el operador (o el cliente HTTP) repite la MISMA llamada a
      `resolveCreditNoteRequestManually()`, y esta vez el `UPDATE` optimista de A-2 SÍ matchea de
      entrada (el estado ya es el que A-2 espera, sin carrera en el medio) — resuelve directo, sin
      pasar de nuevo por esta reclasificación. Mismo patrón de "recuperable vía un reintento
      posterior de la MISMA operación" que P3 ya usa para el caso análogo de
      `finalizeIssued()`/los orquestadores de cancelación (§3.9, "P3", último bullet) — acá el
      reintento lo hace el propio operador desde la UI, no un orquestador automático, pero el
      argumento es el mismo: el estado financiero no se pierde, la próxima llamada ve el estado
      correcto y cierra bien. **No agrega un error tipado nuevo ni cambia el conteo de errores de
      N-4 (§6).**
    - Cualquier otro `status` (ej. `PENDING` genuinamente en vuelo, `REJECTED`, `FAILED_UNCERTAIN`
      con `afipContacted = false`) → invariante GENUINAMENTE no contemplado por este diseño (no la
      carrera recuperable de arriba), no se adivina qué pasó → `InvoiceReconciliationUnexpectedStateError(invoiceId, status)`
      (sin mapear a un 409 amigable — cae al `default:` de `error.middleware.ts`, 500, **a
      propósito**: honest-degradation, mejor un 500 visible que un outcome inventado).
  - **Cierre — solo en las dos ramas idempotentes de arriba:** reusa el **mismo tipo ya existente**
    (`TransitionCreditNoteRequestInput`, rama `{ toState: 'CERRADA', resolutionOutcome,
    resolvedBy, resolutionNote }`) — **sin agregar ningún valor nuevo al enum
    `CreditNoteRequestResolutionOutcome` ni tocar el CHECK
    `chk_credit_note_request_resolution_consistency`**. `resolvedBy: input.resolvedBy` se
    preserva. **Simplificación respecto a la ronda 6 (consecuencia directa de las 2 decisiones del
    dueño, ver la pregunta técnica del gate al final de este ADR):** `resolutionNote` es
    `input.note`, TAL CUAL — **sin ningún prefijo sintético**. La ronda 6 componía un prefijo
    `[auto-detectado: ...]` porque auto-cerraba también en los casos de discrepancia (necesitaba
    dejar rastro de que el sistema había corregido al operador); con las 2 decisiones del dueño,
    los casos de discrepancia ya NO se auto-cierran — rechazan antes de tocar `resolutionNote` en
    absoluto — así que las dos únicas ramas que SÍ escriben son, por construcción, las que
    coinciden con lo que el operador ya declaró: no hay nada que "auto-detectar" ni que prefijar.
    Esto también responde la pregunta abierta sobre el tope `VARCHAR(1000)` de `resolution_note`
    vs. el `z.string().trim().min(1)` sin máximo de `note` en `CreditNoteRequestResolveSchema`
    (`facturacion.schemas.ts`): **no hace falta ajustar el Zod ni separar un campo nuevo** — este
    bloque nunca agrega texto a lo que el operador escribió, el único riesgo de desborde sigue
    siendo el mismo que ya existía antes de este ADR (un operador tipeando una nota larga a mano),
    fuera de alcance de este cambio.
  - **Auditoría del intento rechazado (pregunta técnica del gate, resuelta acá) — declarado
    explícitamente: NO se persiste en ninguna columna ni tabla nueva; el rastro es el `logger.warn`/
    `logger.error` de arriba (mismo criterio que el resto de este ADR usa para logging
    estructurado — `closeAccountsReceivableGapBestEffort()`, P3 más abajo) más el hecho estructural
    de que `credit_note_request` queda `EN_REVISION_MANUAL` (visible en la bandeja) en vez de
    `CERRADA` — el operador que la vuelve a abrir ve que sigue pendiente, no que "se resolvió
    sola". Para la discrepancia de CAE (decisión 2) específicamente, el reporte (d) de §3.10 se
    extiende para volver a mostrar esta fila (ver ahí el `motivo` nuevo) — así la señal para
    revisión fiscal no depende de que el log sobreviva. Se declara como residuo A PROPÓSITO, no
    oculto: agregar una tabla de "intentos de resolución" sería una entidad nueva y una decisión de
    retención de datos propia (`criterios-negocio`), fuera del alcance aditivo de este bloque —
    si en el futuro hace falta guardar el detalle completo de cada intento, es su propio bloque, no
    una extensión silenciosa de este.
  - **Doble-submit genuino, sin conflicto de fondo** (dos llamadas concurrentes a
    `resolveCreditNoteRequestManually()` sobre el mismo `creditNoteRequestId`, ambas con el MISMO
    `outcome`/CAE que terminaría siendo el real): el lock `FOR UPDATE` de la factura y de la
    solicitud (A-4, arriba) ya lo resuelve sin necesitar el `catch` de
    `CreditNoteRequestInvalidTransitionError` que usaba la ronda 6. **Corrección N-3 (ronda 8 del
    gate, aplicada en ronda 9 — la versión anterior de este párrafo describía mal el mecanismo,
    decía "se bloquea en el `FOR UPDATE` de la solicitud"; ES FALSO, corregido acá y en §7):** la
    SEGUNDA transacción no se bloquea en ningún lock de `credit_note_request` — se bloquea en el
    lock IMPLÍCITO de la propia FACTURA, tomado por el `UPDATE` estricto de A-2 (`markIssuedFromManualResolutionWithClient()`/
    `markUncertainClearedWithClient()`) de la PRIMERA transacción, que se sostiene hasta que esa
    primera transacción commitea (invoice ISSUED + `credit_note_request` CERRADA, las dos escrituras
    de la primera transacción, en ese orden, dentro del mismo commit). Recién cuando ese lock se
    libera, la segunda transacción puede completar su propio `UPDATE` — pero re-evalúa su `WHERE`
    contra la fila YA cambiada por la primera (ya no matchea la condición que las dos ramas de
    A-2/N6 comparten — `status = 'FAILED_UNCERTAIN' AND afip_contacted AND uncertain_cleared_at IS
    NULL`, sin ninguna rama `PENDING` involucrada — corrección de terminología, ronda 11, residuo
    puntual del veredicto de ronda 10 del gate: ninguno de los dos predicados de A-2/N6 tiene una
    rama `PENDING`), así que no matchea ninguna rama y el `UPDATE` no devuelve fila ("sin fila",
    mismo caso que §3.2/§3.7). Recién ahí la segunda transacción entra a la reclasificación de A-4: lockea la
    factura (ya libre, lectura inmediata, ve `ISSUED` con los valores reales que la primera
    escribió) y lockea la solicitud (también ya libre, ve `state = 'CERRADA'`) → devuelve esa fila
    tal cual, sin error, sin reintentar el guard de escritura. **Esto no reemplaza la protección de
    `transitionWithClient()` contra un `fromState` ya terminal para el caso GENÉRICO** (el que
    verifica el test de regresión citado arriba) — sigue intacta, sin catch, para cualquier llamada
    que llegue a `transitionWithClient()` desde fuera de esta reclasificación.

  Con esto, el operador nunca se queda sin respuesta clara frente al caso de §3.13 (ni su análogo
  en `NO_EMITIDA`, ni el doble-submit): cuando el sistema ya conoce con certeza el desenlace y
  coincide con lo declarado, cierra solo (aplica el principio transversal del `CLAUDE.md` raíz de
  este repo); cuando el sistema conoce el desenlace y CONTRADICE lo declarado, rechaza con un 409
  claro y deja la solicitud abierta para que el operador la retome con el dato correcto — las 2
  decisiones del dueño, no una inferencia de este ADR.

  Nueva entrada en `EXCLUDED_FILES`/matriz RBAC: no aplica — ninguna ruta nueva, ningún
  `authorize()` nuevo, `POST /api/credit-note-requests/:id/resolve` sigue siendo la única ruta
  involucrada.

  **Referencia cruzada a corregir en la implementación (señalada por el gate en ronda 6, todavía
  sin aplicar — NO se edita código en este ADR, es documentación):** el comentario de
  `markIssuedWithClient()` en el código YA COMMITEADO del Bloque 2a (`sql.invoice.repository.ts`)
  dice, textual, que el método no tiene condición de status y que "la toma... es del Bloque 2c" —
  desactualizado en dos sentidos por el Bloque 3: (a) `markIssuedWithClient()` SÍ gana una
  condición de status con este bloque (`<> 'ISSUED'`, A-2), antes de que 2c exista; (b) esa
  condición no tiene nada que ver con la toma exclusiva de 2c (§3.2) — son dos mecanismos
  distintos sobre dos columnas distintas (`status` de `markIssuedWithClient()` vs. la toma
  `PENDING` de 2c). Actualizar ese comentario es parte del commit que implemente el Bloque 3, no
  de este documento.

### A-3 — bug previo y vivo, independiente de este ADR (cómo el Bloque 3 lo tiene en cuenta, sin arreglarlo)

Hallazgo del gate (ronda 6), **NO se arregla en este ADR** — se registra como su propio ítem en
`docs/pendientes-2026-09-12.md` (ver más abajo en este documento). Tres síntomas del mismo bug:
`ALLOWED_CREDIT_NOTE_REQUEST_TRANSITIONS.PENDIENTE` (`credit-note-request.entities.ts`) incluye
`'CERRADA'` como transición directa, sin pasar por `EN_REVISION_MANUAL`; la ruta `POST
/api/credit-note-requests/:id/resolve` (`credit-note-requests.routes.ts`) no chequea el estado de
la solicitud antes de llamar al service — solo `authorize(Roles.EMISOR_NOTA_CREDITO)`; y el
docblock de `resolveCreditNoteRequestManually()` afirma que `transitionWithClient()` "rechaza si la
fila no está en `EN_REVISION_MANUAL`" — verificado FALSO contra el código real esta sesión (el
`Record` de transiciones permite `PENDIENTE → CERRADA` directo). Consecuencia HOY (sin este ADR):
un operador puede resolver manualmente (`EMITIDA`, con datos tipeados a mano) una solicitud que
sigue `PENDIENTE` — es decir, ANTES de que el camino automático siquiera haya fallado una vez —
pisando lo que ese camino automático termine escribiendo.

**Cómo el Bloque 3 lo tiene en cuenta (no lo arregla):** el predicado ESTRICTO de
`markIssuedFromManualResolutionWithClient()` (A-2, arriba) corre INDEPENDIENTEMENTE de en qué
estado esté `credit_note_request` — mira solo `invoices.status`. Esto significa que la
CONSECUENCIA concreta que A-3 describe (pisar un CAE real con datos tipeados a mano) queda cerrada
como efecto colateral del guard, sin que haga falta arreglar la máquina de transiciones ni la ruta:
si la factura YA llegó a `ISSUED` (el camino automático ganó la carrera), el guard estricto no
matchea `status = 'FAILED_UNCERTAIN'` y el intento manual entra en la reclasificación de arriba
(que rechaza o, como mucho, cierra reflejando la MISMA verdad — nunca sobrescribe). Si la factura
TODAVÍA no llegó a `ISSUED` cuando el operador resuelve manualmente (la carrera real: automático y
manual compiten por escribir primero), el mismo guard hace que solo UNO de los dos gane la
escritura — sin importar si `credit_note_request` estaba en `PENDIENTE` o `EN_REVISION_MANUAL` en
ese momento. **Lo que el Bloque 3 NO cierra, y queda para el bloque futuro que tome A-3 como
propio:** que la resolución manual sea aceptable ANTES de que el camino automático haya fallado
siquiera una vez — sin P-2 esto sigue siendo posible; CON P-2 (ver la corrección de más abajo en
este mismo punto), esa resolución queda bloqueada de plano mientras la solicitud siga `PENDIENTE`
(que es justamente el estado en el que está ANTES de que el camino automático falle) — así que P-2
también cierra este caso, como efecto colateral, no solo el de corrupción de dato. También queda
sin cerrar el tercer síntoma citado arriba — nada transiciona
`credit_note_request` a `CERRADA` cuando el camino AUTOMÁTICO tiene éxito (`finalizeIssued()` no
transiciona nada; el único `toState: 'CERRADA'` automático real hoy es el de la rama `REJECTED` de
`issue()`) — así que una solicitud ligada a una factura que se emitió bien por el camino automático
puede quedar abierta indefinidamente, visible en la bandeja. **Corrección de ronda 13 (H3 del
veredicto de ronda 12 del gate) — "resoluble de forma segura" es cierto SOLO si la solicitud ya
está `EN_REVISION_MANUAL`, no en el caso común:** si el camino automático emitió bien la factura EN
EL PRIMER INTENTO (el caso más común — nunca pasó por `FAILED_UNCERTAIN`, así que nada la
transicionó a `EN_REVISION_MANUAL`), la solicitud queda `PENDIENTE`, y con P-2 (§3.9) aplicado,
`resolveCreditNoteRequestManually()` la RECHAZA de plano (`CreditNoteRequestNotInManualReviewError`,
409) — no "resuelve de forma segura", directamente no la deja resolver. Solo la sub-población que sí
llegó a `EN_REVISION_MANUAL` (pasó por `FAILED_UNCERTAIN` al menos una vez) tiene la propiedad
"resoluble solo de forma segura" que este párrafo describía. Ver el residuo nuevo que esto introduce
— `docs/pendientes-2026-09-12.md`, `CREDIT-NOTE-REQUEST-PENDIENTE-RESOLVE-GUARD-001`, punto (b) —
para el detalle completo de la solicitud que queda sin ninguna forma de cerrarse una vez P-2 exista.

### A-6 — callejón sin salida en `/uncertain` (resuelto arriba, en los bullets de las dos rutas)

Texto de rondas anteriores, Bloque 3 seguía en HOLD: `GET /api/invoices/uncertain` excluía TODA
factura con una `credit_note_request` propia, sin mirar el estado de esa solicitud;
`mark-not-issued` rechazaba si la factura SÍ tenía CUALQUIER `credit_note_request` ligada (por
diseño, ver el bullet de esa ruta). Secuencia alcanzable, documentada en el propio docblock de
`transitionCreditNoteRequestAfterFailure()`: solicitud `CERRADA`, reintento posterior, la factura
vuelve a `FAILED_UNCERTAIN` con `afip_contacted`, la solicitud sigue `CERRADA` (tolerado por ese
mismo método) — esa factura no aparecía en NINGUNA bandeja: `/uncertain` la excluía (tenía una
`credit_note_request`, sin mirar que ya estaba cerrada) y `mark-not-issued` la rechazaba (por la
misma razón, en sentido inverso — CUALQUIER `credit_note_request` ligada, sin distinguir estado).
**Arreglo, ya aplicado en los bullets de las dos rutas de arriba (N-1, ronda 8 del gate, aplicada
en ronda 9 — antes esta sección solo corregía `/uncertain`; el gate encontró que `mark-not-issued`
tenía el MISMO defecto en espejo y seguía sin corregir):** las dos rutas ahora narrowed de la misma
forma — excluyen/rechazan SOLO cuando la `credit_note_request` sigue ABIERTA
(`PENDIENTE`/`EN_REVISION_MANUAL`); una con la solicitud ya `CERRADA` PASA las dos: reaparece en
`/uncertain` (listada) Y `mark-not-issued` ahora la acepta (accionable) — recién con las dos
corregidas esa factura tiene una salida real, no solo visibilidad sin acción. La reconciliación
contra AFIP nueva (§3.14, P-1) reusa el MISMO criterio narrowed para su propio guard de entrada.

### P3 — Política de `finalizeIssued()` cuando su propio guard de status salta

El razonamiento de ronda 6 (`finalizeIssued()` nunca ve la fila ya `ISSUED` porque `retryExisting()`
corta antes) es una lectura vieja — `existing.status` se lee en T0 y `finalizeIssued()` corre
DESPUÉS de la llamada a AFIP (hasta ~80s, §3.4). Cuatro caminos alcanzables donde SÍ puede verla ya
`ISSUED`:
1. Antes de que 2c exista: dos reintentos concurrentes de una fila no-`PENDING`, los dos llaman a
   AFIP (mismo caso que P2(a) cierra en §3.2/§3.7 — acá lo que importa es qué pasa cuando los DOS
   vuelven con una respuesta real de AFIP).
2. Entre el deploy de 3 y el de 4 (antes de que exista el guard de Bloque 4): reintento
   concurrente sobre una `PENDING`.
3. Respuesta tardía de AFIP después de una `EMITIDA` manual (misma clase que §3.4/§3.13 ya
   reconocen) — el camino automático finalmente vuelve con una respuesta real, pero un operador ya
   cerró la solicitud a mano mientras tanto.
4. La ubicación A-3 de arriba: la resolución manual gana la carrera contra el camino automático.

**Política, aplicando el guard `<> 'ISSUED'` de `markIssuedWithClient()` (A-2, exclusivo del
camino automático):** `finalizeIssued()` atrapa `InvoiceAlreadyIssuedError`:
- **Éxito idempotente** si el `cbteNro`/`cae` que esta llamada intentaba grabar COINCIDE con lo
  que ya está persistido (`this.invoiceRepo.findById(invoiceId)`, lectura simple — no hace falta
  lock, solo se está comparando, no escribiendo) — el mismo comprobante real llegó por dos caminos
  a la vez, no hay nada que reconciliar. Devuelve la fila YA persistida (no reintenta la
  escritura) y sigue el flujo normal de `finalizeIssued()` (best-effort de
  `closeAccountsReceivableGapBestEffort()` sobre esa fila).
- **Si NO coinciden** (dos comprobantes reales distintos, o un dato corrupto): **no es un 409
  benigno** — a diferencia del 409 de discrepancia de CAE del camino manual (arriba, decisión 2 del
  dueño), acá NO hay ningún operador del otro lado esperando la respuesta HTTP a quien avisarle
  "pará y revisá" — quien llamó a `issue()`/`reconcileAfterFailure()` es el propio flujo automático
  de emisión, o (vía `retryExisting()`) un caller que ya considera la operación terminada en cuanto
  AFIP respondió que sí. Error tipado nuevo, `InvoiceIssuedComprobanteMismatchError(invoiceId)`
  (código `INVOICE_ISSUED_COMPROBANTE_MISMATCH`), **sin mapeo amigable — cae al `default:` de
  `error.middleware.ts`, 500** (honest-degradation, mismo criterio que
  `InvoiceReconciliationUnexpectedStateError`: dos comprobantes reales distintos sobre la misma
  fila es un invariante roto que necesita revisión humana, no una respuesta que el cliente pueda
  "corregir" reintentando). `logger.error({ invoiceId, attempted: { cbteNro, cae, caeVto },
  persisted: { cbteNro: current.cbteNro, cae: current.cae, caeVto: current.caeVto } }, ...)` con el
  comprobante completo de los dos lados.
- **Superficie durable que lo recoge — declarado como residuo explícito, no una omisión:** este
  repo no tiene, hoy, ningún sink de logs estructurado ni alertas más allá de lo que
  `logger.error()` escribe (mismo límite que ya declara `honest-degradation` sobre
  `db/pg.client.ts::sslConfig()`) — no hay una superficie durable dedicada para este caso
  puntual. No se le agrega una al alcance de este bloque (bloque aditivo, sin nueva infraestructura
  de observabilidad). El log queda como la única traza hasta que exista una.
- **Qué ven los orquestadores de cancelación que llaman a este camino** (`cancel-order-with-credit-note.service.ts`,
  `cancel-reservation-with-credit-note.service.ts`, vía `requestInvoice()` → ... → `retryExisting()`
  → `issue()`/`reconcileAfterFailure()` → `finalizeIssued()`): **hoy relanzan como error genérico**
  — sus `catch` atrapan específicamente `AfipRequestUncertainError`/`AfipRequestRejectedError` y
  hacen `throw err` para cualquier otro, incluido este error nuevo (verificado en código esta
  sesión: `cancel-order-with-credit-note.service.ts`, alrededor del `catch` de
  `requestInvoice()`). **Se declara ACEPTABLE, sin cambiar esos `catch` — es recuperable, porque el
  reintento ve `ISSUED`:** el operador recibe un 500 en esa llamada puntual, pero el estado
  financiero real NO se pierde — la NC/factura YA quedó `ISSUED` con un CAE real (el de la primera
  respuesta que ganó la escritura), y un reintento posterior de la MISMA operación de cancelación
  vuelve a llamar `requestInvoice()`, que resuelve la MISMA fila por idempotencia
  (`invoice:${financialTransactionId}`) y entra a `retryExisting()`, cuyo PRIMER guard
  (`if (existing.status === 'ISSUED') return existing;`) devuelve esa fila de inmediato — sin
  volver a llamar a AFIP, sin tocar el guard nuevo en absoluto. El 500 es una interrupción
  transitoria con una discrepancia logueada para revisión, no una pérdida de trabajo ni un riesgo
  de doble comprobante.

### 3.10 Reporte de reconciliación — candidato (d), complemento (decisión del dueño, RBAC `MANAGEMENT`)

Extiende `listUnreconciledLiveInvoices()` (`GET /api/invoices/unreconciled`) con un `motivo`
nuevo (ej. `'AR_REVERTED_INVOICE_LIVE'`) en vez de crear un endpoint separado — mismo contrato
de salida, un query adicional (AR `REVERTIDO` JOIN `financial_transactions` JOIN el UNION ALL de
`resolveInvoiceLinkage()` filtrado a `INVOICE_STATUSES_CONSUMING_CHARGE`).

**Cambio de RBAC, no solo de contenido:** esa ruta es hoy `FRONT_DESK`
(`accounts-receivable.routes.ts` usa `MANAGEMENT` para el resto del dominio). Subir el grupo del
endpoint completo a `MANAGEMENT` es un cambio observable para cualquier consumidor actual de esa
ruta (`FRONT_DESK` pierde acceso) — verificar en `route-consumer-coverage`/grep de
`appfrontend-main` si algo lo usa hoy antes de implementar, y si lo usa, evaluar separar el
`motivo` nuevo en un endpoint propio `MANAGEMENT` en vez de subir el existente entero (residuo a
resolver en el bloque de implementación, no bloquea este ADR).

**Segundo `motivo` nuevo (ronda 7 — decisión 2 del dueño, "queda para revisión fiscal"):**
`'MANUAL_RESOLUTION_STATE_MISMATCH'` (o el nombre que se fije al implementar) — un `LEFT JOIN`
entre `credit_note_request` en estado `EN_REVISION_MANUAL` y su `invoices` (por `invoice_id`),
filtrado a las filas donde la factura YA alcanzó un desenlace real que la solicitud todavía no
refleja: `invoices.status = 'ISSUED'` **O** (`invoices.status = 'FAILED_UNCERTAIN' AND
invoices.uncertain_cleared_at IS NOT NULL`). **Por qué esta forma de query, en vez de depender del
log de la reclasificación (§3.9):** cubre las DOS decisiones del dueño con una sola condición,
estructural, sin necesitar que ningún intento rechazado haya quedado loggeado —
`invoices.status = 'ISSUED'` con la solicitud todavía abierta es EXACTAMENTE el estado que dejan
tanto un rechazo por discrepancia de CAE (decisión 2) como un rechazo por conflicto de estado con
`input.outcome === 'NO_EMITIDA'` (decisión 1); el caso `FAILED_UNCERTAIN` con
`uncertain_cleared_at` poblado cubre el conflicto simétrico (declaró `EMITIDA`, la verdad es
`NO_EMITIDA`). Es una consulta MÁS AMPLIA que "hubo un intento rechazado" (también atrapa una
solicitud que simplemente nadie resolvió todavía después de que el estado real quedó decidido por
otra vía) — aceptable para un reporte de revisión humana, que prefiere un superset visible a un
subset que dependa de que un log sobreviva (ver la declaración de A-3/A-4 en §3.9 sobre por qué NO
se persiste el intento rechazado en una tabla nueva).

### 3.11 Alcance NC (decisión del dueño: sí, parejo con `CHARGE`)

Los reintentos de NC (`REFUND`/`ADJUSTMENT`) también toman la marca "en vuelo" — mismo mecanismo
de §3.2/§3.6. Verificado: no hay conflicto con `getInFlightCreditNoteTotalForUpdate()`
(`sql.invoice.repository.ts`), que YA cuenta `PENDING` dentro de `INVOICE_STATUSES_CONSUMING_CHARGE`
— una NC "en vuelo" por este mecanismo nuevo ya contaba para ese tope antes de este cambio, sin
comportamiento nuevo que reconciliar ahí.

`retryExisting()` solo abre la transacción de `assertChargesStillInvoiceable()` cuando hay
`chargeTxs.length > 0` (`type === 'CHARGE'` filtrado) — la toma de la marca "en vuelo" para NC
necesita su propio punto de entrada en `retryExisting()`, fuera de ese `if`, para cubrir el caso
`REFUND`/`ADJUSTMENT` puro (sin `CHARGE` en el lote). Detalle de implementación, no cambia el
diseño de arriba.

### 3.12 Los otros 8 call-sites de `resolveInvoiceLinkage()` (hueco B8 de la ronda 2, corregido en la ronda 3 — fuera de alcance de este ADR)

El gate pidió analizar, sitio por sitio, si el mismo riesgo de §3.1 (una sola fila elegida
cuando hay más de una factura ligada al cargo) también alcanza a los otros 8 call-sites. **La
tabla de la ronda 2 estaba mal — decía que los 8 comparten el riesgo; el gate, en la ronda 3,
verificó tres hechos del código que lo acotan:**

1. Cada cargo tiene como mucho **una** factura individual — la clave de idempotencia
   `invoice:${financialTransactionId}` es única (`idx_invoices_idempotency_key`).
2. Cada cargo tiene como mucho **una** factura consolidada — `idx_invoice_charges_ft` es único.
3. Una consolidada solo se arma sobre el CHARGE de empresa de una AR
   (`requestConsolidatedInvoice()` usa `ar.financialTransactionId`), y ese CHARGE nace siempre
   con `reservationId` y NUNCA con `orderId` (`postStayTransfer()`) — así que un cargo de
   ORDEN nunca puede tener una consolidada, solo puede tener su factura individual.

Con esos tres hechos, la clasificación real es:

| Call-site | Patrón | ¿Comparte el riesgo? | Por qué |
|---|---|---|---|
| `invoice.service.ts:577` (`requestInvoice()`) | Un solo `financialTransactionId` | **No** | Solo se llega ahí cuando NO existe la individual — la única fila posible es la consolidada, y hay como mucho una (hecho 2) |
| `order.service.ts::findBlockingInvoiceLinkage()` | Itera los `CHARGE` de la orden | **No** | Un cargo de orden nunca entra en una consolidada (hecho 3) — como mucho una fila |
| `cancel-order-with-credit-note.service.ts:216` | Idéntico patrón | **No** | Mismo motivo |
| `accounts-receivable.service.ts:364` (`transferStayBalanceToReceivable()`) | Itera los `CHARGE` de la estadía | **No, por construcción desde `9490ba1`** — pero con un residuo: cargos que ya se hubieran "adoptado" (`linkStayToReservationCharges()`) ANTES de ese fix podrían seguir siendo doble. Requiere una consulta contra datos reales para descartarlo del todo, no solo lectura de código. |
| `reservation.service.ts::findBlockingInvoiceLinkage()` | Itera los `CHARGE` de la reserva | **Sí** | Los cargos de una reserva SÍ incluyen el CHARGE de AR (que puede tener consolidada + individual) — con `REJECTED`+`PENDING` podría dejar cancelar con una factura en vuelo sin detectarla |
| `cancel-reservation-with-credit-note.service.ts:262` | Idéntico patrón, solo junta las `ISSUED` | Sí, acotado | El riesgo real requiere DOS `ISSUED` simultáneas sobre el mismo cargo — ese caso específico es el que cierra `DUPLICATE-CAE-001` (hallazgo hermano), no este ADR |
| `accounts-receivable.service.ts:529` / `:611` | Un solo `financialTransactionId` | Sí, acotado | Cualquier `NOT_ISSUED` bloquea igual sin importar cuál fila se elija (solo cambia la CLASE de error mostrada) — el impacto real también requiere dos `ISSUED`, mismo caso que arriba |

**Conclusión:** de los 8, **4 no comparten el riesgo en absoluto** (protegidos por unicidad
estructural), **1 requiere una consulta de datos reales para descartarlo del todo** (residuo,
no bloquea este ADR), y **3 comparten una versión acotada del riesgo** — pero su forma real es
"dos facturas `ISSUED` sobre el mismo cargo", que es exactamente el mecanismo que
`DUPLICATE-CAE-001` (hallazgo hermano, gate separado en curso) ya está diseñando cerrar. Se
registra como hallazgo nuevo en `docs/pendientes-2026-09-12.md`
(`INVOICE-LINKAGE-LIMIT1-MULTI-INVOICE-001`) con esta tabla, fuera de los 6 bloques de §6 —
pero cruzado explícitamente con `DUPLICATE-CAE-001`, no como un hallazgo aislado.

### 3.13 Residuo declarado: respuesta tardía de AFIP después de `NO_EMITIDA` + reversa

Si una respuesta de AFIP llega DESPUÉS de que el worker (§3.3) marcó la factura
`FAILED_UNCERTAIN`, un operador la limpió como `NO_EMITIDA` (§3.9), y `reverseTransfer()` ya
revirtió la AR (§3.8) — el `markIssued()` que procesa esa respuesta tardía es incondicional (no
chequea si la AR sigue vigente) y la pasaría a `ISSUED` sobre una AR ya `REVERTIDO`. Ningún
mecanismo de este bloque lo detecta en el momento — el único que lo vería después es el reporte
(d) de §3.10, que cruza exactamente ese cruce (AR `REVERTIDO` vs. factura viva del mismo cargo).
Se deja así a propósito (mismo criterio que el resto de este ADR: el reporte es la red de
seguridad para el residuo que el mecanismo preventivo no puede cerrar del todo, no una excusa
para no prevenir lo que sí se puede).

### 3.14 Reconciliación contra AFIP (P-1, decisión del dueño, ronda 9 — extendida en ronda 11 con
"AFIP prevalece" y corregida en 4 puntos por el veredicto de ronda 10 del gate)

**Decisión del dueño (`AskUserQuestion`, esta sesión, citada íntegra en el encabezado):** para una
factura `CHARGE` (o una NC cuya `credit_note_request` ya está `CERRADA`) que quedó
`FAILED_UNCERTAIN` cuando AFIP en realidad SÍ emitió el comprobante, el sistema consulta el
comprobante real contra AFIP mismo en vez de que el operador tipee un CAE a mano — elimina el
riesgo de tipeo/discrepancia que la decisión 2 de ronda 7 (§3.9, "A-2") todavía deja abierto para
el camino puramente manual: AFIP es la fuente de verdad, no lo que el operador copia.

**Población objetivo — DOS ramas (la segunda es nueva, ronda 11, "AFIP prevalece" — hueco #5 del
veredicto de ronda 10 del gate):**
1. **Nunca limpiada (la MISMA población que `GET /api/invoices/uncertain` lista, tras el fix de A-6,
   ronda 7):** `status = 'FAILED_UNCERTAIN' AND afip_contacted AND uncertain_cleared_at IS NULL`.
2. **NUEVA — ya limpiada a mano (`NO_EMITIDA`), decisión "AFIP prevalece":**
   `status = 'FAILED_UNCERTAIN' AND afip_contacted AND uncertain_cleared_at IS NOT NULL`.

En las dos ramas, además: (`credit_note_request` ausente — camino `CHARGE`) O (`credit_note_request`
propia ya `CERRADA` — camino NC). Una factura con `credit_note_request` todavía ABIERTA
(`PENDIENTE`/`EN_REVISION_MANUAL`) NO es población de esta ruta en ninguna de las dos ramas — esa
sigue resolviéndose por `POST /credit-note-requests/:id/resolve`, mismo criterio de exclusividad ya
declarado para `mark-not-issued` (hueco B7 del gate, ronda 2: dos salidas para el mismo caso serían
dos fuentes de verdad divergentes).

**¿Importa el `status` real de la factura al momento de reconciliar, o solo si está "limpiada"
(pregunta explícita del dueño esta sesión sobre la extensión de ronda 11)? Sí, con un residuo
aceptado por el dueño — corregido en ronda 13 (H1 del veredicto de ronda 12 del gate: la redacción
de ronda 11 de este párrafo afirmaba "nunca escribe un comprobante viejo sobre un estado más nuevo",
que es FALSO, ver el detalle completo en la sección "AFIP prevalece" más abajo; acá solo el
resumen honesto):** la rama 2 (ya limpiada) solo puede matchear mientras la factura SIGA
`status = 'FAILED_UNCERTAIN'` — si alguien ya reintentó la factura después de la declaración
`NO_EMITIDA` (posible: `uncertain_cleared_at` poblado es precisamente lo que `retryExisting()` exige
para volver a intentar, §3.2), el `status` real ya cambió (a `PENDING` mientras el reintento está en
vuelo; a `ISSUED`/`REJECTED`/`FAILED_UNCERTAIN`-fresca cuando resuelve). Mientras el reintento sigue
`PENDING` o ya terminó `ISSUED`/`REJECTED`, la rama 2 no matchea del todo (correcto, sin residuo).
**Pero si el reintento vuelve a fallar de forma ambigua** (`FAILED_UNCERTAIN` fresco, `afip_contacted`
— con `uncertain_cleared_at` reseteado a `NULL` por §3.5 SI el Bloque 2c/4 que implementa ese reset ya
está desplegado, o todavía poblado con el valor viejo si Bloque 3 se desplegó solo, sin que el
resultado cambie en ningún caso — ver el punto siguiente): el predicado de escritura de
`reconcile-with-afip` (`status = 'FAILED_UNCERTAIN' AND afip_contacted`, sin mirar
`uncertain_cleared_at` en ninguno de los dos casos — ver la sección "AFIP prevalece" más abajo) sigue
matcheando IGUAL sobre esa misma fila — no distingue "este
`FAILED_UNCERTAIN` es el intento viejo que el operador está reconciliando" de "este
`FAILED_UNCERTAIN` es un intento MÁS NUEVO, todavía sin resolver, que volvió a caer en ambigüedad".
Si el `cbteNro` que el operador aporta (correspondiente al intento viejo) pasa la validación cruzada
contra AFIP — posible porque `retryExisting()` reusa el MISMO `afipRequest` en cada reintento (mismo
`CbteFch`, mismos montos, ver más abajo) —, la escritura procede sobre la fila del intento NUEVO,
no sobre la que el operador creía estar reconciliando. **Esto es exactamente el residuo "AFIP
prevalece también sobre un reintento más nuevo" — decisión del dueño (esta sesión, ronda 13):
"Prevalece igual, registrar el residuo"** — el mecanismo se acepta tal como está diseñado (AFIP,
fuente verificada, gana), y el caso borde se documenta como residuo conocido en vez de resolverse con
mecanismo o schema nuevo (registrado en `docs/pendientes-2026-09-12.md` como
`ISSUE-BEFORE-REVERSE-WINDOW-001-AFIP-PREVAILS-NEWER-ATTEMPT-SHADOW-001`). El diseño NO compara
"intento viejo vs. nuevo" explícitamente porque el predicado de
escritura no lo necesita para su propósito declarado (AFIP prevalece sobre cualquier declaración
previa) — lo que sí significa es que el predicado no puede, por sí solo, garantizar que el
comprobante que se graba es el que corresponde al intento que el operador cree estar reconciliando.

**Ruta nueva:** `POST /api/invoices/:id/reconcile-with-afip`. RBAC: `Roles.EMISOR_NOTA_CREDITO`
(mismo precedente que el resto de esta bandeja, §2). Body: `{ cbteNro: number }`
(`ReconcileInvoiceWithAfipSchema`, `api/schemas/facturacion.schemas.ts`, `z.object({ cbteNro:
z.number().int().positive() })`). **Por qué el operador sigue aportando `cbteNro` — esto NO es "el
operador tipea el CAE", es distinto:** el sistema no tiene forma de identificar SOLO, sin ayuda,
CUÁL comprobante de AFIP corresponde a esta factura puntual. `getLastVoucher(ptoVta, cbteTipo)`
(ya usado por `reconcileAfterFailure()`, ver `issue()`) devuelve el ÚLTIMO comprobante de ESE punto
de venta+tipo — pero `ptoVta`/`cbteTipo` se comparten entre TODAS las facturas `CHARGE` (o NC) de
ese tipo del negocio, no son exclusivos de esta factura; si otras facturas se emitieron con éxito
mientras esta quedó incierta (caso normal, no raro, en un negocio con más de una factura por día),
"el último comprobante ahora" ya no es el de esta factura. `reconcileAfterFailure()` evita ese
problema comparando contra `lastVoucherBefore`, un valor capturado en MEMORIA al arrancar ESE
intento puntual — dato que no sobrevive más allá de esa invocación y que esta factura, si lleva
horas o días colgada, ya no tiene. Sin ese dato, la única forma de identificar el comprobante
correcto es que el operador lo traiga (mirando el propio portal de AFIP, con el mismo criterio con
que hoy identifica el CAE a mano) — lo que CAMBIA con P-1 es que el `cbteNro` que el operador aporta
es un ÍNDICE que el sistema verifica contra AFIP (barato de acertar mal: si el número no corresponde
a esta factura, la validación cruzada de abajo lo detecta y rechaza), no el CAE en sí (un string
opaco sin relación estructural con la factura, cuyo error de tipeo no tiene ninguna forma de
autodetectarse — exactamente el riesgo que esta decisión existe para cerrar).

**Guard de entrada — reusa el MISMO guard narrowed de N-1 (mark-not-issued), no uno nuevo:**
`InvoiceHasOpenCreditNoteRequestError` (409, ver §3.9) si la factura tiene una `credit_note_request`
propia que sigue ABIERTA. Corre ANTES de tocar AFIP (barato, sin llamada de red).

**Paso 1 — consulta contra AFIP:** `port.getVoucherInfo(input.cbteNro, invoice.ptoVta,
invoice.cbteTipo)` (mismo `AfipBillingPort`/`ArcaSdkBillingAdapter` que el resto de
`InvoiceService`, ya wrappeado en `withAfipTimeout()` dentro del adapter — no hace falta agregar un
timeout nuevo). **Modos de falla de esta llamada (pregunta explícita del gate al pedir este
mecanismo) — mismo convenio que el resto de las 7 llamadas AFIP de este repo
(`afip-request.timeout.ts`), NO el `.catch(() => null)` que usa `reconcileAfterFailure()`:**
`reconcileAfterFailure()` puede tragarse el error porque es un intento AUTOMÁTICO, de background,
sin nadie esperando una respuesta HTTP sincrónica — "no se pudo reconciliar, queda incierto" es una
respuesta aceptable ahí. Acá hay un OPERADOR esperando el resultado de un click: tragar el error en
silencio y devolver "no se encontró" sería indistinguible de "AFIP confirma que no existe ese
comprobante" — dos situaciones completamente distintas que un operador necesita poder diferenciar
(una dice "el comprobante nunca se emitió, andá por NO_EMITIDA"; la otra dice "no sé, probá de
nuevo"). Por eso, mismo patrón que `padron.service.ts` (`AfipPadronUnavailableError`): la llamada va
en un `try/catch` que envuelve CUALQUIER excepción (timeout de `withAfipTimeout()`, fault SOAP,
error de red) y la relanza tipada:

```ts
let info: VoucherInfoResult | null;
try {
  info = await port.getVoucherInfo(input.cbteNro, invoice.ptoVta, invoice.cbteTipo);
} catch (err) {
  throw new AfipReconciliationUnavailableError(invoiceId, errMessage(err));
}
```

`AfipReconciliationUnavailableError` (código `AFIP_RECONCILIATION_UNAVAILABLE`, 503 — mismo grupo
semántico que `AFIP_NOT_CONFIGURED`/`AFIP_PADRON_UNAVAILABLE`: dependencia externa caída,
reintentable por el operador con solo volver a apretar el botón, no un dato corrupto del request).
**No hay reintento automático ni circuit breaker propio de este mecanismo** — este repo no tiene
ninguno para AFIP en ningún call-site existente (`afip-request.timeout.ts`, docblock: un solo
timeout de aplicación de 20s por llamada, sin retry); agregar uno acá sería una pieza de
infraestructura nueva no pedida por el dueño ni precedente en el repo — fuera de alcance, mismo
criterio que P3 declara para la falta de un sink de logs dedicado.

**Paso 2 — AFIP responde, pero sin comprobante real (`info === null` o `info.codAutorizacion`
vacío):** `throw new AfipVoucherNotFoundError(invoiceId, input.cbteNro, invoice.ptoVta,
invoice.cbteTipo)` (código `AFIP_VOUCHER_NOT_FOUND`, 422 — mismo grupo que `AFIP_REQUEST_REJECTED`:
el request llegó bien formado, pero lo que afirma no está respaldado por AFIP). **No dispara
ninguna transición** — el operador recibe un 422 y, aparte, puede usar `mark-not-issued`/`resolve`
con `NO_EMITIDA` si corresponde — dos acciones separadas, no una cascada automática (mismo criterio
de "no reemplazar la decisión del operador por una inferencia" que ya rige el resto de esta
bandeja).

**Corrección de redacción (ronda 11, gap 4(d) del veredicto de ronda 10 del gate — bug de
corrección real, no solo de texto):** este 422 NUNCA se redacta ni se documenta como "AFIP confirma
que el comprobante no se emitió" — la redacción correcta, en el mensaje del error y en cualquier
guía al operador, es **"no se pudo confirmar ese comprobante contra AFIP"**. Motivo, verificado
leyendo el mapper real del SDK (`mapVoucherInfo()`,
`node_modules/@arcasdk/core/lib/infrastructure/mappers/soap-to-dto.mapper.js`, invocado por
`ElectronicBillingRepository.getVoucherInfo()`): `info === null` sale de
`if (!soapResult.ResultGet) { return null; }` — un `return null` temprano que descarta
`soapResult.Errors` sin mirarlo. Eso significa que `null` puede salir de DOS causas indistinguibles
para este código: (a) AFIP genuinamente no tiene ningún comprobante con ese `cbteNro`/`ptoVta`/
`cbteTipo`, o (b) la respuesta de AFIP vino con un error (`Errors` poblado) pero sin `ResultGet` —
un fallo del lado de AFIP, no una confirmación de inexistencia. Además, aun si (a) es cierto para
ESTE `cbteNro` puntual, eso NO dice nada sobre si la factura fue emitida bajo un `cbteNro`
DISTINTO — el operador puede haberse equivocado de número, no de existencia. Seguir la redacción
vieja ("no se emitió") hacia `NO_EMITIDA` y de ahí a `retryExisting()` podría producir un CAE real
duplicado sobre una factura que en realidad SÍ tiene comprobante, solo que bajo otro número o
detrás de un error de AFIP no propagado. La redacción nueva es deliberadamente conservadora: empuja
al operador a seguir investigando (mirar el portal de AFIP directamente, probar otro `cbteNro`) en
vez de concluir `NO_EMITIDA` de un solo lookup fallido.

**Paso 3 — AFIP confirma un comprobante real, pero validación cruzada contra ESTA factura falla —
corregida en 2 puntos por el veredicto de ronda 10 del gate (gaps 4(a)/4(b)):**

**Corrección de nombres de campo (ronda 11, gap 4(b) — la redacción de ronda 9 usaba nombres
SOAP-style contra `info.raw` como si `raw` siguiera siendo XML crudo; es FALSO):** verificado
leyendo `arca-sdk-billing.adapter.ts::getVoucherInfo()` y el mapper real del SDK
(`mapVoucherInfo()`, `soap-to-dto.mapper.js` de `@arcasdk/core`) — el puerto (`afip-billing.port.ts`,
interfaz `VoucherInfoResult`) hoy solo expone `codAutorizacion`/`fchVto`/`raw`, pero el DTO que el
SDK ya arma (`VoucherInfo`, `electronic-billing.types.d.ts`) trae, en camelCase, TODOS los campos
que esta validación necesita: `docTipo`, `docNro`, `impTotal`, `cbteFch`, `impNeto`, `impIVA`,
`concepto`, `monId` (además de `impTotConc`/`impOpEx`/`impTrib`/`monCotiz`, no usados acá). **Este
bloque extiende `VoucherInfoResult` (`afip-billing.port.ts`) con esos 8 campos, y
`ArcaSdkBillingAdapter.getVoucherInfo()` (`arca-sdk-billing.adapter.ts`) los reenvía desde `info`
sin transformarlos** — mismo patrón ya usado para `codAutorizacion`/`fchVto`. La validación cruzada
compara SIEMPRE contra estos campos tipados del puerto (`info.docTipo`, `info.impTotal`, etc.),
nunca contra `info.raw` parseado a mano con nombres PascalCase — `info.raw` sigue existiendo y
sigue persistiéndose en `afip_response` (auditoría), pero deja de usarse para lógica de negocio en
este paso.

**Extensión de la validación cruzada (ronda 11, gap 4(a) — la de ronda 9 solo cruzaba
`ImpTotal`/`DocNro`/`DocTipo`, y esos dos últimos NO discriminan nada para el caso común):**
Consumidor Final es el comprador por default (`DocTipo 99`, sin CUIT/DNI —
`afip-catalog.constants.ts::DOC_TIPO_CONSUMIDOR_FINAL`, `invoice.service.ts` línea de construcción
de `afipRequest`, buscar por nombre) — así que para la mayoría de las facturas `DocTipo`/`DocNro`
son el MISMO valor fijo (`99`/ausente) en TODA factura a consumidor final, y no distinguen nada
entre dos comprobantes reales distintos. Se agregan: `cbteFch` (fecha del comprobante),
`impNeto`/`impIVA` (desglose, no solo el total), `concepto`/`monId` (tipo de operación y moneda) —
comparados contra `invoice.afipRequest.CbteFch`/`ImpNeto`/`ImpIVA`/`Concepto`/`MonId` (mismo
request PascalCase persistido desde `createWithClient()`/`buildCreditNote()`, sin cambios ahí). Si
CUALQUIERA de los 8 campos (`docTipo`, `docNro`, `impTotal`, `cbteFch`, `impNeto`, `impIVA`,
`concepto`, `monId`) no coincide, `throw new AfipVoucherMismatchError(invoiceId,
input.cbteNro)` (código `AFIP_VOUCHER_MISMATCH`, 422, mismo grupo). **Residuo declarado a
propósito, no silenciado (gap 4(a)):** dos facturas REALES distintas a Consumidor Final, por el
MISMO monto, misma fecha, mismo desglose de IVA, mismo concepto y moneda, seguirían pasando esta
validación cruzada indistinguibles entre sí — sobreclamar que esta validación "confirma que el
comprobante es de esta factura" sería falso; lo que confirma es "el comprobante es CONSISTENTE con
esta factura en todos los campos disponibles", que es lo máximo que este mecanismo puede dar sin
más información (ninguna combinación de campos de WSFEv1 identifica unívocamente una factura del
lado del EMISOR — eso es exactamente lo que el operador todavía tiene que aportar con `cbteNro`,
ver arriba). **`CbtesAsoc` (comprobantes asociados, relevante para Notas de Crédito) NO está
disponible por este mecanismo — verificado, no asumido:** el tipo SOAP crudo (`ICbtesAsoc`,
`wsfe-service-soap.types.d.ts`) sí trae este campo en `FECompConsultarResult.ResultGet`, pero el
propio mapper del SDK (`mapVoucherInfo()`) NO lo incluye en el DTO que expone — se pierde adentro
del SDK, antes de llegar a nuestro adapter. Agregarlo requeriría bypassear el DTO del SDK y leer el
SOAP crudo directamente (cambio de alcance mayor, no pedido por el dueño) — declarado como residuo
explícito, no un hueco silencioso: si en el futuro hace falta cross-validar `CbtesAsoc` para NC,
es su propio bloque de trabajo sobre el adapter/puerto. **Por qué el resto de la validación no es
opcional:** sin ella, un operador que se equivoca de `cbteNro` (typo, o confunde dos facturas
`FAILED_UNCERTAIN` de la misma bandeja) podría hacer que ESTA factura quede `ISSUED` con el CAE de
UN COMPROBANTE AJENO real — un bug peor que el que P-1 vino a cerrar (el comprobante ajeno queda
"duplicado" en dos facturas del sistema, y la factura real que sí le corresponde ese CAE queda sin
ningún registro apuntándola). La comparación NO necesita tolerancia de redondeo ni normalización
compleja — son los mismos campos, mismo formato, que el propio negocio ya generó en el request
original (salvo el residuo de Consumidor Final declarado arriba).

**Nuevo — colisión de `cbteNro` con otra factura ya registrada (ronda 11, gap 4(c) del veredicto de
ronda 10 del gate):** el `cbteNro` que AFIP confirma para ESTA factura puede coincidir con el de
OTRA factura ya persistida — golpea el índice único `idx_invoices_talonario` (`schema.sql`,
`(business_id, pto_vta, cbte_tipo, cbte_nro) WHERE cbte_nro IS NOT NULL`) al intentar el `UPDATE`
del Paso 4. HOY, ese Postgres `23505` no está mapeado en `error.middleware.ts` (verificado — no
hay ningún manejo de `unique_violation` en ese archivo) y cae al `default:`, 500 `INTERNAL_ERROR`
genérico, indistinguible de cualquier otro error de infraestructura. **Resolución:** los dos
escritores que pueden setear `cbte_nro` desde un valor aportado por un operador (no generado por
`createNextVoucher()` — el guard `<> 'ISSUED'` de `markIssuedWithClient()`, camino automático,
nunca puede chocar acá porque el número lo genera AFIP en secuencia) — `markIssuedFromManualResolutionWithClient()`
(camino puramente manual, A-2) y el escritor nuevo de la sección "AFIP prevalece" más abajo — atrapan
el error de Postgres en el `UPDATE` (`sql.invoice.repository.ts`), detectan `err.code === '23505'`
sobre la constraint `idx_invoices_talonario` (`err.constraint`, patrón ya distinguible con el driver
`pg`) y relanzan `InvoiceVoucherNumberAlreadyRegisteredError(invoiceId, cbteNro, ptoVta, cbteTipo)`
(código `INVOICE_VOUCHER_NUMBER_ALREADY_REGISTERED`, 409 — mismo grupo semántico que el resto de
409 de este ADR: precondición fiscal violada, accionable por el operador, que tiene que revisar
cuál de las dos facturas es la correcta antes de reintentar). Un choque en el camino AUTOMÁTICO
(`createNextVoucher()` generando un número que AFIP mismo ya emitió) indicaría un bug de
sincronización más profundo, fuera de alcance de este bloque — sigue cayendo al 500 genérico, sin
cambios ahí.

**Paso 4 — validación cruzada pasa: usa el escritor NUEVO, exclusivo de este mecanismo, para las
DOS ramas de población de `reconcile-with-afip` — corregido en ronda 13 (H2 del veredicto de ronda
12 del gate: la redacción de ronda 11 dejaba esto contradicho, ver la nota de la corrección más
abajo). `resolveCreditNoteRequestManually()` (camino puramente manual, A-2) sigue siendo el ÚNICO
caller de `markIssuedFromManualResolutionWithClient()` — ese método queda EXCLUSIVO del camino
manual, nunca invocado desde acá:**

- **Rama 1 (nunca limpiada, `uncertain_cleared_at IS NULL`) y Rama 2 (ya limpiada,
  `uncertain_cleared_at IS NOT NULL` — "AFIP prevalece", ronda 11):** las DOS llaman al escritor
  nuevo `markIssuedFromAfipReconciliationWithClient()` (ver la sección propia más abajo) — un solo
  `WHERE` cubre las dos poblaciones, mismo criterio que esa sección ya declara.

**Corrección de ronda 13 (H2 del veredicto de ronda 12 del gate) — por qué la redacción anterior
era una contradicción real, no solo de texto:** hasta ronda 12, este Paso 4 routeaba la Rama 1 al
escritor de A-2 (`markIssuedFromManualResolutionWithClient()`, que exige `uncertain_cleared_at IS
NULL`), mientras la sección "Interacción con `mark-not-issued`/N6" (más abajo) ya asumía que la
Rama 1 pasaba por el escritor NUEVO y describía que "escribe igual" frente a una carrera con
`mark-not-issued` — las dos secciones del mismo documento describían DOS mecanismos distintos para
el mismo caso. Con el routing tal como estaba escrito, si `mark-not-issued` ganaba la carrera
primero (dejando `uncertain_cleared_at` poblado, `status` todavía `FAILED_UNCERTAIN`), el `UPDATE`
de A-2 para la Rama 1 YA NO matcheaba (su guard exige `uncertain_cleared_at IS NULL`) y la
reconciliación caía en la reclasificación sin haber escrito — no el comportamiento "AFIP prevalece"
que el diseño dice perseguir, sino un 500/409 según el caso. El fix, consistente con la intención ya
declarada del propio mecanismo ("cubre las DOS ramas con un solo `WHERE`"): `reconcile-with-afip`
usa el escritor nuevo para TODA su población, sin excepción — el escritor de A-2 nunca se invoca
desde esta ruta, en ninguna rama.

En las dos ramas, el payload es el mismo:

```ts
{
  cbteNro: input.cbteNro,
  cae: info.codAutorizacion!,
  caeVto: info.fchVto ? afipDateToIso(info.fchVto) : afipDateToIso(toAfipDate(new Date())),
  afipResponse: { reconciledWithAfip: true, requestedCbteNro: input.cbteNro, resolvedBy: input.resolvedBy, raw: info.raw },
}
```

A diferencia del camino puramente manual de hoy (`resolveCreditNoteRequestManually()`, rama
`EMITIDA` — ver el comentario de esa rama, "Sin respuesta cruda de AFIP"), ACÁ SÍ hay una respuesta
real de AFIP — se persiste (`raw: info.raw`, dentro de la marca `afipResponse`, mismo patrón que ya
usa `manualResolution: true` para distinguir el origen de un `ISSUED` — acá la marca es
`reconciledWithAfip: true`, para poder distinguir en auditoría los tres orígenes posibles de un
`ISSUED`: automático, manual-tipeado, y esta reconciliación). **Si el guard estricto NO matchea**
(alguien más ya escribió sobre esta factura entre el `getVoucherInfo()` y este `UPDATE` — ventana de
milisegundos, pero real; también puede matchear el error nuevo de colisión de `cbteNro`, gap 4(c)
arriba): sube `AfipReconciliationPreconditionError` — el mismo error de precondición para las DOS
ramas, porque las dos usan el mismo escritor (corrección de ronda 13, H2 — antes decía "A-2's
`InvoiceManualResolutionPreconditionError` para la rama 1", que asumía el routing viejo ya
corregido arriba) —, y ESTE endpoint reusa la MISMA reclasificación bajo lock de A-4 (lockear factura,
`getReconciliationSnapshotForUpdate()`) — **pero SIN la parte de `credit_note_request`:** la
población de esta ruta nunca tiene una solicitud ABIERTA (el guard de entrada ya lo garantiza), así
que no hace falta `findByIdForUpdate()` ni ninguna de las ramas de N-2/P-2 — si el guard estricto no
matchea, la única causa posible dentro de esta población es que la factura YA se resolvió por otra
vía (automática, o `mark-not-issued`) entre la lectura y la escritura — se relee bajo lock y, si el
comprobante coincide con lo que esta llamada iba a grabar, éxito idempotente (mismo criterio de P3);
si no coincide, error tipado sin mapeo amigable (mismo criterio que P3 — invariante roto, revisión
humana, no un 409 que el operador pueda "corregir" reintentando).

**Post-commit:** `closeAccountsReceivableGapBestEffort()` sobre la factura recién `ISSUED`, mismo
patrón que `finalizeIssued()`/`resolveCreditNoteRequestManually()` (rama `EMITIDA`).

**No transiciona `credit_note_request`:** la población de esta ruta o no tiene solicitud (`CHARGE`)
o la tiene ya `CERRADA` (terminal, nada que transicionar) — a diferencia de
`resolveCreditNoteRequestManually()`, este endpoint solo escribe la FACTURA. **Residuo declarado
para la rama 2 (ronda 11):** si la `credit_note_request` ya `CERRADA` tenía
`resolutionOutcome: 'NO_EMITIDA'` (la declaración manual que esta reconciliación acaba de
contradecir), ese `resolutionOutcome` queda DESACTUALIZADO — la solicitud sigue diciendo
`NO_EMITIDA` mientras la factura ya es `ISSUED`. Mismo criterio que P3 declara para su caso
análogo: el único rastro es `logger.warn`/`logger.error` (ver la sección "AFIP prevalece" más
abajo), sin superficie durable nueva — y el reporte (d) de §3.10 HOY no lo detecta, porque su
segundo `motivo` filtra `credit_note_request` en `EN_REVISION_MANUAL`, no `CERRADA`. Extender ese
filtro (o agregar un tercer `motivo`) queda registrado como hallazgo — **corrección de ronda 13 (H3
del veredicto de ronda 12 del gate): la ronda 11 afirmaba que esto "queda registrado como hallazgo
nuevo en `docs/pendientes-2026-09-12.md`", pero un grep contra ese archivo esta ronda confirma que
NO estaba — recién ahora está, como `ISSUE-BEFORE-REVERSE-WINDOW-001-AFIP-PREVAILS-RESOLUTION-OUTCOME-STALE-001`**,
fuera de alcance de este bloque.

### AFIP prevalece sobre una declaración manual previa (decisión del dueño, ronda 11)

**Por qué NO se reusa `markIssuedFromManualResolutionWithClient()` con el predicado relajado, y en
cambio se agrega un escritor nuevo:** ese método también lo llama la rama `EMITIDA` de
`resolveCreditNoteRequestManually()` (camino puramente manual, CAE tipeado a mano, sin verificación
independiente) — si se le sacara la condición `uncertain_cleared_at IS NULL` del `WHERE` para
habilitar la rama 2 de arriba, esa misma relajación se colaría también al camino puramente manual,
permitiendo que un CAE TIPEADO A MANO (sin que AFIP lo haya confirmado) sobrescriba una factura que
un operador ya declaró `NO_EMITIDA` — exactamente la clase de conflicto que la decisión 1 de ronda 7
("conflicto de estado, rechaza y deja abierta") existe para bloquear en ese camino. Mismo criterio
que ya usó A-2 para separar `markIssuedWithClient()` (automático) de
`markIssuedFromManualResolutionWithClient()` (manual): **"un método por contrato de escritura, no
una rama condicional adentro".** `resolveCreditNoteRequestManually()` NO se toca — sigue llamando
únicamente a `markIssuedFromManualResolutionWithClient()`, con su predicado estricto sin cambios, y
sigue rechazando (decisión 1) cualquier declaración `EMITIDA` sobre una factura ya limpiada
`NO_EMITIDA`.

**Escritor nuevo, exclusivo de `reconcile-with-afip`:** `markIssuedFromAfipReconciliationWithClient()`
(`sql.invoice.repository.ts`/`invoice.repository.ts`), predicado MÁS ANCHO que A-2 a propósito —
cubre las DOS ramas de población de este mecanismo con un solo `WHERE` (no dos escrituras
distintas): no exige `uncertain_cleared_at IS NULL`, porque AFIP (fuente verificada) es más fuerte
que cualquier declaración manual previa, limpia o no. **No toca `uncertain_cleared_at` NI
`uncertain_cleared_by` en el `SET` — corregido en ronda 13 (H3 del veredicto de ronda 12 del gate:
la versión de ronda 11 limpiaba `uncertain_cleared_at = NULL`, borrando en la rama 2 la única
evidencia durable de que existió una declaración manual `NO_EMITIDA` que AFIP terminó
contradiciendo):**

```sql
UPDATE invoices
   SET cbte_nro = $2, cae = $3, cae_vto = $4, afip_response = $5,
       status = 'ISSUED', issued_at = NOW(), pending_since = NULL
 WHERE id = $1
   AND status = 'FAILED_UNCERTAIN' AND afip_contacted
 RETURNING *
```

**Por qué dejar las dos columnas sin tocar, en vez de limpiarlas (recomendación del gate, ronda
12):** para la rama 1 (nunca limpiada), `uncertain_cleared_at`/`uncertain_cleared_by` ya son `NULL`
— no tocarlas no cambia nada, sigue siendo `NULL` después del `UPDATE` igual que antes. Para la rama
2 ("AFIP prevalece"), esas dos columnas tienen el valor que dejó la declaración manual `NO_EMITIDA`
original (`markUncertainClearedWithClient()`, N6) — dejarlas como están, en vez de limpiarlas al
pasar a `ISSUED`, preserva en la propia fila la evidencia de que hubo una declaración manual previa y
de quién la hizo, que AFIP terminó contradiciendo. Es exactamente el tipo de rastro que le importa a
una auditoría o a un reporte de reconciliación futuro ("¿esta factura tuvo una declaración manual
`NO_EMITIDA` antes de que AFIP la reconciliara?") — limpiarlas destruiría esa evidencia sin ganar
nada a cambio (ningún guard de este mecanismo lee `uncertain_cleared_at` una vez que `status` ya es
`ISSUED`, así que dejarlas pobladas no reabre ninguna carrera ni cambia el comportamiento de ningún
predicado existente).

**Qué garantiza este predicado sin mirar `uncertain_cleared_at`, y qué NO garantiza — corregido en
ronda 13 (H1 del veredicto de ronda 12 del gate: la redacción de ronda 11 de este párrafo afirmaba
que el predicado "NUNCA puede matchear" un intento más nuevo — FALSO, contradecía su propio SQL y el
test de §7 que asumía lo mismo; ese test también se corrige, ver §7):** `status = 'FAILED_UNCERTAIN'
AND afip_contacted`, sin condición sobre `uncertain_cleared_at`, es EXACTAMENTE la unión de las dos
ramas de población declaradas arriba — eso SÍ es cierto, y es intencional (un solo `WHERE` para las
dos ramas). Lo que NO es cierto es que el invariante de §3.5 (`uncertain_cleared_at` se resetea a
`NULL` cuando una fila vuelve a `FAILED_UNCERTAIN`) haga que este predicado distinga "el intento que
esta llamada está reconciliando" de "un intento MÁS NUEVO que volvió a caer en la misma ambigüedad":
el reset de §3.5 cambia el valor de `uncertain_cleared_at`, pero este predicado NO MIRA esa columna
— así que una fila que re-entra en `FAILED_UNCERTAIN`+`afip_contacted` (reintento posterior,
nuevamente ambiguo) sigue matcheando el mismo `WHERE`, indistinguible en SQL del intento original.
Lo que el predicado SÍ evita: si el reintento sigue `PENDING` en vuelo, o ya resolvió a
`ISSUED`/`REJECTED`, el predicado deja de matchear del todo (esos tres `status` no son
`FAILED_UNCERTAIN`) — ahí sí, la reclasificación (arriba) compara contra el estado REAL y no escribe
sobre un desacuerdo sin marcarlo. El hueco real está acotado al caso donde el reintento TERMINA
otra vez en `FAILED_UNCERTAIN` ambiguo: ahí el predicado matchea la fila del intento nuevo con la
misma facilidad que matchearía la del intento viejo, y si el `cbteNro`/cross-validación que el
operador aporta (del intento viejo) pasa contra AFIP — posible, ver el residuo declarado arriba en
"Población objetivo" y en la sección siguiente —, la escritura procede sin que el sistema note que
está pisando un intento distinto del que el operador cree estar resolviendo. **Decisión del dueño,
"Prevalece igual, registrar el residuo":** este comportamiento se acepta tal cual, sin mecanismo
nuevo — AFIP (fuente verificada) prevalece incluso en este caso borde, y el residuo queda
documentado en `docs/pendientes-2026-09-12.md` como
`ISSUE-BEFORE-REVERSE-WINDOW-001-AFIP-PREVAILS-NEWER-ATTEMPT-SHADOW-001` en vez de
cerrarse con un chequeo adicional de "intento viejo vs. nuevo" (que `retryExisting()` no tiene forma
barata de expresar hoy, ver el razonamiento de cross-validación de `afipRequest` reusado más arriba
en "Población objetivo").

**Error de precondición nuevo, exclusivo de este escritor:**
`AfipReconciliationPreconditionError(invoiceId)` (código `AFIP_RECONCILIATION_PRECONDITION_FAILED`,
409 — mismo grupo semántico que `InvoiceManualResolutionPreconditionError`: precondición que ya
cambió, no regla de negocio violada) — deliberadamente un nombre DISTINTO al de A-2, mismo criterio
que ya usa A-2 para distinguirse de N6 (no perder de qué escritor vino el guard al reclasificar).

**Interacción con `mark-not-issued`/N6 (carrera con la declaración `NO_EMITIDA` misma, no con un
reintento posterior):** si un operador dispara `mark-not-issued` (N6, `markUncertainClearedWithClient()`,
`WHERE ... AND uncertain_cleared_at IS NULL`) AL MISMO TIEMPO que otro dispara `reconcile-with-afip`
sobre la MISMA factura nunca-limpiada (rama 1), el que tome el lock de fila primero gana: si
`mark-not-issued` gana, deja `uncertain_cleared_at` poblado pero `status` sigue `FAILED_UNCERTAIN` —
el predicado de `markIssuedFromAfipReconciliationWithClient()` (que NO mira `uncertain_cleared_at`)
sigue matchando de todos modos, así que `reconcile-with-afip` escribe igual, exactamente el
comportamiento "AFIP prevalece" — no es un caso especial, es el mismo mecanismo resolviendo la
carrera más rápida de las dos posibles. Si `reconcile-with-afip` gana primero, `mark-not-issued` ya
no ve `status = 'FAILED_UNCERTAIN'` (ahora es `ISSUED`) — su propio `UPDATE` no matchea, cae en la
reclasificación de N6 (`InvoiceUncertainClearPreconditionError`, 409) — el operador se entera de que
la factura ya se resolvió, sin corromper nada.

**Bookkeeping (mismo criterio que las otras dos rutas del Bloque 3, §3.9 — ampliado en ronda 11 con
la extensión del puerto):** sumar a `EXPECTED_AUTHORIZE_CALL_SITES`, `rbac-matriz-endpoints.md`
sección 4/2, `docs/inventario-rutas.md` (`npm run docs:routes`), y evaluar `NO_CONSUMER_ROUTES` (sin
pantalla en `appfrontend-main` todavía, igual que `/uncertain`/`mark-not-issued`). Se registra ANTES
de `GET /api/invoices/:id` en `invoices.routes.ts`, mismo motivo que `/uncertain` (segmento fijo que
matchearía como `:id` si se registra después) — `reconcile-with-afip` es un sufijo de `:id`, así que
no compite con ese problema, pero se agrupa junto a `mark-not-issued` por legibilidad (misma familia
de acciones sobre una factura puntual). **Nuevo en ronda 11 (gap 4(b)):** `afip-billing.port.ts`
(interfaz `VoucherInfoResult`, +8 campos), `arca-sdk-billing.adapter.ts` (`getVoucherInfo()`, los
reenvía) y `arca-sdk-billing.adapter.test.ts` (casos nuevos para los campos agregados) — ver N-4 en
§6 para la lista completa de implementadores/fakes afectados por el bloque entero.

**Tests (§7):** ver §7 para la lista completa y detallada (ampliada en ronda 11) — resumen: AFIP
down/timeout → `AfipReconciliationUnavailableError` (503), sin escribir nada; AFIP responde sin
comprobante → `AfipVoucherNotFoundError` (422), sin escribir, mensaje "no se pudo confirmar" (nunca
"no se emitió"); AFIP responde con comprobante pero alguno de los 8 campos cruzados no coincide →
`AfipVoucherMismatchError` (422), sin escribir; comprobante real y coincide, población nunca-limpiada
→ factura `ISSUED` con el CAE real, `afip_response` con `reconciledWithAfip: true` y el `raw`
completo, `closeAccountsReceivableGapBestEffort()` llamado; comprobante real y coincide, población
"AFIP prevalece" (`uncertain_cleared_at` ya poblado) → mismo resultado, vía
`markIssuedFromAfipReconciliationWithClient()`; colisión de `cbteNro` con otra factura (23505) →
`InvoiceVoucherNumberAlreadyRegisteredError` (409), sin dejar la factura en un estado intermedio;
factura con `credit_note_request` ABIERTA → `InvoiceHasOpenCreditNoteRequestError` (409), sin llamar
a AFIP en absoluto (guard de entrada corre primero); carrera — otra escritura gana entre la consulta
a AFIP y el `UPDATE` estricto → reclasificación sin `credit_note_request`, mismo criterio que P3.

### 3.15 Bookkeeping RBAC obligatorio para las 3 rutas nuevas (ronda 11, residuo #6 del veredicto de
ronda 10 del gate)

El ADR, hasta ronda 9, diseñaba las 3 rutas nuevas del Bloque 3 (`GET /api/invoices/uncertain`,
`POST /api/invoices/:id/mark-not-issued`, `POST /api/invoices/:id/reconcile-with-afip`) sin declarar
en ningún lado que rompen dos cercas RBAC existentes si se implementan sin actualizarlas en el mismo
cambio — hueco puramente de bookkeeping, no de diseño, pero un cambio real que este ADR tiene que
dejar registrado (`CLAUDE.md`, sección RBAC de este repo, ya documenta la convención: actualizar la
matriz y `EXPECTED_AUTHORIZE_CALL_SITES` en el mismo commit que agrega un `authorize()`):

- **`facturacion/invoices.routes.ts` está en `EXCLUDED_FILES` de
  `src/tests/architecture/rbac-matrix-section2-sync.test.ts` con `hiddenCount: 9`** (verificado
  contra HEAD esta ronda) — las 3 rutas nuevas de este bloque son 3 rutas protegidas más en ese
  mismo archivo (las 3 llevan `authorize(Roles.EMISOR_NOTA_CREDITO)`/`authorize(Roles.MANAGEMENT)`
  según corresponda, §3.9/§3.14), así que ese `hiddenCount` tiene que subir de **9 a 12** en el
  MISMO commit que las agrega — de lo contrario esa cerca queda contando un conteo stale contra el
  código real (mismo modo de falla que la cerca ya declara para cualquier archivo de su allowlist).
- **`EXPECTED_AUTHORIZE_CALL_SITES` de `src/tests/security/rbac-matrix-sync.test.ts` está en `215`**
  (verificado contra HEAD esta ronda) — las 3 rutas nuevas suman 3 call-sites de `authorize()`
  reales, así que ese número tiene que subir de **215 a 218** en el mismo commit — es la cerca
  eléctrica que hace explícito cualquier desvío del conteo real (`CLAUDE.md`, sección RBAC).
- Además de las dos cercas, el resto del bookkeeping ya declarado en §3.9/§3.14 para cada ruta
  (fila nueva en `docs/rbac-matriz-endpoints.md` sección 4/2, `docs/inventario-rutas.md`, evaluar
  `NO_CONSUMER_ROUTES`) sigue vigente sin cambios.

Estas dos actualizaciones son parte del alcance obligatorio de implementación del Bloque 3, no un
bloque de higiene aparte — igual que el resto del bookkeeping ya declarado en §3.9/§3.14.

## 4. Migración de datos existentes (hueco #9 del gate — residuo, no bloquea el ADR)

Si se completa `pending_since` retroactivamente para las `PENDING` que ya existen en producción,
el primer ciclo del worker las evaluaría contra su `pending_since` (poblado con, por ejemplo,
`created_at` como aproximación) y podría convertir en `FAILED_UNCERTAIN` filas que en realidad
nunca estuvieron "coladas" — solo son `PENDING` porque el camino fresco tardó en resolver.

**No verificado esta sesión — sin acceso a producción desde este entorno.** Antes de implementar
el worker, se necesita una consulta de solo lectura por tenant: cuántas `invoices` están hoy
`PENDING`, y cuántas `FAILED_UNCERTAIN` con `afip_contacted = true` y sin `uncertain_cleared_at`,
separadas por `CHARGE` vs. NC. Se registra como verificación pendiente en
`docs/pendientes-2026-09-12.md`, sección `## 🔍 Verificaciones pendientes`.

**Condición de despliegue B-1 (ronda 7, obligatoria — corrige una inconsistencia entre este
párrafo y §6/§9 encontrada por el gate en la ronda 6):** la versión anterior de este texto ("correr
esa consulta contra cada tenant real antes de ACTIVAR el worker en producción — el worker puede
implementarse y testearse sin este dato, pero no activarse") daba a entender que el Bloque 4 podía
DESPLEGARSE con el worker inactivo (esperando la consulta) mientras el guard de solo lectura sobre
`retryExisting()` (§3.7, ubicación B) YA estaba activo. Eso rompe la invariante de §6 ("salida
propia siempre disponible... POR CONSTRUCCIÓN del orden de deploys"): con el guard activo y el
worker todavía apagado, una `PENDING` colgada por muerte del proceso (deuda C3 ya conocida,
`sql.invoice.repository.ts`) pierde su única salida actual (reintentar, aunque sea a ciegas) sin
haber ganado todavía la salida nueva (el worker la mueve a `FAILED_UNCERTAIN`, recién ahí Bloque 3
la atiende) — queda sin ninguna de las dos.

**Resolución (opción elegida: la consulta corre ANTES DE DESPLEGAR, no solo antes de activar) —
se descarta la alternativa de un interruptor compartido guard+worker** (que hubiera resuelto lo
mismo, pero exige construir una pieza de config nueva — un flag leído en dos lugares del código,
sincronizado entre el guard y el loop del worker — que hoy no existe en ningún lado de este ADR;
la opción elegida no agrega ninguna pieza nueva, solo reordena un paso que igual hacía falta
correr). Con esto, el guard de `retryExisting()` (§3.7) y el worker (§3.3) se activan **juntos, en
el mismo deploy**, sin una ventana intermedia con uno prendido y el otro no — no hace falta ningún
flag de activación separado: la consulta de este §4 pasa a ser un pre-flight que se corre y se
confirma ANTES de desplegar Bloque 4 (mismo momento que el pre-flight de §3.6 se corre antes de
desplegar 2b — incluida en `docs/pendientes-2026-09-12.md` con esa redacción, no "antes de
activar"). **Corrección B-1 residuo, ronda 9 (la afirmación de arriba, escrita en ronda 7, era
FALSA cuando se escribió — encontrado por el gate en la ronda 8):** `docs/pendientes-2026-09-12.md`
seguía diciendo, en el ítem 2 de su sección "Verificaciones pendientes", "Antes de activar el
worker, Bloque 4 (§4 del ADR)" — la redacción vieja, nunca actualizada pese a que esta misma
sección del ADR ya decía "antes de desplegar" desde ronda 7. Corregido en este mismo cambio (ronda
9) — ver `docs/pendientes-2026-09-12.md`, ítem 2 de esa sección, ahora sí con la redacción
"antes de desplegar Bloque 4 completo". El worker puede implementarse y testearse sin el dato de
producción, igual que antes — lo que cambia es que el propio DEPLOY de Bloque 4 (no solo la
activación del worker dentro de él) espera la consulta.

**Distinto del pre-flight de §3.6 (inconsistencia cerrada en ronda 4 del gate; corregido en ronda
5 — no "antes de 2a/2b", `pending_since` no existe antes de 2a; corregido otra vez en ronda 9,
residuo B-1 de la ronda 8 del gate — esta frase seguía diciendo "ANTES de ACTIVAR EL WORKER"
después de que la resolución de arriba ya había movido la condición a "antes de DESPLEGAR Bloque 4
completo", sin que nadie hubiera actualizado esta frase en el mismo cambio):** el de acá mide el
volumen de `PENDING`/`FAILED_UNCERTAIN` sin `uncertain_cleared_at` ANTES de DESPLEGAR EL BLOQUE 4
COMPLETO (guard de solo lectura de `retryExisting()` + worker, los dos juntos — B-1), no solo antes
de activar el worker dentro de él. El de §3.6 mide la consistencia de `pending_since` (y el SHA del
commit servido) ENTRE el deploy de 2a Y el de 2b, antes de desplegar 2b. Son dos gates en momentos
distintos del mismo plan, ambos necesarios — uno no reemplaza al otro.

## 5. Secuencia con `DUPLICATE-CAE-001`

Hallazgo hermano, mismo archivo, gate de diseño separado en curso (esta sesión). Comparten la
raíz estructural (un cargo con más de una factura ligada) pero son mecanismos independientes:
`DUPLICATE-CAE-001` es un guard de re-chequeo ANTES de abrir la transacción de
`assertChargesStillInvoiceable()` (lectura sin lock, cierra una inconsistencia ya ocurrida);
este bloque es la toma de la marca "en vuelo" DENTRO de esa misma transacción (§3.2, corregido
en la ronda 2 — nunca en una transacción separada ni "adyacente") y todo lo que pasa después,
hasta la llamada a AFIP.

El que se implemente SEGUNDO tiene que releer `retryExisting()` sobre el código que dejó el
primero — no se diseñan en paralelo a ciegas. Se implementan en el orden en que cada gate los
apruebe; el segundo trae al gate el diff real del primero como parte de su propio pre-commit.

## 6. Orden de implementación propuesto (bloques separados, cada uno con su gate de pre-commit)

**Orden de DEPLOY (decisión del dueño, `AskUserQuestion`, 23/09/2026 — opción B recomendada por
el gate en la ronda 4, N3): `2a → 2b → 3 → 4 → 2c → 5`, con `6` independiente (sin dependencia
dura de ningún otro bloque, puede ir en cualquier momento).** Los identificadores de bloque
(`1`/`2a`/`2b`/`2c`/`3`/`4`/`5`/`6`) NO cambian — son los mismos usados en el resto de este
documento (§3.1-§3.13) — lo que cambia es el ORDEN en que se despliegan, listado abajo en ese
orden. Esto reemplaza la nota de la ronda 3 "bloques 2c/3/4 deploy together" (retirada — con este
orden ya no aplica: cada bloque se despliega solo cuando está listo, sin atarse a que otro esté
commiteado en la misma ventana). Razonamiento:

- **2a→2b primero:** prerrequisito estructural de todo lo demás (columna + CHECK).
- **3 (salida manual) antes que 2c:** el Bloque 3 es puramente aditivo — le da salida a `CHARGE`
  `FAILED_UNCERTAIN`, que hoy no tiene ninguna (§3.9). No depende de que exista el 409 de 2c ni
  del worker de 4 para ser útil por sí solo.
- **4 (worker) antes que 2c:** con 3 ya desplegado, el worker deriva cada `PENDING` vencida a una
  salida que YA EXISTE.
  **Argumento original (refutado en ronda 5, ubicación B — ver Historial de revisión):** decía que
  "hoy, sin 2c, una `PENDING` vencida solo puede venir del flujo FRESCO — `retryExisting()`
  todavía no vuelve a marcar `PENDING`" — cierto pero insuficiente: no cubre a `retryExisting()`
  **reintentando** una `PENDING` YA EXISTENTE (vieja o fresca) sin volver a sellar `pending_since`,
  solo cubre quién puede CREARLA. El worker podía marcar `FAILED_UNCERTAIN` una fila con un
  reintento genuinamente en curso.
  **Resolución (ronda 6):** Bloque 4 ya NO deja que `retryExisting()` toque una fila `PENDING` en
  absoluto — agrega, al principio del método (junto a los dos guards que ya existen para `ISSUED`
  y `FAILED_UNCERTAIN` sin limpiar), un guard de solo lectura:
  `if (existing.status === 'PENDING') throw new RetryInvoiceInFlightError(existing.id);` (§3.7,
  detalle completo). Con este guard, el argumento original queda CORREGIDO en vez de descartado:
  ahora si `retryExisting()` ve `PENDING` rechaza de entrada, así que el worker nunca compite con
  un reintento real en curso por la misma fila — la única forma de que una `PENDING` llegue al
  worker sigue siendo el flujo fresco (o un reintento que YA fue rechazado antes de tocar nada),
  exactamente lo que el argumento original asumía. El worker no le quita ninguna salida a nadie:
  agrega una nueva (§3.9) para el caso colgado, y el guard nuevo simplemente hace explícito, con
  un 409 en vez de un silencio, que un `PENDING` no es reintentable mientras la marca siga fresca
  — política ya confirmada por el dueño en §2, aplicada un bloque antes de lo que el diseño
  original de 2c preveía.
  **Condición de despliegue B-1 (ronda 7):** el guard de solo lectura y el worker se despliegan
  JUNTOS, en el mismo deploy de Bloque 4 — el pre-flight de §4 (volumen de `PENDING`/
  `FAILED_UNCERTAIN` sin `uncertain_cleared_at` por tenant) corre y se confirma ANTES de ese
  deploy, no solo antes de activar el worker dentro de él (ver el detalle completo y la alternativa
  descartada — un interruptor compartido guard+worker — en §4). Sin esta condición, un deploy que
  dejara el guard activo con el worker todavía apagado (esperando el pre-flight) le quitaría a una
  `PENDING` colgada (deuda C3) su única salida actual sin haberle dado todavía la nueva.
- **2c último de los cinco:** recién acá se quita el reintento libre (se introduce el 409),
  cuando las dos salidas alternativas (3 y 4) ya están en producción. La invariante de "salida
  propia siempre disponible" se sostiene POR CONSTRUCCIÓN del orden de deploys, no por una regla
  de disciplina de push que dependa de que nadie la rompa en una sesión futura — cada deploy
  individual ya es seguro por sí mismo, sin ventana insegura entre uno y el siguiente.
- **5 (alcance NC) después de 2c:** extiende el MISMO mecanismo de toma exclusiva que 2c
  introduce (§3.11) — no puede desplegarse antes de que 2c exista.
- **6 (reporte) independiente:** sin dependencia dura de ningún otro bloque.

1. **Bloque 1 — `getAllLinkedInvoicesWithClient()` + guard 8-bis evaluado fila por fila (§3.1),
   preservando EXACTAMENTE la tabla de predicados de hoy, mismo error 422 existente.** El fix de
   mayor severidad (hoy la ventana puede quedar abierta la mitad de las veces en el caso de
   doble factura ligada) y el de menor blast radius (no toca `resolveInvoiceLinkage()`, no toca
   schema, no toca rutas ni RBAC, no introduce el error 409). **Alcance confirmado en la ronda 3
   del gate, todo dentro de la aprobación:**
   - Método nuevo `getAllLinkedInvoicesWithClient()` (recibe `client`, `ORDER BY id` para orden
     determinístico, sin `LIMIT`) implementado en `SqlInvoiceRepository`.
   - Guard 8-bis reescrito para evaluar fila por fila con la tabla de §3.1 (incluidas las dos
     precisiones de `ISSUED`/`reservationId` null y `classify*` llamado como mucho una vez).
   - Corregir el docblock de la interfaz `resolveInvoiceLinkage()` (`invoice.repository.ts`) —
     tres afirmaciones falsas: "prueba primero el individual", `ORDER BY created_at DESC`, y "no
     deberían permitir más de una fila" — y el comentario espejo en `sql.invoice.repository.ts`.
   - Actualizar el docblock de `reverseTransfer()` en `accounts-receivable.service.ts`: la
     sección "Guard 8-bis" y el párrafo de "Cuatro lecturas sin `client`" (pasan a ser tres — la
     de guard 8-bis deja de ser una de ellas, ya no corre en una conexión separada del pool).
   - Actualizar la entrada de `CITY-LEDGER-AR-NESTED-CONN-001` en pendientes: la instancia del
     guard 8-bis queda resuelta (ya no cuenta entre las lecturas sin `client`).
   - Registrar el método nuevo en el comentario de `sql.invoice.repository.ts` que ya advierte
     sobre copias a mano del mismo `UNION ALL` (no se toca el SQL de `resolveInvoiceLinkage()`,
     solo se documenta la tercera copia).
   - Actualizar los comentarios de `invoice-retry-charge-guard.integration.test.ts` que todavía
     describen el guard viejo.
   - Actualizar los implementadores/fakes que dependen de la interfaz:
     `invoice.service.test.ts`, `invoice-pdf.service.test.ts`, el `Pick<InvoiceRepository, ...>`
     y el fake de `accounts-receivable.service.test.ts`.
2a. **Bloque 2a — columna `pending_since` + backfill + escritores nuevos actualizados, SIN el
   CHECK todavía** (hueco N1, ronda 3 del gate): `migrate:tenants` corre en el build mientras la
   versión ANTERIOR del servicio sigue atendiendo tráfico (`render.yaml`) — con el CHECK puesto
   en el mismo deploy que lo agrega, el código viejo (que inserta `PENDING` sin `pending_since`,
   y cuyo `markIssuedWithClient()` no lo limpia) viola la constraint durante toda la ventana de
   deploy, incluso perdiendo la persistencia de un CAE real ya devuelto por AFIP. Este bloque
   agrega la columna, corre el backfill (§3.6), y actualiza TODOS los escritores
   (`createWithClient()`, `markIssuedWithClient()`, `markFailedWithClient()`) para que mantengan
   `pending_since` consistente — pero sin agregar el CHECK. También revierte limpio: el código
   nuevo escribe la columna, el viejo la ignora, ninguno rompe.
2b. **Bloque 2b — el CHECK `chk_invoices_pending_since` + backfill inverso** (§3.6, hueco N1
   ronda 4), en un deploy POSTERIOR a 2a, una vez confirmado que la versión que sirve tráfico ya
   es la que mantiene la columna en todos sus escritores (SHA del commit confirmado, no solo
   `/health` — ver pre-flight de §3.6). El pre-flight de §4 (volumen de `PENDING`/
   `FAILED_UNCERTAIN` sin `uncertain_cleared_at`) corre antes del deploy de 4, no de 2a/2b — dos
   gates distintos, en momentos distintos, ambos necesarios (§3.6/§4).
3. **Bloque 3 — salida manual para `CHARGE`/NC (§3.9)**, incluida la exclusión (corregida por A-6/N-1
   — solo solicitudes ABIERTAS) de facturas con `credit_note_request` propia y el predicado
   corregido de `mark-not-issued` (N6) — **y, por N6 (ronda 4), el error tipado nuevo + el test de
   `resolveCreditNoteRequestManually()` sobre el caso de §3.13. Matriz de impacto ampliada en ronda
   7 (§3.9, "Resolución de ubicación A" + A-3/A-4/A-6 + P3) y otra vez en ronda 9 (N-1 a N-4, P-1,
   P-2), todo dentro de este mismo bloque:**
   - **A-2:** `markIssuedFromManualResolutionWithClient()`, método nuevo (predicado estricto,
     exclusivo del camino manual — **corregido en ronda 13, H2 del veredicto de ronda 12 del gate:
     este método NO se reusa por P-1/§3.14, esa afirmación de rondas anteriores era la fuente de la
     contradicción de routing que ronda 12 encontró; P-1 usa su propio escritor exclusivo,
     `markIssuedFromAfipReconciliationWithClient()`, para las dos ramas de su población — ver §3.14**)
     + `InvoiceManualResolutionPreconditionError` — `markIssuedWithClient()` queda con su guard
     `<> 'ISSUED'` de uso exclusivo automático.
   - Reclasificación de `resolveCreditNoteRequestManually()` bajo lock (factura → solicitud, A-4)
     aplicando las 2 decisiones del dueño: `InvoiceResolutionCaeMismatchError` (decisión 2),
     `InvoiceResolutionStateConflictError` (decisión 1), cierre idempotente sin prefijo sintético
     en `resolutionNote` — reemplaza el criterio "auto-cierra reflejando la verdad" de la ronda 6.
   - **A-4/N-2 (ronda 9):** `CreditNoteRequestRepository.findByIdForUpdate()`, método nuevo — sin
     este método el test de regresión "fila ya CERRADA (terminal, A6.4)" (`invoice.service.test.ts`)
     sigue pasando igual (no lo toca, ver §3.9), pero el caso A-4 (factura auto-cerrada `REJECTED`
     con un intento de resolución posterior) sigue dando el 500 espurio que este método cierra. N-2
     (ronda 9) angosta el shortcut de esta rama: idempotente SOLO si el desenlace grabado coincide
     con lo declarado, si no `InvoiceResolutionStateConflictError` (409) — ver §3.9 para las 4
     variantes de test.
   - **P-2 (ronda 9, nuevo):** `CreditNoteRequestNotInManualReviewError` — guard nuevo dentro de la
     MISMA reclasificación de A-4 (mismo lock, mismo orden factura-primero, sin locks nuevos ni
     reordenados): `credit_note_request.state === 'PENDIENTE'` rechaza con 409 en vez de caer en
     `InvoiceReconciliationUnexpectedStateError` (500). Ver §3.9 para el razonamiento completo de
     por qué no hace falta invertir el orden de locks.
   - **A-3 (bug previo, NO se arregla acá del todo — P-2 lo acota más, ronda 9):** ningún cambio de
     código en `ALLOWED_CREDIT_NOTE_REQUEST_TRANSITIONS` ni en la máquina de estados — el Bloque 3
     mitiga la CONSECUENCIA (pisar un CAE real, A-2) y ahora TAMBIÉN la clasificación del ERROR
     (P-2: 409 correcto en vez de 500 genérico, para ESTE call-site) — sigue sin arreglar la CAUSA
     (que la transición `PENDIENTE -> CERRADA` siga siendo técnicamente posible en el tipo);
     registrado y narrowed en `docs/pendientes-2026-09-12.md`
     (`CREDIT-NOTE-REQUEST-PENDIENTE-RESOLVE-GUARD-001`).
   - **N-1 (ronda 9):** `InvoiceHasOpenCreditNoteRequestError` — el error de `mark-not-issued`
     (antes sin nombrar, "error dedicado") ahora tiene nombre y predicado narrowed a "solicitud
     ABIERTA" (antes: cualquier solicitud ligada) — reusado también por P-1 (§3.14).
   - **P-1 (ronda 9, nuevo — mecanismo completo en §3.14, routing corregido en ronda 13):** ruta
     nueva `POST /api/invoices/:id/reconcile-with-afip`, tres errores nuevos
     (`AfipReconciliationUnavailableError` 503, `AfipVoucherNotFoundError` 422,
     `AfipVoucherMismatchError` 422, más los 2 de la extensión "AFIP prevalece" de ronda 11 —
     `InvoiceVoucherNumberAlreadyRegisteredError`, `AfipReconciliationPreconditionError`, ver N-4
     abajo), escribe SIEMPRE por su propio escritor exclusivo
     `markIssuedFromAfipReconciliationWithClient()` (nunca por `markIssuedFromManualResolutionWithClient()`
     de A-2 — corregido en ronda 13, H2 del veredicto de ronda 12 del gate: hasta ronda 12 una de
     las dos ramas de población de P-1 reusaba el escritor de A-2, lo que contradecía la propia
     sección "AFIP prevalece" de §3.14 y dejaba sin efecto el comportamiento "prevalece" para esa
     rama si `mark-not-issued` ganaba una carrera primero) y reusa la reclasificación de A-4 (sin la
     parte de `credit_note_request` — su población nunca tiene una solicitud abierta).
   - **P3, informativo — sin cambio en los orquestadores de cancelación:** `finalizeIssued()`
     gana el manejo de `InvoiceAlreadyIssuedError` (idempotente-si-coincide,
     `InvoiceIssuedComprobanteMismatchError` si no) — `cancel-order-with-credit-note.service.ts`/
     `cancel-reservation-with-credit-note.service.ts` NO se tocan (su `catch` genérico ya es
     aceptable, ver P3).
   - Reporte (d), §3.10: el `motivo` nuevo (`'MANUAL_RESOLUTION_STATE_MISMATCH'`) es del Bloque 6
     (§3.10 vive documentalmente en esta sección pero el bloque de implementación es el 6, sin
     dependencia dura de 3 — puede ir después).
   - **N-4 (ronda 8 del gate, aplicado en ronda 9) — implementadores/consumidores que este bloque
     toca, ninguno listado antes de esta ronda (cada uno verificado por grep contra HEAD el
     23/09/2026):**
     - `InMemoryCreditNoteRequestRepository` (`in-memory.credit-note-request.repository.ts`) —
       implementa la interfaz completa de `CreditNoteRequestRepository`; necesita
       `findByIdForUpdate()` nuevo (A-4).
     - `FakeInvoiceRepository` — DOS clases distintas, una por archivo,
       `implements InvoiceRepository` completo cada una: `invoice.service.test.ts` Y
       `invoice-pdf.service.test.ts`. Las dos necesitan `markIssuedFromManualResolutionWithClient()`
       (A-2) y `getReconciliationSnapshotForUpdate()` (A-4) nuevos, aunque
       `invoice-pdf.service.test.ts` no ejercite ninguno de los dos directamente (el `implements`
       completo igual exige el método en la clase).
     - `Pick<CreditNoteRequestRepository, 'createWithClient' | 'findByInvoiceId' | 'findById' |
       'transitionWithClient'>` de `FakeCreditNoteRequestRepository`
       (`invoice.service.test.ts`) — hoy NO incluye `findByIdForUpdate`; hay que sumarlo a la lista
       del `Pick<>` (y a la clase) para que A-4/N-2/P-2 tengan algo que mockear.
     - Mocks de `sql.invoice.repository.test.ts` (patrón `mockSqlClient`, ver
       `markIssuedWithClient() limpia pending_since = NULL al salir de PENDING` como precedente
       directo) — necesitan casos nuevos para `markIssuedFromManualResolutionWithClient()`,
       `getReconciliationSnapshotForUpdate()`, `markIssuedFromAfipReconciliationWithClient()`
       (ronda 11, escritor nuevo de "AFIP prevalece", §3.14), y el catch de colisión `23505` sobre
       `idx_invoices_talonario` (ronda 11, gap 4(c)).
     - **NUEVO (ronda 11, residuo #5 del veredicto de ronda 10 del gate — la lista de ronda 9
       estaba incompleta, verificado por grep contra HEAD esta ronda):**
       - El parámetro `creditNoteRequestRepo` del constructor de `InvoiceService`
         (`invoice.service.ts`), tipado `Pick<CreditNoteRequestRepository, 'createWithClient' |
         'findByInvoiceId' | 'findById' | 'transitionWithClient'>` — el mismo `Pick<>` que el bullet
         de arriba ya identificó en el fake de test, pero acá es la firma de PRODUCCIÓN: necesita
         sumar `'findByIdForUpdate'` para que la instancia real pueda pasarle el método nuevo a
         `InvoiceService` (sin este cambio, el constructor real ni siquiera compila contra el
         `findByIdForUpdate()` que A-4 agrega a la interfaz completa).
       - Los DOS call-sites typed-double en
         `src/tests/integration/cancel-order-with-credit-note.integration.test.ts` que usan el MISMO
         `Pick<>` (`failingRepo` y `failingTransitionRepo`, ambos objetos literales tipados así en
         ese archivo) — mismo motivo, necesitan `findByIdForUpdate` en su forma literal para seguir
         satisfaciendo el tipo una vez que el `Pick<>` de producción lo incluya.
       - `AfipBillingPort` (`afip-billing.port.ts`, interfaz `VoucherInfoResult`), su adapter
         (`arca-sdk-billing.adapter.ts::getVoucherInfo()`) y el test del adapter
         (`arca-sdk-billing.adapter.test.ts`) — el fix del gap 4(b) de §3.14 agrega 8 campos
         tipados (`docTipo`, `docNro`, `impTotal`, `cbteFch`, `impNeto`, `impIVA`, `concepto`,
         `monId`) a `VoucherInfoResult`, así que el puerto, el adapter y su test necesitan
         actualizarse juntos — y cualquier fake de `AfipBillingPort` en los tests de
         `InvoiceService` que construya un `VoucherInfoResult` a mano.
     - `error.middleware.ts` — **enumeración completa pedida por el gate, RECONTADA en ronda 11
       (residuo #5 del veredicto de ronda 10 del gate — la suma de ronda 9 daba 12, pero 7+1+3+2 =
       13, no 12; la cita nunca se había corregido con el propio desglose que la acompañaba). Con
       los errores nuevos de esta ronda (gaps 4(c) y "AFIP prevalece"), el total real es 15, no
       12 ni 13** (N6, A-2, A-3/P-2, N-2, P-1, gap-4(c), "AFIP prevalece", todos juntos): **10
       mapeados a 409** (`InvoiceUncertainClearPreconditionError`, `InvoiceAlreadyIssuedError`,
       `InvoiceManualResolutionPreconditionError`, `InvoiceResolutionCaeMismatchError`,
       `InvoiceResolutionStateConflictError`, `RetryInvoiceInFlightError`,
       `CreditNoteRequestNotInManualReviewError`, `InvoiceHasOpenCreditNoteRequestError` — los 8 ya
       contados en ronda 9 —, más **2 nuevos de ronda 11**:
       `InvoiceVoucherNumberAlreadyRegisteredError` (gap 4(c), colisión de `cbteNro`) y
       `AfipReconciliationPreconditionError` (escritor nuevo de "AFIP prevalece", §3.14)); **3
       mapeados a otro código, todos de P-1, sin cambios de ronda 11**
       (`AfipReconciliationUnavailableError` 503, `AfipVoucherNotFoundError` 422,
       `AfipVoucherMismatchError` 422); **2 deliberadamente SIN mapear** (caen al `default:` 500,
       honest-degradation, sin cambios de ronda 11): `InvoiceReconciliationUnexpectedStateError` e
       `InvoiceIssuedComprobanteMismatchError` — las dos representan un invariante roto que ningún
       4xx puede describir de forma accionable para quien lo recibe. **El residuo #2 de ronda 10
       (la nueva rama de la carrera EN_REVISION_MANUAL, §3.9) NO agrega un error nuevo** — reusa
       `InvoiceReconciliationUnexpectedStateError`, documentado como transitorio y retryable, ver
       §3.9.

       **Precisión de ronda 13 (N-4 del veredicto de ronda 12 del gate) — 15 es el total de Bloque 3
       Y Bloque 4 combinados, no el delta propio de Bloque 3:** de los 10 errores mapeados a 409 de
       arriba, `RetryInvoiceInFlightError` nace en el Bloque 4 (§3.7/§6, "4. Bloque 4"), no en este
       Bloque 3 — Bloque 3 solo lo REUSA (guard de solo lectura sobre `PENDING`, ver la ubicación B
       de §3.7). El delta propio de `error.middleware.ts` que introduce la implementación de ESTE
       Bloque 3 es **14, no 15** (9 mapeados a 409 sin contar `RetryInvoiceInFlightError` + 3
       mapeados a otro código + 2 sin mapear = 14); el 15 sigue siendo correcto como total combinado
       de los dos bloques, y es el número relevante para quien mire `error.middleware.ts` después de
       que AMBOS estén desplegados — pero no hay que leerlo como "Bloque 3 solo agrega 15 errores".

   Puede desplegarse solo, sin depender de 2c ni de 4.
4. **Bloque 4 — worker de vencimiento (§3.3, §3.4)**, incluida la transición de
   `credit_note_request` a `EN_REVISION_MANUAL` cuando corresponda (§3.9), **y, por ubicación B
   (ronda 6), el guard de solo lectura al principio de `retryExisting()` que rechaza cualquier
   `PENDING` con `RetryInvoiceInFlightError` (§3.7) — nace en este bloque, 2c lo reusa sin
   redefinirlo.** Depende de que 3 ya esté desplegado (necesita una salida a la que derivar cada
   `PENDING` vencida). **El argumento de seguridad de desplegarlo antes de que 2c exista, refutado
   en la ronda 5 (ubicación B), queda corregido en la ronda 6 — ver Historial de revisión y el
   bullet de arriba ("4 (worker) antes que 2c").** **Condición de despliegue B-1 (ronda 7):** el
   guard y el worker se activan JUNTOS, en el mismo deploy — el pre-flight de §4 corre y se
   confirma ANTES de desplegar este bloque, no solo antes de activar el worker dentro de él (ver
   §4 para el detalle y la alternativa descartada). **B-4 (ronda 7):** el docblock de
   `retryExisting()` (`invoice.service.ts`) Y el de `transitionCreditNoteRequestAfterFailure()`
   ("solo bloquea `ISSUED` y `FAILED_UNCERTAIN` sin limpiar") quedan desactualizados por este
   bloque — a corregir en la implementación (ver §3.7/B-4 para el detalle, incluido el orden de
   precedencia frente al guard de `DUPLICATE-CAE-001`: el guard `PENDING` de acá corre PRIMERO).
   **Condición de test OBLIGATORIA (ronda 11, condición (i) del veredicto de ronda 10 del gate —
   requisito de implementación de este bloque, NO todavía verificado porque el worker no tiene
   código):** el `UPDATE` del worker (§3.3) tiene que transicionar `credit_note_request` a
   `EN_REVISION_MANUAL` (vía `transitionCreditNoteRequestAfterFailure()`) DENTRO DE LA MISMA
   transacción que mueve la factura a `FAILED_UNCERTAIN` — un solo commit, mismo patrón que
   `issue()`/`reconcileAfterFailure()` ya usan hoy (verificado en código, ver §3.9, "Por qué P-2 no
   necesita invertir el orden de locks"). El gate de pre-commit de este bloque exige un test de
   integración dedicado que lo pruebe contra Postgres real (no un mock que asuma la atomicidad) —
   por ejemplo, forzando que la transacción del worker falle DESPUÉS de escribir la factura pero
   ANTES de escribir `credit_note_request`, y confirmando que NINGUNA de las dos escrituras queda
   commiteada sin la otra (rollback completo, no un estado a mitad de camino). **Por qué esto no es
   opcional:** P-2 (Bloque 3, §3.9) depende de esta garantía para ser sólido sin invertir el orden
   de locks — si el worker pudiera dejar una factura `FAILED_UNCERTAIN` ambigua con su
   `credit_note_request` todavía `PENDIENTE` (las dos escrituras NO atómicas), el guard de P-2
   podría no ver esa `PENDIENTE` a tiempo, reabriendo el 500 genérico que P-2 existe para cerrar.
2c. **Bloque 2c — toma exclusiva completa (§3.2) + guard 8-bis respeta `uncertainClearedAt`
   (§3.8, movido acá desde el bloque 1) + reset de `uncertain_cleared_at` en
   `markFailedWithClient()` (§3.5 — hueco de asignación cerrado en ronda 4: prerrequisito de que
   §3.8 sea correcto, sin él una factura recién re-fallada podría heredar un valor viejo y el
   guard la trataría como ya limpiada sin revisión real).** **Corrección ronda 6:** el error 409
   (`RetryInvoiceInFlightError`) ya NO nace acá — nace en Bloque 4 (§3.7) y este bloque lo reusa
   sin redefinirlo. **Corrección P2(a), ronda 7 — la frase de la ronda 6 de acá abajo era falsa,
   se retira (terminología corregida otra vez en ronda 9, residuo de la ronda 8 del gate — no era
   "la rama `PENDING`", el `WHERE` no tiene esa rama; es el caso "sin fila" del `UPDATE ...
   RETURNING`, ver §3.2):** el caso "sin fila" de la toma exclusiva de §3.2 NO queda como defensa en
   profundidad para el camino de `retryExisting()` — sigue siendo la primera y única línea real
   contra el doble click de dos reintentos concurrentes sobre una misma fila `REJECTED`/
   `FAILED_UNCERTAIN` limpiada, caso que el guard de Bloque 4 no ve (lee `existing.status` una sola
   vez, antes de que exista ninguna carrera por la toma — ver la corrección de §3.2/§3.7). El guard
   de Bloque 4 y la toma exclusiva de 2c cierran ventanas DISTINTAS, ninguna redundante con la otra.
   Depende de 2a/2b (columna) y de que 3/4 ya estén en producción (orden de deploy de arriba).
5. **Bloque 5 — alcance NC en la toma de marca (§3.11).** Depende de 2c (extiende el mismo
   mecanismo).
6. **Bloque 6 — reporte (d) (§3.10)** — sin dependencia dura de ningún otro bloque, puede ir en
   paralelo o después de cualquiera de los cinco anteriores.

**Residuo declarado (N7, ronda 3 del gate — lectura confirmada correcta en la ronda 4, con una
precisión, sigue sin cerrar en este ADR):** N7 no bloquea 2a/2b/3 — esos bloques no toman locks
nuevos, solo cambian cláusulas `SET` sobre filas que las mismas sentencias ya lockean, y el
backfill es una sola sentencia. Pero N7 ES una pregunta de DISEÑO, no de implementación — tiene
que quedar escrita y revisada en un gate ANTES de aprobar el diseño de 2c, no descubrirse recién
mientras se lo implementa. Punto de partida para ese análisis futuro (inferido, no demostrado —
se deja así, como nota para cuando se diseñe 2c): los 4 `SELECT 1 FROM invoices WHERE id = $1 FOR
UPDATE` de `sql.invoice.repository.ts` (`getOutstandingForUpdate()`, `getRefundableForUpdate()`,
`getInFlightCreditNoteTotalForUpdate()`, `getInFlightCreditNoteTotalForPairForUpdate()`) lockean
la factura original `ISSUED`, y el predicado de la toma del Bloque 2c excluye `ISSUED` — falta
demostrar que esos 4 caminos no lockean DESPUÉS `accounts_receivable`, órdenes o reservas (lock
ordering), y decidir si hay que extender `lock-order.test.ts`/
`accounts-receivable-lock-order.test.ts` cuando se diseñe 2c. Registrado de verdad en
`docs/pendientes-2026-09-12.md`, sección `## 🔍 Verificaciones pendientes` (no estaba pese a que
el texto de la ronda 3 decía que sí — corregido en este mismo cambio, ronda 4).

Cada bloque trae su propio pre-commit con `architecture-governor`. Este ADR autorizó el DISEÑO
del bloque 1 (aprobado, ronda 3, implementado, `bcba224`) y de los bloques 2a y 2b (APROBADOS CON
CONDICIONES en la ronda 5, condición **C5** para 2a — árbol de trabajo limpio con
`DUPLICATE-CAE-001` ya commiteado — ya SATISFECHA: `DUPLICATE-CAE-001` (`d55d08a`) commiteó antes
que 2a (`3216849`), ver "Estado real del código" en el encabezado). Los bloques 3 y 4 volvieron a
HOLD en la ronda 5 por las ubicaciones A y B; la ronda 6 completó un primer diseño de
las dos, la ronda 7 corrigió lo que el gate encontró mal en esa propuesta al revisarla en su
propia ronda 6 (P2(a), P3,
A-2/A-3/A-4/A-6, B-1 a B-4), la ronda 9 corrigió lo que la ronda 8 del gate encontró mal en la
propuesta de ronda 7 (N-1 a N-4, P2(a) residuo de terminología, P2(b) residuo, B-1 residuo) y
agregó P-1/P-2; la ronda 10 del gate encontró 8 hallazgos nuevos sobre esa propuesta (ver Historial
de revisión, entrada ronda 10), y **esta ronda 11 los corrige y diseña la extensión de P-1 ("AFIP
prevalece", decisión nueva del dueño)** — ver §3.9 ("Resolución de ubicación A", "P-2"), §3.14
("P-1"), §3.7/§6 ("4 (worker) antes que 2c") para el mecanismo concreto, y el Historial de revisión
(entradas ronda 9, 10 y 11) para el resumen — pero 3 y 4 siguen en HOLD hasta que el gate
`architecture-governor` corra su propia revisión sobre este texto y lo confirme; este documento no
se autoaprueba. **(Corrección ronda 11: esta frase antes decía "hasta que el gate corra su propia
ronda 9" — número hardcodeado de forward-reference que quedó stale apenas el gate corrió esa ronda;
se reescribe sin número fijo a propósito, mismo modo de falla que ya declaraba B-1 para el estado
de push — ver también la nota equivalente dentro de la entrada de Historial de ronda 9, más
abajo.)** 2c sigue en HOLD por
N7 (registrado como pregunta de diseño para antes de su propio gate) — sin cambios de esta ronda,
salvo la corrección de origen del error 409 (ahora nace en 4, ver arriba). 5 depende de 2c, sin
revisar. 6 no revisado salvo el `motivo` nuevo de §3.10 (documentado, no implementado).

## 7. Tests (por bloque, contra Postgres real donde aplique)

- `getAllLinkedInvoicesWithClient()` + guard 8-bis fila por fila: unit con el fake extendido a
  varias filas por cargo, cubriendo las 5 reglas de la tabla de §3.1 una por una (`ISSUED`
  reconciliada, `ISSUED` no reconciliada, `PENDING`, `FAILED_UNCERTAIN` con y sin
  `afipContacted`, `REJECTED`) más las combinaciones de más de una fila (`REJECTED`+`PENDING` en
  los dos órdenes de id, `ISSUED` reconciliada + `REJECTED`, `REJECTED`+`REJECTED`,
  `FAILED_UNCERTAIN(false)`+`REJECTED`) — sin regresión en ningún caso de una sola fila.
- Carrera α/β (mismo patrón ya gate-aprobado y commiteado para `DUPLICATE-CAE-001`'s hermano de
  Zona 2, `91ff4ba`) + una tercera variante: dos facturas ligadas al mismo cargo, reversa
  concurrente con el reintento de UNA de ellas — confirma que el fix de §3.1 cierra el caso que
  el guard viejo perdía.
- Doble click: dos `retryExisting()` concurrentes sobre la misma factura — solo uno gana la toma
  exclusiva, el otro recibe el error 409 nuevo, nunca dos `createNextVoucher()`.
- Worker: UPDATE condicionado no pisa un `ISSUED` que "llega tarde" (mock de timing, o test de
  integración con un `pending_since` artificialmente vencido).
- Factura limpiada (`uncertainClearedAt` poblado) que vuelve a fallar de forma incierta — confirma
  que §3.5 la deja re-limpiable, no atascada con el valor viejo.
- **Ubicación A (bloque 3) — reconciliación de `resolveCreditNoteRequestManually()`, reescrita en
  ronda 7 para reflejar "rechaza, no auto-cierra" (las 2 decisiones del dueño):**
  - **Idempotente, EMITIDA:** factura ya `ISSUED` con `cbteNro`/`cae` que COINCIDEN con lo que el
    operador declaró → cierra con `resolutionOutcome: 'EMITIDA'`, sin volver a escribir la factura,
    `resolutionNote` es `input.note` TAL CUAL (sin prefijo).
  - **Idempotente, NO_EMITIDA:** factura `FAILED_UNCERTAIN` con `uncertainClearedAt` YA poblado,
    operador declara `NO_EMITIDA` → cierra con `resolutionOutcome: 'NO_EMITIDA'`, sin prefijo.
  - **Decisión 2 (discrepancia de CAE):** factura ya `ISSUED`, operador declara `EMITIDA` con
    `cbteNro`/`cae` que DIFIEREN de lo persistido → `InvoiceResolutionCaeMismatchError` (409),
    `credit_note_request` sigue `EN_REVISION_MANUAL` (no se llama a `transitionWithClient()`),
    `logger.error` con `declared`/`real` completos.
  - **Decisión 1 (conflicto de estado), dos variantes:** factura `ISSUED` + operador declara
    `NO_EMITIDA` → `InvoiceResolutionStateConflictError`; factura `FAILED_UNCERTAIN` limpiada +
    operador declara `EMITIDA` → mismo error, espejo. Las dos: 409, solicitud sin tocar,
    `logger.warn`.
  - **A-4/N-2 — solicitud ya `CERRADA` (auto-cerrada por otra vía, ej. `REJECTED` tardío), CUATRO
    variantes (N-2, ronda 8 del gate, aplicada en ronda 9 — antes había una sola, idempotente
    incondicional; ahora idempotente SOLO si coincide):**
    1. **Idempotente (desenlace coincide):** `resolutionOutcome` grabado === `input.outcome` (y,
       si `EMITIDA`, `cbteNro`/`cae` declarados === los reales de la factura) → devuelve la fila tal
       cual, sin escribir nada, sin `InvoiceReconciliationUnexpectedStateError` (era el 500 espurio
       que A-4 cierra).
    2. **NUEVO (N-2) — auto-cierre con `resolutionOutcome: null` (rama `REJECTED` automática),
       operador declara `EMITIDA` DESPUÉS:** `null !== 'EMITIDA'` → `InvoiceResolutionStateConflictError`
       (409), `logger.warn`, `credit_note_request` sin tocar (sigue `CERRADA` con
       `resolutionOutcome: null`).
    3. **NUEVO (N-2) — doble-submit con desenlaces DISTINTOS (el caso que la ronda 7 no
       distinguía del doble-submit-mismo-desenlace):** seed de `credit_note_request` `CERRADA` con
       `resolutionOutcome: 'NO_EMITIDA'`, la llamada bajo prueba declara `EMITIDA` → `InvoiceResolutionStateConflictError`
       (409), sin escribir.
    4. **NUEVO (N-2) — mismo `outcome: 'EMITIDA'` pero `cbteNro`/`cae` declarados DIFIEREN de los
       ya grabados en la factura (CERRADA con el mismo outcome, pero otro comprobante):**
       `InvoiceResolutionStateConflictError` (409) — no `InvoiceResolutionCaeMismatchError`, aunque
       la causa de fondo sea una discrepancia de CAE: decisión explícita del gate (N-2) de reusar
       el mismo tipo para toda discrepancia contra un estado YA `CERRADA`, distinto del caso
       `EN_REVISION_MANUAL` de la decisión 2 (bullet de arriba), que sí usa
       `InvoiceResolutionCaeMismatchError`.
  - **Regresión — test EXISTENTE, sin tocar (A6.4):** "fila ya CERRADA (terminal, A6.4) --
    transitionWithClient() rechaza" (`invoice.service.test.ts`) sigue pasando sin cambios — la
    factura seedeada en ese test NO dispara el guard estricto, así que el flujo nunca entra a la
    reclasificación de A-4 y `transitionWithClient()` sigue rechazando sin ser atrapado. Confirmado
    en ronda 9 que ni el guard de P-2 ni el de N-2 lo tocan (los dos viven dentro de la
    reclasificación, que este test nunca alcanza — ver el razonamiento completo en §3.9).
  - **NUEVO (P-2, ronda 9) — solicitud `PENDIENTE`, operador intenta resolver antes de que el
    camino automático falle una vez:** `resolveCreditNoteRequestManually()` con
    `credit_note_request.state === 'PENDIENTE'` → `CreditNoteRequestNotInManualReviewError` (409),
    sin tocar la factura NI la solicitud, sin llamar a `createNextVoucher()` ni a ningún método de
    escritura. Variante que confirma el razonamiento de "por qué no hace falta invertir el orden de
    locks" (§3.9): sembrar la factura en CUALQUIER estado (`PENDING`, `REJECTED`,
    `FAILED_UNCERTAIN` sin contactar) junto con `credit_note_request` `PENDIENTE` — en todos los
    casos, el resultado es el mismo 409 de P-2, nunca `InvoiceReconciliationUnexpectedStateError`.
  - Doble-submit genuino (dos llamadas concurrentes, mismo desenlace real) — **mecanismo corregido
    en ronda 9 (N-3, ronda 8 del gate): no es un lock de la solicitud, es el lock implícito de la
    FACTURA** que la primera transacción sostiene hasta commitear; la segunda espera ese lock, al
    liberarse re-evalúa su `WHERE` contra la fila ya cambiada (sin fila), entra a la reclasificación
    de A-4, lockea factura y solicitud (las dos ya libres) y ve `CERRADA` — devuelve esa fila, sin
    error.
  - Estado inesperado (mock devolviendo un `status`/`uncertainClearedAt` que no matchea ninguna
    rama de arriba, y la solicitud NO está `CERRADA`): `InvoiceReconciliationUnexpectedStateError`
    sube sin ser absorbido.
  - `markIssuedWithClient()` (camino automático, `finalizeIssued()`) sobre una factura
    `PENDING`/`REJECTED`/`FAILED_UNCERTAIN`: sin regresión — su guard `<> 'ISSUED'` no cambia ese
    camino (sigue siendo el mismo guard que la ronda 6 proponía, solo que ahora exclusivo del
    automático).
  - **P3 — `finalizeIssued()` atrapa `InvoiceAlreadyIssuedError`:** comprobante coincide → éxito
    idempotente, devuelve la fila persistida, sigue el best-effort de AR; comprobante NO coincide →
    `InvoiceIssuedComprobanteMismatchError` (500), `logger.error` con los dos comprobantes
    completos.
- **Ubicación B (ronda 6, bloque 4) — guard de `retryExisting()` sobre `PENDING`:**
  - `retryExisting()` contra una factura `PENDING` (fresca, recién creada por el camino fresco, o
    vieja): `RetryInvoiceInFlightError` inmediato, cero llamadas a `createNextVoucher()` — no debe
    intentar contactar AFIP en absoluto.
  - **Corrección B-3 (ronda 7) — el test de la ronda 6 de acá abajo ("worker activo... reintento ya
    rechazado") no probaba nada concreto (no fijaba ni el `pending_since` de partida ni la
    secuencia temporal real entre el reintento y el worker); se reemplaza por uno específico:**
    seed de una factura `PENDING` con `pending_since` artificialmente VENCIDO (anterior a
    `NOW() - N`); `retryExisting()` sobre esa fila da `RetryInvoiceInFlightError` (409), sin llamar
    a `createNextVoucher()`; el worker corre y la mueve a `FAILED_UNCERTAIN` (§3.3); un
    `retryExisting()` posterior sobre la MISMA fila ya NO pasa por el guard `PENDING` (el status ya
    cambió) — devuelve el estado `FAILED_UNCERTAIN` tal cual (mismo contrato ya existente para ese
    status, sin regresión), confirmando que el guard nuevo no deja a la fila atascada más allá del
    vencimiento.
  - Regresión de los dos guards existentes (`ISSUED`, `FAILED_UNCERTAIN` sin limpiar): siguen
    devolviendo la fila tal cual (no un error) — el guard nuevo no cambia su contrato.
  - **Cruce con la corrección P2(a) (ronda 7, terminología corregida en ronda 9):** el test de
    "Doble click" de más arriba en esta misma sección (dos `retryExisting()` concurrentes, uno gana
    la toma exclusiva de 2c, el otro cae en el caso "sin fila" del `UPDATE ... RETURNING`) sigue
    siendo el que prueba que ese caso "sin fila" de 2c NO es redundante — agregar el test de B-3 no
    reemplaza ese, cubre una ventana distinta (§3.7).
- **NUEVO (ronda 11, residuo #8 del veredicto de ronda 10 del gate) — N-1 (`mark-not-issued`,
  `InvoiceHasOpenCreditNoteRequestError`):**
  - Factura `FAILED_UNCERTAIN`/`afip_contacted`/`uncertain_cleared_at IS NULL` con una
    `credit_note_request` propia ya `CERRADA` (secuencia real documentada en el docblock de
    `transitionCreditNoteRequestAfterFailure()`): `mark-not-issued` ACEPTA (predicado narrowed a
    "sigue ABIERTA") — la factura queda `FAILED_UNCERTAIN` con `uncertain_cleared_at` poblado, la
    `credit_note_request` sigue `CERRADA` sin tocar.
  - Misma factura con una `credit_note_request` propia todavía ABIERTA
    (`PENDIENTE`/`EN_REVISION_MANUAL`): `mark-not-issued` RECHAZA con
    `InvoiceHasOpenCreditNoteRequestError` (409), sin escribir nada — esa combinación va por
    `POST /credit-note-requests/:id/resolve`, no por acá.
- **NUEVO (ronda 11, residuo #8) — §3.14/P-1, casos de la extensión "AFIP prevalece" y de los gaps
  4(a)/4(c)/4(d):**
  - **AFIP prevalece:** factura `FAILED_UNCERTAIN`/`afip_contacted`/`uncertain_cleared_at`
    POBLADO (ya declarada `NO_EMITIDA` a mano) → `reconcile-with-afip` con un `cbteNro` que AFIP
    confirma real y que cruza contra `invoice.afipRequest` → factura `ISSUED` con el comprobante
    real, `afipResponse.reconciledWithAfip: true`, vía `markIssuedFromAfipReconciliationWithClient()`
    — la `credit_note_request` (si existía, ya `CERRADA`) NO se toca (residuo declarado, §3.14).
  - Mismo caso pero el reintento posterior sigue `PENDING` en vuelo, o ya resolvió a `ISSUED`/
    `REJECTED`: el `UPDATE` de `markIssuedFromAfipReconciliationWithClient()` no matchea (ninguno de
    esos tres `status` es `FAILED_UNCERTAIN`) → reclasificación (sin `credit_note_request`) →
    idempotente si el comprobante ya persistido coincide, error tipado sin mapeo amigable si no.
  - **CORREGIDO en ronda 13 (H1 del veredicto de ronda 12 del gate — la redacción de ronda 11 de
    este caso decía "no matchea", que es FALSO y contradecía el SQL real; el test tal como estaba
    escrito no podía pasar):** el reintento posterior vuelve a fallar de forma AMBIGUA
    (`FAILED_UNCERTAIN` fresca, `afip_contacted`) → el `UPDATE` de
    `markIssuedFromAfipReconciliationWithClient()` SÍ matchea (el predicado no mira
    `uncertain_cleared_at` en absoluto, ver §3.14 "Qué garantiza este predicado...") → la factura
    queda `ISSUED` con el comprobante que el operador aportó para el intento VIEJO, sobre la fila del
    intento NUEVO — comportamiento "AFIP prevalece" aplicado también acá, decisión del dueño
    (residuo aceptado y registrado, `ISSUE-BEFORE-REVERSE-WINDOW-001-AFIP-PREVAILS-NEWER-ATTEMPT-SHADOW-001`
    en `docs/pendientes-2026-09-12.md`), no un caso que el sistema rechace. **Nota para quien
    implemente este test:** sembrar el estado directamente por SQL (no depender de que el reset de
    §3.5 exista — ese reset es entregable de 2c/4, y Bloque 3 puede desplegarse solo, antes) — sembrar
    la fila con `uncertain_cleared_at` en los dos valores posibles (poblado y `NULL`) y confirmar que
    el resultado es el mismo en ambos casos, ya que el predicado no lee esa columna.
  - **Cross-validación extendida (gap 4a):** AFIP confirma un comprobante real con `impTotal`
    coincidente pero `cbteFch`/`impNeto`/`impIVA`/`concepto`/`monId` (cualquiera) DIVERGE del
    `afipRequest` original → `AfipVoucherMismatchError` (422), sin escribir — confirma que la
    validación cruzada extendida realmente evalúa los 5 campos nuevos, no solo los 3 de ronda 9.
    **Nota de fixture (ronda 13, observación del gate en ronda 12):** este test (y el resto de los
    que construyen un `VoucherInfoResult` de AFIP con comprobante real) tiene que sembrar un fixture
    con la FORMA REAL que devuelve el parseo SOAP del SDK (`mapVoucherInfo()`,
    `soap-to-dto.mapper.js` de `@arcasdk/core`, ver §3.14 gap 4(b)) — no un `VoucherInfoResult`
    armado a mano campo por campo que se salte el parseo real, porque eso puede esconder
    discrepancias de forma (tipos, nulls, formato de fecha) que el parseo real sí produce.
  - **Colisión de `cbteNro` (gap 4c):** dos facturas del mismo negocio+punto de venta+tipo con el
    mismo `cbteNro` — la segunda reconciliación (la que golpea `idx_invoices_talonario`) recibe
    `InvoiceVoucherNumberAlreadyRegisteredError` (409), la factura que la disparó queda SIN
    modificar (ni a medio camino).
  - **Wording de "no encontrado" (gap 4d) — test de contrato de mensaje, no solo de código:** AFIP
    responde sin `ResultGet` (`getVoucherInfo()` del adapter devuelve `null`) →
    `AfipVoucherNotFoundError`, y el mensaje/detalle expuesto al cliente contiene la frase "no se
    pudo confirmar" y NO contiene "no se emitió" ni ninguna variante que implique inexistencia
    confirmada — test de regresión de texto, para que una futura edición del mensaje no reintroduzca
    la afirmación excesiva que motivó este fix.
- **Cross-referencia (ronda 11) — Bloque 4 necesita su propio test, no repetido acá:** la condición
  de test obligatoria sobre el `UPDATE` del worker (§3.3) transicionando `credit_note_request` en la
  MISMA transacción que la factura vive en la sección "Bloque 4" de §6 (ronda 11, condición (i) del
  veredicto de ronda 10 del gate) — el spec completo de ese test es responsabilidad del gate de
  pre-commit de Bloque 4, no de esta sección; acá solo se cita para que quien implemente Bloque 3 (y
  lea este §7) sepa que existe y por qué P-2 depende de él.

## 8. `criterios-negocio` / `DEFENSIVE_DEVELOPING.md`

- **Clasificación:** `Invoice` ya está clasificada DOCUMENTO (`invoice.entities.ts`). Los campos
  nuevos (`pending_since`) son metadato del intento de emisión, no contenido fiscal — no alteran
  la inmutabilidad de una factura ya `ISSUED` (el CHECK de consistencia solo aplica mientras
  `status = 'PENDING'`, nunca después).
- **A8.x concurrencia:** cubierto por §3.2 (toma exclusiva) y §3.3 (UPDATE condicionado) — sin
  esto, el mecanismo introduciría una carrera nueva en vez de cerrar una vieja.
- **Principio "salida propia":** cubierto por §3.9 — explícitamente NO se activa el worker (§3.3)
  sin que la salida manual ya exista, por diseño (orden de implementación, §6).
- **DEFENSIVE_DEVELOPING §3** (toca `src/platform/` — versión de schema, y `src/workers/` — el
  worker nuevo): a completar en el commit de cada bloque de implementación, no acá (este
  documento es diseño, no implementación).

## 9. Lo que este ADR NO decide

- El nombre exacto del `motivo` nuevo del reporte (d) y si termina siendo endpoint propio o
  extensión (§3.10, residuo declarado).
- Si arreglar (o no) los otros 8 call-sites de `resolveInvoiceLinkage()` que comparten el mismo
  riesgo estructural que §3.1 (§3.12) — queda registrado como hallazgo nuevo separado, fuera de
  los 6 bloques de este ADR.
- Los números reales de producción — dos gates distintos, ambos necesarios (reconciliado en
  ronda 4, ver §3.6/§4; **corregido en ronda 7, B-1**: el de §4 pasó de bloquear la ACTIVACIÓN del
  worker a bloquear el DEPLOY completo de Bloque 4, guard incluido — ver §4/§6 para el porqué): el
  pre-flight de §3.6 bloquea el DEPLOY de 2a/2b (consistencia de `pending_since` y SHA del commit
  servido); el de §4 bloquea el DEPLOY de Bloque 4 (volumen de `PENDING`/`FAILED_UNCERTAIN` sin
  `uncertain_cleared_at`). Ninguno de los dos bloquea la implementación ni los tests de ningún
  bloque.

## Historial de revisión

- **22/09/2026, ronda 1:** HOLD — 9 huecos en el mecanismo propuesto (predicado del guard 8-bis
  sin verificar contra multi-factura, salida manual inexistente para `CHARGE`, falta de toma
  exclusiva, worker sin UPDATE condicionado, `uncertainClearedAt` sin resetear, deuda TTL
  reabierta sin reconciliar, doble fuente de verdad, consumidores nuevos sin mapear, secuencia
  con `DUPLICATE-CAE-001`).
- **23/09/2026, ronda 2:** HOLD — 8 huecos en el documento corregido (firma booleana que no
  alcanza a preservar la tabla de predicados real y produce una regresión, predicado de toma
  exclusiva incompleto y sin precedente real, worker con comparación de timestamp que nunca iba
  a matchear, migración de schema no idempotente y sin backfill, política de `retryExisting()`
  frente a un `PENDING` sin decidir, colisión con la bandeja de NC existente, 8 call-sites sin
  analizar). Esta versión respondió a los 8.
- **23/09/2026, ronda 3: APROBADO CON CONDICIONES para el bloque 1 (alcance ampliado, §6 punto
  1); HOLD para los bloques 2-6** — 7 huecos nuevos (N1-N7) sobre el texto corregido: el CHECK de
  §3.6 rompía el deploy contra la instancia vieja (dividido en 2a/2b), el SQL de §3.6 tenía un
  `DROP CONSTRAINT` suelto e inválido y anulaba el propósito del nombre fijo de constraint, el
  409 de §3.2/§3.7 sobre `PENDING` quita la única salida actual sin que los bloques 3/4 ya
  existan (bloques 2c/3/4 atados al mismo deploy), el worker de §3.3 no limpiaba
  `uncertain_cleared_at`, faltaba el predicado condicionado de `mark-not-issued` (§3.9), faltaba
  el análisis de orden de locks entre la toma y otros caminos que lockean `invoices` primero, y
  la tabla de §3.12 estaba mal (decía que 8 call-sites comparten el riesgo; en realidad son 4 no,
  1 con residuo, 3 acotados a `DUPLICATE-CAE-001`). Esta versión responde a todo salvo N1-N3/N7,
  que quedan reordenados en §6 para una ronda 4 antes del gate de implementación del bloque 2a.
- **23/09/2026, ronda 4: HOLD ACOTADO.** N2 resuelto (aplicado — el `DROP CONSTRAINT` suelto e
  inválido de §3.6 se retiró, sin reemplazo). N1, N3 y N6 quedan resueltos EN INTENCIÓN, cada uno
  con un hueco que este texto ahora cierra: **N1** — faltaba el caso inverso (instancia de código
  anterior a 2a sirviendo tráfico durante la ventana de deploy sin limpiar `pending_since`),
  cerrado en §3.6 con el backfill inverso, la declaración de que el backfill no se gatea por
  versión (tiene que rerunnear en 2b), el registro pendiente en
  `docs/inventario-dml-schema-2026-09-16.md`, el rollback manual explícito de 2b, la lista real de
  12 archivos de fixtures afectados (grep corrido esta ronda, con exclusiones verificadas) y el
  pre-flight con SHA de commit. **N3** — reorder de deploy `2a→2b→3→4→2c→5` (con `6`
  independiente), decisión ya confirmada por el dueño (`AskUserQuestion`), aplicado en §6,
  retirando la nota "2c/3/4 deploy together" de la ronda 3. **N6** — declarado en §3.9 como
  cambio de comportamiento del **Bloque 3 de este ADR**, disparado sobre
  `resolveCreditNoteRequestManually()` (que pertenece al Bloque 5 del ADR común cancelar-con-NC,
  §6.5 bis, ya implementado en producción — no el Bloque 5 de ESTE ADR, en §6), con el error
  tipado nuevo (409) y el test requerido agregados como parte del Bloque 3, y la afirmación
  inexacta sobre la máquina de estados de `credit_note_request` corregida. **N7** —
  lectura confirmada correcta, con una precisión (no bloquea 2a/2b/3; es una pregunta de DISEÑO
  para antes del gate de implementación de 2c, con los 4 call-sites de `FOR UPDATE` de
  `sql.invoice.repository.ts` citados por nombre en §6) — registrado de verdad en
  `docs/pendientes-2026-09-12.md`, sección `## 🔍 Verificaciones pendientes` (no estaba, pese a
  que el texto de la ronda 3 decía que sí). Huecos de texto menores cerrados: el reset de
  `uncertain_cleared_at` de §3.5 asignado explícitamente al Bloque 2c; la inconsistencia §4 vs.
  §3.6/§6/pendientes reconciliada como dos gates necesarios en momentos distintos, no
  alternativos. Queda para la ronda 5.

- **23/09/2026, ronda 5: 2a/2b APROBADOS CON CONDICIONES → READY FOR IMPLEMENTATION; 3 y 4 vuelven
  a HOLD por dos ubicaciones nuevas.** Verificó los arreglos de la ronda 4 contra el archivo real
  (no tomó el auto-reporte del agente que los aplicó por buena fe): confirmó el backfill inverso
  en §3.6 antes del bloque `DO`, la lista de 12 fixtures (grep re-corrido, exacta, con las 3
  exclusiones verificadas), el reorder de §6, la corrección de N6 en §3.9, y N7 en
  `docs/pendientes-2026-09-12.md`. Encontró un hueco de reconciliación no cerrado (la entrada de
  pendientes seguía describiendo un solo gate donde el ADR ya declaraba dos) y dio 4 condiciones,
  todas aplicadas en este mismo commit de docs:
  - **C1** — reescribir la entrada de `docs/pendientes-2026-09-12.md` (antes "consulta antes del
    bloque 2a") con los DOS gates reales (§3.6 entre 2a y 2b, antes de desplegar 2b; §4 antes de
    activar el worker en 4), Y reubicarla dentro de `## 🔍 Verificaciones pendientes` (vivía en
    `## Hallazgos nuevos`, sin coincidir con lo que el propio ADR §4 ya citaba como su
    ubicación) — aplicado, verificado en confirmación posterior.
  - **C2** — corregir la ambigüedad de "Bloque 5" en el bullet de N6 (§3.9 y encabezado): es el
    Bloque 5 del ADR común cancelar-con-NC (§6.5 bis, ya implementado), no el Bloque 5 de ESTE
    ADR (§6); y el predicado que dispara el cambio es el del Bloque 3 de este ADR, no el de 2c —
    aplicado.
  - **C3** — corregir la clasificación "auto-limitantes desde que corren" del inventario de DML
    en §3.6: en la ventana de 2a (sin CHECK todavía), la sentencia directa es de disparo abierto
    BENIGNO (si vuelve a dispararse, corrige, no daña); recién desde 2b las dos sentencias quedan
    auto-limitantes por el CHECK, mismo precedente que la fila 8 del inventario — aplicado.
  - **C4** — reescribir el pre-flight 1 de 2b en §3.6: "bloquea hasta confirmar 0" no se puede
    exigir, porque ese 0 es justamente lo que las DOS sentencias de backfill que 2b re-ejecuta
    (la directa y la inversa) dejan dentro de su transacción de deploy; reemplazado por confirmar
    el SHA primero y medir el conteo DOS veces separadas en el tiempo (crece → HOLD; estable →
    residuo esperado, no bloquea) — aplicado.

  Encontró además dos ubicaciones NUEVAS, ninguna de la ronda 4, que bloquean el diseño de 3 y 4
  respectivamente (no bloquean 2a/2b, que quedan aprobados):
  - **Ubicación A (bloquea el diseño del Bloque 3):** con el 409 nuevo de N6 puesto, la única
    salida que le queda al operador frente al caso de §3.13 es la rama `EMITIDA` de
    `resolveCreditNoteRequestManually()`, que llama a `markIssuedWithClient()` SIN condición de
    status — sobrescribiría `cae`, `cbte_nro`, `cae_vto`, `afip_response` e `issued_at` de una
    factura ya `ISSUED` con datos cargados a mano por el operador. Choca directo con §8
    (factura `ISSUED` es un documento inmutable). El texto no declaraba cuál es la salida propia
    después de ese 409 — hueco real, no solo de redacción. Queda para la ronda 6.
  - **Ubicación B (bloquea el diseño del Bloque 4, causada por el propio reorder de N3 que esta
    misma ronda recomendó):** en `HEAD` (`bcba224`), `retryExisting()` reintenta una `PENDING`
    sin volver a sellar `pending_since` — el docblock ya declara ese caso como "reintento
    seguro" y el código no escribe ningún estado antes de llamar a `issue()`. Con el Bloque 4
    desplegado ANTES que 2c (el orden que N3 ya fijó en §6), un operador que reintenta una
    `PENDING` vencida —el uso documentado del botón— dispara una llamada a AFIP; si esa llamada
    tarda, el worker ve el `pending_since` viejo y mueve la fila a `FAILED_UNCERTAIN` en plena
    emisión (y, si es `ADJUSTMENT`, lleva la solicitud de NC a `EN_REVISION_MANUAL`). Rompe el
    margen de N ≫ 80s de §3.4 (que asume que `pending_since` marca el inicio del intento en
    vuelo) y el invariante que el propio docblock de `transitionCreditNoteRequestAfterFailure()`
    declara ("`EN_REVISION_MANUAL` no debería ser alcanzable desde estos 3 call-sites hoy") — con
    este hueco, se vuelve alcanzable de forma rutinaria, sumado a la ubicación A. El argumento de
    seguridad que §6 ya tenía escrito para el Bloque 4 solo cubre quién puede CREAR una `PENDING`
    nueva, no quién puede estar reintentando una que ya existe. Dirección sugerida para la ronda
    6 (no decidida todavía): mover a este mismo bloque (4) el rechazo de `retryExisting()` sobre
    facturas `PENDING` — sin 2c nada vuelve a poner una fila en `PENDING`, así que un chequeo de
    solo lectura alcanzaría, coherente con la política ya decidida en §2 ("siempre 409 mientras
    la marca esté fresca"). Puede necesitar una pregunta nueva al dueño si mueve el 409 de
    `PENDING` de 2c a 4. Queda para la ronda 6.

  2c sigue en HOLD por N7 (sin cambios de esta ronda). 5 depende de 2c, sin revisar. 6 no
  revisado en esta ronda. Condición **C5** para implementar 2a: árbol de trabajo limpio, con
  `DUPLICATE-CAE-001` ya commiteado — ese hallazgo hermano toca los mismos dos archivos
  (`sql.invoice.repository.ts`, `invoice.repository.ts`) que 2a va a tocar, y §5 de este ADR ya
  exige que quien implemente segundo relea sobre el diff real del primero.

- **23/09/2026, ronda 6 (propuesta — responde a las ubicaciones A y B de la ronda 5; PENDIENTE de
  verificación por el gate `architecture-governor`, este texto no se autoaprueba):**

  **Ubicación A — resuelta (§3.9, "Resolución de ubicación A").** El mismo choque con §8 que tenía
  la rama `EMITIDA` (`markIssuedWithClient()` sin guard de status, podía sobrescribir una factura
  ya `ISSUED`) se cierra con el mismo mecanismo que N6 ya le dio a la rama `NO_EMITIDA`: un guard
  de status en el `UPDATE` (`WHERE ... AND status <> 'ISSUED'`) y un error tipado nuevo
  (`InvoiceAlreadyIssuedError`, 409, mismo grupo semántico que `InvoiceUncertainClearPreconditionError`
  — nombre que este texto también fija ahora para el error de N6, que había quedado "a definir en
  la implementación"). Lo que la ronda 5 dejó sin cerrar — "¿y después del 409, qué hace el
  operador?" — se resuelve en `resolveCreditNoteRequestManually()`: al atrapar cualquiera de los
  dos guards, el método relee el estado REAL de la factura bajo lock
  (`getReconciliationSnapshotForUpdate()`, método nuevo) y cierra `credit_note_request` reflejando
  esa verdad, no lo que el operador tipeó — reusando los dos valores YA existentes del enum
  `CreditNoteRequestResolutionOutcome` (`'EMITIDA'`/`'NO_EMITIDA'`), sin agregar ninguno nuevo ni
  tocar el CHECK de consistencia. El caso de doble-submit que este mecanismo expone (dos llamadas
  concurrentes al mismo `credit_note_request`) se resuelve con el mismo criterio que
  `transitionCreditNoteRequestAfterFailure()` ya usa para `fromState === 'CERRADA'` — se tolera, no
  se trata como error. **No encontré una decisión de negocio genuina en esta ubicación** — evalué
  explícitamente si "reflejar la verdad real de la factura en vez de lo que el operador tipeó,
  cuando difieren" era una elección con dos respuestas igual de válidas (la alternativa sería
  escalar la discrepancia como sospechosa en vez de auto-cerrar) y concluí que no lo es: escalar
  reabriría exactamente el mismo dead-end que esta ubicación existe para cerrar (la solicitud
  quedaría trabada en `EN_REVISION_MANUAL` para siempre, sin ningún botón que la mueva), y el
  sistema SÍ tiene la información para resolverlo solo (el estado real de la factura, que ya viene
  de AFIP por la vía automática) — no es un caso de "el sistema no puede resolverlo, hay que
  preguntarle al dueño", es la aplicación directa del principio transversal ya declarado en
  `CLAUDE.md`. Si el gate no coincide con esta lectura, la alternativa (escalar en vez de
  auto-cerrar) queda declarada acá para que la traiga de vuelta con `AskUserQuestion`.

  **Ubicación B — resuelta (§3.7, §6 "4 (worker) antes que 2c").** La dirección que la propia
  ronda 5 sugirió (mover el rechazo de `PENDING` de 2c a 4) resultó, al verificarla contra el
  código, ser exactamente correcta y suficiente: `retryExisting(existing)` ya recibe la fila en
  memoria, así que el guard nuevo (`if (existing.status === 'PENDING') throw new
  RetryInvoiceInFlightError(existing.id)`) no necesita ninguna query nueva — es un chequeo de solo
  lectura real, sin tocar el lock ni la transacción de `assertChargesStillInvoiceable()`. El error
  `RetryInvoiceInFlightError` nace en este bloque (no en 2c, como decía la versión anterior de
  §3.7) y 2c lo reusa sin redefinirlo cuando llegue su propia toma exclusiva.

  **Corrección P2(a), ronda 7 — la frase que seguía acá ("la rama `PENDING` de esa toma queda como
  defensa en profundidad, no como la primera línea") era FALSA y se retira, junto con el "Residuo
  declarado a propósito" que la acompañaba (que mezclaba dos ventanas distintas en una sola,
  llamando "más rara" a la que en realidad es la alcanzable en la práctica):** confirmé explícitamente que esto NO reintroduce una dependencia de 2c: Bloque 4
  queda standalone (el guard no lee `pending_since` para decidir, solo el `status` ya cargado; el
  worker de §3.3 sigue siendo el único mecanismo que saca una fila de `PENDING` por vencimiento,
  sin que 4 necesite que 2c exista para eso) — ESO seguía siendo correcto. Lo que NO era correcto:
  **(terminología corregida en ronda 9, residuo de la ronda 8 del gate — el `WHERE` de la toma no
  tiene una "rama `PENDING`", tiene `REJECTED`/`FAILED_UNCERTAIN`; lo que protege es el caso "sin
  fila" que se da cuando el `UPDATE` de la segunda transacción ya no matchea ninguna de esas dos
  porque la primera ya dejó la fila en `PENDING`)** el caso "sin fila" de la toma exclusiva de 2c
  sigue siendo la primera y única línea real contra dos `retryExisting()` concurrentes sobre una
  misma fila `REJECTED`/`FAILED_UNCERTAIN` limpiada
  (el guard de Bloque 4 no ve ese caso — lee `existing.status` una sola vez, antes de que exista
  ninguna carrera por la toma, y las dos lecturas concurrentes ven el mismo status no-`PENDING`) —
  no una capa redundante detrás del guard de Bloque 4. El residuo real que el guard de Bloque 4 SÍ
  deja (alguien pone la fila en `PENDING` en el instante exacto entre la lectura de `existing` y
  el guard, y solo alcanzable DESPUÉS de que 2c exista) es distinto y más acotado — ver la
  corrección completa en §3.2/§3.7, entrada ronda 7. **Tampoco encontré una decisión de negocio genuina en
  esta ubicación** — la política ya estaba confirmada por el dueño en §2 ("siempre 409 mientras la
  marca esté fresca, sin excepción"); mover CUÁNDO se empieza a aplicar (bloque 4 en vez de 2c) es
  una decisión de secuenciamiento de implementación, no de comportamiento de negocio — el
  comportamiento final, una vez 2c también esté desplegado, es idéntico al que el ADR ya tenía
  aprobado.

  **Cambios de código existente (más allá de los dos bloques en HOLD) que esta ronda declara,
  ninguno implementado todavía:** el docblock de `retryExisting()` (`invoice.service.ts`) necesita
  actualizarse en la implementación del Bloque 4 — hoy clasifica `PENDING` como parte de "el resto
  ... reintento seguro"; deja de serlo. Ningún archivo de `src/` se tocó en esta ronda — es
  diseño, igual que el resto de este documento.

  Con esto, los DOS bloques que la ronda 5 dejó en HOLD tienen diseño completo — **pendiente,
  todavía, de que el gate `architecture-governor` corra su propia ronda 6 sobre este texto y lo
  confirme o encuentre huecos nuevos, antes de pasar a READY FOR IMPLEMENTATION.** 2c sigue en
  HOLD por N7 (sin cambios de esta ronda, salvo la corrección de origen del error 409 documentada
  arriba). 5 depende de 2c, sin revisar. 6 no revisado.

- **23/09/2026, ronda 7 (propuesta — corrige lo que la ronda 6 del gate encontró mal en la
  propuesta de ronda 6 para los bloques 3 y 4; PENDIENTE de verificación por el gate
  `architecture-governor`, este texto no se autoaprueba). Alcance: solo documentación, sobre este
  archivo y `docs/pendientes-2026-09-12.md` — ningún archivo de `src/` tocado, ni el Bloque 2b
  (fuera de alcance, gate propio en paralelo).**

  **Dos decisiones de negocio del dueño, tomadas vía `AskUserQuestion` en esta sesión (citadas
  íntegras en el encabezado) — reemplazan el criterio de "auto-cerrar reflejando la verdad real"
  que tenía la propuesta de ronda 6 para "Resolución de ubicación A":**
  1. Conflicto de estado de NC (el operador declara un desenlace que contradice el estado real de
     la factura) → **"Rechaza y deja abierta"** — 409, `credit_note_request` sigue
     `EN_REVISION_MANUAL`.
  2. Discrepancia de CAE (el operador declara `EMITIDA` con un comprobante que difiere del ya
     registrado) → **"Rechaza, queda para revisión fiscal"** — 409, visible en el reporte (d).

  **La autoevaluación de la ronda 6 ("no encontré una decisión de negocio genuina en esta
  ubicación") estaba equivocada, y se registra acá el porqué, no solo el resultado:** la ronda 6
  razonó que "reflejar la verdad real vs. escalar como sospechosa" tenía una sola respuesta
  correcta (reflejar), porque escalar reabriría el mismo dead-end que el mecanismo existe para
  cerrar. Ese razonamiento asumía que las dos únicas opciones eran "auto-cerrar en silencio" o
  "dejar trabada para siempre sin salida" — pero había una tercera, que es la que el dueño eligió:
  rechazar CON una salida (el operador puede volver a intentarlo con el dato correcto, la
  solicitud no queda huérfana, solo abierta) — ni auto-corrección silenciosa ni un dead-end. La
  ronda 6 no consideró esa tercera opción como una pregunta de negocio propia antes de descartarla
  — exactamente el modo de falla que el `CLAUDE.md` de este repo ya describe en "Preguntas de
  alcance pueden esconder una decisión de negocio" (caso D5): la pregunta de mecanismo ("¿cómo
  cierro el dead-end?") escondía una pregunta de negocio distinta ("¿el sistema corrige solo, o le
  devuelve el problema al operador con mejor información?"), y las dos tienen más de una respuesta
  razonable.

  **P2(a) — corrección de una afirmación falsa que viajó por CUATRO lugares de la propuesta de
  ronda 6 (§3.2, §3.7, el bullet de 2c en §6, y la propia entrada de Historial de ronda 6):** decía
  que la rama "sin fila" de la toma exclusiva de 2c es "defensa en profundidad redundante" y "no
  alcanzable en la práctica" para `retryExisting()`, una vez Bloque 4 está desplegado. Es FALSO:
  dos `retryExisting()` concurrentes sobre una fila `REJECTED`/`FAILED_UNCERTAIN` limpiada leen
  los dos ese status (no `PENDING`), pasan el guard de Bloque 4 sin que ninguna de las dos sea
  bloqueada, y la rama "sin fila" del `UPDATE ... RETURNING` de 2c es la ÚNICA protección real
  contra ese doble click — el propio §7 ya tenía un test para exactamente este caso ("Doble
  click"), que contradecía el texto que lo rodeaba. Corregido en los cuatro lugares, con nota
  inline en cada uno (no se reescribió el Historial de ronda 6 en silencio).

  **P2(b) — el encabezado del documento seguía diciendo "Bloques 2a-2b: diseño listo, sin código
  todavía" y "Sin código en ninguno de los 6" pese a que 1 y 2a ya estaban COMMITEADOS (`bcba224`,
  `3216849`) y 2b está implementado en el working tree (gate propio, en paralelo, no tocado por
  esta ronda) — corregido.**

  **P3 — política de `finalizeIssued()` cuando su guard nuevo (`status <> 'ISSUED'`) salta,
  diseñada por primera vez (la propuesta de ronda 6 asumía que ese camino nunca ve la fila ya
  `ISSUED`, lectura vieja — 4 caminos reales listados en §3.9 "P3"):** éxito idempotente si el
  comprobante coincide con lo ya persistido; si no coincide, `InvoiceIssuedComprobanteMismatchError`
  sin mapeo amigable (500, honest-degradation) + `logger.error` con los dos comprobantes completos
  — superficie durable declarada como residuo explícito (este repo no tiene, hoy, un sink de logs
  dedicado). Los orquestadores de cancelación (`cancel-order-with-credit-note.service.ts`,
  `cancel-reservation-with-credit-note.service.ts`) siguen relanzando este caso como error
  genérico, sin cambio — declarado ACEPTABLE porque es recuperable (el reintento de la misma
  operación ve `ISSUED` en el primer guard de `retryExisting()` y no vuelve a tocar AFIP).

  **Cuatro ubicaciones nuevas del Bloque 3 (A-2, A-3, A-4, A-6), ninguna registrada antes de esta
  ronda — todas en §3.9:**
  - **A-2** — el guard `status <> 'ISSUED'` que la ronda 6 proponía para `markIssuedWithClient()`
    no puede ser compartido entre el camino automático y el manual (predicados con necesidades
    distintas). Resuelto con dos métodos: `markIssuedWithClient()` (guard ancho, exclusivo
    automático) y `markIssuedFromManualResolutionWithClient()` (método nuevo, predicado estricto
    espejo de N6, exclusivo manual).
  - **A-3** — bug previo y vivo, independiente de este ADR, NO se arregla acá: 
    `ALLOWED_CREDIT_NOTE_REQUEST_TRANSITIONS.PENDIENTE` permite `CERRADA` directo, la ruta
    `resolve` no chequea el estado de la solicitud, y nada cierra `credit_note_request` cuando el
    camino automático gana. El Bloque 3 mitiga la CONSECUENCIA (pisar un CAE real) vía el guard de
    A-2, no la CAUSA. Registrado como `CREDIT-NOTE-REQUEST-PENDIENTE-RESOLVE-GUARD-001` en
    `docs/pendientes-2026-09-12.md`.
  - **A-4** — la reconciliación de `resolveCreditNoteRequestManually()` clasificaba solo por el
    estado de la FACTURA, ignorando el de la SOLICITUD — un caso ya resuelto por otra vía (ej.
    `REJECTED` tardío que ya cerró la solicitud automáticamente) producía un 500 espurio
    (`InvoiceReconciliationUnexpectedStateError`) en vez de reconocerse como ya contemplado.
    Resuelto lockeando también la solicitud (`findByIdForUpdate()`, método nuevo), después de la
    factura, devolviéndola sin reclasificar si ya está `CERRADA` — sin romper el test de
    regresión "fila ya CERRADA (terminal, A6.4)" (ver §3.9 para por qué ese test no se ve tocado).
  - **A-6** — `GET /api/invoices/uncertain` excluía TODA factura con una `credit_note_request`
    propia sin mirar su estado, dejando un callejón sin salida (solicitud `CERRADA`, la factura
    vuelve a fallar, no aparece en ninguna bandeja). Resuelto: excluye solo las que tienen una
    solicitud ABIERTA.

  **B-1 a B-4 — cuatro correcciones de texto/condición en la ubicación B (Bloque 4), ninguna
  cambia el mecanismo ya aprobado en ronda 6:**
  - **B-1 (condición de despliegue, obligatoria):** el guard de solo lectura y el worker se
    activan JUNTOS, en el mismo deploy — el pre-flight de §4 corre y se confirma ANTES de
    desplegar Bloque 4, no solo antes de activar el worker dentro de él (se descarta un
    interruptor compartido guard+worker por agregar una pieza de config nueva que ninguna otra
    parte de este ADR necesita).
  - **B-2:** el residuo TOCTOU de §3.7 estaba mal descrito (mezclaba dos ventanas en una,
    llamando "más rara" a la alcanzable en la práctica) — reescrito junto con P2(a), mismo
    párrafo.
  - **B-3:** el test de §7 "worker activo... reintento ya rechazado" no probaba nada concreto —
    reemplazado por uno específico con `pending_since` vencido, 409, worker, y reintento
    posterior viendo `FAILED_UNCERTAIN` tal cual.
  - **B-4:** falta también actualizar el docblock de `transitionCreditNoteRequestAfterFailure()`
    (no solo el de `retryExisting()`) en la implementación del Bloque 4, y declarar el orden de
    precedencia frente al guard de `DUPLICATE-CAE-001`: el guard `PENDING` de Bloque 4 corre
    PRIMERO (son los tres guards de solo lectura más baratos del método).

  **Matriz de impacto del Bloque 3 ampliada** (§6, item 3) con todas las ubicaciones de arriba, la
  ruta `resolve`, `ALLOWED_CREDIT_NOTE_REQUEST_TRANSITIONS`, el cierre faltante en
  `finalizeIssued()`, el test de regresión "fila ya CERRADA", y los orquestadores de cancelación.
  **Tope de `note` vs. `resolution_note VARCHAR(1000)`:** ya no aplica — con las 2 decisiones del
  dueño, ningún camino de este bloque agrega texto sintético a `resolutionNote`, así que no hace
  falta ajustar el Zod ni separar un campo nuevo (ver §3.9, "Cierre — solo en las dos ramas
  idempotentes", para el razonamiento completo).

  Con esto, la propuesta para los bloques 3 y 4 queda corregida sobre los puntos que la ronda 6
  del gate marcó — **sigue en HOLD hasta que el gate `architecture-governor` corra su propia
  ronda 7 sobre este texto y lo confirme o encuentre huecos nuevos.** 2c sigue en HOLD por N7 (sin
  cambios de esta ronda). 5 depende de 2c, sin revisar. 6 no revisado (salvo el `motivo` nuevo de
  §3.10, documentado pero no implementado).

- **23/09/2026, ronda 8 (gate `architecture-governor`, sobre la propuesta de ronda 7): HOLD —
  worklist de correcciones, ninguna reabre el mecanismo ya cerrado en §2, todas sobre huecos de
  texto/diseño en la propuesta de ronda 7:**
  - **N-1:** el rechazo de `mark-not-issued` ("factura tiene una `credit_note_request` ligada")
    tenía que angostarse a "solicitud ABIERTA" (no `CERRADA`), espejando el fix que A-6 ya le dio a
    la exclusión de `/uncertain` — sin esto, una factura con solicitud `CERRADA` que vuelve a
    `FAILED_UNCERTAIN` seguía sin ninguna salida real (visible en `/uncertain`, pero rechazada por
    `mark-not-issued` igual).
  - **N-2:** el shortcut CERRADA de la reclasificación de A-4 devolvía 200 incondicional — tragaba
    en silencio dos conflictos reales que la decisión 1 del dueño exige rechazar: un `REJECTED`
    tardío que auto-cerró con `resolutionOutcome: null` y el operador declara `EMITIDA` después; y
    dos operadores resolviendo con desenlaces DISTINTOS. Fix: idempotente solo-si coincide,
    si no `InvoiceResolutionStateConflictError`.
  - **N-3:** §3.9 y §7 describían el mecanismo del doble-submit como "la segunda transacción espera
    el lock de la solicitud" — FALSO. Es el lock IMPLÍCITO de la factura (tomado por el `UPDATE`
    estricto de la primera transacción) el que bloquea a la segunda; recién al liberarse esa
    segunda re-evalúa su propio `WHERE`, ve "sin fila", y entra a la reclasificación.
  - **N-4:** matriz de impacto del Bloque 3 (§6, item 3) incompleta — faltaban
    `InMemoryCreditNoteRequestRepository`, los DOS `FakeInvoiceRepository` (`invoice.service.test.ts`
    e `invoice-pdf.service.test.ts`), el `Pick<>` de `FakeCreditNoteRequestRepository` (sin
    `findByIdForUpdate`), los mocks de `sql.invoice.repository.test.ts`, y una enumeración completa
    de cuántos errores nuevos este diseño mapea a 409 (y cuáles quedan deliberadamente sin mapear).
  - **P2(a) terminología:** §3.2, el bullet de 2c en §6, y §7 seguían diciendo "la rama `PENDING`
    del `WHERE`" — el `WHERE` real no tiene esa rama (solo `REJECTED`/`FAILED_UNCERTAIN`); lo que
    protege es el caso "sin fila" del `UPDATE ... RETURNING` cuando la segunda transacción
    re-evalúa contra una fila que la primera ya dejó `PENDING`. La SUSTANCIA ya estaba bien desde
    ronda 7 (P2(a) original) — esto es una corrección de TERMINOLOGÍA sobre esa misma sustancia.
  - **P2(b) residuo:** (1) el encabezado seguía diciendo que 2a estaba "sujeto a C5" cuando 2a
    (`3216849`) y `DUPLICATE-CAE-001` (`d55d08a`) ya estaban COMMITEADOS — C5 ya satisfecha, sin
    actualizar; (2) el cierre de §6 seguía marcando la ronda 6 como la propuesta vigente,
    esperando que el gate corriera su propia revisión de ESA ronda, pese a que ya habían pasado
    las rondas 7 y 8 sobre el texto.
  - **B-1 residuo:** el ítem 2 de `docs/pendientes-2026-09-12.md` (sección "Verificaciones
    pendientes") seguía diciendo "antes de activar el worker" — stale, la condición B-1 (ronda 7)
    ya había movido esa condición a "antes de desplegar el Bloque 4 completo". El propio ADR tenía
    la misma frase stale en al menos 2 lugares (§3.6, §4) pese a que su propia condición B-1, unos
    párrafos más arriba, ya decía lo correcto — y una de esas menciones afirmaba FALSAMENTE que
    `pendientes.md` ya tenía la redacción actualizada, cuando no la tenía.
  - **P3 residuo:** un CAE tipeado a mano (o, tras P-1, un `cbteNro` equivocado que igual pasa la
    validación cruzada) que gana la escritura puede "ganarle" al CAE real de AFIP que llega tarde —
    el real solo queda visible en una línea de log, no en ninguna superficie durable ni consultable,
    y el reporte (d) tampoco lo detecta (la factura ya está `ISSUED` para cuando ese reporte corre).
    Registrar en `pendientes.md`, describiendo la CONSECUENCIA (un CAE incorrecto puede terminar
    como el comprobante oficial de la factura mientras el log con el real envejece), no solo el
    mecanismo.

  Dos decisiones de negocio NUEVAS del dueño, tomadas en esta sesión vía `AskUserQuestion`
  (aplicadas en ronda 9, ver el encabezado del documento): **P-1** (reconciliar contra AFIP en vez
  de que el operador tipee un CAE, para el caso de una factura `CHARGE`/NC-con-solicitud-`CERRADA`
  colgada en `FAILED_UNCERTAIN` que AFIP en realidad SÍ emitió) y **P-2** (exigir
  `EN_REVISION_MANUAL` para que `POST /credit-note-requests/:id/resolve` acepte una resolución
  manual, cerrando A-3 para ESE call-site puntual).

- **23/09/2026, ronda 9 (propuesta — corrige lo que la ronda 8 del gate encontró mal en la
  propuesta de ronda 7, y diseña P-1/P-2 a partir de las dos decisiones de negocio del dueño;
  PENDIENTE de verificación por el gate `architecture-governor`, este texto no se autoaprueba.
  Alcance: solo documentación, sobre este archivo y `docs/pendientes-2026-09-12.md` — ningún
  archivo de `src/` tocado, ni el Bloque 2b (fuera de alcance, gate propio en paralelo).**

  **N-1 a N-4 aplicados** — ver el resumen de cada uno en la entrada de ronda 8 de arriba y el
  detalle completo en §3.9 (N-1, N-2, N-4) y §3.2/§3.7/§6/§7 (P2(a) terminología). **P2(b) y B-1
  residuos aplicados** — encabezado corregido (C5 satisfecha, 1/2a commiteados, ver "Estado real
  del código"), cierre de §6 reescrito para reflejar rondas 7/8/9, `docs/pendientes-2026-09-12.md`
  ítem 2 y las menciones stale de §3.6/§4 del ADR corregidas a "antes de desplegar Bloque 4
  completo". **P3 residuo registrado** como
  `ISSUE-BEFORE-REVERSE-WINDOW-001-P3-LATE-REAL-CAE-SHADOWED-001` en
  `docs/pendientes-2026-09-12.md`, describiendo la consecuencia (un CAE incorrecto puede quedar
  como el comprobante oficial mientras el log con el real envejece), no solo el mecanismo.

  **P-1 diseñado de cero — §3.14, mecanismo nuevo, ruta nueva
  (`POST /api/invoices/:id/reconcile-with-afip`):** consulta `getVoucherInfo(cbteNro, ptoVta,
  cbteTipo)` contra AFIP real (mismo `AfipBillingPort` que el resto de `InvoiceService`), con tres
  modos de falla tipados (AFIP caída/timeout → 503 retryable; AFIP confirma que no hay comprobante
  → 422; comprobante encontrado pero no corresponde a esta factura, validado cruzando
  `ImpTotal`/`DocNro`/`DocTipo` contra `invoice.afipRequest` → 422) y, si la validación pasa, reusa
  `markIssuedFromManualResolutionWithClient()` (A-2) — el mismo escritor guardado que ya diseñaba
  la rama `EMITIDA` de `resolveCreditNoteRequestManually()`, sin inventar un quinto camino de
  escritura — con los datos REALES de AFIP (`afip_response` deja de estar vacío para este tipo de
  `ISSUED`, a diferencia del camino puramente manual de hoy). Reusa también el guard de entrada
  narrowed de N-1 (`InvoiceHasOpenCreditNoteRequestError`) y la reclasificación de A-4 para el caso
  "alguien más escribió primero" — sin la parte de `credit_note_request`, porque la población de
  esta ruta nunca tiene una solicitud abierta.

  **P-2 diseñado — §3.9, guard nuevo dentro de la reclasificación YA EXISTENTE de A-4, sin
  invertir el orden de locks:** `credit_note_request.state === 'PENDIENTE'` rechaza con
  `CreditNoteRequestNotInManualReviewError` (409) antes de clasificar por estado de factura.
  Verificado exhaustivamente (los 3 escritores de `FAILED_UNCERTAIN` ambiguo —
  `issue()`/`reconcileAfterFailure()`/el worker de §3.3 — transicionan `credit_note_request` en la
  MISMA transacción que la factura, siempre) que una factura genuinamente ambigua NUNCA coexiste
  con una solicitud `PENDIENTE`, así que el guard de A-2 (que corre ANTES, sin lock explícito)
  nunca puede matchear mientras la solicitud siga `PENDIENTE` — el guard de P-2, ubicado DESPUÉS
  de que A-2 ya falló, dentro de la MISMA reclasificación de A-4 (mismo lock, mismo orden
  factura-primero), es suficiente por construcción: no hace falta lockear `credit_note_request`
  antes que la factura. Confirmado que el test de regresión "fila ya CERRADA (A6.4)" no se ve
  tocado (nunca entra a la reclasificación, porque su factura seedeada SÍ pasa el guard de A-2).

  **Re-verificación de N-2 tras P-2 (pedida por la ronda 8):** con P-2 rechazando `PENDIENTE` en la
  entrada, el shortcut `CERRADA` de N-2 deja de ser alcanzable desde una entrada `PENDIENTE`
  fresca — solo queda alcanzable por (a) el cierre automático (`REJECTED` tardío,
  `resolutionOutcome: null`) o (b) la carrera de doble-submit entre dos entradas
  `EN_REVISION_MANUAL`. El código de N-2 sigue haciendo falta para esos dos casos — no se retira.

  **`CREDIT-NOTE-REQUEST-PENDIENTE-RESOLVE-GUARD-001` narrowed en `docs/pendientes-2026-09-12.md`:**
  verificado por grep contra HEAD que `resolveCreditNoteRequestManually()` y
  `transitionCreditNoteRequestAfterFailure()` son los ÚNICOS DOS callers de
  `CreditNoteRequestRepository.transitionWithClient()` en todo el repo — con P-2 aplicado al
  primero, ningún call-site fuera del camino automático (legítimo) puede alcanzar
  `PENDIENTE -> CERRADA`. Queda como deuda estructural DECLARADA (el tipo sigue permitiéndolo) pero
  no como bug alcanzable — la entrada de pendientes se actualizó para decir exactamente eso, sin
  cerrarla del todo (dos de los tres huecos originales del hallazgo A-3 siguen sin decisión).

  **Cuatro greps de verificación corridos esta ronda (ver el reporte de esta sesión para la salida
  completa):** el patrón de "rama PENDING" (vacío salvo notas de corrección histórica), el patrón
  de "antes de activar"/mayúsculas equivalentes (todas las apariciones vivas ahora consistentes
  con "antes de DESPLEGAR"), la marca de estado que usaba la ronda 6 como propuesta vigente (solo
  queda dentro de la propia entrada de Historial de esa ronda), y la marca de condición C5 sobre
  2a en el encabezado (vacío, ya satisfecha).

  Con esto, la propuesta de ronda 9 responde a los 7 hallazgos de la ronda 8 (N-1 a N-4, P2(a)
  terminología, P2(b) residuo, B-1 residuo) y agrega P-1/P-2 completos — **sigue en HOLD hasta que
  el gate `architecture-governor` corra su propia ronda 9 sobre este texto y lo confirme o
  encuentre huecos nuevos.** *(Nota agregada en ronda 11, sin reescribir esta entrada histórica en
  silencio, mismo criterio que ronda 7 ya usó para no tocar el Historial de ronda 6: esa ronda ya
  ocurrió — fue la ronda 10 del gate, HOLD, 8 hallazgos nuevos, ver su propia entrada de Historial
  más abajo — así que la frase de acá queda como constancia de lo que se esperaba al escribirla, no
  como estado vigente.)* 2c sigue en HOLD por N7 (sin cambios de esta ronda). 5 depende de 2c,
  sin revisar. 6 no revisado (salvo el `motivo` nuevo de §3.10, documentado pero no implementado).

- **23/09/2026, ronda 10 (gate `architecture-governor`, sobre la propuesta de ronda 9): HOLD —
  worklist de correcciones, ninguna reabre el mecanismo ya cerrado en §2, todas sobre huecos de
  texto/diseño en la propuesta de ronda 9. Cerrado, verificado sin necesitar redoble (N-1, N-3
  terminología salvo un residuo de una línea, P2(a) terminología, B-1 en ambos archivos, P2(b)
  encabezado/cierre de §6 salvo dos residuos, P3 registration):**
  1. **N-2/P-2 contradictorio y con conclusión falsa** — el texto de §3.9 afirmaba que una llamada
     `PENDIENTE` "se rechaza en el paso de arriba, antes de tocar la factura" y que la carrera de
     N-2 "ya NO es alcanzable desde una entrada `PENDIENTE` fresca" — lo primero contradice el
     propio mecanismo de P-2 (corre DESPUÉS de que A-2 ya falló, no antes); lo segundo es falso —
     SIGUE siendo alcanzable vía la carrera con el auto-cierre `REJECTED`. El desenlace (409 vía
     N-2) es correcto; el razonamiento estaba mal.
  2. **Caso NUEVO en la misma carrera — la clasificación `EN_REVISION_MANUAL` no cubre "la factura
     se volvió ambigua a mitad de la carrera":** la misma carrera, pero el camino automático
     commitea `FAILED_UNCERTAIN`+`afip_contacted` (en vez de `REJECTED`) y transiciona la solicitud
     a `EN_REVISION_MANUAL`. La reclasificación ve exactamente el estado que su propio predicado
     estricto espera, pero el texto la funnelea al catch-all → 500 sin mapear, descripto como
     "invariante no contemplado" cuando en realidad es alcanzable y recuperable.
  3. **La garantía "misma transacción" de P-2 es real para `issue()`/`reconcileAfterFailure()`, pero
     el worker de Bloque 4 no tiene código — es un REQUISITO, no un hecho verificado.** El
     encabezado y la entrada de pendientes afirman a secas que P-2 "exige `EN_REVISION_MANUAL` antes
     de aceptar CUALQUIER resolución" — hay que precisar el alcance real (bloquea mientras la
     solicitud SIGA `PENDIENTE` en el momento del lock, no todo desenlace de carrera posible) y
     declarar, en la propia sección de Bloque 4, que su gate de pre-commit exige un test de
     integración probando la atomicidad del worker.
  4. **§3.14 (P-1) tiene 4 huecos reales:** (a) la cross-validación sobreclama lo que cubre —
     Consumidor Final (`DocTipo 99`) es el comprador default, así que `DocTipo`/`DocNro` no
     discriminan nada en el caso común; agregar `cbteFch`/`impNeto`/`impIVA`/`concepto`/`monId` (y
     declarar el residuo de Consumidor Final + mismo monto como aceptado). (b) los nombres de campo
     son SOAP-style cuando el puerto real devuelve un DTO camelCase normalizado — verificar contra
     `arca-sdk-billing.adapter.ts`/`afip-billing.port.ts` y corregir todas las referencias. (c) falta
     el caso de `cbteNro` duplicado contra `idx_invoices_talonario` (`23505`, hoy 500 genérico sin
     mapear). (d) `null` de `getVoucherInfo()` NO significa necesariamente "nunca se emitió" — puede
     ser un error de AFIP sin `ResultGet`, y aunque este `cbteNro` puntual no exista eso no dice nada
     sobre si la factura se emitió bajo OTRO número; la redacción del 422 tiene que decir "no se pudo
     confirmar", nunca "no se emitió".
  5. **N-4: matriz de impacto incompleta y conteo de errores mal.** Falta el `Pick<>` de PRODUCCIÓN
     del constructor de `InvoiceService`, los DOS typed doubles de
     `cancel-order-with-credit-note.integration.test.ts`, y `AfipBillingPort`/su adapter/su test SI
     el fix de (b) agrega campos tipados. El total declarado (12) no coincide con la propia suma
     citada (7+1+3+2 = 13) — corregir el total, y sumar lo que los fixes de esta ronda agreguen.
  6. **Bookkeeping RBAC ausente:** `facturacion/invoices.routes.ts` está en `EXCLUDED_FILES` de
     `rbac-matrix-section2-sync.test.ts` con `hiddenCount: 9` — las 3 rutas nuevas lo llevan a 12
     sin una entrada de allowlist actualizada; `EXPECTED_AUTHORIZE_CALL_SITES` tiene que subir de
     215 a 218. Ninguno de los dos estaba declarado en el ADR.
  7. **La entrada narrowed de `CREDIT-NOTE-REQUEST-PENDIENTE-RESOLVE-GUARD-001` tiene un error —
     está al revés para el caso común:** afirma que, con P-2 shipped, una solicitud dejada
     `PENDIENTE` tras una emisión automática exitosa "sigue resoluble (P-2 no la bloquea)" — es lo
     contrario: si el camino automático tiene éxito en el PRIMER intento (nunca pasa por
     `FAILED_UNCERTAIN`), la solicitud queda `PENDIENTE` para siempre (nada la auto-cierra) y, con
     P-2 shipped, `resolve` la RECHAZA (no está `EN_REVISION_MANUAL`) — queda SIN ninguna forma de
     cerrarse. También corregir el tiempo verbal: "ya está guardado" sobre algo que P-2 todavía no
     shippeó.
  8. **Tests faltantes en §7:** N-1 (factura con solicitud `CERRADA` que `mark-not-issued` ahora
     acepta; con solicitud ABIERTA que sigue dando 409), P-1/§3.14 (caso AFIP-prevalece nuevo,
     colisión `23505`, wording del 422 "no encontrado"), y nota cruzada de que Bloque 4 necesita su
     propio test de atomicidad del worker (el spec completo vive en la sección de Bloque 4, no acá).

  Una decisión de negocio NUEVA del dueño, tomada en esta sesión vía `AskUserQuestion` (aplicada en
  ronda 11, ver el encabezado del documento): **"AFIP prevalece"** — cuando `reconcile-with-afip`
  encuentra un comprobante AFIP real para una factura que el operador ya declaró `NO_EMITIDA` a
  mano, el comprobante real gana y la factura pasa a `ISSUED`, cerrando el hueco #5 de arriba (antes
  un 500 sin mapear).

- **23/09/2026, ronda 11 (propuesta — corrige los 8 hallazgos del veredicto de ronda 10 del gate y
  diseña la extensión "AFIP prevalece" de P-1 a partir de la decisión de negocio nueva del dueño;
  PENDIENTE de verificación por el gate `architecture-governor`, este texto no se autoaprueba.
  Alcance: solo documentación, sobre este archivo y `docs/pendientes-2026-09-12.md` — ningún
  archivo de `src/` tocado, ni el Bloque 2b (fuera de alcance, gate propio en paralelo).**

  **1-2 (N-2/P-2 contradictorio + caso nuevo EN_REVISION_MANUAL) aplicados en §3.9:** reescrita la
  sección "Reevaluación de alcance tras P-2" — el mecanismo y el desenlace (409 vía N-2) no cambian,
  se corrige el razonamiento: SÍ es alcanzable desde una entrada `PENDIENTE` fresca, vía la carrera
  con el auto-cierre `REJECTED`. Agregado un bullet nuevo a la clasificación `EN_REVISION_MANUAL`
  para el caso "la factura se volvió ambigua a mitad de la carrera" — reusa
  `InvoiceReconciliationUnexpectedStateError` (sin error nuevo), documentado como 500 TRANSITORIO Y
  RETRYABLE (mismo criterio que P3 ya usa para su caso análogo): un segundo intento del operador ve
  el estado ya asentado y resuelve directo.

  **3 (garantía "misma transacción" de P-2) aplicado en el encabezado, §3.9 y §6:** el bullet P-2 del
  encabezado ahora precisa el alcance real de la garantía y cross-referencia la condición de test
  nueva; el "verificado exhaustivamente" de §3.9 se reescribe distinguiendo los 2 escritores YA
  verificados en código del tercero (worker de §3.3) todavía sin código; la sección "Bloque 4" de §6
  gana la condición de test OBLIGATORIA completa (ronda 10, condición (i)), citada desde §3.9 sin
  duplicarse (ronda 10, condición (ii)).

  **4(a)-4(d) aplicados en §3.14, verificados contra código real esta sesión** (`afip-billing.port.ts`,
  `arca-sdk-billing.adapter.ts`, el mapper real del SDK `@arcasdk/core`
  `soap-to-dto.mapper.js::mapVoucherInfo()`, `invoice.service.ts`, `schema.sql`,
  `error.middleware.ts`): cross-validación extendida a 8 campos (con el residuo de Consumidor Final
  declarado, y `CbtesAsoc` declarado NO disponible por este puerto hoy); `VoucherInfoResult` extendido
  con los campos tipados reales; error nuevo `InvoiceVoucherNumberAlreadyRegisteredError` (409) para
  la colisión `23505` sobre `idx_invoices_talonario`; redacción del 422 de "no encontrado" corregida
  a "no se pudo confirmar", nunca "no se emitió". La extensión "AFIP prevalece" (decisión nueva del
  dueño) se diseñó como sección propia de §3.14: predicado de población extendido (segunda rama,
  `uncertain_cleared_at IS NOT NULL`), escritor nuevo y EXCLUSIVO
  (`markIssuedFromAfipReconciliationWithClient()`, deliberadamente SIN compartirse con el camino
  puramente manual — mismo criterio "un método por contrato de escritura" que A-2 ya estableció),
  error de precondición nuevo (`AfipReconciliationPreconditionError`), y el argumento de por qué el
  predicado es seguro sin comparar "intento viejo vs. nuevo" explícitamente (se apoya en el
  invariante de §3.5).

  **5 (N-4 matriz + conteo) aplicado en §6:** agregados el `Pick<>` de producción del constructor de
  `InvoiceService`, los 2 typed doubles de `cancel-order-with-credit-note.integration.test.ts`, y
  `AfipBillingPort`/su adapter/su test. Conteo total recalculado: **15 errores nuevos** (10+3+2), no
  12 ni 13 — 2 nuevos de esta ronda (`InvoiceVoucherNumberAlreadyRegisteredError`,
  `AfipReconciliationPreconditionError`); el residuo #2 (caso nuevo `EN_REVISION_MANUAL`) NO agrega
  un error nuevo.

  **6 (bookkeeping RBAC) aplicado — §3.15 nueva:** declarados explícitamente `hiddenCount: 9 → 12`
  de `rbac-matrix-section2-sync.test.ts` y `EXPECTED_AUTHORIZE_CALL_SITES: 215 → 218` como parte
  obligatoria de la implementación del Bloque 3.

  **7 (entrada narrowed de pendientes) corregido en `docs/pendientes-2026-09-12.md`:** reescrito el
  bullet — con P-2 shipped, una solicitud `PENDIENTE` tras una emisión automática exitosa EN EL
  PRIMER INTENTO queda SIN ninguna forma de cerrarse (no "sigue resoluble"), registrado como residuo
  nuevo de implementar P-2, y corregido el tiempo verbal.

  **8 (tests faltantes) aplicados en §7:** casos de N-1 (solicitud `CERRADA` aceptada, solicitud
  ABIERTA rechazada), casos de P-1/§3.14 (AFIP-prevalece, colisión `23505`, wording del 422), y
  cross-referencia a la condición de test de Bloque 4 sin duplicar el spec completo.

  Con esto, la propuesta de ronda 11 responde a los 8 hallazgos del veredicto de ronda 10 del gate y
  diseña completa la extensión "AFIP prevalece" — **sigue en HOLD hasta que el gate
  `architecture-governor` corra su propia revisión sobre este texto y lo confirme o encuentre huecos
  nuevos.** 2c sigue en HOLD por N7 (sin cambios de esta ronda). 5 depende de 2c, sin revisar. 6 no
  revisado (salvo el `motivo` nuevo de §3.10, documentado pero no implementado).

- **23/09/2026, ronda 12 (gate `architecture-governor`, sobre la propuesta de ronda 11): HOLD —
  dos hallazgos load-bearing (H1, H2) y varios menores (H3), ninguno reabre el mecanismo "AFIP
  prevalece" en sí (la decisión de negocio se mantiene), pero H1 y H2 bloquean implementación tal
  como estaba escrita:**
  1. **H1 — el argumento de seguridad de §3.14 era FALSO, contradecía su propio SQL y su propio test
     de §7.** El predicado `status = 'FAILED_UNCERTAIN' AND afip_contacted` del guard de
     `markIssuedFromAfipReconciliationWithClient()` NO mira `uncertain_cleared_at` — así que el
     argumento de §3.5 (el reset a `NULL`, presentado como el mecanismo de seguridad) es irrelevante
     para si este predicado matchea o no. Un reintento MÁS NUEVO que vuelve a caer en ambigüedad
     (`FAILED_UNCERTAIN`+`afip_contacted` otra vez) matchea el MISMO predicado — el texto se
     contradecía a sí mismo, afirmando en un lugar que esto "NUNCA puede matchear" y describiendo
     dos líneas después exactamente el caso en que sí matchea. Tampoco aplica TODAVÍA en la
     práctica (el reset de §3.5 es entregable del Bloque 2c, que todavía no existe —
     `markFailedWithClient()` hoy explícitamente NO resetea `uncertain_cleared_at`, su propio
     comentario dice "asignado al Bloque 2c -- no se toca acá"). El test de §7 que afirma que una
     `FAILED_UNCERTAIN` recién re-fallada NO matchea el predicado de reconciliación es, tal como está
     escrito, IMPOSIBLE de pasar contra el SQL real. Otro texto sobreclamado ("nunca escribe un
     comprobante viejo sobre un estado más nuevo") también es falso para esta rama. `retryExisting()`
     reusa el MISMO `existing.afipRequest` en cada reintento (mismo `CbteFch`, mismos montos) — la
     validación cruzada genuinamente no puede distinguir "comprobante del intento 1" de "comprobante
     del intento 2", que es justamente por qué esto es un residuo real, no reparable sin mecanismo
     nuevo, y no un bug de texto.
  2. **H2 — contradicción de routing entre rama 1 y rama 2 (también load-bearing, bloquea
     implementación).** El Paso 4 de §3.14 routeaba la rama 1 (población nunca-limpiada) al escritor
     existente de A-2 (`markIssuedFromManualResolutionWithClient()`, que exige
     `uncertain_cleared_at IS NULL`) — pero la sección "Interacción con mark-not-issued" ya asumía
     que la rama 1 pasaba por el escritor NUEVO, diciendo que "escribe igual". Con el routing tal
     como estaba escrito, si `mark-not-issued` ganaba una carrera primero, el escritor de A-2 no
     matcheaba y la reclasificación caía en un 500 sin mapear — no el comportamiento "prevalece" que
     el diseño dice perseguir. **Fix, consistente con la intención ya declarada del propio mecanismo**
     ("cubre las DOS ramas con un solo `WHERE`"): `reconcile-with-afip` usa SIEMPRE el escritor nuevo
     `markIssuedFromAfipReconciliationWithClient()`, para las dos ramas — el escritor de A-2
     (`markIssuedFromManualResolutionWithClient()`) queda EXCLUSIVO del camino manual
     (`resolveCreditNoteRequestManually()`), nunca invocado desde `reconcile-with-afip`. Actualizar:
     el routing del Paso 4, el bullet de A-2 en §6 (que afirmaba "reusado también por P-1" — sacar
     esa afirmación), y la lista de mocks de N-4 si referencia el escritor equivocado como
     compartido.
  3. **H3 — hallazgos menores, misma ronda:**
     - La afirmación de que el residuo de staleness de `resolutionOutcome` "queda registrado como
       hallazgo nuevo en pendientes" es FALSA — un grep confirma que no está (mismo modo de falla que
       el incidente histórico de N7 que este repo ya documenta). Agregarlo de verdad.
     - La sección "A-3" sigue afirmando que una solicitud ligada a una factura auto-emitida bien
       queda "resoluble... de forma segura" — con P-2 aplicado (ronda 9), eso es cierto SOLO si la
       solicitud está `EN_REVISION_MANUAL`; si sigue `PENDIENTE` (el caso común, porque nada la
       auto-cierra en éxito), NO puede resolverse manualmente en absoluto una vez P-2 exista. Corregir
       la afirmación.
     - `docs/pendientes-2026-09-12.md` tiene una referencia adelantada stale, "ronda 9 pendiente de
       su propio gate" — actualizar o sacar, ya se pasaron varias rondas de esa.
     - ¿El escritor nuevo `markIssuedFromAfipReconciliationWithClient()` también toca
       `uncertain_cleared_by`? Recomendación del gate: dejar los DOS campos sin tocar (no limpiar
       ninguno) — preserva la única evidencia durable de que existió una declaración manual
       `NO_EMITIDA` que AFIP terminó contradiciendo, relevante para auditoría/reportes de
       reconciliación. Verificar que el diseño del escritor lo respete y declararlo explícitamente.
     - La aclaración de conteo de errores de N-4: 15 es el TOTAL combinado de Bloque 3 Y Bloque 4 —
       `RetryInvoiceInFlightError` nace en Bloque 4 (§3.7/§6), no en Bloque 3. El delta propio de
       Bloque 3 a `error.middleware.ts` es 14, no 15. Aclarar dondequiera que se cite el conteo, para
       que no se lea como "Bloque 3 solo agrega 15 errores".
     - Slip menor de texto: un lugar dice "7 campos… 8 en total" para los campos de cross-validación
       — corregir a 8 en todo el documento, consistente con el fix real de ronda 11.
     - Nota de fixtures de test: el/los test(s) de cross-validación de §7 deberían describirse como
       necesitando un fixture con la forma del parseo SOAP REAL (no un `VoucherInfoResult` armado a
       mano que se salte el parseo real) — agregar esa nota a la descripción de ese test en §7, para
       que quien lo implemente no tome un atajo que se pierda discrepancias de forma reales.

  **Decisión de negocio nueva del dueño, tomada esta sesión vía `AskUserQuestion` (aplicada en ronda
  13, ver el bloque siguiente): "Prevalece igual, registrar el residuo"** — el mecanismo "AFIP
  prevalece" queda como está diseñado en intención (el comprobante real de AFIP gana sobre una
  declaración manual `NO_EMITIDA` obsoleta) — pero el caso borde que H1 encontró (también puede
  "ganar" en silencio sobre un intento AUTOMÁTICO más nuevo cuyo desenlace todavía no se conoce, ya
  que el predicado SQL actual no puede distinguir "el intento viejo que esta `NO_EMITIDA` describía"
  de "un intento más nuevo que volvió a entrar en ambigüedad") se acepta como residuo conocido,
  documentado — NO se cierra con mecanismo o schema nuevo.

- **23/09/2026, ronda 13 (propuesta — corrige H1/H2/H3 del veredicto de ronda 12 del gate aplicando
  la decisión "Prevalece igual, registrar el residuo"; PENDIENTE de verificación por el gate
  `architecture-governor`, este texto no se autoaprueba. Alcance: solo documentación, sobre este
  archivo y `docs/pendientes-2026-09-12.md` — ningún archivo de `src/` tocado, ni nada de Bloque 3
  fuera de §3.14/§7/el bullet de A-2 y P-1 de §6/la afirmación de A-3/este Historial (el resto del
  diseño de Bloque 3 no tuvo hallazgos en ronda 12, sin tocar).**

  **H1 aplicado en §3.14 ("Población objetivo" y "AFIP prevalece") y en el test correspondiente de
  §7:** sacadas las dos afirmaciones falsas ("nunca puede matchear", "nunca escribe un comprobante
  viejo sobre un estado más nuevo"). Redactado el comportamiento real: el predicado de
  `markIssuedFromAfipReconciliationWithClient()` SÍ puede matchear un reintento más nuevo que volvió
  a caer en ambigüedad, y AFIP prevalece igual en ese caso — trade-off aceptado y deliberado, no un
  bug que se esté enviando en silencio. El test de §7 (caso "la factura ya avanzó") se separó en dos:
  el sub-caso `PENDING`/`ISSUED`/`REJECTED` (sigue sin matchear, correcto) y el sub-caso
  `FAILED_UNCERTAIN` fresca (ahora escribe — AFIP prevalece —, no rechaza). El residuo se registra en
  `docs/pendientes-2026-09-12.md` como `ISSUE-BEFORE-REVERSE-WINDOW-001-AFIP-PREVAILS-NEWER-ATTEMPT-SHADOW-001`,
  con ancla verificable y describiendo la CONSECUENCIA (un comprobante AFIP real, genuinamente
  distinto, de un reintento más nuevo podría quedar invisible para el sistema si una reconciliación
  vieja matchea y escribe primero) — no solo el mecanismo.

  **H2 aplicado en §3.14 (Paso 4 y el párrafo de error de precondición) y en §6 (bullets de A-2 y
  P-1):** `reconcile-with-afip` usa SIEMPRE `markIssuedFromAfipReconciliationWithClient()`, para las
  DOS ramas de su población — el escritor de A-2 (`markIssuedFromManualResolutionWithClient()`)
  queda exclusivo de `resolveCreditNoteRequestManually()`, nunca invocado desde acá. Sacada la
  afirmación "reusado también por P-1" del bullet de A-2; el bullet de P-1 ahora dice explícitamente
  que escribe SIEMPRE por su propio escritor. La lista de mocks de N-4 no necesitó cambios — ya
  enumeraba `markIssuedFromAfipReconciliationWithClient()` como método aparte, sin afirmar que
  comparte población con A-2.

  **H3 aplicado:**
  - Residuo de `resolutionOutcome` registrado de verdad en `docs/pendientes-2026-09-12.md` como
    `ISSUE-BEFORE-REVERSE-WINDOW-001-AFIP-PREVAILS-RESOLUTION-OUTCOME-STALE-001` (la cita en §3.14
    que decía que ya estaba registrado se corrigió para admitir que no lo estaba).
  - Claim de A-3 corregido: "resoluble de forma segura" ahora está acotado explícitamente al caso
    `EN_REVISION_MANUAL`; el caso común (`PENDIENTE`, nunca auto-cerrado en éxito) queda sin ninguna
    forma de resolverse una vez P-2 exista, con referencia al residuo (b) ya registrado en
    `CREDIT-NOTE-REQUEST-PENDIENTE-RESOLVE-GUARD-001`.
  - Referencia adelantada stale de `docs/pendientes-2026-09-12.md` ("ronda 9 pendiente de su propio
    gate") corregida — ya no cita un número de ronda que envejece solo.
  - Corregido el SQL del escritor (§3.14, "Escritor nuevo, exclusivo de `reconcile-with-afip`"): la
    versión de ronda 11 limpiaba `uncertain_cleared_at = NULL` en el `UPDATE`. Esta ronda saca esa
    asignación del `SET` — el escritor ahora NO toca ni `uncertain_cleared_at` ni `uncertain_cleared_by`
    — y declara por qué (preserva la evidencia de auditoría de que existió una declaración manual
    `NO_EMITIDA` luego contradicha por AFIP). Es un cambio de SQL, no solo de prosa.
  - N-4: aclarado que 15 es el total combinado Bloque 3 + Bloque 4 (`RetryInvoiceInFlightError` nace
    en Bloque 4), y que el delta propio de Bloque 3 es 14.
  - "7 campos… 8 en total" corregido a "8 campos" (única ocurrencia inconsistente, verificada por
    grep — el resto del documento ya decía 8 en todos los otros lugares).
  - Nota de fixture agregada al test de cross-validación extendida de §7: sembrar con la forma real
    del parseo SOAP (`mapVoucherInfo()`), no un `VoucherInfoResult` armado a mano.

  Con esto, la propuesta de ronda 13 responde a los 3 hallazgos (H1, H2, H3) del veredicto de ronda
  12 del gate — **sigue en HOLD hasta que el gate `architecture-governor` corra su propia revisión
  sobre este texto y lo confirme o encuentre huecos nuevos.** 2c sigue en HOLD por N7 (sin cambios de
  esta ronda). 5 depende de 2c, sin revisar. 6 no revisado (salvo el `motivo` nuevo de §3.10,
  documentado pero no implementado). Bloque 4 está fuera de alcance de esta ronda 13 (esta ronda no
  lo tocó) — su código puede estar en desarrollo en paralelo por otro agente con su propio gate; no
  asumir acá si existe o no código para Bloque 4 en el momento de la lectura, verificar
  `git status`/`git log` real en vez de confiar en esta frase.

- **23/09/2026, ronda 14 — corrección de integridad documental, no re-diseño (gate
  `architecture-governor`, pre-commit sobre la implementación de Bloque 3).** El commit `f9af82f`
  (que subió este documento con las rondas 6-13 a `main`) trae un mensaje de commit que afirma
  *"Bloque 3 alcanza APROBADO CON CONDICIONES en ronda 14... las 7 condiciones de esa ronda (3
  obligatorias, 4 recomendadas) ya están aplicadas"*. **Esa afirmación no tiene respaldo en este
  documento ni en ningún otro archivo del repo** — el gate de pre-commit que revisó la
  implementación de Bloque 3 (esta misma entrada) hizo `grep -rln "ronda 14" docs/` y no encontró
  ninguna ocurrencia previa a esta entrada, y el encabezado del documento seguía diciendo "ronda 11,
  propuesta" con el Historial terminando en ronda 13 ("sigue en HOLD"). No se sabe qué pasó — si la
  sesión que escribió ese mensaje de commit hizo la revisión pero no llegó a persistir el resultado
  en este archivo antes de commitear, o si describió un trabajo que no se completó. No se
  reconstruye retroactivamente una "ronda 14" ficticia con 7 condiciones inventadas — eso repetiría
  el error, no lo corregiría.

  En cambio: esta entrada **es** la ronda 14 real. El gate de pre-commit, al revisar el código de
  Bloque 3 recién implementado, releyó la sustancia del diseño de ronda 13 (§3.9, §3.14, §6) de
  forma independiente —sin apoyarse en la premisa de "ronda 14 ya aprobada"— y la encontró sólida:
  sin huecos nuevos de matriz de impacto, guards de resolución manual y reconciliación AFIP
  consistentes con lo diseñado en ronda 13, escritores separados correctamente (H2 de ronda 12
  sigue corregido). El veredicto completo sobre el CÓDIGO (no sobre este documento) fue **APROBADO
  CON CONDICIONES**, con dos condiciones: (1) esta misma corrección de integridad documental, y (2)
  corregir las citas de "263" endpoints en `app-main/CLAUDE.md` (sección "Contratos") a 266, con su
  propia entrada fechada — ambas docs-only, ninguna reabre el diseño de Bloque 3. Detalle completo
  del veredicto sobre el código: fuera de este documento, en el registro de la sesión que lo generó.

  **Estado real, no una foto fija:** Bloque 3 tiene código escrito, gate de pre-commit aprobado con
  las 2 condiciones de arriba. Si el código ya está commiteado y con qué hash, verificar
  `git log`/`git status` en el momento de la lectura — no asumirlo de esta frase.
