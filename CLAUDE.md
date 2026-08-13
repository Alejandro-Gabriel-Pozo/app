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
