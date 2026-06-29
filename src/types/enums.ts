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
 */
export enum UserRole {
  ADMIN = 'ADMIN',             // Admin del negocio — acceso total a su tenant
  RECEPTIONIST = 'RECEPTIONIST',
  WAITER = 'WAITER',
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
 * Determina límites de recursos, staff, y funcionalidades.
 */
export enum BusinessPlan {
  FREE    = 'FREE',     // Hasta 2 negocios en Supabase free tier
  STARTER = 'STARTER', // $25/mes — Supabase Pro
  PRO     = 'PRO',     // Funcionalidades ERP/CRM (futuro)
}
 
/**
 * Estado del negocio en la plataforma.
 */
export enum BusinessStatus {
  PENDING    = 'PENDING',    // Registrado, BD en provisioning
  ACTIVE     = 'ACTIVE',     // BD lista, operativo
  SUSPENDED  = 'SUSPENDED',  // Pago vencido o suspendido manualmente
  CANCELLED  = 'CANCELLED',  // Dado de baja
}
 
export enum BedPreference {
  SINGLE = 'SINGLE',
  DOUBLE = 'DOUBLE',
  KING = 'KING',
}
 
export enum TableLocation {
  WINDOW = 'WINDOW',
  TERRACE = 'TERRACE',
  INSIDE = 'INSIDE',
}
 
export enum TherapistGenderPreference {
  MALE = 'MALE',
  FEMALE = 'FEMALE',
  ANY = 'ANY',
}
