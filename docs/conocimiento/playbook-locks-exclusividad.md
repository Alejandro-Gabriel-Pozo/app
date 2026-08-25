# Playbook — locks de disponibilidad y exclusividad de recurso

- **Fecha:** 2026-08-25
- **Estado:** implementado (schema v42 + `lockByIds` + cupo compartido)
- **Contexto:** `SELECT ... FOR UPDATE` sobre reservas en un rango **libre** no bloquea a nadie (0 filas). Doble-booking reproducido con autocannon.
- **Categoría:** Playbook + ADR embebido (`is_exclusive` ≠ `is_lodging`)
- **Etiquetas:** `A8.1` `A8.2` `R9` `postgres` `exclude` `capacity`
- **Referencias:** `criterios-negocio.md` A8; `auditoria-tecnica-infra-reservas.md` §§3–5; `ReservationAvailabilityService`; `ResourceRepository.lockByIds()`; `getByIdWithLock()`; constraint `reservations_no_overlap_exclusive`.

## Problema (INSERT)

Dos `POST /api/reservations` concurrentes para el mismo recurso y rango: ambas ven hueco, ambas insertan.

**Causa (hecho):** el lock estaba en filas de `reservations`. Hueco vacío ⇒ nada que lockear.

## Receta (disponibilidad al crear/mover)

1. Lockear **el recurso** (`resources` `FOR UPDATE`, ids ordenados) **antes** de leer disponibilidad.
2. Después, el chequeo de solapamiento / cupo.
3. Respaldo DB solo si el recurso es **exclusivo**: `EXCLUDE USING gist` + extensión `btree_gist`.
4. Snapshot R9: `reservations.is_exclusive_resource` al crear/reasignar (como `isLodging`).

No reutilizar `is_lodging` (precio por noche) para exclusividad. Columnas distintas; backfill inicial copió `is_lodging` **una vez** (gate `schema_migrations`).

## Problema (UPDATE de estado)

Leer la reserva fuera de la transacción, mutar en memoria, UPSERT ciego: lost update (doble cancel, confirm vs worker de hold, `CHARGE` duplicado si la idempotency key es el id del **evento**).

**Receta:** `getByIdWithLock()` **dentro** de `transactionManager.run()`; reusar `transitionTo()`. En `confirmPriceAdjustment()`, calcular `difference` contra `locked.totalPrice`, no contra el objeto leído antes del lock.

## Cupo compartido (`is_exclusive = false`)

- Exclusivo: cualquier solapamiento en estados bloqueantes (`PENDING`/`CONFIRMED`) rechaza.
- Compartido: `partySize` vs `PhysicalResource.availableSlots()` (no contar `COMPLETED`/`EXPIRED` como ocupación eterna).
- Default si no se resuelve categoría: **exclusivo** (conservador).
- Un EXCLUDE de no-solapamiento **rompería** tours/clases.

**Hecho colateral:** hasta el 25/08 `SqlResourceRepository` no persistía `capacity`/`description`. El JSON de la ruta se veía bien; la BD quedaba en `capacity=1`.

## Procedimiento de prueba que funcionó

- Integración con `TEST_DATABASE_URL` (Neon scratch): `reservation.service.integration.test.ts` (concurrencia 10 requests → 1 éxito; EXCLUDE sí/no según exclusivo).
- `vitest.integration.config.ts`: `testTimeout` 30s; pool `max: 15` (con `max: 3` el test de 10 concurrentes se queda sin conexiones y **parece** colgado).
- `schema.sql` debe crear `products` **antes** de tablas que la referencian; si no, `applyTenantSchema()` falla en negocio **nuevo** (tenants viejos migraron incremental y no lo veían).

## Alternativas descartadas

- Solo advisory lock por `resourceId` (sin EXCLUDE): no cumple A8.2.
- EXCLUDE en todos los recursos: incompatible con cupo compartido.

## Tareas futuras

Cualquier nuevo camino que cree o mueva reserva, hold, o transicione estado; scripts de carga (`concurrency-test-reservations.ts` cubre INSERT, **no** transiciones concurrentes).
