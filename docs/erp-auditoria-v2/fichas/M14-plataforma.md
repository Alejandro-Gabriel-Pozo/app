# M14 · Plataforma y superadmin

**Auditado:** 02/09/2026 · **Método:** `00-programa-v2.md`
**Módulo nuevo en v2** — v1 no lo tenía en el inventario, y tiene schema propio,
autenticación propia y auditoría propia.

## 1. Flujo auditado

alta del negocio → aprovisionamiento de base → activación → cambio de plan →
suspensión → cancelación → baja

## 2. Estado

- **Módulo:** ⚠️ Revisado con brechas
- **Flujo "crear y activar un negocio":** ◇ Parcial — el aprovisionamiento
  automático existe y la activación sigue siendo un paso manual declarado
- **Flujo "cambiar plan y suspender":** ✅ Completo, con auditoría propia
- **Flujo "dar de baja un negocio y sus datos":** ◌ No existe

## 3. Último paso confirmado / primer paso incompleto

- **Último paso confirmado:** el cambio de estado y de plan, **auditado en
  `platform_audit_log`** `[V]` (`src/platform/platform.routes.ts:229`, `:321`,
  `:401`, `:452`) y con `reason` opcional en el schema de cambio de estado
  (`src/platform/platform.routes.ts:40`).
- **Primer paso incompleto:** **la activación del negocio**, que sigue siendo un
  paso manual: `POST /api/admin/set-tenant-url` es "a propósito el paso manual
  con el que hoy se activa un negocio nuevo" `[V]`
  (`src/platform/admin.routes.ts:11`).

## 4. Severidad máxima

**S1** — el alta de un cliente nuevo depende de un paso manual con una
herramienta declarada como de uso único, y no hay baja de datos.

## 5. Superficie

| Pieza | Ubicación |
|---|---|
| Schema propio | `src/db/platform.schema.sql` — 23 tablas |
| Auditoría propia | `platform_audit_log` (`src/db/platform.schema.sql:950`) |
| Auth propia | `src/platform/platform.auth.service.ts`, `PLATFORM_JWT_SECRET` |
| Rutas | `platform.routes.ts` (12), `admin.routes.ts` (2), `companies.routes.ts` (3) |
| Aprovisionamiento | `src/platform/neon-provisioning.ts`, `src/platform/tenant-db.setup.ts` |
| Pantallas | `superadmin`, `superadmin/login`, `superadmin/planes`, `superadmin/roles-de-fabrica` |

## 6. Identidad

`[V]` El negocio tiene `slug` validado con regex
(`src/platform/platform.routes.ts:27`): identidad operativa real, legible y
usada en las URLs del portal.

`[V]` **Aislamiento estructural, no lógico**: una base por negocio, resuelta por
`tenantMiddleware` (`src/app.ts:344`). Es la decisión de arquitectura más fuerte
del sistema y la que hace que muchas preguntas de multi-tenant no apliquen.

## 7. Estados

`[V]` `BusinessStatus`: `ACTIVE`, `SUSPENDED`, `CANCELLED`
(`src/types/enums.ts:66`), y `BusinessPlan` con `ENTERPRISE` entre sus valores
(`src/types/enums.ts:56`).

`[V]` `CANCELLED` es terminal y **no borra nada**: la base del tenant sigue
existiendo. No hay flujo de exportación ni de eliminación de datos.

## 8. Documentos y movimientos

`[V]` No hay facturación de la plataforma a sus clientes: ningún endpoint de
suscripción, cobro ni comprobante. El plan se cambia a mano
(`src/platform/platform.routes.ts:263`). Para un SaaS multi-tenant es la ausencia
más grande del módulo.

## 9. Saldos y reportes

`[V]` `GET /platform/stats` es el único reporte de plataforma
(`src/platform/platform.routes.ts:122`), y **no tiene consumidor** en el panel de
superadmin (`datos/cobertura.csv`).

`[V]` No hay reportes de uso por negocio, ni de límites consumidos contra
`plan_limits`.

## 10. Permisos y segregación

`[V]` `router.use(authenticatePlatform(), authorizePlatform([PlatformRole.SUPERADMIN]))`
después del login (`src/platform/platform.routes.ts:120`), con el motivo escrito:
hasta ese cambio sólo exigía autenticación sin restringir por rol, "el mismo
agujero que `admin.routes.ts` ya cerró" (`src/platform/platform.routes.ts:114`).

`[V]` **El hallazgo de seguridad mejor documentado del repo** está en
`admin.routes.ts:20`: las dos rutas exigían `Roles.MANAGEMENT` de *tenant* y
tomaban `businessId` del propio JWT, así que **cualquier OWNER/ADMIN de
cualquier negocio podía reapuntar su propio negocio a una URL de base
arbitraria** que el servidor luego usaba para conectarse. Se cerró el 19/08/2026
pasando a `authenticatePlatform()`.

