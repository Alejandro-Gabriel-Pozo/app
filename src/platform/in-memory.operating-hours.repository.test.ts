import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryOperatingHoursRepository } from './in-memory.operating-hours.repository.js';

describe('InMemoryOperatingHoursRepository', () => {
  let repo: InMemoryOperatingHoursRepository;

  beforeEach(() => {
    repo = new InMemoryOperatingHoursRepository();
  });

  it('createBusinessWindow + getAllBusinessWindows, ordenado por día y hora', async () => {
    await repo.createBusinessWindow({ id: 'w2', dayOfWeek: 2, startTime: '09:00', endTime: '18:00' });
    await repo.createBusinessWindow({ id: 'w1', dayOfWeek: 0, startTime: '09:00', endTime: '18:00' });

    const windows = await repo.getAllBusinessWindows();

    expect(windows.map((w) => w.id)).toEqual(['w1', 'w2']);
  });

  it('deleteBusinessWindow saca la ventana; no falla si el id no existe', async () => {
    await repo.createBusinessWindow({ id: 'w1', dayOfWeek: 0, startTime: '09:00', endTime: '18:00' });

    await repo.deleteBusinessWindow('w1');
    await repo.deleteBusinessWindow('inexistente');

    expect(await repo.getAllBusinessWindows()).toHaveLength(0);
  });

  it('createResourceWindow + getResourceWindows filtra por resourceId', async () => {
    await repo.createResourceWindow({ id: 'rw1', resourceId: 'res-1', dayOfWeek: 1, startTime: '09:00', endTime: '13:00' });
    await repo.createResourceWindow({ id: 'rw2', resourceId: 'res-2', dayOfWeek: 1, startTime: '09:00', endTime: '13:00' });

    const windows = await repo.getResourceWindows('res-1');

    expect(windows.map((w) => w.id)).toEqual(['rw1']);
  });

  describe('getEffectiveWindows -- cascada negocio -> recurso', () => {
    it('sin ventana propia del recurso, cae al horario del negocio para ese día', async () => {
      repo.seedBusiness([{ id: 'biz-mon', dayOfWeek: 0, startTime: '09:00', endTime: '18:00' }]);

      const effective = await repo.getEffectiveWindows('res-sin-horario-propio', 0);

      expect(effective.map((w) => w.id)).toEqual(['biz-mon']);
    });

    it('con ventana propia del recurso ese día, usa SOLO la del recurso -- no mezcla con la del negocio', async () => {
      repo.seedBusiness([{ id: 'biz-mon', dayOfWeek: 0, startTime: '09:00', endTime: '18:00' }]);
      repo.seedResource('res-1', [{ id: 'res-mon', dayOfWeek: 0, startTime: '10:00', endTime: '14:00' }]);

      const effective = await repo.getEffectiveWindows('res-1', 0);

      expect(effective.map((w) => w.id)).toEqual(['res-mon']);
    });

    it('la ventana propia del recurso en OTRO día no bloquea la cascada del día consultado', async () => {
      repo.seedBusiness([{ id: 'biz-tue', dayOfWeek: 1, startTime: '09:00', endTime: '18:00' }]);
      repo.seedResource('res-1', [{ id: 'res-mon', dayOfWeek: 0, startTime: '10:00', endTime: '14:00' }]);

      const effective = await repo.getEffectiveWindows('res-1', 1);

      expect(effective.map((w) => w.id)).toEqual(['biz-tue']);
    });

    it('sin ventana del negocio ni del recurso para ese día, devuelve vacío', async () => {
      const effective = await repo.getEffectiveWindows('res-1', 3);
      expect(effective).toEqual([]);
    });
  });
});
