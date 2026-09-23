import { describe, it, expect, vi } from 'vitest';
import { SqlInvoiceRepository } from './sql.invoice.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';
import { CBTE_TIPO_NOTA_CREDITO_B, CBTE_TIPO_FACTURA_B } from './afip-catalog.constants.js';
import type { CreateInvoiceInput } from './invoice.entities.js';

// Regresión: cae_vto es DATE en Postgres -- el driver `pg` lo devuelve como
// objeto Date en runtime, no como string, pese a que el tipo de la fila lo
// declaraba `string`. `InvoicePdfService.generate()` llamaba
// `invoice.caeVto.replace(...)` directo y reventaba en producción
// (TypeError: invoice.caeVto.replace is not a function) porque nunca se
// ejercitó este mapeo contra un valor Date real -- los tests anteriores
// mockeaban filas SQL pasando ya un string.

function mockClient(rows: unknown[]): SqlClient {
  return { query: vi.fn(async () => ({ rows })) as unknown as SqlClient['query'] };
}

describe('SqlInvoiceRepository — mapeo de cae_vto', () => {
  it('convierte un Date de pg a string YYYY-MM-DD', async () => {
    const mockSqlClient = mockClient([
      {
        id: 'inv-1',
        business_id: 'biz-1',
        financial_transaction_id: 'ft-1',
        customer_id: 'cust-1',
        idempotency_key: 'invoice:ft-1',
        environment: 'homologacion',
        pto_vta: 1,
        cbte_tipo: 6,
        cbte_nro: '123',
        concepto: 1,
        doc_tipo: 99,
        doc_nro: '0',
        condicion_iva_receptor_id: 5,
        moneda: 'PES',
        imp_neto: '100.00',
        imp_iva: '0.00',
        imp_total: '100.00',
        cae: '12345678901234',
        // Lo que realmente devuelve `pg` para una columna DATE.
        cae_vto: new Date(Date.UTC(2026, 8, 1)),
        status: 'ISSUED',
        afip_contacted: true,
        emisor_cuit: '20111111112',
        afip_request: {},
        afip_response: {},
        error_message: null,
        created_at: new Date(),
        issued_at: new Date(),
      },
    ]);
    const repo = new SqlInvoiceRepository(mockSqlClient);

    const invoice = await repo.getById('inv-1');

    expect(invoice!.caeVto).toBe('2026-09-01');
    expect(typeof invoice!.caeVto).toBe('string');
  });

  it('deja caeVto en null si la columna vino null', async () => {
    const mockSqlClient = mockClient([
      {
        id: 'inv-2',
        business_id: 'biz-1',
        financial_transaction_id: 'ft-2',
        customer_id: 'cust-1',
        idempotency_key: 'invoice:ft-2',
        environment: 'homologacion',
        pto_vta: 1,
        cbte_tipo: 6,
        cbte_nro: null,
        concepto: 1,
        doc_tipo: 99,
        doc_nro: '0',
        condicion_iva_receptor_id: 5,
        moneda: 'PES',
        imp_neto: '100.00',
        imp_iva: '0.00',
        imp_total: '100.00',
        cae: null,
        cae_vto: null,
        status: 'PENDING',
        afip_contacted: false,
        emisor_cuit: null,
        afip_request: {},
        afip_response: null,
        error_message: null,
        created_at: new Date(),
        issued_at: null,
      },
    ]);
    const repo = new SqlInvoiceRepository(mockSqlClient);

    const invoice = await repo.getById('inv-2');

    expect(invoice!.caeVto).toBeNull();
  });
});

