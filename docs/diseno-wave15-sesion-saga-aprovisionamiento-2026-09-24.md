# Diseño — Wave 15: "Sesión + saga de aprovisionamiento"

**Fecha:** 2026-09-24
**Origen del encargo:** `docs/plan-ejecucion-integral-2026-09-16.md` §3, fila 15.
**Estado de la oleada antes de este documento:** NO INICIADA — cero commits,
cero doc de diseño propio. Verificado en código, no asumido (ver §0.2).
**Alcance de este documento:** investigación + diseño. No autoriza
implementación de ningún ítem — cada uno todavía necesita su propio gate de
`architecture-governor` (y, donde se indica, `criterios-negocio`) antes de
tocar código. Este documento tampoco resuelve las bifurcaciones de negocio
que encuentra: las deja explícitas para `AskUserQuestion`.

**Convención de cita:** todo `D-XX`/`P-XX` sin documento explícito es del
registro `docs/auditoria-integral-fase15-2026-09-16.md` (Fase 15). Las citas
a `decisiones-auditoria-fase2-2026-09-15.md` y a
`decisiones-plan-integral-2026-09-16.md` llevan su nombre completo, siguiendo
la regla que el propio plan exige (`CLAUDE.md`/plan §1, Apéndice A.1/A.4 de
`decisiones-plan-integral`).

---

## 0. Método

### 0.1 Orden de dependencia del plan (respetado, no reordenado)

1. Reconciliación **P-02 (D-04)** + **D-07** (`decisiones-auditoria-fase2-2026-09-15.md` §11, TTL de sesión por tenant)
2. **D-04** — revocación real (`token_version`), opción (A) todavía sin decisión del dueño
3. **D-05/P-03** — vínculo a empresa por UUID
4. **D-12/P-08** — sweep de recuperación del outbox
5. **D-18/P-12** — dirección del bus `wake()`
6. **D-19/P-10** — PDF de comprobantes: timeout (no opcional) + materialización
7. **D-14** — extracción de `tenant-provisioning.service.ts`

### 0.2 Verificación de estado real (contra HEAD `a7d06be`, no contra los documentos de auditoría)

| Ítem | Comando | Resultado |
|---|---|---|
| `tenant-provisioning.service.ts` | `find src -iname "*tenant-provisioning*"` | No existe |
| `TenantProvisioner` (puerto F7-04c, prerrequisito de D-14) | `grep -rn "TenantProvisioner" src` | No existe |
| `token_version`/`tokenVersion` | `grep -rn` en `src` | No existe |
| `resolveSessionTtl` | `grep -rn` en `src` | No existe |
| Sweep del outbox | `grep -n "sweep" src/workers/outbox.worker.ts` | Solo comentarios que lo declaran "todavía en HOLD" |
| `AdaptivePoller.wake()` en producción | `grep -rn "wake(" src` | Un solo consumidor: `company-sync.worker.ts` (Bloque 1, ya cerrado). `OutboxWorker` y `reservation-hold-expiry.worker` siguen en `setInterval` fijo |
| Timeout/semáforo de generación de PDF | `grep -n "Semaphore\|AbortSignal.timeout"` en `invoice-pdf.service.ts`/`invoices.routes.ts` | No existe |
| `POST /api/companies/link` | Lectura directa | Sigue vinculando en un solo paso, sin token ni aprobación |

Confirma la premisa del encargo: los 7 ítems están genuinamente sin arrancar.
También confirma que el número de copias de la saga de D-14 bajó de 4 a 3
desde que se escribió Fase 15: `admin.routes.ts` retiró `repair-tenant-db`
en Wave 7 (D-06/P-04, `docs/decisiones-plan-integral-2026-09-16.md:63-68`).
Quedan: `business.routes.ts` (alta pública), `platform.routes.ts` (reintento
de superadmin) y `admin.routes.ts::set-tenant-url` (apuntar a una URL
explícita). El defecto que D-14 describe —divergencia de `evictTenantPool`
y de política de fallo entre copias— sigue intacto en las 3.

### 0.3 Grounding — cuáles ítems lo necesitan

Siguiendo el criterio del propio plan (`erp-audit-orchestrator`/`auditor-circuitos-erp`
para decisiones de negocio con precedente externo relevante; no para fixes de
confiabilidad interna): de los 7 ítems, **ninguno pidió grounding nuevo en
esta sesión**. Los 5 primeros son mecanismos de infraestructura interna
(sesión, outbox, workers, PDF) sin un patrón de "cómo lo hace la industria"
que cambie la decisión — y donde sí había una pregunta con precedente externo
real (D-05, vínculo entre organizaciones; D-19, servir PDF materializado) el
grounding **ya se corrió** en la sesión del 16/09/2026 y su resultado ya está
en `docs/decisiones-plan-integral-2026-09-16.md` (citado en cada sección). No
se re-invocó `auditor-circuitos-erp` porque no apareció ninguna pregunta de
UX/producto nueva sin cubrir. D-14 es estructural, no de producto — su
`erp-audit-orchestrator` corresponde **después** de la extracción, por
mandato del propio plan, no antes.

---

## 1. Reconciliación P-02 (D-04) + D-07 (TTL de sesión por tenant)

**Qué pide:** el gate de `decisiones-plan-integral-2026-09-16.md` (Apéndice
A.1, líneas 321-371) dejó registrado que la fila `P-02 (D-04)` de la tabla
resumen (*"Solo idle timeout, sin tope absoluto"*) es la **única** decisión
de las 25 sin sección de detalle — sin contexto, sin alternativa descartada,
sin gatillo — y señaló que cruza con una decisión ya tomada por separado:
`decisiones-auditoria-fase2-2026-09-15.md` §11 (`D-07`, "TTL de sesión"):
**por tenant**, no global por env var, vía un `resolveSessionTtl()` por
audiencia (staff/cliente/plataforma) que reemplace las 5 copias hoy
dispersas (`auth.service.ts:98`, `customer.auth.service.ts:66`,
`customer.routes.ts:646`, `auth.middleware.ts:112`, `business.routes.ts:189`
hardcodeado). El propio A.1 da el texto mínimo que debe llevar la sección
de detalle faltante — este diseño lo desarrolla.

**Estado real de la sesión hoy** (verificado en código, no en el documento):
`JWT_EXPIRES_IN` (default `86_400` s = 24 h) es una vida **fija** desde la
emisión — no se reinicia con actividad. No existe ningún idle timeout
todavía: hay que construirlo, no ajustarlo. `/refresh` (`auth.service.ts:223`,
`customer.auth.service.ts`) renueva sin tope de vida absoluta — eso es
exactamente lo que P-02 decidió **no** cambiar.

### 1.1 Diseño propuesto (listo para su propio gate)

**Clasificación (`criterios-negocio`):** `resolveSessionTtl()` no es una
entidad de dominio nueva, pero la columna que lo alimenta sí toca
`business_profile`/`businesses` (configuración multi-tenant) — cae bajo la
misma disciplina que `PLAN_LIMITS` (18/08/2026): antes de implementar,
correr la skill `criterios-negocio` sobre la tabla/columna nueva. Esto **no
se resuelve en este documento** — queda como paso obligatorio del gate de
implementación, tal como el propio plan lo pide explícitamente para "el
bloque de sesión".

**Mecanismo:**

1. **Columna de configuración por tenant.** `businesses.session_ttl_seconds`
   (o, si se prefiere agrupar con el resto de configuración de negocio,
   dentro de `business_profile`) — nullable, default `NULL` = usa la
   constante de producto. Sigue el patrón ya usado por `PLAN_LIMITS`: no
   inventa un mecanismo de configuración nuevo.
