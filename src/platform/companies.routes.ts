/**
 * @file companies.routes.ts
 * @description Empresas multipropiedad (17/08/2026, docs/diseno-empresas-
 * multipropiedad.md) — alta de una company y vínculo del negocio del
 * usuario autenticado a ella. Mismo criterio que admin.routes.ts: opera
 * SOLO sobre `req.user!.businessId!` (el negocio del propio caller), nunca
 * un businessId arbitrario del body — así ningún MANAGEMENT de un negocio
 * puede vincular/desvincular OTRO negocio sin que su propio staff lo pida
 * explícitamente (con el `companyId` compartido fuera de banda). No
 * depende de req.db — solo toca la BD central de plataforma, por eso se
 * monta junto a admin.routes.ts, antes de tenantMiddleware.
 *
 * POST /api/companies         — MANAGEMENT — crea una company y vincula el negocio propio
 * POST /api/companies/link    — MANAGEMENT — vincula el negocio propio a una company existente
 */

import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import { authorize } from '../api/middleware/auth.middleware.wrapper.js';
import { Roles } from '../security/roles.js';
import type { PlatformRepository } from './platform.repository.js';
import type { CompanyRepository } from './company.repository.js';
import { z, ZodError } from 'zod';

const CreateCompanySchema = z.object({ name: z.string().min(1).max(255) });
const LinkCompanySchema   = z.object({ companyId: z.string().min(1) });

export function createCompaniesRouter(platformRepo: PlatformRepository, companyRepo: CompanyRepository): Router {
  const router = Router();

  router.post('/', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = CreateCompanySchema.parse(req.body);
      const businessId = req.user!.businessId!;

      const company = await companyRepo.createCompany(body.name);
      await platformRepo.linkBusinessToCompany(businessId, company.id);

      res.status(201).json(company);
    } catch (err) {
      if (err instanceof ZodError) { res.status(400).json({ code: 'VALIDATION_ERROR', errors: err.errors }); return; }
      next(err);
    }
  });

  router.post('/link', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = LinkCompanySchema.parse(req.body);
      const businessId = req.user!.businessId!;

      const company = await companyRepo.findCompanyById(body.companyId);
      if (!company) {
        res.status(404).json({ code: 'COMPANY_NOT_FOUND', message: `Empresa ${body.companyId} no encontrada.` });
        return;
      }

      await platformRepo.linkBusinessToCompany(businessId, company.id);
      res.status(204).send();
    } catch (err) {
      if (err instanceof ZodError) { res.status(400).json({ code: 'VALIDATION_ERROR', errors: err.errors }); return; }
      next(err);
    }
  });

  return router;
}
