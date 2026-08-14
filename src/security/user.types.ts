import type { UserRole } from '../types/enums.js';

/**
 * Usuario autenticado adjuntado a req.user por authenticate().
 *
 * ## Roles (14/08/2026 — ver security/roles.ts)
 * `role` ya NO es el rol del staff — solo se usa como discriminador para
 * tokens CUSTOMER (`role === UserRole.CUSTOMER`). El staff se identifica
 * por `roleId` (FK a `roles`) y `permissionGroups` (resuelto en cada
 * request, nunca cacheado en el JWT — mismo criterio anti-staleness que ya
 * usaba `isMembershipActive`).
 */
export interface AuthenticatedUser {
  id: string;
  /** Presente SOLO en tokens CUSTOMER — discrimina el tipo de sesión. */
  role?: UserRole;
  /** FK a roles.id — presente SOLO en tokens de staff (business_id presente). */
  roleId?: string;
  /**
   * Grupos de permisos del rol actual, resueltos en authenticate() contra
   * role_permission_groups en cada request. Presente SOLO en tokens de
   * staff. `authorize()` lo consulta en vez de comparar `role` contra un
   * array fijo.
   */
  permissionGroups?: string[];
  /** ID del negocio al que pertenece — usado por tenantMiddleware para conectar a la BD correcta */
  businessId?: string;
  /** ID del Customer entity — presente solo en tokens CUSTOMER */
  customerId?: string;
}
