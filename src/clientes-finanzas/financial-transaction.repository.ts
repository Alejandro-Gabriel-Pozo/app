import type { SqlClient } from '../repositories/sql.client.js';

export type TransactionType = 'CHARGE' | 'PAYMENT' | 'REFUND' | 'ADJUSTMENT';
export type TransactionStatus = 'PENDING' | 'SETTLED' | 'FAILED' | 'VOIDED';
export type PaymentMethod = 'CASH' | 'CARD' | 'TRANSFER' | 'OTHER';

export interface FinancialTransaction {
  id: string;
  businessId: string;
  customerId: string;
  /** Null para cargos no asociados a una reserva (ej: consumos de minibar). */
  reservationId?: string | null;
  /** Null para cargos no asociados a una orden (ej: CHARGE de una reserva). */
  orderId?: string | null;
  /** Null para cargos no asociados a una estadía (ej: consumo del portal sin check-in). */
  stayId?: string | null;
  type: TransactionType;
  amount: number;
  currency: string;
  status: TransactionStatus;
  /**
   * Clave de idempotencia opcional.
   *
   * Si se provee, el INSERT usa ON CONFLICT (idempotency_key) DO NOTHING:
   * el worker puede reintentar sin crear duplicados.
   * Si es null/undefined, el INSERT es normal (sin protección de duplicados).
   *
   * Convención para el outbox worker: `${domainEventId}:${type}` —
   * garantiza unicidad por evento de dominio + tipo de movimiento.
   */
  idempotencyKey?: string | null;
  /** Memo libre — ej. "efectivo", "transferencia ref #123" en un pago manual. */
  notes?: string | null;
  /**
   * Medio de pago. Null para filas viejas (nunca se capturó) y para CHARGE
   * PENDING que todavía no se saldó (se completa recién al settlear, ver
   * `settleByOrderId`). Determina si la fila puede vincularse a un turno de
   * caja — solo 'CASH' pasa por `shiftId`.
   */
  paymentMethod?: PaymentMethod | null;
  /**
   * Turno de caja (`cash_register_shifts`) al que pertenece este movimiento.
   * Se completa solo cuando `paymentMethod === 'CASH'` y había un turno OPEN
   * del negocio al momento de crear/settlear la fila — pagos con
   * tarjeta/transferencia no pasan por caja física.
   */
  shiftId?: string | null;
  /**
   * Cantidad de cuotas de un pago con tarjeta. Solo tiene sentido con
   * `paymentMethod === 'CARD'` (constraint en BD, no solo tipo — ver BLOQUE
   * 12 de schema.sql). Puramente descriptivo: no dispara ninguna lógica de
   * plan de cuotas/coeficiente por banco, eso quedó fuera de alcance a
   * propósito (Gap analysis Tango #3 — "subsistema propio").
   */
  cardInstallments?: number | null;
  /**
   * Cuánto de `amount` (que sigue siendo el total ya cobrado, sin cambios
   * de semántica) es recargo financiero por tarjeta. Decomposición
   * descriptiva (A3.5) — no genera un movimiento contable separado a
   * propósito, ver comentario de BLOQUE 12 en schema.sql.
   */
  cardSurchargeAmount?: number | null;
  /**
   * identity_id (JWT sub) de quien autorizó este movimiento a mano — hoy
   * solo lo completa el ajuste de precio de una reserva CONFIRMED
   * (19/08/2026, pendientes-2026-08-18.md punto I): un cargo extra/nota de
   * crédito por recotización necesita quedar atribuido a QUIÉN lo aprobó,
   * no solo a que "el sistema" lo hizo — mismo criterio de accountability
   * que `reservations.schedule_approved_by`. Null para todo lo demás
   * (CHARGE/PAYMENT/REFUND no tienen un paso de autorización humana
   * explícito). SIN FK a `users` a propósito, misma razón que
   * `stays.assigned_by`: identity vive en la platform DB.
   */
  confirmedBy?: string | null;
  /**
   * Solo tiene sentido en filas `type = 'REFUND'` (C2,
   * docs/diseno-cancelacion-notas-credito-c2-2026-08-23.md,
   * `CancellationRefundService`) — la factura ISSUED contra la que
   * corresponde emitir la Nota de Crédito (reparto LIFO entre las
   * facturas de la reserva). `null` para todo lo demás, y también para un
   * `REFUND` que no tenía ninguna factura que cubrir (ledger-only, ver el
   * diseño). SIN cascada de borrado -- una `Invoice` (DOCUMENTO, R12)
   * nunca se borra.
   */
  reversedInvoiceId?: string | null;
  /**
   * Solo tiene sentido en filas `type = 'PAYMENT'` (I4, 23/08/2026,
   * pendientes-2026-08-23.md — conciliación de pagos, verificación de
   * auditoría externa) — la factura ISSUED que este pago está saldando.
   * Espejo exacto de `reversedInvoiceId` del lado del cobro en vez del
   * reembolso. `null` = pago genérico contra la cuenta del cliente, sin
   * asociar a ninguna factura (comportamiento previo, sin cambios). SIN
   * cascada de borrado — mismo motivo que `reversedInvoiceId`.
   */
  settledInvoiceId?: string | null;
  createdAt?: Date;
  /**
   * F1-Pieza 2 (23/08/2026, pendientes-2026-08-23.md — trazabilidad de
   * folio). Campo DERIVADO, no persistido en la tabla — `reservations.
   * reservation_number` (D6) traído por JOIN. Solo lo completa
   * `getByCustomerId()` (el estado de cuenta, único lugar donde el
   * cliente/staff necesita reconocer a qué reserva pertenece un cargo);
   * el resto de los métodos de lectura lo dejan en `null` (no hicieron
   * el JOIN). También `null` si `reservationId` es null o si la reserva
   * no tiene número asignado (no debería pasar post-backfill de D6, pero
   * el JOIN es LEFT por las dudas).
   */
  reservationNumber?: number | null;
}

