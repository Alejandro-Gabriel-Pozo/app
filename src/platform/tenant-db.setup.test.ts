import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as NodeCrypto from 'node:crypto';

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

describe('decryptConnectionString -- modo de dos claves (SEC-ROT-001, 11/09/2026)', () => {
  const OLD_KEY_HEX = 'b'.repeat(64); // 32 bytes en hex, distinta de VALID_KEY_HEX
  const FAKE_CIPHERTEXT = `${'11'.repeat(16)}:${'22'.repeat(16)}:${'33'.repeat(10)}`; // formato válido, ilegible con cualquier clave
  const originalKey = process.env.DB_ENCRYPTION_KEY;
  const originalOldKey = process.env.DB_ENCRYPTION_KEY_OLD;

  beforeEach(() => {
    process.env.DB_ENCRYPTION_KEY = VALID_KEY_HEX;
    delete process.env.DB_ENCRYPTION_KEY_OLD;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.DB_ENCRYPTION_KEY;
    else process.env.DB_ENCRYPTION_KEY = originalKey;
    if (originalOldKey === undefined) delete process.env.DB_ENCRYPTION_KEY_OLD;
    else process.env.DB_ENCRYPTION_KEY_OLD = originalOldKey;
  });

  it('sin DB_ENCRYPTION_KEY_OLD, descifra normal con la primaria -- comportamiento sin cambios', async () => {
    const { encryptConnectionString, decryptConnectionString } = await import('./tenant-db.setup.js');
    const ciphertext = await encryptConnectionString('postgresql://algo');

    await expect(decryptConnectionString(ciphertext)).resolves.toBe('postgresql://algo');
  });

  it('con DB_ENCRYPTION_KEY_OLD configurada, descifra un ciphertext escrito con la clave VIEJA usando el fallback', async () => {
    // Simula "antes de rotar": la vieja era la primaria de ese momento.
    process.env.DB_ENCRYPTION_KEY = OLD_KEY_HEX;
    const { encryptConnectionString } = await import('./tenant-db.setup.js');
    const ciphertextConLaVieja = await encryptConnectionString('postgresql://rotado');

    // Ahora la nueva es la primaria, la vieja queda de respaldo.
    process.env.DB_ENCRYPTION_KEY = VALID_KEY_HEX;
    process.env.DB_ENCRYPTION_KEY_OLD = OLD_KEY_HEX;
    const { decryptConnectionString } = await import('./tenant-db.setup.js');

    await expect(decryptConnectionString(ciphertextConLaVieja)).resolves.toBe('postgresql://rotado');
  });

  it('sin DB_ENCRYPTION_KEY_OLD, un ciphertext ilegible falla con el error ORIGINAL de la primaria, sin envolver', async () => {
    const { decryptConnectionString } = await import('./tenant-db.setup.js');

    await expect(decryptConnectionString(FAKE_CIPHERTEXT)).rejects.not.toThrow(/se probaron 2 claves/);
  });

  it('con DB_ENCRYPTION_KEY_OLD configurada pero NINGUNA de las 2 matchea, falla con el mensaje compuesto y cause = error de la primaria', async () => {
    process.env.DB_ENCRYPTION_KEY_OLD = OLD_KEY_HEX;
    const { decryptConnectionString } = await import('./tenant-db.setup.js');

    await expect(decryptConnectionString(FAKE_CIPHERTEXT)).rejects.toThrow(/se probaron 2 claves/);
    try {
      await decryptConnectionString(FAKE_CIPHERTEXT);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).cause).toBeInstanceOf(Error);
    }
  });

  it('con DB_ENCRYPTION_KEY_OLD de longitud incorrecta (y la primaria fallando), falla ruidoso -- mismo criterio fail-loud que la primaria', async () => {
    process.env.DB_ENCRYPTION_KEY_OLD = 'muycorta';
    const { decryptConnectionString } = await import('./tenant-db.setup.js');

    await expect(decryptConnectionString(FAKE_CIPHERTEXT)).rejects.toThrow(/DB_ENCRYPTION_KEY_OLD debe ser 32 bytes/);
  });

  it('con allowOldKey:false, NO descifra un ciphertext de la vieja aunque DB_ENCRYPTION_KEY_OLD esté configurada y sea correcta (condición 2 del gate)', async () => {
    process.env.DB_ENCRYPTION_KEY = OLD_KEY_HEX;
    const { encryptConnectionString } = await import('./tenant-db.setup.js');
    const ciphertextConLaVieja = await encryptConnectionString('postgresql://rotado');

    process.env.DB_ENCRYPTION_KEY = VALID_KEY_HEX;
    process.env.DB_ENCRYPTION_KEY_OLD = OLD_KEY_HEX;
    const { decryptConnectionString } = await import('./tenant-db.setup.js');

    await expect(decryptConnectionString(ciphertextConLaVieja, { allowOldKey: false })).rejects.toThrow();
  });

  // ── Evidencia de CONTEO real, no solo del resultado (pedido explícito del gate) ──
  describe('conteo real de intentos de Decipheriv', () => {
    beforeEach(() => {
      vi.resetModules();
    });

    afterEach(() => {
      vi.doUnmock('node:crypto');
    });

    it('sin DB_ENCRYPTION_KEY_OLD, un ciphertext ilegible dispara EXACTAMENTE 1 intento de Decipheriv', async () => {
      vi.doMock('node:crypto', async (importOriginal) => {
        const actual = await importOriginal<typeof NodeCrypto>();
        return {
          ...actual,
          createDecipheriv: vi.fn((...args: Parameters<typeof actual.createDecipheriv>) => actual.createDecipheriv(...args)),
        };
      });
      const crypto = await import('node:crypto');
      const { decryptConnectionString } = await import('./tenant-db.setup.js');

      await expect(decryptConnectionString(FAKE_CIPHERTEXT)).rejects.toThrow();

      expect(vi.mocked(crypto.createDecipheriv)).toHaveBeenCalledTimes(1);
    });

    it('con DB_ENCRYPTION_KEY_OLD configurada, un ciphertext ilegible dispara EXACTAMENTE 2 intentos de Decipheriv (primaria + vieja)', async () => {
      process.env.DB_ENCRYPTION_KEY_OLD = OLD_KEY_HEX;
      vi.doMock('node:crypto', async (importOriginal) => {
        const actual = await importOriginal<typeof NodeCrypto>();
        return {
          ...actual,
          createDecipheriv: vi.fn((...args: Parameters<typeof actual.createDecipheriv>) => actual.createDecipheriv(...args)),
        };
      });
      const crypto = await import('node:crypto');
      const { decryptConnectionString } = await import('./tenant-db.setup.js');

      await expect(decryptConnectionString(FAKE_CIPHERTEXT)).rejects.toThrow();

      expect(vi.mocked(crypto.createDecipheriv)).toHaveBeenCalledTimes(2);
    });
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
    if (sql.includes('SELECT MAX')) return { rows: [{ max: 51 }] };
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
    // Cerca electrica: bumpear la version tiene que ser un acto consciente.
    // 45 -> 46 el 03/09/2026 (cuatro columnas de sello de `orders`).
    // 46 -> 47 el 08/09/2026: CHECK chk_financial_transactions_reversed_invoice_type
    // (reversed_invoice_id sólo en filas REFUND/ADJUSTMENT) -- mitad de datos
    // de la condición 3 del re-gate del ADR cancelar-con-NC. Ver schema.sql,
    // bloque "schema v47".
    // 47 -> 48 el 10/09/2026: OUTBOX-RETRY-HIST-01/OUTBOX-BACKOFF-01 --
    // domain_events gana first_failed_at/last_failed_at. Ver
    // docs/diseno-outbox-backoff-2026-09-10.md.
    // 48 -> 49 el 12/09/2026: checkOut() warn-and-override (caso 3) --
    // stays.balance_override_by/_at/balance_at_override. Ver
    // docs/investigacion-decisiones-bloqueado-2026-09-12.md.
    // 49 -> 50 el 12/09/2026: CHECK chk_financial_transactions_order_or_reservation
    // (caso 6). Ver docs/investigacion-decisiones-bloqueado-2026-09-12.md.
    // 50 -> 51 el 12/09/2026: caso 6 residuo parte 2 -- los 3 CHECK de
    // financial_transactions pasan de DROP+ADD incondicional a guard
    // pg_constraint (sin cambio de forma en la tabla, solo de patrón).
    // 51 -> 52 el 12/09/2026: Bloque 1 de docs/diseno-reconciliacion-
    // city-ledger-2026-09-12.md -- accounts_receivable gana el estado
    // REVERTIDO + reversed_by/_at/_reason + reversal_transaction_id/
    // replaces_ar_id. Solo schema, inerte hasta el Bloque 2.
    // 52 -> 53 el 13/09/2026: CITY-LEDGER-CUSTOMER-BALANCE-STATUS-ASYMMETRY-001,
    // paso 1 -- accounts_receivable gana guest_payment_transaction_id
    // (pata del huésped, simétrica a financial_transaction_id ya
    // existente). Acompaña el cambio de código del mismo commit.
    // 53 -> 54 el 14/09/2026: mecanismo general de reversa del ledger --
    // financial_transactions gana reversed_transaction_id (auto-referencial,
    // solo ADJUSTMENT) + 2 CHECK + índice; accounts_receivable pierde
    // reversal_transaction_id (v52, redundante, 0 call sites, 0 filas en
    // producción). Destraba Finding A de reverseTransfer() (Bloque 2).
    // 54 -> 55 el 14/09/2026: CANCEL-POLICY-SCOPE-BASE-001 -- cancellation_policies
    // gana policy_resolution_timing (enum, NOT NULL DEFAULT 'SNAPSHOT_AT_BOOKING')
    // + CHECK. Solo schema + CRUD, inerte hasta que exista snapshot
    // congelado en reservations (Block 2, no incluido).
    // 55 -> 56 el 15/09/2026: docs/diseno-factura-borrador-2026-08-31.md
    // §29.7, Bloque A (solo schema) -- service_items nueva + order_items
    // gana service_item_id y sus 2 CHECK polimórficos pasan a 4 ramas.
    // 56 -> 57 el 15/09/2026: docs/diseno-cancelacion-con-nota-credito-comun-
    // 2026-09-06.md §6.5 bis (reapertura, gatillo 1) -- credit_note_request
    // nueva (TRANSACCIÓN de workflow del escape fiscal N1.a). Solo schema.
    // 57 -> 58 el 15/09/2026: Bloque 5 del ADR común cancelar-con-NC -- invoices
    // gana uncertain_cleared_at/uncertain_cleared_by (BLOQUE 24, schema.sql).
    // 58 -> 59 el 15/09/2026: F2-13 (docs/decisiones-auditoria-fase2-2026-09-15.md
    // #2) -- índice único parcial uq_resources_name sobre upper(btrim(name)),
    // WHERE active = TRUE AND deleted_at IS NULL (BLOQUE 25, schema.sql).
    // 59 -> 60 el 16/09/2026: D-07(c) -- gatean los 3 DML de schema.sql con
    // condición de disparo abierta (customer_rates fixed_price->%,
    // invoices.afip_contacted, reservation_lines), mismo número de versión
    // para los 3. Ver docs/inventario-dml-schema-2026-09-16.md.
    // 60 -> 61 el 23/09/2026: Bloque 2a de docs/diseno-invoice-retry-reverse-
    // window-guard-2026-09-23.md (ISSUE-BEFORE-REVERSE-WINDOW-001) --
    // invoices gana pending_since + backfill directo, SIN el CHECK todavía
    // (eso es el Bloque 2b, deploy posterior).
    // 61 -> 62 el 23/09/2026: Bloque 2b del mismo ADR -- backfill inverso +
    // chk_invoices_pending_since (BLOQUE 27, schema.sql).
    // 62 -> 63 el 24/09/2026: Wave 15 item 2 (D-04 opción A, revocación
    // real de sesión, docs/diseno-wave15-sesion-saga-aprovisionamiento-
    // 2026-09-24.md §2) -- customers.token_version INTEGER NOT NULL
    // DEFAULT 0 (BLOQUE 28, schema.sql).
    // 63 -> 64 el 25/09/2026: Fase 1 de "reserva por tipo de unidad con
    // asignación diferida" (Wave 14 ítem 4.3,
    // docs/diseno-reserva-por-tipo-unidad-2026-09-24.md §6/§8) --
    // reservations.assignment_status VARCHAR(20) NOT NULL DEFAULT
    // 'ASSIGNED' + chk_reservations_assignment_status (BLOQUE 29, schema.sql).
    expect(version).toBe(51); // mock de SELECT MAX simula la BD en la versión previa
    expect(CURRENT_SCHEMA_VERSION).toBe(64);
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

  // D-20 sub-bloque 4 (17/09/2026, F12-12) -- applyTenantSchema() corre
  // DDL (schema.sql) en CADA deploy, contra CADA tenant -- a propósito
  // SIN statement_timeout (abortar una migración a mitad de camino en un
  // deploy es peor que esperar). idle_in_transaction_session_timeout SÍ
  // debe estar -- no tiene el mismo riesgo (ver docblock de
  // getDbIdleInTransactionTimeoutMs() en config/env.ts). Esta es
  // exactamente la propiedad que distingue este cliente del resto de los
  // pools de D-20 sub-bloque 4 -- si algún día alguien le agrega
  // statement_timeout "por consistencia" sin leer este comentario, este
  // test lo agarra.
  it('D-20: lleva idle_in_transaction_session_timeout pero NUNCA statement_timeout (DDL, no requests)', async () => {
    delete process.env.DB_STATEMENT_TIMEOUT_MS;
    delete process.env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS;
    const pg = await import('pg');
    const { applyTenantSchema } = await import('./tenant-db.setup.js');

    await applyTenantSchema('postgresql://fake');

    const ClientMock = pg.default.Client as unknown as { mock: { calls: Array<[Record<string, unknown>]> } };
    const clientConfig = ClientMock.mock.calls[0]![0];
    expect(clientConfig['idle_in_transaction_session_timeout']).toBe(30_000);
    expect(clientConfig['statement_timeout']).toBeUndefined();
  });
});
