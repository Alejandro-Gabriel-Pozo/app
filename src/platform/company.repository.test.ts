import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CompanyRepository } from './company.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';

describe('CompanyRepository', () => {
  let mockSqlClient: SqlClient;
  let repo: CompanyRepository;

  beforeEach(() => {
    mockSqlClient = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    repo = new CompanyRepository(mockSqlClient);
  });

  describe('companies', () => {
    it('createCompany inserta y devuelve la Company mapeada', async () => {
      (mockSqlClient.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ id: 'co-1', name: 'Cadena Los Álamos', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' }],
      });

      const company = await repo.createCompany('Cadena Los Álamos');

      const [sql, params] = (mockSqlClient.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(sql).toContain('INSERT INTO companies');
      expect(params[1]).toBe('Cadena Los Álamos');
      expect(company).toMatchObject({ id: 'co-1', name: 'Cadena Los Álamos' });
      expect(company.createdAt).toBeInstanceOf(Date);
    });

    it('findCompanyById devuelve undefined si no existe', async () => {
      (mockSqlClient.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] });

      const company = await repo.findCompanyById('co-inexistente');

      expect(company).toBeUndefined();
    });

    it('findCompanyById mapea la fila cuando existe', async () => {
      (mockSqlClient.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ id: 'co-1', name: 'Cadena Los Álamos', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' }],
      });

      const company = await repo.findCompanyById('co-1');

      expect(company?.id).toBe('co-1');
    });
  });

  describe('company_products', () => {
    it('upsertCompanyProduct hace INSERT ... ON CONFLICT DO UPDATE con el id que elige el caller', async () => {
      (mockSqlClient.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ id: 'prod-1', company_id: 'co-1', name: 'Coca-Cola 500ml', base_price: '350.00', sku: 'COCA500', updated_at: '2026-08-24T00:00:00Z' }],
      });

      const product = await repo.upsertCompanyProduct({ id: 'prod-1', companyId: 'co-1', name: 'Coca-Cola 500ml', basePrice: 350, sku: 'COCA500' });

      const [sql, params] = (mockSqlClient.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(sql).toContain('ON CONFLICT (id) DO UPDATE');
      expect(params[0]).toBe('prod-1'); // id lo eligió el caller, no randomUUID()
      expect(product.basePrice).toBe(350); // Number(), no string
      expect(product.sku).toBe('COCA500');
    });

    it('getCompanyProductsByCompany mapea todas las filas', async () => {
      (mockSqlClient.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [
          { id: 'p1', company_id: 'co-1', name: 'A', base_price: '10', sku: null, updated_at: '2026-08-24T00:00:00Z' },
          { id: 'p2', company_id: 'co-1', name: 'B', base_price: '20', sku: 'SKU-B', updated_at: '2026-08-24T00:00:00Z' },
        ],
      });

      const products = await repo.getCompanyProductsByCompany('co-1');

      expect(products).toHaveLength(2);
      expect(products[0]!.sku).toBeNull();
      expect(products[1]!.sku).toBe('SKU-B');
    });

    it('getCompanyProduct devuelve undefined si no existe', async () => {
      (mockSqlClient.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] });
      expect(await repo.getCompanyProduct('inexistente')).toBeUndefined();
    });
  });

  describe('company_recipe_items', () => {
    it('getCompanyRecipeItems mapea filas a CompanyRecipeItem', async () => {
      (mockSqlClient.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ id: 'ri-1', company_product_id: 'cp-1', component_product_id: 'cp-2', quantity_per_unit: '2.5' }],
      });

      const items = await repo.getCompanyRecipeItems('cp-1');

      expect(items[0]).toMatchObject({ id: 'ri-1', companyProductId: 'cp-1', componentProductId: 'cp-2', quantityPerUnit: 2.5 });
    });

    it('replaceCompanyRecipeItems borra todo y reinserta cada ítem (DELETE + N INSERT, sin transacción explícita)', async () => {
      const queryMock = mockSqlClient.query as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValue({ rows: [] });

      await repo.replaceCompanyRecipeItems('cp-1', [
        { componentProductId: 'comp-1', quantityPerUnit: 1 },
        { componentProductId: 'comp-2', quantityPerUnit: 3 },
      ]);

      expect(queryMock).toHaveBeenCalledTimes(3); // 1 DELETE + 2 INSERT
      expect(queryMock.mock.calls[0]![0]).toContain('DELETE FROM company_recipe_items');
      expect(queryMock.mock.calls[1]![0]).toContain('INSERT INTO company_recipe_items');
      expect(queryMock.mock.calls[1]![1]).toEqual(expect.arrayContaining(['cp-1', 'comp-1', 1]));
      expect(queryMock.mock.calls[2]![1]).toEqual(expect.arrayContaining(['cp-1', 'comp-2', 3]));
    });

    it('replaceCompanyRecipeItems con lista vacía solo borra, no inserta nada', async () => {
      const queryMock = mockSqlClient.query as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValue({ rows: [] });

      await repo.replaceCompanyRecipeItems('cp-1', []);

      expect(queryMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('company_catalog_propagation_queue', () => {
    it('enqueuePropagation encola un aviso por cada sucursal destino, ON CONFLICT DO NOTHING', async () => {
      const queryMock = mockSqlClient.query as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValue({ rows: [] });

      await repo.enqueuePropagation('cp-1', ['biz-a', 'biz-b', 'biz-c']);

      expect(queryMock).toHaveBeenCalledTimes(3);
      for (const call of queryMock.mock.calls) {
        expect(call[0]).toContain('ON CONFLICT DO NOTHING');
      }
    });

    it('getPendingPropagation mapea filas y respeta el limit', async () => {
      (mockSqlClient.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ id: 'q-1', company_product_id: 'cp-1', target_business_id: 'biz-a', created_at: '2026-08-24T00:00:00Z', retry_count: '2' }],
      });

      const pending = await repo.getPendingPropagation(50);

      const [, params] = (mockSqlClient.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(params).toEqual([50]);
      expect(pending[0]).toMatchObject({ id: 'q-1', targetBusinessId: 'biz-a', retryCount: 2 });
    });

    it('markPropagationProcessed hace UPDATE con processed_at = NOW()', async () => {
      const queryMock = mockSqlClient.query as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValue({ rows: [] });

      await repo.markPropagationProcessed('q-1');

      expect(queryMock.mock.calls[0]![0]).toContain('processed_at = NOW()');
      expect(queryMock.mock.calls[0]![1]).toEqual(['q-1']);
    });

    describe('recordPropagationFailure', () => {
      it('devuelve false si el retry_count resultante todavía no llegó a maxRetries', async () => {
        (mockSqlClient.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ retry_count: 2 }] });

        const deadLettered = await repo.recordPropagationFailure('q-1', 'timeout', 5);

        expect(deadLettered).toBe(false);
      });

      it('devuelve true cuando el retry_count llegó a maxRetries (pasa a dead-letter)', async () => {
        (mockSqlClient.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ retry_count: 5 }] });

        const deadLettered = await repo.recordPropagationFailure('q-1', 'timeout', 5);

        expect(deadLettered).toBe(true);
      });

      it('trunca el mensaje de error a 200 caracteres antes de guardarlo', async () => {
        const queryMock = mockSqlClient.query as ReturnType<typeof vi.fn>;
        queryMock.mockResolvedValueOnce({ rows: [{ retry_count: 1 }] });
        const longError = 'x'.repeat(500);

        await repo.recordPropagationFailure('q-1', longError, 5);

        const params = queryMock.mock.calls[0]![1] as unknown[];
        expect((params[1] as string).length).toBe(200);
      });
    });
  });
});
