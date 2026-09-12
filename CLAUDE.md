# Instrucciones del proyecto — app-main

Backend (API, dominio, infraestructura) de una app de reservas multi-tenant
y multirubro (hotelería, servicios, POS). Ver también el `CLAUDE.md` de
`App - frontend/` (nivel superior) para el contexto de los dos repos.
Mapa de docs reutilizables: `docs/indice-conocimiento.md`.

## Criterios de negocio — cumplimiento obligatorio

Antes de crear o modificar cualquier entidad, tabla, repositorio o
servicio de dominio, usá la skill `criterios-negocio`
(`.claude/skills/criterios-negocio/`). Formaliza el proceso de
`docs/criterios-datos.md` y `docs/criterios-negocio.md`: clasificar la
entidad (maestro/transacción/documento), chequear las reglas relevantes, y
declarar explícitamente qué se cumple, qué se incumple a propósito y por
qué. No propongas "mejorar" las decisiones que esos documentos ya marcan
como correctas.

Usá los nombres que ya existen en el código (`docs/criterios-negocio.md`,
A5.5). Si una entidad se llama `Turno`, no la renombres a `BookingLine`.

## Preguntas de alcance pueden esconder una decisión de negocio

Antes de implementar algo que surgió como "¿lo construimos ahora?" o "¿esto
entra en el alcance?", separá la pregunta de alcance de cualquier decisión de
comportamiento escondida adentro. Caso real (D5, 22/08/2026): la pregunta era
"¿el catálogo es reutilizable?" — la implementación resolvió eso Y, sin
preguntarlo aparte, asumió que reutilizable significaba "snapshot al asignar"
en vez de "regla viva". Esa segunda parte era una decisión de negocio con dos
respuestas igual de válidas y no se preguntó — quedó registrada como
"confirmada" sin estarlo, y hubo que revertir diseño ya implementado.

Regla: si una pregunta de alcance, una vez resuelta, puede comportarse de más
de una forma razonable, cada forma es su propia pregunta con
`AskUserQuestion` — no la resuelvas como parte de la primera.

**Principio ya declarado, transversal — chequearlo ANTES de diseñar, no
después:** `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md`
dice, sobre facturación/NC (buscar la frase textual, no citar por línea —
mismo criterio que SCHEMA-ANCHOR-DRIFT-001): *"La app no le dice al
cliente cómo trabajar; le permite formalizar electrónicamente una
decisión que el cliente ya tomó."* No es un principio acotado a esa
feature — aplica a cualquier
diseño que se plantee bloquear, rechazar en firme, o forzar un único
camino cuando el sistema no puede resolver algo solo. Caso real
(`CN-ESCAPE-ORPHAN-ADJUSTMENT-001`, 11-12/09/2026): frente a un
`ADJUSTMENT` que puede quedar trabado si la atribución fiscal automática
no cierra, la primera propuesta fue marcarlo "FALLIDO" de forma terminal
y mandar al usuario fuera del sistema a resolverlo — sin haber
chequeado este principio ni buscado el precedente ERP antes de diseñar.
El grounding pedido DESPUÉS (`auditor-circuitos-erp`) fue unánime en los
5 sistemas de referencia: ninguno bloquea así — todos dejan un documento
en borrador que un humano completa. Repetible: antes de proponer un
diseño que bloquea o dicta, primero preguntar "¿el sistema le da al
negocio una salida propia, o lo manda a resolver por afuera?" — y si hay
grounding ERP disponible, pedirlo ANTES de diseñar una solución propia,
no para validarla después.

## Developing defensivo — obligatorio antes de dar un cambio por terminado

Además de `criterios-negocio`, todo cambio de código (no solo los que
tocan entidades de dominio) sigue `docs/DEFENSIVE_DEVELOPING.md`. Este
repo históricamente lo disparaba vía el checklist del PR template
(`.github/pull_request_template.md`), pero buena parte del trabajo actual
se commitea directo a `main` sin pasar por PR — así que el checklist
nunca se completa solo. Por eso: respondé la sección 2 (genérica) y, si el
cambio toca `src/api/routes/`, `src/container.ts`, `src/platform/` o
`src/workers/`, también la sección 3 (multi-tenant: `req.db` vs.
`getPlatformRawPool()`, pool del `TransactionManager`, BD del
`DomainEventRepository`) — como parte del mensaje de commit si no hay PR,
no solo cuando lo hay.

Esto no reemplaza a `criterios-negocio`: esa skill cubre integridad de
datos y reglas de negocio; este documento cubre fallos de arquitectura y
wiring (pools mezclados, fallos a mitad de camino, un solo camino por
responsabilidad). Los dos aplican en paralelo cuando el cambio toca
ambas cosas.

## RBAC — maestro de permisos por endpoint

