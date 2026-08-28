# Playbook — campos que interactúan sin ser obvio: selector nombrado, no controles sueltos

- **Fecha:** 2026-08-28
- **Estado:** aceptado (patrón de UI) — primera aplicación pendiente de implementar
- **Categoría:** Playbook de UI
- **Etiquetas:** `UI` `alta` `taxonomia` `resource_categories` `bookable_services`
- **Referencias:** [diseno-taxonomia-tipos-reserva-2026-08-28.md](../diseno-taxonomia-tipos-reserva-2026-08-28.md) (primer caso real); `criterios-negocio.md` A8.

## Regla

Cuando dos o más campos **independientes** se combinan para formar un concepto de negocio con nombre real (no cualquier par de campos — solo cuando la combinación tiene un nombre que el negocio ya usa, como "turno" o "clase grupal"), la UI de alta **no** los muestra como controles técnicos sueltos que el usuario tiene que combinar mentalmente.

En vez de eso:

1. Un **selector de opciones nombradas** ayuda a elegir bien.
2. Al lado del selector, **siempre visible** (nunca en tooltip, nunca colapsado) — tanto al crear como al editar/revisar la entidad después — un **resumen con los valores concretos** que esa opción setea (ej. "Exclusivo: sí · Modo: horario fijo").
3. El nombre es una ayuda para elegir, **nunca un reemplazo** de lo que se está guardando. Si se oculta el valor real detrás del nombre, en unos meses nadie —ni quien lo cargó— sabe qué quedó configurado.
4. **Sin opción pre-seleccionada** — el alta no se completa sin elección explícita.
5. Evaluar si además conviene sacar los `DEFAULT` de esos campos en el schema, para que ningún INSERT (no solo el de la UI) los deje sin declarar — pero solo **después** de que la UI ya fuerce la elección, no antes (si no, solo rompe scripts sin resolver el problema real).

## Cuándo NO aplica

No es "cualquier par de campos en un mismo form" — es específicamente cuando la combinación tiene un nombre de negocio real y existe el riesgo de que alguien la cargue de forma internamente inconsistente sin darse cuenta (cada campo tiene su propio control, cada uno es opcional/tiene default, nada los valida cruzados). Dos campos que siempre se leen juntos y ya se muestran juntos en un único control (ej. `startTime`/`endTime` de un rango) no necesitan este tratamiento — ya son "un concepto" en la UI.

## "Ninguna opción nombrada encaja" — lista creciente, no modo avanzado (regla general)

Preferir que la **lista de opciones nombradas crezca** (agregar un nombre nuevo cuando aparece un caso de negocio real) antes que abrir un "modo avanzado" con los campos crudos sueltos. Un modo avanzado reintroduce exactamente el problema que este patrón resuelve: un control técnico sin guía, con el mismo riesgo de combinación inconsistente sin que nadie lo note. Agregar un nombre nuevo suele ser solo copy (qué texto mostrar por esa combinación), no requiere tocar schema ni validación — bajo costo, sin necesidad real de la vía de escape. Si aparece un caso que necesita valores nuevos (no solo un nombre nuevo) en los campos subyacentes, eso es una discusión de modelo aparte, no algo que el selector deba resolver con una salida a "modo crudo".

## Caso real que originó este playbook (28/08/2026)

`resource_categories.is_exclusive` (`DEFAULT FALSE`) y `bookable_services.booking_mode` (`DEFAULT 'slot'`) se presentaban como controles sueltos — de hecho, `is_exclusive` no tenía **ningún** control en la UI (ni en Categorías ni en Servicios). Resultado en datos reales: Peluquería y Spa de `biz-demo-01` quedaron cargadas como "turno con horario + cupo compartido" (`is_exclusive=false` + `booking_mode='slot'`) — una combinación que no corresponde a ningún concepto de negocio real y permite que dos clientes reserven el mismo horario con el mismo profesional. Nadie decidió mal: nadie fue obligado a ver la interacción entre los dos campos, porque uno de los dos ni siquiera era visible. Ver el diseño completo del selector en el documento de referencia de arriba.

## Otros candidatos a revisar con este criterio (no evaluados todavía, anotar si se confirma)

Ninguno confirmado aún — agregar acá cuando se audite otra pantalla de alta bajo este criterio, no antes.
