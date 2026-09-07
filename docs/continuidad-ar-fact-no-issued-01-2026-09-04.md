# Checkpoint transferible — AR-FACT-NO-ISSUED-01: Fase 1 cerrada, Fases 2-8 diseñadas y en espera

**Fecha:** 04/09/2026 (corrige el desfase de fecha que el propio
`architecture-governor` señaló en su revisión de rol/schema: varias
entradas de esta misma investigación quedaron fechadas "05/09/2026" por
error de un commit al otro; el commit real es de hoy).

**Rama:** ninguna — `app-main` sobre `main`.

> **Estado git — actualizado 07/09/2026 (cierra la línea git-state de
> DA-CONT-001).** Cuando se escribió este checkpoint decía *"`HEAD = b088cbc`,
> 14 commits por delante de `origin/main = 1f72f41`, sin push"*. **Ya no:**
> `4029b96` · `4d2d694` · `b088cbc` (Fase 1) están en `origin/main` desde hace
> tiempo y **desplegados** — `origin/main` está hoy en `9222e84` (deploy live,
> ver `zulu-hub-continuidad-2026-09-07.md`). Lo único que sigue vigente de este
> documento es el **diseño de Fases 2-8 + la decisión de rol**, sin implementar.

**Continúa directamente:**
`docs/continuidad-o2-f2-cierre-implementacion-2026-09-03.md` (el
checkpoint de O2-F2/H-A que motivó esta investigación al auditar el diff
post-cierre).

**Propósito de este documento:** que otra sesión pueda retomar
exactamente en Fase 2 sin re-derivar el diseño de Fases 2-8 ni la
decisión de rol — ambos ya están cerrados, solo falta implementarlos.
**Este checkpoint es puramente documental — no modifica código ni
schema.**

---

## 1. Qué está cerrado — Fase 1

**Los tres commits, en orden, todos locales:**

| SHA | Qué |
|---|---|
| `4029b96` | `refactor(facturacion): resolveInvoiceLinkage() distingue NONE/NOT_ISSUED/ISSUED` — P0, refactor puro, cero cambio de comportamiento (1800 unitarios, mismo conteo antes/después) |
| `4d2d694` | `fix(clientes-finanzas): AR-FACT-NO-ISSUED-01 -- fail-closed en markInvoiced/markCollected` — el guard en sí, con `AR_INVOICE_NOT_ISSUED` (reintentable) y `AFIP_RECONCILIATION_PENDING` (no reintentable a ciegas) mapeados a 409 en el mismo commit |
| `b088cbc` | `docs: marcar Fase 1 de AR-FACT-NO-ISSUED-01 como resuelta` — actualización de `docs/pendientes-2026-09-03.md` |

**Guard fail-closed, publicado localmente (no deployado):**
`AccountsReceivableService.markInvoiced()` y `.markCollected()` rechazan
cuando `InvoiceRepository.resolveInvoiceLinkage()` devuelve
`{kind:'NOT_ISSUED', ...}` — factura interna real pero no `ISSUED`.
`{kind:'NONE'}` (sin ninguna fila `invoices` — §5.1(b), facturación
externa permanente sancionada) sigue pasando sin bloquear, sin cambios.

**Verificación contra las 2 bases de tenant reales (solo lectura, antes
de commitear, script temporal borrado después de correr):**

```
Hotel los Alamos (cd6cd508-f219-4bde-81ec-7a1d74f02074): ninguna FAILED_UNCERTAIN
Demo (biz-demo-01): ninguna FAILED_UNCERTAIN
```

**Cero filas `accounts_receivable` en `FACTURADO`/`COBRADO` afectadas
hoy.** El guard no le va a devolver 409 a nadie sobre datos ya existentes
en los dos únicos negocios con base asignada.

**Evidencia técnica (corrida al cerrar cada commit, no heredada):**
`tsc --noEmit` limpio, `lint` limpio, `lint:arch` limpio (282 módulos,
1301 dependencias). Suite unitaria completa: 1807 tests (1800 + 7 nuevos
de las 4 ramas del guard). Suite de integración completa contra Postgres
real: 120 tests, incluidos los 2 nuevos de este hallazgo (`markCollected()`
rechaza sobre una factura PENDING; `markInvoiced()` rechaza sobre una
factura REJECTED).

---

## 2. Qué se investigó y quedó diseñado, sin implementar — Fases 2-8

