# Auditoría técnica integral — Fase 13: revisar pruebas

Fecha: 16/09/2026
Repos: `app-main` (backend, `/home/user/app`, HEAD `aa248a9`, rama `main`, **17 commits sin pushear**, árbol limpio) · `appfrontend-main` (frontend, `/home/user/appfrontend`, HEAD `3bc77f5`, rama `main`, **3 commits sin pushear**, árbol limpio)
`origin/main` backend: `2b005fa` (15/09/2026 11:02 UTC) · `origin/main` frontend: `b43f7e5`
Fase previa: `docs/auditoria-integral-fase12-2026-09-16.md`
Alcance: inventario y clasificación completa de la suite de pruebas real de ambos repos, calidad de esas pruebas (mocks, aserciones, fragilidad, orden-dependencia, duplicación), huecos de cobertura en áreas críticas de negocio, diferencias entre pruebas y producción, y propuesta de pruebas de caracterización para módulos que un refactor tocaría.

**Cero cambios de código, configuración o dependencias en ninguno de los dos repos.** Se verificó con `git status --porcelain` al final: los dos árboles quedaron limpios. Todo lo que se ejecutó fue de solo lectura sobre los repos (suites de test, lint, coverage — `coverage/` está en `.gitignore`), más un PostgreSQL 16.13 local efímero y un **clon del repo en scratchpad** (`/tmp/.../scratchpad/appfork`) para hacer bisección sin tocar el árbol real.

**Criterio de severidad de esta fase, declarado antes de los hallazgos.** El protocolo pide explícitamente *"no conviertas automáticamente el comportamiento actual en comportamiento correcto"* y distinguir bug de deuda. En consecuencia: severidad **Crítica** solo donde hay una **falla reproducida** que hoy deja sin validar un invariante financiero o de concurrencia declarado por el propio repo; **Alta** donde hay un hueco medido que produce **verde falso** (la suite pasa y el riesgo sigue vivo); **Media** para fragilidad y calidad; **Baja** para higiene. Un test que usa mocks no es automáticamente un hallazgo — el repo declara por escrito cuándo lo hace a propósito y lo respeto.

---

## 0. Método y criterio

### 0.1 Qué NO se re-deriva

- **Fase 9 (seguridad)** — ya inventarió las siete cercas automatizadas (RBAC ×5, contrato OpenAPI, catálogo de roles). **No se re-describe qué hace cada una.** Acá aparecen solo como filas del inventario (§1.3) y como material de un hallazgo nuevo de *fragilidad* (F13-11) y de *señal ignorada* (F13-15).
- **Fase 10 (datos/BD)** — midió `schema.sql` y migraciones contra Postgres real. No se re-mide. La pregunta nueva de esta fase es **si existe alguna prueba automatizada que cubra ese comportamiento**: F13-09 responde que no, y lo demuestra reproduciendo la falla del camino de upgrade.
- **Fase 11 (dependencias)** — ya registró el drift de thresholds de cobertura y el mismatch de versión de PostgreSQL CI-vs-producción (**F11-07**: CI `postgres:16-alpine`, producción documentada PG 18/17). **Se cita, no se re-explica.** El aporte nuevo es medir la calidad de lo que sí está cubierto (§2) y qué queda fuera del denominador (F13-12).
- **Fase 12 (rendimiento)** — ya registró que **no existe ninguna prueba de rendimiento** en el repo. Se cita al clasificar esa categoría como vacía (§1.2); no se repite como hallazgo.

### 0.2 Entorno de verificación

| Elemento | Valor |
|---|---|
| Node | v22.22.2 |
| PostgreSQL local | 16.13 (Ubuntu), `pg_ctlcluster 16 main`, efímero, arrancado y usado solo para esta fase |
| `TEST_DATABASE_URL` usado | `postgres://postgres:postgres@127.0.0.1:5432/postgres` |
| vitest backend | 3.x (`vitest run`) |
| vitest frontend | 4.1.11 |
| Clon de bisección | `/tmp/.../scratchpad/appfork` (`git clone /home/user/app`), `node_modules` por symlink al repo real |

Al terminar se dropeó la BD auxiliar `f13_upgrade`; el `CREATE/DROP DATABASE` de la propia suite dejó **0 bases `test_*` huérfanas** (verificado con `select count(*) from pg_database where datname like 'test_%'`).

### 0.3 Comandos ejecutados (todos reproducibles)

```
cd /home/user/app
npx vitest run                                              # unitarios
npx vitest run --coverage                                   # cobertura
npx vitest run --sequence.shuffle --sequence.seed=<N>        # orden aleatorio (seeds 1,2,3,7,99,2026,12345)
TEST_DATABASE_URL=... npx vitest run --config vitest.integration.config.ts
npx jscpd src --pattern "**/*.test.ts" --min-lines 25 --min-tokens 150
npm run lint
cd /home/user/appfrontend && npm run test:unit && npm run test:visual
curl https://api.github.com/repos/Alejandro-Gabriel-Pozo/app/actions/runs?branch=main
```

---

## 1. Inventario completo y clasificado

### 1.1 Conteo real (medido, no estimado)

| Repo / suite | Archivos | Tests | Resultado medido hoy |
|---|---:|---:|---|
| `app-main` — unitarios (`npm test`, `vitest.config.ts`) | **174** | **2 433** | 2 432 pasan · 1 `todo` · 1 archivo solo-todo |
| `app-main` — integración (`npm run test:integration`) | **47** | **380** | **223 pasan · 153 FALLAN · 4 `todo`** |
| `appfrontend-main` — vitest (`npm run test:unit`) | **2** | **25** | 25 pasan |
| `appfrontend-main` — `node --test` (`npm run test:visual`) | **2** | **34** | 34 pasan |
| **Total** | **225** | **2 872** | |

Archivos `*.test.ts` totales en `app-main/src`: **221** (174 que corren por defecto + 47 de integración, que `vitest.config.ts:18-21` excluye siempre).

Distribución de los 2 433 unitarios por módulo:

| Módulo | Tests | Archivos | | Módulo | Tests | Archivos |
|---|---:|---:|---|---|---:|---:|
| `reservas` | 372 | 23 | | `usuarios-roles` | 82 | 5 |
| `facturacion` | 318 | 16 | | `security` | 81 | 10 |
| `pos-menu` | 302 | 16 | | `tests/domain` | 80 | 7 |
| `clientes-finanzas` | 282 | 15 | | `tests/architecture` | 32 | 10 |
| `platform` | 219 | 23 | | `repositories` | 29 | 3 |
| `workers` | 157 | 7 | | `tests/security` | 26 | 5 |
| `api` | 155 | 14 | | `tests/repositories` | 26 | 2 |
| `pms-estadias` | 107 | 8 | | `services` | 23 | 1 |
| `business-context` | 93 | 4 | | `domain` / `email` / `db` | 23/16/10 | 3/1/1 |

### 1.2 Clasificación por las 9 categorías del protocolo

| Categoría | Existe | Dónde | Volumen medido |
|---|---|---|---|
| **Unitarias** | Sí | `src/**/*.test.ts` fuera de `src/tests/{architecture,security}/` y de `integration/` | ~2 375 tests, 159 archivos |
| **Integración** | Sí (hoy roja) | `src/tests/integration/**` | 380 tests, 47 archivos, Postgres real por BD temporal |
| **Contratos** | Parcial | `src/tests/architecture/openapi-spec-route-sync.test.ts` (6 tests) — solo EXISTENCIA de path+método, no request/response. `roles-catalog-sync.test.ts` (2) congela el catálogo de roles pero **no verifica el otro repo** | 8 tests |
| **End-to-end** | **NO** | Ningún test arranca `createApp()`. Solo 2 archivos levantan un `app.listen(0)` con harness Express propio (`rate-limit.middleware.test.ts:41`, `customer-token-staff-route-ownership.integration.test.ts:315`) | 0 E2E reales |
| **Regresión** | Sí, informal | Marcados por incidente en el docblock: `schema-redeploy-idempotent` (28/08), `financial-transaction.integration` (23/08), `charge-uniqueness`, `orders-stamp-columns`, `reversed-invoice-id-convention` | ~15 archivos con ancla de incidente |
| **Seguridad** | Sí | `src/security/**` (81), `tests/security/` funcional (20) + 7 cercas (RBAC ×5 + OpenAPI + catálogo de roles, 21 tests), `customer-portal-ownership.integration` | ~125 tests |
| **Rendimiento** | **NO** (0) | — | Ya registrado en Fase 12; `autocannon` y `@types/autocannon` están en `devDependencies` y **no los usa ningún test** |
| **Migraciones** | Casi nada | `schema-redeploy-idempotent.integration.test.ts` (2 tests) + `platform-schema.integration.test.ts` (29). `migrations/NNN_*.sql` es histórico y declarado no-aplicado (`migrations/README.md:1`) — correcto que no tenga tests. `migrate-tenants.ts`: **0 %** de cobertura, 0 tests | 31 tests, ninguno del camino de *upgrade* |
| **Smoke tests** | **NO** | `render.yaml:35` declara `healthCheckPath: /health` y no hay ninguna prueba que lo ejercite end-to-end. `src/db/health-cache.test.ts` (10) prueba el caché en aislamiento | 0 |

### 1.3 Las 7 cercas estáticas (solo inventario — Fase 9 ya las describió)

`api-auth-gate-order` (3) · `customer-portal-ownership-guard` (3) · `credit-note-escape-containment` (5) · `rbac-matrix-public-routes-sync` (3) · `rbac-matrix-section2-sync` (4) · `rbac-matrix-sync` (3) · `rbac-route-coverage` (1) · `openapi-spec-route-sync` (6) · más `build-credit-note-throw-catalog` (2), `lock-order` (1), `reversed-invoice-id-convention` (1), `schema-line-anchor-drift` (4). **11 de esos 12 archivos leen código fuente con `readFileSync` + regex**, no como módulo.

---

## 2. Hallazgos verificados

### F13-01 — CRÍTICO. La suite de integración está ROJA en HEAD y en `origin/main`: 153 de 380 tests fallan; CI lo confirma desde el 15/09/2026

