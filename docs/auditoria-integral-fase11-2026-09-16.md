# Auditoría técnica integral — Fase 11: revisar dependencias y configuración

Fecha: 16/09/2026
Repos: `app-main` (backend, `/home/user/app`, HEAD `8a66788`) · `appfrontend-main`
(frontend, `/home/user/appfrontend`, HEAD `3bc77f5`)
Fase previa: `docs/auditoria-integral-fase10-2026-09-15.md`
Alcance: revisión específica de dependencias y configuración — dependencias directas y
transitivas, versiones fijadas, paquetes obsoletos, duplicados, sin uso y con
vulnerabilidades, scripts de instalación, configuración de compilación, variables de
entorno, valores por defecto, y configuración de desarrollo / pruebas / producción con sus
diferencias. **Cero cambios de código, de configuración y de dependencias** — fase de
análisis.

---

## 0. Método y criterio

### 0.1 Qué NO se re-deriva

Esta fase reusa como evidencia y le aplica el lente de dependencias/configuración:

- **F9-01** (Fase 9) — `next@16.3.1` en `appfrontend-main`, 2 advisories CRITICAL de RCE no
  autenticada, fix en `16.3.5` (no semver-major). No se re-deriva la vulnerabilidad. Lo que
  esta fase aporta es el ángulo de **versiones fijadas**: F9-01 ya identificó que el pin
  exacto (`"next": "16.3.1"`, sin `^`) es la causa de que `npm install` no la suba sola.
  Acá se mide **cuántos paquetes más están en esa misma situación** en los dos repos (ver
  0.4 y F11-08) y se confirma que el estado no cambió entre el 15/09 y el 16/09.
- **F9-13** (Fase 9, con la corrección del apéndice del gate) — `@xmldom/xmldom`: **8
  advisories, 6 HIGH**, de clase DoS-en-parseo además de inyección-en-serialización, en la
  cadena de AFIP. Se cita con ese número (8/6), no con el del cuerpo original. Re-medido hoy:
  sigue apareciendo con `severity: high` en `npm audit --omit=dev`, sin cambios.
- **F7-06** (Fase 7) — *"La configuración no tiene capa: 30 variables en 26 archivos, 11 sin
  declarar, un mismo knob resuelto de cinco formas y un literal triplicado"*. El **inventario**
  de variables de entorno y el hecho de que el backend no tenga `.env.example` ya están ahí,
  con el detalle completo. Esta fase **no repite el inventario**; aporta cuatro cosas que ese
  hallazgo no cubre, porque son de otro lente: qué le pasa al proceso cuando cada variable
  falta (F11-03), qué pasa cuando `NODE_ENV` interviene además en la **instalación** de
  dependencias (F11-01), qué endpoint vivo depende de una de las 11 no declaradas (F11-02) y
  qué runbook exige una que `render.yaml` no conoce (F11-11).
- **F9-14** (Fase 9) — `PLATFORM_ADMIN_PASSWORD` y el inventario de secretos `sync: false` de
  `render.yaml`. No se re-deriva. **Corrección de conteo, medida hoy:** los `sync: false`
  reales son **13**, no 14 — `render.yaml:50` es un comentario que contiene la cadena
  `sync: false` y se cuela en un `grep -c`. Las 17 claves del archivo son 4 con valor literal
  + 13 secretos.
- **F9-10 / Fase 10** — `db/pg.client.ts::sslConfig()` cae a `ssl: false` en silencio si falta
  `NEON_SSL`. No se re-deriva. Se cita en F11-18 solo para señalar que `NEON_SSL` **sí** está
  declarada en `render.yaml` (`:46`), o sea que el hueco es de defecto, no de declaración.
- **B-02 / B-04 / B-05** (Fase 1) — `tsconfig.json` excluye un archivo inexistente; el backend
  no tiene `.env.example`; `.MD` de 1 byte y `supabase/` como residuos de raíz. Re-verificados
  hoy (siguen exactos: el `exclude` apunta a `src/reservas/supabase.occupancy.repository.ts`,
  que no existe; `.MD` sigue con 1 byte; `find src -iname "*supabase*"` → 0 resultados). No se
  re-derivan; B-02 se extiende en F11-06 porque la misma clase de drift está también en
  `vitest.config.ts`, que esa revisión no miró.
- **`dependency-provenance` del `CLAUDE.md`** — que el build de Render corre `npm install` (no
  `npm ci`), que el `postinstall` de Puppeteer no se dispara con `node_modules` cacheado, que
  `@arcasdk/pdf` arrastra Chromium y que hay `patches/`. **Re-verificado hoy, sigue siendo
  así**, con estos números que el resumen no da: `puppeteer@25.8.0` forzado por `overrides`
  sobre un `@arcasdk/pdf@0.2.0` que declara `^24.43.1` (F11-04), un solo patch
  (`patches/@arcasdk+pdf+0.2.0.patch`, 4864 bytes, F11-09), y 652 MB de Chromium en
  `.cache/puppeteer` dentro del árbol del proyecto.

### 0.2 Qué se leyó completo (no en diagonal)

**Backend (`app-main`):** `package.json` (67 líneas), `package-lock.json` (739 entradas,
recorrido programáticamente entero, no leído a ojo), `render.yaml` (157, íntegro con sus
comentarios), `tsconfig.json`, `vitest.config.ts` (72), `vitest.integration.config.ts` (38),
`.github/workflows/ci.yml` (299, íntegro), `.github/workflows/pr-checklist.yml` (105),
`eslint.config.js`, `.dependency-cruiser.cjs` (§1-60 + reglas), `knip.json`,
`.puppeteerrc.cjs`, `.gitignore`, `.gitattributes`, `patches/@arcasdk+pdf+0.2.0.patch`,
`README.md` (íntegro), `docs/INCIDENT_LOG_2026-08-08.md` (§85-135), `src/config/plan-limits.ts`,
`src/server.ts` (91, íntegro), `src/container.ts` (§30-140), `src/db/pg.client.ts` (§1-130),
`src/platform/tenant.middleware.ts` (§40-120), `src/platform/tenant-db.setup.ts` (§22-130),
`src/platform/admin.routes.ts` (§45-100), `src/logger.ts` (§1-32),
`src/api/docs-exposure.ts` (íntegro), `src/app.ts` (§170-262),
`src/scripts/migrate-tenants.ts` (§1-60), y `node_modules/patch-package/dist/index.js`
(§86-100) + `dist/applyPatches.js` (§118-130, §300-352) para determinar el comportamiento real
del `postinstall`.

**Frontend (`appfrontend-main`):** `package.json`, `package-lock.json` (568 entradas,
recorrido programático), `.env.example` (íntegro), `next.config.js` (íntegro),
`tsconfig.json`, `vitest.config.mts`, `eslint.config.mjs`, `postcss.config.js`,
`tailwind.config.ts`, `.gitignore`, `.github/workflows/ci.yml` (íntegro),
`README.md` (íntegro), `ARCHITECTURE.md` (§23-80, §220-235), `src/lib/http.ts` (§1-60).

### 0.3 Entorno de verificación

**No se ejecutó nada contra producción, contra Render, contra Vercel ni contra Neon.** Todas
las mediciones corrieron en el sandbox de esta sesión: **Node v22.22.2, npm 10.9.7, Linux
x86-64**. Las consultas al registry (`npm outdated`, `npm audit`) son de solo lectura y no
escriben en el árbol.

Tres artefactos se crearon y se borraron dentro de esta fase, todos **fuera** del árbol de los
dos repos salvo uno, que está gitignoreado:

1. `<scratchpad>/instest/` — copia de `package.json` + `package-lock.json` del backend para
   simular `npm install --dry-run`. Borrado.
2. `<scratchpad>/minitest/` — proyecto mínimo de 1 dependencia + 1 devDependencia, para medir
   el comportamiento de `npm install` bajo `NODE_ENV=production` (F11-01). Borrado.
3. `/home/user/app/coverage/` — generado por `npm run test:coverage` (F11-06). Está en
   `.gitignore` (`coverage/`), o sea que nunca apareció en `git status`; igual **se borró** al
   terminar.

`git status` quedó en **0 archivos modificados y 0 sin seguimiento en los dos repos**,
verificado al cierre.

Una sola afirmación de este informe no es medición propia sino lectura del código de un
paquete de terceros, y se marca como tal: el criterio con el que `patch-package` decide salir
con error (`node_modules/patch-package/dist/index.js:91-94`). Se verificó además, contra
`node_modules/ci-info/vendors.json`, que Render figura como vendor reconocido (`{"name":
"Render","constant":"RENDER","env":"RENDER"}`), que es lo que hace que ese criterio se active
en un build de Render.

### 0.4 Mediciones reproducibles (comando y resultado, no estimación)

| Medición | Comando / procedimiento | Resultado |
|---|---|---|
| **Backend — dependencias directas** | `package.json` | **33** (14 `dependencies` + 19 `devDependencies`) |
| **Backend — árbol instalado (lockfile v3)** | recorrido de `packages` en `package-lock.json` | **738** entradas · **308** no-dev · **430** dev · **120** optional |
| **Frontend — dependencias directas** | `package.json` | **19** (6 `dependencies` + 13 `devDependencies`) |
| **Frontend — árbol instalado (lockfile v3)** | ídem | **568** entradas · **89** no-dev · **479** dev |
| **Backend — paquetes con >1 versión en el árbol** | agrupación por nombre sobre el lockfile | **31** |
| …de esos, en el árbol **de producción** | mismo script filtrando `dev != true` | **14** (`yargs` 15.4.1+18.1.0, `string-width` ×3, `debug` 2.6.9+4.4.3, `ms`, `pako`, `cliui`, `emoji-regex`, `ansi-*`, `y18n`, `yargs-parser`, `real-require`, `wrap-ansi`) |
| **Frontend — paquetes con >1 versión** | ídem | **18** en total · **0** en el árbol de producción |
| `zod` duplicado (backend) | ídem | **3.25.76** (raíz, prod) + **4.4.3** (bajo `knip`, dev). Sin cruce entre los dos |
| **Backend — `npm outdated`** | `npm outdated --json` | **20 de 33** desactualizados · **9** con major disponible · **11** solo minor/patch |
| **Frontend — `npm outdated`** | ídem | **16 de 19** desactualizados · **5** con major disponible |
| **Backend — `npm audit --omit=dev`** | `npm audit --omit=dev --json` | **4 total: 1 high, 3 moderate** — sin cambios respecto de Fase 9 |
| …detalle nuevo que Fase 9 no desglosó | misma salida | `@xmldom/xmldom` **high** (8 advisories, 6 HIGH — F9-13) · `express` + `body-parser` + `qs` **moderate**, los tres `fixAvailable: true` (no-major) |
| **Backend — `npm audit` (con dev)** | `npm audit --json` | **11 total: 2 high, 9 moderate** — sin cambios respecto de Fase 9 |
| **Frontend — `npm audit --omit=dev`** | ídem | **3 total: 1 critical, 1 high, 1 moderate** (`next` critical → fix `16.3.5` no-major · `sharp` high · `qs` moderate) |
| `qs` instalado (backend) | lockfile | **6.15.3**, una sola copia, no-dev |
| `express` instalado vs disponible | `npm outdated` | **4.22.2** instalado · **4.22.3** disponible **dentro del rango `^4.21.0` ya declarado** |
| **`npm install` bajo `NODE_ENV=production` omite devDependencies** | `NODE_ENV=production npm config get omit` | **`dev`** |
| …efecto real, medido | proyecto mínimo (1 dep + 1 devDep), `NODE_ENV=production npm install` | instala **solo** la dependencia de producción; la devDependencia **no** se instala |
| …sobre un `node_modules` que YA la tenía | `npm install` normal → luego `NODE_ENV=production npm install` | npm reporta `up to date` y **borra** la devDependencia del árbol |
| **`render.yaml` — claves declaradas** | `grep -c '^      - key:'` | **17** — 4 con valor literal, **13** con `sync: false` (el 14.º "sync: false" del archivo es el comentario de `:50`) |
| **Nombres `process.env.*` leídos en el backend** | `grep -rhoE "process\.env(\.\w+|\['...'\])" src --include=*.ts` | **32** nombres distintos (incluye los de tests y scripts) |
| Leídos en código productivo y **no** declarados en `render.yaml` | cruce manual de las dos listas | **10**: `JWT_EXPIRES_IN`, `DB_ENCRYPTION_KEY_OLD`, `DATABASE_URL`, `MAX_TENANT_POOLS`, `LOG_LEVEL`, `HEALTH_DB_TTL_MS`, `HEALTH_DB_FAIL_TTL_MS`, `DB_POOL_MAX`, `DB_POOL_IDLE_MS`, `PORT` |
| Declarados en `render.yaml` y no leídos por el código | ídem | **1**: `NODE_VERSION` (la usa Render, correcto) |
| **Nombres `process.env.*` leídos en el frontend** | `grep -rn` sobre `src/`, `scripts/`, `next.config.js` | **3**: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, `NODE_ENV` |
| **Backend — cobertura real** | `npm run test:coverage`, totales recalculados desde `coverage/lcov.info` | **lines 77,68 % (19 841/25 541) · functions 78,30 % · branches 83,70 %** |
| …umbral configurado | `vitest.config.ts:65-68` | lines **60** · functions **60** · branches **50** · statements **60** |
| …margen silencioso | resta | **≈ 17,7 puntos** de caída posible sin que CI se entere |
| Archivos medidos vs. archivos no-test | `SF:` de `lcov.info` contra `find src -name '*.ts' ! -name '*.test.ts'` | **273 de 290** — 17 excluidos |
| Rutas del `coverage.exclude` que **no existen** en el árbol | verificación una por una | **8** (`src/schemas`, `src/seed`, `src/repositories/supabase.occupancy.repository.ts`, `customer.repository.ts`, `occupancy.repository.ts`, `reservation.repository.ts`, `resource.repository.ts`, `sql.customer.repository.ts`) |
| Archivos con test propio **excluidos** de la medición | cruce `exclude` × `*.test.ts` | **2** (`src/services/report.service.ts` ← `report.service.test.ts`; `src/db/health-cache.ts` ← `health-cache.test.ts`) |
| **Frontend — tests** | `npm run test:unit` | **2 archivos, 25 tests, 907 ms**, sobre **131** archivos `.ts`/`.tsx`. Sin configuración de cobertura ni umbral |
| **Backend — archivos linteados por ESLint** | `npx eslint src --ext .ts -f json`, conteo de entradas | **511 de 511** `.ts` de `src/` (el `--ext` del script es inocuo en flat config: no recorta el set) |
| `npm run lint` (backend) | `eslint src --ext .ts --max-warnings 0` | **exit 0**, 0 warnings |
| **Backend — devDependencies sin uso según knip** | `npx knip --no-progress` | **2**: `jscpd`, `pino-pretty` — `pino-pretty` es falso positivo (se resuelve por nombre en `logger.ts:28`, no por `import`) |
| **Backend — dependencias no declaradas según knip** | ídem | **1**: `puppeteer` (usado por `.puppeteerrc.cjs:11` y por el `buildCommand`, presente solo como transitiva) |
| **Frontend — devDependencies sin referencia alguna** | `grep` de cada nombre en `src/`, `scripts/`, configs, `.github/` | **3**: `dependency-cruiser`, `jscpd`, `ts-prune` — sin archivo de config, sin script de npm, sin job de CI |
| `puppeteer` — rango declarado por su consumidor vs. instalado | `node_modules/@arcasdk/pdf/package.json` | declara **`^24.43.1`** · instalado **25.8.0**, forzado por `overrides` de la raíz |
| Tamaño de `node_modules` (backend / frontend) | `du -sh` | **391 MB** / **552 MB** |
| `typescript` en el árbol de producción del backend | `du -sh node_modules/typescript` | **23 MB**, 0 `import` en `src/` |
| Caché de Chromium dentro del proyecto | `du -sh .cache` | **652 MB** (`chrome` + `chrome-headless-shell`, linux-152.0.7977.42) |
| **PostgreSQL: CI vs. producción documentada** | `.github/workflows/ci.yml:284` vs `docs/INCIDENT_LOG_2026-08-08.md:45-46` | CI **postgres:16-alpine** · producción documentada **PG 18** (plataforma) / **PG 17** (tenants), con el mismatch declarado abierto en `:52` y `:121` |
| **Node: declarado vs. CI vs. deploy** | `package.json:engines` · `ci.yml` · `render.yaml:39-40` | Backend: `>=22.12.0 <23.0.0` / `'22'` / `NODE_VERSION: "22"` → **alineado**. Frontend: **sin `engines`, sin `.nvmrc`** / `'24'` literal en 3 jobs / Vercel Dashboard (fuera del repo) |
| `pino` sin `pino-pretty` disponible | `pino({transport:{target:'<inexistente>'}})` en Node 22 | **lanza sincrónicamente**: `Error: unable to determine transport target for "..."` |
| `patch-package` ante mismatch de versión **que igual aplica** | `dist/applyPatches.js:327-352` | **solo warning** (*"Don't worry! This is probably fine"*) |
| `patch-package` ante patch que **no** aplica, en Render | `dist/index.js:91-94` + `ci-info/vendors.json` (Render presente) | **`process.exit(1)`** → el build falla. Fail-loud, correcto |
| Commits vs. merges del backend (60 días) | `git log --oneline --since='60 days ago'` y `--merges` | **956** commits · **28** merges (≈ **3 %** de los cambios pasa por PR) |
| Trazabilidad de `typescript` en `dependencies` | `git log -p -- package.json` | movido de `devDependencies` a `dependencies` el 23/06/2026, commit **`df47067`** *"Fix Render deploy: compile TypeScript before start"* — cuando `start` era `npm run build && node dist/server.js` |
| `npm start` hoy | `package.json:10` | `node dist/server.js` — no compila (el rebuild se sacó en `b2b01ed`, 19/08/2026, *"causaba OOM en Render"*) |
| Archivos `.sql` en `src/db/` vs. copiados al build | `ls src/db/*.sql` vs `package.json:11` | **5** existen · **2** se copian (`schema.sql`, `platform.schema.sql`) · **2** son los únicos leídos en runtime (`tenant-db.setup.ts:57`, `server.ts:39`) → correcto, pero por lista a mano |
| Secretos hardcodeados en configs y scripts | `grep -rEi "(password|secret|api[_-]?key|token)\s*[:=]\s*['\"][A-Za-z0-9_\-]{8,}"` sobre `render.yaml`, `package.json`, `.github/`, `src/scripts/`, `src/config/`, `next.config.js` | **0** en los dos repos |
| URLs de producción hardcodeadas en código | `grep -rn "onrender.com\|vercel.app"` sobre `src/` de los dos repos | **2**: `app-main/src/openapi/spec.ts:26` (`servers[0]`) y `appfrontend-main/src/app/admin/page.tsx:87` (texto de la UI) |

