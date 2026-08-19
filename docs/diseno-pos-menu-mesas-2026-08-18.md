# Diseño POS-Menu: Mesas, Booking Mode, Canal de Venta y Límites de Plan

> Documento de trabajo recibido del dueño (18/08/2026, noche) — consolida
> las preguntas de diseño abiertas hasta ahora. No es una decisión final,
> es la base para seguir charlando cada punto. Copiado tal cual al repo
> para que no se pierda (mismo criterio que
> `referencia-mejoras-pms-2026-08-18.md`). Nada de esto está implementado
> todavía — es backlog de diseño, ver `pendientes-2026-08-18.md` punto O
> y `roadmap-pms-multirubro.md` sección "Complemento F&B" para el estado
> de seguimiento.

## 1. Modelo de Mesas

**Decidido:**
- Categoría = nombre del restaurante / rubro gastronómico. Recursos = mesas (Mesa 1, Mesa 2, ...). Reusa el patrón categoría/recurso que ya existe para alojamiento, con comportamiento distinto.
- Una mesa **no** agrupa varias órdenes simultáneas: 1 apertura de mesa = 1 orden viva (`DRAFT`/`CONFIRMED`), desde que se abre hasta que se cierra.
- Es la reserva/estadía del huésped la que agrupa varias órdenes en distintos momentos (ya soportado hoy vía `Order.stayId`) — no la mesa.
- El estado de la mesa (abierta/cerrada) no necesita persistirse: se puede derivar de si existe una `Order` viva (`DRAFT`/`CONFIRMED`) con ese `resourceId`.

**Gap técnico identificado:**
- `Order` hoy no tiene `resourceId`. Hay que agregarlo (nullable, FK a `resources`) para poder asociar una orden a una mesa concreta.

## 2. Booking Mode (tipo de categoría)

**Problema:** `resource_categories.is_lodging` es un booleano — separa alojamiento del resto, pero "el resto" no es un solo comportamiento (mesa de restaurante ≠ turno de spa/barbería).

**Decidido:**
- `booking_mode` no debe ser un enum fijo (2 o 3 valores hardcodeados) sino un catálogo extensible a nivel plataforma — no se sabe cuántos modos van a terminar existiendo.
- La reserva anticipada de una mesa probablemente **no es un booking_mode nuevo**, sino una capacidad combinable con la categoría de mesas: una mesa puede ser reservable o no, independientemente de que además soporte "orden en vivo" walk-in. Cuando llega quien reservó, la reserva se convierte en la apertura de mesa.
- **Pendiente de confirmar:** si `booking_mode` describe un solo comportamiento por categoría, o si una categoría combina capacidades independientes (reservable: sí/no + admite orden en vivo: sí/no).

## 3. Solapamiento walk-in vs. reserva de mesa

**Problema de negocio (el más difícil de esta ronda):** alguien reserva una mesa a las 21:00; llega un walk-in a las 20:00 y quiere sentarse en esa misma mesa porque es la única disponible. Si el walk-in se queda más de lo esperado, se solapa con la reserva.

**Política elegida:** combinación de dos enfoques —
1. **Buffer de seguridad antes de la reserva:** el sistema no ofrece la mesa a walk-ins dentro de una ventana previa a la reserva, calculada con una duración estimada de mesa (configurable por categoría). Técnicamente reusa el motor que ya existe para turnos (`resource_locks` + `duration_minutes` + lógica de `resolveOccupyingReservations`), aplicado también a mesas.
2. **Alerta al staff:** contador/aviso visual en el panel de mesas cuando se acerca el horario de una reserva sobre una mesa todavía ocupada, para que el mozo/anfitrión gestione la liberación o reubicación a tiempo.

**Tolerancias a definir (los tiempos concretos quedaron aceptados, pendiente de escribirlos como default configurable):**
- Tolerancia de llegada temprana a una reserva (si la mesa está libre, ¿se puede sentar antes?).
- Tolerancia de llegada tardía / grace period (cuánto se guarda la mesa antes de liberarla y marcar "no-show").