Encontrado por `architecture-governor` al revisar el diff post-H-A: el
camino manual de facturación (`markInvoiced()`, `POST
/:id/mark-invoiced`) no verificaba que la factura interna vinculada
estuviera `ISSUED` antes de dejar avanzar la cuenta por cobrar — mismo
perfil de doble cobro que O2-F2 cerró, severidad S1. La Fase 1 (arriba)
cierra el riesgo real con un bloqueo simple. Lo que sigue (Fases 2-8) es
la reconciliación completa para cuando AFIP responde de forma incierta
(`FAILED_UNCERTAIN` con `afip_contacted=true`) — hoy esas facturas quedan
bloqueadas sin ningún camino de resolución, ni automático ni manual.

### 2.1 — Los cinco estados de `invoice_reconciliations` (Fase 2)

Tabla nueva, BD de **tenant** (`src/db/schema.sql`, junto a `invoices`,
que arranca en la línea 2698), schema **v47** (`CURRENT_SCHEMA_VERSION`
46→47 en `src/platform/tenant-db.setup.ts` **y** en el assert literal de
`src/platform/tenant-db.setup.test.ts:138`, en el mismo commit — el
precedente de este mismo repo, `orders.served_at` en v46, es el incidente
que se repite si se olvida ese segundo archivo).

```
status CHECK IN (
  'PENDIENTE_DE_RECONCILIACION',  -- estado inicial, caso abierto
  'RESUELTA_ACEPTADA',            -- reconsulta confirmó comprobante autorizado
  'RESUELTA_RECHAZADA',           -- reconsulta probó que no se autorizó nada
  'RESUELTA_EXTERNA',             -- D3: resuelto declarando comprobante de OTRO sistema
  'ESCALADA'                      -- intentos agotados sin conclusión -- NO es terminal
)
```

**`ESCALADA` no es terminal** — sigue abierta, solo salió de la cola
normal de reintentos automáticos. La bandeja y el índice parcial tienen
que tratar `('PENDIENTE_DE_RECONCILIACION','ESCALADA')` como el conjunto
abierto, no solo el primero — si esto no queda escrito en el código (no
solo acá), en unas semanas alguien filtra por un solo valor y las
escaladas desaparecen del radar.

**Por qué NO se toca `invoices.status` (D1, confirmado por el dueño):**
el estado indeterminado ya está persistido y ya es distinguible
(`FAILED_UNCERTAIN` + `afip_contacted=true`). Agregar un valor al `CHECK`
de una tabla de **documento** viva, reaplicada en cada deploy a todas las
tenant DB, por cero ganancia semántica sobre una tabla de **caso** nueva,
no se justifica.

**Constraints CASE-based que le dan sustancia a D3** (patrón "exactamente
uno de N" que este repo ya usa 3 veces — no el polimórfico
`scope_type`/`scope_id`):
1. `resolved_at`/`resolved_by` `NOT NULL` **si y solo si**
   `status` empieza con `RESUELTA_`.
2. `external_invoice_ref` `NOT NULL` **si y solo si**
   `status = 'RESUELTA_EXTERNA'`. Esto es lo que reserva el valor sin
   habilitar el camino: el `CHECK` de `status` solo no impide escribir
   `RESUELTA_EXTERNA` sin referencia — el `CHECK` cruzado sí. Reservarlo
   ahora es barato (una columna nullable + un `CHECK`); no reservarlo y
   agregarlo después es una segunda migración de constraint sobre la
   misma tabla.

**Campos del resto del schema propuesto** (diseño, no DDL final —
confirmar en el diff exacto de Fase 2): `id`, `business_id`, `invoice_id`
(FK a `invoices`, **`UNIQUE`** — una sola fila por comprobante, un
`retryExisting()` que vuelve a caer en incierto actualiza, no inserta),
`status`, `attempts INT`, `last_checked_at`, `last_check_response
JSONB`, `external_invoice_ref`, `resolution_notes`, `resolved_at`,
`resolved_by`, `created_at`, `updated_at`. **NO snapshotear**
`pto_vta`/`cbte_tipo` — se resuelven por JOIN a `invoices`, son
inmutables ahí.

**Índice anti-doble-facturación — el hallazgo más grave de toda esta
investigación, todavía sin cerrar:** `InvoiceRepository.getInvoicedFinancialTransactionIds()`
(`sql.invoice.repository.ts:212-222`) filtra `i.status = 'ISSUED'`. Si
una factura **individual** queda incierta cubriendo un cargo, y después
alguien pide una factura **consolidada** que incluye ese mismo cargo, el
guard actual no la ve — se puede emitir un segundo comprobante fiscal
real sobre el mismo cargo. **Esto no lo cubre la Fase 1** (que solo
bloquea `markInvoiced()`/`markCollected()`, no `requestConsolidatedInvoice()`)
y es la razón por la que Fase 2 tiene que incluir el guard de cargos
bloqueados ahí también, no solo la tabla.

