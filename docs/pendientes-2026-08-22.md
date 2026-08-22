# Pendientes — Sábado 22 de Agosto 2026

Arranca a partir de `pendientes-2026-08-19.md` (que sigue siendo la fuente
completa de lo ya resuelto ese día y este: D1/D2/D3/D5). Este archivo nuevo
existe porque en la sesión de hoy apareció un ítem de verdad nuevo (D9, más
abajo) — mismo criterio que se usó para pasar de `pendientes-2026-08-10.md`
a `pendientes-2026-08-13.md`: arrastra lo que seguía abierto, no repite el
detalle completo de lo ya cerrado (ver el archivo anterior para eso).

---

## C. Decisiones de negocio SIN resolver (arrastradas de 08-19, sin cambios)

Ver `pendientes-2026-08-19.md` sección C para el detalle completo de cada
pregunta — acá solo el resumen para no perder de vista que siguen abiertas.

- **C1** — Seña/depósito como concepto de facturación separado: no existe
  hoy (se factura el total o nada). Sin responder: dónde vive la regla de
  %, si la seña es un comprobante propio, cómo se descuenta del saldo final.
- **C2** — Reglas de cancelación → Notas de Crédito por %: depende de C1 y
  de soporte de NC/ND (no existe). Sin responder: escala de % según
  anticipación, y si aplica sobre el total o sobre la seña.
- **C3** — Modelo de factura ítem único vs. multi-línea: hay un diseño
  propuesto sin implementar (`docs/diseno-facturacion-lineas-2026-08-22.md`,
  Nivel A/B sin decidir).

**No elegir ninguna opción de C1/C2/C3 sin el dueño.**

## D. Backlog confirmado pendiente (arrastrado de 08-19, sin cambios)

- **D6** — Número operativo de Reserva/Cliente (secuencia por negocio,
  prefijo configurable, mecanismo único reutilizable para ambos).
- **D7** — Reportes POS/Restaurante y CRM (ventas por producto/mermas/
  ticket promedio; clientes nuevos vs. recurrentes/tarifas aplicadas).
  Cero endpoints hoy.
- **D8** — IVA por producto, unidad de medida, código ARCA (hoy la tasa de
  IVA es global del negocio).

---

## D9. Scope multi-nivel para tarifas especiales (customer_rates + rate_catalog)

✅ **Diseño escrito y cerrado con el dueño (22/08/2026, antes de codear):**
`docs/diseno-scope-multinivel-tarifas-2026-08-22.md`. Propuesta completa
de schema (5 columnas de scope mutuamente excluyentes: resource/service/
product/category/bucket) + algoritmo de resolución de precio +
cumplimiento declarado. Las 4 decisiones de negocio quedaron confirmadas
(2 defaults del pedido original + 2 vía `AskUserQuestion`: PRODUCTOS
entra en el alcance, y el eje servicio-siempre-gana de D5 domina por
encima de la especificidad multi-nivel, no al revés). Lo único que
cambió después fue la SECUENCIA de entrega, a pedido del dueño — partida
en dos para que el trabajo de reservas no espere al de POS:

- **D9-Parte 1** (ALOJAMIENTO/TURNOS/SERVICIOS — `reservas`) — lista
  para implementar ya, sin bloqueos.
- **D9-Parte 2** (PRODUCTOS + gancho nuevo en `pos-menu`/
  `order.service.ts`, que hoy no consulta `customer_rates` en
  absoluto) — aparte, no bloqueante, diseño ya escrito para retomar
  cuando corresponda.

(Nombrado "Parte 1"/"Parte 2" en vez de D6/D7 — esos dos números ya
están tomados más arriba en este mismo archivo.)

**No es parte de D5** — D5 (fijo/%/catálogo reutilizable, ya implementado
y commiteado) resuelve CÓMO se expresa un descuento; esto resuelve A QUÉ
se aplica. Encontrado el 22/08/2026, mismo día que D5, al revisar el
diseño terminado — el dueño lo marcó explícitamente como ítem propio.

### El problema

Hoy el target de una tarifa especial (`customer_rates.resource_id`/
`service_id`, igual en `rate_catalog`) es siempre a nivel ÍTEM — un
recurso puntual o un servicio puntual, XOR, nunca un grupo. No hay forma
de decir "10% en TODO alojamiento" o "15% en toda la categoría Habitaciones
Dobles" sin crear una fila por cada ítem individual.

