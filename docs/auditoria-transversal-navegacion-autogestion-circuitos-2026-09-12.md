# Auditoría transversal — navegación, autogestión y 8 circuitos operativos

- **Versión:** v1 (12/09/2026).
- **Estado:** documento de AUDITORÍA — no de diseño. No autoriza `CREATE TABLE`,
  migraciones ni código. Cada hallazgo (c)/hueco de circuito y cada decisión
  (b) necesita su propio documento de diseño + `architecture-governor` antes
  de implementarse, igual que cualquier otro cambio de este repo. Pendiente
  de pasar por el gate como documento de registro (no de implementación).
- **Método:** `docs/DECISION_REVIEW.md` — es un inventario de hallazgos con
  grounding externo, no un cambio de código ni de schema.
- **Origen:** pedido del dueño en la sesión del 12/09/2026, en dos rondas:
  (1) 4 áreas nombradas a mano (navegación/sidebar, autogestión de usuario,
  autogestión de empresa/sucursal, circuito de reservas vs. QloApps y
  `frappe/hospitality`); (2) al ver el resultado, el dueño pidió invertir el
  método — enumerar la superficie real de `app-main` (34 prefijos de ruta,
  medidos contra `src/app.ts`) y auditarla contra los sistemas de
  referencia, en vez de esperar a que alguien nombre un área. La segunda
  ronda lanzó 4 investigaciones en paralelo (housekeeping; CRM de clientes +
  tarifas especiales; administración de roles + superadmin de plataforma;
  reportería + audit log + system + maintenance-windows), cada una con
  instrucción explícita de separar, en toda decisión de negocio, la parte
  que el grounding SÍ resuelve (recomendación técnica) de la que NINGÚN
  grounding resuelve (residuo puro del dueño).
- **Documentos relacionados:** `docs/pendientes-2026-09-12.md` (donde nació
  la primera ronda, sección "Auditoría transversal — navegación, autogestión
  y reservas" — este documento la absorbe y la amplía, no la duplica: la
  sección de pendientes queda como estaba, remitir acá para el detalle
  completo); `docs/roadmap-pms-multirubro.md` (varias filas corregidas o
  confirmadas acá); `docs/erp-auditoria-v2/fichas/M02-clientes.md`,
  `M09-housekeeping.md`, `M16-tarifario-politicas.md` (auditorías previas,
  revalidadas — dos de ellas tenían afirmaciones falsas, corregidas en este
  documento).
- **Etiquetas:** auditoría, UX, navegación, RBAC, housekeeping, CRM,
  tarifas, superadmin, reportería, audit-log.

**Grounding externo usado en todo el documento**: Odoo, ERPNext, Dolibarr,
QloApps, Cloudbeds, y **`frappe/hospitality`** (nuevo en esta sesión —
módulo vertical de Frappe para hotelería, **archivado desde el 04/10/2023**:
sirve como referencia de MODELADO, no de "estado del arte" — se lo cita así
en cada caso, nunca como autoridad de industria viva). Para el circuito de
superadmin/multi-tenant se sumó **`frappe/press`** (el hosting de Frappe
Cloud, el comparable más directo a "gestionar múltiples instancias") y
documentación de **Odoo Online**. Cloudbeds es closed-source: sus citas
salen de su Help Center público, algunas vía índice de búsqueda cuando el
dominio estaba bloqueado por el proxy de egress de esta sesión — marcado
así en cada caso, nunca presentado como código verificado.

---

## 0. Cómo leer este documento

Cada circuito se investigó en dos niveles, y cada hallazgo se clasifica en
tres tipos:

- **Nivel 1 — circuito**: ¿existe la capacidad, con qué alcance?
- **Nivel 2 — mecanismo**: dado que existe (o existiría), ¿cómo lo resuelven
  los sistemas de referencia, con evidencia de código o documentación real?
- **(a)** problema real de UX/organización — no requiere decisión de negocio.
- **(b)** decisión de negocio pendiente — para cada una, el documento separa
  la recomendación TÉCNICA que el grounding sí sostiene (cuando la hay) del
  residuo que NINGÚN grounding puede resolver porque es puramente del
  dueño.
- **(c)** hueco de circuito completo — falta una capacidad entera, no un
  detalle.

**Dos hallazgos son bugs activos, no huecos — ver §1, léanse primero.**

Este documento NO re-audita lo que ya se descartó como no-hallazgo en la
primera ronda (no hay links rotos en el sidebar; el circuito de check-in/
check-out de `app-main` es superior a las dos referencias hoteleras). Esas
conclusiones siguen vigentes y no se repiten acá.

---

## 1. Hallazgos urgentes — bugs reales en el código actual, no huecos de producto

### 1.1 La ficha de cualquier cliente con una tarifa especial se cae (crash de render)

`appfrontend-main/src/app/dashboard/clientes/[id]/page.tsx:591` renderiza
`rate.price.toLocaleString('es-AR')`, pero el backend devuelve `fixedPrice`,
no `price` (`app-main/src/clientes-finanzas/sql.customer-rate.repository.ts:192`,
`customers.routes.ts:654,735`). `rate.price` es `undefined` en TODA
respuesta real → `TypeError`, la ficha entera deja de renderizar. TypeScript
queda "verde" en los dos repos porque el tipo del frontend
(`lib/clientes/types.ts:16`) miente sobre el contrato real — exactamente el
tipo de discrepancia que la colaboración cruzada entre los dos repos existe
para atrapar. Segundo punto de rotura, dos líneas antes (`:587`): una
tarifa con scope `categoryId`/`bucket`/`productId` (los 3 scopes nuevos de
D9) tiene `resourceId`/`serviceId` en `null` los dos → `getServiceName(null)`
revienta igual. Reparable solo en frontend, sin ninguna decisión de negocio
de por medio.

### 1.2 La reportería PMS no tiene ningún camino funcional desde el producto