// D8-Nivel B (23/08/2026) -- mismo motivo que cae_vto arriba: DECIMAL/NUMERIC
// vuelve como string desde `pg`, no como number. getItemsByInvoiceId()
// tiene que convertir explícito, no confiar en el tipo declarado de la fila.
describe('SqlInvoiceRepository — getItemsByInvoiceId()', () => {
  it('convierte quantity/unit_price/subtotal/iva_rate de string (pg) a number', async () => {
    const mockSqlClient = mockClient([
      {
        id: 'ii-1', invoice_id: 'inv-1', order_item_id: 'oi-1', reservation_id: null,
        description: 'Coca-Cola 500ml', quantity: '2.00', unit_price: '50.00', subtotal: '100.00',
        iva_rate: '21.00', unit: 'unidad', arca_unit_code: 7, created_at: new Date(),
      },
    ]);
    const repo = new SqlInvoiceRepository(mockSqlClient);

    const items = await repo.getItemsByInvoiceId('inv-1');

    expect(items).toEqual([{
      id: 'ii-1', invoiceId: 'inv-1', orderItemId: 'oi-1', reservationId: null,
      description: 'Coca-Cola 500ml', quantity: 2, unitPrice: 50, subtotal: 100,
      ivaRate: 21, unit: 'unidad', arcaUnitCode: 7, createdAt: items[0]!.createdAt,
    }]);
    expect(typeof items[0]!.quantity).toBe('number');
  });

  it('sin líneas (factura Nivel A), devuelve array vacío', async () => {
    const repo = new SqlInvoiceRepository(mockClient([]));
    expect(await repo.getItemsByInvoiceId('inv-vieja')).toEqual([]);
  });
});

// I4 (23/08/2026, pendientes-2026-08-23.md -- conciliación de pagos,
// verificación de auditoría externa) -- facturas ISSUED con saldo
// pendiente, para el modal de conciliación de "Registrar Pago".
describe('SqlInvoiceRepository — getOutstandingByCustomerId()', () => {
  it('filtra por customer_id, status ISSUED, y solo cargos reales (ft.type = CHARGE, no Notas de Crédito)', async () => {
    const mockSqlClient = mockClient([]);
    const repo = new SqlInvoiceRepository(mockSqlClient);

    await repo.getOutstandingByCustomerId('cust-1');

    const mockQuery = vi.mocked(mockSqlClient.query);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("i.status = 'ISSUED'");
    expect(sql).toContain("ft.type = 'CHARGE'");
    expect(sql).toContain('settled_invoice_id');
    expect(sql).toContain('reversed_invoice_id');
    expect(sql).toContain('outstanding > 0');
    expect(params).toEqual(['cust-1']);
  });

  it('convierte outstanding (string de pg) a number', async () => {
    const mockSqlClient = mockClient([
      {
        id: 'inv-1', business_id: 'biz-1', financial_transaction_id: 'ft-1', customer_id: 'cust-1',
        idempotency_key: 'invoice:ft-1', environment: 'homologacion', pto_vta: 1, cbte_tipo: 6,
        cbte_nro: '5', concepto: 1, doc_tipo: 99, doc_nro: '0', condicion_iva_receptor_id: 5,
        moneda: 'PES', imp_neto: '1000.00', imp_iva: '210.00', imp_total: '1210.00',
        cae: '123', cae_vto: new Date(Date.UTC(2026, 8, 1)), status: 'ISSUED', afip_contacted: true,
        emisor_cuit: null, afip_request: {}, afip_response: {}, error_message: null,
        created_at: new Date(), issued_at: new Date(), outstanding: '710.00',
      },
    ]);
    const repo = new SqlInvoiceRepository(mockSqlClient);

    const result = await repo.getOutstandingByCustomerId('cust-1');

    expect(result[0]!.outstanding).toBe(710);
    expect(typeof result[0]!.outstanding).toBe('number');
  });
});

