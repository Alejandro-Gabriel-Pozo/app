# Auditoría técnica integral — Fase 3: rastreo de flujos de datos y duplicación semántica

**Fecha:** 15/09/2026. **Alcance:** solo lectura, ningún archivo modificado. Continúa `docs/auditoria-integral-fase0-2026-09-15.md` (estado git/runtime) y `docs/auditoria-integral-fase1-2026-09-15.md` (mapa estructural + cruces de dominio). No repite esos hallazgos.

## Resumen ejecutivo

El punto de partida obligatorio (`docs/erp-auditoria-v2/`, corrida del 02/09/2026, 21 fichas M01–M16/T01–T05) sigue siendo una base sólida y en general vigente, pero **quedó desactualizado en el circuito de mayor riesgo fiscal**: entre el 06/09 y el 15/09 se construyó todo un mecanismo nuevo ("cancelar con Nota de Crédito", ADR común de reservas+órdenes, con doctrina F4 de compensación total, tests de integración contra Postgres real y su propia cerca de RBAC `CN-ESCAPE-CONTAINMENT-001`) que **no tiene un solo punto de entrada desde el frontend**. El hallazgo más grave de esta fase (F3-01/F3-02) es que, hoy, una reserva u orden con factura ya emitida **no se puede cancelar desde el panel bajo ninguna circunstancia**: el botón de cancelar se muestra igual, el backend la rechaza con un mensaje que literalmente le dice al operador "contactá al establecimiento" — mandándolo *fuera del sistema* — cuando el propio backend ya tiene el camino de resolución (`cancel-with-credit-note`, rol `EMISOR_NOTA_CREDITO`) construido, probado y sin usar. Esto contradice el principio que el propio `CLAUDE.md` de `app-main` declara textualmente para este dominio ("la app no le dice al cliente cómo trabajar... no lo manda a resolver por afuera"). Se confirmó además que el endpoint de reversión de traspaso a City Ledger (`POST /accounts-receivable/:id/reverse`, 14/09) y la bandeja de reconciliación manual de `credit-note-requests` (15/09) tienen el mismo patrón: cero consumidores en `appfrontend-main`. Por el lado positivo, se re-confirmó que la auditoría de transiciones de reserva (confirmar/cancelar/completar) **sí existe hoy** — corrige a la baja un hallazgo S1 de la ficha M01 que databa del 02/09 — y que el circuito de ventanas de mantenimiento (D-03) está correctamente conectado end-to-end UI→BD, a diferencia del patrón anterior.

**Nota de procedencia:** este informe fue producido por un agente `erp-audit-orchestrator` (solo lectura, sin `Write`/`Edit`) y persistido en este archivo por la sesión orquestadora, sin ediciones de contenido.

---

## Contexto acumulado

- Fase 0: estado git/runtime/secretos, ya cerrado.
- Fase 1: mapa estructural completo + cruces de dominio (X-01 a X-15), ya cerrado. Su nota de cierre pidió cruzar `docs/erp-auditoria-v2/` antes de seguir — hecho en esta fase.
- Fase 2: 15 decisiones de seguimiento + 3 con grounding ERP, ya implementadas (`docs/decisiones-auditoria-fase2-2026-09-15.md`).
- `docs/erp-auditoria-v2/`: corrida del 02/09/2026, 21 fichas con 158 hallazgos (4 S0, 42 S1...), matriz maestra con 5 patrones transversales. **Verificado en esta fase: el corpus describe correctamente la arquitectura pero quedó atrás en el circuito fiscal de cancelación**, que tuvo desarrollo intenso posterior (06/09 a 15/09, ver `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` y las correcciones sucesivas del conteo de endpoints en `app-main/CLAUDE.md`, de 254→262).

## Feature/circuito priorizado

1. **Reservas end-to-end**, con foco en cancelación con factura viva → Nota de Crédito → City Ledger/accounts_receivable (prioridad 1 del encargo, y el circuito donde se encontró el hallazgo más grave).
2. **Órdenes POS → consumo de inventario** (trazado parcialmente, patrón sano confirmado).
3. **Estadías/housekeeping/ventanas de mantenimiento (D-03)** (trazado parcialmente, confirmado como caso positivo).

## Objetivo de la fase

Reconstruir el lifecycle real (UI → endpoint → servicio → transacción → SQL → evento/outbox → reporte) de los circuitos de mayor impacto de negocio, y catalogar duplicación semántica genuina en el camino de datos, con evidencia `archivo:línea`.

