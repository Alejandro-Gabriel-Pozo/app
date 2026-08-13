/**
 * @file admin.routes.ts
 * @description Rutas de reparación/mantenimiento puntual, ejecutadas por un
 * ADMIN sobre su propio negocio. Pensadas para no depender de acceso a
 * Shell en Render.
 *
 * ⚠️  `POST /repair-tenant-db` es una herramienta de uso único para negocios
 * sembrados directo por SQL (sin pasar por el flujo real de /register).
 * Una vez que ya no la necesites, se puede borrar este archivo y su mount
 * en app.ts sin efectos secundarios.
 *
 * ⚠️  `POST /set-tenant-url` permite apuntar manualmente el negocio a una
 * URL de BD específica (útil para Neon Tenant DB separada). Solo ADMIN.
 *
 * Ambas rutas corren applyTenantSchema() (schema.sql completo, idempotente)
 * contra la URL antes de activar el negocio — ya no hace falta correrlo a
 * mano por psql/SQL Editor como antes. Ver tenant-db.setup.ts.
 */

import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth.middleware.wrapper.js';
import type { PlatformRepository } from '../../platform/platform.repository.js';
import { encryptConnectionString, applyTenantSchema } from '../../platform/tenant-db.setup.js';
import { evictTenantPool } from '../../platform/tenant.middleware.js';
import { Roles } from '../../security/roles.js';

export function createAdminRouter(platformRepo: PlatformRepository): Router {
  const router = Router();

  // POST /api/admin/repair-tenant-db
  // Apunta el negocio del usuario autenticado a la misma DATABASE_URL que ya
  // usa el proceso (la que tiene el schema de recursos/reservas aplicado),
  // cifrándola con DB_ENCRYPTION_KEY — sin exponer ninguno de los dos
  // valores fuera del servidor.
  router.post(
    '/repair-tenant-db',
    authenticate(),
    authorize(Roles.MANAGEMENT),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const databaseUrl = process.env.DATABASE_URL;
        if (!databaseUrl) {
          res.status(500).json({
            code: 'MISSING_DATABASE_URL',
            message: 'DATABASE_URL no está definida en este proceso.',
          });
          return;
        }

        const encryptionKey = process.env.DB_ENCRYPTION_KEY;
        if (!encryptionKey) {
          res.status(500).json({
            code: 'MISSING_DB_ENCRYPTION_KEY',
            message:
              'DB_ENCRYPTION_KEY no está definida en Render. ' +
              'Agrégala en Render Dashboard → Environment → Add environment variable. ' +
              'Genera el valor con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
          });
          return;
        }

        const businessId = req.user!.businessId!;

        console.log(`[admin] repair-tenant-db iniciado para negocio ${businessId}`);

        // Corre schema.sql (idempotente) y registra la versión ANTES de
        // activar el negocio — si la BD no responde o el schema falla, mejor
        // no dejar el negocio apuntando a una tenant DB sin verificar.
        const schemaVersion = await applyTenantSchema(databaseUrl);

        const encrypted = await encryptConnectionString(databaseUrl);
        await platformRepo.activateBusiness(businessId, 'manual-demo', encrypted);
        await platformRepo.updateSchemaVersion(businessId, schemaVersion);
        // Sin esto, el pool cacheado en memoria (tenant.middleware.ts) sigue
        // usando la connection string vieja hasta que el proceso reinicie.
        await evictTenantPool(businessId);

        console.log(`[admin] ✅ Negocio ${businessId} activado correctamente (schema v${schemaVersion}).`);

        res.json({
          message: `Negocio ${businessId} activado y apuntado a DATABASE_URL.`,
          schemaVersion,
        });
      } catch (err) {
        console.error('[admin] repair-tenant-db ERROR:', err);
        next(err);
      }
    },
  );

  // POST /api/admin/set-tenant-url
  // Permite apuntar manualmente el negocio autenticado a una URL de BD específica.
  // Útil para conectar a la Tenant DB de Neon (distinta a la Platform DB).
  //
  // Body: { "databaseUrl": "postgresql://user:pass@host/db?sslmode=require" }
  //
  // ⚠️  La URL nunca se devuelve en la respuesta — solo se cifra y almacena.
  router.post(
    '/set-tenant-url',
    authenticate(),
    authorize(Roles.MANAGEMENT),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { databaseUrl } = req.body as { databaseUrl?: string };

        if (!databaseUrl || typeof databaseUrl !== 'string' || !databaseUrl.startsWith('postgresql')) {
          res.status(400).json({
            code: 'INVALID_DATABASE_URL',
            message: 'Se requiere un campo "databaseUrl" con una URL PostgreSQL válida.',
          });
          return;
        }

        const encryptionKey = process.env.DB_ENCRYPTION_KEY;
        if (!encryptionKey) {
          res.status(500).json({
            code: 'MISSING_DB_ENCRYPTION_KEY',
            message: 'DB_ENCRYPTION_KEY no está definida en Render.',
          });
          return;
        }

        const businessId = req.user!.businessId!;

        console.log(`[admin] set-tenant-url iniciado para negocio ${businessId}`);

        // Mismo criterio que repair-tenant-db: aplicar y verificar el schema
        // antes de activar el negocio contra esta URL.
        const schemaVersion = await applyTenantSchema(databaseUrl);

        const encrypted = await encryptConnectionString(databaseUrl);
        await platformRepo.activateBusiness(businessId, 'neon-tenant', encrypted);
        await platformRepo.updateSchemaVersion(businessId, schemaVersion);
        // Sin esto, el pool cacheado en memoria (tenant.middleware.ts) sigue
        // usando la connection string vieja hasta que el proceso reinicie.
        await evictTenantPool(businessId);

        console.log(`[admin] ✅ Negocio ${businessId} apuntado a URL de Tenant DB (schema v${schemaVersion}).`);

        res.json({
          message: `Negocio ${businessId} apuntado a la Tenant DB correctamente.`,
          schemaVersion,
        });
      } catch (err) {
        console.error('[admin] set-tenant-url ERROR:', err);
        next(err);
      }
    },
  );

  return router;
}
