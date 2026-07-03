import { UserRole } from '../types/enums.js';
import { SqlClient } from '../repositories/sql.client.js';

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
      /**
       * Conexión a la BD del tenant autenticado.
       * Inyectada por tenantMiddleware() después de authenticate().
       * Solo presente en rutas de empleados — no disponible en el portal de clientes.
       */
      db?: SqlClient;
    }
  }
}

export {};
