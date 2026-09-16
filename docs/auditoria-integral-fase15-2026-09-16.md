# Auditoría técnica integral — Fase 15: registro de decisiones

**Fecha:** 2026-09-16
**Repos y HEAD real (verificado con `git rev-parse`, no citado de fases previas):**
- Backend `/home/user/app` (`Alejandro-Gabriel-Pozo/app`), rama `main`, HEAD `e01e7253271e36ac46cf52c06400d5dfd4226e36`
- Frontend `/home/user/appfrontend` (`Alejandro-Gabriel-Pozo/appfrontend`), rama `main`, HEAD `3bc77f508498d458b3edfb319cbab7a1080bf7da`

## 0. Método y límites de esta fase

Esta fase **no busca hallazgos nuevos**: sintetiza los problemas importantes ya encontrados en las Fases 0–14 en el registro de decisiones con la plantilla de 17 campos del protocolo. Toda la evidencia citada proviene del documento de fase original y se cita por su ID (`F9-01`, `F10-02`, …). No se re-derivó evidencia.

**Documentos leídos** (confirmados con `ls`, no asumidos): `auditoria-integral-fase0-2026-09-15.md`, `fase1`, `fase2`, `fase3` (+ variantes `fase3-canonico`, `fase3-duplicacion`, `fase3-grounding`), `fase4`, `fase5`, `fase6`, `fase7`, `fase8`, `fase9`, `fase10` (todos `-2026-09-15.md`), `fase11`, `fase12`, `fase13`, `fase14` (todos `-2026-09-16.md`).

**Tres re-verificaciones puntuales contra el árbol vivo en HEAD `e01e725`** (única excepción a "no correr comandos nuevos", por ser los tres anclas de entradas CRÍTICAS):
1. `src/tests/integration/helpers/seed.ts:90` sigue siendo `const name = overrides.name ?? 'Habitación 101';` → **D-20 sigue abierta**.
2. `appfrontend/package.json:19` sigue siendo `"next": "16.3.1"` → **D-01 sigue abierta**.
3. `src/db/schema.sql:834-852` sigue conteniendo el `UPDATE customer_rates … SET discount_percentage = …, fixed_price = NULL` sin guard de versión → **D-07 sigue abierta**.

`git log --oneline -8` confirma que los 8 commits más recientes son **docs de auditoría únicamente** (`e01e725` Fase 14 … `1d2ef19` Fase 7): **ninguna remediación de las 14 fases ha aterrizado en código todavía**. El registro entero está, por lo tanto, en estado "abierto".

**Selección:** 25 entradas de los ~150+ hallazgos. Criterio: (1) los 3 CRÍTICOS confirmados; (2) los Alta con mayor impacto de negocio o radio de blast; (3) los explícitamente en HOLD esperando decisión del dueño. Quedan deliberadamente fuera decenas de hallazgos Media/Baja verificados — su ausencia acá no los cierra.

---

# A. Seguridad

## D-01 — `next@16.3.1` con dos advisories CRITICAL de RCE no autenticada

**Basado en:** F9-01 (Fase 9).

- **Concepto:** Dependencia directa de producción del frontend con ejecución remota de código no autenticada, con fix de patch disponible.
- **Ubicaciones:** `appfrontend/package.json:19`; `appfrontend/next.config.js` (sin bloque `images`); endpoint `/_next/image` del runtime de Next.
- **Problema observado:** `npm audit --omit=dev` devuelve 1 CRITICAL directa (`next`, GHSA-p293-qw3h-jr36 RCE en Windows + GHSA-2xp9-vwfh-vxw4 RCE en la Image Optimization API vía AVIF, rango `>=16.0.0 <16.3.3`) y 1 HIGH transitiva (`sharp <0.35.4`, GHSA-rgj7-g3m4-5g8c, libheif — justo el decodificador del optimizador).
- **Evidencia (F9-01):** `node -p "require('./node_modules/next/package.json').version"` → `16.3.1`; `npm audit --omit=dev --json` → `{"moderate":1,"high":1,"critical":1}` con `fixAvailable: {"name":"next","version":"16.3.5","isSemVerMajor":false}`; `grep -n "images" next.config.js` → sin coincidencias (rigen los defaults de `image-config.js:50-75`); `grep -rln "next/image" src` → **0 archivos**.
- **Comportamiento actual:** El panel de administración —el mismo origen donde vive la cookie de sesión de staff— corre sobre un runtime con RCE conocida, y expone `/_next/image` aunque ninguna pantalla lo use.
- **Comportamiento esperado:** Ninguna dependencia de producción con advisory CRITICAL o HIGH sin fix aplicado, y ninguna superficie expuesta sin consumidor.
- **Tipo de problema:** Dependencia externa rota + prueba insuficiente (ningún CI de ninguno de los dos repos corre `npm audit`).
- **Severidad:** **Crítica** (única de Fase 9).
- **Nivel de certeza:** Alta para versión, advisories y rango afectado (lectura directa de `npm audit` y `package.json`). HIPÓTESIS_A_CONFIRMAR para explotabilidad concreta en este despliegue: no se verificó el SO del runtime ni se construyó payload alguno, a propósito.
- **Riesgo:** Techo de severidad de los dos repos. RCE en el proceso que sirve el panel = compromiso de sesiones de staff (agravado por D-02 y D-04). El riesgo del cambio, en cambio, es mínimo: patch dentro de la misma minor.
- **Causa probable:** Pin exacto sin `^` (un `npm install` de rutina nunca lo sube) + ausencia de auditoría automática. La combinación hace el drift de seguridad invisible hasta que alguien lo mire a mano.
- **Opciones de solución:**

| Opción | Complejidad | Riesgo | Archivos | Prueba | Rollback | Impacto usuario | Compatibilidad | Mantenimiento |
|---|---|---|---|---|---|---|---|---|
| (a) Bump `next`≥16.3.3 (fix: 16.3.5) + `sharp`≥0.35.4 | Muy baja | Bajo (patch, no semver-major) | 2 (`package.json`+lock) | `npm audit` + `npm run build` | Revertir 2 archivos | Ninguno esperado | Total | Sin costo |
| (b) `images:{unoptimized:true}` o `localPatterns:[]` | Muy baja | Bajo (0 usos de `next/image`) | 1 (`next.config.js`) | Smoke de pantallas | Revertir 1 archivo | Ninguno hoy | Total | Reevaluar si se adopta `next/image` |
| (c) `npm audit --omit=dev --audit-level=high` en CI de ambos repos | Baja | Bajo (puede poner CI roja por deuda preexistente) | 2 workflows | La propia corrida | Sacar el step | Ninguno | Total | Convierte el hallazgo en detectable |

- **Solución recomendada:** Las tres, en ese orden, en bloques separados. (a) es el cambio de menor radio y mayor retorno de toda la auditoría; (b) elimina superficie gratis; (c) es lo que evita que se repita.
- **Archivos afectados:** `appfrontend/package.json`, `appfrontend/package-lock.json`, `appfrontend/next.config.js`, `.github/workflows/` de ambos repos. **No toca código de aplicación.**
- **Pruebas necesarias:** `npm audit --omit=dev` → 0 critical / 0 high; `npm run build` verde; suite del frontend verde; smoke de login y dashboard.
- **Posibles efectos secundarios:** Cambio de comportamiento del optimizador de imágenes (hoy sin consumidores); posible ruido nuevo en CI por deuda preexistente de `npm audit` en el backend (F11-08: `express@4.22.2`, 2 moderate con fix dentro del rango declarado).
- **Plan de rollback:** `git revert` del commit de bump; el lockfile vuelve al árbol anterior. Sin migración de datos ni estado persistido.

---

## D-02 — Tokens de sesión, cookies y PII en cada línea de log

**Basado en:** F9-02 (Fase 9), que reconfirma F8-10 y roza F8-06 (Fase 8).

- **Concepto:** El canal de logging emite credenciales reutilizables y datos personales en el 100% del tráfico.
- **Ubicaciones:** `src/app.ts:146` (`app.use(pinoHttp({ logger }))`, sin opciones); `src/logger.ts:24-32` (`pino({ level })`, sin `redact`); `src/clientes-finanzas/customers.routes.ts:531-548`; `src/api/middleware/error.middleware.ts:79-84`; `src/platform/business.routes.ts:183`.
- **Problema observado:** El serializer `req` por defecto de pino-http emite `headers` completo y `url` completa. Quedan en el log: `Authorization: Bearer <jwt>`, la cookie `rh_token`/`rh_customer_token`, y la query string con PII (`GET /api/customers?email=…&name=…`). Como `pinoHttp` se monta en la línea 146 —antes de todos los mounts— también captura el Bearer de **SUPERADMIN** de `/platform/*` y `/api/admin/*`.
- **Evidencia (F9-02):** Reproducido en dos bancos de prueba independientes (Fases 8 y 9): `req.headers = {"authorization":"Bearer …","cookie":"rh_token=…"}` y `req.url = /api/customers?email=…&name=…`. El propio repo ya declara la clase como deuda en `error.middleware.ts:80-84` (política MID-LOG-001, que sí corta la query string en *ese* log) y ya movió `search` a `POST /customers/search` por este exacto motivo, dejando `email` y `name` donde estaban.
- **Comportamiento actual:** Cualquier lectura de logs —consola de Render, agregador, volcado de soporte, ticket con logs pegados— entrega sesiones reutilizables hasta su `exp` (24h staff, 8h superadmin) y, con D-04 encima, renovables sin tope.
- **Comportamiento esperado:** Redacción en el borde: ningún secreto ni PII en el canal de observabilidad, misma política que MID-LOG-001 ya declara para el `errorHandler`.
- **Tipo de problema:** Bug de configuración (defaults de la librería no revisados), no de implementación.
- **Severidad:** **Alta.**
- **Nivel de certeza:** Alta — reproducido dos veces.
- **Riesgo:** Escalada a superadmin desde acceso de solo lectura a logs. Sin rotación, sin revocación (D-04) y sin TTL de retención declarado.
- **Causa probable:** `pinoHttp({ logger })` es el snippet canónico de la documentación y funciona perfecto; que el default serialice headers completos no es evidente hasta mirar una línea real. La política de logging del repo se escribió para el `errorHandler` y nunca se extendió al middleware que loguea todo el tráfico.
- **Opciones de solución:**

| Opción | Complejidad | Riesgo | Archivos | Prueba | Rollback | Impacto usuario | Compatibilidad | Mantenimiento |
|---|---|---|---|---|---|---|---|---|
| (1) `redact` en `logger.ts` (cubre pinoHttp + las 98 llamadas a `logger.*`) | Muy baja (~10 líneas) | Bajo | 1 | Test de stream en memoria | Revertir 1 archivo | Ninguno | Total | Un solo lugar |
| (2) `serializers.req` propio con `url.split('?')[0]` | Muy baja | Bajo | 1 | Ídem | Ídem | Ninguno | Total | Precedente ya en el repo |
| (3) Mover `email`/`name` de `GET /api/customers` al body | Media | Medio (cambio de contrato) | 2 repos | Integración + pantallas | Mayor | Ninguno si se hace bien | **Rompe clientes** | Saca la PII definitivamente |

- **Solución recomendada:** (1) y (2) ya — no cambian comportamiento de producto y cierran de paso el connection string de Neon con contraseña de F8-06. (3) es un cambio de contrato y **es decisión del dueño**, no de esta auditoría.
- **Archivos afectados:** `src/logger.ts` (1 y 2); `src/clientes-finanzas/customers.routes.ts` + `appfrontend/src/lib/clientes/api.ts` (3).
- **Pruebas necesarias:** Test que monte `pinoHttp` con el logger real contra un stream en memoria, mande un request con `authorization`, `cookie` y query string, y asere que la línea emitida no contiene ninguno de los tres valores. **Hoy ese test falla.**
- **Posibles efectos secundarios:** Perder información de diagnóstico que hoy alguien usa (mitigable redactando a `[Redacted]` en vez de omitir la clave). La opción (3) rompe cualquier cliente que hoy pase `email`/`name` por query.
- **Plan de rollback:** Revertir `logger.ts`. Los logs vuelven al formato actual de inmediato, sin estado persistido.

---

## D-03 — Un token del portal de clientes alcanza 4 rutas mutantes de staff sin guard de pertenencia

**Basado en:** F5-01 (Fase 5), ampliado por F9-15 (Fase 9) en la dimensión de lectura.

- **Concepto:** Cruce de datos y de efecto financiero entre clientes dentro de un mismo tenant.
- **Ubicaciones:** `src/security/auth.middleware.ts:301` (el gate de `/api` acepta `cookies[AUTH_COOKIE_NAME_CUSTOMER]`), `:327` (saltea membership para CUSTOMER), `:374-376`; `src/security/roles.ts:83-86` (`CUSTOMER_PERMISSION_GROUPS = [CUSTOMER_ONLY, BOOKING]`); rutas sin guard: `src/reservas/reservations.routes.ts:363` y `:676`, `src/pos-menu/orders.routes.ts:200` y `:386`.
- **Problema observado:** Un token con `role: CUSTOMER` satisface `Roles.BOOKING` y alcanza 4 rutas mutantes de routers de staff. Puede crear reservas y órdenes **a nombre de otro cliente del mismo negocio**, agregar ítems a **cualquier** orden del tenant, y disparar un cambio de horario sobre **cualquier** reserva. F9-15 agrega que `POST /api/orders/:id/items` **devuelve la orden resultante**, convirtiendo una ruta de escritura en un lector iterable de órdenes ajenas con sus importes.
- **Evidencia (F5-01/F9-15):** Las 5 piezas de la cadena leídas línea por línea; reproducción ya existente en `src/tests/integration/customer-token-staff-route-ownership.integration.test.ts`; enumeración `grep -rn "authorize(Roles.BOOKING)" src --include="*.routes.ts"` → **11 call-sites** (4 mutantes + 7 GET de catálogo legítimos). La cerca `src/tests/architecture/customer-portal-ownership-guard.test.ts` recorre **únicamente** `customer.routes.ts` y pasa verde hoy con estas 4 rutas sin guard.
- **Comportamiento actual:** Las 4 rutas aceptan la request. El aislamiento entre tenants sigue intacto (`tenantMiddleware` resuelve el pool con el `business_id` del propio token); lo que se cruza es **entre clientes dentro de un tenant**.
- **Comportamiento esperado:** El `CLAUDE.md` de `app-main` declara este hueco **cerrado** ("Hueco 1" del ADR de RBAC, 07-08/09/2026). El cierre se definió por **archivo** (`customer.routes.ts`) y por **grupo** (`CUSTOMER_ONLY`), no por **actor** — y `BOOKING` es el otro grupo que un token CUSTOMER satisface.
- **Tipo de problema:** Bug de implementación (falta el guard) + requisito mal delimitado (el criterio de cierre del ADR).
- **Severidad:** **Alta** (misma en F5-01 y F9-15; F9-15 es el mismo defecto visto desde otro lado, no uno nuevo).
- **Nivel de certeza:** Alta para la cadena de código. `No confirmado`: que una request HTTP real con la cookie del portal obtenga 2xx (puede haber `path`/`SameSite` que lo impida desde el navegador — aunque `:299-301` acepta igual el token por header `Authorization`). Comando de verificación registrado en F5-01.
- **Riesgo:** Cargos y reservas creados a nombre de terceros, que después se facturan y se cobran a ese tercero. Corregirlo después exige contra-asiento manual.
- **Causa probable:** El cierre del Hueco 1 se definió por archivo y grupo en vez de por actor; la cerca de clase heredó ese mismo criterio de archivo.
- **Opciones de solución:**

| Opción | Complejidad | Riesgo | Archivos | Prueba | Rollback | Impacto usuario | Compatibilidad | Mantenimiento |
|---|---|---|---|---|---|---|---|---|
| (a) Rechazar tokens CUSTOMER en routers de staff | Baja | **Medio-alto**: puede romper el portal si alguna pantalla depende de estas 4 rutas | 2-3 | Integración + smoke del portal | Fácil (1 middleware) | Alto si hay dependencia no detectada | Rompe si la hay | Simple y duradero |
| (b) Guard de pertenencia en cada una de las 4 | Media | Bajo | 2 routers | 4 pruebas negativas | Fácil | Nulo | Total | 4 puntos a mantener |
| (c) Partir `BOOKING` en dos grupos (staff / portal) | Alta | Medio (toca catálogo de roles → `ROLES-CATALOG-DRIFT-001` + 3 catálogos del frontend) | Muchos | Alta | Difícil | Requiere re-asignar permisos | Rompe roles existentes | Modelo más limpio |

