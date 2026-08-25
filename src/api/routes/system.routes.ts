/**
 * @file system.routes.ts
 * @description Salud operativa del outbox — dead-letter de domain_events
 * (A9.5/A8.7, pendientes-2026-08-15.md punto 2).
 *
 * Va DESPUÉS de tenantMiddleware (necesita req.db) y usa el mismo patrón
 * que /api/reports: se construye el repositorio por request en app.ts con
 * req.db, no acá.
 *
 * Sin requireModule() a propósito — esto no es un módulo de negocio
 * (facturación, POS, etc.), es observabilidad de infraestructura del
 * tenant, mismo criterio que /api/audit-log.
 */

import { Router } from 'express';
import { authorize } from '../../security/auth.middleware.js';
import { Roles } from '../../security/roles.js';
import type { DomainEventRepository } from '../../repositories/domain-event.repository.js';
import { logger } from '../../logger.js';

export function createSystemRouter(repo: DomainEventRepository): Router {
  const router = Router();

  // ── GET /system/outbox/dead-letter ──────────────────────────────────────
  // Eventos que agotaron los reintentos automáticos — requieren acción manual.
  router.get(
    '/outbox/dead-letter',
    authorize(Roles.MANAGEMENT),
    async (_req, res, next) => {
      try {
        const [count, events] = await Promise.all([
          repo.countDeadLettered(),
          repo.getDeadLettered(50),
        ]);
        res.json({ count, events });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── POST /system/outbox/:id/retry ───────────────────────────────────────
  // Reintento manual: vuelve el evento a PENDING para que el worker lo
  // vuelva a procesar en el próximo ciclo de poll.
  router.post(
    '/outbox/:id/retry',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) {
          res.status(400).json({ code: 'INVALID_ID', message: 'id inválido.' });
          return;
        }

        await repo.retryDeadLettered(id);

        // A6.5 (rastro de la transición) — no hay audit_log wireado para
        // esto todavía (A9.4 nota que hoy solo cubre precios); queda en el
        // log del servidor con quién y qué evento, no en la tabla.
        logger.info(
          { eventId: id, identityId: req.user?.id, businessId: req.user?.businessId },
          '[system] Reintento manual de evento',
        );

        res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
