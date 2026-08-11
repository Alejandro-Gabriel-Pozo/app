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
 * 4. Crear negocio en BD central (estado PENDING)
 * 5. Provisionar BD en Supabase (async — puede tardar 2-3 min)
 * 6. Ejecutar schema.sql en la nueva BD (via loadTenantSchema)
 * 7. Activar negocio en BD central (estado ACTIVE)
 * 8. Crear membership ADMIN de la identity en el negocio nuevo
 * 9. Retornar JWT listo para usar
 */

import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlatformRepository } from '../../platform/platform.repository.js';
import {
  provisionBusinessDatabase,
  runSchemaOnNewDatabase,
  encryptConnectionString,
  loadTenantSchema,
} from '../../platform/supabase.provisioner.js';
import { hashPassword, verifyPassword } from '../../security/user.store.js';
import { signToken } from '../../security/auth.middleware.js';
import { BusinessPlan, UserRole } from '../../types/enums.js';

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
   *         description: Negocio registrado y BD provisionada
   *       400:
   *         description: Datos inválidos o email/slug ya en uso
   *       503:
   *         description: Error provisionando la BD en Supabase
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

        console.log(`[register] Negocio creado: ${businessId} — iniciando provisioning...`);

        let provisioned;
        try {
          provisioned = await provisionBusinessDatabase(businessId, body.businessName);
        } catch (err) {
          console.error(`[register] Error provisionando BD para ${businessId}:`, err);
          res.status(503).json({
            code: 'PROVISIONING_ERROR',
            message: 'Error creando la base de datos. Por favor contactá soporte.',
          });
          return;
        }

        const schemaSQL = await loadTenantSchema();
        await runSchemaOnNewDatabase(provisioned.connectionString, schemaSQL);

        const dbUrlEncrypted = await encryptConnectionString(provisioned.connectionString);
        await platformRepo.activateBusiness(businessId, provisioned.projectId, dbUrlEncrypted);

        await platformRepo.createMembership({
          id: randomUUID(),
          identityId,
          businessId,
          role: UserRole.ADMIN,
        });

        const jwtSecret = process.env.JWT_SECRET!;
        const token = signToken(
          { sub: identityId, role: UserRole.ADMIN, business_id: businessId },
          jwtSecret,
        );

        console.log(`[register] ✅ Negocio ${businessId} activo — membership admin creada`);

        res.status(201).json({
          message: 'Negocio registrado exitosamente',
          business: { id: business.id, name: business.name, slug: business.slug, plan: business.plan },
          token,
          tokenType: 'Bearer',
          expiresIn: 86_400,
          user: { id: identityId, email: body.ownerEmail, role: UserRole.ADMIN },
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
