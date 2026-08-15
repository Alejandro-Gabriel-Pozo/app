# Arquitectura — monolito modular vs. microservicios

> Traído por el dueño el 15/08/2026: "fuimos meticulosos en la
> modularidad, pero no en pensar una arquitectura integrada por API
> (microservicios)". No es una hoja de ruta de implementación — es una
> reflexión de arquitectura, documentada con evidencia real del código
> (análisis con `dependency-cruiser`, ya instalado en el repo), no una
> opinión abstracta.

## 1. Qué es esto hoy, dicho explícitamente

`app-main` es un **monolito modular**, no microservicios — nunca se
decidió explícitamente así, pero es lo que hay: un solo proceso Express,
un solo deploy, un solo repo. La modularidad que sí se construyó
(`ModuleKey`/`business_modules`, los 6 módulos gateados — ver memoria
"Modular add-on pricing architecture") es **a nivel de feature flag
dentro del mismo proceso**, no a nivel de servicios independientes con
API entre ellos. Un negocio con el módulo `POS_RESTAURANTE` apagado
sigue corriendo el mismo binario que uno con todo prendido — solo se le
ocultan rutas/UI.

**Aislamiento real que sí existe, por otro eje:** cada tenant tiene su
propia base de datos Postgres (branch de Neon, ver
`docs/pendientes-2026-08-15.md` sección B1) — eso es aislamiento de
*datos* a nivel de infraestructura, lo que mucha gente busca resolver
con microservicios (un servicio por cliente) ya está resuelto acá de
otra forma, más barata de operar.

## 2. Recomendación: no migrar ahora

Con un solo tenant real y un equipo de una persona (+ IA), microservicios
cambiarían velocidad de desarrollo por escalabilidad que todavía no hace
falta. Evidencia concreta de esta sesión: aprovisionamiento automático +
panel de superadmin + fix de un bug de auth crítico, todo en una sola
sesión — posible porque es un solo deploy, no tres servicios coordinados
con sus propios pipelines, versionado de API entre ellos, y monitoreo
separado.

**Condiciones que ameritarían revisar esto** (ninguna se da hoy):
- Un módulo con necesidades de escala muy distintas al resto (ej. un
  motor de reportes pesado que satura el proceso mientras el resto anda
  liviano).
- Necesidad de que un módulo lo posea/despliegue un equipo distinto,
  con su propio ritmo de releases.
- Un módulo que necesite un stack tecnológico distinto (ej. Python para
  ML) que no tiene sentido correr en el mismo proceso Node.
- Requisito de compliance que exija aislamiento más fuerte que
  BD-por-tenant (ya cubre la mayoría de los casos de "no me mezcles con
  otro cliente").

## 3. Auditoría de límites internos (15/08/2026)

Antes de migrar nunca sirve mirar el código a ojo — se corrió
`dependency-cruiser` (ya configurado en `.dependency-cruiser.cjs`) sobre
todo `src/`, agrupando archivos en dominios de negocio inferidos por
nombre (reservas, pos-productos, pms-estadías, clientes-finanzas,
usuarios-roles, plataforma, catálogo-config, reportes) y contando los
imports que cruzan de un dominio a otro. Objetivo: si el día de mañana
hay una razón real para separar un dominio en su propio servicio, ¿qué
tan fácil sería?

### Buena noticia — la mayoría del acoplamiento es legítimo, no un leak

Los cruces con más volumen no son código mal ubicado, son relaciones de
dominio reales:
- `reservas ↔ catalogo-config` (recursos/categorías/horarios): una
  reserva **es** de un recurso, que **pertenece** a una categoría. No
  hay forma sensata de separar esto sin fusionarlos de vuelta en la
  práctica.
- `reservas ↔ clientes-finanzas` (tarifas especiales del cliente): una
  reserva necesita saber si el cliente tiene una tarifa propia.
- `pms-estadías ↔ reservas` (una Estadía nace de una Reserva, vía
  check-in) y `pms-estadías ↔ clientes-finanzas` (una Estadía genera
  cargos en cuenta corriente): ambos son el flujo de negocio real, no
  acoplamiento accidental.
- `pos-productos → clientes-finanzas` (`order.service.ts` →
  `financial-transaction.repository.ts`): una orden confirmada genera un
  movimiento financiero — es la integración que se construyó a propósito
  en la sesión de caja/turno (14/08).

La mayoría de los cruces con `usuarios-roles`/`plataforma` son
infraestructura transversal (`auth.middleware.ts`, `roles.ts`,
`tenant.middleware.ts`) — **todas** las rutas necesitan autenticación y
resolución de tenant, eso no es un dominio que se pueda separar, es la
espina dorsal del multi-tenant.

### El hallazgo real — un punto concreto para empezar el día que haga falta

`customer.routes.ts` (la API pública del portal de clientes) importa de
**seis dominios distintos** en un solo archivo — reservas, catálogo,
clientes, plataforma, PMS, reportes indirectamente. Es esperable: es el
backend del portal público, tiene que exponer un poco de todo. **Si
algún día se separa en microservicios, este archivo es exactamente donde
aparecería un API Gateway / Backend-for-Frontend** — no es un problema a
resolver hoy, es la costura natural.

Más puntual y sí accionable si algún día se encara una separación:
`reservation.service.ts` importa **directo las clases de repositorio**
de otros dominios (`category.repository`, `customer-rate.repository`,
`housekeeping.repository`, `operating-hours.repository`,
`resource.repository`) en vez de pasar por la capa de servicio pública
de esos dominios. Hoy es igual de válido (todo corre en el mismo
proceso, no hay costo de red) — pero es la diferencia entre "leer datos
de otro módulo en memoria" y "llamar a la API pública de otro módulo".
Si `reservas` alguna vez se separa como servicio propio, este es el
primer lugar a mirar — no antes.

### No auditado hoy
El análisis fue por convención de nombres de archivo (heurística, no
perfecta) — no revisó exhaustivamente cada import línea por línea, ni
generó el gráfico visual (necesita Graphviz, ya documentado como fuera
de alcance en C8, `pendientes-2026-08-14.md`). Alcanza para la pregunta
que se estaba respondiendo ("¿está todo mezclado sin criterio, o hay una
estructura de dominio real debajo?") — la respuesta es que sí hay una
estructura real, solo que vive dentro de un solo proceso.

## 4. Conclusión

No hay una arquitectura rota para arreglar — hay una decisión de
arquitectura (monolito modular) tomada implícitamente, que resultó ser
razonable para la etapa actual, con un único punto de acoplamiento
directo entre dominios (`reservation.service.ts` → repositorios ajenos)
que valdría la pena limpiar el día que haya una razón real de negocio
para separar servicios — no antes.