- **Solución recomendada:** **Requiere decisión del dueño** entre (a), (b) y (c). En los tres casos, el trabajo no opcional es **extender la cerca por ACTOR** —toda ruta alcanzable por `CUSTOMER_PERMISSION_GROUPS`, no solo `customer.routes.ts`—; el molde existe: `ESCAPE_ROUTES` de `credit-note-escape-containment.test.ts`.
- **Archivos afectados:** `src/reservas/reservations.routes.ts`, `src/pos-menu/orders.routes.ts`, `src/security/auth.middleware.ts` o `roles.ts` según la opción, `src/tests/architecture/customer-portal-ownership-guard.test.ts`, `docs/rbac-matriz-endpoints.md`.
- **Pruebas necesarias:** Una prueba negativa de integración por ruta (token de cliente A + recurso de cliente B → 403), del tipo que ya existe para `requireOwnReservation()`. F9-15 agrega criterio de aceptación: **asertar también el BODY de la respuesta**, no solo el status.
- **Posibles efectos secundarios:** Con (a), romper un flujo del portal no inventariado. Con (c), desincronizar los 3 catálogos de roles del frontend (ver `ROLES-CATALOG-DRIFT-001`).
- **Plan de rollback:** (b) es el más reversible: quitar el guard restaura el comportamiento actual sin estado persistido. (c) no es trivialmente reversible una vez re-asignados permisos en `role_permission_groups`.

---

## D-04 — No existe ningún mecanismo de revocación de sesión

**Basado en:** F9-03 (Fase 9).

- **Concepto:** JWT stateless puros sin `jti`, sin versión de token, sin denylist, sin tabla de sesiones.
- **Ubicaciones:** `src/security/auth.middleware.ts` (`authenticate()`), `src/app.ts:319-321` (`resolveMembershipContext`), `src/security/customer.auth.service.ts`, endpoint `/refresh`, `POST /api/password-resets/accept`.
- **Problema observado:** Cuatro casos abiertos: (a) el cambio de contraseña no invalida el token anterior; (b) el borrado/anonimización de cuenta de cliente tampoco; (c) no hay chequeo de existencia/estado del customer en el `authenticate()` del portal; (d) `/refresh` renueva sin tope de vida absoluta. La única revocación real es indirecta y solo para staff (desactivar la membership).
- **Evidencia (F9-03):** Lectura directa de las rutas de autenticación; el docblock del `authenticate()` del portal declara explícitamente que "la revocación de clientes es un caso distinto … y queda fuera de este cambio".
- **Comportamiento actual:** Un token robado (p. ej. desde los logs de D-02, o vía el `localStorage` de F9-06) es válido hasta su `exp` y renovable indefinidamente vía `/refresh`.
- **Comportamiento esperado:** Que un reseteo de contraseña o un borrado de cuenta cierren las sesiones existentes, y que exista un tope de vida absoluta de sesión.
- **Tipo de problema:** Requisito incompleto (el modelo stateless se eligió temprano y el portal se construyó después sin revisar el supuesto), no bug de implementación.
- **Severidad:** **Alta.**
- **Nivel de certeza:** Alta para (a), (c), (d) y para el mecanismo de (b). HIPÓTESIS_A_CONFIRMAR para qué rutas del portal siguen operando con un customer anonimizado.
- **Riesgo:** Multiplica el impacto de D-01, D-02 y F9-06. Es lo que convierte una filtración puntual en acceso persistente.
- **Causa probable:** Modelo stateless elegido temprano; el `refresh` se agregó para resolver un problema real de UX (sesiones de 24h fijas) sin volver sobre el supuesto de revocación.
- **Opciones de solución:**

| Opción | Complejidad | Riesgo | Archivos | Prueba | Rollback | Impacto usuario | Compatibilidad | Mantenimiento |
|---|---|---|---|---|---|---|---|---|
| (A) `token_version` en `identities` y `customers`, embebido en el JWT | Baja (1 columna + 2 comparaciones) | Bajo | ~4 + schema | Fácil | Medio (columna) | Nulo | Tokens viejos sin claim: definir default | Bajo |
| (B) Chequeo de existencia/estado del customer en `authenticate()` del portal | Baja | Bajo | 1 | Fácil | Fácil | +1 query por request del portal | Total | Bajo |
| (C) Vida absoluta (`sid_iat` que `refresh` propaga sin renovar) | Baja | Bajo técnico, **alto de producto** | ~2 | Fácil | Fácil | **Fuerza re-login periódico** | Total | Bajo |

- **Solución recomendada:** (A) cierra (a), (b) y (c) con el menor radio. (C) es ortogonal y complementaria, pero **es decisión de producto**: choca de frente con lo que motivó `/refresh` ("el recepcionista no quiere volver a loguearse en medio del turno").
- **Archivos afectados:** `src/security/auth.middleware.ts`, `auth.service.ts`, `customer.auth.service.ts`, `src/db/schema.sql` + `platform.schema.sql`.
- **Pruebas necesarias:** (a) resetear contraseña → el token anterior recibe 401; (b)/(c) anonimizar → 401 en `GET /me` y en `POST /refresh`; (d) `refresh` deja de renovar pasado el tope. **Los cuatro fallan hoy.**
- **Posibles efectos secundarios:** (A) invalida todas las sesiones vivas al desplegar si el default de la columna no se elige con cuidado. (C) genera re-logins visibles para el usuario.
- **Plan de rollback:** (A): dejar de comparar el claim (una línea) restaura el comportamiento actual sin tocar la columna. (C): quitar el tope.

---

## D-05 — Vínculo a la empresa de otra organización conociendo su UUID, sin consentimiento

**Basado en:** F9-05 (Fase 9).

- **Concepto:** `companyId` funciona como capacidad portadora sin las propiedades que hacen segura a una capacidad (no revocable desde el producto, no caduca, no enumerable).
- **Ubicaciones:** `src/platform/companies.routes.ts:82-99` (handler completo, 18 líneas) y `:46` (`LinkCompanySchema`); `src/platform/company-sync.worker.ts:1-11`; `src/app.ts:329`.
- **Problema observado:** `POST /api/companies/link` toma un `companyId` del body, verifica **únicamente que la empresa exista**, y ejecuta `linkBusinessToCompany(businessId, company.id)`. Sin invitación previa, sin aprobación, sin token, sin notificación a la empresa destino. El vínculo no es inerte: `CompanyCatalogPropagationWorker` propaga productos, precios y recetas de la organización ajena hacia la tenant DB del negocio que se vinculó.
- **Evidencia (F9-05):** El docblock del propio archivo (`:1-11`) razona correctamente sobre la dirección **opuesta** ("ningún MANAGEMENT puede vincular OTRO negocio") y da por resuelto el lado del `companyId` con la frase *"con el `companyId` compartido fuera de banda"* — que describe cómo se espera que se use, **no una restricción que el código imponga**.
- **Comportamiento actual:** Responde 204 y cambia `businesses.company_id`. La víctima no recibe ninguna señal; la única forma de detectarlo es mirar la columna a mano.
- **Comportamiento esperado:** Consentimiento explícito de la empresa destino, vínculo auditado de ambos lados y desvínculo operable.
- **Tipo de problema:** Requisito incorrecto/incompleto (supuesto escrito en un comentario en vez de en un guard).
- **Severidad:** **Alta.**
- **Nivel de certeza:** Alta para el camino de código. HIPÓTESIS_A_CONFIRMAR para explotabilidad práctica: depende de cómo se genere el `companyId` (si es UUIDv4 no se adivina; el vector real es la **filtración** del id, que aparece en `GET /api/companies/me` para cualquier MANAGEMENT del grupo, incluida una sucursal dada de baja).
- **Riesgo:** Divulgación de datos comerciales entre organizaciones distintas por un camino que el aislamiento "una BD por tenant" **no cubre**, porque el cruce lo hace un worker con credenciales de plataforma, no una consulta. Atacante necesita ser MANAGEMENT de un negocio con plan ENTERPRISE.
- **Causa probable:** El diseño de multipropiedad resolvió con cuidado el vector obvio y trató el `companyId` como un dato que solo circula dentro de la organización.
- **Opciones de solución:**

| Opción | Complejidad | Riesgo | Archivos | Prueba | Rollback | Impacto usuario | Compatibilidad | Mantenimiento |
|---|---|---|---|---|---|---|---|---|
| (A) Token de vínculo de un solo uso con vencimiento | Media (el molde existe 2 veces: `invitation-token.ts`, `password-reset-token.ts`) | Bajo | ~4 + schema | Integración | Medio | Preserva el flujo actual | Rompe el link "a mano" | Bajo |
| (B) Solicitud + aprobación en dos pasos | Alta | Bajo | ~6 + schema + pantalla | Integración + UI | Difícil | Cambia el flujo | Rompe el actual | Medio |

- **Solución recomendada:** **Requiere decisión del dueño** — toca el modelo de multipropiedad, no solo el guard. (A) es la de menor radio y no inventa mecanismo nuevo. En cualquiera de las dos: auditar el vínculo del lado de la empresa y proveer desvínculo operable.
- **Archivos afectados:** `src/platform/companies.routes.ts`, `company.repository.ts`, `platform.schema.sql`, y una pantalla si se elige (B).
- **Pruebas necesarias:** Integración con dos negocios de dos empresas distintas: el MANAGEMENT de B llama a `POST /api/companies/link` con el `companyId` de A → 403/404 y `businesses.company_id` de B sin cambiar. **Hoy devuelve 204 y cambia.**
- **Posibles efectos secundarios:** Romper el alta de sucursales de grupos existentes que hoy dependen del flujo "compartir el UUID". Migrar vínculos ya creados exige decidir si se re-validan.
- **Plan de rollback:** Quitar el guard restaura el comportamiento actual; los tokens ya emitidos quedan huérfanos (inofensivo).

---

## D-06 — `DATABASE_URL`: una trampa armada que aplicaría el schema de tenant sobre la BD de plataforma

**Basado en:** F11-02 (Fase 11), con contexto de F7-05 (Fase 7), F9-16 (SSRF de `set-tenant-url`) y F10-01.

- **Concepto:** Endpoint de superadmin vivo que depende de una variable genérica que el propio checklist pre-deploy del repo **prohíbe**.
- **Ubicaciones:** `src/platform/admin.routes.ts:67` (`process.env.DATABASE_URL`), `:70-75` (el 500), `:95-99` (la secuencia de 5 pasos), `:60-63` (comentario obsoleto); `render.yaml` (solo `PLATFORM_DATABASE_URL`, `:57-58`); `docs/INCIDENT_LOG_2026-08-08.md:119`.
- **Problema observado:** `POST /api/admin/repair-tenant-db` aplicaría `src/db/schema.sql` (4302 líneas, schema **de tenant**) contra la base que apunte `DATABASE_URL`, y dejaría un negocio apuntado ahí (`applyTenantSchema` → `encryptConnectionString` → `activateBusiness` → `updateSchemaVersion` → `evictTenantPool`). Hoy responde `500 MISSING_DATABASE_URL`: **está muerto**. El problema es qué pasa cuando alguien lo "arregla" poniendo la única connection string que tiene a mano — la de plataforma.
- **Evidencia (F11-02):** `grep -n DATABASE_URL render.yaml` → solo `PLATFORM_DATABASE_URL`. `INCIDENT_LOG_2026-08-08.md:119`, ítem de checklist activo: *"No existe ninguna variable `DATABASE_URL` genérica sin prefijo en el código o en Render"* — existe, en un handler de superadmin. El comentario `:60-63` todavía describe el mundo mono-base ("la misma DATABASE_URL que ya usa el proceso"): hoy el proceso no usa ninguna.
- **Comportamiento actual:** 500 inerte, con la trampa armada.
- **Comportamiento esperado:** O el endpoint no existe, o la variable es inconfundible y hay una guarda que rechace si coincide con `PLATFORM_DATABASE_URL`.
- **Tipo de problema:** Bug de configuración + código muerto **con radio de daño** (misma clase que F10-05).
- **Severidad:** **Alta.**
- **Nivel de certeza:** Alta para todo lo verificable en el repo. `No confirmado`: si `DATABASE_URL` está seteada hoy en el dashboard de Render. Verificable mirando las variables del servicio, o pegándole al endpoint en un entorno no productivo.
- **Riesgo:** 51 tablas de tenant conviviendo con las 24 de plataforma, creadas dentro de la transacción implícita única de F10-01 sosteniendo `AccessExclusiveLock`; y después todo el tráfico de un tenant escribiendo en la BD central. Reversible en teoría, muy caro en la práctica.
- **Causa probable:** El endpoint es anterior al modelo una-BD-por-negocio y nunca se re-evaluó al migrar. La variable dejó de declararse (correctamente), lo que lo apagó, pero el código quedó esperando que alguien "complete la configuración que falta".
- **Opciones de solución:**

| Opción | Complejidad | Riesgo | Archivos | Prueba | Rollback | Impacto usuario | Compatibilidad | Mantenimiento |
|---|---|---|---|---|---|---|---|---|
| (a) Retirar el endpoint (la ruta hermana `set-tenant-url` ya hace lo mismo con la URL explícita en el body) | Baja | Bajo (hoy está muerto) | 1-2 | Verificar que ningún runbook lo cite | Fácil | Ninguno | Total (devuelve 500 hoy) | Elimina la trampa |
| (b) Renombrar la variable (`REPAIR_FALLBACK_TENANT_DATABASE_URL`) + guarda contra `PLATFORM_DATABASE_URL` + declararla en `render.yaml` | Media | Bajo | 2-3 | Integración | Fácil | Ninguno | Total | Conserva la ergonomía |

- **Solución recomendada:** **Requiere decisión del dueño.** En ambos casos, el ítem del checklist del incident log queda cumplido o explícitamente derogado. Nota: (a) no cierra F9-16 (`set-tenant-url` es SSRF por diseño acotado a SUPERADMIN) — ese es un bloque aparte.
- **Archivos afectados:** `src/platform/admin.routes.ts`, `render.yaml`, `docs/INCIDENT_LOG_2026-08-08.md`.
- **Pruebas necesarias:** Integración: con `DATABASE_URL` = la URL de plataforma, el endpoint rechaza **antes de tocar nada**. Hoy no existe ninguna prueba de ese camino (`admin.routes.test.ts:49` setea una URL legacy y prueba solo el camino feliz).
- **Posibles efectos secundarios:** Con (a), perder una herramienta de recuperación que algún runbook no leído podría citar — verificar antes.
- **Plan de rollback:** `git revert`. Si (a) se ejecutó y hace falta la capacidad, `set-tenant-url` la cubre.

---

# B. Integridad de datos y de dinero

## D-07 — Un script de reparación dentro de `schema.sql` convierte, en un deploy, la tarifa fija de un cliente en un porcentaje

**Basado en:** F10-02 (Fase 10). Clase completa: F10-16 y F10-17.

- **Concepto:** Backfill único escrito dentro de un archivo cuya propiedad declarada es "se reaplica entero en cada deploy".
- **Ubicaciones:** `src/db/schema.sql:834-852` (**re-verificado presente en HEAD `e01e725`**); comentario de intención en `:824-832`; contraste correcto en `:128-133` (backfills v42 gateados por `schema_migrations`).
- **Problema observado:** El bloque no está gateado por versión ni por flag de "ya corrió". Las filas que en agosto de 2026 no se convirtieron porque el precio base era 0 quedaron **pendientes para siempre**. El día que alguien edite el catálogo, el **siguiente deploy** convierte esa tarifa: `fixed_price` → `NULL`, `discount_percentage` toma el valor calculado.
- **Evidencia (F10-02):** **Reproducido** contra PostgreSQL 16.13 con schema v59: estado inicial `fixed_price=800, base_price=0` → deploy 1 sin cambios → `UPDATE resources SET base_price=1000` (operación normal de catálogo) → deploy 2 → `fixed_price=NULL, discount_percentage=20.00`. Solo **2 de las 20** sentencias DML del archivo tienen el guard `schema_migrations`.
- **Comportamiento actual:** Cambia lo que se le cobra a un cliente, sin que nadie lo haya pedido y sin rastro. Tres agravantes: (1) no queda en `audit_log` —es SQL crudo, no pasa por `domain/audit.ts::recordFieldChanges()`— violando R14 de `docs/criterios-datos.md`; (2) cambia la **semántica**, no solo el valor (un precio fijo es inmune a la lista, un 20% la sigue); (3) es **irreversible sin backup** (`fixed_price` se pisa con `NULL` en el mismo UPDATE).
- **Comportamiento esperado:** Un backfill que ya cumplió su función no vuelve a evaluarse; y ninguna escritura de datos de negocio ocurre por un camino paralelo al único camino auditado.
- **Tipo de problema:** Bug de datos (script de migración mal encapsulado), no de implementación de dominio.
- **Severidad:** **Crítica** si existe al menos una fila candidata en producción; **Alta** si no existe hoy (el bloque sigue armado para el día que alguien restaure datos viejos o cree una fila con `created_at` retroactivo).
- **Nivel de certeza:** **Alto** para el mecanismo (reproducido end-to-end). **Medio** para la exposición actual: **no se consultó ninguna base real**.
- **Riesgo:** El precio de un cliente cambia solo, en silencio, en un deploy que nadie asocia con tarifas.
- **Causa probable:** Se diseñó como operación única y se escribió dentro del archivo que se reaplica. El razonamiento correcto ya está escrito en el mismo archivo para los backfills de v42 (*"un UPDATE sin este guard pisaría para siempre cualquier decoupling manual"*) y no se aplicó acá.
- **Opciones de solución:**

