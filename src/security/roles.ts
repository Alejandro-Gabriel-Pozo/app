/**
 * @file roles.ts
 * @description Catálogo fijo de grupos de permisos para `authorize()`.
 *
 * Uso en rutas — SIN CAMBIOS respecto a antes del 14/08/2026:
 *   import { Roles } from '../security/roles.js';
 *   router.get('/reservations', authenticate(), authorize(Roles.STAFF), handler);
 *
 * ## Qué cambió (Gap analysis - Tango ERP vs modelo actual.md #2)
 * Antes, cada valor de `Roles.X` era un array de `UserRole` fijo en código
 * (`[OWNER, ADMIN]`) y `authorize()` comparaba el `role` del JWT contra ese
 * array. Ahora cada valor es solo el NOMBRE del grupo — un string — y
 * `authorize()` chequea si el `role_id` del membership actual tiene ese
 * grupo asignado en `role_permission_groups` (tabla, editable por negocio
 * sin deploy). Los ~101 call-sites de `authorize(Roles.X)` en las rutas NO
 * se tocaron: siguen recibiendo lo mismo que devuelve `Roles.X`, solo
 * cambió qué tipo de dato es ese valor.
 *
 * Agregar un grupo nuevo SIGUE siendo un cambio de código (una ruta nueva
 * necesita un `Roles.X` nuevo) — lo que se volvió dinámico es qué rol
 * pertenece a qué grupo(s), no el catálogo de grupos en sí. Ver BLOQUE
 * ROLES en platform.schema.sql para el razonamiento completo.
 */

export const Roles = {
  /** Propietario solamente — configuración de plan, facturación */
  OWNER_ONLY: 'OWNER_ONLY',

  /** Gestión operativa completa */
  MANAGEMENT: 'MANAGEMENT',

  /** Todo el personal interno del negocio (excluye CUSTOMER) */
  STAFF: 'STAFF',

  /** Personal de front-desk: gestiona reservas y clientes */
  FRONT_DESK: 'FRONT_DESK',

  /** Housekeeping + management: ven y actualizan estado de habitaciones */
  HOUSEKEEPING_AND_MANAGEMENT: 'HOUSEKEEPING_AND_MANAGEMENT',

  /** Acceso a órdenes de consumo */
  ORDERS: 'ORDERS',

  /**
   * Emite la Nota de Crédito de cancelación (escape de la guarda fiscal
   * fail-closed de `cancelOrder()` / `cancelReservation()`). Dedicado a
   * propósito: recepción lo tiene sin ser `MANAGEMENT` — ADR
   * `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` §10 q7.
   * Precedente ERP: ERPNext/Odoo ponen la emisión de NC por debajo del
   * tier gerencial.
   *
   * Nombre en español (no la convención inglesa del resto del catálogo):
   * decisión explícita del dueño, elegido del menú de q7
   * (`CREDIT_NOTE_ISSUER` / `EMISOR_NOTA_CREDITO`), alineado al término
   * AFIP "Nota de Crédito". Es una clave técnica estable que queda en
   * `role_permission_groups.permission_group` de cada tenant — cambiarla
   * después es una migración de datos.
   */
  EMISOR_NOTA_CREDITO: 'EMISOR_NOTA_CREDITO',

  /**
   * Solo clientes externos. Caso especial en `authorize()`: los clientes
   * no tienen `role_id` (no son staff, no tienen fila en `roles`) — este
   * grupo y BOOKING se resuelven en código, no contra la BD.
   */
  CUSTOMER_ONLY: 'CUSTOMER_ONLY',

  /** Clientes + recepción (reservas desde portal o mostrador) */
  BOOKING: 'BOOKING',
} as const;

export type PermissionGroup = (typeof Roles)[keyof typeof Roles];

/**
 * Grupos que un token CUSTOMER puede cumplir — hardcodeado a propósito
 * (los clientes no tienen role_id contra el que resolver esto en la BD).
 * Mantener sincronizado a mano si algún día un grupo nuevo debe incluir
 * clientes — no hay forma de derivarlo automáticamente sin una entidad
 * "rol de cliente", que no existe ni hace falta hoy.
 */
export const CUSTOMER_PERMISSION_GROUPS: readonly PermissionGroup[] = [
  Roles.CUSTOMER_ONLY,
  Roles.BOOKING,
];
