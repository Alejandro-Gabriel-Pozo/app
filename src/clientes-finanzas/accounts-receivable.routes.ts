/**
 * @file accounts-receivable.routes.ts
 * @description Gestión de cuentas por cobrar (F1-Pieza 3, 23/08/2026,
 * pendientes-2026-08-23.md) — la creación de una fila vive en
 * `POST /stays/:id/transfer-to-receivable` (stays.routes.ts, ya existía);
 * este router es el ciclo de vida posterior: listar lo que se le transfirió
 * a una empresa y avanzar su estado (PENDIENTE_FACTURAR → FACTURADO →
 * COBRADO, R12, nunca vuelve atrás).
 *
 * ## Permisos por endpoint
 *
 * | Endpoint | Roles | Descripción |
 * |---|---|---|
 * | GET  /accounts-receivable?companyCustomerId=X | MANAGEMENT | Todo lo transferido a esa empresa |
 * | POST /accounts-receivable/:id/mark-invoiced   | MANAGEMENT | PENDIENTE_FACTURAR → FACTURADO (solo estado, no toca el ledger) |
 * | POST /accounts-receivable/:id/mark-collected  | MANAGEMENT | FACTURADO → COBRADO (crea el PAYMENT que cierra la deuda de la empresa) |
 *
 * authenticate() fue removido de cada handler: app.ts lo aplica
 * globalmente sobre /api/* antes de tenantMiddleware.
 */

import { Router } from 'express';
import { z } from 'zod';
import { authorize } from '../security/auth.middleware.js';
import { Roles } from '../security/roles.js';
import type { AccountsReceivableService } from './accounts-receivable.service.js';
import { ValidationError } from '../domain/errors.js';

// invoiceRef (F1-Pieza 3, 23/08/2026) -- N° de comprobante real anotado a
// mano al marcar "Facturado" (ver docblock de AccountReceivable.invoiceRef).
const MarkInvoicedSchema = z.object({
  invoiceRef: z.string().trim().max(255).optional(),
});

export function createAccountsReceivableRouter(arService: AccountsReceivableService): Router {
  const router = Router();

  // ── GET /accounts-receivable?companyCustomerId=X ───────────────────────────
  router.get(
    '/',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const companyCustomerId = req.query['companyCustomerId'];
        if (typeof companyCustomerId !== 'string' || companyCustomerId.trim() === '') {
          throw new ValidationError('companyCustomerId es requerido.');
        }
        const rows = await arService.listByCompany(companyCustomerId);
        res.json(rows);
      } catch (err) { next(err); }
    },
  );

  // ── POST /accounts-receivable/:id/mark-invoiced ─────────────────────────────
  router.post(
    '/:id/mark-invoiced',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const body = MarkInvoicedSchema.parse(req.body ?? {});
        const ar = await arService.markInvoiced(String(req.params['id']), body.invoiceRef ?? null);
        res.json(ar);
      } catch (err) { next(err); }
    },
  );

  // ── POST /accounts-receivable/:id/mark-collected ────────────────────────────
  router.post(
    '/:id/mark-collected',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const ar = await arService.markCollected(String(req.params['id']));
        res.json(ar);
      } catch (err) { next(err); }
    },
  );

  return router;
}
