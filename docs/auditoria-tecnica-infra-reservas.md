# Recomendaciones técnicas — infraestructura y motor de reservas

> Documento vivo. Segunda opinión externa (25/08/2026, "Recomendaciones
> técnicas — app-main", traída por el dueño) más lo que se verificó/
> encontró al empezar a ejecutarla. No son cambios urgentes en su
> mayoría — es una lista para priorizar con el developer, salvo el
> hallazgo de la sección 3, que sí es un bug real en producción.

Última actualización: 2026-08-25.

## 1. Observabilidad e infraestructura (documento original, sin tocar)

### 1.1 Logging estructurado — Pino
93 usos de `console.log/error/warn` en `src/` (**verificado exacto**),
sin logger estructurado. Propuesta: [Pino](https://github.com/pinojs/pino)
+ `pino-http`. Esfuerzo bajo, reemplazo incremental.

### 1.2 Error tracking — Sentry
No hay tracking de errores en producción. Propuesta:
[Sentry](https://sentry.io/) (alternativa: Better Stack). Requiere crear
una cuenta externa — no lo puede hacer Claude, lo tiene que dar de alta
el dueño.

### 1.3 CI — ⚠️ el diagnóstico original está desactualizado
El documento decía que había dos workflows (uno funcional, uno
`noop` placeholder) y que "no se ve un job de typecheck ni de lint
corriendo". **Verificado contra `.github/workflows/`, 25/08/2026:**
- Hay 4 workflows, no 2: `ci.yml`, `a.yml`, `lint-autofix.yml`,
  `pr-checklist.yml`.
- `ci.yml` **ya corre 4 jobs en cada push/PR a main**: tests+coverage,
  typecheck (`npm run build`), lint (`npm run lint`), y un chequeo de
  que `CURRENT_SCHEMA_VERSION` se haya bumpeado si `schema.sql` cambió.
  El `README.md` no mentía.
- `a.yml` es un placeholder inerte (`workflow_dispatch`, nunca corre
  solo) y `lint-autofix.yml` es una herramienta manual de un solo uso
  que su propio comentario dice borrar después de correrla. Ninguno de
  los dos compite con `ci.yml` ni deja huecos de validación.

**Conclusión: el punto 1.3 tal como estaba planteado no aplica.** Lo
único que queda, si molesta el ruido, es borrar `a.yml` y
`lint-autofix.yml` — housekeeping cosmético, no una brecha de CI.

### 1.4 Redis para rate-limiting
`auth.routes.ts` ya tiene el comentario propio "Para multi-instancia
reemplazar por un store Redis" (**verificado, cita exacta**). No urgente
con la escala actual (un tenant, una instancia). Requiere una cuenta
externa (Upstash u otro) — igual que Sentry, lo tiene que dar de alta el
dueño.

### 1.5 BullMQ para workers
Sin tocar — el outbox worker actual está bien diseñado. Dejar para
cuando haga falta cron/prioridades/backoff más sofisticado.

### 1.6 Cobertura de validación con Zod
31 de 237 archivos de código importan Zod (**verificado, el documento
decía 32 — diferencia despreciable**). Pendiente: pasada para confirmar
que toda ruta con input externo valida.

### 1.7 Higiene menor
`ts-prune` → `knip` si molesta el ruido de falsos positivos. Duplicación
2.16% backend (no prioridad) vs. 7.71% frontend (ahí rinde más el DRY).

## 2. Auditoría del motor de reservas — plan original

Punto de partida: ya existe `SELECT ... FOR UPDATE` con tests dedicados
(`resource-lock.service.test.ts`, `sql.resource-lock.repository.test.ts`,
**verificados, existen**). Orden sugerido: 2.1 coverage → 2.2 concurrencia
real → 2.3 auditoría de máquina de estados → 2.4 property-based testing
con `fast-check`.

## 3. Lo que se encontró al ejecutar 2.1 + 2.2 — ⚠️ BUG REAL

### 3.1 Coverage (2.1) — el mapa de riesgo señaló el lugar exacto

`npx vitest run --coverage` escopeado a `src/reservas/`:

- `reservation.service.ts` (818 líneas): **98% cubierto.** Los dos huecos
  son triviales (un getter de una línea, la rama "no encontrado" de un
  helper privado) — no priorizar.
- `reservation-availability.service.ts` (368 líneas): **84.7% cubierto —
  pero el hueco es exactamente el método que previene el doble-booking.**
  `resolveOccupyingReservations()` tiene una rama con lock
  (`getActiveForResourceInRangeWithLock`, usada dentro de
  `transactionManager.run()`) y un fallback sin lock. **La rama con lock
  nunca se ejecuta en los 274 tests de `src/reservas/`** — no por
  descuido: el propio comentario en `reservation.service.ts:37` lo dice
  ("fallback sin lock si el repositorio no lo implementa, **como los
  mocks en tests**"). Los mocks de test deliberadamente no implementan
  los métodos `...WithLock`.

Esto ya era la señal: un test unitario con mocks estructuralmente no
puede probar si el lock real serializa bajo concurrencia. Hacía falta
2.2, no como buena práctica sino como la única forma de ejercitar ese
código.

### 3.2 Test de concurrencia real (2.2) — reprodujo el doble-booking

Script nuevo: `src/scripts/concurrency-test-reservations.ts`
(`autocannon`, agregado como devDependency). Dispara N `POST
/api/reservations` simultáneos reales contra el mismo recurso + mismo
rango horario y cuenta cuántos ganan.

**Resultado contra el backend local real (`biz-demo-01`), 3 corridas
distintas:**
- Corrida 1 (20 conexiones, recurso Habitación 01, rango 2026-11-23
  10:00-11:00 UTC): **3 reservas creadas** para el mismo recurso/rango
  exacto (`reservationNumber` 35, 50, 32).
- Corrida 2 (20 conexiones, mismo recurso, rango 2027-03-13 10:00-11:00
  UTC): **3 reservas creadas** de nuevo (`reservationNumber` 63, 61, 65).
- Corrida 3 (8 conexiones, rango 2028-01-07 10:00-11:00 UTC): **3
  reservas creadas** (`reservationNumber` 130, 131, 134), más 5 de 8
  requests devolviendo `500` en vez de `400`/`201` — probablemente
  Postgres tirando un error de serialización bajo contención real que el
  código no captura explícitamente. Anotado, no investigado a fondo —
  secundario al hallazgo principal.
- Una corrida con solo 5 conexiones sí sirvió como control: 1×`201` +
  4×`400`, sin duplicados — con menos concurrencia real, la ventana de
  carrera es más chica y a veces no se dispara. Esto es consistente con
  la causa raíz de abajo, no la contradice.

Las 9 reservas duplicadas de prueba se cancelaron después de cada
corrida (no quedó nada activo en `biz-demo-01`).

### 3.3 Causa raíz, confirmada en el código

`sql.reservation.repository.ts::getActiveInRange()`:

```sql
WHERE r.resource_id = $1 AND r.status = ANY($4)
  AND r.start_time < $3 AND r.end_time > $2
FOR UPDATE
```

`FOR UPDATE` bloquea **filas que ya existen** hasta el COMMIT de quien
las tiene lockeadas. Cuando el hueco está libre (el caso normal — nadie
reservó ahí todavía), esta consulta devuelve **0 filas**, y `FOR UPDATE`
sobre un resultado vacío no bloquea nada en absoluto. Transacciones
concurrentes corren el mismo SELECT en la misma ventana, todas ven "0
conflictos", todas insertan. Es el gotcha clásico de Postgres:
`SELECT ... FOR UPDATE` sirve para serializar *modificaciones* a filas
existentes, no para prevenir *inserciones* nuevas que compiten por un
mismo hueco.

**Sin backstop a nivel de base de datos** — `schema.sql` (tabla
`reservations`) no tiene ninguna constraint `EXCLUDE`/`UNIQUE` que
impida el solapamiento. La única protección hoy es este `FOR UPDATE`,
que no cubre el caso de hueco vacío.

### 3.4 Opciones de arreglo (sin decidir todavía — para charlar con el developer)

1. **Constraint `EXCLUDE` en Postgres (recomendado)** — con extensión
   `btree_gist`:
   `EXCLUDE USING gist (resource_id WITH =, tstzrange(start_time, end_time) WITH &&) WHERE (status IN ('PENDING','CONFIRMED'))`.
   Blindaje real a nivel de base, no depende de que el código de
   aplicación acierte siempre en every call site presente y futuro. Es
   un cambio de schema: requiere bump de `CURRENT_SCHEMA_VERSION`, pasar
   por la skill `criterios-negocio` (`reservations` ya es TRANSACCIÓN),
   y probar contra `biz-demo-01` antes de dar por cerrado.
2. **Advisory lock por `resourceId`** —
   `pg_advisory_xact_lock(hashtext(resourceId))` antes del SELECT,
   dentro de `transactionManager.run()`. Cambio más chico, sin tocar
   schema — pero sigue siendo disciplina de código: cualquier caller
   nuevo que arme una reserva por otro camino y se olvide del lock
   reabre el mismo hueco.
3. **No arreglar hoy, solo documentar** — opción elegida por el dueño en
   esta sesión (25/08/2026). Retomar cuando se defina el approach con el
   developer.

## Estado

- Secciones 1 y 2: sin empezar (excepto la corrección del punto 1.3,
  hecha en la verificación de arriba).
- Sección 3 (bug de doble-booking): **hallazgo confirmado y documentado,
  sin arreglar a propósito** — decisión del dueño, 25/08/2026. Blast
  radius real: cualquier resourceId/rango que hoy no tenga ya una
  reserva encima está expuesto si dos requests de creación llegan lo
  bastante juntas (en producción, con tráfico real, no solo bajo un
  script de carga).
- Script `src/scripts/concurrency-test-reservations.ts` queda en el
  repo, listo para volver a correr una vez que se implemente cualquiera
  de las dos opciones de arreglo — es la forma de confirmar que de
  verdad quedó resuelto.
