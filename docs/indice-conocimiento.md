# Índice de conocimiento de ingeniería

- **Fecha:** 2026-08-25
- **Estado:** aceptado (catálogo vivo; no sustituye a `pendientes` ni al roadmap)
- **Contexto:** el conocimiento estable estaba disperso en logs de sesión, diseños y auditorías. `pendientes-YYYY-MM-DD.md` es historial diario; este índice es el punto de entrada para **reutilizar** decisiones y procedimientos.
- **Alcance:** ambos repos (`app-main` + `appfrontend-main`). No duplica el detalle: enlaza.
- **Etiquetas:** `mapa-del-sistema` `convencion` `indice`

## Cómo usar esto

0. **Sesión nueva** → `zulu-hub-continuidad-<fecha más reciente>.md`: dónde quedó el proyecto y cuál es el próximo bloque. Después, este índice.
1. Tarea nueva → buscar acá por categoría o etiqueta.
2. Si el hallazgo es de **una sesión** (quién decidió, qué se verificó ese día) → `docs/pendientes-*.md`.
3. Si es **regla permanente de dominio** → `criterios-negocio.md` / `criterios-datos.md` (skill `criterios-negocio`).
4. Si es **visión de producto** → `plan-multirubro-maestro-*.md` (dirección multirubro, con su tabla de conciliación) y `roadmap-pms-multirubro.md` (backlog por rubro). Ninguno de los dos se lee solo al arrancar: se cruzan cuando la tarea toca un rubro.

**Orden de lectura para retomar el trabajo:**

```text
continuidad → plan maestro → plan de dominios ejecutado → pendientes del día → runbook
```

No copiar filas del roadmap a pendientes. No copiar pendientes a este índice.

---

## Fuentes de verdad (no negociar contra el log)

| Qué | Dónde | Categoría |
|---|---|---|
| Integridad de datos (maestro/transacción/documento) | [criterios-datos.md](criterios-datos.md) | Convención |
| Reglas A1–A9 (tenant, dinero, tiempo, estados, privacidad, concurrencia…) | [criterios-negocio.md](criterios-negocio.md) | Convención |
| Checklist de PRs / wiring multi-tenant | [DEFENSIVE_DEVELOPING.md](DEFENSIVE_DEVELOPING.md) | Convención |
| Códigos HTTP y `body.code` | [HTTP_CONTRACTS.md](HTTP_CONTRACTS.md) | Convención |
| RBAC por endpoint + cerca eléctrica de tests | [rbac-matriz-endpoints.md](rbac-matriz-endpoints.md) | Mapa + Convención |
| Dominios / CORS / hosting | [auditoria-dominios.md](auditoria-dominios.md) | Mapa + Runbook de auditoría |
| Nombres de archivo `<entidad>.<capa>.ts` | [convenciones-nombres.md](convenciones-nombres.md) (propuesta; patrón backend ya aplicado) | Convención (parcial) |
| Contexto de operación del negocio | [conocimiento-del-negocio.md](conocimiento-del-negocio.md) | Glosario de negocio |
| **Dónde quedó el proyecto y cuál es el próximo bloque** — lo primero que conviene abrir en una sesión nueva | [zulu-hub-continuidad-2026-08-29.md](zulu-hub-continuidad-2026-08-29.md) | Estado + punto de entrada |
| **Visión de producto multirubro**, con la tabla que concilia el plan contra lo implementado | [plan-multirubro-maestro-2026-08-29.md](plan-multirubro-maestro-2026-08-29.md) | Dirección (no orden de implementación) |
| Plan ejecutado de separación de dominios + las 7 decisiones cerradas + contrato de `BusinessContext` (§5.4 payload, §5.5 consumo) | [plan-separacion-dominios-multirubro-2026-08-28.md](plan-separacion-dominios-multirubro-2026-08-28.md) | Diseño ejecutado |
| Deploy, respaldos, rollback y las trampas que ya costaron un incidente | [conocimiento/runbook-deploy-render.md](conocimiento/runbook-deploy-render.md) | Runbook |
| Log de sesión (más reciente) | [pendientes-2026-08-29.md](pendientes-2026-08-29.md) | Historial, no catálogo |
| Backlog de producto por rubro | [roadmap-pms-multirubro.md](roadmap-pms-multirubro.md) | Roadmap (no pendientes) |
| **Referencia externa de inventario** — `C:\Users\Usuario\Downloads\proyecto script` (NQNTUR, ERP-lite sobre Apps Script). Es el espejo de este repo: su `REVIEW-ERP-LITE.md` lista como gaps propios lo que acá ya está (AFIP, hospedaje, caja, cuentas corrientes), y su fuerte es el inventario que acá falta. Ya se adoptaron su mapa `TRANSICIONES` y `DESTINOS_CONSUMO` (consumo≠merma); conteo físico (3 acciones: AJUSTAR/FALTA_MOVIMIENTO/DESCARTAR) y lotes/FEFO siguen sin adoptar (ver pendientes 27/08) | Fuera del repo | Referencia externa |