---

## 1. El checklist del protocolo, respondido primero

Va antes de los hallazgos a propósito: siete de las respuestas son "verificado limpio" y
acotan el alcance real de lo que sigue.

| Ítem del protocolo | Estado | Evidencia |
|---|---|---|
| **Dependencias directas** | **Pocas y justificadas en el backend; el frontend tiene 3 devDeps fósiles** | 14 prod + 19 dev (backend) · 6 prod + 13 dev (frontend). Todas las de producción del backend tienen `import` real salvo `typescript` (**F11-15**). Frontend: **F11-16** |
| **Dependencias transitivas** | **738 / 568 instaladas; el ratio prod/dev del backend lo domina una sola dependencia** | 308 de las 738 del backend son del árbol de producción, y la cadena de descarga de Chromium aporta la mayoría de los duplicados de ese árbol (**F11-21**) |
| **Versiones fijadas** | **Dos políticas opuestas entre repos, ninguna declarada** | Backend: **0 de 33** con versión exacta — todo `^`. Frontend: **6 de 19** exactas (`next`, `react`, `react-dom`, `eslint-config-next`, `@types/react`, `@types/react-dom`) + 2 `overrides` de tipos. F9-01 ya midió el costo de esa elección en `next`; **F11-08** mide el costo de la contraria en `express` |
| **Paquetes obsoletos** | **20 de 33 (backend) y 16 de 19 (frontend)** | La mayoría es ruido de minor/patch. Los que importan: `express` 4.22.2→4.22.3 (cierra 2 advisories, **F11-08**), `next` 16.3.1→16.3.5 (F9-01), `@arcasdk/pdf` 0.2.0→0.2.1 (**F11-09**, choca con el patch), `@types/node ^20` contra Node 24 (**F11-12**) |
| **Paquetes duplicados** | **14 en el árbol de producción del backend, 0 en el del frontend** | **F11-21**. Ninguno es un duplicado de una dependencia de negocio: son utilidades de CLI (`yargs` 15 y 18, `string-width` ×3) que entran por la cadena de descarga de Chromium |
| **Paquetes sin uso** | **1 en el backend, 3 en el frontend** | Backend: `jscpd` instalado sin script ni job (**F11-17**); `pino-pretty` es falso positivo de knip y está correctamente en `devDependencies`. Frontend: `dependency-cruiser`, `jscpd`, `ts-prune` (**F11-16**) |
| **Paquetes con vulnerabilidades** | **Sin cambios respecto de Fase 9; un detalle nuevo** | 4/11 (backend, sin dev/con dev) y 3/4 (frontend). Lo nuevo: los 3 moderate de `express`/`body-parser`/`qs` tienen fix **dentro del rango ya declarado** (**F11-08**) |
| **Scripts de instalación** | **Uno solo (`postinstall: patch-package`) y es correcto en su política de fallo; su precondición no está garantizada** | Falla ruidosa en Render (verificado vía `ci-info`), pero depende de que `patch-package` —una devDependency— esté instalada (**F11-01**) y de que el patch siga matcheando la versión (**F11-09**) |
| **Configuración de compilación** | **Correcta y explícita; con una lista a mano sin cerca** | `build` = `rm -rf dist && tsc && cp` de los 2 `.sql` que el runtime lee. Los 2 son exactamente los 2 que se leen — verificado. Pero es una lista manual (**F11-19**). Frontend: `next build` sin `ignoreBuildErrors` ni `eslint.ignoreDuringBuilds` — **verificado limpio** |
| **Variables de entorno** | **Inventariadas en F7-06; acá se auditó el comportamiento ante ausencia** | 10 leídas en producción y no declaradas. **F11-02** (una con endpoint vivo), **F11-03** (una cuya ausencia no falla), **F11-11** (una que un runbook exige) |
| **Valores por defecto** | **Casi todos razonables; dos con radio de daño** | `MAX_TENANT_POOLS ?? '200'` × `max: 5` por pool = techo teórico de 1000 conexiones (**F11-18**); `CORS_ORIGIN ?? (NODE_ENV==='production' ? false : '*')` depende de que `NODE_ENV` llegue (**F11-01**, mitad de seguridad ya tratada en Fase 9) |
| **Configuración de desarrollo** | **No es reproducible desde el repo en el backend** | No hay `.env.example`; el `README.md` documenta un arranque (`npm install && npm run dev`) que no puede funcionar y describe una app que ya no existe (**F11-10**) |
| **Configuración de pruebas** | **Dos configs bien separadas y bien documentadas; el umbral no mide nada** | La separación `vitest.config.ts` / `vitest.integration.config.ts` está razonada en su propio docblock y es correcta. Pero el piso de cobertura quedó 17,7 puntos por debajo del real y 8 de sus exclusiones apuntan a archivos inexistentes (**F11-06**) |
| **Configuración de producción** | **`render.yaml` es el mejor artefacto de configuración de los dos repos; el frontend no tiene equivalente** | Cada variable de `render.yaml` lleva fecha, motivo y qué rompe si falta. El frontend **no tiene `vercel.json`**: su configuración de deploy vive entera en un dashboard (**F11-12**) |
| **Diferencias entre entornos** | **Cinco, todas medibles dentro del repo** | Node 22 vs 24 (**F11-12**), `npm install` vs `npm ci` (**F11-13**), PG 16 vs PG 17/18 (**F11-07**), vitest 3 vs 4 (**F11-14**), y el build sin `NEXT_PUBLIC_API_URL` en CI vs. con él en Vercel (**F11-05**) |
| *Funciona solamente en una máquina* | **Sí, el backend** | Sin `.env.example`, con el README describiendo otra aplicación, y con 10 variables cuyo único inventario es leer el código: no hay camino desde el repo a un backend que arranque (**F11-10**) |
| *Depende de un archivo local no documentado* | **No encontrado como archivo; sí como estado** | No hay ningún `require`/`readFile` de un path absoluto ni de un archivo fuera del repo. Lo que sí hay es dependencia de **estado** del entorno de build: `.cache/puppeteer` (652 MB) y la propiedad no declarada de F11-01 |
| *Versión distinta en desarrollo y producción* | **Sí, cuatro casos** | F11-07 (PostgreSQL), F11-12 (Node en el frontend), F11-13 (resolución de dependencias), F11-14 (vitest entre repos) |
| *La configuración se duplica* | **Sí, y una de las copias miente** | El número de Node vive en 4 lugares del backend (coherentes) y en 3 literales `'24'` del CI del frontend sin fuente (**F11-12**). La URL del backend vive en `.env.example`, en un literal de la UI (`admin/page.tsx:87`) y en `spec.ts:26`. El README y el `ARCHITECTURE.md` del frontend contradicen al `.env.example` del mismo repo (**F11-05**, **F11-22**) |
| *Valores sensibles hardcodeados* | **Verificado limpio** | 0 coincidencias del grep de credenciales en configs y scripts de los dos repos. Los 4 valores literales de `render.yaml` son no-secretos y están justificados en comentario (`NODE_ENV`, `NODE_VERSION`, `NEON_SSL`, `NEON_PROJECT_ID`) |
| *Una variable ausente provoca comportamiento silenciosamente incorrecto* | **Sí, tres casos confirmados** | **F11-03** (`PLATFORM_DATABASE_URL` ausente → `pg` cae a los defaults del entorno), **F11-01** (`NODE_ENV` presente donde no se lo espera → se borran devDependencies; ausente donde sí → crash de `logger.ts` y CORS `*`), **F11-02** (`DATABASE_URL` seteada con el valor equivocado → schema de tenant sobre la BD de plataforma) |
| *Un paquete se usa para algo que el proyecto ya puede hacer* | **No encontrado** | Se revisaron las 14 dependencias de producción del backend y las 6 del frontend una por una. Ninguna reimplementa algo que el stack ya trae. `luxon` sobre `Intl` es una decisión defendible y consistente; `zod` es el borde de validación del repo entero (45 archivos) |
| *Dependencias que introducen complejidad innecesaria* | **Una candidata, cuantificada; la decisión no es de esta fase** | `@arcasdk/pdf` → Chromium: 652 MB de caché, 14 de los 14 duplicados del árbol de producción, 1 patch a mano, 1 `overrides` fuera de rango y 1 paso extra en el `buildCommand`, todo para renderizar el PDF de un comprobante. **F11-04** documenta el costo; **no** propone quitarlo — es una decisión de producto |

---

## 2. Hallazgos

### F11-01 — Tres pasos del build de producción dependen de que el `NODE_ENV=production` que `render.yaml` declara NO llegue al `npm install`

**Hallazgo:** `render.yaml:37-38` declara `NODE_ENV: production` como variable del servicio.
El `buildCommand` (`render.yaml:33`) es
`npm install && npx puppeteer browsers install chrome && npm run build && npm run migrate:tenants`.
Se midió que **npm omite las `devDependencies` cuando `NODE_ENV=production`** — y que además
las **borra** de un `node_modules` cacheado que ya las tenía. De los cuatro pasos del
`buildCommand`, **dos dependen de una devDependency**:

- el `postinstall` del propio `npm install` es `patch-package` (`package.json:8`), y
  `patch-package` está en `devDependencies` (`:42`);
- `npm run migrate:tenants` es `tsx src/scripts/migrate-tenants.ts` (`:16`), y `tsx` está en
  `devDependencies` (`:44`).

Los otros dos sobreviven: `puppeteer` es transitiva de producción, y `tsc` funciona porque
`typescript` está —de forma anómala— en `dependencies` (`:61`). Esa anomalía **es el fósil de
este mismo problema**: `git log -p` muestra que se movió ahí el 23/06/2026 en el commit
`df47067`, titulado *"Fix Render deploy: compile TypeScript before start"*, cuando `start`
todavía era `npm run build && node dist/server.js`.

O sea: **el build actual solo funciona si el shell del build NO ve la variable que el propio
`render.yaml` declara.** Esa propiedad no está escrita en ningún lado, no la verifica nada, y
nadie la eligió — es el residuo de una historia de tres commits.

El mismo acoplamiento tiene un **espejo en la dirección opuesta**, medido: `logger.ts:25-31`
carga el transporte `pino-pretty` siempre que `NODE_ENV !== 'production'`, y `pino-pretty` es
una `devDependency` (`:43`). Se verificó que `pino` **lanza sincrónicamente** cuando no puede
resolver el target (`Error: unable to determine transport target for "..."`). Como `logger.ts`
lo importa prácticamente todo el proceso, un entorno con `NODE_ENV` sin definir y
`node_modules` instalado sin dev **no arranca**.

**Evidencia:**
- `render.yaml:33` (`buildCommand`), `:37-38` (`NODE_ENV: production`), `:39-40`
  (`NODE_VERSION: "22"`).
- `package.json:8` (`postinstall: patch-package`), `:16` (`migrate:tenants` → `tsx`), `:42`
  (`patch-package` en dev), `:44` (`tsx` en dev), `:43` (`pino-pretty` en dev), `:61`
  (`typescript` en **dependencies**), `:10` (`start: node dist/server.js` — ya no compila).
- `NODE_ENV=production npm config get omit` → **`dev`** (npm 10.9.7).
- Proyecto mínimo en el scratchpad (borrado), `{dependencies:{ms},devDependencies:{semver}}`:
  - `NODE_ENV=production npm install` → `added 1 package`; `node_modules/ms` **SÍ**,
    `node_modules/semver` **NO**.
  - `npm install` normal (los dos presentes) seguido de `NODE_ENV=production npm install` →
    npm reporta `up to date` y `node_modules/semver` **desaparece**. El caché de
    `node_modules` entre builds que `render.yaml:23-24` documenta **no protege** de esto.
- `git log -p -- package.json` → `df47067` (23/06/2026) mueve `typescript` a `dependencies`;
  `b2b01ed` (19/08/2026) saca el rebuild de `npm start`.
- `pino({level:'debug',transport:{target:'pino-pretty-que-no-existe',options:{}}})` en Node
  22.22.2 → `LANZA SINCRONO: Error | unable to determine transport target for ...`.
- `node_modules/ci-info/vendors.json` incluye `{"name":"Render","constant":"RENDER","env":"RENDER"}`
  — dato que confirma que el build de Render **sí** tiene variables de entorno propias, aunque
  no dice nada sobre las declaradas por el usuario.

**Impacto:** si en algún momento el shell del build pasa a ver `NODE_ENV=production` —por un
cambio de Render, por mover el paso a `preDeployCommand` al pasar a plan pago (algo que
`render.yaml:8-16` ya contempla como opción), o porque alguien declare la variable en un
"build environment" aparte— el `npm install` falla en el `postinstall` con
`patch-package: not found`, antes siquiera de llegar a `tsc`. Por el fail-loud que
`render.yaml:18-21` describe, el deploy no se promueve y producción sigue sirviendo la versión
anterior: es un **deploy trabado**, no una caída. El costo real es de diagnóstico: el síntoma
(`sh: 1: patch-package: not found`) no se parece en nada a la causa (una variable de entorno
que siempre estuvo declarada).

**Causa probable:** acumulación histórica. `NODE_ENV=production` se declaró para el runtime
(logs JSON, docs cerradas, cookie `secure`, CORS cerrado) sin considerar que npm lo lee como
un flag de instalación. `typescript` se movió a `dependencies` para resolver el síntoma de ese
choque en su forma de 2026-06, y nadie volvió a mirar la clase completa cuando el build cambió
de forma dos veces más.

**Nivel de certeza:** **Alta** para las tres mediciones (omisión, prune, crash de pino) y para
la composición del `buildCommand`. **`No confirmado.`** cuál de las dos ramas es la verdadera
hoy en Render.
`Información faltante:` la salida real de `npm install` en el log de build del último deploy —
concretamente si dice `added 738 packages` (dev incluidas) o un número cercano a 308, y si el
paso `migrate:tenants` produce salida.
`Cómo verificarlo:` abrir el log del último deploy en el dashboard de Render y leer esas dos
líneas. Es lectura pura, no toca nada.

**Severidad:** **Alta** (deploy trabado, diagnóstico caro, supuesto no declarado bajo tres
pasos del pipeline).

