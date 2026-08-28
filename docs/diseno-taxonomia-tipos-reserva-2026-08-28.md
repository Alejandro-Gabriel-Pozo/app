# Diseño — taxonomía de tipos de reserva y selector de alta

- **Fecha:** 2026-08-28
- **Estado:** implementado (28/08/2026) — verificado con click real (login del dueño, resto por el agente) contra `biz-demo-01`; alta/edición de categoría y servicio, y confirmado directo en Postgres (`ancient-king-17098519`)
- **Contexto:** el dueño notó que `is_lodging`/`is_exclusive`/`booking_mode` se fueron sumando uno por uno cada vez que apareció un caso nuevo, sin preguntarse si hacía falta una taxonomía única. Pidió confirmar si son 3 ejes independientes o una sola taxonomía disfrazada, y diseñar el control de alta en consecuencia.
- **Etiquetas:** `A8.2` `resource_categories` `bookable_services` `UI` `taxonomia`
- **Referencias:** `criterios-negocio.md` A8; [playbook-locks-exclusividad.md](conocimiento/playbook-locks-exclusividad.md); `reservation-pricing.service.ts`; `reservation-availability.service.ts`; `reservation.service.ts:236-242`; `diseno-precio-servicio-vs-recurso-2026-08-27.md`.

---

## 1. Pregunta: ¿son 3 ejes independientes o una taxonomía disfrazada?

**Conclusión: son 3 ejes genuinamente independientes.** Cada uno lo lee un módulo distinto, para una pregunta distinta, y no hay CHECK/FK en `schema.sql` que los ate entre sí:

| Campo | Vive en | Quién lo lee | Para qué |
|---|---|---|---|
| `is_lodging` | `resource_categories` | `ReservationPricingService` (bucket ALOJAMIENTO/TURNOS para `deposit_policies`/`customer_rates`), `ReservationService.createReservation` (exige `serviceId` si es lodging), `email.handlers.ts` (texto "Check-in"/"Check-out"), filtro de listado Reservas/Estadías vs. Turnos | Bucket de políticas + qué panel/idioma de UI aplica |
| `is_exclusive` | `resource_categories` | `ReservationAvailabilityService.isExclusiveResource()` | Ocupación binaria vs. `capacity`/`availableSlots()` |
| `booking_mode` | `bookable_services` (uno o varios servicios por categoría) | `reservation-pricing.service.ts:139` (`units = nights` solo si `'block'`), `resolveEndTime()` | Forma de la línea de precio + si necesita `duration_minutes` |

No se propone unificarlos en un enum: se probó activamente que perdería casos reales en uso (alquiler multi-día exclusivo no-lodging; actividad `slot` dentro de una categoría de alojamiento, legítima según el propio comentario de `reservation.service.ts:236-238`) y que un dorm/habitación compartida (`is_lodging=true` + `is_exclusive=false`) no rompe nada aguas abajo (`idx_stays_reservation_active` es único por `reservation_id`, no por recurso).

### 1a. Combinaciones válidas conocidas

| Tipo | `is_lodging` | `is_exclusive` | `booking_mode` |
|---|---|---|---|
| Estadía/pernocte | `true` | `true` | `block` |
| Turno con horario (peluquería/spa/consultorio) | `false` | `true` | `slot` |
| Clase grupal con horario fijo | `false` | `false` | `slot` |
| Tour/actividad sin horario fijo | `false` | `false` | `event` |
| Evento (bloquea un espacio completo) | `false` | `true` | `event` |
| Alquiler multi-día exclusivo (no alojamiento) | `false` | `true` | `block` |
| Dorm/habitación compartida | `true` | `false` | `block` |
| Actividad con horario dentro de categoría de alojamiento (legítimo, ver 236-238) | `true` | `true` | `slot` |

### 1b. Hallazgo real — no es un problema de modelo, es de UI

`biz-demo-01` (única base real, proyecto Neon `ancient-king-17098519`) tenía Peluquería y Spa cargadas como `is_lodging=false`, `is_exclusive=false`, `booking_mode='slot'` — combinación que no corresponde a ningún concepto de negocio de la tabla de arriba (permite doble reserva del mismo profesional al mismo horario, mitigado hoy solo porque `capacity=1` en el único recurso de Peluquería).

Causa raíz confirmada leyendo el frontend, no solo inferida: **`is_exclusive` no tiene NINGÚN control en la UI, ni en Categorías ni en Servicios.**
- `dashboard/categorias/page.tsx` — `form` solo tiene `{ name, description, isLodging }`.
- `dashboard/servicios/page.tsx` — `form` tiene `bookingMode` con selector, pero nada de exclusividad.
- `lib/catalogo/types.ts` (`Category`) y `lib/servicios/types.ts` (`BookableService`) — `isExclusive` no existe en ningún tipo del frontend.

La única categoría con `is_exclusive=true` (Hostería) lo tiene por el backfill de la migración v42 (copió `is_lodging`), no porque alguien lo haya elegido en un formulario. Cualquier negocio con peluquería/spa/consultorio que use el panel tal como está hoy termina en la misma combinación incorrecta — no es un error puntual de este dueño.

