/**
 * @file billing-policy.entities.ts
 * @description Relación comercial de facturación con un cliente (C1-Fase C,
 * 23/08/2026, pendientes-2026-08-23.md — recorte confirmado del spec
 * "spec-cobro-facturacion-sena-saldo (1).md", punto 8). No es MAESTRO/
 * TRANSACCIÓN/DOCUMENTO en el sentido estricto de criterios-datos.md Parte
 * 1 — es config viva, mismo criterio que `rate_catalog`/`customer_rates`:
 * se lee al momento de facturar, nunca se congela hasta que se usa.
 *
 * `requiresSenaToConfirm`/`invoicingTrigger`/`cycleFrequency`/
 * `cycleCustomDays` se PERSISTEN pero hoy no tienen ningún código que los
 * haga cumplir — son la config que la Fase B (gateway/hold) y un
 * disparador automático programado (todavía sin construir) van a leer el
 * día que existan. Lo único con efecto real hoy: `dueDays` (vencimiento en
 * el reporte de cuentas por cobrar) e `invoicingScope='consolidated'`
 * habilitando "Facturar ahora" (InvoiceService.requestConsolidatedInvoice).
 *
 * Sin fila = política default: requiere seña (si hay una configurada),
 * factura por reserva, vence al momento (dueDays=0).
 */

export type InvoicingScope = 'per_reservation' | 'consolidated';
export type InvoicingTrigger = 'on_completion' | 'scheduled';
export type CycleFrequency = 'weekly' | 'monthly' | 'custom_days';

export interface BillingPolicy {
  customerId: string;
  requiresSenaToConfirm: boolean;
  invoicingScope: InvoicingScope;
  invoicingTrigger: InvoicingTrigger;
  cycleFrequency: CycleFrequency | null;
  /** Solo tiene sentido con `cycleFrequency = 'custom_days'`. */
  cycleCustomDays: number | null;
  dueDays: number;
  updatedAt: Date;
}

export interface UpsertBillingPolicyInput {
  requiresSenaToConfirm: boolean;
  invoicingScope: InvoicingScope;
  invoicingTrigger: InvoicingTrigger;
  cycleFrequency?: CycleFrequency | null;
  cycleCustomDays?: number | null;
  dueDays: number;
}
