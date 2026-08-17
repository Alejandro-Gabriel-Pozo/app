# Manual de reglas de negocio de inventario

Para hotelería, gastronomía y e-commerce (con fundamentos de manufactura, sin
la complejidad industrial).

Este manual no es específico de ningún código — son los conceptos que
subyacen a cualquier sistema de inventario razonable en estos rubros. La idea
es que sirva como referencia para decidir reglas de negocio antes de
modelarlas en una base de datos, no al revés.

**Origen:** pegado por el dueño en el chat el 15/08/2026 (referenciado en
`pendientes-2026-08-15.md` sección D2, sin persistir en ese momento — quedó
como pendiente "pedir que lo repita si se retoma"). Persistido acá el
16/08/2026 al retomar el carve-out de `inventario/` (ver
`arquitectura-monolito-modular.md` sección 4, paso 5).

---

## 1. Conceptos fundamentales

Todo sistema de inventario, sin importar el rubro, distingue estos tres
números para un mismo ítem — confundirlos es la fuente más común de bugs:

- **Stock físico (on hand):** lo que hay de verdad en el depósito/cocina/
  góndola en este momento.
- **Stock disponible (available):** stock físico menos lo que ya está
  comprometido con pedidos que todavía no se entregaron.
- **Stock comprometido/reservado (committed):** lo que ya se prometió a un
  pedido confirmado pero aún no se descontó físicamente.

`disponible = físico − comprometido`. Un sistema que solo tiene un número
("stock") y no distingue estos tres conceptos tarde o temprano vende algo
que no tiene, o bloquea una venta que sí podría hacer.

**Unidades de medida:** un ingrediente puede comprarse en una unidad (kg de
carne) y consumirse en otra (porción de 180g). El sistema necesita un factor
de conversión por ingrediente, no asumir que "1 unidad de compra = 1 unidad
de consumo".

**El stock como historial de movimientos, no como un número que se pisa:**
la forma robusta de modelarlo no es una columna `stock = 45` que se
sobreescribe, sino una tabla de movimientos (`stock_movements`) donde cada
fila es un hecho inmutable (+10 por compra, −2 por venta, −1 por merma) y el
stock actual es la suma. Esto da trazabilidad completa: siempre podés
reconstruir "por qué el stock de X es 45" mirando el historial. Es más caro
de implementar que una columna mutable, pero es lo que evita que un bug
silencioso deje el número mal sin forma de auditar qué pasó.

## 2. Tipos de movimiento de stock

Cada movimiento debería tener un motivo explícito (no solo un signo +/−),
porque el motivo determina qué reglas aplican:

| Tipo | Ejemplo | ¿Reversible? |
|---|---|---|
| Compra / ingreso | Llega mercadería del proveedor | — |
| Venta / consumo | Se confirma una orden, se descuenta receta | Solo si no se preparó/entregó aún |
| Merma | Venció, se rompió, se quemó en cocina | No (es una pérdida real) |
| Ajuste de conteo | El conteo físico no coincide con el sistema | No (corrige la verdad, no la explica) |
| Transferencia | De depósito central a la barra | Es un par: −en origen, +en destino |
| Devolución de cliente | Se devuelve un producto sin abrir (e-commerce) | +ingreso, con motivo propio |

Mezclar "venta" y "merma" bajo un solo motivo genérico es el error más
común — sin esa distinción no podés calcular después cuánto perdés por
mermas versus cuánto vendés, que es justo la pregunta que el dueño de un
restaurante necesita responder.

## 3. BOM (Bill of Materials) aplicado a gastronomía: la receta

En manufactura, un BOM dice "para fabricar 1 silla necesito 4 patas + 1
asiento + 8 tornillos". En gastronomía es exactamente lo mismo con otro
nombre: la receta.

