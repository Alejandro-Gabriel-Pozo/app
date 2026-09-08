import type { SqlClient } from '../repositories/sql.client.js';
import type { Invoice, CreateInvoiceInput, InvoiceStatus, AfipEnvironment, InvoiceItem, CreateInvoiceItemInput } from './invoice.entities.js';
import type { InvoiceRepository, MarkIssuedInput, MarkFailedInput, InvoiceLinkage } from './invoice.repository.js';
import type { PaymentMethod } from '../clientes-finanzas/financial-transaction.repository.js';
import { isInvoiceFullyCompensatedByIssuedCreditNotes } from './cancel-with-credit-note.js';
import { CBTE_TIPO_FACTURA_B, CBTE_TIPOS_NOTA_CREDITO } from './afip-catalog.constants.js';
import { randomUUID } from 'node:crypto';

interface InvoiceRow {
  id: string;
  business_id: string;
  financial_transaction_id: string | null;
  customer_id: string;
  idempotency_key: string;
  environment: AfipEnvironment;
  pto_vta: number;
  cbte_tipo: number;
  cbte_nro: string | null; // BIGINT llega como string en pg
  concepto: number;
  doc_tipo: number;
  doc_nro: string;
  condicion_iva_receptor_id: number;
  moneda: string;
  imp_neto: string;
  imp_iva: string;
  imp_total: string;
  cae: string | null;
  cae_vto: Date | null; // DATE llega como Date en pg, no como string
  status: InvoiceStatus;
  afip_contacted: boolean;
  emisor_cuit: string | null;
  payment_method: PaymentMethod | null;
  card_installments: number | null;
  afip_request: unknown;
  afip_response: unknown;
  error_message: string | null;
  created_at: Date;
  issued_at: Date | null;
}

function rowToEntity(row: InvoiceRow): Invoice {
  return {
    id: row.id,
    businessId: row.business_id,
    financialTransactionId: row.financial_transaction_id,
    customerId: row.customer_id,
    idempotencyKey: row.idempotency_key,
    environment: row.environment,
    ptoVta: row.pto_vta,
    cbteTipo: row.cbte_tipo,
    cbteNro: row.cbte_nro !== null ? Number(row.cbte_nro) : null,
    concepto: row.concepto,
    docTipo: row.doc_tipo,
    docNro: row.doc_nro,
    condicionIvaReceptorId: row.condicion_iva_receptor_id,
    moneda: row.moneda,
    impNeto: parseFloat(row.imp_neto),
    impIva: parseFloat(row.imp_iva),
    impTotal: parseFloat(row.imp_total),
    cae: row.cae,
    caeVto: row.cae_vto ? row.cae_vto.toISOString().split('T')[0]! : null,
    status: row.status,
    afipContacted: row.afip_contacted,
    emisorCuit: row.emisor_cuit,
    paymentMethod: row.payment_method,
    cardInstallments: row.card_installments,
    afipRequest: row.afip_request,
    afipResponse: row.afip_response,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    issuedAt: row.issued_at,
  };
}

export class SqlInvoiceRepository implements InvoiceRepository {
  constructor(private readonly db: SqlClient) {}

