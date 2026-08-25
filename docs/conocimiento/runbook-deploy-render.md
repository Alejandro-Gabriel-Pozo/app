# Runbook — deploy Render (Node pin + migraciones con EXCLUDE)

- **Fecha:** 2026-08-25
- **Estado:** implementado (`engines.node` acotado; incidente del día resuelto)
- **Categoría:** Runbook + Incidente
- **Etiquetas:** `render` `node` `migrate:tenants` `patch-package` `v42`
- **Alcance:** `app-main` en Render. No documenta secretos.
- **Referencias:** pendientes 25/08 “Incidente de deploy”; `package.json` `engines`; `render.yaml` `NODE_VERSION`; `i11-arcasdk-pdf-puppeteer.md`.

## Contexto

Deploy de `e84c779` (locks de reservas + schema v42) falló **dos veces** por causas independientes.

## Procedimiento 1 — Node no es el de `render.yaml`

**Síntoma:** `patch-package` sobre `@arcasdk/pdf` falla. El parche en sí aplica en una carpeta limpia.

**Causa observada:** el log mostró Node **26.x** aunque `render.yaml` fijaba `NODE_VERSION: "22"`. Render usó el rango de `engines.node` (`>=22.12.0` **sin techo**).

**Qué hacer:**

1. Confirmar en el log de build la versión real de Node.
2. `engines.node` debe ser rango **con techo** alineado a `NODE_VERSION` (hecho: `>=22.12.0 <23.0.0`).
3. “Clear build cache & deploy” puede destrabar un build sucio; no sustituye el pin.

No ampliar el rango de `engines` “para que instale en cualquier Node”.

## Procedimiento 2 — `migrate:tenants` falla al crear `EXCLUDE`

**Síntoma:** migración v42 revierte al crear `reservations_no_overlap_exclusive`.

**Causa observada (demo `biz-demo-01`):** reservas `PENDING` solapadas de pruebas de concurrencia que no se cancelaron todas.

**Qué hacer (orden):**

1. Confirmar con el dueño antes de tocar datos reales.
2. Diagnosticar solapes (ids, recurso, rango, status). No `UPDATE`/`DELETE` directo sobre `reservations` si existe `ReservationService.cancelReservation()` (rastro y eventos).
3. Aplicar columnas nuevas **sin** el constraint si hace falta destrabar; cancelar solapes; recién ahí `migrate:tenants` completo.
4. Scripts de un solo uso: no commitear.

## Verificación

Tras un deploy: proceso up, `migrate:tenants` en el log hasta la versión esperada, `patch-package` OK, Node 22.x en el log. El 25/08 el reintento con `1fcba6d` pasó (Node 22, parche, v42, build).

## Limitaciones

- Este runbook no cubre el OOM de `npm start` del 19/08 (ver pendientes de esa fecha).
- Credenciales de superadmin (`PLATFORM_ADMIN_*`) no se documentan acá; sin ellas no se prueba en vivo `PATCH .../plan`.
