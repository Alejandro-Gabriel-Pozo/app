# Diseño — ciclo de vida de plan (Fase 5): downgrade que apaga un módulo, y edición de preset

- **Fecha:** 2026-08-30
- **Estado:** diseño para **Fase 5**, sin encarar. Las decisiones de negocio
  (patrón aviso+gracia+corte; confirmación itemizada al editar un preset) están
  **confirmadas por el dueño el 30/08/2026**. Los mecanismos y las preguntas
  abiertas quedan acá para retomar. **§5.5–§5.7 (revisión del 30/08, tras cerrar
  el bloque acotado `dbf9503`)**: la mecánica del cableado de escalones 2 y 4, el
  orden de sub-bloques, y 5 decisiones abiertas (A–E) sin cerrar.
- **Etiquetas:** `Fase-5` `plan` `entitlements` `downgrade` `presets` `mensajería`

## 0. Por qué existe este documento

El [cableado acotado de la cascada](diseno-cascada-enforcement-2026-08-30.md)
dejó **diferidos a Fase 5** el escalón 2 (preset de rubro) y el escalón 4
(`min_plan`). Cuando esos escalones entren al gate, una edición de preset o un
downgrade de plan pasan a mover el `402 MODULE_NOT_ENABLED` de ~20 grupos de
rutas para todos los tenants de un rubro/plan. Este documento fija cómo se hace
de forma controlada, en vez de "leer una columna en un gate por request".

Fase 5 (`plan-separacion-dominios-multirubro-2026-08-28.md` §12) trae las
pantallas de Superadmin para rubros/capacidades/presets; esas ediciones hoy "no
dejan rastro" (§10) — Fase 5 lo cierra.

## 1. Parte A — Downgrade de plan que deja un módulo por debajo de `min_plan`

Patrón: **aviso → gracia → corte**. Extiende a **entitlements de módulo** el
diseño de degradación asistida de `pendientes-2026-08-25.md` L, que hoy está
**acotado a asientos/membresías** (Etapa 1 implementada; Etapas 2-3 no).

Es el estándar de la industria para SaaS B2B: no se bloquea en seco un
downgrade; se avisa, se da un margen y recién después se corta.

### 1.1 Etapa 1 — selección / confirmación explícita

Al bajar de plan, si algún módulo con `min_plan` queda por encima del plan
nuevo, el `PATCH /platform/businesses/:id/plan` responde con el detalle (qué
módulos, qué rutas dejarían de estar disponibles) y **no aplica** el cambio
hasta confirmación explícita — mismo patrón que el
`409 SEAT_LIMIT_EXCEEDS_NEW_PLAN` actual.

### 1.2 Etapa 2 — período de gracia

- Duración **fija para empezar** (p. ej. 7 días). **Editable en Fase 5+** — no
  hardcodeada (mismo criterio "diseñar para editable" del resto del repo).
- Durante la gracia el módulo **sigue habilitado**. Se envían avisos.
- **Cantidad y espaciado de los avisos** viven en la misma tabla configurable
  que la duración, no como constante en código.

### 1.3 Etapa 3 — corte

- Al vencer la gracia sin upgrade, el módulo pasa a efectivamente deshabilitado
  (el escalón 4 empieza a restringir).
- **Cada paso** (aviso enviado, gracia iniciada, corte ejecutado) queda en
  `platform_audit_log`.

### 1.4 Invariante dura — lectura de documentos

Durante la gracia **y tras el corte**, la **lectura** de documentos y
transacciones ya emitidos **nunca** se corta (heredado del punto (d) de
[diseno-cascada-enforcement-2026-08-30.md](diseno-cascada-enforcement-2026-08-30.md)
y de `criterios-datos.md` línea 24). Sólo se bloquea la **creación/mutación**.

## 2. Parte B — Editar el preset de un rubro

Editar `industry_capabilities.enabled_by_default` de un rubro es una operación
**distinta y más amplia** que "asignar un rubro a un tenant"
(`plan-separacion-dominios-multirubro-2026-08-28.md` §14 D5, que se autolimita a
"nunca desactiva"). Editar el preset **sí puede** dejar un módulo en `false` por
default para **todos** los tenants de ese rubro que no tengan override
`source='TENANT'` o `source='SUPERADMIN'`.

