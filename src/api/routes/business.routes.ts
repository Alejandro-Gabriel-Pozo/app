/**
 * @file business.routes.ts
 * @description Endpoint de registro de nuevos negocios en la plataforma.
 *
 * ## Flujo de POST /register
 * 1. Validar body con Zod
 * 2. Verificar que email y slug no existan
 * 3. Crear negocio en BD central (estado PENDING)
 * 4. Crear usuario ADMIN inicial
 * 5. Provisionar BD en Supabase (async — puede tardar 2-3 min)
 * 6. Ejecutar schema.sql en la nueva BD
 * 7. Activar negocio en BD central (estado ACTIVE)
 * 8. Retornar JWT listo para usar
 *
 * ## Por qué el provisioning es síncrono aquí
 * Supabase tarda ~2 minutos en crear un proyecto. Para simplificar,
 * el endpoint espera (timeout largo en Render). En producción a escala
 * esto debería moverse a una queue (BullMQ, etc.) con webhook de callback.
 */
 
import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PlatformRepository } from '../../platform/platform.repository.js';
import {
  provisionBusinessDatabase,
  runSchemaOnNewDatabase,
  encryptConnectionString,
} from '../../platform/supabase.provisioner.js';
import { hashPassword } from '../../security/user.store.js';
import { signToken } from '../../security/auth.middleware.js';
import { BusinessPlan, UserRole } from '../../types/enums.js';
 
const __dirname = dirname(fileURLToPath(import.meta.url));
 
// ---------------------------------------------------------------------------
// Schema de validación
// ---------------------------------------------------------------------------
 
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
 *           minLength: 2
 *           maxLength: 100
 *           example: "Spa Serenidad"
 *         ownerEmail:
 *           type: string
 *           format: email
 *           example: "admin@spaserenidad.com"
 *         ownerPassword:
 *           type: string
 *           minLength: 8
 *           example: "MiClave123!"
 *         plan:
 *           type: string
 *           enum: [FREE, STARTER, PRO]
 *           default: FREE
 */
const RegisterBusinessSchema = z.object({
  businessName: z.string().min(2).max(100),
  ownerEmail: z.string().email(),
  ownerPassword: z.string().min(8, { message: 'La contraseña debe tener al menos 8 caracteres' }),
  plan: z.nativeEnum(BusinessPlan).default(BusinessPlan.FREE),
});
 
// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
 
export function createBusinessRouter(platformRepo: PlatformRepository): Router {
  const router = Router();
 
  /**
   * @swagger
   * /register:
   *   post:
   *     summary: Registrar un nuevo negocio en la plataforma
   *     description: >
   *       Crea el negocio, provisiona su base de datos en Supabase,
   *       y retorna un JWT listo para usar. El proceso puede tardar
   *       hasta 3 minutos mientras se crea la BD.
   *     tags: [Platform]
   *     security: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/RegisterBusiness'
   *           example:
   *             businessName: "Spa Serenidad"
   *             ownerEmail: "admin@spaserenidad.com"
   *             ownerPassword: "MiClave123!"
   *             plan: "FREE"
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
        // 1. Validar body
        const body = RegisterBusinessSchema.parse(req.body);
 
        // 2. Generar slug único a partir del nombre
        const slug = generateSlug(body.businessName);
 
        // 3. Verificar unicidad
        const exists = await platformRepo.existsByEmailOrSlug(body.ownerEmail, slug);
        if (exists) {
          res.status(400).json({
            code: 'BUSINESS_ALREADY_EXISTS',
            message: 'Ya existe un negocio con ese email o nombre',
          });
          return;
        }
 
        // 4. Crear negocio en BD central (PENDING)
        const businessId = randomUUID();
        const business = await platformRepo.createBusiness({
          id: businessId,
          name: body.businessName,
          slug,
          plan: body.plan,
          ownerEmail: body.ownerEmail,
        });
 
        console.log(`[register] Negocio creado: ${businessId} — iniciando provisioning...`);
 
        // 5. Provisionar BD en Supabase (puede tardar 2-3 minutos)
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
 
        // 6. Ejecutar schema.sql en la nueva BD
        const schemaPath = join(__dirname, '..', '..', 'db', 'schema.sql');
        const schemaSQL = await readFile(schemaPath, 'utf-8');
        await runSchemaOnNewDatabase(provisioned.connectionString, schemaSQL);
 
        // 7. Cifrar y guardar la connection string — activar negocio
        const dbUrlEncrypted = await encryptConnectionString(provisioned.connectionString);
        await platformRepo.activateBusiness(businessId, provisioned.projectId, dbUrlEncrypted);
 
        // 8. Crear usuario ADMIN del negocio
        const userId = randomUUID();
        const passwordHash = await hashPassword(body.ownerPassword);
        await platformRepo.createPlatformUser({
          id: userId,
          email: body.ownerEmail,
          businessId,
          role: UserRole.ADMIN,
          passwordHash,
        });
 
        // 9. Emitir JWT con business_id
        const jwtSecret = process.env.JWT_SECRET!;
        const token = signToken(
          { sub: userId, role: UserRole.ADMIN, business_id: businessId },
          jwtSecret,
        );
 
        console.log(`[register] ✅ Negocio ${businessId} activo — usuario admin creado`);
 
        res.status(201).json({
          message: 'Negocio registrado exitosamente',
          business: {
            id: business.id,
            name: business.name,
            slug: business.slug,
            plan: business.plan,
          },
          token,
          tokenType: 'Bearer',
          expiresIn: 86_400,
          user: {
            id: userId,
            email: body.ownerEmail,
            role: UserRole.ADMIN,
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );
 
  return router;
}
 
// ---------------------------------------------------------------------------
// Helper: generar slug único
// ---------------------------------------------------------------------------
 
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remover acentos
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}
