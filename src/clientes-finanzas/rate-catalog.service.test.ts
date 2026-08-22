/**
 * @file rate-catalog.service.test.ts
 * @description D5, seguimiento del 22/08/2026 — `rate_catalog_id` en
 * `customer_rates` es una referencia VIVA (ver rate-catalog.repository.ts),
 * así que editar el % de una entrada de catálogo mueve el precio de
 * clientes que nadie tocó ese día. Estos tests verifican que `update()`/
 * `deactivate()` quedan auditados (entity='rate_catalog') y que `create()`
 * NO se audita (mismo criterio que CategoryService.createCategory()).
 */

import { describe, it, expect } from 'vitest';
import { RateCatalogService } from './rate-catalog.service.js';
import { RateCatalogEntryNotFoundError } from '../domain/errors.js';
import { InMemoryRateCatalogRepository } from './in-memory.rate-catalog.repository.js';
import { InMemoryAuditLogRepository } from '../repositories/in-memory.audit-log.repository.js';
import type { RateCatalogEntry } from './rate-catalog.repository.js';

function seedEntry(repo: InMemoryRateCatalogRepository, overrides: Partial<RateCatalogEntry> = {}): RateCatalogEntry {
  const now = new Date();
  const entry: RateCatalogEntry = {
    id: 'cat-1', businessId: 'biz-1', name: 'Corporativo', discountPercentage: 10,
    resourceId: 'r1', serviceId: null, active: true, createdAt: now, updatedAt: now,
    ...overrides,
  };
  repo.seed([entry]);
  return entry;
}

describe('RateCatalogService', () => {
  it('create() no escribe auditoría (es el valor inicial, no hay "antes" contra qué diffear)', async () => {
    const repo = new InMemoryRateCatalogRepository();
    const auditLog = new InMemoryAuditLogRepository();
    const service = new RateCatalogService(repo, auditLog);

    await service.create({ id: 'cat-1', businessId: 'biz-1', name: 'Corporativo', discountPercentage: 10, resourceId: 'r1' });

    expect(auditLog.all()).toHaveLength(0);
  });

  it('update() cambia el % y queda auditado como entity=rate_catalog', async () => {
    const repo = new InMemoryRateCatalogRepository();
    seedEntry(repo);
    const auditLog = new InMemoryAuditLogRepository();
    const service = new RateCatalogService(repo, auditLog);

    const updated = await service.update('cat-1', 'biz-1', { discountPercentage: 15 }, 'ident-admin');

    expect(updated.discountPercentage).toBe(15);
    const entries = auditLog.all();
    expect(entries).toHaveLength(1);
    // InMemoryAuditLogRepository serializa igual que la fila real (TEXT) -- numbers quedan como string.
    expect(entries[0]).toMatchObject({
      entity: 'rate_catalog', entityId: 'cat-1', field: 'discountPercentage',
      oldValue: '10', newValue: '15', changedBy: 'ident-admin',
    });
  });

  it('update() de una entrada inexistente tira RateCatalogEntryNotFoundError, sin auditoría', async () => {
    const repo = new InMemoryRateCatalogRepository();
    const auditLog = new InMemoryAuditLogRepository();
    const service = new RateCatalogService(repo, auditLog);

    await expect(service.update('cat-x', 'biz-1', { discountPercentage: 15 }, 'ident-admin'))
      .rejects.toThrow(RateCatalogEntryNotFoundError);
    expect(auditLog.all()).toHaveLength(0);
  });

  it('deactivate() queda auditado (field=active, true->false)', async () => {
    const repo = new InMemoryRateCatalogRepository();
    seedEntry(repo);
    const auditLog = new InMemoryAuditLogRepository();
    const service = new RateCatalogService(repo, auditLog);

    const ok = await service.deactivate('cat-1', 'biz-1', 'ident-admin');

    expect(ok).toBe(true);
    const entries = auditLog.all();
    expect(entries).toHaveLength(1);
    // InMemoryAuditLogRepository serializa igual que la fila real (TEXT) -- booleans quedan como string.
    expect(entries[0]).toMatchObject({ entity: 'rate_catalog', field: 'active', oldValue: 'true', newValue: 'false' });
  });

  it('deactivate() de algo ya inactivo no reescribe auditoría (idempotente)', async () => {
    const repo = new InMemoryRateCatalogRepository();
    seedEntry(repo, { active: false });
    const auditLog = new InMemoryAuditLogRepository();
    const service = new RateCatalogService(repo, auditLog);

    const ok = await service.deactivate('cat-1', 'biz-1', 'ident-admin');

    expect(ok).toBe(false);
    expect(auditLog.all()).toHaveLength(0);
  });
});
