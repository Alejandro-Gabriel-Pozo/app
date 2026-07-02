import { UserRole } from '../types/enums.js';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        role: UserRole;
        /** ID del negocio (multi-tenant). Presente en tokens de empleados. */
        businessId?: string;
        /** ID del cliente (portal de clientes). Presente en tokens CUSTOMER. */
        customerId?: string;
      };
    }
  }
}

export {};
