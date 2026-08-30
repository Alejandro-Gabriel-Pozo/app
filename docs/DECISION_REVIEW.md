# Análisis de implicancias — método de revisión antes de implementar

- **Fecha:** 2026-08-30
- **Estado:** aceptado. Práctica estándar del repo.
- **Cuándo aplica:** antes de cualquier decisión de **forma o diseño** que toque
  **autorización**, **datos legales/fiscales**, o **arquitectura de módulos** —
  y en general antes de aceptar una propuesta de implementación con su
  recomendación adjunta.
- **Invocador:** el usuario pide *"aplicá el análisis de implicancias"*, o quien
  encara el cambio (IA o persona) usa su propio criterio de que la decisión lo
  amerita. Con cualquiera de los dos, seguir este documento sin que haga falta
  repetir los pasos.
- **Etiquetas:** `metodo` `convencion` `revision` `autorizacion`

**Este documento es autosuficiente.** Contiene el método completo, la frase
invocadora, los disparadores objetivos y un caso trabajado con citas que se
pueden abrir. **No depende de memoria de agente ni de continuidad de sesión**:
cualquiera que llegue acá desde `indice-conocimiento.md` puede aplicarlo sin
haber estado en la conversación que lo originó.

## Supuesto de base

Este método asume que el repo **ya tiene la respuesta escrita en algún lado** —
un criterio de negocio (`criterios-negocio.md` / `criterios-datos.md`), un plan
de diseño (`plan-*`, `diseno-*`), la matriz de RBAC, o el propio código. El
trabajo es **encontrarla y confrontarla contra la propuesta**, no inventar una
nueva.

Si después de buscar **no aparece ningún criterio aplicable**, eso mismo es una
señal: puede ser una **decisión de negocio genuina que falta documentar** (como
pasó con downgrade/preset, ahora en `diseno-lifecycle-plan-fase5-2026-08-30.md`),
no algo para resolver por default ni por lo que "parece razonable".

## El método

Para **cada punto** de la propuesta, en orden y sin saltear:

1. **Identificar qué modelo/criterio del repo lo gobierna.** `criterios-negocio.md`,
   `criterios-datos.md`, `rbac-matriz-endpoints.md`, el `plan-*` o `diseno-*`
   correspondiente. **Con cita exacta de archivo y línea, verificada en el
   momento — nunca de memoria.** Si la cita no se puede fijar, no está
   verificada.
2. **Derivar la implicancia práctica** de aplicar ese modelo al caso concreto:
   qué pasa exactamente si se implementa tal cual se propuso.
3. **Recién ahí preguntar:** ¿ya es visible la opción correcta, legal y
   factible? **No aceptar una recomendación que venga adjunta a la propuesta**
   sin haber pasado antes por (1) y (2).
4. **Sin criterio propio del repo →** comparar contra el diseño de industria en
   sistemas maduros análogos (entitlements de Stripe / LaunchDarkly, colas de
   outbox, etc.). **Nombrar el patrón** ("una resolución determinística por
   sujeto+recurso; el rollout se controla en una capa aparte"), no decir sólo
   "es lo estándar".
5. **Buscar activamente si la propuesta esconde una inconsistencia estructural
   no preguntada.** El hallazgo nav-vs-gate del 30/08/2026 (ver abajo) salió de
   este paso, no de la pregunta original.
6. **Modo estricto:** no implementar, no tocar, no escribir código ni docs hasta
   que el usuario lo autorice explícitamente **después** de ver la síntesis.

El entregable de la revisión es la **síntesis**: por punto, el criterio citado,
la implicancia, y la opción visible (o "no hay criterio → decisión de negocio a
documentar"). Después de eso, el usuario decide; recién con su OK se pasa al
artefacto de diff + preflight (ver `DEFENSIVE_DEVELOPING.md` y el flujo de
commits del proyecto).

## Caso de referencia — nav vs. gate (30/08/2026)

Contexto: cablear la cascada de 5 escalones (`resolveCapabilities`) dentro del
gate de módulos (`requireModule` → 402). La propuesta traía una recomendación
adjunta: rutear `getBusinessModules()` por el resolver, alimentándole input
adulterado (`industryKey: null` mentido, `active: true` fingido) para neutralizar
los escalones que se diferían a Fase 5.

**Paso 1-2 — criterio + implicancia, por punto:**

- **6.B (la consulta).** Criterio: `DEFENSIVE_DEVELOPING.md` §1.5 ("un solo
  camino por responsabilidad") + §1.4 ("degradar con ruido, no en silencio").
  Implicancia: alimentar datos falsos en silencio a una función pura para que
  "no vea" 3 de sus 5 escalones es exactamente el anti-patrón. La versión
  acotada genuinamente es 3 líneas (`(override ?? false) && implemented`); no
  necesita el resolver.
- **Punto d (sacar el gate de lecturas).** Criterio: `criterios-datos.md`, tabla
  MAESTRO/TRANSACCIÓN/DOCUMENTO, fila "¿Se borra?" — DOCUMENTO: "Jamás. Se anula
  con otro documento"; retención AFIP = legal. Implicancia: 402 sobre un
  comprobante ya emitido incumple la obligación de exhibición. Pero: en el
  bloque acotado, un módulo sólo se apaga vía `NOT_IMPLEMENTED` ("sin código"),
  y sin código no hay documentos detrás → el lockout no es load-bearing aún; se
  cementa la invariante antes de Fase 5.

**Paso 5 — inconsistencia estructural no preguntada:**

El nav del sidebar ya consume la cascada **completa**: `context.adapter.ts:119`
llama a `resolveCapabilities` con el input real (5 escalones) para
`/api/business/context`, y el `enabledModules` que gatea la navegación (V3-a/V3-b)
lo refleja **hoy**. En cambio `requireModule` (`security/module.middleware.ts:18`
→ `PlatformRepository.getBusinessModules()`, `platform.repository.ts:420`) resuelve
sólo con los escalones 1 y 3. **Nav y gate ya calculan "enabled" distinto** —
inerte para el único negocio en producción (`industry_key` NULL, sin `min_plan`,
todo `implemented`), pero estructural.

Esto reformuló la pregunta abierta de Fase 5. No era "parámetro de escalones vs.
input completo": era "¿el gate converge en la misma definición de 'efectivo'
que la UI ya muestra?". Respuesta (B): **input real completo, el resolver corre
los 5, sin parámetro de modo**. El subconjunto acotado es transicional, no un
concepto de negocio; un knob tipo `skipPlanRestriction` en el path de
autorización es un footgun de seguridad; y el patrón de industria (Stripe /
LaunchDarkly) es una resolución determinística por sujeto+recurso con el rollout
controlado en una capa aparte, nunca un modo sobre el resolver.
`comoRecordDeModulos` (`capability.resolver.ts:245`) hoy dice "Existe para
comparar, no para consumir" — promoverlo a consumo en Fase 5 es un paso
deliberado, con su docstring actualizado.

Ninguno de estos puntos hizo falta tocar código para verlos. Ese es el valor del
método: la inconsistencia se encontró leyendo el modelo, no debuggeando el
síntoma.

## Cuándo se dispara sin que lo pidan

- La decisión toca `authorize()` / RBAC, o el gate de un módulo (402), o `req.user`.
- La decisión toca datos fiscales/legales (facturación, retención, AFIP/ARCA).
- La decisión cambia dónde vive una responsabilidad entre módulos (repos,
  resolvers, middlewares) o el contrato entre `app-main` y `appfrontend-main`.
- Una propuesta llega con la recomendación ya escrita y no con el razonamiento
  que la sostiene.
