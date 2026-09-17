/**
 * @file admin.routes.ts
 * @description Rutas de reparación/mantenimiento puntual sobre un negocio.
 * Pensadas para no depender de acceso a Shell en Render.
 *
 * ⚠️  `POST /set-tenant-url` permite apuntar manualmente un negocio a una
 * URL de BD específica (útil para Neon Tenant DB separada) — es, a
 * propósito, el paso manual con el que hoy se activa un negocio nuevo tras
 * `POST /platform/businesses` (ver comentario en platform.routes.ts).
 *
 * Corre applyTenantSchema() (schema.sql completo, idempotente) contra la
 * URL antes de activar el negocio — ya no hace falta correrlo a mano por
 * psql/SQL Editor como antes. Ver tenant-db.setup.ts.
 *
 * ## `repair-tenant-db` retirado (16/09/2026, D-06/P-04, Wave 7 del plan de
 * ejecución integral, `docs/decisiones-plan-integral-2026-09-16.md:63-68`)
 * Existía para apuntar el negocio indicado a la `DATABASE_URL` del propio
 * proceso — una variable no declarada en `render.yaml`. El endpoint
 * respondía siempre `500 MISSING_DATABASE_URL` (esa var nunca se seteó en
 * producción), pero seguía siendo una trampa armada: si alguien la
 * completaba con la única connection string "a mano" que tiene un proceso
 * de plataforma — la de la BD central —, este endpoint hubiera aplicado
 * `schema.sql` (schema de TENANT) contra la BD de PLATAFORMA. `set-tenant-url`
 * ya cubre la misma capacidad (apuntar un negocio a una connection string)
 * con la URL explícita en el body, sin depender de ninguna variable de
 * entorno ambigua — retirar el endpoint es de menor radio que renombrar la
 * variable + agregar una guarda.
 *
 * ## Auth — token de PLATAFORMA, no de tenant (19/08/2026, auditoría de producto)
 * Hasta acá esta ruta exigía `Roles.MANAGEMENT` de TENANT —
 * `req.user!.businessId!` se tomaba del propio JWT del que llamaba, así
 * que CUALQUIER OWNER/ADMIN de CUALQUIER negocio podía reapuntar su propio
 * negocio (y `set-tenant-url` acepta una URL arbitraria en el body: el
 * servidor termina conectándose a lo que sea que mande el caller). Ahora
 * exige `authenticatePlatform()` (PLATFORM_JWT_SECRET, mismo mecanismo que
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
import { getDbEncryptionKey } from '../config/env.js';

const SetTenantUrlSchema = z.object({
  businessId: z.string().min(1),
  databaseUrl: z.string().min(1).startsWith('postgresql'),
});

export function createAdminRouter(platformRepo: PlatformRepository): Router {
  const router = Router();

  router.use(authenticatePlatform(), authorizePlatform([PlatformRole.SUPERADMIN]));

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
        const encryptionKey = getDbEncryptionKey();
        if (!encryptionKey) {
          res.status(500).json({
            code: 'MISSING_DB_ENCRYPTION_KEY',
            message: 'DB_ENCRYPTION_KEY no está definida en Render.',
          });
          return;
        }

        const { businessId, databaseUrl } = SetTenantUrlSchema.parse(req.body);

        logger.info({ businessId }, '[admin] set-tenant-url iniciado');

        // Aplicar y verificar el schema antes de activar el negocio contra
        // esta URL — nunca activar un negocio contra una BD sin confirmar.
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
