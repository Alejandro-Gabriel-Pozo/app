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
