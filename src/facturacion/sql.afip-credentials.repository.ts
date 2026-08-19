import type { SqlClient } from '../repositories/sql.client.js';
import { encryptConnectionString, decryptConnectionString } from '../platform/tenant-db.setup.js';
import type {
  AfipCredentialsRepository,
  AfipCredentialsStatus,
  AfipCredentials,
  AfipEnvironment,
  AfipTicketCache,
} from './afip-credentials.repository.js';

/**
 * `encryptConnectionString`/`decryptConnectionString` (tenant-db.setup.ts)
 * son genéricas (string -> string, AES-256-GCM) pese al nombre — ya
 * pensadas para reusarse fuera de connection strings (ver su propio
 * docblock). Un solo mecanismo de cifrado en el proyecto, no uno nuevo
 * por secreto.
 */
export class SqlAfipCredentialsRepository implements AfipCredentialsRepository {
  constructor(private readonly db: SqlClient) {}

  async getStatus(): Promise<AfipCredentialsStatus> {
    const { rows } = await this.db.query<{ afip_environment: AfipEnvironment | null; has_cert: boolean }>(
      `SELECT afip_environment, (afip_cert_encrypted IS NOT NULL AND afip_key_encrypted IS NOT NULL) AS has_cert
       FROM business_profile WHERE id = 'default' LIMIT 1`,
    );
    const row = rows[0];
    if (!row) throw new Error("business_profile sin la fila 'default' -- ¿se corrió schema.sql?");
    return { configured: row.has_cert, environment: row.afip_environment };
  }

  async getDecrypted(): Promise<AfipCredentials | null> {
    const { rows } = await this.db.query<{
      afip_cert_encrypted: string | null;
      afip_key_encrypted: string | null;
      afip_environment: AfipEnvironment | null;
    }>(
      `SELECT afip_cert_encrypted, afip_key_encrypted, afip_environment
       FROM business_profile WHERE id = 'default' LIMIT 1`,
    );
    const row = rows[0];
    if (!row?.afip_cert_encrypted || !row.afip_key_encrypted || !row.afip_environment) return null;
    const [cert, key] = await Promise.all([
      decryptConnectionString(row.afip_cert_encrypted),
      decryptConnectionString(row.afip_key_encrypted),
    ]);
    return { cert, key, environment: row.afip_environment };
  }

  async save(cert: string, key: string, environment: AfipEnvironment): Promise<void> {
    const [certEncrypted, keyEncrypted] = await Promise.all([
      encryptConnectionString(cert),
      encryptConnectionString(key),
    ]);
    // Cambiar de certificado invalida cualquier ticket cacheado del
    // certificado viejo -- WSAA lo hubiera rechazado igual en el próximo
    // uso, pero limpiarlo acá evita el intento de más y el error confuso.
    await this.db.query(
      `UPDATE business_profile
       SET afip_cert_encrypted = $1, afip_key_encrypted = $2, afip_environment = $3,
           afip_ticket_encrypted = NULL, afip_ticket_expires_at = NULL, updated_at = NOW()
       WHERE id = 'default'`,
      [certEncrypted, keyEncrypted, environment],
    );
  }

  async clear(): Promise<void> {
    await this.db.query(
      `UPDATE business_profile
       SET afip_cert_encrypted = NULL, afip_key_encrypted = NULL, afip_environment = NULL,
           afip_ticket_encrypted = NULL, afip_ticket_expires_at = NULL, updated_at = NOW()
       WHERE id = 'default'`,
    );
  }

  async getTicket(): Promise<AfipTicketCache | null> {
    const { rows } = await this.db.query<{ afip_ticket_encrypted: string | null; afip_ticket_expires_at: string | null }>(
      `SELECT afip_ticket_encrypted, afip_ticket_expires_at FROM business_profile WHERE id = 'default' LIMIT 1`,
    );
    const row = rows[0];
    if (!row?.afip_ticket_encrypted || !row.afip_ticket_expires_at) return null;
    return {
      credentials: await decryptConnectionString(row.afip_ticket_encrypted),
      expiresAt: new Date(row.afip_ticket_expires_at),
    };
  }

  async saveTicket(credentialsJson: string, expiresAt: Date): Promise<void> {
    const encrypted = await encryptConnectionString(credentialsJson);
    await this.db.query(
      `UPDATE business_profile
       SET afip_ticket_encrypted = $1, afip_ticket_expires_at = $2
       WHERE id = 'default'`,
      [encrypted, expiresAt.toISOString()],
    );
  }

  async clearTicket(): Promise<void> {
    await this.db.query(
      `UPDATE business_profile SET afip_ticket_encrypted = NULL, afip_ticket_expires_at = NULL WHERE id = 'default'`,
    );
  }
}
