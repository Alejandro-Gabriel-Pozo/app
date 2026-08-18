# Pendientes — Martes 18 de Agosto 2026

Arranca a partir de lo que quedó abierto en `pendientes-2026-08-17.md`.
Mismo criterio de agrupación: deuda estructural primero, seguridad
después, calidad de código, backlog, observaciones sin implementar.
Marcar `✅ RESUELTO` in-place al cerrar un ítem.

---

## A. Resuelto hoy (18/08) — bugs de backend encontrados durante la migración a Refine/Bastión del dashboard (`appfrontend-main`)

Ningún de los tres estaba anotado como pendiente — se encontraron
probando el dashboard migrado contra el backend real, no en un review de
código. Los tres tienen test manual contra Postgres real (Neon) antes de
darlos por cerrados.

- ✅ **Housekeeping — fecha de `GET /housekeeping?date=` corría un día**
  (commit `a84f6a0`). `new Date(dateParam)` se pasaba directo al driver de
  `pg`, que serializa objetos `Date` con la zona horaria LOCAL del
  proceso — `scheduled_for::date = $2::date` terminaba comparando contra
  el día anterior/siguiente según el huso del server. `date` pasa ahora
  como string `'YYYY-MM-DD'` de punta a punta (routes/service/repository,
  incluida la versión in-memory de tests), sin pasar nunca por un objeto
  `Date`. 400 explícito si el query param no matchea el formato.
- ✅ **Reservas — confirmar devolvía 500 pese a quedar `CONFIRMED`**
  (commit `e31ba85`, schema v16). `occupancy_records` nunca tuvo
  `category_id`/`category_name`, aunque el repositorio ya las escribía
  desde el fix de agrupación por categoría en reportes — Postgres 42703
  (columna inexistente). `recordOccupancy()` corre DESPUÉS de la
  transacción que confirma la reserva, así que el cliente recibía 500 pese
  a que el estado ya había quedado `CONFIRMED` en la base. `ALTER TABLE
  ... ADD COLUMN IF NOT EXISTS` con `DEFAULT ''` — solo afecta filas ya
  existentes.
- ✅ **Clientes-finanzas — el CHARGE de toda reserva/orden confirmada
  fallaba al despacharse** (commit `a53b158`, dos bugs SQL apilados en
  `SqlFinancialTransactionRepository.insert()`): (1) `$2`/`$13` reusados
  en dos posiciones sintácticas distintas (VALUES vs. CASE/subquery de
  `shift_id`) causaban "inconsistent types deduced for parameter" (PG
  42P08) — cast explícito en la segunda aparición. (2) Una vez arreglado
  eso, `ON CONFLICT (idempotency_key) DO NOTHING` no matcheaba el índice
  único parcial real (`WHERE idempotency_key IS NOT NULL`) — PG 42P10 —
  arreglado agregando el mismo `WHERE` al `ON CONFLICT`. Verificado
  end-to-end: dos reservas nuevas generaron su CHARGE, y el evento
  original que había quedado dead-lettered (60 reintentos) se reprocesó a
  mano y cerró bien; cola de dead-letter en 0 al terminar.

## B. Resuelto hoy (18/08) — proceso: `DEFENSIVE_DEVELOPING.md` sin uso real

- ✅ **`docs/DEFENSIVE_DEVELOPING.md` existía pero su único disparador (el
  checklist del PR template) no se ejercitaba** (commit `0c8af7f`) — el
  trabajo reciente se commitea directo a `main` sin pasar por PR, y el
  archivo no estaba referenciado en `CLAUDE.md` (el único que se carga
  solo en cada sesión). Detectado porque el propio dueño preguntó si se
  estaba usando. Ahora `CLAUDE.md` lo hace obligatorio también en el
  mensaje de commit cuando no hay PR de por medio, en paralelo a
  `criterios-negocio`.

---

## C. Heredado de `pendientes-2026-08-17.md`, sigue abierto

Sin cambios desde ayer — ver `pendientes-2026-08-15.md`/`-16.md`/`-17.md`
para el detalle completo de cada uno:

### Deuda estructural / arquitectura
- Presets de roles de fábrica hardcodeados y duplicados en TS
  (`platform.repository.ts:151-177`) y SQL (`platform.schema.sql:233-260`)
  — no salen de config de plataforma editable.
- `PLAN_LIMITS` (`src/config/plan-limits.ts`) sigue siendo una constante
  de código, no una tabla en la BD de plataforma.
- Huso horario Argentina fijo (`-03:00`) en
  `reservation.service.ts::combineDateAndTime()` — camino crítico de
  disponibilidad/reservas, dejado a propósito para una sesión propia
  (DST-awareness, ver A4.7).
- F2(c): edición fina de permisos por rol como feature de plan — no
  implementado. Cualquier plan, sin restricción, ya puede editar
  `permissionGroups` de un rol de sistema hoy vía `PUT /api/roles/:id`.
- Decidir si portal de clientes/plataforma migra a cookie httpOnly o
  queda como está.

### Decisiones que necesitan al dueño
- E1–E7 de `pendientes-2026-08-13.md` (salvo E7c/d/e, ya resueltos) —
  falta que se defina alcance.
- Nota "quizá" del dueño (17/08, tarde): panel de superadmin para editar
  presets de roles/`PLAN_LIMITS` sin tocar código a mano — más grande que
  solo migrar a tabla (implica endpoint + UI de admin), sin alcance
  definido todavía.

### Backlog / integraciones externas
- Facturación electrónica AFIP — investigado (`referencia-afip-wsfev1.md`),
  nada implementado. Bloquea con ABM de Empresa (perfil fiscal) y de
  Producto (IVA). Plan: SDK `arcasdk-main` (Node/TS).
- Mails de reserva confirmada — falta cuenta de Resend + dominio
  verificado (`NoopEmailSender` hasta entonces).
- Login con Google — falta crear el OAuth Client ID en Google Cloud
  Console y cargar `GOOGLE_CLIENT_ID`/`NEXT_PUBLIC_GOOGLE_CLIENT_ID`.
- Portal de clientes: falta landing + alta pública de negocio, y
  mecanismo de "reclamo" (`claim`/`merge`) completo (el login con Google
  ya resuelve el caso más común, no el fusionar historial).
- Sitios corporativos (dominio propio) + guest checkout + magic link —
  solo documentado.

### Frontend faltante (backend ya listo)
- Botón "marcar como servido" en POS/cocina (`POST /:id/serve` ya existe
  en backend).
- UI para el catálogo de motivos de merma y para registrar una merma.
- UI para marcar un producto COMPOSITE, armar su receta y registrar una
  Producción.
- UI completa de empresas multipropiedad — compartir un producto,
  resolver revisiones pendientes, alta de `companies`.

---

## D. Nota de contexto — trabajo de `appfrontend-main` en paralelo (18/08)

No es "pendiente" en sí, pero da contexto a por qué aparecieron los tres
bugs de la sección A: se completó la integración de Refine.dev como capa
de datos del dashboard admin y la migración visual al sistema de diseño
"Bastión" en las 14 pantallas de gestión (+ subpágina de variantes).
Detalle en `appfrontend-main/docs/sistema-diseno-bastion.md` sección 7.
Sin pendientes nuevos de ese lado — quedó pusheado completo.
