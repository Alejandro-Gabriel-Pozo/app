# ADR — cerrar la ventana reintento-de-factura vs. reversa (`ISSUE-BEFORE-REVERSE-WINDOW-001`)

**Fecha:** 23/09/2026. **Estado (ronda 3, gate `architecture-governor`): bloque 1 APROBADO CON
CONDICIONES (alcance ampliado en §6, punto 1); bloques 2-6 en HOLD — 7 huecos nuevos (N1-N7,
ver §3.1-§3.9 y §6) encontrados sobre el texto de la ronda 2, pendientes de una ronda 4 antes de
gatear el diseño del bloque 2.** Sin código implementado todavía.
**Hallazgo que cierra:** `WAVE13-ZONA2-CONSOLIDATED-RETRY-ISSUE-BEFORE-REVERSE-WINDOW-001`
(`docs/pendientes-2026-09-12.md`). **No se une con** `WAVE13-ZONA2-CONSOLIDATED-RETRY-DUPLICATE-CAE-001`
(hallazgo hermano, mismo archivo, gate separado en curso) — comparten la raíz (un cargo con
más de una factura ligada) y el mismo punto de entrada (`retryExisting()`, antes de `issue()`),
pero son mecanismos distintos. Ver §5 (secuencia).

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
gate, decisión del dueño ya confirmada en §2): hoy `retryExisting()` también reintenta un
`PENDING` (ver su propio docblock) — con la toma exclusiva de arriba, un `PENDING` fresco no
matchea ninguna rama del `WHERE` (no es `REJECTED` ni `FAILED_UNCERTAIN`), así que el `UPDATE`
no devuelve fila y el reintento se rechaza con 409 sin excepción, sin importar si el `PENDING`
es propio (otro reintento en curso) o del camino fresco. No hay liberación manual antes del
vencimiento automático (decisión confirmada en §2) — la única salida es esperar.

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

DROP CONSTRAINT IF EXISTS chk_invoices_pending_since;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoices_pending_since') THEN
    ALTER TABLE invoices ADD CONSTRAINT chk_invoices_pending_since
      CHECK ((status = 'PENDING') = (pending_since IS NOT NULL));
  END IF;
