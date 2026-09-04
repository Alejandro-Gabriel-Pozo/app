# Pendientes — Viernes 5 de Septiembre 2026

Arrastra lo que seguía abierto en `pendientes-2026-09-03.md` (no hubo archivo
para el 04/09). Los ítems cerrados quedan allá marcados, no se repiten acá.

**Alcance de esta sesión:** cierre completo de `BRECHA-REFUND-01` (Fases 1–3 +
dos residuales de arquitectura), con `architecture-governor` en cada paso.
Push total autorizado por el dueño al final — `app-main` (20 commits,
`1f72f41..1807ca8`) y `appfrontend-main` (1 commit, `9a08417..613c206`).

**Disciplina de evidencia**, igual que los archivos anteriores: `[V]` verificado
contra el árbol real / Postgres real en esta sesión; `[P]` decisión propuesta,
no final; `[H]` hipótesis sin verificar.

---

## ✅ Cerrado — verificado en esta sesión

### BRECHA-REFUND-01 — `confirmRefund()` podía duplicar reembolso / Nota de Crédito · ✅ RESUELTO (05/09/2026)

Registrada `04/09/2026` en `pendientes-2026-09-03.md:683` (bloqueaba C2 — "no
construir la UI sin resolver primero"). Cerrada en 3 commits, todos con
`architecture-governor` antes de cada uno, todos en `origin/main`:

- `b08b0d2` — **Fase 1**: `getCollectedPaymentTotalForReservation()` resta los
  `REFUND` ya emitidos (antes sumaba solo `PAYMENT`, repetía el bruto).
- `46ffaf3` — **F-A**: el reparto ignora Notas de Crédito ya emitidas (misma
  tabla `invoices`) — sin esto, una NC podía terminar apuntando a otra NC.
- `3f11949` — **Fase 3**: advisory lock + `idempotencyKey` derivada
  server-side + capado contra `getRefundableForUpdate()` (`LEAST` de dos
  invariantes, no `impTotal` a secas). El chequeo de retry corre dos veces
  (rápido afuera, autoritativo bajo el lock) — la primera versión de este
  commit tenía el chequeo SOLO afuera; `architecture-governor` lo bloqueó
  con un escenario reproducible antes de aprobar, ver `[V]` abajo.
- `1807ca8` — **residuales #1 y #2** (mismo día, segunda vuelta de
  `architecture-governor` sobre el propio `3f11949`):
  - **Residual #1 (ABBA `confirmRefund()`/`recordPayment()`): CERRADO SIN
    CAMBIO DE CÓDIGO.** `[V]` `recordPayment()` (`customer-account.service.ts:182-188`,
    desde `a2aaf40`, dos días antes) ya ordena sus locks de forma canónica
    (`localeCompare` ascendente sobre `invoices.id`) — el mismo comparador
    que `confirmRefund()`. `architecture-governor` había marcado esto como
    residual abierto en su primera revisión de `3f11949` **citando un
    comentario del propio código como evidencia**, sin releer
    `customer-account.service.ts` actualizado — el comentario estaba
    desactualizado desde `a2aaf40`. Corregido en la segunda vuelta. Detalle
    completo, incluida la regla de proceso ("no citar un comentario de otro
    archivo como estado verificado"), en
    [conocimiento/playbook-idempotencia-bajo-lock.md](conocimiento/playbook-idempotencia-bajo-lock.md).
  - **Residual #2 (chunk `:sin-asignar` sin re-capar bajo lock): CERRADO
    PARCIALMENTE.** `collected` e `issuedInvoices` se releen dentro de la
    transacción, después del pre-lockeo canónico de facturas. Dos
    escenarios reachable verificados con test que falla antes del fix y
    pasa después (`[V]`, contra Postgres real):
    - **Escenario A** (factura que pasa a `ISSUED` en vuelo, vía
      outbox/worker AFIP): antes caía a `:sin-asignar` ledger-only sin
      emitir NC; ahora se ata a la factura real.
    - **Escenario B** (`PAYMENT` concurrente sobre la misma reserva, vía
      `recordPayment()` o cobro de checkout/POS): antes quedaba un
      sub-reembolso silencioso y permanente (Q-C hace `confirmRefund()` de
      un solo tiro por reserva); ahora se refleja.
  - **Residual #2-B, declarado NO cerrado (no confundir con "cerrado"):**
    el `FOR UPDATE` sobre facturas no protege una escritura sobre la
    reserva que no tenga FK a ninguna fila lockeada (un `PAYMENT` genérico
    sin `settled_invoice_id`, dentro de la ventana entre el pre-lockeo y el
    commit). Estrechado, no eliminado — ver `BRECHA-REFUND-01-B` abajo.
  - **Residual #2-C, declarado NO verificado:** la semántica de `FOR KEY
    SHARE`/`FOR UPDATE` que sostiene la protección de Escenario A/B es
    inferencia sobre comportamiento documentado de Postgres, no un hecho
    medido con un test dedicado — ver `FOR-KEY-SHARE-001` abajo.

**Q-A / Q-C** (confirmadas por el dueño antes de Fase 3): reembolso nunca
supera lo efectivamente cobrado; `confirmRefund()` es único e irrepetible por
reserva (retry devuelve lo ya creado, no completa una diferencia después).

**Verificación acumulada de la sesión:** 1815 tests unitarios, 130 de
integración contra Postgres real (incluye los 9 del archivo nuevo
`cancellation-refund.integration.test.ts`), `tsc --noEmit`, `lint`, `lint:arch`
— todo verde antes de cada uno de los 4 commits.

**C2 (`Cancelar reserva` no usa el preview/confirm de reembolso,
`pendientes-2026-08-31.md:262`) queda DESBLOQUEADA.** Sigue sin construirse —
es trabajo de UI aparte, no autorizado en esta sesión — pero ya no tiene la
condición "no construir sin resolver primero" encima.

---

## 🔴 Abierto — registrado por primera vez (05/09/2026)

### BRECHA-REFUND-01-B — un `PAYMENT` sin factura, concurrente con `confirmRefund()`, todavía puede sub-reembolsar

**No es lo mismo que la fila de arriba ya cerrada.** El fix de Residual #2
protege lo que está atado por FK a una factura lockeada. Un `PAYMENT`
puramente contra la reserva (`reservation_id`, sin `settled_invoice_id`) que
commitea en la ventana entre el pre-lockeo de facturas y el `COMMIT` final de
`confirmRefund()` sigue sin reflejarse — la ventana se estrechó (de "toda la
sección antes de la transacción" a "unas pocas sentencias dentro de ella"),
no desapareció. Como `confirmRefund()` es de un solo tiro por reserva (Q-C),
ese faltante queda permanente, no un error visible.

Cerrarlo del todo exige releer `collected` DESPUÉS de adquirir algún lock que
también cubra la reserva en sí (no solo sus facturas) — hoy no existe ese
lock. Bloque de diseño aparte, con `architecture-governor` antes de tocar
código — no autorizado en esta sesión.

### FOR-KEY-SHARE-001 — la semántica de bloqueo que sostiene el fix de Residual #2 no está verificada empíricamente

El comentario en `cancellation-refund.service.ts` (sección "residual #2 --
`collected` releído DESPUÉS del pre-lockeo") documenta como **inferencia** que
un INSERT con `settled_invoice_id`/`reversed_invoice_id` apuntando a una fila
`FOR UPDATE` espera hasta el commit (`FOR KEY SHARE` conflictuando con `FOR
UPDATE`). Es comportamiento documentado de Postgres, pero este repo ya se
comió una vez el costo de asumir semántica de locking sin medirla (§7.1 en
`sql.invoice.repository.ts` — las subconsultas correlacionadas quedaban con
la foto vieja). Falta el test de bloqueo dedicado (técnica descrita en
[conocimiento/playbook-idempotencia-bajo-lock.md](conocimiento/playbook-idempotencia-bajo-lock.md),
sección "Tareas futuras") que confirme o desmienta la inferencia contra
Postgres real.

### LOCK-ORDER-001 — el orden canónico de lock sobre `invoices` no está protegido por nada

`customer-account.service.ts` y `cancellation-refund.service.ts` coinciden
HOY en usar `localeCompare` ascendente sobre `invoices.id` antes de lockear
más de una fila — pero es coincidencia mantenida a mano, dos `.sort()`
ad-hoc en archivos distintos, sin helper compartido, sin test, sin regla de
lint que avise si un tercer sitio nuevo ordena distinto (o no ordena). Ya
existe un precedente de comparador DISTINTO en el repo:
`reservation-availability.service.ts:308` usa `[...ids].sort()` sin
`localeCompare`, sobre otra tabla (`resources`) — no choca hoy porque son
dominios distintos, pero es la clase de inconsistencia que un copy-paste
futuro propaga sin que nada la detecte. Detalle en el playbook citado arriba.

---

## 🔴 Arrastrado de `pendientes-2026-09-03.md`

**Sin re-verificar en esta sesión.** Su estado se conserva porque nadie lo
cerró, no porque se haya vuelto a comprobar.

- **Familia ORDER-\*** — ORDER-05, ORDER-06, ORDER-07, ORDER-09, ORDER-10 y
  ORDER-13 siguen abiertos. ORDER-03-b no está cerrado.
- **INV-ORF-01**, **EVT-ORF-01**, **CAJA-ORD-01**, **AUDIT-ORD-01**, **ORDER-12**.
- **O1-b** — los reportes no distinguen "no consta" de "cero".
- **Seguridad / aislamiento:** FACT-INV-BIZID-001, SEC-ROT-001, RBAC-OWN-001,
  RBAC-SYNC-001, RBAC-MOUNT-001, FAILOPEN-001.
- **Documentales:** AUDIT-DOC-001, DA-CONT-001, DOC-ANCLA-001, CONTRACT-001,
  "RBAC mecanismos 1 y 2" (sigue sin referente).
- **Backlog de producto:** Gap C1-C, FISCAL-CBTE-001, FACT-BORRADOR-001,
  C1-Fase A, **C2 (ya no bloqueada, ver arriba — sigue sin construir)**, C3,
  D7, frontend visual (SEM-001, SEM-002, TOAST-003, A11Y-001, overlays de
  Superadmin), heredados (Redis rate-limit, BullMQ, etapas 2-3 de downgrade,
  datos demo en la base real).
- **A7.6** — política de retención escrita: sigue abierto, sin purga para
  `audit_log` ni `domain_events`.
- **AR-FACT-NO-ISSUED-01** — Fase 1 cerrada (`4029b96`, `4d2d694`, `b088cbc`,
  ya en `origin/main`); Fases 2-8 (tabla `invoice_reconciliations`, máquina
  de estados, permiso dedicado de reconciliación) diferidas, con checkpoint
  documental propio (`docs/continuidad-ar-fact-no-issued-01-2026-09-04.md`)
  — no empezar sin releer ese checkpoint primero.

---

## Higiene pendiente — estado

1. **Portar `O4-03` y `O4-11`** al archivo de `origin/main` — bloque de
   código de test, con su propia autorización. **Sigue abierto**, arrastrado
   desde `pendientes-2026-09-03.md`.
2. **6 artefactos untracked sin triage**, señalados por `architecture-governor`
   antes de autorizar el push de esta sesión: `.claude/skills/neon/`,
   `.claude/skills/neon-postgres/`, `.reviews/`, `docs/erp-auditoria-v2/`,
   `docs/programa-auditoria-completitud-erp-2026-09-01.md`, `skills-lock.json`.
   Ninguno se commiteó (staging explícito, sin `-A`, en los 4 commits de esta
   sesión) — pero tampoco se decidió qué hacer con ellos: ¿van al repo,
   a `.gitignore`, o se borran? Decisión pendiente del dueño, uno por uno, en
   un commit de higiene aparte.