**Corregido en datos reales (28/08/2026), con OK explícito del dueño**, aparte de este diseño:

```sql
UPDATE resource_categories SET is_exclusive = true, updated_at = NOW()
WHERE id IN ('cat-salon-barberia-1786584586896', 'cat-spa-1786546869768');
```

Verificado por SELECT posterior: Salón Barbería y Spa quedaron `is_exclusive=true`; Mesas/Servicos siguen en `false` (correcto, sin recursos exclusivos que reservar).

---

## 2. Principio de diseño — campos que interactúan sin ser obvio

Extraído como playbook reutilizable, ver [conocimiento/playbook-campos-interactuantes-selector-nombrado.md](conocimiento/playbook-campos-interactuantes-selector-nombrado.md). Resumen: cuando 2+ campos independientes arman, al combinarse, un concepto de negocio **con nombre real** (no cualquier par de campos), la UI de alta no los muestra como controles técnicos sueltos — un selector de opciones nombradas ayuda a elegir, y un resumen siempre visible (nunca en tooltip ni colapsado) muestra los valores reales que esa opción setea. El nombre ayuda a elegir, nunca reemplaza ni oculta el valor guardado. Sin opción pre-seleccionada.

---

## 3. Decisión de arquitectura — dónde vive el selector

`is_exclusive` vive en `resource_categories` (una vez por categoría). `booking_mode` vive en `bookable_services` (una vez **por servicio** — una categoría puede tener varios, con distinto `booking_mode` cada uno, caso ya contemplado por el código). Un solo selector combinado no tiene un único lugar natural para vivir.

Revisando los 3 servicios reales + el caso legítimo ya soportado (actividad `slot` en categoría de alojamiento): **en todos los casos, `is_exclusive` es uniforme dentro de una misma categoría** — nunca aparece una categoría que necesite mezclar exclusivo y compartido entre sus propios servicios. Lo que sí varía dentro de una categoría es `booking_mode`.

**Decisión: dos selectores, cada uno dueño de lo que controla.**

### 3a. Form de Categoría — controla `is_exclusive`

Selector nombrado de 2 opciones (no un checkbox técnico):

```
¿Cómo se ocupan los recursos de esta categoría?

 ( ) Exclusivo — una reserva a la vez
     Ej: habitaciones, sillas de peluquería, consultorios, alquiler de auto

 ( ) Cupo compartido — varias reservas hasta un límite
     Ej: clases grupales, tours, dormis compartidos

 [resumen siempre visible, no colapsado]
 → is_exclusive: (sin elegir todavía)
```

`is_lodging` sigue como toggle propio, aparte (es pricing, ortogonal — no entra en este selector).

### 3b. Form de Servicio — controla `booking_mode`

Selector nombrado de 3 opciones. Copy y ejemplos se adaptan según el `is_exclusive`/`is_lodging` que ya tiene la categoría elegida (no repite la pregunta de exclusividad):

```
Categoría: Salón Barbería (Exclusivo · Turnos)

¿Cómo se reserva este servicio?

 ( ) Con horario fijo — dura lo que dura, un turno por vez     [Turno]
 ( ) Por rango de fechas — el cliente elige inicio y fin       [Estadía/alquiler multi-día]
 ( ) Bloque único, precio plano — sin importar la duración     [Evento]

 [resumen siempre visible]
 → Exclusivo: sí (heredado de "Salón Barbería")
 → Modo: (sin elegir todavía)
 → Duración fija: — (solo si elegís "con horario fijo")
```

Con `is_exclusive=false` (categoría de Tours, por ejemplo), mismas 3 opciones con copy/ejemplo distinto: *"Con horario fijo, cupo compartido — Clase grupal"*, *"Por rango de fechas, cupo compartido — Alquiler de varias unidades por día"*, *"Bloque único, cupo compartido — Tour/salida grupal"*.

El resumen muestra siempre los valores reales combinados (`is_exclusive` heredado + `booking_mode` elegido + `duration_minutes` si aplica), visible en alta y en edición — nunca detrás de un tooltip.

---

## 4. "Ninguna opción nombrada encaja" — lista creciente, no modo avanzado

**Decisión: lista creciente.** No modo avanzado con campos crudos.

- Con `is_exclusive` ya fijado por la categoría, al servicio solo le quedan 3 valores posibles de `booking_mode` — el espacio de combinaciones es chico y cerrado, no hace falta escapar a campos crudos porque no hay combinaciones sin nombre (siempre hay, como mínimo, la etiqueta genérica del modo).
- Un modo avanzado reintroduce el problema que se está cerrando: un control técnico suelto sin guía — la misma causa raíz de Peluquería/Spa.
- Agregar un nombre nuevo (ej. si aparece "Evento" como concepto de negocio real) es un cambio de copy en el frontend (`MODE_LABEL`/ejemplos), no de schema ni de validación — costo bajo, sin motivo para necesitar la vía de escape.

Si en el futuro aparece un eje nuevo de verdad (no una etiqueta nueva) — como cancelación por tipo, ver nota en §7 — eso es una discusión de modelo aparte, no una válvula de escape de este selector.

---

