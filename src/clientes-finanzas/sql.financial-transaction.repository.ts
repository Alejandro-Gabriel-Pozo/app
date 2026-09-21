import { randomUUID } from 'crypto';
import type { SqlClient } from '../repositories/sql.client.js';
import type {
  EfectoDesenlace,
  EfectoRechazo,
  OrderChargeInput,
} from './financial-transaction.repository.js';
import type {
  FinancialTransaction,
  FinancialTransactionRepository,
  PaymentInfo,
  PaymentMethod,
  TransactionStatus,
  TransactionType,
} from './financial-transaction.repository.js';

interface TransactionRow {
  id: string;
  business_id: string;
  customer_id: string;
  reservation_id: string | null;
  order_id: string | null;
  stay_id: string | null;
  /** Solo presente en el resultado de getByCustomerId() (JOIN) -- ver reservationNumber en la entidad. */
  reservation_number?: number | null;
  idempotency_key: string | null;
  type: TransactionType;
  amount: string; // DECIMAL llega como string en pg
  currency: string;
  status: TransactionStatus;
  notes: string | null;
  payment_method: PaymentMethod | null;
  shift_id: string | null;
  card_installments: number | null;
  card_surcharge_amount: string | null; // DECIMAL llega como string en pg
  confirmed_by: string | null;
  reversed_invoice_id: string | null;
  settled_invoice_id: string | null;
  reversed_transaction_id: string | null;
  created_at: Date;
}

/**
 * Implementación SQL del ledger financiero.
 *
 * ## Diseño
 * - Nunca se actualiza `amount` in-place. Cada cambio económico es una fila nueva.
 * - `settleByReservationId` y `voidByReservationId` solo cambian `status`.
 * - `getNetBalanceByCustomerId` calcula el balance directamente en SQL.
 * - `create()` con `idempotencyKey`: ON CONFLICT DO NOTHING sobre el UNIQUE index
 *   `idx_ft_idempotency_key`. Permite múltiples CHARGE por reserva (anticipo + saldo)
 *   mientras el outbox worker no crea duplicados en reintentos.
 *
 * Schema esperado: ver `migrations/004_financial_transactions.sql`.
 */
export class SqlFinancialTransactionRepository implements FinancialTransactionRepository {
  constructor(private readonly sqlClient: SqlClient) {}

  async create(
    tx: Omit<FinancialTransaction, 'createdAt'>,
  ): Promise<FinancialTransaction | null> {
    return this.insert(this.sqlClient, tx);
  }

  async createWithClient(
    client: SqlClient,
    tx: Omit<FinancialTransaction, 'createdAt'>,
  ): Promise<FinancialTransaction | null> {
    return this.insert(client, tx);
  }