/** Metadata de medio de pago que puede acompañar un settle (Gap Tango #3). */
export interface PaymentInfo {
  paymentMethod?: PaymentMethod | null;
  cardInstallments?: number | null;
  cardSurchargeAmount?: number | null;
}

// ---------------------------------------------------------------------------
// O2 (03/09/2026) — desenlaces de los efectos financieros de una orden
// ---------------------------------------------------------------------------

/**
 * Por qué un efecto NO se aplicó. Ninguno es reintentable: reintentar no
 * cambia el estado de la orden, ni el tipo del cargo, ni el negocio al que
 * pertenece. La única causa transitoria vive aparte (`DEPENDENCIA_PENDIENTE`).
 */
export type EfectoRechazo =
  | 'ORDEN_INEXISTENTE'         // no hay fila en orders para ese order_id
  | 'ORDEN_DE_OTRO_NEGOCIO'     // existe, con otro business_id — aislamiento
  | 'ORDEN_ESTADO_NO_ELEGIBLE'  // estado conocido que no habilita este efecto
  | 'ORDEN_SIN_CONFIRMAR'       // COMPLETED sin confirmed_at: no hubo acto
  | 'ESTADO_DESCONOCIDO'        // status fuera del CHECK — fail-closed
  | 'CARGO_YA_EXISTE'           // la orden ya tiene su CHARGE (identidad del acto)
  | 'CARGO_YA_SETTLED'          // reintento benigno del at-least-once
  | 'CARGO_ANULADO'             // VOIDED o FAILED
  | 'TIPO_NO_LIQUIDABLE';       // PAYMENT/REFUND/ADJUSTMENT bajo ese order_id

/**
 * Los cuatro desenlaces de negocio, deliberadamente distinguibles.
 *
 * - `APLICADO`: se escribieron `filas` filas. Puede traer rechazos igual:
 *   liquidó el CHARGE y rechazó un PAYMENT de la misma orden.
 * - `RECHAZADO`: no se escribió nada, y `rechazos` dice por qué. **No
 *   reintentable**: el handler retorna, no lanza.
 * - `NADA_QUE_HACER`: no había nada que aplicar y eso es correcto (una orden
 *   sin ítems con precio nunca generó cargo). Es éxito, no rechazo.
 * - `DEPENDENCIA_PENDIENTE`: el efecto depende de algo que todavía no pasó
 *   (T-01: el CHARGE aún no existe porque `order.confirmed` no se procesó).
 *   Es lo ÚNICO transitorio, y lo único que justifica reintentar.
 *
 * Un fallo TÉCNICO nunca es un desenlace: se lanza.
 */
