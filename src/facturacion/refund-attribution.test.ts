import { describe, it, expect } from 'vitest';
import { resolveRefundableForPair, type FrozenInvoiceItemShare, type FrozenIvaEntry } from './refund-attribution.js';

describe('resolveRefundableForPair()', () => {
  it('equivalencia con N2 (commit 5fcc10e) -- consolidada de 3 reservas a tasa 0%, tope por reserva en vez de global', () => {
    // Mismos números que el test de repositorio de N2: consolidada $1000,
    // A=$500/B=$300/C=$200, ya reembolsado $400 contra A y $100 contra B.
    // getRefundableForUpdate() (global) daba 500 para CUALQUIER reserva del
    // lote -- acá, por par, C da exactamente su propio remanente: $200.
    const items: FrozenInvoiceItemShare[] = [
      { reservationId: 'res-A', subtotal: 500, ivaRate: 0 },
      { reservationId: 'res-B', subtotal: 300, ivaRate: 0 },
      { reservationId: 'res-C', subtotal: 200, ivaRate: 0 },
    ];

    const resultC = resolveRefundableForPair({
      items, frozenIva: [], alreadyRefunded: 0, reservationId: 'res-C',
    });

    expect(resultC.kind).toBe('RESOLVED');
    if (resultC.kind !== 'RESOLVED') return;
    expect(resultC.attributedNeto).toBe(200);
    expect(resultC.attributedIva).toBe(0);
    expect(resultC.attributedTotal).toBe(200);
    expect(resultC.refundable).toBe(200);

    // El tope global contaminado de N2 era 500 (1000 - 400 - 100). El tope
    // por par de C NO es ese número -- es la prueba de que el defecto que
    // N2 documentó ya no se reproduce con esta función.
    expect(resultC.refundable).not.toBe(500);

    // A y B, con lo YA reembolsado descontado -- cada uno ve solo SU propio
    // reembolso previo, no el ajeno.
    const resultA = resolveRefundableForPair({ items, frozenIva: [], alreadyRefunded: 400, reservationId: 'res-A' });
    const resultB = resolveRefundableForPair({ items, frozenIva: [], alreadyRefunded: 100, reservationId: 'res-B' });
    expect(resultA.kind === 'RESOLVED' && resultA.refundable).toBe(100);
    expect(resultB.kind === 'RESOLVED' && resultB.refundable).toBe(200);
  });

  it('factura a tasa 21% -- usa la composición fiscal CONGELADA (afip_request.Iva[]), no re-deriva desde pricesIncludeIva actual', () => {
    // 2 reservas, mismo grupo de tasa. Neto real: A=1000, B=500 (total 1500).
    // El BaseImp/Importe congelados podrían no coincidir exactamente con un
    // recálculo ingenuo si pricesIncludeIva cambió después de emitir -- por
    // eso la función parte de `frozenIva`, no de `splitAmount()` en vivo.
    const items: FrozenInvoiceItemShare[] = [
      { reservationId: 'res-A', subtotal: 1000, ivaRate: 21 },
      { reservationId: 'res-B', subtotal: 500, ivaRate: 21 },
    ];
    const frozenIva: FrozenIvaEntry[] = [{ id: 5, baseImp: 1500, importe: 315 }];

    const resultA = resolveRefundableForPair({ items, frozenIva, alreadyRefunded: 0, reservationId: 'res-A' });
    const resultB = resolveRefundableForPair({ items, frozenIva, alreadyRefunded: 0, reservationId: 'res-B' });

    expect(resultA.kind === 'RESOLVED' && resultA.attributedNeto).toBe(1000);
    expect(resultA.kind === 'RESOLVED' && resultA.attributedIva).toBe(210);
    expect(resultA.kind === 'RESOLVED' && resultA.attributedTotal).toBe(1210);

    expect(resultB.kind === 'RESOLVED' && resultB.attributedNeto).toBe(500);
    expect(resultB.kind === 'RESOLVED' && resultB.attributedIva).toBe(105);
    expect(resultB.kind === 'RESOLVED' && resultB.attributedTotal).toBe(605);

    // Los dos suman exactamente el congelado -- ninguna fuga de redondeo
    // en el caso exacto (2/3 y 1/3 de 1500 y 315 son exactos a centavo).
    expect(resultA.kind === 'RESOLVED' && resultB.kind === 'RESOLVED' &&
      round2sum(resultA.attributedNeto, resultB.attributedNeto)).toBe(1500);
  });

  it('tasas MIXTAS -- cada reserva se atribuye dentro de su propio grupo de tasa, sin mezclarlos', () => {
    // res-A tiene ítems en las dos tasas (ej. alojamiento 21% + algo exento
    // a 10.5% en la misma consolidada); res-B solo en 21%.
    const items: FrozenInvoiceItemShare[] = [
      { reservationId: 'res-A', subtotal: 800, ivaRate: 21 },
      { reservationId: 'res-B', subtotal: 200, ivaRate: 21 },
      { reservationId: 'res-A', subtotal: 100, ivaRate: 10.5 },
    ];
    const frozenIva: FrozenIvaEntry[] = [
      { id: 5, baseImp: 1000, importe: 210 },   // grupo 21%: 800+200
      { id: 4, baseImp: 100, importe: 10.5 },   // grupo 10.5%: solo A
    ];

    const resultA = resolveRefundableForPair({ items, frozenIva, alreadyRefunded: 0, reservationId: 'res-A' });
    const resultB = resolveRefundableForPair({ items, frozenIva, alreadyRefunded: 0, reservationId: 'res-B' });

    // A: 80% del grupo 21% (800/1000 * 1000/210) + el 100% del grupo 10.5%.
    expect(resultA.kind === 'RESOLVED' && resultA.attributedNeto).toBe(900);   // 800 + 100
    expect(resultA.kind === 'RESOLVED' && resultA.attributedIva).toBe(178.5);  // 168 + 10.5
    // B: solo su 20% del grupo 21%, cero en el grupo 10.5% (no participa).
    expect(resultB.kind === 'RESOLVED' && resultB.attributedNeto).toBe(200);
    expect(resultB.kind === 'RESOLVED' && resultB.attributedIva).toBe(42);
  });

  it('residuo de redondeo -- lo absorbe la reserva de MAYOR participación en el grupo (decisión del dueño, 05/09/2026)', () => {
    // 3 reservas partiendo 100 en tercios: 33.33... cada una. round2 da
    // 33.33 x3 = 99.99, falta un centavo. Con neto*iva a distintas tasas
    // fijas, elegimos subtotales que fuercen justo este caso.
    const items: FrozenInvoiceItemShare[] = [
      { reservationId: 'res-A', subtotal: 100, ivaRate: 21 }, // mayor participación
      { reservationId: 'res-B', subtotal: 100, ivaRate: 21 },
      { reservationId: 'res-C', subtotal: 100, ivaRate: 21 },
    ];
    // BaseImp de 100 repartido en tercios exactos -- fuerza el residuo:
    // 100/3 = 33.333... -> round2 = 33.33 cada una -> suma 99.99, falta 0.01.
    const frozenIva: FrozenIvaEntry[] = [{ id: 5, baseImp: 100, importe: 21 }];

    const resultA = resolveRefundableForPair({ items, frozenIva, alreadyRefunded: 0, reservationId: 'res-A' });
    const resultB = resolveRefundableForPair({ items, frozenIva, alreadyRefunded: 0, reservationId: 'res-B' });
    const resultC = resolveRefundableForPair({ items, frozenIva, alreadyRefunded: 0, reservationId: 'res-C' });

    const netos = [resultA, resultB, resultC].map((r) => (r.kind === 'RESOLVED' ? r.attributedNeto : NaN));
    // Empate exacto de participación -- el residuo cae en la PRIMERA
    // reserva que alcanza el máximo (orden estable de iteración del Map,
    // documentado -- no es azar).
    expect(netos).toEqual([33.34, 33.33, 33.33]);
    expect(round2sum(...netos)).toBe(100);
  });

  it('BLOQUEA (NO_ITEMS) -- factura sin invoice_items (Nivel A), nunca aproxima', () => {
    const result = resolveRefundableForPair({
      items: [], frozenIva: [], alreadyRefunded: 0, reservationId: 'res-A',
    });
    expect(result).toEqual(expect.objectContaining({ kind: 'BLOCKED', reason: 'NO_ITEMS' }));
  });

  it('BLOQUEA (SUBJECT_NOT_IN_INVOICE) -- la reserva pedida no tiene ningún ítem en esta factura', () => {
    const items: FrozenInvoiceItemShare[] = [{ reservationId: 'res-OTRA', subtotal: 100, ivaRate: 21 }];
    const result = resolveRefundableForPair({
      items, frozenIva: [{ id: 5, baseImp: 100, importe: 21 }], alreadyRefunded: 0, reservationId: 'res-A',
    });
    expect(result).toEqual(expect.objectContaining({ kind: 'BLOCKED', reason: 'SUBJECT_NOT_IN_INVOICE' }));
  });

  describe('bloque 1a -- generalización sobre clave de atribución opaca (ORDER-CONSOLIDATED-PARTIAL-01)', () => {
    // La función nunca le dio tratamiento especial a "reserva" -- estos
    // casos pasan ids con FORMA de orden por el mismo campo `reservationId`
    // (sin renombrar, ver docblock del archivo) y verifican que el reparto
    // y el denominador se comportan exactamente igual que con ids de
    // reserva. Sirve como prueba de que el pure function ya está listo
    // para el modo orden sin cambiar una sola línea de lógica -- el wiring
    // real (bloque 1c) es aparte.
    it('acepta claves con forma de orden y reparte igual que con reservas', () => {
      const items: FrozenInvoiceItemShare[] = [
        { reservationId: 'order-A', subtotal: 500, ivaRate: 0 },
        { reservationId: 'order-B', subtotal: 300, ivaRate: 0 },
        { reservationId: 'order-C', subtotal: 200, ivaRate: 0 },
      ];
      const resultC = resolveRefundableForPair({ items, frozenIva: [], alreadyRefunded: 0, reservationId: 'order-C' });
      expect(resultC.kind === 'RESOLVED' && resultC.attributedNeto).toBe(200);
    });

    it('mezcla claves de orden y de reserva en la misma factura -- cada una se atribuye por su propia clave, sin cruzarse', () => {
      const items: FrozenInvoiceItemShare[] = [
        { reservationId: 'res-A', subtotal: 800, ivaRate: 21 },
        { reservationId: 'order-Z', subtotal: 200, ivaRate: 21 },
      ];
      const frozenIva: FrozenIvaEntry[] = [{ id: 5, baseImp: 1000, importe: 210 }];

      const resultRes = resolveRefundableForPair({ items, frozenIva, alreadyRefunded: 0, reservationId: 'res-A' });
      const resultOrder = resolveRefundableForPair({ items, frozenIva, alreadyRefunded: 0, reservationId: 'order-Z' });

      expect(resultRes.kind === 'RESOLVED' && resultRes.attributedNeto).toBe(800);
      expect(resultRes.kind === 'RESOLVED' && resultRes.attributedIva).toBe(168);
      expect(resultOrder.kind === 'RESOLVED' && resultOrder.attributedNeto).toBe(200);
      expect(resultOrder.kind === 'RESOLVED' && resultOrder.attributedIva).toBe(42);
    });

    it('REFUND-ATTRIBUTION-RESIDUAL-001, RESUELTO (11/09/2026) -- un item sin clave (null) en el MISMO grupo de tasa que un item con clave YA NO le atribuye su monto a la clave presente', () => {
      // Encontrado al generalizar el bloque 1a (11/09/2026), confirmado con
      // caller de producción vivo desde el bloque 3.3-a
      // (InvoiceService.buildCreditNote()) -- corregido en el mismo día,
      // gate architecture-governor, APPROVED WITH CONDITIONS. Antes del
      // fix: el residuo de redondeo se calculaba contra `frozenAmount`
      // completo (1000, ambos items) en vez de contra la porción de los
      // items CON clave (600) -- el "residuo" (1000-600=400) no era un
      // centavo de redondeo, era el monto ENTERO del item sin clave. Con
      // el fix, order-A se lleva exactamente su propia porción (600), el
      // resto (400, sin clave) no es de nadie.
      const items: FrozenInvoiceItemShare[] = [
        { reservationId: 'order-A', subtotal: 600, ivaRate: 0 },
        { reservationId: null, subtotal: 400, ivaRate: 0 },
      ];
      const result = resolveRefundableForPair({ items, frozenIva: [], alreadyRefunded: 0, reservationId: 'order-A' });
      expect(result.kind === 'RESOLVED' && result.attributedNeto).toBe(600);
    });

    it('REFUND-ATTRIBUTION-RESIDUAL-001 -- conservación: atribuir por la clave del sujeto reserva y por la clave del sujeto orden de la MISMA factura suma exactamente el monto congelado, sin doble conteo', () => {
      // El invariante del que depende el bloque 1c: atribuir por la clave A
      // y por la clave B de la MISMA factura tiene que sumar el impTotal
      // real, no menos (plata perdida) ni más (plata que sale dos veces).
      //
      // Modela lo que hacen los 2 resolvers reales, no un array compartido
      // con las dos claves presentes a la vez (eso NO reproduce el bug --
      // los 2 ítems ya tendrían clave, ninguno cuenta como "sin clave").
      // `resolveReservationPairAttribution()` lee `reservation_id` directo:
      // el ítem de orden llega con clave `null`. `resolveOrderPairAttribution()`
      // hace LEFT JOIN a `order_items`: el ítem de reserva llega con clave
      // `null` (el JOIN no matchea). Cada resolver ve al OTRO sujeto como
      // "sin clave", nunca con su propia clave real.
      const itemsVistosPorReserva: FrozenInvoiceItemShare[] = [
        { reservationId: 'res-mix', subtotal: 1000, ivaRate: 21 },
        { reservationId: null, subtotal: 1000, ivaRate: 21 }, // la orden, sin clave desde esta vista
      ];
      const itemsVistosPorOrden: FrozenInvoiceItemShare[] = [
        { reservationId: null, subtotal: 1000, ivaRate: 21 }, // la reserva, sin clave desde esta vista
        { reservationId: 'order-A', subtotal: 1000, ivaRate: 21 },
      ];
      const frozenIva: FrozenIvaEntry[] = [{ id: 5, baseImp: 2000, importe: 420 }];

      const resultRes = resolveRefundableForPair({ items: itemsVistosPorReserva, frozenIva, alreadyRefunded: 0, reservationId: 'res-mix' });
      const resultOrder = resolveRefundableForPair({ items: itemsVistosPorOrden, frozenIva, alreadyRefunded: 0, reservationId: 'order-A' });

      expect(resultRes.kind === 'RESOLVED' && resultRes.attributedTotal).toBe(1210);
      expect(resultOrder.kind === 'RESOLVED' && resultOrder.attributedTotal).toBe(1210);
      expect(
        resultOrder.kind === 'RESOLVED' && resultRes.kind === 'RESOLVED'
          && round2sum(resultOrder.attributedTotal, resultRes.attributedTotal),
      ).toBe(2420); // == impTotal real del grupo (2000 neto + 420 iva) -- con el bug daría 4840 (2420+2420)
    });

    it('REFUND-ATTRIBUTION-RESIDUAL-001, borde -- un item CON clave pero subtotal 0 ya no se lleva el grupo entero', () => {
      // invoice_items.subtotal es DECIMAL(12,2) NOT NULL CHECK (subtotal >= 0)
      // -- 0 es un valor legal (ej. una línea de cortesía). Antes del fix,
      // como esa clave era la ÚNICA con clave presente, se llevaba el
      // residuo completo (todo el monto del item sin clave) aunque su
      // propia participación fuera 0. Con el fix, keyedSubtotalSum=0 -->
      // keyedPortionOfFrozenAmount=0 --> esa clave no recibe nada.
      const items: FrozenInvoiceItemShare[] = [
        { reservationId: 'res-cortesia', subtotal: 0, ivaRate: 0 },
        { reservationId: null, subtotal: 1000, ivaRate: 0 },
      ];
      const result = resolveRefundableForPair({ items, frozenIva: [], alreadyRefunded: 0, reservationId: 'res-cortesia' });
      expect(result.kind === 'RESOLVED' && result.attributedNeto).toBe(0);
    });
  });

  it('BLOQUEA (MISSING_FROZEN_IVA_ENTRY) -- grupo de tasa con IVA sin entrada congelada correspondiente, no se re-deriva', () => {
    const items: FrozenInvoiceItemShare[] = [{ reservationId: 'res-A', subtotal: 100, ivaRate: 21 }];
    const result = resolveRefundableForPair({
      items, frozenIva: [], // vacío -- falta la entrada del grupo 21%
      alreadyRefunded: 0, reservationId: 'res-A',
    });
    expect(result).toEqual(expect.objectContaining({ kind: 'BLOCKED', reason: 'MISSING_FROZEN_IVA_ENTRY' }));
  });

  it('anomalía visible, no enmascarada -- refundable puede dar negativo si ya se reembolsó más de lo atribuible a esta reserva (mismo criterio que getRefundableForUpdate)', () => {
    const items: FrozenInvoiceItemShare[] = [{ reservationId: 'res-A', subtotal: 200, ivaRate: 0 }];
    const result = resolveRefundableForPair({
      items, frozenIva: [], alreadyRefunded: 250, reservationId: 'res-A',
    });
    expect(result.kind === 'RESOLVED' && result.refundable).toBe(-50);
  });

  it('factura individual (1 sola reserva) -- se comporta igual que un caso consolidado degenerado de 1 elemento', () => {
    const items: FrozenInvoiceItemShare[] = [{ reservationId: 'res-A', subtotal: 1000, ivaRate: 21 }];
    const frozenIva: FrozenIvaEntry[] = [{ id: 5, baseImp: 1000, importe: 210 }];
    const result = resolveRefundableForPair({ items, frozenIva, alreadyRefunded: 300, reservationId: 'res-A' });
    expect(result.kind === 'RESOLVED' && result.attributedTotal).toBe(1210);
    expect(result.kind === 'RESOLVED' && result.refundable).toBe(910);
  });
});

function round2sum(...values: number[]): number {
  return Math.round(values.reduce((sum, v) => sum + v, 0) * 100) / 100;
}
