import { describe, it, expect, vi } from 'vitest';
import { diffFields, recordFieldChanges } from './audit.js';
import type { AuditLogRepository } from '../repositories/audit-log.repository.js';

describe('diffFields', () => {
  it('detecta un campo primitivo cambiado', () => {
    const changes = diffFields({ name: 'Salon', active: true }, { name: 'Salon VIP' });
    expect(changes).toEqual([{ field: 'name', oldValue: 'Salon', newValue: 'Salon VIP' }]);
  });

  it('ignora campos del patch que no cambiaron de valor', () => {
    const changes = diffFields({ name: 'Salon', basePrice: 100 }, { name: 'Salon', basePrice: 100 });
    expect(changes).toEqual([]);
  });

  it('ignora claves del patch con valor undefined (no tocadas)', () => {
    const changes = diffFields({ name: 'Salon', description: 'x' }, { name: undefined, description: 'y' });
    expect(changes).toEqual([{ field: 'description', oldValue: 'x', newValue: 'y' }]);
  });

  it('detecta varios campos cambiados a la vez', () => {
    const changes = diffFields(
      { name: 'Salon', basePrice: 100, active: true },
      { name: 'Salon VIP', basePrice: 150 },
    );
    expect(changes).toEqual([
      { field: 'name', oldValue: 'Salon', newValue: 'Salon VIP' },
      { field: 'basePrice', oldValue: 100, newValue: 150 },
    ]);
  });

  it('compara objetos/arrays por valor, no por referencia', () => {
    const current = { fields: [{ name: 'talle', type: 'select' }] };
    const sameByValue = diffFields(current, { fields: [{ name: 'talle', type: 'select' }] });
    expect(sameByValue).toEqual([]);

    const changedByValue = diffFields(current, { fields: [{ name: 'talle', type: 'text' }] });
    expect(changedByValue).toEqual([
      {
        field: 'fields',
        oldValue: [{ name: 'talle', type: 'select' }],
        newValue: [{ name: 'talle', type: 'text' }],
      },
    ]);
  });

  it('trata null y undefined como valores distintos entre sí y de un string vacío', () => {
    const changes = diffFields({ description: null }, { description: '' });
    expect(changes).toEqual([{ field: 'description', oldValue: null, newValue: '' }]);
  });
});

describe('recordFieldChanges', () => {
  function fakeAuditLogRepo(): AuditLogRepository & { record: ReturnType<typeof vi.fn> } {
    return {
      record: vi.fn().mockResolvedValue(undefined),
      findByEntity: vi.fn().mockResolvedValue([]),
    };
  }

  it('no llama a record() si no hay cambios (Fase 3, auditoria-modularidad.md DRY-2)', async () => {
    const repo = fakeAuditLogRepo();
    await recordFieldChanges(repo, 'categories', 'cat-1', [], 'user-1');
    expect(repo.record).not.toHaveBeenCalled();
  });

  it('mapea cada FieldChange a un RecordAuditChangeInput con entity/entityId/changedBy compartidos', async () => {
    const repo = fakeAuditLogRepo();
    await recordFieldChanges(
      repo,
      'categories',
      'cat-1',
      [
        { field: 'name', oldValue: 'Salon', newValue: 'Salon VIP' },
        { field: 'active', oldValue: true, newValue: false },
      ],
      'user-1',
    );
    expect(repo.record).toHaveBeenCalledTimes(1);
    expect(repo.record).toHaveBeenCalledWith([
      { entity: 'categories', entityId: 'cat-1', field: 'name', oldValue: 'Salon', newValue: 'Salon VIP', changedBy: 'user-1' },
      { entity: 'categories', entityId: 'cat-1', field: 'active', oldValue: true, newValue: false, changedBy: 'user-1' },
    ]);
  });
});
