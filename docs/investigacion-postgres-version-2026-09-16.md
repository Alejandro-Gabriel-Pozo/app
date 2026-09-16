# Investigación D-22/P-13 — versión real de Postgres por entorno (16/09/2026)

## Contexto

Wave 6 del plan de ejecución integral (`docs/plan-ejecucion-integral-2026-09-16.md`,
fila 6: *"Versión real de Postgres por entorno: tools MCP de Render, no requiere
agente"*). `docs/decisiones-plan-integral-2026-09-16.md` P-13/D-22 decide
*"unificar plataforma y tenants a una sola versión de PostgreSQL"*, con gatillo
*"al planificar el bloque, confirmar costo/tiempo de migrar el entorno de CI y
cualquier entorno de desarrollo a la versión unificada"* — es decir, este bloque
es investigación y propuesta, no ejecución de ningún cambio de versión.

**Este documento no ejecuta ninguna migración de Postgres.** Solo mide el
estado real y corrige la cita previa que motivó la decisión.

## Método

Los datos de este documento salen de llamadas reales a los MCP de Neon y
Render en esta sesión (no inferidos, no asumidos), y se verificó la
identidad de cada proyecto/servicio contra este mismo repo antes de usarlo:

- **Render:** el único servicio del workspace (`srv-d8tdt41kh4rs73buo5ng`,
  nombre `app`) tiene `repo: https://github.com/Alejandro-Gabriel-Pozo/app`
  (coincide con este repo) y `buildCommand` idéntico, carácter por carácter,
  al `buildCommand` de `render.yaml`
  (`npm install && npx puppeteer browsers install chrome && npm run build &&
  npm run migrate:tenants`). No hay instancias de Postgres en Render — la
  plataforma y los tenants viven en Neon, no en Render Postgres.
- **Neon — plataforma:** proyecto `pdb-ppms` (`morning-unit-50056927`), branch
  `production` (`primary: true`, `default: true`). Confirmado como el
  proyecto real de este repo por sus branches de respaldo, que coinciden con
  los tags/checkpoints que esta misma sesión y el resto del plan ya citan:
  `respaldo-pre-fase3-2026-08-29`, `respaldo-pre-v50-2026-09-12`,
  `respaldo-pre-v44-2026-08-28`, `respaldo-pre-preset-revoke-001-2026-09-10`,
  y `preview/claude/hola-jipqh9` (coincide exactamente con la rama de trabajo
  real de esta sesión).
- **Neon — tenants:** proyecto `DB-APP-PPMS` (`ancient-king-17098519`), un
  branch por negocio. Branch `tenant-template-empty` coincide con
  `NEON_TEMPLATE_BRANCH_ID` (`render.yaml`, provisioning automático de BD por
  negocio, 15/08/2026). Branch `tenant-hotel-los-alamos` es un negocio real
  ya provisionado. También tiene sus propios respaldos con el mismo patrón
  de nombres (`respaldo-hotel-pre-v52-city-ledger-2026-09-12`,
  `respaldo-hotel-pre-v50-2026-09-12`).
- **Descartado explícitamente:** un tercer proyecto Neon del mismo workspace,
  `inventario-api` (`morning-field-10188884`, PG 17, región distinta
  `us-west-2`), no tiene ninguna señal de pertenecer a este servicio —
  no se usa en ningún dato de este documento.
- **CI:** `.github/workflows/ci.yml` (`grep -n "postgres:" .github/workflows/*.yml`)
  usa `postgres:16-alpine` como contenedor de servicio.
- **Entorno local de esta sesión:** PostgreSQL 16.13 (servidor local
  levantado en esta misma sesión, usado para las verificaciones reales de
  las Waves 4-6 — ver Apéndice F de `plan-ejecucion-integral-2026-09-16.md`).

## Resultado medido

| Entorno | Versión real de Postgres |
|---|---|
| Plataforma (Neon `pdb-ppms`, branch `production`) | **18** |
| Tenants (Neon `DB-APP-PPMS`, branches por negocio) | **18** |
| CI (`.github/workflows/ci.yml`) | **16** (`postgres:16-alpine`) |
| Local, esta sesión | **16.13** |

## Corrección a la cita previa de P-13/D-22

`docs/decisiones-plan-integral-2026-09-16.md:41` y `:163` citan *"Tests en
PG16, producción en PG17 (tenants) / PG18 (plataforma)"* — esa cita ya **no
coincide** con el estado real medido hoy: **tenants está en PG18, no PG17**.
Esta investigación no determinó CUÁNDO cambió (pudo ser un upgrade de Neon
posterior a cuando se escribió esa cita, o la cita ya estaba desactualizada
al escribirse) — eso queda fuera de este bloque puntual; no se investigó por
no ser necesario para la decisión de P-13.

**Consecuencia práctica para P-13:** la mitad de la decisión que dice
*"unificar plataforma y tenants entre sí"* ya está cumplida en producción —
los dos ya corren PG18, sin que nadie lo haya planeado como tal. No queda
trabajo ahí. La divergencia real y accionable es otra: **CI (PG16) y el
entorno de desarrollo local (PG16.13) contra producción (PG18)** — dos
versiones mayores de diferencia, no una.

El runbook de pre-chequeo de P-13 (`SELECT upper(btrim(name)), count(*) FROM
resources ... HAVING count(*) > 1` y similares, antes de cualquier
constraint nueva) ya fue adoptado como práctica independiente
(`docs/decisiones-plan-integral-2026-09-16.md` Apéndice A.8(i)) y no se toca
en este bloque.

## Propuesta (no ejecutada en este bloque)

Alinear CI a PG18 (`postgres:16-alpine` → `postgres:18-alpine` en
`.github/workflows/ci.yml`) para que la única versión que se ejercita
automáticamente sea la que corre en producción. Costo estimado: cambio de
una línea en `ci.yml` + correr la suite de integración completa contra un
Postgres 18 real (local o Neon) antes de mergear ese cambio — no se hizo en
este bloque. Sin migración de datos de producción involucrada (Neon ya
corre PG18 en producción hoy) — el radio de este cambio es mucho menor que
el que P-13 asumía originalmente (una migración real de versión de Postgres
en producción, que no hace falta porque plataforma y tenants ya convergieron
solos).

**Sin ejecutar en este bloque, a decidir en qué Wave entra:** Wave 7 ya toca
`.github/workflows/ci.yml` para `D-13`/`P-09` (cerca de conteo del build) —
candidato natural para sumar este cambio de una línea en el mismo sub-bloque,
en vez de abrir un Wave aparte para un cambio de este tamaño.

## Lo que este documento NO hace

- No cambia ninguna versión de Postgres real (ni CI, ni local, ni producción).
- No determina la causa ni la fecha del cambio PG17→PG18 de los tenants.
- No mide si algún tenant individual quedó en una versión distinta al resto
  dentro del mismo proyecto Neon — Neon versiona por proyecto, no por
  branch, así que todos los branches de `DB-APP-PPMS` comparten el mismo PG18
  medido acá; no se verificó branch por branch por ser redundante con esa
  propiedad de Neon.
