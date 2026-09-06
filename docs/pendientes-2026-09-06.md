# Pendientes — Sábado 6 de Septiembre 2026

Arrastra lo que seguía abierto en `pendientes-2026-09-05.md`. Los ítems
cerrados o mitigados quedan marcados allá in-place, no se repite el detalle
completo acá.

**Alcance de esta sesión (autorizado por el dueño):** tanda para cerrar la
familia ORDER y el bloque "confirmRefund / plata / AFIP". Alcance confirmado
por el dueño (AskUserQuestion): **B2 + B3, ORDER-13, O5, INV-ORF-01,
ORDER-15**. Fuera: **B4** (cierre de período contable — sesión propia con el
contador) y el circuito **POS-caja** (ORDER-12, CAJA-ORD-01, AUDIT-ORD-01 —
vertical slice separado). Orden: backend/schema primero, frontend después.
Cada bloque pasa por `architecture-governor` antes de commitear; ningún
bloque se declara terminado si solo existe logging.

**Disciplina de evidencia**, igual que los archivos anteriores: `[V]`
verificado contra el árbol real / Postgres real en esta sesión; `[P]`
decisión propuesta, no final; `[H]` hipótesis sin verificar.

**Estado git al abrir el archivo:** `app-main` HEAD = `6dcb047`,
`origin/main` = `5a3a588` (verificado con `git ls-remote`), **17 commits sin
pushear** (16 de la sesión del 05/09 + el bloque 1 de hoy). `appfrontend-main`
= `613c206`, sincronizado. Push y deploy siguen siendo autorización aparte
del dueño.

---

## ⚠️ Mitigado en esta sesión — verificado

### BRECHA-REFUND-01-B — `PAYMENT` sin factura, concurrente con `confirmRefund()`, sub-reembolsaba en silencio · ⚠️ MITIGADO (commit `6dcb047`, local sin push)

Registrado abierto en `pendientes-2026-09-05.md:143`. **Bloque 1 de la
tanda.** `architecture-governor` APROBÓ CON CONDICIONES — todas aplicadas.

- **Qué hace:** guard optimista estilo ERPNext
  (`payment_entry.validate_allocated_amount_with_latest_data`) en
  `CancellationRefundService.confirmRefund()`
  (`cancellation-refund.service.ts`, después del loop de chunks, antes del
  `});`): relee `getCollectedPaymentTotalForReservation()` por el POOL (no
  por `client` — no ve los REFUND que la propia transacción acaba de
  insertar) y, si `round2(collectedRecheck) !== round2(collected)`, tira
  `RefundBaseChangedError` → 409 `REFUND_BASE_CHANGED`, reintentable (A8.6,
  no se reintenta solo). Rollback total, cero filas persistidas.
- **Archivos** (4, +141 −6): `domain/errors.ts` (clase nueva),
  `reservas/cancellation-refund.service.ts` (import + guard con comentario
  de 3 partes), `api/middleware/error.middleware.ts` (`case` 409 +
  `logger.warn` por-code — única traza de un DomainError en ese middleware),
  `reservas/cancellation-refund.service.test.ts` (fake dinámica corregida al
  corte de commit + 3 tests nuevos: sube, baja, no-regresión).
- **Evidencia** `[V]`: `tsc`/`lint`/`lint:arch` verdes; unit
  `cancellation-refund.service.test.ts` 16 → 19; suite completa
  1866 passed / 1 failed / 1 todo (el único rojo es el DST pre-existente,
  ver abajo); integración `cancellation-refund.integration.test.ts` 15/15
  contra Postgres real (Neon), 83s — "Escenario A", "Escenario B" y los de
  concurrencia real **no se alteraron**.

**Decisiones V/P/H de este bloque:**
- `[V]` `applyCappedRefundToInvoice` y `getRefundableForUpdate` son
  read-only — el guard puede ir después del loop de INSERT.
- `[V]` `getCollectedPaymentTotalForReservation` lee por `this.sqlClient`
  (pool de `req.db`), no por el `client` transaccional — la relectura
  refleja solo commits de OTRAS transacciones.
- `[V]` PAYMENT→VOIDED concurrente no dispara falso positivo (la suma
  cuenta `PAYMENT` en `('SETTLED','VOIDED')`).
- `[V]` `confirmRefund()` hermano no dispara falso positivo (advisory lock +
  re-check `lockedExisting` que hace `return` antes del guard).
- `[P]` Placement "después del loop" para cobertura máxima de ventana; los
  INSERT desperdiciados ante conflicto son irrelevantes (rollback limpio,
  `createWithClient` es INSERT puro sin outbox).

---

## 🔴 Abierto — registrado por primera vez (06/09/2026)

