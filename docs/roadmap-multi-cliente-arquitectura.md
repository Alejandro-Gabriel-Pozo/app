# Roadmap — Arquitectura multi-cliente del portal de alojamiento

> Documento traído por el dueño del proyecto el 15/08/2026, contrastado
> contra el código real antes de guardarlo — varios puntos que la versión
> original marcaba como "pendiente" o "a confirmar" ya están resueltos en
> este repo, y uno (el modelo de datos) asume una arquitectura distinta a
> la real. Ver `docs/pendientes-2026-08-14.md` sección D para el pointer.

## Cómo leer esto

- ✅ Ya hecho — con el archivo/línea que lo prueba.
- ⚠️ Parcial — existe una base, falta una parte real.
- ❌ No existe — pendiente genuino.
- 🔀 Corrección — el punto original asumía algo que no es cómo funciona este sistema.

---

## 1. Decisiones ya tomadas

- Multi-tenencia por path (`portal.tudominio.com/<slug>`), no por
  subdominio: ✅ confirmado — `appfrontend-main/src/app/portal/[businessSlug]/...`
  es una única familia de rutas dinámicas, no rutas hardcodeadas por
  cliente (ver punto 2.3).
- Frontend en Vercel, backend en Render: ✅ vigente. Ver
  `docs/auditoria-dominios.md` — el frontend real quedó en
  `reservasapp-teal.vercel.app` (Vercel), el backend en `app-chny.onrender.com`
  (Render).
- Cookies cross-domain Vercel↔Render: ✅ **confirmado, con la mecánica
  exacta** (no hacía falta preguntarle a nadie, está en el código):
  - Es **rewrite-proxy de Vercel hacia Render**, no CORS-explícito puro.
    `appfrontend-main/next.config.js` define `rewrites()`: todo `/api/*`
    que pide el browser va al mismo origen que el frontend, Next.js lo
    reenvía server-side al backend real. El browser nunca hace una
    request cross-origin de verdad.
  - `CORS_ORIGIN` en Render **también** está seteado (a
    `reservasapp-teal.vercel.app`, confirmado con `curl` el 15/08) como
    capa extra, pero no es lo que hace posible la cookie — es defensa en
    profundidad, no el mecanismo principal.
  - La cookie de sesión (`setAuthCookie()`,
    `app-main/src/security/auth.middleware.ts:188-195`) **no tiene
    `domain` seteado explícitamente** — `httpOnly`, `secure` (solo prod),
    `sameSite: 'strict'`, `path: '/'`, sin `domain`. Al no tener `domain`
    explícito, el browser la asocia al host que respondió la request, que
    gracias al proxy siempre es el dominio del frontend (hoy
    `reservasapp-teal.vercel.app`, mañana `portal.tudominio.com` sin
    tocar nada de esto).

---

## 2. Pendiente de configurar

### 2.1 DNS — `portal.tudominio.com` → proyecto de Vercel
❌ **Genuinamente pendiente.** Hoy el frontend productivo sirve desde
`reservasapp-teal.vercel.app` (el dominio por defecto de Vercel), no hay
ningún dominio propio conectado. Esto sí requiere una acción manual del
dueño: comprar/tener el dominio, agregarlo en Vercel (Settings → Domains)
y esperar el certificado SSL (Vercel lo emite solo, automático, una vez
que el DNS apunta bien — no hace falta gestionarlo aparte).

### 2.2 Comunicación frontend–backend
✅ **Ya resuelto**, ver punto 1 (cookies) — es el rewrite de Vercel
(`/api/* → Render`), no un subdominio `api.tudominio.com` con CORS
explícito. No hace falta elegir entre las dos opciones, ya se eligió y
está funcionando en producción (verificado con `curl` y con login real el
15/08/2026).

### 2.3 Ruta dinámica de cliente en el frontend
✅ **Ya implementado así.** `appfrontend-main/src/app/portal/[businessSlug]/`
es una sola ruta dinámica (`layout.tsx`, `page.tsx`, `login/`, `register/`,
`disponibilidad/`, `cuenta/perfil/`, `cuenta/reservas/`) — todas leen el
slug con `useParams()`, no hay ni una ruta hardcodeada por cliente en
ningún lado del código.

### 2.4 Middleware de tenant en el backend — resolver por slug, validar por sesión
✅ **Ya implementado y verificado leyendo el código el 15/08/2026** — ver
detalle completo en el punto 4 (no negociable), es el mismo tema.

### 2.5 Modelo de datos — 🔀 corrección, no aplica como está planteado
El documento original propone agregar `cliente_id`/`tenant_id` a
`resources`, `stays`, `financial_transactions` y `locations`, de forma
aditiva, y filtrar todas las queries por ese campo. **Eso no es cómo
funciona este sistema, y agregarlo sería un paso atrás, no adelante.**