---

## Clasificación del corpus existente

### ADR (decisiones ya tomadas, no reabrir sin dueño)

| Decisión | Dónde está | Estado |
|---|---|---|
| Monolito modular, no microservicios ahora | [arquitectura-monolito-modular.md](arquitectura-monolito-modular.md) | aceptado |
| `is_exclusive` ≠ `is_lodging` (exclusividad vs pricing por noche) | [criterios-negocio.md](criterios-negocio.md) A8.2; pendientes 25/08 Bug 2 | implementado (schema v42) |
| Check-in bloquea si hay tarea de housekeeping del día y no está `INSPECTED`; override MANAGEMENT con rastro | pendientes 25/08 | implementado (backend); UI pendiente |
| Fail-open si no hay tarea de limpieza planificada para hoy | mismos | implementado |
| Día de negocio (Luxon + `Business.timezone` IANA) para el guard de `HousekeepingTask.create()`, no instante exacto | pendientes 25/08 | implementado |
| Downgrade de plan: etapa 1 = selección obligatoria de membresías a desactivar; etapas 2–3 no | pendientes 25/08 L | implementado etapa 1 |
| Detalle de entidad ERP = ruta `/dashboard/{entidad}/[id]` in-place, no `/edit` | [../appfrontend-main/docs/auditoria-modales.md](../../appfrontend-main/docs/auditoria-modales.md) + `appfrontend-main/CLAUDE.md` | implementado (8 entidades) |
| Alta mínima puede seguir en modal; no reducir el alta de Usuarios sin decisión de producto | pendientes 25/08 Fase 2 | aceptado |
| Rutas `OUT_OF_SERVICE`/`reset` de housekeeping: borrar, no deprecar | pendientes 25/08 | implementado |
| `audit_log` ya existe (R8/A9.4) — no crear una tabla nueva paralela ante un handoff externo que la desconozca | [conocimiento/playbook-audit-log-transaccional.md](conocimiento/playbook-audit-log-transaccional.md) | implementado (12 call sites transaccionales) |
| `RoleService.updatePermissionGroups()`: sin transacción real posible (plataforma+tenant); orden plataforma-primero es el mitigante aceptado | mismo playbook | aceptado, sin atomicidad real |
| El precio vive en el **servicio**, no en el recurso — reserva de alojamiento sin `serviceId` rechaza con `LodgingRequiresServiceError` (422) | [diseno-precio-servicio-vs-recurso-2026-08-27.md](diseno-precio-servicio-vs-recurso-2026-08-27.md) | implementado (27/08/2026) — backend + dashboard + los 3 caminos del portal. **Corrección (28/08/2026):** el código de frontend existía desde el 27/08 pero recién se pusheó el 28/08 (pendientes-2026-08-28.md, sección "Commit + push de la sesión") — "implementado" describía el código local, no lo deployado |
| Servicio = qué recurso se ocupa y por cuánto tiempo; rate plan = cuánto cuesta y qué incluye | mismo doc §2 | aceptado |
| Tarifas especiales de cliente con scope `resource_id`/`bucket=ALOJAMIENTO` quedan inalcanzables en alojamiento (la cascada entra por SERVICIO y no llega al recurso); se re-scopean sobre servicio/categoría | mismo doc, pendientes 27/08 | aceptado (decisión del dueño, 27/08/2026) |
| Un producto sin `sku` no puede existir; `customers.full_name` NOT NULL; `bookable_services.duration_minutes` obligatorio solo en `booking_mode='slot'` | pendientes 27/08, comentario en `schema.sql` (final del archivo) | implementado (27/08/2026), verificado en navegador real |
| Las reglas por tipo de movimiento de stock se declaran como DATO en `STOCK_MOVEMENT_RULES` (A6.1), no repartidas entre CHECKs y call sites — adoptado del mapa `TRANSICIONES` de `proyecto script` | `repositories/stock-movement.repository.ts`, pendientes 27/08 | implementado (27/08/2026) |
| Consumo interno (personal, degustación, elaboración interna) es COSTO OPERATIVO, nunca `movement_type='WASTE'` — catálogo `consumption_destinations` propio, nunca se mezcla con `waste_reasons` (el guard lo rechaza en los dos sentidos) — adoptado de `DESTINOS_CONSUMO` de `proyecto script` | `consumption-destination.service.ts`, `consumption-destinations.routes.ts`, `products.routes.ts` (`POST /stock/consumption`), `dashboard/destinos-consumo/page.tsx`, pendientes 27/08 | implementado (27/08/2026), verificado en navegador real contra la base real (10→7 unidades, movimiento correcto) |
| Seña con 3 formas (`PERCENTAGE`/`FIXED`/`UNITS`); UI expone 2, el resolver implementa las 3 | [diseno-sena-unidades-c1a-2026-08-27.md](diseno-sena-unidades-c1a-2026-08-27.md) | aceptado, sin implementar — el prerequisito (paso 0) ya está resuelto |
| `UNITS` = suma de las primeras N líneas, nunca `N × promedio` | mismo doc §2 | aceptado |
| `is_lodging`/`is_exclusive`/`booking_mode` son 3 ejes independientes, no una taxonomía disfrazada — no se unifican en un enum | [diseno-taxonomia-tipos-reserva-2026-08-28.md](diseno-taxonomia-tipos-reserva-2026-08-28.md) | aceptado |
| Selector de alta en 2 lugares (categoría controla `is_exclusive`, servicio controla `booking_mode` con copy contextual), no un único selector combinado; `isExclusive`/`bookingMode` obligatorios (sin default silencioso ni en schema ni en app) | mismo doc §3/§5/§6 | implementado (28/08/2026), verificado con click real + Postgres |
| Peluquería/Spa de `biz-demo-01` corregidas a `is_exclusive=true` (estaban en `false` por falta de control en la UI, no por decisión) | mismo doc §1b | implementado (28/08/2026), verificado por SQL |
| El adapter `categorias.create` de Refine descartaba `isLodging` en el alta (solo sobrevivía editando después) — hallazgo de paso al implementar el selector, corregido en el mismo cambio | mismo doc §6 | implementado (28/08/2026) |
| Multirubro se resuelve por **capacidades efectivas** (`enabledModules`), nunca por `if (industryKey === 'X')` repartido por el código. El rubro genera un preset editable, no una jaula | [plan-separacion-dominios-multirubro-2026-08-28.md](plan-separacion-dominios-multirubro-2026-08-28.md) §5/§6 | aceptado, sin implementar (Fase 3) |
| Superadmin administra **metadata** de capacidades, no comportamiento: `modules.implemented` distingue "catalogada" de "soportada por código, rutas, permisos y UI". Crear un RUBRO no requiere deploy; crear una CAPACIDAD sí — mismo criterio que `permission_group` | mismo doc §1; `platform.schema.sql` BLOQUE AUDITORÍA | implementado (28/08/2026) la columna; la pantalla es Fase 5 |
| Todo el catálogo multirubro y los overrides de tenant viven en la **BD de plataforma**, no en la del tenant — `business_modules` ya está ahí y se lee antes de `tenantMiddleware` | mismo doc §5.1 | aceptado |
| Un cambio de preset **nunca** pisa un override: aplicar preset escribe `source='PRESET'` y solo sobre filas inexistentes o ya `'PRESET'` | mismo doc §5.3 | aceptado |
| Los límites entre bounded contexts se hacen cumplir con `dependency-cruiser` en CI (`npm run lint:arch`), no por disciplina. El composition root son los `*.routes.ts` (construyen repos por request desde `req.db`), por eso están exceptuados de la regla de repos concretos | mismo doc §11; `.dependency-cruiser.cjs` | implementado (28/08/2026), 6 reglas verificadas contra violaciones de prueba |
| Idempotencia del outbox = casillero `processed_events (domain_event_id, handler_name)`, reclamado antes de correr y liberado si el handler falla. No reemplaza las claves naturales de cada handler: es la red para el que no tiene ninguna (mail) | mismo doc §8; `repositories/processed-event.repository.ts` | implementado (28/08/2026, schema v44), verificado contra Postgres real |
| La versión del evento es una **columna** (`domain_events.version`), no un sufijo en el nombre — 8 tipos ya emitidos con nombre pelado. Versión sin handler → dead-letter en el primer intento (A10.4), no tras 60 reintentos | mismo doc §8; `workers/outbox.worker.ts` | implementado (28/08/2026) |
| Las acciones de SUPERADMIN se auditan en `platform_audit_log` (BD de plataforma), con la MISMA forma que `audit_log` del tenant para reusar `diffFields()`. `business_id NULL` = cambio global, no dato faltante. Sin FK a `businesses`: una CASCADE borraría la evidencia | mismo doc §10; `platform/platform-audit-log.repository.ts` | implementado (28/08/2026), transaccional, verificado contra Postgres real |
| El sistema visual de ZULU Hub pasa a **blanco/negro/grafito de base + brass (reservas) / clay (comercio) / sage (estados positivos) / cian SOLO técnico**. Revierte la guía del 23/08 (navy + cian único, sin color por módulo) y restaura el mecanismo de color de Bastión bajo nombres ZULU — reafirmado por el dueño el 28/08 | [../appfrontend-main/docs/sistema-diseno-zulu-hub.md](../../appfrontend-main/docs/sistema-diseno-zulu-hub.md) §1 | aceptado, sin implementar (Fases V1–V6) |
| Cambiar el rubro de un tenant: solo Superadmin, con preview de consecuencias y confirmación explícita. **Nunca** apaga módulos, borra overrides, categorías, reservas ni estadías — solo escribe `industry_key` y agrega filas `source='PRESET'` que faltaban | [plan-separacion-dominios-multirubro-2026-08-28.md](plan-separacion-dominios-multirubro-2026-08-28.md) §14 D5 | aceptado |
| Preset `GENERIC` para negocios sin rubro elegido. `industry_key NULL` ≠ `'GENERIC'`: NULL es "nunca se le preguntó" (negocios previos a la Fase 3), GENERIC es "se le preguntó y no eligió" | mismo doc §14 D1 | aceptado |
| `locale` existe en la PK de `terminology_defaults` desde el día uno, pero el producto queda en `es-AR`: resolver de una sola pasada, sin selector de idioma ni fallback entre locales | mismo doc §14 D6 | aceptado |
| `console.log` en `src/scripts/` a propósito; Pino solo en el proceso del servidor | [auditoria-tecnica-infra-reservas.md](auditoria-tecnica-infra-reservas.md) §1.1 | implementado |
| Sentry no captura `DomainError`/`ValidationError`/`ZodError` | misma §1.2 | implementado |

