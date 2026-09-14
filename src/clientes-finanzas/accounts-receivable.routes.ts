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
 * | POST /accounts-receivable/:id/reverse         | MANAGEMENT **Y** EMISOR_NOTA_CREDITO | Revierte una transferencia PENDIENTE_FACTURAR (Bloque 3c-iii, §3.7 del ADR de City Ledger — exige los DOS permisos a la vez, dos `authorize()` en cadena) |
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

// Bloque 3c-iii (14/09/2026, docs/diseno-reconciliacion-city-ledger-
// 2026-09-12.md §4.4/§4.3) -- reason es OBLIGATORIO (A6.5, transición de
// estado con motivo obligatorio), no opcional como invoiceRef arriba.
// correctedBalance > 0 opcional -- si se omite, es una reversa pura sin
// AR nueva (paso 8/13 del ADR).
const ReverseTransferSchema = z.object({
  reason: z.string().trim().min(1, 'reason es obligatorio').max(500),
  correctedBalance: z.number().positive().optional(),
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

  // ── POST /accounts-receivable/:id/reverse ───────────────────────────────────
  // Bloque 3c-iii, §3.7/§4.4 del ADR -- exige los DOS permisos a la vez, no
  // uno solo: dos `authorize()` en cadena (AND, no jerarquía -- Express
  // solo sigue a la siguiente función si la anterior llamó a `next()`).
  // Primer endpoint del repo que encadena dos `authorize(Roles.X)` --
  // confirmado por grep exhaustivo antes de este commit, sin precedente
  // previo que copiar.
  router.post(
    '/:id/reverse',
    authorize(Roles.MANAGEMENT),
    authorize(Roles.EMISOR_NOTA_CREDITO),
    async (req, res, next) => {
      try {
        const body = ReverseTransferSchema.parse(req.body);
        const result = await arService.reverseTransfer({
          accountReceivableId: String(req.params['id']),
          reversedBy:          req.user!.id,
          reason:              body.reason,
          ...(body.correctedBalance !== undefined && { correctedBalance: body.correctedBalance }),
        });
        res.json(result);
      } catch (err) { next(err); }
    },
  );

  return router;
}
