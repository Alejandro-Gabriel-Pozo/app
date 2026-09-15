# `migrations/` — histórico, NO se aplica a ninguna base

Los `.sql` de esta carpeta (`003_domain_events.sql` a `012_drop_dead_users_fk.sql`)
no están conectados a ningún aplicador. Nada en `src/` ni en `package.json`
los ejecuta.

El aplicador real es `applyTenantSchema()`
(`src/platform/tenant-db.setup.ts`), que corre `src/db/schema.sql` completo
e idempotente contra cada tenant DB — en el alta de un negocio
(`repair-tenant-db`/`set-tenant-url`) y en cada deploy vía
`npm run migrate:tenants` (`src/scripts/migrate-tenants.ts`).

Se conservan por valor de registro histórico (forma del cambio, orden en
que se introdujeron ciertas columnas/tablas) — por ejemplo, citado como
referencia en `src/clientes-finanzas/sql.financial-transaction.repository.ts:54`.
No los borres pensando que son deuda; tampoco los edites: no representan
el estado real de ningún schema desde que `applyTenantSchema()` los
reemplazó.

**Todo cambio de schema nuevo va en `src/db/schema.sql`**, con el bump
correspondiente de `CURRENT_SCHEMA_VERSION` (`src/platform/tenant-db.setup.ts`).
