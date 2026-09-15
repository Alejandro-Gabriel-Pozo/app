import type { SqlClient }          from '../repositories/sql.client.js';
import { ReservationStatus }        from '../types/enums.js';
import type { Reservation }              from './Reservation.js';
import type {
  ReservationRepository,
  ReservationFilters,
}                                   from './reservation.repository.js';
import type { AppliedRateReportRow } from '../clientes-finanzas/customer-rate.repository.js';
import type { ICategoryRepository } from './category.repository.js';

/**
 * Implementación en memoria del repositorio de reservas.
 * Ideal para desarrollo y tests. No persiste entre reinicios.
 *
 * `saveWithClient` delega a `save()` porque el modo in-memory no tiene
 * transacciones reales — satisface la interfaz sin romper la lógica.
 *
 * ## Cambios
 * - Implementa `getFiltered()` y `countFiltered()` para cumplir la interfaz.
 * - `saveWithClient` usa `SqlClient` (abstracto) en lugar de `PoolClient` (concreto de pg).
 */
export class InMemoryReservationRepository implements ReservationRepository {
  /**
   * D-14 (parcial, 15/09/2026, docs/decisiones-auditoria-fase2-2026-09-15.md)
   * — mismo tope PROVISORIO que `SqlReservationRepository.DEFAULT_UNPAGINATED_LIMIT`,
   * para que las dos implementaciones sigan coincidiendo (evita reabrir la
   * divergencia que D-02 acaba de cerrar). Ver el comentario en
   * `SqlReservationRepository.getFiltered()` para el criterio de magnitud.
   */
  static readonly DEFAULT_UNPAGINATED_LIMIT = 100;

  private reservations: Map<string, Reservation> = new Map();

  /**
   * K2 (23/08/2026) — solo hace falta para resolver el filtro `isLodging`
   * de getFiltered() (el `Resource` embebido en cada `Reservation` trae
   * `categoryId`, no `isLodging` — eso vive en `resource_categories`, hay
   * que resolverlo aparte). Opcional porque ningún test existente hoy
   * necesita ese filtro en memoria — mismo criterio de reuso de dependencia
   * ya existente que usa `ReservationPricingService`, no una tabla/mapa
   * nuevo en este repo.
   */
  constructor(private readonly categoryRepository?: ICategoryRepository) {}

  async save(reservation: Reservation): Promise<void> {
    this.reservations.set(reservation.id, reservation);
  }

  async saveWithClient(_client: SqlClient, reservation: Reservation): Promise<void> {
    // In-memory no tiene transacciones — delega a save()
    await this.save(reservation);
  }

  async getById(id: string): Promise<Reservation | undefined> {
    return this.reservations.get(id);
  }

  async getByCustomerId(customerId: string): Promise<Reservation[]> {
    return Array.from(this.reservations.values()).filter(
      (r) => r.customer.id === customerId,
    );
  }

  async getByResourceId(resourceId: string): Promise<Reservation[]> {
    return Array.from(this.reservations.values()).filter(
      (r) => r.resource.id === resourceId,
    );
  }

  async getByStatus(status: ReservationStatus): Promise<Reservation[]> {
    return Array.from(this.reservations.values()).filter(
      (r) => r.status === status,
    );
  }

  async getByDateRange(startDate: Date, endDate: Date): Promise<Reservation[]> {
    return Array.from(this.reservations.values()).filter(
      (r) => r.startTime < endDate && r.endTime > startDate,
    );
  }

  async getPendingWithExpiredDeposit(now: Date): Promise<Reservation[]> {
    return Array.from(this.reservations.values()).filter(
      (r) => r.status === ReservationStatus.PENDING && r.depositDueBy != null && r.depositDueBy < now,
    );
  }

  async getApprovedLateCheckoutsForDate(date: string): Promise<Reservation[]> {
    return Array.from(this.reservations.values()).filter(
      (r) =>
        r.scheduleApprovalStatus === 'APPROVED' &&
        r.requestedCheckOutTime != null &&
        r.endTime.toISOString().slice(0, 10) === date,
    );
  }

  /**
   * Reservas PENDING/CONFIRMED que solapan un rango, filtradas por lo que
   * indique `matches` — único filtro para las variantes por recurso y por
   * servicio de abajo (antes duplicado, jscpd C5).
   */
  private getActiveInRange(
    matches: (r: Reservation) => boolean,
    startDate: Date,
    endDate: Date,
  ): Reservation[] {
    const activeStatuses = [ReservationStatus.PENDING, ReservationStatus.CONFIRMED];
    return Array.from(this.reservations.values()).filter(
      (r) => matches(r) && activeStatuses.includes(r.status) && r.startTime < endDate && r.endTime > startDate,
    );
  }

