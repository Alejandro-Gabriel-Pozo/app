# Arquitectura — monolito modular vs. microservicios

> Traído por el dueño el 15/08/2026: "fuimos meticulosos en la
> modularidad, pero no en pensar una arquitectura integrada por API
> (microservicios)". No es una hoja de ruta de implementación — es una
> reflexión de arquitectura, documentada con evidencia real del código
> (análisis con `dependency-cruiser`, ya instalado en el repo), no una
> opinión abstracta.

## 1. Qué es esto hoy, dicho explícitamente

`app-main` es un **monolito modular**, no microservicios — nunca se
decidió explícitamente así, pero es lo que hay: un solo proceso Express,
un solo deploy, un solo repo. La modularidad que sí se construyó
(`ModuleKey`/`business_modules`, los 6 módulos gateados — ver memoria
"Modular add-on pricing architecture") es **a nivel de feature flag
dentro del mismo proceso**, no a nivel de servicios independientes con
API entre ellos. Un negocio con el módulo `POS_RESTAURANTE` apagado
sigue corriendo el mismo binario que uno con todo prendido — solo se le
ocultan rutas/UI.

**Aislamiento real que sí existe, por otro eje:** cada tenant tiene su
propia base de datos Postgres (branch de Neon, ver
`docs/pendientes-2026-08-15.md` sección B1) — eso es aislamiento de
*datos* a nivel de infraestructura, lo que mucha gente busca resolver
con microservicios (un servicio por cliente) ya está resuelto acá de
otra forma, más barata de operar.

## 2. Recomendación: no migrar ahora

Con un solo tenant real y un equipo de una persona (+ IA), microservicios
cambiarían velocidad de desarrollo por escalabilidad que todavía no hace
falta. Evidencia concreta de esta sesión: aprovisionamiento automático +
panel de superadmin + fix de un bug de auth crítico, todo en una sola
sesión — posible porque es un solo deploy, no tres servicios coordinados
con sus propios pipelines, versionado de API entre ellos, y monitoreo
separado.

**Condiciones que ameritarían revisar esto** (ninguna se da hoy):
- Un módulo con necesidades de escala muy distintas al resto (ej. un
  motor de reportes pesado que satura el proceso mientras el resto anda
  liviano).
- Necesidad de que un módulo lo posea/despliegue un equipo distinto,
  con su propio ritmo de releases.
- Un módulo que necesite un stack tecnológico distinto (ej. Python para
  ML) que no tiene sentido correr en el mismo proceso Node.
