import { describe, it, expect, vi } from 'vitest';
import { SqlInvoiceRepository } from './sql.invoice.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';

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
