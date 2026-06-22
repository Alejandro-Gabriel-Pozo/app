import { ReservationStatus } from '../types/enums.js';
import {
  OccupancyRepository,
  OccupancySnapshot,
  OccupancyStats,
} from './occupancy.repository.js';

/**
 * Implementación en memoria del repositorio de ocupación.
 * Ideal para desarrollo y tests. No persiste entre reinicios.
 */
export class InMemoryOccupancyRepository implements OccupancyRepository {
  private snapshots: OccupancySnapshot[] = [];

  async recordReservation(
    resourceId: string,
    resourceName: string,
    startTime: Date,
    endTime: Date,
    status: ReservationStatus,
  ): Promise<void> {
    // Solo registrar reservas confirmadas o completadas (las que ocupan espacio real)
    if (
      status !== ReservationStatus.CONFIRMED &&
      status !== ReservationStatus.COMPLETED
    ) {
      return;
    }

    // Calcular minutos ocupados
    const bookedMinutes =
      (endTime.getTime() - startTime.getTime()) / (1000 * 60);

    // Registrar por cada día que ocupe la reserva
    const currentDate = new Date(startTime);
    currentDate.setHours(0, 0, 0, 0);

    while (currentDate < endTime) {
      const dayEnd = new Date(currentDate);
      dayEnd.setDate(dayEnd.getDate() + 1);
      dayEnd.setHours(0, 0, 0, 0);

      // Calcular minutos en este día específico
      const dayStart = new Date(currentDate);
      const effectiveEnd = Math.min(endTime.getTime(), dayEnd.getTime());
      const effectiveStart = Math.max(dayStart.getTime(), startTime.getTime());
      const minInDay = Math.max(
        0,
        (effectiveEnd - effectiveStart) / (1000 * 60),
      );

      const existingIndex = this.snapshots.findIndex(
        (s) =>
          s.resourceId === resourceId &&
          s.date.toDateString() === currentDate.toDateString(),
      );

      if (existingIndex >= 0) {
        this.snapshots[existingIndex].bookedMinutes += minInDay;
      } else {
        this.snapshots.push({
          resourceId,
          resourceName,
          date: new Date(currentDate),
          totalMinutes: 24 * 60,
          bookedMinutes: minInDay,
        });
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }
  }

  async getOccupancyByDateRange(
    startDate: Date,
    endDate: Date,
    resourceIds?: string[],
  ): Promise<OccupancySnapshot[]> {
    return this.snapshots.filter((snapshot) => {
      const dateMatches =
        snapshot.date >= startDate && snapshot.date < endDate;
      const resourceMatches =
        !resourceIds || resourceIds.includes(snapshot.resourceId);
      return dateMatches && resourceMatches;
    });
  }

  async getAverageOccupancyByResource(
    startDate: Date,
    endDate: Date,
  ): Promise<OccupancyStats[]> {
    const snapshots = await this.getOccupancyByDateRange(startDate, endDate);

    // Agrupar por recurso
    const byResource = new Map<
      string,
      { name: string; total: number; booked: number; count: number }
    >();

    for (const snapshot of snapshots) {
      const key = snapshot.resourceId;
      const current = byResource.get(key) || {
        name: snapshot.resourceName,
        total: 0,
        booked: 0,
        count: 0,
      };

      current.total += snapshot.totalMinutes;
      current.booked += snapshot.bookedMinutes;
      current.count += 1;

      byResource.set(key, current);
    }

    // Convertir a estadísticas
    return Array.from(byResource.entries())
      .map(([resourceId, data]) => ({
        resourceId,
        resourceName: data.name,
        date: '',
        occupancyRate:
          data.count > 0
            ? parseFloat(((data.booked / data.total) * 100).toFixed(2))
            : 0,
      }))
      .sort((a, b) => b.occupancyRate - a.occupancyRate);
  }

  async getTopOccupiedResources(
    startDate: Date,
    endDate: Date,
    limit: number = 10,
  ): Promise<OccupancyStats[]> {
    const all = await this.getAverageOccupancyByResource(startDate, endDate);
    return all.slice(0, limit);
  }

  async deleteOldRecords(beforeDate: Date): Promise<number> {
    const beforeCount = this.snapshots.length;
    this.snapshots = this.snapshots.filter((s) => s.date >= beforeDate);
    return beforeCount - this.snapshots.length;
  }

  async getAllSnapshots(): Promise<OccupancySnapshot[]> {
    return [...this.snapshots];
  }
}