  async getActiveForResourceInRange(
    resourceId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Reservation[]> {
    return this.getActiveInRange((r) => r.resource.id === resourceId, startDate, endDate);
  }

  async getActiveForServiceInRange(
    serviceId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Reservation[]> {
    return this.getActiveInRange((r) => r.serviceId === serviceId, startDate, endDate);
  }

  /**
   * Aplica todos los filtros de `ReservationFilters` MENOS page/limit —
   * extraído de getFiltered() (D-14 parcial, 15/09/2026) para que
   * countFiltered() pueda seguir devolviendo el total REAL (sin cota):
   * antes de este cambio countFiltered() delegaba en getFiltered(), y
   * ahora que getFiltered() cae a un tope por default sin page/limit,
   * esa delegación habría devuelto el total CAPADO en vez del real —
   * mismo bug shape que D-02 (dos operaciones que deberían coincidir
   * divergiendo en silencio), esta vez entre getFiltered/countFiltered
   * del mismo repo en vez de entre repos. countFiltered() nunca recibe
   * page/limit (`Omit<...>` en su firma) así que no hace falta que este
   * helper los toque.
   */
  private async applyFilters(
    filters: Omit<ReservationFilters, 'page' | 'limit'>,
  ): Promise<Reservation[]> {
    let results = Array.from(this.reservations.values());

    if (filters.status)     results = results.filter((r) => r.status === filters.status);
    if (filters.resourceId) results = results.filter((r) => r.resource.id === filters.resourceId);
    if (filters.customerId) results = results.filter((r) => r.customer.id === filters.customerId);
    if (filters.from)       results = results.filter((r) => r.endTime   > filters.from!);
    if (filters.to)         results = results.filter((r) => r.startTime < filters.to!);

    if (filters.isLodging !== undefined) {
      if (!this.categoryRepository) {
        // Fallar fuerte en vez de devolver resultados sin filtrar en
        // silencio — mismo criterio que "errores silenciosos" del resto
        // del proyecto: mejor romper un test que dar por buena una
        // separación Reservas/Turnos que en realidad no se aplicó.
        throw new Error(
          'InMemoryReservationRepository.getFiltered({isLodging}) requiere categoryRepository inyectado en el constructor.',
        );
      }
      const flags = await Promise.all(
        results.map((r) => this.categoryRepository!.findById(r.resource.categoryId)),
      );
      results = results.filter((_, i) => flags[i]?.isLodging === filters.isLodging);
    }
    if (filters.search && filters.search.trim() !== '') {
      const q = filters.search.trim().toLowerCase();
      results = results.filter((r) =>
        r.customer.fullName?.toLowerCase().includes(q) || r.customer.email?.toLowerCase().includes(q),
      );
    }

    return results;
  }

  async getFiltered(filters: ReservationFilters): Promise<Reservation[]> {
    const results = await this.applyFilters(filters);

    // D-14 (parcial) — sin limit explícito, antes se devolvía
    // `results.length` (todo, sin cota real). Ahora cae al mismo tope
    // PROVISORIO que el repo SQL (ver arriba) en vez de "todo".
    const page  = filters.page  ?? 1;
    const limit = filters.limit ?? InMemoryReservationRepository.DEFAULT_UNPAGINATED_LIMIT;
    return results.slice((page - 1) * limit, page * limit);
  }

  async countFiltered(
    filters: Omit<ReservationFilters, 'page' | 'limit'>,
  ): Promise<number> {
    // Cuenta sobre applyFilters() directo, NUNCA sobre getFiltered() — ver
    // el docblock de applyFilters(): total real, sin el tope de getFiltered().
    return (await this.applyFilters(filters)).length;
  }

  async delete(id: string): Promise<boolean> {
    return this.reservations.delete(id);
  }

  async getAll(): Promise<Reservation[]> {
    return Array.from(this.reservations.values());
  }

  /**
   * D7 (22/08/2026) — test double, sin `createdAt` en el agregado
   * `Reservation` (solo vive como columna en la fila SQL) -- usa
   * `startTime` como proxy del rango. Ningún test de `ReportService` usa
   * este repo (tiene su propio fake dedicado); esto solo existe para
   * satisfacer `ReservationRepository` en tests que sí lo instancian.
   */
  async getAppliedRatesReport(from: Date, to: Date): Promise<AppliedRateReportRow[]> {
    const groups = new Map<string, AppliedRateReportRow>();

    for (const reservation of this.reservations.values()) {
      if (!reservation.appliedCustomerRateId) continue;
      if (reservation.status !== ReservationStatus.CONFIRMED && reservation.status !== ReservationStatus.COMPLETED) continue;
      if (reservation.startTime < from || reservation.startTime > to) continue;

      const existing = groups.get(reservation.appliedCustomerRateId);
      if (existing) {
        existing.timesApplied += 1;
        existing.totalAmount += reservation.totalPrice;
      } else {
        groups.set(reservation.appliedCustomerRateId, {
          customerRateId: reservation.appliedCustomerRateId,
          customerId: reservation.customer.id,
          customerName: reservation.customer.fullName,
          timesApplied: 1,
          totalAmount: reservation.totalPrice,
        });
      }
    }

    return [...groups.values()].sort((a, b) => b.timesApplied - a.timesApplied);
  }
}
