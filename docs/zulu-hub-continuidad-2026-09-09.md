# ZULU Hub — Continuidad operativa

- **Fecha de corte:** 2026-09-09, `app-main` local en `b0f9d93` (2 commits
  de código sobre lo desplegado + 1 de docs, todo sin pushear).
- **Reemplaza a:** `docs/zulu-hub-continuidad-2026-09-08.md` (arco del
  bloque B-núcleo+órdenes cerrado, deploy `9b651f2`). Ese documento sigue
  siendo la referencia de ese arco — no se reescribe acá.
- **Para qué:** que una sesión nueva sepa dónde quedó el proyecto y qué
  sigue, sin depender del historial conversacional.
- **Etiquetas:** `mapa-del-sistema` `continuidad`

---

## 1. Estado de producción

| Repo | `origin/main` | En producción | Local |
|---|---|---|---|
| `app-main` | `e1b70bb` (sin cambio desde el corte anterior) | Deploy vivo sigue siendo el de `9b651f2` — **nada de lo de hoy está deployado**. | `b0f9d93`, **ahead 4** de `origin/main`. Working tree sucio con el commit de docs de este corte, todavía sin hacer al momento de escribir esto. |
| `appfrontend-main` | `613c206` | Sin cambio. | Sin cambio, no tocado hoy. |

> Verificar siempre con `git ls-remote origin refs/heads/main` antes de
> asumir que algo de esto llegó a producción.

## 2. Qué se hizo hoy (09/09/2026)

1. **Precondición de #29 cumplida** (`docs/pendientes-2026-09-08.md` #29):
   `prices_include_iva=TRUE` en las 2 tenants (Demo, Hotel los Alamos, vía
   Neon MCP), 0 reservas con >1 factura viva en datos reales, grounding
   `auditor-circuitos-erp` sobre ERPNext/Odoo/QloApps para la decisión de
   pool mixto. Sin commit de código propio — registrado en `9b8209a`.
2. **Bloque 3.3-b1** (commit `5a64ae2`) — orquestador
   `CancelReservationWithCreditNoteService` (`src/facturacion/`) + puerto
   `ReservationCancelForCreditNote` (`src/reservas/`), espejo del escape de
   órdenes ya deployado. SIN ruta, SIN `authorize` en ese commit. 21
   unitarios + 4 de integración contra Postgres real (Neon
   `test-integration-db`) + 4 mutaciones obligatorias verificadas y
   revertidas. Tres gates `architecture-governor` (diseño, alcance de
   implementación, cierre). Suite completa 2006/2006 sin regresión
   (baseline 1985).
3. **Bloque 3.3-b2** (commit `b0f9d93`) — ruta
   `POST /api/reservations/:id/cancel-with-credit-note` +
   `authorize(Roles.EMISOR_NOTA_CREDITO)` + RBAC completo. El gate de
   alcance encontró y corrigió 3 errores antes de codear (ver
   `pendientes-2026-09-08.md` #29 y el propio commit): error post-AFIP
   mapeado a 400 en vez de 422, 6 códigos sin mapear en
   `error.middleware.ts`, respuesta que hubiera serializado la reserva sin
   pasar por `toReservationDto()`. 2 mutaciones verificadas y revertidas.
   Suite completa 2013/2013 sin regresión.
4. **Docs-only** (este commit) — reconcilia 3 anclas que quedaron stale
   por el propio 3.3-b2: `CLAUDE.md` (líneas 101/112, ya no dice "una
   ruta"/"cuando exista"), `plan-cierre-cancelacion-nc-y-deuda-estructural-2026-09-08.md`
   (filas 3.3-a/3.3-b/3.3-b1/3.3-b2, la corrección `NUCLEO_IMPORT_ALLOWLIST+2→+1/+1`,
   prioridad de 3.3-d), `pendientes-2026-09-08.md` (#27 con los hashes
   correctos, #29 cerrado con evidencia).

## 3. Deuda declarada de hoy, ninguna bloqueante

- **El catch inline de las DOS rutas de escape** (órdenes y reservas)
  termina en `else if (err instanceof DomainError) res.status(409)` — un
  `DomainError` que `error.middleware.ts` mapearía a otro status (ej.
  `UNSUPPORTED_IVA_RATE` → 422) llega como 409 en las dos. Preexistente en
  órdenes, heredado por reservas. Bloque propio si se decide reconciliar.
- **`AFIP_NOT_CONFIGURED`: 422 inline en las dos rutas, 503 en el
  middleware.** Divergencia deliberada, declarada en el código de las dos
  rutas — mantiene los dos escapes simétricos entre sí.
- **El texto "la orden ..." de `CreditNoteCancellationPendingError`/
  `CreditNoteCancellationRejectedError`** se reusa tal cual para el lado
  reservas (mensaje incorrecto, `.code` correcto) — `domain/errors.ts` fue
  append-only en los dos bloques, corregir el texto toca clases existentes,
  bloque aparte.

## 4. Próximo bloque

**`3.3-d`** (`classifyReservationLiveInvoice()` + reconciliación de
`handleReservationCancelled`, `src/workers/outbox.handlers.ts:162-170`
vs. `:432-466` del lado órdenes) — **prioridad, no preferencia**: 3.3-b2
es el commit que crea el pasivo (cada escape de reserva exitoso, una vez
deployado, va a emitir un `logger.error` falso en el outbox); 3.3-d es el
único bloque que lo retira. `3.3-c` (cablear F4 en
`findBlockingInvoiceLinkage()`, firma congelada) y `3.3-e` (índice de
rendimiento) pueden esperar — ninguno de los dos desbloquea el push.

**Decisión pendiente del dueño, no de ningún gate:** pushear `5a64ae2` +
`b0f9d93` (+ el commit de docs) ahora, asumiendo el ruido operativo de
3.3-d hasta que se cierre; o esperar a que 3.3-d exista antes de pushear.
