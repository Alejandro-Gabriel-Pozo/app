import { describe, it, expect, vi } from 'vitest';
import type { Arca } from '@arcasdk/core';
import { ArcaSdkBillingAdapter } from './arca-sdk-billing.adapter.js';

function fakeArcaClient(overrides: {
  getLastVoucher?: ReturnType<typeof vi.fn>;
  createNextVoucher?: ReturnType<typeof vi.fn>;
  getVoucherInfo?: ReturnType<typeof vi.fn>;
  getIvaReceptorTypes?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    electronicBillingService: {
      getLastVoucher: overrides.getLastVoucher ?? vi.fn(),
      createNextVoucher: overrides.createNextVoucher ?? vi.fn(),
      getVoucherInfo: overrides.getVoucherInfo ?? vi.fn(),
      getIvaReceptorTypes: overrides.getIvaReceptorTypes ?? vi.fn(),
    },
  } as unknown as Arca;
}

describe('ArcaSdkBillingAdapter.getLastVoucher', () => {
  it('pasa cbteNro tal cual', async () => {
    const client = fakeArcaClient({ getLastVoucher: vi.fn().mockResolvedValue({ cbteNro: 42, cbteTipo: 6, ptoVta: 3 }) });
    const adapter = new ArcaSdkBillingAdapter(client);

    expect(await adapter.getLastVoucher(3, 6)).toEqual({ cbteNro: 42 });
  });
});

describe('ArcaSdkBillingAdapter.createNextVoucher', () => {
  it('aprobado: resultado A, cae/caeFchVto/cbteDesde poblados, sin observaciones', async () => {
    const createNextVoucher = vi.fn().mockResolvedValue({
      response: {
        FeCabResp: { Resultado: 'A', CbteTipo: 6 },
        FeDetResp: { FECAEDetResponse: [{ Resultado: 'A', CbteDesde: 7 }] },
      },
      cae: 'CAE-123',
      caeFchVto: '20261231',
    });
    const adapter = new ArcaSdkBillingAdapter(fakeArcaClient({ createNextVoucher }));

    const result = await adapter.createNextVoucher({ CantReg: 1 });

    expect(result.resultado).toBe('A');
    expect(result.cae).toBe('CAE-123');
    expect(result.caeFchVto).toBe('20261231');
    expect(result.cbteDesde).toBe(7);
    expect(result.observaciones).toBeNull();
    expect(result.raw).toEqual(expect.objectContaining({ FeCabResp: expect.anything() }));
  });

  it('rechazado por FeCabResp: resultado R, observaciones de Observaciones.Obs', async () => {
    const createNextVoucher = vi.fn().mockResolvedValue({
      response: {
        FeCabResp: { Resultado: 'R' },
        FeDetResp: { FECAEDetResponse: [{ Resultado: 'R', Observaciones: { Obs: [{ Code: 10015, Msg: 'Factura B no cumple condicion' }] } }] },
      },
      cae: '',
      caeFchVto: '',
    });
    const adapter = new ArcaSdkBillingAdapter(fakeArcaClient({ createNextVoucher }));

    const result = await adapter.createNextVoucher({ CantReg: 1 });

    expect(result.resultado).toBe('R');
    expect(result.observaciones).toBe('10015: Factura B no cumple condicion');
    expect(result.cae).toBeNull(); // '' -- falsy, se normaliza a null
  });

  it('rechazado solo en FeDetResp (FeCabResp no lo marca) -- sigue detectando el rechazo', async () => {
    const createNextVoucher = vi.fn().mockResolvedValue({
      response: {
        FeCabResp: { Resultado: 'A' },
        FeDetResp: { FECAEDetResponse: [{ Resultado: 'R', Observaciones: { Obs: [{ Code: 1, Msg: 'algo' }] } }] },
      },
      cae: '', caeFchVto: '',
    });
    const adapter = new ArcaSdkBillingAdapter(fakeArcaClient({ createNextVoucher }));

    const result = await adapter.createNextVoucher({ CantReg: 1 });

    expect(result.resultado).toBe('R');
  });

  it('rechazado sin Observaciones -- cae a Errors.Err', async () => {
    const createNextVoucher = vi.fn().mockResolvedValue({
      response: {
        FeCabResp: { Resultado: 'R' },
        FeDetResp: { FECAEDetResponse: [{ Resultado: 'R' }] },
        Errors: { Err: [{ Code: 500, Msg: 'Error interno de AFIP' }] },
      },
      cae: '', caeFchVto: '',
    });
    const adapter = new ArcaSdkBillingAdapter(fakeArcaClient({ createNextVoucher }));

    const result = await adapter.createNextVoucher({ CantReg: 1 });

    expect(result.observaciones).toBe('500: Error interno de AFIP');
  });

  it('rechazado sin Observaciones NI Errors -- "sin detalle", nunca undefined', async () => {
    const createNextVoucher = vi.fn().mockResolvedValue({
      response: { FeCabResp: { Resultado: 'R' }, FeDetResp: { FECAEDetResponse: [{ Resultado: 'R' }] } },
      cae: '', caeFchVto: '',
    });
    const adapter = new ArcaSdkBillingAdapter(fakeArcaClient({ createNextVoucher }));

    const result = await adapter.createNextVoucher({ CantReg: 1 });

    expect(result.observaciones).toBe('sin detalle');
  });
});

describe('ArcaSdkBillingAdapter.getVoucherInfo', () => {
  it('mapea codAutorizacion/fchVto, conserva el raw', async () => {
    const getVoucherInfo = vi.fn().mockResolvedValue({ codAutorizacion: 'CAE-999', fchVto: '20261231', resultado: 'A' });
    const adapter = new ArcaSdkBillingAdapter(fakeArcaClient({ getVoucherInfo }));

    const result = await adapter.getVoucherInfo(1, 3, 6);

    expect(result).toEqual({ codAutorizacion: 'CAE-999', fchVto: '20261231', raw: { codAutorizacion: 'CAE-999', fchVto: '20261231', resultado: 'A' } });
  });

  it('el SDK puede devolver null directo (comprobante inexistente) -- se propaga como null, no explota', async () => {
    const getVoucherInfo = vi.fn().mockResolvedValue(null);
    const adapter = new ArcaSdkBillingAdapter(fakeArcaClient({ getVoucherInfo }));

    expect(await adapter.getVoucherInfo(1, 3, 6)).toBeNull();
  });
});

describe('ArcaSdkBillingAdapter.getIvaReceptorTypes', () => {
  it('mapea id/desc del catálogo', async () => {
    const getIvaReceptorTypes = vi.fn().mockResolvedValue({
      resultGet: { condicionIvaReceptor: [{ id: 5, desc: 'Consumidor Final', cmp_Clase: 'B' }] },
    });
    const adapter = new ArcaSdkBillingAdapter(fakeArcaClient({ getIvaReceptorTypes }));

    expect(await adapter.getIvaReceptorTypes()).toEqual([{ id: 5, description: 'Consumidor Final' }]);
  });

  it('sin resultGet -- []', async () => {
    const getIvaReceptorTypes = vi.fn().mockResolvedValue({});
    const adapter = new ArcaSdkBillingAdapter(fakeArcaClient({ getIvaReceptorTypes }));

    expect(await adapter.getIvaReceptorTypes()).toEqual([]);
  });
});
