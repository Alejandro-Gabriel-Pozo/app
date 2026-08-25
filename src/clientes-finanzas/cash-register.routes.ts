/**
 * @file cash-register.routes.ts
 * @description Rutas REST de turnos de caja (Gap analysis Tango #2).
 *
 * GET  /api/cash-register/current      — turno OPEN actual (o 404 si no hay)
 * GET  /api/cash-register               — historial de turnos del negocio
 * GET  /api/cash-register/:id           — detalle de un turno + sus movimientos
 * POST /api/cash-register/open          — abre un turno
 * POST /api/cash-register/close         — cierra el turno OPEN actual
 *
 * Montada en app.ts detrás de requireModule(ModuleKey.CUENTAS_CORRIENTES) —
 * mismo módulo que el estado de cuenta de clientes (customers.routes.ts),
 * no se creó un ModuleKey nuevo para esto (evita otra decisión de pricing
 * sin definir todavía, ver docs/roadmap-pms-multirubro.md).
 */

import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import type { AppContainer } from '../container.js';
import {
  CashRegisterService,
  ShiftAlreadyOpenError,
  NoOpenShiftError,
  ShiftNotFoundError,
} from './cash-register.service.js';
import { SqlCashRegisterShiftRepository }  from './sql.cash-register-shift.repository.js';
import { SqlFinancialTransactionRepository } from './sql.financial-transaction.repository.js';
import { SqlBusinessProfileRepository } from '../repositories/sql.business-profile.repository.js';
import { authorize } from '../security/auth.middleware.js';
import { Roles }     from '../security/roles.js';
import { OpenShiftSchema, CloseShiftSchema } from '../api/schemas/request.schemas.js';
import { z, ZodError } from 'zod';

/**
 * GET /api/cash-register (nivel 2 de cobertura de Zod, 25/08/2026,
 * docs/auditoria-tecnica-infra-reservas.md) — `Number(limit)` sin chequear
 * NaN: un `?limit=abc` pasaba `NaN` directo a `listShifts()`.
 */
const ListShiftsQuerySchema = z.object({
  limit:  z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

function buildService(req: Request): CashRegisterService {
  return new CashRegisterService(
    new SqlCashRegisterShiftRepository(req.db!),
    new SqlFinancialTransactionRepository(req.db!),
    new SqlBusinessProfileRepository(req.db!),
  );
}

function validationError(res: Response, errors: { path: string; message: string }[]): void {
  res.status(400).json({ code: 'VALIDATION_ERROR', errors });
}

export function createCashRegisterRouter(_container: AppContainer): Router {
  const router = Router();

  // ── GET /api/cash-register/current ──────────────────────────────────────
  router.get('/current', authorize(Roles.FRONT_DESK), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const shift = await buildService(req).getCurrentShift(req.businessId!);
      if (!shift) {
        res.status(404).json({ code: 'NO_OPEN_SHIFT', message: 'No hay un turno de caja abierto.' });
        return;
      }
      res.json(shift);
    } catch (err) { next(err); }
  });

  // ── GET /api/cash-register ──────────────────────────────────────────────
  router.get('/', authorize(Roles.FRONT_DESK), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { limit, offset } = ListShiftsQuerySchema.parse(req.query);
      const shifts = await buildService(req).listShifts(req.businessId!, {
        ...(limit  !== undefined && { limit }),
        ...(offset !== undefined && { offset }),
      });
      res.json(shifts);
    } catch (err) {
      if (err instanceof ZodError) { res.status(400).json({ code: 'VALIDATION_ERROR', errors: err.errors }); return; }
      next(err);
    }
  });

  // ── GET /api/cash-register/:id ──────────────────────────────────────────
  router.get('/:id', authorize(Roles.FRONT_DESK), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const detail = await buildService(req).getShiftDetail(String(req.params['id']));
      res.json(detail);
    } catch (err) {
      if (err instanceof ShiftNotFoundError) res.status(404).json({ code: err.code, message: err.message });
      else next(err);
    }
  });

  // ── POST /api/cash-register/open ────────────────────────────────────────
  router.post('/open', authorize(Roles.FRONT_DESK), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = OpenShiftSchema.safeParse(req.body);
      if (!parsed.success) {
        validationError(res, parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })));
        return;
      }
      const shift = await buildService(req).openShift({
        businessId: req.businessId!,
        openedBy: req.user!.id,
        openingAmount: parsed.data.openingAmount,
        ...(parsed.data.notes !== undefined && { notes: parsed.data.notes }),
      });
      res.status(201).json(shift);
    } catch (err) {
      if (err instanceof ShiftAlreadyOpenError) res.status(409).json({ code: err.code, message: err.message });
      else next(err);
    }
  });

  // ── POST /api/cash-register/close ───────────────────────────────────────
  router.post('/close', authorize(Roles.FRONT_DESK), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = CloseShiftSchema.safeParse(req.body);
      if (!parsed.success) {
        validationError(res, parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })));
        return;
      }
      const shift = await buildService(req).closeShift({
        businessId: req.businessId!,
        closedBy: req.user!.id,
        closingAmountCounted: parsed.data.closingAmountCounted,
        ...(parsed.data.notes !== undefined && { notes: parsed.data.notes }),
      });
      res.json(shift);
    } catch (err) {
      if (err instanceof NoOpenShiftError) res.status(409).json({ code: err.code, message: err.message });
      else next(err);
    }
  });

  return router;
}
