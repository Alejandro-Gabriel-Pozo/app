# Plan — Separación de dominios y adaptación multirubro (ZULU Hub)

- **Fecha:** 2026-08-28
- **Estado:** **Fases 0, 1 y 2 ejecutadas y verificadas** (28/08/2026, sin commitear).
  Fases 3–9 y V1–V6: aprobadas, sin implementar. Las 7 decisiones de §14 están cerradas.
- **Alcance:** `app-main` (backend) + `appfrontend-main` (frontend), incluido el panel de Superadmin.
- **Documentos que NO reemplaza:** `arquitectura-monolito-modular.md` (ADR de monolito
  modular), `plan-multirubro.md` (cierre de restos hardcodeados, casi todo ya resuelto),
  `roadmap-pms-multirubro.md` (backlog de producto), `pendientes-*.md` (log de sesión).
- **Etiquetas:** `diseño` `mapa-del-sistema` `multirubro` `plataforma`

---

## 0. Resumen ejecutivo — qué cambia respecto del enunciado

El pedido asume un punto de partida más crudo del que hay. Verificado contra el código
real hoy:

| Lo que pide el enunciado | Estado real |
|---|---|
| Fase 1 — inventario y mapa de dependencias | **Ya existe.** `arquitectura-monolito-modular.md` §3 (dependency-cruiser, 15/08) + `auditoria-modularidad.md` (18/08, 22 hallazgos, 7 fases aplicadas). |
| Fase 2 — reorganización a módulos verticales | **Ya ejecutada.** `src/` está por bounded context: `reservas/`, `pms-estadias/`, `pos-menu/`, `clientes-finanzas/`, `usuarios-roles/`, `facturacion/`, `platform/`. Los pasos 1–4 del plan del 15/08 están ✅. |
| Fase 4 — `is_lodging` / `is_exclusive` / `booking_mode` independientes | **Ya decidido y construido**, con ADR propio: `diseno-taxonomia-tipos-reserva-2026-08-28.md`. No se unifican. Schema v42/v43, UI de selector nombrado en Categorías y Servicios, `is_exclusive` obligatorio de punta a punta. |
| "El backend no infiere rubros desde nombres de recursos" | **Ya resuelto.** El heurístico `resourceName.includes('cabin'\|'mesa'\|'spa')` de `report.service.ts` fue reemplazado por agrupación por `categoryId`. Grep confirma 0 ocurrencias. |
| "La identidad visible es ZULU Hub; Bastion no aparece" | **Ya resuelto** (migrado 23/08). Único resto: el nombre de archivo `appfrontend-main/docs/sistema-diseno-bastion.md` (interno, no visible). |
| Activar/desactivar módulos por negocio | **Ya existe**, con otro nombre: `ModuleKey` + tablas `modules`/`business_modules` (fail-closed), `requireModule()` en las rutas, `GET /api/business/modules` y `useBusinessModules()` en el nav. 6 módulos. |
| Monolito modular vs microservicios | **Ya es un ADR aceptado** (`arquitectura-monolito-modular.md` §2). La recomendación del enunciado coincide con la decisión vigente. No se reabre. |

**Lo que realmente falta es la mitad configurable del pedido, no la separación de
dominios.** El trabajo neto se concentra en cinco cosas que hoy no existen en ninguna
forma:

1. **Rubro (`industryKey`)** — no hay campo, ni tabla `industries`, ni presets.
2. **Terminología configurable** — no existe capa alguna: `terminology()` no existe, los
   textos están en JSX y en `email/templates.ts`.
3. **`GET /api/business/context`** — hay `/api/business/modules` y `/api/business/plan-limits`
   sueltos, sin un contexto unificado.
4. **Origen del valor y presets** — `business_modules` no tiene `source`; no hay cascada
   *system default → industry preset → tenant override*.
5. **Auditoría de plataforma** — `audit_log` vive **solo** en la BD de tenant. Los cambios
   de Superadmin (plan, status, `plan_limits`, `role_presets`) hoy **no dejan rastro**.

---

## 1. Corrección obligada a un criterio de aceptación del addendum

> "Superadmin puede crear y editar rubros sin modificar código." → **Sí, alcanzable.**
> "Superadmin puede asociar módulos y capacidades a cada rubro." → **Sí, alcanzable.**
> "El developer debe poder agregar **un nuevo rubro** … sin editar componentes de frontend." → **Sí.**

Pero: **agregar una capacidad/módulo NUEVO al catálogo seguirá requiriendo código**, y eso
no es deuda — es la misma decisión ya documentada para `permission_group` en
`platform.schema.sql` (BLOQUE ROLES):

> "agregar un grupo de permisos nuevo SIEMPRE implica código nuevo … Lo editable es la
> ASIGNACIÓN rol→grupo, no el catálogo de grupos en sí."

Una fila nueva en `modules` sin un `requireModule(ModuleKey.X)` que la lea, sin rutas y sin
pantalla es una casilla que no apaga ni prende nada. El catálogo es **descubrible y
asignable** por dato; el *comportamiento* de cada capacidad es código. La página de
Superadmin debe reflejar esto explícitamente: el ABM de capacidades es de **metadata**
(nombre visible, descripción, orden, plan mínimo, color contextual, estado), no de creación
de comportamiento. Se propone marcar cada fila con `implemented BOOLEAN` para que Superadmin
vea de un vistazo cuáles tienen código detrás.

Lo que **sí** queda 100% data-driven, sin deploy: rubros, presets, asignación
rubro→capacidad, terminología, overrides de tenant, color contextual y orden de navegación.

---

## 2. Ownership — matriz de dominios contra el código real

`business_id` no aparece en las tablas de tenant porque **cada negocio tiene su propia BD**
(branch de Neon). El aislamiento de tenant ya es de infraestructura, no de columna. Esto es
una diferencia real con el `PhysicalResource` del enunciado (que lleva `businessId`): acá es
implícito y **no debe agregarse**.

