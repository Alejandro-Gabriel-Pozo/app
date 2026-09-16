# Plan de ejecución integral — 16 oleadas (16/09/2026)

**Fecha:** 2026-09-16
**Origen:** diseño producido por un subagente `Plan`, a partir de `docs/plan-integral-sistemico-2026-09-16.md` §3, `docs/auditoria-integral-fase16-2026-09-16.md` §12/§13, `docs/decisiones-plan-integral-2026-09-16.md` (25 decisiones + Apéndices A-E), `docs/decisiones-auditoria-fase2-2026-09-15.md` §11, `docs/pendientes-2026-09-12.md`, y las 4 definiciones de agente en `/home/user/app-main-frontend-root/.claude/agents/`.

**Propósito:** este documento **no es otra síntesis** — es el plan de EJECUCIÓN que mueve el backlog ya documentado (auditoría de 16 fases + `pendientes-2026-09-12.md` + 25 decisiones ya tomadas) hacia "resuelto", organizado en oleadas secuenciadas por dependencia real y con un criterio explícito de cuándo usar cada uno de los 4 subagentes especializados del repo.

---

## 0. Un plan maestro único, no varios

Se descartó fragmentar en varios documentos de plan. Razón: esta misma sesión ya demostró el costo de sincronizar contenido entre documentos separados — la colisión de 10 IDs `D-XX` entre Fase 15 y `decisiones-auditoria-fase2-2026-09-15.md`, la cita huérfana de "#N de los 20 más importantes", una tabla resumen que contradijo su propio detalle (P-11) — son todos síntomas de ese mismo problema. Un plan maestro único con oleadas internas:

- No suma un onceavo "artefacto manual" a los diez que `CLAUDE.md` ya cuenta (sección RBAC/Contratos).
- La ejecución real la hace una sola sesión secuencial (Write/Edit), no hay paralelismo de equipos que justifique varios documentos.
- Las oleadas ya funcionan como planes independientes de facto — cada una es su propio bloque de alcance con sus propias dependencias declaradas.

Lo único que vive fuera de las oleadas es el mecanismo de barrido continuo (§6) — es un proceso recurrente, no una oleada, y mezclarlo le resta legibilidad a ambos.

---

## 1. Convenciones transversales (aplicadas en todo el documento, no repetidas por oleada)