```
Hallazgo:
`npm run test:integration` contra PostgreSQL real falla en 153 de 380 tests
(23 de 47 archivos) en el HEAD local `aa248a9` y en `origin/main` `2b005fa`.
La causa única es el índice `uq_resources_name` agregado por `073a8d4`
(schema v59, 15/09/2026) contra un harness de seeds que genera SIEMPRE el
mismo nombre de recurso. El job `integration` de GitHub Actions está en
`failure` por exactamente ese paso.

Evidencia:
1. Corrida local en HEAD (`aa248a9`), PostgreSQL 16.13:
     TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
       npx vitest run --config vitest.integration.config.ts
     → Test Files  23 failed | 24 passed (47)
       Tests  153 failed | 223 passed | 4 todo (380)
2. 145 de las 153 fallas tienen el MISMO mensaje, agregado del log:
     error: duplicate key value violates unique constraint "uq_resources_name"
   con stack `seedResource src/tests/integration/helpers/seed.ts:101` en
   todas. Las 8 restantes son fallas derivadas del mismo `beforeAll`.
3. Causa exacta:
   - `src/db/schema.sql:4299-4301`
       CREATE UNIQUE INDEX IF NOT EXISTS uq_resources_name
         ON resources (upper(btrim(name)))
         WHERE active = TRUE AND deleted_at IS NULL;
   - `src/tests/integration/helpers/seed.ts:90`
       const name = overrides.name ?? 'Habitación 101';
   - Medido: hay **55 llamadas a `seedResource(` en `src/tests/integration`
     y CERO de ellas pasa `name:`** (`grep -rn "seedResource(" | grep -v "name:"`
     devuelve las mismas 55). El segundo recurso de cada archivo colisiona.
4. Bisección reproducida en un CLON en scratchpad (no en el repo real):
   - En `073a8d4^` (= `089ca3e`):  Test Files 44 passed (44) · Tests 367 passed (367)
   - En `073a8d4` exacto:          Test Files 23 failed | 21 passed (44) · Tests 151 failed | 216 passed (367)
   Un solo commit convierte 0 fallas en 151.
5. CI real (GitHub Actions, API pública):
     run 34961977304 · head_sha 2b005fa · created 2026-09-15T11:11:50Z
     conclusion: failure
     jobs: typecheck ✓ · schema-version-check ✓ · lint ✓ · test ✓ ·
           route-inventory-check ✓ · integration ✗ (step "Run integration tests" failure)
6. `073a8d4` ESTÁ pusheado (`git merge-base --is-ancestor 073a8d4 origin/main` → sí)
   y después se pushearon 10 commits más encima, con la suite ya roja.

Impacto:
Todo el cuerpo de evidencia de concurrencia, atomicidad y dinero que este
repo declara como su estándar de cierre está hoy sin ejecutar. Los 23
archivos caídos incluyen los que sostienen:
  - reservation.service.integration (21/22 caídos) — locks de disponibilidad
  - cancellation-refund.integration (18/19) — reembolso + idempotencia
  - consolidated-invoice-toctou (20/21) — TOCTOU de factura consolidada
  - credit-note-cap / -pair-cap / -cap-service / -compensation (28 caídos) — topes de NC
  - accounts-receivable-invoice-linkage (16/17), reverse-transfer (7/8),
    city-ledger-outstanding (5/7), customer-account-payment (4/5) — cuenta corriente
  - refund-issued-race, reservation-cancel-invoice-toctou — carreras
Sobreviven verdes: outbox-worker (45), order-flow, order-effects,
charge-uniqueness, order-cancel-invoice-toctou, for-key-share-lock-semantics,
platform-schema, schema-redeploy-idempotent.
El riesgo NO es que el índice esté mal (la decisión de negocio es correcta y
está gateada): es que el único mecanismo que re-verifica los invariantes
financieros en cada commit está apagado, y se siguió pusheando encima.

Causa probable:
Bug de prueba (harness), no de producción. Se compone de dos cosas:
 (a) `seed.ts` nunca aleatorizó el nombre — el aislamiento entre tests se
     apoyaba solo en UUIDs, y `name` no era único hasta v59;
 (b) el commit que agregó el índice declaró explícitamente, en su propio
     mensaje y en `docs/pendientes-2026-09-12.md:48-51`, que "el índice único
     parcial `uq_resources_name` nunca corrió contra Postgres real; solo se
     ejercitó el catch del 23505 con un mock" — el residuo estaba REGISTRADO
     y aun así el commit se pusheó sin correr la suite que sí podía verlo.

Nivel de certeza:
Confirmado — reproducido localmente, bisectado a un commit exacto en un clon
aparte, y corroborado de forma independiente por el job de CI en GitHub.

Severidad: CRÍTICA

Recomendación:
Arreglar el harness, no el índice. Un cambio de una línea en
`src/tests/integration/helpers/seed.ts:90` que haga el default único por
llamada (p. ej. `Habitación ${randomUUID().slice(0,8)}`) restaura los 153
tests sin tocar ninguna aserción ni el schema. Verificar después que ningún
test dependa del literal 'Habitación 101' (medido: 0 aserciones lo usan;
los 55 call sites solo lo reciben por default). Es un bloque chico y
reversible, y debería ir ANTES de cualquier otro trabajo sobre estos
dominios, porque hoy ninguna regresión financiera se detecta.

¿Requiere modificar código?: SÍ — 1 línea en el helper de tests. Ningún
cambio en `src/` de producción ni en `schema.sql`.

Prueba necesaria:
TEST_DATABASE_URL=... npm run test:integration  → 380 tests, 0 fallas.
Y un test nuevo que ancle la propiedad del harness: dos llamadas seguidas a
`seedResource(db, catId)` sobre la misma BD no deben colisionar.
```

---

### F13-02 — ALTO. El aislamiento entre tests de integración es estructuralmente frágil: 46 de 47 archivos comparten UNA base por archivo, sin limpieza entre tests

```
Hallazgo:
El harness crea UNA base temporal por ARCHIVO en `beforeAll` y la comparte
entre todos los `it()` de ese archivo. No hay `TRUNCATE` ni rollback entre
tests. El aislamiento depende por completo de que cada fixture use un UUID
aleatorio — supuesto que ya se rompió (F13-01) y que se rompe también con
fixtures de id fijo.

Evidencia:
- 46 de 47 archivos de `src/tests/integration` usan `beforeAll` con
  `createTestDatabase()`; 0 crean la BD por test.
- `grep -rln "TRUNCATE" src/tests/integration --include="*.test.ts"` → 0 archivos.
- Solo 13 de 47 archivos tienen algún `beforeEach`/`afterEach`.
- `src/tests/integration/helpers/db.ts:127-167` — `createTestDatabase()`
  crea `test_<uuid>`, aplica schema.sql, devuelve el cliente. No expone
  ninguna utilidad de limpieza.
- Demostrado sobre la BASELINE LIMPIA (clon en `073a8d4^`, donde la suite
  está 367/367 verde en orden natural):
    --sequence.shuffle --sequence.seed=4242 → 2 failed (367)
      · event-envelope-idempotency.integration.test.ts:160
        `expect(await repo.claim(eventId, 'financial:reservation.confirmed'))`
        → expected true, received false  (otro test ya reclamó ese eventId)
      · platform-schema.integration.test.ts:74
        `expect(rows).toHaveLength(6)` → received 7  (otro test insertó el 7.º módulo)
    --sequence.shuffle --sequence.seed=11  → 2 failed (otros dos)
    --sequence.shuffle --sequence.seed=777 → 4 failed
  Reproducible, no intermitente: mismo seed, mismo resultado.

Impacto:
Dos consecuencias distintas. (1) Los tests de integración no son
independientes: el resultado depende del orden, así que un verde no prueba
que cada test pase por sí mismo. (2) Es el mecanismo exacto que amplificó
F13-01: cualquier constraint de unicidad nueva sobre una columna NO-uuid
convierte un cambio de schema correcto en 150 fallas. La lección no es
"agregar menos constraints", es que el harness no aisla.

Causa probable:
Deuda técnica de diseño del harness, decidida por costo: crear+migrar una
BD por test multiplicaría el tiempo de la suite (hoy ~30 s para 47 bases;
por test serían ~380). La decisión es razonable — lo que falta es la
contraparte: fixtures únicas por construcción o limpieza declarada.

Nivel de certeza:
Confirmado — reproducido con 3 seeds distintos sobre un árbol donde la
suite está verde en orden natural.

Severidad: ALTA

Recomendación:
No rediseñar el harness. Dos medidas chicas: (a) que TODO default de
`seed.ts` sea único por construcción (cierra F13-01 y esta clase entera);
(b) que los dos archivos con estado global compartido —`platform-schema`
(catálogo de módulos) y `event-envelope-idempotency` (`processed_events`)—
usen ids derivados del nombre del test o un `beforeEach` que limpie su
propia tabla. Es la corrección mínima que hace la suite orden-independiente.

¿Requiere modificar código?: SÍ — solo archivos de test/helpers.

Prueba necesaria:
`npm run test:integration -- --sequence.shuffle` verde con al menos 5 seeds
distintos. Idealmente, dejar `--sequence.shuffle` fijo en el job de CI: si
la suite es realmente independiente, no cuesta nada, y si no lo es, se
entera el día que se rompe y no meses después.
```

---

### F13-03 — ALTO. Un test unitario depende del orden: `tenant-db.setup.test.ts` falla con 2 de 6 seeds de shuffle por un `mockImplementation` permanente que nadie restaura

```
Hallazgo:
`src/platform/tenant-db.setup.test.ts` comparte un `queryMock` a nivel de
`describe`. El último test lo sobrescribe con `mockImplementation()`
(permanente), y el `beforeEach` solo hace `mockClear()` — que limpia las
llamadas pero NO la implementación. Si el orden de ejecución pone ese test
antes del primero, el primero recibe la implementación del último y falla.

Evidencia:
- `src/platform/tenant-db.setup.test.ts:214-217` — implementación original
  compartida: `if (sql.includes('SELECT MAX')) return { rows: [{ max: 51 }] };`
- `:225-229` — `beforeEach(() => { vi.resetModules(); queryMock.mockClear(); ... })`
  → `mockClear()`, no `mockReset()`.
- `:312-316` — el test "si SELECT MAX() devuelve null ... cae a
  CURRENT_SCHEMA_VERSION" hace `queryMock.mockImplementation(async (sql) =>
  { if (sql.includes('SELECT MAX')) return { rows: [{ max: null }] }; ... })`
  — permanente, nunca restaurado.
- `src/platform/tenant-db.setup.ts::applyTenantSchema()` cierra con
  `return result.rows[0]?.max ?? CURRENT_SCHEMA_VERSION;` → con `max: null`
  devuelve 59 en vez de 51.
- Reproducción (solo ese archivo):
      npx vitest run src/platform/tenant-db.setup.test.ts --sequence.shuffle --sequence.seed=3     → 1 failed | 19 passed
      ... --sequence.seed=12345                                                                     → 1 failed | 19 passed
      ... --sequence.seed=1  /  --sequence.seed=2                                                   → 20 passed
  Falla exacta:
      FAIL tenant-db.setup.test.ts > applyTenantSchema > corre schema.sql, registra ...
      AssertionError: expected 59 to be 51
      ❯ src/platform/tenant-db.setup.test.ts:300:21
- Suite completa: con seed 12345 el run entero queda en `1 failed | 2431 passed`.
  Con seeds 7, 99, 2026 y con shuffle sin seed: 2432 passed. O sea: 1 de
  2 433 tests es orden-dependiente, no una clase difusa.
- Barrido del mismo patrón en todo el repo: solo 2 archivos combinan
  `mockImplementation()` permanente con hooks que solo hacen `mockClear()`
  — este y `src/platform/tenant.middleware.test.ts`.
- `vitest.config.ts` NO declara `clearMocks`, `restoreMocks` ni `mockReset`
  (grep vacío), así que no hay red global.

Impacto:
Acotado pero real: el test afectado es la cerca eléctrica que obliga a que
bumpear `CURRENT_SCHEMA_VERSION` sea un acto consciente. Un falso rojo ahí
se lee como "la cerca de schema está rota" y entrena a ignorarla — el modo
de falla que el propio repo documenta en otros lados.

Causa probable:
Prueba insuficiente (higiene de mocks), no bug de producción.

Nivel de certeza:
Confirmado — reproducible de forma determinista con seeds 3 y 12345.

Severidad: ALTA (por el rol del test, no por el volumen)

Recomendación:
Cambiar `queryMock.mockClear()` por `mockReset()` + re-instalar la
implementación base en el `beforeEach`, o usar `mockImplementationOnce` en
el test de `max: null`. Evaluar aparte si conviene `restoreMocks: true` en
`vitest.config.ts` — es un cambio de alcance global, decisión propia.

¿Requiere modificar código?: SÍ — solo el archivo de test.

Prueba necesaria:
`npx vitest run --sequence.shuffle --sequence.seed=3` y `=12345` verdes.
```

---

### F13-04 — ALTO. Ningún test ejercita `createApp()`: la regla 3 del propio `DEFENSIVE_DEVELOPING.md` no se cumple a nivel de sistema

```
Hallazgo:
`docs/DEFENSIVE_DEVELOPING.md:28-32` manda: "Testear el wiring real, no solo
la lógica en aislamiento. Un test que arma sus propias dependencias a mano
(mocks, pools de test ad hoc) puede pasar en verde mientras el código de
producción (`createApp()`, los routers reales) está roto. **Al menos un test
de humo debe pasar por el mismo camino que usa producción.**"
No existe ese test.

Evidencia:
- `grep -rn "createApp" src` → 4 hits fuera de `app.ts`:
    src/server.ts:22,65               (producción)
    src/scripts/generate-route-inventory.ts:226,230  (script de docs)
  y CERO en cualquier `*.test.ts`.
- `grep -rln "from '../app|from './app.js'" --include="*.test.ts" src` → vacío.
- `supertest` no está en `package.json` (`grep -c supertest package.json` → 0)
  y 8 archivos de test lo documentan explícitamente ("este repo no tiene
  supertest"), p. ej. `src/reservas/categories.routes.test.ts:7`,
  `src/platform/tenant-isolation.test.ts:18`.
- Los únicos 2 archivos que levantan HTTP real arman su propio Express:
    `src/api/middleware/rate-limit.middleware.test.ts:41` → `app.listen(0)`
    `src/tests/integration/customer-token-staff-route-ownership.integration.test.ts:315`
      → `app.listen(0)`, con docblock en `:20-21` explicando por qué NO usa `createApp()`.
- `vitest.config.ts:33-35` excluye `src/app.ts`, `src/container.ts` y
  `src/server.ts` de la MEDICIÓN de cobertura, así que el hueco tampoco
  aparece como 0 % en el reporte.
- Consecuencia medida: el orden del gate de autenticación en `app.ts` está
  vigilado únicamente por `src/tests/architecture/api-auth-gate-order.test.ts`,
  que es `readFileSync` + regex sobre el texto del archivo — su propio
  docblock declara "No es un parser: ... Un mount armado de forma indirecta
  ... es invisible".
- El patrón dominante de test de ruta es: extraer el handler del
  `router.stack` y llamarlo con un `req`/`res` falsos
  (`src/reservas/reservations.routes.test.ts:41-48`, `getHandler()`). Eso
  nunca ejercita: el orden de middlewares, `tenantMiddleware`,
  `authenticate()`, `helmet`, CORS, el rate limiter, el error middleware
  montado, ni la serialización real de la respuesta.

Impacto:
El ensamblado de producción —el punto exacto donde este repo ya tuvo
incidentes (pools mezclados, gate de auth, mounts) — no tiene ninguna
prueba de humo. Además no hay smoke test contra un entorno desplegado pese
a que `render.yaml:35` declara `healthCheckPath: /health`.

Causa probable:
Deuda técnica declarada: la ausencia de supertest está anotada en 8
archivos como decisión ("sin sumar dependencias nuevas"), pero la
alternativa que la regla 3 exige nunca se construyó.

Nivel de certeza:
Confirmado.

Severidad: ALTA

Recomendación:
No agregar supertest si no se quiere: `createApp()` ya está exportada y el
patrón `app.listen(0)` + `fetch` nativo ya se usa dos veces en el repo. Un
único archivo `src/tests/integration/app-smoke.integration.test.ts` que
arranque `createApp()` y verifique 4 cosas alcanza para cerrar la regla 3:
  (1) `GET /health` → 200;
  (2) `GET /api/<cualquier ruta protegida>` sin token → 401 (gate de tenant);
  (3) un `DomainError` conocido → el status que declara `error.middleware.ts`;
  (4) `GET /openapi.json` NO existe con `NODE_ENV=production`.
Es aditivo, no toca producción, y es la prueba de caracterización natural
de `app.ts` (ver §5).

¿Requiere modificar código?: SÍ — un archivo de test nuevo. Nada en `src/`.

Prueba necesaria: el archivo mismo.
```

---

### F13-05 — ALTO. Los reportes de gerencia no tienen ninguna prueba contra SQL real, y encima `src/services/**` está excluido de la medición de cobertura

```
Hallazgo:
`ReportService` orquesta 7 agregaciones financieras y operativas. Su test
(`src/services/report.service.test.ts`, 23 tests) reemplaza TODOS los
repositorios por fakes en memoria, así que valida la orquestación y nunca
el SQL. Ninguna de esas consultas se ejecuta jamás contra PostgreSQL. Y
`vitest.config.ts:30` excluye `src/services/**` de la cobertura, así que
el hueco no aparece en ningún número.

Evidencia:
- `src/services/report.service.ts` — 295 líneas; `report.service.test.ts` — 512.
- `src/services/report.service.test.ts:19-30` — `FakeAccountsReceivableRepository`,
  `FakeMaintenanceWindowRepository`, etc. ("Fake mínimo — solo lo que
  ReportService llama").
- Búsqueda de cada método de reporte en `src/tests/integration`:
    getReportByPeriod → 0 · getSalesByProduct → 0 · getTicketSummary → 0
    getWasteReport → 0 · getNewVsRecurringReport → 0 · getOccupancyStats → 0
    getAppliedRateReport → 0
- Búsqueda en TODA la suite (`*.test.ts`): `getSalesByProduct`,
  `getTicketSummary` y `getNewVsRecurringReport` aparecen ÚNICAMENTE en
  `report.service.test.ts` (o sea: solo como fake).
  `getOccupancyStats` y `getAppliedRateReport` no aparecen en ningún test.
- Las implementaciones reales viven en rangos que el reporte de cobertura
  marca sin ejecutar: `src/pos-menu/sql.order.repository.ts:467`
  (`getSalesByProduct`) y `:508` (`getTicketSummary`) — el archivo mide
  41,92 % de líneas, con `509-530, 533-565` entre los rangos no cubiertos.
- `vitest.config.ts:30` → `'src/services/**'` dentro de `coverage.exclude`.

Impacto:
Un error de JOIN, de rango de fechas o de agrupación en cualquiera de esos
7 reportes produce un número equivocado en la pantalla de gerencia y no
existe ningún mecanismo automático que lo detecte. Es exactamente la clase
de defecto que un fake en memoria no puede ver, porque el fake devuelve lo
que el test le puso.

Causa probable:
Prueba insuficiente. La exclusión de `src/services/**` de la cobertura está
comentada en el config como "infra / sin tests todavía" — hoy esa
descripción ya no es cierta (el archivo tiene 23 tests) y la exclusión
quedó tapando el hueco real, que es el SQL, no el servicio.

Nivel de certeza:
Confirmado.

Severidad: ALTA

Recomendación:
Un `reports.integration.test.ts` que siembre un escenario chico y conocido
(2 órdenes, 1 desperdicio, 2 clientes uno nuevo y uno recurrente) y afirme
el número exacto de cada reporte. Y sacar `src/services/**` del
`coverage.exclude`, o actualizar el comentario para que diga la verdad.

¿Requiere modificar código?: SÍ — un archivo de test nuevo + 1 línea de config.

Prueba necesaria: la descrita arriba, con cifras exactas, no `toBeDefined()`.
```

---

### F13-06 — ALTO. Caja (`cash_register`) no tiene ninguna prueba contra Postgres real

```
Hallazgo:
El circuito de caja —apertura de turno, cobros en efectivo, cierre,
recuento y diferencia— se prueba solo con repositorios/mocks. No hay ningún
archivo de integración que lo toque.

Evidencia:
- Tests existentes: `src/clientes-finanzas/cash-register.service.test.ts`
  (10 tests), `cash-register.routes.test.ts` (4 `vi.mock`),
  `sql.cash-register-shift.repository.test.ts` (9 tests, mock de `db.query`).
- `ls src/tests/integration | grep -ci cash-register` → 0.
- Barrido por dominio sobre `src/tests/integration` (0 archivos cada uno):
  cash-register, housekeeping, maintenance, report, product, recipe, waste,
  rate-catalog, customer-rate, bookable-service, resource-lock,
  business-profile, password-reset, user-invitation, role, google-oauth.
  Con integración: stay (1), audit-log (1).

Impacto:
Caja es dinero físico y el punto donde un ERP acumula diferencias. La
concurrencia (dos cajeros, un turno), la unicidad del turno abierto y el
cálculo de la diferencia al cierre dependen de constraints y locks reales
que ningún test ejecuta. El mismo repo ya adoptó el estándar contrario para
órdenes y facturación (topes, TOCTOU, FOR UPDATE, todo contra Postgres
real) — caja quedó afuera.

Causa probable:
Deuda técnica de cobertura, por orden de construcción: los circuitos que
recibieron auditoría financiera sí recibieron integración.

Nivel de certeza:
Confirmado.

Severidad: ALTA

Recomendación:
Un `cash-register.integration.test.ts` con al menos: (a) dos aperturas de
turno concurrentes → un solo turno abierto; (b) cobro en efectivo dentro
del turno y suma esperada al cierre; (c) cierre con recuento distinto →
diferencia registrada, no silenciada. Es el mismo molde que ya existe en
`charge-uniqueness.integration.test.ts`.

¿Requiere modificar código?: SÍ — un archivo de test nuevo.

Prueba necesaria: la descrita.
```

---

### F13-07 — ALTO. El frontend tiene 25 tests de producto sobre 131 archivos fuente, y probar componentes es hoy estructuralmente imposible

```
Hallazgo:
`appfrontend-main` tiene 2 archivos de test vitest (25 tests) y 2 de
`node --test` (34 tests) que prueban el escáner de deuda visual, no el
producto. Los 82 componentes/páginas `.tsx` no tienen ninguna prueba, y no
pueden tenerla con la configuración actual.

Evidencia:
- `npm run test:unit` → Test Files 2 passed (2) · Tests 25 passed (25).
  Los dos archivos son `src/lib/apiErrors.test.ts` y
  `src/lib/business-context/numero-operativo.test.ts` — funciones puras.
- `npm run test:visual` → 34 tests, todos sobre `scripts/lib/*.mjs`
  (`find-colors`, `es-pantalla-visual`): es el linter visual probándose a
  sí mismo.
- `find src -name "*.tsx" | wc -l` → **82**. `find src -name "*.ts" -o -name "*.tsx" | wc -l` → 131.
- `vitest.config.mts:6` → `environment: 'node'`. No hay `jsdom` ni
  `happy-dom`, ni `@testing-library/*`, ni Playwright/Cypress en
  `devDependencies` (los hits de `msw`/`@playwright/test` en
  `package-lock.json` son peers opcionales de dependencias transitivas, no
  del proyecto).
- Módulos críticos sin ningún test:
    src/lib/http.ts            (175 líneas) — fetch base, reintentos,
                                `handleApiResponse` (:72) con el interceptor
                                de sesión vencida, `apiFetch` (:101)
    src/lib/refine/dataProvider.ts (357) — el adaptador que traduce TODAS
                                las pantallas migradas a Refine
    src/lib/refine/authProvider.ts (47)
    src/lib/business-context/sources.ts (208)
    src/hooks/useReservationsScreen.ts, src/hooks/useAuthRole.ts
- CI del frontend (`.github/workflows/ci.yml`) sí corre los dos runners,
  pero el propio archivo declara en su cabecera que el gate es
  "INFORMATIVO por ahora, a propósito ... corre en paralelo al deploy de
  Vercel ... puede terminar en rojo con el deploy ya en producción".
  Verificado contra la API: las últimas 10 corridas de `main` están en
  `success` — lo cual, con 25 tests de producto, no significa gran cosa.

Impacto:
El repo que auto-despliega a producción es el que menos cobertura real
tiene. `dataProvider.ts` es el único punto por donde pasan todas las
pantallas Refine: un mapeo mal hecho (paginación, filtros, `id`) rompe
varias pantallas a la vez y nada lo detecta antes del deploy.

Causa probable:
Deuda técnica por decisión de alcance (nunca se montó infraestructura de
testing de UI), no bug.

Nivel de certeza:
Confirmado.

Severidad: ALTA

Recomendación:
Separar dos decisiones que no son la misma. (a) Probar **lógica** de
frontend no necesita DOM: `http.ts`, `dataProvider.ts`, `authProvider.ts`,
`business-context/sources.ts` y los hooks de datos son testeables hoy con
`environment: 'node'` + `fetch` mockeado. Empezar por ahí es barato y cubre
lo que más rompe. (b) Probar **componentes** sí requiere elegir entorno
(jsdom + Testing Library, o Playwright) — eso es una decisión de producto y
de dependencias, no algo que esta auditoría deba decidir.

¿Requiere modificar código?: SÍ — archivos de test nuevos; (b) además
dependencias nuevas, decisión del dueño.

Prueba necesaria: ver §5 (caracterización de `http.ts` y `dataProvider.ts`).
```

---

### F13-08 — ALTO. En el frontend hay dos funciones para el mismo trabajo; la que tiene tests la usan 2 pantallas y la que usan ~49 archivos no tiene ninguno

```
Hallazgo:
`getErrorMessage` (`src/lib/apiErrors.ts:69`) está completamente cubierta
por `apiErrors.test.ts`. `extractErrorMessage` (`src/lib/http.ts:149`) hace
el mismo trabajo con una política DISTINTA y no tiene ningún test. La
tested es la minoritaria.

Evidencia:
- `grep -rln "extractErrorMessage" src | wc -l` → **51** archivos.
- `grep -rln "getErrorMessage" src` → **4** archivos, de los cuales 2 son
  el propio `apiErrors.ts` y su test. Pantallas reales que la usan:
  `src/app/dashboard/categorias/page.tsx` y `src/app/dashboard/roles/page.tsx`.
- Las políticas difieren, no son alias:
    `apiErrors.ts:69-75` → si es ApiError devuelve `err.message`; si no,
      `String(err.message)`; fallback 'Ocurrió un error inesperado'.
    `http.ts:149-164` → si hay `errors.fieldErrors`, devuelve el PRIMER
      error de campo; si no, el primer `formErrors`; recién después
      `err.message`; fallback 'Ocurrió un error'.
  Para un `VALIDATION_ERROR` con `fieldErrors`, una devuelve el mensaje
  general y la otra el error del primer campo. Misma entrada, dos salidas.
- Mismo patrón en el par `getFieldErrors` (`apiErrors.ts:81`, testeada) vs
  `extractFieldErrors` (`http.ts:166`, sin test).

Impacto:
El único test de manejo de errores del frontend cubre el camino que casi
nadie ejecuta. Cambiar `extractErrorMessage` —la que ve el usuario en ~49
pantallas— no rompe ningún test. Y la divergencia de política significa que
el mismo error del backend se muestra distinto según la pantalla, sin que
eso esté declarado en ningún lado.

Causa probable:
Duplicación semántica (clase de hallazgo de Fase 3) que arrastró una
asimetría de cobertura. No es un bug funcional confirmado — no verifiqué
que alguna pantalla muestre un mensaje incorrecto; lo confirmado es la
divergencia de contrato y la ausencia de test.

Nivel de certeza:
Confirmado para el conteo, la ausencia de tests y la divergencia de código.
NO confirmado que hoy produzca un mensaje incorrecto en pantalla.

Severidad: ALTA

Recomendación:
Dos cosas separadas: (1) testear `extractErrorMessage`/`extractFieldErrors`
como están (caracterización — ver §5), sin cambiarlas; (2) decidir aparte
si las dos políticas deben unificarse, que es una decisión de UX, no de
testing.

¿Requiere modificar código?: (1) SÍ, test nuevo. (2) decisión del dueño.

Prueba necesaria:
Tabla de caracterización con al menos: ApiError VALIDATION_ERROR con
fieldErrors; con solo formErrors; ApiError simple; Error nativo; string;
null; objeto sin `message`. Comparar las dos funciones sobre las mismas 7
entradas y dejar la diferencia escrita en el test.
```

---

### F13-09 — ALTO. No existe ninguna prueba del camino de *upgrade* de schema sobre una base poblada; reproducido: el schema de HEAD falla sobre un tenant pre-v59 con dos recursos homónimos

```
Hallazgo:
La única prueba que ejercita `schema.sql` de punta a punta
(`schema-redeploy-idempotent.integration.test.ts`) aplica DOS VECES el
MISMO schema sobre una base creada por ese mismo schema. Por construcción
no puede detectar que una constraint nueva choque con datos preexistentes
de una versión anterior. Reproduje esa falla.

Evidencia:
- `src/tests/integration/schema-redeploy-idempotent.integration.test.ts:21-27`
  (docblock): "aplica schema.sql, inserta una fila CONSUMPTION real ... y
  vuelve a aplicar schema.sql ENTERO otra vez". 2 tests.
- `platform-schema.integration.test.ts` (29 tests) cubre
  `platform.schema.sql`, no el camino de upgrade de un tenant.
- `src/scripts/migrate-tenants.ts` — **0 % de cobertura**, 0 tests
  (lcov: `src/scripts/migrate-tenants.ts` LH=0 de LF=42).
- Reproducción, PostgreSQL 16.13 local:
    1. Apliqué `src/db/schema.sql` de `073a8d4^` (pre-v59) a una BD nueva.
       Índices de `resources`: resources_pkey, idx_resources_category,
       idx_resources_location — sin `uq_resources_name`.
    2. Inserté 2 recursos activos: 'Habitación 101' y 'habitación 101 '
       (normalizan al mismo `upper(btrim(name))`). Aceptados, 2 filas.
    3. Apliqué `src/db/schema.sql` de HEAD sobre esa misma BD:
         psql -v ON_ERROR_STOP=1 -f /home/user/app/src/db/schema.sql
         exit=3
         psql:.../schema.sql:4301: ERROR: could not create unique index "uq_resources_name"
- Camino real en producción: `src/scripts/migrate-tenants.ts:86-88` →
  `if (failed > 0) process.exit(1)`; `render.yaml` encadena
  `... && npm run migrate:tenants` en el `buildCommand`, y el docblock del
  script (`:33-39`) lo declara: "Si falla ... el build entero falla y Render
  no promueve la versión nueva". O sea que un solo tenant con dos recursos
  homónimos activos bloquea el deploy de TODOS los tenants.

Impacto:
El riesgo concreto es de operación, y es fail-closed (no corrompe datos: no
promueve). Pero el hallazgo de esta fase es el hueco de PRUEBA: ninguna
suite puede responder "¿este schema aplica sobre los datos que ya existen?"
antes de que lo intente el deploy contra producción. Fase 10 midió el
comportamiento del schema; lo que nadie tiene es la red automática.

NOTA de alcance: no verifiqué si algún tenant real tiene hoy recursos
homónimos. Eso requiere acceso a las bases de producción (ver §6).

Causa probable:
Prueba insuficiente por diseño del harness: `createTestDatabase()` siempre
parte de cero.

Nivel de certeza:
Confirmado para la ausencia de la prueba y para la falla reproducida sobre
una base poblada construida a mano. NO confirmado el estado de los datos
reales.

Severidad: ALTA

Recomendación:
Un test de upgrade, no de redeploy: aplicar el schema de la versión N-k
(el repo tiene el histórico en git), sembrar datos realistas, aplicar el
schema de HEAD y exigir que complete. Y, como mínimo antes de cualquier
constraint nueva, una query de pre-chequeo contra la flota
(`SELECT upper(btrim(name)), count(*) FROM resources WHERE active AND deleted_at IS NULL
GROUP BY 1 HAVING count(*) > 1`) — eso no es un test, es un runbook, y
corresponde decidirlo al dueño.

¿Requiere modificar código?: SÍ — un archivo de test nuevo. Nada en `src/`.

Prueba necesaria: la descrita, con la matriz de qué versión anterior se usa
como base.
```

---

### F13-10 — MEDIO. `domain/money.ts::round2` no tiene ningún test propio y su comportamiento real contradice la política que su docblock declara

```
Hallazgo:
`round2()` es el único lugar donde este sistema redondea dinero. Su
docblock declara "Media hacia arriba, a 2 decimales". La implementación
—`Math.round(n * 100) / 100` sobre float binario— NO cumple esa política
para una clase entera de entradas, y no hay ningún test que fije ni el
comportamiento declarado ni el real.

Evidencia:
- `src/domain/money.ts:14-16` — 16 líneas en total:
      export function round2(n: number): number { return Math.round(n * 100) / 100; }
  Docblock `:11-12`: "Media hacia arriba, a 2 decimales, al final del
  cálculo — nunca redondear intermedios y volver a sumar."
- No existe `money.test.ts` (`find src -name "money*test*"` → vacío) y
  ningún test lo importa (`grep -rln "from '.*domain/money" --include="*.test.ts"` → vacío).
  Aparece al 100 % en cobertura solo porque lo ejercitan otros módulos
  de forma transitiva, nunca con aserción sobre él.
- Comportamiento real, medido con node:
      round2(1.005) → 1       (la política declarada exige 1.01)
      round2(1.015) → 1.01    (exige 1.02)
      round2(8.165) → 8.16    (exige 8.17)
      round2(2.675) → 2.68    (acá sí coincide)
      round2(-1.005) → -1  ·  round2(-1.015) → -1.01
      round2(1.005) + round2(-1.005) = 0   (simétrico, por casualidad)
      1000 sumas de round2(0.615) = 620.0000000000039  (el resultado de
        round2 no es exacto en float; sumar muchos vuelve a acumular error)

Impacto:
Un refactor que "arregle" `round2` para que cumpla su docblock cambiaría
importes de facturas, notas de crédito y saldos ya emitidos, y ningún test
lo señalaría. Al revés también: alguien que lea el docblock y asuma
half-up puede escribir un tope o una comparación que no cierra por un
centavo. Es exactamente el caso que el protocolo llama "comportamiento
accidental que no debería conservarse" — pero convertirlo en deseado o
descartarlo es decisión de negocio, no de esta auditoría.

Causa probable:
Requisito ambiguo (el docblock dice una cosa, el código hace otra) sobre
una implementación de 1 línea que nadie testeó porque parece trivial.

Nivel de certeza:
Confirmado — la divergencia está medida sobre la función real.

Severidad: MEDIA (es riesgo latente de refactor, no un defecto activo
demostrado en un importe de producción)

Recomendación:
Escribir la prueba de caracterización ANTES de tocar nada (§5.1) y, por
separado, llevar la discrepancia docblock-vs-código al dueño: o se corrige
el comentario, o se cambia la política, y eso último es una decisión con
efecto sobre importes.

¿Requiere modificar código?: para la prueba, SÍ (archivo de test nuevo).
Para `money.ts` en sí: NO sin decisión de negocio.

Prueba necesaria:
Tabla congelada de al menos: 1.005, 1.015, 1.025, 2.675, 8.165, sus
negativos, 0, valores con más de 2 decimales, y una suma acumulada — con
los valores ACTUALES, marcada explícitamente como caracterización.
```

---

### F13-11 — MEDIO. 13 archivos simulan PostgreSQL con un fake que hace `includes()` sobre el texto del SQL, y 16 asertan directamente el texto del SQL

```
Hallazgo:
Dos patrones distintos de "probar la implementación en vez del
comportamiento" conviven. (a) fake-db que decide qué filas devolver según
substrings del SQL; (b) tests que afirman que el SQL contiene ciertos
literales.

Evidencia:
(a) 13 archivos con fake-db por substring:
    src/reservas/reservations.routes.test.ts  (p. ej. :73-84:
      `if (text.includes('SELECT COUNT(*) AS count FROM reservations'))`)
    src/reservas/resources.routes.test.ts, src/reservas/sql.reservation.repository.test.ts,
    src/clientes-finanzas/customer-account.service.test.ts, customers.routes.test.ts,
    sql.customer-tax-profile.repository.test.ts, src/facturacion/invoices.routes.test.ts,
    sql.afip-credentials.repository.test.ts, src/platform/business-context.routes.test.ts,
    business-hours.routes.test.ts, company-sync.worker.test.ts,
    platform.repository.test.ts, tenant-db.setup.test.ts
(b) 16 archivos con aserciones sobre el texto del SQL, p. ej.:
    src/facturacion/sql.invoice.repository.test.ts:142-200 — 12 `expect(sql).toContain(...)`
      incluyendo `toContain("i.status = 'ISSUED'")`, `toContain('UNION ALL')`,
      `toContain('SUM(dedup.imp_total)')`, `not.toContain('cbte_tipo = 8')`
    src/repositories/sql.stock-movement.repository.test.ts:35-68
    src/pos-menu/sql.service-item.repository.test.ts:37-83
    src/platform/company.repository.test.ts:25-154, location.repository.test.ts:24-45,
    sql.operating-hours.repository.test.ts:24-97, src/reservas/sql.resource.repository.test.ts:31,74
- 17 archivos `sql.*.repository.test.ts` corren fuera de integración, casi
  todos sobre `db.query` mockeada.

Impacto:
Estos tests son frágiles en una dirección y ciegos en la otra. Frágiles:
reformatear una query (saltos de línea, alias) los rompe sin que nada haya
cambiado de comportamiento. Ciegos: un SQL sintácticamente inválido, con
un JOIN mal, con el `WHERE` invertido o con un tipo equivocado pasa igual,
porque nadie lo ejecuta. Es el complemento exacto de F13-01: cuando la
suite de integración cae, lo que queda verde no valida nada del SQL.

Causa probable:
Decisión consciente y documentada en varios de esos archivos ("no hay
supertest", "fakear decenas de tablas no vale el costo"). No es descuido.
Lo que falta es la contraparte de integración para los repos donde el SQL
es la lógica.

Nivel de certeza:
Confirmado.

Severidad: MEDIA

Recomendación:
No borrar esos tests: cubren mapeo de filas y armado de parámetros, que es
real. Lo que corresponde es decidir por repositorio dónde vive el
comportamiento: si la regla está EN el SQL (los 12 `toContain` de
`sql.invoice.repository.test.ts` describen una regla de negocio de notas de
crédito), esa regla necesita un test de integración; el `toContain` puede
quedar como documentación, no como la prueba.

¿Requiere modificar código?: NO en producción; sí tests nuevos si se
decide cubrir el SQL.

Prueba necesaria:
Por cada `expect(sql).toContain(<regla de negocio>)`, una aserción
equivalente sobre filas reales en integración.
```

---

### F13-12 — MEDIO. La cobertura se mide sobre un denominador recortado y la suite de integración nunca entra en la medición

```
Hallazgo:
`vitest run --coverage` da 77,68 % líneas / 83,70 % ramas / 78,30 %
funciones, contra thresholds de 60/50/60. Pero esa medición (a) excluye 14
patrones de `src/`, algunos con lógica real, y (b) corre solo la suite
unitaria: los 380 tests de integración no suman cobertura a ningún archivo.

Evidencia:
- Medición real hoy (HEAD `aa248a9`): `All files 77.68 | 83.7 | 78.3 | 77.68`.
- `vitest.config.ts:55-70` — thresholds lines/statements 60, functions 60,
  branches 50. El drift de ~18 puntos ya está registrado en Fase 11; se cita.
- `vitest.config.ts:26-52` — `coverage.exclude` incluye `src/services/**`,
  `src/db/**`, `src/openapi/**`, `src/app.ts`, `src/container.ts`,
  `src/server.ts`, `src/schemas/**`, `src/seed/**`,
  `src/platform/platform.container.ts`,
  `src/repositories/sql.customer.repository.ts`.
- `package.json:12-15` — `test:integration` NO lleva `--coverage`, y
  `vitest.integration.config.ts` no tiene bloque `coverage`. No existe
  ningún reporte combinado.
- Consecuencia medida: `src/facturacion/sql.invoice.repository.ts` (527
  líneas) reporta **23,72 %** — pero es uno de los archivos más
  ejercitados por integración. El número publicado no describe el riesgo
  real ni para arriba ni para abajo.
- Archivos con lógica y cobertura unitaria muy baja (lcov, LF>70):
    sql.rate-catalog.repository.ts 1,30 % (77) · housekeeping.repository.ts 2,94 % (102)
    stay.repository.ts 3,41 % (88) · sql.maintenance-window.repository.ts 3,66 % (82)
    sql.product.repository.ts 9,19 % (283) · sql.inventory-level.repository.ts 9,59 % (146)
    sql.recipe-item.repository.ts 13,40 % (97) · sql.domain-event.repository.ts 13,48 % (89)
    customer.routes.ts 34,53 % (556) · sql.order.repository.ts 41,92 % (291)
    reservations.routes.ts 47,57 % (473) · platform.repository.ts 50,37 % (683)

Impacto:
El 77,68 % se lee como "cobertura del sistema" y no lo es. Un umbral que
está 18 puntos por debajo del valor real no protege de nada: se puede
borrar un tercio de los tests sin que el gate se entere.

Causa probable:
Deuda de configuración: cada exclusión tuvo un motivo fechado y ninguno se
revisó después.

Nivel de certeza:
Confirmado.

Severidad: MEDIA

Recomendación:
Subir los thresholds a un punto por debajo del real medido (p. ej. 75/80/75)
para que vuelvan a ser cerca, y revisar las 14 exclusiones una por una
—varias ya no describen el estado del repo. Medir cobertura combinada
(unit + integración) es deseable pero requiere merge de reportes; es
decisión aparte.

¿Requiere modificar código?: SÍ — solo `vitest.config.ts`.

Prueba necesaria: `npm run test:coverage` verde con los umbrales nuevos.
```

---

### F13-13 — MEDIO. 15 repositorios SQL no tienen ningún test unitario; varios tampoco de integración

```
Hallazgo:
Barrido de `sql.*.repository.ts` contra su `*.test.ts` hermano.

Evidencia:
Sin archivo de test unitario:
  src/clientes-finanzas/sql.billing-policy.repository.ts
  src/clientes-finanzas/sql.rate-catalog.repository.ts      (1,30 % cobertura)
  src/pms-estadias/sql.maintenance-window.repository.ts     (3,66 %)
  src/pos-menu/sql.product.repository.ts                    (9,19 %, 283 líneas)
  src/repositories/sql.business-profile.repository.ts       (58,60 %)
  src/repositories/sql.consumption-destination.repository.ts(18,31 %)
  src/repositories/sql.domain-event.repository.ts           (13,48 %)
  src/repositories/sql.inventory-level.repository.ts        (9,59 %)
  src/repositories/sql.number-sequence.repository.ts
  src/repositories/sql.recipe-item.repository.ts            (13,40 %)
  src/repositories/sql.waste-reason.repository.ts           (18,31 %)
  src/reservas/sql.bookable-service.repository.ts
  src/reservas/sql.cancellation-policy.repository.ts
  src/reservas/sql.category.repository.ts
  src/reservas/sql.deposit-policy.repository.ts             (5,41 %)
Cruce con integración: ninguno de los dominios product/recipe/waste/
rate-catalog/bookable-service/maintenance aparece en `src/tests/integration`
(barrido de §F13-06).

Impacto:
`sql.product.repository.ts` (283 líneas, 9,19 %) es el repositorio de
productos y stock de POS. `sql.domain-event.repository.ts` es la mitad
persistente del outbox — su comportamiento SÍ se ejercita, pero solo desde
`outbox-worker.integration.test.ts`, no como unidad.

Causa probable:
Deuda técnica acumulada por orden de construcción.

Nivel de certeza:
Confirmado (la lista es el resultado del barrido; la cobertura sale de lcov).

Severidad: MEDIA

Recomendación:
No escribir 15 archivos de test por completar una lista. Priorizar por
riesgo de negocio: `sql.product.repository.ts` (stock, dinero indirecto) y
`sql.rate-catalog.repository.ts` (tarifas, dinero directo) primero, y con
integración —no con mock de `db.query`, que reproduce F13-11.

¿Requiere modificar código?: SÍ — tests nuevos.

Prueba necesaria: por repositorio, el contrato de sus 2-3 métodos con más
lógica en el SQL.
```

---

### F13-14 — MEDIO. El middleware de errores tiene 113 `case` y su test nombra 13 códigos; 24 de 122 ramas quedan sin cubrir

```
Hallazgo:
`domainErrorStatus()` mapea 113 códigos de error de dominio a status HTTP.
`error.middleware.test.ts` tiene 15 tests y nombra explícitamente 13
códigos. El resto del mapeo llega al 80,32 % de ramas solo por ejercicio
incidental desde otros tests.

Evidencia:
- `grep -oE "case '[A-Z_0-9]+'" src/api/middleware/error.middleware.ts | sort -u | wc -l` → **113**
- `src/api/middleware/error.middleware.test.ts` — 15 `it()`; códigos
  nombrados: AFIP_REQUEST_UNCERTAIN, CREDIT_NOTE_CANCELLATION_PENDING,
  CREDIT_NOTE_CONSOLIDATED_FULL_REVERSAL,
  CREDIT_NOTE_ISSUED_RESERVATION_NOT_CANCELLABLE, CREDIT_NOTE_MIXED_STAY,
  CREDIT_NOTE_MULTI_INVOICE, CREDIT_NOTE_ORDER_INVOICE_SET_CHANGED,
  CREDIT_NOTE_RESERVATION_INVOICE_SET_CHANGED,
  CREDIT_NOTE_RESERVATION_MULTI_INVOICE,
  CREDIT_NOTE_RESERVATION_NO_LIVE_INVOICE, INVALID_RESERVATION,
  ORDER_NOT_FOUND, ORDER_STATE_UNKNOWN (13) + un
  'CODIGO_INVENTADO_QUE_NO_EXISTE' para el fallback.
- lcov, `src/api/middleware/error.middleware.ts`: BRF=122, BRH=98 → **24
  ramas sin cubrir**.
- `src/domain/errors.ts` define 84 clases `export class *Error`, y hay más
  códigos declarados fuera de ese archivo (p. ej. `STAY_NOT_FOUND` en
  `src/pms-estadias/stay.service.ts:58`, `RESOURCE_OCCUPIED` en `:73`).

Impacto:
El status HTTP es parte del contrato con el frontend (que discrimina por
`httpStatus` en `apiErrors.ts`). Un `case` en el grupo equivocado cambia un
409 por un 400 sin que nada falle. El riesgo está concentrado en los
grupos grandes de fallthrough, donde agregar un `case` en el bloque de al
lado es un error de una línea.

Causa probable:
Prueba insuficiente sobre una estructura que creció por acumulación.

Nivel de certeza:
Confirmado para los conteos y para las 24 ramas. NO verifiqué código por
código cuál tiene el status equivocado.

Severidad: MEDIA

Recomendación:
Un `it.each` sobre la lista completa de códigos con su status esperado,
generado a partir del propio switch invertido. Es el caso ideal para
parametrizar: 113 casos en ~20 líneas.

¿Requiere modificar código?: SÍ — solo el test.

Prueba necesaria: la descrita.
```

---

### F13-15 — MEDIO. La señal de CI está degradada: 14 de las últimas 40 corridas de `main` en rojo, 12 consecutivas por el mismo job, y encima de cada rojo se siguió pusheando

```
Hallazgo:
El estado rojo de CI dejó de ser una señal que frene algo. La corrida
vigente de `origin/main` está en `failure` y es la tercera causa distinta
en tres días.

Evidencia (GitHub Actions API, rama `main`, últimas 40 corridas):
    2026-09-15T11:11  2b005fa  FAILED JOBS: ['integration']        ← vigente
    2026-09-14T23:13  d53221f  FAILED JOBS: ['schema-version-check']
    2026-09-13T19:07  8296e26  FAILED JOBS: ['lint']
    2026-09-13T18:48  b1705e9  FAILED JOBS: ['lint']
    2026-09-13T18:11  14caea7  FAILED JOBS: ['lint']
    2026-09-13T16:58  ddf7479  FAILED JOBS: ['lint']
    2026-09-13T14:11  17b54f5  FAILED JOBS: ['lint']
    2026-09-13T13:41  8c18c35  FAILED JOBS: ['lint']
    2026-09-13T12:47  a7d57b2  FAILED JOBS: ['lint']
    2026-09-13T12:14  dd99cd6  FAILED JOBS: ['lint']
    2026-09-13T11:26  cec0235  FAILED JOBS: ['lint']
    2026-09-13T02:50  3aff145  FAILED JOBS: ['lint']
    2026-09-13T02:21  b4730bd  FAILED JOBS: ['lint']
    2026-09-13T01:29  7f32c30  FAILED JOBS: ['lint']
  Las 12 de `lint` son commits de SOLO documentación (`docs(pendientes)...`,
  `docs(diseno)...`), lo que indica que el rojo venía arrastrado de un commit
  de código anterior y nadie lo cortó durante ~18 horas y 12 pushes.
- `npm run lint` en HEAD local hoy: **verde** — o sea que aquello se
  resolvió, pero no antes de acumular 12 corridas rojas.
- El propio repo tiene escrito el riesgo: el docblock de
  `src/tests/integration/customer-token-staff-route-ownership.integration.test.ts:348-351`
  justifica usar `it.todo` en vez de `expect` rojo porque "dejaría el job
  permanentemente rojo (entrena a leer el rojo como ruido — mismo modo de
  falla que el 'verde silencioso' que este [test] evita)". La preocupación
  estaba identificada; el patrón ocurrió igual, en otro job.

Impacto:
Una suite que corre pero cuyo rojo no detiene nada tiene el mismo valor
informativo que no correr. Es la condición que permitió que F13-01 viviera
un día entero sobre `origin/main` con 10 commits encima.

Causa probable:
Proceso, no código: el repo commitea directo a `main` sin PR y sin branch
protection, así que CI es informativa por construcción en los dos repos
(el frontend lo declara explícitamente en su `ci.yml`).

Nivel de certeza:
Confirmado — datos traídos de la API pública de GitHub Actions.

Severidad: MEDIA (no es un defecto de producto; es el mecanismo que deja
pasar los que sí lo son)

Recomendación:
Es decisión del dueño, no de esta auditoría. Las opciones plausibles, sin
elegir: (a) branch protection + PR obligatorio (requiere configuración
fuera del repo); (b) un hook local pre-push que corra `lint` + `test`;
(c) dejarlo informativo y adoptar la disciplina de no pushear sobre rojo.
Lo que NO es una opción es seguir citando "CI verde" como evidencia.

¿Requiere modificar código?: NO necesariamente.

Prueba necesaria: que la corrida de `origin/main` vuelva a `success` —
hoy eso depende de F13-01.
```

---

### F13-16 — MEDIO. Las dos dependencias externas de mayor riesgo (AFIP y Chromium/PDF) están 100 % mockeadas

```
Hallazgo:
Ni el SDK de facturación electrónica ni la generación de PDF se ejecutan
nunca en ninguna prueba.

Evidencia:
- `src/facturacion/arca-sdk-billing.adapter.test.ts:4-19` — `fakeArcaClient()`
  devuelve un objeto con `electronicBillingService` armado con `vi.fn()`,
  casteado `as unknown as Arca`. No hay ningún test contra homologación.
- `src/facturacion/invoice-pdf.service.test.ts:146` —
  `vi.mock('@arcasdk/pdf', () => ({ ... }))`. Nunca se genera un PDF real;
  el test verifica la conversión `Uint8Array` → `Buffer`.
- `src/facturacion/afip-ticket-storage.ts`: **8,33 %** de cobertura.
  `src/facturacion/afip-client.factory.ts`: 57,14 %.
- Contexto ya registrado en fases previas (se cita, no se re-deriva):
  `render.yaml` ejecuta `npx puppeteer browsers install chrome` explícito
  porque el `postinstall` no se dispara con `node_modules` cacheado.

Impacto:
El camino Chromium es el que más depende del entorno de build y el único
que ninguna prueba toca. Si el binario no está o la versión cambia, nada
lo detecta antes de que un usuario pida un PDF. En AFIP el mock es
defendible (no se puede pegarle a producción fiscal desde CI) pero deja el
mapeo de errores del SDK sin verificación end-to-end.

Causa probable:
Decisión razonable (no se llama a servicios externos desde CI) sin la
contraparte: no hay ningún test que use el binario real ni un modo
homologación opcional.

Nivel de certeza:
Confirmado.

Severidad: MEDIA

Recomendación:
Para PDF, un test opcional (gateado por variable de entorno, mismo patrón
que `skipIfNoDb`) que genere un PDF real y verifique cabecera `%PDF-` y
tamaño > 0. Para AFIP, si existe entorno de homologación, el mismo patrón;
si no, dejarlo declarado como límite conocido, no como cobertura.

¿Requiere modificar código?: SÍ — tests nuevos.

Prueba necesaria: la descrita.
```

---

### F13-17 — MEDIO. Cuatro defectos de seguridad conocidos están codificados como `it.todo`, invisibles en la señal verde/rojo

```
Hallazgo:
`customer-token-staff-route-ownership.integration.test.ts` registra 4
bypasses de pertenencia (F5-01, Fase 5) como `it.todo` en vez de como
aserción roja. La suite reporta verde con los defectos vivos.

Evidencia:
- `src/tests/integration/customer-token-staff-route-ownership.integration.test.ts:388,423,455,487`
  — cuatro `it.todo(...)`:
    'F5-01: POST /api/reservations "a nombre de" B con token de A debería dar 403 ...'
    'F5-01: POST /reservations/:id/schedule-request sobre reserva de B con token de A ...'
    'F5-01: POST /api/orders "a nombre de" B con token de A ...'
    'F5-01: POST /orders/:id/items sobre orden de B con token de A ...'
- Corrida de integración: el archivo reporta `(8 tests | 4 skipped)` y
  cuenta como PASSED.
- La decisión está documentada y gateada (`:61-63`, condición del gate
  `architecture-governor`, 15/09/2026): un `expect(403)` dejaría el job
  permanentemente rojo.
- Total de `it.todo` en el repo: 5 (4 acá + 1 en
  `src/tests/domain/resource.factory.test.ts:13`).

Impacto:
El razonamiento del gate es correcto (un rojo permanente entrena a ignorar
el rojo — exactamente lo que F13-15 muestra que pasó por otro camino).
Pero el resultado es que la suite no distingue "no hay defecto" de "hay
defecto conocido y decidimos no fallar por él". El dato existe en el
archivo; no existe en la señal.

Causa probable:
Decisión de proceso, deliberada y documentada. No es descuido.

Nivel de certeza:
Confirmado.

Severidad: MEDIA

Recomendación:
Ninguna de las dos opciones obvias es gratis y la elección es del dueño:
(a) convertirlos en pruebas de CARACTERIZACIÓN que afirmen el
comportamiento ACTUAL (p. ej. `expect(status).toBe(500)`) con un comentario
que diga "esto es el bug, no el contrato" — mantiene verde y hace que el
día que se arregle el test falle y obligue a actualizarlo; (b) dejarlos
como `it.todo` y llevar el conteo de todos a un lugar que alguien relea.
No recomiendo elegir por el dueño.

¿Requiere modificar código?: depende de la opción.

Prueba necesaria: si (a), las 4 aserciones de caracterización.
```

---

### F13-18 — BAJO. Property-based testing existe pero está aplicado a un solo módulo, y no al dinero

```
Hallazgo:
`fast-check` está en `devDependencies` y lo usa exactamente 1 archivo.

Evidencia:
- `grep -rln "fast-check" --include="*.test.ts" src` → solo
  `src/tests/domain/availability.property.test.ts` (13 tests).
- Ningún property test sobre `round2`, sobre los topes de nota de crédito
  (`credit-note-cap`), sobre la atribución de reembolsos
  (`refund-attribution.test.ts`, 14 tests por ejemplo) ni sobre la
  aplicación de pagos (`customer-account.service.ts`).

Impacto:
Los invariantes financieros del sistema ("la suma de aplicaciones nunca
supera el importe emitido", "un reembolso nunca deja saldo negativo") son
exactamente el tipo de propiedad que un generador encuentra mejor que
ejemplos elegidos a mano — y son los que más caro cuestan cuando fallan.

Causa probable:
Deuda: la herramienta se introdujo para un caso concreto y no se extendió.

Nivel de certeza: Confirmado.
Severidad: BAJA (es una oportunidad, no un defecto)

Recomendación:
Cuando se recupere la suite de integración (F13-01), evaluar 2-3
propiedades sobre topes de NC y aplicación de pagos. No antes: property
tests sobre una suite roja no aportan.

¿Requiere modificar código?: SÍ — tests nuevos, si se decide.
Prueba necesaria: las propiedades elegidas.
```

---

### F13-19 — BAJO. Un archivo de test apunta a otro que no existe

```
Hallazgo:
`src/tests/domain/resource.factory.test.ts:13` declara
`it.todo('migrado a src/tests/domain/entities.test.ts')`, y ese archivo no
existe.

Evidencia:
- `ls src/tests/domain/` → availability.property.test.ts, availability.test.ts,
  customer.test.ts, errors.test.ts, reservation.cancel-confirmed.test.ts,
  **resource.entities.test.ts**, resource.factory.test.ts.
  No hay `entities.test.ts`.
- El docblock `:1-7` dice que el archivo "se mantiene para preservar el
  historial de git".
- Es el único archivo de los 174 que reporta como `↓ skipped`.

Impacto: ninguno funcional. Es un puntero muerto que cuesta 30 segundos a
quien lo lee.

Causa probable: deuda de una migración de nombres.
Nivel de certeza: Confirmado. Severidad: BAJA
Recomendación: corregir el texto del `it.todo` a `resource.entities.test.ts`,
o borrar el archivo (el historial de git no depende de que el archivo
exista). Decisión menor.
¿Requiere modificar código?: SÍ — 1 línea de test, o borrar el archivo.
Prueba necesaria: ninguna.
```

---

### F13-20 — BAJO. En el frontend, 34 de los 59 tests prueban la herramienta, no el producto, y conviven dos runners distintos

```
Hallazgo:
`npm run test:visual` (34 tests, `node --test`) prueba `scripts/lib/*.mjs`
—el escáner de deuda visual del propio repo—, no el producto. El producto
tiene 25 tests, con otro runner (vitest 4.1.11).

Evidencia:
- `package.json:10-11`: `"test:visual": "node --test scripts/lib/*.test.mjs"`,
  `"test:unit": "vitest run"`.
- `scripts/lib/`: `find-colors.test.mjs`, `es-pantalla-visual.test.mjs`.
  Salida: `# tests 34 # pass 34`.
- `.github/workflows/ci.yml` job `test` corre los dos como pasos separados.

Impacto:
Menor, pero distorsiona la lectura: "59 tests" en el frontend suena a
cobertura de producto y el 58 % es tooling. Dos runners también significan
dos configuraciones, dos formas de escribir un test y ninguna razón
técnica evidente (los `.mjs` podrían correr en vitest).

Causa probable: deuda incremental.
Nivel de certeza: Confirmado. Severidad: BAJA
Recomendación: mantener la separación si se quiere, pero nombrar los
conteos por separado al citar cobertura. Unificar runners es opcional.
¿Requiere modificar código?: NO.
Prueba necesaria: ninguna.
```

---

## 3. Calidad de la suite: lo que se midió y NO resultó ser un hallazgo

Esta sección existe para no reportar como problema lo que se verificó y está bien.

### 3.1 No hay tests sin aserciones

Parser de bloques `it()` con balanceo de paréntesis sobre los 221 archivos: **2 772 bloques analizados, 0 sin `expect(`**. Ratio global: **5 667 `expect(` / 2 772 tests ≈ 2,05 aserciones por test**.

### 3.2 Los tests "que solo verifican que se llamó al mock" son el 1,8 %, no la mayoría

Medición en dos pasadas, porque la primera sobreestimaba:
- Bloques cuyas únicas aserciones son sobre mocks (incluido `toHaveBeenCalledWith(payload)`): **440 de 2 772 (15,9 %)**.
- Bloques cuyas únicas aserciones son `toHaveBeenCalled()` / `toHaveBeenCalledTimes()` / `not.toHaveBeenCalled()`, **sin verificar ningún payload**: **50 de 2 772 (1,8 %)**, concentrados en `adaptive-poller.test.ts` (9), `outbox.worker.test.ts` (6), `company-sync.worker.test.ts` (5), `health-cache.test.ts` (4), `outbox.handlers.test.ts` (4), `rate-catalog.routes.test.ts` (4).

La diferencia importa: los 390 restantes usan `toHaveBeenCalledWith({...})`, que **sí** verifica el resultado —solo que contra un mock y no contra una respuesta HTTP o una fila de base. Eso es F13-04/F13-11, no un problema de aserción vacía.

Bloques con solo aserciones débiles (`toBeDefined`/`toBeTruthy`/`not.toThrow`/`toBeUndefined`): **43 de 2 772 (1,6 %)**, y revisando la muestra, la mayoría son correctos (`devuelve undefined si no existe` es exactamente lo que hay que afirmar).

### 3.3 No hay pruebas duplicadas en sentido estricto

- `jscpd` sobre `**/*.test.ts` con `--min-lines 25 --min-tokens 150`: **22 clones, 784 líneas, 1,26 %**. Los 15 más grandes son todos bloques de *setup*/fixtures compartidos entre suites de integración hermanas (`cancel-order-with-credit-note` ↔ `invoice-order-service-item`, `city-ledger-outstanding` ↔ `reverse-transfer`), no tests repetidos.
- Títulos de `it()` repetidos: 54 títulos con 122 ocurrencias; 23 de ellos dentro del mismo archivo. Inspeccioné los sospechosos y **ninguno es un duplicado real**: son el mismo nombre en `describe` distintos. Ejemplo verificado: `resource-lock.service.test.ts:41` y `:51` dicen ambos "lanza BookableServiceNotFoundError si el servicio no existe" pero uno está bajo `describe('listForService')` y el otro bajo `describe('replaceForService')` — son dos métodos.

**Conclusión: la duplicación de tests no es un problema de este repo.** Lo descarto explícitamente.

### 3.4 La suite unitaria es mayormente orden-independiente

Seis corridas completas con `--sequence.shuffle` (sin seed, y seeds 1, 2, 3, 7, 99, 2026, 12345): **solo 1 test falla, siempre el mismo** (F13-03). El resto de los 2 432 es estable bajo reordenamiento. Es un resultado bueno y hay que decirlo.

### 3.5 La higiene de `process.env` en tests está mayormente bien

21 archivos mutan `process.env`; 18 tienen hooks de restauración (`afterEach`/`afterAll`/`vi.unstubAllEnvs`). Los 3 sin hooks visibles (`platform/tenant.middleware.test.ts`, `api/routes/me.routes.test.ts`, `api/routes/auth.routes.test.ts`) no produjeron ninguna falla en 6 corridas con shuffle. No lo reporto como hallazgo: es riesgo latente, no defecto medido.

### 3.6 `migrations/NNN_*.sql` sin tests NO es un hallazgo

`migrations/README.md:1` lo declara: *"histórico, NO se aplica a ninguna base ... no están conectados a ningún aplicador"*. Verificado: el único hit desde `src/` es un comentario de referencia (`sql.financial-transaction.repository.ts:54`). El artefacto vivo es `schema.sql` + `applyTenantSchema()`, que sí es el objeto de F13-09.

### 3.7 El catálogo de roles cross-repo está sincronizado hoy

Verificado al valor, no al conteo. Backend, `src/tests/security/roles-catalog-sync.test.ts:105-114`: BOOKING, CUSTOMER_ONLY, EMISOR_NOTA_CREDITO, FRONT_DESK, HOUSEKEEPING_AND_MANAGEMENT, MANAGEMENT, ORDERS, OWNER_ONLY, STAFF. Los 3 catálogos del frontend:
- `src/app/dashboard/roles/page.tsx:23-31` — 8 (sin `CUSTOMER_ONLY`, a propósito y documentado). ✔
- `src/app/superadmin/planes/page.tsx:16-19` — 9. ✔
- `src/app/superadmin/roles-de-fabrica/page.tsx:15-19` — 9. ✔

El drift que el `CLAUDE.md` del backend describía (`roles-de-fabrica` en 8 de 9) **está cerrado**. Lo que sigue abierto —y no es un hallazgo nuevo, es la limitación que la propia cerca declara— es que ningún test verifica el otro repo: no hay CI compartida.

### 3.8 Otros datos verificados sin hallazgo

- `it.each` se usa en 6 archivos (11 call sites). No hay `it.concurrent` ni `describe.concurrent` (0) — correcto para una suite que comparte bases.
- `vi.mock` total: **69** call sites en 221 archivos; concentrados en `products.routes.test.ts` (11) y `rate-catalog.routes.test.ts` (8). No es un repo mock-pesado a nivel de módulo.
- `vi.fn` total: 1 015, máximo por archivo `invoice.service.test.ts` (83) — consistente con un servicio de 10+ dependencias.
- `vi.useFakeTimers` en solo 4 archivos; `vi.setSystemTime` en 1. Hay muchas fechas literales (141 usos de `'2026-07-01'`, 45 de `'2030-01-01'`), pero `ReservationService` inyecta `this.now()` (`reservation.service.ts:244`), así que los tests no dependen del reloj de la máquina para la validación de pasado. **No encontré ninguna bomba de tiempo activa**; la más lejana es 2030.
- `npm run lint` en HEAD: verde.

---

## 4. Diferencias entre pruebas y producción (pregunta explícita del protocolo)

| Dimensión | En pruebas | En producción | Riesgo | Cubierto por |
|---|---|---|---|---|
| Ensamblado de la app | Handlers extraídos del `router.stack` y llamados con `req`/`res` falsos; 2 harness Express propios | `createApp()` con todo el árbol de middlewares | Orden de gates, `tenantMiddleware`, error middleware montado, serialización | **F13-04** |
| Base de datos | BD temporal nueva por archivo, schema completo de una vez | Tenant migrado incrementalmente, con datos históricos | Constraint nueva vs datos viejos | **F13-09** |
| Versión de PostgreSQL | 16-alpine (CI) / 16.13 (local) | PG 18 plataforma, PG 17 tenants (documentado) | Comportamiento de índices/planner | Ya registrado: **F11-07** |
| SQL de repositorios sin integración | `db.query` mockeada, decisión por `includes()` del texto | PostgreSQL real | SQL inválido o semánticamente mal pasa verde | **F13-11**, **F13-13** |
| Reportes | 7 repos reemplazados por fakes en memoria | Agregaciones SQL reales | Números equivocados en gerencia | **F13-05** |
| AFIP | `vi.fn()` casteado a `Arca` | SDK real contra AFIP | Mapeo de errores del SDK | **F13-16** |
| PDF | `vi.mock('@arcasdk/pdf')` | Chromium instalado en el build de Render | Binario ausente / versión | **F13-16** |
| Email | Tests con sender fake | `NoopEmailSender` si falta `RESEND_API_KEY`, Resend si está | Fail-open declarado a propósito | — |
| SSL | `sslConfig()` con env de test | `NEON_SSL` | Ya registrado en pendientes (`089ca3e`, verificación abierta) | — |
| Frontend | 25 tests de funciones puras, `environment: 'node'` | 82 componentes React en Next 16 / Vercel | Todo lo que sea render, estado o navegación | **F13-07** |

---

## 5. Pruebas de caracterización propuestas (pedido explícito del protocolo)

El protocolo pide: *"Antes de refactorizar módulos críticos, propón pruebas de caracterización que capturen el comportamiento actual"* y *"distingue entre comportamiento actual, comportamiento deseado, y comportamiento accidental que no debería conservarse. No conviertas automáticamente el comportamiento actual en comportamiento correcto."*

Prioricé por **(riesgo de negocio × probabilidad de que un refactor lo toque × ausencia de red actual)**. Las 6 que siguen son propuestas, no implementaciones.

### 5.1 `src/domain/money.ts::round2` — la más urgente

| | |
|---|---|
| **Comportamiento actual (medido)** | `Math.round(n*100)/100`. `round2(1.005)=1`, `round2(1.015)=1.01`, `round2(8.165)=8.16`, `round2(2.675)=2.68`, `round2(-1.005)=-1`. |
| **Comportamiento deseado (declarado)** | Docblock `money.ts:11`: "Media hacia arriba, a 2 decimales". |
| **Comportamiento accidental** | La divergencia entre ambos para todo valor cuya representación binaria cae apenas por debajo del punto medio. **No es "media hacia arriba": es "media hacia arriba del float más cercano"**, que no es lo mismo. |
| **Qué congelar** | Tabla de ~15 entradas con los valores ACTUALES, con un comentario que diga literalmente que es caracterización y no contrato: cambiar cualquiera de esos números cambia importes ya emitidos. |
| **Decisión que NO toma la prueba** | Si la política debe cambiar. Eso es del dueño y tiene efecto retroactivo sobre facturas emitidas. |

### 5.2 `src/app.ts::createApp()` — smoke de wiring

| | |
|---|---|
| **Comportamiento actual** | Sin verificar por ningún test (F13-04). |
| **Qué congelar** | (1) `GET /health` → 200; (2) `GET /api/<ruta protegida>` sin token → 401 y NO 404 (prueba que el gate está antes del router); (3) un `DomainError` conocido → el status exacto que declara `error.middleware.ts`; (4) con `NODE_ENV=production`, `/openapi.json` y `/` no existen; (5) el orden `tenantMiddleware` → router (que `api-auth-gate-order.test.ts` declara explícitamente no cubrir). |
| **Por qué antes de refactorizar** | Cualquier reordenamiento de `app.ts` es hoy invisible salvo para un regex sobre texto. |

### 5.3 `src/facturacion/sql.invoice.repository.ts` — el SQL más cargado de reglas

| | |
|---|---|
| **Comportamiento actual** | 527 líneas, 23,72 % de cobertura unitaria. Su test (`sql.invoice.repository.test.ts:142-200`) afirma **12 substrings del SQL**, entre ellos reglas de negocio puras: `i.status = 'ISSUED'`, `r.type IN ('REFUND','ADJUSTMENT')`, `not.toContain('cbte_tipo = 8')`, `outstanding > 0`. |
| **Comportamiento accidental a no conservar** | Que la regla viva en un `toContain` de texto. Reformatear la query rompe el test sin cambiar nada, y cambiar la semántica manteniendo el substring lo deja verde. |
| **Qué congelar** | Por cada uno de los 12 `toContain`, un escenario de filas reales en integración que produzca el resultado esperado. El `toContain` puede quedar como documentación. |
| **Bloqueo** | Requiere F13-01 resuelto. |

### 5.4 `src/lib/http.ts` (frontend) — `handleApiResponse` + `extractErrorMessage`

| | |
|---|---|
| **Comportamiento actual** | `extractErrorMessage` (`:149`) prioriza `fieldErrors[0]` sobre `message`; `getErrorMessage` (`apiErrors.ts:69`) hace lo contrario. 49 archivos usan la primera; 2 pantallas la segunda. Sin tests para la primera. |
| **Comportamiento deseado** | No declarado en ningún lado. |
| **Comportamiento accidental** | Que el mismo error del backend se muestre distinto según la pantalla. |
| **Qué congelar** | Las mismas 7 entradas contra las dos funciones, con la diferencia escrita en el test. Y `handleApiResponse` (`:72`): qué hace exactamente con 401 (redirect a `loginPath`), con 4xx con body JSON, con 4xx sin body, y con 5xx. |
| **Por qué** | Es el único camino por el que el usuario ve un error, y hoy es reescribible sin que nada falle. |

### 5.5 `src/lib/refine/dataProvider.ts` (frontend, 357 líneas, 0 tests)

| | |
|---|---|
| **Comportamiento actual** | Sin verificar. Es el punto único por donde pasan todas las pantallas Refine. |
| **Qué congelar** | Por cada `ResourceAdapter` registrado: la URL y el query string exactos que produce `getList` con paginación + filtros + orden; cómo mapea la respuesta a `{ data, total }`; qué hace `getOne` con 404; qué manda `create`/`update`. Con `fetch` mockeado — no hace falta DOM. |
| **Por qué antes de refactorizar** | El `CLAUDE.md` del frontend declara que toda pantalla nueva que mapee a un recurso debe ir por Refine: el adaptador va a seguir creciendo. |

### 5.6 `src/api/middleware/error.middleware.ts::domainErrorStatus()`

| | |
|---|---|
| **Comportamiento actual** | 113 `case`, 13 códigos afirmados, 24 de 122 ramas sin cubrir (F13-14). |
| **Qué congelar** | Un `it.each` con la tabla completa código → status. Es caracterización pura: fija el contrato HTTP que el frontend ya consume vía `apiErrors.ts`. |
| **Comportamiento accidental posible** | Que algún código esté en el grupo de fallthrough equivocado. **Escribir la tabla es lo que lo va a revelar** — y si aparece uno mal, corregirlo es decisión de contrato, no de la prueba. |

---

## 6. No confirmado

```
No confirmado.
Información faltante: si algún tenant real tiene hoy dos o más recursos
  activos cuyos nombres normalizan (upper(btrim(name))) al mismo valor —
  lo que haría fallar `migrate:tenants` y bloquear el deploy de toda la
  flota (F13-09).
Cómo verificarlo: contra cada tenant DB de producción,
  SELECT upper(btrim(name)) AS k, count(*) FROM resources
   WHERE active = TRUE AND deleted_at IS NULL GROUP BY 1 HAVING count(*) > 1;
  o correr `npm run migrate:tenants` contra un tenant descartable primero.
```

```
No confirmado.
Información faltante: si el fallo del job `integration` en la corrida
  34961977304 de CI tiene exactamente el mismo desglose que mi corrida
  local (153 fallas, todas por `uq_resources_name`). Verifiqué que el job
  y el step fallaron, no el contenido del log.
Cómo verificarlo:
  curl -H "Authorization: Bearer <token>" \
    https://api.github.com/repos/Alejandro-Gabriel-Pozo/app/actions/jobs/<job_id>/logs
  (los logs requieren autenticación; la API pública de runs/jobs no).
```

```
No confirmado.
Información faltante: si la divergencia entre `extractErrorMessage` y
  `getErrorMessage` (F13-08) produce hoy un mensaje incorrecto en alguna
  pantalla real, o si las dos políticas son ambas aceptables en su
  contexto.
Cómo verificarlo: disparar un VALIDATION_ERROR con `fieldErrors` desde una
  pantalla de cada grupo (p. ej. `dashboard/categorias` usa getErrorMessage;
  `dashboard/clientes` usa extractErrorMessage) y comparar el toast.
```

```
No confirmado.
Información faltante: cuánto tarda el job `integration` en CI con 47 suites.
  El comentario de `.github/workflows/ci.yml:265-275` declara `timeout-minutes: 20`
  y admite que "el margen real con 47 suites no se remidió". Mi corrida
  local fue de ~30 s, pero en un runner de GitHub con contenedor Postgres
  y `npm install` el perfil es otro.
Cómo verificarlo: leer `run_duration_ms` del job `integration` en la última
  corrida donde haya sido verde (10de2c5, 2026-09-15T00:33).
```

```
No confirmado.
Información faltante: si los 3 archivos que mutan `process.env` sin hook de
  restauración (§3.5) pueden contaminar otro archivo en alguna combinación
  de orden no explorada por los 6 seeds probados.
Cómo verificarlo: `npx vitest run --sequence.shuffle` con 50+ seeds en un
  bucle, o agregar `unstubEnvs: true` a `vitest.config.ts` y ver si algo rompe.
```

```
No confirmado.
Información faltante: la cobertura REAL combinada (unitarios + integración).
  El 77,68 % reportado es solo de unitarios y con 14 patrones excluidos.
Cómo verificarlo: correr las dos suites con `--coverage` a directorios
  distintos y mergear los `coverage-final.json` (hoy el reporter configurado
  es `['text','lcov','html']`, sin `json`, así que primero habría que
  agregar `json` al reporter).
```

---

## 7. Resumen por severidad

| Severidad | Cantidad | IDs |
|---|---:|---|
| **CRÍTICA** | **1** | F13-01 |
| **ALTA** | **8** | F13-02, F13-03, F13-04, F13-05, F13-06, F13-07, F13-08, F13-09 |
| **MEDIA** | **8** | F13-10, F13-11, F13-12, F13-13, F13-14, F13-15, F13-16, F13-17 |
| **BAJA** | **3** | F13-18, F13-19, F13-20 |
| **Total** | **20** | |

### Los tres números que resumen la fase

1. **153 de 380** tests de integración fallan hoy en `origin/main`, por un solo commit, con CI confirmándolo — y se pushearon 10 commits encima.
2. **0** tests ejercitan `createApp()`, la regla 3 del propio `DEFENSIVE_DEVELOPING.md` del repo.
3. **25** tests de producto en el frontend, sobre 131 archivos fuente y 82 componentes, en el repo que auto-despliega a producción.

### Clasificación por tipo de problema (taxonomía del protocolo)

| Tipo | Hallazgos |
|---|---|
| Bug de prueba / harness | F13-01, F13-02, F13-03, F13-19 |
| Prueba insuficiente | F13-04, F13-05, F13-06, F13-07, F13-09, F13-13, F13-14, F13-16 |
| Requisito ambiguo | F13-10 (docblock vs código de `round2`) |
| Deuda técnica | F13-11, F13-12, F13-18, F13-20 |
| Bug de integración (cross-repo) | F13-08 (divergencia de política de errores) |
| Proceso / configuración | F13-15, F13-17 |
| Código muerto | ninguno nuevo |

### Lo que NO es un problema, y conviene dejar escrito

- No hay tests sin aserciones (0 de 2 772).
- No hay pruebas duplicadas (jscpd 1,26 %, todo setup; 0 duplicados reales entre los 23 títulos repetidos que inspeccioné).
- La suite unitaria es orden-independiente salvo 1 test de 2 433.
- `migrations/*.sql` sin tests es correcto: está declarado como histórico no aplicado.
- Los 3 catálogos de roles del frontend están sincronizados hoy con el backend.
- Los tests "solo-mock" sin payload son el 1,8 %, no la mayoría.
- La disciplina de docblocks es excepcional: casi todas las cercas declaran por escrito **lo que NO garantizan**, y varias de las limitaciones que reporto acá ya estaban anticipadas por su propio autor. El problema no es que el repo no sepa dónde están sus huecos — es que el mecanismo que los vigila (la suite de integración) está apagado desde el 15/09.

### Orden recomendado de atención (no es una decisión, es una consecuencia de la evidencia)

1. **F13-01** — 1 línea en `seed.ts`. Sin esto, nada de lo demás se puede verificar.
2. **F13-02 + F13-03** — higiene de aislamiento; barato, y evita que F13-01 se repita con la próxima constraint.
3. **F13-04** — un archivo de smoke; cierra una regla que el repo ya se impuso por escrito.
4. **F13-05 / F13-06 / F13-09** — los tres huecos con dinero u operación detrás.
5. El resto, por el criterio del dueño.

---

## Apéndice A — Corrección del gate (`architecture-governor`, 16/09/2026)

**A.1 — F13-15: la degradación de la señal de CI está subdeclarada. No son
14 de las últimas 40 corridas en rojo: son 32 de 40, y la racha consecutiva
más larga no es la de `lint` sino una de `integration` de 18 corridas.**

El gate consultó la misma API pública de GitHub Actions
(`/actions/runs?branch=main&per_page=40`, rama `main`, las 40 del workflow
`CI` / `.github/workflows/ci.yml`, ventana 2026-09-11T22:32 → 2026-09-15T11:11)
y obtuvo **32 `failure` y 8 `success`**.

Las 14 filas que F13-15 enumera son **todas correctas** — fecha, `head_sha` y
job verificados una por una, incluidas las 12 de `lint`, y confirmado contra
`git log` que esas 12 son commits de solo documentación. El error es de
alcance: la enumeración se cortó en `7f32c30` (2026-09-13T01:29) y se tomó ese
corte como el conjunto completo de rojos de la ventana. No lo era.

Las 18 corridas restantes de la ventana —**`206964b` (2026-09-11T22:32) hasta
`a384ddd` (2026-09-12T23:02)**— fallaron **todas por el job `integration`**,
y la racha la cortó `4d85871` (2026-09-12T23:43, `success`).

En consecuencia:

- **La tasa real de rojo en la ventana es del 80 %, no del 35 %.**
- **La racha consecutiva más larga es de 18 corridas del job `integration`**,
  no de 12 de `lint`. Es decir: el job `integration` ya había estado
  permanentemente rojo durante 18 pushes tres días ANTES de `073a8d4` —
  el mismo job, el mismo modo de falla de proceso que F13-15 describe,
  ocurriendo por segunda vez.
- **"Es la tercera causa distinta en tres días" queda corto:** en la ventana
  de 40 hay 3 nombres de job distintos pero **4 episodios** (integration →
  lint → schema-version-check → integration).
- **La severidad MEDIA de F13-15 no cambia, y su tesis se refuerza:** la
  corrección va en la dirección de agravar el hallazgo, no de moderarlo.

**Esto no afecta a F13-01.** La racha de `integration` del 11-12/09 es una
rotura anterior y distinta, ya resuelta el 12/09. La bisección de F13-01 fue
reproducida de forma independiente por el gate sobre un clon propio y un
cluster PostgreSQL propio: `073a8d4^` (`089ca3e`, 15/09) da **367/367 verde**
y `073a8d4` da **151 fallas**. La cadena causal de F13-01 se sostiene sin
cambios.
