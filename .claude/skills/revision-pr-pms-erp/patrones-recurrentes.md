# Patrones recurrentes — revisiones de PR

Registro histórico de hallazgos de dominio (severidad media/alta) por
revisión. Se agrega una línea por hallazgo relevante al final de cada
revisión — nunca se reescribe ni se borra, es historial. Formato:

`- FECHA | PR/commit | regla violada | resumen de una línea`

Si el mismo tipo de problema (misma regla, no solo "otro bug") aparece
más de una vez acá, la próxima revisión que lo detecte tiene que
señalarlo como patrón recurrente — ver Paso 5 de SKILL.md.

---

- 2026-08-14 | 08c506f | R16/A8.3 (límite de plan: SELECT COUNT + INSERT sin transacción) | CategoryService.createCategory() cuenta categorías activas y crea la nueva en dos pasos separados — dos altas simultáneas pueden pasar el límite del plan; ya diagnosticado independientemente en criterios-datos.md el 13/08/2026 y sigue en Backlog.
- 2026-08-17 | Fase 2 carve-out inventario (POST /api/products/stock/waste) | A8.5 (idempotencia insert-then-act) | Un pre-check de stock disponible escrito ANTES del chequeo `if (!inserted) return` (idempotencia por movementId) hacía que un reintento legítimo de una operación ya aplicada leyera el stock YA descontado y fallara con "insuficiente" en vez de no-opear — encontrado y corregido en autorevisión antes de verificar contra Postgres real, no llegó a commitear roto. Regla para el futuro: en cualquier endpoint insert-then-act, todo pre-check de negocio que dependa del estado actual del stock/contador tiene que vivir DESPUÉS del chequeo de idempotencia, nunca antes.
- 2026-08-17 | Fase 3 carve-out inventario (schema.sql, índices de stock_movements ampliados para ítems compuestos) | R2/integridad de índices únicos polimórficos | Un ÚNICO índice único combinando `product_id`/`product_variant_id` (patrón polimórfico, uno de los dos siempre NULL) con otras columnas NO bloquea duplicados — Postgres trata cada NULL como distinto de cualquier otro NULL, así que dos filas con el mismo `product_id` pero `product_variant_id` NULL en ambas no colisionan. Encontrado insertando duplicados reales contra Postgres que deberían haber sido rechazados (ya había pasado, sin loguearse, en el mismo diseño de `inventory_levels` que SÍ usa dos índices parciales — acá se repitió el error al no seguir ese mismo patrón desde el principio). Corregido separando en DOS índices parciales (`WHERE product_id IS NOT NULL` / `WHERE product_variant_id IS NOT NULL`), mismo criterio que `uq_inventory_levels_product`/`uq_inventory_levels_variant`. Regla para el futuro: cualquier índice único que incluya una columna polimórfica nullable-por-diseño (uno de dos FKs, nunca los dos) tiene que partirse en un índice parcial por rama — nunca combinarla con otras columnas en un solo índice, sin excepción, y verificar con un INSERT de duplicado real contra Postgres antes de dar por cerrado.
- 2026-08-22 | [commit/PR de D9] | repos in-memory devuelven referencia en vez
  de copia | Reapareció el mismo motivo estructural ya visto antes en otro
  repo in-memory de este proyecto — deja de ser "un bug puntual". Regla para
  el futuro: todo `in-memory.*.repository.ts` nuevo tiene que devolver una
  copia (spread/structuredClone) en cada método de lectura, nunca la
  referencia interna guardada — verificarlo con un test que mute el objeto
  devuelto y confirme que el estado interno del repo no cambió.