Vale conservarlo como precedente: era una escalada de privilegio real, la
encontró una auditoría de producto, y el cambio de flujo (activar un negocio
dejó de ser autoservicio) se confirmó con el dueño antes del commit.

`[V]` `PLATFORM_JWT_SECRET` separado de `JWT_SECRET`, deliberadamente
(`CLAUDE.md` de `app-main`, sección `secret-lifecycle-discipline`).

## 11. Auditoría y trazabilidad

`[V]` **La plataforma audita mejor que el tenant.** `platform_audit_log` tiene
las mismas 9 columnas que `audit_log` más `business_id`
(`src/db/platform.schema.sql:950`), y se usa en los cuatro puntos de cambio
(estado, plan, límites, presets).

`[V]` **Pero tiene la misma limitación estructural**: es un diff de campos, no un
log de acciones. No hay `action`, ni `reason` persistido, ni `origin`, ni
`correlation_id`. El `reason` del cambio de estado se acepta en el body
(`src/platform/platform.routes.ts:40`) y no tiene columna donde guardarse.
⊃ `A2-T03-002`.

`[V]` El aprovisionamiento (`POST /businesses/:id/provision`) crea una base en
Neon; no se auditó en esta corrida si esa operación queda registrada. `[H]`

## 12. Errores, idempotencia y fallo parcial

`[V]` `applyTenantSchema()` corre el `schema.sql` completo, idempotente, antes de
activar el negocio (`src/platform/admin.routes.ts:16`). Ya no hace falta correrlo
a mano.

`[V]` Riesgo declarado en el propio `CLAUDE.md` del repo: el `buildCommand` de
`render.yaml` encadena `npm run migrate:tenants`, así que **cada deploy escribe
en todas las bases de tenant**. Deploy y migración son la misma operación.

`[H]` No verificado en esta corrida: qué pasa si `provision` falla a mitad de
camino — si el negocio queda en un estado intermedio recuperable. Se confirmaría
leyendo `neon-provisioning.ts` y buscando el manejo de fallo parcial.

## 13. Capacidad ausente

1. **Facturación de la plataforma a sus clientes.**
2. **Baja de datos de un negocio cancelado**, con exportación previa.
3. **Activación automática:** el paso manual de `set-tenant-url`.
4. **Panel de `stats`**: el endpoint existe sin consumidor.
5. **Reportes de uso contra `plan_limits`.**
6. **Segundo superadmin.** El código ya anticipa el problema
   (`src/platform/platform.routes.ts:114`) y hoy hay un solo actor de plataforma
   hardcodeado.
7. **Rotación de `DB_ENCRYPTION_KEY`.** ↔ `SEC-ROT-001`.

## 14. Brechas

| ID | Sev | Qué falta | Evidencia | Cruce |
|---|---|---|---|---|
| `A2-M14-001` | S1 | Activar un negocio depende de un paso manual con una herramienta declarada de uso único. | `src/platform/admin.routes.ts:11`, `:6` | **nuevo** |
| `A2-M14-002` | S1 | Un negocio `CANCELLED` conserva su base entera: sin exportación ni baja de datos. | `src/types/enums.ts:66`; ausencia de endpoint | **nuevo** |
| `A2-M14-003` | S1 | Sin facturación de la plataforma: el plan se cambia a mano y no genera cobro. | `src/platform/platform.routes.ts:263` | **nuevo** |
| `A2-M14-004` | S2 | `reason` se acepta en el body del cambio de estado y no tiene dónde guardarse. | `src/platform/platform.routes.ts:40`; `src/db/platform.schema.sql:950` | ⊃ `A2-T03-002` |
| `A2-M14-005` | S2 | `GET /platform/stats` sin consumidor. | `datos/cobertura.csv` | **nuevo** |
| `A2-M14-006` | S2 | Sin reportes de uso contra `plan_limits`. | ausencia de endpoint | **nuevo** |
| `A2-M14-007` | S2 | `DB_ENCRYPTION_KEY` sin procedimiento de rotación. | — | ↔ `SEC-ROT-001` |
| `A2-M14-008` | S3 | No verificado el manejo de fallo parcial del aprovisionamiento. | — | **nuevo** `[H]` |
| `A2-M14-009` | S3 | No verificado si el aprovisionamiento queda auditado. | — | **nuevo** `[H]` |

## 15. Criterios de cierre

- Alta de negocio de punta a punta sin paso manual.
- Un negocio cancelado tiene camino de exportación y de baja de datos.
- El `reason` de un cambio de estado se persiste.
- `stats` tiene panel o se retira.
- `DB_ENCRYPTION_KEY` tiene procedimiento de rotación escrito.