| Opción | Complejidad | Riesgo | Archivos | Prueba | Rollback | Impacto usuario | Compatibilidad | Mantenimiento |
|---|---|---|---|---|---|---|---|---|
| (a) Gatearlo con `IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = <n>)` | Baja | Bajo | 1 | Integración | Fácil | Ninguno | Total | Consistente con v42 |
| (b) Retirarlo (cumplió su función el 22/08/2026) | Muy baja | Bajo | 1 | Integración | Fácil | Ninguno | Total | Menos SQL muerto |
| (c) Inventariar los 20 DML, separar los auto-limitantes de los 3 con condición de disparo abierta, y gatear/retirar esos 3 | Media | Bajo | 1 | Integración | Fácil | Ninguno | Total | **Cierra la clase, no la instancia** |

- **Solución recomendada:** **(c)**, que absorbe D-07 (F10-02), F10-16 (`UPDATE invoices SET afip_contacted = FALSE`, severidad Baja, hoy inalcanzable pero de la misma forma) y F10-17 (backfill de `reservation_lines` que fabrica precios aproximados en cada deploy, severidad Baja). **Pero antes hace falta un dato que la auditoría no puede obtener:** cuántas filas candidatas existen en los tenants reales. **Requiere decisión del dueño** sobre qué hacer con las filas que existan — eso es negocio, no técnica.
- **Archivos afectados:** `src/db/schema.sql`.
- **Pruebas necesarias:** (1) La consulta de diagnóstico de solo lectura de F10-02 contra cada tenant, **primero**. (2) Test de integración: sembrar una fila legacy con `base_price = 0`, aplicar el schema, subir `base_price`, reaplicar, y afirmar que `fixed_price` **no** cambió.
- **Posibles efectos secundarios:** Gatear por versión hace que una modificación futura de la definición pase inadvertida — el patrón del repo lo resuelve con nombre nuevo por cambio (ya usado en v56).
- **Plan de rollback:** Quitar el guard restaura el comportamiento actual, sin migración de datos. **Lo que no tiene rollback es una conversión ya ocurrida** — de ahí la urgencia de la consulta de diagnóstico antes que del fix.

---

## D-08 — Cada deploy bloquea `reservations`: 45,9 s medidos de espera para un `SELECT` trivial

**Basado en:** F10-01 (Fase 10).

- **Concepto:** `migrate:tenants` reaplica `schema.sql` entero como una sola transacción implícita, con 28 `ALTER TABLE … ADD CONSTRAINT` sin guard que revalidan tablas completas.
- **Ubicaciones:** `src/platform/tenant-db.setup.ts:547` (`await client.query(schemaSQL)`); `src/db/schema.sql:3635-3640` y `:3836-3843` (los dos `EXCLUDE USING gist`); `:477` a `:4302` (ventana del lock); `render.yaml` `buildCommand`; contraste correcto en `:2272-2287` (patrón `pg_constraint` de v51, aplicado a 11 constraints).
- **Problema observado:** La transacción sostiene `AccessExclusiveLock` sobre `reservations` desde el primer `ALTER` hasta el COMMIT final. Ni lecturas ni escrituras pasan.
- **Evidencia (F10-01, medido no inferido):** PostgreSQL 16.13, tenant con 200 000 reservas y 200 000 `reservation_lines`: apply completo **56 741 / 50 241 / 48 568 ms**; sobre tenant vacío **96 ms**; solo el `DROP+ADD` del `EXCLUDE` **16 468 ms**; `pg_locks` → `AccessExclusiveLock granted=t`; un `SELECT count(*) FROM reservations WHERE status='CONFIRMED'` lanzado 3 s después **esperó 45 855 ms**. Transaccionalidad verificada empíricamente (`CREATE TABLE t_a; CREATE TABLE t_b; SELECT 1/0` → 0 tablas creadas).
- **Comportamiento actual:** Con los 2 tenants actuales (casi vacíos) es invisible. Con un hotel real a 200 k reservas son ~50 s por deploy en los que el motor de disponibilidad, el check-in y el portal del cliente devuelven timeout.
- **Comportamiento esperado:** Reaplicar un schema ya aplicado cuesta un `SELECT` sobre `pg_constraint`, no un rebuild.
- **Tipo de problema:** Deuda técnica de migraciones (patrón correcto ya identificado y no generalizado).
- **Severidad:** **Crítica.**
- **Nivel de certeza:** **Alto** — medido, ningún componente derivado de documentación.
- **Riesgo:** El costo crece monótonamente con el volumen del tenant, se paga **en cada deploy**, y nunca mejora solo. Hoy nadie lo mide.
- **Causa probable:** `DROP+ADD` incondicional era correcto cuando el schema era chico y los tenants estaban vacíos. v51 identificó el problema y lo resolvió para 3 CHECK; el razonamiento quedó escrito pero no se generalizó. Los 2 `EXCLUDE` son el peor caso y ninguno tiene guard, probablemente porque `ADD CONSTRAINT … EXCLUDE` no soporta `IF NOT EXISTS`.
- **Opciones de solución:** Una sola razonable: **extender el guard `pg_constraint` de v51 a las 28 posiciones, empezando por los 2 `EXCLUDE`** (concentran ~16 s de los ~50 s). F10-01 ya respondió las cinco preguntas que el protocolo exige antes de cambiar el esquema: impacto sobre datos **ninguno**; datos existentes **sin tocar**; estrategia de migración **documentada en `schema.sql:2284-2287`** (sacar el guard, dejar correr un `DROP+ADD` real una vez, reponerlo); rollback **quitar el guard, sin migración**; compatibilidad temporal **total**.
- **Solución recomendada:** La anterior. El riesgo inverso —que el guard haga pasar inadvertida una **modificación** de definición— se mitiga con el patrón ya usado en v56: nombre nuevo por cambio de definición.
- **Archivos afectados:** `src/db/schema.sql` (28 bloques).
- **Pruebas necesarias:** Integración contra PostgreSQL real: (1) aplicar el schema sobre una BD con N filas en `reservations`, (2) aplicarlo una segunda vez, (3) afirmar que la segunda corrida tarda menos que un umbral fijo y que `pg_stat_user_tables.n_tup_*` no se movió. **Hoy no existe ninguna prueba que mida el costo de reaplicar el schema.**
- **Posibles efectos secundarios:** Un guard mal escrito puede saltear una constraint que **debía** cambiar → drift silencioso entre tenants. Mitigación: la convención de nombre nuevo, más el test de D-21.
- **Plan de rollback:** Quitar el guard restaura el comportamiento actual. Sin datos migrados, sin estado.

---

## D-09 — La versión de schema que decide si un tenant se migra vive en la BD equivocada

**Basado en:** F10-03 (Fase 10), familia de F8-05 y F7-05.

- **Concepto:** `businesses.schema_version` (BD de plataforma) se usa como **autoridad** cuando la fuente de verdad real es `schema_migrations.version` **dentro** de la tenant DB.
- **Ubicaciones:** `src/scripts/migrate-tenants.ts:58-61` (el `continue`) y `:66`; `src/platform/tenant.middleware.ts:91-97`; `src/platform/platform.repository.ts:597-600`; los 5 pares no atómicos `applyTenantSchema()` + `updateSchemaVersion()` (`admin.routes.ts:95/99` y `:143/147`, `business.routes.ts:177/180`, `platform.routes.ts:401/404`, `migrate-tenants.ts:65/66`).
- **Problema observado:** Si plataforma dice v59 y la tenant DB está realmente en v40, el migrador **salta** el tenant y el middleware **no advierte**: ningún mecanismo del sistema lo nota.
- **Evidencia (F10-03):** Las 3 piezas leídas y coincidentes. El repo ya vivió una variante: `schema.sql:1494-1505` narra que `biz-demo-01` corrió deploys enteros "correctamente" durante semanas sin tener la columna `served_at`, y que el síntoma parecía de refresco de UI.
- **Comportamiento actual:** Un tenant puede quedar permanentemente sin migrar, en silencio. Escenarios que lo producen: restaurar una tenant DB desde un snapshot (operación normal de recuperación) sin tocar plataforma; `set-tenant-url` con el `updateSchemaVersion()` posterior fallando; cualquier corrida donde `applyTenantSchema()` tuvo éxito y el UPDATE no.
- **Comportamiento esperado:** La decisión de migrar se toma contra la fuente de verdad, o al menos la divergencia se detecta y se reporta.
- **Tipo de problema:** Bug de integración (caché usada como autoridad) + atomicidad (el par no es transaccional).
- **Severidad:** **Alta.**
- **Nivel de certeza:** **Alto** para el mecanismo. **No confirmado** si hoy existe algún tenant divergente — verificable con dos consultas de solo lectura, descritas en F10-03.
- **Riesgo:** `served_at` generalizado: el código nuevo emite SQL contra columnas inexistentes, Postgres responde 42703, y `error.middleware.ts` lo convierte en un 500 `INTERNAL_ERROR` genérico porque no es un `DomainError`.
- **Causa probable:** El diseño trata `businesses.schema_version` como caché y la usa como autoridad; la fuente real solo se lee **dentro** de `applyTenantSchema()`, o sea únicamente cuando ya se decidió migrar.
- **Opciones de solución:**

| Opción | Complejidad | Riesgo | Archivos | Prueba | Rollback | Impacto usuario | Compatibilidad | Mantenimiento |
|---|---|---|---|---|---|---|---|---|
| (a) Que `migrate-tenants.ts` **no salte** por la versión de plataforma | Muy baja (borrar el `continue`) | Bajo **si D-08 está resuelta** (~96 ms por tenant al día); alto si no (~50 s × tenant × deploy) | 1 | Integración | Trivial | Ninguno | Total | El más simple |
| (b) Mantener el salto pero validarlo contra `schema_migrations` del tenant | Baja | Bajo | 1 | Integración | Fácil | Ninguno | Total | Requiere conexión igual → elimina el ahorro |

- **Solución recomendada:** (a), **con D-08 resuelta primero** — el orden importa: sin el guard `pg_constraint`, dejar de saltar convierte cada deploy en un apply completo por tenant. Es **decisión de producto** cuál de las dos, porque (a) cambia el perfil de tiempo del deploy.
- **Archivos afectados:** `src/scripts/migrate-tenants.ts`.
- **Pruebas necesarias:** Integración con dos bases: dejar `businesses.schema_version` en el valor actual, revertir la tenant DB a un estado anterior (p. ej. `DROP COLUMN served_at`), correr el migrador y afirmar que **detecta** la divergencia en vez de reportar "ya estaba al día".
- **Posibles efectos secundarios:** (a) alarga el build de cada deploy proporcionalmente a la cantidad de tenants; interactúa directamente con D-08 y con D-21 (un tenant con datos que violen una constraint nueva detiene el deploy de **toda la flota**, F10-11/F13-09).
- **Plan de rollback:** Restaurar el `continue`. Sin estado persistido.

---

## D-10 — La `idempotencyKey` del pago está atada al intento, no al pago

**Basado en:** F8-15 (Fase 8), relacionado con F8-01 (D-11).

- **Concepto:** El mecanismo de idempotencia existe, funciona, y está **mal anclado**: protege el caso que no ocurre y no protege el que sí.
- **Ubicaciones:** `src/clientes-finanzas/customer-account.service.ts:146`, `:203`, `:121-124` (docblock); `src/api/schemas/request.schemas.ts:441`; `src/clientes-finanzas/customers.routes.ts:945`; `appfrontend/src/app/dashboard/cuentas-corrientes/page.tsx:180-204` (`:187` genera la clave **dentro del handler del submit**), `:426`; `appfrontend/src/lib/http.ts`.
- **Problema observado:** El parámetro es opcional y con `undefined` se persiste `null` (dos NULL no colisionan en Postgres, así que el índice único no correlaciona). El único caller real la genera con `crypto.randomUUID()` dentro del handler: **cada envío produce una clave nueva**. Protege contra un reintento automático del mismo request (`lib/http.ts` **no tiene ninguno**) y no protege contra el operador que vuelve a apretar "Registrar pago" tras un 500 o un timeout — que es exactamente el escenario del COMMIT ambiguo de D-11.
- **Evidencia (F8-15):** Las dos puntas leídas; ausencia de retry en `http.ts` verificada por grep. El doble click **concurrente** sí está cubierto, pero por el `disabled={paying || …}` del botón, no por la clave.
- **Comportamiento actual:** Dos filas `PAYMENT` `SETTLED` por un solo pago recibido, con el saldo del cliente sobredeclarado y sin ninguna señal de duplicado — `financial_transactions` no tiene otra clave natural que pueda frenarlo.
- **Comportamiento esperado:** La clave se ancla a la **intención** de pago, no al intento. (Marco ERP: los pagos deben ser idempotentes.)
- **Tipo de problema:** Bug de implementación (frontend) + requisito ambiguo (opcionalidad del campo en un endpoint que mueve dinero).
- **Severidad:** **Alta.** F8-15 lo califica como *"el hueco de idempotencia más caro de los encontrados"*.
- **Nivel de certeza:** Alta.
- **Riesgo:** Duplicación de un hecho financiero; corregirlo después exige contra-asiento manual.
- **Causa probable:** La clave se agregó pensando en el reintento de transporte (el caso que la palabra "idempotencia" evoca) y se generó donde era más cómodo. Que el reintento realista sea **humano** —y que por definición pase por un render nuevo del handler— no se consideró.
- **Opciones de solución:**

| Opción | Complejidad | Riesgo | Archivos | Prueba | Rollback | Impacto usuario | Compatibilidad | Mantenimiento |
|---|---|---|---|---|---|---|---|---|
| (a) Generar la clave al **abrir el formulario**, regenerarla solo si cambian los datos | Muy baja | Bajo | 1 (frontend) | Manual + integración | Trivial | Nulo (mejora) | Total | Bajo |
| (b) Derivarla de `customerId+amount+allocations+día` (molde ya usado por el backend: `invoice:${ftId}`, `hashIds()`) | Baja | Medio: dos pagos legítimamente idénticos el mismo día colisionan | 1-2 | Integración | Fácil | **Puede rechazar un pago real** | Total | Requiere regla de negocio |
| (c) Volver `idempotencyKey` obligatoria en el schema HTTP | Baja | Alto | 1-2 | Integración | Fácil | Nulo si el único cliente se actualiza | **Rompe cualquier cliente que no la mande** | Cierra la clase |

- **Solución recomendada:** (a) ya — es chico y no requiere decisión de negocio. (c) **requiere decisión del dueño** (rompe contrato). (b) tiene un modo de falla propio y no la recomiendo sin regla explícita.
- **Archivos afectados:** `appfrontend/src/app/dashboard/cuentas-corrientes/page.tsx`; opcionalmente `src/api/schemas/request.schemas.ts` y `src/clientes-finanzas/customers.routes.ts`.
- **Pruebas necesarias:** Integración con Postgres real: dos `POST /api/customers/:id/payments` con la **misma** clave → una sola fila (**hoy pasa**). Más prueba manual de la pantalla confirmando que dos envíos consecutivos del mismo formulario mandan la misma clave (**hoy: no**).
- **Posibles efectos secundarios:** Con (a), un operador que quiere registrar **dos** pagos legítimamente idénticos seguidos debe recargar/limpiar el formulario — definir ese reset explícitamente es parte del cambio.
- **Plan de rollback:** Revertir el archivo del frontend. Ninguna fila escrita cambia de forma.

---

## D-11 — `TransactionManager.run()`: COMMIT ambiguo y conexión devuelta al pool en estado abortado

