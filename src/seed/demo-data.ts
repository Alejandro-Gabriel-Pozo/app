import {
  ResourceType,
  TableShape,
  TableLocation,
  BedPreference,
  TherapistGenderPreference,
  ReservationStatus,
} from '../types/enums.js';
import {
  CabinResource,
  TableResource,
  SpaResource,
  TourSeatResource,
  Customer,
} from '../domain/entities.js';
import { Reservation } from '../domain/Reservation.js';
import { ResourceRepository } from '../repositories/resource.repository.js';
import { ReservationRepository } from '../repositories/reservation.repository.js';
import { OccupancyRepository } from '../repositories/occupancy.repository.js';
import { CustomerRepository } from '../repositories/customer.repository.js';

export async function seedDemoData(deps: {
  resourceRepository: ResourceRepository;
  reservationRepository: ReservationRepository;
  occupancyRepository: OccupancyRepository;
  customerRepository: CustomerRepository;
}): Promise<void> {
  const resources = [
    new CabinResource('cabin-a', 'Cabaña Bosque', 180),
    new CabinResource('cabin-b', 'Cabaña Lago', 220),
    new TableResource('table-window', 'Mesa Ventana', 45, {
      shape: TableShape.RECTANGLE,
      width: 120,
      height: 80,
      positionX: 10,
      positionY: 20,
      rotationDegrees: 0,
    }),
    new TableResource('table-terrace', 'Mesa Terraza', 50, {
      shape: TableShape.CIRCLE,
      width: 90,
      height: 90,
      positionX: 200,
      positionY: 50,
      rotationDegrees: 0,
    }),
    new TableResource('table-inside', 'Mesa Interior', 35, {
      shape: TableShape.SQUARE,
      width: 80,
      height: 80,
      positionX: 100,
      positionY: 100,
      rotationDegrees: 45,
    }),
    new SpaResource('spa-1', 'Sala Masaje Zen', 90),
    new TourSeatResource('tour-1', 'Asiento Tour Isla', 25),
    new TourSeatResource('tour-2', 'Asiento Tour Isla', 25),
  ];

  for (const resource of resources) {
    await deps.resourceRepository.save(resource);
  }

  // Persistir clientes antes de las reservas
  const customer        = new Customer('cust-demo', 'María López',  'maria@demo.com');
  const pendingCustomer = new Customer('cust-2',    'Carlos Ruiz',  'carlos@demo.com');
  const spaCustomer     = new Customer('cust-3',    'Laura Vega',   'laura@demo.com');

  await deps.customerRepository.save(customer);
  await deps.customerRepository.save(pendingCustomer);
  await deps.customerRepository.save(spaCustomer);

  const confirmedReservation = new Reservation(
    ResourceType.RESTAURANT_TABLE,
    'res-demo-1',
    customer,
    resources[2] as TableResource,
    new Date('2026-07-15T20:00:00'),
    new Date('2026-07-15T22:00:00'),
    { allergies: ['gluten'], tableLocation: TableLocation.WINDOW },
  );
  confirmedReservation.status = ReservationStatus.CONFIRMED;
  await deps.reservationRepository.save(confirmedReservation);

  await deps.occupancyRepository.recordReservation(
    'table-window',
    'Mesa Ventana',
    confirmedReservation.startTime,
    confirmedReservation.endTime,
    ReservationStatus.CONFIRMED,
  );

  const pendingReservation = new Reservation(
    ResourceType.CABIN,
    'res-demo-2',
    pendingCustomer,
    resources[0] as CabinResource,
    new Date('2026-08-01T15:00:00'),
    new Date('2026-08-03T11:00:00'),
    {
      passportNumber: 'AB123456',
      bedPreference: BedPreference.KING,
      lateCheckIn: true,
    },
  );
  await deps.reservationRepository.save(pendingReservation);

  const spaReservation = new Reservation(
    ResourceType.SPA,
    'res-demo-3',
    spaCustomer,
    resources[5] as SpaResource,
    new Date('2026-07-20T16:00:00'),
    new Date('2026-07-20T17:30:00'),
    {
      oilAllergies: [],
      therapistGenderPreference: TherapistGenderPreference.ANY,
    },
  );
  spaReservation.status = ReservationStatus.CONFIRMED;
  await deps.reservationRepository.save(spaReservation);

  await deps.occupancyRepository.recordReservation(
    'spa-1',
    'Sala Masaje Zen',
    spaReservation.startTime,
    spaReservation.endTime,
    ReservationStatus.CONFIRMED,
  );
}