`docs/rbac-matriz-endpoints.md` es la fuente de verdad de qué grupo de
`security/roles.ts` exige cada ruta — es un documento vivo, no una foto
única. Al agregar, sacar o cambiar un `authorize(Roles.X)` en cualquier
`*.routes.ts`, actualizá ese documento (la fila del endpoint que tocaste)
Y el número `EXPECTED_AUTHORIZE_CALL_SITES` de
`src/tests/security/rbac-matrix-sync.test.ts` en el mismo cambio — ese
test es una cerca eléctrica (cuenta call-sites reales contra un número
fijo), no un sistema que interpreta código; si rompe, es la señal de que
el maestro se desactualizó.

Desde el 30/08/2026 hay una **segunda cerca**:
`src/tests/security/rbac-route-coverage.test.ts` recorre los `*.routes.ts` y
falla si un `router.<method>()` no tiene `authorize(Roles.X)` /
`authorizePlatform(...)` en su cadena ni un `router.use()` de autz previo,
salvo que figure en su allowlist `PUBLIC_ROUTES` con el motivo. Cubre lo que
la cerca de conteo NO ve: una ruta agregada a un archivo que YA existe, sin
`authorize()` (Hueco 2 del ADR
`docs/diseno-rbac-modelo-y-alcance-2026-08-30.md`).

Desde el 07/09/2026 hay una **tercera cerca**:
`src/tests/architecture/api-auth-gate-order.test.ts` (RBAC-MOUNT-001) valida
que el `app.use('/api', authenticate(...))` de `src/app.ts` precede a todo
router protegido de `/api` — todo mount `/api/...` anterior al gate tiene que
estar en su allowlist `PRE_AUTH_API_MOUNTS` con motivo. Cubre solo el gate de
tenant (no `tenantMiddleware` ni el `authenticate()` interno del portal).

Desde el 08/09/2026 hay una **cuarta cerca**:
`src/tests/architecture/customer-portal-ownership-guard.test.ts` (RBAC-OWN-001,
clase) valida que toda ruta de `customer.routes.ts` con un `:param` de recurso
(cualquiera menos `:businessSlug`) llama a un guard de pertenencia
(`requireOwnReservation`, hoy) o figura en su allowlist `OWNERSHIP_EXEMPT` con
motivo.

Desde el 08/09/2026 hay una **quinta cerca**:
`src/tests/architecture/credit-note-escape-containment.test.ts`
(`CN-ESCAPE-CONTAINMENT-001`, ADR común cancelar-con-NC §4 capa iv). A
diferencia de las otras cuatro —que exigen que *alguna* autz exista— su
aserción **(D)** congela el **grupo exacto** de las rutas del escape fiscal:
falla si `POST /api/orders/:id/cancel-with-credit-note` o
`POST /api/reservations/:id/cancel-with-credit-note` dejan de exigir
`Roles.EMISOR_NOTA_CREDITO` (p. ej. degradado a `Roles.ORDERS`/`Roles.FRONT_DESK`). Ni
`rbac-route-coverage` ni `rbac-matrix-sync` lo ven —sigue habiendo *un*
`authorize` y el conteo no cambia—. La lista de rutas vigiladas es
`ESCAPE_ROUTES` (dos desde el bloque 3.3-b2, 09/09/2026 — órdenes y
reservas). Las otras cuatro
aserciones de ese archivo (A/B/C.1/C.2) son contención de arquitectura, no
RBAC.

Consecuencia práctica: ahora son **cinco** artefactos a mantener en sync a
mano — la sección 4 de la matriz, el `PUBLIC_ROUTES` de `rbac-route-coverage`,
el `PRE_AUTH_API_MOUNTS` de `api-auth-gate-order`, el `OWNERSHIP_EXEMPT` de
`customer-portal-ownership-guard` y los `authorize()` reales. Para las rutas
del escape con Nota de Crédito hay **un sexto**, acotado a ellas:
`ESCAPE_ROUTES` de `credit-note-escape-containment.test.ts` — al tocar el
`authorize` de `POST /api/orders/:id/cancel-with-credit-note` o de
`POST /api/reservations/:id/cancel-with-credit-note` (bloque 3.3-b2,
09/09/2026) hay que actualizar la matriz,
`EXPECTED_AUTHORIZE_CALL_SITES` **y** esa fila. El test de
`rbac-route-coverage` cubre el cruce `PUBLIC_ROUTES` contra el código en las
dos direcciones (ruta sin autz que falta en el allowlist, y entrada del
allowlist que ya no matchea); `api-auth-gate-order` y
`customer-portal-ownership-guard` cubren solo la dirección "entrada stale" de
su allowlist. Si agregás una ruta pública, tocá los dos.

