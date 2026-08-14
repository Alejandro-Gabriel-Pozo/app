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

import type { AuthenticatedUser } from '../security/user.types.js';
import type { SqlClient }         from '../repositories/sql.client.js';
import type { TransactionManager } from '../db/transaction-manager.js';

declare global {
  namespace Express {
    interface Request {
      /**
       * Payload del JWT autenticado, resuelto por authenticate().
       * Reusa AuthenticatedUser (security/user.types.ts) en vez de
       * declarar su propia forma acá — hasta el 14/08/2026 este archivo
       * tenía una copia inline que había que mantener sincronizada a mano
       * con user.types.ts (mismo tipo de duplicación que ya causó un bug
       * real con CategoryNotFoundError esa misma sesión, ver
       * pendientes-2026-08-14.md C2).
       */
      user?: AuthenticatedUser;

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
