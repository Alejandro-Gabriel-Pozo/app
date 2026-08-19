/**
 * @file invoices.routes.ts
 * @description Facturación electrónica AFIP (Fase 2, WSFEv1 real).
 *
 * GET  /api/business-profile/afip-credentials/status — MANAGEMENT (nunca
 *      devuelve el cert/clave, solo si está configurado y en qué ambiente)
 * PUT  /api/business-profile/afip-credentials        — MANAGEMENT
 * DELETE /api/business-profile/afip-credentials      — MANAGEMENT
 *
 * POST /api/invoices          — FRONT_DESK (pedir el CAE de un cobro ya existente)
 * GET  /api/invoices/:id      — FRONT_DESK
 * GET  /api/invoices?financialTransactionId=... — FRONT_DESK
 *
 * Todo detrás de requireModule(ModuleKey.FACTURACION) — módulo ya definido
 * (types/enums.ts) y sembrado en `modules`/`business_modules` desde antes,
 * sin ninguna ruta que lo usara hasta ahora.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { authorize } from '../security/auth.middleware.js';
import { Roles } from '../security/roles.js';
import { requireModule } from '../security/module.middleware.js';
import { ModuleKey } from '../types/enums.js';
import type { AppContainer } from '../container.js';
import { SqlAfipCredentialsRepository } from './sql.afip-credentials.repository.js';
import { SqlInvoiceRepository } from './sql.invoice.repository.js';
import { InvoiceService } from './invoice.service.js';
import { SqlFinancialTransactionRepository } from '../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlBusinessProfileRepository } from '../repositories/sql.business-profile.repository.js';
import { SaveAfipCredentialsSchema, RequestInvoiceSchema } from '../api/schemas/facturacion.schemas.js';

function buildInvoiceService(req: Request): InvoiceService {
  const db = req.db!;
  return new InvoiceService(
    new SqlInvoiceRepository(db),
    new SqlFinancialTransactionRepository(db),
    new SqlBusinessProfileRepository(db),
    new SqlAfipCredentialsRepository(db),
  );
}

export function createInvoicesRouter(container: AppContainer): Router {
  const router = Router();
  const gate = requireModule(container, ModuleKey.FACTURACION);

  // ── POST /api/invoices ───────────────────────────────────────────────────
  router.post(
    '/',
    gate,
    authorize(Roles.FRONT_DESK),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = RequestInvoiceSchema.parse(req.body);
        const invoice = await buildInvoiceService(req).requestInvoice({
          businessId: req.user!.businessId!,
          financialTransactionId: body.financialTransactionId,
          ...(body.buyer !== undefined && { buyer: body.buyer }),
          ...(body.concepto !== undefined && { concepto: body.concepto }),
        });
        res.status(201).json(invoice);
      } catch (err) { next(err); }
    },
  );

  // ── GET /api/invoices/:id ─────────────────────────────────────────────────
  router.get(
    '/:id',
    gate,
    authorize(Roles.FRONT_DESK),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const invoice = await new SqlInvoiceRepository(req.db!).getById(String(req.params['id']));
        if (!invoice) {
          res.status(404).json({ code: 'INVOICE_NOT_FOUND', message: 'Comprobante no encontrado' });
          return;
        }
        res.json(invoice);
      } catch (err) { next(err); }
    },
  );

  // ── GET /api/invoices?financialTransactionId=... ───────────────────────────
  router.get(
    '/',
    gate,
    authorize(Roles.FRONT_DESK),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const financialTransactionId = req.query['financialTransactionId'];
        if (typeof financialTransactionId !== 'string' || !financialTransactionId) {
          res.status(400).json({ code: 'VALIDATION_ERROR', message: 'financialTransactionId es obligatorio' });
          return;
        }
        const invoices = await new SqlInvoiceRepository(req.db!).getByFinancialTransactionId(financialTransactionId);
        res.json(invoices);
      } catch (err) { next(err); }
    },
  );

  return router;
}

/**
 * Router aparte porque cuelga de `/api/business-profile`, no de
 * `/api/invoices` — mismo negocio (config del emisor), pero un secreto,
 * no un dato del perfil que ya viaja entero por `GET /api/business-profile`.
 */
export function createAfipCredentialsRouter(container: AppContainer): Router {
  const router = Router();
  const gate = requireModule(container, ModuleKey.FACTURACION);

  router.get(
    '/status',
    gate,
    authorize(Roles.MANAGEMENT),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const status = await new SqlAfipCredentialsRepository(req.db!).getStatus();
        res.json(status);
      } catch (err) { next(err); }
    },
  );

  router.put(
    '/',
    gate,
    authorize(Roles.MANAGEMENT),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = SaveAfipCredentialsSchema.parse(req.body);
        const repo = new SqlAfipCredentialsRepository(req.db!);
        await repo.save(body.cert, body.key, body.environment);
        res.json(await repo.getStatus());
      } catch (err) { next(err); }
    },
  );

  router.delete(
    '/',
    gate,
    authorize(Roles.MANAGEMENT),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        await new SqlAfipCredentialsRepository(req.db!).clear();
        res.status(204).send();
      } catch (err) { next(err); }
    },
  );

  return router;
}