### Residual B-1 (de BRECHA-REFUND-01-B) — la ventana `guard → COMMIT` sigue descubierta

Ancla: `cancellation-refund.service.ts`, guard posterior al loop de chunks
en `confirmRefund()`. El guard solo ve lo **commiteado antes de su propio
`SELECT`**. Bajo READ COMMITTED, una transacción concurrente que ya
escribió y todavía no commiteó es invisible, y la ventana entre el guard y
el `COMMIT` queda sin cubrir. Estrechamiento, no garantía. Cerrarlo del
todo exige un lock que cubra la **reserva en sí** (no solo sus facturas) —
hoy no existe. Bloque de diseño propio, con `architecture-governor` antes
de tocar código — no autorizado en esta tanda.

### TEST-DST-001 — `reservation.service.test.ts:2316` falla en este entorno · `requiere entorno`

`combineDateAndTime — DST (hora ambigua, vuelta de otoño)` espera
`2024-04-07T03:00:00Z`, recibe `02:00:00Z`. Dependiente de ICU/tzdata
(`America/Santiago`, DST 2024): Node `v24.14.1`, ICU `78.2`, TZ local
`America/Buenos_Aires`. **Pre-existente**, sin relación con ningún bloque
de esta tanda (`pendientes-2026-09-05.md:75-78` decía "todo verde" con 1815
tests; hoy son 1868 y hay uno rojo). No mezclar con ningún commit de
features — si se toca, commit aparte. `[H]` sobre si es regresión de
tzdata del entorno o del código.

### MID-LOG-001 — `error.middleware.ts` no loguea NINGÚN `DomainError`

`error.middleware.ts:61-68`: el bloque `err instanceof DomainError`
responde el status y el `code` sin loguear. `AFIP_REQUEST_UNCERTAIN`,
`AFIP_REQUEST_REJECTED` y el resto caen en el mismo agujero — nunca
aparecen en logs salvo que un router los capture antes. El bloque 1 abrió
el precedente de logging por-code (solo `REFUND_BASE_CHANGED`). Hallazgo
más ancho que ese bloque: decidir si TODOS los `DomainError` de riesgo
plata/confianza deben loguearse (A9.1/A9.5). Bloque propio.

### POOL-STARV-001 — lecturas por pool dentro de una transacción, pool tenant `max: 5`

`tenant.middleware.ts:105` arma el pool de `req.db` con `max: 5`.
`confirmRefund()` sostiene una conexión de ese pool para la transacción
(`transactionManager.run` → `pool.connect()`) y además hace lecturas por
el MISMO pool DENTRO de la ventana transaccional (`:173`, `:245`, y ahora
el guard de B-1 = 3ª/4ª adquisición). No es clase de riesgo nueva y
`connectionTimeoutMillis: 5_000` lo convierte en timeout visible, no en
cuelgue permanente — pero nunca se dimensionó. `[H]`. Ítem de análisis,
no de código inmediato.

### REFUND-INT-GUARD-001 — falta el test de integración que dispare el guard de B-1 de verdad

Condición no bloqueante que dejó `architecture-governor` al aprobar el
bloque 1. Un decorator sobre `SqlFinancialTransactionRepository.createWithClient`
que, desde una conexión aparte, commitee un `PAYMENT` interferente contra
la reserva (sin `settled_invoice_id`, así el `FOR KEY SHARE` no lo frena) y
después delegue — cae en la ventana `:245 → guard`. Probaría de una las
tres cosas que hoy son inferencia: que el guard dispara, que la transacción
rollbackea de verdad (assert: cero filas REFUND para esa reserva), y que
el aislamiento pool-vs-client es el asumido. Única cerca contra la trampa
latente documentada en el comentario del guard.

### N4-b — encuadre corregido por el dueño: la app NO califica la operación fiscal

Corrección del dueño (06/09/2026) al planteo de la sesión anterior. **La
app no afirma "esto es una rescisión parcial"** ni elige el motivo fiscal.
El emisor, con su contador, determina: si hubo rescisión/devolución/
reducción, si corresponde NC, total o parcial, qué motivo informar, qué
factura asociar, qué documentación respalda. La app: ofrece la capacidad
(seleccionar la consolidada, emitir NC parcial, un solo `CbtesAsoc`,
calcular/mostrar neto+IVA+tributos, validar que el comprobante asociado
exista y esté `ISSUED`, impedir inconsistencias técnicas, enviar a ARCA,
guardar CAE + trazabilidad), SIEMPRE detrás de la autorización humana
explícita (`Roles.MANAGEMENT`, el escape administrativo de ORDER-10 B2).

