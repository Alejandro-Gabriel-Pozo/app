import { describe, it, expect, vi } from 'vitest';
import type { Arca } from '@arcasdk/core';
import { PadronService } from './padron.service.js';
import type { AfipCredentialsRepository, AfipCredentials, AfipCredentialsStatus, AfipTicketCache } from './afip-credentials.repository.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { BusinessProfile, UpdateBusinessProfileInput } from '../domain/business-profile.entities.js';
import { AfipNotConfiguredError, AfipPadronUnavailableError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Fakes — mismo patrón que invoice.service.test.ts
// ---------------------------------------------------------------------------

class FakeBusinessProfileRepository implements BusinessProfileRepository {
  constructor(private readonly profile: BusinessProfile) {}
  async get() { return this.profile; }
  async update(_input: UpdateBusinessProfileInput) { return this.profile; }
}

class FakeAfipCredentialsRepository implements AfipCredentialsRepository {
  constructor(private readonly credentials: AfipCredentials | null) {}
  async getStatus(): Promise<AfipCredentialsStatus> {
    return { configured: this.credentials !== null, environment: this.credentials?.environment ?? null };
  }
  async getDecrypted() { return this.credentials; }
  async save() {}
  async clear() {}
  async getTicket(): Promise<AfipTicketCache | null> { return null; }
  async saveTicket() {}
  async clearTicket() {}
}

function makeProfile(overrides: Partial<BusinessProfile> = {}): BusinessProfile {
  const now = new Date();
  return {
    id: 'default', displayName: 'Hotel ZULU', contactEmail: null,
    currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires', defaultCheckInTime: '14:00:00', defaultCheckOutTime: '11:00:00',
    legalName: 'Hotel Test SRL', taxId: '20111111112', taxIdType: 'CUIT', taxCondition: 'Responsable Inscripto',
    fiscalAddressLine1: null, fiscalAddressCity: null, fiscalAddressState: null,
    fiscalAddressPostalCode: null, fiscalAddressCountry: null, afipSalesPoint: 3, afipCuit: null,
    defaultIvaRate: 21, pricesIncludeIva: true,
    defaultDepositPercentage: null, depositHoldHours: null, customerNumberPrefix: 'CLI', reservationNumberPrefix: 'RES',
    createdAt: now, updatedAt: now,
    ...overrides,
  };
}

function fakeArcaClient(overrides: {
  getTaxpayerDetails?: ReturnType<typeof vi.fn>;
  getTaxIDByDocument?: ReturnType<typeof vi.fn>;
  getIvaReceptorTypes?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    registerScopeFiveService: {
      getTaxpayerDetails: overrides.getTaxpayerDetails ?? vi.fn().mockResolvedValue(null),
    },
    registerScopeThirteenService: {
      getTaxIDByDocument: overrides.getTaxIDByDocument ?? vi.fn().mockResolvedValue({ idPersona: [] }),
    },
    electronicBillingService: {
      getIvaReceptorTypes: overrides.getIvaReceptorTypes ?? vi.fn().mockResolvedValue({ resultGet: undefined }),
    },
  } as unknown as Arca;
}

function buildService(client: Arca, credentials: AfipCredentials | null = { cert: 'c', key: 'k', environment: 'homologacion' }) {
  const clientFactory = vi.fn().mockReturnValue(client);
  return new PadronService(
    new FakeBusinessProfileRepository(makeProfile()),
    new FakeAfipCredentialsRepository(credentials),
    clientFactory,
  );
}

describe('PadronService.getTaxpayerByCuit', () => {
  // Forma REAL de la respuesta -- verificada leyendo
  // base-register-repository.js::mapPersonaReturnToDto() del SDK
  // instalado, no el .d.ts (que declara un DTO más angosto). Ver docblock
  // de padron.service.ts.
  it('empresa: usa razonSocial y detecta Régimen General', async () => {
    const client = fakeArcaClient({
      getTaxpayerDetails: vi.fn().mockResolvedValue({
        idPersona: 20111111112,
        datosGenerales: {
          razonSocial: 'Hotel ZULU SRL',
          domicilioFiscal: { direccion: 'Av. San Martín 123', localidad: 'Neuquén', descripcionProvincia: 'Neuquén', codPostal: 'Q8300' },
        },
        datosRegimenGeneral: { actividad: [] },
      }),
    });

    const result = await buildService(client).getTaxpayerByCuit('20111111112');

    expect(result).toEqual({
      cuit: '20111111112',
      legalName: 'Hotel ZULU SRL',
      taxCondition: 'REGIMEN_GENERAL',
      address: { line1: 'Av. San Martín 123', city: 'Neuquén', state: 'Neuquén', postalCode: 'Q8300', country: 'AR' },
    });
  });

  it('persona física: arma legalName de nombre+apellido cuando no hay razonSocial', async () => {
    const client = fakeArcaClient({
      getTaxpayerDetails: vi.fn().mockResolvedValue({
        idPersona: 20222222223,
        datosGenerales: { nombre: 'Ana', apellido: 'García' },
        datosMonotributo: { categoriaMonotributo: {} },
      }),
    });

    const result = await buildService(client).getTaxpayerByCuit('20222222223');

    expect(result!.legalName).toBe('Ana García');
    expect(result!.taxCondition).toBe('MONOTRIBUTO');
    expect(result!.address).toBeNull();
  });

  it('CUIT sin datos en el padrón: null, no un error', async () => {
    const client = fakeArcaClient({ getTaxpayerDetails: vi.fn().mockResolvedValue(null) });

    const result = await buildService(client).getTaxpayerByCuit('20999999999');

    expect(result).toBeNull();
  });

  it('sin certificado AFIP cargado: AfipNotConfiguredError, nunca llega a pegarle al SDK', async () => {
    const client = fakeArcaClient();
    const service = buildService(client, null);

    await expect(service.getTaxpayerByCuit('20111111112')).rejects.toBeInstanceOf(AfipNotConfiguredError);
  });

  // Bug en producción, 23/08/2026 (pendientes-2026-08-23.md): una excepción
  // del SDK que NO es "no encontrado" (timeout, fault SOAP con forma que
  // isAfipNotFoundError no reconoce, etc.) se colaba cruda hasta el
  // catch-all de error.middleware.ts y salía como 500 genérico. Ahora se
  // traduce a un error de dominio propio (503).
  it('excepción real del SDK (no "no encontrado"): AfipPadronUnavailableError, no un 500 crudo', async () => {
    const client = fakeArcaClient({
      getTaxpayerDetails: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
    });

    await expect(buildService(client).getTaxpayerByCuit('20111111112'))
      .rejects.toBeInstanceOf(AfipPadronUnavailableError);
  });
});

describe('PadronService.resolveCuitByDni', () => {
  it('devuelve el primer CUIT asociado al DNI', async () => {
    const client = fakeArcaClient({ getTaxIDByDocument: vi.fn().mockResolvedValue({ idPersona: [20111111112, 27111111114] }) });

    const result = await buildService(client).resolveCuitByDni('11111111');

    expect(result).toBe('20111111112');
  });

  it('DNI sin CUIT asociado: null', async () => {
    const client = fakeArcaClient({ getTaxIDByDocument: vi.fn().mockResolvedValue({ idPersona: [] }) });

    const result = await buildService(client).resolveCuitByDni('99999999');

    expect(result).toBeNull();
  });

  it('excepción real del SDK (no "no encontrado"): AfipPadronUnavailableError, no un 500 crudo', async () => {
    const client = fakeArcaClient({
      getTaxIDByDocument: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
    });

    await expect(buildService(client).resolveCuitByDni('11111111'))
      .rejects.toBeInstanceOf(AfipPadronUnavailableError);
  });
});

describe('PadronService.getIvaReceptorTypes', () => {
  it('mapea id/desc del catálogo oficial de ARCA', async () => {
    const client = fakeArcaClient({
      getIvaReceptorTypes: vi.fn().mockResolvedValue({
        resultGet: { condicionIvaReceptor: [{ id: 1, desc: 'IVA Responsable Inscripto', cmp_Clase: 'A' }, { id: 5, desc: 'Consumidor Final', cmp_Clase: 'B' }] },
      }),
    });

    const result = await buildService(client).getIvaReceptorTypes();

    expect(result).toEqual([
      { id: 1, description: 'IVA Responsable Inscripto' },
      { id: 5, description: 'Consumidor Final' },
    ]);
  });

  it('respuesta vacía: []', async () => {
    const client = fakeArcaClient({ getIvaReceptorTypes: vi.fn().mockResolvedValue({ resultGet: undefined }) });

    const result = await buildService(client).getIvaReceptorTypes();

    expect(result).toEqual([]);
  });
});
