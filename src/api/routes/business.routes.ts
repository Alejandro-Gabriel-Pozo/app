/**
 * @file business.routes.ts
 * @description Endpoint de registro de nuevos negocios en la plataforma.
 *
 * ## Flujo de POST /register
 * 1. Validar body con Zod
 * 2. Verificar que el slug no exista
 * 3. Resolver la identity del owner:
 *    - Si el email ya tiene una identity (persona que ya usa la plataforma
 *      en otro negocio), exigir que `ownerPassword` coincida con la
 *      contraseña existente — así puede registrar un segundo negocio con
 *      la misma cuenta en vez de fallar o pisar la contraseña de otro.
 *    - Si no existe, crear la identity nueva.
 * 4. Crear negocio en BD central (queda en PENDING — sin BD propia todavía)
 * 5. Crear membership ADMIN de la identity en el negocio nuevo
 * 6. Retornar JWT listo para usar
 *
 * ## Auto-provisioning con Neon (15/08/2026)
 * Hasta acá el negocio quedaba en PENDING sin `req.db` hasta que un ADMIN
 * activaba la BD a mano con POST /api/admin/set-tenant-url (requería crear
 * el branch de Neon a mano primero, en la consola). Ahora, después de
 * crear la membership, se llama a provisionTenantDatabase() +
 * applyTenantSchema() + activateBusiness() automáticamente — ver
 * neon-provisioning.ts para el porqué del branch plantilla.
 *
 * **Fail-open a propósito:** si el aprovisionamiento falla (rate limit de
 * Neon, API caída), el negocio queda PENDING — el mismo estado que era el
 * único resultado posible antes de este cambio, no un modo de falla nuevo.
 * `set-tenant-url`/`repair-tenant-db` (admin.routes.ts) siguen andando
 * igual que siempre como red de seguridad manual, y
 * POST /platform/businesses/:id/provision permite reintentar desde el
 * panel de superadmin sin tocar la base.
 */

import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PlatformRepository } from '../../platform/platform.repository.js';
import { hashPassword, verifyPassword } from '../../security/user.store.js';
import { signToken } from '../../security/auth.middleware.js';
import { BusinessPlan, BusinessStatus } from '../../types/enums.js';
import { provisionTenantDatabase } from '../../platform/neon-provisioning.js';
import { applyTenantSchema, encryptConnectionString } from '../../platform/tenant-db.setup.js';

/**
 * @swagger
 * components:
 *   schemas:
 *     RegisterBusiness:
 *       type: object
 *       required: [businessName, ownerEmail, ownerPassword, plan]
 *       properties:
 *         businessName:
 *           type: string
 *           example: "Spa Serenidad"
 *         ownerEmail:
 *           type: string
 *           format: email
 *         ownerPassword:
 *           type: string
 *           minLength: 8
 *         plan:
 *           type: string
 *           enum: [FREE, STARTER, PRO]
 */
const RegisterBusinessSchema = z.object({
  businessName: z.string().min(2).max(100),
  ownerEmail: z.string().email(),
  ownerPassword: z.string().min(8, { message: 'La contraseña debe tener al menos 8 caracteres' }),
  plan: z.nativeEnum(BusinessPlan).default(BusinessPlan.FREE),
});

