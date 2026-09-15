# Auditoría técnica integral — Fase 9: revisar seguridad

Fecha: 15/09/2026
Repos: `app-main` (backend, `/home/user/app`) · `appfrontend-main` (frontend, `/home/user/appfrontend`)
Fase previa: `docs/auditoria-integral-fase8-2026-09-15.md`
Alcance: revisión específica de seguridad — autenticación, autorización, validación de
entradas, inyección, exposición de información, sesiones/tokens/cookies, CORS, rate
limiting, logs, dependencias y configuración de producción. **Cero cambios de código** —
fase de análisis.

---

## 0. Método y criterio

Esta fase **no re-investiga** lo que fases anteriores ya reprodujeron. Reusa como
evidencia y le aplica el lente de seguridad:

- **F5-01** (Fase 5) — un JWT de portal de cliente llega a 4 rutas mutantes de routers de
  staff (`Roles.BOOKING`) sin guard de pertenencia. Ya tiene test de reproducción
  (`src/tests/integration/customer-token-staff-route-ownership.integration.test.ts`) y
  ficha propia. Acá se agrega **solo el ángulo de exposición de datos** que F5-01 no
  cubrió → F9-15.
- **F8-10** (Fase 8) — cada request loguea el header `authorization` y la cookie de sesión
  completos. Reproducido en el gate de Fase 8. Acá se **confirma de nuevo en el mismo
  banco de pruebas** (para poder medir los dos vectores nuevos en la misma corrida) y se
  suman dos superficies que Fase 8 no nombró: la **query string con PII** y el **token de
  SUPERADMIN** por el mismo canal → F9-02.
- **F8-06** (Fase 8) — el connection string de Neon con contraseña puede terminar logueado
  entero. No se re-deriva; se cita en F9-02 como parte de la misma familia.
- Las **10 cercas RBAC/contrato** del `CLAUDE.md` de `app-main` se usan como evidencia de
  qué SÍ está cubierto por un mecanismo automático. Esta fase se concentra en lo que
  **ninguna cerca ve**, incluidos los huecos que las propias cercas declaran en su
  docblock.
- Fase 7 ya cubrió `crypto-misuse-reasoning` sobre `tenant-db.setup.ts` y `google-oauth.ts`
  desde el ángulo arquitectónico. Acá solo se registra el resultado de la re-lectura con
  lente de seguridad (§2, "verificado limpio"), sin hallazgo nuevo sobre esas costuras.

**Qué se leyó completo (no en diagonal):** `src/app.ts` (595 líneas),
`src/security/auth.middleware.ts` (428), `src/security/roles.ts`,
`src/security/auth.service.ts` (330), `src/security/user.store.ts`,
`src/security/google-oauth.ts` (162), `src/security/invitation-token.ts`,
`src/security/password-reset-token.ts`, `src/api/middleware/rate-limit.middleware.ts`,
`src/api/middleware/helmet.middleware.ts`, `src/api/middleware/error.middleware.ts` (387),
`src/api/docs-exposure.ts`, `src/api/routes/customer.routes.ts` (853),
`src/api/routes/me.routes.ts`, `src/platform/tenant.middleware.ts` (270),
`src/platform/platform.auth.middleware.ts`, `src/platform/platform.auth.service.ts`,
`src/platform/admin.routes.ts` (167), `src/platform/business.routes.ts` (237),
`src/platform/companies.routes.ts` (102), `src/platform/neon-provisioning.ts` (§55-141),
`src/platform/tenant-db.setup.ts` (§95-185), `src/usuarios-roles/password-reset.routes.ts`
(224), `src/facturacion/afip-credentials.service.ts`,
`src/facturacion/sql.afip-credentials.repository.ts`, `src/db/pg.client.ts::sslConfig()`,
`src/logger.ts`, `render.yaml`, y del frontend `src/lib/http.ts`, `next.config.js`,
`src/context/PlatformAuthContext.tsx`, `src/components/ApiBlock.tsx`,
`src/app/admin/page.tsx`.

### Mediciones reproducibles (comando y resultado, no estimación)

| Medición | Comando / procedimiento | Resultado |
|---|---|---|
| Call-sites de `authorize(Roles.X)` en `*.routes.ts` (comentarios removidos) | script node con el MISMO `stripComments` + regex de `src/tests/security/rbac-matrix-sync.test.ts` | **215** (coincide con `EXPECTED_AUTHORIZE_CALL_SITES`) |
| `authorizeAny([...])` / `authorizePlatform(...)` en `*.routes.ts` | mismo script | **2** y **2** |
| `requireModule(...)` — en `*.routes.ts` / en `app.ts` | mismo script + `grep -c` | **9** / **12** |
| Endpoints reales del árbol vivo | `docs/inventario-rutas.md` (`npm run docs:routes`), filas de método | **262** |
| Las 10 cercas RBAC/contrato/arquitectura | `npx vitest run src/tests/security src/tests/architecture` | **15 archivos, 58 tests, todos verdes**, 2.65s |
| Interpolaciones `${...}` dentro de literales que contienen SQL | script node que recorre `src/**/*.ts` (sin `*.test.ts`), detecta template literals con palabra clave SQL y extrae interpolaciones que NO son el placeholder `$${idx}` | **139** ocurrencias, **32** expresiones distintas |
| …de esas, las que no son `CONSTANTE_MAYUS` ni `this.metodo()` | mismo script | **54** — las 54 revisadas a mano: `fields.join(', ')`/`conditions.join(' AND ')`/`setClauses.join(', ')` construidos desde mapas cerrados `[keyTS, columna]` en código, `target.clause`/`subjectColumn`/`column` desde uniones cerradas. **Cero** provenientes de entrada de usuario |
| `child_process` / `exec(` / `spawn(` / `eval(` / `new Function(` en `src/` | `grep -rn` | **0** usos reales (3 coincidencias, todas `RegExp.prototype.exec`) |
| Llamadas `fetch(` en producción | `grep -rn "fetch(" src \| grep -v .test.ts` | **3**: `neon-provisioning.ts:79` (URL de env), `email.sender.ts:119` (constante), `google-oauth.ts:64` (constante). **Ninguna** con URL controlada por el request |
| Librerías de subida de archivos | `grep -rn "multer\|busboy\|formidable\|multipart" package.json src` | **0** — el repo no tiene ningún endpoint de subida de archivos |
| Parsers de body montados | `src/app.ts:193` + `grep -rn urlencoded src` | **solo `express.json()`**; `express.urlencoded` = **0** |
| Rate limiters definidos | `grep -rn "rateLimit({" src` | **6** (4 en `rate-limit.middleware.ts`, 2 locales en `customer.routes.ts`) |
| Cookies de sesión | `auth.middleware.ts:167-226` | **2** (`rh_token`, `rh_customer_token`), las dos `httpOnly` + `sameSite:'strict'` + `secure` solo si `NODE_ENV==='production'` |
| Secretos declarados `sync: false` en `render.yaml` | `grep -c "sync: false" render.yaml` | **14** |
| `npm audit --omit=dev` backend | `npm audit --omit=dev --json` | **4**: 1 high (`@xmldom/xmldom`), 3 moderate (`qs`/`express`/`body-parser`) |
| `npm audit` backend (con dev) | ídem sin `--omit` | **11**: 2 high, 9 moderate |
| `npm audit --omit=dev` frontend | ídem en `/home/user/appfrontend` | **3**: **1 critical (`next`)**, 1 high (`sharp`), 1 moderate (`qs`) |
| Versión de `next` instalada vs. fix | `require('next/package.json').version` + `fixAvailable` de `npm audit` | instalada **16.3.1**; advisories `>=16.0.0 <16.3.3`; fix **16.3.5** (no semver-major) |
| Headers de seguridad en el frontend | `grep -rn "headers()\|Content-Security-Policy\|X-Frame-Options\|Strict-Transport"` sobre `appfrontend` sin `node_modules`/`.next`; `ls` de `vercel.json`/`middleware.ts` | **0 coincidencias**, **0 archivos** — ninguno configurado |
| Reproducción del serializer de `pino-http` | servidor express efímero con `pinoHttp({ logger })`, request con `?email=...&name=...`, header `authorization` y cookie ficticios | `req.url` incluye la query string completa; `req.headers` incluye `authorization` y `cookie` completos; `req.id` = entero `1` |
| Reproducción del orden de montaje de helmet | app express mínima que replica `app.ts:151 → 277 → 282` | `POST /api/customer/:slug/login` → `content-security-policy: (ausente)`; `GET /api/resources` → CSP presente |

Los dos scripts de reproducción se escribieron en el scratchpad de sesión y se
borraron; `git status` quedó limpio en los dos repos.

---

## 1. El checklist del protocolo, respondido primero

Va antes de los hallazgos a propósito: seis de las respuestas son "verificado limpio" y
acotan el alcance real de los hallazgos que siguen.

| Ítem del protocolo | Estado | Evidencia |
|---|---|---|
| **Autenticación** | **Sólida en el mecanismo, con huecos de ciclo de vida** | JWT HS256 propio con `node:crypto`; la comparación de firma usa `timingSafeEqual` con chequeo previo de longitud (`auth.middleware.ts:139-149`). **No hay confusión de algoritmo**: `verifyToken()` nunca lee `header.alg` — siempre calcula HMAC-SHA256 y compara, así que `alg:none`/`alg:RS256` no son vectores. Huecos → F9-03 |
| **Autorización** | **Bien modelada, resuelta por request** | El JWT de staff **no** lleva `role` (`auth.middleware.ts:71-79`); `roleId` + `permissionGroups` se resuelven contra `role_permission_groups` en **cada** request (`app.ts:319-321`), así que una revocación de permisos tiene efecto inmediato. `authorize()` es fail-closed (`permissionGroups ?? []`). `authorizeAny()` existe porque encadenar dos `authorize()` es AND, no OR — corrección documentada |
| **Permisos por recurso / control por rol** | **215 call-sites + 5 cercas, todas verdes** | Ver tabla de mediciones. Lo que ninguna cerca ve: el **grupo** que cada fila de la matriz declara (`rbac-matrix-section2-sync` lo declara como hueco propio), y ownership dentro del tenant fuera de `customer.routes.ts` (F5-01 → F9-15) |
| **Validación de entradas** | **Zod en el borde, consistente** | 18 archivos `src/api/schemas/*.ts` + esquemas locales por router. `express.json()` sin `express.urlencoded` |
| **Inyección SQL** | **Verificado limpio** | 139 interpolaciones en literales SQL, 54 no-constantes, **las 54 provienen de mapas/uniones cerradas en código**; los valores van siempre por `$n`. Ejemplo del criterio, escrito en el propio código: `sql.invoice.repository.ts:769-779` (*"El nombre de columna sale de un `switch` sobre una unión cerrada, NUNCA se interpola un valor del caller"*) |
| **Inyección de comandos** | **Verificado limpio** | 0 `child_process`/`exec`/`spawn`/`eval`/`new Function` en `src/` |
| **XSS** | **Backend limpio; el riesgo real está en el frontend** | La API devuelve JSON con CSP `default-src 'none'` (`helmet.middleware.ts:110-115`) — salvo `/api/customer/*` (F9-08). Templates de mail con `escapeHtml()` (`email/templates.ts:160`). Frontend: **0** `dangerouslySetInnerHTML`. Pero el frontend no emite **ningún** header de seguridad (F9-07) y persiste un token en `localStorage` (F9-06) |
| **CSRF** | **Mitigado, con una sola capa** | `sameSite:'strict'` en las dos cookies (`auth.middleware.ts:202-208`) **+** solo `express.json()` montado: un form cross-site solo puede mandar `urlencoded`/`text/plain`/`multipart`, que ningún parser lee → el body llega `undefined` y Zod rechaza. No hay token CSRF ni chequeo de `Origin`; hoy no hace falta, pero es defensa de una sola capa y conviene declararlo |
| **SSRF** | **Verificado limpio salvo un caso por diseño** | Las 3 `fetch()` de producción usan URLs de env o constantes. El único caso donde el servidor se conecta a un destino del body es `POST /api/admin/set-tenant-url` → F9-16 (SUPERADMIN, riesgo declarado en el propio archivo) |
| **Exposición de información** | **Buena en general, con fugas puntuales** | `/docs`, `/openapi.json` y `/` **no se montan en producción** (`docs-exposure.ts` + `app.ts:247-260`), y el resultado es 404, no 401, a propósito. `toBusinessDto` reduce `dbUrlEncrypted` a `hasTenantDb` booleano (`platform.routes.ts:599`). `X-Powered-By` eliminado. Fugas: F8-03 (raw de AFIP al navegador), F9-02 (logs) |
| **Subida de archivos** | **No aplica** | 0 endpoints de subida. El certificado/clave de AFIP entra como string JSON, no como archivo |
| **Rutas internas** | **Segregadas correctamente** | `/platform/*` fuera de `/api` con `PLATFORM_JWT_SECRET` ≠ `JWT_SECRET`; `/api/admin` montado **antes** del `authenticate()` de tenant a propósito y protegido con `authenticatePlatform()` (`app.ts:284-293`) — el comentario explica el incidente que lo motivó |
| **Datos sensibles** | **Cifrados con un solo mecanismo** | AES-256-GCM con clave de 32 bytes validada (`tenant-db.setup.ts:140-157`), con soporte de clave anterior para rotación (`DB_ENCRYPTION_KEY_OLD`, SEC-ROT-001). Reusado para el cert/clave de AFIP (`sql.afip-credentials.repository.ts:11-17`) |
| **Contraseñas** | **Verificado limpio** | PBKDF2-SHA256, 100 000 iteraciones, salt de 16 bytes, comparación `timingSafeEqual` (`user.store.ts:23-86`); superadmin usa 310 000 iteraciones. Login con hash dummy para tiempo constante y mensaje genérico (`auth.service.ts:79-117`). Cero contraseñas en texto plano persistidas — salvo `PLATFORM_ADMIN_PASSWORD` como variable de entorno (F9-14) |
| **Sesiones** | **Sin revocación de ninguna clase** | F9-03 |
| **Tokens** | **Hygiene correcta en los de un solo uso** | Invitación y reseteo: 32 bytes aleatorios, se persiste solo `sha256(token)` (`invitation-token.ts`, `password-reset-token.ts`), razonamiento correcto y escrito. El de reseteo viaja siempre en el **body**, nunca en la URL de la API |
| **Cookies** | **Configuración correcta** | `httpOnly`, `sameSite:'strict'`, `path:'/'`, `secure` en producción; dos nombres distintos a propósito. El problema no es la cookie: es que el mismo token viaja también en el body (F9-06) |
| **CORS** | **Fail-closed en producción** | `CORS_ORIGIN ?? (production ? false : '*')` (`app.ts:174-176`): sin la variable, en producción **no** hay origen permitido. Sin `credentials: true`, y el frontend no lo necesita porque proxea `/api/*` same-origin (`next.config.js`) |
| **Rate limiting** | **4 capas bien pensadas, con un agujero de mecanismo** | Ver §1.1 y F9-04 |
| **Logs** | **El peor punto del sistema** | F8-10 confirmado + F9-02 |
| **Dependencias vulnerables** | **1 critical + 2 high explotables desde afuera** | F9-01, F9-13 |
| **Configuración de producción** | **Correcta salvo un default silencioso** | `render.yaml` setea `NEON_SSL=true` y 14 secretos `sync:false`. El default silencioso: F9-10 |
| **No confiar en validaciones solo del frontend** | **Verificado limpio** | El frontend declara explícitamente que sus chequeos de rol son cosméticos (`appfrontend/CLAUDE.md`: *"el backend igual la valida en serio; esto solo evita mostrar un botón que el backend va a rechazar"*). El backend re-valida con Zod + `authorize()` en las 215 posiciones |
| **No confiar en ids del cliente sin comprobar permisos** | **Mayormente sí, con la excepción de F5-01** | El aislamiento entre tenants es **estructural** (una BD por negocio). Las rutas que tocan la BD de plataforma (`users`, `roles`, `companies`) derivan el negocio de `req.user!.businessId`, nunca del body — verificado en los 3 routers. Excepciones: F9-15 (=F5-01) y F9-05 |
| **No devolver datos de más** | **Verificado limpio en el borde** | Ningún `*.routes.ts` ni `*.mapper.ts` emite `passwordHash`, `db_url_encrypted`, `afip_cert_encrypted` ni `afip_key_encrypted` |
| **No registrar secretos** | **Incumplido** | F9-02 (=F8-10), F8-06 |
| **No almacenar contraseñas en texto plano** | **Cumplido** en BD; ver F9-14 para el env var |
| **No exponer trazas internas** | **Cumplido** | `error.middleware.ts:114-119`: el error no tipado se loguea entero y al cliente le sale `500 INTERNAL_ERROR` genérico, sin stack. La excepción es el `err.message` de `DomainError` (F8-03) |
| **No usar valores inseguros por defecto** | **Un incumplimiento** | F9-10 (`ssl:false` silencioso). El resto de los defaults son fail-closed y están declarados |
| **Acciones críticas auditables** | **Buena cobertura de negocio, cero cobertura de autenticación** | 30 archivos escriben `audit_log` vía `updateWithAudit()`/`recordFieldChanges()`; el superadmin escribe `platform_audit_log`. **Ningún** evento de login/logout/login fallido queda registrado → F9-11 |