Los 5 reportes que SÍ tienen pantalla (`appfrontend-main/src/app/dashboard/reportes/page.tsx`)
devuelven **400 siempre**, sin excepción. El input es
`&lt;input type="datetime-local"&gt;` (`:382-383` y 4 lugares más), que
produce `2026-09-01T00:00`; el backend valida con `dateOnlySchema`
(`app-main/src/api/schemas/common.schemas.ts:39-41`), que exige
`/^\d{4}-\d{2}-\d{2}$/` estricto. No hay combinación de fechas que
funcione. Mismo bug por el otro extremo en `appfrontend-main/src/app/admin/page.tsx:177-178`
(`.toISOString()` tampoco matchea). Causa raíz: `dateOnlySchema` se
introdujo el 25/08/2026 endureciendo el backend; nadie tocó el frontend
que seguía mandando datetime. Ninguna cerca del repo lo ve —
`openapi-spec-route-sync` valida existencia de path+método, no el formato
del query param. Fix trivial (`type="date"` en los 10 inputs + sacar el
`.toISOString()`), sin decisión de negocio de por medio.

---

## 2. Navegación / sidebar — ⚠️

*(Detalle completo, con todas las citas, en `docs/pendientes-2026-09-12.md`,
sección "Auditoría transversal — navegación, autogestión y reservas", Área
1. Resumen acá para que el documento sea autocontenido.)*

**Descartado, no re-preguntar**: no hay links rotos (las 21 entradas de
`NavList.tsx` apuntan todas a rutas reales, y viceversa).

- **"Admin BD" es un atajo muerto, promocionado como acceso rápido del
  Home** — el endpoint que consume exige hoy token de plataforma
  `SUPERADMIN` (`platform/admin.routes.ts:57`); falla para el 100% de los
  usuarios del panel. Una tercera copia (`appfrontend-main/src/app/admin/page.tsx`,
  ruta raíz `/admin`) no tiene ningún link entrante en todo el repo.
- **Causa raíz de varios síntomas: el sidebar gatea por NOMBRE de rol
  (`useIsManagement()`), no por grupo de permiso.** `role` es un string
  libre y editable (`PUT /api/roles/:id` lo renombra). Consecuencia real:
  un tenant que compra roles personalizados y crea un rol "Gerente" con el
  grupo `MANAGEMENT` pierde del sidebar Usuarios y Roles aunque el backend
  lo autorice — la feature paga se rompe justo para quien la paga. El dato
  correcto (`BusinessContext.permissionGroups`) ya está en el navegador.
  Misma causa explica "Mi Negocio"/"Empresa" visibles sin gate (mismo
  incidente D6 ya documentado en `app-main/CLAUDE.md`, nunca corregido del
  lado del sidebar). "Empresa" tiene además un gap de contrato: el plan no
  está en `BusinessContext` — gatear por plan hoy exigiría un fetch aparte
  a `GET /api/business/plan-limits` (existe, sin gate de `MANAGEMENT`, con
  cliente ya tipado en `lib/negocio/api.ts:51`).
- **City Ledger operativo (con un botón que emite AFIP real) escondido
  dentro de "Reportes"** — su gate de nav (`moduleKey: 'REPORTES'`) no
  coincide con el gate real de sus endpoints (`requireModule(CUENTAS_CORRIENTES)`).
- **Catálogos de POS (Motivos de Merma, Destinos de Consumo) top-level,
  separados de la transacción que los usa** — el propio empty-state manda
  al usuario a "crear uno primero" en otra sección del sidebar.
- **3 catálogos manuales de navegación (`NAV`/`PAGE_TITLES`/`REFINE_RESOURCES`),
  ya con drift** — Facturación se agregó a uno y no a los otros dos.

---

## 3. Autogestión de usuario — ❌ el circuito no existe

*(Detalle completo en `pendientes-2026-09-12.md`, Área 2.)*

Ningún empleado puede ver ni editar su propia ficha. `GET /api/auth/me`
tiene 3 rutas (GET, logout, refresh) — **sin `PATCH`**. Todo `/api/users/*`
exige `MANAGEMENT` o más. Cambiar la contraseña propia requiere salir a un
flujo público de mail no autenticado, como si el usuario no estuviera
logueado. Frappe resuelve esto con `update_password` (clave de reset O
contraseña vieja verificada); Dolibarr con permisos de primera clase
separados (`user->self->creer`, `user->self->password`) — este repo no
tiene noción de "sobre mí mismo" en su modelo de roles. Contraste: el
portal de cliente tiene la asimetría inversa (`DELETE /me` existe, no hay
`PATCH` — se puede borrar la cuenta, no corregir el nombre).

---

## 4. Autogestión de empresa/sucursal — ⚠️ negocio bien, sucursal no

*(Detalle completo en `pendientes-2026-09-12.md`, Área 3.)*

"Mi Negocio" está bien resuelto (identidad, fiscal AFIP, certificado
cifrado, candado `OWNER_ONLY`). **`locations` es un hueco de circuito
real**: FK `NOT NULL` en 3 tablas transaccionales (`resources`, `orders`,
`inventory_levels`; `stock_movements` usa un CHECK, no `NOT NULL`), la
tabla tiene 5 columnas sin domicilio/teléfono/horario, el CRUD no tiene
`PUT`/`DELETE`, y en el frontend **`locationId` no existe — cero
ocurrencias**. `docs/roadmap-pms-multirubro.md:237` declara "✅
Transferencia entre depósitos resuelto" y con una sola ubicación sembrada
y sin pantalla, es inalcanzable para el usuario real. `afip_sales_point` es
único POR NEGOCIO, no por sucursal — bloquea multi-sucursal real en
Argentina. Y "sucursal" hoy significa dos cosas sin decidir: `locations`
(fila dentro del mismo tenant) vs. `companies` (otro tenant vinculado).
ERPNext separa esto de fábrica (`Company` árbol + `Warehouse` árbol);
QloApps tiene el modelo más maduro (`HotelBranchInformation`, con reglas de
reembolso por propiedad); `frappe/hospitality` está en la posición de hoy
de `app-main` (`Hotel Settings` Single) pero es el ejemplo de que el mismo
equipo, al modelar `Restaurant` después, lo sacó del Single. **Decisión
pendiente, no resuelta por el grounding**: ¿multi-sucursal con `locations`
dentro de un tenant, o con un tenant por sucursal agrupados por
`companies`?

