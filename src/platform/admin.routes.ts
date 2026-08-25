/**
 * @file admin.routes.ts
 * @description Rutas de reparación/mantenimiento puntual sobre un negocio.
 * Pensadas para no depender de acceso a Shell en Render.
 *
 * ⚠️  `POST /repair-tenant-db` es una herramienta de uso único para negocios
 * sembrados directo por SQL (sin pasar por el flujo real de /register).
 * Una vez que ya no la necesites, se puede borrar este archivo y su mount
 * en app.ts sin efectos secundarios.
 *
 * ⚠️  `POST /set-tenant-url` permite apuntar manualmente un negocio a una
 * URL de BD específica (útil para Neon Tenant DB separada) — es, a
 * propósito, el paso manual con el que hoy se activa un negocio nuevo tras
 * `POST /platform/businesses` (ver comentario en platform.routes.ts).
 *
 * Ambas rutas corren applyTenantSchema() (schema.sql completo, idempotente)
 * contra la URL antes de activar el negocio — ya no hace falta correrlo a
 * mano por psql/SQL Editor como antes. Ver tenant-db.setup.ts.
 *
 * ## Auth — token de PLATAFORMA, no de tenant (19/08/2026, auditoría de producto)
 * Hasta acá las dos rutas exigían `Roles.MANAGEMENT` de TENANT —
 * `req.user!.businessId!` se tomaba del propio JWT del que llamaba, así
 * que CUALQUIER OWNER/ADMIN de CUALQUIER negocio podía reapuntar su propio
 * negocio (y `set-tenant-url` acepta una URL arbitraria en el body: el
 * servidor termina conectándose a lo que sea que mande el caller). Ahora
 * exigen `authenticatePlatform()` (PLATFORM_JWT_SECRET, mismo mecanismo que
 * `/platform/*`) — un superadmin, no un dueño de negocio. Como un superadmin
 * no pertenece a ningún negocio, `businessId` pasa a ser un campo explícito
 * del body en vez de inferirse de `req.user`. Efecto en el flujo: activar un
 * negocio nuevo ahora requiere acceso de plataforma, ya no lo puede hacer el
 * propio dueño del negocio solo (cambio de flujo confirmado explícitamente
 * con el dueño antes de este commit — antes esto era autoservicio).
 */

import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { authenticatePlatform, authorizePlatform } from './platform.auth.middleware.js';
import type { PlatformRepository } from './platform.repository.js';
import { encryptConnectionString, applyTenantSchema } from './tenant-db.setup.js';
import { evictTenantPool } from './tenant.middleware.js';
import { PlatformRole } from '../types/enums.js';
import { logger } from '../logger.js';

const RepairTenantDbSchema = z.object({
  businessId: z.string().min(1),
});

const SetTenantUrlSchema = z.object({
  businessId: z.string().min(1),
  databaseUrl: z.string().min(1).startsWith('postgresql'),
});

export function createAdminRouter(platformRepo: PlatformRepository): Router {
  const router = Router();

  router.use(authenticatePlatform(), authorizePlatform([PlatformRole.SUPERADMIN]));

  // POST /api/admin/repair-tenant-db
  // Apunta el negocio indicado a la misma DATABASE_URL que ya usa el proceso
  // (la que tiene el schema de recursos/reservas aplicado), cifrándola con
  // DB_ENCRYPTION_KEY — sin exponer ninguno de los dos valores fuera del servidor.
  router.post(
    '/repair-tenant-db',
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

        const { businessId } = RepairTenantDbSchema.parse(req.body);

        logger.info({ businessId }, '[admin] repair-tenant-db iniciado');

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

        logger.info({ businessId, schemaVersion }, '[admin] Negocio activado correctamente.');

        res.json({
          message: `Negocio ${businessId} activado y apuntado a DATABASE_URL.`,
          schemaVersion,
        });
      } catch (err) {
        logger.error({ err }, '[admin] repair-tenant-db ERROR');
        next(err);
      }
    },
  );

  // POST /api/admin/set-tenant-url
  // Permite apuntar manualmente el negocio indicado a una URL de BD específica.
  // Útil para conectar a la Tenant DB de Neon (distinta a la Platform DB).
  //
  // Body: { "businessId": "...", "databaseUrl": "postgresql://user:pass@host/db?sslmode=require" }
  //
  // ⚠️  La URL nunca se devuelve en la respuesta — solo se cifra y almacena.
  router.post(
    '/set-tenant-url',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const encryptionKey = process.env.DB_ENCRYPTION_KEY;
        if (!encryptionKey) {
          res.status(500).json({
            code: 'MISSING_DB_ENCRYPTION_KEY',
            message: 'DB_ENCRYPTION_KEY no está definida en Render.',
          });
          return;
        }

        const { businessId, databaseUrl } = SetTenantUrlSchema.parse(req.body);

        logger.info({ businessId }, '[admin] set-tenant-url iniciado');

        // Mismo criterio que repair-tenant-db: aplicar y verificar el schema
        // antes de activar el negocio contra esta URL.
        const schemaVersion = await applyTenantSchema(databaseUrl);

        const encrypted = await encryptConnectionString(databaseUrl);
        await platformRepo.activateBusiness(businessId, 'neon-tenant', encrypted);
        await platformRepo.updateSchemaVersion(businessId, schemaVersion);
        // Sin esto, el pool cacheado en memoria (tenant.middleware.ts) sigue
        // usando la connection string vieja hasta que el proceso reinicie.
        await evictTenantPool(businessId);

        logger.info({ businessId, schemaVersion }, '[admin] Negocio apuntado a URL de Tenant DB.');

        res.json({
          message: `Negocio ${businessId} apuntado a la Tenant DB correctamente.`,
          schemaVersion,
        });
      } catch (err) {
        logger.error({ err }, '[admin] set-tenant-url ERROR');
        next(err);
      }
    },
  );

  return router;
}