// ADR común cancelar-con-NC (06/09/2026, N1 / predicado F4) -- mitad SQL.
// La cobertura de comportamiento (una NC ISSUED individual/consolidada suma,
// una PENDING no, una parcial suma su parcial) va contra Postgres real en
// src/tests/integration/credit-note-compensation.integration.test.ts -- acá
// solo la forma de la query y el parseo del NUMERIC, mismo criterio que
// getOutstandingByCustomerId arriba (los fakes son ciegos al SQL).
describe('SqlInvoiceRepository — getIssuedCreditNoteCompensationTotal()', () => {
  it('arma la query: reversed_invoice_id + whitelist de tipo + NC ISSUED + UNION ALL individual/consolidada + cbte_tipo (WHERE externo, las 2 ramas lo seleccionan)', async () => {
    const mockSqlClient = mockClient([{ compensated: '0' }]);
    const repo = new SqlInvoiceRepository(mockSqlClient);

    await repo.getIssuedCreditNoteCompensationTotal(mockSqlClient, 'inv-1');

    const [sql, params] = vi.mocked(mockSqlClient.query).mock.calls[0]!;
    expect(sql).toContain('reversed_invoice_id = $1');
    expect(sql).toContain("r.type IN ('REFUND', 'ADJUSTMENT')");
    expect(sql).toContain("nc.status = 'ISSUED'");
    expect(sql).toContain('UNION ALL');
    expect(sql).toContain('invoice_charges');
    expect(sql).toContain('SELECT DISTINCT');
    expect(sql).toContain('SUM(dedup.imp_total)');
    // NO filtra r.status -- anclado a la NC, no al ledger (Defecto B).
    expect(sql).not.toContain("r.status =");
    // 3-ter (bloque 1.4): el filtro de cbte_tipo va UNA vez, en el WHERE
    // externo (al lado de nc.status), y las DOS ramas del UNION ALL
    // seleccionan la columna. Por la constante, nunca `= 8` literal.
    expect((sql.match(/nc\.cbte_tipo = ANY\(\$2::int\[\]\)/g) ?? []).length).toBe(1);
    const branchCbteTipo = (sql.match(/,\s*(?:i\.)?cbte_tipo\b/g) ?? []).length;
    expect(branchCbteTipo).toBe(2); // seleccionada en rama 1 y rama 2
    expect(sql).not.toContain('cbte_tipo = 8');
    expect(params).toEqual(['inv-1', [CBTE_TIPO_NOTA_CREDITO_B]]);
  });

  it('convierte la suma (string de pg) a number', async () => {
    const mockSqlClient = mockClient([{ compensated: '1210.00' }]);
    const repo = new SqlInvoiceRepository(mockSqlClient);

    const total = await repo.getIssuedCreditNoteCompensationTotal(mockSqlClient, 'inv-1');

    expect(total).toBe(1210);
    expect(typeof total).toBe('number');
  });

  it('devuelve 0 cuando no hay ninguna NC ISSUED (COALESCE)', async () => {
    const mockSqlClient = mockClient([{ compensated: '0' }]);
    const repo = new SqlInvoiceRepository(mockSqlClient);

    expect(await repo.getIssuedCreditNoteCompensationTotal(mockSqlClient, 'inv-1')).toBe(0);
  });
});

