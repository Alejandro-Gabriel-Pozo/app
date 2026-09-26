import { describe, it, expect, vi } from 'vitest';
import { CreditNoteReviewSlaWorker, CREDIT_NOTE_REVIEW_SLA_MS } from './credit-note-review-sla.worker.js';
import { InMemoryCreditNoteRequestRepository } from '../facturacion/in-memory.credit-note-request.repository.js';
import type { CreditNoteRequest } from '../facturacion/credit-note-request.entities.js';
import type { EmailSender, EmailMessage } from '../email/email.sender.js';
import type { CreditNoteReviewSlaWorkerDeps } from './credit-note-review-sla.worker.js';

const NOW = new Date('2026-09-26T12:00:00Z').getTime();

function fakeSender(): EmailSender & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return { sent, async send(m) { sent.push(m); } };
}

function makeRequest(overrides: Partial<CreditNoteRequest> = {}): CreditNoteRequest {
  return {
    id: 'cnr-1',
    businessId: 'biz-1',
    invoiceId: 'inv-nc-1',
    reversedInvoiceId: 'inv-orig-1',
    orderId: null,
    reservationId: 'res-1',
    state: 'EN_REVISION_MANUAL',
    resolutionOutcome: null,
    resolvedBy: null,
    resolvedAt: null,
    resolutionNote: null,
    slaAlertSentAt: null,
    createdAt: new Date(NOW - 49 * 60 * 60 * 1000), // 49hs -- cruza el SLA de 48hs
    updatedAt: new Date(NOW - 49 * 60 * 60 * 1000),
    ...overrides,
  };
}

function mkDeps(over: Partial<CreditNoteReviewSlaWorkerDeps> = {}): CreditNoteReviewSlaWorkerDeps {
  return {
    businessId: 'biz-1',
    creditNoteRequestRepo: new InMemoryCreditNoteRequestRepository(),
    getManagementEmails: vi.fn(async () => ['manager@x.com']),
    getBusinessDisplayName: vi.fn(async () => 'Hotel Ejemplo'),
    emailSender: fakeSender(),
    dashboardUrl: 'https://panel/dashboard/facturacion',
    now: () => NOW,
    ...over,
  };
}