- **Ningún `D-XX` se cita sin su documento.** `D-07 (Fase 15)` ≠ `D-07 (decisiones-auditoria-fase2, TTL de sesión)`. Aplica a los 10 IDs colisionados: `D-02, D-03, D-07, D-08, D-09, D-10, D-14, D-15, D-16, D-23`.
- **Ninguna cita "#N de los 20 más importantes" se repite como si `pendientes-2026-09-12.md` la dijera literalmente** — ese ranking viene de un reporte de sesión no versionado (`plan-integral-sistemico` Apéndice A.5). El orden relativo entre esos ítems se conserva; la cita de autoridad no.
- **Dos fuentes con roles distintos, ninguna reemplaza a la otra:** `plan-integral-sistemico §3` decide **cuándo** arranca cada cosa (con qué bloquea); `auditoria-integral-fase16 §12/§13` provee el **criterio de finalización** granular de cada acción.
- **Ya resuelto, excluido de las oleadas:** `D-21` (verificado en esta sesión) y `P-05/D-07(a)` (0/0 filas, 2/2 tenants reales, Apéndices B+D de `decisiones-plan-integral`). El track de `credit_note_request` (4 bloques restantes, tarea #28) y `service_items` Bloque D (tarea #27) siguen su hilo ya en curso — no se renumeran acá, solo se gatean igual.

---

## 2. Criterio de uso de los 4 agentes

No existe hoy una regla escrita en el repo sobre cuándo invocar cada uno — este documento la propone:

| Agente | Cuándo SÍ | Cuándo NO |
|---|---|---|
| **`architecture-governor`** | **Siempre, sin excepción**, antes de cada commit/push/migración/cambio de contrato/deploy/actualización de roadmap (regla ya vigente en `CLAUDE.md`). Su §4.0 (gate de impact-analysis) se invoca explícitamente cuando un bloque toca un concepto con consumidores no descartados (config, forma de error HTTP, RBAC). | Nunca se salta. Es el único de los 4 sin excepción. |
| **`erp-audit-orchestrator`** | Después de completar un bloque que cierra o pone en riesgo un circuito de negocio completo (UI→endpoint→servicio→transacción→SQL→outbox/evento→reporte): dinero, emisión fiscal, estado de reserva/orden. Waves 2, 4, 9 (tramo AFIP), 12, 13, 15 (D-14). | Para fixes de infraestructura/test-harness/dependencias/config puros sin circuito de negocio detrás (Waves 1, 3, 5, 6, 7, 8, 10, 16). Invocarlo ahí es ruido. |
| **`auditor-circuitos-erp`** | Solo para preguntas de diseño técnico que **todavía no tienen grounding** en `grounding-25-preguntas-2026-09-16.md` — ej. el modelo concreto de "perfil fiscal del cliente" en Wave 14. | Para cualquier ítem que ya usó esta herramienta en la sesión de grounding — reinvocarlo ahí es redundante, y el agente no decide UX/producto por su cuenta. |
| **`auditor-estructura`** | Después de un bloque que toca un servicio compartido/transversal (`TransactionManager`, logger, `config/env.ts` nuevo) o que extrae/consolida algo duplicado (Wave 15, D-14: 4 copias de aprovisionamiento). Waves 7 (tras crear `config/env.ts`), 8, 15. | No después de cada bloque chico de un solo archivo — desproporcionado. |

---

## 3. Oleadas

| # | Oleada | Ítems (ID · documento) | Por qué ese orden | Agentes (cuándo · por qué) | Bloques (orden de magnitud) |
|---|---|---|---|---|---|
| **1** | Desbloquear la verificación | `D-21` (Fase 15/16, Etapa 1) | Nada de lo que toca `schema.sql` o performance se puede validar sin esto — bloquea Waves 5, 6, 9 (parcial), 10 | `architecture-governor` en el commit. Nada más — 1 línea, causa raíz conocida | 1–2 |
| **2** | Token CUSTOMER en rutas de staff | `P-01/D-03` (Fase 15) = `F5-01` (pendientes) | Decisión ya tomada; Fase 15 advierte riesgo de romper el portal — conviene resuelto temprano | `architecture-governor` en diseño y commits. `erp-audit-orchestrator` **después**, para confirmar que ninguna pantalla del portal quedó rota | 2–3 |
| **3** | Superficie de consumo (adelantada) | `D-23(1)` inventario×consumidores, `D-24(1)` fila de roadmap "Caja incompleto", `D-25(1)(2)` comentario+cerca HOLD (Fase 15/16 Etapa 9) | Aditiva, cero riesgo — se adelanta porque Wave 9 (error 400 único) necesita este inventario para no romper un consumidor externo desconocido | `architecture-governor` por commit. Ninguno de los otros 3 | 3 |
| **4** | P1 sin bloqueo de decisión | `D-01` (Fase 15/16, Etapa 2) · `D-07(c)` (Fase 15) — inventario de 20 DML + gate/retiro de las 3 de disparo abierto + prueba del Apéndice C.5 | `D-07(a)` ya resuelto habilita `D-07(c)` sin esperar nada más; `D-01` es el patch de menor radio de toda la auditoría | `architecture-governor` por commit. `erp-audit-orchestrator` **después de `D-07(c)`** (cambia comportamiento de tarifas de clientes) | 5 |
| **5** | Bloque de schema — guards | `D-08` (Fase 15/16, Etapa 3) | Depende de Wave 1. No se solapa en el tiempo con Wave 4 (ambas tocan `schema.sql`) | `architecture-governor` mandatorio. Consulta puntual a `erp-audit-orchestrator` solo si el diseño del guard genera duda real | 2 |
| **6** | Migrador real + alineación de versión | `D-09` (Fase 15), `D-22`/`P-13` (Fase 15) | Depende de Wave 5 completa — dejar de saltar sin el guard vuelve cada deploy un apply completo por tenant | `architecture-governor` mandatorio. Versión real de Postgres por entorno: tools MCP de Render, no requiere agente | 3 |
| **7** | Config y pipeline | `D-13`/`P-09`, `D-06`/`P-04`, `D-15`/`P-11` (Fase 15/16, Etapa 8, orden interno: cerca de conteo → D-13 → D-06 → `config/env.ts` → 3 bloques chicos) | Todas ya decididas, sin bloqueo con Waves 5–6 — puede correr en paralelo | `architecture-governor` por sub-bloque. `auditor-estructura` **después** de crear `config/env.ts` (abstracción nueva sobre 26 archivos) | 6 |
| **8** | Dinero y observabilidad de bajo acoplamiento | `D-02`, `D-11`, `D-10`/`P-07` (Fase 15/16, Etapa 4) | Independiente de todo lo anterior, un archivo por sub-bloque | `architecture-governor` mandatorio. `auditor-estructura` **después** (toca `TransactionManager`, 69 call sites) | 3 |
| **9** | Contrato de error único + timeouts | `D-16`, `D-20` (Fase 15/16, Etapa 6) | Depende de Wave 1 **y de Wave 3** — sin el inventario de consumidores, este bloque vuela a ciegas sobre las ~20 rutas afectadas | `architecture-governor` con su §4.0 aplicado literalmente. `erp-audit-orchestrator` **después**, solo para el tramo AFIP (D-20) | 4–5 |
| **10** | N+1 de reservas | `D-17` (Fase 15/16, Etapa 7) | Solo depende de Wave 1 — puede adelantarse si hay capacidad libre | `architecture-governor` mandatorio | 1 |
| **11** | Contención RBAC del escape fiscal de la reversa | `CITY-LEDGER-REVERSE-ROUTE-GROUP-FREEZE-001` (pendientes) | El diseño queda abierto a propósito entre extender `ESCAPE_ROUTES` o una cerca nueva de AND-composition — bloque de diseño explícito antes de tocar código | `architecture-governor` en el diseño (decide el molde de cerca) y en el commit | 2 |
| **12** | Doble emisión de CAE sobre cargo revertido | `§7.2(b)` (pendientes) | Circuito completo nunca reconstruido — caso de uso textual de `erp-audit-orchestrator` | `erp-audit-orchestrator` **antes** de diseñar (reconstruye `reverseTransfer()` + emisión CAE, ubica el punto exacto sin lock). `architecture-governor` mandatorio en el commit. `auditor-circuitos-erp` solo si no aparece precedente claro | 3 |
| **13** | Resto de City Ledger / NC con diseño propio | `CITY-LEDGER-AR-DOUBLE-TRANSFER-001`, `CN-ESCAPE-ORPHAN-ADJUSTMENT-001` (si el HOLD de `invoice_drafts`/`FACT-BORRADOR-001` ya se levantó — si no, pasa al barrido continuo), `CITY-LEDGER-GUARD-RETRY-EMITS-001`, `POOL-MIXTO-MANUAL-01` (pendientes) | Comparten dominio — agruparlos evita reabrir el mismo archivo 4 veces en 4 oleadas | `erp-audit-orchestrator` antes de cada diseño. `architecture-governor` mandatorio por commit | 6–8 |
| **14** | Decisiones de mayor alcance, diseño técnico pendiente | `P-16/D-25` (perfil fiscal), `P-15/D-24` (UI de Caja), `locations` vs `companies` (mantener separado), `4.3` (reserva por tipo de unidad) (pendientes) | Decisión de producto ya cerrada en las 4, diseño técnico todavía sin escribir — las de mayor costo/incertidumbre del plan | `erp-audit-orchestrator`/`auditor-circuitos-erp` antes de cada diseño, **solo si el grounding existente no lo cubre ya**. `architecture-governor` mandatorio en diseño y commits | 4–8 por ítem |
| **15** | Sesión + saga de aprovisionamiento | Reconciliación `P-02/D-04` (Fase 15) + `D-07 (decisiones-auditoria-fase2 §11)` TTL por tenant → luego `D-04`, `D-05/P-03`, `D-12/P-08` (sweep completo), `D-18/P-12` (dirección del bus `wake()`), `D-19/P-10` (materializar PDF; timeout no-opcional, puede adelantarse solo), `D-14` (extracción `tenant-provisioning.service.ts`, con sus 3 prerrequisitos: regresión de los 4 caminos + Regla 3 §11 + backup durable) | `D-14` es el bloque de mayor riesgo de todo el plan ("sin rollback para una base a medias") — va último a propósito | `architecture-governor` mandatorio en todo, incluida la skill `criterios-negocio` para el bloque de sesión. `auditor-estructura` antes/durante `D-14`. `erp-audit-orchestrator` después de `D-14` | 10+ |
| **16** | Pool oportunista P3/P4 | `1.B` sidebar por grupo (pendientes), `SEC-ROT-001` Parte 2/3, resto de "🟡 listo para encarar" (~16 ítems) | Sin bloqueo técnico ni de decisión — solo falta tiempo/gate. Se intercala en huecos de capacidad de las Waves 4–15 | `architecture-governor` mandatorio por commit | 16–20 |

---

## 4. Corrección aplicada en Wave 7 (contradicción P-11/D-15)

La tabla resumen de `decisiones-plan-integral` dice "1 por tenant, 1 por plan, 1 constante"; el detalle real (Apéndice A.3) es **2 constantes de producto** (`PASSWORD_RESET_EXPIRES_HOURS`, `OUTBOX_RETENTION_DAYS`) **+ 1 ligado a `PLAN_LIMITS`** (tope de paginación, por plan) **+ 0 por tenant**. Wave 7 ejecuta con esta lectura corregida.

---

## 5. Lo que no se puede planificar todavía

- **`P-16/D-25`, fecha de la RG 5616/2024:** fuente secundaria sin confirmar — requiere al contador del dueño. **No bloquea Wave 14** (la decisión de desbloquear el resolver ya está tomada independientemente de la fecha); solo cambiaría la prioridad relativa de esa oleada.
- **`P-14/D-23`, "¿existe algún consumidor de la API fuera de estos dos repos?"** — pregunta contractual, no resoluble leyendo código. Bloquea la decisión final "retirar vs. completar" familia por familia, no bloquea construir el artefacto de inventario en Wave 3.
- **No bloqueante:** el "dato de Render pendiente" que `P-09/D-13` y `P-10/D-19` citan (log del último `npm install`, límite de RAM del plan) es resoluble por esta misma sesión vía tools MCP de Render — se resuelve dentro de Waves 7/15, no requiere al dueño.

---

## 6. Mecanismo para el resto de `pendientes-2026-09-12.md` (~80-100 ítems fuera de toda oleada)

No es una oleada más — es un proceso continuo de tres capas:

1. **Barrido por localidad (por oleada):** al cerrar cada oleada, sobre los archivos que esa oleada tocó, aplicar las 5 reglas de `CLAUDE.md` ("Pendientes — revalidar antes de arrastrar") a cualquier ítem de las secciones 🔍/🟡/🟢/cosmético de `pendientes-2026-09-12.md` que comparta archivo o concepto con el cambio recién hecho.
2. **Pool oportunista para 🟡 "listo para encarar" (~16 ítems):** sin oleada fija — se intercalan en huecos de capacidad de cualquier oleada de las Waves 4–16, priorizados por cercanía de archivo con lo que ya está abierto (es Wave 16).
3. **Barrido periódico completo:** antes de cada `pendientes-<fecha>.md` nuevo (ya lo dispara el propio `CLAUDE.md`), correr `auditor-estructura` una vez sobre el diff acumulado de las oleadas recientes, y aplicar la migración de corte-y-pega a `resuelto.md` ya usada en esta sesión.

**No se tocan por default:** los ~5 🟢 "deuda aceptada" (solo se reabren si su ancla se rompe) y el 📋 "backlog de producto sin fecha" (conversación de producto aparte con el dueño, ningún agente de los 4 la gatea).

---

## 7. Resumen de magnitud

| Oleada | Bloques (orden de magnitud) |
|---|---|
| 1 · Verificación | 1–2 |
| 2 · Token CUSTOMER | 2–3 |
| 3 · Consumo/inventario | 3 |
| 4 · P1 sin bloqueo | 5 |
| 5 · Schema/guards | 2 |
| 6 · Migrador/versión | 3 |
| 7 · Config/pipeline | 6 |
| 8 · Dinero/observabilidad | 3 |
| 9 · Error único/timeouts | 4–5 |
| 10 · N+1 | 1 |
| 11 · Cerca reversa | 2 |
| 12 · Doble CAE | 3 |
| 13 · City Ledger resto | 6–8 |
| 14 · Mayor alcance | 4–8 c/u |
| 15 · Sesión + D-14 | 10+ |
| 16 · Pool P3/P4 | 16–20 |

---

## 8. Estado de arranque

El dueño autorizó, en la misma sesión que produjo este plan: commitear este documento y arrancar la Wave 1 (`D-21`) de inmediato. Cada bloque de implementación sigue el mismo proceso de gate (`architecture-governor`) y autorización explícita de push que el resto de esta sesión — este documento no autoriza push ni deploy de ningún bloque por sí mismo.

---

## Apéndice A — Correcciones del gate (`architecture-governor`, 16/09/2026)

Verificación independiente antes de commitear, contra el árbol real de
`/home/user/app` (`HEAD` = `origin/main` = `4b3f9fd`), las 4 definiciones de
`/home/user/app-main-frontend-root/.claude/agents/`, y los documentos fuente con
sus apéndices de corrección aplicados. El cuerpo (`:1-118`) no se edita — misma
convención que usaron los apéndices de `plan-integral-sistemico` y
`decisiones-plan-integral`.

**Lo que el gate NO pudo verificar:** si el DDL del Bloque 3a llegó a correr
contra las tenants reales vía algún deploy posterior al 14/09 (sin acceso a
Render ni a Neon desde el gate). Tampoco se corrió la suite: con `D-21` abierta
está roja por construcción y no aportaría señal sobre un cambio de docs.

### A.1 — `D-21` está VERIFICADA, no resuelta: el fix de 1 línea sigue sin aplicarse

`:27` dice: *"**Ya resuelto, excluido de las oleadas:** `D-21` (verificado en
esta sesión)"*. **Es falso.** Medido hoy:

