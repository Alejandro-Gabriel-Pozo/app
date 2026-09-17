/**
 * @file credit-note-requests.routes.test.ts
 * @description Bloque 5 del ADR común cancelar-con-NC (15/09/2026, §6.5
 * bis) -- capa HTTP de las 3 rutas nuevas. Mismo patrón que
 * `service-items.routes.test.ts`: se extrae el handler final del stack del
 * router y se lo invoca directo, mockeando `buildInvoiceService`
 * (`invoices.routes.js`) y `SqlCreditNoteRequestRepository`
 * (`sql.credit-note-request.repository.js`) a nivel de módulo -- la lógica
 * de negocio real (transiciones, atomicidad) ya está cubierta a fondo en
 * `invoice.service.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZodError } from 'zod';
import type { Request, Response } from 'express';
import { createCreditNoteRequestsRouter } from './credit-note-requests.routes.js';
import { buildInvoiceService } from './invoices.routes.js';
import { SqlCreditNoteRequestRepository } from './sql.credit-note-request.repository.js';
import { CreditNoteRequestNotFoundError, CreditNoteRequestInvalidTransitionError } from '../domain/errors.js';
import type { AppContainer } from '../container.js';
import type { CreditNoteRequest } from './credit-note-request.entities.js';
import type { InvoiceService } from './invoice.service.js';

vi.mock('./invoices.routes.js', () => ({
  buildInvoiceService: vi.fn(),
}));
vi.mock('./sql.credit-note-request.repository.js', () => ({
  SqlCreditNoteRequestRepository: vi.fn(),
}));

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  res.send   = vi.fn(() => res as Response);
  return res as Response & { statusCode?: number; body?: unknown };
}

function getHandler(router: ReturnType<typeof createCreditNoteRequestsRouter>, method: 'get' | 'post', path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
}

function makeRequest(overrides: Partial<CreditNoteRequest> = {}): CreditNoteRequest {
  return {
    id: 'cnr-1', businessId: 'biz-1', invoiceId: 'inv-1', reversedInvoiceId: 'inv-original',
    orderId: 'ord-1', reservationId: null, state: 'EN_REVISION_MANUAL',
    resolutionOutcome: null, resolvedBy: null, resolvedAt: null, resolutionNote: null,
    slaAlertSentAt: null, createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  };
}

function baseReq(overrides: Partial<Request> = {}): Request {
  return {
    db: {}, businessId: 'biz-1', user: { id: 'identity-1', businessId: 'biz-1' },
    params: {}, query: {}, body: {},
    ...overrides,
  } as unknown as Request;
}

describe('credit-note-requests.routes', () => {
  let listByState: ReturnType<typeof vi.fn>;
  let findById: ReturnType<typeof vi.fn>;
  let resolveCreditNoteRequestManually: ReturnType<typeof vi.fn>;
  let router: ReturnType<typeof createCreditNoteRequestsRouter>;

  let defaultRequest: CreditNoteRequest;

  beforeEach(() => {
    defaultRequest = makeRequest();
    listByState = vi.fn(async () => [defaultRequest]);
    findById = vi.fn(async () => defaultRequest);
    resolveCreditNoteRequestManually = vi.fn(async () => makeRequest({ state: 'CERRADA', resolutionOutcome: 'EMITIDA' }));

    vi.mocked(SqlCreditNoteRequestRepository).mockImplementation(() => ({
      listByState, findById,
    } as unknown as SqlCreditNoteRequestRepository));
    vi.mocked(buildInvoiceService).mockReturnValue({
      resolveCreditNoteRequestManually,
    } as unknown as InvoiceService);

    router = createCreditNoteRequestsRouter({} as AppContainer);
  });

  describe('GET /', () => {
    it('200 -- lista la bandeja para un state válido', async () => {
      const handler = getHandler(router, 'get', '/');
      const req = baseReq({ query: { state: 'EN_REVISION_MANUAL' } });
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(listByState).toHaveBeenCalledWith('EN_REVISION_MANUAL');
      expect(res.json).toHaveBeenCalledWith([defaultRequest]);
    });

    it('400 -- sin query param state', async () => {
      const handler = getHandler(router, 'get', '/');
      const req = baseReq({ query: {} });
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(res.status).toHaveBeenCalledWith(400);
      expect(listByState).not.toHaveBeenCalled();
    });

    it('400 -- state no es un CreditNoteRequestState válido', async () => {
      const handler = getHandler(router, 'get', '/');
      const req = baseReq({ query: { state: 'NO_EXISTE' } });
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(res.status).toHaveBeenCalledWith(400);
      expect(listByState).not.toHaveBeenCalled();
    });
  });

  describe('GET /:id', () => {
    it('200 -- devuelve la fila', async () => {
      const handler = getHandler(router, 'get', '/:id');
      const req = baseReq({ params: { id: 'cnr-1' } });
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(findById).toHaveBeenCalledWith('cnr-1');
      expect(res.json).toHaveBeenCalledWith(defaultRequest);
    });

    it('404 -- fila inexistente, propaga CreditNoteRequestNotFoundError a next()', async () => {
      findById.mockResolvedValueOnce(null);
      const handler = getHandler(router, 'get', '/:id');
      const req = baseReq({ params: { id: 'no-existe' } });
      const res = fakeRes();
      const next = vi.fn();

      await handler(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(CreditNoteRequestNotFoundError));
    });
  });

  describe('POST /:id/resolve', () => {
    it('200 -- EMITIDA con cbteNro/cae/caeVto llama a resolveCreditNoteRequestManually con los campos correctos', async () => {
      const handler = getHandler(router, 'post', '/:id/resolve');
      const req = baseReq({
        params: { id: 'cnr-1' },
        body: { outcome: 'EMITIDA', cbteNro: 42, cae: 'CAE-1', caeVto: '2026-12-31', note: 'a mano' },
      });
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(resolveCreditNoteRequestManually).toHaveBeenCalledWith({
        creditNoteRequestId: 'cnr-1', outcome: 'EMITIDA', resolvedBy: 'identity-1',
        note: 'a mano', cbteNro: 42, cae: 'CAE-1', caeVto: '2026-12-31',
      });
      expect(res.json).toHaveBeenCalled();
    });

    it('200 -- NO_EMITIDA sin cbteNro/cae/caeVto', async () => {
      const handler = getHandler(router, 'post', '/:id/resolve');
      const req = baseReq({ params: { id: 'cnr-1' }, body: { outcome: 'NO_EMITIDA' } });
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(resolveCreditNoteRequestManually).toHaveBeenCalledWith({
        creditNoteRequestId: 'cnr-1', outcome: 'NO_EMITIDA', resolvedBy: 'identity-1', note: null,
      });
    });

    it('400 -- EMITIDA sin cbteNro/cae/caeVto (Zod .superRefine)', async () => {
      const handler = getHandler(router, 'post', '/:id/resolve');
      const req = baseReq({ params: { id: 'cnr-1' }, body: { outcome: 'EMITIDA' } });
      const res = fakeRes();

      let caught: unknown;
      await handler(req, res, (err) => { caught = err; });

      expect(caught).toBeInstanceOf(ZodError);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
      expect(resolveCreditNoteRequestManually).not.toHaveBeenCalled();
    });

    it('400 -- outcome inválido', async () => {
      const handler = getHandler(router, 'post', '/:id/resolve');
      const req = baseReq({ params: { id: 'cnr-1' }, body: { outcome: 'ALGO_RARO' } });
      const res = fakeRes();

      let caught: unknown;
      await handler(req, res, (err) => { caught = err; });

      expect(caught).toBeInstanceOf(ZodError);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });

    it('409 -- propaga CreditNoteRequestInvalidTransitionError a next() (fila que no está en EN_REVISION_MANUAL)', async () => {
      resolveCreditNoteRequestManually.mockRejectedValueOnce(
        new CreditNoteRequestInvalidTransitionError('cnr-1', 'CERRADA', 'CERRADA'),
      );
      const handler = getHandler(router, 'post', '/:id/resolve');
      const req = baseReq({ params: { id: 'cnr-1' }, body: { outcome: 'NO_EMITIDA' } });
      const res = fakeRes();
      const next = vi.fn();

      await handler(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(CreditNoteRequestInvalidTransitionError));
    });

    it('404 -- propaga CreditNoteRequestNotFoundError a next()', async () => {
      resolveCreditNoteRequestManually.mockRejectedValueOnce(new CreditNoteRequestNotFoundError('no-existe'));
      const handler = getHandler(router, 'post', '/:id/resolve');
      const req = baseReq({ params: { id: 'no-existe' }, body: { outcome: 'NO_EMITIDA' } });
      const res = fakeRes();
      const next = vi.fn();

      await handler(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(CreditNoteRequestNotFoundError));
    });
  });
});