| Dominio (enunciado) | Carpeta real | Tablas propias (BD de tenant salvo aclaración) |
|---|---|---|
| Business Context | **no existe** → nuevo `src/business-context/` | `industries`, `platform_capabilities`, `industry_capabilities`, `terminology_defaults` (**BD de plataforma**); `business_modules` gana `source` (**plataforma**) |
| Catalog / Resources | `src/reservas/` (parcial) | `resource_categories`, `resources`, `bookable_services`, `service_schedules`, `resource_hours`, `locations` |
| Bookings / Availability | `src/reservas/` | `reservations`, `reservation_lines`, `resource_locks`, `occupancy_records`, `cancellation_policies`, `deposit_policies` |
| PMS / Stays | `src/pms-estadias/` | `stays` |
| CRM | `src/clientes-finanzas/` (parcial) | `customers`, `customer_contact_methods`, `customer_addresses`, `customer_tags`, `tags`, `customer_rates`, `customer_tax_profiles` |
| Commerce / POS | `src/pos-menu/` | `products`, `product_variants`, `orders`, `order_items`, `recipe_items`, `waste_reasons`, `consumption_destinations` |
| Inventario | ❌ **carve-out sin terminar** | `inventory_levels`, `stock_movements` (repos en `src/repositories/`, sin módulo propio) |
| Billing | `src/facturacion/` + `src/clientes-finanzas/` (parcial) | `invoices`, `invoice_items`, `invoice_charges`, `afip_tickets`, `financial_transactions`, `accounts_receivable`, `cash_register_shifts`, `billing_policies` |
| Operations | hoy dentro de `src/pms-estadias/` | `housekeeping_tasks`, `maintenance_windows` |
| Reports | `src/services/report.service.ts` | — (solo lectura) |
| IAM / Account | `src/usuarios-roles/` + `src/security/` + `src/platform/` | `identities`, `memberships`, `roles`, `role_permission_groups`, `role_presets`, `plan_limits`, `user_invitations`, `password_reset_tokens` (**plataforma**); `users` (tenant) |
| Integrations | ❌ no existe | — |

### 2.1 Tablas con ownership ambiguo (respuesta a la pregunta 2)

| Tabla | Ambigüedad | Resolución propuesta |
|---|---|---|
| `financial_transactions` | La escriben `order.service.ts` (POS), `reservation.service.ts` (señas) y `cash-register.service.ts`. Vive en `clientes-finanzas/` pero la usan 3 dominios. | Dueño = **Billing**. POS y Bookings dejan de instanciar el repositorio y pasan por una interfaz de aplicación (`BillingPort.registerPayment()`), o directamente por evento. Ya hay precedente: `registerFinancialHandlers` en el outbox. |
| `housekeeping_tasks` / `maintenance_windows` | Están en `pms-estadias/` pero conceptualmente son **Operations**, y las consume Bookings (guard de check-in, bloqueo de disponibilidad). | Dueño = **Operations**. Extraer `src/operations/` de `pms-estadias/`. Bookings las lee por *read model*, no por repositorio. |
| `inventory_levels` / `stock_movements` | Repos sueltos en `src/repositories/`, escritos desde el handler de outbox y desde `product.service.ts`. Carve-out abierto desde el 15/08. | Dueño = **Inventory** (submódulo de Commerce). Único escritor. Ya consume eventos — cerrarlo es terminar lo empezado. |
| `customer_rates` | Es CRM por identidad pero la lee Bookings para pricing. | Dueño = **CRM**. Bookings consume por interfaz de lectura (hoy ya la importa como `type`; falta el port explícito). |
| `deposit_policies` | Configuración de cobro (Billing) usada por pricing de reservas (Bookings). | Dueño = **Billing**. Nota: su CRUD todavía no existe (paso 10 del plan del 27/08) — la decisión de ownership entra ahí, no antes. |
| `business_profile` | Singleton que mezcla identidad, moneda/huso, horarios default, perfil fiscal AFIP, política de seña, prefijos de numeración y horizonte de mantenimiento. **6 dominios en una tabla.** | Se **mantiene como está** (partirla ahora es riesgo sin beneficio), pero se declara: es un *registro de configuración de tenant*, no un agregado. Business Context lo lee; nadie más lo escribe fuera de su propio service. |
| `users` (tenant) vs `identities`/`memberships` (plataforma) | Duplicación heredada. | Fuera de alcance de este plan. Anotar como deuda. |

### 2.2 Cruces de dominio que hoy son imports directos de repositorio

`reservation.service.ts` importa (como `type`, lo cual ya evita acoplamiento de
construcción, pero no de contrato):

```
../clientes-finanzas/customer-rate.repository.js          → CRM
../clientes-finanzas/financial-transaction.repository.js  → Billing
../pms-estadias/maintenance-window.repository.js          → Operations
../platform/operating-hours.repository.js                 → Business Context / Catalog
../repositories/business-profile.repository.js            → Business Context
```

`api/routes/customer.routes.ts` (portal público) toca seis dominios en un archivo — es la
costura natural de un BFF, no un bug. Se mantiene y se documenta como tal.

---

## 3. Dónde vive cada regla que hoy consulta `is_lodging` (pregunta 4)

Grep exhaustivo — solo 4 usos reales, todos legítimos y **ninguno** es "adivinar el rubro":

| Uso | Archivo | Dominio dueño |
|---|---|---|
| Bucket de tarifa de cliente (`ALOJAMIENTO`/`TURNOS`) | `clientes-finanzas/*customer-rate.repository.ts`, resuelto por `reservation-pricing.service.ts:87,233` | **CRM** decide el bucket; **Bookings** le pasa el `isLodging` ya resuelto. Correcto como está. |
| Bucket de política de seña | `reservas/*deposit-policy.repository.ts` | **Billing** (ver 2.1). Mismo patrón. |
| Filtro de listado Reservas vs Turnos | `reservation.repository.ts:19`, `in-memory.reservation.repository.ts:129` | **Bookings**. Es un filtro de consulta, no una regla de negocio. |
| "Alojamiento exige `serviceId`" (`LodgingRequiresServiceError`) | `reservation.service.ts:240` | **Bookings**. Invariante de dominio, se queda en código. ADR: `diseno-precio-servicio-vs-recurso-2026-08-27.md`. |

**Regla:** `is_lodging` es un atributo de **categoría de recurso**, no un rubro. Ninguna de
estas cuatro se mueve ni se convierte en `enabledModules.includes('PMS')`. Lo que sí se
conecta al Business Context es la **presencia de la pantalla** (Estadías ya está gateada por
`ModuleKey.ALOJAMIENTO`), no la regla de cálculo.

