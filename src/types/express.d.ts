/**
 * @file express.d.ts
 * @description Augmentación del namespace de Express para inyectar
 *              las propiedades que añade tenantMiddleware() en cada request.
 *
 * ## Propiedades disponibles en req después de tenantMiddleware()
 *
 * req.db         — SqlClient conectado a la BD del tenant activo.
 *                  Presente en todas las rutas montadas después de
 *                  app.use('/api', tenantMiddleware(...)).
 *
 * req.businessId — UUID del negocio extraído del JWT.
 *                  Presente después de authenticate().
 *
 * ## Uso en handlers
 *
 * ```ts
 * router.get('/', async (req: Request, res: Response) => {
 *   const rows = await req.db.query('SELECT 1');
 *   res.json({ businessId: req.businessId });
 * });
 * ```
 *
 * ## Uso en tests
 *
 * ```ts
 * const mockReq = {
 *   db: mockSqlClient,          // SqlClient mockeado
 *   businessId: 'biz-uuid',
 * } as unknown as Request;
 * ```
 */

import { SqlClient } from '../repositories/sql.client.js';

declare global {
  namespace Express {
    interface Request {
      /**
       * SqlClient conectado a la base de datos del tenant activo.
       * Inyectado por tenantMiddleware().
       * Disponible en todas las rutas protegidas bajo /api/* (excepto /api/admin).
       */
      db: SqlClient;

      /**
       * UUID del negocio autenticado, extraído del JWT por authenticate().
       * Disponible en todas las rutas que pasan por authenticate().
       */
      businessId: string;
    }
  }
}

export {};