2. **`resolveSessionTtl(audience: 'staff' | 'customer' | 'platform', businessId?: string): number`**
   en un módulo nuevo (`security/session-ttl.ts`, o junto a
   `config/env.ts` si Wave 7 ya lo consolidó — verificar al implementar).
   Reemplaza los 5 call-sites dispersos. Para `platform` no hay tenant, así
   que ese caso es siempre la constante fija — no aplica "por tenant" (el
   superadmin no tiene `businessId`).
3. **Idle timeout — RESUELTO (24/09/2026, `AskUserQuestion`, ver §1.2).**
   Se construye **sobre `/refresh` tal cual existe hoy** — opción (b) del
   borrador original, sin agregar claim nueva (`iat`/`last_activity`) ni
   endpoint nuevo. Verificado contra el código real, no contra el boceto:
   - Staff: `POST /api/auth/refresh` (`api/routes/me.routes.ts:86-95`) —
     handler síncrono, sin idle-check hoy, que llama a
     `authService.refreshTenantToken(req.user.id, req.user.businessId)`
     (`security/auth.service.ts:223-230`) y re-firma incondicionalmente con
     un `exp` nuevo de `this.tokenTtlSeconds` completos (no una extensión
     corta) mientras `authenticate()` ya haya validado que el token vigente
     no expiró.
   - Portal: `POST /api/customer/refresh` (`api/routes/customer.routes.ts:689`,
     mismo criterio, documentado en su propio docblock `:53,66-70`).
   - El mecanismo de idle-timeout pasa a ser: `resolveSessionTtl('staff'|'customer', businessId)`
     (§1.1.2) deja de ser la ventana de vida *absoluta* del token para
     convertirse en la ventana de **idle tolerado** — el token expira por su
     propio `exp` si nadie vuelve a llamar `/refresh` dentro de esa ventana,
     y `/refresh` no tiene forma de reactivar un token ya vencido (falla con
     `JWT_EXPIRED`/`TOKEN_EXPIRED`, `auth.middleware.ts:301-303`, obligando a
     loguearse de nuevo). No hay tope de vida absoluta separado — eso sigue
     siendo la opción (C), descartada por P-02 y fuera de este ítem.
   - **Dependencia no resuelta por este documento, para dejar explícita en el
     gate de implementación:** hoy el frontend (`AuthContext`, según el
     propio docblock de `me.routes.ts:34-41`) llama a `/refresh`
     **periódicamente mientras la pestaña sigue abierta**, no en respuesta a
     actividad real del usuario. Con eso sin cambiar, achicar
     `resolveSessionTtl()` no produce un idle-timeout real — produce "la
     sesión sobrevive mientras la pestaña esté abierta", que es más corto
     pero no la misma propiedad. Que el polling pase a gatillarse por
     actividad real (mouse/teclado/fetch del usuario) en vez de por timer
     fijo es un cambio del lado de `appfrontend-main` (`AuthContext`), fuera
     del alcance de este documento — pero el gate que autorice este bloque
     necesita decidirlo explícitamente, o el idle-timeout no cumple lo que
     su nombre promete.
4. **Alcance explícitamente NO cubierto por esta decisión** (tal como pide
   el texto de A.1): la opción **(A)** de `D-04` original — revocación real
   ante cambio de contraseña, borrado de cuenta o customer inactivo, vía
   `token_version` — es un ítem separado, **ya resuelto** en §2 (el dueño
   dijo proceder). No se bundlea acá aunque comparta archivo.

### 1.2 Bifurcación de negocio — RESUELTO (24/09/2026, `AskUserQuestion`)

**Pregunta:** ¿la renovación de `/refresh` funciona como idle timeout de
facto (opción b), o se agrega una segunda claim `iat`/`last_activity`
verificada en cada request (opción a)?

**Resolución del dueño:** opción (b) — construir sobre el endpoint
`/refresh` existente, no un endpoint/claim nuevo. Motivo registrado por el
dueño: menor radio de cambio, reutiliza el mecanismo que ya existe y que el
frontend ya llama en background, sin tocar el middleware de auth caliente
en cada request con una comparación adicional. Ver §1.1.3 para el mecanismo
concreto y la dependencia de cadencia de polling del frontend que esta
resolución deja pendiente de decidir en el gate de implementación.

### 1.3 Riesgo / reversibilidad

**Bajo y reversible.** Una columna nueva con default `NULL` (no cambia el
comportamiento de ningún tenant existente hasta que alguien la setee) + un
resolver puro + reemplazar 5 lecturas dispersas por una llamada a ese
resolver. Rollback: revertir el resolver, los 5 call-sites vuelven a leer
`JWT_EXPIRES_IN` directo; la columna puede quedar sin uso sin dañar nada.
**Puede avanzar hacia implementación** — la bifurcación de §1.2 ya está
resuelta (24/09/2026); queda correr `criterios-negocio` sobre la columna
nueva y, en el mismo bloque, decidir la dependencia de cadencia de polling
del frontend señalada en §1.1.3. No requiere sign-off de riesgo del dueño
más allá de eso (no es una acción irreversible: no borra sesiones
existentes, no corre DDL contra datos ya escritos más que agregar una
columna nullable).

---

## 2. D-04 — Revocación real de sesión (`token_version`), opción (A) — RESUELTO 24/09/2026

**Qué pide (Fase 15, D-04, opción A):** una columna `token_version` en
`identities` y `customers`, embebida en el JWT y comparada en cada request;
incrementarla invalida todos los tokens emitidos antes del incremento. Cierra
tres de los cuatro casos abiertos de D-04: (a) cambio de contraseña no
invalida el token anterior; (b) borrado/anonimización de cuenta de cliente
tampoco; (c) no hay chequeo de existencia/estado del customer en el
`authenticate()` del portal.

### 2.1 Por qué esto es una bifurcación de negocio, no una tarea técnica