---

## 5. Circuito de reservas — ⚠️, con partes por delante de las referencias

*(Detalle completo en `pendientes-2026-09-12.md`, Área 4.)*

**Descartado, no re-preguntar**: `stays` (check-in/check-out) es superior a
QloApps y `frappe/hospitality` — ninguno de los dos modela no-show ni quién
hizo el check-in.

- **`reservations` no tiene `location_id`** (a diferencia de `orders`) —
  reasignar un recurso de ubicación re-atribuye retroactivamente TODAS sus
  reservas históricas. QloApps lleva `id_hotel` en la propia línea de
  booking. Latente mientras haya una sola `location`.
- **`reservations` snapshotea al cliente pero no al recurso** — renombrar
  "Cabaña 3" reescribe la historia en reportes. **Verificar si es
  intencional**, no es error obvio.
- **Reserva por unidad concreta, no por tipo** — decisión de producto con
  alternativa ya vigente (reasignación manual). `frappe/hospitality` es el
  extremo opuesto (defecto reconocido por el propio proyecto,
  `frappe/erpnext#16161`); QloApps hace las dos cosas a la vez. Costo alto,
  no se resuelve acá.
- `booking_mode = 'event'` **ya está** distinguido e implementado, con
  decisión confirmada con el dueño el 18/08/2026 — descartado como
  hallazgo (la primera versión de este punto era incorrecta, corregida).

---

## 6. Housekeeping — ⚠️ (circuito completo existe; el hueco es de modelado, no de volumen)

**Nivel 1 — lo que existe.** Backend completo (`app-main/src/pms-estadias/housekeeping*`,
11 endpoints, máquina de estados PENDING→ASSIGNED→IN_PROGRESS→DONE→INSPECTED),
frontend con rack por recurso + "Mis tareas"
(`appfrontend-main/src/app/dashboard/housekeeping/`), gate de módulo
(`ModuleKey.HOUSEKEEPING`), entrada de sidebar, e integraciones vivas reales:
`StayService.checkOut()` crea la tarea post-checkout; `StayService.checkIn()`
**bloquea el check-in** si la tarea de hoy no está `INSPECTED` (con
override de `MANAGEMENT`).

**Nivel 2 — grounding.** Cloudbeds modela la condición de limpieza como
propiedad **de la habitación** (Clean/Dirty/Inspected, reset automático de
las ocupadas a Dirty ~2 AM). QloApps no tiene housekeeping en el core — es
un add-on pago de Webkul que sí modela dirty/under cleaning/out of order.
`frappe/hospitality` y ERPNext **no tienen housekeeping en absoluto**
(confirmado listando los 10 doctypes de `hospitality/hotels/`, ninguno de
limpieza; ERPNext lo tiene como gap reconocido, `frappe/erpnext#51226`).
Odoo/Dolibarr no tienen housekeeping hotelero — lo único comparable es el
módulo genérico de mantenimiento de Odoo (`maintenance.request`).

### Huecos de circuito (c)

- **No existe el estado de limpieza del recurso como concepto** — se
  deriva de "¿hay tarea hoy?". Una habitación sucia sin tarea planificada
  se ve idéntica a una limpia, y el gate de check-in falla abierto
  justo ahí.
- **Cero tareas para estadías en curso (stayover)** — el único disparador
  automático es al check-out; un huésped de 5 noches genera 0 tareas
  automáticas de limpieza diaria.
- **Sin reportería de housekeeping** (tareas por empleado, tiempo
  promedio, tasa de rechazo) pese a que los 3 timestamps ya están
  persistidos.
- **Sin checklist ni ítems, sin consumo de insumos** por tarea.
- **Mantenimiento no es una orden de trabajo** (sin técnico, tipo,
  recurrencia) — ya ❌ en el roadmap, confirmado sin cambios.

### Problemas reales (a)

- **El docblock de `housekeeping.routes.ts` miente**: dice que el grupo
  exigido es `HOUSEKEEPING` y que "el asignado inicia"; el código real
  exige solo `STAFF` (los 5 presets lo tienen, incluido `WAITER`) y **nada
  compara `task.assignedTo` contra el usuario real** — cualquier mozo
  puede iniciar/completar la limpieza de cualquier habitación.
- **Nada impide dos tareas del mismo recurso el mismo día**, sin `UNIQUE`;
  el desempate (`ORDER BY scheduled_for DESC LIMIT 1`) es no determinístico
  cuando las automáticas nacen todas a las 08:00 — puede hacer que el gate
  de check-in lea la tarea equivocada.
- `assigned_to` acepta cualquier string, sin validar existencia ni rol —
  el filtro a personal de housekeeping vive **solo en la UI**.
- `isOutOfService()` es código muerto (reemplazado por `maintenance_window`
  desde el 24/08) con un docblock que afirma lo contrario — mismo patrón
  de bug ya corregido una vez en `report.service.ts`.
- Sin `audit_log` y sin `FOR UPDATE` — dos empleados pueden iniciar la
  misma tarea a la vez, el segundo pisa al primero.
- La regla "housekeeping solo para alojamiento" es solo de UI; el backend
  acepta cualquier recurso.
- **Corrección a la ficha previa `M09-housekeeping.md`**: su afirmación
  "el sistema tiene el reparto de roles más fino" citaba el docblock, no el
  código real — falsa. Y "`late-checkouts` sin consumidor" también es
  falsa (sí tiene consumidor); los que de verdad no tienen consumidor son
  otros dos endpoints. Anclas de línea de esa ficha, además, están
  corridas (`schema.sql:1867`→`1934` y similares).

### Decisiones (b) — mecanismo resuelto + residuo del dueño

