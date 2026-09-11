import type { SqlClient } from '../repositories/sql.client.js';
import type { Invoice, CreateInvoiceInput, InvoiceStatus, AfipEnvironment, InvoiceItem, CreateInvoiceItemInput, UnreconciledLiveInvoice } from './invoice.entities.js';
import { INVOICE_STATUSES_CONSUMING_CHARGE } from './invoice.entities.js';
import type { InvoiceRepository, MarkIssuedInput, MarkFailedInput, InvoiceLinkage } from './invoice.repository.js';
import type { PaymentMethod } from '../clientes-finanzas/financial-transaction.repository.js';
import { isInvoiceFullyCompensatedByIssuedCreditNotes, isReservationPortionFullyCompensatedByIssuedCreditNotes } from './cancel-with-credit-note.js';
import { CBTE_TIPO_FACTURA_B, CBTE_TIPOS_NOTA_CREDITO } from './afip-catalog.constants.js';
import { resolveRefundableForPair, type ResolveRefundableForPairResult, type FrozenInvoiceItemShare, type FrozenIvaEntry } from './refund-attribution.js';
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

/**
 * Fragmento compartido entre `getIssuedCreditNoteCompensationTotal()` (F4) y
 * `getInFlightCreditNoteTotalForUpdate()` (N5, bloque 2.4) -- las dos cuentan
 * "qué Notas de Crédito apuntan a la factura `reversed_invoice_id = $1`", y
 * solo difieren en QUÉ `nc.status` cuenta como compensación. Extraído
 * (08/09/2026, gate bloque 2.4, C5) para que dejen de ser dos copias a mano
 * del mismo `UNION ALL` -- antes de esto, F4 llevaba un aviso de que
 * mantenerlas alineadas era manual; ahora el SQL en sí las ata.
 *
 * **Sigue habiendo un TERCER camino que se mantiene alineado a mano, no por
 * typecheck:** `resolveInvoiceLinkage()` (arriba en este archivo) tiene el
 * mismo UNION de "individual vs. consolidada" pero con columnas y predicado
 * DISTINTOS (`id, status, afip_contacted`, sin filtrar por `cbte_tipo` --
 * quiere CUALQUIER comprobante ligado, no solo NC), así que no comparte este
 * fragmento literal. Si `resolveInvoiceLinkage()` suma un tercer camino
 * (además de individual/consolidada), este fragmento también necesita esa
 * rama.
 */
