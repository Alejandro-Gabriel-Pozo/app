# Playbook — audit_log transaccional (update + rastro en la misma transacción)

- **Fecha:** 2026-08-25
- **Estado:** implementado (12 call sites) — commit `04d7a8c`
- **Contexto:** `recordFieldChanges()` corría en un `await` suelto DESPUÉS del `await` que actualizaba la entidad. Si el segundo fallaba, la entidad quedaba escrita pero el rastro de auditoría se perdía en silencio. Encontrado al evaluar un handoff externo (research de tres repos de inventario) que proponía crear una tabla `audit_log` nueva — **descartado**: ya existe (`docs/criterios-datos.md` R8, `schema.sql` BLOQUE 10), el gap real era este.
- **Categoría:** Playbook + ADR embebido (mecanismo de auditoría ya existente, no crear uno nuevo)
- **Etiquetas:** `R8` `A9.4` `transactionmanager` `audit-log` `postgres` `multi-db`
- **Referencias:** `domain/audit.ts`; `TransactionManager`/`PgTransactionManager` (mismo mecanismo del playbook de locks); `repositories/audit-log.repository.ts`; `pendientes-2026-08-25.md` sección "RBAC granular + auditoría — paso 1".

## Problema

`repo.update(id, dto)` + `recordFieldChanges(auditLogRepo, ...)` como dos `await` sueltos contra el mismo pool. Si el segundo falla (conexión cae, timeout), la entidad quedó actualizada pero no hay fila de auditoría — ni error visible para el caller, que ya recibió 200.

Grep real de `recordFieldChanges(` encontró **12 call sites** con este patrón, no los 4 que se habían estimado a ojo desde un comentario desactualizado de `schema.sql`. No asumir el número de call sites de un patrón por un comentario — grepear siempre.

## Receta (misma BD en ambos lados — caso general)

1. Repositorio de la entidad gana un método hermano `updateWithClient?(client, id, dto)` (o `deactivateWithClient?`) — mismo SQL que el método normal, pero contra el `client` recibido en vez de `this.sqlClient`. Opcional en la interfaz, mismo criterio que `getByIdWithLock?` del playbook de locks — no rompe implementaciones in-memory que no lo necesiten.
2. `AuditLogRepository` gana `recordWithClient?(client, changes)` — mismo patrón.
3. `domain/audit.ts::updateWithAudit(transactionManager, auditLogRepo, entity, entityId, changedBy, changes, update)` envuelve las dos escrituras en `transactionManager.run()`. El caller sigue resolviendo `before`/`diffFields()` **antes** de llamar (no necesita estar dentro de la transacción, solo la escritura).
4. Servicios que no tenían `TransactionManager` inyectado lo suman al constructor + wiring en `container.ts`/cada `*.routes.ts` (`buildTenantTransactionManager(req)`, helper ya existente en `db/tenant-context.ts` — no reinventar wiring nuevo).
5. Rutas sin service dedicado (`customers.routes.ts`, `resources.routes.ts`) resuelven el `TransactionManager` inline con el mismo helper.

## Efecto colateral bueno, no pedido pero correcto

Al mover el `update` real adentro de la transacción, aparece una carrera real entre el `findById()` inicial (fuera de la transacción) y el `UPDATE` (dentro): la fila puede desaparecer por un delete concurrente en el medio. `ProductService`/`RateCatalogService` ahora abortan la transacción (throw dentro del callback → rollback, sin INSERT de auditoría fantasma) y traducen eso al contrato público de siempre (`null` / `RateCatalogEntryNotFoundError`) en vez de dejar pasar un `undefined` silencioso.

## Caso especial — dos bases de datos distintas (NO uses este mecanismo)

`RoleService.updatePermissionGroups()`: el rol se actualiza contra la BD de **plataforma** (`platformRepo`), el audit log vive en la BD del **tenant** (`audit_log` es deliberadamente sin `business_id`, aislado por pool de conexión — no hay filtro posible). `TransactionManager.run()` recibe un solo pool — no puede envolver dos bases.

**Mitigación aceptada (sin atomicidad real):** el orden que ya tenía el código — update de plataforma primero, audit de tenant después — es el más seguro de los dos posibles. Si el segundo paso falla: se pierde el rastro, pero el permiso ya cambió de verdad (mismo riesgo que existía antes de que `audit_log` existiera). Al revés sería peor: una fila de audit_log afirmando un cambio que nunca pasó. Documentado con comentario en el código, no se tocó la estructura.

## Hallazgo colateral, documentado y NO arreglado

`PlatformRepository.updateRolePermissionGroups()` (y `updatePlanLimits()`, mismo patrón según su propio comentario) hacen `DELETE` + loop de `INSERT` sueltos — no son atómicos **ni siquiera dentro de la BD de plataforma sola**. Si un `INSERT` del medio falla, el rol/plan queda con un subconjunto incompleto. Distinto problema del de arriba (este si sería arreglable con una transacción normal, misma BD) — sin encarar, queda para cuando alguien lo priorice.

## Procedimiento de prueba que se corrió

`tsc --noEmit` limpio, `eslint` sin errores nuevos, suite unitaria completa 1519/1519. **No se corrió** una prueba de integración forzando un fallo a mitad de transacción contra Postgres real para confirmar el rollback de verdad (a diferencia del playbook de locks, que sí tiene ese procedimiento con `TEST_DATABASE_URL`) — pendiente si alguna vez hace falta demostrarlo, no solo confiar en la lectura del código.

## Tareas futuras

- Extender el mismo mecanismo a entidades TRANSACCIÓN (`invoice.service.ts`, `order.service.ts`) — es el prerequisito del mecanismo "maker-checker" (crear factura vs. marcarla auditada) de la iniciativa de RBAC granular. Ver `pendientes-2026-08-25.md`.
- Grupo de lectura `AUDIT_VIEW` separado de `MANAGEMENT` para `GET /api/audit-log` — no implementado todavía.
- Cualquier nuevo `update()`/`deactivate()` de una entidad auditada (o una entidad nueva que empiece a auditarse) debe usar `updateWithAudit()` desde el principio, no el patrón viejo de dos `await` sueltos.