- **Condición de habitación como propiedad del recurso**: mecanismo
  unánime donde existe (Cloudbeds, add-on QloApps) — columna de condición
  en `resources`, escrita por las transiciones ya existentes. Residuo del
  dueño: valor inicial al migrar (conservador vs. optimista) y si se
  implementa el reset diario automático.
- **Tareas para stayover**: mecanismo — un worker diario (mismo patrón que
  `reservation-hold-expiry.worker.ts` ya existente). Residuo del dueño: la
  política de frecuencia (diaria/día por medio/a pedido) y si es
  configurable por tenant.
- **Segregación ejecutor/inspector**: Cloudbeds lo trata como privilegio
  separado y **opt-in**, no default — hoy acá el mismo preset tiene los dos
  grupos. Mecanismo: guard que rechace autoinspección. Residuo: si una
  operación de 6 habitaciones con una sola mucama debe poder saltarlo.
- **Ownership en start/complete**: mecanismo — reusar el guard de
  pertenencia que el portal de cliente ya tiene (`requireOwnReservation`).
  Residuo: si el negocio quiere que el turno entrante pueda cerrar la
  tarea que dejó abierta el saliente.
- **Unicidad y multi-turno**: mecanismo — columna `business_date` +
  `UNIQUE`. Residuo: si hace falta más de una tarea por día por recurso
  (limpieza de mañana + turndown nocturno es un caso real de hotelería
  media/alta).
- **Consumo de amenities por tarea**: ningún sistema de referencia lo ata a
  la tarea de limpieza — no inventar el vínculo si se hace, es un
  `stock_movement` genérico. Residuo: imputar costo por tarea o por
  período.
- Sin grounding aplicable, verificar si es intencional: `ON DELETE
  CASCADE` sobre historial de limpieza (único caso en el repo, el resto es
  `RESTRICT`); housekeeping apagado por default fuera de alojamiento (ya
  declarado en código, no es descuido).

---

## 7. CRM de clientes — ⚠️

**Corrección de anclas**: `docs/erp-auditoria-v2/fichas/M02-clientes.md`
(02/09/2026) cita líneas ya corridas (`customers.routes.ts:843`→830,
`:622`→626).

### Lo que existe

Alta/edición básica, identidad `CLI-nnnnnn`, búsqueda, tags (asignar/quitar),
perfil fiscal + padrón ARCA, política de facturación por cliente (mal
ubicada, ver abajo), cuenta corriente.

### Huecos de circuito (c)

- **Métodos de contacto (email/teléfono/whatsapp) son de escritura única**
  — se cargan solo en el alta; no hay ruta para editarlos después. El
  agregado `ContactMethod` es **inalcanzable desde el frontend** (cero
  ocurrencias).
- **Los tags son escritura sin lectura agregada** — `getAllTags()` está
  implementado en el repositorio y **ninguna ruta lo expone**; no se puede
  listar clientes por tag; el alta es find-or-create case-sensitive sobre
  `UNIQUE`, así que "VIP"/"vip"/"Vip" son tres tags sin fusión posible. El
  glosario del proyecto define "cliente especial" como "con etiquetas" y no
  se puede consultar.
- **El historial comercial de la ficha del cliente es solo UI** — los
  endpoints (`GET /reservations?customerId=`, `GET /customers/:id/account`)
  ya existen; la ficha no los consume. (Corrección de dimensionamiento a
  `M02-clientes.md`, que lo registraba como falta de backend.)
- Sin notas internas del cliente, sin fusión de duplicados, sin modelo de
  empresa-con-varios-contactos.

### Problemas reales (a)

- **La UI bloquea el caso de negocio que el backend fue diseñado para
  soportar**: el docblock del backend dice explícito "se puede crear un
  cliente sin email (walk-in con solo nombre y teléfono)"; el modal de
  alta exige email y no tiene campo de teléfono. El walk-in de mostrador
  — el caso más frecuente en barbería/gastronomía — no se puede cargar.
- **Combos de cliente sin paginar** en 7 pantallas (Facturación, Cuentas
  Corrientes, Reportes, Órdenes ×2, Estadías ×2) — con miles de clientes
  dejan de ser usables. Solo la pantalla de Clientes pagina server-side.
- **Corrección a `M02-clientes.md`**: su recomendación de retirar el `GET`
  plano de clientes por "sin consumidor" es al revés — ese `GET` es el que
  sirve la primera carga y los 7 combos; retirarlo rompería 6 pantallas.
- **La política de facturación de un cliente (dato maestro) se edita desde
  "Reportes"**, no desde su propia ficha, que ni siquiera la muestra en
  lectura. ERPNext la tiene como campos del doctype `Customer`.
- El alta y la baja de un cliente no se auditan (`audit_log`); solo el
  `PATCH` sí.

### Decisiones (b)

- **Nivel grupo/segmento de cliente para precio**: los 4 sistemas con
  precio-por-cliente lo resuelven por indirección, no duplicando filas
  (ERPNext `customer_group` en la regla, QloApps `id_group` en
  `specific_price`). Mecanismo recomendado: un tercer eje ortogonal en
  `customer_rates` (`customer_id` XOR `tag_id`), coherente con el patrón
  CASE-based que la tabla ya usa dos veces — con el prerrequisito duro de
  que los tags sean consultables primero. Residuo del dueño: si el
  descuento debe vivir pegado al segmento (riesgo de cambio de precio
  masivo al agregar un tag) o al cliente (cero riesgo, repetir la carga
  N veces).
- **Fusión de duplicados**: Odoo tiene el mecanismo completo
  (`base.partner.merge.automatic.wizard` — detecta por email/VAT
  normalizados, reasigna FKs, borra si colisiona con un índice único, deja
  log). Los índices únicos parciales de `customer_rates` son el punto real
  de colisión. Residuo del dueño: Odoo borra al perdedor; este repo tiene
  política de soft-delete/anonymize ya escrita en sentido contrario — qué
  pasa con la ficha perdedora es decisión propia, no trasladable de Odoo.
