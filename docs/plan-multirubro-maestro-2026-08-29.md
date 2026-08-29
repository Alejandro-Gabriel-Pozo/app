# ZULU Hub — Plan maestro multirubro (visión de producto)

- **Fecha:** 2026-08-29
- **Origen:** documento aportado por el dueño (*"ZULU Hub — Plan de implementación multirubro"*), incorporado al repo porque vivía sólo como archivo adjunto de una sesión y ninguna otra sesión podía verlo.
- **Etiquetas:** `vision-de-producto` `multirubro` `plataforma`

> **Documento maestro de visión de producto y arquitectura multirubro. No es
> una orden de implementación greenfield.** Antes de ejecutar cualquier fase,
> compararlo contra el repositorio, los documentos existentes y el estado de
> producción, y marcar cada sección como completa, parcial o pendiente.

**Regla central:** ZULU Hub debe ser **configurable por negocio, no
programado de nuevo por negocio**.

---

## 0. Cómo se relaciona con lo que ya existe

Este documento es **fuente de dirección**. La **fuente de verdad de
implementación** sigue siendo:

| Qué | Dónde |
|---|---|
| Plan ejecutado de separación de dominios + las 7 decisiones cerradas | [plan-separacion-dominios-multirubro-2026-08-28.md](plan-separacion-dominios-multirubro-2026-08-28.md) |
| Esquema real de la plataforma | [`src/db/platform.schema.sql`](../src/db/platform.schema.sql) |
| Dónde quedó el proyecto y qué sigue | [zulu-hub-continuidad-2026-08-29.md](zulu-hub-continuidad-2026-08-29.md) |
| Log del día | [pendientes-2026-08-29.md](pendientes-2026-08-29.md) |

Cuando este documento y el código digan cosas distintas, **gana el código**,
y la discrepancia se anota acá abajo.

---

## 1. Conciliación — dónde el plan maestro y lo implementado no coinciden

Estas diferencias son reales y estaban en el documento original. Se resuelven
acá **una vez**, para no dejar dos fuentes de verdad discutiendo sobre el
nombre de una tabla que ya está en producción.

| Tema | Plan maestro | Vigente (implementado y verificado) | Por qué gana lo vigente |
|---|---|---|---|
| Tabla de capacidades por negocio | `business_capabilities` | **`business_modules`** | Es la que existe y de la que dependen `requireModule()`, `getBusinessModules()`, `createBusiness()` y el nav del frontend. Crear una paralela rompe todo eso sin ganar nada. §5.2 del plan del 28/08 ya lo decía |
| Catálogo de capacidades | `platform_capabilities` como tabla nueva | **`modules`, ampliada** | Mismo motivo. Se le agregaron `active`, `implemented`, `deleted_at`, `min_plan`, `sort_order`, `context_color` |
| PK de `industries` | `id` + `key` | **PK = `key`** | Sigue el patrón de `modules` (PK = `module_key`). No hay id opaco del cual distinguir el código, así que la segunda identidad no aporta. Desviación declarada en el commit `e0855b8` |
| Claves de rubro | `RESTAURANT`, `BEAUTY_WELLNESS`, `PROFESSIONAL_SERVICES` | `RESTAURANTE`, `BARBERIA`, `SPA`, `SERVICIOS_PROF` (§7 del plan del 28/08) | **Todavía no sembradas**: sólo existe `GENERIC`. Al sembrarlas se decide el idioma **una vez**; hoy `industries.key` y `modules.module_key` ya conviven en idiomas distintos y está anotado como deuda de nomenclatura |
| Contexto visual | campo `theme` con `moduleColors` | **`contextColor` por módulo**, enum cerrado | Un tema de negocio y una señal de contexto son cosas distintas. La identidad ZULU es monocromática y global; el color marca el módulo activo. El enum está en un CHECK de la base: `BRASS`/`CLAY`/`SAGE`/`NEUTRAL`. **El cian no es asignable** |
| `capability_dependencies` / `capability_permissions` | tablas propuestas | **no existen** | Pendientes de diseño. No se inventaron dentro de la Fase 3 |
| `industry_presets` versionados + `business_context.preset_version` | tablas propuestas | **no existen** | Ídem. La regla *"un preset actualizado no cambia tenants existentes"* hoy se garantiza por `business_modules.source`, que impide que un preset pise un override |
| Nombres de módulo | `PMS`, `POS`, `MENU`, `INVENTORY`, `TEAM`, `INTEGRATIONS` | `ALOJAMIENTO`, `POS_RESTAURANTE`, `REPORTES`, `HOUSEKEEPING`, `CUENTAS_CORRIENTES`, `FACTURACION` | Los 6 vigentes tienen código, rutas y `requireModule()` detrás. Los del plan son nombres de producto; si se adoptan, es un renombre con migración, no un alias suelto |

