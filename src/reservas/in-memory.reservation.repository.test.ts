import { describe, it, expect, beforeEach } from 'vitest';
import { ReservationStatus } from '../types/enums.js';
import { BookableResource } from './resource.entities.js';
import { Reservation } from './Reservation.js';
import { InMemoryReservationRepository } from './in-memory.reservation.repository.js';
import type { ICategoryRepository } from './category.repository.js';
import type { ResourceCategory } from './resource-category.types.js';

// K2 (23/08/2026) — getFiltered({isLodging}) necesita resolver la
// categoría del recurso de cada reserva; en memoria no hay tabla real,
// así que el repo recibe un ICategoryRepository inyectado (mismo criterio
// que ReservationPricingService, no un mapa/tabla nuevo acá).
function fakeCategoryRepository(categories: Record<string, boolean>): ICategoryRepository {
  return {
    findAll: async () => [],
    findById: async (id: string): Promise<ResourceCategory | null> =>
      id in categories
        ? { id, name: id, fields: [], isLodging: categories[id]!, isExclusive: false, active: true, createdAt: new Date(), updatedAt: new Date() }
        : null,
    countActive: async () => 0,
    create: async () => { throw new Error('no usado en este test'); },
    update: async () => { throw new Error('no usado en este test'); },
    deactivate: async () => {},
  };
}

describe('InMemoryReservationRepository — getFiltered/countFiltered (K2, isLodging + search)', () => {
  const room  = new BookableResource('room-1',  'Habitación 1', 100, 'cat-lodging', null);
  const chair = new BookableResource('chair-1', 'Silla 1',       20, 'cat-turnos',  null);

  let repo: InMemoryReservationRepository;

  function makeReservation(id: string, resource: BookableResource, customer: { id: string; fullName: string; email?: string }) {
    return Reservation.restore({
      id, customer, resource,
      startTime: new Date('2026-08-01T10:00:00'),
      endTime:   new Date('2026-08-01T11:00:00'),
      details: {}, totalPrice: 100,
      initialStatus: ReservationStatus.CONFIRMED,
      reservationNumber: 1,
      appliedCustomerRateId: null,
    });
  }

  beforeEach(async () => {
    const categoryRepository = fakeCategoryRepository({ 'cat-lodging': true, 'cat-turnos': false });
    repo = new InMemoryReservationRepository(categoryRepository);
    await repo.save(makeReservation('res-room',  room,  { id: 'c1', fullName: 'Ana García', email: 'ana@example.com' }));
    await repo.save(makeReservation('res-chair', chair, { id: 'c2', fullName: 'Beto López',  email: 'beto@example.com' }));
  });

  it('isLodging: true devuelve solo reservas de recursos de categoría alojamiento', async () => {
    const results = await repo.getFiltered({ isLodging: true });
    expect(results.map((r) => r.id)).toEqual(['res-room']);
  });

  it('isLodging: false devuelve solo Turnos', async () => {
    const results = await repo.getFiltered({ isLodging: false });
    expect(results.map((r) => r.id)).toEqual(['res-chair']);
  });

  it('sin isLodging devuelve todo, sin filtrar', async () => {
    const results = await repo.getFiltered({});
    expect(results).toHaveLength(2);
  });

  it('isLodging sin categoryRepository inyectado falla fuerte, no devuelve todo en silencio', async () => {
    const repoSinCategorias = new InMemoryReservationRepository();
    await repoSinCategorias.save(makeReservation('res-x', room, { id: 'c1', fullName: 'Ana García' }));
    await expect(repoSinCategorias.getFiltered({ isLodging: true })).rejects.toThrow(/categoryRepository/);
  });

  it('search busca por nombre O email, case-insensitive', async () => {
    expect((await repo.getFiltered({ search: 'ana' })).map((r) => r.id)).toEqual(['res-room']);
    expect((await repo.getFiltered({ search: 'BETO@EXAMPLE.COM' })).map((r) => r.id)).toEqual(['res-chair']);
    expect(await repo.getFiltered({ search: 'nadie' })).toEqual([]);
  });

  it('countFiltered cuenta sobre el mismo filtro, sin paginar', async () => {
    expect(await repo.countFiltered({ isLodging: true })).toBe(1);
    expect(await repo.countFiltered({})).toBe(2);
  });
});

// D-14 parcial (15/09/2026, docs/decisiones-auditoria-fase2-2026-09-15.md) —
// getFiltered({}) sin page/limit ya no devuelve "todo" (results.length):
// cae al mismo tope PROVISORIO que SqlReservationRepository
// (DEFAULT_UNPAGINATED_LIMIT), para no reabrir la divergencia que D-02
// acaba de cerrar.
describe('InMemoryReservationRepository — getFiltered() sin page/limit tiene tope duro (D-14 parcial)', () => {
  it('siembra más filas que el tope y confirma que getFiltered({}) devuelve como máximo el tope', async () => {
    const repo = new InMemoryReservationRepository();
    const resource = new BookableResource('room-1', 'Habitación 1', 100, 'cat-lodging', null);
    const limit = InMemoryReservationRepository.DEFAULT_UNPAGINATED_LIMIT;
    const seeded = limit + 1;

    for (let i = 0; i < seeded; i++) {
      await repo.save(Reservation.restore({
        id: `res-${i}`,
        customer: { id: 'c1', fullName: 'Ana García' },
        resource,
        startTime: new Date(`2026-08-01T10:00:00`),
        endTime:   new Date(`2026-08-01T11:00:00`),
        details: {}, totalPrice: 100,
        initialStatus: ReservationStatus.CONFIRMED,
        reservationNumber: i + 1,
        appliedCustomerRateId: null,
      }));
    }

    expect(await repo.countFiltered({})).toBe(seeded); // sembrado real, sin tope
    const results = await repo.getFiltered({});
    expect(results.length).toBe(limit);
    expect(results.length).toBeLessThan(seeded);
  });
});
