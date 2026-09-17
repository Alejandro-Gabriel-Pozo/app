import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ResendEmailSender, NoopEmailSender, createEmailSender } from './email.sender.js';
import { logger } from '../logger.js';

describe('ResendEmailSender', () => {
  const originalFetch = global.fetch;

  afterEach(() => { global.fetch = originalFetch; });

  it('llama a la API de Resend con el remitente fijo (fromEmail) y el nombre del mensaje', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;

    const sender = new ResendEmailSender('re_test_key', 'notificaciones@zuluhub.com.ar');
    await sender.send({
      to: 'cliente@example.com',
      fromName: 'Hotel Los Álamos',
      replyTo: 'contacto@losalamos.com',
      subject: 'Reserva confirmada',
      html: '<p>hola</p>',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(options.headers.Authorization).toBe('Bearer re_test_key');
    const body = JSON.parse(options.body);
    expect(body.from).toBe('Hotel Los Álamos <notificaciones@zuluhub.com.ar>');
    expect(body.reply_to).toBe('contacto@losalamos.com');
    expect(body.to).toEqual(['cliente@example.com']);
  });

  it('omite reply_to si el mensaje no lo trae', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;

    const sender = new ResendEmailSender('re_test_key', 'notificaciones@zuluhub.com.ar');
    await sender.send({ to: 'cliente@example.com', fromName: 'ZuluHub', subject: 's', html: 'h' });

    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body.reply_to).toBeUndefined();
  });

  it('lanza si Resend responde con error', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => 'invalid from' }) as unknown as typeof fetch;

    const sender = new ResendEmailSender('re_test_key', 'notificaciones@zuluhub.com.ar');
    await expect(
      sender.send({ to: 'cliente@example.com', fromName: 'ZuluHub', subject: 's', html: 'h' }),
    ).rejects.toThrow(/422/);
  });

  // D-20 (17/09/2026, Wave 9) -- el fetch a Resend ahora lleva
  // AbortSignal.timeout(10000).
  describe('D-20 -- timeout del fetch a Resend', () => {
    const sender = new ResendEmailSender('re_test_key', 'notificaciones@zuluhub.com.ar');
    const msg = { to: 'cliente@example.com', fromName: 'ZuluHub', subject: 's', html: 'h' };

    it('un timeout se mapea a un Error con el ms declarado', async () => {
      const timeoutErr = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      global.fetch = vi.fn().mockRejectedValue(timeoutErr) as unknown as typeof fetch;

      await expect(sender.send(msg)).rejects.toThrow(/Resend no respondió en 10000ms/);
    });

    it('pasa un AbortSignal al fetch', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      global.fetch = fetchMock as unknown as typeof fetch;

      await sender.send(msg);

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(options.signal).toBeInstanceOf(AbortSignal);
    });

    it('una falla de fetch que NO es timeout (ej. DNS caído) propaga tal cual, sin envolver', async () => {
      const dnsErr = new TypeError('fetch failed');
      global.fetch = vi.fn().mockRejectedValue(dnsErr) as unknown as typeof fetch;

      await expect(sender.send(msg)).rejects.toBe(dnsErr);
    });
  });
});

describe('ResendEmailSender — header From (EMAIL-FROMNAME-RFC5322-01)', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  async function sendAndGetFrom(fromName: string): Promise<string> {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
    const sender = new ResendEmailSender('re_test_key', 'notificaciones@zuluhub.com.ar');
    await sender.send({ to: 'cliente@example.com', fromName, subject: 's', html: 'h' });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    return body.from as string;
  }

  it('nombre simple -- no cambia, sin comillas (contrato de no-regresión)', async () => {
    expect(await sendAndGetFrom('ZuluHub')).toBe('ZuluHub <notificaciones@zuluhub.com.ar>');
  });

  it('nombre con coma -- se quotea (la coma se lee como separador de direcciones)', async () => {
    expect(await sendAndGetFrom('Hotel Los Andes, S.A.'))
      .toBe('"Hotel Los Andes, S.A." <notificaciones@zuluhub.com.ar>');
  });

  it('nombre con comillas internas -- se escapan y se quotea todo', async () => {
    expect(await sendAndGetFrom('Hotel "Los Andes"'))
      .toBe('"Hotel \\"Los Andes\\"" <notificaciones@zuluhub.com.ar>');
  });

  it('nombre con < y > -- se quotea (rompe la sintaxis addr-spec)', async () => {
    expect(await sendAndGetFrom('Hotel <Los Andes>'))
      .toBe('"Hotel <Los Andes>" <notificaciones@zuluhub.com.ar>');
  });

  it('nombre con parentesis -- se quotea (sin quotear, RFC 5322 los lee como comentario y descarta el texto)', async () => {
    expect(await sendAndGetFrom('Hotel (ex Posada) Los Andes'))
      .toBe('"Hotel (ex Posada) Los Andes" <notificaciones@zuluhub.com.ar>');
  });

  it('nombre con @ -- se quotea', async () => {
    expect(await sendAndGetFrom('Hotel @ Costanera'))
      .toBe('"Hotel @ Costanera" <notificaciones@zuluhub.com.ar>');
  });

  it('nombre con corchetes -- se quotea (delimitadores de domain-literal)', async () => {
    expect(await sendAndGetFrom('Hotel [Sucursal Centro]'))
      .toBe('"Hotel [Sucursal Centro]" <notificaciones@zuluhub.com.ar>');
  });

  it('nombre con backslash -- se escapa y se quotea', async () => {
    expect(await sendAndGetFrom('Hotel\\Andes'))
      .toBe('"Hotel\\\\Andes" <notificaciones@zuluhub.com.ar>');
  });

  it('nombre con caracter de control -- se descarta (strip), no se rechaza el envio', async () => {
    expect(await sendAndGetFrom('Hotel\x07Andes'))
      .toBe('HotelAndes <notificaciones@zuluhub.com.ar>');
  });

  it('nombre no-ASCII combinado con caracter especial -- UTF-8 crudo + quoteado', async () => {
    expect(await sendAndGetFrom('Hotel "Los Álamos", S.A.'))
      .toBe('"Hotel \\"Los Álamos\\", S.A." <notificaciones@zuluhub.com.ar>');
  });
});

describe('NoopEmailSender', () => {
  it('no falla y loguea cuando no hay credenciales', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    const sender = new NoopEmailSender();
    await expect(
      sender.send({ to: 'cliente@example.com', fromName: 'ZuluHub', subject: 's', html: 'h' }),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });
});

describe('createEmailSender', () => {
  const ORIGINAL = { RESEND_API_KEY: process.env.RESEND_API_KEY, RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL };

  beforeEach(() => { delete process.env.RESEND_API_KEY; delete process.env.RESEND_FROM_EMAIL; });
  afterEach(() => {
    for (const [key, value] of Object.entries(ORIGINAL)) {
      if (value !== undefined) process.env[key] = value; else delete process.env[key];
    }
  });

  it('devuelve NoopEmailSender si faltan las variables de entorno', () => {
    expect(createEmailSender()).toBeInstanceOf(NoopEmailSender);
  });

  it('devuelve ResendEmailSender si están las dos variables', () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.RESEND_FROM_EMAIL = 'notificaciones@zuluhub.com.ar';
    expect(createEmailSender()).toBeInstanceOf(ResendEmailSender);
  });
});
