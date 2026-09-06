import { describe, it, expect } from 'vitest';
import {
  isInvoiceFullyCompensatedByIssuedCreditNotes,
  CREDIT_NOTE_COMPENSATION_TOLERANCE,
  authorizeCreditNoteCancellation,
  type CreditNoteCancellationScope,
} from './cancel-with-credit-note.js';

describe('F4 — isInvoiceFullyCompensatedByIssuedCreditNotes()', () => {
  it('compensación exacta => true', () => {
    expect(isInvoiceFullyCompensatedByIssuedCreditNotes(1210, 1210)).toBe(true);
  });

  it('NC por más que la factura (no debería pasar, pero no bloquea) => true', () => {
    expect(isInvoiceFullyCompensatedByIssuedCreditNotes(1210, 1500)).toBe(true);
  });

  it('un centavo corto: dentro de la tolerancia de redondeo => true', () => {
    expect(isInvoiceFullyCompensatedByIssuedCreditNotes(1210, 1209.99)).toBe(true);
  });

  it('dos centavos corto: descuadre real, no ruido de redondeo => false', () => {
    expect(isInvoiceFullyCompensatedByIssuedCreditNotes(1210, 1209.98)).toBe(false);
  });

  it('un centavo corto en magnitudes chicas (residuo real de resta float) => true', () => {
    // 8.30 - 8.29 === 0.010000000000000675 -- un `>= x - 0.01` a secas daría
    // false acá; round2 de la diferencia lo normaliza (re-gate governor).
    expect(isInvoiceFullyCompensatedByIssuedCreditNotes(8.30, 8.29)).toBe(true);
    expect(isInvoiceFullyCompensatedByIssuedCreditNotes(3.30, 3.29)).toBe(true);
  });

  it('dos centavos corto en magnitud chica => false', () => {
    expect(isInvoiceFullyCompensatedByIssuedCreditNotes(8.30, 8.28)).toBe(false);
  });

  it('NC parcial => false (F4 es todo-o-nada)', () => {
    expect(isInvoiceFullyCompensatedByIssuedCreditNotes(1210, 600)).toBe(false);
  });

  it('sin ninguna NC ISSUED (total 0) => false', () => {
    expect(isInvoiceFullyCompensatedByIssuedCreditNotes(1210, 0)).toBe(false);
  });

  it('factura en 0 y sin NC => true (nada que compensar)', () => {
    expect(isInvoiceFullyCompensatedByIssuedCreditNotes(0, 0)).toBe(true);
  });

  it('la tolerancia es exactamente un centavo', () => {
    expect(CREDIT_NOTE_COMPENSATION_TOLERANCE).toBe(0.01);
  });
});

describe('authorizeCreditNoteCancellation()', () => {
  const scope: CreditNoteCancellationScope = { kind: 'ORDER', orderId: 'ord-1' };

  it('construye el token con confirmedBy/reason/scope, trimmeando los strings', () => {
    const authz = authorizeCreditNoteCancellation({
      confirmedBy: '  identity-9 ',
      reason: '  error de carga: la orden nunca existió  ',
      scope,
    });
    expect(authz.confirmedBy).toBe('identity-9');
    expect(authz.reason).toBe('error de carga: la orden nunca existió');
    expect(authz.scope).toEqual(scope);
  });

  it('acepta un scope de reserva', () => {
    const authz = authorizeCreditNoteCancellation({
      confirmedBy: 'id',
      reason: 'x',
      scope: { kind: 'RESERVATION', reservationId: 'res-1' },
    });
    expect(authz.scope).toEqual({ kind: 'RESERVATION', reservationId: 'res-1' });
  });

  it('rechaza confirmedBy vacío / solo espacios (A9.4)', () => {
    expect(() =>
      authorizeCreditNoteCancellation({ confirmedBy: '   ', reason: 'x', scope }),
    ).toThrow(/confirmedBy/);
  });

  it('rechaza reason vacío / solo espacios (N7)', () => {
    expect(() =>
      authorizeCreditNoteCancellation({ confirmedBy: 'id', reason: '   ', scope }),
    ).toThrow(/reason/);
  });
});
