import { AuthenticatedUser } from './user.types.js';
import { SqlClient } from '../repositories/sql.client.js';
 
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      /**
       * SqlClient conectado a la BD del negocio autenticado.
       * Inyectado por tenantMiddleware() después de authenticate().
       * Todos los route handlers deben usar req.db en lugar del pgClient global.
       */
      db?: SqlClient;
    }
  }
}
 
export {};
