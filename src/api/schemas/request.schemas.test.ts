import { describe, it, expect } from 'vitest';
import { RecordPaymentSchema, CompleteOrderSchema } from './request.schemas.js';

describe('RecordPaymentSchema — cardInstallments/cardSurchargeAmount (Gap Tango #3)', () => {
  it('acepta CARD con cuotas y recargo dentro del monto', () => {
    const result = RecordPaymentSchema.safeParse({
      amount: 1150, paymentMethod: 'CARD', cardInstallments: 6, cardSurchargeAmount: 150,
    });
    expect(result.success).toBe(true);
  });

  it('rechaza cardInstallments sin paymentMethod CARD', () => {
    const result = RecordPaymentSchema.safeParse({ amount: 100, paymentMethod: 'CASH', cardInstallments: 3 });
    expect(result.success).toBe(false);
  });

  it('rechaza cardSurchargeAmount sin paymentMethod en absoluto', () => {
    const result = RecordPaymentSchema.safeParse({ amount: 100, cardSurchargeAmount: 20 });
    expect(result.success).toBe(false);
  });

  it('rechaza cardSurchargeAmount mayor que amount', () => {
    const result = RecordPaymentSchema.safeParse({
      amount: 100, paymentMethod: 'CARD', cardSurchargeAmount: 150,
    });
    expect(result.success).toBe(false);
  });

  it('sigue aceptando un pago simple sin ningún campo de tarjeta', () => {
    const result = RecordPaymentSchema.safeParse({ amount: 100 });
    expect(result.success).toBe(true);
  });
});

describe('CompleteOrderSchema — cardInstallments/cardSurchargeAmount (Gap Tango #3)', () => {
  it('acepta CARD con cuotas y recargo', () => {
    const result = CompleteOrderSchema.safeParse({ paymentMethod: 'CARD', cardInstallments: 3, cardSurchargeAmount: 50 });
    expect(result.success).toBe(true);
  });

  it('rechaza cardSurchargeAmount con paymentMethod CASH', () => {
    const result = CompleteOrderSchema.safeParse({ paymentMethod: 'CASH', cardSurchargeAmount: 50 });
    expect(result.success).toBe(false);
  });

  it('acepta body vacío (compatibilidad con callers viejos)', () => {
    const result = CompleteOrderSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});