### 1.1 Las 4+2 capas de rate limiting, medidas contra el montaje real

| Limiter | Ventana / techo | Qué cubre REALMENTE (según `app.ts`) | Observación |
|---|---|---|---|
| `globalLimiter` | 500/min/IP | toda la app (`app.ts:156`) | Único techo efectivo de varias rutas caras |
| `authLimiter` | 10/15min/IP, **`skipSuccessfulRequests: true`** | `/register` (`:271`), `/api/login` (`:272`), `/api/password-resets` (`:309`) | **Una sola instancia de módulo** ⇒ un solo contador compartido por las tres rutas. Y `skipSuccessfulRequests` lo neutraliza donde el éxito es el abuso → F9-04 |
| `platformLimiter` | 30/15min/IP | `/platform/*` (`:266`) | Correcto |
| `apiLimiter` | 200/min/IP | `/api/*` **después** de `authenticate` + `tenantMiddleware` (`:352`) | **No** alcanza `/api/customer/*`, `/api/admin`, `/api/invitations`, `/api/companies`, `/api/auth`, `/api/business/modules`, `/api/business/plan-limits` — todos montados antes |
| `registerLimiter` | 5/15min/IP | `POST /api/customer/:slug/register` | Correcto |
| `loginLimiter` | 10/15min/IP | `POST /api/customer/:slug/login` y `/login/google` | Correcto |
| *(ninguno dedicado)* | — | `/api/invitations/*`, `/api/companies/*`, y **todas** las rutas autenticadas del portal (`/api/customer/me/*`) y `GET /:slug/availability` | Solo `globalLimiter` → F9-09 |

Todos los limiters usan el `MemoryStore` por defecto: el contador es **por proceso**. Con
una sola instancia en Render hoy es correcto; con dos réplicas el techo efectivo se
duplica sin que nada lo avise.

---

## 2. Hallazgos

### F9-01 — `next@16.3.1` en producción arrastra dos advisories CRITICAL de ejecución remota de código no autenticada, con fix menor disponible

```text
Hallazgo: el frontend declara e instala `next@16.3.1`. `npm audit
--omit=dev` sobre `appfrontend-main` devuelve 1 vulnerabilidad CRITICAL,
directa y de producción, compuesta por dos advisories de GitHub: RCE no
autenticada en servidores hospedados en Windows (GHSA-p293-qw3h-jr36) y
RCE no autenticada en la Image Optimization API cuando se procesan
archivos AVIF (GHSA-2xp9-vwfh-vxw4). Los dos declaran rango afectado
`>=16.0.0 <16.3.3`; `npm audit` reporta `fixAvailable: {"name":"next",
"version":"16.3.5","isSemVerMajor":false}` — o sea, un salto de patch
dentro de la misma minor. En la misma corrida aparece `sharp <0.35.4`
(HIGH, GHSA-rgj7-g3m4-5g8c: vulnerabilidades de libheif), que es
exactamente el decodificador que usa el optimizador de imágenes de Next.
Es el único hallazgo CRÍTICO de esta fase y el único que no depende de
código propio: se cierra con un bump de versión.
Evidencia: `cd /home/user/appfrontend && node -p
"require('./node_modules/next/package.json').version"` → `16.3.1`;
`package.json` declara `"next": "16.3.1"` (pin exacto, sin rango) ·
`npm audit --omit=dev --json` → `{"info":0,"low":0,"moderate":1,"high":1,
"critical":1,"total":3}`, con `next` critical `isDirect: true`, `sharp`
high `isDirect: false` · defaults del optimizador leídos en
`node_modules/next/dist/shared/lib/image-config.js:50-75`:
`remotePatterns: []`, `localPatterns: undefined`, `formats:
['image/webp']`, `dangerouslyAllowSVG: false` · `next.config.js` **no**
tiene bloque `images` (verificado: `grep -n "images" next.config.js` →
sin coincidencias), así que rigen esos defaults · `grep -rln "next/image"
src` → **0 archivos**: ninguna pantalla usa el componente, pero el
endpoint `/_next/image` se sirve igual porque es parte del runtime, no
del código de la app · `next.config.js` reescribe `/api/:path*`,
`/platform/:path*` y `/register` hacia el backend, así que una ruta
"local" del optimizador puede resolver a una respuesta del backend.
Impacto: ejecución remota de código en el proceso que sirve el panel de
administración — el mismo origen donde vive la cookie de sesión de staff
(ver F9-06/F9-07). Es el techo de severidad posible en los dos repos. El
advisory de Windows no aplica si el frontend corre en Linux; el de la
Image Optimization API no depende del sistema operativo.
Causa probable: la dependencia se fijó con versión exacta (`16.3.1`, sin
`^`), así que un `npm install` de rutina nunca la sube sola; y no hay
ningún job de CI que corra `npm audit` en `appfrontend-main` (el
`.github/` del repo no tiene un workflow que lo haga — verificado). La
combinación "pin exacto + sin auditoría automática" hace que el drift de
seguridad sea invisible hasta que alguien lo mire a mano, que es
exactamente lo que pasó acá.
Nivel de certeza: Alta para la versión instalada, para los advisories y
para el rango afectado (los tres son lectura directa de la salida de
`npm audit` y del `package.json` real). HIPÓTESIS_A_CONFIRMAR para la
explotabilidad concreta en ESTE despliegue: exige (a) saber si el
frontend corre sobre Windows —no lo hace, por descarte razonable, pero no
se verificó el runtime real— y (b) para el vector AVIF, encontrar una
respuesta alcanzable desde `/_next/image?url=/...` que devuelva bytes
controlados por el atacante. Ninguna de las dos se probó, y deliberadamente
no se construyó ningún payload.
Severidad: **Crítica**.
Recomendación: subir `next` a `>=16.3.3` (el fix disponible es `16.3.5`,
no semver-major) y `sharp` a `>=0.35.4`, en un bloque propio, chico y
reversible, con `npm run build` + la suite de tests del frontend como
evidencia. Independientemente del bump: evaluar `images: { unoptimized:
true }` o `localPatterns: []` mientras ninguna pantalla use `next/image`
— hoy el endpoint está expuesto sin que ninguna funcionalidad lo
necesite, que es superficie gratis. Y sumar `npm audit --omit=dev
--audit-level=high` al CI de los DOS repos, que es lo que convierte esto
en un hallazgo detectable sin auditoría manual.
¿Requiere modificar código?: Sí — `package.json` + lockfile del frontend.
No toca código de aplicación. Es el cambio de menor radio y mayor
retorno de toda la auditoría.
Prueba necesaria: `npm audit --omit=dev` post-bump debe devolver 0
critical y 0 high; `npm run build` verde; smoke test del login y del
dashboard. Si se decide `unoptimized: true`, verificar que ninguna
pantalla rompa (hoy, 0 usos de `next/image` → ninguna debería).
```

### F9-02 — Cada request loguea el token de sesión, la cookie y la query string con PII; el mismo canal lleva el token de SUPERADMIN

