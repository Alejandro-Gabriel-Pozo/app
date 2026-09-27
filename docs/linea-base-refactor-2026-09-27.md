# Línea de base — Fase 0 del refactor incremental de arquitectura

**Fecha de medición:** 27/09/2026. **Commit medido:** `app-main` `c773625` (= `origin/main`,
`git ls-remote` confirmado). `appfrontend` `ec3783a` (= `origin/main`).

Fase 0 aprobada con condiciones por `architecture-governor` en la tercera ronda de gate sobre
`propuesta-refactor-incremental-arquitectonico-app-main-v3-2026-09-27.md` (repo raíz, commit
`a7d14d65bcfe0fa88` como agente). Condiciones cumplidas antes de esta medición: working tree
limpio (commits `c773625` y anteriores), commits pusheados a `origin/main` (ya no "solo local").

Este documento es de solo lectura — ningún archivo de `src/` se tocó al generarlo.

---

## 1. Estado del repo

| | app-main | appfrontend |
|---|---|---|
| `HEAD` | `c773625` | `ec3783a` |
| `origin/main` | `c773625` (igual) | `ec3783a` (igual) |
| `git status --short` | limpio | limpio |

---

## 2. Comandos y salida real

### `npx tsc --noEmit` (app-main)
Exit 0, sin salida.

### `npm run lint` (app-main)
`eslint src --ext .ts --max-warnings 0` — exit limpio, 0 warnings.

### `npm run lint:arch` (app-main)
```
✔ no dependency violations found (317 modules, 1590 dependencies cruised)
```
JSON completo (`--output-type json`) guardado en el scratchpad de la sesión —
962.702 bytes, 317 módulos. **Nota metodológica:** la cifra de "19 pares cíclicos de carpetas / 13
arcos entre dominios sin rutas, mayormente `type-only`" que citó `architecture-governor` en la
tercera ronda de gate viene de su propio análisis con `tsPreCompilationDeps: true` sobre el grafo
completo — un script propio corrido en esta sesión con un criterio más simple (contar
`dependencies[].circular` por archivo) dio 0, así que esa cifra no se re-derivó acá con la misma
metodología. Se cita como ya verificada por el gate, no re-medida en este documento.

### `npx vitest run` (app-main)
```
Test Files  187 passed | 1 skipped (188)
     Tests  2781 passed | 1 todo (2782)
  Duration  31.40s
```

### `npm run test:integration` (app-main)
**Corrección (27/09/2026, post-medición, verificado contra la API REST real de GitHub Actions):**
esta sección decía "no verificable en este sandbox" y dejaba pendiente confirmar CI real — ya se
confirmó, y el resultado es **rojo**, no "sin verificar". No es un problema del sandbox (sin
`TEST_DATABASE_URL` local — eso sigue siendo cierto para correrlo localmente), es un fallo real de
CI. **Precisión sobre desde cuándo:** el run inmediatamente anterior en `main`, `36289944518`
sobre `05542b5`, está en verde — `c773625` (run `36323873388`) es la primera corrida roja, y
también el primer commit que incluye `4eadded` (el commit que agregó el archivo de test que falla).
Los commits intermedios entre `05542b5` y `c773625` no tienen corrida de CI propia, así que no se
puede afirmar en qué commit exacto de ese rango empezó a fallar — solo que `c773625` ya estaba
roto.

Runs reales: `36323873388` sobre `c773625` y `36326751583` sobre `a7b6eb8` (este mismo commit de
línea de base), ambos con el job `integration` en `conclusion: failure` — el resto de los jobs
(`lint`, `typecheck`, `test`, `route-inventory-check`, `schema-version-check`) están en verde en
los dos. Log real del job de `a7b6eb8` (descargado vía la API, no una cita de segunda mano):

```
❯ src/tests/integration/reservation-auto-assign-all.integration.test.ts (5 tests | 5 failed)
Test Files  1 failed | 64 passed (65)
     Tests  5 failed | 491 passed (496)
Duration  49.58s
```

Un único archivo de test roto, 5/5 tests fallando con la misma aserción
(`AssertionError: expected +0 to be 1 // Object.is equality` sobre `occupancy.rows`, líneas 255,
298, 351, 410, 455 del archivo de test, confirmado contra el stack trace real del log) — el resto
de la suite de integración (491 tests, 64 archivos) pasa. **No es una pregunta abierta de negocio
(fix de test vs. fix de producción) — es un bug del fixture de test que rompe un contrato ya
decidido en un gate anterior** (`41b1ff9`, 25/09/2026, fijado por tests de regresión dedicados):
`docs/pendientes-2026-09-27.md` H12, `docs/diseno-occupancy-records-pending-assignment-2026-09-27.md`
(v2).

**Consecuencia para esta línea de base:** el resto de las cifras de este documento (tsc, lint,
lint:arch, vitest unitario, docs:routes, route-consumer-coverage, jscpd, build de frontend) no se
ven afectadas — son mediciones independientes de esta única falla, y todas dieron verde. Lo que
cambia es la fila de `test:integration`: no es una "red de seguridad sin confirmar todavía", es una
red de seguridad con un agujero conocido y acotado a un solo archivo, con causa raíz ya
identificada.