**Basado en:** F8-01 (Fase 8), con C6-06 (Fase 6).

- **Concepto:** El mecanismo del que depende **toda** la atomicidad del backend no declara qué significa una excepción suya.
- **Ubicaciones:** `src/db/pg.transaction-manager.ts:22-43` (`:36` COMMIT, `:39` ROLLBACK sin try propio, `:40` throw, `:42` `conn.release()` sin argumento); `src/db/transaction-manager.ts` (interfaz de 15 líneas, sin cláusula de excepción); **69 call sites en 25 archivos**.
- **Problema observado:** (i) Si el COMMIT falla por corte de conexión, la transacción pudo haberse confirmado del lado del servidor: "no pasó nada" y "pasó todo" son el **mismo evento observable**. (ii) `release()` sin pasar el error devuelve al pool una conexión cuyo ROLLBACK pudo no ejecutarse, contaminando al próximo request que la tome.
- **Evidencia (F8-01):** 43 líneas leídas completas; `grep -rn "transactionManager\.run" src | grep -v test | wc -l` → 69. **Callers protegidos por clave natural:** `invoice.service.ts:530` (`invoice:${ftId}`), `outbox.handlers.ts:213,227,536`, `createOrderChargeIfConfirmed`. **Callers SIN clave natural:** `customer-account.service.ts:203` (ver D-10) y `sql.cash-register-shift.repository.ts:86-110`.
- **Comportamiento actual:** Para los callers con clave natural el COMMIT ambiguo se auto-cura en el reintento — **es la razón por la que esto no explotó todavía**. Para los que no la tienen, el reintento duplica un hecho financiero. La contaminación del pool, si ocurre, produce un `25P02` en un request **ajeno** al que causó el problema.
- **Comportamiento esperado:** El contrato declara que un error **después** del COMMIT no garantiza que no se haya escrito, y por eso todo caller que escriba dinero necesita clave natural; y una conexión en estado dudoso se descarta en vez de reusarse.
- **Tipo de problema:** Deuda técnica de contrato + bug latente de ciclo de vida de recurso.
- **Severidad:** **Alta.** No hay bug activo confirmado; el mecanismo afectado es el que sostiene toda la integridad transaccional.
- **Nivel de certeza:** Alta para el código y para el razonamiento del COMMIT ambiguo. HIPÓTESIS_A_CONFIRMAR para el `25P02` en un request posterior (depende de que `pg` no marque la conexión como no reusable por sí solo).
- **Riesgo:** Radio = los 69 call sites. Diagnóstico caro: el síntoma aparece lejos de la causa.
- **Causa probable:** `run()` se extrajo para resolver acoplamiento y cumplió **ese** objetivo; el ciclo de vida de la conexión ante error nunca se escribió porque había un solo implementador. `conn.release(err)` es un detalle de la API de node-postgres que solo importa en el camino de excepción.
- **Opciones de solución:** Tres, **independientes y todas sin decisión de negocio**: (1) envolver el ROLLBACK en su propio try/catch que loguee y re-lance el error **original** (ya pedido por C6-06, sigue vigente); (2) pasar el error a `release(err)` en el camino de excepción; (3) declarar en la interfaz qué significa una excepción de `run()`.
- **Solución recomendada:** Las tres. (1) y (2) son ~6 líneas en un archivo; (3) es documentación de contrato y es la que habilita auditar los callers sin clave natural (D-10).
- **Archivos afectados:** `src/db/pg.transaction-manager.ts`, `src/db/transaction-manager.ts`.
- **Pruebas necesarias:** Integración con Postgres real: (a) hacer fallar `work` y matar la conexión con `pg_terminate_backend` desde una segunda sesión, aserando que el error que sale de `run()` es el de `work`; (b) tras ese fallo, tomar N conexiones del mismo pool y aserar que ninguna devuelve `25P02`.
- **Posibles efectos secundarios:** (1) cambia **qué error ve el caller** en el camino de fallo (hoy puede estar enmascarado) — algunos `catch` que matchean por mensaje podrían dejar de matchear. Auditar los 69 call sites por ese patrón antes de aplicar.
- **Plan de rollback:** Revertir un archivo. Sin estado persistido.

---

## D-12 — Un crash entre el claim y el fin del handler saltea un efecto financiero en silencio

**Basado en:** F8-07 (Fase 8).

- **Concepto:** El outbox protege contra **duplicar** y no contra **saltear**; el sweep que cerraría el hueco está diseñado y no implementado.
- **Ubicaciones:** `src/workers/outbox.worker.ts:482-518` (`runHandler`: `:491` claim, `:501` handler, `:504` release **solo en el catch**), `:492-498` (el skip, a nivel `debug`), `:430-431`, `:166-174` (el sweep, declarado "todavía en HOLD"); `src/repositories/processed-event.repository.ts:57-73` (el claim es un INSERT autocommiteado, **fuera** de la transacción del handler); `src/logger.ts:25` (`level: 'info'`); `src/app.ts:585-588` (`setTimeout(…, 10_000)` → `process.exit(1)`).
- **Problema observado:** Un crash en la ventana entre claim y fin del handler (SIGKILL de Render tras el timeout de cierre forzado, OOM, excepción no capturada) no pasa por el `catch`: el casillero queda tomado sin que el efecto haya ocurrido. Al reiniciar, `claim()` devuelve `false`, el handler se **saltea con un `logger.debug`** y el evento se marca despachado.
- **Evidencia (F8-07):** Las tres piezas leídas; el claim es demostrablemente autocommiteado. El propio repo ya nombró la variante contigua en `:505-515` y el sweep en `:166-174`.
- **Comportamiento actual:** Un CHARGE que nunca se crea, sin dead-letter, sin `warn`, y sin línea visible en producción (`LOG_LEVEL` default = `info`).
- **Comportamiento esperado:** Ningún efecto financiero desaparece sin rastro; todo evento tiene consumidor y toda no-ejecución es diagnosticable.
- **Tipo de problema:** Bug de diseño de concurrencia con trade-off conocido (deuda técnica con diseño escrito).
- **Severidad:** **Alta.** F8-07: *"el peor modo de falla posible para un outbox, y el único que el resto del diseño (backoff, tope, dead-letter, mail, banner) no cubre"*.
- **Nivel de certeza:** Alta para el mecanismo. HIPÓTESIS_A_CONFIRMAR para la frecuencia real en producción.
- **Riesgo:** Pérdida silenciosa de dinero. Nota importante: **el OOM de D-17 es un productor plausible de este crash**, y el cierre forzado de 10 s ocurre en un deploy normal.
- **Causa probable:** Reclamar antes de correr es la decisión **correcta** para el problema que el claim resuelve (dos polls solapados). El costo —que un claim sobrevive a la muerte del proceso mientras el trabajo no— es inherente a esa elección y solo se cierra con un sweep.
- **Opciones de solución:**

| Opción | Complejidad | Riesgo | Archivos | Prueba | Rollback | Impacto usuario | Compatibilidad | Mantenimiento |
|---|---|---|---|---|---|---|---|---|
| (a) Subir el skip a `info`/`warn` cuando `retry_count > 0` | Muy baja | Muy bajo | 1 | Fácil | Trivial | Ninguno | Total | **Mitigante, no fix**: hace el caso visible |
| (b) Sweep de casilleros reclamados sin efecto correspondiente | Alta | Medio (debe distinguir "sin efecto" de "efecto legítimamente nulo") | Varios | Integración compleja | Medio | Ninguno | Total | Es **la** solución real; hoy en HOLD |
| (c) Reclamar **dentro** de la transacción del handler | Media | Bajo para handlers transaccionales | 2-3 | Integración | Medio | Ninguno | Total | Cierra por construcción, **no aplica al handler de mail** (que es el que motivó la tabla) |

- **Solución recomendada:** (a) ya, hoy, como mitigante de visibilidad. (b) es la solución real y **está en HOLD por matriz de impacto incompleta → requiere decisión del dueño**. (c) es un complemento parcial, no un sustituto.
- **Archivos afectados:** `src/workers/outbox.worker.ts`, `src/repositories/processed-event.repository.ts`.
- **Pruebas necesarias:** Integración con Postgres real: claim manual de `(event_id, 'financial:reservation.confirmed')`, correr un ciclo de poll y aserar que (a) no se creó el CHARGE y (b) el evento quedó con `dispatched_at` no nulo. **Eso fija el comportamiento actual como característica antes de cambiarlo** — hacerlo primero.
- **Posibles efectos secundarios:** (a) puede generar ruido en el log si el caso benigno (otro handler que falló) es frecuente — por eso el gate de `retry_count > 0`. (b) mal calibrado puede **re-ejecutar** un efecto que sí ocurrió → duplicación, el modo de falla opuesto.
- **Plan de rollback:** (a): revertir una línea. (b): desactivar el sweep por flag antes de revertir código.

---

# C. Arquitectura y configuración

## D-13 — El build de producción depende de que `NODE_ENV=production` NO llegue al `npm install`

**Basado en:** F11-01 (Fase 11), reproducido end-to-end en el gate.

- **Concepto:** Propiedad crítica del pipeline que nadie eligió, nadie escribió y nada verifica.
- **Ubicaciones:** `render.yaml:33` (`buildCommand`), `:37-38` (`NODE_ENV: production`); `package.json:8` (`postinstall: patch-package`), `:16` (`migrate:tenants` → `tsx`), `:42-44` (`patch-package`, `pino-pretty`, `tsx` en dev), `:61` (`typescript` anómalamente en `dependencies`); `src/logger.ts:25-31`.
- **Problema observado:** npm **omite y además borra** las devDependencies cuando `NODE_ENV=production`. De los 4 pasos del `buildCommand`, **dos dependen de una devDependency**: el `postinstall` (`patch-package`) y `migrate:tenants` (`tsx`). El build actual **solo funciona si el shell del build no ve la variable que el propio `render.yaml` declara**. Espejo en la dirección opuesta: `logger.ts` carga `pino-pretty` (devDependency) siempre que `NODE_ENV !== 'production'`, y pino **lanza sincrónicamente** si no puede resolver el target → un entorno con `NODE_ENV` sin definir y `node_modules` sin dev **no arranca**.
- **Evidencia (F11-01, medido):** `NODE_ENV=production npm config get omit` → `dev`. Proyecto mínimo en scratchpad: `npm install` normal seguido de `NODE_ENV=production npm install` → npm reporta `up to date` y `node_modules/semver` **desaparece** (el caché de `node_modules` de `render.yaml:23-24` **no protege**). `pino({transport:{target:'inexistente'}})` en Node 22.22.2 → lanza síncrono. `git log -p -- package.json` → `df47067` (23/06/2026, *"Fix Render deploy: compile TypeScript before start"*) movió `typescript` a `dependencies`: **es el fósil de este mismo problema**.
- **Comportamiento actual:** Funciona, por una propiedad no declarada del entorno de build de Render.
- **Comportamiento esperado:** El build declara sus dependencias reales; ningún paso depende de que una variable declarada no se propague.
- **Tipo de problema:** Bug de configuración / entorno, acumulado históricamente.
- **Severidad:** **Alta** (deploy trabado, diagnóstico caro, supuesto no declarado bajo tres pasos del pipeline).
- **Nivel de certeza:** **Alta** para las tres mediciones y la composición del `buildCommand`. **`No confirmado`** cuál de las dos ramas es la verdadera hoy en Render. `Información faltante:` la salida real de `npm install` del último deploy (`added 738 packages` vs. ~308). `Cómo verificarlo:` abrir el log del último deploy en el dashboard — lectura pura.
- **Riesgo:** Si el shell del build pasa a ver la variable (cambio de Render, mover el paso a `preDeployCommand` al pasar a plan pago —algo que `render.yaml:8-16` ya contempla—, o declararla en un "build environment"), el `npm install` falla con `patch-package: not found` antes de llegar a `tsc`. Por el fail-loud de `render.yaml:18-21` el deploy no se promueve: es un **deploy trabado**, no una caída. El costo es de diagnóstico: el síntoma no se parece a la causa.
- **Causa probable:** `NODE_ENV=production` se declaró para el runtime sin considerar que npm lo lee como flag de instalación; `typescript` se movió a `dependencies` para resolver el síntoma en su forma de junio, y nadie miró la clase completa cuando el build cambió de forma dos veces más.
- **Opciones de solución:**

| Opción | Complejidad | Riesgo | Archivos | Prueba | Rollback | Impacto usuario | Compatibilidad | Mantenimiento |
|---|---|---|---|---|---|---|---|---|
| (a) `npm install --include=dev` en el `buildCommand` | Muy baja | Muy bajo: **correcto en las dos ramas**, no cambia nada si la actual es la benigna | 1 | Un deploy | Trivial | Ninguno | Total | Hace el supuesto explícito |
| (b) Mover `patch-package` y `tsx` a `dependencies` | Baja | Bajo | 1 | Un deploy | Fácil | Ninguno | Total | Honesto: **son** dependencias de este pipeline |
| (c) Correr `migrate:tenants` compilado desde `dist/` | Media | Medio (cambia el orden del build) | 2 | Un deploy | Medio | Ninguno | Total | Menos superficie en runtime |

- **Solución recomendada:** **Requiere decisión del dueño.** (a) es la de menor riesgo y sirve como red mientras se decide. En cualquiera de las tres, `typescript` debería volver a `devDependencies` (F11-15: 23 MB al runtime sin consumidor) **pero no antes** de resolver esto: hoy es lo único que sostiene el `tsc` del build si la rama mala resulta ser la verdadera.
- **Archivos afectados:** `render.yaml`, `package.json`.
- **Pruebas necesarias:** Un deploy de prueba que imprima `npm ls tsx patch-package --depth=0` inmediatamente después del `npm install`, antes de cualquier otro paso.
- **Posibles efectos secundarios:** (b) aumenta el tamaño de `node_modules` en runtime. Cualquiera de las tres interactúa con F11-13 (los 6 jobs del CI usan `npm install`, no `npm ci`: el lockfile no es contrato en ningún punto del pipeline del backend).
- **Plan de rollback:** Revertir `render.yaml`/`package.json` y redeployar. El deploy anterior sigue sirviendo mientras tanto (fail-loud).

---

## D-14 — La saga de aprovisionamiento de tenant vive cuatro veces, con políticas de fallo distintas

**Basado en:** F7-05 (Fase 7), con F8-05 (Fase 8) y F10-03 (D-09).

- **Concepto:** Secuencia irreversible (API externa → DDL contra una BD nueva → cifrado → 2 escrituras) escrita a mano cuatro veces en tres archivos de rutas.
- **Ubicaciones:** `src/platform/business.routes.ts:176-184` (alta pública, **fail-open declarado**: el catch loguea, el negocio queda `PENDING`, el registro devuelve 201); `src/platform/platform.routes.ts:399-404` (reintento de superadmin, propaga con `next(err)` → 500); `src/platform/admin.routes.ts:95-99` y `:143-147`; más `src/scripts/migrate-tenants.ts`.
- **Problema observado:** La secuencia no existe como unidad en ningún lado. Las copias difieren en **contenido** (algunas hacen `evictTenantPool`, otras no) y en **política de fallo**. `platform.routes.ts:385-386` incluso lo dice: *"Misma secuencia que business.routes.ts"*.
- **Evidencia (F7-05):** Los cuatro handlers y el script leídos completos; las divergencias verificadas línea por línea; la afirmación falsa del docblock de `server.ts:14` verificada buscando **todos** los call-sites de `applyTenantSchema` (4 en rutas + 1 en script, **0 en middleware**).
- **Comportamiento actual:** Simultáneamente el peor caso de "lógica de negocio en el controlador", de "servicio externo mezclado con reglas internas" y de "acción irreversible sin gate" del repositorio. F8-05: deja **cuatro estados intermedios, tres invisibles**, y `repair-tenant-db` **no es su compensación**.
- **Comportamiento esperado:** Una unidad con contrato explícito de qué pasa en cada punto de fallo y cuál es el estado resultante.
- **Tipo de problema:** Deuda técnica de arquitectura (duplicación semántica con divergencia de política).
- **Severidad:** **Alta.**
- **Nivel de certeza:** Alta.
- **Riesgo:** El camino corre **DDL contra bases de datos de producción**. Es el caso testigo del criterio `irreversible-action-gate` que el propio repo declara.
- **Causa probable:** Cada handler se escribió cuando hizo falta, copiando el anterior; nunca hubo un dueño de la secuencia.
- **Opciones de solución:** Extraer `platform/tenant-provisioning.service.ts` con un método `provisionAndActivate(businessId, source, connectionString?)` que contenga los 5 pasos, reciba el `TenantProvisioner` de F7-04(c) como dependencia inyectada, y declare su contrato de fallo — incluido `evictTenantPool`, que pasa a ser parte de la secuencia y no de dos de sus copias. Los 4 handlers quedan en 3 líneas y siguen eligiendo su política de respuesta, que es **lo único que legítimamente difiere**.
- **Solución recomendada:** La anterior, **con orden estricto**: (1) primero la característica de regresión (ver Pruebas); (2) no se toca antes de F7-04(c); (3) no se toca sin backup durable. Aparte e independiente, hoy: corregir el docblock de `server.ts:14`.
- **Archivos afectados:** `src/platform/business.routes.ts`, `platform.routes.ts`, `admin.routes.ts`, `tenant-db.setup.ts`, `server.ts`, + archivo nuevo.
- **Pruebas necesarias:** **Una característica de regresión ANTES de extraer**: un test de integración por cada uno de los 4 caminos que asere el estado final (`businesses.status`, `db_url_encrypted` presente, `schema_version`, pool evictado o no). Hoy las 4 copias **no tienen ese test en común**, así que la extracción sería a ciegas. La prueba de que la extracción no cambió nada es que los 4 tests pasen **sin modificarse**.
- **Posibles efectos secundarios:** Unificar la política de fallo sin querer (el fail-open del alta pública **es deliberado** y debe preservarse). D-09 y F8-05 se tocan en el mismo código: coordinar.
- **Plan de rollback:** `git revert` de la extracción; los 4 handlers vuelven a sus copias. **No hay rollback para una base aprovisionada a medias** — de ahí el backup durable previo.

