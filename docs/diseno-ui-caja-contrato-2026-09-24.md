# P-15/D-24 — Circuito de Caja: contrato de API para la UI (handoff a appfrontend-main)

**Fecha:** 2026-09-24
**Origen:** Wave 14 de `docs/plan-ejecucion-integral-2026-09-16.md`.
Decisión ya tomada: *"completar — construir la UI faltante"*
(`docs/decisiones-plan-integral-2026-09-16.md:208-215`), sin gatillo de
revisión. Fila de roadmap ya creada como parte de esa misma decisión
(`docs/roadmap-pms-multirubro.md:151-177`, "no opcional, parte del mismo
bloque" — ya ejecutado, ver §1).

## 1. Esto NO es trabajo de `app-main` — es 100% frontend

Verificado contra el código vivo de los dos repos, no contra el plan:

- Backend **completo** y en producción desde `672dda5` (14/08/2026, "Gap
  Tango #2"): `src/clientes-finanzas/cash-register.routes.ts`,
  `.service.ts` (3 errores de dominio: `ShiftAlreadyOpenError`,
  `NoOpenShiftError`, `ShiftNotFoundError`), `sql.cash-register-shift.repository.ts`,
  tabla `cash_register_shifts` (`schema.sql`), montado en `app.ts` detrás
  de `requireModule(ModuleKey.CUENTAS_CORRIENTES)`, validación Zod nivel 2
  en los dos `POST`. **No requiere ningún cambio de schema, contrato ni
  RBAC para que la UI empiece a consumirlo.**
- Cero consumidores en `appfrontend-main`: `grep -rln "cash-register|cash_register|caja" src/`
  sobre el checkout local de ese repo → 0 resultados. No hay dominio
  `lib/caja/` (comparar con los 15 dominios existentes —`catalogo`,
  `recursos`, `finanzas`, etc.— listados en el `CLAUDE.md` de
  `appfrontend-main`).
- La fila del roadmap ya existe (`docs/roadmap-pms-multirubro.md:151-177`)
  — el prerrequisito "no opcional" de la decisión ya está cumplido, esta
  Wave 14 solo falta el bloque de UI en sí.

**Conclusión:** el "diseño técnico pendiente" que Wave 14 le atribuye a
este ítem es un diseño de PANTALLAS, no de backend — pertenece al backlog
propio de `appfrontend-main` (mismo lugar que
`docs/roadmap-migracion-refine.md` o un `pendientes` propio de ese repo),
no a este repo. Esta sesión corre con working directory en `app-main` y no
tiene permiso para escribir código ahí — este documento es el contrato que
esa sesión necesita para diseñar la pantalla sin tener que releer
`cash-register.service.ts` desde cero.

## 2. Prerrequisito operativo, sin correr todavía — bloquea el PRIMER commit, no el diseño

La decisión del dueño es explícita: **antes de cualquier movimiento de
código**, correr `SELECT count(*) FROM cash_register_shifts` en cada
tenant productivo (`docs/decisiones-plan-integral-2026-09-16.md:213`,
repetido en `roadmap-pms-multirubro.md:171-174`). Si hay filas, alguien ya
usó el circuito por API directamente y ese histórico es un hecho
financiero — no se toca, se muestra tal cual en la UI nueva, no se
reinicia. **Esta sesión no corrió esa consulta** (sin acceso autorizado a
producción en el alcance de esta tarea) — queda como acción pendiente,
explícita, antes de escribir el primer commit de la UI.

## 3. Contrato de API — verificado línea por línea

Base: `requireModule(ModuleKey.CUENTAS_CORRIENTES)` + `authorize(Roles.FRONT_DESK)`
en los 5 endpoints (`cash-register.routes.ts:61,73,87,98,118`) — cualquier
rol que ya vea "Clientes"/cuentas corrientes puede operar la caja, sin
permiso nuevo que pedir.

| Método | Ruta | Body / Query | Éxito | Errores propios |
|---|---|---|---|---|
| `GET` | `/api/cash-register/current` | — | `200 CashRegisterShift` | `404 {code: 'NO_OPEN_SHIFT'}` — **no** es un error de dominio lanzado, el propio handler lo arma (no hay turno abierto es un estado válido, no una excepción) |
| `GET` | `/api/cash-register` | `?limit` (≤200) `&offset` | `200 CashRegisterShift[]` | `400` si `limit`/`offset` no parsean (Zod) |
| `GET` | `/api/cash-register/:id` | — | `200 ShiftDetail` (`{shift, transactions}`) | `404 {code: 'SHIFT_NOT_FOUND'}` |
| `POST` | `/api/cash-register/open` | `{openingAmount: number ≥0, notes?: string ≤500}` | `201 CashRegisterShift` | `409 {code: 'SHIFT_ALREADY_OPEN'}` |
| `POST` | `/api/cash-register/close` | `{closingAmountCounted: number ≥0, notes?: string ≤500}` | `200 CashRegisterShift` | `409 {code: 'NO_OPEN_SHIFT'}` |

`CashRegisterShift` (`cash-register-shift.repository.ts:3-24`, campos
relevantes para la UI):
```
id, businessId, openedBy, openedAt, openingAmount, currency, status,
closedBy?, closedAt?, closingAmountCounted?, expectedCashAmount?, variance?
```
`variance = closingAmountCounted - expectedCashAmount` — positivo sobra,
negativo falta, **calculado y persistido al cerrar** (no se recalcula al
leer un turno cerrado: un cargo que se linkee tarde no debe mover el
arqueo histórico ya cerrado — señal a respetar en la UI: un turno cerrado
es de solo lectura, punto).

## 4. Diseño de pantalla propuesto — para revisar contra las convenciones ya vigentes en `appfrontend-main`

Siguiendo `docs/auditoria-modales.md` (tres niveles de interacción, ya
normativo en el `CLAUDE.md` de `appfrontend-main`):

- **Nivel de interacción:** ruta dedicada `/dashboard/caja`, no modal — es
  un flujo con estado (abierto/cerrado), montos, e historial, no una
  confirmación de 2-4 campos. Dos vistas dentro de la misma ruta:
  - **Turno actual** (o CTA "Abrir turno" si `GET /current` da 404):
    monto de apertura, movimientos en efectivo del turno (via
    `ShiftDetail.transactions`), botón "Cerrar turno" que pide
    `closingAmountCounted` y muestra el `variance` resultante antes de
    confirmar.
  - **Historial** — lista paginada (`GET /` con `limit`/`offset`) +
    detalle por turno (`GET /:id`).
- **Refine o fetch directo:** por la convención de `appfrontend-main`
  (*"Excepción explícita — no van por Refine: ... cualquier vista que no
  mapee 1:1 a un recurso con list/create/update/delete"*), Caja **no**
  es un CRUD estándar — es abrir/cerrar con validación de negocio y
  cálculo server-side (`variance`), más cercano al patrón de "cuentas
  corrientes" (fetch directo vía `lib/<dominio>/api.ts`) que a un
  recurso Refine. Dominio nuevo sugerido: `lib/caja/{types,api}.ts`,
  mismo patrón que los 15 dominios existentes.
- **Módulo/plan:** la UI debe ocultarse si el negocio no tiene
  `ModuleKey.CUENTAS_CORRIENTES` habilitado (mismo criterio que ya usa
  la pantalla de Clientes/estado de cuenta) — evita el mismo bug que D6
  (`CLAUDE.md` de `app-main`, regla 5 de "Pendientes — revalidar antes de
  arrastrar": el backend puede exponer el dato y el rol igual no tenerlo
  habilitado).

## 5. Lo que este documento NO hace

- No es el diseño final de la pantalla — es el contrato + una propuesta
  de forma, a cargo de una sesión con acceso de escritura a
  `appfrontend-main` (esta no lo tiene: working directory `/home/user/app`).
  Esa sesión sigue las convenciones de interacción/Refine de su propio
  `CLAUDE.md` y pasa por su propio gate antes de commitear.
- No corre el `SELECT count(*)` de §2 — queda como acción explícita
  pendiente de autorización.
- No toca código de ningún repo.
