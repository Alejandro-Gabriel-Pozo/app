export enum ResourceType {
  CABIN = 'CABIN',
  TOUR_SEAT = 'TOUR_SEAT',
  RESTAURANT_TABLE = 'RESTAURANT_TABLE',
  SPA = 'SPA',
}

export enum ReservationStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
  COMPLETED = 'COMPLETED',
}

export enum TableShape {
  CIRCLE = 'CIRCLE',
  SQUARE = 'SQUARE',
  RECTANGLE = 'RECTANGLE',
}

/**
 * Roles dentro de un negocio (tenant).
 * Se incluyen en el JWT junto con el business_id.
 *
 * CUSTOMER es un rol especial: no es empleado del negocio, sino un
 * cliente externo que reserva por su cuenta desde el portal público.
 * Su JWT lleva `customer_id` en lugar de `sub` como empleado.
 */
export enum UserRole {
  ADMIN        = 'ADMIN',
  RECEPTIONIST = 'RECEPTIONIST',
  WAITER       = 'WAITER',
  CUSTOMER     = 'CUSTOMER',
}

/**
 * Roles de la plataforma (superadmin).
 * Solo para gestión interna — nunca expuestos a negocios.
 */
export enum PlatformRole {
  SUPERADMIN = 'SUPERADMIN',
}

/**
 * Planes de suscripción disponibles para los negocios.
 */
export enum BusinessPlan {
  FREE    = 'FREE',
  STARTER = 'STARTER',
  PRO     = 'PRO',
}

/**
 * Estado del negocio en la plataforma.
 */
export enum BusinessStatus {
  PENDING   = 'PENDING',
  ACTIVE    = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  CANCELLED = 'CANCELLED',
}

export enum BedPreference {
  SINGLE = 'SINGLE',
  DOUBLE = 'DOUBLE',
  KING   = 'KING',
}

export enum TableLocation {
  WINDOW  = 'WINDOW',
  TERRACE = 'TERRACE',
  INSIDE  = 'INSIDE',
}

export enum TherapistGenderPreference {
  MALE   = 'MALE',
  FEMALE = 'FEMALE',
  ANY    = 'ANY',
}