const NC_LINKAGE_UNION = `
  SELECT id AS nc_invoice_id, financial_transaction_id AS reverting_ft_id, imp_total, status, cbte_tipo
    FROM invoices
    WHERE financial_transaction_id IS NOT NULL
  UNION ALL
  SELECT i.id AS nc_invoice_id, ic.financial_transaction_id AS reverting_ft_id, i.imp_total, i.status, i.cbte_tipo
    FROM invoice_charges ic
    JOIN invoices i ON i.id = ic.invoice_id
`;

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
    // (`financial_transaction_id IS NULL` a propósito, ver schema.sql --
    // `ALTER TABLE invoices ALTER COLUMN financial_transaction_id DROP NOT NULL`,
    // cita por nombre desde SCHEMA-ANCHOR-DRIFT-001, 10/09/2026) --
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
    // schema.sql -- `ALTER TABLE invoices ALTER COLUMN financial_transaction_id
    // DROP NOT NULL`, cita por nombre desde SCHEMA-ANCHOR-DRIFT-001,
    // 10/09/2026) del listado -- una factura consolidada cobrada quedaba
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

  async getByStatus(status: InvoiceStatus): Promise<Invoice[]> {
    const { rows } = await this.db.query<InvoiceRow>(
      `SELECT * FROM invoices WHERE status = $1 ORDER BY created_at ASC`,
      [status],
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
             JOIN (${NC_LINKAGE_UNION}) nc ON nc.reverting_ft_id = r.id
            WHERE r.reversed_invoice_id = $1
              AND r.type IN ('REFUND', 'ADJUSTMENT')
              AND nc.status = 'ISSUED'
              AND nc.cbte_tipo = ANY($2::int[])
         ) dedup`,
      [invoiceId, [...CBTE_TIPOS_NOTA_CREDITO]],
    );
    return parseFloat(rows[0]!.compensated);
  }

  /**
   * 3.3-d residual 1 (11/09/2026, docs/diseno-33d-residuales-2026-09-11.md
   * §1.2) -- numerador de F4-por-par: BRUTO (imp_total, no subtotal/neto por
   * línea) de las NC `ISSUED` cuyas `invoice_items` cubren la reserva `R`.
   *
   * Reusa `NC_LINKAGE_UNION` (mismo criterio que `getIssuedCreditNoteCompensationTotal`
   * de arriba -- NO un cuarto UNION individual/consolidada copiado a mano) y
   * el mismo dedup por FILA `(nc_invoice_id, imp_total)`, no por valor
   * (`SUM(DISTINCT imp_total)` colapsaría dos NC distintas del mismo
   * importe). Mantiene `nc.cbte_tipo = ANY($3)` -- sin este filtro, cualquier
   * comprobante ligado a la FT revertidora sumaría su `imp_total`, fail-open
   * (mismo riesgo documentado en F4 arriba).
   *
   * **Por qué sumar el `imp_total` COMPLETO de la NC alcanza, sin prorratear
   * por línea:** es una propiedad de las 3 ramas de
   * `InvoiceService.buildCreditNote()` (invoice.service.ts), NO del schema --
   * documentado en el docblock de `isReservationPortionFullyCompensatedByIssuedCreditNotes()`
   * y en §1.6 del diseño. La rama por par es 1:1 con la reserva; la rama de
   * reversión total cubre la factura ENTERA (más que la porción de R, nunca
   * menos -- sobre-compensación, no sub-compensación); la rama proporcional
   * legacy emite una sola línea por transacción revertidora. Ninguna de las
   * 3 reparte una NC PARCIAL entre múltiples reservas -- si una cuarta rama
   * lo hiciera, este numerador quedaría fail-open sin que nada lo detecte.
   */
  private async getIssuedCreditNoteCompensationTotalForReservation(
    client: SqlClient,
    invoiceId: string,
    reservationId: string,
  ): Promise<number> {
    const { rows } = await client.query<{ compensated: string }>(
      `SELECT COALESCE(SUM(dedup.imp_total), 0) AS compensated
         FROM (
           SELECT DISTINCT nc.nc_invoice_id, nc.imp_total
             FROM financial_transactions r
             JOIN (${NC_LINKAGE_UNION}) nc ON nc.reverting_ft_id = r.id
             JOIN invoice_items ii ON ii.invoice_id = nc.nc_invoice_id AND ii.reservation_id = $2
            WHERE r.reversed_invoice_id = $1
              AND r.type IN ('REFUND', 'ADJUSTMENT')
              AND nc.status = 'ISSUED'
              AND nc.cbte_tipo = ANY($3::int[])
         ) dedup`,
      [invoiceId, reservationId, [...CBTE_TIPOS_NOTA_CREDITO]],
    );
    return parseFloat(rows[0]!.compensated);
  }

  /**
   * 3.3-d residual 1, §1.7 -- resuelve la atribución (factura, reserva) para
   * el clasificador, con `client` explícito (DEFENSIVE_DEVELOPING §3,
   * diseño §1.8 -- NUNCA `getItemsByInvoiceId()`/`getById()`, que usan
   * `this.db`, no el `client` de la transacción/tenant en curso).
   *
   * Devuelve `BLOCKED` para facturas Nivel A (sin `invoice_items`, la
   * mayoría de las facturas reales de al menos una tenant -- ver
   * `refund-attribution.ts:46-48`) y para cualquier otra anomalía que
   * `resolveRefundableForPair()` ya sabe detectar -- el caller (`classifyReservationLiveInvoice`)
   * hace fail-back a F4-por-factura-entera en ese caso, sin re-implementar
   * la detección de anomalías acá.
   */
  private async resolveReservationPairAttribution(
    client: SqlClient,
    invoiceId: string,
    reservationId: string,
  ): Promise<ResolveRefundableForPairResult> {
    const { rows: itemRows } = await client.query<{
      reservation_id: string | null; subtotal: string; iva_rate: string;
    }>(
      `SELECT reservation_id, subtotal, iva_rate FROM invoice_items WHERE invoice_id = $1`,
      [invoiceId],
    );
    const items: FrozenInvoiceItemShare[] = itemRows.map((row) => ({
      reservationId: row.reservation_id,
      subtotal: parseFloat(row.subtotal),
      ivaRate: parseFloat(row.iva_rate),
    }));

    const { rows: invoiceRows } = await client.query<{ afip_request: unknown }>(
      `SELECT afip_request FROM invoices WHERE id = $1`,
      [invoiceId],
    );
    const frozenIva: FrozenIvaEntry[] = (
      (invoiceRows[0]?.afip_request as { Iva?: Array<{ Id: number; BaseImp: number; Importe: number }> } | null)?.Iva ?? []
    ).map((e) => ({ id: e.Id, baseImp: e.BaseImp, importe: e.Importe }));

    // `alreadyRefunded: 0` -- el clasificador solo usa `attributedTotal`, no
    // `refundable` (que restaría lo ya reembolsado). No es un valor real de
    // "nada reembolsado todavía", es simplemente el campo que esta llamada
    // no necesita.
    return resolveRefundableForPair({ items, frozenIva, alreadyRefunded: 0, reservationId });
  }

  async getInFlightCreditNoteTotalForUpdate(client: SqlClient, invoiceId: string): Promise<number> {
    // Bloque 2.4 (tope N5, `docs/pendientes-2026-09-08.md` #21, gate
    // `architecture-governor` 08/09/2026) -- a diferencia de
    // `getIssuedCreditNoteCompensationTotal()` (F4, solo `ISSUED`, doctrina
    // "el predicado se ancla al comprobante EMITIDO, nunca al ledger"), acá
    // la pregunta es otra: F4 pregunta "¿puedo cancelar normalmente?"
    // (fail-closed = exigir NC `ISSUED`); N5 pregunta "¿queda cupo para
    // emitir OTRA NC?" (fail-closed = contar TODO lo en vuelo, incluso lo
    // que todavía no se resolvió con AFIP). Por eso este método cuenta
    // `ISSUED` + `PENDING` + `FAILED_UNCERTAIN` -- NO invierte la doctrina
    // F4, son predicados de preguntas distintas sobre la misma tabla.
    //
    // `REJECTED` queda afuera a propósito: AFIP confirmó que el comprobante
    // no existe, no consume cupo real.
    // **Bypass declarado, NO cerrado en este bloque (condición C1 del gate
    // 08/09/2026):** `retryExisting()` (`invoice.service.ts:897-915`) puede
    // re-emitir una fila `REJECTED` SIN volver a pasar por
    // `buildCreditNote()` -- así que sin este chequeo de cap. Hoy es
    // INALCANZABLE (un solo escritor por factura, mismo argumento que cerró
    // `pendientes-2026-09-08.md` #21 originalmente). **Corrección
    // (08/09/2026, gate del bloque 3.1): el bloque 3.1 NO lo vuelve
    // alcanzable** -- su fail-closed (`ReservationOnConsolidatedInvoiceError`
    // en `cancellation-refund.service.ts`) reduce, no amplía, el conjunto de
    // escrituras de `reversed_invoice_id`: corta ANTES de que se cree
    // ningún `REFUND` contra una factura consolidada. Este C1 sigue
    // dependiendo de que exista un segundo escritor real por factura, que
    // recién entraría con el "subcaso 2" (reparto real por-reserva de una
    // consolidada), bloque posterior de B-reservas -- no con 3.1. Cerrarlo
    // bien (¿el re-chequeo de `retryExisting()` excluye su propia fila, o
    // hace falta otro mecanismo?) es una decisión de diseño aparte,
    // registrada en `pendientes-2026-09-08.md`, gate propio.
    //
    // Consumidores PERMANENTES reales del cap (corrección C2 del gate --
    // la redacción anterior de este comentario en el ADR/plan estaba mal:
    // decía que una NC `PENDING` "rechazada por AFIP" consumía cupo para
    // siempre, pero una NC rechazada PASA a `REJECTED` y este filtro la
    // excluye -- no consume nada):
    //  1. `FAILED_UNCERTAIN` con `afip_contacted = true` -- `retryExisting()`
    //     la devuelve tal cual (`:899`), nunca se resuelve sola.
    //  2. `PENDING` colgada por muerte del proceso entre el COMMIT de la fila
    //     y la respuesta de AFIP.
    // `FAILED_UNCERTAIN` con `afip_contacted = false` SÍ se reintenta
    // automáticamente y termina resolviéndose -- no es un consumidor
    // permanente. Mismo TTL/huérfanos ya registrado como deuda aceptada en
    // `pendientes-2026-09-08.md` (gate bloque 2.2) -- este bloque no lo
    // agrava ni lo resuelve, antes no había cap en absoluto.
    //
    // **Nota C3 (gate 08/09/2026):** `getByIdempotencyKey()` en
    // `requestInvoice()` NO toma lock -- dos llamadas concurrentes con el
    // MISMO `financialTransactionId` pueden llegar las dos hasta acá en una
    // reversión total. La que pierde el lock ve `inFlight` ya incluyendo la
    // NC que la ganadora insertó y este método hace que se lea como "tope
    // excedido" -- cuando en realidad es un duplicado de idempotencia (choca
    // aparte contra `idx_invoices_idempotency_key`, único). El mensaje del
    // error nuevo puede describir mal ese caso puntual; no se corrige acá
    // (mover el chequeo de idempotencia adentro de la transacción es otro
    // bloque) -- ver test dedicado.
    //
    // Reusa `NC_LINKAGE_UNION` (mismo fragmento que F4, extraído en este
    // bloque -- C5 del gate) y el mismo patrón de DOS sentencias que
    // `getRefundableForUpdate()`/`getOutstandingForUpdate()`: lock puro
    // primero (sin subconsultas, nada que quede con foto vieja al esperar),
    // cómputo después en sentencia nueva.
    await client.query(`SELECT 1 FROM invoices WHERE id = $1 FOR UPDATE`, [invoiceId]);

    const { rows } = await client.query<{ in_flight: string }>(
      `SELECT COALESCE(SUM(dedup.imp_total), 0) AS in_flight
         FROM (
           SELECT DISTINCT nc.nc_invoice_id, nc.imp_total
             FROM financial_transactions r
             JOIN (${NC_LINKAGE_UNION}) nc ON nc.reverting_ft_id = r.id
            WHERE r.reversed_invoice_id = $1
              AND r.type IN ('REFUND', 'ADJUSTMENT')
              AND nc.status = ANY($2::text[])
              AND nc.cbte_tipo = ANY($3::int[])
         ) dedup`,
      [invoiceId, [...INVOICE_STATUSES_CONSUMING_CHARGE], [...CBTE_TIPOS_NOTA_CREDITO]],
    );
    return parseFloat(rows[0]!.in_flight);
  }

  async getInFlightCreditNoteTotalForPairForUpdate(client: SqlClient, invoiceId: string, reservationId: string): Promise<number> {
    // Bloque 3.3-a (08/09/2026, gate `architecture-governor`) -- mismo
    // predicado que getInFlightCreditNoteTotalForUpdate(), con
    // `r.reservation_id = $2` sumado: `r` es la transacción REVERTIDORA
    // (REFUND/ADJUSTMENT), no la factura -- filtra por qué reserva generó
    // cada NC/porción en vuelo contra `invoiceId`, no por qué reserva
    // aparece en las líneas de la factura.
    //
    // Corrección del gate (08/09/2026): el nombre `...ForUpdate` tiene que
    // ser verdad por sí solo -- la versión anterior de este método confiaba
    // en que `buildCreditNote()` ya hubiera tomado el lock vía
    // `getInFlightCreditNoteTotalForUpdate()` antes de llamar acá, sin que
    // nada en la firma lo exigiera. Un método público de `InvoiceRepository`
    // cuyo nombre promete un `FOR UPDATE` que no ejecuta es exactamente el
    // modo de falla que este ADR viene repitiendo (la contención depende de
    // algo que nadie mantiene sincronizado). Tomar el lock acá también es
    // prácticamente gratis: sobre una fila que la MISMA transacción ya tiene
    // lockeada, Postgres no espera nada -- misma conexión, sin costo de pool.
    await client.query(`SELECT 1 FROM invoices WHERE id = $1 FOR UPDATE`, [invoiceId]);

    const { rows } = await client.query<{ in_flight: string }>(
      `SELECT COALESCE(SUM(dedup.imp_total), 0) AS in_flight
         FROM (
           SELECT DISTINCT nc.nc_invoice_id, nc.imp_total
             FROM financial_transactions r
             JOIN (${NC_LINKAGE_UNION}) nc ON nc.reverting_ft_id = r.id
            WHERE r.reversed_invoice_id = $1
              AND r.reservation_id = $2
              AND r.type IN ('REFUND', 'ADJUSTMENT')
              AND nc.status = ANY($3::text[])
              AND nc.cbte_tipo = ANY($4::int[])
         ) dedup`,
      [invoiceId, reservationId, [...INVOICE_STATUSES_CONSUMING_CHARGE], [...CBTE_TIPOS_NOTA_CREDITO]],
    );
    return parseFloat(rows[0]!.in_flight);
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

  async classifyReservationLiveInvoice(
    client: SqlClient,
    reservationId: string,
  ): Promise<'RECONCILED' | 'NOT_RECONCILED'> {
    // Bloque 3.3-d (09/09/2026, gate `architecture-governor`) -- espejo de
    // classifyOrderLiveInvoice() de arriba. Ver el docblock de la interfaz
    // para las divergencias frente a órdenes.
    //
    // 3.3-d residual 1 (11/09/2026, docs/diseno-33d-residuales-2026-09-11.md)
    // -- las divergencias 1 y 2 originales (F4 por factura ENTERA, ledger de
    // alcance FACTURA) se resuelven acá clasificando por PAR (esta factura,
    // esta reserva) cuando se puede -- `resolveReservationPairAttribution()`
    // devuelve `RESOLVED` para eso. Cuando NO se puede (facturas Nivel A sin
    // `invoice_items` -- la MAYORÍA de las facturas reales de al menos una
    // tenant, ver `refund-attribution.ts:46-48` -- o cualquier otra anomalía
    // que `resolveRefundableForPair()` ya sabe detectar, `BLOCKED`), fail-back
    // a F4-por-factura-entera + ledger sin scope, BYTE A BYTE el
    // comportamiento de antes de este bloque -- las dos mitades (fiscal y
    // ledger) siguen la MISMA rama siempre, nunca una mezcla de las dos
    // (eso fue exactamente cómo nació la divergencia 2 original -- preguntar
    // por sujetos distintos en cada mitad).

    // Factura B (`cbte_tipo = 6`) ISSUED ligada a algún CHARGE de la
    // reserva, por el camino individual (`invoices.financial_transaction_id`)
    // o el consolidado (`invoice_charges`). Mismo UNION conceptual que
    // `resolveInvoiceLinkage()`/`classifyOrderLiveInvoice()`, filtrado por
    // `ft.reservation_id` en vez de `ft.order_id`.
    const { rows: facturas } = await client.query<{ id: string; imp_total: string }>(
      `SELECT DISTINCT i.id, i.imp_total
         FROM invoices i
         JOIN financial_transactions ft
           ON ft.id = i.financial_transaction_id
           OR ft.id IN (
                SELECT ic.financial_transaction_id FROM invoice_charges ic
                 WHERE ic.invoice_id = i.id
              )
        WHERE ft.reservation_id = $1
          AND ft.type = 'CHARGE'
          AND i.status = 'ISSUED'
          AND i.cbte_tipo = $2`,
      [reservationId, CBTE_TIPO_FACTURA_B],
    );
    // Sin Factura B ISSUED no hay comprobante fiscal vivo que "reconciliar":
    // que `voidByReservationId` haya dado `CARGO_CON_COMPROBANTE_VIVO` en ese
    // caso apunta a un PENDING/FAILED_UNCERTAIN, no a una NC -> fail-closed.
    if (facturas.length === 0) return 'NOT_RECONCILED';

    for (const f of facturas) {
      const pair = await this.resolveReservationPairAttribution(client, f.id, reservationId);

      if (pair.kind === 'RESOLVED') {
        // (1) FISCAL -- por PAR: la porción de ESTA reserva vs. las NC ISSUED
        //     que la cubren específicamente (invoice_items.reservation_id).
        const compensadoPorReserva = await this.getIssuedCreditNoteCompensationTotalForReservation(client, f.id, reservationId);
        if (!isReservationPortionFullyCompensatedByIssuedCreditNotes(pair.attributedTotal, compensadoPorReserva)) {
          return 'NOT_RECONCILED';
        }
        // (2) LEDGER -- scoped a esta reserva, misma rama que (1).
        const { rows: rev } = await client.query<{ total: string; settled: string }>(
          `SELECT COUNT(*)                                  AS total,
                  COUNT(*) FILTER (WHERE status = 'SETTLED') AS settled
             FROM financial_transactions
            WHERE reversed_invoice_id = $1
              AND reservation_id = $2
              AND type IN ('REFUND', 'ADJUSTMENT')`,
          [f.id, reservationId],
        );
        const total = Number(rev[0]!.total);
        const settled = Number(rev[0]!.settled);
        if (total === 0 || total !== settled) return 'NOT_RECONCILED';
      } else {
        // Fail-back declarado (§1.7 del diseño) -- Nivel A / anomalía: F4 por
        // factura entera, tal cual el comportamiento de antes de este bloque.
        const compensado = await this.getIssuedCreditNoteCompensationTotal(client, f.id);
        if (!isInvoiceFullyCompensatedByIssuedCreditNotes(parseFloat(f.imp_total), compensado)) {
          return 'NOT_RECONCILED';
        }
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
    }
    return 'RECONCILED';
  }

  async listUnreconciledLiveInvoices(client: SqlClient): Promise<UnreconciledLiveInvoice[]> {
    // Paso 1 -- candidatos. Mismo JOIN que classifyOrderLiveInvoice()/
    // classifyReservationLiveInvoice() (factura individual O consolidada,
    // Factura B ISSUED), pero DESDE la entidad (para poder filtrar por su
    // estado) en vez de desde la factura. B2 no necesita ese join -- la
    // entidad sale directo de financial_transactions.
    //
    // Falso negativo conocido, aceptado, no oculto (C1, gate 10/09/2026):
    // las dos ramas B2 de abajo filtran `reservation_id IS NOT NULL` /
    // `order_id IS NOT NULL` cada una. Una fila revertidora con
    // `reversed_invoice_id` seteado pero AMBOS ids en NULL no entraría por
    // ninguna rama y se descartaría en silencio -- justo lo que esta
    // bandeja existe para no hacer. Hoy es inalcanzable: todo camino que
    // crea una reversión (`cancellation-refund.service.ts:317-332`, los
    // dos escapes con NC) siempre setea uno de los dos ids, y no hay CHECK
    // de schema que lo impida estructuralmente -- ver docblock de
    // `UnreconciledLiveInvoice` en `invoice.entities.ts`.
    const { rows: candidateRows } = await client.query<{ entity_type: 'ORDER' | 'RESERVATION'; entity_id: string }>(
      `SELECT DISTINCT 'ORDER'::text AS entity_type, o.id AS entity_id
         FROM orders o
         JOIN financial_transactions ft ON ft.order_id = o.id AND ft.type = 'CHARGE'
         JOIN invoices i
           ON i.financial_transaction_id = ft.id
           OR i.id IN (SELECT ic.invoice_id FROM invoice_charges ic WHERE ic.financial_transaction_id = ft.id)
        WHERE o.status = 'CANCELLED' AND i.status = 'ISSUED' AND i.cbte_tipo = $1
       UNION
       SELECT DISTINCT 'RESERVATION'::text, r.id
         FROM reservations r
         JOIN financial_transactions ft ON ft.reservation_id = r.id AND ft.type = 'CHARGE'
         JOIN invoices i
           ON i.financial_transaction_id = ft.id
           OR i.id IN (SELECT ic.invoice_id FROM invoice_charges ic WHERE ic.financial_transaction_id = ft.id)
        WHERE r.status IN ('CANCELLED', 'EXPIRED') AND i.status = 'ISSUED' AND i.cbte_tipo = $1
       UNION
       SELECT DISTINCT 'RESERVATION'::text, ft.reservation_id
         FROM financial_transactions ft
        WHERE ft.reversed_invoice_id IS NOT NULL AND ft.type IN ('REFUND', 'ADJUSTMENT') AND ft.reservation_id IS NOT NULL
       UNION
       SELECT DISTINCT 'ORDER'::text, ft.order_id
         FROM financial_transactions ft
        WHERE ft.reversed_invoice_id IS NOT NULL AND ft.type IN ('REFUND', 'ADJUSTMENT') AND ft.order_id IS NOT NULL`,
      [CBTE_TIPO_FACTURA_B],
    );

    const results: UnreconciledLiveInvoice[] = [];

    for (const candidate of candidateRows) {
      // Paso 2 -- clasifica. Única fuente de verdad de "¿está conciliado?",
      // reusada tal cual -- cero SQL de compensación nuevo acá.
      const status = candidate.entity_type === 'ORDER'
        ? await this.classifyOrderLiveInvoice(client, candidate.entity_id)
        : await this.classifyReservationLiveInvoice(client, candidate.entity_id);
      if (status !== 'NOT_RECONCILED') continue;

      const { rows: entityRows } = await client.query<{ status: string }>(
        candidate.entity_type === 'ORDER'
          ? `SELECT status FROM orders WHERE id = $1`
          : `SELECT status FROM reservations WHERE id = $1`,
        [candidate.entity_id],
      );
      const entityStatus = entityRows[0]?.status ?? 'DESCONOCIDO';
      // Espeja el filtro de estado del paso 1 (B1) -- un candidato puede
      // haber entrado SOLO por B2 (ej. reserva CONFIRMED con una
      // reversión abierta, tx2 sin cancelar la entidad todavía). Sin este
      // chequeo, cualquier candidato con una factura B ISSUED emitiría un
      // motivo `TERMINAL_CON_COMPROBANTE_VIVO` aunque la entidad no sea terminal
      // -- falso, y duplicado con la fila real de B2.
      const isTerminal = candidate.entity_type === 'ORDER'
        ? entityStatus === 'CANCELLED'
        : entityStatus === 'CANCELLED' || entityStatus === 'EXPIRED';

      // B1 -- facturas vivas de esta entidad (mismo join que el paso 1),
      // solo si la entidad de verdad es terminal.
      const liveInvoices = isTerminal ? (await client.query<{
        id: string; pto_vta: number; cbte_nro: string | null; imp_total: string; issued_at: Date | null;
      }>(
        candidate.entity_type === 'ORDER'
          ? `SELECT DISTINCT i.id, i.pto_vta, i.cbte_nro, i.imp_total, i.issued_at
               FROM invoices i
               JOIN financial_transactions ft
                 ON ft.id = i.financial_transaction_id
                 OR ft.id IN (SELECT ic.financial_transaction_id FROM invoice_charges ic WHERE ic.invoice_id = i.id)
              WHERE ft.order_id = $1 AND ft.type = 'CHARGE' AND i.status = 'ISSUED' AND i.cbte_tipo = $2`
          : `SELECT DISTINCT i.id, i.pto_vta, i.cbte_nro, i.imp_total, i.issued_at
               FROM invoices i
               JOIN financial_transactions ft
                 ON ft.id = i.financial_transaction_id
                 OR ft.id IN (SELECT ic.financial_transaction_id FROM invoice_charges ic WHERE ic.invoice_id = i.id)
              WHERE ft.reservation_id = $1 AND ft.type = 'CHARGE' AND i.status = 'ISSUED' AND i.cbte_tipo = $2`,
        [candidate.entity_id, CBTE_TIPO_FACTURA_B],
      )).rows : [];
      for (const inv of liveInvoices) {
        results.push({
          entityType: candidate.entity_type,
          entityId: candidate.entity_id,
          entityStatus,
          invoiceId: inv.id,
          ptoVta: inv.pto_vta,
          cbteNro: inv.cbte_nro === null ? null : Number(inv.cbte_nro),
          impTotal: parseFloat(inv.imp_total),
          issuedAt: inv.issued_at,
          motivo: 'TERMINAL_CON_COMPROBANTE_VIVO',
          sinceAt: inv.issued_at ?? new Date(0),
          revertingTransactionId: null,
          revertingType: null,
          revertingStatus: null,
          ncInvoiceId: null,
          ncStatus: null,
          ncAfipContacted: null,
        });
      }

      // B2 -- reversiones abiertas de esta entidad, con su NC (si la tiene).
      const { rows: reversals } = await client.query<{
        id: string; type: 'REFUND' | 'ADJUSTMENT'; status: string; created_at: Date;
        reversed_invoice_id: string;
      }>(
        candidate.entity_type === 'ORDER'
          ? `SELECT id, type, status, created_at, reversed_invoice_id
               FROM financial_transactions
              WHERE order_id = $1 AND reversed_invoice_id IS NOT NULL AND type IN ('REFUND', 'ADJUSTMENT')`
          : `SELECT id, type, status, created_at, reversed_invoice_id
               FROM financial_transactions
              WHERE reservation_id = $1 AND reversed_invoice_id IS NOT NULL AND type IN ('REFUND', 'ADJUSTMENT')`,
        [candidate.entity_id],
      );
      for (const rev of reversals) {
        const { rows: ncRows } = await client.query<{ id: string; pto_vta: number; cbte_nro: string | null; imp_total: string; status: InvoiceStatus; afip_contacted: boolean }>(
          `SELECT id, pto_vta, cbte_nro, imp_total, status, afip_contacted FROM invoices WHERE financial_transaction_id = $1`,
          [rev.id],
        );
        const nc = ncRows[0];
        // La factura original revertida -- para pto_vta/cbte_nro/imp_total
        // de la fila (el REFUND/ADJUSTMENT en sí no factura nada, revierte
        // lo que ya facturó `reversed_invoice_id`).
        const { rows: originalRows } = await client.query<{ id: string; pto_vta: number; cbte_nro: string | null; imp_total: string; issued_at: Date | null }>(
          `SELECT id, pto_vta, cbte_nro, imp_total, issued_at FROM invoices WHERE id = $1`,
          [rev.reversed_invoice_id],
        );
        const original = originalRows[0];
        if (!original) continue; // defensivo -- reversed_invoice_id es FK, no debería faltar
        results.push({
          entityType: candidate.entity_type,
          entityId: candidate.entity_id,
          entityStatus,
          invoiceId: original.id,
          ptoVta: original.pto_vta,
          cbteNro: original.cbte_nro === null ? null : Number(original.cbte_nro),
          impTotal: parseFloat(original.imp_total),
          issuedAt: original.issued_at,
          motivo: 'REVERSION_ABIERTA',
          sinceAt: rev.created_at,
          revertingTransactionId: rev.id,
          revertingType: rev.type,
          revertingStatus: rev.status,
          ncInvoiceId: nc?.id ?? null,
          ncStatus: nc?.status ?? null,
          ncAfipContacted: nc?.afip_contacted ?? null,
        });
      }
    }

    // Ordenado por antigüedad -- el más viejo primero, mismo criterio que
    // getByStatus() (ordenamiento por antigüedad para una bandeja operativa).
    results.sort((a, b) => a.sinceAt.getTime() - b.sinceAt.getTime());
    return results;
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
    // Predicado corregido 11/09/2026, 2 rondas -- ver el docblock de la
    // interfaz (invoice.repository.ts) para la doctrina completa: por qué
    // la rama invoice_charges NO filtra por status (índice único de
    // respaldo) y la rama invoices SÍ (sin índice, REJECTED no bloquea
    // para siempre) -- asimetría a propósito, no armonizar.
    if (financialTransactionIds.length === 0) return new Set();
    const { rows } = await this.db.query<{ financial_transaction_id: string }>(
      `SELECT financial_transaction_id FROM invoice_charges
        WHERE financial_transaction_id = ANY($1::VARCHAR[])
       UNION
       SELECT financial_transaction_id FROM invoices
        WHERE financial_transaction_id = ANY($1::VARCHAR[])
          AND status = ANY($2::text[])`,
      [financialTransactionIds, [...INVOICE_STATUSES_CONSUMING_CHARGE]],
    );
    return new Set(rows.map((r) => r.financial_transaction_id));
  }

  async getFinancialTransactionIdsCoveredByConsolidated(financialTransactionIds: string[]): Promise<Set<string>> {
    // Ver el docblock de la interfaz (invoice.repository.ts) -- CON JOIN y
    // CON filtro de status a propósito, a diferencia de la rama
    // invoice_charges de getInvoicedFinancialTransactionIds() (esa es
    // status-agnóstica porque responde otra pregunta, forzada por el
    // índice único). Acá el criterio es "¿requestInvoice() rechazaría
    // esto?" -- mismo predicado que ese guard, INVOICE_STATUSES_CONSUMING_CHARGE.
    if (financialTransactionIds.length === 0) return new Set();
    const { rows } = await this.db.query<{ financial_transaction_id: string }>(
      `SELECT ic.financial_transaction_id
       FROM invoice_charges ic
       JOIN invoices i ON i.id = ic.invoice_id
       WHERE ic.financial_transaction_id = ANY($1::VARCHAR[])
         AND i.status = ANY($2::text[])`,
      [financialTransactionIds, [...INVOICE_STATUSES_CONSUMING_CHARGE]],
    );
    return new Set(rows.map((r) => r.financial_transaction_id));
  }

  async getConsolidatedInvoiceIdsForFinancialTransactions(financialTransactionIds: string[]): Promise<Map<string, string>> {
    // Método hermano de getFinancialTransactionIdsCoveredByConsolidated()
    // -- mismo WHERE, mismo filtro INVOICE_STATUSES_CONSUMING_CHARGE, pero
    // suma i.id al SELECT para devolver el invoiceId en vez de solo el
    // booleano de cobertura (ver docblock de la interfaz).
    if (financialTransactionIds.length === 0) return new Map();
    const { rows } = await this.db.query<{ financial_transaction_id: string; invoice_id: string }>(
      `SELECT ic.financial_transaction_id, i.id AS invoice_id
       FROM invoice_charges ic
       JOIN invoices i ON i.id = ic.invoice_id
       WHERE ic.financial_transaction_id = ANY($1::VARCHAR[])
         AND i.status = ANY($2::text[])`,
      [financialTransactionIds, [...INVOICE_STATUSES_CONSUMING_CHARGE]],
    );
    return new Map(rows.map((r) => [r.financial_transaction_id, r.invoice_id]));
  }

  async getByReservationId(reservationId: string): Promise<Invoice[]> {
    // Bloque 3.1 (ADR común cancelar-con-NC §6.1, `docs/pendientes-2026-09-08.md`
    // #5a, gate `architecture-governor` 08/09/2026) -- antes esto era un
    // INNER JOIN ciego a las consolidadas (`financial_transaction_id IS NULL`
    // a propósito, el vínculo vive en `invoice_charges`). Ahora UNION de los
    // dos caminos, mismo espíritu que `resolveInvoiceLinkage()`/`NC_LINKAGE_UNION`
    // pero NO literalmente el mismo fragmento -- acá se filtra por
    // `reservation_id`, no por un `financial_transaction_id` puntual, así que
    // la rama consolidada necesita el join extra a `financial_transactions`
    // vía `invoice_charges.financial_transaction_id` para llegar a la reserva.
    //
    // `i.*` en las DOS ramas (no una lista de columnas a mano como
    // `NC_LINKAGE_UNION`) -- ventaja estructural: una columna nueva en
    // `invoices` entra en las dos ramas a la vez, no puede desalinearse el
    // conteo entre ellas (el modo de falla que el bloque 1.4 sí tuvo que
    // corregir a mano). Lo que SIGUE siendo frágil y hay que declarar: el
    // día que `invoices` sume una columna sin operador de igualdad (`json` a
    // secas, `point`), este UNION revienta en runtime ("could not identify
    // an equality operator") sin que ningún typecheck avise -- verificado
    // hoy contra schema.sql que todas las columnas actuales son UNION-safe
    // (JSONB sí tiene operador de igualdad; `json` a secas NO).
    //
    // `UNION` (dedup), NUNCA `UNION ALL`: `idx_invoice_charges_ft`
    // (schema.sql) es único por `financial_transaction_id`, NO por
    // `(invoice_id, financial_transaction_id)` -- una reserva con N `CHARGE`
    // distintos facturados en la MISMA consolidada (la forma normal de un
    // ciclo de facturación, no un caso raro) produce N filas en la rama
    // consolidada, todas para la MISMA factura. Sin dedup, `confirmRefund()`
    // vería esa factura N veces en el pool LIFO. Cubierto por
    // `credit-note-cap.integration.test.ts`-style test dedicado (C2 del
    // gate) -- ver `getByReservationId() -- UNION` en el archivo de
    // integración de reservas.
    const { rows } = await this.db.query<InvoiceRow>(
      `SELECT * FROM (
         SELECT i.* FROM invoices i
         JOIN financial_transactions ft ON ft.id = i.financial_transaction_id
         WHERE ft.reservation_id = $1
         UNION
         SELECT i.* FROM invoice_charges ic
         JOIN invoices i ON i.id = ic.invoice_id
         JOIN financial_transactions ft ON ft.id = ic.financial_transaction_id
         WHERE ft.reservation_id = $1
       ) linked
       ORDER BY created_at ASC`,
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