- `src/tests/integration/helpers/seed.ts:90` sigue siendo
  `const name = overrides.name ?? 'Habitación 101';` — el default único por
  llamada que pide `fase16 §12` Etapa 1 no está.
- `git log -- src/tests/integration/helpers/seed.ts` → último commit `e84c779`,
  anterior a esta sesión.

Lo que pasó en la sesión fue **diagnóstico y confirmación de causa raíz**, no un
cambio de código — la distinción que el `CLAUDE.md` de este repo ya fija en
*"Un ítem con residuo no es 'cerrado'"*.

El propio documento se contradice: `:48` (Wave 1) y `:118` (§8) tratan `D-21`
como el primer bloque a ejecutar, y **esos dos son los correctos**.

Debe leerse, en `:27`: *"**Ya resuelto, excluido de las oleadas:** `P-05/D-07(a)`
(0/0 filas, 2/2 tenants reales, Apéndices B+D de `decisiones-plan-integral`).
**`D-21` NO está resuelta**: su causa raíz quedó verificada en esta sesión, pero
`src/tests/integration/helpers/seed.ts:90` sigue sin tocar — por eso es la Wave 1
y el primer bloque a ejecutar, no una exclusión."*

La segunda mitad de `:27` (`P-05/D-07(a)`) se verificó y es correcta.