### Diseño técnico / RFC (propuesta o cambio complejo)

Documentos `diseno-*.md` y referencias: seña C1 (Fase A 22/08 + **3 formas 27/08**), **precio servicio vs. recurso 27/08 (paso 0, prerequisito de C1-A)**, **taxonomía de tipos de reserva y selector de alta 28/08**, **separación de dominios + multirubro administrable desde Superadmin 28/08 (plan por fases; 0/1/2 ejecutadas)**, **sistema de diseño ZULU Hub 28/08 (especificación visual normativa, Fases V1–V6)**, cancelación/NC C2, líneas de factura C3, tarifas multinivel, POS mesas, housekeeping/`maintenance_window`, inventario carve-out, empresas multipropiedad, AFIP WSFE, QloApps, mejoras PMS 18/08.

Si la tarea toca uno de esos flujos, leer el `diseno-*` **antes** de pendientes del día.

### Runbooks

| Procedimiento | Dónde |
|---|---|
| Auditoría de dominios/CORS | `CLAUDE.md` raíz + [auditoria-dominios.md](auditoria-dominios.md) |
| Deploy Render: Node pin + migración EXCLUDE con filas solapadas | [conocimiento/runbook-deploy-render.md](conocimiento/runbook-deploy-render.md) |
| **Rollback de un deploy**: qué revertir y qué NO (casi nunca la base — las migraciones son aditivas); branches de respaldo Neon durables vs. PITR de 6 h; proyectos e ids reales de tenants y plataforma | [conocimiento/runbook-deploy-render.md](conocimiento/runbook-deploy-render.md) §Procedimiento 3 |
| **Verificar un deploy contra la base, no contra el log**, y validación punta a punta del outbox (una fila por consumidor en `processed_events`, un solo mail, cero duplicados) | mismo runbook, §Verificación |
| **Leer el resultado de CI sin equivocarse**: `set -o pipefail`, redirigir en vez de pipear (`$?` después de un pipe no es el del comando que importa), y confirmar con una segunda fuente (`gh run view` + `gh run list`) | mismo runbook, §Verificación |
| Incidente inicial Neon/Render (PLATFORM vs TENANT URLs) | [INCIDENT_LOG_2026-08-08.md](INCIDENT_LOG_2026-08-08.md) |
| I11 puppeteer / `@arcasdk/pdf` | [i11-arcasdk-pdf-puppeteer.md](i11-arcasdk-pdf-puppeteer.md) |
| Test de concurrencia de reservas | `src/scripts/concurrency-test-reservations.ts` + auditoría infra §3 |

