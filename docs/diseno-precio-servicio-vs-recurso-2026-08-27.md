# Diseño — El precio vive en el servicio, no en el recurso (paso 0 de C1-A)

**Fecha:** 27/08/2026. Sesión de diseño, sin código.

Surgió mientras se definía `UNITS` para la seña (C1-A, ver
`diseno-sena-unidades-c1a-2026-08-27.md`): el blocker de ese ítem resultó ser
un problema de modelado de precio que estaba abajo. Este documento es el
prerequisito; el de seña es lo que se desbloquea.

---

## 1. El principio (planteado por el dueño, 27/08/2026)

> "Te cobro la estadía, no la habitación. El mismo razonamiento por el que un
> producto en POS tiene precio y el insumo que lo compone no necesariamente."

El recurso **habilita**; lo que se vende es el servicio. La habitación, la
silla de peluquería o la mesa son capacidad, no producto. En el valor del
servicio está incluida la habitación, pero el servicio compone más cosas que
solo la habitación.

**Esto no es una idea nueva en el repo: es la regla ya escrita, aplicada a
dos de los tres rubros y rota en el tercero.**

Evidencia en los ejemplos de la propia API (`src/openapi/spec.ts` ~línea 180):

| Ejemplo | `basePrice` |
|---|---|
| Mesa de restaurante | **0** |
| Silla de peluquería | **0** |
| **Cabaña** | **15000** |

Y en `docs/logica-recursos-categorias-reservas.md` (~línea 180): *"MANAGEMENT
crea recursos lógicos (servicios): 'Corte', 'Tintura', 'Permanente', cada uno
con su `duration_minutes` y su `base_price`"* — el precio en el servicio.

**Dónde nació la deriva:** ese mismo documento tiene como pregunta abierta #1
*"¿Un negocio sin servicios (ej. hotel con habitaciones) necesita recursos
físicos? → Probablemente no."* Ahí quedó instalado "hotel = negocio sin
servicios", y de ahí que la habitación tuviera que llevar el precio.

**Matiz que completa la analogía del POS:** el insumo no tiene *precio de
venta*, pero sí tiene *costo* (valuación de inventario). Traducido: el recurso
puede legítimamente tener una noción de costo, nunca de precio de venta. Hoy
`resources.base_price` es un precio de venta y se lee como tal (último escalón
de la cascada). La conclusión no es "borrar la columna" (es `NOT NULL`, y la
convención `0` ya existe para mesa y silla) sino **dejar de leerla como precio
de venta**.

---

## 2. Los tres ejes del modelo — todos ya construidos

Confirmado contra `schema.sql` el 27/08/2026. El dueño planteó el caso "un
hotel con estadía con desayuno y sin desayuno, distinto precio, y esa estadía
bloquea siempre determinada agenda" — los tres ejes ya existen:

| Eje | Dónde vive | Qué distingue |
|---|---|---|
| **Qué se vende / sobre qué categoría** | `bookable_services` (`category_id` NOT NULL, `duration_minutes`, `booking_mode`) | Estadía Estándar vs. Suite. Tour Cascada vs. Ciudad |
| **Variante comercial del mismo servicio** | `rate_plans` (`service_id` NOT NULL, `price`, `includes_breakfast`, `valid_from/to`, `cancellation_policy`) | Con desayuno vs. sin. Temporada alta vs. baja. No reembolsable |
| **Qué agenda consume al reservarse** | `resource_locks` (pivote servicio → recursos) | La estadía toma la habitación; el tour toma el guía y la camioneta |

Cascada de precio (`ReservationPricingService.resolveUnitPrice()`): tarifa
especial de cliente+servicio > **rate plan elegido** > precio de catálogo del
servicio > tarifa especial de cliente+recurso > `resource.base_price`. El rate
plan **reemplaza** el precio unitario (es absoluto por noche), no lo modifica.