// Bloque 2a (23/09/2026, docs/diseno-invoice-retry-reverse-window-guard-
// 2026-09-23.md §3.6, ISSUE-BEFORE-REVERSE-WINDOW-001) -- mismo criterio
// que getIssuedCreditNoteCompensationTotal() arriba: los fakes (FakeInvoiceRepository,
// invoice.service.test.ts) son ciegos al SQL real -- estos tests cubren la
// FORMA de la query (columna en el INSERT/UPDATE, valor sellado o
// limpiado) contra Postgres real es alcance de
// invoice-mark-failed-transactional.integration.test.ts.
describe('SqlInvoiceRepository — pending_since (Bloque 2a)', () => {
  const baseInput: CreateInvoiceInput = {
    id: 'inv-1', businessId: 'biz-1', financialTransactionId: 'ft-1', customerId: 'cust-1',
    idempotencyKey: 'invoice:ft-1', environment: 'homologacion', ptoVta: 1, cbteTipo: CBTE_TIPO_FACTURA_B,
    emisorCuit: '20111111112', concepto: 1, docTipo: 96, docNro: '0', condicionIvaReceptorId: 5,
    moneda: 'PES', impNeto: 100, impIva: 21, impTotal: 121,
  };

  function pendingRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'inv-1', business_id: 'biz-1', financial_transaction_id: 'ft-1', customer_id: 'cust-1',
      idempotency_key: 'invoice:ft-1', environment: 'homologacion', pto_vta: 1, cbte_tipo: CBTE_TIPO_FACTURA_B,
      cbte_nro: null, concepto: 1, doc_tipo: 96, doc_nro: '0', condicion_iva_receptor_id: 5,
      moneda: 'PES', imp_neto: '100.00', imp_iva: '21.00', imp_total: '121.00',
      cae: null, cae_vto: null, status: 'PENDING', afip_contacted: false,
      pending_since: new Date('2026-09-23T00:00:00Z'),
      uncertain_cleared_at: null, uncertain_cleared_by: null, emisor_cuit: '20111111112',
      payment_method: null, card_installments: null, afip_request: {}, afip_response: null,
      error_message: null, created_at: new Date('2026-09-23T00:00:00Z'), issued_at: null,
      ...overrides,
    };
  }

  it('createWithClient() incluye pending_since en el INSERT, sellado con NOW() (nunca un valor de aplicación)', async () => {
    const mockSqlClient = mockClient([pendingRow()]);
    const repo = new SqlInvoiceRepository(mockSqlClient);

    const invoice = await repo.createWithClient(mockSqlClient, baseInput, {}, []);

    const [sql, params] = vi.mocked(mockSqlClient.query).mock.calls[0]!;
    expect(sql).toContain('pending_since');
    // NOW() está en el propio texto SQL, no en la lista de $-params -- así
    // el sello lo pone Postgres, no el reloj del proceso Node.
    expect(sql).toMatch(/status,\s*pending_since,\s*afip_request\)\s*\n?\s*VALUES.*'PENDING',\s*NOW\(\)/);
    expect(params).not.toContain('PENDING'); // 'PENDING' es literal SQL, no bind param
    expect(invoice.pendingSince).toEqual(new Date('2026-09-23T00:00:00Z')); // rowToEntity mapea pending_since
  });

  it('markIssuedWithClient() limpia pending_since = NULL al salir de PENDING', async () => {
    const mockSqlClient = mockClient([pendingRow({
      status: 'ISSUED', pending_since: null, cbte_nro: '5', cae: 'CAE-1',
      cae_vto: new Date('2026-12-31'), issued_at: new Date(),
    })]);
    const repo = new SqlInvoiceRepository(mockSqlClient);

    const invoice = await repo.markIssuedWithClient(mockSqlClient, 'inv-1', {
      cbteNro: 5, cae: 'CAE-1', caeVto: '2026-12-31', afipResponse: {},
    });

    const [sql] = vi.mocked(mockSqlClient.query).mock.calls[0]!;
    expect(sql).toContain('pending_since = NULL');
    expect(invoice.pendingSince).toBeNull();
  });

  it.each(['REJECTED', 'FAILED_UNCERTAIN'] as const)(
    'markFailedWithClient() limpia pending_since = NULL al marcar %s (data.status siempre saca la fila de PENDING)',
    async (status) => {
      const mockSqlClient = mockClient([pendingRow({ status, pending_since: null, afip_contacted: true })]);
      const repo = new SqlInvoiceRepository(mockSqlClient);

      const invoice = await repo.markFailedWithClient(mockSqlClient, 'inv-1', {
        status, errorMessage: 'test', afipContacted: true,
      });

      const [sql] = vi.mocked(mockSqlClient.query).mock.calls[0]!;
      expect(sql).toContain('pending_since = NULL');
      expect(invoice.pendingSince).toBeNull();
    },
  );

  it('getById() mapea pending_since desde la fila cruda (rowToEntity)', async () => {
    const mockSqlClient = mockClient([pendingRow()]);
    const repo = new SqlInvoiceRepository(mockSqlClient);

    const invoice = await repo.getById('inv-1');

    expect(invoice!.pendingSince).toEqual(new Date('2026-09-23T00:00:00Z'));
  });
});

