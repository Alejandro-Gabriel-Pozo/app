/**
 * @file reservation-customer.entities.ts
 * @description Representación mínima de "quién reservó", propia del
 * bounded context `reservas/` (Fase 7, docs/auditoria-modularidad.md,
 * hallazgo D1 — la entidad `Reservation` importaba y embebía la clase
 * rica `Customer` de `clientes-finanzas/` completa, con invariantes de
 * ESE contexto — `kind`, `contactMethods[]`, `active` — que reservas
 * nunca lee).
 *
 * No es una entidad nueva ni un maestro: es un value object que
 * representa exactamente lo que `reservations.customer_id`/
 * `customer_name`/`customer_email` ya guardan a nivel de columna — el
 * "congelado" de R9 (criterios-datos.md: "una transacción congela lo que
 * necesita del maestro"). Ese congelado ya existía en la base; este
 * cambio solo hace que el modelo TypeScript deje de mentir sobre su
 * forma real.
 *
 * Decisión de negocio confirmada por el dueño (18/08/2026): identidad
 * básica (`customers`) y perfil fiscal (`customer_tax_profiles` — CUIT,
 * razón social, condición IVA) son conceptos separados a propósito.
 * Reservas nunca necesita el perfil fiscal — si algún día hace falta
 * (ej. Facturación), se resuelve por `customerId` contra
 * `clientes-finanzas`, no se carga acá de entrada.
 *
 * Sin clase ni validación propia (a diferencia de `Customer`, que sí
 * valida id/displayName/formato de email en su constructor): esos datos
 * ya se validaron una vez, en `clientes-finanzas`, cuando el cliente
 * maestro se creó. Revalidar acá sería trabajo redundante sin un
 * escenario de fallo real que lo justifique.
 */

export interface ReservationCustomer {
  id: string;
  fullName: string;
  email?: string | undefined;
}