## 5. `DEFAULT` de schema — evaluación

El `DEFAULT FALSE`/`DEFAULT 'slot'` de `schema.sql` **ya es código muerto para el camino real de la app**:
- `sql.category.repository.ts:97` — `dto.isExclusive ?? false`, siempre manda un valor explícito en el INSERT.
- `CreateBookableServiceSchema` (`bookable-service.schemas.ts:13`) exige `bookingMode` (sin `.optional()`), nunca llega `undefined` al repositorio.

El default silencioso real no está en la base, está en el código de la app: `sql.category.repository.ts:97` (`?? false`) y el mock equivalente en `category.service.test.ts:57,107`. Ese `?? false` es lo que hace indistinguible "no elegir" de "elegir cupo compartido".

**Implementado (28/08/2026), en este orden:**
1. `CreateCategoryDTO.isExclusive`: de `boolean | undefined` a `boolean` obligatorio; sacado el `?? false` de `sql.category.repository.ts:97`. Tests que asumían el default (`category.service.test.ts`, `categories.routes.test.ts`) actualizados para pasar el valor explícito.
2. `schema.sql` — `ALTER TABLE resource_categories ALTER COLUMN is_exclusive DROP DEFAULT` / `ALTER TABLE bookable_services ALTER COLUMN booking_mode DROP DEFAULT` (idempotente, corre en cada deploy). Sí había un script activo confiando en el default (`src/db/seed.tenant.sql`, legado de la era Supabase) y una fixture de integración (`rate-plans-seasonal-exclude.integration.test.ts`) — los dos corregidos con `is_exclusive` explícito antes de sacar el default.

---

## 6. Implementado (28/08/2026) — hallazgo adicional en el camino

Backend: `CreateCategoryDTO.isExclusive`/`CreateCategorySchema.isExclusive` pasaron a obligatorios (sacado el `?? false` de `sql.category.repository.ts`); `schema.sql` saca el `DEFAULT` de `resource_categories.is_exclusive` y `bookable_services.booking_mode` con `ALTER COLUMN ... DROP DEFAULT` (idempotente, corre en cada deploy — el `ADD COLUMN IF NOT EXISTS ... DEFAULT` original queda intacto porque es no-op en un tenant ya migrado). `src/db/seed.tenant.sql` (script manual, Supabase-era) y una fixture de `rate-plans-seasonal-exclude.integration.test.ts` insertaban `resource_categories` sin `is_exclusive` — corregidos, hubieran roto con el `DROP DEFAULT`.

Frontend: `Category.isExclusive` obligatorio en `lib/catalogo/types.ts`. **Hallazgo no buscado:** el adapter `categorias.create` de `lib/refine/dataProvider.ts` descartaba `isLodging` (y hubiera descartado `isExclusive`) en el alta — solo sobrevivía si se editaba la categoría después de creada. Corregido en el mismo cambio, no era optativo: dejarlo roto habría vuelto a perder `isExclusive` en cada alta nueva, el mismo bug que originó este documento.

`dashboard/categorias/page.tsx` — selector de 2 opciones (radio, sin preselección, resumen visible) para `isExclusive`; botón de submit deshabilitado sin elección. `dashboard/servicios/page.tsx` — selector de 3 opciones para `bookingMode`, copy contextual a `isExclusive` de la categoría elegida (bloqueado con mensaje hasta elegir categoría), resumen visible con exclusividad heredada + modo + duración.

Verificado con click real: alta de categoría de prueba (`Exclusivo`) → `POST /api/categories` con `isExclusive:true` confirmado en la respuesta y en Postgres; alta de servicio de prueba sobre esa categoría, modo `slot` con el copy "Turno de peluquería..." → `POST /api/bookable-services` con `bookingMode:'slot'` confirmado en respuesta y en Postgres; copy contextual verificado también para una categoría de cupo compartido (Mesas → "Clase grupal con horario fijo", etc.), sin necesidad de enviarlo. Datos de prueba desactivados al cerrar (soft-delete, con OK explícito del dueño).

`tsc --noEmit` limpio en los dos repos; `eslint` limpio en los archivos tocados; suite de `app-main` 1566/1566 (1 flake preexistente de timing en `reservation.cancel-confirmed.test.ts`, no relacionado, confirmado pasando solo).

## 7. Fuera de alcance de este diseño (no implementado, deliberado)

- **`cancellation_policies` es hoy una sola tabla global por negocio** (`business_id, min_days_before_checkin` → `refund_percentage`, sin scope por recurso/servicio/categoría/bucket), a diferencia de `deposit_policies` que ya resuelve por scope (ítem > categoría > bucket). Si algún día un Evento necesita reglas de cancelación distintas a una Estadía, el molde ya existe en el repo (patrón de scope de `deposit_policies`) — es aplicarlo a `cancellation_policies`, no una taxonomía nueva de tipo de reserva.
- La funcionalidad completa de "Eventos" (presupuesto, contrato, ítems de catering — ❌ en `roadmap-pms-multirubro.md`) no depende de este selector: la combinación `is_lodging=false`/`is_exclusive=true`/`booking_mode='event'` ya la soporta el modelo actual sin cambios.