### A.2 — Se cae un **P0** de `plan-integral-sistemico §3` sin declararlo

§3 de la fuente tiene **dos** filas P0. La segunda —*"Verificar Bloque 3a
(reversa del ledger, schema v52→v54) contra Postgres real con volumen, antes de
pushear"*, que bloquea *"el deploy que lo lleve"*— no aparece en ninguna de las
16 oleadas, ni en la exclusión de `:27`, ni en §5. Es el mismo modo de falla que
el Apéndice A.7 de `plan-integral-sistemico` corrigió en su propio §3 (dejar caer
`D-16`/`D-20` sin declararlo), reproducido un nivel más arriba.

Además su enunciado ya está stale, y el plan lo habría heredado:

- `git branch -r --contains 5ae9044` y `8f11d19` → **los dos en `origin/main`**.
  El *"antes de pushear"* ya no aplica.
- `CURRENT_SCHEMA_VERSION` = **59** en `src/platform/tenant-db.setup.ts`, local y
  en `origin/main` — no 54.

Lo que sigue abierto es la sustancia de `pendientes-2026-09-12.md:867-899`: el
DDL destructivo (`DROP COLUMN` + 2 `ADD CONSTRAINT` con lock `ACCESS EXCLUSIVE`
sobre `financial_transactions`) **nunca corrió contra Postgres real**. Si un
deploy posterior al 14/09 lo aplicó es dato no verificable desde el gate.

Debe agregarse como fila de oleada propia, antes de cualquier oleada que pushee
`schema.sql` (es decir, antes de las Waves 4/5/6): *"**Wave 0 — Residuo del
Bloque 3a.** Re-anclar el ítem contra el estado real (`5ae9044`/`8f11d19` ya en
`origin/main`; `CURRENT_SCHEMA_VERSION` = 59, no 54) y resolver con un
`SELECT MAX(version) FROM schema_migrations` de solo lectura contra las 2 tenants
si el DDL destructivo ya corrió. Hasta tener ese dato medido, ninguna oleada que
toque `schema.sql` se pushea."*

### A.3 — `:38`/`:55` contradicen a `fase16:38` sobre qué bloquea `D-21`

`fase16:38`: *"D-21 bloquea la validación de D-08, D-09, **D-11**, **D-12**, D-17
y D-22."* Mapeado a este plan: D-08→W5, D-09→W6, D-11→**W8**, D-12→**W15**,
D-17→W10, D-22→W6.

- `:48` dice *"bloquea Waves 5, 6, 9 (parcial), 10"* — omite **Wave 8** y
  **Wave 15**. (Sumar la Wave 9 sí está bien y tiene fuente: `fase16:585`
  da la dependencia de `D-16` como *"P0"*.)
- `:55` afirma que la Wave 8 es *"Independiente de todo lo anterior"* — falso
  para `D-11`, cuyo criterio de cierre en `fase16:583` es un test de integración
  con `pg_terminate_backend`, que no corre con la suite roja.

Debe leerse, en `:48`: *"…bloquea Waves 5, 6, 8 (D-11), 9 (parcial: D-16 sí,
D-20 no), 10 y 15 (D-12)"*. Y en `:55`: *"Independiente en diseño, pero su
**verificación** depende de la Wave 1 (`fase16:38`: D-21 bloquea la validación de
D-11)."*

### A.4 — La Wave 3 propone para `D-25` la opción que el dueño descartó

`:50` describe el sub-bloque como *"`D-25(1)(2)` comentario+cerca **HOLD**"*,
copiando el enunciado de `fase16 §12` Etapa 9 — que es **anterior a la decisión**.
`decisiones-plan-integral:199-206` registra: *"**Decisión:** desbloquear el
resolver fiscal, con diseño dirigido por el perfil del cliente"*, y lista
*"mantener en HOLD indefinido"* entre las **alternativas descartadas**.

Etapa 9 manda escribir en `src/facturacion/afip-catalog.constants.ts` el
comentario *"…en HOLD"* y una cerca que afirme `CBTE_TIPO_FACTURA_B` /
`CONSUMIDOR_FINAL` *"mientras el resolver esté en HOLD"*. Escribir eso el
16/09/2026 mete en el código una afirmación que el dueño volvió falsa ese mismo
día — y que la Wave 14 de este mismo plan desarma.

Debe leerse, en `:50`: *"`D-25(1)(2)` — comentario + cerca que congelan el estado
**actual** (`FACTURA_B`/`CONSUMIDOR_FINAL` literales), redactados como *'resolver
desbloqueado por decisión del 16/09/2026, todavía sin conectar — esta cerca cae
con el bloque de perfil fiscal de la Wave 14'*, **no** como 'en HOLD': el HOLD lo
levantó el dueño. La cerca es explícitamente temporal y su retiro es parte del
alcance de la Wave 14."*

### A.5 — §2 usa para `auditor-circuitos-erp` el texto que el Apéndice A.2 ya corrigió

`:39` da como único ejemplo *"el modelo concreto de 'perfil fiscal del cliente' en
Wave 14"*. Eso es `decisiones-plan-integral:205` **sin la corrección de su propio
Apéndice A.2**, que el encabezado de este documento (`:4`) declara haber aplicado.

