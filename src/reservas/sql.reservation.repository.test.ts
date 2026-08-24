import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReservationStatus } from '../types/enums.js';
import { BookableResource } from './resource.entities.js';
import { SqlReservationRepository } from './sql.reservation.repository.js';
import { SqlResourceRepository } from './sql.resource.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';

describe('SqlReservationRepository', () => {
  let mockSqlClient: SqlClient;
  let resourceRepo: SqlResourceRepository;
  let repo: SqlReservationRepository;

  const reservationRow = {
    id: 'res-1',
    customer_id: 'cust-1',
    customer_name: 'Ana García',
    customer_email: 'ana@example.com',
    resource_id: 't1',
    status: ReservationStatus.CONFIRMED,
    start_time: '2026-07-01T20:00:00.000Z',
    end_time: '2026-07-01T22:00:00.000Z',
    details: { guests: 2 },
    total_price: '50.00',
    deposit_amount: '0',
    reservation_number: 1,
  };

  beforeEach(() => {
    mockSqlClient = {
      query: vi.fn(async (sql: string) => {
        // Orden importante: getFiltered({isLodging}) arma un EXISTS que
        // contiene el substring "FROM resources" DENTRO de la query
        // principal (que sigue siendo "FROM reservations r ..." de
        // baseSelect()) — hay que distinguir por la forma más específica
        // primero, si no countFiltered/getFiltered con isLodging matchean
        // la rama de resourceRepo.getById() por error.
        if (sql.includes('COUNT(*)')) {
          return { rows: [{ count: '1' }] };
        }
        if (sql.includes('FROM reservations')) {
          return { rows: [reservationRow] };
        }
        if (sql.includes('FROM resources')) {
          return {
            rows: [
              {
                id: 't1',
                name: 'Mesa Ventana',
                category_id: 'cat-table',
                base_price: 50,
                visual_data: null,
              },
            ],
          };
        }
        // rowToReservation() consulta reservation_lines por cada fila —
        // sin desglose en este fixture, no afecta lo que estos tests verifican.
        if (sql.includes('FROM reservation_lines')) {
          return { rows: [] };
        }
        return { rows: [reservationRow] };
      }) as unknown as SqlClient['query'],
    };
    resourceRepo = new SqlResourceRepository(mockSqlClient);
    repo = new SqlReservationRepository(mockSqlClient, resourceRepo);
  });

  it('debe reconstruir una reserva desde SQL', async () => {
    const reservation = await repo.getById('res-1');

    expect(reservation).toBeDefined();
    expect(reservation!.id).toBe('res-1');
    expect(reservation!.status).toBe(ReservationStatus.CONFIRMED);
    expect(reservation!.resource).toBeInstanceOf(BookableResource);
    expect(reservation!.customer.email).toBe('ana@example.com');
  });

  it('debe usar solo estados bloqueantes en getActiveForResourceInRange', async () => {
    await repo.getActiveForResourceInRange(
      't1',
      new Date('2026-07-01T00:00:00'),
      new Date('2026-07-02T00:00:00'),
    );

    const call = (mockSqlClient.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toContain('status = ANY');
    expect(call[1][3]).toEqual([
      ReservationStatus.PENDING,
      ReservationStatus.CONFIRMED,
    ]);
  });

  // 18/08/2026 — badge de late check-out en el tablero de housekeeping
  // (pendientes-2026-08-18.md punto N): confirma que el filtro es por
  // fecha de checkout + pedido APROBADO, como pide el ticket ("reservas
  // con schedule_approval_status = aprobado y checkout de hoy").
  it('getApprovedLateCheckoutsForDate filtra por end_time::date + schedule_approval_status=APPROVED', async () => {
    await repo.getApprovedLateCheckoutsForDate('2026-08-14');

    const call = (mockSqlClient.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toContain('r.end_time::date = $1::date');
    expect(call[0]).toContain("r.schedule_approval_status = 'APPROVED'");
    expect(call[0]).toContain('r.requested_check_out_time IS NOT NULL');
    expect(call[1]).toEqual(['2026-08-14']);
  });

  // Regresión (18/08/2026): el ON CONFLICT DO UPDATE de save()/saveWithClient()
  // no incluía resource_id/start_time/end_time. INSERT los recibía bien, pero
  // como la fila ya existía en cada updateReservation() (drag-to-move/resize
  // del calendario), el UPDATE nunca los tocaba: la API devolvía 200 con el
  // objeto en memoria como si hubiera guardado, pero la fila real en la base
  // no cambiaba de fecha ni de recurso.
  it('el UPDATE del upsert debe tocar resource_id/start_time/end_time, no solo status/details/total_price', async () => {
    const reservation = await repo.getById('res-1');
    await repo.save(reservation!);

    const saveCall = (mockSqlClient.query as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('ON CONFLICT'),
    );
    expect(saveCall).toBeDefined();
    const sql = saveCall![0] as string;
    const setClause = sql.slice(sql.indexOf('DO UPDATE SET'));
    expect(setClause).toMatch(/resource_id\s*=/);
    expect(setClause).toMatch(/start_time\s*=/);
    expect(setClause).toMatch(/end_time\s*=/);
  });

  // Regresión (18/08/2026): service_id/party_size/notes/order_item_id
  // faltaban del INSERT Y del ON CONFLICT enteros -- no es que se
  // desincronizaran entre sí (como el bug de arriba), directamente nunca
  // se escribían. Efecto real: getActiveForServiceInRange() nunca podía
  // matchear nada porque service_id quedaba NULL en toda fila. Encontrado
  // de paso al agregar adultos/ninos a este mismo INSERT.
  it('el INSERT y el UPDATE del upsert deben incluir service_id/party_size/notes/order_item_id/adultos/ninos', async () => {
    const reservation = await repo.getById('res-1');
    await repo.save(reservation!);

    const saveCall = (mockSqlClient.query as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('ON CONFLICT'),
    );
    expect(saveCall).toBeDefined();
    const sql = saveCall![0] as string;
    const insertClause = sql.slice(0, sql.indexOf('ON CONFLICT'));
    const setClause = sql.slice(sql.indexOf('DO UPDATE SET'));

    for (const column of [
      'service_id', 'party_size', 'notes', 'order_item_id', 'adultos', 'ninos', 'rate_plan_id',
      'requested_check_in_time', 'requested_check_out_time', 'schedule_approval_status',
      'schedule_approved_by', 'schedule_charge_amount', 'reservation_number',
    ]) {
      expect(insertClause).toContain(column);
      expect(setClause).toMatch(new RegExp(`${column}\\s*=`));
    }
  });

  // K2 (23/08/2026) — filtro isLodging/search nuevo en getFiltered/countFiltered,
  // para separar Reservas/Turnos y buscar por nombre/email server-side.
  describe('getFiltered / countFiltered — isLodging y search', () => {
    it('sin filtros no agrega el EXISTS de isLodging ni el ILIKE de search', async () => {
      await repo.getFiltered({});

      const call = (mockSqlClient.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[0]).not.toContain('EXISTS');
      expect(call[0]).not.toContain('ILIKE');
      expect(call[1]).toEqual([]);
    });

    it('isLodging agrega un EXISTS contra resources/resource_categories, no un JOIN en el FROM principal', async () => {
      await repo.getFiltered({ isLodging: true });

      const call = (mockSqlClient.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[0]).toContain('FROM reservations r');
      expect(call[0]).toContain('EXISTS (');
      expect(call[0]).toContain('JOIN resource_categories rc ON rc.id = res.category_id');
      expect(call[0]).toContain('rc.is_lodging = $1');
      expect(call[1]).toEqual([true]);
    });

    it('isLodging: false también viaja como parámetro real, no se cae por falsy', async () => {
      await repo.countFiltered({ isLodging: false });

      const call = (mockSqlClient.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[0]).toContain('rc.is_lodging = $1');
      expect(call[1]).toEqual([false]);
    });

    it('search busca por customer_name O customer_email con el mismo parámetro', async () => {
      await repo.getFiltered({ search: 'Ana' });

      const call = (mockSqlClient.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[0]).toContain('r.customer_name ILIKE $1');
      expect(call[0]).toContain('r.customer_email ILIKE $1');
      expect(call[1]).toEqual(['%Ana%']);
    });

    it('search vacío o solo espacios no agrega ningún filtro', async () => {
      await repo.getFiltered({ search: '   ' });

      const call = (mockSqlClient.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[0]).not.toContain('ILIKE');
      expect(call[1]).toEqual([]);
    });

    it('isLodging + search combinados usan índices de parámetro correlativos', async () => {
      await repo.getFiltered({ isLodging: true, search: 'Ana' });

      const call = (mockSqlClient.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[0]).toContain('rc.is_lodging = $1');
      expect(call[0]).toContain('r.customer_name ILIKE $2');
      expect(call[0]).toContain('r.customer_email ILIKE $2');
      expect(call[1]).toEqual([true, '%Ana%']);
    });

    it('countFiltered arma el mismo WHERE que getFiltered, sin LIMIT/OFFSET', async () => {
      await repo.countFiltered({ isLodging: true, search: 'Ana' });

      const call = (mockSqlClient.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[0]).toContain('SELECT COUNT(*) AS count FROM reservations r');
      expect(call[0]).not.toContain('LIMIT');
      expect(call[0]).not.toContain('OFFSET');
      expect(call[1]).toEqual([true, '%Ana%']);
    });
  });
});
