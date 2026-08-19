import { describe, it, expect, vi } from 'vitest';
import { SqlCustomerTaxProfileRepository } from './sql.customer-tax-profile.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';

function mockClient(responses: Record<string, unknown> = {}): SqlClient {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('SELECT id, address_id FROM customer_tax_profiles')) {
      return { rows: (responses['existing'] as unknown[]) ?? [] };
    }
    if (sql.includes('FROM customer_tax_profiles ctp')) {
      return { rows: (responses['profile'] as unknown[]) ?? [] };
    }
    return { rows: [] };
  });
  return { query } as unknown as SqlClient;
}

const PROFILE_ROW = {
  id: 'ctp-1', customer_id: 'cust-1', legal_name: 'Hotel ZULU SRL', tax_id: '20111111112',
  tax_id_type: 'CUIT', tax_condition: 'Responsable Inscripto', is_default: true, created_at: new Date(),
  address_id: 'addr-1', addr_line1: 'Av. San Martín 123', addr_line2: null, addr_city: 'Neuquén',
  addr_state: 'Neuquén', addr_postal_code: 'Q8300', addr_country: 'AR',
};

describe('SqlCustomerTaxProfileRepository', () => {
  it('getByCustomerId: null si el cliente no tiene perfil fiscal cargado', async () => {
    const client = mockClient({ profile: [] });
    const repo = new SqlCustomerTaxProfileRepository(client);

    expect(await repo.getByCustomerId('cust-1')).toBeNull();
  });

  it('getByCustomerId: mapea la fila con domicilio (JOIN a customer_addresses)', async () => {
    const client = mockClient({ profile: [PROFILE_ROW] });
    const repo = new SqlCustomerTaxProfileRepository(client);

    const profile = await repo.getByCustomerId('cust-1');

    expect(profile).toEqual({
      id: 'ctp-1', customerId: 'cust-1', legalName: 'Hotel ZULU SRL', taxId: '20111111112',
      taxIdType: 'CUIT', taxCondition: 'Responsable Inscripto', isDefault: true, createdAt: PROFILE_ROW.created_at,
      address: { line1: 'Av. San Martín 123', line2: null, city: 'Neuquén', state: 'Neuquén', postalCode: 'Q8300', country: 'AR' },
    });
  });

  it('getByCustomerId: perfil sin domicilio cargado -- address null', async () => {
    const client = mockClient({ profile: [{ ...PROFILE_ROW, address_id: null, addr_line1: null, addr_city: null, addr_state: null, addr_postal_code: null, addr_country: null }] });
    const repo = new SqlCustomerTaxProfileRepository(client);

    const profile = await repo.getByCustomerId('cust-1');

    expect(profile!.address).toBeNull();
  });

  it('upsert: cliente sin perfil previo -- INSERT nuevo (no ON CONFLICT UPDATE)', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client: SqlClient = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes('SELECT id, address_id')) return { rows: [] };
        if (sql.includes('customer_tax_profiles ctp')) return { rows: [PROFILE_ROW] };
        return { rows: [] };
      }),
    } as unknown as SqlClient;
    const repo = new SqlCustomerTaxProfileRepository(client);

    await repo.upsert('cust-1', {
      legalName: 'Hotel ZULU SRL', taxId: '20111111112', taxIdType: 'CUIT',
      taxCondition: 'Responsable Inscripto',
      address: { line1: 'Av. San Martín 123', line2: null, city: 'Neuquén', state: 'Neuquén', postalCode: 'Q8300', country: 'AR' },
    });

    const addressInsert = calls.find((c) => c.sql.includes('INSERT INTO customer_addresses'));
    const profileInsert = calls.find((c) => c.sql.includes('INSERT INTO customer_tax_profiles'));
    expect(addressInsert).toBeDefined();
    expect(profileInsert).toBeDefined();
    expect(profileInsert!.sql).toContain('ON CONFLICT (customer_id) DO UPDATE');
    // Perfil nuevo -- el address_id recién creado (no reusa uno viejo, no había).
    expect(profileInsert!.params).toContain(addressInsert!.params[0]); // el id generado para la address
  });

  it('upsert: cliente CON perfil previo -- UPDATE de la misma fila de customer_addresses, no crea otra', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client: SqlClient = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes('SELECT id, address_id')) return { rows: [{ id: 'ctp-1', address_id: 'addr-1' }] };
        if (sql.includes('customer_tax_profiles ctp')) return { rows: [PROFILE_ROW] };
        return { rows: [] };
      }),
    } as unknown as SqlClient;
    const repo = new SqlCustomerTaxProfileRepository(client);

    await repo.upsert('cust-1', {
      legalName: 'Hotel ZULU SRL', taxId: '20111111112', taxIdType: 'CUIT',
      address: { line1: 'Calle nueva 456', line2: null, city: 'Neuquén', state: 'Neuquén', postalCode: 'Q8300', country: 'AR' },
    });

    const addressWrite = calls.find((c) => c.sql.includes('customer_addresses') && !c.sql.startsWith('SELECT'));
    expect(addressWrite!.sql).toContain('UPDATE customer_addresses');
    expect(addressWrite!.params[0]).toBe('addr-1'); // reusa la dirección existente, no crea una nueva
  });
});
