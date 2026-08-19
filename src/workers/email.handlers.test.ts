import { describe, it, expect, beforeEach } from 'vitest';
import { handleReservationConfirmedEmail } from './email.handlers.js';
import type { EmailSender, EmailMessage } from '../email/email.sender.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { BusinessProfile, UpdateBusinessProfileInput } from '../domain/business-profile.entities.js';
import type { DomainEvent } from '../repositories/domain-event.repository.js';

class FakeEmailSender implements EmailSender {
  public sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> { this.sent.push(message); }
}

class FakeBusinessProfileRepository implements BusinessProfileRepository {
  constructor(private profile: BusinessProfile) {}
  async get(): Promise<BusinessProfile> { return this.profile; }
  async update(input: UpdateBusinessProfileInput): Promise<BusinessProfile> {
    this.profile = {
      ...this.profile,
      ...(input.displayName !== undefined && { displayName: input.displayName }),
      ...(input.contactEmail !== undefined && { contactEmail: input.contactEmail }),
      ...(input.currency !== undefined && { currency: input.currency }),
      ...(input.timezone !== undefined && { timezone: input.timezone }),
      updatedAt: new Date(),
    };
    return this.profile;
  }
}

function fakeEvent(payload: Record<string, unknown>): DomainEvent {
  return { id: 1, businessId: 'biz-1', aggregateType: 'RESERVATION', aggregateId: 'res-1', eventType: 'reservation.confirmed', payload };
}

const now = new Date();

describe('handleReservationConfirmedEmail', () => {
  let emailSender: FakeEmailSender;

  beforeEach(() => { emailSender = new FakeEmailSender(); });

  it('envía el mail con la identidad del negocio como remitente y reply-to', async () => {
    const profileRepo = new FakeBusinessProfileRepository({
      id: 'default', displayName: 'Hotel Los Álamos', contactEmail: 'contacto@losalamos.com',
      currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires', defaultCheckInTime: '14:00:00', defaultCheckOutTime: '11:00:00',
    legalName: null, taxId: null, taxIdType: null, taxCondition: null,
    fiscalAddressLine1: null, fiscalAddressCity: null, fiscalAddressState: null,
    fiscalAddressPostalCode: null, fiscalAddressCountry: null, afipSalesPoint: null,
    defaultIvaRate: 21, pricesIncludeIva: true,
      createdAt: now, updatedAt: now,
    });
    const handler = handleReservationConfirmedEmail(emailSender, profileRepo);

    await handler(fakeEvent({
      customerEmail: 'cliente@example.com',
      customerName:  'Juan Pérez',
      resourceName:  'Habitación 101',
      startTime:     '2026-08-20T13:00:00.000Z',
      endTime:       '2026-08-21T13:00:00.000Z',
    }));

    expect(emailSender.sent).toHaveLength(1);
    expect(emailSender.sent[0]).toMatchObject({
      to: 'cliente@example.com',
      fromName: 'Hotel Los Álamos',
      replyTo: 'contacto@losalamos.com',
    });
    expect(emailSender.sent[0]!.subject).toContain('Hotel Los Álamos');
    expect(emailSender.sent[0]!.html).toContain('Habitación 101');
  });

  it('usa el nombre de plataforma por default si el negocio no cargó su identidad', async () => {
    const profileRepo = new FakeBusinessProfileRepository({
      id: 'default', displayName: null, contactEmail: null,
      currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires', defaultCheckInTime: '14:00:00', defaultCheckOutTime: '11:00:00',
    legalName: null, taxId: null, taxIdType: null, taxCondition: null,
    fiscalAddressLine1: null, fiscalAddressCity: null, fiscalAddressState: null,
    fiscalAddressPostalCode: null, fiscalAddressCountry: null, afipSalesPoint: null,
    defaultIvaRate: 21, pricesIncludeIva: true,
      createdAt: now, updatedAt: now,
    });
    const handler = handleReservationConfirmedEmail(emailSender, profileRepo);

    await handler(fakeEvent({
      customerEmail: 'cliente@example.com',
      customerName:  'Juan Pérez',
      resourceName:  'Habitación 101',
      startTime:     '2026-08-20T13:00:00.000Z',
      endTime:       '2026-08-21T13:00:00.000Z',
    }));

    expect(emailSender.sent[0]).toMatchObject({ fromName: 'ZuluHub' });
    expect(emailSender.sent[0]!.replyTo).toBeUndefined();
  });

  it('no envía nada si el cliente no tiene mail cargado (solo teléfono, ej.)', async () => {
    const profileRepo = new FakeBusinessProfileRepository({
      id: 'default', displayName: 'Hotel Los Álamos', contactEmail: null,
      currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires', defaultCheckInTime: '14:00:00', defaultCheckOutTime: '11:00:00',
    legalName: null, taxId: null, taxIdType: null, taxCondition: null,
    fiscalAddressLine1: null, fiscalAddressCity: null, fiscalAddressState: null,
    fiscalAddressPostalCode: null, fiscalAddressCountry: null, afipSalesPoint: null,
    defaultIvaRate: 21, pricesIncludeIva: true,
      createdAt: now, updatedAt: now,
    });
    const handler = handleReservationConfirmedEmail(emailSender, profileRepo);

    await handler(fakeEvent({
      customerEmail: null,
      customerName:  'Juan Pérez',
      resourceName:  'Habitación 101',
      startTime:     '2026-08-20T13:00:00.000Z',
      endTime:       '2026-08-21T13:00:00.000Z',
    }));

    expect(emailSender.sent).toHaveLength(0);
  });
});
