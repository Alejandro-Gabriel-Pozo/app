/**
 * @file money.ts
 * @description Un solo lugar que redondea dinero (A3.3, criterios-negocio.md:
 * "un solo lugar redondea, con política declarada"). `round2` vivía
 * duplicada, byte a byte, en `reservas/cancellation-refund.service.ts` e
 * `facturacion/invoice.service.ts` (hallazgo #5/I6, verificación de
 * auditoría externa, 23/08/2026) — se centraliza acá al agregar un tercer
 * lugar que la necesita (`clientes-finanzas/customer-account.service.ts`,
 * I4, conciliación de pagos) en vez de triplicarla.
 *
 * Media hacia arriba, a 2 decimales, al final del cálculo — nunca
 * redondear intermedios y volver a sumar.
 */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
