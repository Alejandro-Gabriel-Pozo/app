# Auditoría técnica integral — Fase 0: preservar el estado actual

**Fecha:** 15/09/2026. **Alcance:** solo lectura, ningún archivo de código
modificado. Ejecutado por el agente `auditor-estructura` a pedido del dueño,
sobre los dos repos que forman el sistema:

- Backend — `/home/user/app` (`Alejandro-Gabriel-Pozo/app`)
- Frontend — `/home/user/appfrontend` (`Alejandro-Gabriel-Pozo/appfrontend`)

Este documento es el primero de dos (ver `docs/auditoria-integral-fase1-2026-09-15.md`
para el mapa estructural y los cruces entre dominios). Corresponde a la Fase 0
de la instrucción de auditoría completa del dueño (16 fases) — no se avanzó
más allá de Fase 0 + Fase 1 en esta ronda; las fases posteriores requieren
autorización explícita antes de empezar.

---

## Backend — `/home/user/app`

| Ítem | Valor |
|---|---|
| Rama | `main` |
| Working tree | **Limpio** — `git status --short` vacío (0 líneas, sin untracked) |
| HEAD | `0ae7f8f feat(facturacion): credit_note_request Bloque 4 -- transiciones automáticas` (2026-09-15 03:02 +0000) |
| vs `origin/main` | `git rev-list --left-right --count origin/main...HEAD` → **`0 11`** = 0 atrás, **11 commits locales sin pushear** |
| `origin/main` | `10de2c5 feat(facturacion): ORDER-CONSOLIDATED-PARTIAL-01 bloque 1d` (2026-09-15 00:33 +0000) |
| Runtime | `engines.node: ">=22.12.0 <23.0.0"`; CI usa Node `'22'`; `render.yaml` `NODE_VERSION: "22"`. Sin `.nvmrc` |
| TypeScript | `^5.7.0` (dependencia de producción, no devDependency). `target: ES2022`, `module/moduleResolution: NodeNext`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns` |
| Framework | Express `^4.21.0`, `pg` `^8.13.0`, `zod` `^3.24.0`, `luxon`, `pino`, `@sentry/node`, `@arcasdk/core`+`@arcasdk/pdf` (AFIP), `swagger-ui-express`, `helmet`, `express-rate-limit` |
| Gestor de paquetes | **npm** (solo `package-lock.json`, 344 KB). `patches/@arcasdk+pdf+0.2.0.patch` vía `patch-package` en `postinstall` |
| Tipo de módulo | ESM (`"type": "module"`) |

**Comandos reales (citados tal cual de `/home/user/app/package.json`):**

```
postinstall        patch-package
dev                tsx watch src/server.ts
start              node dist/server.js
build              rm -rf dist && tsc && cp src/db/schema.sql dist/db/schema.sql && cp src/db/platform.schema.sql dist/db/platform.schema.sql
test               vitest run
test:watch         vitest
test:coverage      vitest run --coverage
test:integration   vitest run --config vitest.integration.config.ts
migrate:tenants    tsx src/scripts/migrate-tenants.ts
purge:outbox       tsx src/scripts/purge-outbox.ts
docs:routes        tsx src/scripts/generate-route-inventory.ts
lint               eslint src --ext .ts --max-warnings 0
lint:fix           eslint src --ext .ts --fix
lint:arch          depcruise src --config .dependency-cruiser.cjs --output-type err
deadcode           knip
```

**Los 11 commits locales sin pushear (backend):**
`0ae7f8f`, `c85ef33`, `8bba434`, `0ebbf48`, `fc3a72d`, `99a86f0`, `14685db`,
`0c58a7a`, `ffd9ed1`, `808cc34`, `24fa237` — bloques `credit_note_request`
(1–4), `service_items` (B/C/D), schema v56/v57, y 2 commits de docs.

> Nota de esta transcripción (no estaba en el momento de la auditoría): el
> Bloque 5 de `credit_note_request` ya se implementó y está pendiente de gate
> + commit al momento de escribir este documento — el conteo de commits sin
> pushear de arriba quedará desactualizado en cuanto eso se commitee. No se
> re-cuenta acá a propósito: el estado de push es volátil y el propio
> `CLAUDE.md` de este repo pide no citarlo como hecho fijo, sino
> re-verificarlo con `git` en el momento que haga falta.

---

## Frontend — `/home/user/appfrontend`

| Ítem | Valor |
|---|---|
| Rama | `main` |
| Working tree | **Limpio** (0 líneas) |
| HEAD | `ed4ed0f feat(ordenes): espejo de service_items Bloque C (app-main)` (2026-09-15 01:47 +0000) |
| vs `origin/main` | **`0 1`** = 0 atrás, **1 commit local sin pushear** (`ed4ed0f`) |
| `origin/main` | `e841d46 fix(finanzas): agregar revertedAmount a AccountsReceivableReportRow` (2026-09-14 04:25 +0000) |
| Runtime | Sin `engines` ni `.nvmrc`. CI (`.github/workflows/ci.yml`) fija **Node `'24'`** "alineado al runtime real de Vercel, verificado 01/09/2026" |
| TypeScript | `^5`, `noEmit`, `moduleResolution: bundler`, `target: ES2017`, paths `@/* → ./src/*` |
| Framework | **Next.js `16.3.1`** (App Router), React `19.2.8`, `@refinedev/core ^5.0.12`, `@refinedev/nextjs-router ^7.0.5`, `@tanstack/react-query ^5.101.4`, Tailwind `^3.3.0` |
| Gestor de paquetes | **npm** (solo `package-lock.json`, 301 KB) |

**Comandos reales (citados tal cual de `/home/user/appfrontend/package.json`):**

```
dev           next dev
build         next build
start         next start
lint          eslint .
typecheck     tsc --noEmit
lint:visual   node scripts/check-visual-debt.mjs
test:visual   node --test scripts/lib/*.test.mjs
test:unit     vitest run
```

---

## Archivos que no deberían estar versionados — resultado

**No se encontró ningún secreto real versionado en ninguno de los dos repos.**
Detalle (sin pegar contenido):

- Backend: `git ls-files` no devuelve ningún `.env`, `.pem`, `.key`, `.crt`,
  `.dump`, `.sql.gz`. Los únicos matches de `credentials|secret` son
  **nombres de código fuente legítimos**
  (`src/facturacion/afip-credentials.repository.ts`,
  `src/facturacion/sql.afip-credentials.repository.ts` + su test, y
  `.claude/skills/secret-lifecycle-discipline/SKILL.md`). No hay archivos
  `.env*` en disco.
- Frontend: solo `.env.example` versionado, con **dos nombres de variable y
  sin valores sensibles** (`NEXT_PUBLIC_API_URL`,
  `NEXT_PUBLIC_GOOGLE_CLIENT_ID`).
- `.gitignore` de ambos cubre `.env` y `.env.local`. El del backend además
  excluye a propósito `.claude/skills/neon*/`, `skills-lock.json` y
  `.reviews/` con motivo comentado.
- Todos los secretos de producción en `/home/user/app/render.yaml` están
  como `sync: false` (sin valor): `JWT_SECRET`, `PLATFORM_DATABASE_URL`,
  `DB_ENCRYPTION_KEY`, `CORS_ORIGIN`, `PLATFORM_JWT_SECRET`,
  `PLATFORM_ADMIN_EMAIL/_PASSWORD`, `NEON_API_KEY`,
  `NEON_TEMPLATE_BRANCH_ID`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`,
  `GOOGLE_CLIENT_ID`, `SENTRY_DSN`.
- **Único valor identificador en claro:** `NEON_PROJECT_ID:
  ancient-king-17098519` (`render.yaml:98-99`). Es un identificador de
  proyecto, no una credencial — inútil sin `NEON_API_KEY`. Se reporta como
  observación de bajo nivel, no como CRÍTICO.

**Conclusión Fase 0: cero hallazgos CRÍTICOS de secretos.** El riesgo real de
Fase 0 es otro: **12 commits (11 backend + 1 frontend) existen solo en esta
máquina**. Cualquier hallazgo que la auditoría ancle contra `HEAD` no es
reproducible desde GitHub hasta que se pushee — la regla ya documentada en
el `CLAUDE.md` de este repo ("Pendientes — revalidar antes de arrastrar",
regla 2: al arrastrar, se re-chequea el ancla) aplica también acá.

No se creó ninguna rama de auditoría separada (`audit/initial-review`): la
auditoría es de solo lectura por diseño (el agente no tiene `Write`/`Edit`),
así que no hay riesgo de modificar el working tree sobre el que se está
auditando.