---

## D-15 — La configuración no tiene capa: 30 variables en 26 archivos, 11 sin declarar

**Basado en:** F7-06 (Fase 7), con F11-10, F11-11, F11-22, F9-10.

- **Concepto:** No existe ningún lugar donde la pregunta "¿cuál es la configuración de este sistema?" pueda siquiera formularse.
- **Ubicaciones:** `src/config/` (ya no contiene configuración, solo `interface PlanLimits`); 30 nombres de env leídos desde 26 archivos en **dos estilos** (`process.env.X` y `process.env['X']`) que **ningún grep encuentra a la vez**; `render.yaml` declara 16 claves.
- **Problema observado:** Tres estratos sin relación: env leídas en el punto de uso, constantes literales en archivos de dominio y transporte, y un manifiesto de deploy que declara poco más de la mitad de lo que el código lee. **11 variables en el código y no en `render.yaml`** (`JWT_EXPIRES_IN`, `LOG_LEVEL`, `MAX_TENANT_POOLS`, `DB_POOL_MAX`, `DB_POOL_IDLE_MS`, `DB_ENCRYPTION_KEY_OLD`, `PORT`, `DATABASE_URL`, `BUSINESS_ID`, `HEALTH_DB_TTL_MS`, `HEALTH_DB_FAIL_TTL_MS`). El backend **no tiene `.env.example`**; el frontend sí.
- **Evidencia (F7-06), el caso más concreto:** el TTL del token de sesión de staff se resuelve de **cinco formas** (`auth.service.ts:98`, `customer.auth.service.ts:66`, `customer.routes.ts:646` dentro de un handler, `auth.middleware.ts:112` con default `86_400`, y `business.routes.ts:189` **hardcodeado**). Consecuencia medible: con `JWT_EXPIRES_IN=1h`, los logins duran 1 hora y el token que recibe un dueño al registrar su negocio dura **24**. Nada relaciona los dos sitios. Además `DEFAULT_SENDER_NAME = 'ZuluHub'` declarado **tres veces**, una de ellas exportada desde un `*.routes.ts`.
- **Comportamiento actual:** Un knob configurado surte efecto en algunos caminos y no en otros, en silencio.
- **Comportamiento esperado:** La configuración se lee una vez, al arrancar, en un lugar (Regla 4 de la arquitectura objetivo mínima de F7 §5.5 — la única de las cinco **sin referencia interna**: hay que construirla).
- **Tipo de problema:** Deuda técnica de arquitectura + bug de configuración (los 11 sin declarar).
- **Severidad:** Alta como clase; los sub-ítems van de Alta (D-06, que es una instancia) a Baja. F9-10 (`sslConfig()` cae a `ssl:false` **en silencio** si falta `NEON_SSL`, tras que `stripSslMode()` ya borró el `sslmode` de la URL) es el sub-ítem de seguridad y el `CLAUDE.md` ya lo declara deuda, no decisión.
- **Nivel de certeza:** Alta (conteos reproducibles).
- **Riesgo:** Cada variable no declarada es un D-06 potencial. F11-11: `DB_ENCRYPTION_KEY_OLD` es requisito de un runbook de rotación y `render.yaml` no la menciona **ni como comentario** — o sea que el runbook de rotación de la clave que cifra los connection strings **no es ejecutable tal como está escrito**.
- **Causa probable:** `PLAN_LIMITS` ya resolvió esta clase moviéndose a la BD de plataforma (18/08/2026) y vació `src/config/`; nadie reconstruyó la capa para lo que quedó.
- **Opciones de solución:** F7-06 propone un orden concreto: (0) **congelar el 30 actual con una cerca de conteo** antes de mover nada; (1) `src/config/env.ts` único; (2) tres bloques chicos e independientes: mover `PASSWORD_RESET_EXPIRES_HOURS` y literales de política; dejar **una** declaración de `DEFAULT_SENDER_NAME`; hacer que `business.routes.ts:189` use el TTL configurado.
- **Solución recomendada:** Ese orden. Los tres bloques chicos **no requieren decisión del dueño**, salvo el tercero, que es el único con cambio de comportamiento observable (el token del alta pública pasa a respetar `JWT_EXPIRES_IN`) — chico, pero es un cambio. **Sí requiere decisión del dueño**, uno por uno, convertir un literal en configuración **por tenant** (`OUTBOX_RETENTION_DAYS`, el tope de paginación, `PASSWORD_RESET_EXPIRES_HOURS`): misma clase que `PLAN_LIMITS` ya resolvió.
- **Archivos afectados:** 26 archivos que leen `process.env`, `render.yaml`, + `src/config/env.ts` nuevo + un `.env.example` (F11-10: hoy el backend **no se puede levantar desde el repo**).
- **Pruebas necesarias:** Una cerca de conteo del tipo que el repo ya usa diez veces: `process.env` (en los **dos** estilos) fuera de `src/config/env.ts` tiene que ser 0, con allowlist y motivo (`instrument.ts` antes del boot, `scripts/`).
- **Posibles efectos secundarios:** Centralizar cambia el momento de lectura (boot vs. punto de uso): cualquier variable que hoy se lea tarde y se setee en runtime dejaría de funcionar. Auditar antes.
- **Plan de rollback:** Bloque por bloque, cada uno reversible por separado — de ahí la insistencia en no hacerlo de una sola vez.

---

## D-16 — Cuatro formas de error 400 contra un solo parser: el usuario ve "Error inesperado"

**Basado en:** F5-04 (Fase 5), con C6-03 (Fase 6) y Fase 4.

- **Concepto:** El frontend implementa fielmente el contrato **declarado**; el backend emite cuatro formas **reales**, y dos de ellas no se pueden parsear.
- **Ubicaciones:** `appfrontend/src/lib/http.ts:13` (declara **una** forma), `:79-84` (construcción del error, el default `'Error inesperado'` **sobrevive al spread**), `:149-164` y `:166-175` (los dos únicos parsers). Forma A: `reservations.routes.ts:308`, `orders.routes.ts:193`, `cash-register.routes.ts:86` (≥14 archivos según Fase 4). Forma B: helper `validationError()` **duplicado literalmente** en `orders.routes.ts:143-145` y `cash-register.routes.ts:57-59`. Forma C: `err.flatten()` con `'Datos inválidos'`, 8 ocurrencias en `usuarios-roles/`. Forma D (central, correcta): `error.middleware.ts:34-40`.
- **Problema observado:** Para las Formas A y B el body no trae `message`; `extractErrorMessage` cae al default y devuelve **`'Error inesperado'`**, y `extractFieldErrors` devuelve `{}`. El backend manda mensajes de validación precisos y por campo, viajan completos en el payload HTTP, y el usuario ve el literal "Error inesperado".
- **Evidencia (F5-04):** Cadena de evaluación determinista, leída completa. Contraste en vivo: `POST /api/reservations` usa la Forma D y su formulario pinta errores por campo; `POST /api/orders` usa la Forma B y su formulario muestra el literal. Precedente registrado por el propio repo: `appfrontend/src/app/dashboard/ordenes/page.tsx:179-180` — *"ORDER-11: sin `unitPrice`. El backend lo rechaza para PRODUCT desde el 22/08 **y por eso el alta fallaba siempre**"*.
- **Comportamiento actual:** Un error de validación en cualquier pantalla servida por Formas A o B es, para el usuario, **indistinguible de una falla interna**.
- **Comportamiento esperado:** Una sola forma de error 400, la que `error.middleware.ts` declara ser la fuente de verdad.
- **Tipo de problema:** Bug de integración entre repos (contrato declarado ≠ contrato real).
- **Severidad:** **Alta** — en un ERP la validación es la principal interacción de alta/edición.
- **Nivel de certeza:** Alta para ambos lados.
- **Riesgo:** Altas que fallan sistemáticamente sin que el usuario pueda saber por qué (ya ocurrió con ORDER-11).
- **Causa probable:** Cada handler repitió el patrón que tenía a mano; no hay cerca que lo detecte. El frontend se escribió contra el contrato *declarado*, no contra el conjunto de respuestas reales.
- **Opciones de solución:**

| Opción | Complejidad | Riesgo | Archivos | Prueba | Rollback | Impacto usuario | Compatibilidad | Mantenimiento |
|---|---|---|---|---|---|---|---|---|
| (a) Retirar los `catch (ZodError)` locales y delegar con `next(err)` | Media (~20 call-sites, mecánico) | Bajo | ~20 backend, 0 frontend | Tests de ruta existentes | Fácil | **Arregla el síntoma** | Cambia el body de error de esas rutas | Una sola forma |
| (b) Parser tolerante de las 4 formas en el frontend | Baja | Bajo | 1 frontend | Media | Fácil | Arregla el síntoma | Total | **Congela la divergencia**, multiplica tests |
| (c) Cerca de arquitectura: fallar la suite si un `*.routes.ts` serializa un `ZodError` sin pasar por el handler central | Media | Bajo | 1 test | La propia suite | Fácil | Ninguno directo | Total | Evita la regresión |

- **Solución recomendada:** (a) + (c). (a) no toca el frontend y es verificable con los tests de ruta existentes; (c) es el molde que el repo ya sabe sostener (allowlist con motivo, como `PUBLIC_ROUTES`). (b) es más barata de aplicar pero perpetúa el problema.
- **Archivos afectados:** ~20 `*.routes.ts` del backend, `src/tests/architecture/` (nuevo).
- **Pruebas necesarias:** Un test por forma que dispare un 400 real desde cada ruta representativa y asere que `extractFieldErrors(err)` devuelve al menos una clave. **Hoy fallaría para `POST /api/orders` y pasaría para `POST /api/reservations`.**
- **Posibles efectos secundarios:** (a) cambia el body de error de ~20 rutas: cualquier consumidor externo que dependa de las Formas A/B rompe (ver D-23 sobre la imposibilidad actual de descartar consumidores externos).
- **Plan de rollback:** Por ruta — el cambio es granular y cada `catch` retirado se puede reponer solo.

---

# D. Rendimiento y escalabilidad

## D-17 — N+1 en toda lectura de reservas: 401 queries para una página de 200

**Basado en:** F12-01 (Fase 12), con F12-02 y F12-03.

- **Concepto:** Deuda técnica **con gatillo de revisión ya disparado** — el propio código declaró la condición y la condición se cumplió.
- **Ubicaciones:** `src/reservas/sql.reservation.repository.ts:509` (`resourceRepository.getById`), `:515` (`getLines()`), `:565-573`, `:559-564` (el comentario que lo acepta), y los 9 call sites de `Promise.all(rows.map(rowToReservation))`: `:262,270,278,286,298,308,347,459`.
- **Problema observado:** Costo `1 + 2N` en round-trips para cualquier lectura de reservas, incluida la lista principal del panel, el portal público de disponibilidad (la ruta sin auth de F9-09) y el chequeo de conflictos **dentro de la transacción de reserva** (F12-03: la sección crítica sostiene su `FOR UPDATE` durante **21 round-trips**, no 1).
- **Evidencia (F12-01, medido con el código real contra PostgreSQL 16 y 5020 reservas):** `getFiltered({})` con el default de 50 ejecuta **101 queries**; con el tope de 200, **401**. A RTT 15 ms contra Neon la página de 200 tarda **1239 ms**; armada en 3 round-trips, **54 ms**. F12-02: un solo listado **satura el pool de 5 conexiones** del tenant y una query trivial pasa de 15 ms a 600 ms.
- **Comportamiento actual:** La pantalla más usada del panel consume 101 conexiones-turno por apertura.
- **Comportamiento esperado:** El patrón **ya existe en este repo**: `src/pos-menu/sql.order.repository.ts:151-166` resuelve el mismo problema (cabecera + hijos) con dos queries y un `IN (…)`, agrupando en memoria.
- **Tipo de problema:** Deuda técnica, **no** bug de implementación — decisión deliberada y documentada tomada cuando el volumen era otro.
- **Severidad:** **Alta.**
- **Nivel de certeza:** **Problema actual**, no potencial. Medido. Lo único modelado es el RTT; a RTT 0 el sobrecosto sigue siendo 8×.
- **Riesgo:** El costo crece con el **tamaño de página**, no con el de la base: **ya está en su peor forma hoy**, no explota con el tiempo. Interactúa con D-18 (el pool saturado es el mismo recurso que los workers).
- **Causa probable:** El comentario `:559-564` la declara con su condición de revisión: *"si en algún momento esto pesa"*. 401 round-trips por request **es** el peso.
- **Opciones de solución:** Una sola razonable: aplicar en `getFiltered()`/`getActiveInRange()` el patrón de `sql.order.repository.ts:151-166` — una query de filas, una de `resources WHERE id = ANY($1)`, una de `reservation_lines WHERE reservation_id = ANY($1)`, armado en memoria. **No** hace falta JOIN con agregación ni vista materializada: la versión de 3 queries ya da el 23× medido.
- **Solución recomendada:** La anterior. No cambia el contrato de `Reservation.restore()` ni el de ninguna ruta.
- **Archivos afectados:** `src/reservas/sql.reservation.repository.ts` únicamente. Sin tocar entidades, rutas ni schema.
- **Pruebas necesarias:** Reproducir M1/M2 antes y después con un `SqlClient` que cuente queries. **Criterio de aceptación: el contador baja de 401 a ≤4 para 200 filas, y los tests existentes de `sql.reservation.repository.test.ts` siguen verdes sin cambios de aserción.**
- **Posibles efectos secundarios:** Cambia el **orden** de resolución de recursos y líneas; si algún test asume secuencialidad, romperá. El armado en memoria sube el uso de RAM por request (marginal frente a D-19).
- **Plan de rollback:** Revertir un archivo. Sin estado persistido, sin cambio de contrato.
- **Nota de bloqueo:** **D-20 debe resolverse primero** — hoy los tests de integración de reservas están rojos y no podrían validar este cambio.

---

## D-18 — Dos de los tres workers siguen en `setInterval` fijo por tenant (incidente real ya ocurrido)

**Basado en:** F12-04 (Fase 12). **En HOLD esperando decisión del dueño.**