---

## 4. `BookableService` — qué controla (pregunta 5)

Estado real hoy: `bookable_services(category_id, name, booking_mode, duration_minutes, price)`
+ `rate_plans(service_id, name, valid_from, valid_to, EXCLUDE gist)` + `service_schedules`.

| Eje | Dueño hoy | Correcto | Acción |
|---|---|---|---|
| **Qué se vende** | `bookable_services.name` | ✅ | — |
| **Modalidad temporal** | `booking_mode` (`slot`/`block`/`event`) | ✅ | — |
| **Duración** | `duration_minutes` (obligatorio solo en `slot`) | ✅ | — |
| **Precio base** | `bookable_services.price` | ✅ (ADR 27/08: el precio vive en el servicio, no en el recurso) | — |
| **Precio por vigencia/temporada** | `rate_plans` | ✅ desde v43 | — |
| **Precio de recurso** | `resources.base_price` — columna viva que ya no debería mandar | ⚠️ | Declararla legado y dejar de leerla, o documentar por qué sigue. Ver pregunta abierta 5. |
| **Rate plans reutilizables** | ❌ `rate_plans.service_id` NOT NULL | 🟠 Deuda ya registrada (pendientes 28/08) | Aplicar el molde de `rate_catalog`. **No es parte de este plan** — se cruza, no se duplica. |
| **Disponibilidad** | `service_schedules` + `resource_hours` + `operating_hours` + `resource_locks` + `maintenance_windows` | ✅ pero repartido | Consolidar la lectura detrás de `ReservationAvailabilityService`, que ya es el punto único de entrada. |

**Conclusión:** `BookableService` controla precio, duración y modalidad. **No** controla
exclusividad (eso es `resource_categories.is_exclusive`) ni capacidad (`resources.capacity`).
Esa separación es la decisión del 28/08 y se preserva.

---

## 5. Business Context — modelo de datos

### 5.1 Dónde vive: BD de plataforma

Decisión: **todo el catálogo multirubro y los overrides de tenant van a la BD de plataforma**,
junto a `business_modules`. Motivos:

- `business_modules` ya vive ahí y ya se lee por request vía `container.getBusinessModules()`,
  **antes** de `tenantMiddleware`.
- Superadmin debe poder leer y escribir el contexto de N negocios sin abrir N conexiones a
  N branches de Neon.
- La cascada *system → industry → tenant* necesita el preset, que es global por definición.

Costo: `currency`/`timezone` viven en `business_profile` (BD de tenant). Por eso
`GET /api/business/context` se monta **después** de `tenantMiddleware` (necesita `req.db`),
a diferencia de `/api/business/modules`, que se queda donde está por compatibilidad.

### 5.2 Tablas nuevas (`platform.schema.sql`)

```sql
-- MAESTRO (criterios-datos.md): R1 código de negocio = key; R2/R3 deleted_at vs active.
industries (
  id, key UNIQUE, name, description, active, deleted_at, sort_order,
  created_at, updated_at
)

-- Catálogo. `implemented` = tiene código detrás (ver §1). `min_plan` = gating por plan.
platform_capabilities (
  id, key UNIQUE, name, description, active, deleted_at, implemented,
  min_plan, context_color, sort_order, created_at, updated_at
)

industry_capabilities (
  industry_id, capability_key, enabled_by_default, required, sort_order,
  PRIMARY KEY (industry_id, capability_key)
)

terminology_defaults (
  scope_type CHECK IN ('SYSTEM','INDUSTRY','TENANT'),
  scope_id,           -- NULL para SYSTEM
  term_key, locale, value, updated_at, updated_by,
  PRIMARY KEY (scope_type, scope_id, term_key, locale)
)
```

Cambios a tablas existentes:

```sql
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS industry_key VARCHAR(50)
  REFERENCES industries(key);            -- NULL = sin rubro asignado (negocios viejos)

ALTER TABLE business_modules ADD COLUMN IF NOT EXISTS source VARCHAR(20)
  NOT NULL DEFAULT 'SUPERADMIN' CHECK (source IN ('PRESET','SUPERADMIN','TENANT'));
ALTER TABLE business_modules ADD COLUMN IF NOT EXISTS updated_by VARCHAR(255);
```

> **Cuidado de deploy (lección del 28/08):** `platform.schema.sql` se reaplica entero en cada
> arranque. Un `CHECK` nuevo se agrega **editando el bloque existente in-place**, nunca
> dejando un segundo par `DROP CONSTRAINT`/`ADD CONSTRAINT` más abajo en el archivo.

`business_modules` **es** la tabla `tenant_capabilities` del enunciado. No se crea una
paralela: renombrar o duplicar rompería `requireModule()`, `getBusinessModules()`,
`createBusiness()` y el nav del frontend sin ganar nada.

`platform_capabilities` **es** la tabla `modules` existente, ampliada. Mismo criterio.

### 5.3 Cascada de resolución

```
capacidad efectiva(business, key) =
    business_modules(business, key)          si existe fila  → `source` dice de dónde vino
  → industry_capabilities(industry, key).enabled_by_default  si el negocio tiene rubro
  → FALSE                                                     (fail-closed, ya vigente)

término efectivo(business, key, locale) =
    terminology_defaults('TENANT',   business_id, key, locale)
  → terminology_defaults('INDUSTRY', industry_id, key, locale)
  → terminology_defaults('SYSTEM',   NULL,        key, locale)
  → la clave misma (nunca romper la pantalla por un término faltante)
```

**Un cambio de preset nunca pisa un override.** Se garantiza estructuralmente: aplicar un
preset escribe filas con `source='PRESET'` y **solo** sobre las que no existen o ya tienen
`source='PRESET'`. Nunca sobre `'TENANT'` ni `'SUPERADMIN'`. Se prueba con un test dedicado
antes de exponer la pantalla.

### 5.4 Contrato de `BusinessContext`