- **Multi-nivel:** una hamburguesa no descuenta "hamburguesa" del stock —
  descuenta pan + carne + queso + salsa. Y la salsa puede ser a su vez una
  sub-receta (una preparación interna que combina 4 ingredientes crudos).
  Esto es un BOM de dos niveles: producto vendible → sub-receta →
  ingredientes crudos. El sistema necesita poder "explotar" la receta
  completa hasta llegar a los ingredientes que sí se compran y se cuentan.
- **Rendimiento (yield):** 1kg de carne cruda no rinde 1kg de carne
  servida — rinde menos por cocción, descarte, desperdicio de corte. Si la
  receta no contempla el rendimiento real, el costo calculado por plato
  queda subestimado y el margen que ve el dueño es ficticio.
- **Costeo de receta:** costo del plato = suma de (cantidad de cada
  ingrediente × costo unitario) ajustado por rendimiento. Esto es lo que
  permite calcular el margen real de cada plato del menú — sin esto, fijar
  precios es a ojo.

## 4. El patrón reserva → confirmación → consumo

Patrón central, vale la pena nombrarlo con precisión:

1. **Reserva (soft commit):** el pedido existe pero todavía no se
   garantiza — ejemplo, un carrito de e-commerce, o una orden en borrador.
   No debería bloquear stock todavía, o bloquearlo solo temporalmente con
   expiración.
2. **Confirmación (hard commit):** el pedido se confirma y ahí sí se
   compromete stock de forma firme. Es el punto de no retorno operativo —
   a partir de acá, cocina empieza a preparar, o el depósito empieza a
   picking.
3. **Consumo físico real:** el ingrediente se usa de verdad — se cocina,
   se empaqueta, se entrega.

Punto clave que suele generar confusión: el momento en que baja el stock
(paso 2, confirmación) no tiene por qué coincidir con el momento en que se
cobra. Son dos procesos independientes que pueden desacoplarse en el
tiempo — en un restaurante, el consumo físico pasa mucho antes que el
cobro (se come primero, se paga después). El inventario se rige por "¿se
usó el bien?", no por "¿se cobró?". Tratar el cobro y el consumo como el
mismo evento es la raíz de bugs de stock en sistemas de restaurante.

## 5. Reversión de movimientos: cuándo restaurar stock y cuándo no

Regla de oro, sin excepciones: se restaura stock solo si el bien físico no
se llegó a usar.

- Se canceló un pedido antes de que saliera de cocina / antes de que se
  hiciera picking → restaurar es correcto, no se usó nada.
- Se canceló un pedido después de que el plato se sirvió y se comió, o el
  paquete salió del depósito → nunca restaurar stock, aunque la
  cancelación sea por un problema de cobro, de logística, o de lo que
  sea. El bien ya no existe físicamente. Lo que hay que resolver ahí es
  un problema financiero (¿cómo se cobra o se da de baja esa deuda?), no
  de inventario.

Para que un sistema pueda aplicar esta regla necesita que el modelo de
estados distinga "se usó físicamente" de "se cobró/se cerró". Si el modelo
de estados solo tiene algo como `CONFIRMED → CANCELLED` sin ningún estado
intermedio que marque "ya se entregó/sirvió", el sistema no tiene
información suficiente para decidir si corresponde restaurar o no — y ahí
la pregunta correcta no es "qué regla de código escribo" sino "en la
operación real, ¿puede pasar que se cancele algo después de haberse
consumido?". Si la respuesta es sí, hace falta un estado o un flag nuevo
antes de escribir la regla; si la respuesta es no (porque el negocio nunca
cancela algo ya servido, siempre lo resuelve por otro lado), la regla
simple es válida y no hace falta modelar nada más — pero es una decisión
de negocio explícita, no algo que el código deba asumir solo.

## 6. Mermas y ajustes

Las mermas necesitan tratamiento propio, separado de las ventas:

- **Vencimiento:** venció antes de venderse — motivo `expired`.
- **Rotura/error de preparación:** se quemó un plato, se rompió un
  producto — motivo `waste_prep` o similar.
- **Faltante de conteo:** el conteo físico da menos que el sistema —
  motivo `count_adjustment`, y normalmente dispara una revisión (¿error de
  registro, robo, error de recetas?).

