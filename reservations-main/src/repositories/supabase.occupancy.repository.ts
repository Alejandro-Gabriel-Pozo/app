import { supabase } from '../config/supabase.js';
import { ReservationSnapshot } from '../domain/reservation.types.js';
import { OccupancyRepository } from './occupancy.repository.js';

export class SupabaseOccupancyRepository implements OccupancyRepository {
  async getOccupancyByResourceAndDateRange(
    resourceId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<ReservationSnapshot[]> {
    const { data, error } = await supabase
      .from('reservations')
      .select('id, resource_id, start_time, end_time, status')
      .eq('resource_id', resourceId)
      .gte('end_time', startDate.toISOString())
      .lte('start_time', endDate.toISOString())
      .in('status', ['PENDING', 'CONFIRMED'])
      .order('start_time', { ascending: true });

    if (error) {
      throw new Error(`Failed to fetch occupancy: ${error.message}`);
    }

    return (data || []).map((row: any) => ({
      id: row.id,
      resourceId: row.resource_id,
      startTime: new Date(row.start_time),
      endTime: new Date(row.end_time),
      status: row.status,
    }));
  }

  async getOccupancyByResourceType(
    resourceType: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Record<string, ReservationSnapshot[]>> {
    const { data, error } = await supabase
      .from('reservations')
      .select('id, resource_id, start_time, end_time, status')
      .eq('resource_type', resourceType)
      .gte('end_time', startDate.toISOString())
      .lte('start_time', endDate.toISOString())
      .in('status', ['PENDING', 'CONFIRMED'])
      .order('resource_id, start_time', { ascending: true });

    if (error) {
      throw new Error(`Failed to fetch occupancy by type: ${error.message}`);
    }

    const occupancyMap: Record<string, ReservationSnapshot[]> = {};

    (data || []).forEach((row: any) => {
      const resourceId = row.resource_id;
      if (!occupancyMap[resourceId]) {
        occupancyMap[resourceId] = [];
      }
      occupancyMap[resourceId].push({
        id: row.id,
        resourceId: row.resource_id,
        startTime: new Date(row.start_time),
        endTime: new Date(row.end_time),
        status: row.status,
      });
    });

    return occupancyMap;
  }

  async getUnderutilizedResources(
    resourceType: string,
    minOccupancyPercent: number,
    startDate: Date,
    endDate: Date,
  ): Promise<{ resourceId: string; occupancyPercent: number }[]> {
    const { data, error } = await supabase.rpc('get_underutilized_resources', {
      p_resource_type: resourceType,
      p_min_occupancy: minOccupancyPercent,
      p_start_date: startDate.toISOString(),
      p_end_date: endDate.toISOString(),
    });

    if (error) {
      throw new Error(`Failed to fetch underutilized resources: ${error.message}`);
    }

    return data || [];
  }

  async recordOccupancy(resourceId: string, snapshot: ReservationSnapshot): Promise<void> {
    const { error } = await supabase
      .from('reservations')
      .update({
        status: snapshot.status,
        updated_at: new Date().toISOString(),
      })
      .eq('id', snapshot.id);

    if (error) {
      throw new Error(`Failed to record occupancy: ${error.message}`);
    }
  }
}