**✅ RBAC-SYNC-001 §4 resuelto (09/09/2026, gate `architecture-governor`,
"camino 3"):** hasta acá, nada verificaba la sección 4 de la matriz contra
`PUBLIC_ROUTES` — era a ojo. Ahora `src/tests/architecture/rbac-matrix-public-routes-sync.test.ts`
parsea la sección 4 (formato: archivo entre backticks terminado en
`.routes.ts`, MÉTODO en mayúsculas, cada path entre backticks empezando
con `/`) y la cruza contra `PUBLIC_ROUTES` (importado del test original,
no duplicado) en las dos direcciones — fail-loud si una fila no se puede
parsear ni matchea una exclusión declarada. Esa exclusión
(`EXCLUDED_ROWS`, 3 filas sin contraparte real -- `app.ts` x2 +
`platform.routes.ts (resto)` histórico -- verificadas también en las dos
direcciones) es el **séptimo** artefacto de la lista de arriba: mismo
criterio que `PRE_AUTH_API_MOUNTS`/`OWNERSHIP_EXEMPT`/`ESCAPE_ROUTES`, un
allowlist chico con motivo, no una excepción muda. Esta cerca no resuelve
`app.ts` ni valida montaje — eso sigue siendo alcance de
`api-auth-gate-order`/`rbac-route-coverage`.

**RBAC-MATRIX-SECTION2-001 (09/09/2026, gate `architecture-governor`):**
hasta acá, ni la cerca de conteo (`rbac-matrix-sync`) ni `rbac-route-coverage`
cruzan el CONTENIDO fila-por-fila de la sección 2 de la matriz (`archivo →
método+path`) contra el código real — solo que el TOTAL de `authorize()`
coincida, o que cada ruta tenga ALGUNA capa de autz. El hueco real que
esto cierra: una ruta agregada bajo un `router.use(...)` que YA instala
el guard de autz no suma un `authorize()` call-site nuevo (el conteo no
se mueve) y `rbac-route-coverage` la da por cubierta (hay guard previo)
— así que la matriz podía quedarse sin esa fila para siempre sin que
ninguna cerca se enterara.
`src/tests/architecture/rbac-matrix-section2-sync.test.ts` cruza
EXISTENCIA usando `route-enumeration.fixture.ts` (extraído el mismo día
de `rbac-route-coverage.test.ts`, para no reimplementar el enumerador
dos veces) contra bullets `- MÉTODO \`path\`` de la sección 2 — join por
CÓDIGO, no por `docs/inventario-rutas.md` (ese mapa archivo→prefijo no es
función: 2 archivos montan 2 routers en 2 prefijos distintos). **No
valida el GRUPO que cada fila declara** — una fila puede seguir diciendo
`FRONT_DESK` cuando el código exige `MANAGEMENT` sin que esta cerca (ni
ninguna otra de las cuatro) lo detecte; `chain` en `RouteCall` ya trae la
cadena de middlewares con el `authorize(Roles.X)` real, así que el bloque
de grupo queda habilitado pero no implementado.

`EXCLUDED_FILES` (**noveno** artefacto manual del repo, ver la nota de
numeración en "Contratos" más abajo): 11 archivos donde la sección 2
describe las rutas protegidas en prosa (comodines, corchetes opcionales,
párrafos narrativos) en vez de bullets parseables — 85 rutas protegidas
sin verificar fila por fila todavía (medido, no el ~83 de una estimación
previa al gate: `accounts-receivable.routes.ts` tiene 3, no 1 — su único
bullet real diverge del código, `/?companyCustomerId=` vs `/`).
Cuantificado a propósito (cada entrada lleva el conteo real, verificado
contra el código): agregar una ruta a uno de estos 11 archivos sin
normalizar la sección 2 pone la suite roja — la deuda queda medida
adentro de la cerca, no invisible. **Hueco declarado, todavía sin
cerrar:** la aserción de `EXCLUDED_FILES` solo verifica "¿el conteo de
rutas protegidas sigue coincidiendo?", no "¿el archivo sigue sin bullets
parseables?" — si alguien normaliza `products.routes.ts` a sus 30
bullets reales y se olvida de sacarlo de `EXCLUDED_FILES`, el conteo
sigue dando 30 y la cerca queda verde ignorando los 30 bullets nuevos.
Cerrar esa dirección (contar bullets parseables por archivo y compararlo
contra 0, o contra lo que corresponda) es el próximo bloque, obligatorio
antes de empezar a normalizar cualquiera de los 11 archivos. Normalizar
esos 11 archivos a bullets (y sacarlos de `EXCLUDED_FILES`) es, además,
un bloque de docs aparte, no decidido todavía.