export type EfectoDesenlace =
  | { tipo: 'APLICADO';              filas: number; rechazos: EfectoRechazo[] }
  | { tipo: 'RECHAZADO';             rechazos: EfectoRechazo[] }
  | { tipo: 'NADA_QUE_HACER' }
  | { tipo: 'DEPENDENCIA_PENDIENTE' };

/** Lo que hace falta para crear el CHARGE de una orden confirmada. */
export interface OrderChargeInput {
  id:         string;
  businessId: string;
  customerId: string;
  orderId:    string;
  stayId:     string | null;
  amount:     number;
  currency:   string;
}

export interface FinancialTransactionRepository {
  /**
   * Crea una transacción nueva.
   *
   * - Si `idempotencyKey` está presente: ON CONFLICT DO NOTHING — retorna
   *   `null` si la fila ya existía (el caller debe tratarlo como éxito).
   * - Si `idempotencyKey` está ausente: INSERT normal — lanza si el id ya existe.
   */
  create(
    tx: Omit<FinancialTransaction, 'createdAt'>,
  ): Promise<FinancialTransaction | null>;

  /**
   * Igual que `create()`, pero corre sobre un `SqlClient` de una transacción
   * ya abierta (`TransactionManager.run(...)`). Usado por
   * `AccountsReceivableService.transferStayBalanceToReceivable()` — el
   * PAYMENT que salda el folio y la fila de `accounts_receivable` deben
   * confirmarse juntos o no confirmarse ninguno.
   */
  createWithClient(
    client: SqlClient,
    tx: Omit<FinancialTransaction, 'createdAt'>,
  ): Promise<FinancialTransaction | null>;

  /**
   * Busca una transacción puntual por su propio id — a diferencia de las
   * `getByX` de abajo (que devuelven varias, agrupadas por origen), esto
   * es "dame ESTA fila". Agregado (19/08/2026) para que el servicio de
   * facturación AFIP pueda resolver el `FinancialTransaction` exacto que
   * se está facturando a partir de `invoices.financial_transaction_id`.
   */
  getById(id: string): Promise<FinancialTransaction | null>;

  /** Obtiene todas las transacciones de una reserva. */
  getByReservationId(reservationId: string): Promise<FinancialTransaction[]>;

  /** Obtiene todas las transacciones de una orden. */
  getByOrderId(orderId: string): Promise<FinancialTransaction[]>;

  /** Obtiene todas las transacciones de un cliente. */
  getByCustomerId(customerId: string): Promise<FinancialTransaction[]>;

  /** Obtiene todas las transacciones de una estadía. */
  getByStayId(stayId: string): Promise<FinancialTransaction[]>;

  /**
   * Busca por idempotencyKey. Usado cuando create() devuelve null (ya
   * existía) y el caller necesita la fila real para devolverla igual —
   * un reintento de red no debe verse como error.
   */
  getByIdempotencyKey(idempotencyKey: string): Promise<FinancialTransaction | undefined>;

  /**
   * Pasa a SETTLED todas las transacciones PENDING de una reserva.
   * Idempotente: si ya están SETTLED, no hace nada.
   * Retorna la cantidad de filas actualizadas.
   */
  settleByReservationId(reservationId: string): Promise<number>;

  /**
   * Pasa a VOIDED las transacciones CHARGE/ADJUSTMENT PENDING/SETTLED de
   * una reserva. Usado cuando se cancela una reserva confirmada.
   *
   * NO toca PAYMENT/REFUND (fix 23/08/2026, bug real en producción) — un
   * pago ya cobrado es un hecho histórico de dinero que cambió de manos,
   * nunca se anula en silencio al cancelar. Si corresponde devolver algo,
   * eso se modela con un REFUND explícito (ver `CancellationRefundService`,
   * C2), no anulando el PAYMENT original.
   *
   * Retorna la cantidad de filas actualizadas.
   */
  voidByReservationId(reservationId: string): Promise<number>;

