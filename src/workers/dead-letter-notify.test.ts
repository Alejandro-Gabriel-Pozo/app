import { describe, it, expect, vi } from 'vitest';
import { makeDeadLetterEmailNotifier, type DeadLetterNotifierDeps } from './dead-letter-notify.js';
import type { EmailSender, EmailMessage } from '../email/email.sender.js';
import type { DomainEvent } from '../repositories/domain-event.repository.js';

function ev(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    id: 1, businessId: 'biz-1', aggregateType: 'ORDER', aggregateId: 'ord-1',
    eventType: 'order.completed', payload: {}, retryCount: 60,
    lastError: 'PG_40P01', failedAt: new Date(), dispatchedAt: null,
    ...overrides,
  };
}

function fakeSender(): EmailSender & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return { sent, async send(m) { sent.push(m); } };
}

function mkDeps(over: Partial<DeadLetterNotifierDeps> = {}): DeadLetterNotifierDeps {
  return {
    businessId: 'biz-1',
    getManagementEmails: vi.fn(async () => ['a@x.com']),
    getBusinessDisplayName: vi.fn(async () => 'Hotel Ejemplo'),
    emailSender: fakeSender(),
    dashboardUrl: 'https://panel/dashboard',
    ...over,
  };
}

describe('makeDeadLetterEmailNotifier (O5 / D2-C)', () => {
  it('sin eventos -> no consulta destinatarios ni envía', async () => {
    const deps = mkDeps();
    const notify = makeDeadLetterEmailNotifier(deps);

    await notify([]);

    expect(deps.getManagementEmails).not.toHaveBeenCalled();
    expect((deps.emailSender as ReturnType<typeof fakeSender>).sent).toHaveLength(0);
  });

  it('sin destinatarios MANAGEMENT -> no envía (degrada al banner)', async () => {
    const sender = fakeSender();
    const notify = makeDeadLetterEmailNotifier(mkDeps({ getManagementEmails: async () => [], emailSender: sender }));

    await notify([ev()]);

    expect(sender.sent).toHaveLength(0);
  });

  it('un email por destinatario, UN cuerpo con todos los eventos, con el nombre del negocio', async () => {
    const sender = fakeSender();
    const notify = makeDeadLetterEmailNotifier(mkDeps({
      getManagementEmails: async () => ['a@x.com', 'b@x.com'],
      getBusinessDisplayName: async () => 'Hotel los Álamos',
      emailSender: sender,
    }));

    await notify([
      ev({ id: 1, eventType: 'order.completed', lastError: 'ChargeNeverCreatedError' }),
      ev({ id: 2, eventType: 'reservation.confirmed', lastError: 'PG_40P01' }),
    ]);

    expect(sender.sent).toHaveLength(2);
    expect(sender.sent.map((m) => m.to)).toEqual(['a@x.com', 'b@x.com']);
    expect(sender.sent[0]!.html).toBe(sender.sent[1]!.html);
    expect(sender.sent[0]!.fromName).toBe('Hotel los Álamos');
    expect(sender.sent[0]!.subject).toContain('Hotel los Álamos');
    expect(sender.sent[0]!.subject).toContain('2 eventos');
    expect(sender.sent[0]!.html).toContain('Hotel los Álamos');
    expect(sender.sent[0]!.html).toContain('no se le generó el cargo');
    expect(sender.sent[0]!.html).toContain('Falla temporal de base de datos');
    expect(sender.sent[0]!.html).toContain('https://panel/dashboard');
    // A7.1: nunca el lastError crudo.
    expect(sender.sent[0]!.html).not.toContain('ChargeNeverCreatedError');
    expect(sender.sent[0]!.html).not.toContain('PG_40P01');
  });

  it('display_name null -> fromName cae al default de plataforma', async () => {
    const sender = fakeSender();
    const notify = makeDeadLetterEmailNotifier(mkDeps({ getBusinessDisplayName: async () => null, emailSender: sender }));

    await notify([ev()]);

    expect(sender.sent[0]!.fromName).toBe('ZuluHub');
  });

  it('getBusinessDisplayName que RECHAZA (tenant DB caída) -> el mail IGUAL sale, con el default', async () => {
    const sender = fakeSender();
    const notify = makeDeadLetterEmailNotifier(mkDeps({
      getBusinessDisplayName: async () => { throw new Error('tenant DB timeout'); },
      emailSender: sender,
    }));

    await expect(notify([ev()])).resolves.toBeUndefined();
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.fromName).toBe('ZuluHub');
  });

  it('si un envío falla, los demás igual salen (allSettled)', async () => {
    const sent: string[] = [];
    const sender: EmailSender = {
      async send(m) { if (m.to === 'boom@x.com') throw new Error('resend 500'); sent.push(m.to); },
    };
    const notify = makeDeadLetterEmailNotifier(mkDeps({
      getManagementEmails: async () => ['ok1@x.com', 'boom@x.com', 'ok2@x.com'],
      emailSender: sender,
    }));

    await expect(notify([ev()])).resolves.toBeUndefined();
    expect(sent).toEqual(['ok1@x.com', 'ok2@x.com']);
  });

  describe('throttle entre ciclos (B1)', () => {
    it('un segundo aviso dentro de la ventana se SUPRIME (no consulta ni envía)', async () => {
      let t = 1_000_000;
      const getManagementEmails = vi.fn(async () => ['a@x.com']);
      const sender = fakeSender();
      const notify = makeDeadLetterEmailNotifier(mkDeps({
        getManagementEmails, emailSender: sender, cooldownMs: 900_000, now: () => t,
      }));

      await notify([ev()]);              // envía
      t += 300_000;                       // +5 min, dentro de la ventana
      await notify([ev({ id: 2 })]);      // suprimido

      expect(sender.sent).toHaveLength(1);
      expect(getManagementEmails).toHaveBeenCalledTimes(1);
    });

    it('pasada la ventana, vuelve a avisar', async () => {
      let t = 1_000_000;
      const sender = fakeSender();
      const notify = makeDeadLetterEmailNotifier(mkDeps({
        emailSender: sender, cooldownMs: 900_000, now: () => t,
      }));

      await notify([ev()]);
      t += 900_001;                       // justo pasada la ventana
      await notify([ev({ id: 2 })]);

      expect(sender.sent).toHaveLength(2);
    });

    it('el cooldown entra aunque el ciclo no tenga destinatarios (no re-loguea cada 5s)', async () => {
      let t = 1_000_000;
      const getManagementEmails = vi.fn(async () => [] as string[]);
      const notify = makeDeadLetterEmailNotifier(mkDeps({
        getManagementEmails, cooldownMs: 900_000, now: () => t,
      }));

      await notify([ev()]);              // 0 destinatarios -> igual entra en cooldown
      t += 5_000;
      await notify([ev({ id: 2 })]);     // suprimido

      expect(getManagementEmails).toHaveBeenCalledTimes(1);
    });
  });
});