END $$;
```

El backfill con `created_at` es seguro PORQUE hasta este bloque `retryExisting()` nunca vuelve a
poner `PENDING` (solo el INSERT inicial lo hace) — no hay ninguna `PENDING` existente hoy que
esté "en vuelo por un reintento" sin haberlo estado también en su creación. Esto deja de ser
cierto en cuanto este bloque se despliega, así que el orden importa: el backfill corre como
parte del MISMO deploy que agrega la columna, antes de que cualquier reintento pueda volver a
poner `PENDING`.

**`CURRENT_SCHEMA_VERSION`** (`src/platform/tenant-db.setup.ts`) sube en este mismo bloque —
dispara `DEFENSIVE_DEVELOPING.md` §3 (toca `src/platform/`), a completar en el commit.

**La consulta de solo lectura por tenant de §4 tiene que correr ANTES del deploy de este
bloque** (no antes de "activar el worker", como decía la ronda 1) — el `UPDATE` de backfill de
arriba corre en cada tenant en el momento del deploy, así que hace falta saber cuántas filas
`PENDING` existen hoy para no sorprenderse con el volumen del backfill, aunque el backfill en sí
sea seguro por el argumento de arriba.

Todo escritor que saque una factura de `PENDING` sin limpiar `pending_since` falla en la base,
no en silencio. Call-sites a tocar: `createWithClient()` (setea `pending_since = NOW()` junto
con el INSERT), `markIssuedWithClient()`/`markFailedWithClient()` (`pending_since = NULL`), la
toma exclusiva nueva de §3.2, y el UPDATE del worker de §3.3.

### 3.7 Mensaje de error distinto para "en vuelo" vs. "necesita NC", y qué hace `retryExisting()` con un `PENDING` (bloque 2)

`ArReversalRequiresCreditNoteError` (`accounts-receivable.service.ts`) dice *"...la corrección
tiene que hacerse con una Nota de Crédito, no con `reverseTransfer()`"* — engañoso para el caso
"hay una emisión genuinamente en vuelo, reintentá en un momento" (ya lo es hoy para el `PENDING`
transitorio del camino fresco, sin este bloque).

**Resolución:** nuevo error `RetryInvoiceInFlightError(invoiceId)`, mapeado a **409** (no 422 —
es una precondición temporal que se resuelve sola con el tiempo, mismo grupo semántico que el
resto de errores 409 de "carrera en curso" ya listados en `error.middleware.ts`, no el grupo 422
de "regla de negocio violada"). Es el error que devuelve la toma exclusiva de §3.2 cuando el
`UPDATE ... RETURNING` no encuentra fila porque la factura ya está `PENDING` (propia o ajena) —
**política confirmada por el dueño en §2: siempre 409 mientras la marca esté fresca, sin
excepción, sin liberación manual antes del vencimiento automático.** No hace falta ningún
chequeo de tiempo separado acá — si la marca ya venció, el worker de §3.3 ya la habrá movido a
`FAILED_UNCERTAIN` antes de que este código la vea, así que el propio `status` de la fila decide.

Distinto del guard 8-bis de `reverseTransfer()` (§3.1) — ese sigue usando
`ArReversalRequiresCreditNoteError` (422) para TODOS sus casos de bloqueo, incluido `PENDING`
(ver la tabla de §3.1): el 409 nuevo es específico de `retryExisting()` rechazando un reintento
concurrente, no de `reverseTransfer()` rechazando una reversa. No se unifican los dos errores —
son dos operaciones distintas rechazando por motivos relacionados pero no idénticos.

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

La bandeja del Bloque 5 (`resolveCreditNoteRequestManually()`) está acotada a
`credit_note_request` — filas que solo existen para `tx.type === 'ADJUSTMENT'`
(`invoice.service.ts`). Una factura `CHARGE` que el worker de vencimiento (§3.3) lleve a
`FAILED_UNCERTAIN` no tiene NINGUNA salida dentro del sistema hoy — viola directamente el
principio de "salida propia" que motivó este mecanismo en primer lugar.

**Resolución — bandeja nueva, no extender `credit_note_request`** (su máquina de estados es de
NC, no de facturas en general; extenderla mezclaría dos conceptos, mismo criterio que este repo
ya aplicó al NO fusionar `ESCAPE_ROUTES` con `CITY-LEDGER-REVERSE-ROUTE-GROUP-FREEZE-001`,
CLAUDE.md):

- `GET /api/invoices/uncertain` — lista facturas `FAILED_UNCERTAIN` con `afip_contacted = true`
  y `uncertain_cleared_at IS NULL`, **excluyendo las que tienen una `credit_note_request` propia**
  (esas siguen su propio camino, ver abajo). RBAC: `MANAGEMENT` (mismo criterio que la decisión
  ya tomada para el reporte (d), §3.10 — ambos exponen estado de facturación sin reconciliar).
  Se registra ANTES de `GET /api/invoices/:id` en `invoices.routes.ts` — mismo motivo ya
  documentado en ese archivo para otras rutas de segmento fijo (`/uncertain` matchearía como
  `:id` si se registra después).
- `POST /api/invoices/:id/mark-not-issued` — mismo efecto que
  `resolveCreditNoteRequestManually()` con `outcome: 'NO_EMITIDA'`: llama a
  `markUncertainClearedWithClient()`. **Corrección (hueco N6, ronda 3 del gate):**
  `markUncertainClearedWithClient()` hoy actualiza con `WHERE id = $1`, sin condición de status
  (`sql.invoice.repository.ts`) — seguro en el Bloque 5 porque `credit_note_request` ya trae su
  propia máquina de estados como guard previo, pero esta ruta nueva no tiene ese guard. Este
  bloque agrega el predicado a la condición del `UPDATE`:
  `WHERE id = $1 AND status = 'FAILED_UNCERTAIN' AND afip_contacted AND uncertain_cleared_at IS NULL`
  — si no matchea (la factura ya se limpió, ya se resolvió sola, o nunca estuvo en ese estado),
  rechaza en vez de escribir un estado inconsistente. **Rechaza
  con un error dedicado (fail-loud, no silencioso) si la factura SÍ tiene una `credit_note_request`
  ligada** — esa combinación va por `POST /credit-note-requests/:id/resolve`, no por acá; dos
  salidas para el mismo caso serían dos fuentes de verdad divergentes (hueco B7 del gate, ronda
  2). RBAC: **`Roles.EMISOR_NOTA_CREDITO`** (decisión del dueño, §2).
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
  construya la pantalla — igual que las dos bandejas existentes del Bloque 5, ya en esa lista).

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

## 4. Migración de datos existentes (hueco #9 del gate — residuo, no bloquea el ADR)

Si se completa `pending_since` retroactivamente para las `PENDING` que ya existen en producción,
el primer ciclo del worker las evaluaría contra su `pending_since` (poblado con, por ejemplo,
`created_at` como aproximación) y podría convertir en `FAILED_UNCERTAIN` filas que en realidad
nunca estuvieron "coladas" — solo son `PENDING` porque el camino fresco tardó en resolver.

**No verificado esta sesión — sin acceso a producción desde este entorno.** Antes de implementar
el worker, se necesita una consulta de solo lectura por tenant: cuántas `invoices` están hoy
`PENDING`, y cuántas `FAILED_UNCERTAIN` con `afip_contacted = true` y sin `uncertain_cleared_at`,
separadas por `CHARGE` vs. NC. Se registra como verificación pendiente en
`docs/pendientes-2026-09-12.md`, sección `## 🔍 Verificaciones pendientes`, con la acción
puntual que la cierra (correr esa consulta contra cada tenant real antes de activar el worker en
producción — el worker puede implementarse y testearse sin este dato, pero no activarse).

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
2b. **Bloque 2b — el CHECK `chk_invoices_pending_since`** (§3.6), en un deploy POSTERIOR a 2a,
   una vez confirmado que la versión que sirve tráfico ya es la que mantiene la columna en todos
   sus escritores. La consulta de producción de §4 corre antes del deploy de 2a (mide el volumen
   del backfill), no antes de 2b.