- **Concepto:** Corrección diseñada, gateada y **entregada a un tercio**: el helper existe y solo lo usa el worker menos crítico.
- **Ubicaciones:** `src/workers/outbox.worker.ts:304` (`setInterval`, 5 s) y `:205`; `src/workers/reservation-hold-expiry.worker.ts:59` y `:54` (60 s); `src/workers/outbox.registry.ts:140`, `:10-18` (docblock), `:180-192` (`stopTenantWorker`); `src/platform/tenant.middleware.ts:112-115`, `:167-185`; `src/workers/adaptive-poller.ts`; `docs/diseno-polling-adaptativo-neon-2026-09-10.md`.
- **Problema observado:** Los dos workers arrancan **uno por tenant** en la primera request de ese negocio y **no se detienen nunca por inactividad** — solo por desalojo LRU, error del pool, o apagado del proceso. **No hay TTL de inactividad.** Con N tenants tocados desde el arranque: `N × 17 280` polls de outbox por día más `N × 1440` de holds, indefinidamente, aunque no haya un solo usuario conectado.
- **Evidencia (F12-04):** `grep -rn "AdaptivePoller" src --exclude="*.test.ts"` → **un solo consumidor de producción** (`company-sync.worker.ts:60`). **El incidente ya ocurrió y está documentado en el repo:** `docs/diseno-polling-adaptativo-neon-2026-09-10.md:9-16` — *"pollean más seguido que la ventana fija de 5 minutos del scale-to-zero de Neon (free plan)… **Esto agotó el cupo de compute del plan free el 2026-09-10**"*. El mismo documento (`:445-451`) declara la coexistencia como *"transitoria, no permanente"*. **Han pasado 6 días.**
- **Comportamiento actual:** Cada tenant tocado una vez mantiene su base despierta **para siempre**. El síntoma visible desapareció (billing activado); la causa no.
- **Comportamiento esperado:** Un tenant sin actividad llega a ≥5 min continuos sin ninguna query (condición del scale-to-zero).
- **Tipo de problema:** Deuda técnica **con dueño y diseño ya escritos**, más una **decisión de negocio pendiente** (la dirección del bus de `wake()`, §3.3 del diseño, en HOLD).
- **Severidad:** **Alta.**
- **Nivel de certeza:** **Problema actual**, con evidencia de incidente real fechado. No medido por Fase 12 (exige métricas de Neon) pero tampoco hace falta: el documento del propio repo lo mide y lo atribuye.
- **Riesgo:** Costo de cómputo directo y **creciente con la cantidad de tenants**. Hay además un hueco de alcance ya nombrado (`:264-267`): un tenant que solo recibió tráfico de portal de clientes puede **no** tener `OutboxWorker` arrancado — o sea, el problema opuesto.
- **Causa probable:** Bloque correctamente diseñado, correctamente gateado, y entregado parcialmente: quedaron justo los dos que causaron el incidente.
- **Opciones de solución:** **No inventar diseño nuevo.** `docs/diseno-polling-adaptativo-neon-2026-09-10.md` ya tiene §3.2 (hold-expiry) y §3.3 (outbox + `wake()`) escritos, con el punto exacto que el gate dejó en HOLD. Las opciones reales son las que ese documento enumera.
- **Solución recomendada:** **Desbloquear la decisión de §3.3 y completar el bloque.** Mientras tanto, **no** subir el intervalo fijo a mano: el propio documento (`:18-20`) descartó esa opción por costo de latencia de negocio, con el dueño de por medio. **ESPERA DECISIÓN DEL DUEÑO.**
- **Archivos afectados:** `src/workers/outbox.worker.ts`, `reservation-hold-expiry.worker.ts`, `outbox.registry.ts`.
- **Pruebas necesarias:** Contar polls observados: `grep` sobre los logs estructurados del worker por `businessId` en una ventana de 1 h sin actividad de usuario, cruzado contra el panel de compute de Neon. **Criterio: un tenant sin actividad llega a ≥5 min continuos sin ninguna query.** (Nota: F8-08 — 14 líneas de log del OutboxWorker **no llevan `businessId`** sobre un `event.id` que no es único entre tenants; esa prueba necesita F8-08 resuelta primero.)
- **Posibles efectos secundarios:** Un poller adaptativo mal calibrado aumenta la latencia del outbox → los CHARGE tardan más en materializarse. `wake()` mal dirigido reintroduce el polling constante por otra vía.
- **Plan de rollback:** El `AdaptivePoller` ya convive con `setInterval`; revertir un worker a `setInterval` es un cambio local por worker.

---

## D-19 — Cada PDF lanza y destruye un Chromium entero: 21 s en frío, ~200 MB por PDF concurrente, en plan `free`

**Basado en:** F12-05 (Fase 12), con F11-04 y F12-10.

- **Concepto:** Dependencia externa cuyo contrato de recursos no está acotado por el consumidor, en una ruta interactiva.
- **Ubicaciones:** `src/facturacion/invoices.routes.ts:283-301` (construye un `InvoicePdfService` **nuevo por request**, síncrono respecto de la respuesta HTTP); `src/facturacion/invoice-pdf.service.ts:177-178`; `node_modules/@arcasdk/pdf/lib/generator/invoice-pdf-generator.js:124-125` y `:188` (**un proceso de navegador por llamada**, sin caché de instancia); `render.yaml:5` (`plan: free`); `src/api/middleware/rate-limit.middleware.ts:99-107`.
- **Problema observado:** Sin pool de instancias, sin reuso, sin límite de concurrencia específico, **sin timeout** y sin cola. La ruta cae en el `apiLimiter` genérico (200 req/min por IP) igual que un `GET` de lista.
- **Evidencia (F12-05, medido):** Primera generación tras arrancar: **21 093 ms solo de `launch()`**. En caliente: `launch()` 297-334 ms, ciclo completo 503-513 ms **para una página trivial** (un `<h1>`); un comprobante real con QR, plantilla ARCA y N ítems es más. Tres PDFs concurrentes: pico de **37 procesos `chrome`** y **596 MB de PSS** (≈200 MB por PDF en vuelo), medido sobre `/proc/*/smaps_rollup` (no double-cuenta páginas compartidas).
- **Comportamiento actual:** Dos modos de falla, los dos plausibles hoy: (1) **~21 s de espera** para el usuario en el primer PDF tras un arranque — y en un plan free que se suspende por inactividad, "después de un arranque" es la situación **normal**; (2) 3 PDFs concurrentes ≈ 596 MB → carga que produce un **OOM-kill del proceso entero**, tumbando también los N workers de outbox y las conexiones de todos los tenants del proceso.
- **Comportamiento esperado:** Concurrencia acotada, timeout presente, y el usuario no espera 21 s.
- **Tipo de problema:** Dependencia externa + falta de límites, **no** bug propio.
- **Severidad:** **Alta.**
- **Nivel de certeza:** **Problema actual** en lo medible (tiempos y memoria, sobre el Chromium real del repo). **Potencial** en la consecuencia: que 3 PDFs concurrentes efectivamente OOM-killeen el proceso en Render depende del límite de RAM real del plan, que **Fase 12 no verificó**.
- **Riesgo:** **Un OOM-kill es un productor directo de D-12** (crash entre claim y fin del handler → efecto financiero salteado en silencio). Los dos hallazgos se componen.
- **Causa probable:** `@arcasdk/pdf` no expone modo de reuso de navegador; la app lo usa tal cual.
- **Opciones de solución:**

| Opción | Complejidad | Riesgo | Archivos | Prueba | Rollback | Impacto usuario | Compatibilidad | Mantenimiento |
|---|---|---|---|---|---|---|---|---|
| (a) Semáforo en proceso (1-2 en vuelo) + 429 o cola por encima | Baja | Bajo | 1-2 | Carga local | Fácil | 429 ocasional | Total | **Ataca el modo 2**, el más grave |
| (b) Sacar la generación del camino interactivo (generar al emitir o vía outbox; la ruta sirve bytes materializados) | Alta | Medio | Varios + schema/storage | Integración | Difícil | **Ataca los dos modos** | Cambia el contrato de la ruta | Cambio de diseño |
| (c) Revisar si se conserva el camino Chromium | — | — | — | — | — | — | — | **Decisión de producto ya planteada por F11-04, abierta** |

- **Solución recomendada:** (a) ya, por ser la de menor radio y atacar el modo de falla peor. **Independiente de la opción elegida y no opcional: poner un timeout** — hoy una `generate()` colgada cuelga la request para siempre (D-22 es la ficha general). (b) y (c) **requieren decisión del dueño**.
- **Archivos afectados:** `src/facturacion/invoices.routes.ts`, `invoice-pdf.service.ts`.
- **Pruebas necesarias:** Reproducir M11/M12 con un comprobante **real** (no un `<h1>`): medir `launch()`, ciclo completo y PSS con 1, 3 y 5 PDFs concurrentes, **cruzado contra el límite de RAM del plan de Render**. Criterio: el pico con la concurrencia máxima admitida queda por debajo del límite con margen para workers y pools.
- **Posibles efectos secundarios:** (a) produce 429 en un momento en que el usuario espera un comprobante — el mensaje debe ser accionable, no genérico. (b) cambia cuándo existe el PDF, lo que toca el ciclo de vida del documento fiscal.
- **Plan de rollback:** (a): quitar el semáforo. (b): no trivial una vez materializados PDFs en storage.

---

## D-20 — Ninguna llamada HTTP saliente tiene timeout, y ningún pool tiene `statement_timeout`

**Basado en:** F12-10 y F12-12 (Fase 12).

- **Concepto:** Omisión sistemática de límites de tiempo, en un repo donde la práctica **sí está entendida** y escrita para los pools de conexión.
- **Ubicaciones:** `src/platform/neon-provisioning.ts:79-86`; `src/email/email.sender.ts:119-134`; `src/security/google-oauth.ts:64` (**camino de login**); `src/facturacion/afip-client.factory.ts:19-25`; el punto de extensión que existe y no se usa: `node_modules/@arcasdk/core/lib/infrastructure/soap/soap-client.js:68-78` (`request: adapterRequestOptions` → `createSoapEngine({…, requestOptions})`).
- **Problema observado:** Los 4 `fetch()` sin `AbortSignal`; el cliente SOAP de AFIP construido sin `requestOptions`. El default efectivo de `undici` no impone límite total de request. Y ningún pool tiene `statement_timeout` ni `idle_in_transaction_session_timeout` (F12-12): una query trabada retiene **1 de 5** conexiones sin límite.
- **Evidencia (F12-10):** Contraste dentro del mismo repo que demuestra que la práctica está entendida: `src/container.ts:57-63` — *"Sin esto, `pg` espera indefinidamente si la BD de plataforma no responde… sin timeout acá un Neon caído colgaría el build para siempre, bloqueando todo deploy futuro."* El mismo razonamiento no se aplicó a las salidas HTTP. El repo ya nombró un caso de esta clase y lo dejó abierto: `src/db/health-cache.ts:28-33`.
- **Comportamiento actual:** Una contraparte que acepta la conexión y no responde deja la operación esperando; la request retiene su conexión de Express. Con `plan: free` y una sola instancia, un puñado de requests colgadas es una porción significativa de la capacidad. AFIP es la contraparte con peor disponibilidad conocida de las cuatro.
- **Comportamiento esperado:** Cada llamada saliente falla en su timeout declarado, con valores **distintos por contraparte** (el aprovisionamiento de Neon legítimamente tarda más que el JWKS de Google).
- **Tipo de problema:** Deuda técnica. F12-10: *"Omisión sistemática, no decisión: en ningún call site hay un comentario que justifique la ausencia, mientras que en los pools sí hay uno que justifica la presencia."*
- **Severidad:** **Media** (ambas fichas).
- **Nivel de certeza:** **Actual** en cuanto a la ausencia (verificada en los 4 sitios + el SDK). **Potencial** en cuanto a la consecuencia: no se reprodujo un cuelgue real; el comportamiento exacto depende de los defaults de `undici` en Node 22, que Fase 12 **no midió**.
- **Riesgo:** Agotamiento de capacidad por requests colgadas. En el camino de login, `googleapis.com` colgado cuelga el login (la caché mitiga el caso repetido, no el primero ni el de `forceRefresh`).
- **Causa probable:** Omisión sistemática, sin decisión registrada.
- **Opciones de solución:** `AbortSignal.timeout(ms)` en los cuatro `fetch()`, con valores por contraparte; `request: { timeout }` al constructor de `Arca`; `statement_timeout` e `idle_in_transaction_session_timeout` en los pools.
- **Solución recomendada:** Los tres `fetch()` no-AFIP son de radio mínimo y van ya. **El de AFIP tiene una sutileza de negocio que no es de rendimiento y ya está resuelta en el diseño:** un timeout **después** de invocar `createNextVoucher()` es ambiguo, y el código ya tiene la maquinaria (`FAILED_UNCERTAIN`, `afipContacted`, la comparación de `getLastVoucher()` antes/después — `invoice.service.ts:1453` y `:1540`). **Poner un timeout no debe cambiar esa clasificación.**
- **Archivos afectados:** `src/platform/neon-provisioning.ts`, `src/email/email.sender.ts`, `src/security/google-oauth.ts`, `src/facturacion/afip-client.factory.ts`, `src/container.ts` / `src/db/pg.client.ts`.
- **Pruebas necesarias:** Un servidor local que acepta la conexión y no responde, apuntando cada cliente a él. Criterio: cada llamada falla en su timeout declarado. **Para AFIP, sumar un test que verifique que el timeout post-`createNextVoucher` produce `FAILED_UNCERTAIN` con `afipContacted = true`, no un error genérico.**
- **Posibles efectos secundarios:** Un timeout mal dimensionado en el aprovisionamiento de Neon **aborta una saga a medio camino** (D-14): peor que esperar. Dimensionar con la latencia real observada, no con un default.
- **Plan de rollback:** Por call site. Sin estado persistido.

---

# E. Pruebas y señal de CI

## D-21 — La suite de integración está roja: 153 de 380 tests fallan

**Basado en:** F13-01 (Fase 13). **Re-verificado abierto en HEAD `e01e725`.**

- **Concepto:** El único mecanismo que re-verifica los invariantes financieros en cada commit está apagado, y se siguió pusheando encima.
- **Ubicaciones:** `src/tests/integration/helpers/seed.ts:90` (`const name = overrides.name ?? 'Habitación 101';` — **re-verificado idéntico en HEAD hoy**); `src/db/schema.sql:4299-4301` (`CREATE UNIQUE INDEX IF NOT EXISTS uq_resources_name ON resources (upper(btrim(name))) WHERE active = TRUE AND deleted_at IS NULL`).
- **Problema observado:** `npm run test:integration` falla en **153 de 380 tests (23 de 47 archivos)**. Causa única: el índice de v59 contra un harness que genera **siempre el mismo nombre de recurso**. Hay **55 llamadas a `seedResource(` y cero de ellas pasa `name:`** → el segundo recurso de cada archivo colisiona.
- **Evidencia (F13-01):** 145 de las 153 fallas con el **mismo** mensaje (`duplicate key value violates unique constraint "uq_resources_name"`, stack en `seed.ts:101`). **Bisección reproducida en un clon aparte:** en `073a8d4^` → 367 passed / 0 failed; en `073a8d4` exacto → 151 failed. **CI real corroborándolo de forma independiente:** run `34961977304`, head_sha `2b005fa`, `conclusion: failure`, job `integration` ✗ con todos los demás ✓. `073a8d4` está pusheado y se pushearon **10 commits más encima** con la suite ya roja.
- **Comportamiento actual:** Los 23 archivos caídos incluyen los que sostienen **locks de disponibilidad** (`reservation.service.integration`, 21/22), **reembolso + idempotencia** (`cancellation-refund`, 18/19), **TOCTOU de factura consolidada** (20/21), **topes de NC** (28 caídos) y **cuenta corriente** (~32 caídos). Todo el cuerpo de evidencia de concurrencia, atomicidad y dinero que este repo declara como su estándar de cierre está **hoy sin ejecutar**.
- **Comportamiento esperado:** 380 tests, 0 fallas.
- **Tipo de problema:** **Bug de prueba (harness), no de producción.** El índice es una decisión de negocio correcta y está gateada.
- **Severidad:** **CRÍTICA.**
- **Nivel de certeza:** **Confirmado** — reproducido localmente, bisectado a un commit exacto en un clon aparte, y corroborado por CI. **Y re-verificado hoy en HEAD `e01e725`**: la línea del harness sigue igual y los 8 commits posteriores son docs.
- **Riesgo:** Ninguna regresión financiera se detecta hoy. **Esta entrada bloquea la validación de D-08, D-09, D-11, D-12, D-17 y D-22.**
- **Causa probable:** Dos cosas: (a) `seed.ts` nunca aleatorizó el nombre (el aislamiento se apoyaba solo en UUIDs y `name` no era único hasta v59); (b) el commit que agregó el índice **declaró explícitamente**, en su propio mensaje y en `docs/pendientes-2026-09-12.md:48-51`, que *"el índice único parcial `uq_resources_name` nunca corrió contra Postgres real; solo se ejercitó el catch del 23505 con un mock"* — **el residuo estaba registrado y aun así se pusheó sin correr la suite que sí podía verlo**.
- **Opciones de solución:** Una sola correcta: **arreglar el harness, no el índice.** Un cambio de **una línea** en `seed.ts:90` que haga el default único por llamada (p. ej. `Habitación ${randomUUID().slice(0,8)}`).
- **Solución recomendada:** La anterior, **antes que cualquier otro trabajo de este registro**. Verificado en F13-01: **0 aserciones dependen del literal `'Habitación 101'`**; los 55 call sites solo lo reciben por default.
- **Archivos afectados:** `src/tests/integration/helpers/seed.ts`. **Ningún cambio en `src/` de producción ni en `schema.sql`.**
- **Pruebas necesarias:** `TEST_DATABASE_URL=… npm run test:integration` → 380 tests, 0 fallas. Más un test nuevo que ancle la propiedad del harness: dos llamadas seguidas a `seedResource(db, catId)` sobre la misma BD no colisionan.
- **Posibles efectos secundarios:** Si algún test asume implícitamente el nombre (medido: ninguno), fallaría — y fallaría ruidosamente, que es lo correcto. Resolver esto **destapa** el estado real de los otros 227 tests, que hoy nadie puede afirmar.
- **Plan de rollback:** Revertir una línea. Riesgo prácticamente nulo; el riesgo está en **no** hacerlo.
- **Ítem asociado (F13-15, severidad Media):** la señal de CI está degradada — 14 de las últimas 40 corridas de `main` en rojo, **12 consecutivas** del job `lint` sobre commits de **solo documentación** (rojo arrastrado durante ~18 h y 12 pushes). Eso es lo que permitió que F13-01 viviera un día sobre `origin/main` con 10 commits encima. F13-15 es explícitamente **decisión del dueño** (branch protection + PR obligatorio / hook pre-push / disciplina de no pushear sobre rojo). *"Lo que NO es una opción es seguir citando 'CI verde' como evidencia."*