**Recomendación (análisis, no ejecución):** hay tres caminos, y la elección es del dueño.
(a) Hacer el supuesto explícito y verificable: `npm install --include=dev` en el
`buildCommand`, que es correcto en las dos ramas y no cambia nada si la rama actual es la
benigna. (b) Sacar del build todo lo que dependa de devDependencies: mover `patch-package` y
`tsx` a `dependencies` — honesto respecto de que **son** dependencias de producción de este
pipeline, y consistente con lo que ya se hizo con `typescript`. (c) Dejar de usar `tsx` para
`migrate:tenants` y correr el script ya compilado desde `dist/`. En cualquiera de las tres,
`typescript` debería volver a `devDependencies` (ver F11-15), pero **no antes** de resolver
esto: hoy es lo único que sostiene el `tsc` del build si la rama mala resulta ser la verdadera.

**¿Requiere modificar código?:** No en `src/`. Sí en `render.yaml` y/o `package.json`. Fuera
del alcance de esta fase.

**Prueba necesaria:** un deploy de prueba que imprima `npm ls tsx patch-package --depth=0`
inmediatamente después del `npm install`, antes de cualquier otro paso.

---

### F11-02 — Un endpoint de superadmin vivo depende de `DATABASE_URL`, variable que `render.yaml` no declara y que el propio checklist pre-deploy del repo prohíbe; si alguien la setea con el valor "natural", aplica el schema de tenant sobre la BD de plataforma

**Hallazgo:** `POST /api/admin/repair-tenant-db` (`src/platform/admin.routes.ts:67`) lee
`process.env.DATABASE_URL`, y con ese valor ejecuta
`applyTenantSchema(databaseUrl)` → `encryptConnectionString` → `activateBusiness` →
`updateSchemaVersion` → `evictTenantPool`. Es decir: **aplica `src/db/schema.sql` (el schema
de tenant, 4302 líneas) contra la base que apunte `DATABASE_URL`, y deja un negocio apuntado
ahí**.

`DATABASE_URL` no está en las 17 claves de `render.yaml`. Con lo cual, hoy, el endpoint
responde `500 MISSING_DATABASE_URL` (`:70-75`) — está **muerto en producción**.

El problema no es que esté muerto, es qué pasa cuando alguien lo revive. `DATABASE_URL` es el
nombre genérico por excelencia; un operador que quiera "arreglar" ese 500 va a poner en el
dashboard la única connection string que tiene a mano, que es la de plataforma. En ese momento
el endpoint queda armado para aplicar el schema **de tenant** sobre la base **de plataforma** y
apuntar un negocio a ella. Su propio comentario (`:60-63`) todavía describe el mundo
mono-base de antes: *"Apunta el negocio indicado a la misma DATABASE_URL que ya usa el
proceso"* — un mundo donde había una sola base y esa frase tenía sentido. Hoy el proceso no
usa ninguna `DATABASE_URL`.

Y el repo ya escribió la regla que esto viola. `docs/INCIDENT_LOG_2026-08-08.md:119`, en el
"Checklist Pre-Deploy (agregar al proceso)": *"[ ] No existe ninguna variable `DATABASE_URL`
genérica sin prefijo en el código o en Render"*. Existe, en el código, en un handler de
superadmin.

**Evidencia:**
- `src/platform/admin.routes.ts:67` (`const databaseUrl = process.env.DATABASE_URL;`),
  `:70-75` (el 500), `:95-99` (la secuencia de 5 pasos), `:60-63` (el comentario obsoleto).
- `render.yaml`: `grep -n DATABASE_URL` → solo `PLATFORM_DATABASE_URL` (`:57-58`). No hay
  `DATABASE_URL`.
- `docs/INCIDENT_LOG_2026-08-08.md:119` — la regla, escrita como ítem de checklist activo.
- La otra lectura de `DATABASE_URL` en producción es `src/db/pg.client.ts:82`, el pool legado,
  que no tiene caller productivo (ver F11-18).
- El endpoint está detrás de `authenticatePlatform() + authorizePlatform([SUPERADMIN])`
  (`:57`) — la superficie es de superadmin, no pública.
- Fase 7 (**F7-05**) ya catalogó este handler como una de las 4 copias de la saga de
  aprovisionamiento; lo que no miró es de qué variable de entorno depende.

**Impacto:** el radio no es el endpoint sino la base de plataforma. Aplicar `schema.sql` de
tenant sobre ella crearía 51 tablas de tenant convivientes con las 24 de plataforma, y —por lo
que Fase 10 midió en **F10-01**— lo haría dentro de una transacción implícita única que
sostiene `AccessExclusiveLock`. Después, `activateBusiness` dejaría un negocio con su
`db_url_encrypted` apuntando a la base central: todo el tráfico de ese tenant pasaría a
escribir en la BD de plataforma. Es reversible en teoría y muy caro en la práctica.

**Causa probable:** el endpoint es anterior al modelo una-BD-por-negocio y nunca se re-evaluó
al migrar. La variable dejó de declararse (correctamente), lo que apagó el endpoint, pero el
código quedó como una trampa armada esperando que alguien "complete la configuración que
falta".

**Nivel de certeza:** **Alta** para todo lo verificable en el repo (la lectura, el 500, la
secuencia, la ausencia en `render.yaml`, la regla del incident log).
**`No confirmado.`** si `DATABASE_URL` está o no seteada hoy en el dashboard de Render.
`Información faltante:` la lista de variables del servicio en Render.
`Cómo verificarlo:` mirarla en el dashboard, o pegarle al endpoint con credenciales de
superadmin en un entorno no productivo y ver si responde `500 MISSING_DATABASE_URL`.

**Severidad:** **Alta.**

**Recomendación (análisis, no ejecución):** dos opciones, sin elegir por el dueño.
(a) Retirar el endpoint: `set-tenant-url` (la ruta hermana, `:143-147`) hace lo mismo
recibiendo la URL explícita en el body, que es lo correcto en un modelo multi-tenant —
`repair-tenant-db` sería entonces código muerto con radio de daño, misma clase que F10-05.
(b) Si se quiere conservar la ergonomía de "reparar sin escribir la URL", cambiar el nombre de
la variable a algo que no se pueda confundir (`REPAIR_FALLBACK_TENANT_DATABASE_URL`),
declararla en `render.yaml` con su comentario, y agregar una guarda que rechace si el valor
coincide con `PLATFORM_DATABASE_URL`. En cualquiera de las dos, el ítem del checklist del
incident log queda cumplido o explícitamente derogado.

**¿Requiere modificar código?:** Sí. Fuera del alcance de esta fase.

**Prueba necesaria:** de integración: con `DATABASE_URL` = la URL de plataforma, el endpoint
debe rechazar antes de tocar nada. Hoy no existe ninguna prueba de ese camino
(`admin.routes.test.ts:49` setea `DATABASE_URL = 'postgresql://legacy/db'` y prueba el camino
feliz).

---

### F11-03 — `server.ts` crea el pool de migración de plataforma sin verificar `PLATFORM_DATABASE_URL`: si falta, `pg` cae a los defaults del entorno en vez de fallar

**Hallazgo:** `src/server.ts:44` construye el pool con el que aplica `platform.schema.sql` en
cada arranque:

```
const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL,
  ssl: sslConfig(),
});
```

No hay chequeo previo. El driver `pg` trata `connectionString: undefined` como "sin
connection string" y resuelve host, puerto, usuario y base desde `PGHOST`/`PGUSER`/`PGDATABASE`
o, en su ausencia, desde sus defaults (`localhost:5432`, usuario del sistema operativo, base
con el nombre del usuario). Es decir: **con la variable ausente, el proceso no falla — se
conecta a otra base y le aplica el schema de plataforma.**

El repo **sí** tiene el chequeo, dos veces, pero en el lugar equivocado del orden de ejecución:
`container.ts:43-49` y `:122-127` lanzan un `Error` explícito con instrucciones
(*"Configurá la variable de entorno en Render Dashboard"*). Los dos corren dentro de
`createApp()`, que `server.ts:65` invoca **después** del bloque de migración.

**Evidencia:**
- `src/server.ts:31-59` — el bloque completo: `readFile(platform.schema.sql)` → `new Pool({...})`
  → `pool.query(sql)` → `pool.end()`, con `try/catch` que loguea y `process.exit(1)`.
  El `catch` atrapa el fallo de conexión, pero solo si la conexión **falla**.
- `src/server.ts:44` — `connectionString: process.env.PLATFORM_DATABASE_URL`, sin guarda.
- `src/container.ts:43-49` y `:122-127` — las dos guardas que sí existen, y que corren después.
- `src/server.ts:65` — `const { app } = await createApp();`, posterior al bloque.
- Contraste dentro del mismo archivo: `PORT` sí tiene default explícito (`:31`,
  `parseInt(process.env.PORT ?? '3000', 10)`).

**Impacto:** en producción el resultado es benigno y ruidoso: no hay postgres en `localhost`,
la conexión falla, el `catch` loguea, `Sentry.captureException` reporta y el proceso sale con
1. En una máquina de desarrollo **con un postgres local corriendo** —que es el caso normal de
quien trabaja en este repo— el resultado es silencioso y equivocado: `npm run dev` sin `.env`
aplica `platform.schema.sql` (24 tablas, 57 índices) sobre la base por defecto del
desarrollador. Se combina mal con F11-10: como no hay `.env.example`, "correr sin `.env`" no es
un descuido exótico, es el estado inicial de cualquiera que clone el repo.

**Causa probable:** el bloque de migración se escribió antes que las guardas de `container.ts`
y nunca se alineó con ellas. Es el mismo patrón que Fase 7 describe como "configuración leída
en el punto de uso, sin capa": tres archivos leen la misma variable y solo dos la validan.

**Nivel de certeza:** **Alta** para el código y el orden de ejecución (lectura directa).
**Alta** también para el comportamiento de `pg` ante `connectionString: undefined`, que es su
contrato documentado y el que hace funcionar `checkDatabaseHealth()` en los tests. No se
reprodujo el escenario completo (levantar el server sin la variable contra un postgres local)
porque implicaba escribir un schema en una base, y esta fase no escribe.

**Severidad:** **Alta** (por el radio en desarrollo y por ser el primer paso del arranque; el
camino de producción es correcto por accidente, no por diseño).

**Recomendación (análisis, no ejecución):** subir la guarda que ya existe en `container.ts` a
antes del bloque de migración de `server.ts`, o —mejor, y alineado con lo que F7-06 pide— un
único punto de validación de entorno que corra primero y liste **todas** las variables
obligatorias faltantes de una vez, en vez de fallar de a una. Es la contraparte de F11-10: el
mismo módulo que valida puede generar el `.env.example`.

**¿Requiere modificar código?:** Sí. Fuera del alcance de esta fase.

**Prueba necesaria:** unitaria — `main()` con `delete process.env.PLATFORM_DATABASE_URL` debe
salir con un error nombrando la variable, sin intentar conectar.

---

### F11-04 — `overrides` fuerza `puppeteer` a un major fuera del rango que su consumidor declara, y el build ejecuta `npx` sobre un paquete que el `package.json` no declara

**Hallazgo:** tres cosas que por separado se defienden y juntas dejan el motor de PDF sin dueño
declarado:

1. `package.json:64-66` declara `"overrides": { "puppeteer": "^25.8.0" }`. El único consumidor
   real, `@arcasdk/pdf@0.2.0`, declara `"puppeteer": "^24.43.1"`. `^24.43.1` **no** admite
   25.x: el override no está resolviendo un conflicto dentro del rango, está **cruzando un
   major por encima de lo que el paquete dice soportar**.
2. `puppeteer` **no es una dependencia directa** de este repo. `knip` lo reporta como
   *"Unlisted dependency"* apuntando a `.puppeteerrc.cjs:11`. El `buildCommand` de
   `render.yaml:33` corre `npx puppeteer browsers install chrome` sobre un binario que llega
   solo por transitividad.
3. El puente entre las dos cosas es un patch a mano
   (`patches/@arcasdk+pdf+0.2.0.patch`): reemplaza el `require("puppeteer")` original por un
   `await import("puppeteer")` porque —según el propio comentario del patch— *"puppeteer 25 es
   ESM puro... un require() clásico tira ERR_REQUIRE_ESM"*. O sea: **el patch existe
   precisamente porque el override rompió la forma en que el paquete carga su dependencia.**

El razonamiento original está escrito y es correcto para su momento (`fd72495`, 24/08/2026:
resolver vulnerabilidades subiendo a Node 22 + puppeteer 25). Lo que no quedó registrado es el
costo: `@arcasdk/pdf` corre hoy contra un major de puppeteer que su autor nunca probó, y si
`npx` no encontrara el paquete en `node_modules` **lo descargaría del registry en el acto**,
sin lockfile, sin integridad y sin que nadie lo note en el log.

**Evidencia:**
- `package.json:64-66` (`overrides`), `node_modules/@arcasdk/pdf/package.json` →
  `dependencies.puppeteer = "^24.43.1"`, `node_modules/puppeteer/package.json` → `25.8.0`.
- `package-lock.json`: `node_modules/@arcasdk/pdf` → `{"puppeteer":"^24.43.1"}`;
  `node_modules/puppeteer` → `25.8.0`, `dev: false`.
- `npx knip --no-progress` → `Unlisted dependencies (1) — puppeteer  .puppeteerrc.cjs:11:10`.
- `render.yaml:33` (el `npx`), `:26-32` (el comentario que explica por qué el paso es
  explícito), `.puppeteerrc.cjs:12-14` (redirección del caché al proyecto).
- `patches/@arcasdk+pdf+0.2.0.patch` — la sustitución de `require("puppeteer")` por
  `import("puppeteer")` y el agregado de `--no-sandbox --disable-setuid-sandbox
  --disable-dev-shm-usage`.
- `du -sh .cache` → **652 MB**; `du -sh node_modules/puppeteer-core` → 8,1 MB.
- Los **14** duplicados del árbol de producción del backend (`yargs` 15.4.1 + 18.1.0,
  `string-width` ×3, `pako`, `cliui`, `emoji-regex`…) son la maquinaria de descarga y
  descompresión que entra con `@puppeteer/browsers` (ver F11-21).

**Impacto:** el circuito fiscal (PDF del comprobante AFIP) corre sobre una combinación de
versiones que nadie certificó y que se sostiene con un patch de 4864 bytes. El fallo esperable
no es un crash de build sino un PDF que deja de generarse en runtime, que es exactamente el
modo de falla que `render.yaml:26-32` ya narra haber sufrido una vez ("Could not find Chrome"
con el build reportado como exitoso).

**Causa probable:** una decisión de seguridad correcta (subir puppeteer) tomada sobre una
dependencia que no se controla, sin la contrapartida de declarar `puppeteer` como dependencia
propia — que es lo que convertiría el override en una elección explícita en vez de en un
parche invisible.

**Nivel de certeza:** **Alta** para los tres hechos (override fuera de rango, ausencia de la
declaración directa, patch como consecuencia). **`No confirmado.`** si `@arcasdk/pdf@0.2.1`
—disponible— ya soporta puppeteer 25 y haría innecesario parte de esto.
`Información faltante:` el changelog o el `package.json` de `@arcasdk/pdf@0.2.1`.
`Cómo verificarlo:` `npm view @arcasdk/pdf@0.2.1 dependencies` — lectura del registry, no toca
el árbol.

**Severidad:** **Alta.**

**Recomendación (análisis, no ejecución):** declarar `puppeteer` como dependencia directa con
el rango que realmente se usa. Eso convierte el `npx` del build en una invocación sobre algo
declarado, hace visible el override en el mismo archivo y le da a `knip` la forma de vigilarlo.
Aparte —y esto es decisión de producto, no recomendación de esta fase— vale medir si el costo
total del camino Chromium (652 MB de caché, 14 duplicados de producción, 1 patch, 1 override
fuera de rango, 1 paso de build) es el que se quiere pagar por el PDF de un comprobante, o si
conviene evaluar un renderizador sin navegador. No se propone ninguna alternativa concreta:
ese análisis no se hizo y no corresponde a esta fase.

**¿Requiere modificar código?:** No en `src/`. Sí en `package.json`. Fuera del alcance.

**Prueba necesaria:** la que ya debería existir y no existe: una prueba de integración que
genere un PDF real. Sin ella, cualquier cambio en esta cadena se descubre en producción.

---

### F11-05 — El `README.md` del frontend documenta Vite y `VITE_API_URL`: seguirlo al pie de la letra produce exactamente el fallo silencioso contra el que advierte el `.env.example` del mismo repo