### 2.1 Preview + confirmación itemizada

- Reusa el patrón de preview de D5 (`GET /platform/businesses/:id/industry-change-preview`),
  adaptado a la edición del preset.
- La confirmación debe **listar exactamente** qué módulos se desactivarían y
  **qué pierde acceso** cada tenant afectado (o el conteo de tenants), y exigir
  un click explícito del tipo *"entiendo que esto desactiva X, Y, Z para N
  negocios"* — **no** un modal genérico "¿confirmar?". La intención es que el
  operador entienda la consecuencia concreta, no que haya un botón de por medio.

### 2.2 Nunca pisa un override

Un módulo con override `source='TENANT'` o `'SUPERADMIN'` **no se toca**: la
edición de preset sólo mueve el default (`source='PRESET'`). Mismo criterio que
`criterios-negocio.md` A5 y el patrón "nunca un cambio de configuración
silencioso que afecte algo que el cliente ya compró".

### 2.3 Auditoría

Cada edición de preset queda en `platform_audit_log` (cierra el gap de §10).

## 3. Parte C — Infraestructura de mensajería (nota transversal)

- "Avisos de facturación/plan" (Parte A) y "comunicación de marketing"
  (cumpleaños, promociones — `roadmap-pms-multirubro.md` "Promociones ❌")
  **necesitan la misma infraestructura de envío**. No construir dos sistemas
  separados el día de mañana.
- **El canal importa por tipo de mensaje.** Un aviso de downgrade merece más
  urgencia que un email transaccional (¿WhatsApp en algún momento?). El diseño
  de esa infra debe contemplar canal por tipo.
- **Alcance de esta nota:** dejar registrado el punto de convergencia. El módulo
  de mensajería es su propio bloque, sin encarar.

## 4. Preguntas abiertas (cerrar en Fase 5)

- ¿El tiempo de aviso y de gracia es fijo para todos los planes, o configurable
  por plan/negocio? (Fijo para empezar; editable después — ver 1.2.)
- ¿Cantidad y espaciado de los avisos en la misma tabla configurable que el
  timing? (Propuesto: sí.)
- ¿Un downgrade da 402 en silencio tras el corte, o bloquea en el momento del
  downgrade con la selección? (Parte A propone: selección en Etapa 1 + gracia +
  corte.)
- Canal por tipo de mensaje: ¿email para todo al principio, WhatsApp para los
  urgentes después?

## 5. Hallazgo — nav y gate ya divergen; por qué Fase 5 converge en el resolver completo

Encontrado el 30/08/2026 en una ronda de análisis de implicancias
(`DECISION_REVIEW.md`), no en la pregunta original.

### 5.1 La divergencia estructural que ya existe

El nav del sidebar consume la cascada **completa**: `context.adapter.ts:119`
llama a `resolveCapabilities` con el input real (5 escalones) para
`/api/business/context`, y el `enabledModules` que gatea la navegación (V3-a /
V3-b) lo refleja **hoy**. `requireModule` (`security/module.middleware.ts:18` →
`PlatformRepository.getBusinessModules()`, `platform.repository.ts:420`) resuelve
sólo con los escalones 1 y 3. **Nav y gate calculan "enabled" distinto** — inerte
para el único negocio en producción (`industry_key` NULL, sin `min_plan`, todo
`implemented`), pero estructural.

El [cableado acotado](diseno-cascada-enforcement-2026-08-30.md) cierra el escalón
`NOT_IMPLEMENTED`; quedan el escalón 2 (preset) y el 4 (`min_plan`).

### 5.2 La pregunta que esto resuelve

No era "¿parámetro de escalones vs. input completo?". Era: **¿el gate converge en
la misma definición de "efectivo" que la UI ya muestra?**

### 5.3 Decisión — (B): input real completo, resolver corre los 5, sin parámetro

- **No hay pregunta de negocio** que sea "resolvé escalones 1,3,5 pero no 2,4".
  El subconjunto acotado fue un dispositivo transicional para diferir riesgo, no
  un concepto de dominio. Meterlo en la API de una función pura central deja a un
  lector futuro con un `{ skipPlanRestriction: true }` y la duda de cuándo es
  correcto.