Cada ajuste de este tipo debería guardar quién lo hizo y por qué (aunque
sea un motivo de una lista corta) — es lo que permite auditar después si
las mermas son razonables o si hay un problema sistemático.

## 7. Particularidades por rubro

**Gastronomía:**
- Ingredientes perecederos, BOM multinivel (recetas y sub-recetas),
  rendimiento variable por preparación.
- La venta y el consumo son casi simultáneos (se cocina al pedido) — no
  hay "reposición en el momento" como en retail.
- El costo real de un plato puede diferir bastante del costo teórico por
  variación de rendimiento — vale la pena poder comparar ambos.

**Hotelería (minibar, amenities, insumos de housekeeping):**
- Se parece más a retail tradicional: reposición periódica, conteo
  físico como fuente de verdad frecuente (a diferencia de un restaurante,
  donde el conteo es menos frecuente porque el flujo es más rápido).
- El consumo muchas veces no se registra en el momento (el huésped toma
  algo del minibar sin que nadie lo vea) — el conteo físico corrige lo
  que el sistema no captó.

**E-commerce:**
- Reserva de stock al iniciar el checkout, típicamente temporal y con
  expiración (si el cliente no completa el pago en X minutos, se libera
  la reserva).
- Dos escuelas sobre cuándo descontar stock de verdad: al confirmar el
  pago, o al despachar el pedido. Ninguna es "la correcta" — depende de
  qué tan ajustado esté el stock y qué tan grave sea prometer algo que
  después no se puede despachar.
- Backorder: vender algo que no hay stock ahora pero sí se sabe que va a
  haber — requiere modelar "disponible para prometer" (available-to-
  promise) distinto de "disponible ahora".
- Multi-almacén: qué depósito sirve qué pedido según cercanía/
  disponibilidad — agrega una capa de "¿de dónde sale esto?" que
  gastronomía y hotelería normalmente no tienen (todo sale de un solo
  lugar).

**Industrial (mencionado solo para contraste, no aplica directo a este
caso):**
- Órdenes de producción con lead time, MRP (planificación de
  requerimiento de materiales) que calcula qué comprar según demanda
  proyectada.
- Es el origen del concepto de BOM, pero la complejidad de planificación
  a futuro no suele hacer falta en un restaurante u hotel de escala
  chica/mediana — ahí alcanza con punto de reorden simple (alertar
  cuando el stock baja de X).

## 8. Multi-ubicación / multi-depósito

Un mismo ingrediente puede vivir en más de un punto de consumo: cocina,
barra, depósito central. Esto agrega una dimensión más al modelo — el
stock no es solo "cuánto hay", es "cuánto hay dónde".

Las transferencias entre ubicaciones son un tipo de movimiento propio, no
un ingreso ni un egreso puro: son un par simétrico (−N en origen, +N en
destino) que debería registrarse como una sola operación atómica, no como
dos movimientos independientes que podrían quedar inconsistentes si uno
falla.

Esto solo hace falta modelarlo si el negocio realmente tiene más de un
punto de consumo con conteo independiente — si todo el stock de bebidas
vive en un solo lugar físico, no hace falta esta complejidad todavía.

## 9. Idempotencia y concurrencia

Dos problemas técnicos que son casi universales en sistemas de inventario:

- **Idempotencia:** cualquier evento que dispare un movimiento de stock
  (confirmar una orden, procesar un pago) necesita una clave que
  garantice que, si el evento se procesa dos veces por error (reintento,
  duplicado), el stock no se descuenta dos veces. La clave natural suele
  ser el ID de la entidad que originó el movimiento (ítem de orden, línea
  de pedido).
- **Concurrencia:** dos operaciones simultáneas descontando el mismo
  ingrediente (dos comandas al mismo tiempo pidiendo el último bife)
  necesitan una transacción atómica a nivel de fila (`UPDATE ... WHERE
  stock >= cantidad`) en vez de "leer el stock, decidir, escribir" — ese
  patrón de leer-y-luego-escribir es donde aparecen las condiciones de
  carrera clásicas que venden más de lo que hay.