- **Empresa con varios contactos**: Odoo (auto-referencia `parent_id`/
  `child_ids`) es la variante de menor costo estructural para este repo.
  Residuo del dueño: si el caso existe de verdad en su cartera, y —si
  existe— contra quién se acumula el saldo de cuenta corriente (pregunta
  ya cercana a City Ledger, no se reabre acá).

---

## 8. Tarifas especiales (`rate_catalog` + `customer_rates`) — ❌ en producto, ✅ en dominio

**El backend está más completo que la ficha previa (`M16-tarifario-politicas.md`,
con anclas ya corridas) y el producto más vacío de lo que ella describe.**

### Lo que modela el backend (sólido)

`customer_rates` cruza dos ejes ortogonales, cada uno "exactamente uno de
N": **scope** (recurso/servicio/producto/categoría/bucket, con resolución
por especificidad ítem > categoría > bucket) y **precio** (fijo, % propio,
o referencia viva a `rate_catalog` — la decisión ya confirmada con el
dueño el 22/08/2026: "regla viva", no snapshot).

### Lo que llega al producto: nada del catálogo, un solo modo de 3

El único formulario (`clientes/[id]/page.tsx:599-634`) ofrece exactamente
`resource|service` + `price` fijo. **Cero** ocurrencias de `rate-catalog`
en el frontend. Los modos B/C (% propio, referencia a catálogo) y los 3
scopes nuevos de D9 son inalcanzables desde el producto — aunque se
cargara el catálogo por API cruda, no hay forma de asignarlo a un cliente
desde la UI.

### Hallazgos

- **§1.1 de este documento** (el crash de `rate.price`) es el hallazgo más
  urgente de este circuito.
- **La mitad del diseño D9 está muerta en producto**: columnas, índices,
  API y motor de pricing existen para `product_id`/`category_id`/`bucket`;
  sin UI, "10% a toda la categoría Suites para este cliente" no es una
  operación disponible.
- **Resolución de un `[H]` abierto de `M16`**: verificado que una reserva
  `CONFIRMED` NO se recalcula sola cuando cambia el % del catálogo — el
  precio histórico está protegido. Pero al verificarlo apareció un
  hallazgo nuevo: el ajuste de precio por estiramiento de fechas
  recalcula TODA la cascada al precio de hoy, sin desglosar cuánto es por
  noches nuevas y cuánto por el % que cambió mientras tanto.
- **Corrección a `M16`**: el reporte `applied-rates` no mide "cuánto
  descuento regalamos" como la ficha decía — suma lo facturado, no lo
  resignado, porque no existe en ningún lado el precio de lista contra el
  que comparar. "Agregar panel" no alcanza; falta congelar el precio de
  lista o el % aplicado en la línea.

### Grounding (tabla comparativa completa en la fuente — resumen)

Los **5** sistemas de referencia coinciden, sin excepción, en un punto: la
**vigencia temporal** de la tarifa (`date_start`/`date_end` o equivalente).
`frappe/hospitality` —el específico de hotelería— la hace **obligatoria**,
no opcional. Es el punto de mayor convergencia de todo el grounding de esta
ronda.

### Decisiones (b)

- **Vigencia temporal**: mecanismo — `valid_from`/`valid_to` nullable +
  filtro de rango; el costo real no son las columnas, son los índices
  únicos parciales actuales, que hoy prohíben justo lo que hay que
  permitir (cargar la tarifa de temporada con anticipación). Residuo del
  dueño: la vigencia resuelve dos problemas distintos —"cargar hoy la de
  enero" (barato) vs. "qué precio regía el 15 de julio" auditable (necesita
  además una tabla de log, como la de Dolibarr) — cuál le importa es
  negocio, no técnica.
- **Moneda por tarifa**: 3 de 5 sistemas la tratan como atributo de la
  regla, requerido. Mecanismo: columna con default = moneda del negocio.
  Residuo del dueño: si este producto va a vender a clientes que cotizan
  en otra moneda, y si sí, a qué tipo de cambio y en qué momento se
  congela (toca facturación/ARCA, excede este circuito).

---

## 9. Administración de roles y permisos — ⚠️ (circuito ciego, no incompleto)

El circuito existe punta a punta (crear, editar grupos, desactivar, techo
por plan, auditoría de escritura en 3 de 4 operaciones) pero el admin **no
puede ver** qué hace ningún grupo, ni qué hace ningún rol de fábrica, ni
quién cambió qué.

**Confirmado, corrige una nota stale del `CLAUDE.md`**: los 3 catálogos de
grupos del frontend están sincronizados hoy (9/9/8, el de 8 excluye
`CUSTOMER_ONLY` a propósito) — la nota que decía "desincronizado 8 de 9"
quedó vieja desde el mismo día que se corrigió.

### Hallazgos

- **La tabla de roles no dice qué hace ningún rol** — la columna "Grupos de
  permiso" es un número (`{n} grupo(s)`); los roles de fábrica ni siquiera
  tienen botón de editar. El dueño no tiene forma, desde ninguna pantalla,
  de saber qué puede hacer cada rol.
- **Desactivar un rol no deja rastro de auditoría** — es el único de los 4
  métodos del servicio que no llama a `auditLogRepo` (los otros 3 sí, con
  comentario explicando el criterio).
- **Desactivar un rol es irreversible y quema el nombre para siempre** —
  no existe `reactivateRole`, y el chequeo de duplicados corre sobre
  activos+inactivos: desactivás "Cajero" y no lo podés reactivar, no lo
  podés borrar, ni volver a crear un rol con ese nombre. Contraste
  interno: las memberships sí tienen camino de vuelta
  (`reactivated_by`/`_at`). No encontré ningún sistema de referencia donde
  desactivar un rol sea terminal.
- **`RoleInUseError` manda a adivinar a quién reasignar** — el 409 solo
  trae un número, nunca la lista de personas.