- Un knob tipo `skipPlanRestriction` en el **path de autorización** es un footgun
  de seguridad: mal pasado en un gate, un módulo queda enforced-abierto que un
  plan debería restringir.
- `DEFENSIVE_DEVELOPING.md` §1.5 ("un solo camino por responsabilidad"): dos
  definiciones de "enabled" (una para nav, otra para gate) es exactamente eso.
- **Diseño de industria** (entitlements de Stripe / LaunchDarkly): una resolución
  **determinística por sujeto+recurso** dado el dato actual; el rollout de una
  regla nueva se controla en una **capa aparte** —una migración, un período de
  gracia, una regla de targeting sobre el dato—, nunca un modo sobre el resolver.
- `comoRecordDeModulos` (`capability.resolver.ts:245`) hoy dice *"Existe para
  comparar, no para consumir"*: promoverlo a consumo en Fase 5 es un paso
  deliberado, con su docstring actualizado.

Fase 5 **converge**: el gate enforcea el mismo "efectivo" que la UI muestra —
evita el escenario de soporte "el nav dice que tengo Reportes pero la API me da
402". El acotado interino se logra **no llamando al resolver** (2 queries +
`implemented`); Fase 5 lo **reemplaza** por la llamada real completa. Es un swap,
no "prender un flag".

### 5.4 Lo que queda abierto (más angosto)

La **mecánica de rollout** per-negocio del pasaje "escalón 2/4 inerte → en vivo":
¿flag en `businesses`? ¿columna `cascade_enforcement_version`? ¿entra para todos
el día que sale el código y la maquinaria de aviso/gracia/corte (Parte A) absorbe
el impacto? Este documento se inclina por lo último. **Resuelto en §5.5.5** (sin
flag; el rollout vive en el dato) tras la revisión del 30/08.

## 5.5 Mecánica del cableado de escalones 2 y 4 — revisión del 30/08

Hecha tras cerrar el bloque acotado (`dbf9503`). La **decisión (B)** de §5.3
sigue firme (resolver completo, input real, sin parámetro de modo); esto es el
*cómo*, en 6 puntos, con 5 decisiones abiertas en §5.7.

### 5.5.1 El método compartido — `resolveEffectiveModules(businessId)`

El input real ya lo arma `getContextInputs(businessId, locale)`
(`platform.repository.ts`) → `RawContextInputs` → `buildContextPayloadCore`
(`context.adapter.ts`; valida forma SQL / `plan` / `source` / `contextColor`) →
`resolveCapabilities()`. Hoy sólo lo consume `GET /api/business/context` (nav).

Fase 5: extraer `resolveEffectiveModules(businessId): EffectiveCapability[]` en
el repo (la misma sentencia de `getContextInputs`, **sin** el subselect de
terminología) y que lo consuman **los dos** lados:

- `context.adapter` → proyecta `enabledModuleKeys` (el `enabledModules` del payload).
- `requireModule` (vía `getBusinessModuleGates`) → proyecta `comoRecordDeModulos`
  para el `enabled`, más `restrictedBy`/`origin` por módulo para el `402`.

Una sola definición de "efectivo" para nav y gate (DEFENSIVE §1.5). El
`context.adapter` deja de llamar a `resolveCapabilities` directo. Invariante a
preservar: un `ContextDataError` (forma SQL rota / `plan` inválido) en el gate →
`503 PLATFORM_UNAVAILABLE`, **nunca** "todo `false`" ni "todo `true`" (ya en
`diseno-cascada-enforcement-2026-08-30.md` §4).

### 5.5.2 Prerequisito duro — lecturas de TRANSACCIÓN/DOCUMENTO detrás de gates

Criterio: `criterios-datos.md` R2/R3 (líneas 83, 218 — una reserva histórica
cuyo recurso ya se había desactivado **dejaba de poder leerse**, y quedó
**corregido**) + §1.4 de este doc. Apenas se cargue el primer preset o
`min_plan`, una edición de preset o un downgrade movería el `402` de **lecturas
de registros que siguen existiendo**.