### Playbooks (clase de problema → receta)

| Clase de problema | Documento |
|---|---|
| Fecha calendario (`YYYY-MM-DD`) vs UTC en JS / Zod | [conocimiento/playbook-fechas-timezone.md](conocimiento/playbook-fechas-timezone.md) |
| `SELECT FOR UPDATE` sobre 0 filas; recurso exclusivo vs cupo | [conocimiento/playbook-locks-exclusividad.md](conocimiento/playbook-locks-exclusividad.md) |
| Wiring tenant: `req.db` vs pool de plataforma; `Pick<Repo>` en servicios | [DEFENSIVE_DEVELOPING.md](DEFENSIVE_DEVELOPING.md) §3 + `app.ts` |
| 404 de detalle: `isApiError` + `err.code`, nunca `err.status` | `appfrontend-main/src/lib/apiErrors.ts`; caso Órdenes 25/08 |
| Cambiar `authorize(Roles.X)`: matriz RBAC + `EXPECTED_AUTHORIZE_CALL_SITES` | `app-main/CLAUDE.md` sección RBAC |
| `update()`/`deactivate()` de una entidad auditada: el UPDATE y el INSERT en `audit_log` deben compartir transacción, no dos `await` sueltos | [conocimiento/playbook-audit-log-transaccional.md](conocimiento/playbook-audit-log-transaccional.md) |
| Regla nueva de `dependency-cruiser`: verificarla con un archivo de violación de prueba ANTES de darla por buena — para un paquete npm, `to.path` es la ruta resuelta (`node_modules/express/index.js`), no el especificador, y una regla mal escrita nunca falla | `.dependency-cruiser.cjs` (docblock); pendientes 28/08 |
| 2+ campos independientes que forman un concepto de negocio con nombre — antes de construir el alta, agrupar en selector nombrado + resumen visible, no controles sueltos | [conocimiento/playbook-campos-interactuantes-selector-nombrado.md](conocimiento/playbook-campos-interactuantes-selector-nombrado.md) |

