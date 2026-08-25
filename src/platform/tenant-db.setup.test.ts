import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const VALID_KEY_HEX = 'a'.repeat(64); // 32 bytes en hex

describe('encryptConnectionString / decryptConnectionString', () => {
  const originalKey = process.env.DB_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.DB_ENCRYPTION_KEY = VALID_KEY_HEX;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.DB_ENCRYPTION_KEY;
    else process.env.DB_ENCRYPTION_KEY = originalKey;
  });

  it('roundtrip: lo que se cifra se puede volver a descifrar exacto', async () => {
    const { encryptConnectionString, decryptConnectionString } = await import('./tenant-db.setup.js');
    const plaintext = 'postgresql://user:pass@host:5432/tenant-db-1';

    const ciphertext = await encryptConnectionString(plaintext);
    const decrypted = await decryptConnectionString(ciphertext);

    expect(decrypted).toBe(plaintext);
  });

  it('el ciphertext tiene el formato iv:authTag:data (tres partes hex separadas por :)', async () => {
    const { encryptConnectionString } = await import('./tenant-db.setup.js');

    const ciphertext = await encryptConnectionString('postgresql://algo');

    expect(ciphertext.split(':')).toHaveLength(3);
  });

  it('dos cifrados del mismo texto dan resultados distintos (IV aleatorio por llamada)', async () => {
    const { encryptConnectionString } = await import('./tenant-db.setup.js');

    const a = await encryptConnectionString('postgresql://mismo-texto');
    const b = await encryptConnectionString('postgresql://mismo-texto');

    expect(a).not.toBe(b);
  });

  it('decryptConnectionString rechaza un ciphertext con formato inválido (no 3 partes)', async () => {
    const { decryptConnectionString } = await import('./tenant-db.setup.js');

    await expect(decryptConnectionString('formato-invalido-sin-separadores')).rejects.toThrow(/formato de ciphertext inválido/i);
  });

  it('decryptConnectionString rechaza un authTag corrupto (integridad AES-GCM)', async () => {
    const { encryptConnectionString, decryptConnectionString } = await import('./tenant-db.setup.js');
    const ciphertext = await encryptConnectionString('postgresql://algo');
    const [iv, authTag, data] = ciphertext.split(':');
    const corrupted = `${iv}:${(authTag as string).split('').reverse().join('')}:${data}`;

    await expect(decryptConnectionString(corrupted)).rejects.toThrow();
  });

  it('sin DB_ENCRYPTION_KEY definida, falla explícito en vez de cifrar con una key por defecto', async () => {
    delete process.env.DB_ENCRYPTION_KEY;
    const { encryptConnectionString } = await import('./tenant-db.setup.js');

    await expect(encryptConnectionString('postgresql://algo')).rejects.toThrow(/DB_ENCRYPTION_KEY no está definida/);
  });

  it('con DB_ENCRYPTION_KEY de longitud incorrecta, falla explícito', async () => {
    process.env.DB_ENCRYPTION_KEY = 'muycorta';
    const { encryptConnectionString } = await import('./tenant-db.setup.js');

    await expect(encryptConnectionString('postgresql://algo')).rejects.toThrow(/debe ser 32 bytes en hex/);
  });
});

describe('loadTenantSchema', () => {
  it('lee src/db/schema.sql desde disco y devuelve contenido no vacío', async () => {
    const { loadTenantSchema } = await import('./tenant-db.setup.js');

    const schema = await loadTenantSchema();

    expect(schema.length).toBeGreaterThan(0);
    expect(schema).toContain('CREATE TABLE');
  });

  it('cachea en memoria -- llamadas repetidas devuelven el mismo contenido sin releer', async () => {
    const { loadTenantSchema } = await import('./tenant-db.setup.js');

    const first = await loadTenantSchema();
    const second = await loadTenantSchema();

    expect(first).toBe(second); // misma referencia de string -- cache, no una nueva lectura
  });
});

describe('applyTenantSchema', () => {
  const queryMock = vi.fn(async (sql: string): Promise<{ rows: Array<Record<string, unknown>> }> => {
    if (sql.includes('SELECT MAX')) return { rows: [{ max: 41 }] };
    return { rows: [] };
  });
  const connectMock = vi.fn(async () => {});
  const endMock = vi.fn(async () => {});

  beforeEach(() => {
    vi.resetModules();
    queryMock.mockClear();
    connectMock.mockClear();
    endMock.mockClear();
    vi.doMock('pg', () => ({
      default: {
        Client: vi.fn().mockImplementation(() => ({
          connect: connectMock,
          query: queryMock,
          end: endMock,
        })),
      },
    }));
  });

  afterEach(() => {
    vi.doUnmock('pg');
  });

  it('corre schema.sql, registra CURRENT_SCHEMA_VERSION y devuelve la versión máxima real', async () => {
    const { applyTenantSchema, CURRENT_SCHEMA_VERSION } = await import('./tenant-db.setup.js');

    const version = await applyTenantSchema('postgresql://fake');

    expect(connectMock).toHaveBeenCalledOnce();
    const calls = queryMock.mock.calls.map((c) => c[0] as string);
    expect(calls.some((sql) => sql.includes('CREATE TABLE'))).toBe(true); // el propio schema.sql
    expect(calls.some((sql) => sql.includes('INSERT INTO schema_migrations'))).toBe(true);
    expect(calls.some((sql) => sql.includes('ON CONFLICT (version) DO NOTHING'))).toBe(true);
    expect(version).toBe(41);
    expect(CURRENT_SCHEMA_VERSION).toBe(41);
  });

  it('cierra la conexión aunque la query falle a mitad de camino (finally)', async () => {
    queryMock.mockImplementationOnce(async () => { throw new Error('boom'); });
    const { applyTenantSchema } = await import('./tenant-db.setup.js');

    await expect(applyTenantSchema('postgresql://fake')).rejects.toThrow('boom');

    expect(endMock).toHaveBeenCalledOnce();
  });

  it('si SELECT MAX() devuelve null (BD nunca migrada por otro proceso), cae a CURRENT_SCHEMA_VERSION', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT MAX')) return { rows: [{ max: null }] };
      return { rows: [] };
    });
    const { applyTenantSchema, CURRENT_SCHEMA_VERSION } = await import('./tenant-db.setup.js');

    const version = await applyTenantSchema('postgresql://fake');

    expect(version).toBe(CURRENT_SCHEMA_VERSION);
  });
});