### 2.2 — La decisión de permisos, RE-CORREGIDA contra el código real (04/09/2026) — reemplaza las dos versiones anteriores de este documento

**Historial de esta sección, para que quede explícito y nadie repita la
vuelta:** la 1ª versión diseñaba `Roles.FISCAL_RECONCILIATION` como rol
nuevo hardcodeado. El dueño la corrigió pidiendo una capa de "acción con
permiso propio, mapeada a un grupo hoy, a un rol en el futuro" y citando
un pendiente ya existente con ese modelo. **Se buscó ese pendiente a
fondo** (`pendientes-2026-08-30.md`, `pendientes-2026-09-03.md`,
`diseno-rbac-modelo-y-alcance-2026-08-30.md`,
`diseno-factura-borrador-2026-08-31.md`, `indice-conocimiento.md`, y el
nombre literal `FACTURACION_RECONCILIACION_RESOLVER` en todo el repo) y
**no se encontró** — lo más cercano es un ADR ya aceptado
(`diseno-rbac-modelo-y-alcance-2026-08-30.md`, 30/08/2026) que evaluó un
modelo deny-by-default de acciones **y lo rechazó explícitamente**, por
alto costo de migrar los ~204 call-sites existentes sin un incidente que
lo justifique. El dueño, al ver la discrepancia, aclaró que su recuerdo
era otra cosa: quería poder decidir **por acción** (GET/POST/PUT/DELETE)
quién puede ver/crear/editar/borrar cada cosa.

**Verificado contra el código real (no supuesto): esa granularidad YA
EXISTE hoy, endpoint por endpoint.** Ejemplo real, `invoices.routes.ts`:

| Acción | Grupo requerido |
|---|---|
| `GET /api/invoices/:id` (ver) | `Roles.FRONT_DESK` |
| `POST /api/invoices` (crear) | `Roles.FRONT_DESK` |
| `POST /api/invoices/consolidated` (emitir consolidada) | `Roles.MANAGEMENT` |
| `PUT /api/invoices/:id` (editar) | `Roles.MANAGEMENT` |
| `DELETE /api/invoices/:id` (borrar) | `Roles.MANAGEMENT` |

Cada `router.get/post/put/delete(...)` lleva su propio
`authorize(Roles.X)`, elegido independientemente del resto — el sistema
ya permite "el mostrador puede ver y crear, pero solo gestión puede
editar o borrar" sin ninguna pieza nueva. **Y los roles nombrados por
negocio (ej. "Recepcionista") tampoco son un modelo futuro — ya existen
hoy** (`role_permission_groups`, configurable por el dueño sin tocar
código, sección 3 de `docs/rbac-matriz-endpoints.md`).

**Lo único que no existe sin tocar código:** el catálogo de "qué se
puede proteger" son 8 valores fijos en `src/security/roles.ts`
(`MANAGEMENT`, `FRONT_DESK`, `STAFF`, `HOUSEKEEPING_AND_MANAGEMENT`,
`ORDERS`, `CUSTOMER_ONLY`, `BOOKING`, `OWNER_ONLY`) — agregar una
capacidad que no encaja en ninguna de esas 8 exige un valor nuevo en ese
archivo, que es código, no configuración. **Reconciliar AFIP es
exactamente ese caso: nadie tiene hoy un permiso que signifique eso.**

**Conclusión, confirmada por el dueño (04/09/2026): "lo otro no
interfiere hoy por hoy"** — no hace falta ninguna capa de abstracción
acción→grupo→rol nueva. El mecanismo que ya existe (grupo nuevo en
`roles.ts` + `authorize()` en las rutas + asignación por rol nombrado,
sin código, por negocio) alcanza. Se descarta también la 2ª versión de
esta sección (la capa de "acción" separada del grupo) — no hay
infraestructura nueva que construir, solo usar la que ya está.

**Tabla de decisión final:**