- Mismo bug transversal del §2 (sidebar por nombre de rol), con la peor
  consecuencia de todo el documento: un rol custom "Supervisor" con el
  grupo `MANAGEMENT` real **no ve Roles ni Usuarios en el menú** — la
  feature paga de roles personalizados se vuelve invisible justo para
  quien la compra.
- La pantalla de edición de roles viola la convención de interacción del
  propio repo (más de 4 campos/relaciones dentro de un `Modal`) y "Roles"
  no figura en el backlog de migración a ruta dedicada.
- `GET /api/audit-log` existe, con resolución cross-DB de `changedByName`
  ya hecha — **cero consumidores en el frontend**.

### Decisiones (b)

- **Describir qué hace cada grupo**: Dolibarr resuelve esto con label +
  descripción **servida junto al permiso**, no como documentación aparte
  (Frappe deja el campo de descripción vacío — no es precedente acá).
  Mecanismo: un endpoint de catálogo que reemplace los 3 arrays literales
  del frontend por una sola fuente (retira además el artefacto manual
  `ROLES-CATALOG-DRIFT-001` del `CLAUDE.md`, porque el drift deja de ser
  posible por construcción). Residuo del dueño: a qué nivel de detalle —
  una frase de negocio, la lista de pantallas, o la lista de endpoints
  reales (Dolibarr elige lo último, pero le habla a un admin técnico, no
  necesariamente el caso acá).
- **Reasignación asistida al desactivar un rol en uso**: Frappe muestra
  quiénes tienen el rol, no solo cuántos; este repo **ya tiene** el mismo
  patrón implementado para un caso equivalente (`SEAT_LIMIT_EXCEEDS_NEW_PLAN`
  devuelve la lista completa de memberships). Mecanismo: replicar esa
  forma acá — no reabre la política de bloquear-no-cascadear ya cerrada.
  Residuo del dueño: si además se ofrece reasignación masiva desde la
  misma pantalla, o solo un link a Usuarios filtrado.

---

## 10. Superadmin de plataforma — ❌ ciclo de vida cortado en los dos extremos

Piezas sólidas existen (transiciones validadas, auditoría transaccional en
la mayoría de las escrituras, degradación asistida de asientos ya
implementada en backend) pero el circuito está roto en el alta, en la
suspensión real, y no existe la baja.

### Hallazgos de severidad alta

- **Suspender un negocio no le corta el acceso hasta que se reinicie el
  proceso.** El middleware de tenant (`platform/tenant.middleware.ts`)
  devuelve el pool cacheado ANTES de consultar el estado del negocio; el
  `PATCH` de status (`platform.routes.ts`) nunca llama a
  `evictTenantPool()` — función definida en `tenant.middleware.ts:170` y
  ya usada por este mismo motivo, pero en OTRO archivo:
  `platform/admin.routes.ts:102,150`, con el comentario textual *"Sin
  esto, el pool cacheado en memoria (tenant.middleware.ts) sigue usando
  la connection string vieja hasta que el proceso reinicie"* — exactamente
  el mismo mecanismo, nunca incorporado al `PATCH` de status. Es una línea
  faltante, no diseño pendiente. Frappe Cloud trata la suspensión como
  estado operativo real, propagado, no un flag consultado perezosamente.
- **El actor del audit log de plataforma es un UUID aleatorio que cambia
  en cada login** del superadmin — no se puede reconstruir qué hizo una
  persona ni siquiera hoy con un solo superadmin. El email sí viaja en el
  token; es el dato que debería persistirse.

### Otros huecos de circuito (c)

- El audit log de plataforma es **write-only** — los métodos de lectura
  están implementados, ninguna ruta los llama.
- La degradación asistida de plan (bajar de plan eligiendo a quién
  desactivar si faltan asientos) está completa en el backend, testeada, y
  **el cliente HTTP del frontend no manda el campo que la activa** — el
  downgrade queda bloqueado desde el panel, siempre.
- Crear un negocio desde el panel **no crea identity ni membership ni
  invitación** — produce un tenant sin que nadie pueda entrar. El camino
  público sí lo hace bien; el del superadmin no. Y no hay botón de alta en
  la UI en absoluto.
- **`industry_key` no se puede escribir desde ningún lado** — se lee en
  toda la capa de business-context (presets por rubro, terminología, color
  de módulo) y nunca se setea. Toda la capa multirubro está construida,
  testeada, e inalcanzable por falta de un `PATCH`. Bloquea especialmente a
  spa/barbería.
- Los overrides de módulo por negocio (`source = SUPERADMIN | TENANT`) no
  tienen camino de escritura — el schema ya anticipó la arquitectura de
  tres orígenes, falta el endpoint.
- El `reason` de una suspensión nunca se captura (el backend lo acepta, el
  frontend no lo manda).
- Sin vista de detalle de un negocio — todo el ciclo de vida se maneja
  desde dos `&lt;select&gt;` en una fila de tabla.

### Decisiones (b)

- **Baja de tenant**: convergencia fuerte entre las dos plataformas SaaS
  multi-tenant comparables — Frappe Cloud y Odoo Online llegan
  independientemente a ~21 días de gracia con backup antes de destruir.
  Ninguno de los 5 sistemas de referencia "de producto" tiene equivalente
  (son de un solo tenant). Mecanismo: separar corte de acceso (inmediato,
  reversible) de ventana de gracia (datos intactos) de archivado (backup
  verificado, después liberar el recurso). Residuo del dueño: el número
  exacto de días (el orden de magnitud converge, el número no es
  trasladable sin más) y si el cliente puede llevarse sus datos solo o el
  operador lo hace por él (postura de negocio con implicancias legales
  sobre datos personales de huéspedes).
- **Overrides de módulo**: en los 3 ERP open-source de referencia, activar
  un módulo es autoservicio del propio negocio, no del proveedor — el
  diseño de 3 orígenes que el schema ya tiene es coherente con eso.
  Residuo del dueño: si algún módulo es un add-on PAGO (venta/baja
  autoservicio con facturación) — decisión de modelo comercial, no técnica.
