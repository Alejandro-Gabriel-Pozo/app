/**
 * @file roles.ts
 * @description Grupos de roles reutilizables para el middleware `authorize()`.
 *
 * Uso en rutas:
 *   import { Roles } from '../security/roles.js';
 *   router.get('/reservations', authenticate(), authorize(Roles.STAFF), handler);
 *
 * Regla: los grupos son arrays `readonly` para que TypeScript los trate
 * como tuplas de literales y `authorize()` pueda hacer includes() en ellos.
 */

import { UserRole } from '../types/enums.js';

export const Roles = {
  /** Propietario solamente — configuración de plan, facturación */
  OWNER_ONLY: [UserRole.OWNER] as const,

  /** Propietario + Admin — gestión operativa completa */
  MANAGEMENT: [UserRole.OWNER, UserRole.ADMIN] as const,

  /** Todo el personal interno del negocio (excluye CUSTOMER) */
  STAFF: [
    UserRole.OWNER,
    UserRole.ADMIN,
    UserRole.RECEPTIONIST,
    UserRole.HOUSEKEEPING,
    UserRole.WAITER,
  ] as const,

  /** Personal de front-desk: gestiona reservas y clientes */
  FRONT_DESK: [
    UserRole.OWNER,
    UserRole.ADMIN,
    UserRole.RECEPTIONIST,
  ] as const,

  /** Housekeeping + management: ven y actualizan estado de habitaciones */
  HOUSEKEEPING_AND_MANAGEMENT: [
    UserRole.OWNER,
    UserRole.ADMIN,
    UserRole.HOUSEKEEPING,
  ] as const,

  /** Acceso a órdenes de consumo */
  ORDERS: [
    UserRole.OWNER,
    UserRole.ADMIN,
    UserRole.WAITER,
  ] as const,

  /** Solo clientes externos */
  CUSTOMER_ONLY: [UserRole.CUSTOMER] as const,

  /** Clientes + recepción (reservas desde portal o mostrador) */
  BOOKING: [
    UserRole.OWNER,
    UserRole.ADMIN,
    UserRole.RECEPTIONIST,
    UserRole.CUSTOMER,
  ] as const,
} as const;