| Aspecto | Decisión |
|---|---|
| Granularidad por acción (ver/crear/editar/borrar) | **Ya existe hoy**, un `authorize()` independiente por endpoint — verificado contra código real |
| Roles nombrados por negocio | **Ya existen hoy** (`role_permission_groups`) — no es un modelo futuro |
| Grupo nuevo en `roles.ts` | **Necesario** — reconciliar AFIP es una capacidad que hoy no tiene ningún grupo |
| Nombre del grupo | Sin decidir en este checkpoint — confirmar contra el vocabulario de `roles.ts` en Fase 6, no asumir `FACTURACION_RECONCILIACION_RESOLVER` literal |
| Asignación del grupo nuevo a un rol nombrado | **Explícita, mínimo privilegio, por tenant, nunca preset automático** (decisión original, sin cambios) |
| Capa de abstracción acción→grupo→rol | **Descartada** — no hace falta, ya existe la granularidad que buscaba |
| Migración grupos → roles | **No aplica** — los roles ya existen, no hay nada que migrar |

**Lo que sigue vigente de la decisión original, sin cambios:** asignación
**explícita** (nunca preset automático), **mínimo privilegio**, **por
tenant**, permiso **dedicado** (no reusar `markCollected()` ni otro
genérico), y **toda resolución de un caso queda auditada**.

**Lo que falta resolver en Fase 6 (permisos), no cerrado todavía:**
- Nombre exacto del grupo nuevo en `src/security/roles.ts` — confirmar
  contra el vocabulario ya usado (los 8 existentes son sustantivos de
  área/función, no verbos de acción — `FACTURACION_RECONCILIACION_RESOLVER`
  puede no encajar con ese estilo; revisar antes de asumirlo).
- Cómo se audita la **asignación** del grupo a un rol nombrado —
  verificar el mecanismo real de `RoleService`/`role.service.ts`, no
  asumir que ya audita esto.
- Cómo se audita **cada resolución** — la tabla `invoice_reconciliations`
  ya tiene `resolved_by`/`resolved_at`; decidir si alcanza con esas dos
  columnas o hace falta además una fila en `audit_log` (revisar si el
  bloqueo de H-E -- `audit_log.changed_by NOT NULL` sin actor plumbeado
  -- aplica acá; para reconciliación SÍ hay actor real, así que podría no
  tener el mismo obstáculo que tuvo H-A -- **verificar, no asumir**).
- El hallazgo de `GET /api/invoices/:id` (`Roles.FRONT_DESK`, no
  `MANAGEMENT`) sigue vigente: un rol nombrado que **solo** tenga el
  grupo nuevo de reconciliación recibiría 403 ahí. Recomendación
  pendiente de confirmar: que `GET /api/invoice-reconciliations`
  devuelva embebidos los campos del comprobante (`ptoVta`, `cbteTipo`,
  `cbteNro`, `impTotal`, `status`, `errorMessage`, `afipContacted`,
  `issuedAt`, cliente) en vez de abrir un `authorize()` más sobre una
  ruta compartida.
- Sincronizar en el mismo commit: `docs/rbac-matriz-endpoints.md` §1 y
  §2, `EXPECTED_AUTHORIZE_CALL_SITES` en
  `src/tests/security/rbac-matrix-sync.test.ts`, y **no** tocar
  `PUBLIC_ROUTES` (las rutas nuevas llevan `authorize()`).
- **Trampa de montaje ya identificada, no repetirla:** montar las rutas
  en `/api/invoice-reconciliations` **top-level**, nunca
  `/api/invoices/reconciliations` — ese prefijo colisiona con el
  `router.get('/:id')` ya montado en `/api/invoices`
  (`src/app.ts:385`) y `rbac-route-coverage.test.ts` no valida orden de
  montaje (RBAC-MOUNT-001), así que pasaría verde estando roto.

### 2.3 — Orden de fases, actualizado con la decisión de rol