// Bloque 4 (23/09/2026, docs/diseno-invoice-retry-reverse-window-guard-
// 2026-09-23.md §3.3/§4/§6) -- estos tests cubren la FORMA de las dos
// sentencias nuevas (predicado sin SELECT previo comparado por igualdad,
// interval armado por concatenación en vez de un valor de aplicación,
// columnas que limpia el UPDATE) contra un mock -- el comportamiento
// real contra Postgres (re-evaluación del WHERE bajo READ COMMITTED,
// atomicidad con la transición de credit_note_request) es alcance de
// invoice-pending-expiry-worker.integration.test.ts.
describe('SqlInvoiceRepository — getPendingExpiredInvoiceIds()/expirePendingWithClient() (Bloque 4)', () => {
  it('getPendingExpiredInvoiceIds() filtra por status PENDING y pending_since vencido, sin comparar contra un valor de aplicación', async () => {
    const mockSqlClient = mockClient([{ id: 'inv-1' }, { id: 'inv-2' }]);
    const repo = new SqlInvoiceRepository(mockSqlClient);

    const ids = await repo.getPendingExpiredInvoiceIds(600_000);

    const [sql, params] = vi.mocked(mockSqlClient.query).mock.calls[0]!;
    expect(sql).toContain(`status = 'PENDING'`);
    expect(sql).toContain('pending_since < NOW()');
    // El threshold viaja como bind param concatenado a una unidad de
    // interval, nunca un `Date`/timestamp de aplicación comparado por
    // igualdad (hueco #3 de la ronda 1 del gate -- ver docblock de la
    // interfaz).
    expect(sql).toMatch(/\(\$1 \|\| ' milliseconds'\)::interval/);
    expect(params).toEqual([600_000]);
    expect(ids).toEqual(['inv-1', 'inv-2']);
  });

  it('expirePendingWithClient() -- UNA sola sentencia UPDATE, re-evalúa status + pending_since en el WHERE, limpia uncertain_cleared_at', async () => {
    const mockSqlClient = mockClient([{ id: 'inv-1', financial_transaction_id: 'ft-1' }]);
    const repo = new SqlInvoiceRepository(mockSqlClient);

    const result = await repo.expirePendingWithClient(mockSqlClient, 'inv-1', 600_000);

    const [sql, params] = vi.mocked(mockSqlClient.query).mock.calls[0]!;
    expect(sql).toContain(`SET status = 'FAILED_UNCERTAIN', afip_contacted = true, pending_since = NULL`);
    expect(sql).toContain('uncertain_cleared_at = NULL');
    expect(sql).toContain(`WHERE id = $1`);
    expect(sql).toContain(`AND status = 'PENDING'`);
    expect(sql).toMatch(/pending_since < NOW\(\) - \(\$2 \|\| ' milliseconds'\)::interval/);
    expect(sql).toContain('RETURNING id, financial_transaction_id');
    expect(params).toEqual(['inv-1', 600_000]);
    expect(result).toEqual({ id: 'inv-1', financialTransactionId: 'ft-1' });
  });

  it('expirePendingWithClient() -- sin fila (otra transacción ya la tomó, o ya no es candidata) devuelve null, no lanza', async () => {
    const mockSqlClient = mockClient([]);
    const repo = new SqlInvoiceRepository(mockSqlClient);

    const result = await repo.expirePendingWithClient(mockSqlClient, 'inv-ya-tomada', 600_000);

    expect(result).toBeNull();
  });
});