  async getById(id: string): Promise<Invoice | null> {
    const { rows } = await this.db.query<InvoiceRow>(`SELECT * FROM invoices WHERE id = $1`, [id]);
    return rows[0] ? rowToEntity(rows[0]) : null;
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<Invoice | null> {
    const { rows } = await this.db.query<InvoiceRow>(
      `SELECT * FROM invoices WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    return rows[0] ? rowToEntity(rows[0]) : null;
  }

  async getByFinancialTransactionId(financialTransactionId: string): Promise<Invoice[]> {
    const { rows } = await this.db.query<InvoiceRow>(
      `SELECT * FROM invoices WHERE financial_transaction_id = $1 ORDER BY created_at ASC`,
      [financialTransactionId],
    );
    return rows.map(rowToEntity);
  }

  async getOutstandingForUpdate(client: SqlClient, invoiceId: string): Promise<number> {
    // O2-F2 (03/09/2026) -- DOS sentencias separadas, a propósito. Antes
    // era una sola `SELECT ... FOR UPDATE OF i` con el cómputo de saldo
    // (subconsultas correlacionadas contra financial_transactions) en el
    // mismo SELECT que toma el lock. Bajo Postgres real, si esta sentencia
    // tiene que ESPERAR el lock (otra transacción lo tenía tomado) y esa
    // otra transacción no modificó la fila de `invoices` en sí (solo
    // insertó en `financial_transactions`, una tabla DISTINTA -- exactamente
    // el caso de `markCollected()`/`recordPayment()`), Postgres NO
    // re-evalúa las subconsultas correlacionadas con una foto nueva al
    // desbloquear: quedan con la foto de ANTES de esperar, así que "ganan"
    // el lock pero leen un saldo viejo -- sobre-aplicación real bajo
    // concurrencia genuina, no solo hipotética.
    //
    // Reproducido y confirmado contra Postgres real (Neon) el 03/09/2026:
    // dentro de la MISMA transacción, inmediatamente después de esta
    // sentencia, un SELECT plano SÍ ve la fila recién commiteada por la
    // otra transacción -- la sentencia FOR UPDATE bloqueada es la única que
    // queda con la foto vieja. Por eso el fix separa "tomar el lock" (sin
    // subconsultas, nada que pueda quedar stale) de "leer el saldo"
    // (sentencia nueva, ejecuta DESPUÉS de que el lock ya se obtuvo, con
    // una foto tomada en ese momento -- ya no puede quedar vieja).
    //
    // Afecta también al camino de O2-F1 (recordPayment): esa suite pasaba
    // porque su timing no disparaba la espera real por el lock, no porque
    // el mecanismo fuera correcto bajo cualquier orden de llegada -- ver
    // docs/diseno-o2-f2-cierre-completo-2026-09-03.md.
    await client.query(`SELECT 1 FROM invoices WHERE id = $1 FOR UPDATE`, [invoiceId]);

    // Sin el JOIN a `financial_transactions ft ON ft.id = i.financial_transaction_id`
    // que usa `getOutstandingByCustomerId`: acá se busca por `i.id`
    // directo, y ese JOIN excluiría toda factura CONSOLIDADA
    // (`financial_transaction_id IS NULL` a propósito, ver schema.sql:3139) --
    // exactamente el tipo de factura contra la que este método también
    // tiene que poder calcular saldo.
    // ADR común cancelar-con-NC (06/09/2026, N1.b) -- la contribución de una
    // transacción revertidora al "ya revertido" de la factura se toma POR TIPO,
    // no como `SUM(r.amount)` a secas: un `REFUND` lleva `amount` positivo (ese
    // es el monto revertido); el `ADJUSTMENT` compensatorio de una Nota de
    // Crédito lleva `amount` NEGATIVO (convención de `handleReservationPriceAdjusted`,
    // outbox.handlers.ts:169-176), así que su monto revertido es `-r.amount`.
    // Sin este CASE, un `ADJUSTMENT` negativo haría `imp_total - (-monto) =
    // imp_total + monto` y la factura nunca se vería compensada. `ELSE 0`
    // explícito (no `-r.amount` genérico): defensa en profundidad para un
    // `type` inesperado con `reversed_invoice_id`. Desde schema v47 el CHECK
    // `chk_financial_transactions_reversed_invoice_type` garantiza que sólo
    // `REFUND`/`ADJUSTMENT` pueden tener `reversed_invoice_id`, así que el
    // `ELSE 0` es hoy inalcanzable -- se mantiene por si la whitelist del
    // CHECK y este CASE se desalinearan.
    const { rows } = await client.query<{ outstanding: string }>(
      `SELECT
         (i.imp_total
           - COALESCE((SELECT SUM(p.amount) FROM financial_transactions p
                       WHERE p.settled_invoice_id = i.id AND p.status = 'SETTLED'), 0)
           - COALESCE((SELECT SUM(CASE WHEN r.type = 'REFUND' THEN r.amount
                                       WHEN r.type = 'ADJUSTMENT' THEN -r.amount
                                       ELSE 0 END)
                       FROM financial_transactions r
                       WHERE r.reversed_invoice_id = i.id AND r.status = 'SETTLED'), 0)
         ) AS outstanding
       FROM invoices i
       WHERE i.id = $1`,
      [invoiceId],
    );
    if (rows.length === 0) {
      throw new Error(`getOutstandingForUpdate: factura "${invoiceId}" no existe -- invariante roto, se validó su existencia antes de entrar a la transacción`);
    }
    return parseFloat(rows[0]!.outstanding);
  }

  async getRefundableForUpdate(client: SqlClient, invoiceId: string): Promise<number> {
    // BRECHA-REFUND-01 Fase 3 -- mismo patrón de dos sentencias que
    // getOutstandingForUpdate (§7.1): lock puro primero, sin subconsultas;
    // cómputo después, sentencia nueva, foto fresca.
    await client.query(`SELECT 1 FROM invoices WHERE id = $1 FOR UPDATE`, [invoiceId]);

    // "ya reembolsado" por TIPO -- ver el comentario de N1.b en
    // getOutstandingForUpdate arriba (REFUND: +amount; ADJUSTMENT de NC:
    // -amount; ELSE 0).
    const { rows } = await client.query<{ refundable: string }>(
      `SELECT LEAST(
         -- (A) pagado − ya reembolsado
         COALESCE((SELECT SUM(p.amount) FROM financial_transactions p
                    WHERE p.settled_invoice_id = i.id AND p.status = 'SETTLED'), 0)
           - COALESCE((SELECT SUM(CASE WHEN r.type = 'REFUND' THEN r.amount
                                       WHEN r.type = 'ADJUSTMENT' THEN -r.amount
                                       ELSE 0 END)
                       FROM financial_transactions r
                       WHERE r.reversed_invoice_id = i.id AND r.status = 'SETTLED'), 0),
         -- (B) valor del comprobante − ya reembolsado
         i.imp_total
           - COALESCE((SELECT SUM(CASE WHEN r.type = 'REFUND' THEN r.amount
                                       WHEN r.type = 'ADJUSTMENT' THEN -r.amount
                                       ELSE 0 END)
                       FROM financial_transactions r
                       WHERE r.reversed_invoice_id = i.id AND r.status = 'SETTLED'), 0)
       ) AS refundable
       FROM invoices i
       WHERE i.id = $1`,
      [invoiceId],
    );
    if (rows.length === 0) {
      throw new Error(`getRefundableForUpdate: factura "${invoiceId}" no existe -- invariante roto, se validó su existencia antes de entrar a la transacción`);
    }
    return parseFloat(rows[0]!.refundable);
  }

  async getOutstandingByCustomerId(customerId: string): Promise<Array<Invoice & { outstanding: number }>> {
    // O2-F2 (03/09/2026, F2.1) -- el JOIN original exigía
    // `ft.id = i.financial_transaction_id`, lo que excluía TODA factura
    // consolidada (`i.financial_transaction_id IS NULL` a propósito, ver
    // schema.sql:3139) del listado -- una factura consolidada cobrada quedaba
    // invisible para este modal de conciliación aunque tuviera saldo real.
    // Ahora: consolidada (financial_transaction_id IS NULL) siempre pasa --
    // nunca se genera una consolidada para un REFUND, así que no hace falta
    // verificar `type` en ese caso -- o individual con `ft.type = 'CHARGE'`,
    // mismo filtro que antes.
    const { rows } = await this.db.query<InvoiceRow & { outstanding: string }>(
      `SELECT * FROM (
         SELECT i.*,
           (i.imp_total
             - COALESCE((SELECT SUM(p.amount) FROM financial_transactions p
                         WHERE p.settled_invoice_id = i.id AND p.status = 'SETTLED'), 0)
             -- "ya revertido" por TIPO -- ver N1.b en getOutstandingForUpdate.
             - COALESCE((SELECT SUM(CASE WHEN r.type = 'REFUND' THEN r.amount
                                         WHEN r.type = 'ADJUSTMENT' THEN -r.amount
                                         ELSE 0 END)
                         FROM financial_transactions r
                         WHERE r.reversed_invoice_id = i.id AND r.status = 'SETTLED'), 0)
           ) AS outstanding
         FROM invoices i
         LEFT JOIN financial_transactions ft ON ft.id = i.financial_transaction_id
         WHERE i.customer_id = $1 AND i.status = 'ISSUED'
           AND (i.financial_transaction_id IS NULL OR ft.type = 'CHARGE')
       ) sub
       WHERE outstanding > 0
       ORDER BY issued_at ASC NULLS LAST`,
      [customerId],
    );
    return rows.map((row) => ({ ...rowToEntity(row), outstanding: parseFloat(row.outstanding) }));
  }

  async getByCustomerId(customerId: string): Promise<Invoice[]> {
    const { rows } = await this.db.query<InvoiceRow>(
      `SELECT * FROM invoices WHERE customer_id = $1 ORDER BY created_at DESC`,
      [customerId],
    );
    return rows.map(rowToEntity);
  }

  async resolveInvoiceLinkage(financialTransactionId: string): Promise<InvoiceLinkage> {
    // AR-FACT-NO-ISSUED-01 (05/09/2026) -- reemplaza a
    // getInvoiceIdByFinancialTransactionId(). H2 (architecture-governor,
    // 03/09/2026) sigue aplicando en espíritu (la rama consolidada
    // necesita el mismo tratamiento que la individual), pero SIN filtro de
    // status -- acá se quiere saber el estado real, no solo si es ISSUED.
    // UNION ALL de los dos caminos (individual: invoices.financial_transaction_id
    // directo; consolidado: invoice_charges), sin deduplicar por diseño --
    // el ORDER BY prioriza ISSUED si por algún motivo hubiera más de una
    // fila (no debería, ver el docblock de la interfaz).
    const { rows } = await this.db.query<{ id: string; status: InvoiceStatus; afip_contacted: boolean }>(
      `SELECT id, status, afip_contacted FROM (
         SELECT id, status, afip_contacted FROM invoices WHERE financial_transaction_id = $1
         UNION ALL
         SELECT i.id, i.status, i.afip_contacted FROM invoice_charges ic
         JOIN invoices i ON i.id = ic.invoice_id
         WHERE ic.financial_transaction_id = $1
       ) linked
       ORDER BY (status = 'ISSUED') DESC, id
       LIMIT 1`,
      [financialTransactionId],
    );
    const row = rows[0];
    if (!row) return { kind: 'NONE' };
    if (row.status === 'ISSUED') return { kind: 'ISSUED', invoiceId: row.id };
    return { kind: 'NOT_ISSUED', invoiceId: row.id, status: row.status, afipContacted: row.afip_contacted };
  }

  async getIssuedCreditNoteCompensationTotal(client: SqlClient, invoiceId: string): Promise<number> {
    // ADR común cancelar-con-NC (06/09/2026) -- mitad SQL del predicado F4.
    // Ver el docblock de la interfaz para la doctrina completa.
    //
    // El sub-SELECT `nc` espeja los CAMINOS del UNION ALL de
    // resolveInvoiceLinkage() (arriba): un comprobante llega a su transacción
    // revertidora de forma individual (invoices.financial_transaction_id) o
    // consolidada (invoice_charges). Mantener esos dos caminos alineados es
    // MANUAL -- no hay typecheck que ate las dos queries; si
    // resolveInvoiceLinkage() suma un tercer camino, este también.
    // Los PREDICADOS sí divergen a propósito desde el bloque 1.4:
    // resolveInvoiceLinkage() quiere CUALQUIER comprobante ligado a la FT
    // (para bloquear la cancelación); acá se filtra `nc.cbte_tipo` para contar
    // SÓLO Notas de Crédito como compensación (ver más abajo).
    //
    // `r.type IN ('REFUND','ADJUSTMENT')`: whitelist de N1.b. Desde schema v47
    // el CHECK `chk_financial_transactions_reversed_invoice_type` impide una
    // fila con `reversed_invoice_id` y otro `type` (mitad de datos de la
    // condición 3 del re-gate; la mitad de código es la cerca
    // `reversed-invoice-id-convention.test.ts`). El filtro se mantiene igual:
    // si el CHECK y esta whitelist se desalinearan, fail-closed (la
    // compensación no cuenta -> la cancelación queda bloqueada).
    //
    // `nc.cbte_tipo = ANY($2)` en el WHERE EXTERNO (3-ter, bloque 1.4), al lado
    // de `nc.status = 'ISSUED'` -- las dos ramas del UNION ALL seleccionan
    // `cbte_tipo` como columna, el predicado se aplica una sola vez sobre el
    // resultado unido. Se elige el WHERE externo, no un filtro por rama: una
    // 3ª rama futura que omita la columna revienta con "each UNION query must
    // have the same number of columns" (fail-loud en CI), mientras que una que
    // omitiera un `AND cbte_tipo = ANY(...)` por rama compilaría y
    // reintroduciría el fail-OPEN en silencio. Mismo nivel que `nc.status`,
    // que es el predicado hermano.
    // Sólo una Nota de Crédito compensa. Sin el filtro, una Factura B (u otro
    // comprobante) cuyo `financial_transaction_id` -- o cuya fila
    // `invoice_charges` -- apuntara por un bug a una FT revertidora sumaría su
    // `imp_total` -> fail-OPEN (la cancelación se destraba sin NC real).
    // `CBTE_TIPOS_NOTA_CREDITO`, no `= 8` literal: NC A/C entran ahí el día que
    // se emita Factura A/C. Acoplado por invariante al routing de
    // `InvoiceService.requestInvoice()` (una FT REFUND/ADJUSTMENT produce
    // siempre una NC) -- ver el docblock de la constante y los tests de
    // routing de `invoice.service.test.ts`.
    //
    // NO se filtra `r.status`: F4 se ancla a la NC `ISSUED`, no al ledger
    // (Defecto B). Si la NC llegó a AFIP el crédito existe aunque la fila
    // revertidora local no esté SETTLED.
    //
    // `SELECT DISTINCT (nc_invoice_id, imp_total)` antes del SUM -- NO es
    // cosmético, cierra un doble conteo fail-open real (re-gate governor,
    // 06/09/2026):
    //  (motivo principal) `invoice_charges` es N:1 hacia la factura. Una NC
    //  CONSOLIDADA con N filas `invoice_charges` apuntando a N transacciones
    //  revertidoras que comparten `reversed_invoice_id = $1` produce N filas
    //  del join, y sin dedup `SUM(imp_total)` suma el imp_total de ESA NC N
    //  veces -> F4 da "compensada" con compensación parcial -> se destraba
    //  la cancelación. El ADR (N1.a, "Multi-línea") declara ese caso
    //  alcanzable en B-reservas.
    //  (motivo secundario) `idx_invoices_financial_transaction` NO es único,
    //  así que en teoría una misma NC individual podría aparecer dos veces
    //  (la clave de idempotencia determinística lo evita en la práctica --
    //  mismo supuesto que el `ORDER BY ... LIMIT 1` de resolveInvoiceLinkage()).
    // Dedup por `(id, imp_total)`, NO `SUM(DISTINCT imp_total)`: dos NC
    // distintas con el mismo importe SÍ suman las dos.
    //
    // HUECO que ni el DISTINCT ni el filtro de `cbte_tipo` cierran: una NC
    // consolidada que cubre revertidoras de facturas ORIGINALES distintas --
    // para `invoiceId = A` queda una fila con el imp_total COMPLETO de la NC,
    // incluida la porción que compensa a B -> sobre-conteo. Lo cierra la
    // DOCTRINA N2.a del ADR (una NC apunta a exactamente UNA factura -- las 3
    // referencias, ERPNext/Odoo/QloApps, modelan NC<->factura 1:1), no una
    // atribución por `invoice_charges.amount` en esta SQL. El enforcement es un
    // guard (rechazar una NC cuyas revertidoras abarquen >1
    // `reversed_invoice_id`) + una cerca de datos, que van en `buildCreditNote()`
    // extendido o en el orquestador `cancel<X>WithCreditNote()`, NUNCA en los
    // services (F5), y entran con el PRIMER builder que pueda crear una NC
    // consolidada (B-reservas subcaso 2 / el escape). HOY no hay exposición de
    // ESTE hueco: `buildCreditNote()` nunca pasa `charges` a
    // `createWithClient()` -> ningún camino crea una NC consolidada. (La rama 2
    // del UNION ALL NO es "defensiva" a secas: `invoice_charges` sí tiene filas
    // reales, por las Facturas B consolidadas de cuentas por cobrar
    // -- `invoice.service.ts`, `financialTransactionId: null` + charges de
    // `pending`; lo que hoy la salva de F4 es que esos charges apuntan a FTs
    // `CHARGE`, no a revertidoras, y desde 1.4 además el filtro `cbte_tipo` las
    // descarta. Lo defensivo es puntualmente el caso N2.a.) Ver
    // `pendientes-2026-09-06.md` (F4-CONSOL-XFACT-01) y ADR §6.3 / §10.
    const { rows } = await client.query<{ compensated: string }>(
      `SELECT COALESCE(SUM(dedup.imp_total), 0) AS compensated
         FROM (
           SELECT DISTINCT nc.nc_invoice_id, nc.imp_total
             FROM financial_transactions r
             JOIN (
               SELECT id AS nc_invoice_id, financial_transaction_id AS reverting_ft_id, imp_total, status, cbte_tipo
                 FROM invoices
                 WHERE financial_transaction_id IS NOT NULL
               UNION ALL
               SELECT i.id AS nc_invoice_id, ic.financial_transaction_id AS reverting_ft_id, i.imp_total, i.status, i.cbte_tipo
                 FROM invoice_charges ic
                 JOIN invoices i ON i.id = ic.invoice_id
             ) nc ON nc.reverting_ft_id = r.id
            WHERE r.reversed_invoice_id = $1
              AND r.type IN ('REFUND', 'ADJUSTMENT')
              AND nc.status = 'ISSUED'
              AND nc.cbte_tipo = ANY($2::int[])
         ) dedup`,
      [invoiceId, [...CBTE_TIPOS_NOTA_CREDITO]],
    );
    return parseFloat(rows[0]!.compensated);
  }

  async classifyOrderLiveInvoice(
    client: SqlClient,
    orderId: string,
  ): Promise<'RECONCILED' | 'NOT_RECONCILED'> {
    // Ver el docblock de la interfaz para la doctrina completa (ancla al
    // comprobante, conjunción con el ledger, fail-closed, grounding ERP en
    // af2b2b5). Este método consulta `financial_transactions` (tabla de
    // clientes-finanzas) -- ya es práctica establecida en este archivo
    // (getIssuedCreditNoteCompensationTotal, :148/:153/:178/:183/:190).

    // Factura B (`cbte_tipo = 6`) ISSUED ligada a algún CHARGE de la orden,
    // por el camino individual (`invoices.financial_transaction_id`) o el
    // consolidado (`invoice_charges`). Mismo UNION conceptual que
    // `resolveInvoiceLinkage()`.
    const { rows: facturas } = await client.query<{ id: string; imp_total: string }>(
      `SELECT DISTINCT i.id, i.imp_total
         FROM invoices i
         JOIN financial_transactions ft
           ON ft.id = i.financial_transaction_id
           OR ft.id IN (
                SELECT ic.financial_transaction_id FROM invoice_charges ic
                 WHERE ic.invoice_id = i.id
              )
        WHERE ft.order_id = $1
          AND ft.type = 'CHARGE'
          AND i.status = 'ISSUED'
          AND i.cbte_tipo = $2`,
      [orderId, CBTE_TIPO_FACTURA_B],
    );
    // Sin Factura B ISSUED no hay comprobante fiscal vivo que "reconciliar":
    // que `voidByOrderId` haya dado `CARGO_CON_COMPROBANTE_VIVO` en ese caso
    // apunta a un PENDING/FAILED_UNCERTAIN, no a una NC -> fail-closed.
    if (facturas.length === 0) return 'NOT_RECONCILED';

    for (const f of facturas) {
      // (1) FISCAL -- F4, reusado verbatim (isInvoiceFullyCompensatedByIssuedCreditNotes
      //     + getIssuedCreditNoteCompensationTotal, sin SQL de compensación nuevo).
      const compensado = await this.getIssuedCreditNoteCompensationTotal(client, f.id);
      if (!isInvoiceFullyCompensatedByIssuedCreditNotes(parseFloat(f.imp_total), compensado)) {
        return 'NOT_RECONCILED';
      }
      // (2) LEDGER -- conjunción que sólo estrecha: >= 1 fila revertidora y
      //     TODAS `SETTLED`. Un `ADJUSTMENT` `PENDING` (tx2 sin commitear) no
      //     netea el saldo del cliente. `total === 0` cubre además la verdad
      //     vacua del caso `imp_total = 0` (F4 daría `true` con cero NC).
      const { rows: rev } = await client.query<{ total: string; settled: string }>(
        `SELECT COUNT(*)                                  AS total,
                COUNT(*) FILTER (WHERE status = 'SETTLED') AS settled
           FROM financial_transactions
          WHERE reversed_invoice_id = $1
            AND type IN ('REFUND', 'ADJUSTMENT')`,
        [f.id],
      );
      const total = Number(rev[0]!.total);
      const settled = Number(rev[0]!.settled);
      if (total === 0 || total !== settled) return 'NOT_RECONCILED';
    }
    return 'RECONCILED';
  }

  async getChargeIdsForInvoice(invoiceId: string): Promise<string[]> {
    // ADR común cancelar-con-NC §3 N1.a(iii) -- inverso de resolveInvoiceLinkage().
    // UNION (no ALL) de los dos caminos: individual (invoices.financial_transaction_id
    // directo) y consolidado (invoice_charges). Dedup por si un mismo id apareciera
    // en los dos (no debería). Ver el docblock de la interfaz.
    const { rows } = await this.db.query<{ financial_transaction_id: string }>(
      `SELECT financial_transaction_id FROM invoices
        WHERE id = $1 AND financial_transaction_id IS NOT NULL
       UNION
       SELECT financial_transaction_id FROM invoice_charges
        WHERE invoice_id = $1`,
      [invoiceId],
    );
    return rows.map((r) => r.financial_transaction_id);
  }

  async getInvoicedFinancialTransactionIds(financialTransactionIds: string[]): Promise<Set<string>> {
    if (financialTransactionIds.length === 0) return new Set();
    const { rows } = await this.db.query<{ financial_transaction_id: string }>(
      `SELECT ic.financial_transaction_id
       FROM invoice_charges ic
       JOIN invoices i ON i.id = ic.invoice_id
       WHERE i.status = 'ISSUED' AND ic.financial_transaction_id = ANY($1::VARCHAR[])`,
      [financialTransactionIds],
    );
    return new Set(rows.map((r) => r.financial_transaction_id));
  }

  async getByReservationId(reservationId: string): Promise<Invoice[]> {
    const { rows } = await this.db.query<InvoiceRow>(
      `SELECT i.* FROM invoices i
       JOIN financial_transactions ft ON ft.id = i.financial_transaction_id
       WHERE ft.reservation_id = $1
       ORDER BY i.created_at ASC`,
      [reservationId],
    );
    return rows.map(rowToEntity);
  }

  async create(input: CreateInvoiceInput, afipRequest: unknown, items: CreateInvoiceItemInput[]): Promise<Invoice> {
    return this.createWithClient(this.db, input, afipRequest, items);
  }

  async createWithClient(
    client: SqlClient,
    input: CreateInvoiceInput,
    afipRequest: unknown,
    items: CreateInvoiceItemInput[],
    charges?: { financialTransactionId: string; amount: number }[],
  ): Promise<Invoice> {
    const { rows } = await client.query<InvoiceRow>(
      `INSERT INTO invoices
         (id, business_id, financial_transaction_id, customer_id, idempotency_key, environment,
          pto_vta, cbte_tipo, emisor_cuit, concepto, doc_tipo, doc_nro, condicion_iva_receptor_id, moneda,
          imp_neto, imp_iva, imp_total, payment_method, card_installments, status, afip_request)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'PENDING', $20)
       RETURNING *`,
      [
        input.id, input.businessId, input.financialTransactionId, input.customerId,
        input.idempotencyKey, input.environment, input.ptoVta, input.cbteTipo, input.emisorCuit, input.concepto,
        input.docTipo, input.docNro, input.condicionIvaReceptorId, input.moneda,
        input.impNeto, input.impIva, input.impTotal,
        input.paymentMethod ?? null, input.cardInstallments ?? null,
        JSON.stringify(afipRequest),
      ],
    );

    for (const item of items) {
      await client.query(
        `INSERT INTO invoice_items
           (id, invoice_id, order_item_id, reservation_id, description, quantity, unit_price, subtotal, iva_rate, unit, arca_unit_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          randomUUID(), input.id, item.orderItemId, item.reservationId, item.description,
          item.quantity, item.unitPrice, item.subtotal, item.ivaRate, item.unit, item.arcaUnitCode,
        ],
      );
    }

    // C1-Fase C (23/08/2026) -- solo facturas consolidadas pasan `charges`.
    for (const charge of charges ?? []) {
      await client.query(
        `INSERT INTO invoice_charges (id, invoice_id, financial_transaction_id, amount)
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), input.id, charge.financialTransactionId, charge.amount],
      );
    }

    return rowToEntity(rows[0]!);
  }

