# Índice de conocimiento de ingeniería

- **Fecha:** 2026-08-25
- **Estado:** aceptado (catálogo vivo; no sustituye a `pendientes` ni al roadmap)
- **Contexto:** el conocimiento estable estaba disperso en logs de sesión, diseños y auditorías. `pendientes-YYYY-MM-DD.md` es historial diario; este índice es el punto de entrada para **reutilizar** decisiones y procedimientos.
- **Alcance:** ambos repos (`app-main` + `appfrontend-main`). No duplica el detalle: enlaza.
- **Etiquetas:** `mapa-del-sistema` `convencion` `indice`

## Cómo usar esto

1. Tarea nueva → buscar acá por categoría o etiqueta.
2. Si el hallazgo es de **una sesión** (quién decidió, qué se verificó ese día) → `docs/pendientes-*.md`.
3. Si es **regla permanente de dominio** → `criterios-negocio.md` / `criterios-datos.md` (skill `criterios-negocio`).
4. Si es **visión de producto** → `roadmap-pms-multirubro.md` (no se lee solo al arrancar; cruzarlo cuando la tarea toca un rubro).

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
| Log de sesión (más reciente) | [pendientes-2026-08-25.md](pendientes-2026-08-25.md) | Historial, no catálogo |
| Backlog de producto por rubro | [roadmap-pms-multirubro.md](roadmap-pms-multirubro.md) | Roadmap (no pendientes) |

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
| `console.log` en `src/scripts/` a propósito; Pino solo en el proceso del servidor | [auditoria-tecnica-infra-reservas.md](auditoria-tecnica-infra-reservas.md) §1.1 | implementado |
| Sentry no captura `DomainError`/`ValidationError`/`ZodError` | misma §1.2 | implementado |

### Diseño técnico / RFC (propuesta o cambio complejo)

Documentos `diseno-*.md` y referencias: seña C1, cancelación/NC C2, líneas de factura C3, tarifas multinivel, POS mesas, housekeeping/`maintenance_window`, inventario carve-out, empresas multipropiedad, AFIP WSFE, QloApps, mejoras PMS 18/08.

Si la tarea toca uno de esos flujos, leer el `diseno-*` **antes** de pendientes del día.

### Runbooks

| Procedimiento | Dónde |
|---|---|
| Auditoría de dominios/CORS | `CLAUDE.md` raíz + [auditoria-dominios.md](auditoria-dominios.md) |
| Deploy Render: Node pin + migración EXCLUDE con filas solapadas | [conocimiento/runbook-deploy-render.md](conocimiento/runbook-deploy-render.md) |
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

Ver pendientes 25/08 “Pendientes heredados” y auditoría infra **Estado**: Redis rate-limit (1.4), BullMQ (1.5), UI de flujos backend-only, C1-Fase B pagos, etapas 2–3 de downgrade, gap facturas consolidadas en JOINs, `PlatformRepository.updateRolePermissionGroups()`/`updatePlanLimits()` no atómicos ni dentro de su propia BD (`conocimiento/playbook-audit-log-transaccional.md`).

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
