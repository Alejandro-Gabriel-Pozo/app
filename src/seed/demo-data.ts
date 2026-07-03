/**
 * @file demo-data.ts
 * @description Datos de demo para el modo in-memory.
 *
 * ## Cambios
 * - Se eliminan los imports de `ResourceType` y las subclases.
 * - Se usa `BookableResource` directamente con `categoryId` fijo ('cat-demo').
 * - La reserva de demo ya no pasa `resourceType` al constructor de `Reservation`.
 * - `visualData` usa `positionX`/`positionY` en lugar de `x`/`y`.
 */

import { BookableResource, Customer } from '../domain/entities.js';
import { Reservation } from '../domain/Reservation.js';
import { ReservationRepository } from '../repositories/reservation.repository.js';
import { ResourceRepository } from '../repositories/resource.repository.js';
import { OccupancyRepository } from '../repositories/occupancy.repository.js';
import { CustomerRepository } from '../repositories/customer.repository.js';

interface SeedDeps {
  resourceRepository:    ResourceRepository;
  reservationRepository: ReservationRepository;
  occupancyRepository:   OccupancyRepository;
  customerRepository:    CustomerRepository;
}

export async function seedDemoData(deps: SeedDeps): Promise<void> {
  const table1 = new BookableResource('table-terrace', 'Mesa Terraza', 0, 'cat-demo', {
    shape: 'ROUND',
    positionX: 100,
    positionY: 200,
  });
  const table2 = new BookableResource('table-garden', 'Mesa Jardín', 0, 'cat-demo', {
    shape: 'SQUARE',
    positionX: 300,
    positionY: 150,
  });
  const cabin1 = new BookableResource('cabin-pine', 'Cabaña Pino', 150, 'cat-demo');

  await deps.resourceRepository.save(table1);
  await deps.resourceRepository.save(table2);
  await deps.resourceRepository.save(cabin1);

  const demoCustomer = new Customer('cust-demo', 'Cliente Demo', 'demo@example.com');
  await deps.customerRepository.save(demoCustomer);

  const confirmedReservation = new Reservation(
    'res-demo-1',
    demoCustomer,
    table1,
    new Date('2025-12-15T20:00:00.000Z'),
    new Date('2025-12-15T22:00:00.000Z'),
    { guests: 4, occasion: 'Cumpleaños' },
  );
  confirmedReservation.confirm();

  await deps.reservationRepository.save(confirmedReservation);
  await deps.occupancyRepository.recordReservation(
    table1.id,
    table1.name,
    confirmedReservation.startTime,
    confirmedReservation.endTime,
    confirmedReservation.status,
  );
}
