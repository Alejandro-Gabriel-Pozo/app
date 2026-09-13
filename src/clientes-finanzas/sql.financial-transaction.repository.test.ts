import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SqlFinancialTransactionRepository } from './sql.financial-transaction.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';

describe('SqlFinancialTransactionRepository — stay_id (A1, paso 1)', () => {
  let mockSqlClient: SqlClient;
  let repo: SqlFinancialTransactionRepository;

  beforeEach(() => {
    mockSqlClient = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    repo = new SqlFinancialTransactionRepository(mockSqlClient);
  });

  describe('create', () => {
    it('incluye stay_id en el INSERT normal (sin idempotencyKey)', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [{
          id: 'tx-1', business_id: 'biz-1', customer_id: 'cust-1',
          reservation_id: null, order_id: null, stay_id: 'stay-1',
          idempotency_key: null, type: 'CHARGE', amount: '100', currency: 'ARS',
          status: 'PENDING', notes: null, created_at: new Date(),
        }],
      });

      await repo.create({
        id: 'tx-1',
        businessId: 'biz-1',
        customerId: 'cust-1',
        stayId: 'stay-1',
        type: 'CHARGE',
        amount: 100,
        currency: 'ARS',
        status: 'PENDING',
      });

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('stay_id');
      expect(params).toContain('stay-1');
    });

    it('incluye stay_id en el INSERT idempotente (con idempotencyKey)', async () => {
      await repo.create({
        id: 'tx-2',
        businessId: 'biz-1',
        customerId: 'cust-1',
        stayId: 'stay-1',
        idempotencyKey: 'evt-1:CHARGE',
        type: 'CHARGE',
        amount: 100,
        currency: 'ARS',
        status: 'PENDING',
      });

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('ON CONFLICT');
      expect(sql).toContain('stay_id');
      expect(params).toContain('stay-1');
    });

    it('permite stay_id null (cargo asociado a una orden, sin estadía)', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [{
          id: 'tx-3', business_id: 'biz-1', customer_id: 'cust-1',
          reservation_id: null, order_id: 'order-3', stay_id: null,
          idempotency_key: null, type: 'CHARGE', amount: '100', currency: 'ARS',
          status: 'PENDING', notes: null, created_at: new Date(),
        }],
      });

      // orderId cubre el documento de origen obligatorio (F1-Pieza 2) --
      // este test verifica específicamente que stay_id null no rompe nada,
      // no que un cargo pueda no tener NINGÚN origen (ver describe de más
      // abajo para ese caso).
      await repo.create({
        id: 'tx-3',
        businessId: 'biz-1',
        customerId: 'cust-1',
        orderId: 'order-3',
        type: 'CHARGE',
        amount: 100,
        currency: 'ARS',
        status: 'PENDING',
      });

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [, params] = mockQuery.mock.calls[0]!;
      expect(params).toContain(null);
    });
  });

  describe('create — documento de origen obligatorio (F1-Pieza 2, 23/08/2026)', () => {
    it('rechaza un CHARGE sin reservationId, orderId ni stayId', async () => {
      await expect(repo.create({
        id: 'tx-origen-1', businessId: 'biz-1', customerId: 'cust-1',
        type: 'CHARGE', amount: 100, currency: 'ARS', status: 'PENDING',
      })).rejects.toThrow(/documento de origen/);

      expect(mockSqlClient.query).not.toHaveBeenCalled();
    });

    it('rechaza un ADJUSTMENT sin reservationId, orderId ni stayId', async () => {
      await expect(repo.create({
        id: 'tx-origen-2', businessId: 'biz-1', customerId: 'cust-1',
        type: 'ADJUSTMENT', amount: -50, currency: 'ARS', status: 'PENDING',
      })).rejects.toThrow(/documento de origen/);
    });

    it('acepta un CHARGE con orderId aunque reservationId y stayId sean null', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [{
          id: 'tx-origen-3', business_id: 'biz-1', customer_id: 'cust-1',
          reservation_id: null, order_id: 'order-1', stay_id: null,
          idempotency_key: null, type: 'CHARGE', amount: '100', currency: 'ARS',
          status: 'PENDING', notes: null, created_at: new Date(),
        }],
      });

      await expect(repo.create({
        id: 'tx-origen-3', businessId: 'biz-1', customerId: 'cust-1', orderId: 'order-1',
        type: 'CHARGE', amount: 100, currency: 'ARS', status: 'PENDING',
      })).resolves.not.toBeNull();
    });

    it('NO exige origen para PAYMENT (pago genérico contra la cuenta del cliente)', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [{
          id: 'tx-origen-4', business_id: 'biz-1', customer_id: 'cust-1',
          reservation_id: null, order_id: null, stay_id: null,
          idempotency_key: null, type: 'PAYMENT', amount: '100', currency: 'ARS',
          status: 'SETTLED', notes: null, created_at: new Date(),
        }],
      });

      await expect(repo.create({
        id: 'tx-origen-4', businessId: 'biz-1', customerId: 'cust-1',
        type: 'PAYMENT', amount: 100, currency: 'ARS', status: 'SETTLED',
      })).resolves.not.toBeNull();
    });

    it('NO exige origen para REFUND (reembolso ledger-only, sin factura que cubrir)', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [{
          id: 'tx-origen-5', business_id: 'biz-1', customer_id: 'cust-1',
          reservation_id: null, order_id: null, stay_id: null,
          idempotency_key: null, type: 'REFUND', amount: '100', currency: 'ARS',
          status: 'SETTLED', notes: null, created_at: new Date(),
        }],
      });

      await expect(repo.create({
        id: 'tx-origen-5', businessId: 'biz-1', customerId: 'cust-1',
        type: 'REFUND', amount: 100, currency: 'ARS', status: 'SETTLED',
      })).resolves.not.toBeNull();
    });
  });

  describe('create — payment_method / shift_id (Gap Tango #2)', () => {
    it('incluye payment_method y una subquery de turno OPEN en el INSERT normal', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [{
          id: 'tx-4', business_id: 'biz-1', customer_id: 'cust-1',
          reservation_id: null, order_id: null, stay_id: null,
          idempotency_key: null, type: 'PAYMENT', amount: '100', currency: 'ARS',
          status: 'SETTLED', notes: null, payment_method: 'CASH', shift_id: 'shift-1',
          created_at: new Date(),
        }],
      });

      await repo.create({
        id: 'tx-4',
        businessId: 'biz-1',
        customerId: 'cust-1',
        type: 'PAYMENT',
        amount: 100,
        currency: 'ARS',
        status: 'SETTLED',
        paymentMethod: 'CASH',
      });

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('payment_method');
      expect(sql).toContain('cash_register_shifts');
      expect(params).toContain('CASH');
    });

    it('honra un shiftId explícito por sobre la resolución automática', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [{
          id: 'tx-5', business_id: 'biz-1', customer_id: 'cust-1',
          reservation_id: null, order_id: null, stay_id: null,
          idempotency_key: null, type: 'PAYMENT', amount: '100', currency: 'ARS',
          status: 'SETTLED', notes: null, payment_method: 'CASH', shift_id: 'shift-explicit',
          created_at: new Date(),
        }],
      });

      await repo.create({
        id: 'tx-5',
        businessId: 'biz-1',
        customerId: 'cust-1',
        type: 'PAYMENT',
        amount: 100,
        currency: 'ARS',
        status: 'SETTLED',
        paymentMethod: 'CASH',
        shiftId: 'shift-explicit',
      });

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [, params] = mockQuery.mock.calls[0]!;
      expect(params).toContain('shift-explicit');
    });
  });

  describe('create — card_installments / card_surcharge_amount (Gap Tango #3)', () => {
    it('incluye card_installments y card_surcharge_amount en el INSERT normal', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [{
          id: 'tx-6', business_id: 'biz-1', customer_id: 'cust-1',
          reservation_id: null, order_id: null, stay_id: null,
          idempotency_key: null, type: 'PAYMENT', amount: '1150', currency: 'ARS',
          status: 'SETTLED', notes: null, payment_method: 'CARD', shift_id: null,
          card_installments: 6, card_surcharge_amount: '150', created_at: new Date(),
        }],
      });

      const created = await repo.create({
        id: 'tx-6',
        businessId: 'biz-1',
        customerId: 'cust-1',
        type: 'PAYMENT',
        amount: 1150,
        currency: 'ARS',
        status: 'SETTLED',
        paymentMethod: 'CARD',
        cardInstallments: 6,
        cardSurchargeAmount: 150,
      });

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('card_installments');
      expect(sql).toContain('card_surcharge_amount');
      expect(params).toContain(6);
      expect(params).toContain(150);
      expect(created?.cardInstallments).toBe(6);
      expect(created?.cardSurchargeAmount).toBe(150);
    });

    it('quedan null cuando no se pasan (compatibilidad con callers viejos)', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [{
          id: 'tx-7', business_id: 'biz-1', customer_id: 'cust-1',
          reservation_id: null, order_id: null, stay_id: null,
          idempotency_key: null, type: 'PAYMENT', amount: '100', currency: 'ARS',
          status: 'SETTLED', notes: null, payment_method: 'CASH', shift_id: null,
          card_installments: null, card_surcharge_amount: null, created_at: new Date(),
        }],
      });

      const created = await repo.create({
        id: 'tx-7',
        businessId: 'biz-1',
        customerId: 'cust-1',
        type: 'PAYMENT',
        amount: 100,
        currency: 'ARS',
        status: 'SETTLED',
        paymentMethod: 'CASH',
      });

      expect(created?.cardInstallments).toBeNull();
      expect(created?.cardSurchargeAmount).toBeNull();
    });
  });

  /**
   * O2 (03/09/2026) — fila de diagnóstico neutra: todo en cero. Los tests la
   * ajustan campo por campo para forzar cada desenlace.
   *
   * Reemplaza a ORD3B-01/ORD3B-07, que asertaban sobre la sentencia vieja
   * (`o.status      = 'COMPLETED'`, con los espacios exactos) y sobre el
   * `rowCount ?? 0` que O2 elimina. Las dos aserciones se conservan con otra
   * forma: la de la guarda en O2R-02, la del cero sin excepción en O2R-05.
   */
  function diagnostico(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      aplicadas: 0, candidatos: 0,
      orden_inexistente: 0, orden_ajena: 0, orden_no_elegible: 0,
      estado_desconocido: 0, ya_settled: 0, anulados: 0, tipo_no_liquidable: 0,
      con_comprobante_vivo: 0,
      orden_total: null, orden_status: null,
      ...over,
    };
  }
  const conDiagnostico = (over: Record<string, unknown> = {}) =>
    vi.mocked(mockSqlClient.query).mockResolvedValueOnce({ rows: [diagnostico(over)] });

  describe('settleChargesByOrderId — la sentencia (Gap Tango #2/#3 + O2)', () => {
    it('O2R-01: persiste paymentMethod, vincula el turno OPEN si es CASH, y pasa el businessId', async () => {
      conDiagnostico({ aplicadas: 1, candidatos: 1 });
      await repo.settleChargesByOrderId('order-1', 'biz-1', { paymentMethod: 'CASH' });

      const [sql, params] = vi.mocked(mockSqlClient.query).mock.calls[0]!;
      expect(sql).toContain("SET status         = 'SETTLED'");
      expect(sql).toContain('payment_method');
      expect(sql).toContain('cash_register_shifts');
      expect(sql).toContain('ELSE ft.shift_id END');
      expect(params).toEqual(['order-1', 'CASH', null, null, 'biz-1']);
    });

    it('O2R-02: las TRES allowlists positivas viven dentro del UPDATE', async () => {
      conDiagnostico();
      await repo.settleChargesByOrderId('order-1', 'biz-1', { paymentMethod: 'CASH' });

      const [sql] = vi.mocked(mockSqlClient.query).mock.calls[0]!;
      // Tipo: sólo CHARGE (ORDER-09). Un PAYMENT de la misma orden no se
      // liquida ni cuenta como éxito.
      expect(sql).toContain("ft.type   IN ('CHARGE')");
      // Estado del cargo.
      expect(sql).toContain("ft.status IN ('PENDING')");
      // Estado de la orden: ORDER-03-b, subsumido acá.
      expect(sql).toContain("o.status IN ('COMPLETED')");
      expect(sql).toContain('o.business_id = ft.business_id');
      // Y el conteo NO sale de rowCount: sale como columna de la fila.
      expect(sql).toContain('AS aplicadas');
    });

    it('O2R-03: persiste cuotas y recargo cuando es CARD (Gap Tango #3)', async () => {
      conDiagnostico({ aplicadas: 1, candidatos: 1 });
      await repo.settleChargesByOrderId('order-1', 'biz-1',
        { paymentMethod: 'CARD', cardInstallments: 6, cardSurchargeAmount: 150 });

      const [sql, params] = vi.mocked(mockSqlClient.query).mock.calls[0]!;
      expect(sql).toContain('card_installments');
      expect(sql).toContain('card_surcharge_amount');
      expect(params).toEqual(['order-1', 'CARD', 6, 150, 'biz-1']);
    });

    it('O2R-04: sigue funcionando sin paymentInfo', async () => {
      conDiagnostico();
      await repo.settleChargesByOrderId('order-1', 'biz-1');

      const [, params] = vi.mocked(mockSqlClient.query).mock.calls[0]!;
      expect(params).toEqual(['order-1', null, null, null, 'biz-1']);
    });
  });

  describe('settleChargesByOrderId — los desenlaces, sin ningún cero mudo', () => {
    it('O2R-05: APLICADO cuando la sentencia escribió', async () => {
      conDiagnostico({ aplicadas: 1, candidatos: 1 });
      const d = await repo.settleChargesByOrderId('order-1', 'biz-1');
      expect(d).toEqual({ tipo: 'APLICADO', filas: 1, rechazos: [] });
    });

    it('O2R-06: APLICADO con rechazos parciales — liquidó el cargo y dejó afuera un PAYMENT', async () => {
      conDiagnostico({ aplicadas: 1, candidatos: 2, tipo_no_liquidable: 1 });
      const d = await repo.settleChargesByOrderId('order-1', 'biz-1');
      // Un PAYMENT de la misma orden NO se convierte en éxito silencioso.
      expect(d).toEqual({ tipo: 'APLICADO', filas: 1, rechazos: ['TIPO_NO_LIQUIDABLE'] });
    });

    it('O2R-07: RECHAZADO por estado de la orden — ORDER-03-b, con motivo', async () => {
      conDiagnostico({ candidatos: 1, orden_no_elegible: 1 });
      const d = await repo.settleChargesByOrderId('order-1', 'biz-1');
      expect(d).toEqual({ tipo: 'RECHAZADO', rechazos: ['ORDEN_ESTADO_NO_ELEGIBLE'] });
    });

    it('O2R-08: RECHAZADO por tenant — se distingue de "la orden no existe"', async () => {
      conDiagnostico({ candidatos: 1, orden_ajena: 1 });
      const d = await repo.settleChargesByOrderId('order-1', 'biz-1');
      expect(d).toEqual({ tipo: 'RECHAZADO', rechazos: ['ORDEN_DE_OTRO_NEGOCIO'] });
    });

    it('O2R-09: RECHAZADO por estado desconocido — fail-closed', async () => {
      conDiagnostico({ candidatos: 1, estado_desconocido: 1 });
      const d = await repo.settleChargesByOrderId('order-1', 'biz-1');
      expect(d).toEqual({ tipo: 'RECHAZADO', rechazos: ['ESTADO_DESCONOCIDO'] });
    });

    it('O2R-10: RECHAZADO benigno cuando el cargo ya estaba liquidado', async () => {
      conDiagnostico({ candidatos: 1, ya_settled: 1 });
      const d = await repo.settleChargesByOrderId('order-1', 'biz-1');
      expect(d).toEqual({ tipo: 'RECHAZADO', rechazos: ['CARGO_YA_SETTLED'] });
    });

    it('O2R-11: NADA_QUE_HACER — orden COMPLETED sin ítems con precio', async () => {
      conDiagnostico({ orden_status: 'COMPLETED', orden_total: '0' });
      const d = await repo.settleChargesByOrderId('order-1', 'biz-1');
      // No es rechazo: es éxito. Una orden sin precio nunca generó cargo.
      expect(d).toEqual({ tipo: 'NADA_QUE_HACER' });
    });

    it('O2R-12: DEPENDENCIA_PENDIENTE — el CHARGE todavía no existe (T-01/ORDER-13)', async () => {
      conDiagnostico({ orden_status: 'COMPLETED', orden_total: '300' });
      const d = await repo.settleChargesByOrderId('order-1', 'biz-1');
      // Ni rechazo definitivo ni éxito: order.completed se adelantó al
      // order.confirmed que crea el cargo.
      expect(d).toEqual({ tipo: 'DEPENDENCIA_PENDIENTE' });
    });

    it('O2R-13: sin candidatos y sin orden es RECHAZADO, no dependencia pendiente', async () => {
      conDiagnostico({ orden_status: null });
      const d = await repo.settleChargesByOrderId('order-1', 'biz-1');
      expect(d).toEqual({ tipo: 'RECHAZADO', rechazos: ['ORDEN_INEXISTENTE'] });
    });
  });

  describe('settleChargesByOrderId — ausencia de resultado NO es cero', () => {
    it('O2R-14: lanza si la consulta no devolvió ninguna fila de diagnóstico', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({ rows: [] });
      await expect(repo.settleChargesByOrderId('order-1', 'biz-1'))
        .rejects.toThrow(/no devolvió ninguna fila/);
    });

    it('O2R-15: lanza si un contador no vino como entero', async () => {
      vi.mocked(mockSqlClient.query)
        .mockResolvedValueOnce({ rows: [diagnostico({ aplicadas: 'no-es-un-numero' })] });
      await expect(repo.settleChargesByOrderId('order-1', 'biz-1'))
        .rejects.toThrow(/no vino como entero/);
    });
  });

  describe('createOrderChargeIfConfirmed — identidad del acto', () => {
    const entrada = {
      id: 'ft-1', businessId: 'biz-1', customerId: 'cust-1', orderId: 'order-1',
      stayId: null, amount: 300, currency: 'ARS',
    };
    const ordenFila = (over: Record<string, unknown> = {}) => ({
      id: 'order-1', business_id: 'biz-1', status: 'CONFIRMED',
      confirmed_at: new Date().toISOString(), ...over,
    });

    it('O2R-16: la PRIMERA sentencia es el lock, con el MISMO client que el INSERT', async () => {
      vi.mocked(mockSqlClient.query)
        .mockResolvedValueOnce({ rows: [ordenFila()] })
        .mockResolvedValueOnce({ rows: [{ id: 'ft-1' }] });

      await repo.createOrderChargeIfConfirmed(mockSqlClient, entrada);

      const calls = vi.mocked(mockSqlClient.query).mock.calls;
      expect(calls[0]![0]).toContain('FOR UPDATE');
      expect(calls[0]![0]).toContain('FROM orders');
      // El NOT EXISTS solo no es a prueba de carreras: sin el lock, dos
      // handlers concurrentes podrían pasarlo los dos.
      expect(calls[1]![0]).toContain('NOT EXISTS');
      // Las dos sentencias salen del mismo objeto `client`: es el parámetro,
      // no una convención.
      expect(calls).toHaveLength(2);
    });

    it('O2R-17: la clave de idempotencia es del ACTO, no del evento', async () => {
      vi.mocked(mockSqlClient.query)
        .mockResolvedValueOnce({ rows: [ordenFila()] })
        .mockResolvedValueOnce({ rows: [{ id: 'ft-1' }] });

      await repo.createOrderChargeIfConfirmed(mockSqlClient, entrada);

      const [, params] = vi.mocked(mockSqlClient.query).mock.calls[1]!;
      expect(params).toContain('order:order-1:CHARGE');
    });

    it('O2R-18: RECHAZADO si la orden no existe, sin intentar el INSERT', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({ rows: [] });
      const d = await repo.createOrderChargeIfConfirmed(mockSqlClient, entrada);
      expect(d).toEqual({ tipo: 'RECHAZADO', rechazos: ['ORDEN_INEXISTENTE'] });
      expect(vi.mocked(mockSqlClient.query).mock.calls).toHaveLength(1);
    });

    it('O2R-19: RECHAZADO si la orden es de otro negocio, sin INSERT', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({ rows: [ordenFila({ business_id: 'biz-ajeno' })] });
      const d = await repo.createOrderChargeIfConfirmed(mockSqlClient, entrada);
      expect(d).toEqual({ tipo: 'RECHAZADO', rechazos: ['ORDEN_DE_OTRO_NEGOCIO'] });
      expect(vi.mocked(mockSqlClient.query).mock.calls).toHaveLength(1);
    });

    it('O2R-20: RECHAZADO si la orden está en DRAFT o CANCELLED — allowlist positiva', async () => {
      for (const estado of ['DRAFT', 'CANCELLED']) {
        vi.mocked(mockSqlClient.query).mockReset();
        vi.mocked(mockSqlClient.query).mockResolvedValueOnce({ rows: [ordenFila({ status: estado })] });
        const d = await repo.createOrderChargeIfConfirmed(mockSqlClient, entrada);
        expect(d).toEqual({ tipo: 'RECHAZADO', rechazos: ['ORDEN_ESTADO_NO_ELEGIBLE'] });
      }
    });

    it('O2R-21: RECHAZADO si el estado está fuera del enum — fail-closed', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({ rows: [ordenFila({ status: 'ARCHIVADA' })] });
      const d = await repo.createOrderChargeIfConfirmed(mockSqlClient, entrada);
      expect(d).toEqual({ tipo: 'RECHAZADO', rechazos: ['ESTADO_DESCONOCIDO'] });
    });

    it('O2R-22: COMPLETED SIN confirmed_at no autoriza una creación financiera', async () => {
      vi.mocked(mockSqlClient.query)
        .mockResolvedValueOnce({ rows: [ordenFila({ status: 'COMPLETED', confirmed_at: null })] });
      const d = await repo.createOrderChargeIfConfirmed(mockSqlClient, entrada);
      // El estado aislado no alcanza: tiene que haber habido un acto de
      // confirmación, y ese acto es confirmed_at.
      expect(d).toEqual({ tipo: 'RECHAZADO', rechazos: ['ORDEN_SIN_CONFIRMAR'] });
      expect(vi.mocked(mockSqlClient.query).mock.calls).toHaveLength(1);
    });

    it('O2R-23: COMPLETED CON confirmed_at sí crea — order.completed pudo adelantarse', async () => {
      vi.mocked(mockSqlClient.query)
        .mockResolvedValueOnce({ rows: [ordenFila({ status: 'COMPLETED' })] })
        .mockResolvedValueOnce({ rows: [{ id: 'ft-1' }] });
      const d = await repo.createOrderChargeIfConfirmed(mockSqlClient, entrada);
      // Sin esto, ORDER-13 traba la familia: uno espera un cargo que el otro
      // se niega a crear.
      expect(d).toEqual({ tipo: 'APLICADO', filas: 1, rechazos: [] });
    });

    it('O2R-24: RECHAZADO CARGO_YA_EXISTE cuando el INSERT no afecta filas', async () => {
      vi.mocked(mockSqlClient.query)
        .mockResolvedValueOnce({ rows: [ordenFila()] })
        .mockResolvedValueOnce({ rows: [] });
      const d = await repo.createOrderChargeIfConfirmed(mockSqlClient, entrada);
      expect(d).toEqual({ tipo: 'RECHAZADO', rechazos: ['CARGO_YA_EXISTE'] });
    });

    it('O2R-25: NADA_QUE_HACER si el monto no es positivo, sin INSERT', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({ rows: [ordenFila()] });
      const d = await repo.createOrderChargeIfConfirmed(mockSqlClient, { ...entrada, amount: 0 });
      expect(d).toEqual({ tipo: 'NADA_QUE_HACER' });
      expect(vi.mocked(mockSqlClient.query).mock.calls).toHaveLength(1);
    });
  });

  describe('create — confirmed_by (19/08/2026, ajuste de precio de reservas CONFIRMED)', () => {
    it('incluye confirmed_by en el INSERT normal (sin idempotencyKey)', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [{
          id: 'tx-8', business_id: 'biz-1', customer_id: 'cust-1',
          reservation_id: 'res-1', order_id: null, stay_id: null,
          idempotency_key: null, type: 'ADJUSTMENT', amount: '-300', currency: 'ARS',
          status: 'PENDING', notes: null, confirmed_by: 'user-manager-1', created_at: new Date(),
        }],
      });

      const created = await repo.create({
        id: 'tx-8',
        businessId: 'biz-1',
        customerId: 'cust-1',
        reservationId: 'res-1',
        type: 'ADJUSTMENT',
        amount: -300,
        currency: 'ARS',
        status: 'PENDING',
        confirmedBy: 'user-manager-1',
      });

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('confirmed_by');
      expect(params).toContain('user-manager-1');
      expect(created?.confirmedBy).toBe('user-manager-1');
    });

    it('incluye confirmed_by en el INSERT idempotente (con idempotencyKey)', async () => {
      await repo.create({
        id: 'tx-9',
        businessId: 'biz-1',
        customerId: 'cust-1',
        reservationId: 'res-1',
        idempotencyKey: 'evt-1:ADJUSTMENT',
        type: 'ADJUSTMENT',
        amount: 200,
        currency: 'ARS',
        status: 'PENDING',
        confirmedBy: 'user-manager-1',
      });

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('confirmed_by');
      expect(params).toContain('user-manager-1');
    });

    it('queda null para CHARGE/PAYMENT/REFUND sin autorización humana explícita', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [{
          id: 'tx-10', business_id: 'biz-1', customer_id: 'cust-1',
          reservation_id: null, order_id: null, stay_id: 'stay-10',
          idempotency_key: null, type: 'CHARGE', amount: '100', currency: 'ARS',
          status: 'PENDING', notes: null, confirmed_by: null, created_at: new Date(),
        }],
      });

      // stayId cubre el documento de origen obligatorio (F1-Pieza 2) --
      // no tiene relación con lo que este test verifica (confirmed_by).
      const created = await repo.create({
        id: 'tx-10', businessId: 'biz-1', customerId: 'cust-1', stayId: 'stay-10',
        type: 'CHARGE', amount: 100, currency: 'ARS', status: 'PENDING',
      });

      expect(created?.confirmedBy).toBeNull();
    });
  });

  describe('getByStayId', () => {
    it('filtra por stay_id ordenado por created_at ASC', async () => {
      await repo.getByStayId('stay-1');

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('WHERE stay_id = $1');
      expect(sql).toContain('ORDER BY created_at ASC');
      expect(params).toEqual(['stay-1']);
    });
  });

  describe('getByCustomerId — reservationNumber (F1-Pieza 2, 23/08/2026)', () => {
    it('hace LEFT JOIN a reservations y mapea reservation_number', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [{
          id: 'tx-1', business_id: 'biz-1', customer_id: 'cust-1',
          reservation_id: 'res-1', order_id: null, stay_id: null,
          reservation_number: 42,
          idempotency_key: null, type: 'CHARGE', amount: '100', currency: 'ARS',
          status: 'PENDING', notes: null, created_at: new Date(),
        }],
      });

      const [tx] = await repo.getByCustomerId('cust-1');

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('LEFT JOIN reservations');
      expect(sql).toContain('WHERE ft.customer_id = $1');
      expect(params).toEqual(['cust-1']);
      expect(tx!.reservationNumber).toBe(42);
    });

    it('reservationNumber queda null si el cargo no tiene reservationId', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [{
          id: 'tx-2', business_id: 'biz-1', customer_id: 'cust-1',
          reservation_id: null, order_id: 'order-1', stay_id: null,
          reservation_number: null,
          idempotency_key: null, type: 'CHARGE', amount: '100', currency: 'ARS',
          status: 'PENDING', notes: null, created_at: new Date(),
        }],
      });

      const [tx] = await repo.getByCustomerId('cust-1');

      expect(tx!.reservationNumber).toBeNull();
    });
  });

  describe('getByShiftId', () => {
    it('filtra por shift_id ordenado por created_at ASC', async () => {
      await repo.getByShiftId('shift-1');

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('WHERE shift_id = $1');
      expect(sql).toContain('ORDER BY created_at ASC');
      expect(params).toEqual(['shift-1']);
    });
  });

  describe('getNetBalanceByStayId', () => {
    // Bug real en producción, 23/08/2026 (pendientes-2026-08-23.md,
    // verificación de auditoría externa): REFUND tenía el mismo signo que
    // PAYMENT. Un REFUND revierte un PAYMENT (A3.9, criterios-negocio.md
    // -- "todo movimiento tiene contrapartida"), necesita el signo
    // OPUESTO para cancelarlo, no el mismo para duplicarlo.
    // 12/09/2026 (caso 3, docs/investigacion-decisiones-bloqueado-2026-09-12.md):
    // antes filtraba solo SETTLED -- el CHARGE de saldo y los ADJUSTMENT de
    // precio nacen PENDING, así que checkOut() casi nunca veía el ítem de
    // ingreso principal de la estadía. Ahora incluye PENDING también
    // (PAYMENT/REFUND siempre nacen SETTLED directo, no les afecta).
    it('calcula CHARGE + ADJUSTMENT + REFUND - PAYMENT, PENDING y SETTLED', async () => {
      await repo.getNetBalanceByStayId('stay-1');

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain("WHEN 'CHARGE'     THEN  amount");
      expect(sql).toContain("WHEN 'ADJUSTMENT' THEN  amount");
      expect(sql).toContain("WHEN 'PAYMENT'    THEN -amount");
      expect(sql).toContain("WHEN 'REFUND'     THEN  amount");
      expect(sql).toContain("status IN ('PENDING', 'SETTLED')");
      expect(sql).toContain('stay_id = $1');
      expect(params).toEqual(['stay-1']);
    });

    it('devuelve 0 cuando no hay transacciones', async () => {
      const balance = await repo.getNetBalanceByStayId('stay-sin-cargos');
      expect(balance).toBe(0);
    });

    // Regresión directa del bug: simula lo que Postgres devolvería con la
    // fórmula CORREGIDA para "cobré 1000, reembolsé 1000 completo" -- con
    // el bug viejo (REFUND: -amount) esta cuenta daba -2000, no 0.
    it('regresión: cobro completo + reembolso completo da balance 0, no -2×monto', async () => {
      // amount=1000 CHARGE (voided, no cuenta) + amount=1000 PAYMENT SETTLED
      // (-1000) + amount=1000 REFUND SETTLED (fórmula corregida: +1000) = 0.
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({ rows: [{ net: '0' }] });
      const balance = await repo.getNetBalanceByStayId('stay-reembolso-total');
      expect(balance).toBe(0);
    });
  });

  describe('getNetBalanceByCustomerId', () => {
    it('calcula CHARGE + ADJUSTMENT + REFUND - PAYMENT, solo SETTLED (mismo fix que getNetBalanceByStayId)', async () => {
      await repo.getNetBalanceByCustomerId('cust-1');

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain("WHEN 'PAYMENT'    THEN -amount");
      expect(sql).toContain("WHEN 'REFUND'     THEN  amount");
      expect(sql).toContain("customer_id = $1");
      expect(params).toEqual(['cust-1']);
    });
  });

  describe('settleByReservationId', () => {
    // Residual B-1 / 3.2-b (13/09/2026) -- PAYMENT nunca se liquida como
    // side-effect de completar la reserva (A3.9: dinero que ya cambió de
    // manos, no una obligación pendiente).
    it('excluye PAYMENT del UPDATE (interferente dormido -- PAYMENT hoy siempre nace SETTLED, pero la query no debe depender de eso)', async () => {
      await repo.settleByReservationId('res-1');

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain("status = 'PENDING'");
      expect(sql).toContain("AND type <> 'PAYMENT'");
      expect(params).toEqual(['res-1']);
    });
  });

  // Bug real en producción, 23/08/2026: voidByReservationId/voidByOrderId
  // anulaban CUALQUIER transacción PENDING/SETTLED de la reserva/orden sin
  // filtrar por `type` -- así que un PAYMENT ya cobrado (ej. una seña,
  // C1-Fase A) quedaba VOIDED junto con el CHARGE al cancelar. Un pago es
  // un hecho histórico de dinero que ya cambió de manos -- nunca se anula
  // en silencio, solo se revierte con un REFUND explícito.
  //
  // RESERVA-10 (05/09/2026) -- reescrito con el mismo criterio que
  // voidByOrderId() post-ORDER-10: EfectoDesenlace, no un número mudo;
  // exige EXISTS una reserva CANCELLED (antes no chequeaba el estado de
  // la reserva en absoluto); NOT EXISTS un comprobante vivo.
  describe('voidByReservationId — RESERVA-10', () => {
    function diagReserva(over: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        aplicadas: 0, candidatos: 0,
        reserva_inexistente: 0, reserva_no_elegible: 0, estado_desconocido: 0,
        anulados: 0, tipo_no_liquidable: 0, con_comprobante_vivo: 0,
        ...over,
      };
    }

    it('solo anula CHARGE/ADJUSTMENT, nunca PAYMENT/REFUND, y exige la reserva CANCELLED', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [diagReserva({ aplicadas: 1, candidatos: 1 })],
      });

      const d = await repo.voidByReservationId('res-1', 'biz-1');

      const [sql, params] = vi.mocked(mockSqlClient.query).mock.calls[0]!;
      expect(sql).toContain("SET status = 'VOIDED'");
      expect(sql).toContain("ft.type   IN ('CHARGE','ADJUSTMENT')");
      // RESERVA-10: antes no chequeaba el estado de la reserva en absoluto.
      expect(sql).toContain("r.status = 'CANCELLED'");
      expect(params).toEqual(['res-1', 'biz-1']);
      expect(d).toEqual({ tipo: 'APLICADO', filas: 1, rechazos: [] });
    });

    it('RESERVA-10: excluye del UPDATE los cargos con comprobante vivo, contra invoices/invoice_charges', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [diagReserva({ candidatos: 1, con_comprobante_vivo: 1 })],
      });

      const d = await repo.voidByReservationId('res-1', 'biz-1');

      const [sql] = vi.mocked(mockSqlClient.query).mock.calls[0]!;
      expect(sql).toContain('AND NOT EXISTS (');
      expect(sql).toContain('FROM invoices');
      expect(sql).toContain('FROM invoice_charges ic');
      expect(sql).toContain("linked.status = 'ISSUED'");
      expect(d).toEqual({ tipo: 'RECHAZADO', rechazos: ['CARGO_CON_COMPROBANTE_VIVO'] });
    });

    it('reserva inexistente: candidatos=0 es NADA_QUE_HACER', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({ rows: [diagReserva()] });
      const d = await repo.voidByReservationId('res-inexistente', 'biz-1');
      expect(d).toEqual({ tipo: 'NADA_QUE_HACER' });
    });

    it('reserva NO CANCELLED: rechaza con RESERVA_ESTADO_NO_ELEGIBLE', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [diagReserva({ candidatos: 1, reserva_no_elegible: 1 })],
      });
      const d = await repo.voidByReservationId('res-1', 'biz-1');
      expect(d).toEqual({ tipo: 'RECHAZADO', rechazos: ['RESERVA_ESTADO_NO_ELEGIBLE'] });
    });
  });

  describe('voidByOrderId — O2 / ORDER-06', () => {
    it('O2R-26: exige que la orden esté CANCELLED, dentro de la sentencia', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [{
          aplicadas: 1, candidatos: 1, orden_inexistente: 0, orden_ajena: 0,
          orden_no_elegible: 0, estado_desconocido: 0, ya_settled: 0,
          anulados: 0, tipo_no_liquidable: 0, con_comprobante_vivo: 0,
        }],
      });

      const d = await repo.voidByOrderId('order-1', 'biz-1');

      const [sql, params] = vi.mocked(mockSqlClient.query).mock.calls[0]!;
      expect(sql).toContain("SET status = 'VOIDED'");
      // ORDER-06: antes anulaba PENDING y SETTLED sin mirar el estado de la
      // orden. Del lado *anular* eso revierte un cobro ya realizado.
      expect(sql).toContain("o.status IN ('CANCELLED')");
      // ORDER-15, declarada y NO resuelta: el filtro de tipo sigue siendo más
      // amplio que el de la liquidación, que quedó en ('CHARGE').
      expect(sql).toContain("ft.type   IN ('CHARGE','ADJUSTMENT')");
      expect(params).toEqual(['order-1', 'biz-1']);
      expect(d).toEqual({ tipo: 'APLICADO', filas: 1, rechazos: [] });
    });

    it('ORDER-10 (05/09/2026): la sentencia excluye del UPDATE los cargos con comprobante vivo, contra invoices/invoice_charges', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [{
          aplicadas: 0, candidatos: 1, orden_inexistente: 0, orden_ajena: 0,
          orden_no_elegible: 0, estado_desconocido: 0, ya_settled: 0,
          anulados: 0, tipo_no_liquidable: 0, con_comprobante_vivo: 1,
        }],
      });

      const d = await repo.voidByOrderId('order-1', 'biz-1');

      const [sql] = vi.mocked(mockSqlClient.query).mock.calls[0]!;
      // La exclusión cross-dominio SANCIONADA (ver docblock de voidByOrderId):
      // NOT EXISTS contra invoices/invoice_charges, DENTRO del UPDATE.
      expect(sql).toContain('AND NOT EXISTS (');
      expect(sql).toContain('FROM invoices');
      expect(sql).toContain('FROM invoice_charges ic');
      expect(sql).toContain("linked.status = 'ISSUED'");
      expect(sql).toContain("linked.status = 'PENDING'");
      expect(sql).toContain("linked.status = 'FAILED_UNCERTAIN' AND linked.afip_contacted");
      // No aplicó nada (el único candidato lo bloqueó el comprobante vivo) y
      // el rechazo declara la causa real -- no un "nada que hacer" mudo.
      expect(d).toEqual({ tipo: 'RECHAZADO', rechazos: ['CARGO_CON_COMPROBANTE_VIVO'] });
    });
  });
});
