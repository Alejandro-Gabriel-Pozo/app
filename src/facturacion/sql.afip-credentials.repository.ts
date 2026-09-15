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
    return this.saveWith(this.db, cert, key, environment);
  }

  async saveWithClient(client: SqlClient, cert: string, key: string, environment: AfipEnvironment): Promise<void> {
    return this.saveWith(client, cert, key, environment);
  }

  private async saveWith(client: SqlClient, cert: string, key: string, environment: AfipEnvironment): Promise<void> {
    const [certEncrypted, keyEncrypted] = await Promise.all([
      encryptConnectionString(cert),
      encryptConnectionString(key),
    ]);
    // Cambiar de certificado invalida CUALQUIER ticket cacheado del
    // certificado viejo, de TODOS los servicios (wsfe, padrón, etc.) --
    // WSAA lo hubiera rechazado igual en el próximo uso, pero limpiarlo
    // acá evita el intento de más y el error confuso.
    //
    // F2-05 (15/09/2026): las dos escrituras corren contra `client` (el de
    // la transacción de `AfipCredentialsService`, o `this.db` si se llama
    // sin transacción explícita) -- antes eran dos `await` sueltos contra
    // `this.db` sin garantía de atomicidad: un fallo entre el UPDATE y el
    // DELETE dejaba el certificado nuevo guardado con tickets viejos
    // todavía cacheados (o viceversa).
    await client.query(
      `UPDATE business_profile
       SET afip_cert_encrypted = $1, afip_key_encrypted = $2, afip_environment = $3, updated_at = NOW()
       WHERE id = 'default'`,
      [certEncrypted, keyEncrypted, environment],
    );
    await client.query(`DELETE FROM afip_tickets`);
  }

  async clear(): Promise<void> {
    return this.clearWith(this.db);
  }

  async clearWithClient(client: SqlClient): Promise<void> {
    return this.clearWith(client);
  }

  private async clearWith(client: SqlClient): Promise<void> {
    await client.query(
      `UPDATE business_profile
       SET afip_cert_encrypted = NULL, afip_key_encrypted = NULL, afip_environment = NULL, updated_at = NOW()
       WHERE id = 'default'`,
    );
    await client.query(`DELETE FROM afip_tickets`);
  }

  async getTicket(serviceName: string): Promise<AfipTicketCache | null> {
    const { rows } = await this.db.query<{ ticket_encrypted: string; expires_at: string }>(
      `SELECT ticket_encrypted, expires_at FROM afip_tickets WHERE service_name = $1 LIMIT 1`,
      [serviceName],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      credentials: await decryptConnectionString(row.ticket_encrypted),
      expiresAt: new Date(row.expires_at),
    };
  }

  async saveTicket(serviceName: string, credentialsJson: string, expiresAt: Date): Promise<void> {
    const encrypted = await encryptConnectionString(credentialsJson);
    await this.db.query(
      `INSERT INTO afip_tickets (service_name, ticket_encrypted, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (service_name) DO UPDATE
       SET ticket_encrypted = EXCLUDED.ticket_encrypted, expires_at = EXCLUDED.expires_at`,
      [serviceName, encrypted, expiresAt.toISOString()],
    );
  }

  async clearTicket(serviceName: string): Promise<void> {
    await this.db.query(`DELETE FROM afip_tickets WHERE service_name = $1`, [serviceName]);
  }
}