### Mapas del sistema

| Mapa | Dónde |
|---|---|
| Módulos y acoplamiento | [arquitectura-monolito-modular.md](arquitectura-monolito-modular.md), [auditoria-modularidad.md](auditoria-modularidad.md) |
| Recursos / categorías / reservas | [logica-recursos-categorias-reservas.md](logica-recursos-categorias-reservas.md) |
| Motor de reservas + observabilidad | [auditoria-tecnica-infra-reservas.md](auditoria-tecnica-infra-reservas.md) |
| Multi-cliente | [roadmap-multi-cliente-arquitectura.md](roadmap-multi-cliente-arquitectura.md) |
| Sitios corporativos | [roadmap-sitios-corporativos-reservas.md](roadmap-sitios-corporativos-reservas.md) |
| Frontend: Bastión, Refine, modales | `appfrontend-main/docs/` |

### Deuda técnica (conocida, no resolver en este índice)

Ver pendientes **27/08** (“Deuda nueva” + “Pendientes heredados”) y auditoría infra **Estado**: Redis rate-limit (1.4), BullMQ (1.5), UI de flujos backend-only, C1-Fase B pagos, etapas 2–3 de downgrade, gap facturas consolidadas en JOINs, `PlatformRepository.updateRolePermissionGroups()`/`updatePlanLimits()`/`createRole()` no atómicos ni dentro de su propia BD (`conocimiento/playbook-audit-log-transaccional.md`).

