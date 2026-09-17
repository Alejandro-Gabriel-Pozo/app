import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withAfipTimeout, AFIP_REQUEST_TIMEOUT_MS } from './afip-request.timeout.js';
import { logger } from '../logger.js';

describe('withAfipTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('AFIP_REQUEST_TIMEOUT_MS es 20_000 -- ancla del valor que el resto de la suite asume', () => {
    expect(AFIP_REQUEST_TIMEOUT_MS).toBe(20_000);
  });

  it('si la promesa resuelve ANTES del timeout, resuelve con el valor real -- sin log', async () => {
    const result = await withAfipTimeout(Promise.resolve('ok-value'), 'test-op');

    expect(result).toBe('ok-value');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('si la promesa rechaza ANTES del timeout, propaga el error real tal cual -- sin log', async () => {
    const original = new Error('fault SOAP real');
    await expect(withAfipTimeout(Promise.reject(original), 'test-op')).rejects.toBe(original);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('si la promesa nunca resuelve, rechaza a los 20_000ms con un mensaje que nombra el label y el ms', async () => {
    const hung = new Promise(() => { /* nunca resuelve */ });

    const pending = expect(withAfipTimeout(hung, 'getTaxpayerByCuit')).rejects.toThrow(
      /\[AFIP\] getTaxpayerByCuit no respondió en 20000ms/,
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
  });

  it('asentamiento tardío -- RESOLVE después de vencido el timeout: se descarta y se loguea, no crashea ni cambia el resultado ya entregado', async () => {
    let resolveLate!: (v: string) => void;
    const late = new Promise<string>((resolve) => { resolveLate = resolve; });

    const pending = expect(withAfipTimeout(late, 'getVoucherInfo')).rejects.toThrow(/no respondió en 20000ms/);
    await vi.advanceTimersByTimeAsync(20_000);
    await pending; // el caller ya recibió el rechazo de timeout acá

    // AFIP "responde" después de que el caller ya siguió su curso.
    resolveLate('CAE-llegado-tarde');
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.warn).toHaveBeenCalledOnce();
    const [payload, msg] = vi.mocked(logger.warn).mock.calls[0]!;
    expect(payload).toMatchObject({ label: 'getVoucherInfo' });
    expect(msg).toContain('resolvió DESPUÉS de vencer el timeout');
  });

  it('asentamiento tardío -- REJECT después de vencido el timeout: se descarta y se loguea con el motivo real, no un unhandledRejection', async () => {
    let rejectLate!: (err: Error) => void;
    const late = new Promise<string>((_resolve, reject) => { rejectLate = reject; });

    const pending = expect(withAfipTimeout(late, 'createNextVoucher')).rejects.toThrow(/no respondió en 20000ms/);
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;

    // El fault SOAP real de AFIP llega después de vencido el timeout --
    // exactamente el caso que el docblock nombra ("CAE duplicado").
    rejectLate(new Error('CAE duplicado -- AFIP ya lo había procesado'));
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.warn).toHaveBeenCalledOnce();
    const [payload, msg] = vi.mocked(logger.warn).mock.calls[0]!;
    expect(payload).toMatchObject({ label: 'createNextVoucher', err: 'CAE duplicado -- AFIP ya lo había procesado' });
    expect(msg).toContain('rechazó DESPUÉS de vencer el timeout');
  });
});
