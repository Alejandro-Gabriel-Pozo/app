import { describe, it, expect } from 'vitest';
import { RecordPaymentSchema, CompleteOrderSchema, CreateCustomerRateSchema, CreateRateCatalogEntrySchema, CreateOrderItemSchema, GetReservationsQuerySchema, GetOrdersQuerySchema } from './request.schemas.js';

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

  it('acepta bucket ALOJAMIENTO/TURNOS/SERVICIOS/PRODUCTOS + price (nivel BUCKET, D9-Parte 2: PRODUCTOS ya habilitado)', () => {
    for (const bucket of ['ALOJAMIENTO', 'TURNOS', 'SERVICIOS', 'PRODUCTOS']) {
      expect(CreateCustomerRateSchema.safeParse({ bucket, price: 100 }).success).toBe(true);
    }
  });

  it('acepta productId (nivel ÍTEM, D9-Parte 2)', () => {
    const result = CreateCustomerRateSchema.safeParse({ productId: 'prod-1', price: 100 });
    expect(result.success).toBe(true);
  });

  it('rechaza bucket inválido (fuera del catálogo de 4)', () => {
    const result = CreateCustomerRateSchema.safeParse({ bucket: 'GIMNASIO', price: 100 });
    expect(result.success).toBe(false);
  });

  it('rechaza categoryId + bucket juntos (dos niveles a la vez)', () => {
    const result = CreateCustomerRateSchema.safeParse({ categoryId: 'cat-1', bucket: 'TURNOS', price: 100 });
    expect(result.success).toBe(false);
  });

  it('rechaza productId + resourceId juntos (dos scopes ÍTEM a la vez)', () => {
    const result = CreateCustomerRateSchema.safeParse({ productId: 'p1', resourceId: 'r1', price: 100 });
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

  it('acepta bucket PRODUCTOS / productId (D9-Parte 2, ya habilitado)', () => {
    expect(CreateRateCatalogEntrySchema.safeParse({ name: 'X', discountPercentage: 10, bucket: 'PRODUCTOS' }).success).toBe(true);
    expect(CreateRateCatalogEntrySchema.safeParse({ name: 'X', discountPercentage: 10, productId: 'p1' }).success).toBe(true);
  });
});

describe('CreateOrderItemSchema — unitPrice server-side para PRODUCT/PRODUCT_VARIANT (D9-Parte 2, pendientes-2026-08-22.md)', () => {
  it('rechaza unitPrice para itemType PRODUCT -- el servidor lo resuelve', () => {
    const result = CreateOrderItemSchema.safeParse({ itemType: 'PRODUCT', productId: 'p1', quantity: 1, unitPrice: 100 });
    expect(result.success).toBe(false);
  });

  it('acepta PRODUCT sin unitPrice', () => {
    const result = CreateOrderItemSchema.safeParse({ itemType: 'PRODUCT', productId: 'p1', quantity: 1 });
    expect(result.success).toBe(true);
  });

  it('rechaza unitPrice para itemType PRODUCT_VARIANT -- el servidor lo resuelve', () => {
    const result = CreateOrderItemSchema.safeParse({
      itemType: 'PRODUCT_VARIANT', productId: 'p1', productVariantId: 'v1', quantity: 1, unitPrice: 100,
    });
    expect(result.success).toBe(false);
  });

  it('sigue exigiendo unitPrice para itemType RESERVATION -- sin gancho server-side (fuera del alcance de D9)', () => {
    const result = CreateOrderItemSchema.safeParse({ itemType: 'RESERVATION', reservationId: 'res-1', quantity: 1 });
    expect(result.success).toBe(false);
  });

  it('acepta RESERVATION con unitPrice', () => {
    const result = CreateOrderItemSchema.safeParse({ itemType: 'RESERVATION', reservationId: 'res-1', quantity: 1, unitPrice: 500 });
    expect(result.success).toBe(true);
  });
});