Inventario de GET gateados por módulo (verificado contra `src/app.ts` el 30/08):

| Ruta | Módulo | Gate | Clase | Acción Fase 5 |
|---|---|---|---|---|
| `GET /api/orders*` | POS_RESTAURANTE | mount-level (todos los verbos) | TRANSACCIÓN | ungate GET |
| `GET /api/stays*` | ALOJAMIENTO | mount-level | TRANSACCIÓN | ungate GET |
| `GET /api/accounts-receivable*` | CUENTAS_CORRIENTES | mount-level | TRANSACCIÓN | ungate GET |
| `GET /api/cash-register*` | CUENTAS_CORRIENTES | mount-level | TRANSACCIÓN (arqueos) | ungate GET |
| `GET /api/housekeeping*` | HOUSEKEEPING | mount-level | TRANSACCIÓN (tareas) | ungate GET |
| `GET /customers/:id/account` | CUENTAS_CORRIENTES | per-route | TRANSACCIÓN | ungate |
| `GET /customers/:id/outstanding-invoices` | CUENTAS_CORRIENTES | per-route | DOCUMENTO | ungate |
| `GET /api/reservations*` | — | ya sin gate de módulo | TRANSACCIÓN | nada |
| `GET /api/products*`, `/waste-reasons`, `/consumption-destinations` | POS_RESTAURANTE | mount-level | MAESTRO (config) | decisión — §5.7 B |
| `GET /api/reports*` | REPORTES | mount-level | vista derivada | decisión — §5.7 E |

Trabajo: pasar los `app.use('/api/x', requireModule(container, mod), router)` a
gating **per-route** (como `invoices` en `dbf9503`) o un helper
`gateMutations(container, module)` que aplique `requireModule` sólo a
`POST/PUT/PATCH/DELETE`. Es el bloque de código más grande y va **antes** de
cargar datos de escalón 2/4. Inerte hasta entonces.

### 5.5.3 Escalón 2 prende sin fila en `business_modules`

`resolveCapabilities` ya lo maneja (`origin: 'INDUSTRY_PRESET'`, `source: null`).
El `402` de otros módulos puede entonces traer `origin: 'INDUSTRY_PRESET'` —
valor nuevo, aditivo, backend-only (`http.ts` sigue como subconjunto).

### 5.5.4 `industry_capabilities.required` no lo mira el resolver

`plan-separacion-dominios-multirubro-2026-08-28.md` §5.3b (línea 516: `PATCH
/api/business/modules/:moduleKey` opera dentro del `required` del rubro) lo trata
como **duro**: el tenant no puede apagar un módulo obligatorio. Pero
`resolveCapabilities` deja ganar siempre al override (escalón 3); `required` no
se consulta. **Gap.** Dos caminos:

- **(i)** enforcement sólo en el write path: `PATCH` rechaza `enabled = false`
  para un módulo `required`. El resolver queda "last writer wins". No cubre el
  caso de `required` agregado a un preset *después*, con una fila
  `business_modules.enabled = false` preexistente.
- **(ii)** `required` como **piso en el resolver** (escalón 3.5:
  `if (preset.required) enabled = true`). Cierra el gap retroactivo; es un
  escalón nuevo.

Hoy no hay presets → no bloquea. Resolver antes de cargar el primero.

### 5.5.5 Rollout — sin flag; el rollout vive en el dato

Expande §5.4. El resolver corre **siempre** los 5 escalones. Escalón 2/4 son
inertes **porque no hay datos** (0 `industry_key`, 0 `min_plan` — verificado
contra `pdb-ppms` el 30/08, ver `zulu-hub-continuidad` §1 re-chequeo). Entran en
vivo cuando se carga el primer preset/`min_plan`, con su preview (§2) y su
aviso/gracia/corte (§1).

**No** hay `cascade_enforcement` en `businesses`: eso sería un modo sobre el
resolver, contra la decisión (B). El control es un **gate de release**: un script
read-only que corre `resolveEffectiveModules` contra la BD de cada tenant y
**falla si algún `Record` cambia** sin una fila de escalón 2/4 que lo justifique
— el mismo método usado para verificar el bloque acotado.

