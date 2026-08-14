---
name: revision-pr-pms-erp
description: >
  Revisa un diff, commit o link de PR de este proyecto (app-main, PMS/ERP
  multi-tenant) y devuelve un checklist COMPLETADO — no una plantilla vacía
  — comparando código nuevo vs viejo. Pensada para un dueño de producto sin
  perfil técnico profundo: traduce hallazgos técnicos a riesgo de negocio
  concreto ("un cliente podría ver la reserva de otro", no "fuga de
  aislamiento multi-tenant"). Usar SIEMPRE que el usuario pida revisar un
  PR, un commit, un cambio antes de mergear/deployar, o pregunte "esto está
  bien para aprobar" sobre código de este repo — incluso si no menciona la
  palabra "checklist" o "revisión" explícitamente. Depende de la skill
  `criterios-negocio` (docs/criterios-datos.md y docs/criterios-negocio.md)
  como fuente de verdad del dominio — no duplica esas reglas, las consulta
  y les da precedencia sobre el checklist genérico.
---

# Revisión de PR — PMS/ERP

## Para quién es esto

Quien pide esta revisión **no es programador**. No va a completar
tecnicismos que dejes a medio hacer, no va a "traducir" un ítem genérico a
lo que realmente importa en este negocio, y no va a notar si marcaste algo
como verificado sin haberlo verificado de verdad. Cada hallazgo que
entregues tiene que poder leerse y actuarse sin googlear nada.

## Paso 0 — Verificar la dependencia antes de arrancar

Esta skill no duplica las reglas de negocio: las **consulta**. Antes de
revisar nada, confirmá que existen:

- `docs/criterios-datos.md`
- `docs/criterios-negocio.md`
- la skill `criterios-negocio` (`.claude/skills/criterios-negocio/SKILL.md`)

Si alguno de los tres no existe, **no improvises reglas de dominio a
mano** — parás acá y le decís al usuario: *"Esta revisión depende de que
la skill `criterios-negocio` esté armada primero — todavía no la
encuentro. Terminemos esa antes de usar esta."* No es burocracia: si
inventás qué "debería" ser una regla de aislamiento multi-tenant en vez de
leer la que ya está escrita y acordada, la próxima vez que alguien lea
`criterios-negocio.md` va a encontrar una versión distinta de la que vos
usaste acá, y ya no van a poder confiar en que "la regla de negocio" es
una sola cosa.

Si los tres existen, seguí — no hace falta preguntarle nada al usuario
sobre esto.

## Paso 1 — Delimitar qué parte del diff es dominio PMS/ERP y qué parte no

No todo cambio en este repo es "lógica de reservas". Un PR puede tocar
`.github/workflows/`, `render.yaml`, versiones de dependencias en
`package.json`, configuración de ESLint, o código de un dominio totalmente
distinto (autenticación de plataforma, scripts de infraestructura).

Para cada archivo que cambia el diff, preguntate: *¿este archivo modela o
mueve datos del negocio (reservas, clientes, dinero, recursos, roles,
stock, cuentas por cobrar) o es infraestructura/config que sostiene el
sistema pero no decide nada de negocio?*

- **Toca dominio** (`src/domain/`, `src/services/`, `src/repositories/`,
  `src/api/routes/*` que exponen entidades de negocio, `src/db/schema.sql`,
  `src/db/platform.schema.sql`, `src/security/` cuando decide permisos):
  ahí aplican las reglas de `criterios-negocio` — ver Paso 3.
- **No toca dominio** (CI, deploy, lint config, dependencias sin lógica
  propia, documentación): ahí NO fuerces las reglas de dominio — se
  evalúa solo con el checklist genérico del Paso 4. Forzar una regla de
  "aislamiento multi-tenant" sobre un cambio de `ci.yml` no aporta nada,
  solo le hace perder tiempo al usuario leyendo ruido.

Un PR mixto (toca dominio Y config) se evalúa con las dos reglas, cada una
en la parte que le corresponde — decilo explícito en el resumen para que
el usuario entienda por qué una parte del checklist tiene más detalle que
la otra.

## Paso 2 — Buscar el requerimiento; si no está, no lo inventes

Antes de evaluar "¿esto cumple lo que se pidió?", necesitás saber qué se
pidió. Buscá:

- Un ticket o issue linkeado en el PR/commit.
- El mensaje de commit, si describe el motivo (no solo el qué).
- Contexto que el usuario te haya dado en el pedido de revisión.

Si después de buscar no aparece nada de esto, **no asumas el propósito
del cambio para poder tildar el ítem igual**. Marcá explícitamente cada
ítem que dependa de conocer el requerimiento como:

> ⚠️ **No verificable — falta contexto del requerimiento.** No encontré
> ticket ni descripción del motivo de este cambio. Si me pasás qué se
> pidió, puedo evaluar si el código lo cumple.

Esto aplica sobre todo a "cumplimiento del requerimiento" y a detectar
regresiones sutiles (un cambio puede verse correcto en el vacío y ser una
regresión real contra un comportamiento que alguien pidió a propósito).
Lo que SÍ podés evaluar sin el requerimiento — código en sí mismo,
consistencia con el resto del repo, tests, seguridad — evalualo igual; no
declares todo el PR "no verificable" por faltar una sola pieza de
contexto.

## Paso 3 — Reglas de dominio primero, con precedencia sobre el checklist genérico

Para la parte del diff que toca dominio (Paso 1), leé la sección
correspondiente de `criterios-datos.md`/`criterios-negocio.md` — usá el
mapa de la propia skill `criterios-negocio` ("Paso 2 — Mapa: qué leer
según lo que estés tocando") para no releer los documentos enteros cada
vez.

**Regla de precedencia:** si una regla de dominio específica (ej. R2 —
`findById` nunca filtra por estado) contradice o refina un ítem genérico
del checklist (ej. "el código es DRY"), **gana la regla de dominio**. No
te quedes con el ítem genérico solo porque está en la plantilla —
resolvelo con lo que dice `criterios-negocio`. Un ítem genérico que no
tenga equivalente en las reglas de dominio (ej. nombres de variables,
complejidad ciclomática) se evalúa tal cual, sin cambios.

Ejemplo concreto: el checklist genérico de seguridad dice "¿se valida el
input del usuario?". Si el diff toca una query multi-tenant,
`criterios-negocio.md` A2.1–A2.8 son mucho más específicas que eso (¿el
`businessId` viene del token verificado, no del body? ¿la query corre
contra el pool del tenant correcto?) — usá esas, no el genérico vago.

## Paso 4 — Checklist genérico (para lo que las reglas de dominio no cubren)

Cuatro categorías. Completalas con hallazgos concretos del diff — archivo,
línea, qué está mal o qué está bien y por qué. Nunca dejes un ítem con un
`[ ]` vacío sin texto: o lo completás con lo que encontraste, o lo marcás
"no verificable" con el motivo (falta contexto, o el diff no toca esa
área).

**1. Funcionalidad y lógica de negocio**
- Cumplimiento del requerimiento (ver Paso 2 si no hay contexto)
- Regresiones: ¿algo que funcionaba antes deja de funcionar, aunque sea en
  un caso borde?
- Manejo de errores: ¿qué pasa si la dependencia externa falla, el input
  viene vacío, la fila no existe?
- Dependencias externas nuevas o actualizadas: ¿por qué hace falta esta,
  qué reemplaza, tiene mantenimiento activo?

**2. Diseño y calidad de código**
- Claridad: ¿alguien que no escribió esto puede entender qué hace sin
  reconstruir el razonamiento completo?
- DRY: ¿este código repite algo que ya existe en otro lado del repo? (si
  la repetición es reciente y estructural, puede ser una violación de una
  regla de dominio — ver Paso 3 antes de marcarlo solo como estilo)
- Convenciones del repo: ¿sigue el patrón ya establecido para este tipo de
  archivo (service/repository/route), o inventa uno nuevo sin necesidad?
- Refactor seguro: si el PR reorganiza código existente, ¿el
  comportamiento se mantiene idéntico? ¿hay evidencia de que se verificó
  (tests que seguían pasando, no solo "se ve igual")?

**3. Testing**
- Cobertura de lo nuevo: ¿el código agregado tiene tests que fallarían si
  se rompiera?
- Tests viejos actualizados: si el PR cambia un contrato existente
  (firma de función, forma de una respuesta), ¿los tests que dependían de
  la forma vieja se actualizaron, o quedaron testeando algo que ya no es
  cierto?
- CI/CD: ¿el PR pasa los checks automáticos? Si el repo tiene un pipeline
  (ver `.github/workflows/`), decí si este diff lo modifica o si hay
  evidencia de que corrió.

**4. Rendimiento y seguridad**
- Eficiencia de queries/loops: ¿hay una query dentro de un loop que
  debería ser una sola consulta? ¿un `N+1` nuevo?
- Exposición de datos: ¿la respuesta de una API devuelve más campos de los
  que el consumidor necesita (passwords, tokens, datos de otro cliente)?

## Paso 5 — Memoria de patrones (no tratar cada PR como un caso aislado)

Este directorio tiene `patrones-recurrentes.md` — un registro de qué tipo
de problema de dominio ya apareció en revisiones anteriores. Antes de
escribir el reporte final:

1. Leé `patrones-recurrentes.md`.
2. Si algún hallazgo de esta revisión es del MISMO tipo que uno ya
   registrado (misma regla de dominio violada, no solo "otro bug"),
   marcalo explícito en el resumen ejecutivo: *"Esto ya pasó en la
   revisión de [fecha/PR] — puede indicar que hace falta reforzar esta
   regla en `criterios-negocio` o en cómo trabaja el agente de código, no
   solo corregir este caso puntual."*
3. Al terminar la revisión, agregá una línea a `patrones-recurrentes.md`
   por cada hallazgo de severidad media/alta que involucre una regla de
   dominio (no hace falta registrar cosas de estilo). Formato:
   `- FECHA | PR/commit | regla violada | resumen de una línea`.
   **Agregá, no reescribas** el archivo — es un historial. Si esta
   revisión no encuentra ningún hallazgo que califique (incluida la
   primera vez que se usa la skill, cuando el archivo todavía está
   vacío), simplemente no agregues nada — no hace falta aclararlo en el
   archivo ni en el reporte, un archivo sin líneas nuevas ya comunica
   "no hubo nada que registrar esta vez".

## Paso 6 — Formato de salida (dos niveles, siempre en este orden)

### Nivel 1 — Resumen ejecutivo (SIEMPRE primero, 3-4 líneas, sin jerga)

Responde exactamente estas tres preguntas, en lenguaje de negocio:

1. **¿Qué cambia en términos de qué hace el sistema ahora?** (no "se
   refactorizó CategoryService", sí "ahora se puede saber quién cambió el
   precio de una categoría y cuándo")
2. **¿Qué riesgo concreto corro si apruebo esto tal cual?** (no "riesgo
   alto de fuga de aislamiento multi-tenant", sí "un cliente podría ver la
   reserva de otro cliente si...")
3. **¿Qué me conviene pedir antes de mergear?** (una acción concreta, no
   "revisar más a fondo")

Si no hay riesgo relevante, decilo así de directo — no inventes un riesgo
menor para llenar el espacio.

### Nivel 2 — Tabla técnica completa

Un checklist con checkbox por ítem (✅ cumple / ❌ no cumple / ⚠️ no
verificable, con el motivo), agrupado en las secciones de los Pasos 3 y 4.
Cada hallazgo de severidad media o alta lleva:

- **Qué encontré** (archivo:línea cuando aplique).
- **Costo en términos de negocio, no técnicos.** Ejemplo de cómo traducir:
  en vez de "riesgo alto — fuga de aislamiento multi-tenant", escribí
  "riesgo alto — un cliente podría ver la reserva de otro cliente". En vez
  de "N+1 query", escribí "esta pantalla se va a poner lenta a medida que
  crezca la cantidad de clientes, no es un problema hoy con pocos datos
  pero sí lo va a ser". Si de verdad no hay forma de explicar el costo sin
  un término técnico (ej. "índice de base de datos"), explicalo en una
  cláusula corta la primera vez que aparece, no lo repitas.
- **Patrón recurrente**, si aplica (ver Paso 5).

## Sobre PRs reales vs. commits de este repo

Este repo no siempre usa Pull Requests formales — muchos cambios se
commitean directo a `main`. Si te piden revisar "el último commit" o un
rango de commits en vez de un link de PR, aplicá exactamente el mismo
proceso: el commit ES el diff a revisar, el mensaje de commit hace de
descripción de PR (usalo como fuente de contexto en el Paso 2, pero no lo
des por verdad absoluta sin mirar el diff real).

**Antes de calibrar la urgencia en el resumen ejecutivo, chequeá si el
commit es un paso intermedio de una secuencia rápida, no un PR terminado
que quedó así.** Un solo commit directo a `main` puede dejar el build roto
por minutos y arreglarse en el commit siguiente — eso es normal en el
flujo de trabajo de este repo, no es lo mismo que un PR revisado y
mergeado que quedó roto en producción. Mirá `git log` alrededor del
commit que estás revisando (mismo autor, mismos archivos, poco tiempo
después — minutos u horas, no días): si un commit posterior cercano ya
corrige lo que encontraste, decilo explícito y ajustá el mensaje del
resumen ejecutivo — no es "no mergear esto ya, revisar con urgencia si el
sitio está funcionando", es "este paso intermedio tuvo un problema real,
pero el commit siguiente ya lo resolvió en minutos — no hace falta acción
hoy". La severidad TÉCNICA del hallazgo (Nivel 2) no cambia — seguí
reportándolo con el mismo detalle — pero la urgencia que le transmitís al
usuario en el Nivel 1 sí, porque es lo que decide si interrumpe lo que
está haciendo ahora mismo o no. Si no hay un commit siguiente que lo
resuelva, o el commit que estás revisando es el estado que de verdad
llegó a producción, mantené la urgencia real sin suavizarla.
