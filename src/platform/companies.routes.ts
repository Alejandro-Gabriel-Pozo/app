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
 * GET  /api/companies/me      — MANAGEMENT — empresa a la que pertenece el negocio propio (o null)
 * POST /api/companies         — MANAGEMENT + plan ENTERPRISE — crea una company y vincula el negocio propio
 * POST /api/companies/link    — MANAGEMENT + plan ENTERPRISE — vincula el negocio propio a una company existente
 *
 * GET /me existe porque, sin él, el frontend no tiene forma de saber si el
 * negocio ya pertenece a una empresa antes de ofrecer "crear"/"vincular" —
 * el riesgo real es que alguien cree una empresa nueva sin saber que ya
 * estaba vinculado a otra, desvinculándola sin darse cuenta (linkBusinessToCompany
 * simplemente sobreescribe company_id, no hay confirmación en el medio).
 * A propósito SIN requirePlan(): un negocio que dejó de ser ENTERPRISE
 * (downgrade) sigue pudiendo ver a qué empresa pertenece.
 *
 * ## Gate de plan ENTERPRISE (18/08/2026, pendientes-2026-08-18.md, deuda
 * estructural — aclarado por el dueño: empresas multipropiedad es la
 * feature que define el plan ENTERPRISE). `requirePlan()`
 * (security/plan.middleware.ts) solo en los dos POST — crear/vincular es
 * lo que se gatea, no seguir usando una company ya vinculada (mismo
 * criterio "no gatear cada operación downstream" que ya regía el catálogo
 * compartido en sí, ver diseno-empresas-multipropiedad.md).
 */

import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import { authorize } from '../api/middleware/auth.middleware.wrapper.js';
import { Roles } from '../security/roles.js';
import { requirePlan } from '../security/plan.middleware.js';
import { BusinessPlan } from '../types/enums.js';
import type { AppContainer } from '../container.js';
import type { PlatformRepository } from './platform.repository.js';
import type { CompanyRepository } from './company.repository.js';
import { z } from 'zod';

const CreateCompanySchema = z.object({ name: z.string().min(1).max(255) });
const LinkCompanySchema   = z.object({ companyId: z.string().min(1) });

export function createCompaniesRouter(
  platformRepo: PlatformRepository,
  companyRepo: CompanyRepository,
  container: AppContainer,
): Router {
  const router = Router();

  router.get('/me', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const business = await platformRepo.findById(req.user!.businessId!);
      if (!business?.companyId) {
        res.json({ companyId: null, companyName: null });
        return;
      }
      const company = await companyRepo.findCompanyById(business.companyId);
      res.json({ companyId: business.companyId, companyName: company?.name ?? null });
    } catch (err) { next(err); }
  });

  router.post('/', authorize(Roles.MANAGEMENT), requirePlan(container, BusinessPlan.ENTERPRISE), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = CreateCompanySchema.parse(req.body);
      const businessId = req.user!.businessId!;

      const company = await companyRepo.createCompany(body.name);
      await platformRepo.linkBusinessToCompany(businessId, company.id);

      res.status(201).json(company);
    } catch (err) {
      next(err);
    }
  });

  router.post('/link', authorize(Roles.MANAGEMENT), requirePlan(container, BusinessPlan.ENTERPRISE), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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
      next(err);
    }
  });

  return router;
}
