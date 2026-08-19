// =============================================================================
// domain/business-profile.entities.ts — Identidad del negocio (MAESTRO singleton)
// =============================================================================
// Ver schema.sql BLOQUE 15. Arrancó mínimo (nombre + contacto) a propósito —
// solo lo que necesitaba el mail de reserva confirmada (punto 5/E5,
// pendientes-2026-08-15.md). Sumó currency/timezone el 17/08/2026
// (auditoría de hardcodes, pendientes-2026-08-17.md sección F3). Sumó el
// perfil fiscal el 18/08/2026 (Facturación Electrónica AFIP, Fase 1 —
// docs/referencia-afip-wsfev1.md), tal como este comentario ya anticipaba:
// sobre esta misma tabla, no una nueva.
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
   * — antes vivía hardcodeado en email/templates.ts. Desde el 18/08/2026,
   * `reservation.service.ts` (combineDateAndTime) también lo usa para el
   * camino crítico de disponibilidad (antes tenía el huso de Argentina
   * fijo a propósito) — ver docblock de esa función para el detalle de DST.
   */
  timezone: string;
  /**
   * Hora de pared (A4.3, criterios-negocio.md), política general del
   * negocio — "check-in a las 14" es 14 local siempre, no un instante.
   * 18/08/2026, flujo de check-in/check-out (pendientes-2026-08-18.md
   * punto N). Formato HH:MM:SS.
   */
  defaultCheckInTime: string;
  defaultCheckOutTime: string;
  /**
   * Perfil fiscal del negocio EMISOR (18/08/2026, Facturación Electrónica
   * AFIP, Fase 1 — docs/referencia-afip-wsfev1.md). Mismos nombres que
   * `customer_tax_profiles` (A5.1) — esa tabla resuelve el lado
   * comprador de una factura, esta resuelve el emisor. Todo `null` hasta
   * que el dueño del negocio lo cargue en Mi Negocio; sin esto no hay con
   * qué autenticarse ni qué mandar en la cabecera de un comprobante AFIP.
   */
  legalName: string | null;
  taxId: string | null;
  taxIdType: string | null;
  taxCondition: string | null;
  fiscalAddressLine1: string | null;
  fiscalAddressCity: string | null;
  fiscalAddressState: string | null;
  fiscalAddressPostalCode: string | null;
  fiscalAddressCountry: string | null;
  /** Punto de Venta (terminología AFIP) — un solo punto de venta por ahora, ver schema.sql. */
  afipSalesPoint: number | null;
  /**
   * CUIT con el que autenticarse contra AFIP -- `null` = usar `taxId` (el
   * caso normal: el negocio se autentica como sí mismo). Distinto de
   * `taxId` a propósito (19/08/2026, hallazgo real durante Fase 2):
   * homologación de AFIP a veces exige un CUIT de testing ficticio,
   * independiente del CUIT legal real -- pisar `taxId` con ese valor
   * ensuciaría "Datos fiscales" (identidad legal real que se muestra en
   * Mi Negocio). Este campo permite separar "con qué CUIT hablo con AFIP"
   * de "cuál es mi identidad fiscal real", sin que uno tape al otro.
   */
  afipCuit: string | null;
  /**
   * Conexión real a AFIP (19/08/2026, Fase 2). Confirmado con el dueño
   * (A2.9 — config real, nunca una constante): HOY sus precios de
   * catálogo YA incluyen IVA, alícuota general 21%. Ninguno de los dos es
   * un supuesto del sistema, son estos dos campos. El certificado/clave/
   * ticket de WSAA NO viven acá — `AfipCredentialsRepository` los maneja
   * aparte, nunca deben poder salir por este mismo camino (GET
   * /api/business-profile expone el resto del perfil entero).
   */
  defaultIvaRate: number;
  pricesIncludeIva: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpdateBusinessProfileInput {
  displayName?: string | null | undefined;
  contactEmail?: string | null | undefined;
  currency?: string | undefined;
  timezone?: string | undefined;
  defaultCheckInTime?: string | undefined;
  defaultCheckOutTime?: string | undefined;
  legalName?: string | null | undefined;
  taxId?: string | null | undefined;
  taxIdType?: string | null | undefined;
  taxCondition?: string | null | undefined;
  fiscalAddressLine1?: string | null | undefined;
  fiscalAddressCity?: string | null | undefined;
  fiscalAddressState?: string | null | undefined;
  fiscalAddressPostalCode?: string | null | undefined;
  fiscalAddressCountry?: string | null | undefined;
  afipSalesPoint?: number | null | undefined;
  afipCuit?: string | null | undefined;
  defaultIvaRate?: number | undefined;
  pricesIncludeIva?: boolean | undefined;
}