- **Reintentos automáticos:** una mutación de stock que puede fallar por
  una razón de negocio real (no hay stock suficiente) nunca debería
  reintentarse automáticamente sin límite — un reintento automático no
  resuelve "no hay stock", solo repite el mismo fallo indefinidamente. Ese
  tipo de fallo necesita resolverse de forma síncrona, antes de
  comprometerse a la operación, o con intervención manual — no con un
  reintento en background.

## 10. Métricas que un sistema de inventario debería poder responder

- Stock disponible en tiempo real por ingrediente/producto.
- Punto de reorden / stock mínimo, con alerta cuando se cruza.
- Porcentaje de merma por período (y por motivo — vencimiento vs rotura
  vs faltante de conteo cuentan historias distintas).
- Costo de mercadería vendida (COGS) teórico vs real: el teórico sale de
  sumar recetas × ventas; el real sale del conteo físico. La diferencia
  entre ambos es la métrica que detecta problemas — mala preparación,
  porciones más grandes de lo recetado, robo, mermas no registradas. Sin
  poder comparar ambos números, no hay forma de saber si el negocio está
  perdiendo plata por inventario sin que se note en ningún reporte.

## 11. Preguntas para resolver como negocio antes de modelarlas en código

Este manual da el marco, pero las respuestas son tuyas, específicas de
cómo opera tu negocio real:

- ¿El modelo de estados de una orden necesita distinguir "ya se sirvió/
  entregó" de "se cobró", o en tu operación eso nunca genera ambigüedad?
- ¿Vas a trackear mermas como su propio tipo de movimiento desde el día
  uno, o por ahora alcanza con no descontar "de más" y dejar mermas para
  más adelante?
- ¿Hay más de un punto de consumo físico (cocina/barra/depósito) que
  necesite stock separado, o todo vive en un solo lugar por ahora?
- ¿Vas a necesitar comparar COGS teórico vs real en algún momento
  cercano, o es una métrica para más adelante?

Las respuestas a esto son las que le llevás de vuelta a la
implementación — no hace falta resolver todo de una, pero sí tenerlo
nombrado para no descubrirlo como bug en producción.

---

## Respuestas ya dadas contra este código (16/08/2026)

Registro de qué preguntas de la sección 11 (y otras del manual) ya tienen
respuesta real, para no volver a preguntarlas:

- **"¿Servido" vs "cobrado"?** Sí hay ambigüedad real, ya resuelto:
  `orders.served_at` (schema v6, BLOQUE 14, 15/08/2026), independiente de
  `status`. `cancelOrder()` restaura stock solo si `previousStatus ===
  'CONFIRMED' && !wasServed` — regla de oro de la sección 5 de este
  manual, ya implementada antes de que este archivo se persistiera.
- **¿Mermas desde el día uno?** Sí — confirmado 16/08/2026, tipo de
  movimiento propio (`WASTE`), no una categoría de `ADJUSTMENT`. Ver
  `pendientes-2026-08-16.md` (carve-out de `inventario/`, Fase 2).
- **¿Más de un punto de consumo?** Sí, real, con transferencias — no es
  "reservar el campo para después". Ver Fase 1 del carve-out.
- **¿COGS teórico vs real cercano?** No — pospuesto explícitamente
  (`pendientes-2026-08-15.md` D2), con la condición de que `recipe_items`
  (Fase 3 del carve-out) guarde costo por ingrediente + rendimiento desde
  que se implemente la receta, aunque el cálculo de COGS en sí no se
  construya todavía — así no hay que remodelar cuando se retome.
- **Multinivel de recetas** (sección 3) — confirmado 16/08/2026: sí, una
  receta puede tener como ingrediente otra receta/sub-producto. La
  explosión de stock al confirmar una orden es recursiva — necesita
  prevención de ciclos (una receta no puede referenciarse a sí misma,
  directa ni indirectamente).