## Alcance incluido

- Circuito de cancelación de reserva con/sin factura viva, desde el botón del dashboard hasta el rechazo o éxito del backend.
- Circuito de cancelación con Nota de Crédito (reservas y órdenes) como mecanismo nuevo, su cobertura de RBAC, y su consumo (o no) desde el frontend.
- Reversión de traspaso a cuentas por cobrar (`accounts-receivable reverse`, 14/09) y su consumo desde el frontend.
- Bandeja de reconciliación manual de solicitudes de Nota de Crédito (`credit-note-requests`, 15/09) y su consumo desde el frontend.
- Verificación puntual de vigencia de 3 fichas del corpus previo (M01 reservas, M10 facturación, M05 caja) contra el código real de hoy.
- Trazado parcial de consumo de inventario en confirmación de orden (`order.confirmed` → outbox → `stock_movements`).
- Verificación de conexión end-to-end de ventanas de mantenimiento (D-03) UI↔backend.

## Alcance excluido (ver "qué no se cubrió")

Trazado completo de cierre de caja/POS→facturación, folio de estadía completo, reportes derivados, y verificación con Postgres real corriendo (esta fase es de código y configuración, igual que las anteriores).

---

## Hallazgos

### F3-01 — La cancelación estándar de una reserva con factura viva es un callejón sin salida en la UI

**Ubicación:**
- Frontend: `appfrontend-main/src/app/dashboard/reservas/[id]/page.tsx:261-277` (`doDetailAction`), `:646-655` (botón "Cancelar reserva", condicionado solo por `reservation.allowedTransitions?.includes('CANCELLED')`).
- Backend: `app-main/src/reservas/reservation.service.ts:959-1008` (`cancelReservation`), guardia en `:973-986` (`findBlockingInvoiceLinkage`, definida en `:946-957`).
- Error: `app-main/src/domain/errors.ts:878-884` (`ReservationChargeInvoicedError`).
- Cálculo de `allowedTransitions`: `app-main/src/reservas/Reservation.ts:361` — máquina de estados pura, **no** conoce el estado de facturación.

**Evidencia:** `allowedTransitions` se computa solo a partir de `status` (CONFIRMED→[COMPLETED,CANCELLED,EXPIRED]), sin mirar si hay un `CHARGE` con factura ISSUED o pendiente. El botón "Cancelar reserva" del dashboard se muestra igual. Al hacer click, `reservationsApi.cancel(id)` (`appfrontend-main/src/lib/reservas/api.ts:72`) llama `POST /api/reservations/:id/cancel`, que ejecuta `cancelReservation()`. Si `findBlockingInvoiceLinkage()` encuentra un `CHARGE` con factura `ISSUED` o `NOT_ISSUED` en `PENDING`/`FAILED_UNCERTAIN`+`afipContacted`, lanza `ReservationChargeInvoicedError`, cuyo mensaje es: *"...no se puede cancelar directamente. Requiere un ajuste administrativo: contactá al establecimiento."* El `catch` del frontend (`page.tsx:272-274`) solo hace `toast(extractErrorMessage(err), 'error')` — no ofrece ningún camino alternativo.

**Comportamiento actual:** el usuario ve el botón, lo aprieta, recibe un toast de error que lo manda a resolver el problema *fuera del sistema* ("contactá al establecimiento"), sin ningún enlace ni acción hacia el mecanismo que sí puede resolverlo (ver F3-02).

**Comportamiento esperado:** según el propio principio declarado en `app-main/CLAUDE.md` (sección "Preguntas de alcance pueden esconder una decisión de negocio", citando `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md`): *"La app no le dice al cliente cómo trabajar; le permite formalizar electrónicamente una decisión que el cliente ya tomó."* Y el caso `CN-ESCAPE-ORPHAN-ADJUSTMENT-001` documentado en el mismo archivo dice explícitamente que el grounding ERP fue unánime en que ningún sistema de referencia bloquea así. El mensaje de error actual es exactamente el patrón que ese mismo documento describe como incorrecto.