**Hallazgo:** `appfrontend-main/README.md` describe un proyecto que no es este. Dice
*"React + TypeScript + Vite"*, instruye
`cp .env.example .env # editá VITE_API_URL si tu API no corre en localhost:3000`, indica
desplegar como **Render Static Site** con `Publish Directory: dist` y afirma que
*"el `render.yaml` incluido ya trae esta config"* — archivo que no existe en el repo.

El repo real es Next.js 16 sobre Vercel, sin `dist`, sin `render.yaml` y sin Vite.

Lo que convierte esto de "documentación vieja" en un hallazgo de configuración es que el mismo
repo, en `.env.example:2-6`, tiene escrita la advertencia exacta contra lo que el README manda
hacer:

> *"⚠️ El prefijo `NEXT_PUBLIC_` es obligatorio... Si esta variable se llama distinto (ej.
> `VITE_API_URL`, que es de Vite, no de Next.js), `src/lib/api.ts` cae a `BASE=''` en silencio
> y todos los fetch van a rutas relativas del propio frontend (404)."*

Hoy el mecanismo es incluso menos perdonador que lo que esa nota describe: `BASE` ya es `''`
siempre y por diseño (`src/lib/http.ts:5`, `src/lib/customerApi.ts:17`,
`src/lib/platformApi.ts:13`), porque el mismo origen se resuelve por el `rewrites()` de
`next.config.js:17`. Y ese rewrite lee **`NEXT_PUBLIC_API_URL`**: si no está, `return []`, y
**todo `/api/*` queda servido por el propio Next**, que responde 404. No hay error de
configuración, no hay warning, no hay log: la app compila, levanta, muestra el login y ningún
fetch llega nunca al backend.

**Evidencia:**
- `appfrontend-main/README.md` — íntegro; las frases citadas están en los primeros 25 renglones.
- `appfrontend-main/.env.example:2-6` — la advertencia.
- `appfrontend-main/next.config.js:17-19` — `const backend = process.env.NEXT_PUBLIC_API_URL;
  if (!backend) return []`.
- `src/lib/http.ts:3-5`, `src/lib/customerApi.ts:16-17`, `src/lib/platformApi.ts:13` — los tres
  `BASE = ''` con el comentario que remite al rewrite.
- `find . -maxdepth 2 -name vercel.json -not -path ./node_modules/*` → **0 resultados**.
- `.github/workflows/ci.yml` del frontend, job `typecheck-build`, comentario propio:
  *"Sin secretos: `NEXT_PUBLIC_API_URL` ausente degrada `rewrites()` a `[]`... compila igual,
  solo sin el proxy same-origin"*. O sea: **el job de build de CI valida un binario que no es
  el que se despliega** — compila sin la variable, producción compila con ella.

**Impacto:** dos. (1) Un entorno nuevo (una máquina, una preview de Vercel, un fork) montado
siguiendo el README arranca "bien" y no funciona, sin ninguna señal que apunte a la causa.
(2) El build de CI y el build de producción no son el mismo artefacto: como
`NEXT_PUBLIC_*` se inlinea en tiempo de build, el bundle que CI declara verde **no contiene**
la configuración del que se sirve.

**Causa probable:** el README sobrevivió a una reescritura completa de stack (Vite→Next,
Render→Vercel) sin que nadie lo tocara, porque no hay nada que lo verifique. El `.env.example`
se escribió después, justo para documentar el trauma de ese cambio, y quedó contradiciendo al
README sin que se borrara el original.

**Nivel de certeza:** **Alta** para todo (lectura directa de cinco archivos del repo).

**Severidad:** **Alta** (reproducibilidad de entornos y divergencia CI/producción; no es una
falla de runtime en el despliegue actual, que funciona).

**Recomendación (análisis, no ejecución):** reescribir el README del frontend contra el repo
real, o —si no se quiere invertir en eso ahora— reemplazarlo por un puntero de tres líneas a
`.env.example` + `ARCHITECTURE.md`, que es menos que hoy pero deja de mentir. Aparte, evaluar
si el job de build de CI debe correr con un `NEXT_PUBLIC_API_URL` de prueba, para que el
artefacto que se valida se parezca al que se despliega. Ninguna de las dos es decisión de esta
fase.

**¿Requiere modificar código?:** No (documentación y, opcionalmente, un `env:` en el CI).
Fuera del alcance.

**Prueba necesaria:** ninguna automática. Un chequeo humano: clonar, seguir el README, ver qué
pasa.

---

### F11-06 — El umbral de cobertura está 17,7 puntos por debajo de la cobertura real, y 8 de sus 18 exclusiones apuntan a archivos que no existen

**Hallazgo:** `vitest.config.ts:65-68` fija el piso en lines **60**, functions **60**, branches
**50**, statements **60**. La cobertura real medida hoy es lines **77,68 %**, functions
**78,30 %**, branches **83,70 %**. El gate tolera una caída de **17,7 puntos** en líneas y de
**33,7** en ramas sin ponerse rojo.

El propio comentario del archivo (`:57-64`) explica que el piso se puso debajo del valor
medido *"a propósito (margen para fluctuación normal, no para que baje sin que nadie lo note)"*
citando un estado real de **63,6 %**, y declara como objetivo de Fase 3 llevarlo a 80/70. El
código llegó a 77,68 % solo; el piso se quedó donde estaba. La consecuencia es la que el
comentario justamente quería evitar: hoy la cobertura sí puede bajar sin que nadie lo note.

Además, el `exclude` de cobertura (`:32-54`) tiene **8 rutas que no existen en el árbol**:
`src/schemas/`, `src/seed/`, `src/repositories/supabase.occupancy.repository.ts`,
`customer.repository.ts`, `occupancy.repository.ts`, `reservation.repository.ts`,
`resource.repository.ts` y `sql.customer.repository.ts`. Es la misma clase de drift que Fase 1
registró para `tsconfig.json` en **B-02** (`exclude` de
`src/reservas/supabase.occupancy.repository.ts`, también inexistente), pero en un archivo que
esa revisión no miró — y acá el residuo no es cosmético: **2 de las exclusiones que sí existen
apagan la medición de archivos que tienen test propio**:

| Excluido | Su test | LOC |
|---|---|---|
| `src/services/**` → `report.service.ts` | `report.service.test.ts` | 295 |
| `src/db/**` → `health-cache.ts` | `health-cache.test.ts` | 129 |

Esos tests corren y pasan; su cobertura simplemente no cuenta. `src/db/**` además apaga
`pg.client.ts`, que es donde vive el `ssl:false` silencioso de F9-10.

**Evidencia:**
- `vitest.config.ts:32-54` (exclusiones), `:55-68` (umbrales y su comentario).
- `npm run test:coverage` (corrida completa, exit 0) + recálculo de totales sobre
  `coverage/lcov.info` (`LF/LH/FNF/FNH/BRF/BRH` sumados): **19 841/25 541 líneas = 77,68 %**;
  functions **78,30 %**; branches **83,70 %**. `coverage/` fue borrado al terminar.
- Cruce de `SF:` de `lcov.info` contra `find src -name '*.ts' ! -name '*.test.ts'`:
  **273 medidos de 290**; los 17 fuera son `app.ts`, `container.ts`, `server.ts`,
  `platform.container.ts`, `openapi/spec.ts`, los 6 de `src/db/`, `services/report.service.ts`,
  `repositories/sql.client.ts`, `security/user.types.ts` y los 3 de `src/types/`.
- Verificación una por una de las 8 rutas inexistentes (`[ -e "$p" ]`).
- `ls src/services/` → `report.service.ts` + `report.service.test.ts`.
  `ls src/db/` → incluye `health-cache.ts` + `health-cache.test.ts`.

**Impacto:** el job `test` del CI (`ci.yml:14-45`) es la única cerca de cobertura del backend, y
hoy es decorativa: no hay ningún cambio plausible que la ponga roja. Un bloque grande sin tests
—el escenario para el que el umbral existe— entraría verde.

**Causa probable:** el piso se calibró una vez (24/08/2026, "I7") contra el estado de ese
momento y nunca se re-calibró; las exclusiones se escribieron contra la estructura de carpetas
anterior al refactor por dominios y sobrevivieron porque una ruta inexistente en un `exclude`
no produce error.

**Nivel de certeza:** **Alta** (cobertura medida, exclusiones verificadas una por una).

**Severidad:** **Media** (es una cerca que no cerca; no rompe nada por sí sola).

**Recomendación (análisis, no ejecución):** tres movimientos, separables. (1) Subir el piso a
algo por debajo pero cerca del real —el propio comentario ya declara 80/70 como objetivo—.
(2) Borrar las 8 rutas muertas del `exclude`. (3) Decidir explícitamente los 2 casos con test
propio: o se sacan del `exclude` y cuentan, o se documenta por qué no. Lo primero es lo que
convierte al gate en gate; lo segundo y tercero es higiene que además hace auditable la
primera.

**¿Requiere modificar código?:** No en `src/`. Sí en `vitest.config.ts`. Fuera del alcance.

**Prueba necesaria:** ninguna nueva. Correr `npm run test:coverage` tras el cambio y verificar
que sigue verde con el piso nuevo.

---

### F11-07 — Los tests de integración corren contra PostgreSQL 16; la producción documentada es PG 18 (plataforma) y PG 17 (tenants), y el mismatch está declarado abierto hace cinco semanas

**Hallazgo:** el job `integration` del CI (`ci.yml:281-284`) levanta
`image: postgres:16-alpine`. `docs/INCIDENT_LOG_2026-08-08.md:45-46` registra que la BD de
plataforma corre **PostgreSQL 18** y la de tenants **PostgreSQL 17**, y el mismo documento
declara el problema en dos lugares:

- `:52` — *"⚠️ Hay un mismatch de versiones (PG 18 vs PG 17). Si alguna query usa syntax
  exclusiva de PG 18, fallará en el proyecto de tenants. **Alinear versiones en el próximo
  sprint o confirmar compatibilidad explícitamente**"*;
- `:121` — ítem de checklist pre-deploy sin marcar, y `:132` — deuda #3, prioridad Media,
  estado **Pendiente**.

O sea que hay **tres** versiones en juego (16 en pruebas, 17 en tenants, 18 en plataforma) y la
única que se ejercita automáticamente es la que no corre en ningún lado. Las mediciones de la
Fase 10 se hicieron también contra PG 16.13 local, con lo cual el conocimiento acumulado sobre
comportamiento de locks, `EXCLUDE USING gist` y tiempos de `ALTER` está todo calibrado sobre la
versión no productiva.

**Evidencia:**
- `.github/workflows/ci.yml:281-295` — el service container y su healthcheck; `:298` — el
  `TEST_DATABASE_URL` que apunta a él.
- `docs/INCIDENT_LOG_2026-08-08.md:45-46`, `:52`, `:85-86`, `:121`, `:132`.
- `src/db/schema.sql` usa `btree_gist`, `pgcrypto`, 2 `EXCLUDE USING gist` y `gen_random_uuid()`
  — todo soportado en 16, 17 y 18, sin sintaxis exclusiva de una versión detectada en la
  revisión de Fase 10.
- `docs/auditoria-integral-fase10-2026-09-15.md` §0.3 — las mediciones de esa fase se hicieron
  sobre PostgreSQL **16.13**.

**Impacto:** la suite de integración —47 suites, cada una creando una base y aplicando
`schema.sql` entero— es la evidencia más fuerte que tiene este proyecto sobre locks,
constraints y concurrencia. Toda esa evidencia está sacada de un motor que no es el de
producción. Mientras el schema no use sintaxis versión-específica el riesgo es bajo; el punto
es que **nadie lo está verificando**, y la deuda que lo dice está abierta desde el 08/08/2026.

**Causa probable:** el `postgres:16-alpine` se eligió cuando se armó el job (05/09/2026, F2) por
ser la imagen estable habitual, sin cruzarlo contra lo que el incident log ya decía sobre
producción.

**Nivel de certeza:** **Alta** para el 16 del CI (lectura directa). **`No confirmado.`** para
las versiones de producción de hoy: la única fuente es un documento del 08/08/2026, y esta fase
no consulta Neon.
`Información faltante:` `SELECT version()` contra la BD de plataforma y contra una de tenant.
`Cómo verificarlo:` dos consultas de solo lectura, o el panel de cada proyecto en Neon.

**Severidad:** **Media.**

**Recomendación (análisis, no ejecución):** primero confirmar las versiones reales (la deuda #3
del incident log sigue siendo la acción correcta y es barata). Después, alinear la imagen del
job `integration` a la versión de los tenants, que es contra la que corre `schema.sql`. Si las
dos versiones de producción siguen divergiendo entre sí, la decisión de si eso se alinea o se
documenta como compatible es del dueño, no de esta fase.

**¿Requiere modificar código?:** No. Un cambio de una línea en `ci.yml` y, eventualmente, una
decisión de infraestructura.

**Prueba necesaria:** correr la suite de integración completa contra la versión objetivo antes
de fijarla.

---

### F11-08 — `express@4.22.2` arrastra 2 advisories moderate cuyo fix ya está dentro del rango declarado: nadie corre `npm update` y ningún CI de los dos repos corre `npm audit`

**Hallazgo:** `npm audit --omit=dev` del backend devuelve, además del `@xmldom/xmldom` de
F9-13, tres entradas encadenadas: `qs` (moderate, 2 advisories: *array-limit bypass via
bracket-key comma parsing* y *DoS via Attacker Controlled isBuffer*), y por arrastre
`body-parser` y `express`. Las tres con `fixAvailable: true` **sin major**.

La versión instalada de `express` es **4.22.2**; la disponible es **4.22.3**, y
`package.json:52` ya declara `"express": "^4.21.0"` — o sea que **4.22.3 entra en el rango que
el repo ya autorizó**. No hace falta ninguna decisión: hace falta que algo lo mueva. Nada lo
mueve, porque:

- el build de Render corre `npm install`, que respeta el lockfile mientras satisfaga el rango
  y por lo tanto **nunca sube dentro de `^`** por su cuenta;
- **ningún job del CI del backend corre `npm audit`** — los 6 jobs son `test`, `typecheck`,
  `lint`, `schema-version-check`, `route-inventory-check` e `integration`;
- el CI del frontend tampoco (Fase 9 ya lo verificó para ese repo).

Esto cierra el par con F9-01. Ahí el problema fue el **pin exacto** (`next: "16.3.1"`), que
hace que ni siquiera un patch de seguridad entre solo. Acá el problema es el **rango abierto**
sin nadie que lo ejerza: `^4.21.0` autoriza el fix desde hace tiempo y el fix no entró igual.
**Las dos políticas de versionado opuestas conviviendo en el mismo proyecto fallan por la misma
causa: no hay un momento en el que alguien mire.**

**Evidencia:**
- `npm audit --omit=dev --json` (backend): `{"moderate":3,"high":1,"total":4}`; `qs` con los 2
  títulos citados y `fixAvailable: true`; `express` y `body-parser` `via: qs`.
- `npm outdated --json` (backend): `express | 4.22.2 | 4.22.3 | 5.2.1` — `wanted` 4.22.3.
- `package.json:52` → `"express": "^4.21.0"`.
- `package-lock.json` → `node_modules/qs` versión **6.15.3**, copia única, `dev: false`.
- `.github/workflows/ci.yml` (backend, íntegro): 6 jobs, ninguno ejecuta `npm audit`.
- Política de versionado medida: backend **0 de 33** dependencias con versión exacta; frontend
  **6 de 19** exactas.

**Impacto:** dos advisories moderate en el parser de query strings del framework HTTP, en un
servicio que expone 262 endpoints. No es crítico y no hay explotación demostrada en este
código; lo relevante es el mecanismo: **el repo no tiene ningún punto en el que la diferencia
entre "lo instalado" y "lo disponible con fix" se vuelva visible**, y ya pagó el costo de eso
una vez, en F9-01, en severidad crítica.

**Causa probable:** no hay proceso de actualización de dependencias, ni manual con cadencia ni
automatizado. Los bumps del repo son reactivos: aparecen cuando algo se rompe (`fd72495`,
`b11ca15`) o cuando una auditoría los encuentra.

**Nivel de certeza:** **Alta** (salida directa de `npm audit` y `npm outdated`, y lectura
completa de los dos `ci.yml`).

**Severidad:** **Media.**

