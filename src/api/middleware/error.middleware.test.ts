import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
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
});