export function createBusinessRouter(platformRepo: PlatformRepository): Router {
  const router = Router();

  /**
   * @swagger
   * /register:
   *   post:
   *     summary: Registrar un nuevo negocio en la plataforma
   *     tags: [Platform]
   *     security: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/RegisterBusiness'
   *     responses:
   *       201:
   *         description: Negocio registrado (queda PENDING hasta que se active su BD manualmente)
   *       400:
   *         description: Datos inválidos o slug ya en uso
   *       409:
   *         description: El email ya tiene una cuenta y la contraseña no coincide
   */
  router.post(
    '/',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = RegisterBusinessSchema.parse(req.body);
        const slug = generateSlug(body.businessName);

        const slugTaken = await platformRepo.findBySlug(slug);
        if (slugTaken) {
          res.status(400).json({
            code: 'BUSINESS_ALREADY_EXISTS',
            message: 'Ya existe un negocio con ese nombre',
          });
          return;
        }

        // Resolver la identity del owner ANTES de crear nada — si el email
        // ya existe y la contraseña no coincide, cortamos acá sin dejar
        // ningún registro a medias.
        const existingIdentity = await platformRepo.findIdentityByEmail(body.ownerEmail);
        let identityId: string;

        if (existingIdentity) {
          const passwordMatches = await verifyPassword(body.ownerPassword, existingIdentity.passwordHash);
          if (!passwordMatches) {
            res.status(409).json({
              code: 'EMAIL_ALREADY_REGISTERED',
              message: 'Ese email ya tiene una cuenta en la plataforma. Iniciá sesión con tu contraseña actual para registrar un negocio nuevo.',
            });
            return;
          }
          identityId = existingIdentity.id;
        } else {
          const identity = await platformRepo.createIdentity({
            id: randomUUID(),
            email: body.ownerEmail,
            passwordHash: await hashPassword(body.ownerPassword),
          });
          identityId = identity.id;
        }

        const businessId = randomUUID();
        const business = await platformRepo.createBusiness({
          id: businessId,
          name: body.businessName,
          slug,
          plan: body.plan,
          ownerEmail: body.ownerEmail,
        });

        // OWNER, no ADMIN: es quien registra el negocio. Antes esto creaba
        // ADMIN pese a que el resto del código (Roles.OWNER_ONLY,
        // DELETE /api/users/:id) asume que alguien tiene OWNER — con ADMIN acá,
        // nadie lo tenía nunca y esa ruta era inalcanzable para cualquiera.
        //
        // El rol "sistema" OWNER ya existe acá — createBusiness() lo
        // provisiona internamente (provisionSystemRoles(), 14/08/2026,
        // mismo criterio que provisionDefaultModules()) antes de retornar.
        const roles = await platformRepo.listRolesByBusiness(businessId);
        const ownerRole = roles.find((r) => r.name === 'OWNER');
        if (!ownerRole) {
          throw new Error(`[register] El negocio ${businessId} no tiene rol OWNER provisionado — revisar provisionSystemRoles().`);
        }

        await platformRepo.createMembership({
          id: randomUUID(),
          identityId,
          businessId,
          roleId: ownerRole.id,
        });

        // Aprovisionamiento automático — ver comentario de archivo. No
        // relanzar en el catch: el negocio queda PENDING (mismo resultado
        // que antes de este cambio) y sigue siendo reintentable a mano o
        // desde el panel de superadmin.
        let finalStatus: BusinessStatus = business.status;
        try {
          const { connectionString } = await provisionTenantDatabase(business.slug);
          const schemaVersion = await applyTenantSchema(connectionString);
          const encrypted     = await encryptConnectionString(connectionString);
          await platformRepo.activateBusiness(businessId, 'neon-branch', encrypted);
          await platformRepo.updateSchemaVersion(businessId, schemaVersion);
          finalStatus = BusinessStatus.ACTIVE;
        } catch (provisionErr) {
          console.error(`[register] Aprovisionamiento falló para ${businessId}, queda PENDING:`, provisionErr);
        }

        // El JWT de staff ya no lleva `role` (ver security/roles.ts) — los
        // permisos se resuelven en cada request contra role_permission_groups.
        const jwtSecret = process.env.JWT_SECRET!;
        const token = signToken(
          { sub: identityId, business_id: businessId },
          jwtSecret,
        );

        const message = finalStatus === BusinessStatus.ACTIVE
          ? 'Negocio registrado y listo para usar.'
          : 'Negocio registrado. Todavía falta activar su base de datos — contactá a soporte para completar el alta antes de operar.';

        if (finalStatus !== BusinessStatus.ACTIVE) {
          console.log(`[register] Negocio ${businessId} creado (PENDING) — falta activar su BD.`);
        }

        res.status(201).json({
          message,
          business: { id: business.id, name: business.name, slug: business.slug, plan: business.plan, status: finalStatus },
          token,
          tokenType: 'Bearer',
          expiresIn: 86_400,
          user: { id: identityId, email: body.ownerEmail, role: ownerRole.name },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}