**`ROLES-CATALOG-DRIFT-001` (09/09/2026, gate `architecture-governor`,
**décimo** artefacto manual del repo -- cuenta corrida, ver la nota de
numeración en "Contratos"): nació del caso real de `EMISOR_NOTA_CREDITO`
(bloque 5.1) -- agregado a `Roles` el 07/09/2026, nunca propagado a
`appfrontend-main`, descubierto recién el 09/09/2026.
`src/tests/security/roles-catalog-sync.test.ts` congela el CONJUNTO
ordenado del catálogo (no un conteo -- un conteo no detecta que se
RENOMBRE una clave manteniendo el tamaño, mutación verificada) + un
espejo `key === value` (la clave persiste tal cual en
`role_permission_groups.permission_group`). El mensaje de falla apunta a
los 3 catálogos a mano de `appfrontend-main` y a `docs/pendientes-2026-09-08.md`
bloque 5.1 -- el detalle de CADA catálogo (no los tres tienen la misma
regla de inclusión: `dashboard/roles/page.tsx` excluye `CUSTOMER_ONLY` a
propósito) vive en el docblock del archivo, no en el mensaje, para no
citar rutas exactas de otro repo en un string que nadie relee hasta que
falla. **No verifica que `appfrontend-main` se haya actualizado** -- es
un recordatorio en el momento del cambio de este repo, no un chequeo de
sincronía real entre los dos (no hay CI compartida). Y está VERDE hoy con
`roles-de-fabrica/page.tsx` todavía desincronizado (8 de 9) -- verde acá
no implica que los 3 catálogos del frontend estén al día.

## Contratos — spec OpenAPI vs rutas reales

Distinto de RBAC: esto es sobre qué documenta `src/openapi/spec.ts`, no
sobre quién puede pegarle a una ruta. La numeración de "artefacto manual"
es una cuenta corrida para todo el repo, no una por sección -- el octavo
se nombra acá abajo (`CLOSURE_MOUNTS`); el noveno (`EXCLUDED_FILES`,
RBAC-MATRIX-SECTION2-001) se nombra en la sección RBAC de arriba, donde
corresponde temáticamente. **No es una cuenta exhaustiva:**
`MOUNT_TO_ROUTES_FILE` y `EXCLUDED_PATHS` (los dos allowlists manuales de
`CONTRACT-001`, unas líneas más abajo) son del mismo tipo -- allowlist
chico con motivo, verificado en las dos direcciones -- y no tienen número
asignado. El número sirve para citar un artefacto puntual en una
conversación ("el séptimo"), no para saber cuántos hay en total.

**`src/openapi/spec.ts`** es un OpenAPI 3.0.3 escrito a mano, NO generado
desde las rutas reales. Hasta el 09/09/2026 nada lo cruzaba contra el
código: 3 de los 19 paths documentados daban 404 real (2 de `/api/reports`
mal escritos, 1 fantasma en `/api/resources`), uno de ellos sin detectarse
por ~2.5 meses. Corregido en `a96aa90`.

Desde el 09/09/2026 hay una cerca: `src/tests/architecture/openapi-spec-route-sync.test.ts`
(`CONTRACT-001`, `cf59908`) importa `openApiSpec` como módulo real (no
regex sobre el texto de `spec.ts`) y verifica que cada path+método
documentado exista como `router.<método>()` real en el `*.routes.ts`
correspondiente — existencia solamente, no valida request/response
schemas. Dos allowlists chicas con motivo, mismo criterio que las de
RBAC: `MOUNT_TO_ROUTES_FILE` (prefijo de `app.ts` → archivo de rutas, solo
para los 6 prefijos que `spec.ts` documenta hoy — manual porque al menos
un mount real, `/api/reports`, arma el router dentro de un closure de
middleware en vez de `app.use(prefix, routerFn(...))`, y un parser
genérico de `app.ts` no lo ve) y `EXCLUDED_PATHS` (`/health`,
`/health/db` — `app.get()` directos de `app.ts`, no viven en ningún
`*.routes.ts`). Sin `EXPECTED_*` de conteo a propósito: documentar un
endpoint nuevo no debe romper el build.

**Lo que esta cerca NO garantiza** (declarado en su propio header): que
`MOUNT_TO_ROUTES_FILE` siga apuntando al router que `app.ts` monta
realmente en cada prefijo. El mapa es manual, verificado a mano el
09/09/2026; si un prefijo se re-monta a otro router, la cerca sigue verde
validando contra el archivo viejo — re-verificar a mano al tocar esos
mounts.