**Tipo de problema:** problema confirmado.
**Severidad:** Alta (bloquea una operación de negocio legítima y frecuente — cancelar una reserva facturada — sin ruta de resolución dentro del producto).
**Nivel de certeza:** Alta (código leído completo en las dos puntas, mensaje de error citado literal).
**Impacto:** operativo directo — cualquier reserva confirmada, cobrada y facturada que necesite cancelarse queda atascada; el negocio depende de que alguien con acceso a la API o a la base de datos la resuelva a mano.
**Causa probable:** el mecanismo de resolución (`cancel-with-credit-note`) se construyó como "núcleo + backend" primero (ver F3-02) y el enganche de UI quedó en un sub-bloque posterior no ejecutado todavía.
**Duplicación o contradicción relacionada:** contradice directamente el principio citado en el propio `CLAUDE.md` del repo backend, y reproduce el patrón que el caso `CN-ESCAPE-ORPHAN-ADJUSTMENT-001` (11-12/09/2026) ya identificó y corrigió *a nivel de diseño de backend* — pero la corrección de diseño no llegó a la UI.
**Recomendación:** exponer en el dashboard, cuando `cancelReservation` devuelva `RESERVATION_CHARGE_INVOICED`, una acción "Cancelar con Nota de Crédito" que llame a `POST /:id/cancel-with-credit-note` (rol `EMISOR_NOTA_CREDITO`, ya existe y está probado) en vez de (o además de) mostrar el toast actual.
**¿Requiere modificar código?** Sí — cambio de frontend (y potencialmente de UX/rol, ver pregunta al dueño más abajo). No implementado en esta fase.
**Prueba necesaria:** repro manual — confirmar una reserva, cobrar y facturar el `CHARGE`, intentar cancelar desde el dashboard, confirmar el toast y la ausencia de acción alternativa; luego confirmar que `POST /:id/cancel-with-credit-note` con el rol correcto sí resuelve el caso.

---

### F3-02 — El mecanismo completo "cancelar con Nota de Crédito" (reservas + órdenes) tiene cero consumidores en el frontend

**Ubicación:**
- Núcleo compartido: `app-main/src/facturacion/cancel-with-credit-note.ts:1-30` (docblock explica por qué vive en `facturacion/` — `.dependency-cruiser.cjs` prohíbe imports directos `reservas`↔`pos-menu`).
- Reservas: `app-main/src/facturacion/cancel-reservation-with-credit-note.service.ts`, ruta en `app-main/src/reservas/reservations.routes.ts:519-608` (`POST /:id/cancel-with-credit-note`, `Roles.EMISOR_NOTA_CREDITO`, declarado en el comentario de cabecera `:18`).
- Órdenes: `app-main/src/facturacion/cancel-order-with-credit-note.service.ts`, ruta equivalente en `app-main/src/pos-menu/orders.routes.ts`.
- Cerca de RBAC dedicada: `app-main/src/tests/architecture/credit-note-escape-containment.test.ts` (`CN-ESCAPE-CONTAINMENT-001`), con `ESCAPE_ROUTES` listando exactamente estas dos rutas.
- Frontend: búsqueda `grep -rn "cancel-with-credit-note|cancellation-refund|cancelWithCreditNote" appfrontend-main/src` → **0 resultados**. Búsqueda de UI de notas de crédito en las pantallas de reservas/órdenes → **0 resultados**.

**Evidencia:** el backend tiene, para este mecanismo: la doctrina de compensación total F4 (`isInvoiceFullyCompensatedByIssuedCreditNotes`, `cancel-with-credit-note.ts:117-...`, con tolerancia de redondeo documentada y justificada), exposición forense de City Ledger (`AccountsReceivableRepoForCancel`, `:34-61`, ligada al `diseno-reconciliacion-city-ledger-2026-09-12.md`), tests de integración contra Postgres real (`src/tests/integration/cancel-order-with-credit-note.integration.test.ts`, `cancel-reservation-with-credit-note.integration.test.ts`, `credit-note-cap-service.integration.test.ts`, `credit-note-lines.integration.test.ts`) y una cerca de arquitectura propia que congela el grupo RBAC exacto de las dos rutas. Es, medido por volumen de trabajo (ADR, doctrina documentada, tests de integración, cerca de CI dedicada), una de las inversiones de ingeniería más grandes y mejor cuidadas del repo en las últimas dos semanas — y no tiene ningún punto de entrada desde `appfrontend-main`.

**Comportamiento actual:** el único camino real para ejecutar este mecanismo hoy es una llamada HTTP manual (Postman/curl/script) con un usuario que tenga el rol `EMISOR_NOTA_CREDITO`. Ningún usuario de negocio del panel puede activarlo.