`decisiones-plan-integral-2026-09-16.md` Apéndice A.1 (líneas 335-342) es
explícito: la decisión registrada de P-02 descarta la opción **(C)** (tope de
vida absoluta) — **no dice nada de la opción (A)**. La fuente (Fase 15,
D-04) la recomienda y la separa a propósito de (C) porque no choca con el
motivo de `/refresh` ("el recepcionista no quiere volver a loguearse en
medio del turno"): (A) no fuerza re-login periódico, solo corta sesiones
**específicas** cuando hay una razón concreta (contraseña cambiada, cuenta
borrada). O sea que técnicamente (A) no tiene el mismo costo de producto que
(C) — pero sigue siendo una decisión que nadie tomó todavía, y tiene un
efecto observable real: **"un default mal elegido invalida todas las
sesiones vivas al desplegar"** (Fase 16 §13, fila P3/D-04) — el primer
deploy que agregue la columna necesita decidir qué valor de `token_version`
llevan las filas existentes, y esa elección por sí sola puede desloguear a
todo el staff de todos los tenants en el momento del deploy si se elige mal.

**Resolución del dueño (24/09/2026, `AskUserQuestion`, "opción A"):**
proceder con el diseño. Restricción de seguridad explícita, dada como parte
de la respuesta: *"el rollout por default no puede invalidar las sesiones
existentes"* — es decir, cualquier valor con el que `token_version` nazca en
el deploy inicial no puede desloguear en masa al staff de ningún tenant. El
resto de este ítem convierte esa restricción en un mecanismo concreto (§2.2),
no en una promesa.

### 2.2 Diseño resuelto — mecanismo de rollout seguro (no un boceto)

**Por qué el peligro no está en la columna, sino en la comparación.**
`identities.token_version integer NOT NULL DEFAULT 0` (ídem `customers`) es,
por sí sola, inofensiva: un `ALTER TABLE ... ADD COLUMN` con default no
cambia el comportamiento de ningún token existente hasta que algo empiece a
leerla. El riesgo real descrito por Fase 16 §13 (fila P3/D-04) vive en el
otro lado: **todo JWT emitido antes de este deploy no tiene claim `tv` en su
payload**, porque `signToken()` (`security/auth.middleware.ts:110-125`) no la
escribía todavía. Si la verificación nueva hace una comparación estricta
(`payload.tv !== identity.token_version`), entonces para cada sesión viva en
el momento del deploy `payload.tv` es `undefined` y la comparación da
`undefined !== 0` → `true` → **rechazo** — exactamente el modo de falla que
la restricción del dueño prohíbe, y ocurre para el 100% de las sesiones
activas en el mismo instante del deploy, no de a una.

**Mecanismo elegido: claim ausente se interpreta como el valor `0`, nunca
como "sin verificar".**

```
const currentTv = <token_version leído de BD para esa identity/customer>;
const tokenTv = payload.tv ?? 0;   // ausencia de claim == 0, no == skip
if (tokenTv !== currentTv) { /* 401, mismo código que MEMBERSHIP_INACTIVE */ }
```

Combinado con el default de columna (`DEFAULT 0`, backfill automático para
toda fila existente), esto cierra el hueco sin necesidad de ninguna otra
decisión de negocio:

- **En el instante del deploy:** BD tiene `token_version = 0` para todas las
  identities/customers existentes (default de la migración). Todo JWT viejo,
  sin claim `tv`, se trata como `tv = 0` por la coerción `?? 0`. `0 === 0` →
  pasa. **Ninguna sesión viva se cae al desplegar** — la restricción del
  dueño queda satisfecha por construcción, no por una elección de valor que
  alguien podría volver a errar en el próximo deploy.
- **Tokens nuevos, emitidos después del deploy** (`issueTenantToken()` en
  login, `refreshTenantToken()` en `/refresh` — §1 —, `selectBusiness()`,
  `loginWithGoogle()`, y sus equivalentes de `customer.auth.service.ts`):
  llevan `tv: <token_version actual>` embebido explícitamente, sin depender
  de la coerción.
- **La revocación real sigue funcionando**, no es un chequeo de utilería: en
  cuanto alguien cambia la contraseña de una identity (`UPDATE identities SET
  token_version = token_version + 1`), CUALQUIER token con `tv` ausente o con
  el valor viejo — viva desde antes del deploy o emitido después pero antes
  del bump — deja de matchear `currentTv` y se rechaza en el próximo request.
  La coerción `?? 0` es equivalente a que la BD y el JWT compartan el mismo
  valor de partida (`0`); a partir de ahí el mecanismo de comparación es el
  mismo para tokens viejos y nuevos, sin caso especial permanente — es un
  puente de una sola vez para la migración, no una excepción que quede
  colgando en el código para siempre.
- Cambio de contraseña → `UPDATE identities SET token_version = token_version + 1`.
- Borrado/anonimización de cuenta de cliente → mismo patrón sobre `customers`.
- Caso (c) de D-04 (chequeo de existencia/estado del customer) se resuelve
  gratis con la misma query **solo del lado staff** — ver la nota de costo
  más abajo, es distinto para el portal.

**Sub-hallazgo de costo, no una bifurcación de negocio nueva — corrección al
boceto original:** `authenticate()` (`security/auth.middleware.ts:296-329`)
ya hace un lookup de membership por request para tokens de staff
(`resolveMembershipContext`, línea 312-329) — ahí el chequeo de
`token_version` es gratis, mismo viaje a BD. Pero esa rama se salta a
propósito para `payload.role === UserRole.CUSTOMER` (línea 312): **hoy no
existe ningún lookup por-request equivalente para el portal de clientes** —
es precisamente el hueco que el propio D-04, caso (c), señala ("no hay
chequeo de existencia/estado del customer en el `authenticate()` del
portal"). Para el portal, el chequeo de `token_version` **no es gratis**:
agrega una query nueva a cada request autenticada de `customer.routes.ts`
que hoy no existe. Esto no bloquea la resolución de §2.1 (la restricción del
dueño era sobre el default de rollout, no sobre el costo de performance del
portal) pero el gate de implementación debería decidir explícitamente si
ese costo nuevo es aceptable tal cual, o si conviene resolverlo junto con el
propio caso (c) (un solo lookup que traiga `token_version` + `status`/
`deleted_at` del customer a la vez, en vez de dos).
- Caso (d) de D-04 (`/refresh` sin tope) sigue siendo la opción (C), fuera de este ítem — ya decidida en contra por P-02.

### 2.3 Riesgo / reversibilidad

**Medio, no irreversible, con el punto de despliegue delicado ya cerrado por
diseño.** El mecanismo en sí es reversible (columna + comparación, se puede
revertir sin pérdida de datos). El riesgo que motivaba dejar esto abierto —
"un default mal elegido desloguea a todo el staff al desplegar" — queda
neutralizado por construcción con la coerción `payload.tv ?? 0` de §2.2, no
por una elección de valor que dependa de que alguien la piense bien en cada
deploy futuro. Queda un costo de performance nuevo en el portal de clientes
(sub-hallazgo de §2.2) a decidir en el gate de implementación, y el mismo
paso por `criterios-negocio` que ya pedía el boceto original (columna nueva
en `identities`/`customers`, dos entidades maestras). **Puede avanzar hacia
implementación** — no requiere una nueva ronda de `AskUserQuestion`, la
restricción de seguridad del dueño ya tiene mecanismo concreto que la
cumple.

---

## 3. D-05 / P-03 — Vínculo a empresa por UUID: solicitud + aprobación en dos pasos — actor de aprobación RESUELTO 24/09/2026

**Qué pide:** `decisiones-plan-integral-2026-09-16.md` (P-03, líneas 55-60)
ya decidió la forma: **solicitud + aprobación en dos pasos** (opción B de
Fase 15), descartando el token de un solo uso (opción A, "forma más débil de
las dos" según el grounding, con la corrección del Apéndice A.7 sobre esa
misma frase — la conclusión no cambia, solo la fuerza declarada de la
evidencia). Cierra `D-05` (Fase 15): hoy `POST /api/companies/link` vincula
con solo verificar que la empresa exista, sin invitación ni notificación al
lado receptor, y el `CompanyCatalogPropagationWorker` propaga catálogo
completo apenas se vincula.

**Gatillo de revisión declarado:** ninguno — es la decisión de mayor
alcance de las dos, tomada con esa consecuencia asumida (`decisiones-plan-integral:60`).

### 3.1 Diseño propuesto (listo para su propio gate)

**Clasificación (`criterios-negocio`):** entidad transaccional nueva
(solicitud de vínculo, con estado y ciclo de vida) que cruza el límite entre
dos tenants (`businesses`) — corre la skill antes de tocar `platform.schema.sql`,
no se resuelve acá.

**Modelo:**

- Tabla nueva en `platform.schema.sql`: `company_link_requests` — `id`,
  `requesting_business_id` (FK `businesses`), `target_company_id` (FK
  `companies`), `status` (`PENDING` / `APPROVED` / `REJECTED` /
  `CANCELLED`), `requested_by_identity_id`, `requested_at`, `resolved_by_identity_id`
  nullable, `resolved_at` nullable. Un índice único parcial `WHERE status = 'PENDING'`
  sobre `(requesting_business_id, target_company_id)` — mismo patrón CASE-based
  que el repo ya usa para "a lo sumo una fila activa" (`CLAUDE.md` app-main,
  sección Modularidad).
- `POST /api/companies/link-requests` (reemplaza el efecto inmediato de
  `POST /api/companies/link`): MANAGEMENT + plan ENTERPRISE del negocio que
  pide vincularse, crea la fila `PENDING`. **No vincula nada todavía.**
- `POST /api/companies/link-requests/:id/approve` / `.../reject` — **path
  corregido respecto del boceto original** (que decía
  `/platform/companies/:companyId/link-requests/:id/approve`; ver §3.2 para
  por qué ese prefijo era incompatible con la resolución del dueño). Vive en
  el mismo router que ya monta `POST /api/companies/link` hoy
  (`platform/companies.routes.ts`, montado en `app.ts:336` bajo
  `/api/companies` — pese al nombre de carpeta `platform/`, es un router de
  tenant, no de superadmin) y usa `authorize(Roles.MANAGEMENT)` exactamente
  como sus dos vecinos (`companies.routes.ts:55,67,81`). El `businessId`
  aprobador sale de `req.user.businessId` (el JWT del staff que aprueba, no
  un parámetro de la URL) — ver §3.2 para el guard adicional que esto
  necesita.
- Al aprobar: recién ahí `linkBusinessToCompany()` (ya existe) corre, dentro
  de la misma transacción que marca la solicitud `APPROVED`.
- Auditoría de ambos lados: usar `domain/audit.ts::recordFieldChanges()`
  sobre la fila de la solicitud (ya declarado como el patrón obligatorio del
  repo para "diff + auditoría si cambió algo" — `CLAUDE.md` app-main).
- Desvínculo operable: `POST /api/companies/unlink` (no existe hoy) —
  mencionado por D-05 como parte del "comportamiento esperado" pero es una
  pieza aparte, no bloqueante para el flujo de aprobación en sí.
- Vínculos ya existentes (si los hay hoy en producción): no se tocan por
  este bloque — decisión explícita del dueño en el gate de implementación
  (¿se re-validan o se dan por buenos?), la misma pregunta que D-05 ya deja
  planteada y que `decisiones-plan-integral` no resolvió (no aparece en su
  detalle).

### 3.2 Actor de aprobación — RESUELTO 24/09/2026 (`AskUserQuestion`)

**Pregunta:** ¿quién aprueba del lado de la empresa destino? Una `company`
no necesariamente tiene un usuario de plataforma logueado que pueda
"aprobar" nada — el modelo de multipropiedad de este repo no define hoy
quién representa a una `company` fuera de los negocios ya vinculados a
ella. El boceto ofrecía tres opciones sin resolver: (i) cualquier MANAGEMENT
de cualquier negocio ya vinculado a esa `company`; (ii) email de contacto
propio de la `company` + link firmado; (iii) solo superadmin de plataforma.

**Resolución del dueño:** opción (i) — "cualquier usuario con rol MANAGEMENT
de esa empresa" — reutilizando `Roles.MANAGEMENT` tal cual existe, sin
modelo de actor/rol nuevo. Mismo criterio que el repo ya usa en otras
decisiones de alcance-por-empresa (no se inventa un "aprobador de
`company`" separado del staff que ya gestiona los negocios vinculados a
ella).

**Qué cambia esto en el diseño de §3.1, concretamente:**

- **Corrección de ruta, no solo de vocabulario.** El boceto original ponía
  el endpoint de aprobación bajo `/platform/companies/:companyId/...`. Con
  la resolución (i), eso queda incompatible con el propio mecanismo de
  autorización: `/platform/*` (`app.ts:273`) es el universo de superadmin —
  clave separada (`PLATFORM_JWT_SECRET`), payload `PlatformJwtPayload`
  (`platform/platform.auth.middleware.ts:29-35`), `req.platformUser`, sin
  relación con `Roles.MANAGEMENT` ni con membership de negocio. `Roles.MANAGEMENT`
  solo existe como concepto donde ya vive hoy: rutas `/api/*`, resuelto vía
  `resolveMembershipContext(payload.sub, payload.business_id)`
  (`security/auth.middleware.ts:312-329`), que depende de que el JWT sea de
  staff con `business_id`. Por eso el endpoint pasa a `/api/companies/link-requests/:id/approve`
  (§3.1) — mismo router y mismo prefijo que ya usa `POST /api/companies/link`
  hoy.
- **Guard adicional, no solo `authorize(Roles.MANAGEMENT)`.** Que el usuario
  tenga MANAGEMENT no alcanza — tiene que tener MANAGEMENT **del negocio que
  ya está vinculado a la `company` destino**, no de cualquier negocio del
  sistema. Eso es una verificación de pertenencia (¿el
  `req.user.businessId` de quien aprueba está entre los negocios ya
  vinculados a `target_company_id`?), estructuralmente igual al patrón que
  el repo ya nombra para el caso análogo del portal de clientes
  (`requireOwnReservation()`, RBAC-OWN-001,
  `app-main/CLAUDE.md`/`authorization-surface-mapping`) — un `authorize()`
  de rol no reemplaza un chequeo de pertenencia, hacen falta los dos.
  **No implementado ni diseñado en detalle acá** — queda para el gate de
  implementación, señalado para que no se dé por cubierto solo con
  `authorize(Roles.MANAGEMENT)`.
- **Caso borde que la opción (i) hereda tal cual, sin resolverlo esta
  sesión:** si `target_company_id` todavía no tiene ningún negocio
  vinculado (primer vínculo de esa `company`), no existe ningún MANAGEMENT
  elegible para aprobar por definición — el flujo de "primer vínculo a una
  `company` nueva" necesita su propio camino (¿lo resuelve un superadmin a
  mano la primera vez, vía `/platform/*`? ¿el alta de la `company` ya viene
  con un negocio fundador?). Es una pregunta real pero de alcance distinto
  a "quién aprueba un vínculo ADICIONAL" — no la resuelvo acá, la dejo
  anotada para que no se descubra recién en implementación.

**Impacto en bookkeeping de RBAC (no implementar, solo dejar registrado —
`app-main/CLAUDE.md` cuenta ~13 artefactos manuales de RBAC en este repo):**
un `POST /api/companies/link-requests/:id/approve` (+ `.../reject`) nuevo
con `authorize(Roles.MANAGEMENT)` va a pedir, en el mismo cambio que lo
implemente:
- Fila nueva en `docs/rbac-matriz-endpoints.md` (sección 2 y, si aplica,
  sección 4).
- `EXPECTED_AUTHORIZE_CALL_SITES` de `rbac-matrix-sync.test.ts` (+1 por cada
  `authorize()` nuevo — 2 rutas, así que +2 si aprobar y rechazar son
  handlers separados).
- Bullet nuevo en la sección 2 de la matriz para que
  `rbac-matrix-section2-sync.test.ts` lo cruce contra el código (el archivo
  ya usa bullets parseables, `companies.routes.ts` no está en
  `EXCLUDED_FILES`, así que no hace falta tocar esa allowlist).
- `docs/inventario-rutas.md` regenerado (`npm run docs:routes`) — sube el
  conteo total de rutas vivas, mismo criterio que las correcciones ya
  registradas en `app-main/CLAUDE.md` (263→266, etc.).
- **No** hace falta tocar `roles-catalog-sync.test.ts` — se reusa
  `Roles.MANAGEMENT`, que ya existe en el catálogo; no hay rol nuevo que
  propagar a `appfrontend-main`.
- `rbac-route-coverage.test.ts` y `api-auth-gate-order.test.ts` no deberían
  requerir tocar sus allowlists (`PUBLIC_ROUTES`/`PRE_AUTH_API_MOUNTS`): la
  ruta nueva no es pública y se monta en el mismo lugar que sus vecinas ya
  protegidas — a confirmar en el gate, no asumido acá.

### 3.3 Riesgo / reversibilidad

**Bajo-medio, reversible.** No toca datos existentes (tabla nueva, endpoint
nuevo que reemplaza a uno que hoy vincula sin fricción). El único costo real
es de producto: alguien que hoy vincula empresas "a mano" compartiendo el
UUID deja de poder hacerlo en un paso — cambio de flujo ya asumido
explícitamente por el dueño (`decisiones-plan-integral:60`, "gatillo de
revisión: ninguno"). **Puede avanzar hacia diseño de detalle** — el actor de
aprobación de §3.2 ya está resuelto (24/09/2026); quedan pendientes el guard
de pertenencia señalado ahí (no solo `authorize(Roles.MANAGEMENT)`) y el
caso borde de "company sin ningún negocio vinculado todavía". No requiere
sign-off de riesgo (no es una acción irreversible ni corre DDL sobre datos
de negocio existentes más allá de una tabla nueva).

---

## 4. D-12 / P-08 — Sweep de recuperación del outbox

**Qué pide:** `decisiones-plan-integral-2026-09-16.md` (P-08, líneas 95-101)
decidió implementar el sweep completo (no solo subir el log a `warn` como
mitigante) — pero deja una **precondición explícita, parte del bloque, no
opcional**: completar la matriz de impacto que lo tenía en HOLD, distinguiendo
"sin efecto" (el handler debía crear algo y no lo hizo — bug a recuperar) de
"efecto legítimamente nulo" (el handler evaluó condiciones y decidió,
correctamente, no hacer nada).

### 4.1 Por qué esto no es un mecanismo genérico

El outbox de este repo tiene 9 handlers de producción registrados
(`src/workers/outbox.handlers.ts:150-156`, `src/workers/inventory.handlers.ts:144-145`,
más los de `email.handlers.ts`), cada uno con su propia noción de "efecto
esperado":

| Handler | Efecto esperado si el evento es válido |
|---|---|
| `financial:reservation.confirmed` | Crea un `CHARGE` |
| `financial:reservation.completed` | Cierra la estadía + accounts receivable |
| `financial:reservation.cancelled` | Ajusta `financial_transactions` / factura |
| `financial:reservation.price_adjusted` | Ajusta el `CHARGE` existente |
| `financial:order.confirmed` | Crea un `CHARGE` |
| `financial:order.completed` | — |
| `financial:order.cancelled` | Ajusta factura |
| `inventory:order.confirmed` | Descuenta stock |
| `inventory:order.cancelled` | Repone stock |
| handlers de mail (`email.handlers.ts`) | Envía un correo — sin fila que verificar |

Un sweep genérico ("¿existe processed_events sin efecto correlacionado?") no
puede distinguir estos casos sin una función de verificación **por handler**
que sepa cuál es la fila esperada (o la ausencia legítima de fila) para ese
tipo de evento. Escribir esas 9 funciones de verificación es, en sí mismo,
trabajo de clasificación de dominio financiero — cae bajo `criterios-negocio`
handler por handler (varios tocan `financial_transactions`, que es la
entidad más sensible del repo a duplicación), no es responsabilidad
razonable de este documento de diseño resolver de una sola pasada.

### 4.2 Forma del mecanismo (esqueleto, listo para que el gate lo complete handler por handler)

1. **Tabla o vista de "casilleros reclamados sin resolución"**: `processed_events`
   con `claimed_at` no nulo y sin fila terminal correspondiente después de
   una ventana de gracia (mayor al timeout de cierre forzado de 10 s de
   `app.ts:585-588`, para no confundir "todavía procesando" con "crasheó").
2. **Interfaz por handler**: `verifyEffect(event: DomainEvent): Promise<'PRESENT' | 'MISSING' | 'NOT_APPLICABLE'>` —
   cada handler de la tabla de §4.1 implementa la suya. `NOT_APPLICABLE`
   cubre el caso "efecto legítimamente nulo" (p. ej. una reserva cancelada
   sin cargo previo que ajustar).
3. **Sweep**: recorre los casilleros reclamados sin resolver, llama a
   `verifyEffect()` del handler correspondiente por `name`, y solo
   **re-encola** (no re-ejecuta directo) los `MISSING` — re-encolar en vez de
   ejecutar en el propio sweep deja el mismo camino de reintento/backoff que
   ya existe, en vez de duplicar lógica de ejecución.
4. **El modo de falla opuesto (mencionado por el propio P-08) es real**: un
   `verifyEffect()` mal escrito que devuelva `MISSING` para un caso que en
   realidad era `NOT_APPLICABLE` duplica el efecto. Por eso cada
   `verifyEffect()` necesita su propio test dedicado con Postgres real,
   **antes** de que el sweep entre en producción — no es negociable, es la
   misma clase de riesgo que motivó dejar esto en HOLD originalmente.

### 4.3 No resuelto acá, adrede

La tabla de 9 handlers de §4.1 no trae su columna `verifyEffect()` — completarla
es el trabajo real del bloque ("matriz de impacto", precondición no
opcional per P-08) y excede lo que este documento de investigación puede
hacer responsablemente sin pasar cada handler financiero por
`criterios-negocio` con el detalle que esa skill exige. **Esto no es una
bifurcación de negocio en el sentido de "más de una respuesta razonable"**
— es trabajo de clasificación pendiente, con una sola respuesta correcta por
handler que hay que derivar leyendo cada uno, no decidir a preferencia.

### 4.4 Riesgo / reversibilidad

**Medio.** El mecanismo en sí (tabla de reclamados + interfaz de
verificación) es aditivo y no toca el camino feliz existente — bajo riesgo
de implementar el esqueleto. El riesgo real vive en la calidad de cada
`verifyEffect()`: uno mal escrito puede *crear* la clase de bug que el
sweep viene a resolver (duplicar un efecto financiero), así que cada
handler financiero necesita su propio test contra Postgres real antes de
habilitarse en el sweep — habilitación **handler por handler**, no un
interruptor único para los 9 a la vez. **Puede avanzar hacia diseño de
detalle e implementación incremental** (empezando por el handler menos
riesgoso, probablemente `inventory:*`, no `financial:*`) una vez que cada
`verifyEffect()` pase por su propio gate — no requiere sign-off de riesgo
sobre el mecanismo en sí, sí requiere disciplina de no habilitar un handler
financiero sin su test dedicado.

---

## 5. D-18 / P-12 — Dirección del bus `wake()`

**Corrección de estado, antes de diseñar nada:** `decisiones-plan-integral-2026-09-16.md`
(P-12, líneas 155-161) describe esto como *"desbloquear la decisión... en vez
de mantenerlo en HOLD"* y como *"siguiente paso: releer el diseño y tomar la
decisión puntual de dirección del bus"* — como si la dirección todavía no
se hubiera elegido. **Eso ya no es exacto.** `docs/diseno-polling-adaptativo-neon-2026-09-10.md`
(§3.3, líneas 296-305) registra que el dueño **ya eligió**, por
`AskUserQuestion`, el 10/09/2026: *"el mecanismo exacto (post-commit) sobre
la ventana de actividad probabilística"*. Lo que sigue en HOLD no es la
dirección — es la **implementación concreta** de ese mecanismo, porque la
primera propuesta de post-commit (hook en `PgTransactionManager`) fue
**rechazada por el gate** en su momento por 3 fallas estructurales:

1. 19 de 20 implementaciones de `TransactionManager` en tests son dobles que
   no correrían el callback → falso-verde por default en tests unitarios.
2. El `WeakMap<SqlClient, cb[]>` puede quedar huérfano si `insertWithClient()`
   recibe un cliente que no es el `tx` de un `run()` real (8 sitios de
   construcción de `SqlDomainEventRepository`, no todos garantizados
   transaccionales).
3. Es un mecanismo transversal nuevo en la pieza más compartida del repo
   (`PgTransactionManager`) para resolver un problema de cadencia de un solo
   worker.

El propio documento dice, textual: *"Bloque propio, gate propio, cuando se
encare"* (línea 305). Este documento respeta esa frase: **no intento
re-diseñar el mecanismo post-commit acá** — sería exactamente el tipo de
apuro que el encargo pide evitar en la oleada de mayor riesgo del plan.

### 5.1 ¿Worker propio para el portal? — RESUELTO 24/09/2026 (`AskUserQuestion`), y ya implementado en código antes de esta sesión

**Pregunta que se le hizo al dueño:** el portal de clientes, ¿comparte el
worker de outbox por-tenant existente, o necesita uno propio? **Resolución:**
comparte el worker per-tenant existente — no hay worker separado para el
portal de clientes.

**Corrección de estado — esto ya no es una bifurcación abierta, y además
la respuesta del dueño coincide con lo que el código ya hace.** El hallazgo
que el boceto original citaba (`docs/diseno-polling-adaptativo-neon-2026-09-10.md`
§3.3, 10/09/2026: *"si un tenant recibe tráfico solo del portal ... no
existe `OutboxWorker` para ese `businessId`"*) describía el estado real **el
día que se escribió** — pero quedó obsoleto **al día siguiente**:
`CUSTOMER-PORTAL-NO-OUTBOX-WORKER-001` (11/09/2026, gate
`architecture-governor`, decisión del dueño — ver docblock de
`api/routes/customer.routes.ts:558-573`) ya cerró exactamente este hueco, y
lo hizo con el mismo mecanismo que la resolución del dueño pide: **el
mismo `ensureTenantWorker()`** (`workers/outbox.registry.ts:73-166`) que
`tenant.middleware.ts:238` llama para tráfico de staff se llama también
desde el middleware de `customer.routes.ts:582` para tráfico del portal —
mismo primitivo idempotente (`workers.has(businessId)`, `outbox.registry.ts:86`),
sin distinguir "worker para staff" de "worker para portal": es un worker
por `businessId`, no por consumidor. Verificado en código, no en el
boceto: `grep -rn "ensureTenantWorker" src` da exactamente dos call-sites de
producción — `platform/tenant.middleware.ts:238` y
`api/routes/customer.routes.ts:582` — más sus dobles de test.

**Consistencia con el resto de los workers per-tenant del repo (según lo
pedido, verificado uno por uno):** `OutboxWorker` (`outbox.registry.ts:139`,
poll cada 5 s) y `ReservationHoldExpiryWorker` (`:157-164`, poll cada 60 s)
se instancian los dos dentro de `ensureTenantWorker()`, uno por tenant
activo — el mismo caller que arranca uno arranca el otro. **Corrección: no
existe `InvoicePendingExpiryWorker` en `main` hoy** — el nombre solo aparece
en un comentario de `domain/errors.ts:1636-1642` que documenta que ese
worker vive en una rama separada (`bloque-4-invoice-pending-expiry`), **no
mergeada**. No lo cito como ejemplo ya-existente del patrón para no repetir,
en este mismo documento, el modo de falla que motivó esta corrección
(afirmar contra un estado que no es el del código real) — si esa rama se
mergea, seguiría el mismo patrón por diseño, pero eso se confirma cuando
exista en `main`, no antes.

**No hay bloque de implementación pendiente para este sub-ítem específico**
— la brecha que motivaba la pregunta ya no existe, y la resolución del
dueño confirma que el estado actual del código es el que se quiere. Lo que
sigue en HOLD, sin tocar por esta resolución, es el mecanismo post-commit en
sí (§5, cuerpo principal) — eso sigue siendo *"bloque propio, gate propio"*,
sin relación con esta pregunta.

### 5.2 Riesgo / reversibilidad

**El sub-ítem de §5.1 no tiene riesgo que evaluar — ya está en producción
desde el 11/09/2026, antes de que esta sesión empezara.** No hay nada que
autorizar ni implementar ahí; la resolución del dueño documenta una
decisión que el código ya refleja. **El resto del ítem (mecanismo
post-commit) sigue sin aplicar clasificación de riesgo en esta sesión** —
necesita su propio bloque de diseño dedicado (como el documento de origen ya
pide) antes de que tenga sentido clasificarlo.

---

## 6. D-19 / P-10 — PDF de comprobantes: timeout (no opcional) + materialización

**Qué pide:** `decisiones-plan-integral-2026-09-16.md` (P-10, líneas 175-181)
decidió **materializar el PDF una vez tras generarlo y servir el archivo en
pedidos posteriores** (el comprobante es inmutable tras el CAE — no hay
razón para re-renderizar). Descartó sacar la generación completa del camino
interactivo (mayor alcance, se pospone) y descartó dejarlo como está. Marca
aparte, **no opcional e independiente de esta decisión**: poner un timeout a
`generate()` — hoy una llamada colgada cuelga la request para siempre.

### 6.1 Timeout — listo para implementar ya, sin esperar la materialización

Es el sub-ítem de menor radio de toda la oleada. `invoices.routes.ts:283-301`
construye un `InvoicePdfService` nuevo por request y llama a `generate()`
síncrono respecto de la respuesta HTTP, sin ningún límite de tiempo. Envolver
esa llamada en un timeout explícito (`Promise.race` contra un timer, o
pasarle un `AbortSignal` si `@arcasdk/pdf`/Puppeteer lo soporta — confirmar
al implementar) y responder un error clasificado (no un 500 genérico) si se
cumple. No depende de ninguna otra decisión de este documento ni de D-12/D-18.
**Se puede adelantar solo**, tal como el propio plan ya lo anota
(`plan-ejecucion-integral-2026-09-16.md:62`: *"puede adelantarse solo"*).

### 6.2 Materialización — diseño propuesto (listo para su propio gate)

**Clasificación (`criterios-negocio`):** el PDF pasa de "efímero, generado
en cada `GET`" a "documento persistido" — toca el ciclo de vida de un
documento fiscal (factura/comprobante), que ya es una de las entidades más
reguladas del repo (AFIP). Correr `criterios-negocio` sobre el campo/tabla
de almacenamiento antes de implementar — no se resuelve acá.

**Mecanismo:**

1. Columna nueva en la tabla de facturas (o tabla aparte
   `invoice_pdfs`, a decidir por tamaño esperado de blob — Postgres puede
   guardar el PDF como `bytea` para los volúmenes actuales, o una referencia
   a storage externo si crece; el propio Chromium mide ~200 MB por PDF **en
   memoria durante la generación**, no el tamaño del archivo final, que es
   órdenes de magnitud menor — verificar tamaño real de archivo antes de
   descartar `bytea`).
2. `GET /api/invoices/:id/pdf` (o el endpoint actual que sirve el PDF):
   primero chequea si ya existe el PDF materializado; si existe, lo sirve
   directo (sin Chromium); si no, genera, materializa, y sirve — **dentro
   del mismo timeout de §6.1**.
3. Invalidación: dado que el comprobante es inmutable tras el CAE (premisa
   de la decisión del dueño), no hay invalidación normal — el único caso que
   la rompería es una corrección post-emisión (nota de crédito, remitida),
   que ya es un documento distinto con su propio `id`, no una edición del
   mismo PDF.
4. Composición con D-12/D-19: el propio Fase 16 (§13, fila P4/D-19) nota que
   "el OOM es productor directo de D-12" — con la materialización, el
   Chromium solo corre **una vez por comprobante** en vez de en cada `GET`,
   lo que reduce (no elimina) la frecuencia del modo de falla que compone
   con el sweep de §4. No sustituye el semáforo de concurrencia que Fase 15
   recomienda como mitigante adicional (1-2 en vuelo) — ese sigue siendo un
   sub-ítem aparte, de radio igual de bajo que el timeout, y puede sumarse
   en el mismo bloque sin depender de nada más.

### 6.3 Riesgo / reversibilidad

**Timeout (§6.1): bajo, reversible, sin dependencias — listo para
implementar de inmediato en un bloque propio.**
**Materialización (§6.2): bajo-medio, reversible.** No borra ni transforma
datos existentes; agrega una columna/tabla y un chequeo "¿ya existe?" antes
de generar. El único efecto de producto es que un PDF regenerado a mano
(si alguna vez hiciera falta, p. ej. por un cambio de plantilla) requeriría
un mecanismo explícito de invalidación que este diseño no cubre — señalar
en el gate de implementación si ese caso es real hoy. **Puede avanzar hacia
implementación** una vez pasada por `criterios-negocio`.

---

## 7. D-14 — Extracción de `tenant-provisioning.service.ts`

**Este es el bloque de mayor riesgo de todo el plan, declarado así por el
propio plan, y este documento lo trata en consecuencia: es un documento de
encuadre de riesgo y prerrequisitos, NO un diseño listo para implementar.**
No hay una versión "lista para el gate" de este ítem todavía, porque
ninguno de sus tres prerrequisitos está cumplido (§7.2) — proponer el diseño
de extracción en detalle antes de eso sería exactamente el tipo de apuro que
el encargo de esta sesión pide evitar.

### 7.1 Qué pide, y por qué es irreversible

**Fase 15 (D-14)** + **Fase 16 §11 (Regla 3)** + **Fase 16 §13 (fila P2/D-14)**:
la secuencia de aprovisionamiento de un tenant —API externa de Neon → DDL
completo contra una base nueva (`schema.sql`, 4302 líneas) → cifrado del
connection string → 2 escrituras en la BD de plataforma (`activateBusiness`,
`updateSchemaVersion`) → eviction del pool cacheado— vive copiada, con
políticas de fallo divergentes, en 3 archivos de rutas (§0.2 confirma que
bajó de 4 a 3 desde Fase 15, por el retiro de `repair-tenant-db` en Wave 7 —
la clase de problema no cambió). El propio repo ya declara el criterio que
aplica: `irreversible-action-gate` — la secuencia **corre DDL contra bases
de datos de producción**, y **no hay rollback para una base aprovisionada a
medias**. Eso no es retórica de la auditoría: es una propiedad real del
mecanismo — `schema.sql` aplicado parcialmente, o un cifrado que corrió pero
el `activateBusiness()` posterior falló, deja una base nueva en un estado
que ningún camino del repo hoy sabe describir ni deshacer limpio.

### 7.2 Los tres prerrequisitos que el propio plan exige — estado real de cada uno

| # | Prerrequisito | Fuente | Estado verificado (§0.2) |
|---|---|---|---|
| 1 | Característica de regresión de los 3 (antes 4) caminos: un test de integración por camino que asere el estado final (`businesses.status`, `db_url_encrypted`, `schema_version`, pool evictado o no) | Fase 15 (D-14), Fase 16 §13 | **No existe.** `find src/tests -iname "*provision*"` no devuelve nada. Las 3 copias no tienen hoy ningún test en común — la extracción sería a ciegas. |
| 2 | Regla 3 de Fase 16 §11 aplicada a `TenantProvisioner`: puerto (interfaz + implementación real + política declarada), mismo molde que `email/email.sender.ts` | Fase 16 §11 (tabla de reglas), F7-04(c) | **No existe.** `grep -rn "TenantProvisioner" src` no devuelve nada — ni el puerto ni la implementación. |
| 3 | Backup durable, previo a tocar cualquiera de las 3 copias | Fase 15 (D-14), Fase 16 §13 (Etapa 10) | **No existe** un mecanismo de backup documentado específico para este propósito — no se encontró runbook de backup/restore de tenant DBs en `docs/conocimiento/`. Requiere decisión operativa propia (¿snapshot de Neon antes de cada aprovisionamiento? ¿point-in-time recovery del proveedor? ¿algo más simple, dado que "aprovisionar" crea una base nueva, no modifica una existente?) |

**Los tres están sin cumplir.** Esto no es una sorpresa — es exactamente lo
que "Wave 15 NOT STARTED" predice — pero significa que este documento no
puede, honestamente, entregar más que el encuadre de qué falta y por qué
cada pieza importa, no un plan de extracción línea por línea.

### 7.3 Una precisión que si se pasa por alto, socava el prerrequisito 1

El backfill de `MIGRATE-TENANTS-CONCURRENT-DDL-001` (`docs/pendientes-2026-09-12.md:2106-2144`,
hallazgo de la retrospectiva de Waves 1-7, reproducido empíricamente contra
Postgres real) encontró que `applyTenantSchema()` **no tiene ningún
advisory lock** — 5 corridas concurrentes contra la misma BD produjeron
carreras reales (`duplicate key value violates unique constraint
"pg_extension_name_index"`, `tuple concurrently updated`). Ese hallazgo se
registró explícitamente como **fuera** del alcance de las Waves 8-16
existentes porque tocaba `migrate-tenants.ts` (reaplicar sobre un tenant YA
migrado), no la ruta de alta de un tenant NUEVO. **Pero la extracción de
D-14 sí toca la ruta de alta de un tenant nuevo**, y dos requests
concurrentes de alta pública (`business.routes.ts`) para el mismo negocio —
o un alta pública en curso mientras un superadmin reintenta manualmente vía
`platform.routes.ts` para el mismo `businessId`— ejercitarían exactamente la
misma clase de carrera contra una base que, en ese caso, ni siquiera existe
todavía al arrancar la secuencia (la crea `provisionTenantDatabase()`, así
que el primer punto de colisión sería la creación del branch de Neon, no
`schema.sql`). **Esto no estaba en el radar de D-14 tal como está escrito en
Fase 15** — es un hallazgo de esta sesión que el prerrequisito 1 (la
característica de regresión) debería cubrir con un caso explícito: dos
llamadas concurrentes a `provisionAndActivate()` para el mismo negocio, no
solo los 3 caminos en secuencia. Lo señalo para que quede en el diseño
cuando se escriba, no lo resuelvo acá.

### 7.4 Lo único de este ítem que es independiente y de bajo riesgo

Corregir el docblock de `src/server.ts:14` (*"Tenant schemas se aplican vía
tenant.middleware al primer request del tenant"*) — Fase 15 ya lo señaló
como afirmación falsa: los 4 (hoy 3) call-sites de `applyTenantSchema` están
en rutas, ninguno en middleware. Es un cambio de un comentario, sin efecto
de comportamiento, y **no** requiere ninguno de los tres prerrequisitos. No
lo edité en esta sesión (el encargo de esta tarea es investigación/diseño,
no cambios de código) — queda anotado para el bloque de implementación.

### 7.5 Riesgo / reversibilidad — declaración explícita, sin suavizar

**Esto no es "listo para implementar" y no lo voy a presentar como tal.**
El mecanismo que D-14 extrae corre DDL de 4302 líneas contra una base de
datos de producción recién creada, con tres escrituras posteriores que hoy
divergen en 3 copias sin test común. La extracción en sí (mover código a un
archivo nuevo) es mecánicamente de bajo riesgo — pero el **riesgo real no
está en la extracción, está en tocar una secuencia irreversible sin la red
de seguridad que el propio plan exige antes de tocarla**. Tres cosas tienen
que existir primero, en este orden, y ninguna existe hoy:

1. Los tests de regresión de los 3 caminos (para saber, con evidencia, que
   la extracción no cambió el comportamiento).
2. El puerto `TenantProvisioner` (para que la extracción tenga algo limpio
   que inyectar, en vez de mezclar la llamada a la API de Neon con la
   lógica de orquestación).
3. Un backup durable operable antes de la primera vez que el código
   extraído corra contra producción.

**Recomendación de esta sesión: no proponer un diseño de implementación de
D-14 todavía.** Lo que sí corresponde, como siguiente paso concreto y de
bajo riesgo en sí mismo, es que el dueño vea este encuadre y decida
explícitamente **si autoriza empezar por el prerrequisito 1** (los tests de
regresión — que son de solo lectura contra el comportamiento actual, no
tocan nada) como primer bloque, dejando el prerrequisito 3 (backup durable)
resuelto operativamente antes de que exista código nuevo para probar contra
producción. Eso es una secuencia de trabajo, no una autorización para
extraer nada todavía. **El sign-off que hace falta acá no es sobre un diseño
técnico — es sobre el riesgo mismo de tocar esta secuencia**, y por eso este
documento no lo empuja hacia "listo para implementar": se lo entrego al
dueño para que lo autorice con los ojos abiertos, tal como pide el encargo.

---

## 8. Resumen — qué puede avanzar y qué no

| Ítem | Puede avanzar hacia implementación ya (con su propio gate) | Necesita decisión del dueño primero (`AskUserQuestion`) | No diseñable todavía en esta sesión |
|---|---|---|---|
| 1. Reconciliación P-02(D-04)+D-07 TTL | **Sí — §1.2 RESUELTO 24/09/2026** (idle vía `/refresh` existente, §1.1.3) | — (resuelto; queda una dependencia de cadencia de polling del frontend a decidir en el gate, no una bifurcación de negocio nueva) | — |
| 2. D-04 `token_version` (opción A) | **Sí — §2.1 RESUELTO 24/09/2026** (proceder; mecanismo de rollout seguro en §2.2, `payload.tv ?? 0`) | — (resuelto; queda el costo de performance nuevo en el portal, sub-hallazgo de §2.2, a decidir en el gate) | — |
| 3. D-05/P-03 vínculo empresa | **Sí — §3.2 RESUELTO 24/09/2026** (aprobador: `Roles.MANAGEMENT` de la empresa destino) | — (resuelto; queda el guard de pertenencia y el caso borde de `company` sin negocio vinculado, señalados en §3.2, a diseñar en el gate) | — |
| 4. D-12/P-08 sweep outbox | Esqueleto sí; handlers financieros uno por uno tras su propio `criterios-negocio` | No (es clasificación, no bifurcación) — **no tocado en esta sesión** | Los 9 `verifyEffect()` en detalle |
| 5. D-18/P-12 wake() | **§5.1 RESUELTO 24/09/2026 y ya vigente en producción desde el 11/09/2026** (`CUSTOMER-PORTAL-NO-OUTBOX-WORKER-001`, verificado contra `ensureTenantWorker()`) | — | El mecanismo post-commit en sí — "bloque propio, gate propio" (fuente) — **no tocado en esta sesión** |
| 6. D-19/P-10 timeout | **Sí, ya, sin dependencias** — **no tocado en esta sesión** | No | — |
| 6. D-19/P-10 materialización | Sí, tras `criterios-negocio` — **no tocado en esta sesión** | No | — |
| 7. D-14 extracción | **No** — ninguno de los 3 prerrequisitos existe — **no tocado en esta sesión, framing de riesgo intacto** | Sign-off explícito sobre el riesgo, no sobre un diseño (§7.5) | El diseño de extracción en sí |

**Nota de disciplina, para la sesión que retome esto:** el orden de la tabla
de §0.1 es del plan, no mío — lo respeté incluso donde, como en D-18, la
investigación encontró que el estado real difiere de cómo el plan lo
describe (§5). Señalar esa clase de discrepancia es parte del trabajo de
esta sesión, no una corrección que haya que ocultar para que el documento
"cierre prolijo".

---

## 9. Adenda — resoluciones del dueño vía `AskUserQuestion` (24/09/2026)

Mismo día del documento original, mismo `architecture-governor`. Cuatro de
las siete bifurcaciones de negocio que este documento dejó explícitamente
abiertas se le presentaron al dueño y se resolvieron; el detalle de cada
resolución quedó integrado en su propia sección (§1.2, §2.1, §3.2, §5.1) —
esta adenda es el registro cronológico corrido, no una repetición del
contenido.

1. **§1.2 (idle timeout de P-02(D-04)+D-07):** se construye sobre
   `POST /api/auth/refresh` / `POST /api/customer/refresh`, tal cual existen
   hoy — sin endpoint nuevo, sin claim `iat`/`last_activity` nueva en el
   JWT. Mecanismo desarrollado en §1.1.3, grounded contra
   `me.routes.ts:86-95`, `customer.routes.ts:689` y
   `auth.service.ts:223-230` (código real, no el boceto). Queda una
   dependencia explícita, no resuelta por esta pregunta: la cadencia con la
   que el frontend llama a `/refresh` hoy es un timer de fondo mientras la
   pestaña sigue abierta, no una respuesta a actividad real — sin ese
   cambio del lado `appfrontend-main`, el mecanismo acorta la sesión pero no
   es un idle-timeout en sentido estricto.
2. **§2.1 (D-04 `token_version`, opción A):** proceder, con la restricción
   explícita de que el rollout por default no invalide sesiones existentes.
   Mecanismo concreto en §2.2: coerción `payload.tv ?? 0` combinada con el
   default de columna `DEFAULT 0` — todo JWT viejo sin claim `tv` se trata
   como `tv = 0`, matchea el default de la migración, y no se cae al
   desplegar; la revocación real (el propósito del ítem) sigue funcionando
   igual para tokens viejos y nuevos en cuanto se incrementa
   `token_version`. No hizo falta dejar ninguna sub-decisión de negocio
   pendiente para sostener la propiedad de seguridad pedida — sí quedó un
   sub-hallazgo de costo (query nueva por request en el portal de clientes,
   que no es gratis como sí lo es para staff) señalado para el gate de
   implementación.
3. **§3.2 (D-05/P-03, actor de aprobación):** cualquier usuario con
   `Roles.MANAGEMENT` de la empresa (`company`) receptora — se reusa el
   grupo existente, sin modelo de actor nuevo. Esto obligó a corregir el
   endpoint sugerido por el boceto original (`/platform/companies/...` →
   `/api/companies/link-requests/:id/approve`), porque `Roles.MANAGEMENT`
   solo existe donde hoy vive: rutas `/api/*` con membership de negocio, no
   en el universo de superadmin de `/platform/*`. Quedan señalados, no
   resueltos: el guard de pertenencia adicional (MANAGEMENT del negocio
   correcto, no de cualquiera) y el caso borde de una `company` sin ningún
   negocio vinculado todavía. Impacto de bookkeeping RBAC (matriz, conteo de
   `authorize()`, sección 2, inventario de rutas) enumerado en §3.2 para
   cuando se implemente.
4. **§5.1 (D-18/P-12, worker del portal de clientes):** el portal comparte
   el worker per-tenant existente, sin worker propio — consistente con
   `OutboxWorker`/`ReservationHoldExpiryWorker` (uno por tenant, no por
   consumidor, `outbox.registry.ts::ensureTenantWorker()`). Verificado
   contra código: esta resolución **ya estaba implementada** desde el
   11/09/2026 (`CUSTOMER-PORTAL-NO-OUTBOX-WORKER-001`), dos semanas antes de
   esta sesión — el boceto original citaba un hallazgo de una fuente del
   10/09/2026 que quedó obsoleto al día siguiente sin que este documento lo
   hubiera re-verificado contra el código vivo. No hay bloque de
   implementación pendiente para este sub-ítem.

**Explícitamente no tocado por esta adenda** (fuera del encargo de esta
resolución puntual): el ítem 4 (D-12/P-08, sweep del outbox) sigue
bloqueado en la clasificación handler-por-handler gateada por
`criterios-negocio` — no se fabricó ninguna resolución ahí. El ítem 6
(D-19/P-10, PDF) no tenía ninguna bifurcación planteada y no se tocó. El
ítem 7 (D-14, extracción de `tenant-provisioning.service.ts`) sigue siendo
encuadre de riesgo únicamente — su contenido no se modificó, y no se
intentó ninguna framing de "listo para implementar" sobre él.