  async getItemsByInvoiceId(invoiceId: string): Promise<InvoiceItem[]> {
    const { rows } = await this.db.query<{
      id: string;
      invoice_id: string;
      order_item_id: string | null;
      reservation_id: string | null;
      description: string;
      quantity: string;
      unit_price: string;
      subtotal: string;
      iva_rate: string;
      unit: string | null;
      arca_unit_code: number | null;
      created_at: Date;
    }>(
      `SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY created_at ASC`,
      [invoiceId],
    );

    return rows.map((row) => ({
      id: row.id,
      invoiceId: row.invoice_id,
      orderItemId: row.order_item_id,
      reservationId: row.reservation_id,
      description: row.description,
      quantity: parseFloat(row.quantity),
      unitPrice: parseFloat(row.unit_price),
      subtotal: parseFloat(row.subtotal),
      ivaRate: parseFloat(row.iva_rate),
      unit: row.unit,
      arcaUnitCode: row.arca_unit_code,
      createdAt: row.created_at,
    }));
  }

  async markIssued(id: string, data: MarkIssuedInput): Promise<Invoice> {
    const { rows } = await this.db.query<InvoiceRow>(
      `UPDATE invoices
       SET cbte_nro = $2, cae = $3, cae_vto = $4, afip_response = $5,
           status = 'ISSUED', issued_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, data.cbteNro, data.cae, data.caeVto, JSON.stringify(data.afipResponse)],
    );
    if (!rows[0]) throw new Error(`Invoice ${id} no encontrada al marcar ISSUED`);
    return rowToEntity(rows[0]);
  }

  async markFailed(id: string, data: MarkFailedInput): Promise<Invoice> {
    const { rows } = await this.db.query<InvoiceRow>(
      `UPDATE invoices
       SET status = $2, error_message = $3, afip_response = COALESCE($4, afip_response), afip_contacted = $5
       WHERE id = $1
       RETURNING *`,
      [
        id, data.status, data.errorMessage,
        data.afipResponse != null ? JSON.stringify(data.afipResponse) : null,
        data.afipContacted,
      ],
    );
    if (!rows[0]) throw new Error(`Invoice ${id} no encontrada al marcar ${data.status}`);
    return rowToEntity(rows[0]);
  }

  async getStatus(id: string): Promise<InvoiceStatus | null> {
    const { rows } = await this.db.query<{ status: InvoiceStatus }>(
      `SELECT status FROM invoices WHERE id = $1`,
      [id],
    );
    return rows[0]?.status ?? null;
  }
}
