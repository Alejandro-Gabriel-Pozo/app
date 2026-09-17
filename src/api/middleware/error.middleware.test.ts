import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { errorHandler } from './error.middleware.js';
import { DomainError } from '../../domain/errors.js';
import { logger } from '../../logger.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.error).mockClear();
});

class TestDomainError extends DomainError {
  constructor(code: string, message = 'algo pasó con la orden ord-42 por $1234') {
    super(message, code);
  }
}

function fakeReq(over: Record<string, unknown> = {}): Request {
  return {
    method: 'POST',
    originalUrl: '/api/orders/ord-42/cancel-with-credit-note',
    user: { businessId: 'biz-1' },
    ...over,
  } as unknown as Request;
}

function fakeRes(): Response & { statusCode?: number; body?: unknown } {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((c: number) => { res.statusCode = c; return res as Response; });
  res.json = vi.fn((b: unknown) => { res.body = b; return res as Response; });
  return res as Response & { statusCode?: number; body?: unknown };
}

describe('error.middleware -- MID-LOG-001 política de logging de DomainError', () => {
  it('un DomainError que mapea a 422 se loguea: code + status + método/URL + tenant, SIN message', () => {
    const res = fakeRes();
    errorHandler(new TestDomainError('CREDIT_NOTE_CANCELLATION_PENDING'), fakeReq(), res, vi.fn());

    expect(res.statusCode).toBe(422);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [payload, msg] = vi.mocked(logger.warn).mock.calls[0]!;
    expect(payload).toEqual({
      code: 'CREDIT_NOTE_CANCELLATION_PENDING',
      status: 422,
      method: 'POST',
      url: '/api/orders/ord-42/cancel-with-credit-note',
      businessId: 'biz-1',
    });
    expect(JSON.stringify(payload)).not.toContain('ord-42 por $1234'); // el message no viaja al log
    expect(msg).toBe('[errorHandler] DomainError');
    // el message SÍ va en la respuesta al cliente (comportamiento sin cambio)
    expect((res.body as { message: string }).message).toContain('$1234');
  });

  it('un DomainError que mapea a 409 se loguea', () => {
    const res = fakeRes();
    errorHandler(new TestDomainError('CREDIT_NOTE_MULTI_INVOICE'), fakeReq(), res, vi.fn());
    expect(res.statusCode).toBe(409);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn).mock.calls[0]![0]).toMatchObject({ code: 'CREDIT_NOTE_MULTI_INVOICE', status: 409 });
  });

  it('un DomainError 4xx de cliente rutinario (404) NO se loguea', () => {
    const res = fakeRes();
    errorHandler(new TestDomainError('ORDER_NOT_FOUND'), fakeReq(), res, vi.fn());
    expect(res.statusCode).toBe(404);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('un DomainError 400 de validación NO se loguea', () => {
    const res = fakeRes();
    errorHandler(new TestDomainError('INVALID_RESERVATION'), fakeReq(), res, vi.fn());
    expect(res.statusCode).toBe(400);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('un code sin mapeo: 500 + logger.error "sin mapeo de status" (comportamiento previo, sin doble log)', () => {
    const res = fakeRes();
    errorHandler(new TestDomainError('CODIGO_INVENTADO_QUE_NO_EXISTE'), fakeReq(), res, vi.fn());
    expect(res.statusCode).toBe(500);
    // el `default:` de domainErrorStatus loguea; status 500 >= 409 así que
    // el warn de la política TAMBIÉN corre -- una línea de cada, no un doble
    // warn.
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.error).mock.calls[0]![0]).toMatchObject({ code: 'CODIGO_INVENTADO_QUE_NO_EXISTE' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('sin req.user (ruta pública que propaga un DomainError): businessId null, no explota', () => {
    const res = fakeRes();
    errorHandler(new TestDomainError('AFIP_REQUEST_UNCERTAIN'), fakeReq({ user: undefined }), res, vi.fn());
    expect(res.statusCode).toBe(409);
    expect(vi.mocked(logger.warn).mock.calls[0]![0]).toMatchObject({ businessId: null });
  });

  it('A7.2 -- el query string NUNCA viaja al log (originalUrl = path + query)', () => {
    const res = fakeRes();
    errorHandler(
      new TestDomainError('AFIP_REQUEST_UNCERTAIN'),
      fakeReq({ originalUrl: '/api/customers?email=juan%40example.com&name=Perez' }),
      res,
      vi.fn(),
    );
    const logged = vi.mocked(logger.warn).mock.calls[0]![0] as { url: string };
    expect(logged.url).toBe('/api/customers');
    expect(logged.url).not.toContain('?');
    expect(logged.url).not.toContain('email');
    expect(logged.url).not.toContain('juan');
  });

  it('ORDER_STATE_UNKNOWN ahora mapea a 409 (antes caía a 500 "sin mapeo")', () => {
    const res = fakeRes();
    errorHandler(new TestDomainError('ORDER_STATE_UNKNOWN'), fakeReq(), res, vi.fn());
    expect(res.statusCode).toBe(409);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  // Bloque 3.3-b2 (09/09/2026, gate `architecture-governor`) -- los 6 códigos
  // nuevos del escape de reservas, como red de seguridad de
  // `reservations.routes.ts` (que los resuelve inline igual que
  // orders.routes.ts). Sin estos casos, un `next(err)` con cualquiera de los
  // 6 caería al `default:` -> 500 "sin mapeo" sin que ningún test lo avise.
  it('CREDIT_NOTE_RESERVATION_NO_LIVE_INVOICE mapea a 409', () => {
    const res = fakeRes();
    errorHandler(new TestDomainError('CREDIT_NOTE_RESERVATION_NO_LIVE_INVOICE'), fakeReq(), res, vi.fn());
    expect(res.statusCode).toBe(409);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('CREDIT_NOTE_RESERVATION_MULTI_INVOICE mapea a 409', () => {
    const res = fakeRes();
    errorHandler(new TestDomainError('CREDIT_NOTE_RESERVATION_MULTI_INVOICE'), fakeReq(), res, vi.fn());
    expect(res.statusCode).toBe(409);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('CREDIT_NOTE_MIXED_STAY mapea a 409', () => {
    const res = fakeRes();
    errorHandler(new TestDomainError('CREDIT_NOTE_MIXED_STAY'), fakeReq(), res, vi.fn());
    expect(res.statusCode).toBe(409);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('CREDIT_NOTE_CONSOLIDATED_FULL_REVERSAL mapea a 409', () => {
    const res = fakeRes();
    errorHandler(new TestDomainError('CREDIT_NOTE_CONSOLIDATED_FULL_REVERSAL'), fakeReq(), res, vi.fn());
    expect(res.statusCode).toBe(409);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('CREDIT_NOTE_RESERVATION_INVOICE_SET_CHANGED mapea a 422 -- documento fiscal ya emitido, no reintentar', () => {
    const res = fakeRes();
    errorHandler(new TestDomainError('CREDIT_NOTE_RESERVATION_INVOICE_SET_CHANGED'), fakeReq(), res, vi.fn());
    expect(res.statusCode).toBe(422);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('CREDIT_NOTE_ISSUED_RESERVATION_NOT_CANCELLABLE mapea a 422, NUNCA a 400 (INVALID_RESERVATION) -- documento fiscal ya emitido', () => {
    const res = fakeRes();
    errorHandler(new TestDomainError('CREDIT_NOTE_ISSUED_RESERVATION_NOT_CANCELLABLE'), fakeReq(), res, vi.fn());
    expect(res.statusCode).toBe(422);
    expect(logger.error).not.toHaveBeenCalled();
  });

  // M3 (14/09/2026) -- espejo del test de arriba, lado órdenes: red de
  // seguridad de `orders.routes.ts` (que también delega TODO a next(err)).
  // Sin este case, CREDIT_NOTE_ORDER_INVOICE_SET_CHANGED caería al
  // `default:` -> 500 "sin mapeo" sin que ningún test lo avise.
  it('CREDIT_NOTE_ORDER_INVOICE_SET_CHANGED mapea a 422 -- documento fiscal ya emitido, no reintentar', () => {
    const res = fakeRes();
    errorHandler(new TestDomainError('CREDIT_NOTE_ORDER_INVOICE_SET_CHANGED'), fakeReq(), res, vi.fn());
    expect(res.statusCode).toBe(422);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

// D-16 (17/09/2026, Wave 9, gate `architecture-governor` -- condición F4 de
// la primera pasada). Tras mover ~18 *.routes.ts a delegar TODO ZodError con
// next(err)/next(parsed.error), este es el ÚNICO lugar que sigue armando el
// body de un 400 de validación -- y hasta este bloque, NINGÚN test en el
// repo fijaba esa forma exacta. `error-400-single-shape.test.ts` (la cerca
// de arquitectura del mismo bloque) verifica que nada MÁS la construya, pero
// no verifica CÓMO la construye este archivo -- ese hueco es este test.
describe('error.middleware -- forma canónica de un ZodError (D-16, la única que appfrontend/src/lib/http.ts sabe parsear)', () => {
  it('un ZodError produce { code, message, errors: flatten() } -- errors.fieldErrors trae el mensaje por campo', () => {
    const Schema = z.object({ amount: z.number().positive() });
    const parsed = Schema.safeParse({ amount: -5 });
    if (parsed.success) throw new Error('el fixture del test debería fallar la validación');

    const res = fakeRes();
    errorHandler(parsed.error, fakeReq(), res, vi.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      code:    'VALIDATION_ERROR',
      message: 'Datos de entrada inválidos',
      errors:  parsed.error.flatten(),
    });
    // La forma que appfrontend/src/lib/http.ts realmente lee -- si esto deja
    // de estar poblado, el frontend vuelve a mostrar "Error inesperado"
    // aunque el test de arriba (comparación estructural con flatten()) siga
    // pasando con un flatten() vacío por algún cambio futuro del schema.
    const body = res.body as { errors: { fieldErrors: Record<string, string[]> } };
    expect(body.errors.fieldErrors['amount']?.length).toBeGreaterThan(0);
  });
});