  /**
   * O2 (03/09/2026) -- liquida el CHARGE de una orden COMPLETED.
   *
   * Reemplaza a `settleByOrderId(): Promise<number>`. El `number` colapsaba
   * nueve situaciones distintas en un cero mudo: no se podía distinguir un
   * reintento benigno de un cruce de tenant. Y `?? 0` confundía "el driver no
   * informó" con "cero filas".
   *
   * Tres allowlists POSITIVAS, todas dentro de la misma sentencia:
   * estado de la orden (`COMPLETED`), estado del cargo (`PENDING`) y **tipo
   * del cargo (`CHARGE` y nada más)**. Un `PAYMENT`, un `REFUND` o un
   * `ADJUSTMENT` bajo ese `order_id` **no se liquidan y no cuentan como
   * éxito**: salen por `TIPO_NO_LIQUIDABLE`.
   *
   * ORDER-03-b queda subsumido acá: su guarda es una de las tres allowlists.
   *
   * Si se pasa `paymentInfo.paymentMethod`, se persiste en las filas
   * actualizadas. Si además es `'CASH'` y hay un turno OPEN para el negocio,
   * esas filas se vinculan a ese turno en la misma UPDATE.
   *
   * **Nunca devuelve un cero sin motivo.** Un fallo técnico lanza.
   */
  settleChargesByOrderId(
    orderId: string,
    businessId: string,
    paymentInfo?: PaymentInfo,
  ): Promise<EfectoDesenlace>;

  /**
   * O2 -- crea el CHARGE de una orden confirmada, si corresponde.
   *
   * **La identidad del acto económico es `order_id`, no `event.id`.** Una
   * orden se confirma como máximo una vez (`TRANSICION_CONFIRMAR` sólo acepta
   * `DRAFT` y ninguna transición vuelve ahí), así que el acto y la orden son
   * la misma cosa. `event.id` identifica el mensaje, no el hecho: por eso dos
   * mensajes del mismo hecho creaban dos cargos.
   *
   * Toma el lock de la fila de `orders` **con el mismo `client`** antes del
   * INSERT: el `NOT EXISTS` por sí solo no es a prueba de carreras, dos
   * handlers concurrentes podrían pasarlo los dos.
   *
   * Exige que la orden esté en `CONFIRMED`/`COMPLETED` **y** tenga
   * `confirmed_at`: el estado `COMPLETED` aislado no autoriza una creación
   * financiera. `COMPLETED` sólo se acepta porque `order.completed` puede
   * adelantarse al `order.confirmed` que crea el cargo (ORDER-13); sin eso,
   * la familia quedaría trabada.
   */
  createOrderChargeIfConfirmed(
    client: SqlClient,
    input: OrderChargeInput,
  ): Promise<EfectoDesenlace>;

  /** Obtiene todas las transacciones de un turno de caja. */
  getByShiftId(shiftId: string): Promise<FinancialTransaction[]>;

  /**
   * O2 -- anula los movimientos de una orden CANCELLED.
   *
   * ORDER-06: antes anulaba `PENDING` **y `SETTLED`** sin mirar el estado de
   * la orden. Es el mismo defecto que ORDER-03-b cerró del lado *liquidar*,
   * y del lado *anular* es más caro: revierte un cobro ya realizado. Ahora
   * exige `o.status IN ('CANCELLED')` dentro de la sentencia.
   *
   * **ORDER-15, declarada y NO resuelta acá:** conserva
   * `type IN ('CHARGE','ADJUSTMENT')` mientras que la liquidación quedó en
   * `('CHARGE')`. Un `ADJUSTMENT` con `order_id` -- que hoy no existe, el
   * único creador siempre usa `reservationId` -- podría anularse y nunca
   * liquidarse. Alinear las dos allowlists exige decidir antes si los ajustes
   * sobre órdenes son un concepto de negocio: es su propio bloque.
   */
  voidByOrderId(orderId: string, businessId: string): Promise<EfectoDesenlace>;

  /**
   * Balance neto de un cliente: suma(CHARGE + ADJUSTMENT + REFUND) -
   * suma(PAYMENT), solo SETTLED. REFUND tiene el mismo signo que CHARGE/
   * ADJUSTMENT (no el de PAYMENT) porque revierte un PAYMENT -- necesita
   * el signo opuesto para cancelarlo, no duplicarlo (fix 23/08/2026, A3.9
   * criterios-negocio.md).
   */
  getNetBalanceByCustomerId(customerId: string): Promise<number>;