**Comportamiento esperado:** dado el volumen de la inversión y que la cerca `CN-ESCAPE-CONTAINMENT-001` está activa protegiendo el grupo de rol de estas rutas — indicando que el equipo las considera parte del contrato estable de la API — se esperaría un consumidor de UI en el mismo horizonte de trabajo, o al menos una nota explícita de que el frontend queda para un sub-bloque posterior (no encontrada en `app-main/CLAUDE.md` ni en `docs/pendientes-2026-09-12.md` más allá de menciones de verificaciones pendientes puntuales).

**Tipo de problema:** problema confirmado (en cuanto a "producto sin terminar" — el patrón §4.4 de `10-matriz-maestra.md`, "backend construido, producto sin terminar", ya lo tenía identificado en general para 46 endpoints; **esta instancia específica es posterior a esa corrida y no está en su lista**).
**Severidad:** Alta — combinado con F3-01, deja sin resolución de producto un caso de negocio que va a ocurrir con toda seguridad (reserva/orden facturada que necesita cancelarse).
**Nivel de certeza:** Alta (grep negativo confirmado en las dos direcciones: no hay texto "cancel-with-credit-note" en el frontend, y sí existen las rutas, el rol y los tests en el backend).
**Impacto:** operativo y de UX — capacidad construida y no aprovechable por el negocio hasta que se conecte.
**Causa probable:** desarrollo en sub-bloques declarados explícitamente en el propio código (`cancel-with-credit-note.ts:18`: "Alcance de este sub-bloque (B-núcleo+órdenes, 1 de ~6) — SIN callers todavía") — es decir, **el propio autor del código ya declaró que el frontend queda para más adelante**; no es un descuido silencioso, es una fase de un plan de sub-bloques que en esta fecha (15/09) todavía no llegó a la UI.
**Duplicación o contradicción relacionada:** con F3-01 (mismo circuito, dos ángulos) y con el patrón general §4.4 de `10-matriz-maestra.md`.
**Recomendación:** priorizar el sub-bloque de UI de este mecanismo como parte del roadmap inmediato — es, según la propia matriz maestra, "la mejor relación esfuerzo/resultado" (trabajo difícil ya hecho). Ver pregunta al dueño más abajo sobre si esto ya está planificado.
**¿Requiere modificar código?** Sí. No implementado en esta fase.
**Prueba necesaria:** confirmar contra `docs/pendientes-2026-09-12.md` y sesiones posteriores si existe ya un sub-bloque de UI planificado y no ejecutado, antes de tratarlo como hallazgo nuevo puro.

---

### F3-03 — `POST /accounts-receivable/:id/reverse` (City Ledger) sin consumidor en el frontend

**Ubicación:** `app-main/src/clientes-finanzas/accounts-receivable.routes.ts:98-106` (ruta), `:17` (comentario RBAC: `MANAGEMENT` **y** `EMISOR_NOTA_CREDITO`, dos `authorize()` en cadena). Búsqueda `grep -rn "reverse" appfrontend-main/src/lib/finanzas/api.ts` y `grep -rln "reverse" appfrontend-main/src/app/dashboard/` → 0 resultados en ambos.

**Evidencia:** endpoint agregado el 14/09/2026 (Bloque 3c-iii, según `app-main/CLAUDE.md`), documentado como reversión de una transferencia `PENDIENTE_FACTURAR` al City Ledger — capacidad crítica para deshacer un traspaso mal hecho de saldo de estadía a cuenta corriente empresarial. Doble RBAC (`MANAGEMENT` + `EMISOR_NOTA_CREDITO`) indica que se lo trató con el mismo cuidado que el escape de F3-02.

**Comportamiento actual:** solo alcanzable por API directa.
**Comportamiento esperado:** consumo desde alguna pantalla de cuentas corrientes/City Ledger, o declaración explícita de que se posterga.
**Tipo de problema:** problema confirmado (misma familia que F3-02, mismo patrón "backend sin pantalla").
**Severidad:** Media-Alta (menos frecuente que cancelar una reserva, pero es la única forma de corregir un traspaso erróneo).
**Nivel de certeza:** Alta.
**Impacto:** operativo — un traspaso mal hecho a City Ledger queda sin forma de revertirse desde el panel.
**Causa probable:** mismo patrón de desarrollo en sub-bloques que F3-02, feature muy reciente (14-15/09).
**Duplicación o contradicción relacionada:** F3-02.
**Recomendación:** agregar la acción de reversión a la pantalla de cuentas corrientes/City Ledger cuando se aborde F3-02, dado que comparten rol y dominio.
**¿Requiere modificar código?** Sí. No implementado.
**Prueba necesaria:** confirmar si hay un sub-bloque de UI ya planificado para esto en `docs/pendientes-2026-09-12.md` o posteriores.

