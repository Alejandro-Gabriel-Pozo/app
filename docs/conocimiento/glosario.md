# Glosario de ingeniería (términos del proyecto)

- **Fecha:** 2026-08-25
- **Estado:** aceptado (vivo; no inventar sin call site)
- **Categoría:** Glosario
- **Etiquetas:** `vocabulario`
- **Ver también:** [conocimiento-del-negocio.md](../conocimiento-del-negocio.md) (reglas de operación, no de código).

| Término | Significado en este repo (hecho) |
|---|---|
| **MAESTRO / TRANSACCIÓN / DOCUMENTO** | Clases de `criterios-datos.md`. Reservan reglas incompatibles (borrar vs desactivar vs anular). |
| **Día de negocio** | Calendario en `Business.timezone` (IANA), no fecha del servidor ni UTC del `Date` de JS. |
| **`is_lodging`** | Categoría se cobra por noche. No implica exclusividad de reserva. |
| **`is_exclusive`** | Categoría: a lo sumo una reserva bloqueante en un instante. Tours/clases: `false` + `capacity`. |
| **`is_exclusive_resource`** | Columna snapshot en `reservations` (R9) para el EXCLUDE. |
| **Maintenance window** | Bloqueo de calendario por rango de fechas. Reemplazó el uso de housekeeping `OUT_OF_SERVICE` para pintar “fuera de servicio”. |
| **Housekeeping status** | Máquina de **tarea** (`PENDING`…`INSPECTED`), no estado de habitación tipo Opera. `OUT_OF_SERVICE` puede existir en filas históricas; ya no hay rutas para transicionar a/desde ahí. |
| **`INSPECTED`** | Umbral para check-in (25/08): `DONE` no alcanza. |
| **Fail-open (check-in)** | Sin tarea de limpieza **ese día** para el recurso, el check-in no bloquea. |
| **Platform DB vs tenant DB** | `PLATFORM_DATABASE_URL` vs pool por negocio (`req.db`). Nunca una `DATABASE_URL` genérica. |
| **`body.code`** | Identificador de error para el front. No ramificar solo por HTTP status (`HTTP_CONTRACTS.md`). |
| **`EXPECTED_AUTHORIZE_CALL_SITES`** | Entero en test de RBAC; hay que actualizarlo al agregar/sacar `authorize()`. |
| **Asiento** | Membresía de staff que cuenta contra `maxActiveMemberships`. OWNER no ocupa asiento (mismo filtro que el count). |
| **`MEMBERSHIP_DEACTIVATED`** | 409 al re-invitar/alta cuando ya hay membership inactiva: hay que `POST /users/:id/reactivate`, no crear otra fila (`UNIQUE identity+business`). |
| **Bastión** | Sistema de diseño del panel (`appfrontend-main/docs/sistema-diseno-bastion.md`). |
| **ADR (hotelero)** | Average Daily Rate — métrica de reportes, **no** Architecture Decision Record. En este índice, “ADR” de categoría significa decisión de arquitectura. |

## Pendiente de confirmar

- Si el staff opera en un huso distinto al `Business.timezone`, el playbook de `T00:00` en el navegador puede desfasar el día. No hay evidencia en código de un caso de prueba para eso.