```ts
interface BusinessContext {
  businessId: string
  industryKey: string | null
  enabledModules: string[]                       // claves efectivas, ya resueltas
  moduleSources: Record<string, 'PRESET' | 'SUPERADMIN' | 'TENANT'>
  terminology: Record<string, string>            // ya resuelto por cascada
  locale: string
  currency: string                               // business_profile
  timezone: string                               // business_profile
  navigation: Array<{
    moduleKey: string
    label: string
    contextColor: 'BRASS' | 'CLAY' | 'SAGE' | 'NEUTRAL'
  }>
}
```

`theme.primaryContext` del enunciado se reemplaza por `contextColor` **por módulo**: la
identidad ZULU es monocromática y global; el color es una señal de contexto de módulo, no un
tema de negocio. Superadmin elige de un enum cerrado (`BRASS`/`CLAY`/`SAGE`/`NEUTRAL`), nunca
un color libre — el cian queda reservado al plano técnico y **no** es asignable.

---

## 6. Terminología — claves y alcance (pregunta 6)

Claves iniciales (estables, en inglés; el valor va en el locale del negocio):

```
resource.singular      resource.plural
reservation.singular   reservation.plural
customer.singular      customer.plural
service.singular       service.plural
staff.singular         staff.plural
stay.singular          stay.plural
location.singular      location.plural
```

**Tres consumidores, tres mecanismos — el sidebar es el más fácil de los tres:**

| Consumidor | Mecanismo | Riesgo |
|---|---|---|
| **UI** | `BusinessContextProvider` (React context) + `useTerminology()` → `t('resource.plural')`. Se carga una vez con el resto del contexto. | Bajo |
| **Emails** (`email/templates.ts`, disparados desde el outbox, **sin request**) | El worker ya resuelve `businessProfileRepo` por tenant (`registerEmailHandlers`). Se le inyecta un `TerminologyResolver` con la misma vida. | Medio: el worker corre fuera del ciclo de request, hay que pasarle `businessId` explícito |
| **Errores de API** (`domain/errors.ts`, ej. `LodgingRequiresServiceError`) | **No se traducen en el backend.** El backend ya devuelve `body.code` estable (`HTTP_CONTRACTS.md`); el frontend mapea `code` → mensaje con terminología resuelta. | Bajo, pero exige revisar los mensajes que hoy se muestran crudos |
| **Reportes** | Encabezados por terminología; los datos ya agrupan por `categoryId`. | Bajo |

**Regla:** ningún término se resuelve en el backend salvo en emails. Todo lo demás viaja como
clave y se resuelve en el borde. Así no hay que versionar mensajes traducidos en la API.

---

## 7. Presets de rubro por defecto (pregunta 8)

Contra las 6 capacidades que **hoy existen con código** (`ModuleKey`). El resto de la columna
"Módulos sugeridos" del enunciado (MENU, INVENTORY, TEAM, INTEGRATIONS) todavía no tiene
código — se cargan como filas con `implemented = FALSE`.

| Rubro (`key`) | REPORTES | HOUSEKEEPING | CUENTAS_CORRIENTES | POS_RESTAURANTE | FACTURACION | ALOJAMIENTO |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| `GENERIC` | ✔ | — | ✔ | — | ✔ | — |
| `HOSPITALITY` | ✔ | ✔ req. | ✔ | — | ✔ | ✔ **req.** |
| `RESTAURANTE` | ✔ | — | ✔ | ✔ **req.** | ✔ | — |
| `BARBERIA` | ✔ | — | — | — | ✔ | — |
| `SPA` | ✔ | — | — | — | ✔ | — |
| `SALUD` | ✔ | — | ✔ | — | ✔ | — |
| `DEPORTES` | ✔ | — | ✔ | — | ✔ | — |
| `SERVICIOS_PROF` | ✔ | — | ✔ | — | ✔ | — |

Terminología por rubro (extracto):

| Rubro | `resource.singular` | `reservation.singular` | `customer.singular` | `staff.singular` |
|---|---|---|---|---|
| `GENERIC` | Recurso | Reserva | Cliente | Personal |
| `HOSPITALITY` | Habitación | Reserva | Huésped | Personal |
| `RESTAURANTE` | Mesa | Reserva | Comensal | Mozo |
| `BARBERIA` | Silla | Turno | Cliente | Profesional |
| `SPA` | Box | Sesión | Cliente | Terapeuta |
| `SALUD` | Consultorio | Cita | Paciente | Profesional |
| `DEPORTES` | Cancha | Turno | Jugador | Entrenador |
| `SERVICIOS_PROF` | Espacio | Reunión | Cliente | Profesional |

**Cambio de comportamiento a confirmar con el dueño:** hoy `createBusiness()` habilita
`ALOJAMIENTO` por defecto para **todo** negocio nuevo. Con presets, un negocio de barbería
nacería sin `ALOJAMIENTO`. Es el cambio correcto, pero es un cambio de default — hay que
decidirlo explícitamente, no dejarlo pasar como efecto secundario.

---

## 8. Eventos — qué hay y qué falta (pregunta 7)

**Existen hoy: 8 emitidos.** `reservation.confirmed`, `reservation.cancelled`,
`reservation.completed`, `reservation.expired`, `reservation.price_adjusted`,
`order.confirmed`, `order.completed`, `order.cancelled`.

⚠️ `customer.created` aparece en el docblock de `domain-event.repository.ts` como si
existiera, pero **no lo emite nadie** (grep exhaustivo, 28/08/2026). CRM no publica
ningún evento todavía.

**Consumidores:** `registerFinancialHandlers`, `registerInventoryHandlers`,
`registerEmailHandlers`. Un `OutboxWorker` por tenant, arrancado bajo demanda desde
`tenantMiddleware`. Dead-letter con `retry_count`/`failed_at`/`last_error` (A9.5).

**Faltan (por dominio):**

```
PMS/Stays     StayCheckedIn, StayCheckedOut
Operations    ResourceBlocked, MaintenanceIncidentOpened, HousekeepingTaskCompleted
Billing       PaymentRegistered, InvoiceIssued
CRM           CustomerUpdated
Commerce      ProductPriceChanged
Platform      BusinessIndustryChanged, BusinessCapabilityChanged, TerminologyChanged
```

**Dos huecos estructurales del sobre del evento, no del catálogo:**