---

### F3-04 — Bandeja de reconciliación manual de `credit-note-requests` sin consumidor en el frontend

**Ubicación:** `app-main/src/facturacion/credit-note-requests.routes.ts:68-100` (3 endpoints — 2 `GET`, 1 `POST`). Búsqueda `grep -rli "credit-note-request" appfrontend-main/src` → 0 resultados.

**Evidencia:** router agregado el 15/09/2026 (Bloque 5 del ADR común cancelar-con-NC, §6.5 bis, según `app-main/CLAUDE.md` — el mismo bloque que corrigió el conteo de endpoints de 259 a 262), pensado explícitamente como bandeja de reconciliación manual para el caso `ADJUSTMENT` huérfano descrito en `CN-ESCAPE-ORPHAN-ADJUSTMENT-001`.

**Comportamiento actual:** solo alcanzable por API directa; el propósito declarado del router (darle al negocio una salida propia en vez de mandarlo a resolver por afuera) no está disponible para el negocio todavía, porque no hay UI.
**Comportamiento esperado:** una pantalla o sección donde `MANAGEMENT`/`EMISOR_NOTA_CREDITO` pueda ver y completar estos borradores.
**Tipo de problema:** problema confirmado.
**Severidad:** Media (es la pieza más nueva del circuito, del mismo día de esta auditoría — el riesgo de que quede huérfana por mucho tiempo es alto si no se prioriza junto con F3-02).
**Nivel de certeza:** Alta.
**Impacto:** el mecanismo que el propio repo diseñó para *no* bloquear al negocio queda, en la práctica, igual de inalcanzable que si no existiera, hasta que tenga UI.
**Causa probable:** desarrollo por sub-bloques, feature de 15/09 (mismo día del corte de esta auditoría).
**Duplicación o contradicción relacionada:** F3-01, F3-02, F3-03 — las cuatro son la misma historia vista en cuatro puntos del mismo circuito.
**Recomendación:** tratar F3-01 a F3-04 como un solo bloque de trabajo de frontend (no cuatro tickets independientes) cuando se autorice.
**¿Requiere modificar código?** Sí. No implementado.
**Prueba necesaria:** ídem F3-02/F3-03.

---

### F3-05 — Corrección: la ficha M01 (`02/09/2026`) está desactualizada respecto de la auditoría de transiciones de reserva

**Ubicación:** `docs/erp-auditoria-v2/fichas/M01-reservas.md:120-131` (hallazgo `A2-M01-002`, "el servicio central del producto no audita ninguna transición", `grep -c "auditLog|AuditLog" = 0`) vs. código real: `app-main/src/reservas/reservation.service.ts:899-901` (`confirmReservation`), `:990-992` (`cancelReservation`), `:1025-1027` (`completeReservation`) — las tres llaman `auditReservationTransition(client, this.auditLogRepo, reservation.id, previousStatus, reservation.status, changedBy)` dentro de la misma transacción que el `UPDATE`, marcado en comentarios como `// D-10`.

**Evidencia:** `grep -c "auditLog\|AuditLog" src/reservas/reservation.service.ts` da **5** hoy, no 0. El bloque `D-10` es posterior al 02/09 (no aparece en la ficha ni se cita su fecha exacta en el código leído; se infiere posterior porque contradice directamente el hallazgo `A2-M01-002` de esa fecha).

