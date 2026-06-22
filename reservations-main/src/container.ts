import { InMemoryResourceRepository } from './repositories/in-memory.resource.repository.js';
import { InMemoryReservationRepository } from './repositories/in-memory.reservation.repository.js';
import { InMemoryOccupancyRepository } from './repositories/in-memory.occupancy.repository.js';
import { ReservationService } from './services/reservation.service.js';
import { ReportService } from './services/report.service.js';
import { seedDemoData } from './seed/demo-data.js';

export interface AppContainer {
  resourceRepository: InMemoryResourceRepository;
  reservationRepository: InMemoryReservationRepository;
  occupancyRepository: InMemoryOccupancyRepository;
  reservationService: ReservationService;
  reportService: ReportService;
}

export async function createAppContainer(): Promise<AppContainer> {
  const resourceRepository = new InMemoryResourceRepository();
  const reservationRepository = new InMemoryReservationRepository();
  const occupancyRepository = new InMemoryOccupancyRepository();

  const reservationService = new ReservationService(
    reservationRepository,
    resourceRepository,
    occupancyRepository,
  );
  const reportService = new ReportService(occupancyRepository);

  await seedDemoData({
    resourceRepository,
    reservationRepository,
    occupancyRepository,
  });

  return {
    resourceRepository,
    reservationRepository,
    occupancyRepository,
    reservationService,
    reportService,
  };
}
