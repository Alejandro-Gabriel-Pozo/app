/**
 * @file afip-credentials.service.test.ts
 * @description F2-05 + F2-06 (15/09/2026,
 * docs/decisiones-auditoria-fase2-2026-09-15.md #1). Cubre lo que
 * `sql.afip-credentials.repository.test.ts` no puede: que `save()`/
 * `clear()` corren como una sola unidad transaccional (con rollback real
 * simulado -- ver el docblock del rollback más abajo por qué esto NO
 * reemplaza una prueba contra Postgres real) y que dejan rastro en
 * `audit_log` SIN el valor del secreto.
 */

import { describe, it, expect } from 'vitest';
import { AfipCredentialsService } from './afip-credentials.service.js';
import type {
  AfipCredentialsRepository,
  AfipCredentialsStatus,
  AfipCredentials,
  AfipEnvironment,
  AfipTicketCache,
} from './afip-credentials.repository.js';
import type { AuditLogRepository, AuditLogEntry, RecordAuditChangeInput } from '../repositories/audit-log.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';

/**
 * Estado combinado (fila `business_profile` + `audit_log`) que
 * `SnapshotTransactionManager` clona antes de correr `work()` y restaura
 * si `work()` tira -- emula BEGIN/COMMIT/ROLLBACK sin Postgres real.
 */
interface FakeState {
  configured: boolean;
  environment: AfipEnvironment | null;
  auditEntries: AuditLogEntry[];
}

function cloneState(state: FakeState): FakeState {
  return {
    configured: state.configured,
    environment: state.environment,
    auditEntries: state.auditEntries.map((e) => ({ ...e })),
  };
}

/**
 * `saveWithClient()`/`clearWithClient()` en dos pasos SEPARADOS (igual que
 * `SqlAfipCredentialsRepository.saveWith()`: UPDATE business_profile,
 * DESPUÉS DELETE afip_tickets) -- con `failAfterFirstWrite` se puede forzar
 * que el SEGUNDO paso falle, DESPUÉS de que el primero ya mutó el estado,
 * para probar que la transacción revierte los dos, no solo uno.
 */
class FakeAfipCredentialsRepository implements AfipCredentialsRepository {
  ticketsCleared = 0;

  constructor(
    private readonly state: FakeState,
    private readonly failAfterFirstWrite = false,
  ) {}

  async getStatus(): Promise<AfipCredentialsStatus> {
    return { configured: this.state.configured, environment: this.state.environment };
  }

  async getDecrypted(): Promise<AfipCredentials | null> { return null; }

  async save(): Promise<void> { throw new Error('no usado en esta suite -- ver saveWithClient()'); }
  async clear(): Promise<void> { throw new Error('no usado en esta suite -- ver clearWithClient()'); }

  async saveWithClient(_client: SqlClient, _cert: string, _key: string, environment: AfipEnvironment): Promise<void> {
    // Paso 1, equivalente al UPDATE business_profile real.
    this.state.configured = true;
    this.state.environment = environment;
    if (this.failAfterFirstWrite) throw new ForcedRollbackError();
    // Paso 2, equivalente al DELETE FROM afip_tickets real.
    this.ticketsCleared += 1;
  }

  async clearWithClient(_client: SqlClient): Promise<void> {
    this.state.configured = false;
    this.state.environment = null;
    if (this.failAfterFirstWrite) throw new ForcedRollbackError();
    this.ticketsCleared += 1;
  }

  async getTicket(): Promise<AfipTicketCache | null> { return null; }
  async saveTicket(): Promise<void> {}
  async clearTicket(): Promise<void> {}
}

class FakeAuditLogRepository implements AuditLogRepository {
  constructor(private readonly state: FakeState) {}

  async record(changes: RecordAuditChangeInput[]): Promise<void> {
    for (const c of changes) {
      this.state.auditEntries.push({
        id: `audit-${this.state.auditEntries.length}`,
        entity: c.entity,
        entityId: c.entityId,
        field: c.field,
        oldValue: c.oldValue === null || c.oldValue === undefined ? null : String(c.oldValue),
        newValue: c.newValue === null || c.newValue === undefined ? null : String(c.newValue),
        changedBy: c.changedBy,
        changedAt: new Date(),
      });
    }
  }

  async recordWithClient(_client: SqlClient, changes: RecordAuditChangeInput[]): Promise<void> {
    await this.record(changes);
  }

  async findByEntity(entity: string, entityId: string): Promise<AuditLogEntry[]> {
    return this.state.auditEntries.filter((e) => e.entity === entity && e.entityId === entityId);
  }
}

/** Marcador de error artificial -- distinguible de cualquier error real de negocio. */
class ForcedRollbackError extends Error {
  constructor() {
    super('rollback-forzado: fallo intencional del segundo statement.');
  }
}

/**
 * Camino feliz: aplica `work()` directo contra `this.db` (sin transacción
 * real) -- mismo `InMemoryTransactionManager` que `business-profile.service.test.ts`.
 */
class NoopTransactionManager implements TransactionManager {
  async run<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    const noopClient: SqlClient = { async query() { return { rows: [], rowCount: 0 }; } };
    return work(noopClient);
  }
}