**Lo que esta cerca a propósito NO hace:** exigir que un endpoint real
esté documentado. `spec.ts` cubre ~18 paths de **251** endpoints reales
(33 routers montados en `app.ts` sin ninguna entrada acá) -- el 251 es
medido, no estimado: ver `docs/inventario-rutas.md` más abajo. Cerrar esa brecha
es `CONTRACT-COVERAGE-001` — decisión de producto (mantener el spec a
mano vs. generarlo desde las rutas), no algo que un fence deba forzar. Ver
`docs/pendientes-2026-09-08.md`, sección Higiene, para el detalle
completo y los dos ítems de backlog que bloquea.

**`CONTRACT-COVERAGE-001`, componente de existencia — resuelto el
09/09/2026 (gate `architecture-governor`, opción (A) elegida por el
dueño), `2194849`.** No completando `spec.ts` a mano — mismo modo de
falla que ya causó `CONTRACT-001` — sino generando un inventario de
EXISTENCIA (`docs/inventario-rutas.md`, `npm run docs:routes`)
booteando la app real y caminando `app._router.stack`: el árbol vivo de
Express resuelve automáticamente los prefijos de montaje normales, sin
regex sobre texto. `src/tests/architecture/openapi-spec-route-sync.test.ts`
sigue vigente — no se retira, este inventario no valida request/response.

Seis mounts arman su router DENTRO de un middleware por-request (`req.db`,
no al boot) y por eso el árbol vivo no los ve al caminar
(`/api/reports`, `/api/system`, `/api/housekeeping`,
`/api/maintenance-windows`, `/api/stays`, `/api/accounts-receivable` — 40
endpoints, confirmado por spike real, no inferido). `CLOSURE_MOUNTS`
(`src/scripts/generate-route-inventory.ts`) es el **octavo** artefacto
manual del repo — mismo criterio que `MOUNT_TO_ROUTES_FILE`: allowlist
chico, motivo por entrada, verificado en las dos direcciones (mount sin
explicar → falla nombrándolo; entrada que ya no es un closure → falla
nombrándola).

**Lo que este inventario NO dice, a propósito:** quién puede pegarle a
cada ruta (`authorize(Roles.X)`/`requireModule(...)`/`authorizePlatform(...)`
capturan el permiso en un closure — nada legible desde `app._router.stack`;
esa pregunta sigue siendo `docs/rbac-matriz-endpoints.md` + 7 cercas, y
cruzarla contra este inventario es un bloque futuro, no decidido) ni la
forma del request/response (`spec.ts` sigue siendo el único con eso, para
18 de 251). Depende de `NODE_ENV` — generado con `development`, `/` y
`/openapi.json` no existen en producción, marcado en el propio artefacto.

## Pendientes — revalidar antes de arrastrar

**Auditoría del 01/09/2026:** de 28 ítems abiertos de
`docs/pendientes-2026-08-31.md` (commit `3a40ba4`), **6 no eran lo que decían**
(21%). Uno estaba
resuelto hacía tres días, tres estaban mal dimensionados, uno no tenía
referente en ningún lado del repo y uno estaba duplicado.

**Lo que se pudre no es lo viejo.** Los 5 ítems de frontend —los más antiguos,
los sospechados— verificaron **todos, al número de línea**. Se pudre lo que
queda **fuera de una categoría que alguien relee**: los tres peores hallazgos
compartían no estar en ninguna sección revisable.

Cinco reglas, cada una de un caso real de este repo:

1. **Ningún ítem sin ancla verificable.** Cada uno lleva `archivo:línea`, un
   comando que lo reproduce, o una etiqueta explícita de por qué no se puede
   verificar (`requiere decisión del dueño`, `requiere query`, `requiere
   entorno`). Un ítem sin referente **no se arrastra: se reescribe o se borra**.
   → *"RBAC — mecanismos 1 y 2" viajó idéntico por 5 archivos sin que en ningún
   lado se defina qué son.*
2. **Al arrastrar, se re-chequea el ancla.** Es barato: ¿el `archivo:línea`
   sigue existiendo?, ¿el grep sigue pegando? Si el ancla se movió, el ítem
   cambió. → *D8 se arrastró 3 días como abierto estando implementado.*
3. **El ítem describe la consecuencia, no el mecanismo.** *"2 queries con JOIN
   sin vista unificada"* se lee como refactor; *"el saldo del cliente queda
   subdeclarado y se devuelve plata sin nota de crédito"* se lee como lo que es.
   → *Gap C1-C, subdimensionado desde el 27/08.*
4. **Si el ítem cita un documento versionado, cita la versión — y se re-chequea
   en el mismo commit.** → *FACT-BORRADOR-001 nació citando v2.7 cuando el
   commit padre del suyo ya era v2.8. **El arrastre no necesita semanas: le
   alcanzaron dos commits de la misma sesión.***
