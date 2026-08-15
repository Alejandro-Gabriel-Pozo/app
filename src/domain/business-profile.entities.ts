// =============================================================================
// domain/business-profile.entities.ts — Identidad del negocio (MAESTRO singleton)
// =============================================================================
// Ver schema.sql BLOQUE 15. Arranca mínimo (nombre + contacto) a propósito —
// solo lo que necesita el mail de reserva confirmada (punto 5/E5,
// pendientes-2026-08-15.md). Los campos fiscales de FACTURACION se agregan
// después sobre esta misma tabla, no una nueva.
// =============================================================================

export interface BusinessProfile {
  id: string;
  /** Nombre que ve el cliente en el remitente del mail — null hasta que se cargue. */
  displayName: string | null;
  /** Reply-to del mail — null hasta que se cargue. */
  contactEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpdateBusinessProfileInput {
  displayName?: string | null | undefined;
  contactEmail?: string | null | undefined;
}
