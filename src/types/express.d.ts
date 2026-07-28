/**
 * @file express.d.ts  (src/types)
 * @description Augmentación ÚNICA del namespace de Express.
 *
 * Unifica las declaraciones que antes estaban divididas entre
 * src/security/express.d.ts y este archivo (fix M8).
 * El archivo src/security/express.d.ts fue eliminado.
 *
 * ## Propiedades disponibles en req
 *
 * req.user       — Payload del JWT (empleados y clientes).
 * req.db         — SqlClient conectado a la BD del tenant activo.
 * req.txm        — TransactionManager del tenant activo (fix C1).
 * req.businessId — UUID del negocio extraído del JWT.
 *
 * ## Uso en handlers
 *
 * ```ts
 * router.post('/', async (req: Request, res: Response) => {
 *   const result = await req.txm.run(async (tx) => {
 *     return tx.query('INSERT INTO ...');
 *   });
 *   res.json(result);
 * });
 * ```
 */

import { UserRole }          from './enums.js';
import { SqlClient }         from '../repositories/sql.client.js';
import { TransactionManager } from '../db/transaction-manager.js';

declare global {
  namespace Express {
    interface Request {
      /**
       * Payload del JWT autenticado.
       * Presente en todas las rutas que pasan por authenticate().
       */
      user?: {
        id: string;
        role: UserRole;
        /** ID del negocio (multi-tenant). Presente en tokens de empleados. */
        businessId?: string;
        /** ID del cliente (portal de clientes). Presente en tokens CUSTOMER. */
        customerId?: string;
      };

      /**
       * SqlClient conectado a la base de datos del tenant activo.
       * Inyectado por tenantMiddleware().
       */
      db: SqlClient;

      /**
       * TransactionManager del tenant activo.
       * Inyectado por tenantMiddleware() junto con req.db.
       * Usar para operaciones que requieren atomicidad (confirm/cancel/anonymize).
       */
      txm: TransactionManager;

      /**
       * UUID del negocio autenticado, extraído del JWT por authenticate().
       */
      businessId: string;
    }
  }
}

export {};