Consecuencia para el ADR del bloque 2 (a documentar explícitamente):
1. motivo del ajuste + decisión total/parcial provienen del autorizante;
2. `confirmed_by` identifica a la autoridad que decidió;
3. `notes` es explicación libre — no interviene en cálculos ni clasificación;
4. la app calcula y muestra la composición neto/IVA/total desde datos
   fiscales congelados;
5. fail-closed si falta esa composición o si se excede el saldo reversible;
6. la asociación con la consolidada y el único `CbtesAsoc` se validan
   técnicamente, no se presentan como conclusión fiscal de la app.

Frase que ordena el diseño (dueño, 06/09/2026): **la app debe poder hacerlo;
quien decide si debe hacerse es el emisor con su contador.** La app recibe la
decisión del autorizante, registra el motivo declarado y si es total/parcial,
permite seleccionar la consolidada, valida que exista y esté `ISSUED`,
calcula la composición neto/IVA/total con datos fiscales congelados, verifica
que no se supere el saldo reversible, genera la NC con el `CbtesAsoc`
correspondiente y conserva evidencia + trazabilidad — pero no califica la
operación ni garantiza que el tratamiento fiscal sea correcto.

**Pendiente externo (solo esto, no bloquea el mecanismo técnico):** consulta
al contador — "si el emisor determina que parte de una operación facturada
en forma consolidada fue efectivamente cancelada o reducida, ¿puede
documentarla mediante una NC parcial por rescisión asociada únicamente a la
factura consolidada?". Define el **escenario fiscal que el emisor puede
utilizar**, no bloquea diseñar ni implementar la capacidad técnica. Si el
contador lo confirma, la app debe poder ejecutarlo; si no, el emisor no usa
esa opción para ese caso.

---

## 🔎 Referencia nueva — artículo AFIP SDK sobre Notas de Crédito

El dueño pegó completo (06/09/2026) el artículo "Nota de crédito: qué es y
cuándo emitirla" (AFIP SDK blog, RG 4540/2019). Guardado en memoria del
proyecto. Aplica a N4-b y ORDER-10 B2. Puntos que fijan diseño:

- Rescisión parcial es causal válida de NC (§1). La regla "individualizar
  cada factura afectada" (§5, §15) aplica a diferencias de precio/cantidad,
  no a rescisión — una NC parcial por rescisión se asocia con `CbtesAsoc`
  a la única consolidada.
- NC ≠ devolución de dinero (§2): la NC documenta el ajuste; el movimiento
  de plata es separado. Valida el diseño (fail-closed + escape MANAGEMENT
  emite NC; la plata es aparte).
- NC B (§9): reduce el total con IVA incluido, reflejando el IVA contenido
  por alícuota — valida usar `afip_request.Iva[]` congelado.
- Plazo 15 días corridos (§4): desde el hecho generador o desde el
  conocimiento formal del emisor. Son las "dos fechas" de schema diferidas
  (con B4).
- Nunca emitir clase M (discontinuada 01/12/2025, §6). Leyenda "A
  CONSUMIDOR FINAL" en NC B (§8); identificar receptor si importe ≥
  $10.000.000 desde 01/07/2026 (§8); QR obligatorio (§7).

---

## 🔴 Arrastrado de `pendientes-2026-09-05.md` — sin re-verificar salvo donde se indica

Su estado se conserva porque nadie lo cerró, no porque se haya vuelto a
comprobar. Detalle completo en el archivo del 05/09; acá una línea por ítem.

### Tanda actual (a encarar en esta sesión)

- **confirmRefund #1 / N4-b** (ceguera del `INNER JOIN` de `getByReservationId()`
  a facturas consolidadas + cableado de `resolveRefundableForPair()`, N4-a
  ya hecho en `eda4a2f`). **Bloque 2.** ADR pendiente (ver encuadre
  corregido arriba). 2 columnas de schema = (1) motivo + total/parcial
  declarados por el autorizante, (2) composición fiscal congelada +
  referencia a la operación afectada. Migración con backup durable previo.
- **ORDER-10 B2** — `cancelOrderWithCreditNote()`, ruta `MANAGEMENT`,
  `ADJUSTMENT` compensatorio, extensiones a `buildCreditNote()`; reconciliar
  residual #3 (falso positivo de `CARGO_CON_COMPROBANTE_VIVO` con cada NC
  legítima). **Bloque 3.** Sin schema (ADR `diseno-cancelacion-orden-nota-credito-2026-09-05.md`).
- **ORDER-10 B3** — `?status=` en `GET /api/invoices` + bandeja de NC
  pendientes. **Bloque 4.** Sin schema.
- **ORDER-13** — caso de conciliación "órdenes `COMPLETED` sin `CHARGE`"
  visible y reparable a mano (idempotente, revalida estado, audita
  actor/motivo/monto/resultado; **no** auto-repara — decisión del dueño) +
  pt1 (clasificar retry de dead-letter por tipo de excepción, no por
  substring) + pt2 (mensaje de negocio). **Bloque 5.**