5. **Verificar accesibilidad, no solo existencia.** Que el backend **exponga**
   un dato no significa que **el usuario de esa pantalla pueda leerlo**: hay
   que mirar el `authorize(Roles.X)` del endpoint contra los grupos que tiene
   el rol que la usa (`platform.schema.sql`, presets). → *D6 pasó por **tres**
   revisiones que lo declararon "UI pura". Las tres verificaron que los campos
   existieran; ninguna miró quién podía leerlos. `GET /api/business-profile`
   exige `MANAGEMENT` y el preset `RECEPTIONIST` no lo tiene — el usuario que
   más usa esa pantalla recibía 403. El bloqueo apareció recién al implementar.*

**Cuándo aplica:** al crear un `pendientes-<fecha>.md` nuevo arrastrando ítems
del anterior. **No** exige re-auditar todo el archivo cada sesión —eso nadie lo
sostiene—: exige no copiar una línea sin mirar lo que afirma.

## Skills de ingeniería (capa técnica)

14 skills genéricas de ingeniería y seguridad en `.claude/skills/`,
seleccionadas de las 72 del set "SKILLS — Engineering Discipline Skill Set"
y copiadas el 30/08/2026 desde una copia local desempaquetada (sin repo git,
sin commit upstream registrado). Se activan en una **capa distinta** de
`criterios-negocio` y `revision-pr-pms-erp`: arquitectura, proceso de cambio
y auditoría, no reglas de negocio ni integridad de datos. Cada `SKILL.md`
lleva al final una sección "Precedencia en este repo".

**Ninguna de las 14 sustituye el paso obligatorio de `criterios-negocio`**
(ni el de `docs/DEFENSIVE_DEVELOPING.md`): son capa adicional, no alternativa.
El riesgo a vigilar no es que contradigan a `criterios-negocio` —para eso
está la cláusula de precedencia al final de cada `SKILL.md`— sino que una
tarea dispare solo la skill técnica y nunca cargue `criterios-negocio`. La
instrucción de más arriba ("Antes de crear o modificar cualquier entidad…
usá la skill `criterios-negocio`") se aplica igual, la haya disparado una
skill técnica o no.

- **`atomic-state-mutation`** — varias escrituras que tienen que ser una sola
  unidad atómica. Caso vivo: `domain/audit.ts` — `updateWithAudit()` /
  `recordFieldChangesWithClient()` envuelven "UPDATE de la entidad + INSERT de
  auditoría" en una `TransactionManager.run()` (fix del 25/08/2026; antes eran
  dos `await` sueltos y si el segundo fallaba se perdía el rastro). La
  `recordFieldChanges()` no transaccional queda a propósito para el único caso
  cross-DB (`RoleService.updatePermissionGroups()`: rol en BD de plataforma,
  auditoría en BD de tenant).
- **`concurrency-reasoning`** — código que corre más de una vez a la vez:
  réplicas, retries, cron que se solapa, doble click. Toca los `SELECT ... FOR
  UPDATE` de `reservation.service.ts` / `reservation-availability.service.ts`
  (serializan disponibilidad + INSERT), el `FOR UPDATE` sobre `orders` de
  `sql.order.repository.ts`, `reservation-hold-expiry.worker.ts` y el
  `OutboxWorker` (polls solapados). Para el caso puramente transaccional de BD,
  deriva a `atomic-state-mutation`.
- **`versioned-schema-evolution`** — formatos serializados que sobreviven al
  código que los escribió. Aplica a `schema.sql` reaplicado idempotente a cada
  tenant en cada deploy (`npm run migrate:tenants`), a los `migrations/NNN_*.sql`
  numerados, y al campo `version` de los handlers del outbox (A10.1/A10.4:
  `UnsupportedEventVersionError` — "versión desconocida se rechaza ruidosamente").
- **`honest-degradation`** — que una ruta degradada falle visible en vez de
  devolver algo plausible y mal. El repo ya decide fail-loud vs fail-open por
  subsistema: `migrate:tenants` que falla tumba el build entero (R15); mail
  sin `RESEND_API_KEY` → `NoopEmailSender` (fail-open a propósito); OAuth sin
  `GOOGLE_CLIENT_ID` → fail-closed; superadmin sin envs → 503
  `PLATFORM_AUTH_NOT_CONFIGURED`. Hallazgo abierto que esta skill levantaría:
  `db/pg.client.ts::sslConfig()` cae a `ssl: false` en silencio (sin warn) si
  falta `NEON_SSL` — eso es deuda, no una decisión. Usarla al agregar un
  fallback nuevo.