A.2, medido contra los dos repos: el endpoint **tiene consumidor**
(`appfrontend-main/src/lib/clientes/api.ts:83,85`, desde
`src/app/dashboard/clientes/[id]/page.tsx:519`) y el modelo **ya existe y está
persistido** (`src/clientes-finanzas/customer-tax-profile.entities.ts`, índice
único `customer_tax_profiles_customer_uniq`, schema v27). Su corrección literal:
*"no rediseñar el modelo de perfil fiscal —ya existe—, sino (1) decidir si
`taxCondition` deja de ser texto libre y pasa a un catálogo cerrado alimentado por
`GET /api/customers/padron/iva-receptor-types`… y (2) conectar `resolveDocTipo()`
y el perfil a `invoice.service.ts` (`:592`, `:651`, `:750`, `:805`, `:879`)"*.

Consecuencia que ninguna fila declara: `padron/iva-receptor-types` es **una de las
15 familias huérfanas de `D-23`**, así que **la Wave 14 depende de la Wave 3**.

Debe leerse, en `:39`: *"…ej. si `taxCondition` pasa a catálogo cerrado en la Wave
14 — **no** 'el modelo de perfil fiscal', que `decisiones-plan-integral` Apéndice
A.2 ya midió como existente (`customer-tax-profile.entities.ts`, schema v27, con
pantalla y consumidor)."* Y en `:61`, sumar a la Wave 14: *"depende de la Wave 3 —
`padron/iva-receptor-types` es una de las 15 familias de `D-23`."*

### A.6 — "tarea #27" / "tarea #28" no tienen referente versionado

`:27` cita *"`credit_note_request` (4 bloques restantes, **tarea #28**)"* y
*"`service_items` Bloque D (**tarea #27**)"*. `grep -rn "tarea #" docs/` devuelve
**solo este archivo**; *"`service_items` Bloque D"* tampoco aparece en ningún otro
documento. Vienen de una lista de tareas de sesión no versionada.

