---
name: criterios-negocio
description: >
  Verifica el cumplimiento de los criterios de integridad de datos y de
  negocio de este proyecto (docs/criterios-datos.md y
  docs/criterios-negocio.md) ANTES de crear o modificar cualquier entidad,
  tabla de schema.sql, repositorio o servicio de dominio. Usar SIEMPRE que:
  se cree o altere una tabla; se agregue o cambie un método de repositorio
  (findById, findAll, save, delete, countActive, deactivate); se decida qué
  pasa al "borrar" algo (¿desactivar, soft-delete con deleted_at,
  hard-delete?); se toque unicidad de nombres/códigos, duplicados o fusión
  de entidades; se maneje dinero, fechas/horarios/husos horarios,
  aislamiento multi-tenant (businessId), máquinas de estado/transiciones,
  concurrencia (SELECT+INSERT, límites de plan) o eventos/outbox. Dispará
  esta skill incluso si el usuario no menciona "criterios", "reglamento" ni
  los nombres de los documentos explícitamente — cualquier cambio de
  esquema, entidad de dominio o lógica de ciclo de vida en este repo la
  requiere. También usar antes de diagnosticar si algo es un bug o
  comportamiento esperado en resource_categories, resources,
  bookable_services, customers, products, tags o cualquier entidad de
  catálogo similar.
---

# Criterios de negocio — cumplimiento obligatorio

Este repo tuvo un incidente de producción (13/08/2026: categorías y
recursos se volvían invisibles al desactivarse, porque `findById` filtraba
por estado — una reserva histórica llegó a romperse por completo). De ahí
salieron dos documentos que son la fuente de verdad del proyecto para todo
lo que no es "lógica de negocio pura":

- **`docs/criterios-datos.md`** — integridad de las entidades: qué es un
  maestro/transacción/documento, reglas R1–R16, checklist para tabla
  nueva, estado de cumplimiento actual.
- **`docs/criterios-negocio.md`** — las otras nueve dimensiones: tenant,
  dinero, tiempo, lenguaje ubicuo, estados, privacidad, concurrencia,
  observabilidad, eventos. Reglas A2.x–A10.x.

No los repitas de memoria ni asumas que los recordás de una sesión
anterior — **leélos** (con Read o Grep sobre la sección relevante) antes de
decidir. Son documentos vivos: cambian a medida que se cumplen reglas, y
una versión vieja en tu contexto puede estar desactualizada.

## Paso 1 — Clasificá la entidad

Antes de tocar cualquier tabla o entidad de dominio, declará en tu
respuesta si es:

- **MAESTRO** (`Customer`, `PhysicalResource`, `ResourceCategory`,
  `BookableService`, `Product`, `Tag`, `Business`) — nunca se borra, se
  desactiva o se marca borrado; tiene ciclo de vida propio.
- **TRANSACCIÓN** (`Reservation`, `Stay`, `Order`, `HousekeepingTask`,
  `StockMovement`, `FinancialTransaction`) — un hecho que ocurrió, se
  cancela o revierte, nunca se edita después de confirmarse.
- **DOCUMENTO** (facturas AFIP, notas de crédito — todavía no existen en
  el código) — inmutable, numeración correlativa e irrompible.

`docs/criterios-datos.md` Parte 1 tiene la tabla completa con las
diferencias de reglas entre las tres. Si dudás a cuál pertenece algo
nuevo, leé esa tabla antes de seguir — la clase determina qué reglas
aplican, no al revés.

## Paso 2 — Mapa: qué leer según lo que estés tocando

No hace falta leer los dos documentos enteros cada vez. Andá directo a la
sección que aplica:

| Estás por... | Leé |
|---|---|
| Crear/alterar una tabla SQL | `criterios-datos.md` Parte 5 (checklist para tabla nueva) |
| Escribir `findById`/`getById` de un repositorio | `criterios-datos.md` R2 — nunca filtra por estado |
| Decidir qué hace un endpoint "delete"/"desactivar" | `criterios-datos.md` R3 (borrado ≠ pausado) + R5 (plan para dependientes) |
| Agregar un campo `name`/`code` a un maestro | `criterios-datos.md` R1 (código de negocio) + R6 (unicidad normalizada) |
| Ver duplicados o un "no me aparece la categoría" | `criterios-datos.md` R7 (fusión) — no lo arregles borrando a mano sin revisar R2/R3 primero |
| Tocar `businessId`/queries multi-tenant | `criterios-negocio.md` sección 2 (A2.1–A2.7) |
| Tocar precios, `amount`, impuestos, columnas DECIMAL | `criterios-negocio.md` sección 3 (A3.1–A3.10) |
| Tocar fechas, horarios, `TIMESTAMPTZ`, husos | `criterios-negocio.md` sección 4 (A4.1–A4.7) |
| Renombrar una entidad o un campo del dominio | `criterios-negocio.md` sección 5 (A5.1–A5.5) |
| Agregar un estado o una transición nueva | `criterios-negocio.md` sección 6 (A6.1–A6.6) |
| Tocar email/teléfono/CUIT/domicilio de un cliente | `criterios-negocio.md` sección 7 (A7.1–A7.7) |
| Escribir un `SELECT COUNT` seguido de un `INSERT`, o cualquier chequeo de límite | `criterios-negocio.md` sección 8 (A8.1–A8.6) + `criterios-datos.md` R16 |
| Agregar logs o un evento de dominio nuevo | `criterios-negocio.md` secciones 9 y 10 |

## Paso 3 — Declará el cumplimiento explícitamente

En tu respuesta al usuario (no solo en tu razonamiento interno), decí:

1. Qué reglas aplican al cambio (por número: R2, A3.4, etc. — no en
   abstracto).
2. Cómo el cambio las cumple.
3. Si alguna regla se incumple a propósito, decilo y justificá por qué
   (ej. "no agrego código de negocio a `Tag` todavía porque R1 lo marca
   para 'esta semana', no para este cambio puntual").

Esto no es burocracia — es lo que evitó (esta vez, después del incidente)
que el mismo bug de `findById` se reintrodujera sin que nadie lo conecte
con el síntoma. La regla ya estaba documentada en un comentario del código
antes del fix y nadie la relacionó con el bug real durante meses.

## Regla dura: no "mejores" lo que ya está marcado como correcto

Los dos documentos tienen ítems marcados `✅`/"ya cumplido" — decisiones
que el dueño del proyecto ya evaluó y quiere mantener así (ej. anonimizar
en vez de hard-delete, `subtotal` persistido en vez de recalculado, retry
solo en GET/HEAD). Si vas a tocar código cerca de una de esas decisiones,
no la "mejores" ni la refactorices sin que te lo pidan explícitamente —
son áreas ya cerradas, no deuda pendiente.

## Si encontrás una regla nueva que falta

No la implementes de una si no te la pidieron para el cambio puntual que
estás haciendo. Nombrala, explicá el riesgo concreto (no en abstracto —
con el escenario real que la rompería), y preguntá si conviene resolverla
ahora o anotarla para después. Así se manejaron R2/R3 del incidente de
categorías: se investigó el alcance completo antes de tocar código, y se
acordó explícitamente qué entraba "ahora" y qué quedaba para "esta
semana"/"cuando duela".
