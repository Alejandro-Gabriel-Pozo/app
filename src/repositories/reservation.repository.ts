import { Reservation } from '../domain/Reservation.js';
import { ReservationStatus } from '../types/enums.js';
import { SqlClient } from './sql.client.js';

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

  // Filtrado genérico + paginación
  getFiltered(filters: ReservationFilters): Promise<Reservation[]>;
  countFiltered(filters: Omit<ReservationFilters, 'page' | 'limit'>): Promise<number>;

  /** @deprecated Usar getFiltered({}) */
  getAll(): Promise<Reservation[]>;
}
