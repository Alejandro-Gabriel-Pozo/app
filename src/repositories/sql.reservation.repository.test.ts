import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ResourceType,
  TableShape,
  TableLocation,
  ReservationStatus,
} from '../types/enums.js';
import { SqlReservationRepository } from './sql.reservation.repository.js';
import { SqlResourceRepository } from './sql.resource.repository.js';
import { SqlClient } from './sql.client.js';
import { TableResource } from '../domain/entities.js';

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
    resource_type: ResourceType.RESTAURANT_TABLE,
    status: ReservationStatus.CONFIRMED,
    start_time: '2026-07-01T20:00:00.000Z',
    end_time: '2026-07-01T22:00:00.000Z',
    details: { allergies: [], tableLocation: TableLocation.WINDOW },
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
                type: ResourceType.RESTAURANT_TABLE,
                base_price: 50,
                visual_data: {
                  shape: TableShape.RECTANGLE,
                  width: 120,
                  height: 80,
                  positionX: 0,
                  positionY: 0,
                  rotationDegrees: 0,
                },
              },
            ],
          };
        }
        return { rows: [reservationRow] };
      }),
    };
    resourceRepo = new SqlResourceRepository(mockSqlClient);
    repo = new SqlReservationRepository(mockSqlClient, resourceRepo);
  });

  it('debe reconstruir una reserva desde SQL', async () => {
    const reservation = await repo.getById('res-1');

    expect(reservation).toBeDefined();
    expect(reservation!.id).toBe('res-1');
    expect(reservation!.status).toBe(ReservationStatus.CONFIRMED);
    expect(reservation!.resource).toBeInstanceOf(TableResource);
    expect(reservation!.customer.email).toBe('ana@example.com');
  });

  it('debe usar solo estados bloqueantes en getActiveForResourceInRange', async () => {
    await repo.getActiveForResourceInRange(
      't1',
      new Date('2026-07-01T00:00:00'),
      new Date('2026-07-02T00:00:00'),
    );

    const call = (mockSqlClient.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain('status = ANY');
    expect(call[1][3]).toEqual([
      ReservationStatus.PENDING,
      ReservationStatus.CONFIRMED,
    ]);
  });
});
