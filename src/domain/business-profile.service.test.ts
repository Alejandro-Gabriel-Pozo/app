import { describe, it, expect } from 'vitest';
import { BusinessProfileService } from './business-profile.service.js';
import { FiscalProfileLockedError } from './errors.js';
import { InMemoryAuditLogRepository } from '../repositories/in-memory.audit-log.repository.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { BusinessProfile, UpdateBusinessProfileInput } from './business-profile.entities.js';

/**
 * D3 (pendientes-2026-08-19.md): el perfil fiscal se bloquea para
 * Roles.MANAGEMENT (no OWNER_ONLY) una vez que el CUIT ya está cargado, y
 * cada update() queda auditado. Fake mínimo de BusinessProfileRepository
 * — no hay InMemoryBusinessProfileRepository en el repo todavía.
 */
class FakeBusinessProfileRepository implements BusinessProfileRepository {
  private profile: BusinessProfile;

  constructor(initial: BusinessProfile) {
    this.profile = initial;
  }

  async get(): Promise<BusinessProfile> {
    return this.profile;
  }

  async update(input: UpdateBusinessProfileInput): Promise<BusinessProfile> {
    this.profile = { ...this.profile, ...input, updatedAt: new Date() } as BusinessProfile;
    return this.profile;
  }
}

const now = new Date();

function makeProfile(overrides: Partial<BusinessProfile> = {}): BusinessProfile {
  return {
    id: 'default',
    displayName: 'Hotel Los Álamos',
    contactEmail: 'contacto@losalamos.test',
    currency: 'ARS',
    timezone: 'America/Argentina/Buenos_Aires',
    defaultCheckInTime: '15:00:00',
    defaultCheckOutTime: '10:00:00',
    legalName: null,
    taxId: null,
    taxIdType: null,
    taxCondition: null,
    fiscalAddressLine1: null,
    fiscalAddressCity: null,
    fiscalAddressState: null,
    fiscalAddressPostalCode: null,
    fiscalAddressCountry: null,
    afipSalesPoint: null,
    afipCuit: null,
    defaultIvaRate: 21,
    pricesIncludeIva: true,
    defaultDepositPercentage: null,
    depositHoldHours: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('BusinessProfileService.update — candado del perfil fiscal (D3)', () => {
  it('antes de la primera carga (taxId null), cualquier MANAGEMENT puede cargar el perfil fiscal completo', async () => {
    const repo = new FakeBusinessProfileRepository(makeProfile());
    const auditLog = new InMemoryAuditLogRepository();
    const service = new BusinessProfileService(repo, auditLog);

    const updated = await service.update(
      { legalName: 'Los Álamos SRL', taxId: '30-12345678-9' },
      'ident-admin',
      /* isOwner */ false,
    );

    expect(updated.taxId).toBe('30-12345678-9');
  });

  it('con el CUIT ya cargado, un MANAGEMENT no-dueño no puede tocar un campo fiscal', async () => {
    const repo = new FakeBusinessProfileRepository(makeProfile({ taxId: '30-12345678-9', legalName: 'Los Álamos SRL' }));
    const auditLog = new InMemoryAuditLogRepository();
    const service = new BusinessProfileService(repo, auditLog);

    await expect(
      service.update({ legalName: 'Otro Nombre SRL' }, 'ident-admin', false),
    ).rejects.toThrow(FiscalProfileLockedError);

    expect(await repo.get()).toMatchObject({ legalName: 'Los Álamos SRL' }); // no se tocó
    expect(auditLog.all()).toHaveLength(0); // nada que auditar, el update ni corrió
  });

  it('con el CUIT ya cargado, el dueño (isOwner=true) sí puede corregir un dato fiscal, y queda auditado', async () => {
    const repo = new FakeBusinessProfileRepository(makeProfile({ taxId: '30-12345678-9', legalName: 'Los Álamos SRL' }));
    const auditLog = new InMemoryAuditLogRepository();
    const service = new BusinessProfileService(repo, auditLog);

    const updated = await service.update({ legalName: 'Los Álamos Hotel SRL' }, 'ident-owner', true);

    expect(updated.legalName).toBe('Los Álamos Hotel SRL');
    const entries = auditLog.all();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entity: 'business_profile', entityId: 'default', field: 'legalName',
      oldValue: 'Los Álamos SRL', newValue: 'Los Álamos Hotel SRL', changedBy: 'ident-owner',
    });
  });

  it('con el CUIT ya cargado, un MANAGEMENT no-dueño SÍ puede seguir editando campos NO fiscales (displayName)', async () => {
    const repo = new FakeBusinessProfileRepository(makeProfile({ taxId: '30-12345678-9' }));
    const auditLog = new InMemoryAuditLogRepository();
    const service = new BusinessProfileService(repo, auditLog);

    const updated = await service.update({ displayName: 'Los Álamos (nuevo nombre de fantasía)' }, 'ident-admin', false);

    expect(updated.displayName).toBe('Los Álamos (nuevo nombre de fantasía)');
    expect(auditLog.all()).toHaveLength(1);
  });

  it('reenviar un campo fiscal con el MISMO valor (formulario completo) no dispara el candado -- solo importa si el VALOR cambia', async () => {
    const repo = new FakeBusinessProfileRepository(makeProfile({ taxId: '30-12345678-9', legalName: 'Los Álamos SRL', defaultIvaRate: 21 }));
    const auditLog = new InMemoryAuditLogRepository();
    const service = new BusinessProfileService(repo, auditLog);

    // Mismo patrón que el formulario real (mi-negocio/page.tsx): reenvía
    // TODOS los campos fiscales tal cual están, solo cambia defaultIvaRate.
    const updated = await service.update(
      { legalName: 'Los Álamos SRL', taxId: '30-12345678-9', defaultIvaRate: 25 },
      'ident-admin',
      false,
    );

    expect(updated.defaultIvaRate).toBe(25);
    expect(auditLog.all().map((e) => e.field)).toEqual(['defaultIvaRate']);
  });

  it('un patch que no cambia nada no escribe filas de auditoría (recordFieldChanges es no-op)', async () => {
    const repo = new FakeBusinessProfileRepository(makeProfile({ displayName: 'Hotel Los Álamos' }));
    const auditLog = new InMemoryAuditLogRepository();
    const service = new BusinessProfileService(repo, auditLog);

    await service.update({ displayName: 'Hotel Los Álamos' }, 'ident-admin', false);

    expect(auditLog.all()).toHaveLength(0);
  });
});