**Recomendación (análisis, no ejecución):** un job de `npm audit --omit=dev` en los dos CI. La
decisión de si ese job **falla** el build o solo informa es del dueño y no es trivial: fallar
por un advisory de una transitiva de cuarto nivel sin fix disponible (el caso de
`@xmldom/xmldom`, F9-13) bloquearía todo deploy hasta resolverlo. Una forma intermedia,
consistente con las cercas que este repo ya usa, es un umbral declarado con allowlist por
advisory y motivo —mismo criterio que `PUBLIC_ROUTES` o `CLOSURE_MOUNTS`— para que un advisory
nuevo rompa y uno aceptado conscientemente no.

**¿Requiere modificar código?:** No. Un job de CI y, aparte, un bump.

**Prueba necesaria:** `npm install express@4.22.3` seguido de la suite completa (unitarios +
integración), que es donde se vería cualquier regresión de parseo de query.

---

### F11-09 — El patch de `@arcasdk/pdf` está anclado a `0.2.0` mientras el rango declarado admite `0.2.1`, que ya existe: si el árbol se re-resuelve, el patch degrada a warning o el PDF deja de generarse

**Hallazgo:** `patches/@arcasdk+pdf+0.2.0.patch` codifica la versión en su nombre, como exige
`patch-package`. `package.json:47` declara `"@arcasdk/pdf": "^0.2.0"`, y `npm outdated` reporta
`0.2.1` disponible. Hoy el lockfile fija `0.2.0` y todo cuadra. El día que el lockfile se
re-resuelva —`npm install <cualquier-cosa>`, un `npm update`, o un borrado de
`package-lock.json`— entran dos escenarios, los dos verificados en el código de
`patch-package`:

1. **El patch sigue aplicando sobre 0.2.1** → `patch-package` emite únicamente un warning:
   *"Don't worry! This is probably fine. The patch was still applied successfully... There is a
   small chance of breakage"* (`dist/applyPatches.js:327-352`). El build pasa verde con un
   parche escrito para otro código.
2. **El patch no aplica** → camino `createBrokenPatchFileError`, y `shouldExitWithError` es
   verdadero en Render, porque se activa con `isCI` y `ci-info` reconoce a Render por la
   variable `RENDER` (`dist/index.js:91-94` + `ci-info/vendors.json`). El build **falla**, que
   es lo correcto.

Lo que el patch hace no es cosmético: elimina el `require("puppeteer")` original (que tiraría
`ERR_REQUIRE_ESM` contra puppeteer 25, ver F11-04) y agrega los flags
`--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage` sin los cuales —según el propio
comentario del patch y el commit `71d4683`— Chromium no arranca en el contenedor de Render. Los
dos efectos son condición necesaria para que se emita un PDF en producción.

**Evidencia:**
- `patches/@arcasdk+pdf+0.2.0.patch` (4864 bytes) — el hunk que saca el `require` y agrega los
  flags, con su comentario fechado (I11, 23/08/2026).
- `package.json:47` (`^0.2.0`), `:8` (`postinstall`), `package-lock.json` →
  `node_modules/@arcasdk/pdf` = **0.2.0**.
- `npm outdated --json` → `@arcasdk/pdf | 0.2.0 | 0.2.1 | 0.2.1`.
- `node_modules/patch-package/dist/applyPatches.js:327-352` — texto literal del warning de
  mismatch.
- `node_modules/patch-package/dist/index.js:91-94` — `shouldExitWithError = !!argv["error-on-fail"]
  || (NODE_ENV==="production" && isCI) || (isCI && !PATCH_PACKAGE_INTEGRATION_TEST) ||
  NODE_ENV==="test"`.
- `node_modules/ci-info/vendors.json` → `{"name":"Render","constant":"RENDER","env":"RENDER"}`
  (1 de 47 vendors).
- Nota de interacción con F11-01: si el `npm install` del build llegara a omitir
  devDependencies, `patch-package` no existiría y este análisis sería irrelevante porque el
  `postinstall` fallaría antes.

**Impacto:** el escenario 2 es ruidoso y por lo tanto aceptable. El escenario 1 es el
problemático: un build verde con un parche aplicado sobre código que cambió, y el síntoma
apareciendo recién cuando alguien emita una factura. Es la misma clase de falla que
`render.yaml:26-32` ya narra ("build exitoso, `Could not find Chrome` en runtime").

**Causa probable:** `patch-package` es así por diseño (prioriza no bloquear al desarrollador), y
el rango `^0.2.0` se escribió antes de que existiera el patch. Nadie apretó el rango al
agregarlo.

**Nivel de certeza:** **Alta** para el mecanismo (lectura del código de `patch-package` y de
`ci-info`) y para las versiones. **`No confirmado.`** si el patch aplicaría limpio sobre 0.2.1.
`Información faltante:` el diff entre `@arcasdk/pdf@0.2.0` y `0.2.1` en
`lib/generator/invoice-pdf-generator.js`.
`Cómo verificarlo:` `npm pack @arcasdk/pdf@0.2.1` en un directorio temporal y comparar ese
archivo; no toca el árbol del repo.

**Severidad:** **Media.**

**Recomendación (análisis, no ejecución):** apretar el rango a la versión exacta parcheada
(`"@arcasdk/pdf": "0.2.0"`), que es lo que hace el frontend con `next` y lo que vuelve el
acoplamiento visible en el propio `package.json`. Como contrapartida, eso convierte cualquier
bump en una decisión explícita que obliga a regenerar el patch — que es exactamente lo que se
quiere para un archivo que sostiene el circuito fiscal.

**¿Requiere modificar código?:** No en `src/`. Sí en `package.json`. Fuera del alcance.

**Prueba necesaria:** la de F11-04: una prueba de integración que genere un PDF real. Sin ella
no hay forma de detectar el escenario 1.

---

### F11-10 — El backend no se puede levantar desde el repo: sin `.env.example`, con un `README.md` que describe otra aplicación, y con una convención escrita que da por existente un archivo que no existe

**Hallazgo:** Fase 1 (**B-04**) y Fase 7 (**F7-06**) ya registraron que el backend no tiene
`.env.example` y que sus variables solo viven en `render.yaml`. Lo que esta fase agrega, con el
lente de "configuración de desarrollo", es que el problema es más grande que un archivo
faltante: **los tres artefactos que deberían describir cómo levantar el backend describen tres
sistemas distintos, y ninguno es el real.**

1. **No hay `.env.example`.** Verificado: no existe, y `git ls-files` no devuelve ninguno.
2. **`README.md` describe una aplicación anterior.** Dice *"Modo demo in-memory con datos
   precargados (sin base de datos)"*; su "Inicio rápido" es `npm install && npm run dev`, que
   no puede funcionar (F11-03: el primer paso de `main()` intenta migrar la BD de plataforma);
   su árbol de arquitectura lista `src/seed/`, carpeta que no existe; su build command para
   Render es `npm install && npm run build`, sin los dos pasos que `render.yaml` sí tiene
   (`npx puppeteer` y `migrate:tenants`); y sus "Próximos pasos" incluyen *"[ ] Autenticación
   JWT"*, que está construida hace meses. **No menciona una sola variable de entorno.**
3. **`docs/INCIDENT_LOG_2026-08-08.md` legisla sobre el archivo inexistente.** Su sección
   "Convenciones Establecidas" se titula *"`.env.example` — Mantener SIEMPRE actualizado"* y
   fija la regla *"Si se agrega o modifica una variable de entorno → se actualiza `.env.example`
   en el mismo PR"* (`:108`). El checklist pre-deploy (`:120`) tiene el ítem
   *"[ ] `.env.example` está actualizado y refleja todas las variables requeridas"*, y la tabla
   de deudas (`:129`) lista *"Actualizar `.env.example` con las dos variables"* como 🔴 Alta,
   Pendiente. El contenido que ese documento propone para el archivo cita **`TENANT_DATABASE_URL`**
   — variable con **0 ocurrencias** en `src/` — y su deuda #2 habla de **`drizzle-kit`**, que no
   está ni en `package.json` ni en el lockfile.

**Evidencia:**
- `ls -a /home/user/app` → sin `.env.example`; `.gitignore:3-4` ignora `.env` y `.env.local`.
- `README.md` (íntegro) — las cinco afirmaciones citadas.
- `find src -type d -name seed` → 0; `ls src/` no tiene `seed`.
- `docs/INCIDENT_LOG_2026-08-08.md:94-108` (la convención), `:117-121` (el checklist), `:126-132`
  (la tabla de deudas).
- `grep -rn "TENANT_DATABASE_URL" src --include=*.ts | wc -l` → **0**.
- `grep -c drizzle package.json` → 0; `grep -c 'node_modules/drizzle' package-lock.json` → 0.
- Las 10 variables leídas en producción y no declaradas en `render.yaml` (medición 0.4) son
  exactamente las que un desarrollador nuevo no tiene forma de descubrir salvo leyendo `src/`.

**Impacto:** el repo no es autosuficiente para levantar el backend. Combinado con F11-03, el
camino por defecto de alguien que clona y sigue el README no es "falla y le pregunto a alguien"
sino "arranca y escribe el schema de plataforma en la base que tenga a mano". Y la existencia de
una convención escrita sobre el archivo faltante es peor que su ausencia: hace creer a quien
lee el incident log que ese inventario existe en algún lado.

**Causa probable:** el `.env.example` se planificó el 08/08/2026, quedó como deuda 🔴 Alta y
nunca se creó; el README nunca se revisó después del pivote a multi-tenant. Es el modo de falla
que el propio `CLAUDE.md` del repo describe en su sección de pendientes: *"se pudre lo que queda
fuera de una categoría que alguien relee"*.

**Nivel de certeza:** **Alta** (lectura directa de los tres documentos y verificación de cada
referencia contra el árbol).

**Severidad:** **Media** (no afecta producción; afecta reproducibilidad, onboarding y —vía
F11-03— tiene radio real en una máquina de desarrollo).

**Recomendación (análisis, no ejecución):** un `.env.example` generado desde el mismo módulo que
valide el entorno al arrancar (ver F11-03), de modo que no puedan divergir; y cerrar el README a
lo que es cierto hoy, aunque sea más corto. La regla del incident log ya está escrita y es la
correcta: lo que falta es el archivo sobre el que rige. Las dos referencias muertas del incident
log (`TENANT_DATABASE_URL`, `drizzle-kit`) deberían marcarse como históricas con fecha, no
borrarse: el documento es un registro de incidente, no una guía viva.

**¿Requiere modificar código?:** No necesariamente (un `.env.example` alcanza). Sí si se opta
por el validador de entorno. Fuera del alcance.

**Prueba necesaria:** ninguna automática. La verificación es humana: clonar, seguir el README,
llegar a un backend que responde `/health`.

---

### F11-11 — `DB_ENCRYPTION_KEY_OLD` es requisito de un runbook de rotación y `render.yaml` no la menciona, ni siquiera como comentario

**Hallazgo:** `SEC-ROT-001` (11/09/2026) construyó la rotación sin downtime de
`DB_ENCRYPTION_KEY`: durante la ventana de rotación, `decryptConnectionString()` intenta con la
clave primaria y, si falla, con `DB_ENCRYPTION_KEY_OLD`
(`src/platform/tenant-db.setup.ts:170-180`). El mecanismo está bien hecho —el `opts` es objeto y
no booleano posicional, con el razonamiento escrito (`:82-90`); el error de la ventana de
rotación nombra las dos variables *"para que el operador sepa, a las 3 de la mañana"*
(`:128-133`)— y tiene runbook propio
(`docs/conocimiento/runbook-rotacion-db-encryption-key.md`).

`render.yaml` no la nombra. Ni como `sync: false`, ni como comentario. Es una de las 10
variables leídas en producción que el manifiesto de deploy no conoce (medición 0.4).

**Evidencia:**
- `src/platform/tenant-db.setup.ts:30` (la tabla de variables del docblock, que **sí** la
  documenta), `:78`, `:115-133`, `:161`, `:170-177`.
- `render.yaml` — `grep -n DB_ENCRYPTION` devuelve solo `DB_ENCRYPTION_KEY` (`:61-64`), con su
  comentario y el `node -e` para generarla.
- 10 ocurrencias de `DB_ENCRYPTION_KEY_OLD` en `src/`, ninguna en `render.yaml`.

**Impacto:** el día de la rotación, el operador sigue el runbook, entra al dashboard y agrega
una variable que el archivo que dice ser la fuente de verdad de la configuración del servicio no
declara. Cuando la ventana cierra y la borra, `render.yaml` sigue sin registro de que eso pasó.
El riesgo concreto es de dirección opuesta a la habitual: no es que falte cuando hace falta, es
que **quede puesta** después de la ventana, dejando la clave anterior viva indefinidamente como
fallback de descifrado — exactamente lo que una rotación viene a terminar.

**Causa probable:** la variable se agregó al código y al runbook en el mismo bloque, y
`render.yaml` no entró en ese alcance porque la variable es transitoria por definición.

**Nivel de certeza:** **Alta** (lectura directa de los dos archivos).

**Severidad:** **Media.**

**Recomendación (análisis, no ejecución):** declararla en `render.yaml` como bloque comentado
—no como `sync: false` activo— con el texto de cuándo se pone, cuándo se saca y qué pasa si
queda. Es el mismo patrón que el archivo ya usa para explicar decisiones (`:8-16`, `:26-32`,
`:50`, `:111-115`): dejar constancia de algo que no se activa por defecto.

**¿Requiere modificar código?:** No. Un comentario en `render.yaml`. Fuera del alcance.

**Prueba necesaria:** ninguna. Es documentación de configuración.

---

### F11-12 — El frontend no declara la versión de Node en ningún lado del repo: vive en el dashboard de Vercel, se replica a mano en 3 literales del CI, y sus tipos apuntan a otra versión

