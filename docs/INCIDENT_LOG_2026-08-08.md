# 📋 Incident Log — 08 Agosto 2026

> **Estado final:** ✅ App en producción (live en Render)
> **Tiempo de resolución:** ~1 sesión de trabajo
> **Repositorio afectado:** `app` + configuración de Neon y Render

---

## Contexto

Durante el proceso de deploy a Render se identificaron tres problemas encadenados relacionados con la configuración de bases de datos (Neon) y las variables de entorno. Se resolvieron en orden y el proyecto quedó live al cierre de la sesión.

---

## Problemas Identificados y Soluciones

### ❌ Problema 1 — Una sola `DATABASE_URL` para múltiples bases de datos

**Síntoma:** La app tenía una sola variable `DATABASE_URL` genérica que intentaba servir tanto a la base de datos de la plataforma como a la de los tenants, causando conflictos y errores en runtime.

**Causa raíz:** No se separaron las concerns de base de datos desde el inicio del proyecto. Una sola variable no puede apuntar a dos bases con roles distintos.

**Solución aplicada:**
- Se eliminó la variable genérica `DATABASE_URL`
- Se crearon dos variables explícitas y descriptivas:
  - `PLATFORM_DATABASE_URL` → base de datos central de la plataforma
  - `TENANT_DATABASE_URL` → base de datos de los tenants
- Ambas fueron seteadas en el panel de variables de entorno de Render

**Regla permanente:**
> ⚠️ Nunca usar `DATABASE_URL` genérica cuando el proyecto tiene múltiples bases de datos. Nombrar las variables con prefijos descriptivos (`PLATFORM_`, `TENANT_`, etc.) **desde el inicio**, no como refactor posterior.

---

### ❌ Problema 2 — Ambas bases de datos en el mismo proyecto Neon

**Síntoma:** La plataforma y los tenants compartían el mismo proyecto Neon, mezclando concerns, permisos y dificultando el branching independiente.

**Causa raíz:** Se asumió que un proyecto Neon podía alojar múltiples bases de datos con dominios distintos sin consecuencias.

**Solución aplicada:** Se crearon dos proyectos Neon completamente independientes:

| Variable | Proyecto Neon | Región | PG Version |
|---|---|---|---|
| `PLATFORM_DATABASE_URL` | `pdb-ppms` | us-east-2 | PostgreSQL 18 |
| `TENANT_DATABASE_URL` | *(proyecto tenants)* | us-west-2 | PostgreSQL 17 |

**Regla permanente:**
> ⚠️ Un proyecto Neon por dominio de responsabilidad. Plataforma y tenants son dominios separados → proyectos separados. Esto también facilita billing, permisos y branching por feature.

**Deuda identificada:**
> ⚠️ Hay un mismatch de versiones (PG 18 vs PG 17). Si alguna query usa syntax exclusiva de PG 18, fallará en el proyecto de tenants. **Alinear versiones en el próximo sprint o confirmar compatibilidad explícitamente.**

---

### ❌ Problema 3 — Connection string sin pooler en entorno serverless

**Síntoma:** La app en Render experimentaba timeouts de conexión porque se usaban connection strings directas (sin pooler).

**Causa raíz:** Render (y plataformas serverless en general) no mantienen conexiones persistentes a la base de datos. Sin un pooler, cada request abre y cierra una conexión nueva, agotando el límite de conexiones de Neon.

**Solución aplicada:** Usar siempre la URL con el endpoint **pooler** de Neon:

```bash
# ❌ INCORRECTO — sin pooler (solo para migraciones locales)
postgresql://user:pass@ep-nombre-endpoint.region.aws.neon.tech/neondb

# ✅ CORRECTO — con pooler (para Render y cualquier entorno serverless)
postgresql://user:pass@ep-nombre-endpoint-pooler.region.aws.neon.tech/neondb?channel_binding=require&sslmode=require
```

**Diferencias clave:**
- El hostname incluye `-pooler` antes del `.region`
- Se agregan los params `channel_binding=require&sslmode=require`

**Regla permanente:**
> ⚠️ En Render, Vercel, Railway, y cualquier entorno serverless: **SIEMPRE** usar la connection string con `-pooler`. La URL sin pooler queda reservada exclusivamente para correr `drizzle-kit push` o `drizzle-kit migrate` en local.

---

## Estado Final del Sistema

```
✅ App live en Render
✅ PLATFORM_DATABASE_URL → Neon pdb-ppms (us-east-2, PG 18, con pooler)
✅ TENANT_DATABASE_URL   → Neon tenants  (us-west-2, PG 17, con pooler)
✅ Variables de entorno separadas y correctamente nombradas
```

---

## Convenciones Establecidas

### `.env.example` — Mantener SIEMPRE actualizado

```bash
# Base de datos de la plataforma (proyecto Neon: pdb-ppms)
# Usar el endpoint con -pooler para Render/producción
PLATFORM_DATABASE_URL="postgresql://user:pass@ep-xxx-pooler.c-5.us-east-2.aws.neon.tech/neondb?channel_binding=require&sslmode=require"

# Base de datos de los tenants
# Usar el endpoint con -pooler para Render/producción
TENANT_DATABASE_URL="postgresql://user:pass@ep-xxx-pooler.region.aws.neon.tech/neondb?channel_binding=require&sslmode=require"
```

### Regla de commit

> Si se agrega o modifica una variable de entorno → se actualiza `.env.example` en el **mismo PR**, no en uno separado.

---

## Checklist Pre-Deploy (agregar al proceso)

Antes de cada deploy a Render verificar:

- [ ] Las connection strings usan el endpoint con **`-pooler`** en el hostname
- [ ] `PLATFORM_DATABASE_URL` y `TENANT_DATABASE_URL` están ambas seteadas en Render
- [ ] No existe ninguna variable `DATABASE_URL` genérica sin prefijo en el código o en Render
- [ ] Las migraciones fueron corridas correctamente en **ambas** bases de datos
- [ ] `.env.example` está actualizado y refleja todas las variables requeridas
- [ ] PG version mismatch está documentado o resuelto (PG 18 platform vs PG 17 tenants)

---

## Deudas Técnicas Abiertas Post-Sesión

| # | Tarea | Prioridad | Estado |
|---|---|---|---|
| 1 | Actualizar `.env.example` con las dos variables y sus comentarios | 🔴 Alta | Pendiente |
| 2 | Verificar que `drizzle-kit` apunta a la DB correcta según contexto (platform vs tenant) | 🔴 Alta | Pendiente |
| 3 | Alinear versión PG entre proyectos Neon (18 vs 17) o documentar compatibilidad | 🟡 Media | Pendiente |
| 4 | Agregar checklist pre-deploy al README | 🟡 Media | Pendiente |

---

*Generado automáticamente al cierre de sesión — 08/08/2026*
