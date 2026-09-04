# T02 · Usuarios, roles y permisos

**Auditado:** 02/09/2026 · **Método:** `00-programa-v2.md`

## 1. Flujo auditado

invitación → aceptación y alta → asignación de rol → ejecución de acciones →
cambio de rol → baja → reactivación

## 2. Estado

- **Módulo:** ⚠️ Revisado con brechas
- **Flujo "invitar y dar de alta":** ✅ Completo
- **Flujo "gobernar quién puede qué":** ◇ Parcial — el modelo es sólido, el
  control interno no
- **Flujo "auditar quién dio de alta a quién":** ◌ No existe

## 3. Último paso confirmado / primer paso incompleto

- **Último paso confirmado:** reactivación. `POST /api/users/:id/reactivate`
  existe `[V]` (`src/usuarios-roles/users.routes.ts:426`).
- **Primer paso incompleto:** **el rastro**. `users.routes.ts` (475 líneas) no
  escribe una sola fila de `audit_log` `[V]` (`grep -c "auditLog\|AuditLog"` =
  `0`). Se puede dar de alta un usuario con permisos de `MANAGEMENT`, usarlo y
  darlo de baja sin que quede registro de quién lo hizo.

## 4. Severidad máxima

**S1** — creación y baja de usuarios privilegiados sin auditoría.

## 5. Superficie

| Pieza | Ubicación |
|---|---|
| Grupos de permiso | `src/security/roles.ts:25` — 9 grupos |
| Roles del tenant | `src/db/platform.schema.sql:245` |
| Junction rol↔grupo | `src/db/platform.schema.sql:260` |
| Presets de fábrica | `src/db/platform.schema.sql:286`, seed en `:301` |
| Rutas | `users.routes.ts` (7), `roles.routes.ts` (5), `user-invitation.routes.ts` (6), `password-reset.routes.ts` (3) |
| Pantallas | `dashboard/usuarios`, `dashboard/usuarios/[id]`, `dashboard/roles`, `invitaciones/aceptar`, `restablecer-contrasena/*` |
| Cercas | `src/tests/security/rbac-matrix-sync.test.ts:44`, `src/tests/security/rbac-route-coverage.test.ts:20` |

## 6. Identidad

`[V]` La identidad (`identities`) vive en la base de **plataforma** y la
membresía en `memberships`; el usuario del tenant es una proyección. Es lo que
hace imposible el JOIN con `audit_log` (ver `fichas/T03-auditoria.md` §6).

Sin identidad operativa: los usuarios se referencian por UUID en toda la UI.
Menor que en las entidades operativas —un usuario se identifica por su email—
pero vale anotarlo.

## 7. Estados

`[V]` Los presets son cinco: `OWNER`, `ADMIN`, `RECEPTIONIST`, `HOUSEKEEPING`,
`WAITER` (`src/db/platform.schema.sql:301`). Los nueve grupos de permiso están
en `src/security/roles.ts:25`.

Reparto real de los 245 endpoints `[V]` (`datos/endpoints.csv`):

| Guard | Endpoints |
|---|---|
| `MANAGEMENT` | 123 |
| `FRONT_DESK` | 41 |
| `STAFF` | 15 |
| `SUPERADMIN` (vía `router.use`) | 13 |
| `BOOKING` | 11 |
| `ORDERS` | 10 |
| `handler:requireCustomerId` | 6 |
| `HOUSEKEEPING_AND_MANAGEMENT` | 2 |
| `OWNER_ONLY` | 1 |
| `CUSTOMER_ONLY` | 1 |
| sin guard declarativo | 21 |

**El número que importa es 123 de 245: la mitad de la API es un solo grupo.**
`MANAGEMENT` cubre configurar el negocio, editar tarifas, registrar cobros,
marcar deuda como cobrada, emitir facturas y leer el log de auditoría de todo
eso. No hay grado dentro de `MANAGEMENT`, así que tampoco puede haber
segregación de funciones dentro de él.

`OWNER_ONLY` gobierna **un** endpoint. La distancia entre "el dueño" y "quien
puede mover la plata" es, en la práctica, ninguna.

## 8. Documentos y movimientos

No aplica.

## 9. Saldos y reportes

No aplica.

## 10. Permisos y segregación

`[V]` Hay dos cercas automáticas, y son buenas:

1. `rbac-matrix-sync.test.ts:44` — cuenta call-sites de `authorize(Roles.X)`
   contra un número fijo (`204`) y falla si el maestro se desactualiza.
