import type { Reservation } from '../domain/Reservation.js';
import type { ReservationStatus } from '../types/enums.js';
import type { SqlClient } from './sql.client.js';

export interface ReservationFilters {
  status?:     ReservationStatus;
  resourceId?: string;
  customerId?: string;
  from?:       Date;
  to?:         Date;
  page?:       number;
  limit?:      number;
}

export interface ReservationRepository {
  // Escritura
  save(reservation: Reservation): Promise<void>;
  saveWithClient(client: SqlClient, reservation: Reservation): Promise<void>;
  delete(id: string): Promise<boolean>;

  // Lectura — métodos específicos
  getById(id: string): Promise<Reservation | undefined>;
  getByCustomerId(customerId: string): Promise<Reservation[]>;
  getByResourceId(resourceId: string): Promise<Reservation[]>;
  getByStatus(status: ReservationStatus): Promise<Reservation[]>;
  getByDateRange(startDate: Date, endDate: Date): Promise<Reservation[]>;

  /**
   * Devuelve reservas PENDING + CONFIRMED que solapan el rango.
   * Usado en chequeos de disponibilidad SIN transacción
   * (e.g. checkAvailability, GET de disponibilidad en el router).
   */
  getActiveForResourceInRange(
    resourceId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Reservation[]>;

  /**
   * Igual que getActiveForResourceInRange pero emite SELECT ... FOR UPDATE.
   * Debe llamarse dentro de una transacción activa (client provisto por
   * transactionManager.run()).
   *
   * Opcional (?:) para no romper mocks/stubs en tests unitarios que
   * no necesiten el lock.
   */
  getActiveForResourceInRangeWithLock?(
    client: SqlClient,
    resourceId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Reservation[]>;

  /**
   * Devuelve reservas PENDING + CONFIRMED que solapan el rango, filtradas
   * por `serviceId` en lugar de `resourceId`.
   *
   * ## Por qué existe
   * `resource_locks` vincula un servicio con recursos ADICIONALES que
   * bloquea (más allá del `resourceId` principal de cada reserva). Para
   * saber si un recurso R está ocupado hay que mirar dos cosas: reservas
   * cuyo `resourceId` primario ES R, Y reservas de cualquier OTRO servicio
   * que también bloquee R vía `resource_locks` — esas reservas viven bajo
   * SU PROPIO `resourceId` primario (nunca bajo R), así que
   * `getActiveForResourceInRange(R, ...)` solo no las encuentra. Ver
   * `ReservationService.resolveOccupyingReservations()`.
   */
  getActiveForServiceInRange(
    serviceId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Reservation[]>;

  /** Igual que getActiveForServiceInRange pero con SELECT ... FOR UPDATE. */
  getActiveForServiceInRangeWithLock?(
    client: SqlClient,
    serviceId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Reservation[]>;

  // Filtrado genérico + paginación
  getFiltered(filters: ReservationFilters): Promise<Reservation[]>;
  countFiltered(filters: Omit<ReservationFilters, 'page' | 'limit'>): Promise<number>;

  /** @deprecated Usar getFiltered({}) */
  getAll(): Promise<Reservation[]>;
}
