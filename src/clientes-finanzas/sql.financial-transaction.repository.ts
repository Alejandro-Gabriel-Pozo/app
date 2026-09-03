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
    if (
      (tx.type === 'CHARGE' || tx.type === 'ADJUSTMENT') &&
      tx.reservationId == null &&
      tx.orderId == null &&
      tx.stayId == null
    ) {
      throw new Error(
        `financial_transactions: un ${tx.type} necesita al menos un documento de origen ` +
        `(reservationId, orderId o stayId) -- no debería crearse uno sin ninguno de los tres.`,
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
           (id, business_id, customer_id, reservation_id, order_id, stay_id, idempotency_key, type, amount, currency, status, notes, payment_method, shift_id, card_installments, card_surcharge_amount, confirmed_by, reversed_invoice_id, settled_invoice_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           COALESCE($14, CASE WHEN $13::VARCHAR(20) = 'CASH'
             THEN (SELECT id FROM cash_register_shifts WHERE business_id = $2::VARCHAR(255) AND status = 'OPEN')
             ELSE NULL END), $15, $16, $17, $18, $19)
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
         (id, business_id, customer_id, reservation_id, order_id, stay_id, type, amount, currency, status, notes, payment_method, shift_id, card_installments, card_surcharge_amount, confirmed_by, reversed_invoice_id, settled_invoice_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         COALESCE($13, CASE WHEN $12::VARCHAR(20) = 'CASH'
           THEN (SELECT id FROM cash_register_shifts WHERE business_id = $2::VARCHAR(255) AND status = 'OPEN')
           ELSE NULL END), $14, $15, $16, $17, $18)
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
    const result = await this.sqlClient.query(
      `UPDATE financial_transactions
       SET status = 'SETTLED'
       WHERE reservation_id = $1
         AND status = 'PENDING'`,
      [reservationId],
    );
    return result.rowCount ?? 0;
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
   */
  async voidByReservationId(reservationId: string): Promise<number> {
    const result = await this.sqlClient.query(
      `UPDATE financial_transactions
       SET status = 'VOIDED'
       WHERE reservation_id = $1
         AND status IN ('PENDING', 'SETTLED')
         AND type IN ('CHARGE', 'ADJUSTMENT')`,
      [reservationId],
    );
    return result.rowCount ?? 0;
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

  /** Arma la lista de rechazos a partir de los contadores del diagnóstico. */
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
    const { rows } = await client.query<{ id: string }>(
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
    );

    if (rows.length === 0) return { tipo: 'RECHAZADO', rechazos: ['CARGO_YA_EXISTE'] };
    return { tipo: 'APLICADO', filas: rows.length, rechazos: [] };
  }

  /**
   * O2 / ORDER-06 -- ver el docblock del contrato. La guarda de estado de la
   * orden va DENTRO de la sentencia, igual que en la liquidación.
   *
   * ORDER-15: el filtro de tipo sigue siendo ('CHARGE','ADJUSTMENT'), a
   * diferencia de la liquidación, que quedó en ('CHARGE'). La asimetría queda
   * declarada, no resuelta: cerrarla exige decidir antes si los ajustes sobre
   * órdenes son un concepto de negocio.
   */
  async voidByOrderId(orderId: string, businessId: string): Promise<EfectoDesenlace> {
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
              WHERE ft_type NOT IN ('CHARGE','ADJUSTMENT'))::int                 AS tipo_no_liquidable`,
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
    const result = await this.sqlClient.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM financial_transactions
       WHERE reservation_id = $1 AND type = 'PAYMENT' AND status IN ('SETTLED', 'VOIDED')`,
      [reservationId],
    );
    return parseFloat(result.rows[0]?.total ?? '0');
  }

  async linkStayToReservationCharges(stayId: string, reservationId: string): Promise<number> {
    const result = await this.sqlClient.query(
      `UPDATE financial_transactions
       SET stay_id = $1
       WHERE reservation_id = $2
         AND stay_id IS NULL`,
      [stayId, reservationId],
    );
    return result.rowCount ?? 0;
  }

  /** Mismo fix y mismo motivo que `getNetBalanceByCustomerId` — ver su docblock. */
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
         AND status = 'SETTLED'`,
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
      createdAt:       row.created_at,
      reservationNumber: row.reservation_number ?? null,
    };
  }
}