- **`authorization-surface-mapping`** — construir la matriz actor × recurso ×
  acción y probar las celdas sin test (las ausencias no se grepean). El
  aislamiento entre tenants **ya es estructural** (una BD por negocio,
  `platform/tenant.middleware.ts` → `req.db`): ahí la skill no aporta. Se acota
  a los 2 huecos reales, registrados en
  `docs/diseno-rbac-modelo-y-alcance-2026-08-30.md`: (1) ownership dentro de un
  tenant en el portal de cliente (`api/routes/customer.routes.ts`, rutas
  `Roles.CUSTOMER_ONLY` — **no** `me.routes.ts`, que es el `/api/auth/me` de
  staff sin `:id`) — **cerrado**: instancia el 07/09/2026
  (`requireOwnReservation()` + prueba negativa de integración), clase el
  08/09/2026 (cerca `customer-portal-ownership-guard.test.ts`, ver arriba);
  (2) ruta nueva sin `authorize()` en un `*.routes.ts` existente — invisible
  para la cerca de conteo `src/tests/security/rbac-matrix-sync.test.ts`
  (mitigado por `rbac-route-coverage.test.ts`).
  Complementa —no reemplaza— `authorize(Roles.X)` + `docs/rbac-matriz-endpoints.md`.
- **`irreversible-action-gate`** — clasificar por reversibilidad y radio antes
  de ejecutar algo destructivo, masivo o hacia afuera. Casos: `migrate:tenants`
  en cada deploy (escribe en todas las tenant DB), la cancelación C2 de reserva
  que hoy no usa el preview/confirm de reembolso (backlog en pendientes), el
  aprovisionamiento de tenant en Neon, y toda decisión de "¿desactivar /
  soft-delete / hard-delete?" (esa parte la manda `criterios-negocio`).
- **`secret-lifecycle-discipline`** — credenciales como ciclo de vida (emisión,
  alcance, rotación, revocación) y redacción en el borde. Toca los `sync: false`
  de `render.yaml` (`JWT_SECRET`, `PLATFORM_DATABASE_URL`, `DB_ENCRYPTION_KEY`,
  `NEON_API_KEY`, `RESEND_API_KEY`, `PLATFORM_JWT_SECRET`/`_ADMIN_PASSWORD`), el
  `db_url_encrypted` guardado en la BD central, y la separación deliberada
  `PLATFORM_JWT_SECRET` ≠ `JWT_SECRET`. No hay historia de rotación para
  `DB_ENCRYPTION_KEY` — eso es un hallazgo, no un dato.
- **`crypto-misuse-reasoning`** — juzgar el uso, no el nombre del primitivo.
  Este repo hace crypto a mano a propósito ("sin SDK nuevo"): `tenant-db.setup.ts`
  cifra connection strings con AES-256-GCM (`createCipheriv`, IV de 16 bytes
  random, authTag, formato `iv:authTag:ct`); `google-oauth.ts` verifica JWT
  RS256 + JWKS con `node:crypto` (lookup por `kid`, chequeo de `iss`/`aud`/`exp`
  — sin el `aud` pasaría cualquier token de Google de otra app);
  `auth.middleware.ts` firma el JWT propio igual. Revisá las costuras al tocar
  cualquiera.
- **`dependency-provenance`** — saber qué se ejecuta realmente y de dónde vino
  (manifest vs lock vs instalado vs shipped). Contexto: el build de Render corre
  `npm install` (no `npm ci`), el `postinstall` de Puppeteer no se dispara con
  `node_modules` cacheado (`npx puppeteer browsers install chrome` explícito en
  `render.yaml`), `@arcasdk/pdf` arrastra Chromium, y hay `patches/`
  (patch-package). Usarla al sumar o subir una dependencia.
- **`pipeline-trust`** — el pipeline de CI/CD como entorno privilegiado que
  corre código con credenciales de producción. El `buildCommand` de `render.yaml`
  encadena `npm install && npx puppeteer … && npm run build && npm run
  migrate:tenants`: el build tiene `PLATFORM_DATABASE_URL` y **escribe en todas
  las tenant DB**. Deploy = migración contra producción, no "un poco de YAML".
- **`decision-record-discipline`** — capturar la decisión con su contexto
  (fuerzas del momento, alternativas descartadas, supuesto, gatillo de revisión).
  El repo ya lo hace informal: comentarios fechados por todo `render.yaml` y el
  código, los `docs/pendientes-YYYY-MM-DD.md`, el
  `plan-separacion-dominios-multirubro`. Usarla cuando una elección de librería,
  modelo de datos o límite vaya a ser difícil de deshacer.
- **`audit-before-patch`** — validar todo hallazgo de auditoría contra el
  archivo vivo antes de tocar una línea. Directo al flujo de `revision-pr-pms-erp`
  y a cuando otro modelo pasa una lista de findings: confirmá el ancla, confirmá
  que el bug existe en este código (que no haya ya un guard), y recién ahí parchá.
