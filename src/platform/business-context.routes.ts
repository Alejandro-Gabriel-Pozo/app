/**
 * @file business-context.routes.ts
 * @description Fase 4 Bloque 4B — `GET /api/business/context`.
 *
 * Contexto que consume el shell del dashboard de staff: capacidades
 * efectivas, colores por módulo, terminología resuelta, grupos de permiso,
 * y `currency`/`timezone`/prefijos de numeración del negocio.
 *
 * ## Montaje (ver app.ts)
 *
 * Va DESPUÉS de `tenantMiddleware` + `apiLimiter` — necesita `req.db` para
 * leer `business_profile` (a diferencia de `/api/business/modules`, que va
 * antes). `authorize(Roles.STAFF)` deja fuera a los tokens `CUSTOMER`:
 * `tenantMiddleware` tampoco les setea `req.db`, y el contexto del portal de
 * clientes es otro contrato.
 *
 * ## Respuestas
 *
 * - **200** — `{ ...ContextPayloadCore, currency, timezone,
 *   reservationNumberPrefix, customerNumberPrefix, permissionGroups }`.
 *   **13 claves exactas**, congeladas por el test de conjunto en
 *   `business-context.routes.test.ts`. Contrato D-A: sin `navigation` /
 *   `href` / `icon` / `managementOnly` (eso es catálogo local del
 *   frontend). `locale` es `'es-AR'` (D6).
 * - **404 `BUSINESS_NOT_FOUND`** — `getContextInputs` devolvió `null` (el
 *   negocio no existe). En la práctica `tenantMiddleware` ya lo cortó antes;
 *   esto cubre la race de un borrado entre medio.
 * - **503 `PLATFORM_UNAVAILABLE`** — `ContextDataError`: forma SQL rota
 *   (columna ausente, `NULL` no permitido, agregado no-array, item
 *   incompleto) o dominio inválido (`plan` / `source` / `contextColor` /
 *   `deletedAt`). El `errorHandler` global no reconoce `ContextDataError`,
 *   por eso se captura acá.
 * - **500 `INTERNAL_ERROR`** — `business_profile` sin la fila `'default'`
 *   (`SqlBusinessProfileRepository.get()` lanza `Error` genérico), u otro
 *   fallo no previsto. Va por `next(err)` -> `errorHandler`.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { authorize } from '../security/auth.middleware.js';
import { Roles } from '../security/roles.js';
import { SqlBusinessProfileRepository } from '../repositories/sql.business-profile.repository.js';
import { loadBusinessContextCore } from '../business-context/context.adapter.js';
import { ContextDataError } from '../business-context/context.errors.js';
import type { PlatformRepository } from './platform.repository.js';

export function createBusinessContextRouter(
  platformRepo: Pick<PlatformRepository, 'getContextInputs'>,
): Router {
  const router = Router();

  router.get(
    '/',
    authorize(Roles.STAFF),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        // businessId SIEMPRE de req.businessId (lo setea tenantMiddleware
        // desde el JWT). Ningún parámetro de URL/body/query selecciona el
        // negocio.
        const core = await loadBusinessContextCore(req.businessId, platformRepo);

        if (core === null) {
          res.status(404).json({ code: 'BUSINESS_NOT_FOUND', message: 'Negocio no encontrado.' });
          return;   // no se consulta business_profile
        }

        // Destructuring EXPLÍCITO, nunca spread de BusinessProfile: esa entidad
        // trae `taxId`, `taxCondition`, `afipCuit`, `afipSalesPoint` y el resto
        // del perfil fiscal, y este endpoint es `Roles.STAFF`. Spreadearla
        // filtraría datos fiscales a recepción. El test de conjunto exacto de
        // claves es la cerca que lo detecta si alguien cambia esta línea.
        const {
          currency,
          timezone,
          reservationNumberPrefix,
          customerNumberPrefix,
        } = await new SqlBusinessProfileRepository(req.db!).get();

        res.json({
          ...core,                                      // businessId, industryKey, industryName,
                                                        // enabledModules, moduleSources, moduleColors,
                                                        // terminology, locale
          currency,
          timezone,
          // D6 (01/09/2026) — prefijos del número operativo. Van acá y no en un
          // endpoint propio porque son configuración de PRESENTACIÓN por
          // negocio, de la misma naturaleza que `currency`/`timezone`, y este
          // contrato ya lee `business_profile`. Un endpoint nuevo habría
          // sumado un call-site de `authorize`, un round-trip en la pantalla
          // más usada, y un segundo lector del mismo concepto.
          reservationNumberPrefix,
          customerNumberPrefix,
          permissionGroups: req.user?.permissionGroups ?? [],
        });
      } catch (err) {
        if (err instanceof ContextDataError) {
          res.status(503).json({
            code:    'PLATFORM_UNAVAILABLE',
            message: 'No se pudo resolver el contexto del negocio.',
          });
          return;
        }
        next(err);
      }
    },
  );

  return router;
}
