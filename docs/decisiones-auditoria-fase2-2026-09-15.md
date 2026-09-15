# Decisiones del dueño — auditoría integral Fase 2 (15/09/2026)

Registro de las 15 decisiones tomadas por el dueño sobre las "Preguntas que
requieren decisión humana" (§13) del informe de Fase 2 entregado en chat el
15/09/2026 (agentes `architecture-governor` + `auditor-estructura`, sin
archivo propio — el informe completo vive en la conversación de esa sesión;
este documento es el registro de las decisiones, no una repetición del
informe). Cada ítem cita el hallazgo (`F2-XX`/`D-XX`) que lo originó.

Formato: decisión → estado de implementación (bloque de esta ronda / bloque
aparte / pendiente de grounding) → notas.

---

## 1. F2-06 — Permiso de credenciales AFIP

**Decisión: `OWNER_ONLY`.** `PUT`/`DELETE /api/business-profile/afip-credentials`
pasan a exigir `Roles.OWNER_ONLY` (hoy `Roles.MANAGEMENT`), consistente con
el candado que ya protege el resto del perfil fiscal (`FISCAL_PROFILE_LOCKED`,
D3). Se implementa junto con F2-05 (transacción + auditoría) en el mismo
bloque — mismo archivo, misma feature (credenciales AFIP).

**Estado: bloque de esta ronda.**

## 2. F2-13 — Unicidad de nombre de recurso

**Decisión: NO, dos recursos no pueden llamarse igual.** Requiere: índice
`UNIQUE` parcial sobre `resources.name` (activos, mismo criterio de
unicidad normalizada que R6 de `criterios-datos.md`), clase de error nueva
(`ResourceNameConflictError`, code `RESOURCE_NAME_CONFLICT` — el que
`spec.ts` ya documenta, hoy fantasma), `case` 409 en `domainErrorStatus()`,
y alinear `docs/rbac-matriz-endpoints.md` si corresponde.

**Estado: bloque de esta ronda.**

## 3. F2-10 + F2-11 — `supabase/migrations/` y `migrations/`

**Decisión: se borra.** `supabase/migrations/001_init.sql` (y la carpeta
`supabase/`) se eliminan — describe un estado de schema incompatible con
`schema.sql` (columnas que ya no existen, contradice `migrations/006`) y no
tiene valor de referencia real. `migrations/003_*.sql` a `012_*.sql` se
conservan (tienen valor de registro histórico, citados como referencia de
forma en `sql.financial-transaction.repository.ts:54`) pero ganan un
`migrations/README.md` que declara explícitamente: histórico, no se
aplica, el aplicador real es `applyTenantSchema()` → `src/db/schema.sql`.

**Estado: bloque de esta ronda (limpieza de archivos).**

## 4. F2-08 — Unificación de SSL

**Decisión: sí.** Los 3 `pg.Client` restantes (`tenant-db.setup.ts::applyTenantSchema`,
`company-sync.worker.ts`, `outbox-purge.ts`) pasan a usar `sslConfig()` +
`stripSslMode()`, igual que el resto de los pools del proceso.

**Advertencia declarada por la auditoría, no resuelta por esta decisión:**
el hallazgo original recomendaba verificar contra la flota de tenants de
producción ANTES de cambiar (si algún tenant tiene una connection string
con certificado que hoy no validaría, el cambio lo rompe). Esta sesión no
tiene acceso a credenciales de producción ni a la flota real — el cambio
se hace igual, por decisión explícita del dueño, pero **queda como
verificación pendiente en entorno real** (no como riesgo descartado).

**Estado: bloque de esta ronda, con la advertencia de arriba registrada en
`docs/pendientes-2026-09-12.md`.**

## 5. F2-02 — Tipo de `req.db`/`req.businessId`

**Decisión: se cambia.** `req.db: SqlClient` → `req.db?: SqlClient` y
`req.businessId: string` → `req.businessId?: string` en `express.d.ts`.
Radio grande: ~186 sitios con `req.db`/`req.db!`, todos los `*.routes.ts`
de tenant. El compilador va a exigir narrowing (`!` o guard) en cada uno.

