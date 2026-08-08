export enum ReservationStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
  COMPLETED = 'COMPLETED',
}

/**
 * Roles dentro de un negocio (tenant).
 * Se incluyen en el JWT junto con el business_id.
 *
 * OWNER        — propietario del negocio: acceso total a su tenant, igual que ADMIN
 *                pero además puede ver facturación y configuración del plan.
 * ADMIN        — administrador operativo: gestión completa excepto facturación.
 * RECEPTIONIST — recepción: reservas, check-in/out, clientes. Sin acceso a reportes ni config.
 * HOUSEKEEPING — mucama / limpieza: solo lectura del estado de habitaciones y tareas asignadas.
 * WAITER       — mozo: órdenes de consumo. Sin acceso a reservas ni config.
 * CUSTOMER     — cliente externo que reserva desde el portal público.
 *                Su JWT lleva `customer_id` en lugar de `sub` como empleado.
 */
export enum UserRole {
  OWNER        = 'OWNER',
  ADMIN        = 'ADMIN',
  RECEPTIONIST = 'RECEPTIONIST',
  HOUSEKEEPING = 'HOUSEKEEPING',
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
 * Los límites de cada plan están definidos en src/config/plan-limits.ts
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
