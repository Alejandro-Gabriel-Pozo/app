/**
 * @file credit-note-requests.routes.ts
 * @description Bandeja de reconciliación manual de `credit_note_request`
 * (Bloque 5 del ADR común cancelar-con-NC,
 * `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` §6.5 bis).
 * Bloques 1-4 (repo+entidades, `markFailedWithClient` transaccional, INSERT
 * real en `buildCreditNote()`, las 3 transiciones automáticas) ya están
 * cableados — este archivo es SOLO las 3 rutas nuevas + la orquestación
 * manual de `InvoiceService.resolveCreditNoteRequestManually()`.
 *
 * GET  /api/credit-note-requests?state=EN_REVISION_MANUAL — `authorizeAny([EMISOR_NOTA_CREDITO, MANAGEMENT])`
 *      (§6.5 bis, pregunta de negocio 3, RESUELTA: MANAGEMENT ve la bandeja
 *      en modo lectura sin poder resolver). `state` es OBLIGATORIO — la
 *      bandeja es específicamente para revisión manual, no un listado
 *      genérico; 400 si falta o no es un `CreditNoteRequestState` válido.
 * GET  /api/credit-note-requests/:id — `authorizeAny([EMISOR_NOTA_CREDITO, MANAGEMENT])`.
 *      `findById()` sin filtro de estado (R2) — 404 si no existe.
 * POST /api/credit-note-requests/:id/resolve — `authorize(EMISOR_NOTA_CREDITO)`
 *      simple, NO `authorizeAny` (la transición de estado NO se amplía a
 *      MANAGEMENT, solo la lectura — §6.5 bis pregunta 3). Body:
 *      `{ outcome: 'EMITIDA' | 'NO_EMITIDA', note?, cbteNro?, cae?, caeVto? }`
 *      (`CreditNoteRequestResolveSchema`, `api/schemas/facturacion.schemas.ts`).
 *
 * ## Por qué NO entra en `ESCAPE_ROUTES` de `credit-note-escape-containment.test.ts`
 * Esa cerca (`CN-ESCAPE-CONTAINMENT-001`, aserción D) congela el grupo de
 * las rutas que DISPARAN el escape fiscal (`POST /api/orders/:id/cancel-with-credit-note`,
 * `POST /api/reservations/:id/cancel-with-credit-note`) — el riesgo que
 * contiene es "alguien degrada el `authorize()` de la puerta de salida y
 * nadie se entera". `POST /:id/resolve` no dispara nada hacia AFIP ni crea
 * una NC nueva: reconcilia un intento YA EN CURSO (`EN_REVISION_MANUAL`)
 * que el escape ya generó — es la bandeja de revisión, no la puerta. Mismo
 * criterio que el propio ADR anticipa ("evaluar si entran, probablemente
 * NO — esa cerca congela el grupo de las rutas que disparan el escape, no
 * las que reconcilian un intento ya en curso"), decisión tomada acá porque
 * el ADR la dejó como pregunta abierta para este bloque.
 *
 * ## Aislamiento multi-tenant
 * `req.db!` (pool del tenant), mismo criterio que el resto de `facturacion/`
 * — nunca `getPlatformRawPool()`.
 *
 * ## Montaje
 * `app.ts`, junto a `/api/invoices` (mismo módulo `facturacion`, después
 * del gate `authenticate()` de tenant).
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { authorize, authorizeAny } from '../security/auth.middleware.js';
import { Roles } from '../security/roles.js';
import type { AppContainer } from '../container.js';
import { SqlCreditNoteRequestRepository } from './sql.credit-note-request.repository.js';
import { buildInvoiceService } from './invoices.routes.js';
import { ALLOWED_CREDIT_NOTE_REQUEST_TRANSITIONS, type CreditNoteRequestState } from './credit-note-request.entities.js';
import { CreditNoteRequestResolveSchema } from '../api/schemas/facturacion.schemas.js';
import { CreditNoteRequestNotFoundError } from '../domain/errors.js';

/** Los 3 únicos valores válidos de `credit_note_request.state` — mismo patrón que `VALID_INVOICE_STATUSES` de `invoices.routes.ts`. */
const VALID_CREDIT_NOTE_REQUEST_STATES: readonly CreditNoteRequestState[] =
  Object.keys(ALLOWED_CREDIT_NOTE_REQUEST_TRANSITIONS) as CreditNoteRequestState[];

export function createCreditNoteRequestsRouter(_container: AppContainer): Router {
  const router = Router();

  function buildRepo(req: Request): SqlCreditNoteRequestRepository {
    return new SqlCreditNoteRequestRepository(req.db!);
  }

  router.get(
    '/',
    authorizeAny([Roles.EMISOR_NOTA_CREDITO, Roles.MANAGEMENT]),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const state = req.query['state'];
        if (typeof state !== 'string' || !VALID_CREDIT_NOTE_REQUEST_STATES.includes(state as CreditNoteRequestState)) {
          res.status(400).json({
            code: 'VALIDATION_ERROR',
            message: `El query param "state" es obligatorio y debe ser uno de: ${VALID_CREDIT_NOTE_REQUEST_STATES.join(', ')}`,
          });
          return;
        }
        const requests = await buildRepo(req).listByState(state as CreditNoteRequestState);
        res.json(requests);
      } catch (err) { next(err); }
    },
  );

  router.get(
    '/:id',
    authorizeAny([Roles.EMISOR_NOTA_CREDITO, Roles.MANAGEMENT]),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const id = String(req.params['id']);
        const request = await buildRepo(req).findById(id);
        if (!request) throw new CreditNoteRequestNotFoundError(id);
        res.json(request);
      } catch (err) { next(err); }
    },
  );

  router.post(
    '/:id/resolve',
    authorize(Roles.EMISOR_NOTA_CREDITO),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = CreditNoteRequestResolveSchema.parse(req.body);
        const updated = await buildInvoiceService(req).resolveCreditNoteRequestManually({
          creditNoteRequestId: String(req.params['id']),
          outcome: body.outcome,
          resolvedBy: req.user!.id,
          note: body.note ?? null,
          ...(body.cbteNro !== undefined && { cbteNro: body.cbteNro }),
          ...(body.cae !== undefined && { cae: body.cae }),
          ...(body.caeVto !== undefined && { caeVto: body.caeVto }),
        });
        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