Este backend usa **una base de datos Postgres separada por negocio**
(`db_url_encrypted` por fila de `businesses`, cifrada; ver
`platform.schema.sql`), no una base compartida con una columna de tenant.
`resources`/`stays`/`financial_transactions`/`locations` viven en
`src/db/schema.sql`, que se aplica completo (idempotente) contra la BD de
CADA tenant por separado (`applyTenantSchema()`,
`src/platform/tenant-db.setup.ts`) — no existe una tabla compartida entre
negocios que necesite una columna de aislamiento, porque no hay tabla
compartida. Un bug de "me olvidé el `WHERE tenant_id = ...`" es
estructuralmente imposible acá, porque no hay una tabla única de la que
olvidarse filtrar — cada negocio tiene su propia conexión de Postgres.

Es una garantía de aislamiento más fuerte que la del modelo `tenant_id`
compartido, no una alternativa equivalente. **No agregar `cliente_id` a
esas tablas** — generaría confusión sobre cuál es el mecanismo real de
aislamiento y podría hacer que alguien, más adelante, asuma erróneamente
que ese campo es lo que separa los datos.

---

## 3. Preguntas — respondidas contra el código real (15/08/2026)

### 3.1 ¿Un usuario puede pertenecer a más de una hostería?
✅ **Sí, ya soportado.** `memberships` tiene
`UNIQUE (identity_id, business_id)` — una identity no puede tener dos
membresías en el MISMO negocio, pero sí puede tener membresías en
negocios distintos. El login ya maneja este caso:
`POST /api/login/select-business` — paso 2 cuando el email tiene más de
una membership activa (`auth.routes.ts`).

### 3.2 ¿Cómo se genera y valida el slug?
⚠️ **Automático, con un gap menor.** `generateSlug()`
(`business.routes.ts:188-196`): minúsculas, sin tildes, no-alfanumérico →
guión, recortado a 50 caracteres. Unicidad forzada en dos capas: `slug
VARCHAR(100) NOT NULL UNIQUE` en `platform.schema.sql` + chequeo explícito
antes de crear (`400 BUSINESS_ALREADY_EXISTS` si ya existe). **Gap real:**
si dos negocios generan el mismo slug (nombres iguales o muy parecidos),
el segundo simplemente falla con 400 — no hay sufijo automático
(`-2`, `-3`, etc.). El usuario tiene que elegir otro nombre de negocio.
No es un bug, pero es fricción de UX si se espera volumen de altas.

### 3.3 ¿Alta manual o autoservicio?
⚠️ **Ya es autoservicio en el registro, manual en la activación.**
`POST /api/register` (`business.routes.ts`) es público (`security: []`),
sin autenticación — cualquiera puede registrar un negocio nuevo hoy
mismo. Crea la identity (o reusa una existente si el email/password
coinciden), el negocio, el rol OWNER "sistema", y la membership, todo en
una transacción con rollback si algo falla. **Pero el negocio queda en
estado `PENDING`** — el aprovisionamiendo real de la base de datos del
tenant (completar `db_url_encrypted`) sigue siendo un paso manual (los
endpoints admin `repair-tenant-db`/`set-tenant-url` mencionados en
`pendientes-2026-08-14.md` sección F2). Hay variables `SUPABASE_ACCESS_TOKEN`/
`SUPABASE_ORG_ID` en `render.yaml` para automatizar esto pero, igual que
pasó con el `render.yaml` del frontend, **no hay código real que las
use** — quedaron aspiracionales. Automatizar esto sería el siguiente paso
lógico si el volumen de altas lo justifica.

### 3.4 ¿Existe un rol superadmin que vea todas las hosterías?
✅ **Sí, ya existe, y ya está aislado por diseño.** Sistema de auth
completamente separado para `/platform/*`
(`security/platform.auth.middleware.ts`): JWT propio
(`PLATFORM_JWT_SECRET`, distinto del de tenants/empleados), documentado
explícitamente para que un token de empleado comprometido no sirva ahí, y
viceversa.

### 3.5 ¿Cómo probar el aislamiento A/B antes de producción?
Dado el modelo real (BD separada por tenant, punto 2.5), el riesgo no es
"me olvidé un `WHERE`" — es "resolví el pool de conexión equivocado".
Test recomendado, todavía no escrito:
- Integración: loguearse como usuario del negocio A, armar cualquier
  request que intente referenciar un ID de un recurso/reserva/cliente
  real del negocio B (nunca vía `:businessSlug` en la URL — ya no hay
  rutas autenticadas que lo acepten, ver punto 4 — sino IDs sueltos en
  el body/query) y confirmar 401/403/404, nunca 200 con datos ajenos.
- Unitario/directo: `getTenantClient(businessIdA, ...)` y
  `getTenantClient(businessIdB, ...)` devuelven pools con
  `connectionString` distintas — confirma que el cache de pools
  (`tenantPools`, `tenant.middleware.ts`) nunca podría devolver el pool
  de un negocio para el `businessId` de otro.

---

## 4. No negociable — verificado en código, no solo declarado (15/08/2026)

**Confirmado leyendo `tenant.middleware.ts` y `customer.routes.ts`
línea por línea:** el aislamiento se resuelve siempre contra
`req.user.businessId` (inyectado por `authenticate()` desde el JWT
verificado), nunca contra un `:businessSlug` de la URL, en los dos
sistemas de sesión (staff y customer):

