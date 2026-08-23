import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqlAfipCredentialsRepository } from './sql.afip-credentials.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';

const ORIGINAL_KEY = process.env.DB_ENCRYPTION_KEY;
const TEST_KEY = 'a'.repeat(64); // 32 bytes en hex

beforeEach(() => {
  process.env.DB_ENCRYPTION_KEY = TEST_KEY;
});

afterEach(() => {
  if (ORIGINAL_KEY !== undefined) process.env.DB_ENCRYPTION_KEY = ORIGINAL_KEY;
  else delete process.env.DB_ENCRYPTION_KEY;
});

/**
 * Fake mínimo que simula la fila singleton `business_profile` + la tabla
 * `afip_tickets` (particionada por `service_name`, 23/08/2026) -- suficiente
 * para probar que save()/getDecrypted()/getStatus()/*Ticket() leen y
 * escriben lo correcto sin necesitar Postgres real.
 */
function fakeSqlClient(): SqlClient & { row: Record<string, unknown>; tickets: Map<string, { ticket_encrypted: string; expires_at: string }> } {
  const state = {
    row: {
      afip_cert_encrypted: null as string | null,
      afip_key_encrypted: null as string | null,
      afip_environment: null as string | null,
    },
    tickets: new Map<string, { ticket_encrypted: string; expires_at: string }>(),
  };

  return {
    get row() { return state.row; },
    get tickets() { return state.tickets; },
    async query<T>(sql: string, params: unknown[] = []) {
      if (sql.includes('UPDATE business_profile') && sql.includes('afip_cert_encrypted = $1')) {
        state.row.afip_cert_encrypted = params[0] as string;
        state.row.afip_key_encrypted = params[1] as string;
        state.row.afip_environment = params[2] as string;
        return { rows: [] as T[], rowCount: 1 };
      }
      if (sql.includes('SET afip_cert_encrypted = NULL')) {
        state.row.afip_cert_encrypted = null;
        state.row.afip_key_encrypted = null;
        state.row.afip_environment = null;
        return { rows: [] as T[], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM afip_tickets') && sql.includes('WHERE service_name')) {
        state.tickets.delete(params[0] as string);
        return { rows: [] as T[], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM afip_tickets')) {
        state.tickets.clear();
        return { rows: [] as T[], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO afip_tickets')) {
        state.tickets.set(params[0] as string, { ticket_encrypted: params[1] as string, expires_at: params[2] as string });
        return { rows: [] as T[], rowCount: 1 };
      }
      if (sql.includes('SELECT ticket_encrypted, expires_at FROM afip_tickets')) {
        const ticket = state.tickets.get(params[0] as string);
        return { rows: (ticket ? [ticket as T] : []), rowCount: ticket ? 1 : 0 };
      }
      if (sql.includes('has_cert')) {
        return {
          rows: [{
            afip_environment: state.row.afip_environment,
            has_cert: state.row.afip_cert_encrypted !== null && state.row.afip_key_encrypted !== null,
          } as T],
          rowCount: 1,
        };
      }
      // Resto de los SELECTs -- devuelven el estado actual, cualquiera sea el subconjunto de columnas pedido.
      return { rows: [state.row as T], rowCount: 1 };
    },
  };
}

describe('SqlAfipCredentialsRepository', () => {
  it('save() nunca persiste el certificado/clave en texto plano', async () => {
    const client = fakeSqlClient();
    const repo = new SqlAfipCredentialsRepository(client);

    await repo.save('-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----', 'clave-privada-secreta', 'homologacion');

    expect(client.row.afip_cert_encrypted).not.toContain('BEGIN CERTIFICATE');
    expect(client.row.afip_key_encrypted).not.toContain('clave-privada-secreta');
    expect(client.row.afip_cert_encrypted).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/); // iv:authTag:ciphertext
  });

  it('getDecrypted() devuelve exactamente lo que se guardó con save()', async () => {
    const client = fakeSqlClient();
    const repo = new SqlAfipCredentialsRepository(client);

    await repo.save('CERT-CONTENT', 'KEY-CONTENT', 'produccion');
    const result = await repo.getDecrypted();

    expect(result).toEqual({ cert: 'CERT-CONTENT', key: 'KEY-CONTENT', environment: 'produccion' });
  });

  it('getDecrypted() devuelve null si no hay certificado cargado todavía', async () => {
    const repo = new SqlAfipCredentialsRepository(fakeSqlClient());
    expect(await repo.getDecrypted()).toBeNull();
  });

  it('getStatus() nunca expone el certificado/clave, solo si está configurado', async () => {
    const client = fakeSqlClient();
    const repo = new SqlAfipCredentialsRepository(client);

    expect(await repo.getStatus()).toEqual({ configured: false, environment: null });

    await repo.save('CERT', 'KEY', 'homologacion');
    const status = await repo.getStatus();

    expect(status).toEqual({ configured: true, environment: 'homologacion' });
    expect(JSON.stringify(status)).not.toContain('CERT');
    expect(JSON.stringify(status)).not.toContain('KEY');
  });

  it('save() con un certificado nuevo invalida cualquier ticket WSAA cacheado del certificado viejo, de todos los servicios', async () => {
    const client = fakeSqlClient();
    const repo = new SqlAfipCredentialsRepository(client);

    await repo.save('CERT-1', 'KEY-1', 'homologacion');
    await repo.saveTicket('wsfe', JSON.stringify({ token: 'x' }), new Date(Date.now() + 3_600_000));
    await repo.saveTicket('ws_sr_padron_a5', JSON.stringify({ token: 'y' }), new Date(Date.now() + 3_600_000));
    expect(await repo.getTicket('wsfe')).not.toBeNull();
    expect(await repo.getTicket('ws_sr_padron_a5')).not.toBeNull();

    await repo.save('CERT-2', 'KEY-2', 'homologacion');
    expect(await repo.getTicket('wsfe')).toBeNull();
    expect(await repo.getTicket('ws_sr_padron_a5')).toBeNull();
  });

  it('clear() borra certificado, clave, ambiente y todos los tickets cacheados', async () => {
    const client = fakeSqlClient();
    const repo = new SqlAfipCredentialsRepository(client);

    await repo.save('CERT', 'KEY', 'produccion');
    await repo.saveTicket('wsfe', '{"token":"abc"}', new Date());
    await repo.clear();

    expect(await repo.getStatus()).toEqual({ configured: false, environment: null });
    expect(await repo.getDecrypted()).toBeNull();
    expect(await repo.getTicket('wsfe')).toBeNull();
  });

  describe('ticket WSAA (cache del Token de Acceso, 12hs, particionado por servicio)', () => {
    it('saveTicket()/getTicket() hacen roundtrip cifrado', async () => {
      const client = fakeSqlClient();
      const repo = new SqlAfipCredentialsRepository(client);
      const expiresAt = new Date('2026-08-20T00:00:00.000Z');

      await repo.saveTicket('wsfe', '{"token":"abc","sign":"def"}', expiresAt);
      const cached = await repo.getTicket('wsfe');

      expect(cached?.credentials).toBe('{"token":"abc","sign":"def"}');
      expect(cached?.expiresAt.toISOString()).toBe(expiresAt.toISOString());
      expect(client.tickets.get('wsfe')?.ticket_encrypted).not.toContain('token');
    });

    it('clearTicket() borra solo el ticket de ese servicio, no el certificado ni otros tickets', async () => {
      const client = fakeSqlClient();
      const repo = new SqlAfipCredentialsRepository(client);

      await repo.save('CERT', 'KEY', 'homologacion');
      await repo.saveTicket('wsfe', '{"token":"abc"}', new Date());
      await repo.saveTicket('ws_sr_padron_a5', '{"token":"def"}', new Date());
      await repo.clearTicket('wsfe');

      expect(await repo.getTicket('wsfe')).toBeNull();
      expect(await repo.getTicket('ws_sr_padron_a5')).not.toBeNull();
      expect(await repo.getStatus()).toEqual({ configured: true, environment: 'homologacion' });
    });

    // Bug real en producción, 23/08/2026 (pendientes-2026-08-23.md): un
    // ticket cacheado para `wsfe` se reusaba para las llamadas al padrón
    // porque antes había un solo ticket por negocio -- ARCA rechazaba esas
    // llamadas con un SOAP fault. Este test es la regresión concreta.
    it('un ticket cacheado para wsfe NO se devuelve para ws_sr_padron_a5 -- son servicios independientes', async () => {
      const client = fakeSqlClient();
      const repo = new SqlAfipCredentialsRepository(client);

      await repo.saveTicket('wsfe', '{"token":"solo-wsfe"}', new Date(Date.now() + 3_600_000));

      expect(await repo.getTicket('ws_sr_padron_a5')).toBeNull();
      expect((await repo.getTicket('wsfe'))?.credentials).toBe('{"token":"solo-wsfe"}');
    });
  });
});