- **Actor único de plataforma**: no es urgente por el número de operadores
  (hoy es uno), pero la inestabilidad del actor en el audit log sí lo es,
  hoy mismo. Residuo del dueño: cuándo pasar a varios operadores y con qué
  mecanismo.

---

## 11. Reportería — ⚠️ backend, ❌ producto

*(§1.2 de este documento es el hallazgo más urgente de este circuito —
léase ahí.)*

- **6 de 11 endpoints sin consumidor** — 5 de POS/CRM ya están en el
  roadmap como gap conocido; el sexto (`DELETE /occupancy/purge`, borrado
  masivo de histórico) no figura en ningún documento.
- **"Reportes" no es una pantalla de reportes, es un explorador de API** —
  renderiza JSON crudo con el verbo HTTP y la URL visibles, mismo
  componente que la pantalla de pruebas `/admin`. Mecanismo que el
  grounding sí resuelve: los 3 sistemas con reportería madura (Frappe,
  ERPNext, Dolibarr) definen el reporte como DATO (columnas, filtros,
  roles) consumido por un renderer genérico — no una pantalla por reporte.
  Los 11 endpoints ya devuelven tipos concretos; el costo real es un
  componente + 11 definiciones, no 11 pantallas. Residuo del dueño: si el
  usuario final define sus propios reportes (Frappe/Dolibarr) o solo
  consume los de fábrica (Cloudbeds) — y si "Reportes" debe seguir
  mostrando la URL/verbo cruda o eso fue un resto de cuando era un
  explorador.
- **Denominador inconsistente entre reportes de la misma pantalla**: el
  reporte diario no excluye recursos en mantenimiento, los otros 3 sí —
  mismo rango, mismo negocio, universos distintos sin que nada lo indique.
  Cloudbeds tiene un artículo de soporte dedicado exactamente a esta
  discrepancia — es un modo de falla documentado en la industria, no
  teórico.
- El borrado masivo de histórico (`purge`) no tiene preview, ni
  confirmación, ni auditoría, y está atado a un módulo de plan —un tenant
  sin ese módulo no puede purgar su propia tabla de ocupación. Mecanismo
  de referencia (Frappe `Log Settings`): retención declarativa + job, no
  un endpoint destructivo manual.

---

## 12. Audit log — ❌ circuito sin salida al producto

- **Cero consumidores en el frontend** — no existe ninguna pantalla, en
  ningún lado, que muestre el historial de cambios. El backend resuelve
  cross-DB `changedByName` (trabajo no trivial) y nadie lo ve.
- La API solo contesta "historial de este documento" — no hay feed por
  usuario ni por fecha (ni el índice para soportarlo sin table scan).
- **Cobertura desigual**: fuerte en maestros (productos, tarifas, roles,
  clientes), **casi nula en las transacciones del día a día del PMS**
  — no se audita check-in, check-out, reasignación de limpieza, apertura/
  cierre de caja, ni baja de usuarios.
- No figura en el roadmap de producto — nunca entró al backlog.

### Decisión (b)

- **Historial per-documento**: no es decisión, es implementación pura — la
  API ya tiene exactamente la forma que Frappe usa para esto (entity +
  entityId ≡ doctype + docname). Falta la card en las pantallas de detalle
  que ya existen, siguiendo el patrón `.detail-card-header` que el
  `CLAUDE.md` del frontend ya declara normativo.
- **Feed global**: mecanismo — separarlo del historial per-documento como
  un artefacto propio (así lo hacen las dos referencias), con índices
  nuevos y una política de retención (sin la cual crece sin techo).
  Residuo del dueño, dos preguntas distintas: si el feed global es de
  negocio o de seguridad (Dolibarr eligió seguridad, Frappe tiene las
  dos), y si vale la pena antes que la vista per-documento (que es
  gratis, ésta cuesta).

---

## 13. `/api/system` (dead-letter del outbox) — ⚠️ drift de contrato de 5 días

Tiene UI (banner + rail en el layout), y el backend ya traduce cada fallo a
lenguaje de negocio con un campo explícito que dice *"'Reintentar' es un
no-op garantizado — la UI debe ofrecer otra acción"* — desde el
07/09/2026. **El frontend nunca lo consumió**: el tipo del cliente HTTP no
tiene el campo `description`, y sigue mostrando el string técnico crudo
(`order.completed · 5 intentos · ChargeNeverCreatedError`) con un botón
"Reintentar" que, para esos casos, el propio backend clasifica como no-op
garantizado. Fix sin decisión de negocio — el ADR ya la tomó, falta
propagar el contrato.

Secundario: sin eventos, el banner desaparece — no hay forma de consultar
proactivamente el estado, ni histórico de eventos ya resueltos. Y el rail
degrada a "sincronizado" también ante errores de red, no solo ante falta
de permiso (que sí es un caso declarado a propósito) — **verificar si es
intencional**.

---

## 14. `/api/maintenance-windows` — ⚠️ modelo de dominio sólido, semántica de reportería sin declarar

El modelo en sí está bien resuelto (clasificado correctamente como
transacción, manejo de fechas con razonamiento de huso explícito,
distinción `closedAt`/`endDate`) — no es un hallazgo.

- **El código ya tomó una decisión de reportería sin declararla**: toda
  ventana de mantenimiento excluye incondicionalmente al recurso de las
  estadísticas de ocupación. Es la convención "Out of Order" (achica el
  denominador) aplicada a todo, sin distinguirla de "Out of Service"
  (no la achica) — una distinción estándar de hotelería (Oracle OPERA,
  Apaleo, Cloudbeds la tienen las tres, con documentación explícita de que
  "la elección no es de housekeeping, es de reportería"). Mecanismo:
  campo discriminante tipado en la ventana (no texto libre), y el conteo
  de recursos excluidos visible en el reporte (Cloudbeds lo muestra;
  cuando no se muestra es la causa documentada de confusión). Residuo del
  dueño: si la distinción aplica fuera de alojamiento (todo el grounding
  es hotelero), y cuál es el default al migrar (cambia la lectura
  histórica de todos los reportes).