Es exactamente el hallazgo que el Apéndice A.5 de `plan-integral-sistemico`
levantó para el ranking *"#N de los 20 más importantes"*, y lo que `:25` —el
bullet inmediatamente anterior— prohíbe en este mismo documento. También incumple
la Regla 1 de `CLAUDE.md` (*"Ningún ítem sin ancla verificable… un ítem sin
referente no se arrastra"*).

Debe leerse, en `:27`, sin los números de tarea: *"El track de
`credit_note_request` (4 bloques restantes) y el de `service_items` siguen su hilo
ya en curso — se gatean igual, y su ancla es `pendientes-2026-09-12.md`, no una
numeración de sesión."*

### A.7 — `:33` afirma que no hay regla escrita, y su propia tabla lo desmiente

`:33` dice *"No existe hoy una regla escrita en el repo sobre cuándo invocar cada
uno"*. El `CLAUDE.md` raíz (`:206-208`) es exactamente esa regla para
`architecture-governor` — y `:37`, una línea más abajo, lo concede
(*"regla ya vigente en `CLAUDE.md`"*). Los otros 3 llevan su propia regla de
invocación en el campo `description` de su frontmatter.

Debe leerse: *"El `CLAUDE.md` raíz ya fija la regla de `architecture-governor`
(`:206-208`), y el `description` de cada agente declara su gatillo. Lo que no
existe es un criterio **comparado** entre los cuatro —cuándo uno y no otro— que es
lo que esta tabla propone."*

### A.8 — Tres precisiones menores, sin cambio de conclusión

1. **`auditor-circuitos-erp` no tiene `Bash`.** Sus `tools` son
   `Read, Grep, Glob, WebSearch, WebFetch`: no puede verificar contra la BD, la
   suite ni git. Declararlo donde el plan se apoya en él (`:39`, `:59`, `:61`).
2. **La Wave 15 omite el segundo prerrequisito de `D-18`.** `fase16:602` lo da
   como *"**HOLD** (P-12) + **F8-08 resuelta** para poder medirlo"*; `:62` trae
   solo el HOLD levantado.
3. **La Wave 2 omite el trabajo no opcional de `D-03`.** `fase16:567`: *"`D-03`
   tiene también un trabajo no opcional en las tres opciones: **extender la cerca
   por ACTOR** —toda ruta alcanzable por `CUSTOMER_PERMISSION_GROUPS`, no solo
   `customer.routes.ts`—"*, y es parte del texto de la decisión del dueño.
4. **`:81` estima *"~80-100 ítems"* sin método.** `plan-integral-sistemico §3`
   enumera fuera de su orden ~35 🔍 + 5 🟢 + ~9 cosmético ≈ 49. Marcarlo como
   estimación, o citar cómo se contó — mismo criterio que el repo ya aplicó al
   incidente 251/253/254 de `CLAUDE.md`.

---

## Apéndice B — Wave 1 (`D-21`) ejecutada: código fijo, corrida real pendiente

**16/09/2026, gate `architecture-governor`, commit `5fb2487` (local, sin pushear).**

`:27` y `:48` (Wave 1) quedan corregidas otra vez, en el mismo sentido que ya
fijó el A.1: `D-21` sigue **sin poder marcarse "resuelta" a secas**. Lo que
cambió en este bloque es que el fix de una línea que A.1 pedía **ya se
aplicó** — `src/tests/integration/helpers/seed.ts:93`, `seedResource()` ahora
defaultea a `` `Habitación ${randomUUID().slice(0, 8)}` `` en vez de
`'Habitación 101'` fijo — y quedó anclado con un test nuevo
(`src/tests/integration/helpers/seed.test.ts`, 2 casos, mismo patrón
`describe.skipIf(skipIfNoDb)` del resto de `src/tests/integration/`).

**Verificado en este bloque:** `tsc --noEmit`, `eslint --max-warnings 0`,
`lint:arch` (dependency-cruiser) y la suite unitaria completa (173 archivos,
2432 tests) — todos verdes. Cero call sites de `seedResource()` (55 en
`src/tests/integration/`) pasan `name` explícito, así que el default nuevo
alcanza a todos. Los 3 archivos que mencionan el literal viejo
(`reservations.routes.test.ts`, `resources.routes.test.ts`,
`email.handlers.test.ts`) usan fakes/fixtures propios, confirmados
independientes de este helper.

**No verificado, y no verificable en este entorno:** el objetivo real de
`D-21` — 380/0 tests de integración contra Postgres real (382/0 contando los
2 tests nuevos) — porque este entorno no tiene `TEST_DATABASE_URL`. Residuo
registrado en `docs/pendientes-2026-09-12.md`, bullet `5fb2487` bajo
`## 🔍 Verificaciones pendientes`, con la acción puntual que lo cierra y la
distinción explícita frente al ítem `073a8d4` (mismo índice
`uq_resources_name`, pregunta distinta: `073a8d4` pide sembrar dos nombres
iguales a propósito y confirmar el `23505`/409, esta corrida solo confirma
que el *camino feliz* del seed no colisiona más consigo mismo).

**Efecto sobre lo que `D-21` bloqueaba (A.3):** las Waves 5, 6, 9 (parcial),
10, 8 (`D-11`) y 15 (`D-12`) quedan desbloqueadas para **arrancar** — el gate
de esta Wave 1 es lo que las habilitaba, no la corrida verde de Postgres. Pero
ninguna de ellas puede darse por **finalizada** citando `D-21` como evidencia
de que la suite de integración corre limpia — esa evidencia todavía no existe.
Cuando alguien corra `TEST_DATABASE_URL=... npm run test:integration` y
confirme 382/0 (o triage lo que quede rojo, distinguiendo falla nueva de una
de las 227 que Fase 15 ya advertía sin diagnosticar), el bullet se corta de
`pendientes-2026-09-12.md` y pasa a `docs/resuelto.md` con esa evidencia —
recién ahí `D-21` puede citarse como cerrada sin matices.

**No pusheado.** Push de `5fb2487` (y de este commit de docs) requiere
autorización explícita y nueva del dueño, igual que el resto de esta sesión.

---

## Apéndice C — Wave 2 (`P-01/D-03`) ejecutada: rechazo por actor + endpoints
## dedicados de catálogo, capa 2 (cerca RBAC) declarada bloque siguiente

**16/09/2026, gate `architecture-governor` en 2 rondas, commits `668e16c`
(código) + este mismo commit de docs (local, sin pushear).**

`:49` (Wave 2 en la tabla de `§3`) queda ejecutada, con una condición que la
tabla original no anticipaba. Resumen de las 2 rondas de gate:

**Ronda 1 — HOLD.** El diff inicial implementaba solo la capa 1 (rechazo por
actor en `tenantMiddleware`, opción "a" de Fase 15) sin la capa 2 que la
decisión del dueño pedía explícitamente (*"las dos capas, no una sola"*,
`decisiones-plan-integral-2026-09-16.md:51`), y el análisis de impacto no
había detectado que `GET /api/categories`/`GET /api/bookable-services`
(rutas de STAFF alcanzables por `Roles.BOOKING`, que CUSTOMER satisface)
tenían un consumidor real en el portal — roto (500) desde el 03/07/2026,
independiente de este fix.

**Entre rondas — investigación más profunda, a pedido explícito del dueño**
("Siento que estamos parados en una decisión de diseño del negocio. Sé más
profundo" — no eligió ninguna de las 3 opciones ofrecidas vía
`AskUserQuestion`, pidió resolver la pregunta de fondo en vez de tratarla
como una elección arbitraria). Se confirmó que la pregunta no era ambigua:
el wizard "Nueva reserva" del portal necesita ese catálogo para funcionar.
Se construyeron 2 endpoints dedicados bajo `/api/customer/*`, mismo patrón
que `/me/reservations`, y se migró el único consumidor real. El gate, en
su ronda 2, verificó independientemente que el payload de los 2 endpoints
nuevos es idéntico campo por campo al que las rutas de staff ya devolvían
— cero datos nuevos cruzan el borde de actor CUSTOMER, lo que confirma que
esto era un camino técnico faltante, no una decisión de negocio pendiente.

**Ronda 2 — APPROVED WITH CONDITIONS**, las 3 cumplidas en `668e16c` y en
el commit de docs que lo acompaña: (1) declarar en el código la divergencia
deliberada de saltear `CategoryService`/`BookableServiceService` en los 2
endpoints nuevos (hecho, comentario en `customer.routes.ts`); (2) registrar
el residuo de verificación real — el test de integración reescrito y el
wizard del portal nunca corrieron contra un entorno real (hecho, ver
`docs/resuelto.md` y `## 🔍 Verificaciones pendientes` de
`pendientes-2026-09-12.md`); (3) fortalecer 2 unit tests para assertar el
argumento del constructor de los repos (hecho,
`src/api/routes/customer.routes.test.ts`).

**No ejecutado en esta Wave, declarado bloque siguiente obligatorio — NO
retirado de la decisión del dueño:** la capa 2 (cerca RBAC molde
`ESCAPE_ROUTES` que congele el rechazo por actor de `tenantMiddleware` +
el invariante de que ningún mount `/api/*` de staff se registre antes de
ese middleware sin allowlist con motivo). El gate, en la ronda 2, amplió
el alcance real de esa capa 2 con un hallazgo que la matriz de impacto
original no tenía: 4 mounts `/api/*` viven hoy entre `authenticate()` y
`tenantMiddleware`, y 2 de ellos (`/api/business/modules`,
`/api/business/plan-limits`) no tienen ningún `authorize()` y SÍ son
alcanzables por un token CUSTOMER hoy (`CUSTOMER-STAFF-MOUNT-PRE-TENANT-001`,
`pendientes-2026-09-12.md`) — preexistente, no introducido por esta Wave,
pero material de alcance obligatorio para diseñar la capa 2. Ese diseño
(¿`authorize()` en esos 2 endpoints, o un allowlist explícito tipo
`PRE_AUTH_API_MOUNTS`?) queda pendiente, junto con la cerca en sí.

**Efecto sobre lo que dependía de Wave 2:** ninguna wave posterior de este
plan citaba a P-01/D-03 como bloqueante directo, así que no hay
desbloqueos que declarar acá (a diferencia de la Wave 1/D-21). La Wave 2
en sí queda "código resuelto, capa 2 pendiente, verificación real
pendiente" — no "cerrada sin matices".

**No pusheado.** Push de `668e16c` (y de este commit de docs) requiere
autorización explícita y nueva del dueño, igual que el resto de esta
sesión.

---

## Apéndice D — Wave 2 capa 2 ejecutada: `RBAC-MOUNT-002` cierra
## `CUSTOMER-RBAC-ACTOR-FENCE-001`

**16/09/2026, gate `architecture-governor`, commit `c1777e5` (código) + este
mismo commit de docs (local, sin pushear).**

`:395-408` (Apéndice C, arriba) queda ejecutado. La capa 2 que la decisión
del dueño pedía (`decisiones-plan-integral-2026-09-16.md:51`, *"las dos
capas, no una sola"*) está construida: `RBAC-MOUNT-002`
(`src/tests/architecture/api-auth-gate-order.test.ts`) congela que ningún
mount `/api/*` que dependa de contexto de staff se registre antes de
`tenantMiddleware` sin allowlist con motivo — la assertion (i) de la
decisión (que `tenantMiddleware` siga rechazando CUSTOMER) sigue cubierta
por `tenant-isolation.test.ts`, no duplicada.

**A diferencia del resto de Wave 2, esta pieza no tiene residuo de
verificación** — es parseo de texto sobre `app.ts`, corre sin
`TEST_DATABASE_URL` ni entorno real, y se verificó por mutación (3 casos:
mount nuevo, entrada stale, gate renombrado — los 3 disparan). Va directo a
`docs/resuelto.md` sin pasar por `## 🔍 Verificaciones pendientes`.

**Lo que la capa 2 NO cierra, a propósito — dos hallazgos nuevos,
registrados, no decisiones tomadas:**
1. `CUSTOMER-STAFF-MOUNT-PRE-TENANT-001` — si `/api/business/modules`/
   `/api/business/plan-limits` deberían cerrarse con `authorize()` (y con
   qué grupo — `Roles.STAFF`, no `MANAGEMENT`, según el gate) sigue sin
   decidir. La cerca declara el estado actual, no lo fuerza a cerrarse.
2. `CUSTOMER-PERMISSION-GROUPS-UNFENCED-001` (nuevo) — la zona
   pre-`tenantMiddleware` no tiene congelado qué GRUPO protege cada mount,
   solo que el mount esté declarado. Si `CUSTOMER_PERMISSION_GROUPS`
   (`security/roles.ts:81-84`) alguna vez ganara `Roles.MANAGEMENT`,
   `/api/companies` quedaría abierto a un token CUSTOMER sin que ninguna
   de las 8 cercas RBAC del repo lo note. Bloque propio, no decidido.

**Estado final de Wave 2 (P-01/D-03):** código resuelto en su totalidad
(capa 1 + capa 2), gate-aprobado en 3 rondas totales. Quedan, sin cerrar
todavía y sin bloquear nada en curso: los 2 residuos de verificación real
de `668e16c` (test de integración contra Postgres, wizard del portal
contra un cliente real) y los 2 hallazgos de arriba (ninguno de los 4 es
"capa 2 pendiente" — esa ya está).

**No pusheado.** Push de `c1777e5` (y de este commit de docs) requiere
autorización explícita y nueva del dueño.

---

## Apéndice E — Wave 3 ejecutada: `D-23(1)`/`D-24(1)`/`D-25(1)(2)`

**16/09/2026, gate `architecture-governor` (APPROVED WITH CONDITIONS,
ambas cumplidas antes de commitear), commits `6edf27d` (D-25) + `2f2a3e7`
(D-23(1)/D-24(1), código) + este mismo commit de docs (local, sin
pushear).**

`:50` (fila de la tabla de oleadas, arriba) queda ejecutado -- **pero con
el encuadre del Apéndice A.4, no el que la fila misma dice.** La fila
describe D-25(1)(2) como "comentario+cerca HOLD", texto escrito antes de
que el dueño decidiera desbloquear el resolver fiscal
(`decisiones-plan-integral-2026-09-16.md:199-206`, P-16 -- "mantener en
HOLD indefinido" quedó entre las alternativas descartadas). El Apéndice
A.4 (`:209-228`) ya corregía esto por escrito antes de ejecutar; este
Apéndice deja constancia de que la ejecución siguió A.4, no `:50` --
mismo criterio de esta sección: los Apéndices corrigen sin reescribir el
cuerpo.

**D-25(1)(2):** comentario en `afip-catalog.constants.ts` sobre
`resolveDocTipo()` con el encuadre correcto ("desbloqueado, todavía sin
conectar", Wave 14 como destino de la conexión) + 2 tests de
caracterización en `invoice.service.test.ts` que fijan el comportamiento
ACTUAL (siempre Consumidor Final) como tripwire, no como cerca de texto
sobre el fuente -- desviación deliberada de lo que A.4 pedía
literalmente ("cerca"), decidida porque un test sobre el payload real de
AFIP es más fuerte que un test sobre un string del código.

**D-23(1):** `src/tests/architecture/route-consumer-coverage.test.ts`
(nuevo) -- tercer artefacto de la superficie HTTP (qué existe / quién
puede / quién usa), molde `CLOSURE_MOUNTS`/`PUBLIC_ROUTES`/
`EXCLUDED_FILES`, documentado en `app-main/CLAUDE.md` sección "Consumo —
qué ruta usa quién" (undécimo artefacto manual del repo). Corrida real
contra `appfrontend-main` (los 2 repos están clonados lado a lado en esta
sesión) encontró 1 hallazgo nuevo no capturado por F14-01:
`GET /platform/businesses/:id` sin consumidor -- registrado en el
allowlist de la cerca y en `docs/pendientes-2026-09-12.md`, decisión
"familia por familia" diferida, no tomada en esta Wave.

**D-24(1):** sección `## Caja (arqueo de efectivo)` nueva en
`docs/roadmap-pms-multirubro.md` -- el circuito de Caja (backend completo
desde `672dda5`, cero UI) deja de estar invisible para el roadmap.
Decisión del dueño (P-15) de completar, no retirar, ya registrada ahí con
su cita exacta.

**Dos condiciones del gate, ambas cumplidas antes de commitear (no
después):** (1) el comentario "8 exclusiones" del allowlist de la cerca
describía mal el conteo (8 familias, 12 paths) -- corregido en el mismo
texto antes del commit `2f2a3e7`. (2) la cerca solo verificaba 2
direcciones (huérfano sin declarar / entrada stale con consumidor nuevo)
-- se agregó una tercera aserción (entrada del allowlist cuya ruta ya no
existe en el inventario) antes de commitear, mismo criterio que el gate
exige para todo allowlist manual del repo.

**Verificado antes de cada commit:** `tsc --noEmit` limpio; suite
completa 174 archivos / 2443 tests verde; `eslint --max-warnings 0`
limpio; `lint:arch` limpio; la cerca nueva corre (no saltea) en este
entorno, 3/3.

**Residuos, ninguno bloqueante, registrados en
`docs/pendientes-2026-09-12.md` (sección "Hallazgos de diseño abiertos"):**
1. `route-consumer-coverage` nunca corre en la CI de este repo -- propiedad
   permanente (`ci.yml` no clona `appfrontend-main`), no una verificación
   pendiente. Decisión no tomada: job de CI con doble `checkout`, o cerca
   "de sesión" a propósito.
2. `GET /platform/businesses/:id` sin consumidor -- decisión "familia por
   familia" diferida por D-23, no de esta Wave.

**No pusheado.** Push de `6edf27d`/`2f2a3e7` (y de este commit de docs)
requiere autorización explícita y nueva del dueño.

---

## Apéndice F — Wave 4 ejecutada: `D-01` (frontend) + `D-07(c)` (backend)

**16/09/2026, gate `architecture-governor` en cada repo por separado
(2 rondas cada uno — la primera de D-07(c) devolvió HOLD con 4
correcciones, aplicadas antes de commitear), commits
`appfrontend-main a64d931` (D-01) + `app-main a4950db` (D-07(c)) + este
mismo commit de docs (local, sin pushear).**

`:51` (fila de la tabla de oleadas, arriba) queda ejecutado. Los dos
componentes viven en repos distintos y se gatearon por separado, en
paralelo — sin dependencia entre sí, tal como la fila ya indicaba
("Ninguno de los otros 3" agentes).

**D-01 (sub-opción (a) solamente):** `next` 16.3.1 → 16.3.5 en
`appfrontend-main`, cierra las 2 advisories CRITICAL de RCE no autenticada
(GHSA-p293-qw3h-jr36, GHSA-2xp9-vwfh-vxw4) + la HIGH transitiva de `sharp`
(GHSA-rgj7-g3m4-5g8c, resuelta sola vía el rango de `optionalDependencies`
de `next`). Pin exacto mantenido a propósito (no `^16.3.5`) — con lockfile
commiteado y `npm ci` en CI, un caret no aporta actualidad, solo drift no
revisado; la visibilidad la tiene que dar la sub-opción (c) (`npm audit`
en CI), todavía no decidida. `npm audit --omit=dev` post-bump: 0 crítico,
0 alto, 1 moderado (`qs`, preexistente, fuera de alcance). Build/typecheck/
lint/unit tests verdes. **Sub-opciones (b) (`images` block en
`next.config.js`) y (c) (`npm audit` en CI de ambos repos) quedan sin
decidir — bloques separados**, tal como el propio D-01 los planteaba.
**Residuo declarado, precondición de push, no de este commit:** sin smoke
test de login/dashboard contra un runtime real (`next start`) — `next
build` no ejercita los `rewrites()` de `next.config.js`, que es el proxy
same-origin del que depende la cookie de sesión.

**D-07(c):** inventario completo de las 21 sentencias DML de `schema.sql`
(`docs/inventario-dml-schema-2026-09-16.md` — el número correcto es 21,
no 20; la cita original de F10-02/fase15 nunca se había re-contado, y la
primera versión de este mismo documento heredó el mismo error hasta que
el gate lo encontró, ver el propio documento sección 4 de "Lo que NO
garantiza"). 18 son auto-limitantes por construcción, 2 ya estaban
gateadas (precedente v42), y las 3 con condición de disparo abierta
(`customer_rates` D-07/F10-02, `invoices.afip_contacted` F10-16,
`reservation_lines` F10-17) se gatean por `schema_migrations version=60`.
Medición previa contra los 2 tenants reales (Apéndices B/D de
`docs/decisiones-plan-integral-2026-09-16.md`): 0 filas candidatas y 0 ya
convertidas en `customer_rates` — gatear no deja ninguna corrección
pendiente sin aplicar. F10-16/F10-17 severidad Baja, no medidos.

**A diferencia de toda la sesión hasta acá, esta pieza SÍ se verificó
contra Postgres real, no solo tsc/lint/unitarios.** Esta misma sesión
encontró un servidor PostgreSQL 16.13 instalado localmente (apagado por
default) y lo levantó (`service postgresql start`) — primera vez en todo
este plan de ejecución que hay Postgres real disponible sin depender de
Neon ni de autorización de producción. Con eso: la suite de integración
completa corrió limpia (**48 archivos, 381 tests**, incluidos los 3 tests
nuevos de `schema-redeploy-idempotent.integration.test.ts` que reproducen
el escenario exacto de F10-02 y los casos de F10-16/F10-17 — **5/5
pasando, no salteados**, confirmado explícitamente porque el gate había
rechazado la corrida "skip" anterior como evidencia insuficiente). Esto
también resuelve, de paso, varios de los residuos de
"🔍 Verificaciones pendientes" acumulados en `docs/pendientes-2026-09-12.md`
en waves anteriores que esperaban exactamente esto — pendiente de
reconciliar esa sección contra la corrida real (bloque de docs aparte, no
este commit).

**Lo que D-07(c) no cierra, a propósito — residuo registrado en
`docs/pendientes-2026-09-12.md`:**
1. La "ventana de un deploy más" — `applyTenantSchema()` registra la
   versión DESPUÉS de correr `schema.sql`, así que el primer deploy con
   este commit todavía ejecuta las 3 sentencias una última vez antes de
   quedar cerradas para siempre. Medido para `customer_rates` (no-op), no
   para F10-16/F10-17 — precondición de deploy, no de este commit.
2. `route-consumer-coverage` nunca corre en la CI de este repo (residuo
   de Wave 3, sin relación con D-07(c), ya registrado en el Apéndice E).

**No pusheado.** Push de `a64d931` (`appfrontend-main`), `a4950db`
(`app-main`) y de este commit de docs requiere autorización explícita y
nueva del dueño, en cada repo.