### 5.5.6 Contrato del `402`

`ModuleGate.origin` / `restrictedBy` pasan de los `Extract<>` acotados
(`SYSTEM_DEFAULT|TENANT_OVERRIDE` / `NOT_IMPLEMENTED|null`) al `CapabilityOrigin`
/ `CapabilityRestriction` completos — o `ModuleGate` se vuelve alias de
`{ moduleKey, enabled, origin, restrictedBy }` de `EffectiveCapability`. `http.ts`
(frontend) sigue como subconjunto tipado (backend-only, ya decidido en §3e del
enforcement doc). `restrictedBy: 'MIN_PLAN'` en el body → el frontend puede
rutear a `UpgradePrompt` (ya existe para `PLAN_LIMIT_REACHED`).

## 5.6 Orden de sub-bloques (un commit cada uno)

1. **Prerequisito** — ungate de GET de TRANSACCIÓN (per-route / `gateMutations`).
   El más grande. Inerte hoy. **Se puede hacer ya.**
2. **Convergencia** — `resolveEffectiveModules(businessId)` compartido
   gate ↔ adapter. Verificado por equivalencia. **Se puede hacer ya.**
3. **`required`** — decidir (i) write-path o (ii) piso en el resolver.
4. **Superadmin** (`plan-separacion` §12) — pantallas de preset/`min_plan` con
   preview + confirmación itemizada (§2) + auditoría (`platform_audit_log`).
   Recién acá se **cargan** datos de escalón 2/4.
5. **aviso/gracia/corte** (Parte A) — para el primer downgrade real.

1 y 2 son código chico e inerte, verificable ahora. 3 es una decisión de
negocio. 4 y 5 son Fase 5 plena.

## 5.7 Decisiones abiertas — cerrar antes de un commit de código

- **A.** Mecanismo: ¿`resolveEffectiveModules` compartido gate ↔ adapter (§5.5.1)?
- **B.** ¿Los GET de MAESTRO (`products`, `waste-reasons`,
  `consumption-destinations`) se ungatean, o quedan gateados como config — mismo
  criterio que `afip-credentials/status` (perdés el producto → perdés su config,
  no tus registros)?
- **C.** `required` → write-path (i) o piso en el resolver (ii) (§5.5.4)?
- **D.** Rollout: ¿§5.5.5 (sin flag; rollout en el dato) + gate de release por
  equivalencia?
- **E.** ¿`GET /api/reports` sigue gateado? Un reporte es vista derivada, no
  registro emitido — pero hoy no hay export crudo fuera de los módulos, así que
  un negocio downgradeado no tiene **ninguna** vía de leer sus históricos
  agregados. Gap de roadmap, no de este diseño.

## 6. Referencias

- [diseno-cascada-enforcement-2026-08-30.md](diseno-cascada-enforcement-2026-08-30.md);
  `DECISION_REVIEW.md` (el método de la ronda que produjo §5).
- `pendientes-2026-08-25.md` L (degradación asistida en 3 etapas — asientos).
- `plan-separacion-dominios-multirubro-2026-08-28.md` §10 (auditoría — gap), §12
  (fases), §14 D5 (cambio de rubro).
- `criterios-negocio.md` A5 / A7.6 (política de retención) / A9.4 (audit log
  append-only); `criterios-datos.md`.
- `roadmap-pms-multirubro.md` (Promociones ❌).
- Anclas del hallazgo nav-vs-gate: `src/business-context/context.adapter.ts:119`,
  `src/platform/platform.repository.ts:420`, `src/security/module.middleware.ts:18`,
  `src/business-context/capability.resolver.ts:245`.
- Anclas de §5.5 (revisión 30/08): `src/business-context/capability.resolver.ts`
  (`resolveCapabilities`, `restriccionQueAplica`, `comoRecordDeModulos`),
  `src/business-context/context.adapter.ts::buildContextPayloadCore`,
  `src/platform/platform.repository.ts::getContextInputs`,
  `src/platform/platform.repository.ts::getBusinessModuleGates` (post-`dbf9503`),
  `src/app.ts` (montaje de gates de módulo), `plan-separacion` §5.3b (línea 516,
  `required`).
