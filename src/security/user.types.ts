import { UserRole } from '../types/enums.js';
 
/**
 * Usuario autenticado adjuntado a req.user por authenticate().
 * Ahora incluye businessId para el tenant middleware.
 */
export interface AuthenticatedUser {
  id: string;
  role: UserRole;
  /** ID del negocio al que pertenece — usado por tenantMiddleware para conectar a la BD correcta */
  businessId?: string;
}
