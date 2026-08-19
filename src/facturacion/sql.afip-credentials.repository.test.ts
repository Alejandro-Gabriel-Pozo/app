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
 * Fake mínimo que simula la fila singleton `business_profile` -- suficiente
 * para probar que save()/getDecrypted()/getStatus() leen y escriben las
 * columnas correctas sin necesitar Postgres real.
 */
function fakeSqlClient(): SqlClient & { row: Record<string, unknown> } {
  const state = {
    row: {
      afip_cert_encrypted: null as string | null,
      afip_key_encrypted: null as string | null,
      afip_environment: null as string | null,
      afip_ticket_encrypted: null as string | null,
      afip_ticket_expires_at: null as string | null,
    },
  };

  return {
    get row() { return state.row; },
    async query<T>(sql: string, params: unknown[] = []) {
      if (sql.includes('UPDATE business_profile') && sql.includes('afip_cert_encrypted = $1')) {
        state.row.afip_cert_encrypted = params[0] as string;
        state.row.afip_key_encrypted = params[1] as string;
        state.row.afip_environment = params[2] as string;
        state.row.afip_ticket_encrypted = null;
        state.row.afip_ticket_expires_at = null;
        return { rows: [] as T[], rowCount: 1 };
      }
      if (sql.includes('SET afip_cert_encrypted = NULL')) {
        state.row.afip_cert_encrypted = null;
        state.row.afip_key_encrypted = null;
        state.row.afip_environment = null;
        state.row.afip_ticket_encrypted = null;
        state.row.afip_ticket_expires_at = null;
        return { rows: [] as T[], rowCount: 1 };
      }
      if (sql.includes('SET afip_ticket_encrypted = $1')) {
        state.row.afip_ticket_encrypted = params[0] as string;
        state.row.afip_ticket_expires_at = params[1] as string;
        return { rows: [] as T[], rowCount: 1 };
      }
      if (sql.includes('SET afip_ticket_encrypted = NULL')) {
        state.row.afip_ticket_encrypted = null;
        state.row.afip_ticket_expires_at = null;
        return { rows: [] as T[], rowCount: 1 };
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

  it('save() con un certificado nuevo invalida cualquier ticket WSAA cacheado del certificado viejo', async () => {
    const client = fakeSqlClient();
    const repo = new SqlAfipCredentialsRepository(client);

    await repo.save('CERT-1', 'KEY-1', 'homologacion');
    await repo.saveTicket(JSON.stringify({ token: 'x' }), new Date(Date.now() + 3_600_000));
    expect(await repo.getTicket()).not.toBeNull();

    await repo.save('CERT-2', 'KEY-2', 'homologacion');
    expect(await repo.getTicket()).toBeNull();
  });

  it('clear() borra certificado, clave, ambiente y ticket cacheado', async () => {
    const client = fakeSqlClient();
    const repo = new SqlAfipCredentialsRepository(client);

    await repo.save('CERT', 'KEY', 'produccion');
    await repo.clear();

    expect(await repo.getStatus()).toEqual({ configured: false, environment: null });
    expect(await repo.getDecrypted()).toBeNull();
  });

  describe('ticket WSAA (cache del Token de Acceso, 12hs)', () => {
    it('saveTicket()/getTicket() hacen roundtrip cifrado', async () => {
      const client = fakeSqlClient();
      const repo = new SqlAfipCredentialsRepository(client);
      const expiresAt = new Date('2026-08-20T00:00:00.000Z');

      await repo.saveTicket('{"token":"abc","sign":"def"}', expiresAt);
      const cached = await repo.getTicket();

      expect(cached?.credentials).toBe('{"token":"abc","sign":"def"}');
      expect(cached?.expiresAt.toISOString()).toBe(expiresAt.toISOString());
      expect(client.row.afip_ticket_encrypted).not.toContain('token');
    });

    it('clearTicket() borra solo el ticket, no el certificado', async () => {
      const client = fakeSqlClient();
      const repo = new SqlAfipCredentialsRepository(client);

      await repo.save('CERT', 'KEY', 'homologacion');
      await repo.saveTicket('{"token":"abc"}', new Date());
      await repo.clearTicket();

      expect(await repo.getTicket()).toBeNull();
      expect(await repo.getStatus()).toEqual({ configured: true, environment: 'homologacion' });
    });
  });
});