1. `domain_events` **no tiene** `event_id`, `correlation_id`, `causation_id` ni `version`.
   Tiene `id BIGSERIAL`, `business_id`, `aggregate_type`, `aggregate_id`, `event_type`,
   `payload`, `occurred_at`, `dispatched_at` (+ los 3 de dead-letter). Agregar las cuatro es
   `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (`version INT NOT NULL DEFAULT 1`, el resto
   nullable para las filas viejas).
2. **La idempotencia era una expectativa documentada, no un mecanismo — y ya estaba
   fallando.** Corrección a la primera redacción de este documento, que decía "hoy no
   duplica": **sí duplicaba**. Al revisar handler por handler:
   - financieros → idempotentes vía `idempotencyKey = "${event.id}:CHARGE"` + ON CONFLICT.
   - inventario → idempotentes vía insert-then-act sobre el casillero único de
     `stock_movements`.
   - **mail → nada**, y el propio `email.handlers.ts` lo decía: "un reintento del outbox
     por OTRO handler puede reenviar el mail".

   Como `reservation.confirmed` tiene **dos** consumidores (financiero + mail) y el worker
   los corre juntos con `Promise.all`, cada fallo del handler financiero reenviaba la
   confirmación de reserva al huésped. Bug vivo, no riesgo teórico.

---

## 9. Compatibilidad de endpoints (pregunta 3)

| Endpoint | Decisión |
|---|---|
| `GET /api/business/modules` | **Se mantiene tal cual.** Lo consume `useBusinessModules()` en 3 pantallas. Pasa a ser una vista derivada del contexto. |
| `GET /api/business/plan-limits` | Se mantiene. |
| `GET /api/business/context` | **Nuevo.** Se monta después de `tenantMiddleware`. |
| `GET/PATCH /api/business/terminology` | **Nuevo**, OWNER/ADMIN del tenant. |
| `PATCH /api/business/modules/:moduleKey` | **Nuevo**, OWNER/ADMIN, dentro de límites de plan y del `required` del rubro. Escribe `source='TENANT'`. |
| `/api/platform/*` del enunciado | ⚠️ **El prefijo real de Superadmin es `/platform/*`**, no `/api/platform/*` (`app.ts:213`, con `platformLimiter` y token de plataforma propio). Las rutas nuevas van bajo `/platform/*` para no partir el rate-limit ni la autorización. Migrar a `/api/platform/*` es una decisión aparte, con su propia migración de `platformFetch()`. |

Rutas nuevas de Superadmin (bajo `/platform`):

```
GET | POST      /platform/industries
PATCH           /platform/industries/:key
GET | PUT       /platform/industries/:key/capabilities
GET | PUT       /platform/industries/:key/terminology
GET | POST      /platform/capabilities
PATCH           /platform/capabilities/:key
GET             /platform/businesses/:id/context
PATCH           /platform/businesses/:id/industry
PATCH           /platform/businesses/:id/modules/:moduleKey
PATCH           /platform/businesses/:id/terminology/:termKey
POST            /platform/businesses/:id/apply-preset    -- idempotente, no pisa overrides
```

**Ninguna ruta existente cambia de forma ni se elimina en este plan.**

---

## 10. Auditoría (criterio 9 del addendum) — gap real

`audit_log` está **solo** en `schema.sql` (BD de tenant). `platform.schema.sql` no tiene
ninguna tabla de auditoría: los cambios de plan, estado, `plan_limits` y `role_presets` que
hace Superadmin hoy no dejan rastro de quién ni cuándo.

Propuesta: `platform_audit_log` en la BD de plataforma, con la **misma forma** que `audit_log`
(`entity`, `entity_id`, `field`, `old_value`, `new_value`, `changed_by`, `changed_at`) más
`business_id` nullable, para poder reusar `domain/audit.ts::diffFields()` y
`recordFieldChanges()` sin inventar un segundo modelo — mismo criterio que el playbook
`conocimiento/playbook-audit-log-transaccional.md` ("no crear una tabla paralela ante un
handoff externo que la desconozca").

Alcance mínimo para cerrar el criterio: rubro, capacidades, presets, terminología, plan y
estado de negocio. Retro-cubrir `plan_limits`/`role_presets` en el mismo cambio, porque es la
misma tabla y el mismo helper.

---

## 11. Dependencias — cómo se hace cumplir, no solo declarar

Declarar reglas sin cerca eléctrica es cómo se degrada la estructura. `dependency-cruiser` ya
está en el repo (`.dependency-cruiser.cjs`) con 3 reglas genéricas (`no-circular`,
`no-orphans`, `not-to-unresolvable`) y corre limpio. **Se agregan reglas de dominio:**

```js
// forbidden — una regla por cruce prohibido, severity 'error'
{ name: 'pos-no-lee-repos-de-reservas',
  from: { path: '^src/pos-menu/' },
  to:   { path: '^src/reservas/.*\\.repository\\.ts$' } },

{ name: 'crm-no-escribe-orders',
  from: { path: '^src/clientes-finanzas/' },
  to:   { path: '^src/pos-menu/.*\\.repository\\.ts$' } },

{ name: 'domain-sin-express-ni-sql',
  from: { path: '^src/(reservas|pos-menu|pms-estadias|clientes-finanzas)/.*\\.(entities|types)\\.ts$' },
  to:   { dependencyTypes: ['npm'], path: '^(express|pg)$' } },

{ name: 'business-context-no-toca-transaccional',
  from: { path: '^src/business-context/' },
  to:   { path: '^src/(reservas|pos-menu|facturacion|pms-estadias)/' } },
```

Se agrega `npm run lint:arch` (dependency-cruiser con esta config) al mismo lugar donde ya
corren `tsc` y `eslint`. Una regla que no corre en CI no es una regla.

**Reports** queda explícitamente fuera de la lista de prohibiciones: es cross-cutting a
propósito (lee de todos los dominios, no escribe en ninguno) — ya está documentado así en
`arquitectura-monolito-modular.md` §4.

---

## 12. Fases

Cada fase termina con: `tsc --noEmit` limpio, suite completa verde, `lint:arch` sin
violaciones nuevas, y verificación **contra la base, no contra la pantalla**. PRs chicos y
reversibles. Ninguna fase deja endpoints rotos.

| Fase | Qué | Entregable | Riesgo | Rollback |
|---|---|---|---|---|
| **0** ✅ | Cerca eléctrica: reglas de dominio en `.dependency-cruiser.cjs` + `lint:arch` en CI. **Sin mover un archivo.** | 6 reglas, las 5 aplicables verificadas contra violaciones de prueba. 0 violaciones reales | 🟢 | Revertir el `.cjs` |
| **1** ✅ | Sobre del evento: 4 columnas nuevas en `domain_events` + `processed_events`. Emisores rellenan `event_id`/`version`; consumidores chequean `processed_events`. | Schema v44. Bug de mail duplicado cerrado. A10.4 implementado | 🟡 | Columnas aditivas; filas viejas quedan con NULL |
| **2** ✅ | `platform_audit_log` + auditoría transaccional en las 4 mutaciones de Superadmin existentes. `modules.active`/`implemented` | Criterio 9 cubierto antes de agregar superficie nueva | 🟢 | Tabla nueva, nadie la lee todavía |
| **3** | Modelo de Business Context: 4 tablas nuevas + `businesses.industry_key` + `business_modules.source`. **Seed de 7 rubros y de los 6 módulos existentes.** Sin API ni UI. | Migración aplicada, datos de `biz-demo-01` intactos | 🟡 | `source` tiene DEFAULT; `industry_key` nullable — ignorar las columnas alcanza |
| **4** | `src/business-context/` — resolución de cascada + `GET /api/business/context`. `getBusinessModules()` delega en el resolver (**mismo contrato de salida**). Cache por proceso con TTL corto: hoy cada `requireModule()` pega a la BD de plataforma sin cache. | Endpoint nuevo + `/api/business/modules` sin cambios visibles | 🟠 | El resolver cae a la consulta directa si falla |
| **5** | Superadmin: pestaña **Configuración de plataforma** (Rubros, Capacidades, Presets) + pestaña **Contexto** en el detalle de negocio, con el origen visible por fila | Superadmin crea un rubro y un preset sin deploy | 🟢 | Pantallas nuevas |
| **6** | Terminología: `terminology_defaults` poblado, `BusinessContextProvider` + `useTerminology()` en el frontend, resolver en el worker de emails | Cambiar "Habitación"→"Silla" desde Superadmin cambia la UI | 🟠 | El resolver cae a la clave / valor de sistema |
| **7** | Onboarding: alta de negocio elige rubro → aplica preset (`source='PRESET'`). Cambia el default actual de `ALOJAMIENTO` siempre encendido. | Alta de negocio multirubro | 🟡 | Feature flag hasta validar |
| **8** | Extracción de `src/operations/` desde `pms-estadias/` + cierre del carve-out de Inventario. Ports explícitos para los 5 cruces de `reservation.service.ts`. | Reglas de la Fase 0 en verde sin excepciones | 🟠 | `git mv` reversible; uno por uno con `tsc` entre medio |
| **9** | Validación multirubro: los 5 presets mínimos, matriz de permisos, textos, navegación y disponibilidad | Matriz de aceptación firmada | 🟢 | — |

**Las fases 0–2 no tocan nada de multirubro y se pueden empezar sin más decisiones.** La
fase 3 en adelante necesita el OK de las preguntas abiertas de §14.

---

## 13. Cómo se prueba que una barbería no ve Housekeeping (pregunta 9)

Tres capas, ninguna sustituye a la otra:

1. **Backend, test de integración por preset.** Fixture que crea un negocio con
   `industry_key='BARBERIA'`, aplica el preset y verifica que `GET /api/business/context`
   devuelve `enabledModules` sin `HOUSEKEEPING`, y que `GET /api/housekeeping` responde
   **402 `MODULE_NOT_ENABLED`**. Mismo test con `HOTELERIA` esperando 200. Esta es la prueba
   que vale: el gate real es el backend.
2. **Frontend, test del nav.** `useBusinessContext()` mockeado con cada preset → el item
   "Housekeeping" no se renderiza. Se mantiene el criterio actual (`modules[key] !== false`:
   no oculta mientras carga, a propósito).
3. **Verificación manual contra la base.** Con la restricción registrada el 28/08: el agente
   no puede hacer login. El click lo corre el dueño; el agente confirma por SQL de solo
   lectura contra Neon.

Matriz mínima de Fase 9: 5 rubros × (nav visible, 402 esperados, terminología de 5 claves,
alta de categoría/servicio, disponibilidad de una reserva del rubro) = 25 casos.

---

## 14. Las siete decisiones — estado al 28/08/2026

Cuatro cerradas por el dueño el 28/08/2026, tres todavía abiertas. **Las tres abiertas
bloquean la Fase 3**, no las Fases 0–2 (ya ejecutadas).

### ✅ Decidido — D1. Default de `ALOJAMIENTO` al crear un negocio

> "Los negocios nuevos deben nacer según un preset del rubro elegido. No deben recibir
> `ALOJAMIENTO` por defecto salvo que el preset sea `HOSPITALITY`."

Cambia `PlatformRepository.createBusiness()`, que hoy prende `ALOJAMIENTO` para todos.
Abría una pregunta nueva: **un negocio dado de alta sin rubro** (el flujo de hoy) no tiene
preset del cual derivar módulos y, con el fail-closed vigente, nacería sin ninguno.
Resuelta en la misma sesión con el preset `GENERIC` — ver abajo.

**Nota de nomenclatura:** el dueño escribió `HOSPITALITY` (inglés); `ModuleKey` usa claves en
castellano (`ALOJAMIENTO`, `POS_RESTAURANTE`). Se adopta `HOSPITALITY` como clave de rubro y
se deja la inconsistencia anotada — `industries.key` y `modules.module_key` son catálogos
distintos y no tienen por qué compartir idioma, pero conviene decidirlo una vez y no fila
por fila.

**Preset `GENERIC` — resuelto el 28/08/2026:**

> "Si no se selecciona rubro, debe existir un preset `GENERIC` para evitar que el tenant
> nazca sin módulos."

Cierra el agujero que abría D1: con el fail-closed vigente, un negocio dado de alta sin
rubro nacería sin ninguna capacidad. `GENERIC` es una fila más de `industries`, no un caso
especial del código, y su preset es el mínimo común a todos los rubros de la tabla de §7 —
lo que ningún negocio deja de necesitar:

| `GENERIC` | REPORTES | HOUSEKEEPING | CUENTAS_CORRIENTES | POS_RESTAURANTE | FACTURACION | ALOJAMIENTO |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| | ✔ | — | ✔ | — | ✔ | — |

Terminología `GENERIC` = los valores del scope `SYSTEM` (recurso / reserva / cliente /
servicio / personal). Sin `required` en ninguna capacidad: un negocio genérico puede apagar
todo lo que quiera.

`businesses.industry_key` se mantiene **nullable** igual, para los negocios que ya existen:
`NULL` ≠ `'GENERIC'`. `NULL` es "nunca se le preguntó" (negocios anteriores a la Fase 3, que
conservan los módulos que ya tenían); `GENERIC` es "se le preguntó y no eligió rubro". Que
un negocio viejo pase a `GENERIC` es una decisión de migración de datos aparte, no un
efecto secundario del deploy.

### ✅ Decidido — D2. Quién edita la terminología

> "El tenant puede editar su propia terminología dentro de las claves y límites definidos por
> Superadmin. Superadmin administra las claves y presets; el tenant administra sus overrides."

`terminology_defaults` con `scope_type='TENANT'` se escribe desde `/api/business/terminology`
(OWNER/ADMIN), y solo para `term_key` que ya existan en el scope `SYSTEM`. Un tenant no
inventa claves nuevas: inventar una clave es cambiar qué texto muestra una pantalla, y eso es
código. Toda escritura queda auditada.

### ✅ Decidido — D3. `resources.base_price`

> "Se mantiene temporalmente por compatibilidad histórica, pero `BookableService.price` será
> la fuente principal para nuevas reservas cuando exista un servicio. No usar fallback
> silencioso para alojamiento. Antes de eliminar `base_price`, presentar inventario de
> consumidores y plan de migración."

Consistente con lo que ya hace el código: `LodgingRequiresServiceError` (422) rechaza una
reserva de alojamiento sin `serviceId` — no hay fallback silencioso hoy. La columna se queda;
**no se borra en este plan**. El inventario de consumidores + plan de migración es un
entregable aparte, a pedir explícitamente.

### ✅ Decidido — D4. Prefijo de las rutas de Superadmin

> "Deben conservar el prefijo real `/platform/*`; no cambiar a `/api/platform/*` sin una
> decisión de compatibilidad separada."

Las rutas nuevas de la Fase 3 (§9) van bajo `/platform/*`.

### ✅ Decidido — D5. Cambio de rubro de un tenant

> "El tenant no debe cambiar libremente su rubro. Superadmin podrá iniciar el cambio con
> preview de consecuencias y confirmación explícita. El cambio no debe borrar
> automáticamente módulos, overrides, categorías, reservas ni estadías."

`PATCH /platform/businesses/:id/industry` pasa a ser **dos endpoints**, no uno:

```
GET   /platform/businesses/:id/industry-change-preview?industryKey=BARBERIA
PATCH /platform/businesses/:id/industry     -- exige confirmación explícita
```

El preview calcula y devuelve, sin escribir nada:

| Qué muestra | De dónde sale |
|---|---|
| Módulos que el preset nuevo sugiere y hoy están apagados | `industry_capabilities` vs `business_modules` |
| Módulos activos hoy que el preset nuevo **no** sugiere | ídem — se listan, **no se apagan** |
| Overrides de terminología que quedarían "huérfanos" respecto del preset nuevo | `terminology_defaults` scope TENANT |
| Datos operativos que el rubro nuevo no contempla: categorías con `is_lodging=true`, estadías abiertas, reservas futuras | tenant DB |

**Regla dura, verificable con test:** aplicar un cambio de rubro **solo** escribe
`businesses.industry_key` y, a lo sumo, agrega filas `business_modules` con
`source='PRESET'` para módulos que no tenían fila. **Nunca** hace `UPDATE ... SET
enabled=false`, nunca borra overrides, y nunca toca la BD del tenant. Un negocio que estuvo
en hotelería y pasa a barbería conserva sus estadías y su historial — dejan de estar en el
camino sugerido, no dejan de existir.

### ✅ Decidido — D6. `locale`

> "Agregar `locale` ahora, pero mantener el producto en `es-AR` sin abrir todavía una
> implementación completa de i18n."

`terminology_defaults.locale` va en la PK desde el día uno (evita migrar con datos
cargados). El resolver de la Fase 6 hace **una sola pasada** con `locale='es-AR'` fijo: sin
selector de idioma, sin fallback entre locales, sin traducción del producto. `BusinessContext.locale`
se expone con ese valor constante.

### ✅ Decidido — D7. Reconstrucción visual como corriente formal

> "Convertir la reconstrucción visual de Superadmin en una fase formal. El panel debe usar
> los tokens de ZULU Hub y la misma identidad monocromática que el dashboard del tenant.
> […] el plan visual existente debe formar parte del plan activo, con entregables y
> criterios de aceptación propios."

**Mi recomendación anterior ("ítem aparte, es UI pura, no bloquea nada") estaba mal, y por
una razón concreta que apareció al medir el código:** los tokens ZULU que hay hoy **no son**
los de la especificación. Ver §16 y
`appfrontend-main/docs/sistema-diseno-zulu-hub.md` §1.

Se incorpora como corriente propia: Fases **V1–V6**, §16.

### Confirmaciones del dueño que no eran preguntas abiertas

- **`implemented`** (D5 del mensaje del dueño): "debe distinguir una capacidad catalogada de
  una capacidad realmente soportada por código, rutas, permisos y UI". Es exactamente §1 de
  este documento. Implementado en la Fase 2.
- **`PhysicalResource` sin `businessId`**: confirmado, el aislamiento es por BD de tenant
  (§2).
- **La página existente de Superadmin** es el lugar donde viven rubros, capacidades, presets,
  terminología, identidad contextual y configuración efectiva de tenants — no una
  administración paralela (Fase 5).

---

## 15. Qué NO se hace en este plan

- **No se crean microservicios.** ADR vigente: `arquitectura-monolito-modular.md` §2.
- **No se unifican `is_lodging`/`is_exclusive`/`booking_mode`.** ADR del 28/08.
- **No se reescribe `business_profile`** ni se parten sus 6 responsabilidades.
- **No se resuelve la deuda de `rate_plans` reutilizables** (pendientes 28/08) — se cruza, no
  se duplica.
- **No se toca `users` (tenant) vs `identities`/`memberships` (plataforma).**
- **No se renombran `modules`→`platform_capabilities` ni `business_modules`→`tenant_capabilities`**
  en la base. Se amplían en su lugar.

---

## 16. Corriente visual — Fases V1–V6 (D7)

**Especificación normativa completa:**
[`appfrontend-main/docs/sistema-diseno-zulu-hub.md`](../../appfrontend-main/docs/sistema-diseno-zulu-hub.md).
Acá va solo cómo se cruza con las fases de backend y qué hay que resolver antes de arrancar.

### 16.1 El hallazgo que cambió el alcance de D7

Mi recomendación anterior — "ítem aparte, es UI pura, no bloquea nada" — partía de un
supuesto equivocado: que el dashboard ya usaba los tokens de la especificación y solo
faltaba aplicarlos a Superadmin. **No es así.** Medido sobre `globals.css` el 28/08/2026, el
sistema ZULU que hay hoy es **navy oscuro + cian neón**, y su propio comentario
(`globals.css:645-656`, guía del 23/08 también aportada por el dueño) dice explícitamente lo
contrario de esta especificación en los tres ejes:

| Eje | ZULU del 23/08 (implementado) | Especificación del 28/08 |
|---|---|---|
| Base | Navy `#060a1f` | Blanco / blanco cálido, negro para el shell |
| Acento primario | Cian `#00e0ff`, único para todo el dashboard | Cian restringido al plano técnico |
| Color por módulo | **No existe** — *"a diferencia de Bastión (brass/clay por módulo) acá no hay modificador de color por vertical"* | Brass reservas / clay comercio — el mecanismo de Bastión |

La especificación **restaura el mecanismo de color de Bastión bajo nomenclatura ZULU** e
invierte la polaridad de oscuro a claro. Es un reemplazo del sistema de tokens, no una
extensión. El dueño lo reafirmó con el enunciado completo el 28/08 — se ejecuta, y queda
registrado que fue deliberado.

### 16.2 Tamaño real, medido

53 páginas/layouts · 34 con scope `.zulu` · **53 usos de `var(--accent)` en 31 archivos**
(cada uno es una decisión de contexto: brass, clay, sage, neutro o técnico) · 20 usos del
acento dentro de las propias primitives · 21 hex hardcodeados en 10 archivos · 69 clases
Tailwind de color crudas, concentradas en Superadmin.

`brass`/`clay`/`sage` **no existen** como colores hoy. Lo que sí existe son dos alias
engañosos: `.btn-mini-clay → var(--danger)` (rojo) y `.btn-mini-sage → var(--success)`.
Repintarlos sin revisar call sites convertiría botones "Eliminar" en botones de contexto
comercio — que sería violar el criterio 15 de la propia especificación.

### 16.3 Fases y sus dependencias con el backend

| Fase visual | Depende de | Puede arrancar |
|---|---|---|
| **V1 — Auditoría** | nada del backend | ya (medición de §16.2 es su insumo) |
| **V2 — Tokens y primitives** | nada del backend | tras V1 |
| **V3 — App shell** | **Fase 4** (`GET /api/business/context`) para el sidebar dinámico | tras V2 + Fase 4 |
| **V4 — Flujos principales** | V3 | — |
| **V5 — Superadmin** | **Fase 5** (las pantallas de rubros/capacidades/presets tienen que existir) | tras V3 + Fase 5 |
| **V6 — Cobertura restante** | V4 | — |

**V1 y V2 corren en paralelo a la Fase 3** — no tocan backend. V3 y V5 sí esperan: un
sidebar dinámico sin `BusinessContext` sería una lista hardcodeada más (criterio 3), y no se
puede pintar una pantalla de Superadmin que todavía no existe.

### 16.4 Bloqueantes de la Fase V2 — cerrados el 28/08/2026

Los tres que había quedaron resueltos en la misma sesión, con medición en vez de criterio:

| Bloqueante | Cierre |
|---|---|
| Faltaba `zulu-hub-sketch.html` | **Creado**: `appfrontend-main/docs/zulu-hub-sketch.html`, HTML autocontenido derivado de la especificación. Declara explícitamente que **no es el boceto original** del dueño (que no estaba en ningún repo); si aparece, lo reemplaza |
| Faltaba `clay-strong` | **`#944E37`**, confirmado. 6.17 blanco / 5.60 warm-white / 4.72 sobre clay-soft |
| Faltaba el rojo destructivo | **`#B42318`**, confirmado. 6.57 / 5.97 — AA texto en los dos. Y **ΔE 28.3 contra clay** (>25 = "claramente distinto"): la preocupación de que "eliminar" y "comercio" se parecieran queda descartada con medición, no a ojo |

**Cuatro reglas de contraste, a codificar en las primitives (no solo a documentar):**

1. El color de **texto** es siempre `*-strong`. `brass` sobre blanco da 3.16 y sobre
   warm-white **2.87** — no alcanza ni para bordes.
2. Sobre cualquier superficie `*-soft`, el texto es **`--zulu-black`** (14.5–15.6).
   Confirmado por el dueño; la medición explica por qué la regla uniforme conviene: el par
   `sage-strong`/`sage-soft` da 4.24 y se queda a 0.26 de AA, mientras brass y clay sí
   pasarían.
3. **`cyan-technical` nunca sobre blanco** (2.05). Para superficie clara se agrega
   **`--zulu-cyan-deep #1F6D77`** (5.98), la "variante oscura específica" que pidió el dueño.
4. El destructivo es **independiente de clay**, con token propio.

Tabla completa en la especificación §4.3.

### 16.5 Evidencia por PR (criterio 14)

El criterio pide screenshots de cada pantalla modificada. El agente **no puede hacer login**
(restricción registrada el 28/08). Los screenshots detrás de autenticación los produce el
dueño, o el agente sobre una sesión que el dueño abra. Hay que contemplarlo al planificar
cada PR visual, no descubrirlo al cerrarlo.