/**
 * Emula BEGIN/COMMIT/ROLLBACK: clona `state` ANTES de `work()`; si `work()`
 * tira, restaura el clon (ninguna de las escrituras hechas dentro de
 * `work()` sobrevive) y relanza el error; si `work()` resuelve, deja el
 * estado como quedó (COMMIT).
 *
 * **Esto es una alternativa declarada, no un reemplazo, de una prueba
 * contra Postgres real** (mismo criterio que
 * `audit-log-transactional.integration.test.ts`, que sí fuerza un ROLLBACK
 * real de `PgTransactionManager`). Esta suite prueba que
 * `AfipCredentialsService` + `updateWithAudit()` propagan el error y que,
 * BAJO EL SUPUESTO de que `TransactionManager.run()` hace rollback real
 * (ya probado contra Postgres real para el caso general en el archivo de
 * arriba), el resultado observable es "ninguna de las dos escrituras
 * persiste". No prueba que `PgTransactionManager` en particular haga
 * ROLLBACK -- eso ya está cubierto. La verificación de integración real
 * para ESTE caso puntual (UPDATE business_profile + DELETE afip_tickets +
 * INSERT audit_log, las tres en la misma transacción, contra Postgres
 * real) queda declarada como pendiente -- no se corrió en este entorno
 * (sin TEST_DATABASE_URL). Ver
 * `src/tests/integration/afip-credentials-transactional.integration.test.ts`.
 */
class SnapshotTransactionManager implements TransactionManager {
  constructor(private readonly state: FakeState) {}

  async run<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    const snapshot = cloneState(this.state);
    const noopClient: SqlClient = { async query() { return { rows: [], rowCount: 0 }; } };
    try {
      return await work(noopClient);
    } catch (err) {
      const restored = cloneState(snapshot);
      this.state.configured = restored.configured;
      this.state.environment = restored.environment;
      this.state.auditEntries.length = 0;
      this.state.auditEntries.push(...restored.auditEntries);
      throw err;
    }
  }
}

describe('AfipCredentialsService.save() -- camino feliz', () => {
  it('guarda y deja ≥1 fila en audit_log para business_profile, sin el valor del secreto', async () => {
    const state: FakeState = { configured: false, environment: null, auditEntries: [] };
    const repo = new FakeAfipCredentialsRepository(state);
    const auditLog = new FakeAuditLogRepository(state);
    const service = new AfipCredentialsService(repo, auditLog, new NoopTransactionManager());

    const status = await service.save(
      '-----BEGIN CERTIFICATE-----\nSECRETO-CERT\n-----END CERTIFICATE-----',
      'SECRETO-CLAVE-PRIVADA',
      'homologacion',
      'ident-owner',
    );

    expect(status).toEqual({ configured: true, environment: 'homologacion' });

    const entries = await auditLog.findByEntity('business_profile', 'default');
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.every((e) => e.changedBy === 'ident-owner')).toBe(true);

    // Nunca el contenido real del certificado/clave en ningún old/new value.
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('SECRETO-CERT');
    expect(serialized).not.toContain('SECRETO-CLAVE-PRIVADA');
    expect(serialized).not.toContain('BEGIN CERTIFICATE');

    // El HECHO del cambio sí queda -- transición ausente -> presente + ambiente.
    expect(entries).toContainEqual(expect.objectContaining({ field: 'afipCredentialsConfigured', oldValue: 'false', newValue: 'true' }));
    expect(entries).toContainEqual(expect.objectContaining({ field: 'afipEnvironment', oldValue: null, newValue: 'homologacion' }));
  });

  it('clear() también audita el hecho (configured true -> false, environment -> null)', async () => {
    const state: FakeState = { configured: true, environment: 'produccion', auditEntries: [] };
    const repo = new FakeAfipCredentialsRepository(state);
    const auditLog = new FakeAuditLogRepository(state);
    const service = new AfipCredentialsService(repo, auditLog, new NoopTransactionManager());

    await service.clear('ident-owner');

    const status = await repo.getStatus();
    expect(status).toEqual({ configured: false, environment: null });

    const entries = await auditLog.findByEntity('business_profile', 'default');
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries).toContainEqual(expect.objectContaining({ field: 'afipCredentialsConfigured', oldValue: 'true', newValue: 'false' }));
    expect(entries).toContainEqual(expect.objectContaining({ field: 'afipEnvironment', oldValue: 'produccion', newValue: null }));
  });
});

describe('AfipCredentialsService -- atomicidad (F2-05, rollback simulado)', () => {
  it('save(): si el segundo statement (equivalente a DELETE afip_tickets) falla, el primero (UPDATE business_profile) NO persiste, y tampoco queda auditoría fantasma', async () => {
    const state: FakeState = { configured: false, environment: null, auditEntries: [] };
    const repo = new FakeAfipCredentialsRepository(state, /* failAfterFirstWrite */ true);
    const auditLog = new FakeAuditLogRepository(state);
    const service = new AfipCredentialsService(repo, auditLog, new SnapshotTransactionManager(state));

    await expect(
      service.save('CERT', 'KEY', 'homologacion', 'ident-owner'),
    ).rejects.toThrow(ForcedRollbackError);

    // El repo nunca llegó al segundo paso (equivalente al DELETE).
    expect(repo.ticketsCleared).toBe(0);

    // Y el estado observable quedó exactamente como antes de la llamada.
    const status = await repo.getStatus();
    expect(status).toEqual({ configured: false, environment: null });
    expect(await auditLog.findByEntity('business_profile', 'default')).toHaveLength(0);
  });

  it('clear(): mismo rollback -- si el segundo statement falla, configured/environment vuelven al valor previo', async () => {
    const state: FakeState = { configured: true, environment: 'produccion', auditEntries: [] };
    const repo = new FakeAfipCredentialsRepository(state, /* failAfterFirstWrite */ true);
    const auditLog = new FakeAuditLogRepository(state);
    const service = new AfipCredentialsService(repo, auditLog, new SnapshotTransactionManager(state));

    await expect(service.clear('ident-owner')).rejects.toThrow(ForcedRollbackError);

    expect(repo.ticketsCleared).toBe(0);
    const status = await repo.getStatus();
    expect(status).toEqual({ configured: true, environment: 'produccion' }); // no se tocó
    expect(await auditLog.findByEntity('business_profile', 'default')).toHaveLength(0);
  });
});
