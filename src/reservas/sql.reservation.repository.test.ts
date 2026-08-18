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
  };

  beforeEach(() => {
    mockSqlClient = {
      query: vi.fn(async (sql: string) => {
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

    for (const column of ['service_id', 'party_size', 'notes', 'order_item_id', 'adultos', 'ninos', 'rate_plan_id']) {
      expect(insertClause).toContain(column);
      expect(setClause).toMatch(new RegExp(`${column}\\s*=`));
    }
  });
});