describe('CreditNoteReviewSlaWorker', () => {
  it('sin filas EN_REVISION_MANUAL -- no consulta destinatarios ni envía', async () => {
    const deps = mkDeps();
    const worker = new CreditNoteReviewSlaWorker(deps);

    await worker.poll();

    expect(deps.getManagementEmails).not.toHaveBeenCalled();
    expect((deps.emailSender as ReturnType<typeof fakeSender>).sent).toHaveLength(0);
  });

  it('fila EN_REVISION_MANUAL que todavía no cruzó el SLA -- no avisa', async () => {
    const repo = new InMemoryCreditNoteRequestRepository();
    repo.seed(makeRequest({ createdAt: new Date(NOW - 10 * 60 * 60 * 1000) })); // 10hs, no cruza 48hs
    const sender = fakeSender();
    const worker = new CreditNoteReviewSlaWorker(mkDeps({ creditNoteRequestRepo: repo, emailSender: sender }));

    await worker.poll();

    expect(sender.sent).toHaveLength(0);
    const row = await repo.findById('cnr-1');
    expect(row!.slaAlertSentAt).toBeNull();
  });

  it('fila que cruzó el SLA -- avisa, marca sla_alert_sent_at y el link apunta a la bandeja', async () => {
    const repo = new InMemoryCreditNoteRequestRepository();
    repo.seed(makeRequest());
    const sender = fakeSender();
    const worker = new CreditNoteReviewSlaWorker(mkDeps({ creditNoteRequestRepo: repo, emailSender: sender }));

    await worker.poll();

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.to).toBe('manager@x.com');
    expect(sender.sent[0]!.subject).toContain('Hotel Ejemplo');
    expect(sender.sent[0]!.html).toContain('https://panel/dashboard/facturacion');
    expect(sender.sent[0]!.html).toContain('cnr-1');
    expect(sender.sent[0]!.html).toContain('reserva res-1');

    const row = await repo.findById('cnr-1');
    expect(row!.slaAlertSentAt).not.toBeNull();
  });

  it('fila con subject ORDER -- el resumen menciona la orden, no la reserva', async () => {
    const repo = new InMemoryCreditNoteRequestRepository();
    repo.seed(makeRequest({ id: 'cnr-2', orderId: 'ord-1', reservationId: null }));
    const sender = fakeSender();
    const worker = new CreditNoteReviewSlaWorker(mkDeps({ creditNoteRequestRepo: repo, emailSender: sender }));

    await worker.poll();

    expect(sender.sent[0]!.html).toContain('orden ord-1');
  });

  it('fila ya notificada (sla_alert_sent_at poblado) -- no se vuelve a avisar (escalamiento único, no reiterado)', async () => {
    const repo = new InMemoryCreditNoteRequestRepository();
    repo.seed(makeRequest({ slaAlertSentAt: new Date(NOW - 60 * 60 * 1000) }));
    const sender = fakeSender();
    const worker = new CreditNoteReviewSlaWorker(mkDeps({ creditNoteRequestRepo: repo, emailSender: sender }));

    await worker.poll();

    expect(sender.sent).toHaveLength(0);
  });

  it('sin destinatarios MANAGEMENT -- no envía, pero SÍ marca la fila (no reintenta storm, mismo criterio que dead-letter-notify)', async () => {
    const repo = new InMemoryCreditNoteRequestRepository();
    repo.seed(makeRequest());
    const sender = fakeSender();
    const worker = new CreditNoteReviewSlaWorker(mkDeps({
      creditNoteRequestRepo: repo,
      emailSender: sender,
      getManagementEmails: async () => [],
    }));

    await worker.poll();

    expect(sender.sent).toHaveLength(0);
    const row = await repo.findById('cnr-1');
    expect(row!.slaAlertSentAt).not.toBeNull();
  });

  it('varias filas cruzan el SLA en el mismo ciclo -- UN solo mail con todas listadas (batching, mismo criterio que dead-letter)', async () => {
    const repo = new InMemoryCreditNoteRequestRepository();
    repo.seed(makeRequest({ id: 'cnr-1', reservationId: 'res-1' }));
    repo.seed(makeRequest({ id: 'cnr-2', orderId: 'ord-2', reservationId: null }));
    const sender = fakeSender();
    const worker = new CreditNoteReviewSlaWorker(mkDeps({ creditNoteRequestRepo: repo, emailSender: sender }));

    await worker.poll();

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.html).toContain('cnr-1');
    expect(sender.sent[0]!.html).toContain('cnr-2');
    expect(sender.sent[0]!.subject).toContain('2 solicitudes');
  });

  it('el error al marcar una fila no bloquea a las demás del mismo ciclo', async () => {
    const repo = new InMemoryCreditNoteRequestRepository();
    repo.seed(makeRequest({ id: 'cnr-1' }));
    repo.seed(makeRequest({ id: 'cnr-2', orderId: 'ord-2', reservationId: null }));
    const originalMark = repo.markSlaAlertSent.bind(repo);
    repo.markSlaAlertSent = async (id: string) => {
      if (id === 'cnr-1') throw new Error('boom');
      return originalMark(id);
    };
    const sender = fakeSender();
    const worker = new CreditNoteReviewSlaWorker(mkDeps({ creditNoteRequestRepo: repo, emailSender: sender }));

    await worker.poll();

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.html).toContain('cnr-2');
    expect(sender.sent[0]!.html).not.toContain('cnr-1');
  });

  it('listEligibleForSlaAlert() tira -- poll() resuelve (no rechaza) y no se manda nada (BLOCKING 1, gate 26/09/2026)', async () => {
    const repo = new InMemoryCreditNoteRequestRepository();
    repo.seed(makeRequest());
    repo.listEligibleForSlaAlert = async () => {
      throw new Error('tenant db timeout');
    };
    const sender = fakeSender();
    const getManagementEmails = vi.fn(async () => ['manager@x.com']);
    const worker = new CreditNoteReviewSlaWorker(
      mkDeps({ creditNoteRequestRepo: repo, emailSender: sender, getManagementEmails }),
    );

    await expect(worker.poll()).resolves.toBeUndefined();

    expect(sender.sent).toHaveLength(0);
    expect(getManagementEmails).not.toHaveBeenCalled();
  });

  it('getManagementEmails() tira -- poll() resuelve, las filas NO quedan marcadas, y el próximo poll tras recuperarse manda exactamente una vez (BLOCKING 2, gate 26/09/2026)', async () => {
    const repo = new InMemoryCreditNoteRequestRepository();
    repo.seed(makeRequest());
    const sender = fakeSender();
    let shouldFail = true;
    const getManagementEmails = vi.fn(async () => {
      if (shouldFail) throw new Error('platform db unreachable');
      return ['manager@x.com'];
    });
    const worker = new CreditNoteReviewSlaWorker(
      mkDeps({ creditNoteRequestRepo: repo, emailSender: sender, getManagementEmails }),
    );

    await expect(worker.poll()).resolves.toBeUndefined();

    // Falló ANTES de reclamar -- la fila queda intacta para el próximo poll.
    expect(sender.sent).toHaveLength(0);
    let row = await repo.findById('cnr-1');
    expect(row!.slaAlertSentAt).toBeNull();

    // Se recupera la BD de plataforma -- el próximo poll manda exactamente una vez.
    shouldFail = false;
    await worker.poll();

    expect(sender.sent).toHaveLength(1);
    row = await repo.findById('cnr-1');
    expect(row!.slaAlertSentAt).not.toBeNull();
  });

  it('CREDIT_NOTE_REVIEW_SLA_MS es 48 horas (§6.5 bis, pregunta A, RESUELTA)', () => {
    expect(CREDIT_NOTE_REVIEW_SLA_MS).toBe(48 * 60 * 60 * 1000);
  });

  it('start()/stop() son idempotentes y no dejan timers colgados', async () => {
    const worker = new CreditNoteReviewSlaWorker(mkDeps());
    worker.start();
    worker.start(); // no-op, ya hay un intervalId
    await worker.stop();
    await worker.stop(); // no-op, ya se detuvo
  });
});