**Estado: bloque propio, aparte de este batch — requiere verificación
exhaustiva de `tsc --noEmit` sobre ~186 sitios y no debe mezclarse con
otros cambios. Próximo bloque después de este batch.**

## 6. D-03 — Horizonte de ventana de mantenimiento abierta

**Decisión: mismo horizonte** que la evaluación de disponibilidad
(`business_profile.maintenance_horizon_days`, hoy 30 días default,
configurable) — reemplaza los 10 años hardcodeados del alta
(`maintenance-window.service.ts:56`).

**Grounding pedido por el dueño antes de fijar el comportamiento de
borde** (qué pasa si YA hay una reserva más allá del horizonte configurado
cuando se intenta abrir la ventana — ¿se rechaza el alta, se permite con
aviso, se marca para revisión como ya hace el camino de evaluación con
`needsMaintenanceReview`?). Mismo criterio que el principio ya declarado en
`app-main/CLAUDE.md` ("buscar el precedente ERP antes de diseñar, no para
validarlo después").

**✅ RESUELTO (15/09/2026, dueño, "aceptamos la recomendación"):**
grounding completado (5 de 6 sistemas de referencia permiten crear el
bloqueo con una reserva en conflicto; el único que bloquea, OPERA, solo
aplica a conflictos con fecha cierta, no al caso incierto de este repo;
ningún sistema tiene ventana sin fecha de fin, así que ninguno tiene
análogo real del horizonte). Se adopta la recomendación **(c) con (b)
como estado durable**, no un simple "mismo horizonte":

- **Tramo cierto** — `[startDate, min(endDate, hoy + maintenanceHorizonDays)]`:
  sigue bloqueando con `MaintenanceWindowConflictError`, igual que hoy.
- **Tramo incierto** — solo alcanzable con `endDate === null`, más allá de
  `hoy + horizonte`: NO bloquea. El alta devuelve en la respuesta 201 la
  lista de reservas que quedaron fuera de horizonte y sin revisar
  (`conflictingReservationIds`, ya calculado hoy para el error), y las
  marca `needs_maintenance_review = true` — INSERT de la ventana + UPDATE
  de N reservas en la MISMA transacción (`atomic-state-mutation`).
- **El horizonte aplica SOLO a la rama `endDate === null`.** Si la ventana
  tiene fecha de fin, sigue evaluándose completa (sin horizonte) —
  aplicar el horizonte también ahí sería una regresión real: dejaría
  pasar un alta con una reserva DENTRO del rango acotado sin bloquear ni
  marcar nada, contradiciendo al motor de disponibilidad
  (`reservation-availability.service.ts:90-98`, que no usa horizonte para
  ventanas acotadas).
- **`needsMaintenanceReview`: snapshot, se limpia solo al reasignar**
  (decisión del dueño, `AskUserQuestion`, 15/09/2026) — no se recalcula
  automáticamente si cambia la configuración del horizonte o la ventana;
  es la extensión mínima del diseño actual (ya es snapshot al crear la
  reserva, R14/YAGNI), sin agregar un motor de recálculo nuevo.

**No resuelto acá, declarado por el grounding, no bloqueante para
implementar:** la pantalla de revisión de `needsMaintenanceReview` sigue
sin existir (backlog ya conocido); el límite de anticipación de una
reserva (que haría desaparecer el caso de borde desde el otro extremo) no
se propone, queda anotado como posible mejora futura, no una decisión de
este bloque.

**Estado: bloque de implementación, esta ronda.**

## 7. D-02 — Filtros parciales de reservas

**Decisión: debe rechazarse (400).** `?from=` sin `?to=` (y `?limit=` sin
`?page=`) pasan a ser un request inválido, rechazado por el schema Zod de
`GET /api/reservations`, en vez de aceptarse y aplicarse con semántica
distinta según el repositorio (SQL los ignora, in-memory los aplica).
Cierra la divergencia sin tocar los dos repositorios.

**Estado: bloque de esta ronda.**

## 8. D-10 — Auditoría de transiciones de reserva

**Decisión: todas.** `confirmReservation()`/`cancelReservation()`/`completeReservation()`
del camino normal (`reservation.service.ts`) pasan a dejar rastro en
`audit_log` (entity `'reservations'`), igual que ya hace el escape con
Nota de Crédito — cierra la asimetría donde hoy solo el escape audita.

**Estado: bloque de esta ronda.**

## 9. D-15 — Emisores con `taxIdType` no-CUIT

**Decisión: pendiente de grounding.** El dueño pidió investigar (no
resolvió directo) si el producto contempla o va a contemplar emisores
fiscales que no sean CUIT/CUIL — relevante para decidir si
`UpdateBusinessProfileSchema` debe validar `taxId` condicionalmente (como
ya hace el receptor, `customer_tax_profiles`) o si el emisor es CUIT-only
por diseño.

**✅ RESUELTO (15/09/2026, dueño, "sí fijarlo").** Grounding: el emisor es
CUIT-only, hoy y en cualquier corto plazo razonable — el protocolo AFIP/
ARCA no tiene otro lugar donde poner la identidad del emisor
(`<Auth><Cuit>`, `Long(11)`, obligatorio en toda llamada WSFEv1), y los
ERP multi-país de referencia con integración fiscal real (Odoo l10n_ar)
**pinean** el emisor al identificador que exige el país, no lo dejan
condicional — la validación condicional es un patrón exclusivo del lado
RECEPTOR en todos los sistemas revisados. Sin ambición multi-país
verificada en `docs/` de este repo.

El hallazgo real que el grounding encontró (`EMISOR-TAXIDTYPE-DECORATIVO-01`):
`business_profile.taxIdType` no lo lee ningún camino de producción (0
call-sites reales), el frontend lo deja como texto libre
(`dashboard/mi-negocio/page.tsx`), y queda bajo el candado `OWNER_ONLY`
del perfil fiscal confirmado — un dueño puede guardar "DNI" ahí mientras
el sistema exige CUIT igual, sin que nada lo detecte.

**Implementación decidida (opción (a) del grounding):** `taxIdType` del
emisor deja de ser texto libre editable — se fija a `'CUIT'` (backend:
`z.literal('CUIT')` o se deriva sin pedirse; frontend: el input de
`mi-negocio` deja de ser editable, muestra "CUIT" fijo). No se borra la
columna (mantiene el paralelismo de nombres con `customer_tax_profiles`
que `business-profile.entities.ts` ya declara querer preservar).

**Estado: bloque de implementación, esta ronda.**

## 10. D-16 — Decimales de moneda en el frontend

**Decisión: 2 decimales.** El módulo nuevo `lib/business-context/moneda.ts`
(mismo molde que `numero-operativo.ts`: resolver puro + hook, lee
`currency` del `BusinessContext`) usa `maximumFractionDigits: 2` en los 17
archivos hoy hardcodeados a `'ARS'`/`'es-AR'`.

**Estado: bloque aparte — repo `appfrontend`, 17 archivos, coordinar con
la corriente de Fase V2 del sistema de diseño que el `CLAUDE.md` del
frontend ya pide no interrumpir con repintados sueltos. No en este batch.**

## 11. D-07 — TTL de sesión

**Decisión: por tenant**, no global por variable de entorno. Es una
decisión más amplia que la pregunta original (que solo pedía decidir si
implementar o borrar `PLATFORM_JWT_EXPIRES_IN`) — implica una columna
nueva de configuración (probablemente en `business_profile` o en
`businesses` de plataforma, a definir en el diseño) y un
`resolveSessionTtl()` por audiencia (staff/cliente/plataforma) que la
lea, reemplazando las 5 copias/hardcodeos hoy dispersos
(`auth.service.ts`, `customer.auth.service.ts`, `customer.routes.ts`,
`business.routes.ts`, `platform.auth.service.ts`).

**Estado: bloque de diseño propio, aparte — es una feature de
configurabilidad nueva, no un fix de duplicación. Requiere pasar por
`criterios-negocio` (toca `business_profile`, configuración multi-tenant)
antes de tocar código. No en este batch.**

## 12. D-14 — Contrato de paginación

**Decisión: pendiente de grounding.** El dueño pidió investigar (no un
sí/no directo) cuál debería ser el contrato canónico (`page`/`limit` vs.
`limit`/`offset`) y el tope máximo de página — y si ese tope es global,
por plan o por tenant. Se cruza con `PLAN_LIMITS`, todavía sin resolver en
este repo.

**✅ RESUELTO (15/09/2026, dueño, "adoptamos la recomendación").**
Grounding completado contra 8 sistemas de referencia (Odoo, ERPNext x2,
Dolibarr, QloApps, Cloudbeds, Mews, OPERA, Shopify). Se adopta tal cual:

- **Contrato canónico: `limit`/`offset`**, envelope único
  `{ data, limit, offset, total, hasMore }` — 6 de 8 sistemas lo usan así
  (Odoo, Frappe v1/v2, Cloudbeds, OPERA); compone con un futuro cursor sin
  renombrar nada; evita el off-by-one de `page` (Dolibarr es 0-based,
  este repo era 1-based — ambigüedad que un integrador tendría que
  adivinar). **Sin fallback a array plano**: hoy la ausencia de `page`/
  `limit` en `GET /api/reservations` cambia el TIPO de la respuesta — eso
  es lo que causaba el truncado silencioso en Órdenes/Productos/Turnos de
  caja (devuelven array pelado con su default, sin `total`, sin forma de
  saber que hay más). Con este contrato, sin parámetros → envelope con
  los defaults, nunca un array pelado.
- **Tope: fijo y global en el código, NO por plan ni por tenant.**
  Unanimidad del set (ningún sistema lo ata al tier — Shopify separa
  explícitamente cap de página, igual para todos, de rate limit, que sí
  escala por plan). El tope protege al servidor (memoria, tiempo de
  conexión), no es una variable de negocio.
- **Valores: `limit` default 50, máximo 200.** Mediana de los defaults
  observados (20–100) y el valor más alto con evidencia empírica de
  estabilidad (`erpnext#49037`: 200 funciona, 2000/5000 produce
  duplicados y registros faltantes). Un `limit` por encima del tope se
  CLAMPEA y se informa el valor efectivo en el envelope — nunca se trunca
  en silencio (mismo criterio `honest-degradation` que ya rige el repo;
  es literalmente el bug que reportó `Dolibarr#8681`).
- **Offset, no cursor, por ahora.** El único sistema con cursor obligado
  (Mews) lo usa para sincronización máquina-a-máquina de gran volumen —
  no es el patrón de un listado de panel filtrado por fecha. Cursor queda
  reservado para un futuro canal de export/sync, no para este batch.
- **Implementación acompañante, independiente del contrato** (ya
  recomendada por el grounding, va en el mismo bloque): desempate
  explícito en el `ORDER BY` de los 5 listados (`, id DESC` — causa raíz
  real de duplicados/faltantes en paginación, ya visto en
  `erpnext#49037`); `.max(200)` en los schemas Zod de `limit` que hoy no
  lo tienen.

**Reemplaza el tope provisorio de 100 ya commiteado** (`bf29137`,
`DEFAULT_UNPAGINATED_LIMIT`) por el contrato definitivo — no fue
descartado, fue el paso intermedio correcto mientras el grounding corría.

**Alcance de ESTE bloque:** migrar `reservations` (el recurso con el
contrato viejo `page`/`limit` + el bug ya identificado) al contrato
nuevo, incluyendo el adaptador correspondiente en
`appfrontend/src/lib/refine/dataProvider.ts` (único consumidor vivo hoy,
cambio de 2 líneas ya anticipado por el grounding) — cambio de contrato
entre repos, se revisan los dos lados en el mismo bloque, regla del
`CLAUDE.md` raíz. Los otros 4 recursos (`orders`, `products`,
`cash-register-shift`, `customers`) que hoy usan `limit`/`offset` pero
SIN envelope (el bug de truncado silencioso) quedan para un bloque
aparte — mismo contrato, pero no tienen consumidor vivo hoy en el
frontend (`ordersApi.list()` se llama sin argumentos), así que el
cambio ahí es más grande en superficie de archivos pero sin la urgencia
de un contrato roto entre repos.

**Estado: bloque de implementación, esta ronda (alcance: `reservations` +
el desempate de `ORDER BY`/`.max()` en los 5 listados). El resto
(`orders`/`products`/`cash-register-shift`/`customers` al envelope
completo) queda registrado como bloque aparte en pendientes.**

## 13. D-09 — Bandeja de dead-letter para propagación de catálogo

**Decisión: sí**, necesita su propia bandeja visible (no alcanza con el
log). Mismo criterio que ya existe para el outbox
(`GET/POST /api/system/outbox/dead-letter`), aplicado a
`company_catalog_propagation_queue`.

**Estado: bloque de diseño/producto propio, aparte — es un endpoint
nuevo + posiblemente notificación, no un fix de duplicación. Se
recomienda diseñarlo junto con el arreglo de atomicidad de F2-07/F2-14
(mismo worker/feature). No en este batch.**

## 14. D-23 — Desambiguar los 4 `INVALID_TRANSITION`

**Decisión: sí.** `ORDER_INVALID_TRANSITION`, `STAY_INVALID_TRANSITION`,
`HOUSEKEEPING_TASK_INVALID_TRANSITION`, `ACCOUNTS_RECEIVABLE_INVALID_TRANSITION`
(codes propios, reemplazando el `'INVALID_TRANSITION'` compartido) y la
reserva gana su propia clase de transición mapeada a 409 (hoy usa
`InvalidReservationError`/`'INVALID_RESERVATION'`, 400).

**Estado: bloque aparte — es cambio de contrato de API (`code` visible al
cliente), el `CLAUDE.md` raíz exige revisar `appfrontend-main` ANTES de
tocar el `code` (¿quién matchea `'INVALID_TRANSITION'` hoy?). No en este
batch — primer paso es esa verificación cross-repo, no la implementación.**

## 15. D-08 — PDF de factura sin CUIT de emisor resoluble

**Decisión: debe fallar.** `invoice-pdf.service.ts` deja de degradar a
`emisorCuit ?? afipCuit ?? taxId ?? ''` — si ninguno de los 3 resuelve,
tira (mismo criterio `honest-degradation` que el resto del dominio de
facturación: `AfipNotConfiguredError` o similar, no un PDF con el campo
vacío).

**Estado: bloque de esta ronda.**

---

## Resumen de qué se implementa en este batch (15/09/2026, misma sesión)

Bloques chicos, reversibles, cada uno con su propio gate `architecture-governor`
antes de commitear — igual que el resto de esta sesión:

- **Bloque "limpieza"**: #3 (borrar `supabase/`, `migrations/README.md`),
  #4 (SSL unificado), #15 (PDF falla sin CUIT).
- **Bloque "AFIP credentials"**: #1 (OWNER_ONLY) + F2-05 (transacción +
  auditoría, ya sin pregunta abierta — bug confirmado).
- **Bloque "resource uniqueness"**: #2.
- **Bloque "filtros de reservas"**: #7.
- **Bloque "auditoría de reservas"**: #8.
- **Bloque "tope de paginación en reservas"**: mitad de #12 que no
  depende del grounding.

**Grounding despachado en paralelo** (no implementa nada, solo investiga):
#6 (horizonte de mantenimiento, caso de borde), #9 (emisores no-CUIT),
#12 (contrato de paginación).

**Bloques de diseño propio, para después de este batch** (no arrancan
hoy): #5 (tipo `req.db?`, 186 sitios), #10 (moneda en frontend, 17
archivos), #11 (TTL de sesión por tenant, feature nueva), #13 (bandeja de
dead-letter de propagación), #14 (desambiguar `INVALID_TRANSITION`, cambio
de contrato cross-repo).
