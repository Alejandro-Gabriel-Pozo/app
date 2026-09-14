# Playbook — auditar TODOS los consumidores antes de ampliar un tipo/campo compartido

- **Fecha:** 2026-09-14
- **Estado:** aplicado (City Ledger, `reverseTransfer()`, Bloque 3c) — extraído después del hecho, no antes.
- **Contexto:** 5 rondas de gate `architecture-governor` sobre un único mecanismo (`AccountsReceivableService.reverseTransfer()`). De esas, al menos 3 HOLD/condiciones no fueron por el DISEÑO del método en sí — fueron "te faltó declarar este consumidor del tipo/campo que estás tocando".
- **Categoría:** Proceso de cambio — auditoría previa, no patrón de código.
- **Etiquetas:** `RBAC-SYNC-001` `ROLES-CATALOG-DRIFT-001` `SCHEMA-ANCHOR-DRIFT-001` `mirror-drift` `cross-repo`
- **Referencias:** `docs/diseno-reconciliacion-city-ledger-2026-09-12.md` (rondas de gate); `docs/pendientes-2026-09-12.md` (`CITY-LEDGER-AR-REPORT-ROW-FRONTEND-MIRROR-001`, cerrado en `docs/resuelto.md`); `CLAUDE.md` raíz, sección RBAC (`ROLES-CATALOG-DRIFT-001`).

## Problema (hecho, no hipótesis)

Ampliar `AccountsReceivableStatus` de 3 a 4 valores (agregar `REVERTIDO`) y agregar un campo (`replaces_ar_id`/`reversed_*`, luego `revertedAmount`) tocó, en total, **consumidores en 3 categorías que se fueron descubriendo una por una, en rondas de gate sucesivas, en vez de en una sola pasada**:

1. **Consumidores exhaustivos del tipo** (`Record<AccountsReceivableStatus, ...>`, un `switch` sin `default`) — el compilador los pesca solo, pero solo si el desarrollador AMPLÍA el tipo antes de escribir el consumidor nuevo. `AR_STATUS_LABEL` en `appfrontend-main` sí era de este tipo — TypeScript lo forzó.
2. **Consumidores NO exhaustivos** (agregaciones SQL con `FILTER (WHERE status = ...)`, `Record` de OTRO tipo que solo comparte forma con el primero) — nada los fuerza. `getReportByPeriod()` (un `SUM(...) FILTER` por cada status, sin bucket para el 4º) y el espejo `AccountsReceivableReportRow` del frontend (mismos 4 campos, tipado como `unknown` en su único consumidor) cayeron acá — se encontraron en la ronda de gate de la RUTA, dos bloques después de haber tocado el tipo por primera vez.
3. **Referencias a un método renombrado/ensanchado** (`lockForUpdate` → `getByIdWithLock`) — un grep encuentra todos los call-sites reales, pero **no** los comentarios de otros archivos que MENCIONAN el nombre viejo (`payment-application.ts` lo citaba en un docblock) ni los números que dependían del conteo anterior (`EXPECTED_AUTHORIZE_CALL_SITES`, el header de `rbac-matriz-endpoints.md`, el total de `docs/inventario-rutas.md`, 3 citas de "251" en `CLAUDE.md` que ya estaban stale ANTES de este bloque).

Ninguno de estos hallazgos cambió el diseño del método — todos eran "esto también hay que actualizarlo", encontrados tarde porque nadie los buscó ANTES de escribir la primera línea de código.

## Receta

Antes de escribir el primer commit que amplíe un `enum`/union/campo compartido entre módulos o entre repos, correr en UNA sola pasada (no repartida entre rondas de gate):

1. **`grep -rn '<NombreDelTipo>'` en los dos repos** (`app-main` y `appfrontend-main`, o los que compartan el contrato) — no solo donde se declara, cada IMPORT.
2. Para cada archivo que aparece, clasificarlo:
   - ¿Es un `Record<Tipo, X>` o un `switch` sin `default`? → el compilador lo va a forzar SOLO SI el tipo ya está ampliado cuando se compila ese archivo. Ampliar el tipo en un commit previo y separado (o al menos antes) para que el error de compilación salga temprano, no en un gate posterior.
   - ¿Es una agregación SQL (`FILTER`, `GROUP BY`, `CASE WHEN`) sobre la misma columna? → nada lo fuerza. Hay que leerlo a mano y decidir si el bucket/rama nuevo aplica.
   - ¿Es un espejo de tipo en OTRO repo, sin importar el original? → nada lo fuerza tampoco, y encima puede no tener ningún consumidor tipado que lo delate (`unknown` en el límite HTTP). Mismo criterio que `ROLES-CATALOG-DRIFT-001` — congelar el conjunto en un test si el archivo es crítico, o al menos anclarlo en pendientes si no.
3. **Grep aparte para cualquier método que se vaya a renombrar/ensanchar**: `grep -rn '<nombreViejo>'` sin filtrar por `*.ts` de código — incluye comentarios, `.md`, strings de test. Un comentario que cita el nombre viejo no rompe el build, así que sobrevive silencioso.
4. **Grep aparte para cualquier NÚMERO que dependa de un conteo que el cambio mueve** (`EXPECTED_*` de una cerca, un header "(N call-sites)", un total de un inventario generado) — y, ya que se está mirando esa cerca, chequear si el número que tenía ANTES de este cambio ya estaba stale por otro motivo (pasó dos veces en esta sesión: `EXPECTED_AUTHORIZE_CALL_SITES` tenía un comentario colgado de un bump anterior sin actualizar, y `CLAUDE.md` citaba "251" cuando la última medición real ya decía "253").

## Por qué esto no reemplaza al gate — lo complementa

Este playbook cierra el tipo de HOLD que es "auditoría incompleta" (mecánico, se puede hacer con grep). **No** cierra el tipo de HOLD que encontró Finding C (`CITY-LEDGER-AR-STAY-ADOPTION-RACE-001`) — un efecto de segundo orden entre dos mecanismos independientes, que solo aparece DESPUÉS de diseñar el primer fix y someterlo a lectura adversarial. Correr este playbook antes no hubiera encontrado Finding C; sí hubiera colapsado 2-3 rondas de "te faltó declarar X" en una sola.

## Alternativas descartadas

- **Confiar en que el compilador atrape todo:** falso para SQL, para espejos en otro repo, y para comentarios — el compilador solo ve TypeScript compilado, no prosa ni SQL embebido en template strings sin tipar.
- **Delegar el barrido al gate de cada ronda:** funciona (es lo que pasó acá), pero cuesta una ronda completa por cada consumidor no declarado — caro en tiempo de sesión, barato de evitar con un grep de 5 minutos antes de la primera línea de código.

## Tareas futuras

Aplicar este barrido la próxima vez que se amplíe `AccountsReceivableStatus` (o cualquier union compartido entre los dos repos), se renombre un método público de un repositorio, o se agregue una columna a una tabla que ya tiene un reporte agregado (`getReportByPeriod`-shaped) o un espejo de tipo en `appfrontend-main`.