  /**
   * Suma de `PAYMENT` `SETTLED` asociados a una reserva puntual (C1-Fase A,
   * docs/diseno-sena-deposito-fase-a-2026-08-22.md) — usado por
   * `ReservationService.confirmReservation()` para el gate de seña
   * (`DepositNotPaidError`): compara este total contra `deposit_amount`
   * sin necesitar tocar el status de ningún `CHARGE`. `PAYMENT` siempre se
   * crea `SETTLED` directo (`CustomerAccountService.recordPayment`), así
   * que no hace falta filtrar por otro estado.
   */
  getSettledPaymentTotalForReservation(reservationId: string): Promise<number>;

  /**
   * Neto COBRADO menos YA REEMBOLSADO de una reserva (C2,
   * docs/diseno-cancelacion-notas-credito-c2-2026-08-23.md) — a diferencia
   * de `getSettledPaymentTotalForReservation` (que exige `SETTLED`, usada
   * por el gate de seña de `confirmReservation()`), esta cuenta lo cobrado
   * de verdad, neto de reembolsos. `CancellationRefundService.previewRefund()`/
   * `confirmRefund()` necesitan "cuánto queda disponible para reembolsar
   * hoy", no "cuánto se cobró en algún momento" -- **el nombre del método
   * quedó del fix anterior (solo pagos); BRECHA-REFUND-01 (05/09/2026)
   * agregó la resta de REFUND sin renombrarlo todavía** (rename mecánico
   * pendiente, ver `docs/pendientes-2026-09-03.md`).
   *
   * El `OR status = 'VOIDED'` (solo del lado PAYMENT) es DEFENSIVO desde el
   * fix de `voidByReservationId` (23/08/2026): antes, un PAYMENT de la
   * reserva quedaba VOIDED al cancelar, así que hacía falta incluirlo acá
   * para no perder de vista "cuánto se cobró realmente". Ahora
   * `voidByReservationId` ya no toca PAYMENT (solo CHARGE/ADJUSTMENT), así
   * que en teoría esta cláusula nunca debería activarse desde acá en
   * adelante -- se deja igual por las dudas de que exista alguna fila
   * VOIDED de antes del fix, o algún otro camino que la anule.
   *
   * **Asimetría deliberada de estados entre PAYMENT y REFUND** (BRECHA-REFUND-01):
   * un REFUND `VOIDED` es plata que NO salió -- nunca debe restar, así que
   * el lado REFUND exige `SETTLED` estricto, sin el `OR VOIDED` defensivo
   * del lado PAYMENT (esos dos casos no son simétricos: "un pago que se
   * anuló" y "un reembolso que se anuló" significan cosas opuestas para
   * este cálculo).
   */
  getCollectedPaymentTotalForReservation(reservationId: string): Promise<number>;

  /**
   * Balance neto de una estadía puntual (mismo cálculo y mismo fix de
   * signo de REFUND que getNetBalanceByCustomerId, pero acotado a un
   * `stay_id`). Es lo que StayService.checkOut() consulta para decidir si
   * hay saldo pendiente — el balance del cliente completo mezclaría
   * estadías/órdenes históricas ya saldadas con la actual.
   */
  getNetBalanceByStayId(stayId: string): Promise<number>;

  /**
   * Adopta bajo `stay_id` los cargos que ya existían para una reserva antes
   * de que la Stay existiera. El CHARGE de una Reservation se crea en
   * `reservation.confirmed` (outbox), que corre ANTES del check-in — nunca
   * queda con `stay_id`, así que sin este paso getNetBalanceByStayId lo
   * subestimaría. No reasigna `customer_id` (R9) — solo agrupa el cargo ya
   * existente bajo la estadía que recién se creó. Llamado desde
   * StayService.checkIn() una sola vez, justo después de crear la Stay.
   * Idempotente: solo toca filas con `stay_id IS NULL`.
   */
  linkStayToReservationCharges(stayId: string, reservationId: string): Promise<number>;
}