  private async insert(
    client: SqlClient,
    tx: Omit<FinancialTransaction, 'createdAt'>,
  ): Promise<FinancialTransaction | null> {
    // F1-Pieza 2 (23/08/2026, pendientes-2026-08-23.md) — "documento de
    // origen obligatorio por cargo", A3.9 de criterios-negocio.md ("un
    // cargo sin origen es un descuadre esperando"). Guard a nivel
    // aplicación, no CHECK de Postgres: no hay forma de verificar contra
    // datos reales de producción (sin TEST_DATABASE_URL en este entorno)
    // si alguna fila vieja ya viola el invariante -- un CHECK que valida
    // filas existentes al agregarse rompería el deploy si una sola fila
    // no cumple. Los 4 sitios de creación reales (outbox.handlers.ts x3,
    // stay.service.ts, reservation.service.ts) ya setean reservationId/
    // orderId siempre -- este guard es para que un caller nuevo no rompa
    // ese invariante en silencio, no una migración retroactiva.
    // PAYMENT/REFUND no entran: un pago de mostrador contra la cuenta
    // general del cliente, sin reserva/orden asociada, es un caso real
    // (CustomerAccountService.recordPayment() sin allocations).
    //
    // reversedTransactionId (14/09/2026, mecanismo general de reversa del
    // ledger -- docs/diseno-reconciliacion-city-ledger-2026-09-12.md
    // §4.2/§4.3) cuenta como documento de origen válido: una fila que
    // corrige a otra fila del ledger SÍ tiene un origen real (A3.9), solo
    // que no es reservationId/orderId/stayId -- generaliza el guard, no lo
    // relaja (el CHECK de BD `chk_financial_transactions_reversed_transaction_type`
    // igual restringe este campo a `type = 'ADJUSTMENT'`).
    if (
      (tx.type === 'CHARGE' || tx.type === 'ADJUSTMENT') &&
      tx.reservationId == null &&
      tx.orderId == null &&
      tx.stayId == null &&
      tx.reversedTransactionId == null
    ) {
      throw new Error(
        `financial_transactions: un ${tx.type} necesita al menos un documento de origen ` +
        `(reservationId, orderId, stayId o reversedTransactionId) -- no debería crearse uno sin ninguno de los cuatro.`,
      );
    }

    const id = tx.id ?? randomUUID();
    const idempotencyKey = tx.idempotencyKey ?? null;
    const paymentMethod = tx.paymentMethod ?? null;
    const explicitShiftId = tx.shiftId ?? null;
    const cardInstallments = tx.cardInstallments ?? null;
    const cardSurchargeAmount = tx.cardSurchargeAmount ?? null;

    if (idempotencyKey !== null) {
      // Path idempotente: el worker usa esto para evitar duplicados en reintentos.
      // ON CONFLICT DO NOTHING sobre idx_ft_idempotency_key -- es un índice
      // ÚNICO PARCIAL (UNIQUE ... WHERE idempotency_key IS NOT NULL), así que
      // el ON CONFLICT tiene que repetir esa misma condición para que Postgres
      // pueda inferir qué índice usar como arbiter; sin el WHERE, "ON CONFLICT
      // (idempotency_key)" no matchea ningún índice NO parcial sobre esa
      // columna sola y Postgres tira 42P10 "no unique or exclusion constraint
      // matching the ON CONFLICT specification" (bug real encontrado el
      // 18/08/2026, quedaba tapado detrás del bug de tipos de $2/$13 de más
      // abajo -- con ese ya arreglado, este era el que seguía rompiendo el
      // CHARGE de cada reserva confirmada).
      //
      // shift_id: si el caller no lo pasó explícito ($14) y el medio de pago
      // ($13) es 'CASH', se resuelve al turno OPEN del negocio ($2) en la
      // misma sentencia (A8.2 — constraint/subquery, no un SELECT previo en
      // el service). Tarjeta/transferencia o sin turno abierto: queda NULL.
      // card_installments/card_surcharge_amount ($15/$16) son puramente
      // descriptivos (Gap Tango #3) — el CHECK de BD exige payment_method
      // = 'CARD' para que no sean NULL, no hace falta replicar esa lógica acá.
      // $2 y $13 se castean explícito en su segunda aparición (dentro del
      // CASE/subquery) -- reusar el mismo placeholder en dos posiciones
      // sintácticas distintas (VALUES vs. WHERE anidado) hace que Postgres
      // no pueda unificar el tipo deducido para cada una ("inconsistent
      // types deduced for parameter", 42P08 -- bug real encontrado el
      // 18/08/2026: el CHARGE de toda reserva confirmada fallaba al
      // despacharse, terminaba en dead-letter tras 60 reintentos).
      const result = await client.query<TransactionRow>(
        `INSERT INTO financial_transactions
           (id, business_id, customer_id, reservation_id, order_id, stay_id, idempotency_key, type, amount, currency, status, notes, payment_method, shift_id, card_installments, card_surcharge_amount, confirmed_by, reversed_invoice_id, settled_invoice_id, reversed_transaction_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           COALESCE($14, CASE WHEN $13::VARCHAR(20) = 'CASH'
             THEN (SELECT id FROM cash_register_shifts WHERE business_id = $2::VARCHAR(255) AND status = 'OPEN')
             ELSE NULL END), $15, $16, $17, $18, $19, $20)
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
         RETURNING *`,
        [
          id,
          tx.businessId,
          tx.customerId,
          tx.reservationId ?? null,
          tx.orderId ?? null,
          tx.stayId ?? null,
          idempotencyKey,
          tx.type,
          tx.amount,
          tx.currency,
          tx.status,
          tx.notes ?? null,
          paymentMethod,
          explicitShiftId,
          cardInstallments,
          cardSurchargeAmount,
          tx.confirmedBy ?? null,
          tx.reversedInvoiceId ?? null,
          tx.settledInvoiceId ?? null,
          tx.reversedTransactionId ?? null,
        ],
      );
      // RETURNING vacío = ON CONFLICT activado = fila ya existía = éxito silencioso.
      return result.rows[0] ? this.rowToEntity(result.rows[0]) : null;
    }

    // Path normal (sin idempotency_key): INSERT estándar, lanza en conflicto
    // de id. Mismo criterio de shift_id/card_* que el path idempotente (ver
    // arriba, incluidos los casts explícitos de $2/$12 -- mismo bug, mismo fix).
    const result = await client.query<TransactionRow>(
      `INSERT INTO financial_transactions
         (id, business_id, customer_id, reservation_id, order_id, stay_id, type, amount, currency, status, notes, payment_method, shift_id, card_installments, card_surcharge_amount, confirmed_by, reversed_invoice_id, settled_invoice_id, reversed_transaction_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         COALESCE($13, CASE WHEN $12::VARCHAR(20) = 'CASH'
           THEN (SELECT id FROM cash_register_shifts WHERE business_id = $2::VARCHAR(255) AND status = 'OPEN')
           ELSE NULL END), $14, $15, $16, $17, $18, $19)
       RETURNING *`,
      [
        id,
        tx.businessId,
        tx.customerId,
        tx.reservationId ?? null,
        tx.orderId ?? null,
        tx.stayId ?? null,
        tx.type,
        tx.amount,
        tx.currency,
        tx.status,
        tx.notes ?? null,
        paymentMethod,
        explicitShiftId,
        cardInstallments,
        cardSurchargeAmount,
        tx.confirmedBy ?? null,
        tx.reversedInvoiceId ?? null,
        tx.settledInvoiceId ?? null,
        tx.reversedTransactionId ?? null,
      ],
    );
    return this.rowToEntity(result.rows[0]!);
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<FinancialTransaction | undefined> {
    const result = await this.sqlClient.query<TransactionRow>(
      `SELECT * FROM financial_transactions WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    return result.rows[0] ? this.rowToEntity(result.rows[0]) : undefined;
  }

  async getById(id: string): Promise<FinancialTransaction | null> {
    const result = await this.sqlClient.query<TransactionRow>(
      `SELECT * FROM financial_transactions WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? this.rowToEntity(result.rows[0]) : null;
  }

  async getByIdWithLock(client: SqlClient, id: string): Promise<FinancialTransaction | undefined> {
    const result = await client.query<TransactionRow>(
      `SELECT * FROM financial_transactions WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return result.rows[0] ? this.rowToEntity(result.rows[0]) : undefined;
  }

  async getByReservationId(reservationId: string): Promise<FinancialTransaction[]> {
    const result = await this.sqlClient.query<TransactionRow>(
      `SELECT * FROM financial_transactions
       WHERE reservation_id = $1
       ORDER BY created_at ASC`,
      [reservationId],
    );
    return result.rows.map((r) => this.rowToEntity(r));
  }

  async getByOrderId(orderId: string): Promise<FinancialTransaction[]> {
    const result = await this.sqlClient.query<TransactionRow>(
      `SELECT * FROM financial_transactions
       WHERE order_id = $1
       ORDER BY created_at ASC`,
      [orderId],
    );
    return result.rows.map((r) => this.rowToEntity(r));
  }

  /**
   * F1-Pieza 2 (23/08/2026) — LEFT JOIN a `reservations` para traer
   * `reservation_number` (D6): el estado de cuenta necesita mostrar A QUÉ
   * reserva pertenece cada cargo, no solo el UUID interno. LEFT (no INNER)
   * porque reservation_id es nullable -- un cargo de orden/estadía sin
   * reserva asociada no debe desaparecer del estado de cuenta.
   */
  async getByCustomerId(customerId: string): Promise<FinancialTransaction[]> {
    const result = await this.sqlClient.query<TransactionRow>(
      `SELECT ft.*, r.reservation_number
       FROM financial_transactions ft
       LEFT JOIN reservations r ON r.id = ft.reservation_id
       WHERE ft.customer_id = $1
       ORDER BY ft.created_at DESC`,
      [customerId],
    );
    return result.rows.map((r) => this.rowToEntity(r));
  }

  async getByStayId(stayId: string): Promise<FinancialTransaction[]> {
    const result = await this.sqlClient.query<TransactionRow>(
      `SELECT * FROM financial_transactions
       WHERE stay_id = $1
       ORDER BY created_at ASC`,
      [stayId],
    );
    return result.rows.map((r) => this.rowToEntity(r));
  }

  async getByShiftId(shiftId: string): Promise<FinancialTransaction[]> {
    const result = await this.sqlClient.query<TransactionRow>(
      `SELECT * FROM financial_transactions
       WHERE shift_id = $1
       ORDER BY created_at ASC`,
      [shiftId],
    );
    return result.rows.map((r) => this.rowToEntity(r));
  }

  async settleByReservationId(reservationId: string): Promise<number> {
    // Residual B-1 / 3.2-b (13/09/2026) -- `AND type <> 'PAYMENT'` agregado
    // a propósito, mismo criterio que el corolario de A3.9
    // (criterios-negocio.md): un PAYMENT es dinero que YA cambió de manos,
    // nunca una obligación pendiente de liquidar -- "settle" es un
    // concepto de CHARGE/ADJUSTMENT, no de PAYMENT. Interferente dormido,
    // no bug activo hoy: `PAYMENT` siempre se crea `SETTLED` directo
    // (`CustomerAccountService.recordPayment`, ver docblock de
    // `getSettledPaymentTotalForReservation` más abajo), así que esta
    // cláusula nunca tocaba una fila real todavía -- se cierra antes de
    // que algún camino futuro cree un PAYMENT PENDING y esta query lo
    // liquide en silencio como side-effect de completar la reserva.
    const result = await this.sqlClient.query(
      `UPDATE financial_transactions
       SET status = 'SETTLED'
       WHERE reservation_id = $1
         AND status = 'PENDING'
         AND type <> 'PAYMENT'`,
      [reservationId],
    );
    return result.rowCount ?? 0;
  }

  async settleByIdsWithClient(client: SqlClient, ids: string[], businessId: string): Promise<number> {
    if (ids.length === 0) return 0;
    // Solo `status` -- ADR cancelar-con-NC §3 N1.a(i). `business_id` en el WHERE
    // por A2.x (nunca liquidar una fila de otro tenant). `AND status='PENDING'`
    // = idempotencia ante reintento (N11).
    const result = await client.query(
      `UPDATE financial_transactions
       SET status = 'SETTLED'
       WHERE id = ANY($1::text[])
         AND business_id = $2
         AND status = 'PENDING'`,
      [ids, businessId],
    );
    return result.rowCount ?? 0;
  }

  /** Arma la lista de rechazos de `voidByReservationId()` a partir de sus propios contadores.
   *  Helper SEPARADO de `rechazosDe()` (usado por voidByOrderId()/settleChargesByOrderId()) a
   *  propósito -- `reservations` no tiene `business_id` propio, así que su fila de diagnóstico no
   *  tiene columnas equivalentes a `orden_ajena`, y forzar ese acople metería columnas dummy
   *  irrelevantes en las funciones de orden. */
  private static rechazosDeReserva(f: Record<string, unknown>): EfectoRechazo[] {
    const r: EfectoRechazo[] = [];
    const n = (c: string) => SqlFinancialTransactionRepository.entero(f, c);
    if (n('reserva_inexistente')   > 0) r.push('RESERVA_INEXISTENTE');
    if (n('reserva_no_elegible')   > 0) r.push('RESERVA_ESTADO_NO_ELEGIBLE');
    if (n('estado_desconocido')    > 0) r.push('ESTADO_DESCONOCIDO');
    if (n('anulados')              > 0) r.push('CARGO_ANULADO');
    if (n('tipo_no_liquidable')    > 0) r.push('TIPO_NO_LIQUIDABLE');
    if (n('con_comprobante_vivo')  > 0) r.push('CARGO_CON_COMPROBANTE_VIVO');
    return r;
  }

  /**
   * Bug real en producción, 23/08/2026 (mismo hallazgo que el fix de
   * signo en getNetBalanceByCustomerId/getNetBalanceByStayId, ver ahí) —
   * antes anulaba CUALQUIER fila de la reserva sin filtrar por `type`,
   * así que un PAYMENT ya cobrado (ej. una seña, C1-Fase A) quedaba
   * VOIDED junto con el CHARGE al cancelar. Un pago es un hecho histórico
   * de dinero que ya cambió de manos -- nunca se anula en silencio, solo
   * se revierte con un REFUND explícito (A3.9: todo movimiento tiene
   * contrapartida). Ahora solo anula CHARGE/ADJUSTMENT -- la parte de la
   * deuda que corresponde a un servicio que no se va a prestar.
   *
   * `getCollectedPaymentTotalForReservation` seguía contando PAYMENT
   * VOIDED a propósito (ver su docblock) porque antes de este fix el
   * PAYMENT SÍ quedaba VOIDED acá -- se deja esa cláusula igual, ahora es
   * defensiva/no debería activarse nunca desde este método, pero no hay
   * necesidad de tocarla para este fix.
   *
   * **RESERVA-10 (05/09/2026, architecture-governor) -- excepción
   * cross-dominio SANCIONADA, misma que `voidByOrderId()`.** Esta función
   * es de `clientes-finanzas` y consulta acá, en SQL crudo, las tablas
   * `invoices`/`invoice_charges` (`facturación`) -- `lint:arch`
   * (dependency-cruiser) sólo inspecciona imports de TypeScript, no joins
   * SQL, así que este acoplamiento es invisible para esa cerca. Motivo:
   * anular en silencio un `CHARGE` que ya tiene una Factura B con CAE
   * real de AFIP (o una todavía `PENDING`/`FAILED_UNCERTAIN` con AFIP ya
   * contactado) deja un comprobante fiscal real sin contrapartida -- el
   * guard de la puerta de entrada (`ReservationService.cancelReservation()`,
   * `ReservationChargeInvoicedError`) cubre el camino normal, esta
   * función es el cierre estructural para cualquier otro caller
   * (`reservation-hold-expiry.worker.ts`, por ejemplo). Además, ahora
   * exige `EXISTS` una reserva `CANCELLED` -- antes no chequeaba el
   * estado de la reserva EN ABSOLUTO.
   */
  async voidByReservationId(reservationId: string, businessId: string): Promise<EfectoDesenlace> {
    const { rows } = await this.sqlClient.query<Record<string, unknown>>(
      `WITH candidatos AS (
         SELECT ft.id, ft.status AS ft_status, ft.type AS ft_type,
                (r.id IS NOT NULL) AS reserva_existe,
                r.status           AS r_status,
                EXISTS (
                  SELECT 1 FROM (
                    SELECT status, afip_contacted FROM invoices
                     WHERE financial_transaction_id = ft.id
                    UNION ALL
                    SELECT i.status, i.afip_contacted FROM invoice_charges ic
                      JOIN invoices i ON i.id = ic.invoice_id
                     WHERE ic.financial_transaction_id = ft.id
                  ) linked
                  WHERE linked.status = 'ISSUED'
                     OR linked.status = 'PENDING'
                     OR (linked.status = 'FAILED_UNCERTAIN' AND linked.afip_contacted)
                ) AS con_comprobante_vivo
           FROM financial_transactions ft
           LEFT JOIN reservations r ON r.id = ft.reservation_id
          WHERE ft.reservation_id = $1 AND ft.business_id = $2
       ),
       anuladas AS (
         UPDATE financial_transactions ft
            SET status = 'VOIDED'
          WHERE ft.reservation_id = $1
            AND ft.business_id    = $2
            AND ft.type   IN ('CHARGE','ADJUSTMENT')
            AND ft.status IN ('PENDING','SETTLED')
            AND EXISTS (SELECT 1 FROM reservations r
                         WHERE r.id = ft.reservation_id
                           AND r.status = 'CANCELLED')
            AND NOT EXISTS (
                  SELECT 1 FROM (
                    SELECT status, afip_contacted FROM invoices
                     WHERE financial_transaction_id = ft.id
                    UNION ALL
                    SELECT i.status, i.afip_contacted FROM invoice_charges ic
                      JOIN invoices i ON i.id = ic.invoice_id
                     WHERE ic.financial_transaction_id = ft.id
                  ) linked
                  WHERE linked.status = 'ISSUED'
                     OR linked.status = 'PENDING'
                     OR (linked.status = 'FAILED_UNCERTAIN' AND linked.afip_contacted)
                )
         RETURNING ft.id
       )
       SELECT
         (SELECT count(*) FROM anuladas)::int                                    AS aplicadas,
         (SELECT count(*) FROM candidatos)::int                                  AS candidatos,
         (SELECT count(*) FROM candidatos WHERE NOT reserva_existe)::int         AS reserva_inexistente,
         -- RESERVA-10 (05/09/2026, architecture-governor): test NEGATIVO
         -- (IS DISTINCT FROM 'CANCELLED'), a diferencia de la whitelist
         -- POSITIVA que usa voidByOrderId() (o_status IN (...)) para
         -- su orden_no_elegible. A propósito, no descuido: reservations
         -- no tiene un conjunto cerrado de "estados no elegibles para
         -- anular" que valga la pena enumerar (CANCELLED es el único
         -- elegible, todo lo demás -- PENDING/CONFIRMED/COMPLETED/EXPIRED,
         -- e incluso un futuro estado desconocido -- cae acá). Consecuencia
         -- declarada: un estado desconocido futuro cuenta EN LAS DOS
         -- columnas (acá y en estado_desconocido más abajo), a diferencia
         -- del lado orden donde cuenta solo en estado_desconocido. Más
         -- ruidoso, no menos correcto -- estado_desconocido ya escala a
         -- grave en registrarDesenlace().
         (SELECT count(*) FROM candidatos WHERE reserva_existe
              AND r_status IS DISTINCT FROM 'CANCELLED')::int                    AS reserva_no_elegible,
         (SELECT count(*) FROM candidatos WHERE
              (reserva_existe AND r_status NOT IN
                 ('PENDING','CONFIRMED','CANCELLED','COMPLETED','EXPIRED'))
           OR  ft_status NOT IN ('PENDING','SETTLED','FAILED','VOIDED'))::int     AS estado_desconocido,
         (SELECT count(*) FROM candidatos
              WHERE ft_status IN ('VOIDED','FAILED'))::int                       AS anulados,
         (SELECT count(*) FROM candidatos
              WHERE ft_type NOT IN ('CHARGE','ADJUSTMENT'))::int                 AS tipo_no_liquidable,
         (SELECT count(*) FROM candidatos
              WHERE con_comprobante_vivo)::int                                   AS con_comprobante_vivo`,
      [reservationId, businessId],
    );

    const f = rows[0];
    const aplicadas  = SqlFinancialTransactionRepository.entero(f, 'aplicadas');
    const candidatos = SqlFinancialTransactionRepository.entero(f, 'candidatos');
    const rechazos   = SqlFinancialTransactionRepository.rechazosDeReserva(f!);

    if (aplicadas > 0) return { tipo: 'APLICADO', filas: aplicadas, rechazos };
    if (candidatos === 0) return { tipo: 'NADA_QUE_HACER' };
    return { tipo: 'RECHAZADO', rechazos };
  }

  // -------------------------------------------------------------------------
  // O2 (03/09/2026) — efectos financieros de una orden, gobernados por estado
  // -------------------------------------------------------------------------

  /**
   * Lee un contador de la fila de diagnóstico. **La ausencia de resultado no
   * es cero.** Si la consulta no devolvió fila, o un contador no vino como
   * entero, eso es una anomalía del driver o del adaptador -- no un hecho de
   * negocio. Se lanza, y el worker reintenta.
   *
   * Reemplaza al viejo `result.rowCount ?? 0`, que confundía "el driver no
   * informó" con "cero filas". El conteo ahora vuelve como columna de la fila,
   * no como metadato del driver.
   */
  private static entero(fila: Record<string, unknown> | undefined, campo: string): number {
    if (!fila) {
      throw new Error('efecto financiero: la consulta no devolvió ninguna fila de diagnóstico.');
    }
    const valor = Number(fila[campo]);
    if (!Number.isInteger(valor)) {
      throw new Error(
        `efecto financiero: el contador "${campo}" no vino como entero (${String(fila[campo])}).`,
      );
    }
    return valor;
  }

  /**
   * Arma la lista de rechazos a partir de los contadores del diagnóstico
   * de las funciones de ORDEN (`voidByOrderId()`/`settleChargesByOrderId()`).
   *
   * RESERVA-10 (05/09/2026, architecture-governor): `voidByReservationId()`
   * tiene su PROPIO helper, `rechazosDeReserva()` (más abajo), en vez de
   * compartir este -- `reservations` no tiene `business_id` propio, así
   * que no existe ningún contador equivalente a `orden_ajena` para llenar
   * acá. Forzar el acople metería una columna dummy nombrando un concepto
   * que no puede existir del lado reserva (distinto del dummy legítimo
   * `con_comprobante_vivo` de `settleChargesByOrderId()`, donde el
   * concepto SÍ existe y el chequeo está solamente diferido).
   */
  private static rechazosDe(f: Record<string, unknown>): EfectoRechazo[] {
    const r: EfectoRechazo[] = [];
    const n = (c: string) => SqlFinancialTransactionRepository.entero(f, c);
    if (n('orden_inexistente')  > 0) r.push('ORDEN_INEXISTENTE');
    if (n('orden_ajena')        > 0) r.push('ORDEN_DE_OTRO_NEGOCIO');
    if (n('orden_no_elegible')  > 0) r.push('ORDEN_ESTADO_NO_ELEGIBLE');
    if (n('estado_desconocido') > 0) r.push('ESTADO_DESCONOCIDO');
    if (n('ya_settled')         > 0) r.push('CARGO_YA_SETTLED');
    if (n('anulados')           > 0) r.push('CARGO_ANULADO');
    if (n('tipo_no_liquidable') > 0) r.push('TIPO_NO_LIQUIDABLE');
    if (n('con_comprobante_vivo') > 0) r.push('CARGO_CON_COMPROBANTE_VIVO');
    return r;
  }

  async settleChargesByOrderId(
    orderId: string,
    businessId: string,
    paymentInfo?: PaymentInfo,
  ): Promise<EfectoDesenlace> {
    const method = paymentInfo?.paymentMethod ?? null;
    const cardInstallments = paymentInfo?.cardInstallments ?? null;
    const cardSurchargeAmount = paymentInfo?.cardSurchargeAmount ?? null;

    // Una sola sentencia: el UPDATE y la clasificación leen el MISMO snapshot.
    // Un SELECT de diagnóstico posterior leería otro y podría informar "orden
    // cancelada" sobre una orden que se canceló DESPUÉS -- una mentira.
    //
    // Tres allowlists positivas dentro del UPDATE: tipo del cargo (CHARGE y
    // nada más, ORDER-09), estado del cargo (PENDING) y estado de la orden
    // (COMPLETED, que es ORDER-03-b subsumido acá).
    const { rows } = await this.sqlClient.query<Record<string, unknown>>(
      `WITH candidatos AS (
         SELECT ft.id, ft.status AS ft_status, ft.type AS ft_type,
                (o_any.id IS NOT NULL) AS orden_existe,
                (o_mio.id IS NOT NULL) AS orden_del_negocio,
                o_mio.status           AS o_status
           FROM financial_transactions ft
           LEFT JOIN orders o_any ON o_any.id = ft.order_id
           LEFT JOIN orders o_mio ON o_mio.id = ft.order_id
                                 AND o_mio.business_id = ft.business_id
          WHERE ft.order_id = $1 AND ft.business_id = $5
       ),
       liquidadas AS (
         UPDATE financial_transactions ft
            SET status         = 'SETTLED',
                payment_method = COALESCE($2, ft.payment_method),
                shift_id       = CASE WHEN $2 = 'CASH'
                  THEN (SELECT s.id FROM cash_register_shifts s
                         WHERE s.business_id = ft.business_id AND s.status = 'OPEN')
                  ELSE ft.shift_id END,
                card_installments     = COALESCE($3, ft.card_installments),
                card_surcharge_amount = COALESCE($4, ft.card_surcharge_amount)
          WHERE ft.order_id    = $1
            AND ft.business_id = $5
            AND ft.type   IN ('CHARGE')
            AND ft.status IN ('PENDING')
            AND EXISTS (SELECT 1 FROM orders o
                         WHERE o.id          = ft.order_id
                           AND o.business_id = ft.business_id
                           AND o.status IN ('COMPLETED'))
         RETURNING ft.id
       )
       SELECT
         (SELECT count(*) FROM liquidadas)::int                                  AS aplicadas,
         (SELECT count(*) FROM candidatos)::int                                  AS candidatos,
         (SELECT count(*) FROM candidatos WHERE NOT orden_existe)::int           AS orden_inexistente,
         (SELECT count(*) FROM candidatos WHERE orden_existe
                                            AND NOT orden_del_negocio)::int      AS orden_ajena,
         (SELECT count(*) FROM candidatos WHERE orden_del_negocio
              AND o_status IN ('DRAFT','CONFIRMED','CANCELLED'))::int            AS orden_no_elegible,
         (SELECT count(*) FROM candidatos WHERE
              (orden_del_negocio AND o_status NOT IN
                 ('DRAFT','CONFIRMED','CANCELLED','COMPLETED'))
           OR  ft_status NOT IN ('PENDING','SETTLED','FAILED','VOIDED'))::int    AS estado_desconocido,
         (SELECT count(*) FROM candidatos WHERE ft_status = 'SETTLED')::int      AS ya_settled,
         (SELECT count(*) FROM candidatos
              WHERE ft_status IN ('VOIDED','FAILED'))::int                       AS anulados,
         (SELECT count(*) FROM candidatos
              WHERE ft_type NOT IN ('CHARGE'))::int                              AS tipo_no_liquidable,
         -- ORDER-10 (05/09/2026): dummy, no un chequeo real. La liquidación
         -- nunca mira comprobantes vivos -- esta columna existe sólo para
         -- que rechazosDe() (compartida con voidByOrderId()) no explote por
         -- una columna faltante. Si algún día settleChargesByOrderId()
         -- necesita el chequeo real, esto deja de ser 0::int.
         0::int                                                                  AS con_comprobante_vivo,
         (SELECT o.total_amount FROM orders o
           WHERE o.id = $1 AND o.business_id = $5)::numeric                      AS orden_total,
         (SELECT o.status FROM orders o
           WHERE o.id = $1 AND o.business_id = $5)                               AS orden_status`,
      [orderId, method, cardInstallments, cardSurchargeAmount, businessId],
    );

    const f = rows[0];
    const aplicadas  = SqlFinancialTransactionRepository.entero(f, 'aplicadas');
    const candidatos = SqlFinancialTransactionRepository.entero(f, 'candidatos');
    const rechazos   = SqlFinancialTransactionRepository.rechazosDe(f!);

    if (aplicadas > 0) return { tipo: 'APLICADO', filas: aplicadas, rechazos };

    // Sin ningún movimiento para esa orden hay que separar "no había nada que
    // cobrar" de "el CHARGE todavía no existe" (ORDER-13). Confundirlos deja
    // el cargo PENDING para siempre, que es lo que pasaba antes en silencio.
    if (candidatos === 0) {
      const estado = f!['orden_status'] as string | null;
      const total  = f!['orden_total'] == null ? null : Number(f!['orden_total']);
      if (estado === null)         return { tipo: 'RECHAZADO', rechazos: ['ORDEN_INEXISTENTE'] };
      if (estado !== 'COMPLETED')  return { tipo: 'RECHAZADO', rechazos: ['ORDEN_ESTADO_NO_ELEGIBLE'] };
      if (total !== null && total > 0) return { tipo: 'DEPENDENCIA_PENDIENTE' };
      return { tipo: 'NADA_QUE_HACER' };
    }

    return { tipo: 'RECHAZADO', rechazos };
  }

  async createOrderChargeIfConfirmed(
    client: SqlClient,
    input: OrderChargeInput,
  ): Promise<EfectoDesenlace> {
    // 1 · Lock de la fila de la orden, con el MISMO client que hará el INSERT.
    //     El NOT EXISTS de abajo no es a prueba de carreras por sí solo: dos
    //     handlers concurrentes podrían pasarlo los dos antes de que ninguno
    //     inserte. El lock los serializa. Que lock e INSERT compartan conexión
    //     no es una convención sino el parámetro `client`: el mismo objeto en
    //     las dos sentencias, dentro de la transacción del caller.
    const { rows: lock } = await client.query<Record<string, unknown>>(
      'SELECT id, business_id, status, confirmed_at FROM orders WHERE id = $1 FOR UPDATE',
      [input.orderId],
    );
    const orden = lock[0];
    if (!orden) return { tipo: 'RECHAZADO', rechazos: ['ORDEN_INEXISTENTE'] };
    if (orden['business_id'] !== input.businessId) {
      return { tipo: 'RECHAZADO', rechazos: ['ORDEN_DE_OTRO_NEGOCIO'] };
    }

    const estado = orden['status'] as string;
    if (!['DRAFT', 'CONFIRMED', 'CANCELLED', 'COMPLETED'].includes(estado)) {
      return { tipo: 'RECHAZADO', rechazos: ['ESTADO_DESCONOCIDO'] };
    }
    // Allowlist positiva. COMPLETED entra SÓLO porque order.completed puede
    // adelantarse al order.confirmed que crea el cargo (ORDER-13): sin eso la
    // familia se traba, uno esperando un cargo que el otro se niega a crear.
    if (!['CONFIRMED', 'COMPLETED'].includes(estado)) {
      return { tipo: 'RECHAZADO', rechazos: ['ORDEN_ESTADO_NO_ELEGIBLE'] };
    }
    // El estado COMPLETED aislado NO autoriza una creación financiera: tiene
    // que haber existido un acto de confirmación, y ese acto es confirmed_at.
    if (orden['confirmed_at'] == null) {
      return { tipo: 'RECHAZADO', rechazos: ['ORDEN_SIN_CONFIRMAR'] };
    }

    if (input.amount <= 0) return { tipo: 'NADA_QUE_HACER' };

    // 2 · INSERT condicional, mismo client. La identidad del acto es el
    //     order_id: NOT EXISTS por (order_id, type='CHARGE'). La clave
    //     'order:<id>:CHARGE' es la segunda defensa, y el NOT EXISTS cubre
    //     además la migración: un cargo viejo creado con la clave de evento
    //     bloquea igual al de clave nueva.
    let rows: { id: string }[];
    try {
      ({ rows } = await client.query<{ id: string }>(
      `INSERT INTO financial_transactions
         (id, business_id, customer_id, order_id, stay_id, idempotency_key,
          type, amount, currency, status)
       SELECT $1, $2, $3, $4, $5, $6, 'CHARGE', $7, $8, 'PENDING'
        WHERE NOT EXISTS (SELECT 1 FROM financial_transactions ft
                           WHERE ft.order_id    = $4::VARCHAR(255)
                             AND ft.business_id = $2::VARCHAR(255)
                             AND ft.type = 'CHARGE')
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        input.id, input.businessId, input.customerId, input.orderId,
        input.stayId, `order:${input.orderId}:CHARGE`,
        input.amount, input.currency,
      ],
      ));
    } catch (err) {
      // El indice de v45 y el NOT EXISTS detectan el MISMO hecho; el segundo
      // llega un instante antes. Que gane el indice no cambia el desenlace.
      if (SqlFinancialTransactionRepository.esConflictoDeCargoUnico(err)) {
        return { tipo: 'RECHAZADO', rechazos: ['CARGO_YA_EXISTE'] };
      }
      throw err;
    }

    if (rows.length === 0) return { tipo: 'RECHAZADO', rechazos: ['CARGO_YA_EXISTE'] };
    return { tipo: 'APLICADO', filas: rows.length, rechazos: [] };
  }

  /**
   * schema v45 -- el indice `uq_ft_un_charge_por_orden` hace ESTRUCTURAL el
   * invariante "un CHARGE por orden". Si dos handlers concurrentes llegaran a
   * pasar los dos el `NOT EXISTS` -- imposible con el lock, pero el indice no
   * depende del lock --, el segundo INSERT muere con 23505 contra ESE indice.
   *
   * Eso NO es un fallo tecnico: es el mismo hecho de negocio que el
   * `NOT EXISTS` detecta un instante antes. Propagarlo haria que el worker
   * reintentara 60 veces algo ya resuelto. Se traduce al mismo desenlace.
   *
   * Cualquier OTRO 23505 -- el de `idx_ft_idempotency_key`, por ejemplo -- se
   * propaga: no es este invariante y no corresponde interpretarlo aca.
   */
  private static esConflictoDeCargoUnico(err: unknown): boolean {
    const e = err as { code?: string; constraint?: string };
    return e?.code === '23505' && e?.constraint === 'uq_ft_un_charge_por_orden';
  }

  /**
   * O2 / ORDER-06 -- ver el docblock del contrato. La guarda de estado de la
   * orden va DENTRO de la sentencia, igual que en la liquidación.
   *
   * ORDER-15: el filtro de tipo sigue siendo ('CHARGE','ADJUSTMENT'), a
   * diferencia de la liquidación, que quedó en ('CHARGE'). La asimetría queda
   * declarada, no resuelta: cerrarla exige decidir antes si los ajustes sobre
   * órdenes son un concepto de negocio.
   *
   * **ORDER-10 (05/09/2026, architecture-governor) -- excepción cross-dominio
   * SANCIONADA.** Esta función es de `clientes-finanzas` y consulta acá,
   * en SQL crudo, las tablas `invoices`/`invoice_charges` de `facturación` --
   * `lint:arch` (dependency-cruiser) sólo inspecta imports de TypeScript, no
   * joins SQL cross-tabla, así que este acoplamiento es invisible para esa
   * cerca y hay que declararlo a mano acá. Motivo: anular en silencio un
   * CHARGE que ya tiene una Factura B con CAE real de AFIP (o una todavía
   * `PENDING`/`FAILED_UNCERTAIN` con AFIP ya contactado) deja un comprobante
   * fiscal real sin contrapartida -- el guard de la puerta de entrada
   * (`OrderService.cancelOrder()`, `OrderChargeInvoicedError`) cubre el
   * camino normal, pero esta función es el cierre estructural para
   * cualquier otro caller. Misma semántica de estados que
   * `InvoiceRepository.resolveInvoiceLinkage()` (facturación): bloquea
   * `ISSUED`, `PENDING` y `FAILED_UNCERTAIN` con `afip_contacted`; NO
   * bloquea `REJECTED` (AFIP ya dijo que no, no hay comprobante real).
   */
  async voidByOrderId(orderId: string, businessId: string): Promise<EfectoDesenlace> {
    const { rows } = await this.sqlClient.query<Record<string, unknown>>(
      `WITH candidatos AS (
         SELECT ft.id, ft.status AS ft_status, ft.type AS ft_type,
                (o_any.id IS NOT NULL) AS orden_existe,
                (o_mio.id IS NOT NULL) AS orden_del_negocio,
                o_mio.status           AS o_status,
                EXISTS (
                  SELECT 1 FROM (
                    SELECT status, afip_contacted FROM invoices
                     WHERE financial_transaction_id = ft.id
                    UNION ALL
                    SELECT i.status, i.afip_contacted FROM invoice_charges ic
                      JOIN invoices i ON i.id = ic.invoice_id
                     WHERE ic.financial_transaction_id = ft.id
                  ) linked
                  WHERE linked.status = 'ISSUED'
                     OR linked.status = 'PENDING'
                     OR (linked.status = 'FAILED_UNCERTAIN' AND linked.afip_contacted)
                ) AS con_comprobante_vivo
           FROM financial_transactions ft
           LEFT JOIN orders o_any ON o_any.id = ft.order_id
           LEFT JOIN orders o_mio ON o_mio.id = ft.order_id
                                 AND o_mio.business_id = ft.business_id
          WHERE ft.order_id = $1 AND ft.business_id = $2
       ),
       anuladas AS (
         UPDATE financial_transactions ft
            SET status = 'VOIDED'
          WHERE ft.order_id    = $1
            AND ft.business_id = $2
            AND ft.type   IN ('CHARGE','ADJUSTMENT')
            AND ft.status IN ('PENDING','SETTLED')
            AND EXISTS (SELECT 1 FROM orders o
                         WHERE o.id          = ft.order_id
                           AND o.business_id = ft.business_id
                           AND o.status IN ('CANCELLED'))
            AND NOT EXISTS (
                  SELECT 1 FROM (
                    SELECT status, afip_contacted FROM invoices
                     WHERE financial_transaction_id = ft.id
                    UNION ALL
                    SELECT i.status, i.afip_contacted FROM invoice_charges ic
                      JOIN invoices i ON i.id = ic.invoice_id
                     WHERE ic.financial_transaction_id = ft.id
                  ) linked
                  WHERE linked.status = 'ISSUED'
                     OR linked.status = 'PENDING'
                     OR (linked.status = 'FAILED_UNCERTAIN' AND linked.afip_contacted)
                )
         RETURNING ft.id
       )
       SELECT
         (SELECT count(*) FROM anuladas)::int                                    AS aplicadas,
         (SELECT count(*) FROM candidatos)::int                                  AS candidatos,
         (SELECT count(*) FROM candidatos WHERE NOT orden_existe)::int           AS orden_inexistente,
         (SELECT count(*) FROM candidatos WHERE orden_existe
                                            AND NOT orden_del_negocio)::int      AS orden_ajena,
         (SELECT count(*) FROM candidatos WHERE orden_del_negocio
              AND o_status IN ('DRAFT','CONFIRMED','COMPLETED'))::int            AS orden_no_elegible,
         (SELECT count(*) FROM candidatos WHERE
              (orden_del_negocio AND o_status NOT IN
                 ('DRAFT','CONFIRMED','CANCELLED','COMPLETED'))
           OR  ft_status NOT IN ('PENDING','SETTLED','FAILED','VOIDED'))::int    AS estado_desconocido,
         0::int                                                                  AS ya_settled,
         (SELECT count(*) FROM candidatos
              WHERE ft_status IN ('VOIDED','FAILED'))::int                       AS anulados,
         (SELECT count(*) FROM candidatos
              WHERE ft_type NOT IN ('CHARGE','ADJUSTMENT'))::int                 AS tipo_no_liquidable,
         (SELECT count(*) FROM candidatos
              WHERE con_comprobante_vivo)::int                                   AS con_comprobante_vivo`,
      [orderId, businessId],
    );

    const f = rows[0];
    const aplicadas  = SqlFinancialTransactionRepository.entero(f, 'aplicadas');
    const candidatos = SqlFinancialTransactionRepository.entero(f, 'candidatos');
    const rechazos   = SqlFinancialTransactionRepository.rechazosDe(f!);

    if (aplicadas > 0) return { tipo: 'APLICADO', filas: aplicadas, rechazos };
    if (candidatos === 0) return { tipo: 'NADA_QUE_HACER' };
    return { tipo: 'RECHAZADO', rechazos };
  }

  /**
   * Bug real en producción, 23/08/2026 (pendientes-2026-08-23.md,
   * verificación de auditoría externa) — REFUND tenía el mismo signo que
   * PAYMENT (`-amount`). Un REFUND revierte un PAYMENT (A3.9,
   * criterios-negocio.md: "todo movimiento tiene contrapartida"), así que
   * necesita el signo OPUESTO, no el mismo: si no, un reembolso duplica el
   * débito en vez de cancelarlo (cobro 1000 + reembolso 1000 daba -2000,
   * no 0). Ver también `voidByReservationId`/`voidByOrderId` más abajo —
   * el bug completo requería los dos fixes juntos.
   *
   * **`SETTLED`-only, a diferencia de `getNetBalanceByStayId()`** (que
   * también cuenta `PENDING`, ver su docblock) — DECLARADO, no alineado
   * (`CITY-LEDGER-CUSTOMER-BALANCE-STATUS-ASYMMETRY-001`, paso 2,
   * 13/09/2026, grounding `auditor-circuitos-erp`: 3/3 sistemas
   * verificados en código -- Odoo `_credit_debit_get`, ERPNext
   * `get_balance_on()` vs. `get_customer_outstanding()`, QloApps
   * `Customer::getOutstanding()` -- excluyen del agregado por CLIENTE las
   * obligaciones contratadas-no-firmes; el nivel FOLIO (`getNetBalanceByStayId`)
   * es una pregunta distinta, donde sí corresponde contar `PENDING`).
   *
   * **`CITY-LEDGER-CUSTOMER-BALANCE-STATUS-ASYMMETRY-001` -- CERRADO
   * (paso 3, DECIDIDO NO IMPLEMENTAR, 14/09/2026).** El `PAYMENT`
   * sintético de una transferencia a City Ledger todavía cuenta acá sin
   * excluir, y el `CHARGE` original de la reserva se liquida después
   * (`reservation.completed` -> `settleByReservationId()`) -- crédito
   * fantasma TRANSITORIO, se autocorrige solo cuando el `CHARGE` liquida
   * (verificado empíricamente contra Postgres real). 4 rondas de diseño
   * para excluirlo fueron rechazadas, cada una con un defecto aritmético
   * real distinto (ver `docs/diseno-city-ledger-balance-asymmetry-pasos-2b-3-2026-09-14.md`
   * §2, y el cierre del ítem completo en `docs/resuelto.md`, sección
   * `14/09/2026`) -- la última (ronda 4, columna de vínculo con
   * corrección proporcional) sobrevivió su propia verificación aritmética
   * pero el dueño decidió, preguntado explícitamente, NO tocar este
   * método: `balance` queda con su definición SETTLED-only actual, y
   * `CustomerStatement.cityLedgerOutstanding` (paso 2(b),
   * `getCityLedgerOutstandingByCustomerId()` más abajo en este archivo)
   * resuelve la necesidad de visibilidad sin tocar este cálculo. **No
   * reabrir sin nueva decisión del dueño.**
   */
  async getNetBalanceByCustomerId(customerId: string): Promise<number> {
    const result = await this.sqlClient.query<{ net: string }>(
      `SELECT
         COALESCE(
           SUM(
             CASE type
               WHEN 'CHARGE'     THEN  amount
               WHEN 'ADJUSTMENT' THEN  amount
               WHEN 'PAYMENT'    THEN -amount
               WHEN 'REFUND'     THEN  amount
             END
           ), 0
         ) AS net
       FROM financial_transactions
       WHERE customer_id = $1
         AND status = 'SETTLED'`,
      [customerId],
    );
    return parseFloat(result.rows[0]?.net ?? '0');
  }

  /**
   * Ver docblock completo en la interfaz
   * (`financial-transaction.repository.ts::getCityLedgerOutstandingByCustomerId`)
   * — caveat de AR legacy sin `guest_payment_transaction_id` incluido ahí,
   * no repetido acá.
   */
  async getCityLedgerOutstandingByCustomerId(customerId: string): Promise<number> {
    const result = await this.sqlClient.query<{ outstanding: string }>(
      `SELECT COALESCE(SUM(ar.amount), 0) AS outstanding
       FROM accounts_receivable ar
       JOIN financial_transactions gp ON gp.id = ar.guest_payment_transaction_id
       WHERE gp.customer_id = $1
         AND ar.status IN ('PENDIENTE_FACTURAR', 'FACTURADO')`,
      [customerId],
    );
    return parseFloat(result.rows[0]?.outstanding ?? '0');
  }

  async getSettledPaymentTotalForReservation(reservationId: string): Promise<number> {
    const result = await this.sqlClient.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM financial_transactions
       WHERE reservation_id = $1 AND type = 'PAYMENT' AND status = 'SETTLED'`,
      [reservationId],
    );
    return parseFloat(result.rows[0]?.total ?? '0');
  }

  async getCollectedPaymentTotalForReservation(reservationId: string): Promise<number> {
    // BRECHA-REFUND-01 (05/09/2026, architecture-governor) -- ahora resta
    // los REFUND ya emitidos. Antes del fix, dos confirmRefund() sobre la
    // MISMA reserva (sin necesitar concurrencia real -- alcanza con dos
    // llamadas separadas por minutos) calculaban el mismo "collected" cada
    // vez, así que el segundo reembolso repetía el cálculo del primero en
    // vez de verlo ya descontado -- doble reembolso real. Ver el docblock
    // de la interfaz (financial-transaction.repository.ts) para la
    // asimetría deliberada de estados entre PAYMENT y REFUND.
    //
    // Sin GREATEST(...,0): si el neto diera negativo (no debería, salvo un
    // REFUND que ya exceda lo cobrado -- caso que este mismo cambio cierra
    // hacia adelante), NothingToRefundError ya lo corta más arriba
    // (confirmRefund() lanza si refundAmount <= 0) -- un clamp acá
    // escondería la anomalía en vez de dejarla visible.
    const result = await this.sqlClient.query<{ total: string }>(
      `SELECT COALESCE(SUM(CASE WHEN type = 'PAYMENT' THEN amount ELSE -amount END), 0) AS total
       FROM financial_transactions
       WHERE reservation_id = $1
         AND (
               (type = 'PAYMENT' AND status IN ('SETTLED', 'VOIDED'))
            OR (type = 'REFUND'  AND status = 'SETTLED')
             )`,
      [reservationId],
    );
    return parseFloat(result.rows[0]?.total ?? '0');
  }

  async linkStayToReservationCharges(stayId: string, reservationId: string): Promise<number> {
    // `CITY-LEDGER-AR-DOUBLE-TRANSFER-001` (Wave 13, 18/09/2026, gate
    // `architecture-governor`, docs/diseno-city-ledger-double-transfer-2026-09-18.md)
    // -- predicado alfa AND beta. Sin esto, esta adopción type-agnóstica
    // (a propósito, ver CITY-LEDGER-OVERTRANSFER-PAYMENT-001 -- no
    // filtrar por `type` acá) podía re-adoptar el CHARGE compensatorio
    // de empresa de una transferencia ANTERIOR (`postStayTransfer()`,
    // accounts-receivable.service.ts, nace con `stay_id NULL` a
    // propósito) en una segunda transferencia o un re-check-in,
    // duplicando la deuda transferida.
    //   alfa: `reversed_transaction_id IS NULL` -- evita adoptar la pata
    //   ADJUSTMENT compensatoria de `reverseTransfer()` mientras está en
    //   vuelo (`CITY-LEDGER-AR-STAY-ADOPTION-RACE-001`).
    //   beta: `NOT EXISTS (... accounts_receivable.financial_transaction_id
    //   = financial_transactions.id)` -- excluye el CHARGE de empresa
    //   una vez que ya tiene una AR asociada (el único productor de esa
    //   columna es `postStayTransfer()`).
    // Deliberadamente NO se filtra por `reversed_invoice_id` (columna
    // distinta, usada por los ADJUSTMENT de Nota de Crédito) -- esos
    // cargos tienen que seguir siendo adoptables, son cargos legítimos
    // de la reserva/estadía, no filas de City Ledger.
    // Hueco legacy aceptado: filas de `accounts_receivable`/
    // `financial_transactions` anteriores a que existiera la columna
    // `financial_transaction_id` quedan ciegas a beta (sin backfill
    // posible, ver schema.sql) -- medido 0 filas en los 2 tenants reales
    // al momento de este fix, ver el diseño citado arriba.
    // beta es status-agnóstico a propósito: `markRevertedWithClient()`
    // (sql.accounts-receivable.repository.ts) NO limpia
    // `financial_transaction_id` al pasar la AR a REVERTIDO, así que el
    // CHARGE de empresa sigue excluido de la adopción incluso después de
    // revertido -- correcto, porque alfa ya excluye la pata ADJUSTMENT
    // compensatoria, y las dos filas netean a cero en el ledger de la
    // empresa sin que ninguna de las dos vuelva a moverse de estadía.
    const result = await this.sqlClient.query(
      `UPDATE financial_transactions
       SET stay_id = $1
       WHERE reservation_id = $2
         AND stay_id IS NULL
         AND reversed_transaction_id IS NULL
         AND NOT EXISTS (
               SELECT 1 FROM accounts_receivable ar
                WHERE ar.financial_transaction_id = financial_transactions.id
             )`,
      [stayId, reservationId],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Mismo fix de signo de REFUND que `getNetBalanceByCustomerId` — ver su
   * docblock. Filtro de status corregido 12/09/2026 (caso 3 de
   * `docs/investigacion-decisiones-bloqueado-2026-09-12.md`): antes exigía
   * `status = 'SETTLED'` a secas, y el CHARGE de saldo / los ADJUSTMENT de
   * precio nacen `PENDING` (liquidan recién en `reservation.completed`,
   * ver `outbox.handlers.ts`) — el guard de `checkOut()` casi nunca veía el
   * ítem de ingreso principal de la estadía. `PAYMENT`/`REFUND` siempre
   * nacen `SETTLED` directo, así que incluir `PENDING` no les afecta.
   */
  async getNetBalanceByStayId(stayId: string): Promise<number> {
    const result = await this.sqlClient.query<{ net: string }>(
      `SELECT
         COALESCE(
           SUM(
             CASE type
               WHEN 'CHARGE'     THEN  amount
               WHEN 'ADJUSTMENT' THEN  amount
               WHEN 'PAYMENT'    THEN -amount
               WHEN 'REFUND'     THEN  amount
             END
           ), 0
         ) AS net
       FROM financial_transactions
       WHERE stay_id = $1
         AND status IN ('PENDING', 'SETTLED')`,
      [stayId],
    );
    return parseFloat(result.rows[0]?.net ?? '0');
  }

  // ---------------------------------------------------------------------------
  // Helpers privados
  // ---------------------------------------------------------------------------

  private rowToEntity(row: TransactionRow): FinancialTransaction {
    return {
      id:              row.id,
      businessId:      row.business_id,
      customerId:      row.customer_id,
      reservationId:   row.reservation_id,
      orderId:         row.order_id,
      stayId:          row.stay_id,
      idempotencyKey:  row.idempotency_key,
      type:            row.type,
      amount:          parseFloat(row.amount),
      currency:        row.currency,
      status:          row.status,
      notes:           row.notes,
      paymentMethod:   row.payment_method,
      shiftId:         row.shift_id,
      cardInstallments:    row.card_installments,
      cardSurchargeAmount: row.card_surcharge_amount !== null ? parseFloat(row.card_surcharge_amount) : null,
      confirmedBy:     row.confirmed_by,
      reversedInvoiceId: row.reversed_invoice_id,
      settledInvoiceId: row.settled_invoice_id,
      reversedTransactionId: row.reversed_transaction_id,
      createdAt:       row.created_at,
      reservationNumber: row.reservation_number ?? null,
    };
  }
}