## 4. Analítica de mesa (byproduct de los timestamps)

Los mismos timestamps de apertura/cierre de mesa que hacen falta para la política de solapamiento (punto 3) sirven, sin trabajo adicional, para análisis de negocio:

- Tiempo real de mesa por apertura (`confirmed_at`/`completed_at` + `resourceId` nuevo).
- Cruzado con `order_items` (ya existen `productId`, `quantity`, `subtotal` por línea) → qué se pidió en ese tiempo.
- Ejemplo de pregunta que esto responde: ¿conviene seguir vendiendo entradas o dar cortesía y enfocar la venta en platos principales?, según tiempo de permanencia y qué se pide.
- Encaja con la decisión ya tomada de reportería propia por fórmulas (sin IA) — es una consulta de agregación, no algo que requiera IA en tiempo real.
- Nota: `occupancy_records` (tabla ya existente) es de granularidad diaria (`resource_id + date`) — no sirve para este caso, que necesita el detalle de cada apertura de mesa individual. Son datos complementarios, no reemplazables entre sí.

## 5. Canal de venta / punto de venta (gap recién identificado)

**Problema:** hoy `Product` tiene nombre, precio base, SKU, descripción, gestión de stock por variante, stock actual, alerta mínima, y `productType` (`RAW_MATERIAL` / `COMPOSITE` / `RETAIL`). Pero no existe ningún campo que distinga **dónde/cómo se vendió** un producto.

Caso concreto: un negocio vende gastronomía en mesas, pero también tiene una vitrina de productos regionales que se vende por mostrador, sin pasar por una mesa. Hoy, con `Order.resourceId` siendo opcional (mesa), un `resourceId = null` sería ambiguo: no se distingue entre "venta de mostrador por diseño" y "se olvidaron de cargar la mesa" (o un cargo directo a la habitación sin pasar por mesa).

**Pendiente de definir:**
- ¿Un campo explícito de canal de venta en `Order` (ej. `salesChannel: 'MESA' | 'MOSTRADOR' | 'HABITACION' | ...`), en vez de inferirlo de si `resourceId` es null?
- ¿Ese canal también debería catalogarse a nivel plataforma (mismo criterio que `booking_mode`), en vez de ser un enum fijo?
- ¿Cómo se reporta esto por separado en la reportería propia (ventas por mesa vs. ventas de mostrador)?

## 6. Límites de plan (negocio, categorías)

**Definido:**
- "Negocio" = propiedad (unidad física/establecimiento), no un tipo de servicio. El plan Enterprise habilita tener más de un negocio (multi-propiedad).
- Dentro de un mismo negocio, el plan también debería limitar **cuántas categorías de cada tipo** se pueden crear (ej. plan básico: 1 categoría alojamiento + 1 categoría restaurante). Objetivo: evitar que alguien use categorías separadas como sustituto de pagar el plan multi-negocio (ej. separar "restaurante" de "confitería" por franja horaria para operar como si fueran 2 sucursales).

**Conexión con decisión previa:** mismo patrón que la idea de vender asientos de usuario/rol por cantidad (no solo on/off) — el plan no es solo "qué features tenés", es "cuántas unidades de cada cosa podés crear". Sugerido: diseñar la estructura de límites por plan de forma genérica desde el arranque (tabla de límites: `max_negocios`, `max_categorias_por_negocio`, `max_categorias_por_booking_mode`, `max_asientos_por_rol`, etc.) en vez de campos hardcodeados por cada límite nuevo que aparezca.

---

## Preguntas abiertas para la próxima ronda

1. ¿`booking_mode` es un valor único por categoría, o una categoría combina capacidades independientes (reservable / admite orden en vivo)?
2. Números concretos de tolerancia (llegada temprana y grace period de llegada tardía) — quedaron aceptados en concepto, faltan como default configurable.
3. ¿Cómo se modela el canal de venta (`salesChannel`) y se catalogiza (fijo vs. extensible a nivel plataforma)?
4. Estructura genérica de límites de plan — definir el catálogo completo de dimensiones a limitar, no solo negocios/categorías.