```text
Hallazgo: reconfirma F8-10 y le suma dos superficies que Fase 8 no
nombró. `app.ts:146` monta `pinoHttp({ logger })` sin `redact` y sin
serializers propios, y `logger.ts:24-32` tampoco los define. El
serializer `req` por defecto de pino-http emite `headers` COMPLETO y
`url` COMPLETA. Consecuencias: (i) el header `Authorization: Bearer
<jwt>` y la cookie `rh_token`/`rh_customer_token` quedan en el log de
CADA request — ya reproducido en Fase 8; (ii) `pinoHttp` está montado en
la línea 146, ANTES de todos los mounts, así que también captura el
Bearer de SUPERADMIN de `/platform/*` y de `/api/admin/*`, que es la
credencial más poderosa del sistema (ve todos los negocios, puede
reapuntar la BD de cualquier tenant); (iii) `req.url` incluye la query
string, y `GET /api/customers?email=...&name=...` sigue aceptando PII por
query — el propio repo lo declara como deuda conocida en
`error.middleware.ts:80-84` (A7.2) y ya movió `search` al body de
`POST /customers/search` por este exacto motivo, pero dejó `email` y
`name` donde estaban.
Evidencia: src/app.ts:146 (`app.use(pinoHttp({ logger }))`, sin
opciones) · src/logger.ts:24-32 (`pino({ level })`, sin `redact`) ·
src/clientes-finanzas/customers.routes.ts:531-548 (`GET /` lee `email` y
`name` de `req.query`) · :549-551 (el comentario que declara la mitad ya
resuelta: *"`search` (nombre O email) YA NO va acá — ver POST
/customers/search (A7.2, 23/08/2026: era PII viajando en query
string)"*) · src/api/middleware/error.middleware.ts:79-84 (la política
MID-LOG-001 corta la query string en ESE log —`req.originalUrl.split('?')[0]`—
y declara el motivo, pero no puede hacer nada con la línea que pino-http
ya emitió) · familia relacionada: F8-06 (connection string de Neon con
contraseña en el mensaje de error, logueado entero por
`business.routes.ts:183` y `error.middleware.ts:115`).
Reproducción (servidor express efímero, valores ficticios):
  req.url     = /api/customers?email=juan.perez%40ejemplo.test&name=Juan%20Perez
  req.headers = {"authorization":"Bearer TOKEN_FICTICIO_AAA",
                 "cookie":"rh_token=COOKIE_FICTICIA_BBB", ...}
  req.id      = 1
(los valores son inventados a propósito; la estructura es la real).
Impacto: cualquiera con acceso de lectura a los logs del servicio —
consola de Render, agregador, un volcado de soporte, un ticket con logs
pegados — obtiene credenciales de sesión reutilizables hasta su `exp`
(24h por defecto para staff, 8h para superadmin) y, con F9-03 encima,
renovables sin límite. No hay rotación, no hay revocación, no hay TTL de
retención declarado para los logs. El vector de PII es distinto y también
real: email y nombre completo de clientes finales quedan en texto plano
en un canal que no está pensado para datos personales.
Causa probable: `pinoHttp({ logger })` es el snippet canónico de la
documentación y funciona perfecto; que el default serialice headers
completos no es evidente hasta que alguien mira una línea real. La
política de logging del repo (MID-LOG-001) se escribió para el
`errorHandler` —donde sí es ejemplar, con "NUNCA `err.message`"
explícito— y nunca se extendió al middleware que loguea el 100% del
tráfico.
Nivel de certeza: Alta. Reproducido en esta fase y en la anterior, con
dos bancos de prueba independientes.
Severidad: Alta.
Recomendación: (1) `redact` en `logger.ts` —un solo lugar, cubre
`pinoHttp` y las 98 llamadas a `logger.*`— con al menos
`req.headers.authorization`, `req.headers.cookie`, `res.headers["set-cookie"]`
y `err.message` de la familia `NeonProvisioningError` (esto último cierra
F8-06 de paso); (2) un `serializers.req` propio que emita
`url.split('?')[0]` en vez de la URL completa, mismo criterio que ya usa
MID-LOG-001 — no hace falta inventarlo, hay precedente en el repo;
(3) aparte y como decisión de producto, mover `email`/`name` de
`GET /api/customers` al body (`POST /customers/search` ya es el molde),
que es lo único que saca la PII del canal de forma definitiva. (1) y (2)
no cambian comportamiento de producto; (3) es un cambio de contrato y
toca el frontend.
¿Requiere modificar código?: Sí. (1) y (2) son ~10 líneas en un archivo.
Prueba necesaria: test que monte `pinoHttp` con el logger real contra un
stream en memoria, mande un request con `authorization`, `cookie` y query
string, y asere que la línea emitida NO contiene ninguno de los tres
valores. Hoy ese test falla.
```

### F9-03 — No existe ningún mecanismo de revocación de sesión: ni el cambio de contraseña, ni el borrado de cuenta, ni un token robado cierran la sesión, y `/refresh` la renueva sin tope

```text
Hallazgo: los JWT del sistema son stateless puros — sin `jti`, sin
versión de token, sin denylist, sin tabla de sesiones. La única
revocación que existe es indirecta y solo para staff: `authenticate()`
resuelve `memberships.active` + `permissionGroups` en cada request
(`app.ts:319-321`), así que desactivar una membership corta el acceso.
Todo lo demás queda sin cerrar:
 (a) `POST /api/password-resets/accept` cambia el `password_hash` y NO
     invalida nada — un atacante que ya tenga el token de la víctima
     conserva el acceso completo después del reseteo, que es justamente
     el escenario para el que uno resetea la contraseña;
 (b) `DELETE /api/customer/me` anonimiza la fila (`password_hash = NULL`,
     PII reemplazada) pero el JWT emitido antes sigue siendo válido: el
     `authenticate()` del portal no consulta la BD y `authorize(CUSTOMER_ONLY)`
     se resuelve contra una lista fija en código;
 (c) `POST /api/customer/refresh` re-firma el token leyendo ÚNICAMENTE
     `req.user` (sin tocar la BD, por diseño declarado), así que una
     cuenta ya "eliminada" puede renovar su sesión indefinidamente;
 (d) `POST /api/auth/refresh` (staff) sí queda acotado por la membership,
     pero tampoco tiene vida absoluta: mientras la membership esté activa,
     un token robado se renueva para siempre en ciclos de 24h.
Evidencia: src/security/auth.middleware.ts:126-161 (`verifyToken` valida
firma y `exp`, nada más; el payload no tiene `jti`) · :69-86 (`JwtPayload`
sin identificador de sesión) · :327-344 (la resolución de membership se
SALTEA para `role === CUSTOMER`) · src/usuarios-roles/password-reset.routes.ts:200-220
(`accept`: `updateIdentityPassword` + `markPasswordResetTokenUsed`, y
nada más) · src/api/routes/customer.routes.ts:636-655 (`refresh`: lee
`req.user.customerId`/`businessId`, firma con `signToken`, devuelve; cero
consultas) · :660-688 (`DELETE /me` → `customerRepo.anonymize`) ·
src/clientes-finanzas/sql.customer.repository.ts:271-296 (`anonymize`:
`password_hash = NULL`, `display_name = '[eliminado]'`; la fila sigue
existiendo y `getById` la sigue devolviendo) ·
src/api/routes/me.routes.ts:86-95 (`refresh` de staff) ·
src/security/auth.service.ts:222-229 (`refreshTenantToken`, con el
docblock que declara por qué no reconsulta: *"authenticate() ya confirmó,
para ESTA request, que la membership sigue activa"* — correcto para el
caso que cubre, mudo sobre el resto) · contraste: la suite
`src/tests/security/customer.delete.account.test.ts` (6 tests, verdes)
cubre "el login con las credenciales originales falla" y "el email queda
libre", pero NINGUNO cubre "un token emitido antes del borrado deja de
funcionar".
Impacto: la operación que un usuario ejecuta para RECUPERAR una cuenta
comprometida (cambiar la contraseña) no expulsa al atacante. Y una cuenta
de cliente borrada por pedido del titular —el caso de uso GDPR que
`anonymize()` implementa— conserva una sesión viva que puede crear
reservas, ver su propia información anonimizada y renovarse sola. La
anonimización de datos sin revocación de sesión cumple la mitad de la
promesa.
Causa probable: el modelo stateless se eligió temprano y funciona bien
para el caso de staff, donde `resolveMembershipContext` cubre el 90% de
lo que uno querría revocar. El portal de clientes se construyó después,
con un `authenticate()` sin ese hook —decisión declarada en el propio
docblock (*"la revocación de clientes es un caso distinto ... y queda
fuera de este cambio"*)— y el `refresh` se agregó para resolver un
problema de UX real (sesiones de 24h fijas) sin que nadie volviera sobre
el supuesto de revocación.
Nivel de certeza: Alta para (a), (c) y (d): lectura directa del código,
sin ambigüedad. Alta para (b) en cuanto al mecanismo; HIPÓTESIS_A_CONFIRMAR
para el alcance exacto de lo que un token post-borrado puede HACER (p. ej.
si `POST /me/reservations` prospera con un customer anonimizado depende de
validaciones del `ReservationService` que no se recorrieron en esta fase).
`No confirmado.` `Información faltante: qué rutas del portal siguen
operando con un customer en estado anonimizado.` `Cómo verificarlo: test
de integración que anonimice y después ejercite las 6 rutas de /me/* con
el token previo.`
Severidad: Alta.
Recomendación: tres opciones, de menor a mayor radio, ninguna elegida
acá. (A) Mínimo y de radio chico: agregar un `token_version` entero a
`identities` y a `customers`, embeberlo en el JWT y compararlo en
`authenticate()` — el reseteo de contraseña y el borrado de cuenta lo
incrementan. Cierra (a), (b) y (c) con una columna y dos líneas de
comparación. (B) Chequeo de existencia/estado del customer en el
`authenticate()` del portal, simétrico al `resolveMembershipContext` de
staff — cierra (b) y (c), no (a), y agrega una consulta por request al
portal. (C) Vida absoluta de sesión: un claim `sid_iat` que `refresh`
propaga sin renovar, con tope (p. ej. 7 días) — cierra (d) y acota el
daño de cualquier robo, en los cuatro casos. (A) y (C) son ortogonales y
se complementan. La elección de la vida absoluta es una decisión de
producto (frica con "el recepcionista no quiere volver a loguearse en
medio del turno", que es literalmente lo que motivó `/refresh`).
¿Requiere modificar código?: Sí. No implementado.
Prueba necesaria: por caso — (a) test que resetee la contraseña y asere
que el token anterior recibe 401; (b)/(c) test de integración que
anonimice y asere 401 tanto en `GET /me` como en `POST /refresh`;
(d) test que asere que `refresh` deja de renovar pasado el tope absoluto.
Los cuatro fallan hoy.
```

### F9-04 — `POST /register` aprovisiona un branch de Neon, es público, y su limiter no cuenta los registros exitosos: el techo real es el global de 500/min/IP

```text
Hallazgo: `authLimiter` está configurado con `skipSuccessfulRequests:
true` (`rate-limit.middleware.ts:75`). La implementación de
express-rate-limit@7.5.1 incrementa el contador al entrar y lo
DECREMENTA en el evento `finish` si `requestWasSuccessful` —cuyo default
es `statusCode < 400`— devuelve true. Consecuencia: en un endpoint cuyo
camino de ÉXITO es el abuso, el limiter no acumula nada. Dos rutas están
exactamente en ese caso:
 (i) `POST /register` (público, sin captcha, sin verificación de email)
     responde 201 y en ese mismo handler llama a `provisionTenantDatabase()`,
     que crea un branch de Neon con compute endpoint propio y aplica
     `schema.sql` completo. Cada 201 cuesta infraestructura facturable y
     deja un tenant real en la plataforma;
 (ii) `POST /api/password-resets/request` responde 200 SIEMPRE, por
     diseño anti-enumeración (`GENERIC_REQUEST_RESPONSE`), y en el camino
     manda un mail vía Resend. Nunca devuelve 4xx, así que nunca acumula.
En los dos casos el único techo que queda en pie es `globalLimiter`
(500 req/min/IP, `app.ts:156`).
Evidencia: src/api/middleware/rate-limit.middleware.ts:70-78 (`authLimiter`
con `skipSuccessfulRequests: true` y el comentario que explica la
intención —"Reduce el riesgo de bloquear a usuarios legítimos con
contraseña correcta"—, correcta para `/api/login`, no para las otras
dos) · node_modules/express-rate-limit/dist/index.cjs:652-653
(`skipSuccessfulRequests: false`, `requestWasSuccessful: (_request,
response) => response.statusCode < 400`) y :792-797 (el `response.on
("finish")` que llama `store.decrement(key)`) · src/app.ts:271
(`app.use('/register', ...helmetApi, authLimiter, createBusinessRouter(...))`) ·
:309 (`app.use('/api/password-resets', authLimiter, ...)`) ·
src/platform/business.routes.ts:99-103 (el handler es `router.post('/')`,
sin ninguna autenticación) · :174-184 (`provisionTenantDatabase()` +
`applyTenantSchema()` + `activateBusiness()` dentro del request) ·
src/platform/neon-provisioning.ts:104-141 (dos llamadas a la API de Neon;
la primera crea `branch` + `endpoints: [{type: 'read_write'}]`) ·
src/usuarios-roles/password-reset.routes.ts:93-95 y :162 (la respuesta
genérica 200 incondicional) · :156 (`sendPasswordResetEmail`) · nota de
mecanismo: `authLimiter` es **una sola instancia de módulo** compartida
por las tres rutas, así que comparten contador por IP.
Impacto: (i) agotamiento de recursos y de costo con amplificación real —
una sola IP puede disparar cientos de aprovisionamientos de Neon por
minuto, cada uno con su compute endpoint; el techo de plan de Neon o la
factura son el límite práctico, no la aplicación. Además deja basura
estructural: negocios, identities y memberships reales en la BD de
plataforma, sin forma de distinguirlos de altas legítimas (y, si el
aprovisionamiento falla a mitad, los estados intermedios de F8-05).
(ii) bombardeo de mails hacia una víctima elegida y consumo de la cuota
de Resend, que es infraestructura compartida de la plataforma
(A2.9: una sola `RESEND_API_KEY` para todos los tenants) — agotarla deja
sin mail transaccional a TODOS los negocios.
Causa probable: `skipSuccessfulRequests` se eligió pensando en el
endpoint de login, donde "éxito" significa "usuario legítimo" y saltearlo
es correcto. Al reusar la MISMA instancia de limiter en dos rutas con
semántica opuesta —donde el éxito es precisamente lo que hay que
limitar— la opción se invirtió de protección a agujero, sin que nada lo
señalara: el comentario del archivo sigue describiendo el caso de login.
Nivel de certeza: Alta para el mecanismo: la opción está en el código, su
implementación se leyó en el paquete instalado (7.5.1), y el montaje de
las dos rutas es lectura directa de `app.ts`. HIPÓTESIS_A_CONFIRMAR para
el volumen exacto sostenible contra Neon: depende del rate limit de la
API de Neon y del plan contratado, que no se consultaron.
`No confirmado.` `Información faltante: el techo de creación de branches
por minuto de la API de Neon para el proyecto ancient-king-17098519.`
`Cómo verificarlo: doc de límites de la API de Neon para el plan
contratado, o la propia respuesta 429 del endpoint POST /projects/{id}/branches.`
Severidad: Alta.
Recomendación: separar los limiters por semántica en vez de reusar uno.
(1) Un `registrationLimiter` propio para `/register`, SIN
`skipSuccessfulRequests` y con un techo bajo (el precedente está en el
repo: `registerLimiter` de `customer.routes.ts:144-156` es 5/15min y
tampoco saltea éxitos). (2) Lo mismo para `/api/password-resets/request`
— y, además, un límite por EMAIL destino, no solo por IP, que es lo único
que corta el bombardeo desde IPs rotativas. (3) Dejar `authLimiter` como
está para `/api/login`, donde la opción sí es correcta. Ninguna de las
tres cambia comportamiento para un usuario legítimo. Aparte, y como
decisión de producto: si `/register` debe seguir siendo autoservicio sin
verificación de email es una pregunta de negocio, no técnica — hoy
cualquiera puede crear un tenant con un email que no controla.
¿Requiere modificar código?: Sí, (1)-(3) son ~20 líneas en dos archivos
y ningún cambio de contrato. La pregunta de la verificación de email es
decisión del dueño.
Prueba necesaria: test de integración que dispare 20 `POST /register`
exitosos consecutivos desde la misma IP contra la app real con un doble
de `provisionTenantDatabase`, y asere que a partir del N-ésimo la
respuesta es 429. Hoy los 20 devuelven 201.
```

### F9-05 — Cualquier MANAGEMENT puede vincular su negocio a la empresa de otra organización conociendo su UUID, sin consentimiento, y el worker le propaga el catálogo ajeno

```text
Hallazgo: `POST /api/companies/link` toma un `companyId` del body,
verifica ÚNICAMENTE que la empresa exista, y ejecuta
`linkBusinessToCompany(businessId, company.id)`. No hay ninguna
verificación del lado de la empresa destino: ni invitación previa, ni
aprobación, ni token de vínculo, ni notificación. El `companyId` funciona
como una capacidad portadora ("quien conoce el UUID, entra"), pero sin
las propiedades que hacen segura a una capacidad: no se puede revocar
desde el producto (no hay endpoint de desvínculo en este router), no
caduca, y no hay forma de enumerar quién la usó. Y el vínculo no es
inerte: `CompanyCatalogPropagationWorker` propaga el catálogo compartido
desde la BD central hacia CADA negocio miembro, así que vincularse
significa recibir productos, precios y recetas de la organización ajena
en la propia tenant DB.
Evidencia: src/platform/companies.routes.ts:82-99 (el handler completo:
`LinkCompanySchema.parse` → `findCompanyById` → 404 si no existe →
`linkBusinessToCompany` → 204. No hay más chequeos) · :46
(`LinkCompanySchema = z.object({ companyId: z.string().min(1) })`) ·
:1-11 (el docblock razona correctamente sobre la dirección OPUESTA
—"nunca un businessId arbitrario del body ... así ningún MANAGEMENT de un
negocio puede vincular/desvincular OTRO negocio"— y da por resuelto el
lado del `companyId` con la frase *"con el `companyId` compartido fuera
de banda"*, que describe cómo se espera que se use, no una restricción
que el código imponga) · :16-21 (el propio archivo ya identificó que
`linkBusinessToCompany` *"simplemente sobreescribe company_id, no hay
confirmación en el medio"*, pero por el riesgo de que el PROPIO negocio
se desvincule sin darse cuenta — el riesgo del lado de la empresa
destino no está considerado) · src/platform/company-sync.worker.ts:1-11
(la dirección de la propagación: *"BD central → cada sucursal hermana"*,
"por cada fila pendiente, se conecta a un tenant DISTINTO (el
`target_business_id` de esa fila) — decripta su connection string, aplica
el cambio") · src/app.ts:329 (montado antes de `tenantMiddleware`: opera
solo contra la BD de plataforma) · gates existentes:
`authorize(Roles.MANAGEMENT)` + `requirePlan(container,
BusinessPlan.ENTERPRISE)` — o sea, el atacante necesita ser MANAGEMENT
de un negocio con plan ENTERPRISE, no un anónimo.
Impacto: divulgación de datos comerciales entre organizaciones distintas
—catálogo, precios y recetas de la empresa víctima llegan a la base de un
tercero— por un camino que el aislamiento estructural de "una BD por
tenant" no cubre, porque el cruce lo hace un worker con credenciales de
plataforma, no una consulta. La víctima no recibe ninguna señal: el
vínculo se escribe en la BD central y la única forma de detectarlo es
mirar `businesses.company_id` a mano. Es, además, un cambio de estado
sobre una entidad ajena que nadie audita del lado de la empresa.
Causa probable: el diseño de empresas multipropiedad resolvió con
cuidado la dirección "no tocar OTRO negocio" —que era el vector obvio— y
trató el `companyId` como un dato que solo circula dentro de la
organización. Es un supuesto razonable sobre cómo se usa el producto, y
la brecha aparece cuando ese supuesto se escribe en un comentario en vez
de en un guard: no hay nada en el código que impida presentar un
`companyId` obtenido por cualquier otra vía.
Nivel de certeza: Alta para el camino de código (los tres archivos están
leídos completos y el handler tiene 18 líneas). HIPÓTESIS_A_CONFIRMAR
para la explotabilidad práctica, que depende de cómo se genere el
`companyId`: si es un UUIDv4, adivinarlo no es viable y el vector real
es la FILTRACIÓN del id (aparece en `GET /api/companies/me` para
cualquier MANAGEMENT del grupo, incluida una sucursal que se dé de baja,
y probablemente en la UI). `No confirmado.` `Información faltante: cómo
genera el id CompanyRepository.createCompany() y si el id aparece en
alguna respuesta o pantalla accesible a alguien fuera del grupo.`
`Cómo verificarlo: leer createCompany() en src/platform/company.repository.ts
y grepear el frontend por companyId en pantallas renderizadas.`
Severidad: Alta.
Recomendación: dos formas, ninguna elegida acá. (A) Invitación explícita:
la empresa emite un token de vínculo de un solo uso y con vencimiento
(el repo ya tiene el molde exacto dos veces —`invitation-token.ts` y
`password-reset-token.ts`: 32 bytes aleatorios, se persiste solo el
sha256— así que no hay mecanismo nuevo que inventar). (B) Aprobación en
dos pasos: el negocio SOLICITA el vínculo, un MANAGEMENT de un negocio ya
miembro lo aprueba; el estado intermedio queda visible para las dos
partes. (A) preserva el flujo actual de "se comparte un dato fuera de
banda" y solo lo vuelve seguro; (B) cambia el flujo y agrega una
pantalla. En cualquiera de las dos: auditar el vínculo del lado de la
empresa, y proveer un desvínculo operable. La elección es del dueño del
dominio — toca el modelo de multipropiedad, no solo el guard.
¿Requiere modificar código?: Sí. No implementado.
Prueba necesaria: test de integración con dos negocios de dos empresas
distintas donde el MANAGEMENT del negocio B llama a `POST /api/companies/link`
con el `companyId` de la empresa A, aserando que la respuesta es 403/404
y que `businesses.company_id` de B no cambió. Hoy devuelve 204 y cambia.
```

### F9-06 — El token de sesión viaja también en el body de la respuesta y una pantalla del frontend lo persiste en `localStorage`: la cookie `httpOnly` no aporta protección contra XSS

```text
Hallazgo: las cinco rutas que emiten sesión setean la cookie httpOnly Y
devuelven el mismo JWT en el body de la respuesta — coexistencia
declarada a propósito en los docblocks ("coexistencia, no reemplazo").
Mientras el valor esté disponible para JavaScript, el atributo `httpOnly`
no protege de nada: un XSS en el origen del frontend lee la respuesta de
`/api/auth/refresh` (que el `AuthContext` llama periódicamente) y obtiene
un token de 24h. Y no es teórico: `appfrontend-main/src/app/admin/page.tsx`
—una consola de API con 14 bloques, incluida `POST /api/login`— guarda
explícitamente el token del body en `localStorage.setItem('token', t)`.
Esa página se compila y se sirve en producción como cualquier otra ruta
de la app, y no tiene guard de servidor: su único chequeo es un
`useEffect` que redirige si no encuentra la clave en `localStorage`.
Evidencia: src/api/routes/auth.routes.ts:178+182, :228-229, :273-276
(los tres logins: `setAuthCookie(res, result.token, ...)` seguido de
`res.status(200).json(result)`, donde `result` incluye `token`) ·
src/security/auth.service.ts:238-254 (`LoginResult` lleva `token`) ·
src/api/routes/me.routes.ts:86-95 (`POST /api/auth/refresh`: cookie +
`res.status(200).json(result)` con el token) ·
src/api/routes/customer.routes.ts:389-396, :424-430, :461-467, :652-653
(las cuatro del portal, mismo patrón) ·
src/platform/business.routes.ts:201+211-218 (`/register`, ídem) ·
appfrontend-main/src/app/admin/page.tsx:110 (`onToken={t => {
localStorage.setItem('token', t); ... }}` colgado del bloque `POST
/api/login`) · :24-25 (el único guard: `const token =
localStorage.getItem('token'); if (!token) router.replace('/login')`) ·
:34 (`localStorage.removeItem('token')` en el logout) ·
appfrontend-main/src/components/ApiBlock.tsx:52-60 (usa `apiFetch`, o
sea la cookie — el token de `localStorage` ya NO se usa para autenticar:
queda guardado sin cumplir ninguna función) · contraste: el resto de la
app migró bien —`src/lib/http.ts:113-122` usa `credentials:'include'` y
`AuthContext.tsx:6` documenta que el token salió de `localStorage` el
13/08/2026— y el portal de clientes hizo lo mismo el 19/08/2026
(`CustomerAuthContext.tsx:8`). La página `/admin` quedó atrás ·
relacionado: `PlatformAuthContext.tsx:26-32,62` guarda el token de
SUPERADMIN en `sessionStorage` — decisión razonada y declarada (alcance
de pestaña, TTL de 8h), pero sigue siendo almacenamiento legible por JS
para la credencial más poderosa del sistema.
Impacto: la migración a cookie httpOnly —un bloque de trabajo real
(B2, 13/08/2026)— no rinde su beneficio principal: un XSS en el origen
del frontend sigue pudiendo exfiltrar una sesión válida, por dos vías
distintas (la respuesta de `/refresh` y la clave `'token'` que la página
`/admin` dejó guardada). El segundo vector es además persistente:
sobrevive al cierre del navegador y no se limpia con el logout normal del
dashboard (solo el logout de `/admin` lo borra).
Causa probable: la coexistencia body+cookie se eligió a propósito para no
romper consumidores que leían el token del body (apps, Postman, la doc de
Swagger) durante la transición, y está bien documentada. Lo que no ocurrió
es el cierre de esa transición: no hay fecha, no hay ítem que la reclame,
y la página `/admin` —una herramienta interna de pruebas anterior a todo
esto— quedó fuera del barrido de las dos migraciones.
Nivel de certeza: Alta. Las cinco rutas del backend y las dos líneas del
frontend son lectura directa.
Severidad: Media-Alta. No es explotable por sí sola: necesita un XSS, y
el frontend hoy no tiene ninguno conocido (0 `dangerouslySetInnerHTML`).
Lo que hace es anular la mitigación que existía justamente para ese caso.
Recomendación: tres piezas independientes. (1) Sacar el
`localStorage.setItem('token', ...)` de `admin/page.tsx` — es un
remanente sin función, el componente ya autentica por cookie. Radio
mínimo, sin decisión de negocio. (2) Evaluar si la página `/admin`
—consola de API con 14 endpoints, incluido el login— debe seguir
existiendo en el bundle de producción; el precedente está en el propio
repo: `docs-exposure.ts` decidió exactamente esto para `/docs` y dejó
escrito el razonamiento (404, no 401; sin variable de override). (3)
Cerrar la coexistencia: dejar de devolver `token` en el body de las cinco
rutas, o —si algún consumidor todavía lo necesita— declarar cuál y
ponerle fecha. (3) es un cambio de contrato entre los dos repos y
requiere confirmar quién lee ese campo hoy.
¿Requiere modificar código?: Sí para (1) y (3). (2) es una decisión de
producto antes que un cambio.
Prueba necesaria: (1) grep de `localStorage` en `appfrontend/src` debe
quedar sin la clave `'token'`. (3) test de ruta que asere que el body de
`POST /api/login` NO contiene `token` y que el `Set-Cookie` sí está;
más una verificación manual de que el dashboard, el portal y `/registro`
siguen logueando.
```

### F9-07 — El frontend —el origen donde vive la cookie de sesión y donde se renderiza HTML— no emite ningún header de seguridad

```text
Hallazgo: `appfrontend-main` no configura **ningún** header de
seguridad. No hay `headers()` en `next.config.js`, no hay `middleware.ts`,
no hay `vercel.json`. El resultado es que el origen que renderiza HTML,
ejecuta JavaScript y porta la cookie de sesión del staff sirve sus
páginas sin `Content-Security-Policy`, sin `X-Frame-Options`/
`frame-ancestors`, sin `Strict-Transport-Security` propio y sin
`Referrer-Policy`. La asimetría es el punto: el backend —que devuelve
JSON y es la superficie MENOS expuesta a XSS y clickjacking— tiene una
configuración de helmet cuidada, documentada en una tabla, con CSP
`default-src 'none'` y `frame-ancestors 'none'`.
Evidencia: appfrontend-main/next.config.js (archivo completo: solo
`rewrites()`, ningún `headers()`) · `ls -a` de la raíz del repo: no hay
`vercel.json`; `ls src/middleware.ts middleware.ts` → no existen ·
`grep -rn "headers()\|Content-Security-Policy\|X-Frame-Options\|Strict-Transport"`
sobre `.js/.ts/.tsx/.json` excluyendo `node_modules` y `.next` → **0
coincidencias** · contraste: app-main/src/api/middleware/helmet.middleware.ts:14-25
(la tabla de headers con el "protege contra" de cada uno) y :110-115
(`defaultSrc: ["'none'"]`, `frameAncestors: ["'none'"]` para `/api`) ·
appfrontend-main/next.config.js:1-12 (la razón por la que la cookie del
backend termina asociada al dominio del FRONTEND: el rewrite same-origin) ·
`grep -rn "dangerouslySetInnerHTML" src` → 0 (no hay un XSS conocido hoy;
esto es ausencia de defensa en profundidad, no un bug activo).
Impacto: el dashboard es embebible en un iframe de cualquier origen
(clickjacking sobre acciones destructivas: cancelar, eliminar, emitir
Nota de Crédito), y cualquier XSS futuro —una dependencia comprometida,
un render de dato sin escapar— corre sin ninguna restricción de origen
para exfiltrar. Con F9-06 encima, lo que exfiltra es una sesión válida
y renovable.
Causa probable: `create-next-app` no genera headers de seguridad y Next
no los aplica por defecto, así que su ausencia no produce ningún síntoma
ni aparece en ningún linter. El esfuerzo de seguridad del proyecto se
concentró donde había un archivo que escribir (`helmet.middleware.ts` en
el backend); en el frontend no había archivo, así que no hubo momento en
el que alguien decidiera no ponerlos.
Nivel de certeza: Alta para la ausencia (tres búsquedas independientes:
grep por contenido, listado de la raíz, chequeo de `middleware.ts`).
HIPÓTESIS_A_CONFIRMAR para qué headers agrega la plataforma de hosting
por su cuenta: Vercel y Render agregan algunos (HSTS, entre otros) sin
que el proyecto los declare. `No confirmado.` `Información faltante: los
headers de respuesta reales del frontend en producción.`
`Cómo verificarlo: curl -sI https://<dominio-del-frontend>/dashboard y
mirar la lista real; es una verificación de un minuto y cierra el
hallazgo en cualquiera de las dos direcciones.`
Severidad: Media-Alta.
Recomendación: un bloque `headers()` en `next.config.js` con, como
mínimo, `X-Frame-Options: DENY` (o `frame-ancestors 'none'` vía CSP),
`Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` y
`Strict-Transport-Security`. La CSP completa merece su propio bloque y
una medición previa (Next inyecta scripts inline; exige `nonce` o
`strict-dynamic`, y ponerla mal rompe la app entera) — no se propone
hacerla en el mismo paso. Reusar la tabla de `helmet.middleware.ts` como
referencia: el criterio ya está escrito y razonado en el otro repo.
¿Requiere modificar código?: Sí, un archivo del frontend. La parte no-CSP
no cambia comportamiento; la CSP sí y requiere su propia verificación.
Prueba necesaria: `curl -sI` sobre el frontend desplegado mostrando los
headers presentes; y, para la CSP, recorrer manualmente el dashboard con
la consola abierta verificando que no haya violaciones bloqueantes.
```

### F9-08 — `/api/customer/*` queda fuera del `helmetApi` que el comentario de `app.ts` afirma que lo cubre, y fuera del `apiLimiter`

```text
Hallazgo: `app.ts:280-282` dice, literalmente, *"13. helmetApi sobre todo
/api/* — cubre customer, admin y rutas de tenant"*. Es falso para
`customer`: el router del portal se monta en la línea **277**, ANTES del
`app.use('/api', ...helmetApi)` de la **282**. Express ejecuta los
middlewares en orden de registro, así que cuando el router del portal
responde, el `helmetApi` de la 282 nunca corre. Las respuestas del portal
de clientes salen sin `Content-Security-Policy` (sí conservan los headers
de `helmetBase` de la línea 151: HSTS, nosniff, X-Frame-Options,
Referrer-Policy, Permissions-Policy). El mismo orden deja al portal fuera
del `apiLimiter` (línea 352) y del `tenantMiddleware` (347) — esto
último es correcto y deliberado (el portal resuelve su propio tenant),
pero lo del limiter no está declarado en ninguna parte.
Evidencia: src/app.ts:274-277 (mount del portal) · :279-282 (el
comentario y el mount de helmetApi) · :284-293 (`/api/admin`, montado
DESPUÉS de la 282 — sí recibe helmetApi, o sea que de los tres que el
comentario nombra, dos son correctos y uno no) · :349-352 (`apiLimiter`) ·
el resto de los mounts pre-282 sí traen su helmet explícito: `:266`
(`/platform`, `...helmetApi`), `:271` (`/register`, `...helmetApi`),
`:272` (`/api/login`, `...helmetApi`) — el portal es el único que no ·
reproducción (app express mínima que replica el orden 151→277→282):
  POST /api/customer/mi-negocio/login → content-security-policy: (ausente)
  GET  /api/resources                 → content-security-policy: default-src 'none'; ... frame-ancestors 'none'; ...
Impacto: bajo por sí mismo —son respuestas JSON leídas por `fetch`, no
documentos que el navegador renderice— pero el portal de clientes es
justamente la superficie que un tercero no autenticado puede alcanzar con
un navegador (`register`, `login`, `availability` son públicas), y es la
única familia de rutas `/api/*` que perdió la capa. El impacto mayor es
de otro tipo: un comentario de arquitectura que afirma una cobertura que
no existe es exactamente el patrón que el repo ya nombró como
`SCHEMA-ANCHOR-DRIFT-001` — el siguiente que lea `app.ts` para saber qué
está protegido va a leer una afirmación falsa.
Causa probable: el portal se montó antes del gate de `/api` por una razón
correcta y declarada (no debe pasar por `authenticate()` de tenant ni por
`tenantMiddleware`), y el comentario del helmet se escribió describiendo
la intención del mount —"sobre todo /api/*"— sin recorrer qué queda
efectivamente antes. Es el mismo modo de falla que `CONTRACT-001`: una
afirmación sobre el montaje que ninguna cerca cruza contra el montaje
real.
Nivel de certeza: Alta. Orden leído en `app.ts` y semántica de Express
reproducida.
Severidad: Media.
Recomendación: mover `app.use('/api', ...helmetApi)` ANTES del mount del
portal (línea 277) — es un middleware puro de headers, no depende de
autenticación ni de tenant, así que adelantarlo no tiene otro efecto — o,
si se prefiere no tocar el orden, agregarle `...helmetApi` al mount del
portal como ya hacen `/platform`, `/register` y `/api/login`. En el mismo
cambio, corregir el comentario de :280-282. Y decidir, aparte, si el
portal debe tener su propio limiter para las rutas autenticadas (ver
F9-09). La cerca `api-auth-gate-order.test.ts` ya valida el orden del
gate de AUTENTICACIÓN; extenderla al orden de helmet es una opción de
bajo costo, no una obligación.
¿Requiere modificar código?: Sí, una línea de mount + un comentario.
Prueba necesaria: test de ruta (supertest) que asere que
`POST /api/customer/:slug/login` devuelve `content-security-policy` con
`default-src 'none'`. Hoy falla.
```

### F9-09 — Endpoint público sin autenticar que abre una consulta por recurso contra la tenant DB, con el único techo de 500 req/min/IP

```text
Hallazgo: `GET /api/customer/:businessSlug/availability` es público (se
monta antes del `authenticate()` de `/api`, y el `router.use(authenticate(),
authorize(CUSTOMER_ONLY))` del portal está registrado DESPUÉS de esta
ruta). Su handler trae TODOS los recursos del negocio y después lanza un
`Promise.all` con una consulta por recurso — un fan-out N+1 cuyo N lo
determina el catálogo del tenant, no el request. No tiene limiter
dedicado (los dos del archivo cubren `register` y `login`) y, por el
orden de montaje de F9-08, tampoco le llega el `apiLimiter`. El único
techo es `globalLimiter`: 500 req/min/IP. El mismo orden deja SIN limiter
dedicado a todas las rutas autenticadas del portal (`POST /me/reservations`
entre ellas) y a `/api/invitations/*`.
Evidencia: src/api/routes/customer.routes.ts:483-537 (la ruta) ·
:499-517 (`resourceRepo.getAll()` y después `Promise.all(allResources.map
(async (resource) => reservationRepo.getActiveForResourceInRange(...)))`) ·
:552 (`router.use(authenticate(), authorize(Roles.CUSTOMER_ONLY))`,
registrado 15 rutas más abajo — todo lo anterior es público) ·
:279-292 (`resolveTenantBySlug`: cada request hace `platformRepo.findBySlug`
y resuelve/crea el pool del tenant) · src/app.ts:277 vs :352 (el mount
del portal precede al `apiLimiter`) · :299 (`/api/invitations` sin
limiter propio) · src/platform/tenant.middleware.ts:103-109 (el pool por
tenant es `max: 5` conexiones) · contraste: el propio archivo SÍ le puso
limiter a las dos rutas que consideró sensibles (`registerLimiter` 5/15min,
`loginLimiter` 10/15min) — `availability` no entró en esa lista.
Impacto: amplificación — una request barata para el atacante se traduce
en 1 + N consultas contra un pool de 5 conexiones del tenant. Con
`globalLimiter` en 500/min/IP y un catálogo de tamaño medio, una sola IP
puede saturar el pool de un negocio elegido por su slug (que es público,
está en la URL del portal). Además paga compute de Neon en un endpoint
sin autenticar, y el slug permite dirigir el ataque a una víctima
concreta. El vector no es de confidencialidad ni integridad: es
disponibilidad y costo.
Causa probable: `availability` se escribió como consulta de lectura
inofensiva y su forma N+1 es un problema de performance que nadie
convirtió en pregunta de seguridad. El orden de montaje (F9-08) hizo el
resto: la ruta quedó fuera del limiter general de `/api` sin que la
decisión se tomara.
Nivel de certeza: Alta para el camino de código y para qué limiters
alcanzan la ruta (lectura directa del handler y del orden de `app.ts`).
HIPÓTESIS_A_CONFIRMAR para el umbral real de saturación: depende del N de
cada tenant y de la latencia de Neon. `No confirmado.` `Información
faltante: cuántos recursos tiene un tenant real y cuánto tarda
getActiveForResourceInRange bajo carga.` `Cómo verificarlo: autocannon
—ya está en devDependencies— contra el endpoint en un entorno no
productivo, midiendo latencia y errores de pool a 100/200/500 req/min.`
Severidad: Media.
Recomendación: (1) un limiter dedicado para las rutas públicas del
portal, con el mismo criterio con que ya existen `registerLimiter` y
`loginLimiter` en ese archivo; (2) reemplazar el fan-out por UNA consulta
con `resource_id = ANY($1)` —el repositorio ya usa ese patrón en otras
consultas— lo que convierte el N+1 en O(1) y elimina la amplificación en
la raíz; (3) como consecuencia de F9-08, revisar si el portal
autenticado debería recibir `apiLimiter` o uno propio. (2) es la que
cierra el problema; (1) es la mitigación inmediata.
¿Requiere modificar código?: Sí. Ninguna de las tres requiere decisión de
negocio.
Prueba necesaria: test que cuente las consultas emitidas por
`GET /availability` con un doble del repositorio y asere que es 2
(recursos + disponibilidad) y no 1+N; más una corrida de `autocannon`
antes y después sobre un tenant sembrado.
```

### F9-10 — `sslConfig()` desactiva TLS hacia Postgres en silencio si falta `NEON_SSL`, después de que `stripSslMode()` ya borró el `sslmode` de la URL

```text
Hallazgo: `sslConfig()` devuelve `{ rejectUnauthorized: true }` si
`NEON_SSL === 'true'` y **`false`** en cualquier otro caso — sin warning,
sin log, sin distinguir "la variable dice que no" de "la variable no
está". Y el valor no se usa solo: los tres pools del proceso (plataforma,
tenant y legado) lo consumen, y `stripSslMode()` elimina el `?sslmode=require`
de la connection string ANTES de crear el pool, así que tampoco queda la
defensa de la URL. El resultado de una variable ausente es una conexión a
Postgres en texto plano, con las credenciales de la base viajando sin
cifrar. `render.yaml` **sí** declara `NEON_SSL: "true"` con un comentario
que explica exactamente por qué, así que el despliegue de producción
actual está bien — el hallazgo es el default, no el estado de hoy.
Evidencia: src/db/pg.client.ts:67-71 (las 5 líneas de `sslConfig()`) ·
:90-98 (el pool legado la usa junto a `stripSslMode`) ·
src/platform/tenant.middleware.ts:99-109 (el pool de CADA tenant:
`stripSslMode(rawConnectionString)` + `ssl: sslConfig()`) ·
src/platform/company-sync.worker.ts:29 (el worker de propagación importa
las dos y abre conexiones de vida corta a cada tenant con el mismo
criterio) · render.yaml:44-47 (`NEON_SSL: "true"` con el comentario:
*"Sin esto, los pools caen a ssl:false ... No es un secreto, pero si
falta, el proceso no debe asumir un default en silencio"* — el comentario
ya declara el problema que el código no resuelve) ·
src/platform/tenant.middleware.ts:18-28 (el docblock cuenta que este
archivo YA tuvo su propia función con un fallback distinto
—`{ rejectUnauthorized: false }`, "vulnerable a MITM"— y que se unificó
acá; la unificación fue correcta, el default quedó) · el `CLAUDE.md` de
`app-main` ya lo tiene registrado como hallazgo abierto bajo
`honest-degradation`: *"cae a `ssl: false` en silencio (sin warn) si
falta `NEON_SSL` — eso es deuda, no una decisión"*.
Impacto: en el despliegue actual, ninguno — la variable está seteada.
El riesgo es de futuro y de segunda instancia: un servicio nuevo en
Render (worker, cron, entorno de staging), un `npm run migrate:tenants`
corrido desde una máquina sin esa variable, o un `.env` incompleto, se
conecta a las bases de producción sin TLS y sin que nada lo diga.
`migrate:tenants` corre en CADA build (`buildCommand` de `render.yaml`)
con `PLATFORM_DATABASE_URL` y escribe en todas las tenant DB — es
exactamente el tipo de camino donde un default silencioso duele.
Causa probable: `false` es el valor que hace andar Postgres local sin
certificado, así que como default de desarrollo es cómodo y correcto. Lo
que falta es la asimetría: el mismo default en producción debería ser
fail-loud, y el repo ya tiene el criterio escrito para otros subsistemas
(`migrate:tenants` que falla tumba el build; OAuth sin `GOOGLE_CLIENT_ID`
es fail-closed).
Nivel de certeza: Alta. Cinco líneas de código, tres call-sites y el
comentario de `render.yaml` que describe el mismo comportamiento.
Severidad: Media (Alta si alguna vez se despliega sin la variable).
Recomendación: hacer explícito el trío en vez de binario — `NEON_SSL`
ausente en `NODE_ENV === 'production'` debería lanzar al arrancar (mismo
criterio que `getJwtSecret()` y `deriveEncryptionKey()`, que ya validan y
fallan ruidosamente); ausente fuera de producción, `false` con un
`logger.warn` una sola vez. No requiere decisión de negocio: la
alternativa "seguir en silencio en producción" no es una postura que
alguien vaya a defender.
¿Requiere modificar código?: Sí, ~6 líneas en un archivo.
Prueba necesaria: test unitario de `sslConfig()` con las cuatro
combinaciones de `NODE_ENV` × `NEON_SSL` presente/ausente, aserando que
la combinación (production, ausente) lanza.
```

### F9-11 — Ningún evento de autenticación queda registrado: ni login exitoso, ni login fallido, ni logout dejan rastro en `audit_log` ni en el log estructurado

```text
Hallazgo: el repo tiene una infraestructura de auditoría de negocio
sólida —30 archivos escriben `audit_log` vía `updateWithAudit()`/
`recordFieldChanges()`, más `platform_audit_log` para el superadmin— y
cero cobertura del evento más básico de seguridad: quién entró, cuándo,
desde dónde, y quién lo intentó sin lograrlo. Los tres handlers de
`auth.routes.ts` no llaman a `logger` ni a ningún repositorio de
auditoría: en el camino de éxito responden 200 y en el de fallo responden
401 inline, sin pasar por `error.middleware.ts`. Y aunque pasaran, la
política MID-LOG-001 excluye a propósito todo lo que mapea a <409, o sea
también el 401. Mismo cuadro en el portal de clientes y en el login de
superadmin.
Evidencia: src/api/routes/auth.routes.ts — `grep -n "logger\.\|audit"`
sobre el archivo devuelve **0 coincidencias**; los handlers están en
:164-190 (login), :222-235 (select-business) y :265-285 (google), los
tres con `res.status(401).json(...)` inline en el catch ·
src/api/middleware/error.middleware.ts:95-106 (el `if (status >= 409)`
que deja el 401 fuera, con el motivo declarado: *"Los 4xx de cliente
rutinario (400 validación / 401 / 404 no-encontrado) NO se loguean — son
ruido de alto volumen"*) · src/api/routes/customer.routes.ts:431-440,
:468-477 (los dos logins del portal, mismo patrón) ·
src/platform/platform.auth.service.ts:110-114 (superadmin: lanza
`INVALID_CREDENTIALS` sin registrar nada) · contraste positivo:
:116-133 (`PLATFORM-AUDIT-ACTOR-STABLE-001` — el repo SÍ se ocupó de que
el `sub` del superadmin sea estable *"para que ninguna fila de auditoría
de un mismo superadmin"* quedara sin poder atribuirse; el razonamiento
está y llega hasta `platform_audit_log`, pero el evento de login en sí
sigue sin registrarse) · medición: `grep -rlE "updateWithAudit\(|
recordFieldChanges" src --include="*.ts" | grep -v test` → 30 archivos,
ninguno de autenticación.
Impacto: ante un incidente —una cuenta comprometida, un acceso indebido—
no hay forma de responder "¿cuándo entró?", "¿desde qué IP?", "¿hubo un
ataque de fuerza bruta antes?". La única señal de un ataque de
credenciales es el contador en memoria del `authLimiter`, que no persiste
nada y se reinicia con el proceso. Es también el prerrequisito faltante
de cualquier detección: sin el evento, no hay alerta posible. Y tiene
efecto directo sobre el ítem del protocolo "las acciones críticas sean
auditables": iniciar sesión es la acción crítica que habilita todas las
demás.
Causa probable: la auditoría del repo creció desde el lado del negocio
(A6.5: "una cancelación sin rastro no es aceptable") y su mecanismo
—`audit_log` con `entity`/`entity_id`/`field`/`old`/`new`— está modelado
para cambios de campo de una entidad, que es exactamente lo que un evento
de login no es. Sin un molde donde encajara, el evento nunca se escribió.
La exclusión del 401 en MID-LOG-001 es correcta para SU propósito (no
ahogar el canal de errores) y no pretendía cubrir esto.
Nivel de certeza: Alta. Ausencia verificada con búsqueda sobre los
archivos concretos, no inferida.
Severidad: Media.
Recomendación: dos opciones de ubicación, ninguna elegida acá. (A) Log
estructurado dedicado: un `logger.info({ evento: 'auth.login',
resultado, identityId, businessId, ip })` en los cinco handlers de login
—nunca el email ni la contraseña— reusando la clave `evento:` que
`outbox.handlers.ts` ya estableció como convención consultable. Barato,
sin schema nuevo, y suficiente para responder "cuándo y desde dónde" si
se corrige F9-02 primero (hoy ese log conviviría con líneas que ya
filtran el token). (B) Tabla propia de eventos de autenticación en la BD
de plataforma, durable y consultable desde el producto — más caro, y es
el único camino si el requisito es que el DUEÑO del negocio pueda ver los
accesos de su staff, que es una pregunta de producto, no técnica. El
orden importa: (A) no debería implementarse antes que el `redact` de
F9-02.
¿Requiere modificar código?: Sí. (A) es ~15 líneas en 3 archivos; (B) es
un bloque con migración. La elección entre las dos es del dueño.
Prueba necesaria: test de ruta que dispare un login exitoso y uno fallido
contra un logger de prueba, aserando que se emitió una línea por cada uno
con el resultado correcto y SIN el email ni la contraseña en el payload.
```

### F9-12 — `POST /api/password-resets/accept` hace dos escrituras sueltas: si la segunda falla, el token de reseteo queda reutilizable

```text
Hallazgo: el handler cambia la contraseña y marca el token como usado en
dos `await` consecutivos, sin transacción y sin compensación. Si
`markPasswordResetTokenUsed` falla —caída de la BD de plataforma, el
COMMIT ambiguo de F8-01— la contraseña YA cambió y el token sigue en
estado `PENDING`, dentro de su ventana de 24h, aceptado por
`findValidPendingToken()` en cualquier intento posterior. El token de
reseteo deja de ser de un solo uso exactamente en la ventana en la que su
portador tiene menos razones para ser de confianza.
Evidencia: src/usuarios-roles/password-reset.routes.ts:209-210
(`await platformRepo.updateIdentityPassword(...)` seguido de
`await platformRepo.markPasswordResetTokenUsed(...)`, sin
`runInTransaction`) · :172-178 (`findValidPendingToken`: el único
criterio es `status === 'PENDING'` y `expiresAt > now`) · :33
(`PASSWORD_RESET_EXPIRES_HOURS = 24`) · contraste dentro del mismo repo:
`platform.repository.ts` SÍ tiene `runInTransaction` y lo usa en otros
puntos (citado en F8-05 como :322-323), así que el mecanismo existe y no
se aplicó acá · familia: es el mismo patrón que F8-05 ya describió para
`activateBusiness` + `updateSchemaVersion`, y que F2-05 corrigió para
`SqlAfipCredentialsRepository` (UPDATE + DELETE ahora comparten `client`).
Impacto: acotado —exige que la segunda escritura falle en una ventana de
milisegundos— pero el efecto es un token de autenticación de un solo uso
que se vuelve multi-uso sin que nadie se entere. Combinado con F9-03 (el
reseteo no revoca sesiones), un atacante que obtenga el link puede
cambiar la contraseña más de una vez y mantener el acceso.
Causa probable: el mismo diagnóstico que F7-05 y F8-05 hicieron para
otras secuencias: dos escrituras que conceptualmente son una sola
operación, escritas como dos `await` porque el repositorio las expone
como dos métodos y no hubo un lugar que describiera la unidad.
Nivel de certeza: Alta para el código (dos líneas contiguas, leídas).
El disparo depende de un fallo de infraestructura, no de una acción del
atacante.
Severidad: Baja-Media.
Recomendación: envolver las dos escrituras en la `runInTransaction` que
`platform.repository.ts` ya tiene, o invertir el orden (marcar el token
usado ANTES de cambiar la contraseña) para que el fallo caiga del lado
seguro: un token quemado sin efecto es recuperable pidiendo otro; una
contraseña cambiada con el token vivo, no. La inversión es de una línea
y no necesita transacción; la transacción es más correcta. Ninguna
requiere decisión de negocio.
¿Requiere modificar código?: Sí, ~5 líneas en un archivo.
Prueba necesaria: test con un `platformRepo` doble cuyo
`markPasswordResetTokenUsed` lance, aserando que después del fallo el
mismo token NO es aceptado por un segundo `POST /accept`. Hoy sí lo es.
```

### F9-13 — `@xmldom/xmldom` con 4 advisories (una HIGH) en la cadena que firma los XML de AFIP

```text
Hallazgo: `npm audit --omit=dev` sobre `app-main` reporta
`@xmldom/xmldom` como HIGH, transitivo y de producción. La cadena es
`reservations-api → @arcasdk/core@2.0.0 → soap@1.10.0 → xml-crypto@6.1.2
→ @xmldom/xmldom@0.8.14`, o sea el parser/serializador de XML que usa la
librería de firma criptográfica con la que se habla con AFIP. Los
advisories son cuatro variantes del mismo tema —inyección que evade
`requireWellFormed` al serializar: fragmento XML vía `EntityReference.
nodeName` (GHSA-6gmq-8vp8-gcm6, moderate), Processing Instruction target
(GHSA-c7q8-3ch8-vqpv, high), DocType `name` (GHSA-27p8-2357-5qqv, high) y
un end tag mal formado que el parser acepta— todos con rango
`>=0.7.0 <=0.8.14`, que es exactamente la versión instalada.
Evidencia: `npm ls @xmldom/xmldom` → la cadena de 4 niveles citada arriba ·
`npm audit --omit=dev --json` → `@xmldom/xmldom`, `severity: "high"`,
`isDirect: false`, `range: "<=0.8.14"` · los 4 advisories con sus
`source`/`title`/`url`/`range` en la misma salida · el consumidor real en
este repo: `src/facturacion/arca-sdk-billing.adapter.ts` +
`afip-client.factory.ts` (el SDK de ARCA/AFIP) · contexto ya conocido del
repo: el `CLAUDE.md` declara bajo `dependency-provenance` que el build de
Render corre `npm install`, no `npm ci`, y que hay `patches/`
(patch-package) — o sea que la resolución exacta del árbol en producción
puede diferir de la del lockfile local.
Impacto: la superficie es el XML que el proceso serializa y firma para
AFIP, y el XML que recibe de vuelta. Los advisores son de inyección en la
SERIALIZACIÓN, así que el vector requiere que un dato controlable termine
dentro de un nodo XML que después se firme o se compare — plausible en un
comprobante (razón social, descripción de línea) pero no demostrado en
este código. Lo que sí es cierto y verificable es que la versión
instalada está dentro del rango afectado de cuatro advisories, una de
ellas HIGH, en el camino criptográfico de un circuito fiscal.
Causa probable: es una dependencia de cuarto nivel: subirla exige que
`xml-crypto`, `soap` y `@arcasdk/core` la suban, o un `overrides` en el
`package.json` propio. No hay `npm audit` en CI que lo levante.
Nivel de certeza: Alta para la versión, la cadena y los advisories
(lectura directa de `npm ls` y `npm audit`).
HIPÓTESIS_A_CONFIRMAR para la explotabilidad en este flujo concreto: no
se trazó qué campos del comprobante llegan al serializador ni si alguno
es controlable por un usuario del tenant. `No confirmado.`
`Información faltante: si algún string de origen de usuario (razón
social, descripción de línea, concepto) se serializa dentro del XML
firmado por xml-crypto.` `Cómo verificarlo: trazar el payload desde
InvoiceService.issue() hasta arca-sdk-billing.adapter.ts y ver qué campos
llegan al SDK sin sanitizar.`
Severidad: Media (Alta si la confirmación de arriba resulta afirmativa).
Recomendación: (1) verificar si `npm audit fix` resuelve sin romper —el
reporte no ofrece `fixAvailable` para esta rama, así que probablemente
requiera (2); (2) un `overrides: { "@xmldom/xmldom": "^0.9.x" }` en el
`package.json` de `app-main`, con la advertencia de que `xml-crypto`
puede depender de API de 0.8: hay que correr la suite de facturación
completa (`invoice.service.test.ts`, `arca-sdk-billing.adapter.test.ts`)
antes de aceptarlo; (3) independientemente del fix, sumar
`npm audit --omit=dev --audit-level=high` al CI de los dos repos — es lo
mismo que pide F9-01 y cierra los dos de una.
¿Requiere modificar código?: Solo `package.json`/lockfile. Requiere
verificación real porque toca el circuito fiscal.
Prueba necesaria: post-override, `npm audit --omit=dev` sin high; suite
de `src/facturacion/` verde; y —dado que los tests usan dobles del
puerto— una emisión real contra el ambiente de homologación de AFIP antes
de considerarlo cerrado.
```

### F9-14 — La credencial de SUPERADMIN es una contraseña en texto plano en una variable de entorno, única, sin rotación y sin segundo factor

```text
Hallazgo: el acceso de plataforma —el que puede listar todos los
negocios, cambiarles el plan y el estado, aprovisionar bases y, vía
`/api/admin/set-tenant-url`, reapuntar la base de cualquier tenant a una
URL arbitraria— se autentica contra `PLATFORM_ADMIN_EMAIL` +
`PLATFORM_ADMIN_PASSWORD`, dos variables de entorno. La contraseña se
guarda en texto plano en el entorno del proceso y se hashea en memoria al
primer login (`_bootstrapHash`, memoizado a nivel de módulo). No hay
tabla de usuarios de plataforma, no hay rotación, no hay segundo factor,
y no hay forma de tener más de un superadmin ni de revocar a uno sin
cambiar la variable y reiniciar. El propio código lo declara: el comentario
de `PLATFORM-AUDIT-ACTOR-STABLE-001` dice que el email *"es el único
identificador de persona que existe en este modelo de un solo operador"*
y que el modelo multi-superadmin es *"decisión de negocio aparte, no
tomada"*.
Evidencia: src/platform/platform.auth.service.ts:14-17 (el docblock:
*"PLATFORM_ADMIN_PASSWORD — contraseña en texto plano para el primer
deploy (se hashea en runtime; no se guarda en disco)"*) · :70-85
(`getBootstrapCredentials`: lee las dos env vars y memoiza el hash) ·
:95-114 (el login) · :133 (`const userId = creds.email`) · render.yaml:
`PLATFORM_ADMIN_EMAIL` y `PLATFORM_ADMIN_PASSWORD` con `sync: false`, o
sea que el valor real vive en el dashboard de Render · lo que protege esa
credencial: `src/platform/admin.routes.ts:124-163`
(`POST /api/admin/set-tenant-url` acepta cualquier `databaseUrl` que
empiece con `postgresql` y conecta el servidor ahí) y
`src/platform/platform.routes.ts` (alta, plan, estado y aprovisionamiento
de cualquier negocio) · mitigantes reales y verificados: clave JWT
separada (`PLATFORM_JWT_SECRET` ≠ `JWT_SECRET`, con el porqué escrito en
`platform.auth.middleware.ts:12-16`), TTL de 8h (la mitad que el de
staff), `platformLimiter` de 30/15min sobre `/platform/*`, PBKDF2 con
310 000 iteraciones y `timingSafeEqual`, y fail-closed con 503
`PLATFORM_AUTH_NOT_CONFIGURED` si faltan las variables · agravante:
F9-02 pone el Bearer de superadmin en el log de cada request, y
`PlatformAuthContext.tsx:62` lo guarda en `sessionStorage` (legible por
JS) en un origen sin CSP (F9-07).
Impacto: es el único punto del sistema donde una sola credencial estática
da control sobre TODOS los tenants. El conjunto de quien la conoce no
está delimitado por nada (cualquiera con acceso al dashboard de Render la
ve en claro), cambiarla no invalida los tokens ya emitidos (F9-03) y
nada registra quién la usó ni cuándo (F9-11).
Causa probable: es explícitamente un mecanismo de bootstrap —"para el
primer deploy"— que quedó como el mecanismo definitivo porque hay un solo
operador y nunca hizo falta otro. El comentario de
PLATFORM-AUDIT-ACTOR-STABLE-001 muestra que el límite está identificado y
que la decisión de superarlo se dejó explícitamente pendiente.
Nivel de certeza: Alta para el mecanismo y para los mitigantes (todo
leído). NO es un bug: es un modelo de seguridad declarado, con su alcance
escrito. Se registra como riesgo estructural, no como defecto.
Severidad: Media, como riesgo de concentración. Sube a Alta en
combinación con F9-02 (el token en logs) mientras ese no se corrija.
Recomendación: no se propone reemplazar el modelo acá — es decisión del
dueño y depende de cuántas personas operan la plataforma. Lo que sí
corresponde registrar como consecuencia directa de otros hallazgos de
esta fase: (1) el `redact` de F9-02 debe cubrir explícitamente el Bearer
de `/platform/*` y `/api/admin/*`, no solo el de tenant; (2) los eventos
de login de superadmin son los PRIMEROS que deberían entrar en la
auditoría de F9-11, por encima de los de staff; (3) si el modelo se
mantiene, dejar escrito el procedimiento de rotación de
`PLATFORM_ADMIN_PASSWORD` (hoy no existe runbook, a diferencia de
`DB_ENCRYPTION_KEY`, que sí tiene el suyo:
`docs/conocimiento/runbook-rotacion-db-encryption-key.md`). Las tres son
de bajo costo y no requieren cambiar el modelo.
¿Requiere modificar código?: (1) y (2) sí, y ya están pedidos por F9-02 y
F9-11. (3) es documentación. El cambio de modelo es decisión de negocio,
no técnica.
Prueba necesaria: para (1), el mismo test de redacción de F9-02 pero con
un request a `/platform/businesses`. Para (3), ninguna — es un runbook.
```

### F9-15 — F5-01 desde el ángulo de seguridad: qué DATOS ajenos alcanza un token de cliente en las rutas de staff, no solo qué puede escribir

```text
Hallazgo: F5-01 (Fase 5) ya estableció, con test de reproducción, que un
JWT del portal de clientes satisface `Roles.BOOKING` y alcanza 4 rutas
mutantes de routers de staff sin guard de pertenencia. Este hallazgo NO
lo re-investiga: le agrega la dimensión que F5-01 no trató, que es la de
exposición de información. Las rutas afectadas no solo escriben:
responden con el estado del recurso sobre el que operaron. En particular
`POST /api/orders/:id/items` acepta un `:id` de CUALQUIER orden del
tenant y devuelve la orden resultante, con sus ítems y sus importes — lo
que convierte una ruta de escritura en un lector de las órdenes de otros
clientes del mismo negocio, iterando el `:id`. El mismo razonamiento
aplica a `POST /api/reservations/:id/schedule-request`. Además, la
enumeración completa de `authorize(Roles.BOOKING)` da **11** call-sites
en 5 archivos, no 4: los 7 restantes son lecturas
(`bookable-services.routes.ts` ×5, `resources.routes.ts`,
`business-hours.routes.ts`) y son legítimas por diseño (el portal
necesita catálogo y horarios para reservar), pero conviene que estén
enumeradas: hoy nada declara cuál es el conjunto de datos que un token de
cliente puede leer, ni hay cerca que lo congele.
Evidencia: docs/auditoria-integral-fase5-2026-09-15.md, ficha F5-01
completa (ubicación, comportamiento observado y el contraste con
`requireOwnReservation`) · reproducción ya existente:
src/tests/integration/customer-token-staff-route-ownership.integration.test.ts ·
registrado en docs/pendientes-2026-09-12.md · enumeración de esta fase:
`grep -rn "authorize(Roles.BOOKING)" src --include="*.routes.ts"` → 11
call-sites: reservations.routes.ts ×2 (`POST /` en :361, `POST
/:id/schedule-request` en :674), orders.routes.ts ×2 (`POST /` en :200,
`POST /:id/items` en :386), bookable-services.routes.ts ×5,
resources.routes.ts ×1, business-hours.routes.ts ×1 · la cerca que NO
llega: src/tests/architecture/customer-portal-ownership-guard.test.ts
recorre ÚNICAMENTE `customer.routes.ts` (verificado: la suite pasa hoy
con estas 4 rutas sin guard) · el gate que sí cubre el lado del portal:
src/api/routes/customer.routes.ts:342-362 (`requireOwnReservation`).
Impacto: además del impacto de escritura que F5-01 ya dimensionó, un
cliente del portal puede leer datos comerciales de otros clientes del
mismo negocio —composición y montos de órdenes ajenas— sin necesidad de
adivinar nada más que un id de orden. Dentro de un tenant, el aislamiento
"una BD por negocio" no aplica: el actor ya está adentro.
Causa probable: la misma que F5-01 diagnosticó, y vale repetirla porque
es la lección transferible: el cierre del Hueco 1 del ADR de RBAC se
definió por ARCHIVO (`customer.routes.ts`) y por GRUPO (`CUSTOMER_ONLY`),
no por ACTOR. `BOOKING` es el otro grupo que un token CUSTOMER satisface
y vive en routers de staff, donde ni el guard ni la cerca llegan.
Nivel de certeza: Alta para el mecanismo (ya reproducido en Fase 5) y
para la enumeración de los 11 call-sites (grep reproducible).
HIPÓTESIS_A_CONFIRMAR para la forma exacta de la respuesta de
`POST /:id/items`: no se leyó el mapper de la respuesta en esta fase.
`No confirmado.` `Información faltante: qué campos devuelve
POST /api/orders/:id/items.` `Cómo verificarlo: leer el handler en
src/pos-menu/orders.routes.ts:386 y su mapper, o extender el test de
integración que ya existe para asertar sobre el body además del status.`
Severidad: Alta — la misma que F5-01, sin inflarla: es el mismo defecto
visto desde otro lado, no uno nuevo.
Recomendación: no duplicar la remediación. F5-01 ya está registrado en
`docs/pendientes-2026-09-12.md` con su test; lo que esta fase agrega como
pedido propio es que, cuando se aborde, (a) el criterio de cierre incluya
la respuesta y no solo el efecto de escritura, y (b) la extensión de la
cerca `customer-portal-ownership-guard.test.ts` cubra por ACTOR —toda
ruta que un token con `role: CUSTOMER` pueda alcanzar— y no por archivo,
que es la generalización que el propio diagnóstico de F5-01 señala. La
lista `ESCAPE_ROUTES` de `credit-note-escape-containment.test.ts` es el
precedente de una cerca que congela un conjunto explícito de rutas: el
mismo molde sirve para congelar el conjunto de rutas alcanzables por
`BOOKING`.
¿Requiere modificar código?: Sí, ya pedido por F5-01. Esta ficha no
agrega trabajo nuevo, agrega criterio de aceptación.
Prueba necesaria: extender el test de integración existente para asertar
que el BODY de la respuesta de `POST /api/orders/:id/items` con un token
de cliente ajeno no expone la orden.
```

### F9-16 — `POST /api/admin/set-tenant-url` conecta el servidor a una URL de base de datos del body: SSRF por diseño, acotado a SUPERADMIN

```text
Hallazgo: es la única posición del código donde el servidor abre una
conexión hacia un destino que viene en el request. `SetTenantUrlSchema`
valida solo que sea un string que empiece con `postgresql`; después
`applyTenantSchema(databaseUrl)` se conecta y ejecuta `schema.sql`
completo contra ese destino, y `encryptConnectionString` lo persiste como
la base del tenant. No hay allowlist de host, ni de puerto, ni chequeo de
que el destino sea Neon. Se registra como riesgo aceptado y no como
defecto: la ruta existe exactamente para eso, la protección es el gate de
plataforma, y el propio archivo declara el incidente que llevó a
endurecerla.
Evidencia: src/platform/admin.routes.ts:49-52 (`SetTenantUrlSchema =
z.object({ businessId, databaseUrl: z.string().min(1).startsWith
('postgresql') })`) · :124-163 (el handler) · :143 (`applyTenantSchema
(databaseUrl)`) · :57 (`router.use(authenticatePlatform(),
authorizePlatform([PlatformRole.SUPERADMIN]))` — el gate, aplicado a todo
el router) · :20-32 (el docblock que narra el endurecimiento del
19/08/2026: hasta esa fecha exigía `Roles.MANAGEMENT` de TENANT, así que
*"CUALQUIER OWNER/ADMIN de CUALQUIER negocio podía reapuntar su propio
negocio (y set-tenant-url incluso acepta una URL arbitraria en el body:
el servidor termina conectándose a lo que sea que mande el caller)"*) ·
src/app.ts:284-293 (el mount antes del `authenticate()` de tenant, con el
motivo) · :123 (*"La URL nunca se devuelve en la respuesta — solo se
cifra y almacena"*) · verificación complementaria de esta fase: las otras
3 `fetch()` de producción usan URLs de entorno o constantes, así que no
hay ninguna otra superficie SSRF.
Impacto: si la credencial de SUPERADMIN se compromete (ver F9-14), el
atacante puede redirigir la base de un tenant a un servidor propio y
capturar todo el tráfico de datos de ese negocio a partir de ahí. Es una
escalada desde una credencial ya comprometida, no un vector
independiente.
Causa probable: la ruta es deliberada y su alcance está escrito. El
riesgo residual es inherente a su función.
Nivel de certeza: Alta. Archivo leído completo, gate verificado.
Severidad: Baja como hallazgo autónomo (requiere SUPERADMIN). Se registra
para que el riesgo quede declarado y no se descubra de nuevo.
Recomendación: opcional y de bajo costo: validar el host del
`databaseUrl` contra una allowlist de sufijos (`.neon.tech`, o lo que
corresponda al proveedor) — no impide nada legítimo y cierra la
redirección a un host arbitrario. Aparte: `applyTenantSchema` corre DDL
contra el destino ANTES de cualquier verificación de que sea una base
propia; invertir eso (verificar primero) es otra opción. Ninguna de las
dos es urgente.
¿Requiere modificar código?: Opcional. No bloquea nada.
Prueba necesaria: si se implementa la allowlist, test unitario del
esquema con una URL de host no permitido, aserando 400.
```

---

## 3. Resumen por severidad

| # | Hallazgo | Severidad | ¿Código? | Relación con fases previas |
|---|---|---|---|---|
| F9-01 | `next@16.3.1`: 2 advisories CRITICAL de RCE no autenticada; fix en un patch | **Crítica** | Sí (`package.json`) | Nuevo |
| F9-02 | Token, cookie, query string con PII y Bearer de superadmin en cada línea de log | **Alta** | Sí | Reconfirma **F8-10**; suma 2 vectores; misma familia que **F8-06** |
| F9-03 | Sin revocación de sesión: reset de contraseña, borrado de cuenta y robo no cierran nada; `/refresh` sin tope | **Alta** | Sí | Nuevo |
| F9-04 | `POST /register` (Neon) y `/password-resets/request` (mail) con limiter que no cuenta los éxitos | **Alta** | Sí | Nuevo; agrava **F8-05** (más sagas a medias) |
| F9-05 | Vincularse a la empresa de otra organización con solo su UUID; el worker propaga su catálogo | **Alta** | Sí | Nuevo |
| F9-15 | Token de cliente lee datos de órdenes ajenas en rutas de staff (ángulo de datos) | **Alta** | Sí (ya pedido) | **Cita F5-01 / C6-05**, no lo duplica |
| F9-06 | El token viaja en el body y una pantalla lo guarda en `localStorage`: la cookie httpOnly no protege | **Media-Alta** | Sí | Nuevo |
| F9-07 | El frontend no emite ningún header de seguridad | **Media-Alta** | Sí | Nuevo |
| F9-08 | `/api/customer/*` fuera de `helmetApi` (sin CSP) y fuera de `apiLimiter`, contra lo que afirma el comentario | **Media** | Sí | Nuevo; mismo patrón que `CONTRACT-001` |
| F9-09 | Endpoint público con fan-out N+1 contra la tenant DB, techo 500/min/IP | **Media** | Sí | Nuevo |
| F9-10 | `sslConfig()` → `ssl:false` en silencio sin `NEON_SSL` | **Media** | Sí | Ya declarado en `CLAUDE.md` bajo `honest-degradation`; acá con anclas |
| F9-11 | Ningún evento de autenticación auditado ni logueado | **Media** | Sí | Nuevo; interactúa con MID-LOG-001 |
| F9-13 | `@xmldom/xmldom` HIGH en la cadena de firma XML de AFIP | **Media** | Solo deps | Nuevo |
| F9-14 | SUPERADMIN: credencial única en env, sin rotación ni MFA | **Media** | Parcial | Riesgo estructural declarado; agravado por F9-02 |
| F9-12 | `password-resets/accept`: dos escrituras sueltas → token reutilizable | **Baja-Media** | Sí | Misma familia que **F8-05** / F2-05 |
| F9-16 | `set-tenant-url` conecta a una URL del body (SSRF por diseño, SUPERADMIN) | **Baja** | Opcional | Riesgo aceptado, se registra |

**Totales:** 16 hallazgos — 1 Crítica, 5 Altas, 2 Media-Alta, 5 Medias,
1 Baja-Media, 1 Baja, 1 riesgo estructural declarado (F9-14, contado en Medias).

**Lo que esta fase verificó limpio y no produjo hallazgo** (registrado porque una
ausencia de hallazgo solo vale si se dice qué se buscó): inyección SQL (139
interpolaciones revisadas, 54 no-constantes, todas de origen en código), inyección de
comandos (0 superficies), XSS en el backend, CSRF (SameSite=Strict + solo `express.json()`),
hashing de contraseñas, confusión de algoritmo en el JWT propio, verificación del ID token
de Google (`iss`/`aud`/`exp`/`email_verified`/`kid`, todos chequeados), higiene de los
tokens de un solo uso, cifrado en reposo de connection strings y credenciales de AFIP,
no exposición de campos sensibles en las respuestas, no exposición de `/docs` y
`/openapi.json` en producción, y aislamiento entre tenants en las rutas que tocan la BD
de plataforma (`users`, `roles`, `companies` derivan el negocio de `req.user`, nunca del
body).

---

## 4. No confirmado

Cinco puntos que esta fase no pudo cerrar con el alcance disponible. Se listan con el
formato exacto del protocolo.

1. **Explotabilidad real de los advisories de Next.js en este despliegue (F9-01).**
   `No confirmado.`
   `Información faltante: el sistema operativo del host del frontend, y si existe alguna respuesta alcanzable desde /_next/image?url=/... que devuelva bytes controlables por el atacante.`
   `Cómo verificarlo: confirmar el runtime del servicio en el panel de hosting; y, para el vector AVIF, enumerar qué rutas del backend (alcanzables por el rewrite /api/:path*) pueden devolver un cuerpo binario con un content-type de imagen. Independientemente del resultado, el bump de versión es la acción correcta.`

2. **Headers de seguridad que agrega el hosting por su cuenta en el frontend (F9-07).**
   `No confirmado.`
   `Información faltante: la lista real de headers de respuesta del frontend en producción.`
   `Cómo verificarlo: curl -sI https://<dominio-del-frontend>/dashboard. Es una verificación de un minuto y cierra el hallazgo en cualquiera de las dos direcciones.`

3. **Alcance de lo que puede HACER un token de cliente después del borrado de cuenta (F9-03(b)).**
   `No confirmado.`
   `Información faltante: qué rutas de /api/customer/me/* siguen operando con un customer en estado anonimizado — depende de validaciones de ReservationService que no se recorrieron en esta fase.`
   `Cómo verificarlo: test de integración que llame a anonymize() y después ejercite las 6 rutas de /me/* con el token emitido antes del borrado.`

4. **Techo real de creación de branches contra la API de Neon (F9-04).**
   `No confirmado.`
   `Información faltante: el rate limit de POST /projects/{id}/branches para el plan contratado del proyecto ancient-king-17098519.`
   `Cómo verificarlo: doc de límites de la API de Neon, o la propia respuesta 429 del endpoint. No cambia la recomendación —el limiter hay que arreglarlo igual—, cambia la estimación del daño máximo.`

5. **Si algún dato de origen de usuario llega al XML firmado por `xml-crypto` (F9-13).**
   `No confirmado.`
   `Información faltante: qué campos del comprobante (razón social, descripción de línea, concepto) se serializan dentro del XML que el SDK de ARCA firma.`
   `Cómo verificarlo: trazar el payload desde InvoiceService.issue() hasta arca-sdk-billing.adapter.ts y enumerar qué strings llegan al SDK sin sanitizar.`

Además, dos puntos con certeza parcial documentados dentro de sus fichas:
`F9-05` (cómo se genera el `companyId` y por dónde puede filtrarse) y
`F9-15` (la forma exacta del body de `POST /api/orders/:id/items`).

---

## 5. Alcance excluido

Lo que esta fase **no** cubrió, y por qué:

- **Re-derivación de F5-01, F8-10, F8-06, C6-05 y las 10 cercas RBAC/contrato.** Reusadas
  como evidencia por instrucción del protocolo. F9-02 y F9-15 son ángulos nuevos sobre
  hallazgos existentes, explícitamente etiquetados como tales.
- **Las costuras criptográficas ya auditadas por Fase 7** (`tenant-db.setup.ts`
  AES-256-GCM, `google-oauth.ts` RS256/JWKS). Se releyeron con lente de seguridad y el
  resultado —limpio— se registra en §1; no se produjo hallazgo nuevo, así que no hay ficha.
- **Pentest activo.** No se construyó ningún exploit, no se ejercitó ninguna ruta contra un
  entorno real, y no se probó la API de Neon, la de AFIP ni el frontend desplegado. Todas
  las reproducciones fueron locales, con servidores efímeros y valores ficticios.
- **Valores reales de secretos.** Ningún `.env`, ninguna variable del dashboard de Render,
  ninguna connection string, ningún token real aparece en este documento. Las
  reproducciones usan literales inventados (`TOKEN_FICTICIO_AAA`, `COOKIE_FICTICIA_BBB`,
  `juan.perez@ejemplo.test`) marcados como tales en el propio texto.
- **Revisión de las 262 rutas una por una.** La cobertura de autorización se estableció por
  las cercas existentes (215 call-sites, 5 cercas verdes) más lectura dirigida de las
  familias de mayor riesgo: portal de clientes, plataforma/superadmin, empresas
  multipropiedad, reseteo de contraseña, credenciales de AFIP y registro público.
- **`docs/rbac-matriz-endpoints.md` y `docs/diseno-rbac-modelo-y-alcance-2026-08-30.md`
  como documentos.** Leídos como fuente de verdad; no se reescriben ni se auditan sus
  filas una por una — eso es alcance de las cercas, no de esta fase.
- **Seguridad de la infraestructura fuera del código** (configuración de Render, políticas
  de acceso de Neon, DNS, TLS del borde, retención de logs del proveedor). Fuera del
  alcance de una auditoría de repositorio; se nombra donde una decisión de código depende
  de ello (F9-02 sobre retención, F9-10 sobre `NEON_SSL`, F9-14 sobre quién ve el
  dashboard).
- **Cumplimiento normativo** (GDPR, PCI, régimen de facturación electrónica de AFIP como
  obligación legal). F9-03(b) toca el borde de la anonimización por pedido del titular
  pero se trata como defecto técnico, no como evaluación de cumplimiento.

---

## Apéndice — verificación independiente del gate `architecture-governor` (15/09/2026)

El cuerpo de arriba es verbatim del agente productor y no se edita. Este apéndice registra
lo que el gate verificó por su cuenta antes de autorizar el commit, incluida una
reproducción independiente de F9-01, y dos correcciones factuales encontradas al hacer
spot-check de los hallazgos.

**F9-01 — REPRODUCIDO de forma independiente, campo por campo.** El gate corrió los
mismos comandos que el agente productor sobre `/home/user/appfrontend` y obtuvo resultados
idénticos: `next` instalado `16.3.1` (pin exacto en `package.json`, sin `^`);
`npm audit --omit=dev --json` → `{moderate:1, high:1, critical:1, total:3}`, con `next`
`critical`/`isDirect:true` y `sharp` `high`/`isDirect:false`; los dos advisories
(`GHSA-p293-qw3h-jr36`, `GHSA-2xp9-vwfh-vxw4`) con rango `>=16.0.0 <16.3.3`; `fixAvailable`
`{"name":"next","version":"16.3.5","isSemVerMajor":false}` idéntico campo por campo.
Confirmado además que `next.config.js` no tiene bloque `images` (archivo leído completo:
solo `rewrites()`) y que `grep -rln "next/image" src` da 0 — así que rigen los defaults del
optimizador de imágenes y `/_next/image` es superficie expuesta sin que ninguna pantalla la
use. `.github/workflows/` solo tiene `ci.yml`, sin `npm audit`. **El fix es tan simple como
el informe afirma** — un bump de patch dentro de la misma minor, sin decisión de negocio.

**Árboles de git confirmados limpios en los DOS repos.** `git status --porcelain
--untracked-files=all` dio una sola entrada en `app-main` (este mismo `.md`) y salida
**vacía** en `appfrontend-main`. `git stash list` vacío en ambos. Sin rastro de los scripts
temporales (`sqlscan.mjs`, `pinourl.mjs`) que el agente productor dice haber escrito y
borrado en su scratchpad.

**Corrección 1 — F9-13, el conteo de advisories de `@xmldom/xmldom` es incompleto,
declarado bajo "Nivel de certeza: Alta".** El título dice *"4 advisories (una HIGH)"* y el
cuerpo dice *"cuatro variantes del mismo tema — inyección ... al serializar"*.
`npm audit --omit=dev --json` sobre `/home/user/app`, corrido de forma independiente por el
gate, devuelve **8 advisories, de los cuales 6 son HIGH** — los 4 ya citados
(`GHSA-6gmq-8vp8-gcm6` moderate, `GHSA-c7q8-3ch8-vqpv` high, `GHSA-27p8-2357-5qqv` high,
`GHSA-6h8r-xr42-gp59` moderate) más **4 no citados**: `GHSA-8344-3jmq-59r6` (high,
deduplicación de atributos en tiempo cuadrático), `GHSA-x4fp-j954-r2f4` (high, ReDoS por
regex de trim de whitespace en end-tag), `GHSA-965w-775f-mr7g` (high, consumo de memoria
cuadrático) y `GHSA-93r5-fhx6-vmg9` (high, parseo en tiempo cuadrático vía recovery de
input malformado). Los 8 tienen rango `>=0.7.0 <=0.8.14`, dentro del cual cae la versión
instalada (`0.8.14`).

Esto no es cosmético: los 4 advisories omitidos son de **clase distinta** — DoS por
complejidad en el **parseo**, no inyección en la **serialización**. El razonamiento de
impacto de la ficha (*"el vector requiere que un dato controlable termine dentro de un nodo
XML que después se firme o se compare"*) y su `No confirmado` #5 (si algún dato de usuario
llega al XML firmado) están planteados sobre la mitad del problema: los 4 de complejidad no
necesitan un campo serializable controlable — alcanza con XML malformado en el camino de
parseo, que incluye las **respuestas que AFIP devuelve**. El documento además se contradice
a sí mismo: el título dice "una HIGH" y el cuerpo nombra dos como high. La
`Severidad: Media (Alta si...)` de la ficha está construida sobre un conjunto incompleto y
debería re-evaluarse al abordar el hallazgo. La recomendación operativa (`overrides` a
0.9.x + suite de facturación completa + `npm audit` en CI) no cambia — se refuerza.

**Corrección 2 — F9-10, la cita de `render.yaml` omite la cláusula que contradice el
párrafo de Impacto de la ficha.** La ficha cita: *"Sin esto, los pools caen a ssl:false ...
No es un secreto, pero si falta, el proceso no debe asumir un default en silencio"*. El
texto real (`render.yaml:43-45`) es: *"Sin esto, los pools caen a ssl:false **y la conexión
a Neon/Supabase falla**. No es un secreto, pero si falta, el proceso no debe asumir un
default en silencio."* Los puntos suspensivos omiten exactamente la cláusula que
contradice el Impacto declarado (*"se conecta a las bases de producción sin TLS y sin que
nada lo diga"*): si el comentario del propio repo es correcto, el modo de falla real podría
ser ruidoso (la conexión falla) y no un plaintext silencioso. El gate no verificó cuál de
las dos direcciones es la real — ninguno de los dos documentos lo hizo. `No confirmado.`
`Información faltante: si el endpoint de Neon del proyecto rechaza conexiones sin TLS o las
acepta en texto plano.` `Cómo verificarlo: un intento de conexión real a un branch de Neon
con `ssl: false` desde un entorno no productivo.` La recomendación de la ficha (fail-loud
explícito en producción ante `NEON_SSL` ausente) se sostiene en cualquiera de las dos
direcciones y no cambia.

**Discrepancias menores, registradas solo aquí (no afectan ninguna conclusión):**
(a) F9-02 ancla el comentario de A7.2 en `customers.routes.ts:549-551`; el texto citado
—literal, y presente una sola vez en el archivo— está en realidad en `:529-530`.
(b) La fila `fetch(` de la tabla de mediciones reproducibles declara el resultado **3**
(correcto para producción), pero el comando tal como está escrito
(`grep -rn "fetch(" src | grep -v .test.ts`) devuelve 4 líneas — la cuarta es
`src/scripts/concurrency-test-reservations.ts:68`, un script CLI fuera del proceso del
servidor, correctamente excluido del conteo pero no del comando citado.

**Nota a favor del informe:** F9-06 afirma que `PlatformAuthContext.tsx` guarda el token de
SUPERADMIN en `sessionStorage` (`:26,:62`). Es correcto, pese a que el docblock de ese mismo
archivo (`:86`) dice *"sigue en localStorage a propósito"* — un comentario stale que el
agente productor no tomó como fuente, leyendo el código real en su lugar.

**Spot-check adicional, todo exacto:** F9-03 (`auth.middleware.ts:126-161`,
`customer.routes.ts:636-655`), F9-04 (`rate-limit.middleware.ts:70-78`/`:75`,
`express-rate-limit@7.5.1:652-653`/`:792-797`, mounts `:271`/`:272`/`:309`/`:156`/`:352`),
F9-05 (`companies.routes.ts:82-99`, 18 líneas, cero verificación del lado de la empresa
destino), F9-08 (portal en `:277` vs. `helmetApi` en `:282`, el comentario de `:280` es
falso para `customer`), F9-12 (`password-reset.routes.ts:209-210`), F9-06
(`admin/page.tsx:110,:24-25,:34`), F9-11 (`grep "logger\.\|audit"` sobre `auth.routes.ts` →
0), F9-15 (11 call-sites de `authorize(Roles.BOOKING)` con la distribución exacta por
archivo). Mediciones re-corridas y coincidentes: `EXPECTED_AUTHORIZE_CALL_SITES = 215`,
`npx vitest run src/tests/security src/tests/architecture` → 15 archivos/58 tests verdes,
`sync: false` en `render.yaml` = 14, `npm audit` backend (con y sin dev) idénticos,
`npm ls @xmldom/xmldom` con la cadena de 4 niveles citada.

**Escaneo de prompt injection / instrucciones ocultas: limpio.** Censo de codepoints
Unicode sobre los 95.546 caracteres del documento — cero zero-width, cero bidi override,
cero tag characters, cero BOM; solo acentos del español y tipografía estándar. Sin
comentarios HTML, `<script`, `data:`/`base64,`. Ningún secreto real — los literales de las
reproducciones son declaradamente ficticios.

**Decisión: APPROVED WITH CONDITIONS.** Autorizado el commit de este documento, un solo
archivo en `app-main`, nada en `appfrontend-main`. **El bump de `next`/`sharp` (F9-01) NO
queda autorizado en este gate** — es su propio bloque con su propio gate: toca
`package.json` + lockfile de `appfrontend-main`, exige `npm run build` + suite del frontend
+ smoke test de login/dashboard, y `appfrontend-main/main` está hoy ahead 3 de
`origin/main` — hay que decidir qué pasa con esos 3 commits antes de apilar otro. Tampoco
quedan autorizados: el `overrides` de `@xmldom/xmldom` (F9-13, toca el circuito fiscal),
ninguna corrección de código de F9-02 a F9-16, ni `npm audit` en CI de los dos repos.
