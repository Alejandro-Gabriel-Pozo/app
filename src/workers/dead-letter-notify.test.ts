import { describe, it, expect, vi } from 'vitest';
import { makeDeadLetterEmailNotifier } from './dead-letter-notify.js';
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

describe('makeDeadLetterEmailNotifier (O5 / D2-C)', () => {
  it('sin eventos -> no consulta destinatarios ni envía', async () => {
    const getManagementEmails = vi.fn(async () => ['a@x.com']);
    const sender = fakeSender();
    const notify = makeDeadLetterEmailNotifier({ businessId: 'biz-1', getManagementEmails, emailSender: sender, dashboardUrl: 'https://p/dashboard' });

    await notify([]);

    expect(getManagementEmails).not.toHaveBeenCalled();
    expect(sender.sent).toHaveLength(0);
  });

  it('sin destinatarios MANAGEMENT -> no envía (degrada al banner)', async () => {
    const sender = fakeSender();
    const notify = makeDeadLetterEmailNotifier({
      businessId: 'biz-1', getManagementEmails: async () => [], emailSender: sender, dashboardUrl: 'https://p/dashboard',
    });

    await notify([ev()]);

    expect(sender.sent).toHaveLength(0);
  });

  it('un email por destinatario, UN solo cuerpo con todos los eventos del ciclo', async () => {
    const sender = fakeSender();
    const notify = makeDeadLetterEmailNotifier({
      businessId: 'biz-1',
      getManagementEmails: async () => ['a@x.com', 'b@x.com'],
      emailSender: sender,
      dashboardUrl: 'https://panel/dashboard',
    });

    await notify([
      ev({ id: 1, eventType: 'order.completed', lastError: 'ChargeNeverCreatedError' }),
      ev({ id: 2, eventType: 'reservation.confirmed', lastError: 'PG_40P01' }),
    ]);

    expect(sender.sent).toHaveLength(2);
    expect(sender.sent.map((m) => m.to)).toEqual(['a@x.com', 'b@x.com']);
    // Mismo cuerpo para los dos, con los dos eventos adentro.
    expect(sender.sent[0]!.html).toBe(sender.sent[1]!.html);
    expect(sender.sent[0]!.html).toContain('no se le generó el cargo');       // describeDeadLetter(ChargeNeverCreatedError)
    expect(sender.sent[0]!.html).toContain('Falla temporal de base de datos'); // describeDeadLetter(PG_40P01)
    expect(sender.sent[0]!.html).toContain('https://panel/dashboard');
    expect(sender.sent[0]!.subject).toContain('2 eventos');
    // A7.1: nunca el lastError crudo en el cuerpo.
    expect(sender.sent[0]!.html).not.toContain('ChargeNeverCreatedError');
    expect(sender.sent[0]!.html).not.toContain('PG_40P01');
  });

  it('si un envío falla, los demás igual salen (allSettled)', async () => {
    const sent: string[] = [];
    const sender: EmailSender = {
      async send(m) {
        if (m.to === 'boom@x.com') throw new Error('resend 500');
        sent.push(m.to);
      },
    };
    const notify = makeDeadLetterEmailNotifier({
      businessId: 'biz-1',
      getManagementEmails: async () => ['ok1@x.com', 'boom@x.com', 'ok2@x.com'],
      emailSender: sender,
      dashboardUrl: 'https://p/dashboard',
    });

    await expect(notify([ev()])).resolves.toBeUndefined();
    expect(sent).toEqual(['ok1@x.com', 'ok2@x.com']);
  });
});