**Efecto de enmascaramiento, mientras este archivo siga rojo:** el job `integration` ya está en
`failure` — una regresión nueva en CUALQUIER OTRO archivo de integración no cambia el color del
job (ya era rojo). La red de seguridad real, mientras tanto, es el conteo por archivo del log
(`Test Files N failed | M passed`), no el `conclusion` del job — cualquiera que revise CI en este
período tiene que mirar el log, no solo el semáforo.

### `npm run docs:routes` (app-main)
```
Escribí 271 rutas en /home/user/app/docs/inventario-rutas.md
```
`git diff --exit-code docs/inventario-rutas.md` → exit 0 (sin diferencias, el archivo ya estaba
al día).

### `route-consumer-coverage.test.ts` (app-main, con `appfrontend` al lado)
```
✓ src/tests/architecture/route-consumer-coverage.test.ts (3 tests) 90ms
```
Corrió de verdad (no salteado) — 3/3.

### `npm run deadcode` (`knip`, app-main)
```
Unused devDependencies (2): jscpd, pino-pretty
Unlisted dependencies (1): puppeteer
Unused exports (27)
Unused exported types (24)
```
Sin sección "Unused files" — 0 archivos completos sin usar. Reporte completo guardado en el
scratchpad de la sesión (62 líneas).

### `npx jscpd src` (app-main) — dos corridas

| Parámetros | Clones | Líneas duplicadas | % |
|---|---|---|---|
| Default (sin flags) | 1307 | 13899 | 9.18% total, 9.59% TS |
| `--min-lines 8 --min-tokens 60` (mismos que `auditoria-modularidad.md`) | 652 | 9200 | 6.08% total, 6.36% TS |

**Hallazgo de esta medición, no un bug de metodología:** `auditoria-modularidad.md:87` citaba
**2.16%** (71 clones, 919 líneas) con estos mismos parámetros. La cifra real hoy es **6.08%** —
casi el triple. Mismo patrón que ya se encontró del lado frontend (7.71% citado vs. 9.41% real).
No se investigó la causa en este documento (¿crecimiento real de código desde esa auditoría, o el
runtime de `jscpd` cambió de versión?) — se registra como hallazgo a triagear, no como parte de la
Fase 0 en sí.

### Métricas de riesgo (app-main)

| Métrica | Valor medido | Comando |
|---|---|---|
| `reservation.service.ts` | 1957 líneas | `wc -l src/reservas/reservation.service.ts` |
| `products.routes.ts` | 840 líneas | `wc -l src/pos-menu/products.routes.ts` |
| `round2(` fuera de tests | 11 archivos, 58 ocurrencias | `grep -rln/-rn "round2(" src/ --include="*.ts" \| grep -v .test.ts` |
| `event.payload as` en workers | 11 | `grep -rn "event.payload as" src/workers/*.ts` |
| Archivos de inventario en `src/repositories/` | 16 (14 sin contar 2 `.test.ts`) | `ls src/repositories/ \| grep -iE "stock\|inventory\|recipe\|waste\|consumption"` |

**Nota:** el `round2` da 58 ocurrencias/11 archivos con este comando exacto — la cifra de "74" que
citaron rondas anteriores de gate puede venir de un patrón de búsqueda distinto (no re-conciliado
acá, se deja registrado el método usado esta vez).

### Frontend (`appfrontend`, `ec3783a`)

| Chequeo | Resultado |
|---|---|
| `npx tsc --noEmit` | Exit 0 |
| `npm run lint` | 0 errores, **4 warnings** (`check-visual-debt.mjs:70`, `categorias/page.tsx:107`, `ordenes/[id]/page.tsx:595`, `lib/http.ts:91`) |
| `npm run build` | **Exit 0 — corrido por primera vez en esta ronda** (las rondas de gate anteriores no lo habían corrido). Genera todas las rutas estáticas/dinámicas sin error. |

---

## 3. Qué NO se verificó en esta Fase 0 (declarado, no escondido)

- **`test:integration` de app-main contra Postgres real, localmente** — sin `TEST_DATABASE_URL` en
  este sandbox. **Actualización (27/09/2026, ver §2 arriba): sí se verificó vía CI real** — está
  roja, un solo archivo (`reservation-auto-assign-all.integration.test.ts`, 5/5 tests), causa raíz
  ya diagnosticada. Ya no es "sin confirmar", es un hallazgo confirmado y acotado.
- **Matriz completa de arcos cíclicos entre carpetas** (19 pares / 13 arcos) — citada como ya
  verificada por `architecture-governor` en la tercera ronda, no re-derivada acá con la misma
  metodología exacta.
- **`test:unit`/`test:visual`/`lint:visual` de `appfrontend`** — ya verificados en rondas de gate
  anteriores (39/39, 34/34, sin cambios), no se re-corrieron en esta sesión porque no cambiaron
  desde la última medición.

## 4. Conclusión de la Fase 0

Línea de base establecida sobre `c773625`/`ec3783a`, ambos en `origin/main`. **Corrección
27/09/2026:** la suite de integración de `app-main` no queda "sin verificar" — se confirmó rota en
CI real, en un único archivo con causa raíz ya identificada (ver §2/§3). Cualquier fase de
migración que dependa de la suite de integración como red de seguridad tiene ese agujero conocido y
acotado, no una incógnita — no bloquea usar el resto de la suite (491/496 tests) como red de
seguridad, pero sí bloquea confiar en la cobertura específica de "Auto Assign All" hasta que
`docs/diseno-occupancy-records-pending-assignment-2026-09-27.md` se resuelva. El resto de los
números está medido con comando real, sin estimaciones.