### Los 3 niveles pedidos (inclusión explícita en cada uno, nunca "todo menos estos")

1. **Bucket completo** — uno de: ALOJAMIENTO, TURNOS, SERVICIOS, PRODUCTOS.
2. **Categoría** dentro de un bucket.
3. **Ítem puntual** (lo que ya existe hoy).

Mismo shape para `customer_rates` (convenio individual) y `rate_catalog`
(grupo/preset) — resuelto al leer en los dos casos, consistente con la
decisión de referencia viva ya tomada en D5.

### Cómo mapean los 4 buckets a lo que ya existe (sin tablas nuevas para los buckets en sí)

- **ALOJAMIENTO** y **TURNOS** — ambos son `resources`, distinguidos por
  `is_lodging`. No son tablas separadas.
- **SERVICIOS** — `bookable_services`, categoría propia ya vía
  `resource_categories` (nivel intermedio sin tabla nueva).
- **PRODUCTOS** — `products`. Categoría propia también ya vía
  `resource_categories` (confirmado: `categoryId` ya existe en el
  catálogo de productos, pendientes-2026-08-19.md sección D9 original del
  gap analysis de Clientes).

**Hallazgo adicional durante el diseño (no una de las preguntas del
dueño, pero afecta el alcance):** `customer_rates`/`rate_catalog` HOY no
tienen ninguna columna para apuntar a un producto — el target actual es
`resource_id` XOR `service_id` únicamente. O sea que este ítem no es solo
"agregar granularidad" a los dos targets existentes — también agrega
PRODUCTOS como una tercera dimensión de target que hoy no existe en
absoluto. Confirmar que esto está dentro del alcance esperado antes de
diseñar el schema (no asumido).

### Defaults ya confirmados por el dueño (22/08/2026) — no reabrir sin que él los cambie

1. **Solapamiento de scopes del mismo cliente** (ej. "10% en todo
   ALOJAMIENTO" + "15% en la habitación X" para el mismo cliente): gana
   el más específico — ítem > categoría > bucket.
2. **"Exactamente un modo activo" deja de poder vivir en un CHECK/índice
   único de la base.** La garantía actual (`uq_customer_rates_customer_resource`/
   `_service`, un solo override activo por cliente+ítem) asumía una sola
   fila por cliente+ítem — con scope multi-nivel, un cliente puede tener
   VARIAS filas activas simultáneas que se solapen a distinto nivel (ítem
   + categoría + bucket, todas vigentes a la vez, resueltas por
   prioridad al cotizar). La garantía "no hay dos tarifas activas
   pisándose para el mismo cliente+ítem AL MISMO NIVEL" pasa a
   resolverse en la capa de servicio al leer/cotizar, no en un índice
   único de Postgres. Explícito para que no se asuma que queda tan
   blindado como el modelo actual — es un cambio real de dónde vive esa
   garantía, no un detalle de implementación menor.

### Preguntas que siguen abiertas (no asumir, confirmar antes de codear)

1. ¿Confirmar que agregar PRODUCTOS como target nuevo (hallazgo de
   arriba) entra en este alcance, o D9 se limita a agregar granularidad
   bucket/categoría a los dos targets que ya existen (resource/service)?
2. Forma del schema: ¿una columna `scope_level` (`ITEM`/`CATEGORY`/
   `BUCKET`) + `scope_id` (nullable, según nivel) + `bucket` (solo si
   scope_level=BUCKET), o mantener columnas separadas nullable por cada
   nivel/target con un CHECK más largo? Afecta directamente cómo se
   escribe la resolución de prioridad en `ReservationPricingService`.
3. ¿`rate_catalog` necesita los mismos 3 niveles que `customer_rates`, o
   alcanza con que el catálogo defina scopes de categoría/bucket y las
   asignaciones individuales sigan siendo por cliente+scope (mismo
   mecanismo, sin duplicar la pregunta)? (Asumido "mismo shape en las
   dos" en la descripción de arriba, pero vale confirmarlo explícito
   antes de tocar dos schemas a la vez.)

**Sin implementar todavía.** Tamaño estimado: comparable o mayor a D5
(rediseño de schema + reescritura de la cascada de resolución de precio +
migración de las tarifas ya cargadas al nuevo modelo de scope). Antes de
codear, conviene un documento de diseño propio (mismo criterio que
`docs/diseno-facturacion-lineas-2026-08-22.md` para C3) dado el tamaño y
las preguntas abiertas de arriba.