- **O5** — clasificar el error de dead-letter + notificar a un rol (reusa
  `domain_events` + `OutboxAlertBanner`, no tabla de incidentes nueva).
  **Bloque 6.**
- **ORDER-15** — asimetría `voidByOrderId` (acepta `ADJUSTMENT`) vs
  `settleChargesByOrderId` (solo `CHARGE`); impacto hoy cero. **Bloque 7.**
- **INV-ORF-01** — reservas de stock huérfanas. Query de dimensionamiento
  contra `Demo` + `Hotel los Alamos` **autorizada por el dueño**
  (06/09/2026, read-only). **Bloque 8.**

### Fuera de esta tanda (decisión del dueño)

- **ORDER-10 B4** — diseño de "período contable del tenant" + regla de
  cierre + excepciones + reapertura. Sesión propia con el contador.
- **ORDER-12**, **CAJA-ORD-01**, **AUDIT-ORD-01** — circuito POS-caja
  (efectivo, turnos, arqueo). Vertical slice separado.

### Resto del arrastre (sin cambios respecto de `pendientes-2026-09-05.md`)

- **ORDER-17** — ✅ RESUELTO (`caf24e1`), 4 residuales no bloqueantes.
- **RESERVA-10** — ✅ RESUELTO (`179b4ad`); H1 (`reservation-hold-expiry.worker.ts`
  no-op estructural), H2 (test negativo vs whitelist).
- **FACT-CONSOL-TOCTOU-01** — ✅ RESUELTO (`1f3af80`); R1 (fail-open sin
  fila), R2 (`getByIdWithLock` opcional en la interfaz), R3 (`markInvoiced()`
  post-commit = AR-FACT Fase 2), R4 (lado órdenes sin integración).
- **F2** — ✅ RESUELTO (`3073f36`); falta la primera corrida verde del job
  `integration` en Actions (nunca corrió contra `postgres:16-alpine`, solo
  Neon).
- **INV-ORF-01** (reservas de stock huérfanas históricas + compensación de
  dead-letter `inventory.handlers.ts:70-80`).
- **EVT-ORF-01** (`reservation.expired` sin consumidor, se persiste y el
  worker lo descarta cada 5s — cruza con A7.6), **ORDER-12**, **CAJA-ORD-01**,
  **AUDIT-ORD-01**, **O1-b** (reportes no distinguen "no consta" de "cero").
- **Seguridad / aislamiento:** FACT-INV-BIZID-001, SEC-ROT-001,
  RBAC-OWN-001, RBAC-SYNC-001, RBAC-MOUNT-001, FAILOPEN-001.
- **Documentales:** corregir el estado git stale de
  `continuidad-ar-fact-no-issued-01-2026-09-04.md:9-11` (afirma
  `HEAD=b088cbc` sin pushear; ya está en `origin/main`); DA-CONT-001
  (parcial); DOC-ANCLA-001; CONTRACT-001; C-5 (rama de origen `RECEIVABLE`
  desaparecida entre §8 y §24 de FACT-BORRADOR-001); ficha
  `erp-auditoria-v2/fichas/M10-facturacion.md:133` stale ("6 decisiones
  abiertas" cuando están cerradas).
- **Backlog de producto:** Gap C1-C (mitad viva); AR-FACT-NO-ISSUED-01
  Fases 2-8 — incluido `getInvoicedFinancialTransactionIds()`
  (`sql.invoice.repository.ts:245-255` filtra solo `ISSUED` = hueco de
  doble comprobante, merece fila propia); FISCAL-CBTE-001; FACT-BORRADOR-001
  (v2.8, sin aprobar, 4 correcciones + 3 decisiones del dueño abiertas);
  C1-Fase A; C1-Fase B (bloqueada hasta elegir proveedor); C2 (desbloqueada,
  sin construir); C3; D7 (5 endpoints de reportes sin consumidor); frontend
  visual (SEM-001, SEM-002, TOAST-003, A11Y-001, overlays de Superadmin);
  heredados (Redis rate-limit, BullMQ, etapas 2-3 de downgrade, datos demo
  en la base real).
- **A7.6** — política de retención escrita: sin purga para `audit_log` ni
  `domain_events`.
- **ORDER-15** (ver arriba, ahora en la tanda).

---

## Higiene pendiente

- Crear el commit de docs de este archivo (separado del código, mismo
  criterio que los commits anteriores).
- El texto de `pendientes-2026-09-05.md` quedó marcado in-place para
  BRECHA-REFUND-01-B (⚠️ MITIGADO) — ese cambio va en el mismo commit de
  docs que este archivo.