- Requisito de compliance que exija aislamiento más fuerte que
  BD-por-tenant (ya cubre la mayoría de los casos de "no me mezcles con
  otro cliente").

## 3. Auditoría de límites internos (15/08/2026)

Antes de migrar nunca sirve mirar el código a ojo — se corrió
`dependency-cruiser` (ya configurado en `.dependency-cruiser.cjs`) sobre
todo `src/`, agrupando archivos en dominios de negocio inferidos por
nombre (reservas, pos-productos, pms-estadías, clientes-finanzas,
usuarios-roles, plataforma, catálogo-config, reportes) y contando los
imports que cruzan de un dominio a otro. Objetivo: si el día de mañana
hay una razón real para separar un dominio en su propio servicio, ¿qué
tan fácil sería?

### Buena noticia — la mayoría del acoplamiento es legítimo, no un leak

Los cruces con más volumen no son código mal ubicado, son relaciones de
dominio reales:
- `reservas ↔ catalogo-config` (recursos/categorías/horarios): una
  reserva **es** de un recurso, que **pertenece** a una categoría. No
  hay forma sensata de separar esto sin fusionarlos de vuelta en la
  práctica.
- `reservas ↔ clientes-finanzas` (tarifas especiales del cliente): una
  reserva necesita saber si el cliente tiene una tarifa propia.
- `pms-estadías ↔ reservas` (una Estadía nace de una Reserva, vía
  check-in) y `pms-estadías ↔ clientes-finanzas` (una Estadía genera
  cargos en cuenta corriente): ambos son el flujo de negocio real, no
  acoplamiento accidental.
- `pos-productos → clientes-finanzas` (`order.service.ts` →
  `financial-transaction.repository.ts`): una orden confirmada genera un
  movimiento financiero — es la integración que se construyó a propósito
  en la sesión de caja/turno (14/08).

La mayoría de los cruces con `usuarios-roles`/`plataforma` son
infraestructura transversal (`auth.middleware.ts`, `roles.ts`,
`tenant.middleware.ts`) — **todas** las rutas necesitan autenticación y
resolución de tenant, eso no es un dominio que se pueda separar, es la
espina dorsal del multi-tenant.

### El hallazgo real — un punto concreto para empezar el día que haga falta

`customer.routes.ts` (la API pública del portal de clientes) importa de
**seis dominios distintos** en un solo archivo — reservas, catálogo,
clientes, plataforma, PMS, reportes indirectamente. Es esperable: es el
backend del portal público, tiene que exponer un poco de todo. **Si
algún día se separa en microservicios, este archivo es exactamente donde
aparecería un API Gateway / Backend-for-Frontend** — no es un problema a
resolver hoy, es la costura natural.

Más puntual y sí accionable si algún día se encara una separación:
`reservation.service.ts` importa **directo las clases de repositorio**
de otros dominios (`category.repository`, `customer-rate.repository`,
`housekeeping.repository`, `operating-hours.repository`,
`resource.repository`) en vez de pasar por la capa de servicio pública
de esos dominios. Hoy es igual de válido (todo corre en el mismo
proceso, no hay costo de red) — pero es la diferencia entre "leer datos
de otro módulo en memoria" y "llamar a la API pública de otro módulo".
Si `reservas` alguna vez se separa como servicio propio, este es el
primer lugar a mirar — no antes.

### No auditado hoy
El análisis fue por convención de nombres de archivo (heurística, no
perfecta) — no revisó exhaustivamente cada import línea por línea, ni
generó el gráfico visual (necesita Graphviz, ya documentado como fuera
de alcance en C8, `pendientes-2026-08-14.md`). Alcanza para la pregunta
que se estaba respondiendo ("¿está todo mezclado sin criterio, o hay una
estructura de dominio real debajo?") — la respuesta es que sí hay una
estructura real, solo que vive dentro de un solo proceso.

## 4. Plan de reorganización por dominio (15/08/2026, solo diseño — no ejecutado)

Confirmado con el dueño (ver sección 3): la separación lógica entre
dominios ya existe en buena parte por disciplina (`order.service.ts` y
`reservation.service.ts` no se importan entre sí, por ejemplo), pero
`src/` está organizado por **capa técnica** (`services/`, `repositories/`,
`api/routes/`, todos mezclando los dominios) en vez de por **bounded
context** (DDD). Esto documenta cómo se vería la reorganización — mapeo
archivo por archivo — sin ejecutarla todavía.

### Contextos propuestos y qué archivo va en cada uno

**`reservas/`** — el núcleo compartido entre rubros (ver
`docs/roadmap-pms-multirubro.md`): fechas, disponibilidad, recursos,
categorías.
- Services: `reservation.service.ts`, `resource-lock.service.ts`,
  `bookable-service.service.ts`, `category.service.ts`
- Repositories: `reservation.repository.ts` (+ `sql.`/`in-memory.`),
  `resource.repository.ts` (+ variantes), `resource-lock.repository.ts`
  (+ variantes), `bookable-service.repository.ts` (+ variantes),
  `category.repository.ts` (+ variantes), `occupancy.repository.ts` (+
  variantes; `supabase.occupancy.repository.ts` es scaffolding
  abandonado — candidato a borrar en vez de mover, ver C8 en
  `pendientes-2026-08-14.md`)
- Routes: `reservations.routes.ts`, `resources.routes.ts`,
  `bookable-services.routes.ts`, `categories.routes.ts`
- Domain: `Reservation.ts`, `availability.ts`, `reservation.types.ts`, y
  **la parte de `entities.ts` que es `PhysicalResource`/`BookableService`**
  (ver "archivos a partir primero" abajo)

**`pms-estadias/`** — específico de alojamiento (no todos los rubros lo
usan).
- Services: `stay.service.ts`, `housekeeping.service.ts`
- Repositories: `stay.repository.ts`, `housekeeping.repository.ts` (+
  variante)
- Routes: `stays.routes.ts`, `housekeeping.routes.ts`
- Domain: `stay.ts`, `housekeeping-task.ts`

**`pos-menu/`** — punto de venta, específico de gastronomía/retail.
- Services: `order.service.ts`, `product.service.ts`
- Repositories: `order.repository.ts` (+ variantes), `product.repository.ts`
  (+ variante sql)
- Routes: `orders.routes.ts`, `products.routes.ts`
- Domain: `order.entities.ts`, `product.entities.ts`

**`inventario/`** — ❌ **no existe como módulo separado hoy.** `stockQuantity`/
`stockMinAlert` son campos sueltos dentro de `product.entities.ts`, y el
decremento de stock (`ProductRepository.decrementStock`) existe pero
nunca se llama (E7a). Carve-out real, no solo mover archivos: decidir si
Inventario pasa a ser su propio agregado (tabla/repositorio propio que
referencia `product_id`) con su propio service que es el único que
escribe stock, escuchando `order.completed` vía el outbox — es más
consistente con "recibe eventos, recalcula stock" que dejarlo como
métodos sueltos en `ProductRepository`. Esto es exactamente lo que se
resolvería primero si se retoma la opción 1 (enganchar el handler).

**`clientes-finanzas/`** — CRM, cuenta corriente, caja.
- Services: `accounts-receivable.service.ts`, `customer-account.service.ts`,
  `cash-register.service.ts`
- Repositories: `accounts-receivable.repository.ts` (+ sql),
  `customer.repository.ts` (+ variantes), `customer-rate.repository.ts`
  (+ variantes), `financial-transaction.repository.ts` (+ sql),
  `cash-register-shift.repository.ts` (+ sql)
- Routes: `customers.routes.ts` (CRM interno), `cash-register.routes.ts`
- Domain: **la parte de `entities.ts` que es `Customer`/`ContactMethod`**

**`usuarios-roles/`** — staff, auth, RBAC.
- Services: `role.service.ts`
- Routes: `roles.routes.ts`, `users.routes.ts`, `auth.routes.ts`,
  `me.routes.ts`
- Security: `auth.middleware.ts`, `auth.service.ts`, `roles.ts`,
  `user.store.ts`, `user.types.ts`, `module.middleware.ts`

**`plataforma/`** — multi-tenant, superadmin, aprovisionamiento. Ya está
bastante bien aislado hoy (carpeta `platform/` propia) — el que menos
trabajo daría.
- Todo `platform/*` ya vive junto.
- Routes: `business.routes.ts`, `business-hours.routes.ts`,
  `business-modules.routes.ts`, `platform.routes.ts`, `admin.routes.ts`
- Repositories de config de negocio (¿quedan acá o en su propio
  `catalogo-config/`? — decisión abierta): `location.repository.ts` (+
  variantes), `operating-hours.repository.ts` (+ variantes)
- Security: `platform.auth.middleware.ts`, `platform.auth.service.ts`

**`reportes/`** — naturalmente cross-cutting (lee de todos los demás),
no es un dominio de escritura. Se queda como "read model" que importa
de los demás a propósito — no tiene sentido forzarlo a no depender de
nadie.
- `report.service.ts`, `reports.routes.ts`

**`portal-cliente/`** (BFF) — hoy `customer.routes.ts` toca seis
dominios en un archivo (hallazgo de la sección 3). Si se reorganiza,
este archivo pasaría a ser un agregador delgado que llama a los
services de `reservas`/`pos-menu`/`clientes-finanzas` en vez de
importar sus repositorios directo — es el punto exacto donde hoy se ve
más el costo de no tener bounded contexts explícitos.
- Routes: `customer.routes.ts`
- Security: `customer.auth.service.ts`

**Infraestructura compartida (kernel) — no pertenece a ningún dominio,
se queda en la raíz de `src/`:** `workers/*` (outbox — lo usan todos los
dominios que emiten eventos), `domain-event.repository.ts` (+ sql),
`audit-log.repository.ts` (+ in-memory) + `audit-log.routes.ts` +
`audit.ts`, `sql.client.ts`, `db/*` (transaction managers, pg client,
tenant-context), `container.ts`, `app.ts`, `server.ts`, `enums.ts`.

### Archivos a partir primero (bloquean el resto)

`domain/entities.ts` mezcla **tres bounded contexts en un solo archivo**:
`Customer`/`ContactMethod` (clientes-finanzas), `PhysicalResource`
(reservas), `BookableService`/`ServiceSchedule` (reservas). Ningún
archivo puede moverse a su carpeta de dominio mientras este archivo siga
mezclado — es el primer paso literal antes de mover cualquier otra cosa,
no una limpieza opcional.

✅ **HECHO (15/08/2026).** Partido en `domain/customer.entities.ts`
(`Customer`/`ContactMethod`) y `domain/resource.entities.ts`
(`PhysicalResource` + el alias `BookableResource`, todavía usado en
~8 archivos de test — no se tocó ese uso, es una limpieza aparte). Los
27 archivos que importaban de `entities.js` se actualizaron.

**Hallazgo real en el camino, no solo mover archivos:** `BookableService`/
`ServiceSchedule`/`BookingMode` que vivían en `entities.ts` eran una
**definición duplicada y muerta** — confirmado por grep exhaustivo, cero
imports en todo el repo fuera del propio archivo. La definición real y
usada (con `createdAt`/`updatedAt`/DTOs, más completa) ya vivía en
`types/bookable-service.types.ts`. Se borraron en vez de moverlas — mover
código muerto a la carpeta nueva solo hubiera arrastrado la confusión.

Verificado: `tsc --noEmit` limpio, `npm test` 433/434 (mismo resultado
que antes del split — ningún test cambió de comportamiento),
`dependency-cruiser` sin violaciones nuevas (el único hallazgo,
`supabase.occupancy.repository.ts`, es preexistente y no relacionado —
ver C8 en `pendientes-2026-08-14.md`).

### Orden recomendado si se ejecuta

1. Partir `entities.ts` (bloqueante, ver arriba).
2. `plataforma/` primero — ya está casi aislado, sirve como ensayo de
   bajo riesgo del proceso de migración (actualizar imports, correr
   `tsc`+tests, confirmar) antes de tocar dominios con más cruces.

   ✅ **HECHO (15/08/2026).** Movidos a `src/platform/` (nombre real en
   código, no `plataforma/` — el término ya establecido en todo el stack
   es "platform", A5.1): `admin.routes.ts`, `business.routes.ts`,
   `business-hours.routes.ts`, `business-modules.routes.ts`,
   `platform.routes.ts` (desde `api/routes/`); `location.repository.ts`,
   `in-memory.location.repository.ts` (+ test), `operating-hours.
   repository.ts`, `sql.operating-hours.repository.ts`, `in-memory.
   operating-hours.repository.ts` (desde `repositories/`);
   `platform.auth.middleware.ts`, `platform.auth.service.ts` (+ tests,
   desde `security/`). 15 archivos movidos con `git mv` (historial
   preservado), ~20 archivos externos con imports corregidos (`app.ts`,
   rutas de otros dominios que todavía consumen `operating-hours.
   repository.ts` — `bookable-services`/`reservations`/`resources`/
   `customer.routes.ts` — sin mover ellas mismas, siguen en `api/routes/`
   hasta que les toque su propio paso del plan).
   Verificado: `tsc --noEmit` limpio a la primera pasada, `npm test`
   433/434 (mismo resultado, tests corriendo desde su nueva ubicación),
   lint limpio, `dependency-cruiser` sin violaciones nuevas.
3. `pms-estadias/` y `pos-menu/` — pocos cruces salientes cada uno (ver
   sección 3), riesgo bajo.

   ✅ **HECHO (15/08/2026).** `src/pms-estadias/` (11 archivos):
   `housekeeping.service.ts`, `stay.service.ts` (+ test, desde
   `services/`); `housekeeping.repository.ts`, `in-memory.housekeeping.
   repository.ts`, `stay.repository.ts` (desde `repositories/`);
   `housekeeping.routes.ts`, `stays.routes.ts` (desde `api/routes/`);
   `housekeeping-task.ts` (+ test), `stay.ts` (desde `domain/`).
   `src/pos-menu/` (13 archivos): `order.service.ts`, `product.service.ts`
   (+ tests, desde `services/`); `in-memory.order.repository.ts`, `order.
   repository.ts`, `product.repository.ts`, `sql.order.repository.ts`,
   `sql.product.repository.ts` (desde `repositories/`); `orders.
   routes.ts`, `products.routes.ts` (desde `api/routes/`); `order.
   entities.ts`, `product.entities.ts` (desde `domain/`). 24 archivos
   movidos con `git mv`. Externos con imports corregidos: `app.ts`
   (construye ambos repos/servicios y monta las 4 rutas), rutas de otros
   dominios que consumen `housekeeping.repository.ts` sin mover ellas
   mismas (`bookable-services`/`customer`/`reservations.routes.ts`),
   `reservation.service.ts` (+ test, + integration test — usa
   housekeeping como dependencia de estadías), `accounts-receivable.
   service.ts` (+ test — usa `stay.repository`/`stay.service`/`stay.js`),
   `workers/inventory.handlers.ts` (+ test) y `workers/outbox.
   registry.ts` (usan `product.service`/`product.repository`/`sql.
   product.repository` para reponer stock desde eventos de compra).
   Encontrado y corregido en el camino: 4 archivos movidos a `pos-menu/`
   (`in-memory.order.repository.ts`, `product.repository.ts`, `sql.
   order.repository.ts`, `sql.product.repository.ts`) habían quedado con
   `import ... from './sql.client.js'` sin actualizar — correcto cuando
   vivían en `repositories/` (junto a `sql.client.ts`, que es kernel
   compartido y no se mueve), roto tras la mudanza. Corregido a `'../
   repositories/sql.client.js'`.
   Verificado: `tsc --noEmit` limpio, `npm test` 433/434 (mismo
   resultado), lint limpio, `dependency-cruiser` sin violaciones nuevas
   (solo la preexistente de `supabase.occupancy.repository.ts`, ya
   trackeada aparte).
4. `reservas/` y `clientes-finanzas/` al final — son los que más
   cruzan entre sí, requieren que los otros ya estén acomodados para
   que sus imports "hacia afuera" apunten a carpetas ya estables.
5. `inventario/` se construye nuevo (no es un move, es un carve-out),
   en paralelo con el punto 1 de la sección 3 (enganchar el handler del
   outbox) — son la misma tarea vista desde dos ángulos.

**No estimado el esfuerzo en horas** — toca las rutas de import de
~150 archivos. Se haría dominio por dominio, verificando `tsc --noEmit`
+ suite completa después de cada uno (mismo criterio que ya se usó hoy
para el fix de `tsconfig.json`), nunca en un solo commit gigante.

## 5. Conclusión

No hay una arquitectura rota para arreglar — hay una decisión de
arquitectura (monolito modular) tomada implícitamente, que resultó ser
razonable para la etapa actual. La separación lógica entre dominios ya
existe en gran parte (confirmado: `order.service.ts` y
`reservation.service.ts` no se importan entre sí), pero no está hecha
explícita en la estructura de carpetas — sección 4 documenta cómo se
vería llevarla a bounded contexts reales, sin ejecutarlo todavía.
Próximo paso acordado con el dueño: retomar la opción de enganchar
Inventario al outbox (sección 3) como primer caso real del patrón, antes
de mover ningún archivo.