**Comportamiento actual:** confirmar, cancelar y completar una reserva sí quedan auditadas con actor y transición de estado.
**Comportamiento esperado:** ya se cumple — esto es una corrección a favor, no un hallazgo de deuda.
**Tipo de problema:** documentación desactualizada.
**Severidad:** Baja (es una mejora no reflejada, no un riesgo).
**Nivel de certeza:** Alta (5 call sites leídos literalmente, con comentario `D-10` explícito).
**Impacto:** si alguien arrastra `A2-M01-002` como pendiente sin re-chequear el ancla, trabajaría sobre un problema ya resuelto — exactamente el modo de falla que la sección "Pendientes — revalidar antes de arrastrar" de `app-main/CLAUDE.md` describe.
**Causa probable:** el corpus `erp-auditoria-v2` no se revalida automáticamente; nadie lo tocó desde el 02/09.
**Duplicación o contradicción relacionada:** ninguna — es en sí misma la corrección de una posible duplicación de esfuerzo futura.
**Recomendación:** actualizar `fichas/M01-reservas.md` §11 (Auditoría y trazabilidad) y §14 (`A2-M01-002`) para reflejar el estado actual, o marcarla con una nota de vigencia fechada — decisión de mantenimiento documental, no de código.
**¿Requiere modificar código?** No.
**Prueba necesaria:** ninguna adicional — ya verificado por lectura directa.

---

### F3-06 — Reconfirmado: `cbteTipo` sigue fijo en Factura B en los tres puntos del flujo de emisión (M10, sin cambios desde el 02/09)

**Ubicación:** `app-main/src/facturacion/invoice.service.ts:651`, `:805`, `:879` (los tres usan `CBTE_TIPO_FACTURA_B`, importado en `:40`).

**Evidencia:** la ficha `docs/erp-auditoria-v2/fichas/M10-facturacion.md:30-33` citaba las líneas `:368`, `:466`, `:540` para el mismo hallazgo (`A2-M10-001`, severidad S0) — los números de línea se movieron (el archivo creció), pero el patrón es idéntico: no hay selección de tipo de comprobante según la condición fiscal del receptor (`condicion_iva_receptor_id` se captura pero, según la propia ficha, "no participa de la elección del tipo de comprobante").

**Comportamiento actual:** todo comprobante emitido es Factura B, sin importar si el cliente es Responsable Inscripto (que debería recibir Factura A).
**Comportamiento esperado:** selección de `cbteTipo` derivada de la condición fiscal real del receptor.
**Tipo de problema:** problema confirmado (re-verificado, no resuelto desde el 02/09).
**Severidad:** S0 / Alta — es un documento fiscal ante ARCA, y la ficha original ya registra que el dueño confirmó el 01/09 que va a facturar a Responsables Inscriptos, lo cual vuelve el hallazgo aplicable en la práctica, no solo teórico.
**Nivel de certeza:** Alta (3 líneas leídas directamente).
**Impacto:** fiscal — comprobantes potencialmente mal tipificados ante clientes RI.
**Causa probable:** dependencia declarada como externa al código (`docs/diseno-fiscal-profile-resolver-2026-09-01.md`, en HOLD según la propia ficha) — decisión de producto/fiscal pendiente, no un descuido de implementación.
**Duplicación o contradicción relacionada:** `FISCAL-CBTE-001` (ya referenciado en la ficha original).
**Recomendación:** no se propone solución técnica — está fuera del alcance de esta fase y depende de una decisión fiscal externa ya declarada como en HOLD.
**¿Requiere modificar código?** Sí, eventualmente, pero bloqueado por una decisión ya declarada pendiente — no accionable desde esta auditoría.
**Prueba necesaria:** ninguna adicional — solo mantenerlo visible hasta que se resuelva `diseno-fiscal-profile-resolver-2026-09-01.md`.

---

### F3-07 — Reconfirmado: Caja (M05) sigue sin ninguna pantalla en el frontend

**Ubicación:** búsqueda `grep -rli "cash-register|arqueo|caja" appfrontend-main/src` → 0 resultados.

**Evidencia:** coincide exactamente con lo que `docs/erp-auditoria-v2/fichas/M05-caja.md` y `10-matriz-maestra.md` §3 ya describían el 02/09 ("Caja: ◌ Huérfano... la apertura: no hay pantalla"). Sin cambios detectados en el frontend desde entonces.

**Comportamiento actual:** el backend de apertura/cierre/arqueo de caja (`cash_register_shifts`, 5 endpoints) sigue sin ningún punto de entrada de UI.
**Tipo de problema:** deuda técnica (ya conocida, re-verificada, sin cambios).
**Severidad:** S1 (según la matriz maestra original — no escalada ni degradada por esta verificación).
**Nivel de certeza:** Alta.
**Impacto:** sin cambios respecto del 02/09.
**Causa probable:** sin cambios.
**Duplicación o contradicción relacionada:** ninguna nueva.
**Recomendación:** ninguna nueva — la ficha M05 y el bloque B3 de la matriz maestra ("no depende de nada y es de mejor relación esfuerzo/resultado") siguen vigentes tal cual.
**¿Requiere modificar código?** Sí, ya declarado, sin cambios de alcance.
**Prueba necesaria:** ninguna adicional.