Nuevo el 27/08: tarifa de temporada que cruza el rango de la estadía (se valida solo la fecha de inicio); `rate_plans` no reutilizables entre servicios; `resource_locks` solo bloquea recursos concretos por ID, no un pool de categoría; `updateReservation()` resetea `depositAmount` y `needsMaintenanceReview` a su default.

### Incidentes

| Incidente | Dónde |
|---|---|
| Primer live Render/Neon | [INCIDENT_LOG_2026-08-08.md](INCIDENT_LOG_2026-08-08.md) |
| Deploy `e84c779` (Node 26 + EXCLUDE v42) | pendientes 25/08 “Incidente de deploy” + runbook Render |
| OOM `npm start` en Render | pendientes 19/08 sección U |

---

## Contradicciones código ↔ docs (hechos)

| Afirmación | Realidad observada | Acción |
|---|---|---|
| [criterios-datos.md](criterios-datos.md) Parte 1: facturas AFIP / NC “aún no existen” | Existen tabla `invoices`, rutas `/api/invoices`, diseño C2 | Corregido en esa fila (25/08/2026) |
| Auditoría infra §1.2: “falta pegar `SENTRY_DSN` en Render” vs pendientes: dueño confirmó que la pegó | **Pendiente de confirmar** cuál es el estado actual en el dashboard de Render | No asumir; verificar en el panel |
| `PhysicalResource.capacity` en UI 200/201 vs persistencia | Hasta el 25/08 `SqlResourceRepository` no persistía `capacity` (filas reales en default 1) | Fix aplicado; datos históricos no se backfillearon a otro valor |

---

## Qué no es este índice

- No es un ADR por cada commit.
- No reemplaza la skill `criterios-negocio` antes de tocar entidades.
- Los agentes `.agents/auditor-circuitos-erp` y `auditor-estructura` recorren código; este índice les da el mapa de docs para no reauditar de cero.