- El histórico completo de ventanas de un recurso tiene endpoint Y cliente
  de frontend ya escrito — **nadie lo llama**. Mismo patrón exacto que el
  audit log: el circuito se construye hasta el historial y se detiene ahí.
- Mantenimiento como ticket (técnico, costo, tipo) ya está ❌ en el
  roadmap — confirmado sin cambios.

---

## 15. Tabla consolidada — todos los hallazgos de las 8 áreas

| # | Hallazgo | Tipo | Severidad |
|---|---|---|---|
| **1.1** | Ficha de cliente se cae con cualquier tarifa especial (`rate.price` vs `fixedPrice`) | **bug activo** | 🔴 urgente |
| **1.2** | Reportería PMS: los 5 reportes con pantalla devuelven 400 siempre | **bug activo** | 🔴 urgente |
| 2.* | Sidebar: Admin BD muerto, gateo por nombre de rol, City Ledger mal ubicado, catálogos sin agrupar, 3 listas con drift | UI+circuito | ❌/⚠️ |
| 3 | Autogestión de usuario: circuito inexistente | circuito | ❌ |
| 4 | `locations`: hueco de circuito + decisión multi-sucursal sin resolver | circuito+decisión | ❌ |
| 5.* | Reservas: sin `location_id`, sin snapshot de recurso, sin reserva por tipo | decisión (mayormente) | ⚠️ |
| 6.* | Housekeeping: condición de habitación inexistente, sin stayover, ownership roto, sin unicidad | circuito+(a)+(b) | ⚠️ |
| 7.* | CRM: contacto de escritura única, tags sin lectura, walk-in bloqueado, política de facturación mal ubicada | circuito+(a) | ⚠️ |
| 8.* | Tarifas: 2 de 3 modos y 3 de 5 scopes inalcanzables desde UI; sin vigencia temporal | circuito+decisión | ❌ |
| 9.* | Roles: circuito ciego (sin legibilidad, sin reversibilidad, sin auditoría visible) | circuito+(a) | ⚠️ |
| 10.* | Superadmin: suspensión no aplica, actor de auditoría inestable, alta produce tenant sin acceso, downgrade roto, `industry_key` inescribible, sin baja | circuito, 2 de severidad alta | ❌ |
| 11.* | Reportería: 6 endpoints sin UI, "Reportes" es explorador de API, denominador inconsistente, purge sin gobernanza | circuito+(a) | ⚠️/❌ |
| 12.* | Audit log: sin consumidor, sin feed global, cobertura desigual, nunca entró al roadmap | circuito | ❌ |
| 13 | Dead-letter: drift de contrato de 5 días (backend ya resolvió, frontend no lo consume) | drift | ⚠️ |
| 14.* | Maintenance windows: decisión de reportería no declarada (OOO vs OOS), histórico construido y sin consumidor | (b)+circuito | ⚠️ |

---

## 16. Meta-hallazgo — cobertura tras las 5 rondas

De los **34 prefijos de ruta reales** identificados en la primera ronda
(`docs/pendientes-2026-09-12.md`), esta consolidación cubre, entre las 5
rondas: `admin`, `password-resets`, `companies` (parcial), `auth`/me,
`business/modules`, `business/plan-limits` (parcial), `resources`
(parcial), `locations`, `reservations`, `customers`, `rate-catalog`,
`users`+`invitations` (parcial), `roles`, `products`+`orders` (parcial),
`waste-reasons`/`consumption-destinations`, `bookable-services` (parcial),
`business-profile`, `business/context` (parcial), `invoices` (parcial),
`audit-log`, `reports`, `system`, `housekeeping`, `maintenance-windows`,
`stays` (parcial), `accounts-receivable` (tangencial), `cash-register`
(nombrado, no auditado a fondo), más los flujos de `/superadmin`.

**Todavía sin auditar, ninguna ronda las tocó**: `cancellation-policies`,
`categories`, `business-hours`, `login`/`customer` (portal, más allá del
perfil), `invitations`, y el detalle fino de `accounts-receivable`/
`cash-register` como circuitos propios (solo se tocaron tangencialmente vía
el hallazgo del City Ledger).

**Repetido en 3 de las 4 rondas paralelas, sin que nadie lo haya pedido
así — patrón, no coincidencia**: el circuito se construye hasta el
historial/auditoría y se detiene justo ahí. Pasa en housekeeping
(`isOutOfService` muerto, sin audit), en CRM (altas/bajas sin auditar), en
roles (desactivar sin auditar, catálogo sin legibilidad), en superadmin
(audit log write-only, actor inestable), en audit-log en sí (cero
consumidores), y en maintenance-windows (histórico con cliente HTTP ya
escrito, sin pantalla). Vale la pena leerlo como una sola causa transversal
— "el historial no es prioridad de producto todavía" — no como 6 hallazgos
sueltos.

---

## 17. Próximos pasos sugeridos (orden, no decisión)

No decidido por este documento — orden lógico según lo que cada ronda
señaló como dependencia:

1. **Los 2 bugs activos (§1)** no dependen de ninguna decisión — son
   reparables ya, cada uno un cambio acotado de frontend.
2. **P1 (suspensión que no corta acceso) y P2 (actor de auditoría
   inestable)** del circuito de superadmin son los dos hallazgos de mayor
   severidad de todo el documento fuera de los bugs — no dependen de
   decisión de negocio tampoco (P1 es una línea faltante, P2 es persistir
   un campo que ya viaja en el token).
3. El resto son, en su mayoría, decisiones (b) con mecanismo ya resuelto
   por el grounding — el costo real de decidir cada una ya está medido en
   este documento; lo que falta es que el dueño resuelva el residuo
   puntual señalado en cada caso.
4. Cualquier implementación, de cualquiera de estos hallazgos, pasa antes
   por su propio documento de diseño + `architecture-governor` — este
   documento es solo el registro de auditoría, no autoriza nada.