**Hallazgo:** el backend tiene la versión de Node fijada en cuatro lugares coherentes entre sí:
`package.json:engines` (`>=22.12.0 <23.0.0`, acotada a propósito en `1fcba6d`, *"para que Render
no salte de versión sola"*), `render.yaml:39-40` (`NODE_VERSION: "22"`) y tres jobs del CI con
`node-version: '22'`, cada uno con el comentario *"alineado a engines.node y a render.yaml"*.
Está bien hecho.

El frontend no tiene **nada** de eso:

- sin `engines` en `package.json`;
- sin `.nvmrc` (verificado: no existe en ninguno de los dos repos);
- **sin `vercel.json`** — toda la configuración de deploy (versión de Node, install command,
  build command, variables de entorno) vive en el dashboard de Vercel, fuera del repositorio y
  fuera de control de versiones;
- tres literales `node-version: '24'` en `ci.yml`, el primero con el comentario
  *"alineado al runtime real de Vercel (Settings → Node.js Version), verificado 01/09/2026"* —
  una alineación **verificada a mano una vez**, hace seis semanas, contra una fuente que puede
  cambiar sin tocar el repo;
- y `@types/node: "^20"` en `devDependencies`, o sea que el type-check corre con las
  definiciones de una versión de Node que no es ni la del CI (24) ni la de Vercel (24). `npm
  outdated` confirma: `@types/node | 20.19.43 | 20.19.43 | 22.20.3`.

**Evidencia:**
- `app-main/package.json:19-21`, `render.yaml:39-40`, `.github/workflows/ci.yml` (los 3
  `node-version: '22'` con su comentario).
- `appfrontend-main/package.json` — sin `engines`.
- `ls -a /home/user/appfrontend/.nvmrc` → *No such file* en los dos.
- `find /home/user/appfrontend -maxdepth 2 -name vercel.json -not -path '*/node_modules/*'` →
  **0 resultados**.
- `appfrontend-main/.github/workflows/ci.yml` — 3 × `node-version: '24'`, comentario en el
  primero.
- `appfrontend-main/package.json` → `"@types/node": "^20"`; `npm outdated` → latest 22.20.3.

**Impacto:** el repo que auto-deploya a producción al pushear a `main` (el propio `ci.yml` lo
dice: *"es el repo que auto-deploya a producción (Vercel)... el de MENOR control automatizado
siendo el de MAYOR exposición"*) no declara en ningún archivo versionado sobre qué runtime
corre. Si alguien cambia la versión en el dashboard, o si Vercel mueve su default, el CI sigue
validando contra 24 y producción corre contra otra cosa, sin que ningún archivo del repo cambie
ni ningún chequeo se ponga rojo. Los `@types/node` desalineados no rompen nada hoy —el frontend
casi no usa APIs de Node— pero son la señal de que nadie está mirando la alineación.

**Causa probable:** el proyecto se creó con `create-next-app`, que no genera `engines` ni
`vercel.json`, y la configuración se fue resolviendo en el dashboard. El CI se agregó después
(01/09/2026) y se alineó a mano contra lo que el dashboard decía ese día.

**Nivel de certeza:** **Alta** para todo lo verificable en el repo. **`No confirmado.`** cuál es
la versión de Node que Vercel usa hoy.
`Información faltante:` el valor actual de Settings → Node.js Version del proyecto en Vercel.
`Cómo verificarlo:` mirarlo en el dashboard, o leer la cabecera de un log de build reciente.

**Severidad:** **Media.**

**Recomendación (análisis, no ejecución):** declarar `engines.node` en el `package.json` del
frontend — Vercel lo respeta y lo convierte en un dato versionado. Con eso, los tres literales
del CI pasan a tener una fuente única, igual que en el backend. Evaluar aparte si conviene un
`vercel.json` mínimo para sacar del dashboard lo que es configuración de build; y subir
`@types/node` a la major que corresponda al runtime elegido.

**¿Requiere modificar código?:** No. `package.json` y, opcionalmente, un `vercel.json`. Fuera
del alcance.

**Prueba necesaria:** un build de preview en Vercel tras declarar `engines`, verificando en el
log que la versión usada es la declarada.

---

### F11-13 — Los 6 jobs del CI del backend usan `npm install`, no `npm ci`: el lockfile no es contrato en ningún punto del pipeline del backend

**Hallazgo:** los 5 jobs del backend que instalan dependencias (`test`, `typecheck`, `lint`,
`route-inventory-check`, `integration`) corren `npm install`. El `buildCommand` de Render
también. **En ningún punto del pipeline del backend el lockfile se trata como contrato.**

La diferencia importa: `npm ci` falla si `package.json` y `package-lock.json` divergen, borra
`node_modules` y reproduce el árbol exacto. `npm install` reconcilia: si divergen, **reescribe
el lockfile** y sigue. Con lo cual un `package.json` modificado sin regenerar el lock produce un
CI verde contra un árbol que nadie commiteó — y produce un árbol potencialmente distinto en cada
job, porque cada uno resuelve por su cuenta.

El frontend **sí** usa `npm ci` en sus 3 jobs, con `cache: 'npm'`. O sea que los dos repos del
mismo proyecto tienen políticas opuestas de reproducibilidad de dependencias, ninguna de las dos
declarada como decisión. Y en el frontend la política se corta igual en el borde: lo que Vercel
ejecuta para instalar no está en el repo (F11-12).

**Evidencia:**
- `app-main/.github/workflows/ci.yml` — `run: npm install` en los jobs `test` (`:30`),
  `typecheck`, `lint`, `route-inventory-check` e `integration`.
- `app-main/render.yaml:33` — `buildCommand: npm install && ...`.
- `appfrontend-main/.github/workflows/ci.yml` — `run: npm ci` en `typecheck-build`, `lint` y
  `test`, los tres con `cache: 'npm'`.
- Ninguno de los dos `ci.yml` tiene `cache: 'npm'` del lado del backend.
- `npm ls --depth=0` del backend: sin `invalid`, sin `missing`, sin `extraneous` — el árbol
  local **hoy** coincide con el lockfile. (En el frontend aparecen 2 `extraneous`,
  `@emnapi/runtime` y `@img/sharp-wasm32`, que son variantes opcionales de `sharp` resueltas por
  la plataforma de este sandbox; no es un hallazgo del repo, se registra como caveat de la
  medición.)

**Impacto:** ninguno observable hoy —el árbol está sincronizado— pero el pipeline no tiene forma
de detectar que deje de estarlo, y esa es precisamente la garantía que se compra con `npm ci`.
Es el mismo mecanismo que Fase 9 ya citó como limitante al analizar `@xmldom/xmldom`: *"la
resolución exacta del árbol en producción puede diferir de la del lockfile local"*.

**Causa probable:** `npm install` es el default de todos los ejemplos; `npm ci` se adoptó en el
frontend cuando se armó su CI (01/09/2026, con caché) y nunca se retrofiteó al backend.

**Nivel de certeza:** **Alta** (lectura íntegra de los dos `ci.yml` y de `render.yaml`).

**Severidad:** **Media.**

**Recomendación (análisis, no ejecución):** `npm ci` en los 5 jobs del backend, con
`cache: 'npm'` — es además más rápido. Para el `buildCommand` de Render la decisión es menos
obvia y conviene tomarla junto con F11-01: `npm ci` borra `node_modules` entero, lo que anula el
caché que `render.yaml:23-24` documenta y obliga a redescargar todo en cada deploy, incluido
—según cómo interactúe con `.puppeteerrc.cjs`— el Chromium de 652 MB. Los dos lados de ese
trade-off deberían medirse antes de decidir.

**¿Requiere modificar código?:** No. Cambios en `ci.yml` y, eventualmente, en `render.yaml`.
Fuera del alcance.

**Prueba necesaria:** correr el CI completo con `npm ci` y verificar que ningún job falle por
divergencia lock/manifest (si falla, el hallazgo se convierte en otro más grande).

---

### F11-14 — Dos majors del mismo runner de tests conviven entre repos, y `@vitest/coverage-v8` está acoplado a mano al major de `vitest`

**Hallazgo:** el backend usa `vitest@^3.0.0` (instalado 3.2.7) y el frontend `vitest@^4.1.11`
(instalado 4.1.11). El backend además tiene `@vitest/coverage-v8@^3.0.0`, cuyo major **tiene que
coincidir** con el de `vitest` para que el reporter funcione — un acoplamiento que no está
escrito en ningún lado y que solo se mantiene porque los dos rangos empiezan con el mismo
número.

`npm audit` del backend muestra el costo actual: `vitest` y `@vitest/mocker` figuran como
**moderate** (*Path Traversal / Arbitrary File Read via @vitest/mocker Redirect Mock*), con
`fixAvailable: {"name":"vitest","version":"5.0.1","isSemVerMajor":true}` — o sea que el fix
implica saltar **dos** majors (3 → 5) y arrastrar `@vitest/coverage-v8` con él. Como es
devDependency, no está en la superficie de producción (no aparece en `npm audit --omit=dev`),
pero sí en la superficie del CI, que es un entorno privilegiado.

El frontend, además, tiene un segundo runner: `npm run test:visual` usa `node --test` sobre
`scripts/lib/*.test.mjs`. El `ci.yml` lo declara explícitamente (*"dos runners distintos: vitest
y node --test"*), así que es una decisión consciente y no un hallazgo — se registra porque
completa el mapa: **tres configuraciones de prueba distintas entre los dos repos, más una cuarta
(`vitest.integration.config.ts`) dentro del backend.**

**Evidencia:**
- `app-main/package.json:35` (`@vitest/coverage-v8: ^3.0.0`), `:46` (`vitest: ^3.0.0`).
- `appfrontend-main/package.json` → `"vitest": "^4.1.11"`.
- `npm outdated` backend: `vitest | 3.2.7 | 3.2.7 | 5.0.1`; `@vitest/coverage-v8 | 3.2.7 | 3.2.7
  | 5.0.1`. Frontend: `vitest | 4.1.11 | 4.1.11 | 5.0.1`.
- `npm audit --json` backend → `vitest` y `@vitest/mocker` moderate, fix semver-major a 5.0.1.
- `appfrontend-main/vitest.config.mts` (`environment: 'node'`, `include: src/**/*.test.{ts,tsx}`)
  vs `app-main/vitest.config.ts` (`globals: true`, coverage, exclusiones) vs
  `vitest.integration.config.ts` (`testTimeout: 30_000`).
- Detalle menor de la config del frontend: declara soporte para tests `.tsx` con
  `environment: 'node'`. Hoy no hay ningún `.tsx` de test (los 2 archivos son `.ts`), así que es
  configuración no ejercitada: un test de componente fallaría por falta de DOM.

**Impacto:** bajo hoy. Importa por dos motivos acumulativos: (1) el salto 3 → 5 del backend será
más caro cuanto más se postergue, y arrastra la config de cobertura que F11-06 ya señala
desalineada; (2) tener dos majors del mismo runner significa que ninguna experiencia adquirida en
un repo (un flag, un workaround, una forma de mockear) se traslada fiablemente al otro.

**Causa probable:** cada repo adoptó vitest en un momento distinto y ninguno se re-alineó.

**Nivel de certeza:** **Alta.**

**Severidad:** **Media.**

**Recomendación (análisis, no ejecución):** tratar `vitest` + `@vitest/coverage-v8` como un par
que se mueve junto, y decidir si los dos repos deben converger a un major común. Si se hace, es
bloque propio: un salto de dos majors del runner de tests cambia el criterio de "verde", y
mezclarlo con cualquier otro cambio haría imposible atribuir una regresión.

**¿Requiere modificar código?:** Posiblemente sí (los tests). Fuera del alcance.

**Prueba necesaria:** la suite completa de los dos repos, antes y después, comparando el conteo
de tests ejecutados y no solo el exit code.

---

### F11-15 — `typescript` (23 MB) viaja al runtime de producción sin ningún consumidor, como fósil de un fix de deploy de junio

**Hallazgo:** `typescript` está en `dependencies` (`package.json:61`), no en
`devDependencies`. Tiene **0 `import`** en `src/` (verificado). Se movió ahí el 23/06/2026 en
`df47067`, *"Fix Render deploy: compile TypeScript before start"*, el mismo commit que cambió
`start` a `npm run build && node dist/server.js` — es decir, cuando el compilador **sí** hacía
falta en el runtime, porque el runtime compilaba. Desde `b2b01ed` (19/08/2026, *"sacar el
rebuild redundante de npm start (causaba OOM en Render)"*), `start` es `node dist/server.js` y
ya no compila nada.

Queda en el árbol de producción porque el `tsc` del **build** lo necesita — pero eso solo es
cierto bajo la rama de F11-01 en la que el build omite devDependencies. Bajo la otra rama, es
23 MB de compilador enviados al contenedor de producción sin ningún consumidor.

**Evidencia:**
- `package.json:61` (`"typescript": "^5.7.0"` dentro de `dependencies`), `:10` (`start`),
  `:11` (`build`).
- `grep -rn "from 'typescript" src --include=*.ts` → **0**.
- `git log -p -- package.json` → `df47067` mueve la línea; `b2b01ed` saca el rebuild de `start`.
- `du -sh node_modules/typescript` → **23 MB**.
- `npm outdated` → `typescript | 5.9.3 | 5.9.3 | 7.0.2` (el `latest` 7.x no es accionable: está
  fuera del rango `^5.7.0` y es un salto de dos majors).

**Impacto:** 23 MB y algo de tiempo de instalación en cada deploy de un servicio en `plan: free`.
El impacto real no es el tamaño sino la desinformación: un lector de `package.json` concluye
razonablemente que el runtime necesita el compilador, y esa conclusión es falsa.

**Causa probable:** la trazada arriba, en tres commits separados por dos meses. Nadie revisó la
ubicación cuando desapareció el motivo.

**Nivel de certeza:** **Alta** (historia de git verificada commit por commit).

**Severidad:** **Baja.**

**Recomendación (análisis, no ejecución):** devolverlo a `devDependencies` **en el mismo bloque
en que se resuelva F11-01**, nunca antes: si la rama mala de F11-01 resultara ser la verdadera,
moverlo hoy rompería el `tsc` del build. Si se resuelve F11-01 por la vía (a) o (b), el
movimiento es seguro y además vuelve el `package.json` honesto.

**¿Requiere modificar código?:** No en `src/`. Fuera del alcance.

**Prueba necesaria:** un deploy después del cambio, verificando que `npm run build` completa.

---

### F11-16 — Tres devDependencies del frontend sin uso, sin configuración y sin script: `dependency-cruiser`, `jscpd` y `ts-prune`

**Hallazgo:** los tres están declarados en `appfrontend-main/package.json` y no tienen **ninguna**
referencia en el repo: ni un `import`, ni un script de npm, ni un job de CI, ni un archivo de
configuración. `ts-prune` es especialmente revelador: el backend lo tenía y lo **reemplazó por
knip** el 25/08/2026 (`13bcc63`, *"limpieza de CI y reemplazo de ts-prune por knip"*); la copia
del frontend sobrevivió a esa decisión porque nadie la cruzó.

`dependency-cruiser` es el caso más llamativo de los tres: en el backend está bien integrado
(`.dependency-cruiser.cjs` de 7484 bytes con 6 reglas de dominio, script `lint:arch`, job de CI
con el argumento explícito *"una regla de arquitectura que no corre en CI no es una regla"*). En
el frontend está instalado y no hay ni config ni script — o sea, exactamente lo que ese
comentario declara que no sirve.

**Evidencia:**
- `appfrontend-main/package.json` — los tres en `devDependencies`.
- `grep` de cada nombre sobre `src/`, `scripts/`, `*.js`, `*.ts`, `*.mts`, `*.mjs` y `.github/`,
  excluyendo `package.json` → **0 referencias** para los tres.
- `ls -a | grep -iE "dependency-cruiser|jscpd|prune"` en la raíz del frontend → ninguno.
- `app-main/.dependency-cruiser.cjs` + `package.json:21` (`lint:arch`) +
  `app-main/.github/workflows/ci.yml` (step *"Lint de arquitectura"*) — el contraste.
- `git log` del backend: `13bcc63` (25/08/2026) reemplaza ts-prune por knip.
- `npm outdated` del frontend confirma que los tres se siguen resolviendo y actualizando:
  `dependency-cruiser | 18.2.0 | 18.3.1`, `jscpd | 5.0.15 | 5.2.1`.

**Impacto:** ruido de instalación y una señal falsa. Los tres son herramientas de análisis: su
presencia sugiere que el frontend tiene análisis de duplicación, de límites y de código muerto.
No tiene ninguno de los tres.

**Causa probable:** se instalaron durante la auditoría de modularidad de agosto, se usaron una
vez a mano y quedaron. El frontend no tiene `knip`, que es lo que en el backend los habría
delatado.

**Nivel de certeza:** **Alta** (grep exhaustivo, verificado también por ausencia de archivos de
configuración).

**Severidad:** **Baja.**

**Recomendación (análisis, no ejecución):** decidir por cada uno: se cablea (config + script +
job) o se saca. `dependency-cruiser` en particular vale la pregunta —el frontend tiene
convenciones de módulos declaradas en su `CLAUDE.md` (`lib/<dominio>/`, barrels de
compatibilidad) que hoy no las sostiene ninguna cerca— pero eso es un bloque de arquitectura,
no de limpieza de dependencias, y la decisión es del dueño.

**¿Requiere modificar código?:** No. `package.json` del frontend. Fuera del alcance.

**Prueba necesaria:** ninguna.

---

### F11-17 — `knip` y `jscpd` están instalados en el backend y no corren en ningún job: la detección de código muerto y de duplicación depende de que alguien se acuerde

**Hallazgo:** `knip` tiene script (`npm run deadcode`, `package.json:22`) y config dedicada
(`knip.json`), pero **no** está en ningún job del CI. `jscpd` no tiene ni siquiera script: está
en `devDependencies` y se invoca a mano. El `ci.yml` del backend corre `eslint` y `depcruise`
—las dos cercas que sí se cablearon— y nada más.

Se corrió `knip` en esta fase y produce resultado útil de inmediato: 29 exports sin uso, 23 tipos
exportados sin uso, 2 devDependencies reportadas como sin uso (una de ellas, `pino-pretty`, es
falso positivo por resolución dinámica) y 1 dependencia no declarada (`puppeteer`, que es el
F11-04). Nada de eso está siendo vigilado.

**Evidencia:**
- `app-main/package.json:22` (`"deadcode": "knip"`), `:39` (`jscpd`), `:41` (`knip`).
- `knip.json` — 4 líneas, `entry: ["src/scripts/*.ts", ".puppeteerrc.cjs"]`,
  `project: ["src/**/*.ts"]`.
- `.github/workflows/ci.yml` — los 6 jobs; ninguno menciona `knip`, `deadcode` ni `jscpd`.
- `npx knip --no-progress` (corrida de esta fase): salida completa reproducida en 0.4.
- Contraste con `lint:arch`, que sí está en CI con el argumento escrito de por qué tiene que
  estarlo.

**Impacto:** bajo y acumulativo. Es la misma clase de brecha que el propio repo ya diagnosticó
para las reglas de arquitectura y resolvió; acá quedó sin resolver para código muerto y
duplicación.

**Causa probable:** `knip` entró como reemplazo de `ts-prune` en un commit de limpieza
(`13bcc63`) y el cableado a CI no formaba parte de ese alcance.

**Nivel de certeza:** **Alta.**

**Severidad:** **Baja.**

**Recomendación (análisis, no ejecución):** si `knip` va a CI, necesita antes una línea base:
hoy reportaría 52 items y pondría el build rojo de entrada. El camino consistente con lo que
este repo ya hace en otras cercas es un allowlist declarado con motivo por entrada —igual que
`PUBLIC_ROUTES`, `CLOSURE_MOUNTS` o `EXCLUDED_FILES`— de modo que lo existente quede medido
adentro de la cerca y lo nuevo rompa. Esa es una decisión de alcance, no de esta fase.

**¿Requiere modificar código?:** No. `ci.yml` y `knip.json`. Fuera del alcance.

**Prueba necesaria:** ninguna.

---

### F11-18 — Los tamaños de pool son literales; las tres variables que parecen configurarlos solo afectan a un pool legado sin caller productivo

**Hallazgo:** el proceso abre tres clases de pool y ninguna de las dos que corren en producción
es configurable:

| Pool | `max` | Configurable | Caller productivo |
|---|---|---|---|
| Plataforma (`container.ts:55`) | **5**, literal | no | sí, todo el proceso |
| Tenant (`tenant.middleware.ts:105`) | **5**, literal | no | sí, uno por negocio activo |
| Legado (`pg.client.ts:92-96`) | `DB_POOL_MAX ?? 10` | sí | **ninguno** |

El pool legado es el único que lee `DB_POOL_MAX`, `DB_POOL_IDLE_MS` y `DATABASE_URL`, y solo se
instancia si `checkDatabaseHealth()` se llama sin argumento. El único llamador de producción es
`app.ts:220`, que **sí** le pasa `platformClient`. `knip` confirma desde el otro lado: `pgClient`,
`withTransaction` y `closeDatabasePool` figuran como exports sin uso. O sea: **tres nombres de
variable de entorno que un operador razonablemente creería que dimensionan los pools de
producción, y no dimensionan nada.**

El techo que sí es real está en otra variable, tampoco declarada: `MAX_TENANT_POOLS ?? '200'`
(`tenant.middleware.ts:60`). Con 200 pools × `max: 5` el proceso puede sostener **1000**
conexiones a Neon, más las 5 de plataforma. El comentario del LRU (`:45-51`) explica muy bien por
qué el límite existe y qué fuga evita, pero no dice nada sobre el techo de conexiones que ese
número implica del otro lado.

**Evidencia:**
- `src/container.ts:52-62` (pool de plataforma, `max: 5`, `connectionTimeoutMillis: 10_000` con
  su motivo escrito).
- `src/platform/tenant.middleware.ts:60` (`MAX_TENANT_POOLS ?? '200'`), `:103-109`
  (`max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000`).
- `src/db/pg.client.ts:5-13` (la tabla del docblock que documenta las tres variables), `:82-100`
  (el pool), `:159` (`checkDatabaseHealth(client?)`).
- `src/app.ts:220` — `checkDatabaseHealth(platformClient)`, con argumento.
- `grep -rn "checkDatabaseHealth" src --include=*.ts` sin tests → solo `app.ts` y el propio
  `pg.client.ts`.
- `npx knip` → `pgClient`, `withTransaction`, `closeDatabasePool` en "Unused exports".
- `render.yaml` no declara ninguna de las cuatro (`DATABASE_URL`, `DB_POOL_MAX`,
  `DB_POOL_IDLE_MS`, `MAX_TENANT_POOLS`).
- `NEON_SSL` **sí** está declarada (`render.yaml:46-48`) con su comentario: el `ssl:false`
  silencioso de F9-10 es un problema de valor por defecto, no de declaración.

**Impacto:** dos. (1) Ante un problema de saturación de conexiones, el knob que el docblock de
`pg.client.ts` ofrece (`DB_POOL_MAX`) no hace nada, y el que sí importaría (`MAX_TENANT_POOLS`,
o los dos `max: 5`) no está documentado como tal. (2) Con un solo tenant real el techo de 1000
conexiones es teórico, pero es el tipo de número que se descubre cuando ya es tarde.

**Causa probable:** el pool legado es anterior al modelo multi-tenant y su documentación se
conservó tal cual; los pools nuevos se escribieron con literales porque en su momento no había
motivo para parametrizarlos.

**Nivel de certeza:** **Alta** (lectura directa + `knip` desde el otro lado).

**Severidad:** **Baja** (con el volumen actual; el hallazgo es de claridad de configuración, no
de un fallo activo).

**Recomendación (análisis, no ejecución):** decidir qué pasa con el bloque legado de
`pg.client.ts` — retirarlo convierte tres variables fantasma en cero, y es la única forma de
cerrar del todo F11-02, que depende de la misma `DATABASE_URL`. Si se retira, corregir el
docblock de ese archivo, que hoy documenta como configuración del sistema algo que no lo es.
Aparte, dejar escrito en `render.yaml` el techo de conexiones que resulta de
`MAX_TENANT_POOLS × max`, aunque sea como comentario.

**¿Requiere modificar código?:** Sí si se retira el pool legado. Fuera del alcance.

**Prueba necesaria:** ninguna para la documentación. Si se retira el bloque, la suite completa
(hay tests que usan `checkDatabaseHealth()` sin argumento).

---

### F11-19 — El build copia a mano 2 de los 5 `.sql`; hoy son exactamente los 2 correctos y nada lo verifica

**Hallazgo:** `tsc` no copia archivos que no sean TypeScript, así que `package.json:11` los copia
a mano:
`rm -rf dist && tsc && cp src/db/schema.sql dist/db/schema.sql && cp src/db/platform.schema.sql dist/db/platform.schema.sql`.

En `src/db/` hay **5** archivos `.sql`. Se copian **2**. Los 2 que el runtime lee son, verificado,
exactamente esos 2: `tenant-db.setup.ts:57` resuelve `schema.sql` vía `import.meta.url`, y
`server.ts:39` resuelve `platform.schema.sql` vía `__dirname`. Los otros 3
(`seed.tenant.sql`, `seed.platform.sql`, `migrate_resource_categories.sql`) no se leen desde
código. **Está bien hoy.**

Lo que no hay es nada que lo mantenga bien. Si un cambio futuro agrega una lectura de `.sql` en
runtime, `tsc` compila, el CI pasa (el job `typecheck` corre `npm run build`, que no valida
contenidos de `dist/`), y el fallo aparece en producción como `ENOENT` en el primer request que
toque ese camino. El propio `tenant-db.setup.ts:47-49` documenta haber resuelto la mitad difícil
del problema (*"Usa import.meta.url para resolver el path de forma robusta, independientemente de
la estructura del directorio de build"*) — la mitad que falta es que el archivo exista ahí.

**Evidencia:**
- `package.json:11` — el `build` completo.
- `ls src/db/*.sql` → 5 archivos.
- `grep -rn "\.sql'" src --include=*.ts` sin tests → 3 hits, de los cuales 2 son lecturas
  (`tenant-db.setup.ts:57`, `server.ts:39`) y 1 es un mensaje de log (`server.ts:55`).
- `tsconfig.json` — sin `resolveJsonModule` ni ningún mecanismo de copia de assets.
- `.github/workflows/ci.yml`, job `typecheck` → `run: npm run build`, sin verificación posterior
  del contenido de `dist/`.

**Impacto:** ninguno hoy. Es una lista manual de dos entradas que gobierna si el aprovisionamiento
de tenants funciona en producción.

**Causa probable:** la forma más simple que funciona, agregada cuando hacía falta el primer
archivo.

**Nivel de certeza:** **Alta.**

**Severidad:** **Baja.**

**Recomendación (análisis, no ejecución):** una aserción de una línea al final del build (que
`dist/db/` contenga los `.sql` que `src/` lee), o —más barato— un test que verifique que el
conjunto de `.sql` leídos por `src/` es igual al conjunto copiado por el script de build. Es
exactamente el molde que este repo ya usa en `route-inventory-check`: regenerar y comparar.

**¿Requiere modificar código?:** No en `src/`. Fuera del alcance.

**Prueba necesaria:** la que se propone arriba, si se decide hacerla.

---

### F11-20 — El gate de checklist defensivo solo puede correr sobre el 3 % de los cambios

**Hallazgo:** `.github/workflows/pr-checklist.yml` implementa un gate serio: rechaza el PR si el
checklist de `docs/DEFENSIVE_DEVELOPING.md` no está completo en la descripción, y exige la
sub-sección multi-tenant si el PR toca `src/api/routes/`, `src/container.ts`, `src/platform/` o
`src/workers/`. Dispara únicamente en eventos `pull_request`.

En los últimos 60 días el backend registra **956 commits** y **28 merges**. O sea que el gate
puede haber intervenido, como techo, en alrededor del **3 %** de los cambios. El `CLAUDE.md` del
repo ya declara el hecho (*"buena parte del trabajo actual se commitea directo a `main` sin pasar
por PR — así que el checklist nunca se completa solo"*) y define la mitigación correcta
(responder el checklist en el mensaje de commit). Lo que esta fase aporta es el número, que no
estaba medido: la mitigación por disciplina cubre 97 de cada 100 cambios.

**Evidencia:**
- `.github/workflows/pr-checklist.yml` — íntegro; `on: pull_request`, los 4 prefijos sensibles,
  las dos validaciones.
- `git log --oneline --since='60 days ago' | wc -l` → **956**;
  `git log --merges --oneline --since='60 days ago' | wc -l` → **28**.
- `.github/pull_request_template.md` existe.
- `CLAUDE.md` de `app-main`, sección *"Developing defensivo"* — la mitigación declarada.

**Impacto:** el gate no es inútil (cubre el camino de PR cuando se usa), pero su cobertura real no
está escrita en ningún lado, y un lector de `.github/` concluiría que el checklist es obligatorio
para todo cambio. No lo es.

**Causa probable:** el workflow se escribió cuando el flujo esperado era por PR; el flujo real
cambió sin que el workflow se revisara.

**Nivel de certeza:** **Alta** para los conteos. La inferencia "28 merges ⇒ ≤28 PRs" es un techo,
no un número exacto (un merge puede no venir de un PR).

**Severidad:** **Baja.**

**Recomendación (análisis, no ejecución):** ninguna acción técnica evidente — un gate sobre
mensajes de commit sería frágil y ruidoso. Lo que sí corresponde es dejar el número escrito junto
al workflow, para que su alcance real no haya que deducirlo.

**¿Requiere modificar código?:** No. Un comentario. Fuera del alcance.

**Prueba necesaria:** ninguna.

---

### F11-21 — 14 paquetes con más de una versión en el árbol de producción del backend, todos de la cadena de descarga de Chromium; el frontend tiene 0

**Hallazgo:** el árbol de producción del backend (308 paquetes) tiene **14** nombres resueltos a
más de una versión: `yargs` (15.4.1 y 18.1.0), `yargs-parser` (18.1.3 y 22.0.0), `string-width`
(4.2.3, 7.2.0 y 8.2.2), `wrap-ansi`, `cliui`, `y18n`, `ansi-regex`, `ansi-styles`, `strip-ansi`,
`emoji-regex`, `debug` (2.6.9 de la cadena de Express y 4.4.3), `ms`, `pako` y `real-require`.

La composición es reveladora: salvo `debug`/`ms` (Express) y `real-require` (pino), **todos son
utilidades de línea de comandos y de presentación en terminal** — `yargs`, barras de progreso,
medición de ancho de caracteres — que un servidor HTTP no necesita. Entran por
`@puppeteer/browsers`, que es la maquinaria de descarga y descompresión de Chromium: un artefacto
de **build** que vive en el árbol de **producción** porque `@arcasdk/pdf` lo declara como
dependencia normal.

El frontend, en contraste, tiene **18** duplicados en total y **0** en su árbol de producción.

`zod` merece mención aparte porque es la única duplicación de una dependencia de negocio: 3.25.76
en la raíz (producción) y 4.4.3 bajo `knip` (dev). No se cruzan y no hay riesgo de que un schema
de un major se valide con el otro — `knip` es una herramienta de análisis que no comparte código
con `src/`.

**Evidencia:**
- Recorrido programático de `package-lock.json` agrupando por nombre y filtrando `dev != true`:
  **14** nombres con más de una versión, listados arriba.
- Mismo procedimiento sobre el frontend: **0**.
- `node_modules/@arcasdk/pdf/package.json` → `puppeteer` como `dependencies` (no `peer`, no
  `optional`).
- `du -sh node_modules` → **391 MB** (backend), **552 MB** (frontend); `.cache` → **652 MB**.
- Las dos copias de `zod`: `node_modules/zod` 3.25.76 (`dev: false`) y
  `node_modules/knip/node_modules/zod` 4.4.3 (`dev: true`).

**Impacto:** tamaño de imagen y tiempo de instalación en un servicio `plan: free`. No hay riesgo
funcional identificado: ninguno de los 14 es una dependencia cuyo comportamiento dependa de tener
una sola instancia (no hay singletons, ni registries globales, ni `instanceof` cruzando versiones).

**Causa probable:** consecuencia directa de F11-04 — el motor de PDF arrastra la cadena completa
de descarga de navegadores al árbol de producción.

**Nivel de certeza:** **Alta** (medición programática sobre los dos lockfiles).

**Severidad:** **Baja.**

**Recomendación (análisis, no ejecución):** nada por sí solo. Se registra porque **cuantifica**
el costo de F11-04: si alguna vez se evalúa el camino Chromium, estos 14 duplicados y los 652 MB
de caché son parte del número que hay del otro lado de la balanza.

**¿Requiere modificar código?:** No.

**Prueba necesaria:** ninguna.

---

### F11-22 — La tabla de variables cross-repo de `ARCHITECTURE.md` nombra variables de backend que no existen

**Hallazgo:** `appfrontend-main/ARCHITECTURE.md` mantiene una tabla que cruza las variables de
entorno de los dos repos — el único artefacto del proyecto que intenta eso. Sus nombres del lado
del backend son incorrectos:

| Lo que dice `ARCHITECTURE.md` | Lo que existe en `app-main` |
|---|---|
| `DATABASE_URL` — *"PostgreSQL platform DB"* (`:227`, `:38`, `:74`) | `PLATFORM_DATABASE_URL`. `DATABASE_URL` existe solo como legado sin caller (F11-18) y como la trampa de F11-02 |
| `ENCRYPTION_KEY` (`:38`) | `DB_ENCRYPTION_KEY` |

El lado del frontend de la misma tabla (`NEXT_PUBLIC_API_URL`, `:226`) **sí** es correcto, y la
regla que cierra la sección (*"ninguna variable sin prefijo `NEXT_PUBLIC_` llega al browser"*)
también.

**Evidencia:**
- `appfrontend-main/ARCHITECTURE.md:38`, `:74`, `:226-232`.
- `app-main/render.yaml:57-58` (`PLATFORM_DATABASE_URL`), `:61-64` (`DB_ENCRYPTION_KEY`).
- `app-main/src/container.ts:43` y `:122` — las dos lecturas de `PLATFORM_DATABASE_URL`.

**Impacto:** el único documento que intenta la vista cross-repo —que es justamente la razón por la
que el `CLAUDE.md` raíz manda abrir una sola sesión sobre los dos repositorios— desorienta en ese
punto. Se agrava con F11-02: un operador que lea esta tabla y crea que el backend usa
`DATABASE_URL` tiene un motivo más para setearla.

**Causa probable:** la tabla se escribió antes de la separación plataforma/tenant y nunca se
cruzó contra `render.yaml`.

**Nivel de certeza:** **Alta.**

**Severidad:** **Baja** por sí sola; sube al leerse junto con F11-02.

**Recomendación (análisis, no ejecución):** corregir los dos nombres. Es el cambio más barato de
todo este informe y elimina un insumo del error de F11-02.

**¿Requiere modificar código?:** No. Documentación. Fuera del alcance.

**Prueba necesaria:** ninguna.

---

## 3. Verificado limpio (sin hallazgo)

Se registra porque acota el alcance real de la sección anterior y porque varios de estos puntos
son, a criterio de esta fase, mejores que el promedio de un proyecto de este tamaño:

- **Secretos hardcodeados: 0** en los dos repos. El grep de credenciales sobre `render.yaml`,
  `package.json`, `.github/`, `src/scripts/`, `src/config/` y `next.config.js` no devuelve nada.
  Los 4 valores literales de `render.yaml` (`NODE_ENV`, `NODE_VERSION`, `NEON_SSL`,
  `NEON_PROJECT_ID`) son no-secretos y cada uno lleva su comentario explicando por qué está ahí y
  qué rompe si falta. Los 13 `sync: false` cubren todo lo que es credencial.
- **`render.yaml` es el mejor artefacto de configuración de los dos repos.** Cada bloque lleva
  fecha, decisión, alternativa descartada y consecuencia. El bloque de `preDeployCommand`
  (`:8-16`) cita la documentación oficial de Render y explica por qué no se usa; el de Puppeteer
  (`:26-32`) narra el bug real que lo motivó; el de superadmin (`:73-78`) dice qué error exacto
  se ve si falta cada variable. Es `decision-record-discipline` aplicada sin que nadie lo
  pidiera.
- **Alineación de versión de Node en el backend:** 4 lugares (`engines`, `render.yaml`, 3 jobs de
  CI) con el mismo valor y con el comentario cruzado en cada uno. El commit que la acotó
  (`1fcba6d`, *"acotar engines.node a 22.x para que Render no salte de version sola"*) documenta
  el motivo. Es el contraejemplo exacto de F11-12.
- **`@types/express` alineado a `express`:** `^4.17.21` contra `express@^4.21.0`, resultado de un
  downgrade deliberado (`b11ca15`, *"downgrade @types/express 5→4 to match express@4 runtime"*).
  Es la única dependencia de tipos del backend que podía desalinearse y está correctamente
  atada.
- **Separación de configs de prueba:** `vitest.config.ts` y `vitest.integration.config.ts` están
  separadas por un motivo real, verificado en su momento (el `exclude` gana sobre el path de CLI)
  y documentado en un docblock de 20 líneas que además invalida explícitamente el comando viejo
  que no funcionaba. El `testTimeout: 30_000` de la config de integración tiene su causa escrita.
- **El job `integration` no puede dar verde silencioso:** su comentario declara que `skipIfNoDb`
  ya no saltea cuando `CI=true`, y que si el job perdiera `TEST_DATABASE_URL` falla en rojo en vez
  de reportar "todo bien" habiendo corrido cero tests. Es exactamente la forma correcta de tratar
  una prueba condicional en CI.
- **El job `test` no tiene `services: postgres` y el comentario explica por qué** — la
  configuración muerta (un contenedor y un `TEST_DATABASE_URL` que ningún test de ese job usaba)
  se retiró en vez de dejarse "por las dudas", y el comentario aclara que leída desde afuera daba
  la impresión de que la integración corría. Eliminar configuración inerte y dejar constancia es
  raro y es correcto.
- **`schema-version-check`** filtra el diff de `schema.sql` para ignorar líneas de comentario,
  con el falso positivo real que lo motivó documentado, el residuo declarado (literales
  multilínea, hoy vacío) y la decisión de no usar `grep -P` explicada por portabilidad. La
  captura de `SCHEMA_DIFF` **sin** `|| true` está justificada en el propio comentario para no
  disfrazar un fallo de git como "solo comentarios". Es una cerca escrita con criterio de
  auditoría.
- **`.gitignore` de los dos repos:** cubre `.env` y `.env.local`; el del backend además excluye
  `coverage/`, `.cache/`, `.reviews/` y las skills de acceso directo a Neon, cada exclusión con
  su motivo y su fecha de decisión. El del frontend documenta en el propio archivo que `.next`
  *"faltaba, npm run build lo generaba sin ignorar"*.
- **`next.config.js` no oculta errores de build:** no tiene `typescript.ignoreBuildErrors` ni
  `eslint.ignoreDuringBuilds`, que son los dos escapes habituales. El `rewrites()` está
  documentado en 15 líneas con el problema de cookies de tercero que lo motiva y con la
  aclaración de cuál de las tres reglas es obligatoria y cuál es prolija.
- **`.puppeteerrc.cjs`** redirige el caché al directorio del proyecto con el motivo escrito
  (build y runtime en filesystems separados en Render) y el link a la documentación. Resuelve un
  problema real de forma mínima.
- **Política de fallo del `postinstall`:** `patch-package` sale con error en Render, verificado
  vía `ci-info`. Un patch roto **no** pasa silencioso.
- **Assets del build:** los 2 `.sql` copiados son exactamente los 2 leídos en runtime
  (verificado). F11-19 es sobre la falta de cerca, no sobre un error actual.
- **ESLint lintea lo que dice lintear:** 511 de 511 archivos `.ts` de `src/`, con
  `--max-warnings 0` y exit 0. El `--ext .ts` del script es inocuo en flat config; se verificó
  contando las entradas del reporter JSON, no asumiendo.
- **Ningún archivo local no versionado es requisito de ejecución:** no se encontró ningún
  `readFile`/`require` de un path absoluto, de un home de usuario ni de un archivo fuera del
  repo, en ninguno de los dos.
- **Sin dependencia que reimplemente el runtime:** se revisaron las 14 dependencias de producción
  del backend y las 6 del frontend una por una. Ninguna reemplaza algo que Node 22 o Next 16 ya
  provean.
- **Árbol de producción del frontend limpio:** 89 paquetes, **0** duplicados de versión.
- **Lockfiles en sincronía con sus manifiestos:** `npm ls --depth=0` sin `invalid`, `missing` ni
  `UNMET` en ninguno de los dos. (Los 2 `extraneous` del frontend son variantes opcionales de
  `sharp` resueltas por la plataforma de este sandbox, no divergencia del repo.)

---

## 4. No confirmado

Seis afirmaciones que esta fase **no** puede cerrar sin acceso a Render, a Vercel o al registry
más allá de la lectura. Ninguna se reporta como hallazgo confirmado.

1. **Si el `npm install` del build de Render ve o no `NODE_ENV=production` (F11-01).** Es la
   pregunta que decide cuál de las dos ramas del hallazgo es la real hoy.
   `Información faltante:` la línea `added N packages` del log de build del último deploy, y si
   el paso `migrate:tenants` produce salida.
   `Cómo verificarlo:` abrir el log de ese deploy en el dashboard de Render. Lectura pura.
2. **Si `DATABASE_URL` está seteada hoy en el servicio de Render (F11-02).** Determina si el
   endpoint `repair-tenant-db` está inerte o armado.
   `Información faltante:` la lista de variables del servicio.
   `Cómo verificarlo:` el dashboard de Render, o pegarle al endpoint desde un entorno no
   productivo con credenciales de superadmin y ver si responde `500 MISSING_DATABASE_URL`.
3. **Las versiones reales de PostgreSQL en producción (F11-07).** La única fuente es un documento
   del 08/08/2026 que declara PG 18 / PG 17 y marca el mismatch como deuda abierta.
   `Información faltante:` `SELECT version()` contra la BD de plataforma y contra una de tenant.
   `Cómo verificarlo:` dos consultas de solo lectura, o el panel de cada proyecto en Neon.
4. **La versión de Node que Vercel usa hoy para el frontend (F11-12).** El CI la replica en un
   literal `'24'` verificado a mano el 01/09/2026 contra una fuente fuera del repo.
   `Información faltante:` Settings → Node.js Version del proyecto en Vercel.
   `Cómo verificarlo:` el dashboard, o la cabecera de un log de build reciente.
5. **Si el patch de `@arcasdk/pdf` aplicaría limpio sobre la versión 0.2.1 (F11-09).** Decide si
   un re-resolve del lockfile cae en el escenario "warning" o en el escenario "build rojo".
   `Información faltante:` el contenido de `lib/generator/invoice-pdf-generator.js` en 0.2.1.
   `Cómo verificarlo:` `npm pack @arcasdk/pdf@0.2.1` en un directorio temporal fuera del repo y
   comparar; no toca el árbol.
6. **Si `@arcasdk/pdf@0.2.1` ya declara compatibilidad con puppeteer 25 (F11-04).** Cambiaría el
   análisis del `overrides` fuera de rango.
   `Información faltante:` el campo `dependencies` de esa versión.
   `Cómo verificarlo:` `npm view @arcasdk/pdf@0.2.1 dependencies`. Lectura del registry.

---

## 5. Alcance excluido de esta fase

- **No se modificó ni una línea de código, de configuración, de dependencias ni de
  documentación.** Fase de análisis, y además el rol de auditoría de este protocolo no
  implementa. `git status` quedó limpio en los dos repos, verificado al cierre.
- **No se ejecutó nada contra producción, Render, Vercel ni Neon.** Las únicas salidas de red
  fueron consultas de solo lectura al registry de npm (`npm outdated`, `npm audit`), que no
  escriben en el árbol.
- **No se instaló, actualizó ni removió ningún paquete en ninguno de los dos repos.** Las dos
  simulaciones de `npm install` corrieron sobre copias en el scratchpad de sesión, borradas al
  terminar.
- **No se re-derivaron** F9-01, F9-13, F9-14, F9-10, F7-06, B-02, B-04 ni B-05; se citan donde
  corresponde, con la corrección de conteo de `sync: false` (13, no 14) declarada en 0.1.
- **Las vulnerabilidades como problema de seguridad** quedan fuera: son alcance de la Fase 9.
  Esta fase las mira solo como propiedad del árbol de dependencias — quién las arrastra, si el
  fix está dentro del rango declarado, y qué mecanismo de actualización existe o no (F11-08).
- **El contenido de `schema.sql`, las migraciones y su aplicación** quedan fuera: alcance de la
  Fase 10. La única intersección tratada es la imagen de PostgreSQL contra la que se prueban
  (F11-07) y la copia de los `.sql` al build (F11-19).
- **La cobertura de tests como medida de calidad** queda fuera. F11-06 es sobre el **umbral y sus
  exclusiones** como artefacto de configuración, no sobre si 77,68 % es suficiente — esa pregunta
  es de otra fase.
- **No se evaluó el rendimiento** de ninguna dependencia ni el tiempo real de build en Render.
  Los tamaños citados (391 MB, 552 MB, 652 MB, 23 MB) son de disco en este sandbox.
- **No se propuso reemplazar ninguna dependencia.** Donde un hallazgo lo rozaría (F11-04: el
  camino Chromium), se documentó el costo medido y se dejó explícito que la decisión es de
  producto, sin proponer alternativa.
- **La configuración que vive fuera de los repositorios** (dashboards de Render, Vercel y Neon)
  no se consultó. Es, en sí misma, parte de tres hallazgos (F11-01, F11-02, F11-12): lo que esta
  fase puede afirmar es qué depende de ella, no qué contiene.

---

## 6. Resumen por severidad

| Severidad | ID | Título breve |
|---|---|---|
| **Alta** | **F11-01** | Tres pasos del build dependen de que el `NODE_ENV=production` declarado NO llegue al `npm install` (omisión y prune de devDependencies, medidos) |
| **Alta** | **F11-02** | `repair-tenant-db` depende de `DATABASE_URL`, no declarada y prohibida por el checklist del propio repo; con el valor "natural" aplica el schema de tenant sobre la BD de plataforma |
| **Alta** | **F11-03** | `server.ts` crea el pool de migración sin verificar `PLATFORM_DATABASE_URL`: ausente, `pg` cae a los defaults del entorno |
| **Alta** | **F11-04** | `overrides` fuerza `puppeteer` fuera del rango declarado por `@arcasdk/pdf`, y el build hace `npx` sobre un paquete no declarado |
| **Alta** | **F11-05** | El README del frontend documenta Vite y `VITE_API_URL`: reproduce el fallo silencioso contra el que advierte su propio `.env.example` |
| **Media** | **F11-06** | Umbral de cobertura 17,7 puntos por debajo del real; 8 exclusiones inexistentes y 2 archivos con test propio fuera de la medición |
| **Media** | **F11-07** | Integración contra PostgreSQL 16; producción documentada PG 18 / PG 17, con el mismatch declarado abierto desde el 08/08/2026 |
| **Media** | **F11-08** | `express@4.22.2`: fix de 2 advisories disponible dentro del rango ya declarado; ningún CI de ninguno de los dos repos corre `npm audit` |
| **Media** | **F11-09** | El patch de `@arcasdk/pdf` está anclado a `0.2.0` mientras el rango admite `0.2.1`: mismatch que aplica = solo warning |
| **Media** | **F11-10** | El backend no se levanta desde el repo: sin `.env.example`, README de otra aplicación, y una convención escrita sobre un archivo inexistente |
| **Media** | **F11-11** | `DB_ENCRYPTION_KEY_OLD`: el runbook de rotación exige una variable que `render.yaml` no menciona |
| **Media** | **F11-12** | El frontend no declara la versión de Node en ningún archivo versionado; vive en el dashboard de Vercel y se replica a mano |
| **Media** | **F11-13** | `npm install` (no `npm ci`) en los 6 puntos del pipeline del backend: el lockfile no es contrato en ninguno |
| **Media** | **F11-14** | `vitest` 3 (backend) vs 4 (frontend); `@vitest/coverage-v8` acoplado a mano al major |
| **Baja** | **F11-15** | `typescript` (23 MB) en `dependencies` sin consumidor, fósil de un fix de deploy de junio |
| **Baja** | **F11-16** | 3 devDependencies del frontend sin uso, sin config y sin script (`dependency-cruiser`, `jscpd`, `ts-prune`) |
| **Baja** | **F11-17** | `knip` y `jscpd` instalados en el backend y fuera de todo job de CI |
| **Baja** | **F11-18** | Pools con `max` literal; `DATABASE_URL`/`DB_POOL_MAX`/`DB_POOL_IDLE_MS` solo configuran un pool legado sin caller |
| **Baja** | **F11-19** | El build copia a mano 2 de los 5 `.sql`; correcto hoy, sin cerca |
| **Baja** | **F11-20** | El gate de checklist defensivo alcanza, como techo, el 3 % de los cambios (28 merges / 956 commits en 60 días) |
| **Baja** | **F11-21** | 14 duplicados de versión en el árbol de producción del backend, todos de la cadena de descarga de Chromium |
| **Baja** | **F11-22** | La tabla cross-repo de `ARCHITECTURE.md` nombra `DATABASE_URL` y `ENCRYPTION_KEY`, que no existen |

**Total: 22 hallazgos** — 0 críticos, 5 altos, 9 medios, 8 bajos.

**Clasificación por tipo** (regla 5 del protocolo):

- **Bug de configuración/entorno:** F11-01, F11-02, F11-03, F11-11, F11-12, F11-13, F11-18
- **Bug de implementación:** F11-02 (el handler en sí), F11-03 (la guarda faltante)
- **Dependencia externa:** F11-04, F11-08, F11-09, F11-21
- **Prueba insuficiente:** F11-06 (el umbral no cerca nada), F11-07 (se prueba contra otro motor),
  F11-20 (el gate alcanza el 3 %). Transversal: **no existe ninguna prueba que ejercite la
  generación de un PDF real**, lo que deja F11-04 y F11-09 sin forma de detectarse antes de
  producción
- **Deuda técnica:** F11-14, F11-15, F11-17, F11-19
- **Código muerto:** F11-18 (el pool legado y sus 3 exports sin caller), F11-16 (3 devDeps del
  frontend)
- **Documentación desactualizada:** F11-05, F11-10, F11-22
- **Requisito ambiguo / decisión de negocio pendiente:** si el `npm audit` en CI debe fallar o
  solo informar (F11-08); si el camino Chromium para el PDF fiscal se conserva (F11-04); si
  `repair-tenant-db` se retira o se blinda (F11-02); si los dos repos convergen a un major común
  de vitest (F11-14)

**Los cinco hallazgos altos comparten una causa de fondo:** *la configuración efectiva de este
sistema no vive en sus repositorios.* Vive en dos dashboards (Render, Vercel), en el
comportamiento no documentado de `npm` ante una variable declarada para otra cosa, en un
`node_modules` cacheado, y en tres documentos que describen tres sistemas anteriores. Cada uno de
los cinco es el punto donde algo del repositorio **depende** de algo que el repositorio no puede
ver ni verificar: F11-01 depende de una propiedad del shell de build, F11-02 de qué escriba un
operador en un campo de texto, F11-03 de que exista o no un postgres en `localhost`, F11-04 de que
`@arcasdk/pdf` siga tolerando un major que no declara, F11-05 de que nadie siga las instrucciones
del README.

El contraste dentro del mismo proyecto es la mejor evidencia de que esto es corregible y no
estructural: `render.yaml` —donde la configuración **sí** está en el repositorio— es el artefacto
mejor documentado de los dos repos, con fecha, motivo y consecuencia por cada línea. Los cinco
hallazgos altos están, sin excepción, en el terreno que ese archivo no cubre.
