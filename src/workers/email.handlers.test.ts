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
    fiscalAddressPostalCode: null, fiscalAddressCountry: null, afipSalesPoint: null, afipCuit: null,
    defaultIvaRate: 21, pricesIncludeIva: true, defaultDepositPercentage: null, depositHoldHours: null, customerNumberPrefix: 'CLI', reservationNumberPrefix: 'RES',
      maintenanceHorizonDays: 30,
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
    fiscalAddressPostalCode: null, fiscalAddressCountry: null, afipSalesPoint: null, afipCuit: null,
    defaultIvaRate: 21, pricesIncludeIva: true, defaultDepositPercentage: null, depositHoldHours: null, customerNumberPrefix: 'CLI', reservationNumberPrefix: 'RES',
      maintenanceHorizonDays: 30,
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
    fiscalAddressPostalCode: null, fiscalAddressCountry: null, afipSalesPoint: null, afipCuit: null,
    defaultIvaRate: 21, pricesIncludeIva: true, defaultDepositPercentage: null, depositHoldHours: null, customerNumberPrefix: 'CLI', reservationNumberPrefix: 'RES',
      maintenanceHorizonDays: 30,
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

  // Regresión (19/08/2026): startTime/endTime de una reserva de alojamiento
  // son "medianoche UTC del día calendario" (Reservas, appfrontend-main),
  // no un instante real -- convertirlas al huso del negocio como si lo
  // fueran mostraba un horario sin relación con el check-in/check-out
  // configurado (reportado: "Desde"/"Hasta" mostraban 9pm-9pm ambos).
  it('alojamiento: muestra el check-in/check-out ESTÁNDAR del negocio, no el instante crudo convertido de huso', async () => {
    const profileRepo = new FakeBusinessProfileRepository({
      id: 'default', displayName: 'Hotel ZULU', contactEmail: null,
      currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires', defaultCheckInTime: '15:00:00', defaultCheckOutTime: '10:00:00',
      legalName: null, taxId: null, taxIdType: null, taxCondition: null,
      fiscalAddressLine1: null, fiscalAddressCity: null, fiscalAddressState: null,
      fiscalAddressPostalCode: null, fiscalAddressCountry: null, afipSalesPoint: null, afipCuit: null,
      defaultIvaRate: 21, pricesIncludeIva: true, defaultDepositPercentage: null, depositHoldHours: null, customerNumberPrefix: 'CLI', reservationNumberPrefix: 'RES',
      maintenanceHorizonDays: 30,
      createdAt: now, updatedAt: now,
    });
    const handler = handleReservationConfirmedEmail(emailSender, profileRepo);

    // Check-in 29/09, check-out 30/09 -- medianoche UTC de cada día, tal
    // cual los manda Reservas hoy.
    await handler(fakeEvent({
      customerEmail: 'cliente@example.com',
      customerName:  'Ale',
      resourceName:  'Habitación 03',
      startTime:     '2026-09-29T00:00:00.000Z',
      endTime:       '2026-09-30T00:00:00.000Z',
      isLodging:     true,
    }));

    const html = emailSender.sent[0]!.html;
    expect(html).toContain('29 de septiembre de 2026, 3:00 p. m.');
    expect(html).toContain('30 de septiembre de 2026, 10:00 a. m.');
    expect(html).not.toContain('9:00 p. m.');
  });

  it('turno con horario real (no alojamiento): sigue convirtiendo el instante al huso del negocio', async () => {
    const profileRepo = new FakeBusinessProfileRepository({
      id: 'default', displayName: 'Hotel ZULU', contactEmail: null,
      currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires', defaultCheckInTime: '15:00:00', defaultCheckOutTime: '10:00:00',
      legalName: null, taxId: null, taxIdType: null, taxCondition: null,
      fiscalAddressLine1: null, fiscalAddressCity: null, fiscalAddressState: null,
      fiscalAddressPostalCode: null, fiscalAddressCountry: null, afipSalesPoint: null, afipCuit: null,
      defaultIvaRate: 21, pricesIncludeIva: true, defaultDepositPercentage: null, depositHoldHours: null, customerNumberPrefix: 'CLI', reservationNumberPrefix: 'RES',
      maintenanceHorizonDays: 30,
      createdAt: now, updatedAt: now,
    });
    const handler = handleReservationConfirmedEmail(emailSender, profileRepo);

    // 13:00 UTC = 10:00 en Argentina (UTC-3) -- instante real de un turno.
    await handler(fakeEvent({
      customerEmail: 'cliente@example.com',
      customerName:  'Ale',
      resourceName:  'Barbero Isahía',
      startTime:     '2026-08-20T13:00:00.000Z',
      endTime:       '2026-08-20T13:30:00.000Z',
      isLodging:     false,
    }));

    const html = emailSender.sent[0]!.html;
    expect(html).toContain('10:00');
  });
});
