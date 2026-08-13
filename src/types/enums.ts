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

/**
 * Módulos habilitables por negocio (add-ons de facturación modular).
 * Ver src/db/platform.schema.sql (tablas `modules` y `business_modules`)
 * y src/platform/platform.repository.ts (getBusinessModules).
 *
 * POS_RESTAURANTE y ALOJAMIENTO son módulos comercialmente distintos aunque
 * convivan en un mismo negocio (ej. un hotel con su propio restaurante) —
 * no conflacionar en un solo módulo "hospitalidad".
 *
 * ALOJAMIENTO es el único que se habilita por defecto en negocios nuevos
 * (ver PlatformRepository.createBusiness) — el resto arranca deshabilitado
 * hasta que exista una pantalla de selección/pago.
 */
export enum ModuleKey {
  REPORTES            = 'REPORTES',
  HOUSEKEEPING        = 'HOUSEKEEPING',
  CUENTAS_CORRIENTES  = 'CUENTAS_CORRIENTES',
  POS_RESTAURANTE     = 'POS_RESTAURANTE',
  FACTURACION         = 'FACTURACION',
  ALOJAMIENTO         = 'ALOJAMIENTO',
}