- **Staff:** `tenantMiddleware()` (`tenant.middleware.ts:190-223`) lee
  `req.user.businessId` — no toca `req.params` en ningún punto de este
  archivo.
- **Customer:** las rutas públicas pre-sesión (`/:businessSlug/register`,
  `/login`, `/availability` en `customer.routes.ts`) sí usan el slug de
  la URL — correcto e inevitable, todavía no existe una sesión de la que
  derivar el negocio. Pero **a partir de `router.use(authenticate(),
  authorize(Roles.CUSTOMER_ONLY))` (línea 413), ninguna ruta posterior
  vuelve a aceptar `:businessSlug` en su path** (`/me`, `/reservas`,
  etc. son rutas planas) — el middleware de la línea 418-431 resuelve
  `req.db` de nuevo desde `req.user.businessId`, con el comentario
  explícito: "mismo campo que usa tenantMiddleware". No hay ningún punto
  del código, autenticado, donde el slug de la URL decida a qué base de
  datos se conecta la request.

Nada que hacer acá — la regla ya está implementada tal como la pedía el
dueño. Vale la pena escribir el test de la sección 3.5 para que quede
protegida contra una regresión futura, no porque hoy esté rota.

---

## 5. Portales por audiencia (15/08/2026, solo documentado — no implementado)

El dueño hizo notar algo real: hasta ahora el foco estuvo siempre en el
**negocio** (nuestro cliente directo) — pero el negocio tiene sus propios
clientes, y ese es un segundo público con necesidades propias. Hay tres
audiencias distintas, cada una con su propio login, y hoy están en
estados muy distintos de madurez. Esto es un mapeo del estado real, no
un diseño nuevo — el pedido explícito fue "documentar por ahora".

| Audiencia | Login/registro | Estado |
|---|---|---|
| **SUPERADMIN** (plataforma) | `/superadmin/login` | ✅ Hecho hoy (sección B de arriba) |
| **Negocio** (dueño/staff) | `/login` (sesión) | ✅ Login existe. ❌ **Alta/registro no tiene frontend** — `POST /register` (`business.routes.ts`) es público y ya acepta `plan` (FREE/STARTER/PRO), pero **no hay ninguna página en `appfrontend-main` que lo llame** (`grep` confirma: no existe `src/app/register`, `src/app/signup` ni similar). Hoy la única forma de registrar un negocio es a mano por API/Swagger. |
| **Cliente final** (huésped/consumidor) | `/portal/[businessSlug]/login` y `/register` | ✅ Ya existe y funciona — `POST /api/customer/:businessSlug/register` + páginas reales en el portal. |

### 5.1 Falta: landing + alta de negocio ("por dónde entran la primera vez, cuando eligen el plan")
No hay ninguna página pública hoy que explique el producto, muestre
planes (FREE/STARTER/PRO — el enum ya existe en el backend) y termine en
`POST /register`. Es la puerta de entrada real del negocio como cliente
nuestro — hoy no existe. Cuándo se construya, considerar si vive en
`host.zuluhub.com.ar` (mismo Next.js, ruta nueva) o en el dominio raíz
`zuluhub.com.ar` una vez que ese exista como sitio de marca (ver
`docs/auditoria-dominios.md`).

### 5.2 Falta: "reclamar" un registro de cliente que el negocio ya creó
El negocio puede cargar clientes a mano hoy (CRM interno,
`customers.routes.ts`, visible en `/dashboard/clientes`) — un huésped
que se registró en el mostrador, sin cuenta propia. Si esa misma persona
más adelante se autoregistra en el portal (`/portal/[slug]/register`,
sección de arriba), **hoy no hay ningún mecanismo que vincule las dos
cosas** — quedaría un cliente duplicado: el que cargó el negocio (sin
login) y el que se creó solo (con login), sin relación entre ambos.
Confirmado con `grep` que no existe ninguna lógica de `claim`/`merge`/
`absorb` en `customer.routes.ts` hoy.

No diseñado todavía — preguntas reales para cuando se encare:
- ¿Se matchea por email? ¿Qué pasa si el negocio cargó un email
  incorrecto o genérico (mostrador sin email real)?
- ¿El "reclamo" lo dispara el cliente (ingresa un código que le da el
  negocio) o se detecta solo al registrarse con un email que ya existe
  como cliente sin cuenta?
- ¿Qué pasa con el historial (reservas, cuenta corriente) del registro
  viejo — se migra entero al nuevo, o el nuevo empieza vacío y el viejo
  queda archivado?

### 5.3 Nota de arquitectura — un solo Next.js, no un subdominio por audiencia
Hoy `/dashboard` (negocio), `/portal/[businessSlug]` (cliente) y
`/superadmin` (plataforma) conviven en la misma app de
`appfrontend-main`, separados por path, no por subdominio — decisión ya
tomada de entrada en la hoja de ruta original (sección 1: "multi-tenencia
por path, no por subdominio"). Sigue siendo válido para el negocio/cliente
(son el mismo producto, `host.zuluhub.com.ar`). Vale la pena revisar si
`/superadmin` amerita separarse a otro subdominio el día que haya más de
un operador de plataforma — hoy, con un solo SUPERADMIN, no hace falta.