2c. **Bloque 2c — toma exclusiva completa (§3.2) + error 409 nuevo (§3.7) + guard 8-bis respeta
   `uncertainClearedAt` (§3.8, movido acá desde el bloque 1).** Depende de 2a/2b.

**Huecos de secuencia entre 2c, 3 y 4 (N3, ronda 3 del gate) — los bloques 2c, 3 y 4 DEPLOYAN
JUNTOS, en el mismo deploy, aunque se implementen y gateen como commits/PRs separados:** hoy
`retryExisting()` es la salida documentada para una `PENDING` huérfana (el propio código y el
botón "Reintentar factura" del frontend dependen de poder reintentarla). El bloque 2c le quita
esa salida (409 en vez de reintentar). Si 2c se deploya solo, sin que el bloque 3 (salida
manual) y el bloque 4 (worker que resuelve el limbo) ya estén live, una `PENDING` colgada queda
sin NINGUNA salida hasta el próximo deploy — viola el principio de salida propia por una ventana
de tiempo, no de diseño. Los tres bloques pueden implementarse y gatearse en commits separados
(cada uno con su propio pre-commit), pero el ORDEN DE DEPLOY los ata: no hay deploy intermedio
entre el commit de 2c y el commit de 4.

3. **Bloque 3 — salida manual para `CHARGE`/NC (§3.9)**, incluida la exclusión de facturas con
   `credit_note_request` propia y el predicado corregido de `mark-not-issued` (N6).
4. **Bloque 4 — worker de vencimiento (§3.3, §3.4)**, incluida la transición de
   `credit_note_request` a `EN_REVISION_MANUAL` cuando corresponda (§3.9).
5. **Bloque 5 — alcance NC en la toma de marca (§3.11).**
6. **Bloque 6 — reporte (d) (§3.10)** — sin dependencia dura de 1-5, puede ir en paralelo o
   después.

**Residuo declarado (N7, ronda 3 del gate, sin cerrar en este ADR):** falta el análisis de orden
de locks entre la toma de la marca "en vuelo" (AR → órdenes/reservas → `invoices`, orden ya
establecido por `assertChargesStillInvoiceable()`) y otros caminos que lockean `invoices`
PRIMERO (ej. `getOutstandingForUpdate()`) — un ABBA potencial que ningún bloque de este ADR
cierra todavía. Se registra como verificación pendiente antes del gate de implementación del
bloque 2c.

Cada bloque trae su propio pre-commit con `architecture-governor`. Este ADR autoriza el DISEÑO
del bloque 1 (aprobado, ronda 3) — los bloques 2a en adelante quedan en HOLD hasta una ronda 4
que resuelva N1-N7 de forma completa (no solo la reordenada acá) antes de su propio gate de
implementación.

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
- Los números reales de producción (§4) — bloquean el DEPLOY del bloque 2 (no solo la activación
  del worker, corregido en §3.6), no la implementación ni los tests de ningún bloque.

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