**Límite exacto de `resource_locks`:** bloquea recursos **concretos por ID**,
no "uno cualquiera de la categoría X". Si la estadía siempre ocupa *el*
comedor, o el tour siempre lleva *la* camioneta, está resuelto. Si hace falta
"un guía cualquiera de los tres", no llega. Es asimétrico: el recurso
**principal** sí puede resolverse por pool
(`findAvailableResourceInCategory`, el checkbox "cualquier recurso
disponible"), los **bloqueados** no. Spa con tres terapeutas y tour con dos
guías son los casos donde eso aparece primero.

### Criterio para cargar datos sin equivocarse

> **Si cambia qué recurso se ocupa, o por cuánto tiempo → es otro servicio.**
> **Si solo cambia cuánto cuesta o qué incluye → es un rate plan.**

Contra los casos reales: suite vs. estándar ocupan recursos distintos → dos
servicios. Con desayuno vs. sin ocupan la misma habitación las mismas noches →
un servicio, dos rate plans. Tour privado vs. grupal consume guía dedicado vs.
compartido → dos servicios. Corte vs. corte+barba cambia la duración → dos
servicios.

Así la grilla no explota en el schema: 4 tipos de habitación × 3 planes =
**4 servicios + 12 filas de `rate_plans`**, que es carga de datos, no
estructura nueva. Es la grilla clásica de un PMS: tipo de habitación × plan →
precio.

**Corrección registrada:** en la primera pasada de esta sesión se dijo que
"con desayuno / sin desayuno" necesitaría más *servicios*. Es incorrecto — es
un `rate_plan`, y `includes_breakfast` es literalmente una columna de esa
tabla.

---

## 3. El bug: las reservas de alojamiento no mandan `serviceId`

Tres síntomas de la misma raíz.

**1. El front asume que el servicio es opcional, y lo dice.** El alta manda
`...(form.serviceId && { serviceId: form.serviceId })`
(`appfrontend-main/src/app/dashboard/reservas/page.tsx`). El comentario de al
lado es explícito: *"check-in/check-out por día calendario es el caso por
defecto, se elija o no un 'servicio' puntual"*, con "servicio" entre comillas.
El modelo mental de esa pantalla es "la reserva es una habitación, el servicio
es un extra opcional" — el modelo invertido, escrito.

**2. Sin servicio no hay cálculo por noche.**
`units = service?.bookingMode === 'block' ? calculateNights() : 1`. Sin
servicio la estadía entera se cotiza como **una línea plana** al `base_price`
de la habitación: una noche y diez noches salen lo mismo.

**3. Sin servicio también se cae "cualquier recurso disponible" (K4).** El
checkbox manda `categoryId: selectedService.categoryId` — sale del servicio.
Sin servicio no hay `selectedService`, cae a `resourceId` y la funcionalidad
desaparece en silencio.

### Las dos superficies se comportan distinto (verificado 27/08/2026)

Revisión pedida por el dueño: *"del lado del cliente no hay nada, entonces hay
que modelarlo, y revisar la parte del operario porque me parece que del lado
del operario sí existe"*. Confirmado — son dos historias distintas.

**Operario (dashboard) — sí hay modelado.** El selector etiqueta los servicios
de alojamiento: `{s.name}{s.bookingMode === 'block' ? ' (alojamiento — por
noche)' : ''}`. Y el selector de tarifa muestra `"Precio de catálogo ($X)"` más
cada rate plan con su precio.

> **Test de 10 segundos para cerrar el hilo abierto de la sección 5, sin tocar
> la base:** abrir el alta y mirar el desplegable "Servicio". Si dice
> **"Estadía (alojamiento — por noche)"**, el servicio está bien configurado y
> el bug es de USO (sale bien cuando se elige, mal cuando no). Si dice
> "Estadía" a secas, el servicio no es `block` y el paso 0 arranca por
> corregirlo.

**Causa raíz del lado del operario, escrita en la pantalla:** el label del
campo es **"Servicio (opcional)"** y su primera opción es literalmente
**"Sin servicio — horario libre"**. El operario no se olvida: la pantalla le
ofrece "sin servicio" como opción normal, con nombre amable. Esa opción se
diseñó para *"quiero poner las horas a mano"*, y su efecto colateral es apagar
el precio por noche, los rate plans y K4. Un afordance hecho para una cosa que
hace otra sin decirlo.

**Ninguna de las dos pantallas muestra un TOTAL antes de crear.** El operario
ve el precio por noche; el total recién aparece en el listado, ya creada la
reserva.

**Cliente (portal) — no muestra un precio ausente: muestra el equivocado.** La
pantalla de disponibilidad arma una tarjeta por habitación con
`${r.basePrice.toLocaleString('es-AR')}` y un botón "Reservar". Sin servicio,
sin plan, sin noches, sin total — **el portal le vende el recurso al huésped,
literalmente**. La pantalla de "mis reservas" del portal hace lo mismo.
(`appfrontend-main/src/app/portal/[businessSlug]/disponibilidad/page.tsx` ~149;
`.../cuenta/reservas/page.tsx` ~411.)

Es la encarnación exacta del modelo invertido, en la única superficie que ve un
cliente real.

### 🔴 Consecuencia no contemplada: el paso 0 rompe el portal

**Si `resources.base_price` pasa a `0` por convención (como mesa y silla), el
portal le anuncia "$0" a todos los clientes.**

Y no alcanza con cambiar qué campo se muestra: el contrato de disponibilidad
del portal también es centrado en el recurso, así que exponer el precio
correcto implica que devuelva servicios y rate plans, no habitaciones con
precio.

Quedan **tres** órdenes de trabajo donde el plan original tenía uno:

| | Qué es | Tamaño |
|---|---|---|
| **Dashboard** | Sacar "Sin servicio" para alojamiento, campo obligatorio | Chico |
| **Backend** | Guard ruidoso + eliminar el fallback a `base_price` | Chico |
| **Portal** | Re-modelar qué se ofrece y a qué precio: hoy vende recursos | **Grande, no estaba contemplado** |

### Son DOS caminos de alta, no uno

`POST /api/customer/me/reservations` (portal del cliente) es un segundo
camino, con su propio `CreateCustomerReservationSchema` donde `serviceId`
también es `.optional()` (`src/api/routes/customer.routes.ts` ~línea 190). En
el portal el "sin servicio" **es una opción explícita del selector**, con
centinela `NO_SERVICE`, que manda `endTime` suelto
(`appfrontend-main/src/app/portal/[businessSlug]/cuenta/reservas/page.tsx`
~línea 149).

**Segunda ocurrencia del mismo modo de falla.** El docblock de
`customer.routes.ts` cuenta la primera: *"Este es el único flujo de reserva
real hoy en producción — antes nunca mandaba serviceId, así que
`resource_locks` quedaba inerte pese a que el motor de bloqueo ya
funcionaba"*. Misma forma: una feature construida queda muerta porque el alta
no manda el dato. Se arregló en el portal y no en el dashboard. Un guard en el
servicio (no en cada ruta) es lo que lo cierra para siempre.

### El scope "solo alojamiento" es correcto, y por una razón concreta

Exigir `serviceId` en todos los rubros **rompería restaurante**: una reserva
de mesa legítimamente no tiene servicio, y su recurso tiene `basePrice: 0` a
propósito (es el ejemplo canónico de la API). El guard va sobre
`resource_categories.is_lodging`, que es justo el dato que
`ReservationPricingService` ya recibe vía `ICategoryRepository`.

### El riesgo del arreglo ingenuo

Si se hace obligatorio el servicio en el alta pero se deja el fallback, se
cambia un precio equivocado **visible** por un cero **invisible**: una reserva
que llegue sin servicio cotiza `basePrice = 0` → `totalPrice = 0` → y
`resolveDepositAmount()` corta temprano con `totalPrice <= 0`, así que
**también se saltea toda la seña**, sin error ni log. R15 (criterios-datos) es
explícito: nunca degradar a `null`, cero o "—". Por eso las dos mitades son
inseparables.

### La trampa del `booking_mode`

`bookable_services.booking_mode` tiene `DEFAULT 'slot'`. Si el servicio
"Estadía" se creó sin fijar `block` explícitamente, mandar `serviceId` **no
cambia nada**: se sigue cotizando como una unidad plana, ahora al precio del
servicio en vez del de la habitación. Mismo síntoma, otro número. Es lo
primero a verificar.

### Reservas ya creadas mal

Quedan con `total_price` plano y una sola línea. Son transacciones: **no
tocarlas con UPDATE** (R12). Para las que sigan abiertas está el camino
sancionado que ya existe — `GET /reservations/:id/price-preview` +
`POST /:id/confirm-price-adjustment`, que recalcula con la cascada actual y
asienta la diferencia con rastro. Para las ya completadas, dejarlas y anotar
la discontinuidad: cualquier reporte que cruce el antes y el después va a
mostrar el escalón.

---

## 4. Paso 0 — plan cerrado (27/08/2026)

| Sub-paso | Verificación antes de seguir |
|---|---|
| **0.a** Revisar los datos de Hotel ZULU: existe "Estadía", es `block`, cuántas hacen falta | Una reserva de prueba de 3 noches cotiza 3× la tarifa, no un monto plano |
| **0.b** Backend: `ReservationService` rechaza ruidosamente una reserva de alojamiento sin `serviceId`; se elimina el fallback silencioso a `base_price` | Los **dos** caminos (dashboard y portal) devuelven error claro, no un total en 0 |
| **0.c** Dashboard: sacar "Sin servicio — horario libre" para alojamiento y dejar el campo obligatorio | Alta completa en navegador con precio por noche correcto |
| **0.c-bis** 🔴 **Portal: re-modelar qué se ofrece y a qué precio** — hoy muestra `resource.basePrice` en disponibilidad y en "mis reservas", y su contrato de disponibilidad devuelve recursos, no servicios. **Sin esto, poner `base_price = 0` le anuncia "$0" a los clientes.** No estaba en el plan original | El huésped ve el precio del servicio/plan y un total por las noches elegidas, no el precio de la habitación |
| **0.d** Reservas históricas: decidir cuáles se ajustan por `confirm-price-adjustment` y cuáles se dejan | Lista explícita, no un barrido |
| **0.e** Anotar deudas nuevas en `pendientes-2026-08-27.md` | — |

**Orden interno: 0.a antes que 0.b.** Si el guard entra antes de que los datos
estén bien, el alta de alojamiento queda bloqueada para el tenant — el error
ruidoso es lo correcto, pero conviene que llegue cuando ya hay un servicio
válido para elegir.

---

## 5. Preguntas de negocio — RESPONDIDAS (27/08/2026, con el dueño)

| Pregunta | Respuesta |
|---|---|
| Al cargar una reserva de 3 noches, ¿qué precio muestra? | **El total de las 3 noches (multiplica)** |
| ¿Cobra igual todas las habitaciones? | **Distinto según el tipo** (estándar / suite / cabaña…) |
| ¿Ofrece variantes de la misma habitación? | **Las tres:** con/sin desayuno, precio por temporada, y tarifas no reembolsables |
| ¿Cuánto de seña le dice a un cliente? | **Una noche** → `UNITS` con `unit_count = 1` |

### ⚠️ La respuesta 1 contradice el reporte del bug — hilo ABIERTO

El reporte del dueño fue *"las reservas de Hostería no están mandando
`serviceId`, y por eso caen al fallback de `resource.base_price`"*. Pero si el
total escala con las noches, esa reserva **sí llevaba `serviceId` con
`booking_mode = 'block'`**.

Verificado que la pantalla **no calcula precio del lado del cliente**:
`nightsCount` solo dibuja la etiqueta "3 noches"
(`appfrontend-main/src/app/dashboard/reservas/page.tsx` ~línea 604), y la
columna Precio del listado muestra `r.totalPrice`, el valor guardado por el
backend. Lo que se ve es real.

**Hipótesis más probable: las dos cosas son ciertas según el caso.** El
`serviceId` es opcional en el alta, así que la reserva sale bien cuando el
operador elige "Estadía" en el desplegable, y sale mal —precio plano, sin rate
plan, sin K4— cuando no lo toca. No hay error: sale un número, el equivocado.

**Eso es peor que "siempre roto".** Un bug constante se descubre el primer día;
uno que depende de si alguien tocó un desplegable produce dos precios distintos
para la misma habitación y las mismas fechas.

**Cómo se cierra:** una consulta de solo lectura contra la base del tenant —
cuántas reservas tienen `service_id IS NULL`, y desde cuándo. **No corrida
todavía** (base de producción de un negocio real, requiere OK explícito del
dueño).

**Impacto en el paso 0 según el resultado:**
- Si la mayoría ya lleva servicio → 0.a se achica a "confirmar que los
  servicios están bien configurados" y 0.d es una lista corta. El guard
  (0.b/0.c) sigue siendo igual de necesario: pasa de "arreglar todo" a
  "impedir que vuelva a pasar".
- Si la mayoría no lo lleva → el paso 0 es como estaba planteado.

### Dato pendiente para dimensionar

Falta la **lista real de tipos de habitación** de la Hostería (estándar /
suite / cabaña / lo que sea) — define cuántos servicios "Estadía X" hay que
crear y cómo se agrupan las habitaciones en categorías.

---

## 6. Deuda anotada — PROMOVIDA el mismo día

Se anotó como "no bloquea C1-A ni `UNITS`, se resuelve cuando duela". Sigue
sin bloquear `UNITS`, **pero las respuestas de negocio de la sección 5 la
volvieron activa**: la Hostería usa hoy las tres variantes (desayuno,
temporada, no reembolsable). Ya no es deuda futura.

- **🔴 Temporada que cruza el rango de la estadía — ERROR DE COBRO VIVO, no
  deuda futura.** `rate_plans.valid_from` / `valid_to` se valida **solo contra
  la fecha de inicio** (simplificación deliberada, documentada en
  `resolveRatePlanPrice()`). Una estadía que entra el 28/02 en temporada alta y
  sale el 5/03 cobra **las seis noches a tarifa alta**. No hay forma de
  expresar otra cosa: todas las líneas de una reserva llevan el mismo precio
  unitario. Es el "motor de tarifas por temporada" que `buildLines()` anticipa
  como estructura pero que no existe como lógica. **Con temporada en uso real
  (confirmado 27/08), esto pasa en cada cruce de temporada.**
- **🟠 El plan no es reutilizable entre servicios — duele ya.**
  `rate_plans.service_id` es NOT NULL con unique `(service_id, name)`: "Con
  desayuno" hay que crearlo una vez por cada tipo de habitación, y renombrarlo
  o cambiarle la política de cancelación son N ediciones. Con lo confirmado el
  27/08 (N tipos × con/sin desayuno × reembolsable/no, cada uno duplicado por
  rango de temporada) son ~2 docenas de filas cargadas a mano. Es el mismo
  problema que las tarifas especiales de cliente ya tuvieron y que se resolvió
  con `rate_catalog` (catálogo reutilizable con referencia viva). El molde
  existe en el repo.