- **`surgical-patcher`** — cambiar archivos por parches anclados, verificados y
  reversibles, nunca reescribiéndolos de memoria. Aplica a cualquier edición
  sobre `src/` existente, sobre todo al aplicar un diff de un auditor o de otro
  modelo. Este repo commitea directo a `main` sin PR: el radio de un reemplazo
  mal hecho es toda la rama.
- **`git-discipline`** — proteger la historia: tag de restore antes de la sesión,
  prohibido reescribir historia compartida, verificar el estado real del repo
  antes de afirmarlo. El repo commitea seguido directo a `main` sin PR y ya
  tiene la regla "no force-push" en el `CLAUDE.md` raíz. El hook de
  `.claude/skills/git-discipline/scripts/install_guard_hooks.sh` la refuerza a nivel git —bloquea el push
  non-fast-forward, incluido vía `git -C <path> push`— pero es una red
  parcial: vive en `.git/hooks/`, no se versiona (hay que reinstalarlo en
  cada clon) y se saltea con `git push --no-verify`.

## Modularidad — convenciones aplicadas (no aspiracionales)

Estado real del código después de `docs/auditoria-modularidad.md`
(auditoría completa) y su roadmap (7 fases, todas aplicadas). El detalle
completo — hallazgos, métricas, razonamiento — vive en ese documento y en
`docs/convenciones-nombres.md`; acá solo las reglas que un archivo nuevo
tiene que respetar de entrada.

**Nomenclatura de archivos:** `<entidad>.<capa>.ts` (ej.
`reservation.service.ts`, `sql.reservation.repository.ts`,
`customer.entities.ts`). El prefijo `sql.`/`in-memory.` antes de la
entidad distingue implementaciones de una misma interfaz. Nuevo archivo
de dominio → seguí este patrón, no inventes uno nuevo por archivo.

**Dónde viven los tipos:** si TODOS los importadores de un `*.types.ts`
viven dentro de un mismo módulo (ej. `reservas/`), el archivo vive ahí —
no en `src/types/`. Esa carpeta queda reservada para lo genuinamente
transversal (`enums.ts`, `visual.interface.ts`, `express.d.ts`). Antes de
crear un tipo nuevo, preguntate quién lo va a importar; si la respuesta es
"solo archivos de este módulo", el tipo vive en el módulo.

**Antes de reescribir un patrón que ya existe como helper compartido:**
- Regex de hora HH:MM/HH:MM:SS → `api/schemas/common.schemas.ts`
  (`TIME_ONLY_REGEX`/`timeOnlySchema`), no lo reescribas inline.
- "Diff contra el estado anterior + grabar auditoría si cambió algo" →
  `domain/audit.ts::recordFieldChanges()`, no repitas el
  `diffFields()` + `if (changes.length > 0) { record(...) }` a mano.
- "Resolver plan + límites del negocio contra la BD de plataforma, con
  503 si no responde" → `security/resolve-plan-limits.ts::resolvePlanLimits()`,
  mismo contrato que `requireModule`/`requirePlan`.
- Auditoría de catálogo/tarifas especiales → `domain/audit.ts::recordFieldChanges()`,
  ya extendido a `RateCatalogService` y a la desactivación de `customer_rates`
  (distingue "cambió el % del catálogo" de "se tocó al cliente puntual") — no
  reimplementes el diff a mano.
- Resolver ALOJAMIENTO vs. TURNOS → `ICategoryRepository` (columna `is_lodging`
  de `resource_categories`), ya inyectado en `ReservationPricingService` — si un
  servicio nuevo lo necesita, reenviá la dependencia existente, no crees una
  tabla ni un flag nuevo.
- "Exactamente uno de N" en un CHECK de Postgres (pricing mode de
  `customer_rates`, scope de `customer_rates`, scope de `rate_catalog`) →
  patrón CASE-based, ya usado 3 veces en este repo — no el diseño polimórfico
  `scope_type`/`scope_id` (pierde la FK real hacia las tablas de ítem).

**Bounded contexts — no importes la clase rica de otro contexto dentro de
tu propia entidad.** Si tu módulo solo necesita 2-3 campos de una entidad
de otro contexto (ej. `reservas` necesitando "quién reservó" de
`clientes-finanzas`), definí tu propia representación mínima en tu
módulo (value object sin validación propia — esos datos ya se validaron
una vez, en el contexto dueño) y resolvé el resto por id cuando
realmente haga falta. Ejemplo real:
`reservas/reservation-customer.entities.ts::ReservationCustomer` (id,
fullName, email) en vez de importar `clientes-finanzas/
customer.entities.ts::Customer` completo (que trae `kind`,
`contactMethods[]`, `active` — nada de lo cual el otro contexto lee
nunca). La capa de rutas/aplicación sigue pudiendo consultar el otro
contexto para resolver el dato completo — lo que no cruza el límite es
el objeto rico en sí, dentro del dominio.
