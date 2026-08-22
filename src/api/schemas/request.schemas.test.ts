import { describe, it, expect } from 'vitest';
import { RecordPaymentSchema, CompleteOrderSchema, CreateCustomerRateSchema, CreateRateCatalogEntrySchema } from './request.schemas.js';

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

describe('CreateCustomerRateSchema — fijo vs. % vs. catálogo (D5, pendientes-2026-08-19.md)', () => {
  it('acepta resourceId + price (ad hoc, fijo)', () => {
    const result = CreateCustomerRateSchema.safeParse({ resourceId: 'r1', price: 100 });
    expect(result.success).toBe(true);
  });

  it('acepta serviceId + discountPercentage (ad hoc, %)', () => {
    const result = CreateCustomerRateSchema.safeParse({ serviceId: 's1', discountPercentage: 15 });
    expect(result.success).toBe(true);
  });

  it('acepta solo rateCatalogId (desde el catálogo)', () => {
    const result = CreateCustomerRateSchema.safeParse({ rateCatalogId: 'cat-1' });
    expect(result.success).toBe(true);
  });

  it('rechaza rateCatalogId combinado con resourceId', () => {
    const result = CreateCustomerRateSchema.safeParse({ rateCatalogId: 'cat-1', resourceId: 'r1' });
    expect(result.success).toBe(false);
  });

  it('rechaza rateCatalogId combinado con price', () => {
    const result = CreateCustomerRateSchema.safeParse({ rateCatalogId: 'cat-1', price: 100 });
    expect(result.success).toBe(false);
  });

  it('rechaza resourceId y serviceId juntos', () => {
    const result = CreateCustomerRateSchema.safeParse({ resourceId: 'r1', serviceId: 's1', price: 100 });
    expect(result.success).toBe(false);
  });

  it('rechaza ni resourceId ni serviceId (sin rateCatalogId)', () => {
    const result = CreateCustomerRateSchema.safeParse({ price: 100 });
    expect(result.success).toBe(false);
  });

  it('rechaza price y discountPercentage juntos', () => {
    const result = CreateCustomerRateSchema.safeParse({ resourceId: 'r1', price: 100, discountPercentage: 10 });
    expect(result.success).toBe(false);
  });

  it('rechaza ni price ni discountPercentage', () => {
    const result = CreateCustomerRateSchema.safeParse({ resourceId: 'r1' });
    expect(result.success).toBe(false);
  });

  it('rechaza discountPercentage 0 o > 100', () => {
    expect(CreateCustomerRateSchema.safeParse({ resourceId: 'r1', discountPercentage: 0 }).success).toBe(false);
    expect(CreateCustomerRateSchema.safeParse({ resourceId: 'r1', discountPercentage: 101 }).success).toBe(false);
  });
});

describe('CreateCustomerRateSchema — scope multi-nivel (D9-Parte 1, pendientes-2026-08-22.md)', () => {
  it('acepta categoryId + discountPercentage (nivel CATEGORÍA)', () => {
    const result = CreateCustomerRateSchema.safeParse({ categoryId: 'cat-hab-dobles', discountPercentage: 10 });
    expect(result.success).toBe(true);
  });

  it('acepta bucket ALOJAMIENTO/TURNOS/SERVICIOS + price (nivel BUCKET)', () => {
    for (const bucket of ['ALOJAMIENTO', 'TURNOS', 'SERVICIOS']) {
      expect(CreateCustomerRateSchema.safeParse({ bucket, price: 100 }).success).toBe(true);
    }
  });

  it('rechaza bucket PRODUCTOS -- D9-Parte 2, no implementado todavía', () => {
    const result = CreateCustomerRateSchema.safeParse({ bucket: 'PRODUCTOS', price: 100 });
    expect(result.success).toBe(false);
  });

  it('rechaza productId -- D9-Parte 2, no implementado todavía', () => {
    const result = CreateCustomerRateSchema.safeParse({ productId: 'prod-1', price: 100 });
    expect(result.success).toBe(false);
  });

  it('rechaza bucket inválido (fuera del catálogo de 4)', () => {
    const result = CreateCustomerRateSchema.safeParse({ bucket: 'GIMNASIO', price: 100 });
    expect(result.success).toBe(false);
  });

  it('rechaza categoryId + bucket juntos (dos niveles a la vez)', () => {
    const result = CreateCustomerRateSchema.safeParse({ categoryId: 'cat-1', bucket: 'TURNOS', price: 100 });
    expect(result.success).toBe(false);
  });

  it('rechaza rateCatalogId combinado con categoryId o bucket', () => {
    expect(CreateCustomerRateSchema.safeParse({ rateCatalogId: 'cat-1', categoryId: 'c1' }).success).toBe(false);
    expect(CreateCustomerRateSchema.safeParse({ rateCatalogId: 'cat-1', bucket: 'TURNOS' }).success).toBe(false);
  });
});

describe('CreateRateCatalogEntrySchema (D5, pendientes-2026-08-19.md)', () => {
  it('acepta nombre + % + resourceId', () => {
    const result = CreateRateCatalogEntrySchema.safeParse({ name: 'Corporativo', discountPercentage: 10, resourceId: 'r1' });
    expect(result.success).toBe(true);
  });

  it('acepta nombre + % + serviceId', () => {
    const result = CreateRateCatalogEntrySchema.safeParse({ name: 'Corporativo', discountPercentage: 10, serviceId: 's1' });
    expect(result.success).toBe(true);
  });

  it('rechaza sin resourceId ni serviceId', () => {
    const result = CreateRateCatalogEntrySchema.safeParse({ name: 'Corporativo', discountPercentage: 10 });
    expect(result.success).toBe(false);
  });

  it('rechaza resourceId y serviceId juntos', () => {
    const result = CreateRateCatalogEntrySchema.safeParse({ name: 'Corporativo', discountPercentage: 10, resourceId: 'r1', serviceId: 's1' });
    expect(result.success).toBe(false);
  });

  it('rechaza % <= 0 o > 100', () => {
    expect(CreateRateCatalogEntrySchema.safeParse({ name: 'X', discountPercentage: 0, resourceId: 'r1' }).success).toBe(false);
    expect(CreateRateCatalogEntrySchema.safeParse({ name: 'X', discountPercentage: 100.5, resourceId: 'r1' }).success).toBe(false);
  });
});

describe('CreateRateCatalogEntrySchema — scope multi-nivel (D9-Parte 1, pendientes-2026-08-22.md)', () => {
  it('acepta categoryId', () => {
    const result = CreateRateCatalogEntrySchema.safeParse({ name: 'Dobles -10%', discountPercentage: 10, categoryId: 'cat-1' });
    expect(result.success).toBe(true);
  });

  it('acepta bucket ALOJAMIENTO', () => {
    const result = CreateRateCatalogEntrySchema.safeParse({ name: 'Todo alojamiento -10%', discountPercentage: 10, bucket: 'ALOJAMIENTO' });
    expect(result.success).toBe(true);
  });

  it('rechaza bucket PRODUCTOS / productId -- D9-Parte 2, no implementado todavía', () => {
    expect(CreateRateCatalogEntrySchema.safeParse({ name: 'X', discountPercentage: 10, bucket: 'PRODUCTOS' }).success).toBe(false);
    expect(CreateRateCatalogEntrySchema.safeParse({ name: 'X', discountPercentage: 10, productId: 'p1' }).success).toBe(false);
  });
});