**Alias de producto:** si un rubro necesita mostrarse como "Hospedaje" en vez
de "Alojamiento", eso es **terminología** (`terminology_defaults`), no un
cambio de `module_key`. La clave técnica es estable por diseño.

---

## 2. Estado por sección del plan maestro

Marcado contra el repo y producción al 29/08/2026.

| § | Tema | Estado |
|---|---|---|
| 1 | Principios (separar por responsabilidad, no hardcodear rubro, la config no reemplaza reglas críticas) | **Completo como criterio**; vigente en `arquitectura-monolito-modular.md` y en las convenciones de ambos repos |
| 2 | Dominios y matriz de ownership | **Completo** — `src/` ya está por bounded context. Carve-out sin terminar: inventario. Sin módulo: Integrations |
| 3 | Contrato de `BusinessContext` | **Parcial** — contrato definido (§5.4 y §5.5 del plan del 28/08) y consumido por el frontend contra mock (`515bc3f`). Falta el endpoint (Fase 4) |
| 4.1 | Rubros | **Parcial** — tabla `industries` en producción; sólo `GENERIC` sembrado |
| 4.2 | Capacidades: `implemented` vs `active` | **Completo** — las dos columnas existen y los 6 módulos están en `implemented = TRUE` |
| 4.2 | `capability_dependencies` / `capability_permissions` | **Pendiente** — sin diseño |
| 4.3 | Cascada de resolución | **Parcial** — el modelo está (`industry_capabilities` + `business_modules.source`); el resolver es Fase 4 |
| 5 | Presets versionados y onboarding editable | **Pendiente** |
| 6 | Terminología configurable | **Parcial** — `terminology_defaults` en producción con 10 términos `SYSTEM`; falta resolver y consumir |
| 7 | `is_lodging` / `is_exclusive` / `booking_mode` separados | **Completo** — ADR propio (`diseno-taxonomia-tipos-reserva-2026-08-28.md`), schema v42/v43 |
| 7.2 | `AllocationPolicy` EXCLUSIVE/CAPACITY | **Pendiente** — hoy `is_exclusive` booleano |
| 8 | Entitlement ≠ Permission | **Completo en backend** — `requireModule()` y `authorize()` son guardas separadas |
| 9 | Desactivación segura de módulos | **Pendiente** — hoy no hay chequeo de dependencias ni de datos abiertos |
| 10 | Superadmin: sección de plataforma | **Pendiente** — Fase 5 |
| 10 | Auditoría de mutaciones de plataforma | **Completo** — `platform_audit_log`, Fase 2 |
| 11 | Identidad visual contextual | **Completo** — corriente V2 cerrada en producción |
| 12 | Eventos con sobre e idempotencia | **Completo** — Fase 1, schema v44, `processed_events` |
| 13 | Matriz de pruebas multirubro | **Pendiente** |
| 14 | Priorización de producto | **Insumo**, no ejecutado |

---

## 3. Lo que este documento NO cambia

- **No reabre la corriente visual V2.** Está cerrada en producción. El token
  layer está reemplazado y verificado; lo que falta es reconstruir las
  pantallas y conectar el color efectivo por módulo (V3/V4).
- **No reabre las 7 decisiones** de §14 del plan del 28/08.
- **No habilita features de CRM avanzado** ni dominios nuevos por rubro.

---

## 4. Único bloque siguiente

**Fase 4** — `src/business-context/`: resolución de la cascada y
`GET /api/business/context`. Al exponerlo, el frontend cambia
`mockSource()` por la fuente real **sin tocar las pantallas**: es lo que la
arquitectura del provider (`515bc3f`) hace posible.

El contenido del payload y los tres estados de consumo están cerrados en
§5.4 y §5.5 del plan del 28/08. Antes de ampliar el modelo con dependencias
de capacidades o presets versionados, cerrar la Fase 4 con el modelo que ya
está en producción.
