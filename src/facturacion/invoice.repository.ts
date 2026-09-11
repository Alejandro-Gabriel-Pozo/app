import type { Invoice, CreateInvoiceInput, InvoiceStatus, InvoiceItem, CreateInvoiceItemInput, UnreconciledLiveInvoice } from './invoice.entities.js';
import type { SqlClient } from '../repositories/sql.client.js';

export interface MarkIssuedInput {
  cbteNro: number;
  cae: string;
  caeVto: string;
  afipResponse: unknown;
}

export interface MarkFailedInput {
  status: 'REJECTED' | 'FAILED_UNCERTAIN';
  errorMessage: string;
  afipResponse?: unknown;
  /** Ver `Invoice.afipContacted` — obligatorio, cada call site de
   * `markFailed()` sabe si createNextVoucher() llegó a invocarse. */
  afipContacted: boolean;
}

/**
 * AR-FACT-NO-ISSUED-01 (05/09/2026) -- resultado de resolver qué factura
 * interna cubre un `financial_transaction_id`, distinguiendo los TRES
 * estados que antes colapsaban en `string | null`. Ver
 * `InvoiceRepository.resolveInvoiceLinkage()`.
 */
export type InvoiceLinkage =
  | { kind: 'NONE' }
  | { kind: 'NOT_ISSUED'; invoiceId: string; status: 'PENDING' | 'REJECTED' | 'FAILED_UNCERTAIN'; afipContacted: boolean }
  | { kind: 'ISSUED'; invoiceId: string };

