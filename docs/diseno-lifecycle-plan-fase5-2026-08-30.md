# Diseño — ciclo de vida de plan (Fase 5): downgrade que apaga un módulo, y edición de preset

- **Fecha:** 2026-08-30
- **Estado:** diseño para **Fase 5**, sin encarar. Las decisiones de negocio
  (patrón aviso+gracia+corte; confirmación itemizada al editar un preset) están
  **confirmadas por el dueño el 30/08/2026**. Los mecanismos y las preguntas
  abiertas quedan acá para retomar.
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

## 5. Referencias

- [diseno-cascada-enforcement-2026-08-30.md](diseno-cascada-enforcement-2026-08-30.md).
- `pendientes-2026-08-25.md` L (degradación asistida en 3 etapas — asientos).
- `plan-separacion-dominios-multirubro-2026-08-28.md` §10 (auditoría — gap), §12
  (fases), §14 D5 (cambio de rubro).
- `criterios-negocio.md` A5 / A7.6 (política de retención) / A9.4 (audit log
  append-only); `criterios-datos.md`.
- `roadmap-pms-multirubro.md` (Promociones ❌).