2. `rbac-route-coverage.test.ts:20` — falla si una ruta no tiene guard en su
   cadena ni un `router.use()` previo, salvo que esté en `PUBLIC_ROUTES` con
   motivo. Cubre el hueco que la primera no ve.

`[V]` Lo que **ninguna** cerca cubre, declarado en el propio `CLAUDE.md` del
repo: el cruce entre la sección 4 de `docs/rbac-matriz-endpoints.md` y el
`PUBLIC_ROUTES` del test. Es a ojo. ↔ `RBAC-SYNC-001`.

`[V]` Segregación de funciones: **no existe** en ningún flujo. Ningún endpoint
exige un aprobador distinto del ejecutor. Se verificó buscando cualquier
segundo guard o campo de aprobación en las rutas de dinero: `mark-collected`
(`src/clientes-finanzas/accounts-receivable.routes.ts:68`) pide `MANAGEMENT` y
nada más.

## 11. Auditoría y trazabilidad

`[V]` `role.service.ts` **sí** audita los cambios de grupos de permiso — es el
único caso cross-DB deliberado del repo (`src/domain/audit.ts:53`).

`[V]` `users.routes.ts` **no** audita nada: ni alta, ni baja, ni reactivación,
ni cambio de rol de un usuario. Es el hueco de esta ficha.

`[V]` Las invitaciones tampoco (`user-invitation.routes.ts`, `grep -c` = `0`).

## 12. Errores, idempotencia y fallo parcial

`[V]` `password-reset` y `invitations` exponen `lookup` y `accept` sin guard
declarativo (`datos/endpoints.csv`, cinco filas `SIN-GUARD`). Es correcto: son
públicos por diseño y están detrás de `authLimiter` (`src/app.ts:306`). El
CSV los marca porque no puede saberlo; la cerca `PUBLIC_ROUTES` sí los cubre.

`[H]` No verificado: si el token de invitación caduca y si un `accept` repetido
crea dos usuarios. Se confirmaría con una prueba de integración; no hay una hoy
en `src/tests/security/`.

## 13. Capacidad ausente

1. **Segregación de funciones.** Sin ella no hay control interno posible sobre
   la plata, por más auditoría que se agregue después.
2. **Grados dentro de `MANAGEMENT`.** Hoy quien puede editar el nombre del
   negocio puede marcar una deuda como cobrada.
3. **Auditoría del alta y la baja de usuarios.**
4. **Motivo obligatorio** en desactivación y reactivación.
5. **Sesiones y revocación.** No hay listado de sesiones activas ni forma de
   cortar el acceso de un usuario ya autenticado antes de que expire su JWT.
   `[H]` — verificar contra `src/security/auth.middleware.ts` en una pasada
   dedicada; no se auditó en esta corrida.

## 14. Brechas

| ID | Sev | Qué falta | Evidencia | Cruce |
|---|---|---|---|---|
| `A2-T02-001` | S1 | Alta, baja, reactivación y cambio de rol de usuarios sin auditoría. | `src/usuarios-roles/users.routes.ts:426`; `grep -c` = 0 | ⊃ `A2-T03-001` |
| `A2-T02-002` | S1 | Sin segregación de funciones en ningún flujo de dinero: el mismo grupo registra, aprueba y consulta. | `src/clientes-finanzas/accounts-receivable.routes.ts:68`; reparto de guards §7 | **nuevo** |
| `A2-T02-003` | S2 | `MANAGEMENT` cubre 123 de 245 endpoints; no hay grado intermedio. | `datos/endpoints.csv` | **nuevo** |
| `A2-T02-004` | S2 | Nada verifica la §4 de la matriz RBAC contra `PUBLIC_ROUTES`. | `CLAUDE.md` de `app-main`, sección RBAC | ↔ `RBAC-SYNC-001` |
| `A2-T02-005` | S2 | Ownership dentro del tenant sin guard estructural ni test negativo. | `docs/diseno-rbac-modelo-y-alcance-2026-08-30.md` | ↔ `RBAC-OWN-001` |
| `A2-T02-006` | S4 | No se verificó caducidad ni reuso del token de invitación. | ausencia de test en `src/tests/security/` | **nuevo** `[H]` |

## 15. Criterios de cierre

- `users.routes.ts` y `user-invitation.routes.ts` escriben auditoría del hecho.
- Al menos un flujo de dinero exige aprobador distinto del ejecutor.
- Existe un grupo entre `STAFF` y `MANAGEMENT`, o está escrito por qué no hace
  falta.
- Una cerca cubre el cruce §4 ↔ `PUBLIC_ROUTES`.
- Hay test negativo de ownership dentro del tenant.