---

### F3-08 — Consumo de inventario en confirmación de orden: patrón "insert-then-act" trazado y sano (sin defecto encontrado)

**Ubicación:** `app-main/src/workers/inventory.handlers.ts:1-145` (docblock completo + wiring de `order.confirmed`/`order.cancelled` en `:144-145`).

**Evidencia:** el docblock (líneas 2-87) documenta con precisión el diseño: `OrderService.confirmOrder()` reserva stock atómicamente (`stock_quantity`/`reserved_quantity`) dentro de la misma transacción que confirma la orden; el handler del outbox **consolida** esa reserva (no decrementa desde cero) al procesar el evento `order.confirmed`, usando un insert-then-act sobre `stock_movements` (fila única por combinación orden+ítem como "casillero" que evita doble consolidación entre reintentos). El caso límite documentado explícitamente (líneas 76-78): si el producto se borra entre la reserva y la consolidación, la orden queda con "stock permanentemente desincronizado" — está señalado como límite conocido en el propio código, no oculto.

**Comportamiento actual:** el flujo es: UI confirma orden → `OrderService.confirmOrder()` reserva stock en transacción → evento `order.confirmed` al outbox → `inventory.handlers.ts` consolida en `stock_movements` de forma idempotente ante reintentos.
**Comportamiento esperado:** coincide con el diseño documentado; no se encontró divergencia entre el docblock y el código real en el tiempo disponible de esta fase.
**Tipo de problema:** diferencia legítima entre plataforma y tenant — no aplica; se clasifica como **documentación al día** (caso positivo, se incluye para completar la traza del circuito pedida por el encargo).
**Severidad:** — (sin hallazgo).
**Nivel de certeza:** Media — se leyó el docblock completo y el wiring, pero no se siguió línea por línea toda la implementación de `confirmOrder()` ni se verificó el caso límite de producto borrado contra una corrida real.
**Impacto:** — .
**Causa probable:** — .
**Duplicación o contradicción relacionada:** ninguna detectada.
**Recomendación:** ninguna — se señala el caso límite de "producto borrado entre reserva y consolidación" como candidato a `docs/pendientes-*.md` si no está ya registrado (no se verificó).
**¿Requiere modificar código?** No.
**Prueba necesaria:** para cerrar la traza completa del circuito POS (pedido en el encargo pero no completado en esta fase por tiempo): seguir `confirmOrder()` en detalle, el cierre de caja (bloqueado por F3-07 — no hay UI que lo dispare) y la facturación de la orden.

---

### F3-09 — Ventanas de mantenimiento (D-03): circuito conectado end-to-end, caso de contraste positivo

**Ubicación:** backend `app-main/src/pms-estadias/maintenance-windows.routes.ts` (4 endpoints: `:30`, `:42`, `:59`, `:83`), `maintenance-window.service.ts`, `sql.maintenance-window.repository.ts`; frontend `appfrontend-main/src/lib/maintenance-windows/api.ts` y `types.ts`, consumidos desde `src/components/RoomCalendar.tsx` y `src/app/dashboard/housekeeping/page.tsx`/`[id]/page.tsx`.

**Evidencia:** a diferencia de F3-01 a F3-04, acá `grep -rli "maintenance" appfrontend-main/src` **sí** devuelve resultados reales de consumo, no solo tipos declarados sin uso. `app-main/docs/pendientes-2026-09-12.md:92-97` documenta el detalle del bloque D-03 (horizonte de ventana en dos tramos, commit `dd48592`) y señala honestamente una limitación de su propio test de atomicidad: `maintenance-window.service.test.ts` corre contra `InMemoryTransactionManager` (sin `BEGIN`/`COMMIT`/`ROLLBACK` real), por lo que confirma que el wiring usa una sola invocación de `transactionManager.run()` mezclando ventana + reservas, pero **no** confirma que Postgres real revierta correctamente ante un fallo a mitad de camino.

