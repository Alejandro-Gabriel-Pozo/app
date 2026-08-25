# Instrucciones del proyecto — app-main

Backend (API, dominio, infraestructura) de una app de reservas multi-tenant
y multirubro (hotelería, servicios, POS). Ver también el `CLAUDE.md` de
`App - frontend/` (nivel superior) para el contexto de los dos repos.
Mapa de docs reutilizables: `docs/indice-conocimiento.md`.

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

## Preguntas de alcance pueden esconder una decisión de negocio

Antes de implementar algo que surgió como "¿lo construimos ahora?" o "¿esto
entra en el alcance?", separá la pregunta de alcance de cualquier decisión de
comportamiento escondida adentro. Caso real (D5, 22/08/2026): la pregunta era
"¿el catálogo es reutilizable?" — la implementación resolvió eso Y, sin
preguntarlo aparte, asumió que reutilizable significaba "snapshot al asignar"
en vez de "regla viva". Esa segunda parte era una decisión de negocio con dos
respuestas igual de válidas y no se preguntó — quedó registrada como
"confirmada" sin estarlo, y hubo que revertir diseño ya implementado.

Regla: si una pregunta de alcance, una vez resuelta, puede comportarse de más
de una forma razonable, cada forma es su propia pregunta con
`AskUserQuestion` — no la resuelvas como parte de la primera.

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

## RBAC — maestro de permisos por endpoint

`docs/rbac-matriz-endpoints.md` es la fuente de verdad de qué grupo de
`security/roles.ts` exige cada ruta — es un documento vivo, no una foto
única. Al agregar, sacar o cambiar un `authorize(Roles.X)` en cualquier
`*.routes.ts`, actualizá ese documento (la fila del endpoint que tocaste)
Y el número `EXPECTED_AUTHORIZE_CALL_SITES` de
`src/tests/security/rbac-matrix-sync.test.ts` en el mismo cambio — ese
test es una cerca eléctrica (cuenta call-sites reales contra un número
fijo), no un sistema que interpreta código; si rompe, es la señal de que
el maestro se desactualizó.

## Modularidad — convenciones aplicadas (no aspiracionales)

Estado real del código después de `docs/auditoria-modularidad.md`
(auditoría completa) y su roadmap (7 fases, todas aplicadas). El detalle
completo — hallazgos, métricas, razonamiento — vive en ese documento y en
`docs/convenciones-nombres.md`; acá solo las reglas que un archivo nuevo
tiene que respetar de entrada.

**Nomenclatura de archivos:** `<entidad>.<capa>.ts` (ej.
`reservation.service.ts`, `sql.reservation.repository.ts`,
`customer.entities.ts`). El prefijo `sql.`/`in-memory.` antes de la
entidad distingue implementaciones de una misma interfaz. Nuevo archivo
de dominio → seguí este patrón, no inventes uno nuevo por archivo.

**Dónde viven los tipos:** si TODOS los importadores de un `*.types.ts`
viven dentro de un mismo módulo (ej. `reservas/`), el archivo vive ahí —
no en `src/types/`. Esa carpeta queda reservada para lo genuinamente
transversal (`enums.ts`, `visual.interface.ts`, `express.d.ts`). Antes de
crear un tipo nuevo, preguntate quién lo va a importar; si la respuesta es
"solo archivos de este módulo", el tipo vive en el módulo.

**Antes de reescribir un patrón que ya existe como helper compartido:**
- Regex de hora HH:MM/HH:MM:SS → `api/schemas/common.schemas.ts`
  (`TIME_ONLY_REGEX`/`timeOnlySchema`), no lo reescribas inline.
- "Diff contra el estado anterior + grabar auditoría si cambió algo" →
  `domain/audit.ts::recordFieldChanges()`, no repitas el
  `diffFields()` + `if (changes.length > 0) { record(...) }` a mano.
- "Resolver plan + límites del negocio contra la BD de plataforma, con
  503 si no responde" → `security/resolve-plan-limits.ts::resolvePlanLimits()`,
  mismo contrato que `requireModule`/`requirePlan`.
- Auditoría de catálogo/tarifas especiales → `domain/audit.ts::recordFieldChanges()`,
  ya extendido a `RateCatalogService` y a la desactivación de `customer_rates`
  (distingue "cambió el % del catálogo" de "se tocó al cliente puntual") — no
  reimplementes el diff a mano.
- Resolver ALOJAMIENTO vs. TURNOS → `ICategoryRepository` (columna `is_lodging`
  de `resource_categories`), ya inyectado en `ReservationPricingService` — si un
  servicio nuevo lo necesita, reenviá la dependencia existente, no crees una
  tabla ni un flag nuevo.
- "Exactamente uno de N" en un CHECK de Postgres (pricing mode de
  `customer_rates`, scope de `customer_rates`, scope de `rate_catalog`) →
  patrón CASE-based, ya usado 3 veces en este repo — no el diseño polimórfico
  `scope_type`/`scope_id` (pierde la FK real hacia las tablas de ítem).

**Bounded contexts — no importes la clase rica de otro contexto dentro de
tu propia entidad.** Si tu módulo solo necesita 2-3 campos de una entidad
de otro contexto (ej. `reservas` necesitando "quién reservó" de
`clientes-finanzas`), definí tu propia representación mínima en tu
módulo (value object sin validación propia — esos datos ya se validaron
una vez, en el contexto dueño) y resolvé el resto por id cuando
realmente haga falta. Ejemplo real:
`reservas/reservation-customer.entities.ts::ReservationCustomer` (id,
fullName, email) en vez de importar `clientes-finanzas/
customer.entities.ts::Customer` completo (que trae `kind`,
`contactMethods[]`, `active` — nada de lo cual el otro contexto lee
nunca). La capa de rutas/aplicación sigue pudiendo consultar el otro
contexto para resolver el dato completo — lo que no cruza el límite es
el objeto rico en sí, dentro del dominio.
