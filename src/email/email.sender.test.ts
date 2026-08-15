import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ResendEmailSender, NoopEmailSender, createEmailSender } from './email.sender.js';

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
});

describe('NoopEmailSender', () => {
  it('no falla y loguea cuando no hay credenciales', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
