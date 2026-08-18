// =============================================================================
// domain/business-profile.entities.ts — Identidad del negocio (MAESTRO singleton)
// =============================================================================
// Ver schema.sql BLOQUE 15. Arrancó mínimo (nombre + contacto) a propósito —
// solo lo que necesitaba el mail de reserva confirmada (punto 5/E5,
// pendientes-2026-08-15.md). Sumó currency/timezone el 17/08/2026
// (auditoría de hardcodes, pendientes-2026-08-17.md sección F3). Los
// campos fiscales de FACTURACION se agregan después sobre esta misma
// tabla, no una nueva.
// =============================================================================

export interface BusinessProfile {
  id: string;
  /** Nombre que ve el cliente en el remitente del mail — null hasta que se cargue. */
  displayName: string | null;
  /** Reply-to del mail — null hasta que se cargue. */
  contactEmail: string | null;
  /**
   * ISO 4217 (ARS, USD, ...). Antes era una constante fija ('ARS') en el
   * DEFAULT de columna de financial_transactions/accounts_receivable/
   * cash_register_shifts (17/08/2026, auditoría de hardcodes,
   * pendientes-2026-08-17.md sección F3) — ahora es la fuente real que
   * esos servicios leen al crear cada fila.
   */
  currency: string;
  /**
   * IANA (America/Argentina/Buenos_Aires, ...). Es el campo que A4.2
   * (criterios-negocio.md) pedía en `Business` y nunca se había modelado
   * — antes vivía hardcodeado en email/templates.ts. `reservation.
   * service.ts` (combineDateAndTime) sigue con el huso Argentina fijo a
   * propósito por ahora — cambiarlo toca el camino crítico de
   * disponibilidad ya verificado, queda para una sesión propia.
   */
  timezone: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpdateBusinessProfileInput {
  displayName?: string | null | undefined;
  contactEmail?: string | null | undefined;
  currency?: string | undefined;
  timezone?: string | undefined;
}