---

## D-22 — No existe ninguna prueba del camino de *upgrade* de schema sobre una base poblada

**Basado en:** F13-09 (Fase 13), con F10-11 y F11-07.

- **Concepto:** La única prueba que ejercita `schema.sql` de punta a punta **no puede** detectar que una constraint nueva choque con datos preexistentes.
- **Ubicaciones:** `src/tests/integration/schema-redeploy-idempotent.integration.test.ts:21-27` (docblock: aplica el **mismo** schema dos veces sobre una base creada por **ese mismo** schema — 2 tests); `src/scripts/migrate-tenants.ts` (**0 % de cobertura**, 0 tests, lcov LH=0 de LF=42), `:86-88` (`if (failed > 0) process.exit(1)`); `render.yaml` (`buildCommand`).
- **Problema observado:** Por construcción, el harness siempre parte de cero (`createTestDatabase()`), así que ninguna suite puede responder *"¿este schema aplica sobre los datos que ya existen?"* antes de que lo intente el deploy contra producción.
- **Evidencia (F13-09, reproducido en PostgreSQL 16.13):** (1) aplicar `schema.sql` de `073a8d4^` (pre-v59) a una BD nueva; (2) insertar 2 recursos activos `'Habitación 101'` y `'habitación 101 '` (normalizan al mismo `upper(btrim(name))`) — **aceptados, 2 filas**; (3) aplicar `schema.sql` de HEAD sobre esa misma base → `exit=3`, `ERROR: could not create unique index "uq_resources_name"`.
- **Comportamiento actual:** **Un solo tenant con dos recursos homónimos activos bloquea el deploy de TODOS los tenants** (el docblock del script lo declara: *"Si falla … el build entero falla y Render no promueve la versión nueva"*). F10-11 generaliza: un solo tenant con datos que violen un constraint detiene el deploy de toda la flota, y hay al menos un `SET NOT NULL` sin backfill que puede provocarlo.
- **Comportamiento esperado:** Una prueba de **upgrade**, no de redeploy: aplicar el schema de la versión N-k, sembrar datos realistas, aplicar el de HEAD y exigir que complete.
- **Tipo de problema:** **Prueba insuficiente por diseño del harness.** El riesgo operativo es **fail-closed** (no corrompe datos: no promueve).
- **Severidad:** **ALTA.**
- **Nivel de certeza:** **Confirmado** para la ausencia de la prueba y para la falla reproducida sobre una base poblada construida a mano. **NO confirmado** el estado de los datos reales (requiere acceso a producción).
- **Riesgo:** Deploy bloqueado para toda la flota, descubierto en el peor momento posible. Ítem relacionado (F11-07, Media): los tests corren contra **PostgreSQL 16** y la producción documentada es **PG 18** (plataforma) y **PG 17** (tenants) — o sea que **la única versión que se ejercita automáticamente es la que no corre en ningún lado**, y todas las mediciones de la Fase 10 (locks, `EXCLUDE USING gist`, tiempos de `ALTER`) están calibradas sobre la versión no productiva. El mismatch está **declarado abierto desde el 08/08/2026**.
- **Causa probable:** El harness se diseñó para aislamiento (base nueva por archivo) y esa elección excluye por construcción el escenario de upgrade.
- **Opciones de solución:** (1) Test de upgrade con matriz explícita de qué versión anterior se usa como base (el repo tiene el histórico en git). (2) Query de pre-chequeo contra la flota antes de cada constraint nueva — *"eso no es un test, es un runbook, y corresponde decidirlo al dueño"*. (3) Alinear la imagen del job `integration` a la versión de los tenants, **después** de confirmar las versiones reales con `SELECT version()`.
- **Solución recomendada:** (1) + (2) juntas, y (3) como bloque aparte y barato. (2) y la decisión de si se alinean entre sí PG 17 y PG 18 **requieren decisión del dueño**.
- **Archivos afectados:** `src/tests/integration/` (archivo nuevo), `.github/workflows/ci.yml:281-284`, `docs/INCIDENT_LOG_2026-08-08.md` (deuda #3). **Nada en `src/`.**
- **Pruebas necesarias:** La descrita, con matriz de versiones base. Más, como mínimo antes de cualquier constraint nueva: `SELECT upper(btrim(name)), count(*) FROM resources WHERE active AND deleted_at IS NULL GROUP BY 1 HAVING count(*) > 1`.
- **Posibles efectos secundarios:** El test de upgrade es lento (aplica dos schemas completos sobre datos) — puede empeorar el tiempo del job `integration`, hoy ya el más largo. Considerarlo un job separado.
- **Plan de rollback:** Borrar el archivo de test. Cambiar la imagen de Postgres del CI es reversible en una línea.

---

# F. Código muerto y superficie sin consumidor

## D-23 — 35 de 262 endpoints (13 %) no tienen ningún consumidor, y nada en el repo puede detectarlo

**Basado en:** F14-01 (Fase 14), reproducido de forma independiente en el gate.

- **Concepto:** Existe artefacto generado de "qué rutas existen" y **no existe ninguno de "quién las llama"**.
- **Ubicaciones:** `docs/inventario-rutas.md` (artefacto **generado**, 262 endpoints / 201 paths); las 15 familias huérfanas listadas en F14-01 (`/api/cash-register` ×5, `/api/cancellation-policies` ×5, `/api/rate-catalog` ×4, `/api/reports/pos/*` ×3, `/api/reports/crm/*` ×2, `DELETE /api/reports/occupancy/purge`, `/api/products/*/stock/*` ×3, `/api/stays/*` ×3, `/api/housekeeping/*` ×2, `/api/locations` ×2, `GET /api/audit-log`, `GET /api/business/modules`, `GET /api/invoices/unreconciled`, `GET /api/customers/padron/iva-receptor-types`, `POST /api/users/:id/reactivate`).
- **Problema observado:** Tras excluir **17 paths con justificación explícita** (probes de infra, docs dev-only, rutas consumidas con otro cliente, y features creadas el 14-15/09 con UI pendiente — **no** abandonadas), quedan **29 paths / 35 métodos** sin una sola llamada desde `appfrontend-main`.
- **Evidencia (F14-01):** Cruce mecánico inventario × 177 paths literales del frontend, con normalización de `:param` y `${expr}`, más verificación individual por familia (todas dieron 0). **La evidencia más fuerte:** el propio frontend documenta **por duplicado** que no usa un endpoint **creyendo que no existe** — `appfrontend/src/app/dashboard/estadias/[id]/page.tsx:78` y `src/lib/refine/dataProvider.ts:209` dicen *"Sin GET /api/stays/:id"*, mientras `docs/inventario-rutas.md:233` lo lista (ver F14-18).
- **Comportamiento actual:** 13 % de la superficie HTTP se mantiene, se testea, se audita en RBAC (7 cercas), se cuenta en el inventario y **se despliega** sin que nadie la ejerza. Verificable: el commit `2b005fa` (contrato de paginación, 15/09) tocó `cash-register.routes.ts`, un router sin un solo consumidor.
- **Comportamiento esperado:** Que la pregunta "¿quién llama a esta ruta?" tenga un artefacto que la responda, igual que ya lo tienen "¿qué rutas existen?" y "¿quién puede pegarles?".
- **Tipo de problema:** Código muerto (probable) + deuda de proceso. **No** es riesgo de rotura: es superficie de ataque y de mantenimiento que nadie mide.
- **Severidad:** **Alta** — por ser el termómetro que explica D-24, D-25, F14-09 y F14-17.
- **Nivel de certeza:** **Alta** para "sin consumidor en estos dos repos". **Media-baja** para "sin consumidor en absoluto": **no se pudo descartar clientes externos**.
- **Riesgo:** **Borrar sin el artefacto de consumo es el modo de falla de `CONTRACT-001` al revés** (3 de 19 paths de `spec.ts` daban 404, uno sin detectarse 2,5 meses).
- **Causa probable:** El repo construye backend-primero por diseño, y el propio inventario declara textualmente sus límites: *"dice QUÉ RUTAS EXISTEN. NO dice quién puede pegarles… ni la forma del request/response"*. Tampoco dice quién las usa, y esa tercera pregunta no la responde nada.
- **Opciones de solución:** Una sola, y en un orden estricto: **producir primero el artefacto de consumo** (tercera columna en `docs/inventario-rutas.md`, o un test de arquitectura que cruce inventario × literales del frontend con allowlist con motivo — mismo patrón que `CLOSURE_MOUNTS`/`PUBLIC_ROUTES`/`EXCLUDED_FILES`, que este repo ya sabe sostener). **Recién con ese artefacto verde, decidir familia por familia.**
- **Solución recomendada:** La anterior. **No borrar ninguno todavía.** Marcar `@deprecated` en el docblock del router + fila en `pendientes-<fecha>.md` con el comando que reproduce el 0 — salvo las familias que D-24 y F14-17 tratan aparte.
- **Archivos afectados:** `src/scripts/generate-route-inventory.ts`, `src/tests/architecture/` (nuevo), `docs/inventario-rutas.md`.
- **Pruebas necesarias:** El test de arquitectura "inventario × consumidores", **verificado en las dos direcciones** (ruta sin consumidor que falta en el allowlist, y entrada del allowlist que ya tiene consumidor). Antes de eliminar cualquier familia: (a) `grep -rn "<path>" appfrontend/src` → 0; (b) **logs de acceso reales de Render, ventana ≥ 30 días**; (c) confirmar con el dueño si hay un consumidor fuera de estos repos.
- **Posibles efectos secundarios:** El artefacto nuevo es el **décimo-primer** artefacto manual del repo — suma costo de mantenimiento. F14 mismo advierte que los allowlists sin verificación bidireccional se pudren.
- **Plan de rollback:** El artefacto es aditivo (no cambia comportamiento). **El borrado de endpoints no se plantea en esta entrada, precisamente porque su rollback sería reconstruir código.**

---

## D-24 — El circuito de Caja está construido entero en el backend y no tiene ni una línea de UI

**Basado en:** F14-02 (Fase 14), reproducido de forma independiente en el gate; reconfirma F3-07 (Fase 3).

- **Concepto:** El único caso donde falta el **circuito entero**, no un endpoint suelto — y donde la ausencia de fila de roadmap **garantiza** que nadie lo revise.
- **Ubicaciones:** `src/clientes-finanzas/cash-register.routes.ts:1-14`, `cash-register.service.ts` (3 errores de dominio propios: `ShiftAlreadyOpenError`, `NoOpenShiftError`, `ShiftNotFoundError`), su repositorio SQL, la tabla en `schema.sql`, `src/app.ts:83` y `:396` (montado y vivo en producción); `docs/roadmap-pms-multirubro.md:115` (única mención, **incidental**, dentro de Multidivisa).
- **Problema observado:** Vertical **completo** del lado servidor —router, servicio, repositorio, tabla, `requireModule(ModuleKey.CUENTAS_CORRIENTES)`, validación Zod de nivel 2— con **cero** consumidores y **sin fila propia en el roadmap**.
- **Evidencia (F14-02):** `grep` de `cash-register` / `cash_register` / `caja` en `appfrontend/src` → **0, 0, 0**. Origen: `672dda5`, **2026-08-14** ("Gap Tango #2"), un mes y dos días antes del HEAD. Los 3 commits posteriores que lo tocaron son **barridos mecánicos transversales** (mover a bounded context, cobertura Zod, tope de paginación), no trabajo sobre la feature.
- **Comportamiento actual:** El **circuito #2 de la secuencia ERP canónica** (*pago efectivo → turno abierto → cierre → recuento → diferencia*) está a medio construir y **desaparecido del radar**: sin fila de roadmap, y por el mecanismo que el propio `CLAUDE.md` describe, **nunca puede aparecer en un `pendientes-<fecha>.md`**. Es literalmente el incidente del 25/08/2026 que ese documento narra, repetido sobre otra feature.
- **Comportamiento esperado:** El efectivo tiene circuito de arqueo operable, o la decisión de no tenerlo está registrada.
- **Tipo de problema:** Brecha estructural de proceso (roadmap ↔ pendientes), **no** defecto técnico: el código parece correcto.
- **Severidad:** **Alta** — no por el código, sino porque **el dinero en efectivo no tiene circuito de arqueo operable**.
- **Nivel de certeza:** **Alta** (0 hits con 3 términos distintos; montaje verificado; fechas de git verificadas).
- **Riesgo:** Borrar tiene **radio alto** (toca `schema.sql`, que se reaplica a **todas** las tenant DB en cada deploy). Dejarlo como está tiene riesgo técnico cero y costo de mantenimiento permanente.
- **Causa probable:** Feature construida backend-primero en un sprint de "gap analysis Tango", sin par de UI planificado y sin fila de roadmap que la sostenga en el radar.
- **Opciones de solución:**

| Opción | Complejidad | Riesgo | Archivos | Prueba | Rollback | Impacto usuario | Compatibilidad | Mantenimiento |
|---|---|---|---|---|---|---|---|---|
| (1) Completar (es el circuito #2 y está ~70 % hecho; falta la pantalla) | Media | Bajo | Frontend + roadmap | Integración + UI | Fácil | **Habilita el arqueo de efectivo** | Total | Feature viva |
| (2) Retirar entero (router + servicio + repo + tabla) con un ADR que diga por qué | Media | **Alto** (toca `schema.sql` → todas las tenant DB) | Muchos + schema | Migración | **Difícil** | Elimina una capacidad | Rompe si hay datos | Menos superficie |

- **Solución recomendada:** **Decisión del dueño, y ninguno de los dos caminos es "borrar en silencio".** En cualquiera de los dos: **crear la fila en `docs/roadmap-pms-multirubro.md` primero** — sin eso, la decisión se vuelve a perder. Marca correcta hoy: **no `@deprecated` sino "incompleto"** (fila de roadmap en ❌/⚠️ + ítem en pendientes); marcarlo `@deprecated` sería afirmar una decisión de producto que nadie tomó.
- **Archivos afectados:** (1) frontend + roadmap; (2) `cash-register.routes.ts`, `.service.ts`, el repositorio, `src/app.ts`, `src/db/schema.sql`, roadmap, ADR.
- **Pruebas necesarias:** **Antes de cualquier movimiento: `SELECT count(*) FROM cash_register_shifts` en cada tenant productivo.** Si hay filas, alguien lo usó por API y el borrado **destruye hechos financieros — prohibido** bajo la regla de no editar hechos financieros históricos. Si se completa: integración con Postgres real sobre apertura/cierre concurrente (dos `POST /open` simultáneos → un solo turno).
- **Posibles efectos secundarios:** (2) es irreversible sobre datos. (1) expone un servicio que **nunca corrió contra tráfico real**: esperar bugs de primera puesta en uso.
- **Plan de rollback:** (1): quitar la pantalla. (2): **no hay rollback de una tabla borrada con datos** — de ahí la query de conteo como paso 0 obligatorio.

---

## D-25 — Toda factura sale a Consumidor Final: el resolver fiscal está construido y sin conectar

**Basado en:** F14-03 (Fase 14), con F3-06 (Fase 3). **En HOLD esperando decisión del dueño.**

- **Concepto:** No es código muerto por descuido: es **andamiaje pre-construido y bloqueado** por una decisión fiscal en HOLD.
- **Ubicaciones:** `src/facturacion/afip-catalog.constants.ts:106-117` (`resolveDocTipo`, **único consumidor: su propio test**), `:23,25` (`CBTE_TIPO_FACTURA_A`, `CBTE_TIPO_FACTURA_C`), `:83,85,94,95` (`CONCEPTO_PRODUCTOS`, `CONCEPTO_PRODUCTOS_Y_SERVICIOS`, `DOC_TIPO_CUIL`, `DOC_TIPO_CDI`); `src/facturacion/invoice.service.ts:89-93`, `:592` y `:750` (`input.buyer ?? CONSUMIDOR_FINAL`), `:651,805,879` (`cbteTipo: CBTE_TIPO_FACTURA_B` **literal, sin ninguna resolución**), `:113`; `docs/diseno-fiscal-profile-resolver-2026-09-01.md`.
- **Problema observado:** El campo opcional `buyer` de `POST /api/invoices` **no lo manda ningún cliente**, así que la rama del `??` resuelve **siempre** al default.
- **Evidencia (F14-03, cadena completa verificada con 5 búsquedas independientes):** `grep -rn "InvoiceBuyer" app/src | grep -v test` → **0**; `grep -rn "docTipo|DocTipo|buyer" appfrontend/src` → **0**; el frontend manda `{ financialTransactionId }` y `{ companyCustomerId }` y nada más; `grep resolveDocTipo|DOC_TIPO_CUIT` en producción → **0**: nadie hace ese mapeo fuera de la función muerta. El comentario `invoice.service.ts:113` lo dice de frente: *"Sin esto, se factura a Consumidor Final (DocTipo 99, sin CUIT/DNI)"* — está describiendo **el 100 % de los casos reales**, no un borde. *(Corrección del gate, apéndice A.1: `DOC_TIPO_CUIL` y `DOC_TIPO_CDI` **no** tienen cero referencias absolutas — ver el apéndice de F14 para el matiz exacto.)*
- **Comportamiento actual:** Dos capas que hay que separar. **(1) Código muerto:** una función fiscal con test verde que nunca corre en producción — **cobertura sin ejercicio**. **(2) Negocio (ya cubierto por Fase 3, severidad asignada allí):** todo comprobante sale Factura B a Consumidor Final, **incluida la consolidada corporativa** (`:750` usa el mismo default) — **una factura a una empresa sin su CUIT no le sirve como crédito fiscal**. El perfil fiscal del cliente se captura (`/api/customers/:id/tax-profile`, `padron/lookup-by-cuit`, `padron/lookup-by-dni`) y **nunca llega a AFIP**: es el patrón *"dato anecdótico, sin efecto downstream"* en su forma más cara.
- **Comportamiento esperado:** Pendiente de la decisión fiscal en HOLD.
- **Tipo de problema:** Requisito en espera de decisión del dueño; el código muerto es su consecuencia, no su causa.
- **Severidad:** **Media** en la dimensión de código muerto. La dimensión de negocio tiene su severidad asignada en Fase 3 y F14 no la re-califica.
- **Nivel de certeza:** **Alta** para las 5 afirmaciones de código y para "el frontend no manda `buyer`". No verificado: si existe otro cliente fuera de estos repos que sí lo mande.
- **Riesgo:** **Borrar es el peor resultado posible acá.** Borrar `resolveDocTipo()` y las constantes A/C obligaría a reescribirlas cuando la decisión salga de HOLD, y perdería el docblock que explica por qué el fallback es 99 y no un código inventado — **que es el conocimiento caro, no las 10 líneas**.
- **Causa probable:** El catálogo AFIP se escribió completo y correcto por anticipado (buena práctica); el resolver que lo consumiría quedó bloqueado por `docs/diseno-fiscal-profile-resolver-2026-09-01.md`.
- **Opciones de solución:** **NO borrar y NO marcar `@deprecated`** — esta es la única ficha de la Fase 14 donde la recomendación estándar se **invierte**, y el motivo importa: marcar `@deprecated` algo que espera una decisión en HOLD **convertiría una espera en un retiro sin que nadie lo decida**, exactamente el modo de falla que el `CLAUDE.md` describe en *"Preguntas de alcance pueden esconder una decisión de negocio"*.
- **Solución recomendada:** (1) Un comentario en `afip-catalog.constants.ts`: *"sin consumidor de producción hoy — habilitado por `docs/diseno-fiscal-profile-resolver-2026-09-01.md`, en HOLD"*. (2) Una **cerca chica que congele el hecho**. (3) **Desbloquear la decisión fiscal es del dueño** — no de esta auditoría. La etiqueta correcta no es "obsoleto" sino **"pre-construido y bloqueado"**, que el repo no tiene todavía.
- **Archivos afectados:** `src/facturacion/afip-catalog.constants.ts` (comentario), `src/tests/` (cerca nueva). **Nada de producción.**
- **Pruebas necesarias:** Un test que afirme que el `cbteTipo` emitido es siempre `CBTE_TIPO_FACTURA_B` y el `buyer` siempre `CONSUMIDOR_FINAL` **mientras el resolver esté en HOLD**, y que **falle ruidosamente** el día que eso cambie. Convierte una ausencia silenciosa en una afirmación verificada — mismo criterio que las 7 cercas de RBAC.
- **Posibles efectos secundarios:** La cerca fallará en el momento en que se conecte el resolver — **eso es el objetivo**, y hay que documentarlo para que nadie la "arregle" sin leer.
- **Plan de rollback:** Borrar la cerca. Nada de producción cambia.

---

# 2. Tabla resumen del registro de decisiones

| ID | Concepto | Fase de origen | Severidad | Solución recomendada | ¿Decisión del dueño? |
|---|---|---|---|---|---|
| D-01 | `next@16.3.1` con 2 advisories CRITICAL de RCE | F9-01 | **Crítica** | Bump a ≥16.3.3 + `sharp` ≥0.35.4 + `npm audit` en CI de ambos repos | No |
| D-02 | Token de sesión, cookie y PII en cada línea de log | F9-02 / F8-10 / F8-06 | Alta | `redact` + `serializers.req` en `logger.ts` | Solo para mover `email`/`name` fuera de la query |
| D-03 | Token del portal alcanza 4 rutas mutantes de staff | F5-01 / F9-15 | Alta | Guard por actor + extender la cerca por ACTOR, no por archivo | **Sí** (entre (a), (b) y (c)) |
| D-04 | Sin ningún mecanismo de revocación de sesión | F9-03 | Alta | `token_version` (A); vida absoluta (C) es aparte | **Sí** (para (C), vida absoluta) |
| D-05 | Vínculo a empresa ajena conociendo su UUID | F9-05 | Alta | Token de vínculo de un solo uso, o aprobación en dos pasos | **Sí** (toca el modelo de multipropiedad) |
| D-06 | `DATABASE_URL`: trampa que aplicaría schema de tenant sobre plataforma | F11-02 / F7-05 | Alta | Retirar el endpoint, o renombrar la variable + guarda | **Sí** |
| D-07 | Backfill de `customer_rates` convierte tarifa fija en % | F10-02 (+F10-16, F10-17) | **Crítica** si hay filas candidatas | Inventariar los 20 DML; gatear o retirar los 3 con disparo abierto | **Sí** (qué hacer con las filas existentes) |
| D-08 | Cada deploy bloquea `reservations` 45,9 s medidos | F10-01 | **Crítica** | Extender el guard `pg_constraint` de v51 a las 28 posiciones | No |
| D-09 | La versión de schema autoritativa vive en la BD equivocada | F10-03 / F8-05 | Alta | Que `migrate-tenants` no salte por la versión de plataforma (tras D-08) | **Sí** (cambia el perfil del deploy) |
| D-10 | `idempotencyKey` del pago atada al intento, no al pago | F8-15 | Alta | Generar la clave al abrir el formulario | **Sí** solo si se la vuelve obligatoria |
| D-11 | `TransactionManager.run()`: COMMIT ambiguo + conexión abortada al pool | F8-01 / C6-06 | Alta | try/catch en el ROLLBACK + `release(err)` + contrato declarado | No |
| D-12 | Crash entre claim y handler saltea un efecto financiero | F8-07 | Alta | Subir el skip a `warn` ya; el sweep es la solución real | **Sí** (el sweep está en HOLD) |
| D-13 | El build depende de que `NODE_ENV=production` no llegue a `npm install` | F11-01 | Alta | `npm install --include=dev`, o mover `tsx`/`patch-package` a deps | **Sí** (entre las 3 opciones) |
| D-14 | La saga de aprovisionamiento vive 4 veces con políticas distintas | F7-05 / F8-05 | Alta | Extraer `tenant-provisioning.service.ts`, tras característica de regresión | No (pero exige orden y backup) |
| D-15 | Configuración sin capa: 30 vars en 26 archivos, 11 sin declarar | F7-06 (+F11-10/11/22, F9-10) | Alta como clase | Cerca de conteo primero, luego `src/config/env.ts` y 3 bloques chicos | **Sí** para convertir literales en config por tenant |
| D-16 | Cuatro formas de error 400: el usuario ve "Error inesperado" | F5-04 / C6-03 | Alta | Delegar los `ZodError` al handler central + cerca de arquitectura | No |
| D-17 | N+1 en toda lectura de reservas: 401 queries por página de 200 | F12-01 (+F12-02, F12-03) | Alta | Aplicar el patrón que ya usa `sql.order.repository.ts:151-166` | No |
| D-18 | Dos workers en `setInterval` fijo por tenant (incidente ya ocurrido) | F12-04 | Alta | Completar el bloque de `AdaptivePoller` según §3.2/§3.3 del diseño | **Sí — HOLD explícito** |
| D-19 | Un Chromium entero por PDF: 21 s en frío, ~200 MB concurrente | F12-05 / F11-04 | Alta | Semáforo de 1-2 en vuelo + **timeout** (no opcional) | **Sí** para sacarlo del camino interactivo |
| D-20 | Ninguna salida HTTP con timeout; ningún pool con `statement_timeout` | F12-10 / F12-12 | Media | `AbortSignal.timeout()` por contraparte + `requestOptions` en Arca | No |
| D-21 | Suite de integración roja: 153 de 380 tests fallan | F13-01 (+F13-15) | **CRÍTICA** | Arreglar el harness (1 línea en `seed.ts:90`), no el índice | No (F13-15 sí: branch protection) |
| D-22 | Sin prueba del camino de upgrade de schema sobre base poblada | F13-09 (+F10-11, F11-07) | Alta | Test de upgrade con matriz de versiones + alinear el PG del CI | **Sí** (runbook de pre-chequeo; alinear PG 17/18) |
| D-23 | 35 de 262 endpoints sin ningún consumidor | F14-01 | Alta | Artefacto de consumo **primero**; no borrar nada todavía | **Sí**, familia por familia, después del artefacto |
| D-24 | Caja: circuito completo en backend, cero UI, sin fila de roadmap | F14-02 / F3-07 | Alta | Fila de roadmap primero; después completar o retirar con ADR | **Sí** |
| D-25 | Toda factura sale a Consumidor Final; resolver fiscal sin conectar | F14-03 / F3-06 | Media (código) | No borrar, no `@deprecated`: comentario + cerca que congele el hecho | **Sí — HOLD explícito** |

**Recuento:** 25 entradas · 4 Críticas (D-01, D-07 condicional, D-08, D-21) · 19 Altas · 2 Medias · **15 requieren decisión del dueño**, de las cuales **2 están en HOLD declarado desde antes de esta auditoría** (D-18, D-25).

# 3. Orden de atención que se desprende de la evidencia (no es una decisión)

1. **D-21** primero y solo — sin la suite de integración verde, ningún otro cambio de este registro se puede validar. Una línea.
2. **D-01** — mayor retorno por menor radio; no toca código de aplicación.
3. **D-07** (consulta de diagnóstico, que es de solo lectura) y **D-08** — los dos tocan `schema.sql` y conviene un solo bloque de schema.
4. **D-02**, **D-11**, **D-10** — secretos en logs y el par atomicidad/idempotencia del dinero.
5. El resto, por dependencia: **D-09** después de D-08; **D-17** después de D-21; **D-23** antes de cualquier borrado.

# 4. Límites declarados de esta fase

- **No se re-verificó el estado de los ~150 hallazgos** de las 14 fases contra el árbol vivo, salvo los 3 anclas críticas citadas en §0. Un hallazgo no incluido acá **no está cerrado**: está fuera de la selección.
- **No se consultó ninguna base de producción.** D-07 (¿hay filas candidatas?), D-09 (¿hay tenants divergentes?), D-22 (¿hay recursos homónimos?), D-24 (¿hay turnos de caja registrados?) y D-19 (¿cuál es el límite de RAM del plan?) **tienen todos una consulta de solo lectura pendiente** que esta auditoría no puede correr, y que en varios casos es lo que define la severidad real.
- **No se verificó el dashboard de Render.** D-13 (¿qué dice el log del último `npm install`?) y D-06 (¿está seteada `DATABASE_URL`?) dependen de eso.
- **No se pudo descartar consumidores externos de la API** (D-23), lo que acota la certeza de todo el bloque F a "sin consumidor en estos dos repos".
- Esta fase **no aprueba ni rechaza ninguna decisión de negocio**: donde hay más de un camino razonable, se enumeran las opciones con su comparación y se deja la elección al dueño, como pide el protocolo.

---

# Apéndice A — Correcciones del gate (`architecture-governor`, 16/09/2026)

Verificación independiente previa al commit. El cuerpo verbatim de las 25
fichas no se edita; las dos correcciones de abajo son del aparato del
documento (§0, §2 y una nota de bloqueo), no de ninguna afirmación
atribuida a una fase de origen. Las 10 entradas cotejadas contra su
documento de fase (D-01, D-03, D-07, D-08, D-10, D-13, D-17, D-21, D-22,
D-24) resultaron fieles en Severidad, Evidencia y conclusiones.

## A.1 — Dos referencias cruzadas dicen `D-20` donde corresponde `D-21`

`D-20` es "Ninguna llamada HTTP saliente tiene timeout" (F12-10/F12-12,
severidad Media). `D-21` es "La suite de integración está roja: 153 de 380
tests fallan" (F13-01, CRÍTICA). El ancla `src/tests/integration/helpers/
seed.ts:90` y el bloqueo por suite roja pertenecen ambos a **D-21**.

Dice, y debe leerse corregido:

- **§0, re-verificación 1 de 3:** donde dice
  *"→ **D-20 sigue abierta**"* debe decir *"→ **D-21 sigue abierta**"*.
  La frase que introduce las tres re-verificaciones ("por ser los tres
  anclas de entradas CRÍTICAS") sólo es cierta con D-21: D-20 es Media.
- **D-17, "Nota de bloqueo":** donde dice
  *"**D-20 debe resolverse primero**"* debe decir
  *"**D-21 debe resolverse primero**"*. Lo que impide validar el cambio de
  D-17 es la suite de integración roja (D-21), no la ausencia de timeouts
  (D-20).

El resto del documento usa `D-21` correctamente en los cinco lugares donde
corresponde (D-08 "Posibles efectos secundarios", D-09 "Posibles efectos
secundarios", D-21 "Riesgo", §3.1 y §3.5). Ninguna conclusión cambia.

## A.2 — El recuento de §2 dice 15 y las filas de la tabla son 16

`**Recuento:**` declara "**15 requieren decisión del dueño**". Contando las
celdas de la columna "¿Decisión del dueño?" que abren con **Sí** en
negrita, son **16**: D-03, D-04, D-05, D-06, D-07, D-09, **D-10**, D-12,
D-13, D-15, D-18, D-19, D-22, D-23, D-24, D-25.

Las 25 filas de la tabla son correctas una por una; el error está sólo en
la línea de recuento. El resto de esa línea sí cierra y fue verificado
contra el cuerpo de las fichas: 25 entradas, 4 Críticas (D-01, D-07
condicional, D-08, D-21), 19 Altas, 2 Medias (D-20, D-25) y 2 en HOLD
declarado (D-18, D-25).

Si la intención era excluir a **D-10** —cuya solución recomendada (a) dice
explícitamente "no requiere decisión de negocio", quedando el Sí sólo para
la opción (c)—, el criterio no está declarado y **D-04** tiene la misma
estructura (recomendada (A) sin decisión; el Sí aplica sólo a (C)) y sí
queda contada. Con el criterio literal de la tabla, el número es 16.