| Fase | Contenido | Toca schema | Gate |
|---|---|---|---|
| **1** | ✅ **CERRADA** — guard fail-closed | no | — |
| **2** | Tabla `invoice_reconciliations`, los 5 estados, los 2 `CHECK` cruzados, índice parcial de bandeja, **guard de cargos bloqueados en `requestConsolidatedInvoice()`**, `CURRENT_SCHEMA_VERSION` 46→47. Sin escritores ni lectores todavía | **sí** | respaldo durable + `migrate:tenants` + verificación por tenant, **antes** de cualquier deploy |
| **3-5** | Apertura del caso desde `invoice.service.ts` (misma transacción que `markFailed()`), `afip_last_voucher_before` persistido, algoritmo de reconsulta (`getVoucherInfo` extendido con `ImpTotal`/`DocTipo`/`DocNro`/`CbteFch`, hoy el puerto no los expone), lectura de bandeja | no | unit + integración por fase |
| **6a** | Grupo nuevo en `roles.ts` (nombre a confirmar contra el vocabulario existente — ver §2.2) — **sin preset**, asignable por rol nombrado, según la decisión del dueño. Cero `authorize()` nuevos todavía — no-op de comportamiento | no | trivial, nada lo usa aún |
| **6b** | Las 3 rutas + `authorize(Roles.<nombre confirmado>)` + servicio + matriz RBAC + cerca de conteo | no | RBAC matriz + cerca en el mismo commit |
| **7** | Worker de reconsulta automática (backoff 5min→15→60→240→1440, 5 intentos, después `ESCALADA`) + botón manual (`POST /:id/reconcile`) — **el manual es obligatorio, no opcional**: los workers de este repo arrancan perezosamente por tenant desde `tenantMiddleware`, un negocio sin tráfico HTTP nunca correría el suyo | no | su modo de falla es silencioso — último en implementarse |
| **8** | Bandeja en `appfrontend-main` | no | repo aparte, gate aparte |

**Diferido explícitamente, fuera de este plan completo:**
`invoice_source=EXTERNO` (el camino real de facturación externa —
`RESUELTA_EXTERNA` solo reserva el lugar, no lo construye); refresco de
`CbteFch` en `retryExisting()` (prerrequisito real de la pata
RECHAZADA→reintento, encontrado en la investigación, su propio ítem);
alertas/notificaciones al escalar (borde con **O5** — gestión operativa
durable de incidentes, `pendientes-2026-09-03.md:8,108,205-206`, abierto
sin diseño — **no mezclar**, confirmado explícitamente); renombre de
`FAILED_UNCERTAIN` para el caso `afip_contacted=false` (es deuda de
nombre, no de comportamiento); H-E (actor en `markCollected()`); la
costura best-effort de `markInvoiced()` en `invoice.service.ts` contra
C1-Fase C.

---

## 3. Instrucción explícita para la próxima sesión

**Empezar por Fase 2.** El pedido específico del dueño, textual: diseñar
la tabla `invoice_reconciliations`, su máquina de estados,
`resolution_source` **incluyendo `EXTERNAL` sin habilitar todavía el
flujo externo**, el índice anti-doble-facturación individual **y**
consolidada, permisos, y pruebas negativas.

**No implementar Fase 2 hasta entregar el diff exacto y la matriz de
decisiones** — mismo patrón que este repo ya viene usando toda la
sesión (revisión de `architecture-governor` antes de tocar código,
`AskUserQuestion` para lo que sea genuinamente una decisión de negocio
o de producto, nunca asumida).

**Nota sobre `resolution_source` vs. el campo del bosquejo anterior:**
el diseño de esta sesión usaba `external_invoice_ref` (texto) como la
señal de "resuelto externamente". El pedido de la próxima sesión habla
de `resolution_source` **incluyendo `EXTERNAL`** — verificar si son el
mismo campo con otro nombre, o si `resolution_source` es una columna
nueva (`AUTOMATICA`/`MANUAL`/`EXTERNAL` como enum de *quién/cómo* resolvió,
distinta de `external_invoice_ref` como el *dato* de la referencia
externa). No asumir que ya están reconciliados entre sí — es lo primero
a aclarar en la matriz de decisiones de Fase 2.

---

## 4. Qué NO hacer (instrucción explícita del dueño, 04/09/2026)

- **No pushear.** `origin/main` sigue en `1f72f41`, 14 commits atrás de
  `HEAD`. Los tres commits de Fase 1 (`4029b96`, `4d2d694`, `b088cbc`)
  **quedan intactos, tal cual están** — no se tocan en este checkpoint.
- **No iniciar las Fases 2-8 en esta sesión.** Este documento es el
  diseño y el registro, no el arranque.
- **No `git add -A`.** Staging por ruta explícita, siempre. Los 6
  artefactos sin trackear (`.claude/skills/neon/`, `.claude/skills/neon-postgres/`,
  `.reviews/`, `docs/erp-auditoria-v2/`,
  `docs/programa-auditoria-completitud-erp-2026-09-01.md`, `skills-lock.json`)
  siguen sin tocar.
- **No `amend`, `squash` ni reescribir ningún commit existente.**
- **No deploy.** `render.yaml` encadena `migrate:tenants` en el
  `buildCommand` — deploy en este repo es migración contra todas las
  tenant DB reales.
- **Este checkpoint no modifica código ni schema.** Es el único archivo
  que este documento autoriza escribir.
