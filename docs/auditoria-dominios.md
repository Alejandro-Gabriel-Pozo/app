# Auditoría de dominios, subdominios y archivos de configuración

> Documento vivo. Se actualiza cada vez que se agrega, cambia o elimina un
> dominio, subdominio, endpoint externo o variable de entorno relacionada con
> hosting en cualquiera de los dos repositorios (`app` backend y
> `appfrontend` frontend). Ver instrucción permanente en `CLAUDE.md` (raíz de
> `App - frontend`), sección "Auditoría de dominios".

Última actualización: 2026-08-12.

| Dominio/Subdominio/Archivo | Notas registradas |
|---|---|
| `app-chny.onrender.com` | Backend (`app`) en producción sobre Render. Referenciado como default hardcodeado en `appfrontend-main/src/app/login/page.tsx:6` y `appfrontend-main/src/app/admin/page.tsx:6`, como servidor "producción" en `app-main/src/openapi/spec.ts:26`, y como ejemplo en `appfrontend-main/.env.example:6` y `appfrontend-main/render.yaml:11` (`NEXT_PUBLIC_API_URL`). |
| `render.com` | Plataforma de hosting de ambos servicios (backend y frontend). Ver `app-main/README.md:118` (instrucciones de deploy) y `render.yaml` de cada repo. |
| `app-main/render.yaml` | Config de deploy del backend (`reservations-api`) en Render. Define `CORS_ORIGIN` (dominio del frontend, sin valor — se carga manual en el dashboard de Render, `sync: false`) y `NEON_SSL`. Comentario explícito: sin `NEON_SSL=true` los pools de Postgres caen a `ssl:false` en silencio y falla la conexión a Neon/Supabase. |
| `appfrontend-main/render.yaml` | Config de deploy del frontend (`admin-panel`) en Render. Fija `NEXT_PUBLIC_API_URL=https://app-chny.onrender.com` como valor productivo. |
| `appfrontend-main/.env.example` | Documenta `NEXT_PUBLIC_API_URL`. Nota de advertencia: el prefijo `NEXT_PUBLIC_` es obligatorio en Next.js — si se nombra distinto (ej. `VITE_API_URL`, que es de Vite) el cliente API cae a `BASE=''` en silencio y todos los fetch van a rutas relativas del propio frontend (404). |
| `appfrontend-main/README.md` | ⚠️ Desactualizado: describe deploy como SPA con Vite (`VITE_API_URL`, `dist/index.html`, rewrite `/* → /index.html`), pero el proyecto real es Next.js (`package.json` usa `next dev`/`next build`). Revisar y reescribir en la próxima limpieza de docs. También menciona que el dominio final del Static Site debe reflejarse en `CORS_ORIGIN` del backend, si no el navegador bloquea las peticiones. |
| `appfrontend-main/ARCHITECTURE.md` | Tabla de variables de entorno cross-repo: `NEXT_PUBLIC_API_URL` (repo `appfrontend`, URL del backend), `DATABASE_URL`/`TENANT_ENCRYPTION_KEY`/`JWT_SECRET` (repo `app`). Referencia issues de GitHub `app#27` (roadmap frontend) y `app#26` (code review backend) — no son dominios pero sí punteros externos de auditoría. |
| `github.com/Alejandro-Gabriel-Pozo/app` | Repositorio backend. Referenciado en `app-main/README.md:133`. Remoto real confirmado: `origin` de `app-main` apunta acá. |
| `github.com/Alejandro-Gabriel-Pozo/appfrontend` | Repositorio frontend. Remoto real confirmado: `origin` de `appfrontend-main` apunta acá (no tiene mención explícita en texto, se agrega por auditoría de `git remote -v`). |
| `*.aws.neon.tech` (proyecto `pdb-ppms`, us-east-2, PG18 — plataforma; proyecto tenants, us-west-2, PG17) | Ver `app-main/docs/INCIDENT_LOG_2026-08-08.md`. Regla permanente: SIEMPRE usar el endpoint con sufijo `-pooler` antes de `.region.aws.neon.tech` en Render/producción (serverless no mantiene conexiones persistentes); la URL sin pooler es solo para migraciones locales (`drizzle-kit push/migrate`). Deuda documentada: mismatch de versión PG18 vs PG17 entre plataforma y tenants, sin alinear todavía. |
| `unpkg.com`, `fonts.googleapis.com`, `fonts.gstatic.com` | Dominios externos permitidos en la Content-Security-Policy de `/docs` (Swagger UI) — `app-main/src/api/middleware/helmet.middleware.ts:94-103`. Comentario explícito: `'unsafe-inline'` ahí es aceptable porque Swagger UI no procesa datos de usuarios; **no** debe extenderse esa política permisiva al resto de la API. |
| `CORS_ORIGIN` (variable, sin dominio fijo) | `app-main/src/app.ts:108-110`: en producción, si `CORS_ORIGIN` no está seteada, el CORS cae a `false` (bloquea todo) — en desarrollo cae a `'*'`. Debe apuntar exactamente al dominio del Static Site/frontend en Render; un mismatch bloquea todas las peticiones del panel. |
| `localhost:3000` | Entorno de desarrollo local del backend (`app-main/README.md:23-24`, `app-main/src/server.ts:62-63`, `app-main/src/openapi/spec.ts:27`). Expone `/docs` (Swagger UI) y `/health` (health check). |
| `portal/[businessSlug]` (subdominio lógico, no DNS) | Ruta dinámica del frontend (`appfrontend-main/src/app/portal/[businessSlug]/...`) que identifica al negocio/tenant por slug en la URL, no por subdominio real. Relevante para no confundirlo con un subdominio DNS durante auditorías. |

## Archivos ignorados por ser ruido (código de terceros o sin información nueva)

- `package-lock.json` (ambos repos): solo URLs de `registry.npmjs.org`, resolución de dependencias.
- `appfrontend-main/src/components/UpgradePrompt.tsx`: `http://www.w3.org/2000/svg` es el namespace estándar de SVG, no un dominio de infraestructura.
- `app-main/.MD`: archivo vacío en la raíz del repo, sin contenido.
- `app-main/CONTRIBUTING.md`, `app-main/src/tests/README.md`: mencionan `conventionalcommits.org` y `vitest.dev` como referencias de documentación externa, sin relación con infraestructura propia.
