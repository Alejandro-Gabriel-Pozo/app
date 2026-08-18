# Instrucciones del proyecto — app-main

Backend (API, dominio, infraestructura) de una app de reservas multi-tenant
y multirubro (hotelería, servicios, POS). Ver también el `CLAUDE.md` de
`App - frontend/` (nivel superior) para el contexto de los dos repos.

## Criterios de negocio — cumplimiento obligatorio

Antes de crear o modificar cualquier entidad, tabla, repositorio o
servicio de dominio, usá la skill `criterios-negocio`
(`.claude/skills/criterios-negocio/`). Formaliza el proceso de
`docs/criterios-datos.md` y `docs/criterios-negocio.md`: clasificar la
entidad (maestro/transacción/documento), chequear las reglas relevantes, y
declarar explícitamente qué se cumple, qué se incumple a propósito y por
qué. No propongas "mejorar" las decisiones que esos documentos ya marcan
como correctas.

Usá los nombres que ya existen en el código (`docs/criterios-negocio.md`,
A5.5). Si una entidad se llama `Turno`, no la renombres a `BookingLine`.

## Developing defensivo — obligatorio antes de dar un cambio por terminado

Además de `criterios-negocio`, todo cambio de código (no solo los que
tocan entidades de dominio) sigue `docs/DEFENSIVE_DEVELOPING.md`. Este
repo históricamente lo disparaba vía el checklist del PR template
(`.github/pull_request_template.md`), pero buena parte del trabajo actual
se commitea directo a `main` sin pasar por PR — así que el checklist
nunca se completa solo. Por eso: respondé la sección 2 (genérica) y, si el
cambio toca `src/api/routes/`, `src/container.ts`, `src/platform/` o
`src/workers/`, también la sección 3 (multi-tenant: `req.db` vs.
`getPlatformRawPool()`, pool del `TransactionManager`, BD del
`DomainEventRepository`) — como parte del mensaje de commit si no hay PR,
no solo cuando lo hay.

Esto no reemplaza a `criterios-negocio`: esa skill cubre integridad de
datos y reglas de negocio; este documento cubre fallos de arquitectura y
wiring (pools mezclados, fallos a mitad de camino, un solo camino por
responsabilidad). Los dos aplican en paralelo cuando el cambio toca
ambas cosas.