**Comportamiento actual:** el circuito UI→endpoint→servicio→BD está conectado y en uso real.
**Tipo de problema:** deuda técnica (acotada, ya declarada por el propio repo) — el hueco es la verificación de atomicidad contra Postgres real, no el wiring en sí.
**Severidad:** Baja-Media (el propio repo ya lo etiquetó como verificación pendiente, no como bug).
**Nivel de certeza:** Alta para "está conectado"; Media para "el detalle de atomicidad contra Postgres real" (no verificado en esta fase, solo se leyó lo que `pendientes-2026-09-12.md` ya declara).
**Impacto:** bajo si el wiring de una sola transacción es correcto (probable, dado el patrón repetido en el resto del repo); requeriría confirmación con Postgres real para cerrar del todo.
**Causa probable:** limitación conocida y declarada de la suite de tests (fake in-memory vs. Postgres real).
**Duplicación o contradicción relacionada:** ninguna.
**Recomendación:** ninguna nueva — ya está anclado en `docs/pendientes-2026-09-12.md` como verificación pendiente.
**¿Requiere modificar código?** No para el wiring; sí (test nuevo de integración) para cerrar la verificación de atomicidad.
**Prueba necesaria:** test de integración contra Postgres real que fuerce un fallo a mitad de la transacción de `maintenance-window.service.ts` y confirme rollback completo (ventana + reservas afectadas).

---

## Preguntas para el dueño (no resueltas por esta auditoría)

1. **F3-02/F3-03/F3-04**: ¿el frontend de "cancelar con Nota de Crédito", de reversión de City Ledger y de la bandeja de reconciliación ya está planificado como el próximo sub-bloque de trabajo, o quedó fuera del roadmap actual? El propio código (`cancel-with-credit-note.ts:18`) declara "B-núcleo+órdenes, 1 de ~6" — ¿cuáles son los ~5 sub-bloques restantes y en qué orden?
2. **F3-01**: cuando se conecte la UI, ¿la acción "cancelar con Nota de Crédito" debería ofrecerse directamente en el botón "Cancelar reserva" existente (mismo botón, mismo rol si el usuario lo tiene) o como una acción separada visible solo para `EMISOR_NOTA_CREDITO`/`MANAGEMENT`? Es una decisión de UX/permisos, no técnica.
3. **F3-06**: sigue abierta la pregunta ya declarada en `diseno-fiscal-profile-resolver-2026-09-01.md` (en HOLD) — no se re-abre acá, solo se confirma que sigue sin resolver en el código.

---

## Qué no se cubrió y por qué

1. **Trazado SQL/outbox línea por línea de `confirmOrder()`, cierre de caja, y facturación de orden completa.** F3-08 documenta el patrón general (bien resuelto) pero no siguió cada `await` hasta el `INSERT` final ni verificó los reportes derivados — tiempo insuficiente en esta fase para los tres circuitos pedidos con la misma profundidad.
2. **Folio de estadía como documento de entrega y housekeeping completo (M09/M15).** Solo se verificó el enganche de ventanas de mantenimiento (F3-09); no se re-auditó el resto de `fichas/M09-housekeeping.md`/`M15-estadias.md` contra el código actual — se asume vigente por defecto dado que no hubo señal de cambios recientes en esos archivos, pero **no está verificado**, solo inferido de la ausencia de menciones en `app-main/CLAUDE.md` reciente.
3. **Verificación con Postgres real, corridas de concurrencia, y ejecución de tests.** Igual que en Fases 0-2, esta fase es de código y configuración únicamente — ningún test se corrió, ninguna base se consultó.
4. **Revalidación completa de las 21 fichas de `erp-auditoria-v2` línea por línea.** Se hizo spot-check dirigido (M01, M05, M10) sobre los circuitos priorizados por el encargo; las 18 fichas restantes se asumen vigentes por defecto (fecha 02/09, sin señal de cambio posterior detectada por esta fase) pero **no fueron re-verificadas** contra el código de hoy.
5. **Duplicación semántica fuera del camino de reservas/facturación.** El encargo pedía catalogar duplicación semántica en el camino de datos en general; esta fase, por restricción de tiempo, se concentró en el circuito de cancelación fiscal (el de mayor impacto de negocio) y no relevó sistemáticamente duplicación en Reportes (M11), Portal de clientes (M13) ni Plataforma (M14).
6. **Grounding contra sistemas ERP de referencia.** No incluido en el encargo original de este agente — el dueño lo pidió después de ver este informe, como complemento a despachar por separado (ver nota de seguimiento al final de esta sesión).