export interface InvoiceRepository {
  getById(id: string): Promise<Invoice | null>;
  getByIdempotencyKey(idempotencyKey: string): Promise<Invoice | null>;
  getByFinancialTransactionId(financialTransactionId: string): Promise<Invoice[]>;
  /**
   * C2 (23/08/2026, docs/diseno-cancelacion-notas-credito-c2-2026-08-23.md)
   * — todas las facturas (cualquier status) de una reserva. Bloque 3.1
   * (08/09/2026, ADR común cancelar-con-NC §6.1) — resuelve por los DOS
   * caminos: individual (`financial_transactions.reservation_id`) y
   * consolidada (`invoice_charges.financial_transaction_id` →
   * `financial_transactions.reservation_id`), `UNION` con dedup. Antes
   * (C2 original) era ciego a las consolidadas — hallazgo #1 del ADR.
   * Sin filtro de status (R2) — `CancellationRefundService.confirmRefund()`
   * filtra a `ISSUED` + Factura B y ordena por `issuedAt` para el reparto
   * LIFO, y desde 3.1 rechaza fail-closed (`ReservationOnConsolidatedInvoiceError`)
   * si alguna de las `ISSUED` es consolidada — ver el guard en el service.
   */
  getByReservationId(reservationId: string): Promise<Invoice[]>;
  /**
   * C1-Fase C (23/08/2026), predicado corregido 11/09/2026 en 2 rondas
   * (hueco de doble comprobante, gate `architecture-governor`) — de la
   * lista dada, cuáles YA tienen un comprobante vivo por CUALQUIERA de
   * los 2 caminos de emisión. Guard contra double-billing en
   * `InvoiceService.requestConsolidatedInvoice()`: una fila
   * `accounts_receivable` PENDIENTE_FACTURAR cuyo cargo YA está
   * facturado (por la vía consolidada -- `invoice_charges` -- o por la
   * vía individual -- `invoices.financial_transaction_id` directo, ej.
   * alguien clickeó "Facturar" en cuentas-corrientes sobre ese mismo
   * cargo) no se puede volver a facturar.
   *
   * **DOS ramas, DOS políticas de status distintas, a propósito -- no
   * armonizar sin re-derivar cada una:**
   *
   * 1. **`invoice_charges` (ronda 1, `INVOICE-CHARGES-GUARD-INDIVIDUAL-01`)
   *    -- status-agnóstico, SIN filtro.** El recurso protegido es la fila
   *    `invoice_charges` en sí -- se inserta ANTES de llamar a AFIP, en la
   *    misma transacción que la factura `PENDING`
   *    (`sql.invoice.repository.ts::createWithClient()`), y **nunca se
   *    borra**, sea cual sea el desenlace (`ISSUED`, `REJECTED`,
   *    `FAILED_UNCERTAIN` quedan todos con su `invoice_charges` intacto).
   *    `idx_invoice_charges_ft` (`schema.sql`) es un índice ÚNICO sobre
   *    `financial_transaction_id` sin `WHERE` de status -- filtrar acá
   *    dejaría pasar el guard para un INSERT que igual choca contra el
   *    índice, solo que con un 23505 crudo en vez de
   *    `AccountsReceivableAlreadyInvoicedError`.
   * 2. **`invoices.financial_transaction_id` directo (ronda 2,
   *    `INVOICE-CHARGES-GUARD-1BIS-01`) -- filtrada por
   *    `INVOICE_STATUSES_CONSUMING_CHARGE`
   *    (`ISSUED`/`PENDING`/`FAILED_UNCERTAIN`, NO `REJECTED`).** Acá NO
   *    hay índice único forzando nada -- una factura individual
   *    `REJECTED` sobre este mismo `ftId` es perfectamente reintentable
   *    (mismo `idempotencyKey` determinístico, `retryExisting()` la
   *    reemite) y AFIP confirmó que no existe, así que no debe bloquear
   *    para siempre (decisión del dueño, grounding ERP: Odoo excluye
   *    `state=='cancel'` de `qty_invoiced`, ERPNext excluye
   *    `docstatus==2`).
   *
   * **Asimetría real, declarada a propósito**: un cargo cuya factura
   * CONSOLIDADA fue `REJECTED` queda bloqueado para re-consolidarse PARA
   * SIEMPRE (rama 1, sin filtro) -- pero SÍ es facturable por el camino
   * individual (`InvoiceService.requestInvoice()`, ronda 1 lo permitió a
   * propósito). No son la misma pregunta: "¿puedo facturar este cargo
   * DE NUEVO por otra vía?" (rama 2, permisivo con `REJECTED`) vs.
   * "¿puede este cargo terminar en DOS `invoice_charges`?" (rama 1,
   * nunca, es lo que el índice único ya impide). Ver el test dedicado en
   * `consolidated-invoice-toctou.integration.test.ts` que fija esta
   * asimetría -- si algún día se "corrige" armonizando las dos ramas, ese
   * test tiene que romper primero.
   *
   * **Supuesto de código, sin constraint que lo fuerce**: la rama 2 no
   * puede matchear una Nota de Crédito -- las NC persisten el id del
   * REFUND/ADJUSTMENT que revierten (`InvoiceService::buildCreditNote()`),
   * nunca el id del CHARGE original, y el único creador de
   * `accounts_receivable.financialTransactionId` que alimenta este guard
   * (`AccountsReceivableService::transferStayBalanceToReceivable()`,
   * `accounts-receivable.service.ts:169`) hardcodea `type: 'CHARGE'`. Es
   * un invariante de código (un solo call-site), no un CHECK de schema --
   * si aparece un segundo creador de AR que no sea `CHARGE`, revisar esto.
   *
   * **Diagnóstico**: el `Set` devuelto no distingue de qué rama vino cada
   * id -- si hace falta saber CUÁL de los 2 caminos ya facturó un cargo
   * puntual para atender un caso real, usar `resolveInvoiceLinkage()`
   * (mismo archivo), que sí lo distingue.
   *
   * Predicados distintos sobre "¿este cargo tiene un comprobante vivo?"
   * conviven a propósito en este archivo -- responden preguntas distintas
   * sobre las mismas tablas, no unificar sin re-derivar cada uno:
   *
   * | Predicado                                              | Pregunta                                  | Status               |
   * |---------------------------------------------------------|--------------------------------------------|----------------------|
   * | este método, rama `invoice_charges`                     | ¿puedo re-consolidar este cargo?          | agnóstico (índice único lo fuerza) |
   * | este método, rama `invoices` (1-bis)                     | ¿puedo facturar individual este cargo?    | `INVOICE_STATUSES_CONSUMING_CHARGE` |
   * | guard de `InvoiceService.requestInvoice()`               | ¿emito individual ahora?                  | `INVOICE_STATUSES_CONSUMING_CHARGE` |
   * | `getFinancialTransactionIdsCoveredByConsolidated()` (abajo) | ¿tiene sentido ofrecer el botón en la UI? | `INVOICE_STATUSES_CONSUMING_CHARGE`, solo rama `invoice_charges` |
   * | `getInFlightCreditNoteTotalForUpdate()`/`ForPair`         | ¿queda cupo para otra NC?                 | `INVOICE_STATUSES_CONSUMING_CHARGE` |
   * | `sql.financial-transaction.repository.ts`                | ¿anulo este CHARGE?                       | (propio, ver ese archivo) |
   */
  getInvoicedFinancialTransactionIds(financialTransactionIds: string[]): Promise<Set<string>>;
  /**
   * `INVOICE-CHARGES-GUARD-FRONTEND-02` (11/09/2026, Bloque 2, gate
   * `architecture-governor`) — de la lista dada, cuáles NO tiene sentido
   * ofrecer para facturación individual porque están cubiertos por una
   * consolidada VIVA (no `REJECTED`). Consumidor: `GET /customers/:id/account`,
   * para que `FacturarButton` (appfrontend-main) oculte el botón en ese
   * caso puntual -- nunca para el resto de los estados de una factura
   * INDIVIDUAL propia (`ISSUED` sigue mostrando CAE+PDF, `PENDING`/
   * `FAILED_UNCERTAIN` siguen ofreciendo "Reintentar factura" -- grounding
   * ERP verificado: ningún ERP maduro oculta un documento fiscal en curso o
   * fallido, lo muestra con su estado y una acción de reintento, ej. Odoo
   * `account_edi` `action_retry_edi_documents_error`).
   *
   * **Criterio de diseño, sin margen de interpretación**: este método
   * devuelve `true` para un `ftId` EXACTAMENTE cuando
   * `InvoiceService.requestInvoice()` lanzaría
   * `InvoiceAlreadyLinkedByOtherPathError` -- el botón no tiene que
   * adivinar nada, solo no ofrecer una acción que el backend va a
   * rechazar. Por eso el predicado filtra por
   * `INVOICE_STATUSES_CONSUMING_CHARGE` igual que ese guard -- **NO** es
   * el mismo predicado status-agnóstico de la rama `invoice_charges` de
   * `getInvoicedFinancialTransactionIds()` de arriba (esa responde "¿puede
   * este cargo re-consolidarse?", forzada por `idx_invoice_charges_ft`
   * único; ésta responde "¿tiene sentido ofrecer el botón individual?").
   * Una consolidada `REJECTED` deja el cargo bloqueado para re-consolidar
   * PARA SIEMPRE (esa rama), pero SÍ facturable individual (este método
   * debe devolver `false` para ese caso, dejando el botón visible) --
   * confundir los dos predicados fue exactamente la regresión que este
   * método corrige (esconder el botón también sobre una consolidada
   * `REJECTED`, dejando el único camino restante -- el individual --
   * inalcanzable desde la UI).
   *
   * Cuarto predicado sobre "¿este cargo tiene un comprobante vivo?" en
   * este archivo (ver la tabla completa en el docblock del método de
   * arriba) -- no unificar con ninguno de los otros tres sin re-derivar.
   */
  getFinancialTransactionIdsCoveredByConsolidated(financialTransactionIds: string[]): Promise<Set<string>>;
  /**
   * `INVOICE-CHARGES-BUTTON-DEADEND-01` (11/09/2026, gate
   * `architecture-governor`, opción B) — método HERMANO de
   * `getFinancialTransactionIdsCoveredByConsolidated()` de arriba, mismo
   * predicado exacto (mismo `WHERE`, mismo filtro
   * `INVOICE_STATUSES_CONSUMING_CHARGE`), pero devuelve el `invoiceId` de
   * la consolidada en vez de solo el `Set` de cargos cubiertos -- para que
   * el frontend pueda armar un link preciso cargo→factura en vez de
   * mandar al usuario a la lista completa del cliente a buscarlo.
   * Deliberadamente un método nuevo, NO una firma cambiada del de arriba
   * (mismo criterio que forzó separar este archivo de
   * `getInvoicedFinancialTransactionIds()`): cambiar el tipo de retorno
   * de un método ya consumido rompe silenciosamente a quien solo
   * necesita el booleano de cobertura.
   */
  getConsolidatedInvoiceIdsForFinancialTransactions(financialTransactionIds: string[]): Promise<Map<string, string>>;
  /**
   * I4 (23/08/2026, pendientes-2026-08-23.md — conciliación de pagos,
   * verificación de auditoría externa) — facturas `ISSUED` de un cliente
   * (excluye Notas de Crédito, que se emiten desde `type='REFUND'`) con
   * saldo pendiente > 0. `outstanding = impTotal - pagado (settled_invoice_id)
   * - acreditado (reversed_invoice_id)`, ambos solo `SETTLED`. Usado por
   * el modal de conciliación de "Registrar Pago"
   * (`dashboard/cuentas-corrientes`) para listar qué facturas puede saldar
   * un pago nuevo.
   */
  getOutstandingByCustomerId(customerId: string): Promise<Array<Invoice & { outstanding: number }>>;
  /**
   * O2-F2 (03/09/2026, F2.2 -- visibilidad) — TODAS las facturas de un
   * cliente, cualquier status, sin filtrar por saldo pendiente. A diferencia
   * de `getOutstandingByCustomerId` (que alimenta el modal de conciliación
   * de pagos) esta es la lectura genérica "qué facturas tiene este cliente"
   * -- antes de esta sesión no existía ningún endpoint que la expusiera para
   * facturas consolidadas (`financial_transaction_id IS NULL`), así que no
   * había forma de listarlas por cliente en absoluto.
   */
  getByCustomerId(customerId: string): Promise<Invoice[]>;
  /**
   * B3 bloque 2.1 (08/09/2026, `docs/pendientes-2026-09-08.md` #4a) —
   * localizar un caso trabado (NC/factura `PENDING` o `FAILED_UNCERTAIN`
   * que nadie resolvió) sin conocer de antemano su `financialTransactionId`
   * ni `customerId` — hoy solo se puede por SQL directo contra la tenant
   * (D1 del ADR común cancelar-con-NC, "una NC trabada no se puede
   * localizar por API"). Deliberadamente sin filtro de `businessId`: el
   * aislamiento ya es físico (una BD por negocio, A2.8), mismo criterio que
   * `getByCustomerId`. Orden `created_at ASC` — el más viejo primero, que es
   * el único motivo por el que la bandeja existe (distinguir "trabado hace 3
   * minutos" de "trabado hace 3 días"). NO es la bandeja completa de B3 (esa
   * necesita `credit_note_request`, bloque 2.3, todavía sin gate) — es la
   * consulta mínima que da la mayor parte del valor sin schema nuevo.
   */
  getByStatus(status: InvoiceStatus): Promise<Invoice[]>;
  /**
   * O2-F2 (03/09/2026, F2.3) / AR-FACT-NO-ISSUED-01 (05/09/2026,
   * architecture-governor, paquete post-H-A, "P0") -- dado el
   * `financial_transaction_id` de una fila `accounts_receivable`, resuelve
   * qué factura interna lo cubre y en qué estado está. Reemplaza a
   * `getInvoiceIdByFinancialTransactionId(): Promise<string | null>`
   * (removido en este mismo cambio, un solo caller productivo,
   * `AccountsReceivableService.markCollected()`) porque ese método
   * colapsaba DOS situaciones bajo el mismo `null`: "no hay ninguna
   * factura interna" (legítimo -- fila legacy o facturación externa
   * permanente, §5.1(b) de `docs/diseno-o2-f2-cierre-completo-2026-09-03.md`)
   * y "hay una factura interna pero no está ISSUED todavía" (el bug real:
   * `markCollected()` caía al fallback legacy sobre una factura que
   * podía llegar a ISSUED después, habilitando doble cobro).
   *
   * Prueba primero el camino individual (`invoices.financial_transaction_id`
   * directo), si no matchea el consolidado (`invoice_charges.financial_transaction_id`).
   * Sin filtro de `status` -- a diferencia del método que reemplaza, trae
   * la fila exista en el estado que exista, ordenada
   * `(status = 'ISSUED') DESC, created_at DESC` (si por algún motivo
   * hubiera más de una, cosa que el índice único `idx_invoice_charges_ft`
   * y la clave de idempotencia determinística no deberían permitir, prioriza
   * la emitida).
   */
  resolveInvoiceLinkage(financialTransactionId: string): Promise<InvoiceLinkage>;
  /**
   * O2-F1 (03/09/2026, decisión del dueño: opción B, aplicación parcial
   * controlada) — saldo pendiente de UNA factura puntual, calculado con
   * `SELECT ... FOR UPDATE` sobre la fila de `invoices` dentro de la
   * transacción del caller. No es una lectura suelta: `recordPayment()`
   * la usa para serializar dos pagos concurrentes contra la misma
   * factura -- el segundo espera a que el primero commitee y recién ahí
   * lee el saldo YA actualizado, en vez de los dos leyendo el saldo viejo
   * a la vez y sobre-aplicando los dos (A8.1/A8.2, mismo patrón que
   * `ResourceRepository.lockByIds()`).
   *
   * Misma fórmula que `getOutstandingByCustomerId` (impTotal - pagado -
   * acreditado, ambos solo SETTLED) pero acotada a un id y con el lock.
   * Lanza si la factura no existe -- a esta altura ya se validó su
   * existencia fuera de la transacción; que no aparezca acá es un
   * invariante roto, no un 404 de negocio.
   */
  getOutstandingForUpdate(client: SqlClient, invoiceId: string): Promise<number>;
  /**
   * BRECHA-REFUND-01 Fase 3 (05/09/2026, architecture-governor) — cuánto
   * de UNA factura puntual todavía se puede reembolsar, con `SELECT ...
   * FOR UPDATE` dentro de la transacción del caller (mismo patrón de dos
   * sentencias que `getOutstandingForUpdate` §7.1 -- lock primero, sin
   * subconsultas; cómputo después, sentencia nueva, foto fresca).
   *
   * NO es el espejo de `getOutstandingForUpdate()` con el signo dado
   * vuelta -- un reembolso no capa contra "cuánto falta cobrar"
   * (`outstanding`, que ya resta los REFUND -- capar un reembolso contra
   * eso daría siempre 0, porque son las mismas facturas que un reembolso
   * ataca). Capa contra el mínimo de dos invariantes:
   *  (A) cuánto entró realmente por esta factura y todavía no se devolvió
   *      (pagado − ya reembolsado) -- nunca reembolsar más plata de la
   *      que efectivamente entró;
   *  (B) cuánto vale el comprobante y todavía no se acreditó (impTotal −
   *      ya reembolsado) -- invariante fiscal frente a ARCA, nunca
   *      acreditar una NC por más que el valor facial.
   * En la práctica (A) ≤ (B) siempre (el pagado ya está capado contra
   * impTotal desde el lado del cobro) -- pedir las dos es gratis y deja
   * los dos invariantes escritos, no solo el que domina hoy.
   */
  getRefundableForUpdate(client: SqlClient, invoiceId: string): Promise<number>;
  /**
   * ADR común cancelar-con-NC (06/09/2026, N1 / predicado **F4**) — suma el
   * `imp_total` de las Notas de Crédito **`ISSUED`** que compensan la
   * factura `invoiceId`. Mitad SQL de F4; la mitad de doctrina es
   * `isInvoiceFullyCompensatedByIssuedCreditNotes()` en
   * `cancel-with-credit-note.ts`.
   *
   * "Compensan" = existe una transacción revertidora `r`
   * (`financial_transactions.reversed_invoice_id = invoiceId`, `type` en
   * `REFUND`/`ADJUSTMENT` — la whitelist de N1.b; desde schema v47 el CHECK
   * `chk_financial_transactions_reversed_invoice_type` la respalda, el filtro
   * queda como defensa en profundidad fail-closed) cuya PROPIA factura de NC
   * está `ISSUED`. El vínculo transacción→NC se resuelve con
   * el MISMO `UNION ALL` que `resolveInvoiceLinkage()`: individual
   * (`invoices.financial_transaction_id`) o consolidada (`invoice_charges`).
   *
   * Anclado al comprobante emitido, NUNCA al ledger (Defecto B del
   * re-gate): un `REFUND`/`ADJUSTMENT` `SETTLED` sin NC `ISSUED` suma 0. NO
   * filtra por `r.status` a propósito — si la NC llegó a AFIP, el crédito
   * existe con independencia del estado local de la fila revertidora.
   *
   * `0` si no hay ninguna NC `ISSUED`. Suma en la moneda de las NC (N4
   * exige misma moneda NC↔factura — no se mezclan). SIN caller todavía: F4
   * se cablea en `findBlockingInvoiceLinkage()` en un sub-bloque posterior.
   * Recibe `client` (NO toma lock — el lock es sobre la fila del ORIGEN,
   * N10, responsabilidad del caller) para poder leer dentro de la
   * transacción del caller.
   */
  getIssuedCreditNoteCompensationTotal(client: SqlClient, invoiceId: string): Promise<number>;
  /**
   * Bloque 2.4 (tope N5, `docs/pendientes-2026-09-08.md` #21) — lock +
   * suma de NC EN VUELO (`ISSUED` + `PENDING` + `FAILED_UNCERTAIN`) contra
   * `invoiceId`, para el tope fail-closed que `buildCreditNote()` chequea
   * antes de armar una NC nueva. Pregunta distinta de F4
   * (`getIssuedCreditNoteCompensationTotal`, solo `ISSUED`, "¿puedo cancelar
   * normalmente?"): acá es "¿queda cupo para OTRA NC?" — no invierte la
   * doctrina F4, F4 no se toca. Excluye `REJECTED` (AFIP confirmó que no
   * existe) — ver docblock de la implementación para el bypass declarado de
   * `retryExisting()` que esa exclusión abre (condición C1 del gate
   * 08/09/2026, hoy inalcanzable, se vuelve alcanzable con el bloque 3.1).
   * Toma el lock ANTES del cómputo, dos sentencias separadas (mismo patrón
   * que `getRefundableForUpdate`/`getOutstandingForUpdate` — evita foto
   * vieja de subconsultas correlacionadas al esperar el lock bajo Postgres
   * real).
   */
  getInFlightCreditNoteTotalForUpdate(client: SqlClient, invoiceId: string): Promise<number>;
  /**
   * Bloque 3.3-a (08/09/2026, gate `architecture-governor`) — mismo tope
   * que `getInFlightCreditNoteTotalForUpdate()` (ISSUED + PENDING +
   * FAILED_UNCERTAIN, excluye REJECTED) pero acotado a UN sujeto (reserva u
   * orden) dentro de una factura consolidada — el sujeto de la transacción
   * REVERTIDORA, no de la factura. Necesario porque el tope global topea la
   * factura ENTERA: una consolidada con cupo global de sobra puede aun así
   * dejar que un sujeto puntual se lleve más de lo que le corresponde
   * (`resolveRefundableForPair()`, N4-a). Los dos topes CONVIVEN, no se
   * reemplazan — este es adicional, no un sustituto.
   *
   * Toma su PROPIO lock (`SELECT 1 FROM invoices WHERE id = $1 FOR UPDATE`,
   * corrección del gate 08/09/2026) — autocontenido, no depende de que el
   * caller haya llamado antes a `getInFlightCreditNoteTotalForUpdate()` en
   * la misma transacción. Sobre una fila que la misma transacción ya tiene
   * lockeada (el caso real, `buildCreditNote()` llama a los dos seguidos)
   * el lock es instantáneo — no hay costo por sostenerlo dos veces.
   *
   * `subject` (1c-ii-a, 11/09/2026, gate `architecture-governor`) —
   * generalizado de `reservationId: string` a un discriminador cerrado
   * (`RESERVATION`/`ORDER`) para que el bloque 1c-ii-b (atribución de
   * órdenes en `buildCreditNote()`, todavía en HOLD) pueda reusar este
   * mismo método en vez de un hermano nuevo `...ForOrderPairForUpdate` —
   * un método nuevo sería invisible para `lock-order.test.ts` (`LOCK_CALL_RE`)
   * hasta que alguien se acordara de sumarlo a mano. Sin consumidor de
   * `kind: 'ORDER'` todavía; el único call site real
   * (`invoice.service.ts`) sigue pasando `kind: 'RESERVATION'`.
   */
  getInFlightCreditNoteTotalForPairForUpdate(
    client: SqlClient,
    invoiceId: string,
    subject: { kind: 'RESERVATION' | 'ORDER'; id: string },
  ): Promise<number>;
  /**
   * ADR común cancelar-con-NC (§3 N1.a(iii)) — devuelve los
   * `financial_transactions.id` de los CARGO(s) que la factura `invoiceId`
   * facturó: el camino individual (`invoices.financial_transaction_id`) más
   * el consolidado (`invoice_charges.financial_transaction_id`).
   *
   * Es el **inverso** de `resolveInvoiceLinkage()` y la razón de que exista
   * es N1.a(iii): el `UPDATE` dirigido que sella el CARGO revertido tiene
   * que derivar su conjunto de ids **de la FACTURA que se está revirtiendo**,
   * nunca de "todos los cargos del documento". Para una orden el conjunto es
   * siempre `{charge.id}` (una orden = un CHARGE, índice único v45); el
   * orquestador igual lo pide para el assert defensivo de N2.a (si diera
   * cardinalidad ≠ 1 la NC abarcaría >1 factura y hay que abortar).
   *
   * Orden y unicidad no garantizados — el caller compara como conjunto.
   */
  getChargeIdsForInvoice(invoiceId: string): Promise<string[]>;
  /**
   * ADR común cancelar-con-NC — sub-bloque 5 (b). Clasifica el estado
   * "comprobante fiscal vivo" de una ORDEN ya `CANCELLED`, para que
   * `handleOrderCancelled` decida si el rechazo `CARGO_CON_COMPROBANTE_VIVO`
   * de `voidByOrderId()` es una **anomalía de integridad** (`grave`) o el
   * **estado esperado** de un escape reconciliado (`info`).
   *
   * `'RECONCILED'` ⟺ **las DOS condiciones**:
   *  1. (fiscal — el ancla, `cancel-with-credit-note.ts:63-70`) toda Factura B
   *     (`cbte_tipo = 6`) `ISSUED` ligada a un CHARGE de la orden está
   *     **totalmente compensada** por Notas de Crédito `ISSUED`
   *     (`isInvoiceFullyCompensatedByIssuedCreditNotes()` +
   *     `getIssuedCreditNoteCompensationTotal()` — F4, reusado verbatim, sin
   *     SQL de compensación nuevo);
   *  2. (ledger — conjunción que sólo ESTRECHA, nunca invierte la doctrina)
   *     toda fila revertidora de esas facturas
   *     (`financial_transactions.reversed_invoice_id IN (...)`,
   *     `type IN ('REFUND','ADJUSTMENT')`) está en `status = 'SETTLED'`, y hay
   *     al menos una — un `ADJUSTMENT` `PENDING` (tx2 sin commitear) NO netea
   *     el saldo del cliente (`invoice.repository.ts:57-58`: outstanding cuenta
   *     sólo `SETTLED`), así que "cubierto fiscalmente" no basta.
   *
   * `'NOT_RECONCILED'` en todo lo demás — **fail-closed**: Factura B sin
   * compensar del todo, compensación parcial, comprobante `PENDING`/
   * `FAILED_UNCERTAIN` con `afip_contacted` (CAE en vuelo, todavía sin NC),
   * fila revertidora `PENDING`, cero filas revertidoras, o cero Factura B
   * `ISSUED`. NO se pregunta "¿vino del escape?" — se pregunta si el
   * comprobante vivo está cubierto por otro comprobante Y el ledger cerró;
   * una tercera puerta futura que llegue a `CANCELLED` sin emitir su NC sigue
   * dando `NOT_RECONCILED` → `grave`.
   *
   * Doctrina ya grondeada contra ERPNext + Odoo 19 (commit `af2b2b5`,
   * `docs/pendientes-2026-09-06.md` ítem 5): ninguna referencia revierte el
   * asiento de la factura original al cancelar el documento de venta — los dos
   * asientos quedan en pie neteados; que `voidByOrderId()` se niegue a anular
   * el par `CHARGE`/`ADJUSTMENT` `SETTLED` es LO CORRECTO, lo único mal
   * clasificado es la severidad.
   *
   * Recibe `client` (mismo criterio que `getIssuedCreditNoteCompensationTotal`):
   * `handleOrderCancelled` no abre transacción, le pasa el `SqlClient` crudo
   * del tenant. **Lectura sin lock** — una emisión de NC concurrente podría
   * dejar la clasificación vieja; para un nivel de log es tolerable y el
   * próximo evento de esa orden la re-evalúa.
   */
  classifyOrderLiveInvoice(client: SqlClient, orderId: string): Promise<'RECONCILED' | 'NOT_RECONCILED'>;
  /**
   * Bloque 3.3-d (09/09/2026, gate `architecture-governor`) — espejo de
   * `classifyOrderLiveInvoice()` de arriba, lado RESERVAS, para que
   * `handleReservationCancelled` decida la severidad del rechazo
   * `CARGO_CON_COMPROBANTE_VIVO` de `voidByReservationId()`. Mismas dos
   * condiciones (F4 fiscal + ledger `SETTLED`), mismo fail-closed, MISMA
   * doctrina — pero con TRES divergencias reales frente a órdenes que el
   * gate exigió declarar acá (condición C3), no copiar el docblock verbatim:
   *
   * 1. **RESUELTO (11/09/2026, 3.3-d residual 1,
   *    docs/diseno-33d-residuales-2026-09-11.md).** F4 preguntaba por la
   *    factura ENTERA, no por la porción de esta reserva -- una reserva
   *    puede compartir una factura CONSOLIDADA con otras, y el escape emite
   *    una NC **PARCIAL** (solo la porción de esta reserva). Ahora el
   *    clasificador resuelve la atribución por PAR `(invoiceId,
   *    reservationId)` vía `resolveRefundableForPair()` (reusa el mismo
   *    primitivo del tope de 3.3-a) cuando la factura tiene `invoice_items`
   *    congelados; compara BRUTO contra BRUTO
   *    (`isReservationPortionFullyCompensatedByIssuedCreditNotes()`,
   *    `cancel-with-credit-note.ts`) contra el numerador nuevo
   *    (`getIssuedCreditNoteCompensationTotalForReservation()`,
   *    `sql.invoice.repository.ts`). **Excepción declarada, no residual
   *    oculto:** facturas Nivel A (sin `invoice_items` -- la MAYORÍA de las
   *    facturas reales de al menos una tenant, `refund-attribution.ts:46-48`)
   *    hacen fail-back a F4-por-factura-entera, comportamiento idéntico al
   *    de antes de este bloque. El residual simétrico del lado ÓRDENES
   *    (`classifyOrderLiveInvoice` sigue con F4 por factura entera siempre,
   *    sin fail-back porque nunca lo necesita hoy) queda registrado aparte:
   *    `ORDER-CONSOLIDATED-PARTIAL-01`, `docs/pendientes-2026-09-10.md`.
   * 2. **RESUELTO junto con el punto 1.** La condición de ledger
   *    (`reversed_invoice_id = $1`) era de alcance FACTURA -- en una
   *    consolidada, contaba también las filas revertidoras de OTRAS
   *    reservas. Ahora sigue la MISMA rama que el chequeo fiscal: scoped a
   *    `reservation_id = $2` cuando el par se resuelve, sin scope (como
   *    antes) en el fail-back Nivel A. Las dos mitades preguntan siempre
   *    por el mismo sujeto -- mezclar sujetos distintos entre las dos
   *    mitades fue justo cómo nació esta divergencia originalmente.
   * 3. **Sigue abierto, bloque propio (residual 2 de 3.3-d, en curso).** La
   *    guarda que llama a este método (`handleReservationCancelled`) es más
   *    frágil que su par de órdenes: `voidByReservationId()` no filtra
   *    `candidatos` por `type` (a diferencia del guard de entrada de
   *    `voidByOrderId()`) — una reserva con un `PAYMENT` propio
   *    (`CustomerAccountService.recordPayment()`, alcanzable por
   *    `POST /api/customers/.../payments`, algo que NO puede pasarle a una
   *    orden) produce `rechazos = ['TIPO_NO_LIQUIDABLE', 'CARGO_CON_COMPROBANTE_VIVO']`
   *    — la rama ESTRECHA del handler (exactamente un rechazo) no dispara, y
   *    este método ni se llama. Diseño completo (allowlist de co-rechazos
   *    benignos) en `docs/diseno-33d-residuales-2026-09-11.md` §2, todavía
   *    sin implementar (Commit B, gate propio). **El pasivo de deploy que
   *    el fix de este método retira queda acotado al subconjunto "factura
   *    directa o consolidada, sin `PAYMENT` propio ni filas anuladas
   *    previas en la reserva"** hasta que ese bloque cierre.
   *
   * Recibe `client` crudo del tenant, sin lock — mismo criterio que
   * `classifyOrderLiveInvoice`.
   */
  classifyReservationLiveInvoice(client: SqlClient, reservationId: string): Promise<'RECONCILED' | 'NOT_RECONCILED'>;
  /**
   * Bandeja "factura viva no conciliada" (10/09/2026, gate
   * `architecture-governor`) -- ver el docblock de `UnreconciledLiveInvoice`
   * para la forma de la fila y qué es `motivo`. Mecanismo de DOS pasos,
   * no una query sola con la doctrina de compensación reescrita en SQL
   * (eso sería el cuarto vocabulario de estado que el gate rechazó):
   * 1. Enumera candidatos -- `UNION` de B1 (entidad terminal con Factura
   *    B `ISSUED` viva) y B2 (reversión abierta, `reversed_invoice_id`
   *    sin cerrar).
   * 2. Clasifica cada candidato con `classifyOrderLiveInvoice`/
   *    `classifyReservationLiveInvoice` (arriba) y se queda solo con
   *    `'NOT_RECONCILED'` -- cero SQL de compensación nuevo, una sola
   *    fuente de verdad de "¿está conciliado?".
   *
   * N+1 declarado a propósito (1 + 2N queries por candidato, mismo costo
   * que ya paga cada `classify*LiveInvoice` -- ver su docblock): con 0
   * filas en producción hoy es gratis, y es el trade correcto (una sola
   * fuente de verdad sobre velocidad) mientras el volumen lo permita.
   * Sin techo (`LIMIT`) ni índice sobre `reversed_invoice_id` -- eso
   * sigue siendo 3.3-e, bloque aparte con backup durable.
   */
  listUnreconciledLiveInvoices(client: SqlClient): Promise<UnreconciledLiveInvoice[]>;
  /** PENDING inicial — el CAE todavía no se pidió. `afipRequest` se persiste ANTES de llamar a AFIP (auditable incluso si la llamada nunca vuelve). */
  create(input: CreateInvoiceInput, afipRequest: unknown, items: CreateInvoiceItemInput[]): Promise<Invoice>;
  /**
   * D8-Nivel B (23/08/2026) — versión transaccional de `create()`: inserta
   * el comprobante Y sus líneas dentro de la misma transacción
   * (`InvoiceService.requestInvoice()` la envuelve en
   * `transactionManager.run()`) — nunca una factura creada sin ninguna
   * línea por una falla a mitad de camino.
   *
   * `charges` (C1-Fase C, 23/08/2026) — opcional, solo para facturas
   * consolidadas: una fila `invoice_charges` por cada `financialTransactionId`
   * cubierto (con `input.financialTransactionId = null`). Omitido/vacío en
   * el camino per-reservation de siempre — comportamiento sin cambios.
   */
  createWithClient(
    client: SqlClient,
    input: CreateInvoiceInput,
    afipRequest: unknown,
    items: CreateInvoiceItemInput[],
    charges?: { financialTransactionId: string; amount: number }[],
  ): Promise<Invoice>;
  markIssued(id: string, data: MarkIssuedInput): Promise<Invoice>;
  markFailed(id: string, data: MarkFailedInput): Promise<Invoice>;
  /** Solo para reconciliar un FAILED_UNCERTAIN ya resuelto a mano (A8.6) — no un "editar" genérico. */
  getStatus(id: string): Promise<InvoiceStatus | null>;
  /** D8-Nivel B — líneas reales del comprobante (vacío = factura Nivel A, ver InvoicePdfService). */
  getItemsByInvoiceId(invoiceId: string): Promise<InvoiceItem[]>;
  /**
   * 1c-ii-a (11/09/2026, gate `architecture-governor`, preparación mecánica
   * para `ORDER-CONSOLIDATED-PARTIAL-01`) — resuelve, para una factura, qué
   * `order_id` corresponde a cada `invoice_items.id` de origen ORDEN (JOIN
   * `invoice_items.order_item_id → order_items.order_id`, estable:
   * `order_items.order_id` nunca se actualiza en `src/pos-menu/`, y el
   * `ON DELETE SET NULL` de la FK no puede orfanar una línea ya facturada sin
   * violar el CHECK `chk_invoice_item_origin` primero).
   *
   * Solo trae entradas con `order_id` resuelto -- una línea de origen
   * RESERVA o el caso borde sin documento (`resolveInvoiceItems()`, Nivel A)
   * simplemente no aparece en el `Map`. **Sin consumidor todavía** -- mismo
   * criterio que `resolveOrderPairAttribution()`/`getIssuedCreditNoteCompensationTotalForOrder()`
   * (bloque 1b): la rama de atribución de órdenes en `buildCreditNote()`
   * (bloque 1c-ii-b) es quien lo va a usar.
   */
  getOrderIdsByInvoiceItemId(invoiceId: string): Promise<Map<string, string>>;
}