describe('GetReservationsQuerySchema — filtros parciales (D-02, docs/decisiones-auditoria-fase2-2026-09-15.md)', () => {
  it('rechaza from sin to', () => {
    const result = GetReservationsQuerySchema.safeParse({ from: '2026-01-01T00:00:00.000Z' });
    expect(result.success).toBe(false);
  });

  it('rechaza to sin from', () => {
    const result = GetReservationsQuerySchema.safeParse({ to: '2026-01-31T00:00:00.000Z' });
    expect(result.success).toBe(false);
  });

  it('acepta from y to juntos', () => {
    const result = GetReservationsQuerySchema.safeParse({
      from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('acepta ninguno de los 4 (solo otros filtros)', () => {
    const result = GetReservationsQuerySchema.safeParse({ status: 'CONFIRMED' });
    expect(result.success).toBe(true);
  });

  it('acepta sin ningún parámetro', () => {
    const result = GetReservationsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

// D-14 (15/09/2026, docs/decisiones-auditoria-fase2-2026-09-15.md #12) --
// contrato canónico limit/offset. A diferencia del `page`/`limit` viejo,
// `limit` y `offset` NO necesitan viajar juntos (cada uno tiene su propio
// default razonable), y `limit` NO tiene `.max()` acá -- el clamp real
// (resolveReservationsLimit) vive en el repo/ruta, no en el schema
// (honest-degradation: clampea e informa, no rechaza con 400).
describe('GetReservationsQuerySchema — limit/offset (D-14, docs/decisiones-auditoria-fase2-2026-09-15.md)', () => {
  it('acepta limit solo, sin offset', () => {
    const result = GetReservationsQuerySchema.safeParse({ limit: '20' });
    expect(result.success).toBe(true);
  });

  it('acepta offset solo, sin limit', () => {
    const result = GetReservationsQuerySchema.safeParse({ offset: '40' });
    expect(result.success).toBe(true);
  });

  it('acepta limit y offset juntos', () => {
    const result = GetReservationsQuerySchema.safeParse({ limit: '20', offset: '40' });
    expect(result.success).toBe(true);
  });

  it('NO rechaza un limit por encima de 200 -- el clamp es responsabilidad del repo/ruta, no del schema', () => {
    const result = GetReservationsQuerySchema.safeParse({ limit: '99999' });
    expect(result.success).toBe(true);
  });

  it('rechaza offset negativo', () => {
    const result = GetReservationsQuerySchema.safeParse({ offset: '-1' });
    expect(result.success).toBe(false);
  });

  it('rechaza limit no positivo (0)', () => {
    const result = GetReservationsQuerySchema.safeParse({ limit: '0' });
    expect(result.success).toBe(false);
  });
});

// D-14 (15/09/2026, docs/decisiones-auditoria-fase2-2026-09-15.md #12) --
// fix mecánico acotado sobre los 4 listados que NO migran al envelope
// completo en este bloque: solo `.max(200)`, con rechazo 400 (a diferencia
// de reservations, que clampea -- ver arriba).
describe('GetOrdersQuerySchema — .max(200) en limit (D-14, docs/decisiones-auditoria-fase2-2026-09-15.md)', () => {
  it('acepta limit hasta 200', () => {
    const result = GetOrdersQuerySchema.safeParse({ limit: '200' });
    expect(result.success).toBe(true);
  });

  it('rechaza limit por encima de 200', () => {
    const result = GetOrdersQuerySchema.safeParse({ limit: '201' });
    expect(result.success).toBe(false);
  });
});

describe('CreateOrderItemSchema — itemType SERVICE (Bloque C, docs/diseno-factura-borrador-2026-08-31.md §29, 15/09/2026)', () => {
  it('acepta SERVICE con serviceItemId, sin unitPrice -- el servidor lo resuelve', () => {
    const result = CreateOrderItemSchema.safeParse({ itemType: 'SERVICE', serviceItemId: 'svc-1', quantity: 1 });
    expect(result.success).toBe(true);
  });

  it('rechaza SERVICE sin serviceItemId', () => {
    const result = CreateOrderItemSchema.safeParse({ itemType: 'SERVICE', quantity: 1 });
    expect(result.success).toBe(false);
  });

  it('rechaza unitPrice para itemType SERVICE -- el servidor lo resuelve (service_items.price)', () => {
    const result = CreateOrderItemSchema.safeParse({ itemType: 'SERVICE', serviceItemId: 'svc-1', quantity: 1, unitPrice: 100 });
    expect(result.success).toBe(false);
  });

  it('rechaza SERVICE con productId', () => {
    const result = CreateOrderItemSchema.safeParse({ itemType: 'SERVICE', serviceItemId: 'svc-1', productId: 'p1', quantity: 1 });
    expect(result.success).toBe(false);
  });

  it('rechaza SERVICE con reservationId', () => {
    const result = CreateOrderItemSchema.safeParse({ itemType: 'SERVICE', serviceItemId: 'svc-1', reservationId: 'res-1', quantity: 1 });
    expect(result.success).toBe(false);
  });

  it('rechaza PRODUCT con serviceItemId -- FK cruzada entre tipos', () => {
    const result = CreateOrderItemSchema.safeParse({ itemType: 'PRODUCT', productId: 'p1', serviceItemId: 'svc-1', quantity: 1 });
    expect(result.success).toBe(false);
  });

  it('rechaza RESERVATION con serviceItemId -- FK cruzada entre tipos', () => {
    const result = CreateOrderItemSchema.safeParse({ itemType: 'RESERVATION', reservationId: 'res-1', serviceItemId: 'svc-1', quantity: 1, unitPrice: 100 });
    expect(result.success).toBe(false);
  });
});
