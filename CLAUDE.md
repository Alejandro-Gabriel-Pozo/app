# Instrucciones del proyecto — app-main

Backend (API, dominio, infraestructura) de una app de reservas multi-tenant
y multirubro (hotelería, servicios, POS). Ver también el `CLAUDE.md` de
`App - frontend/` (nivel superior) para el contexto de los dos repos.

## Criterios de negocio — cumplimiento obligatorio

Antes de implementar cualquier cambio, verificá el cumplimiento de
`docs/criterios-datos.md` y `docs/criterios-negocio.md`.

Declará explícitamente qué reglas aplican al cambio y cómo se cumplen. Si
una regla se incumple a propósito, decilo y justificalo. No propongas
cambios a las decisiones listadas ahí como ya correctas.

Antes de crear o modificar una entidad, declará siempre si es MAESTRO,
TRANSACCIÓN o DOCUMENTO (`docs/criterios-datos.md`, Parte 1), y justificá
el cumplimiento de las reglas de esa clase.

Usá los nombres que ya existen en el código (`docs/criterios-negocio.md`,
A5.5). Si una entidad se llama `Turno`, no la renombres a `BookingLine`.
