/**
 * @file operating-hours.repository.ts
 * @description Horario de atención — cascada negocio → recurso.
 *
 * Un mismo repositorio cubre las dos tablas (`business_hours`,
 * `resource_hours`) porque son un único concepto con dos niveles, no dos
 * features separadas: el negocio tiene un horario por defecto ("Mi
 * Negocio"), y un recurso puntual (típicamente una persona — un barbero,
 * una estilista) puede tener uno propio que lo REEMPLAZA (no se combina)
 * para ese recurso. Ver docs/conocimiento-del-negocio.md sección 2/3 para
 * el caso real que motivó este diseño.
 */

export interface OperatingWindow {
  id: string;
  dayOfWeek: number; // 0 = lunes ... 6 = domingo
  startTime: string; // HH:MM:SS
  endTime: string;
}

export interface CreateBusinessWindowDto {
  id: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export interface CreateResourceWindowDto {
  id: string;
  resourceId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

function toMinutes(time: string): number {
  const parts = time.split(':').map(Number);
  return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
}

/**
 * Compara dos ventanas del MISMO día. Dos rangos [s1,e1) y [s2,e2) se
 * superponen si s1 < e2 && s2 < e1 — cubre tanto duplicados exactos
 * (09:00-18:00 dos veces) como solapamientos parciales (09:00-13:00 y
 * 12:00-15:00), que son igual de inválidos: no tiene sentido que un
 * negocio o recurso tenga dos franjas activas al mismo tiempo el mismo día.
 */
export function windowsOverlap(
  a: { startTime: string; endTime: string },
  b: { startTime: string; endTime: string },
): boolean {
  return toMinutes(a.startTime) < toMinutes(b.endTime) && toMinutes(b.startTime) < toMinutes(a.endTime);
}

export interface IOperatingHoursRepository {
  getAllBusinessWindows(): Promise<OperatingWindow[]>;
  createBusinessWindow(dto: CreateBusinessWindowDto): Promise<OperatingWindow>;
  deleteBusinessWindow(id: string): Promise<void>;

  getResourceWindows(resourceId: string): Promise<OperatingWindow[]>;
  createResourceWindow(dto: CreateResourceWindowDto): Promise<OperatingWindow>;
  deleteResourceWindow(id: string): Promise<void>;

  /**
   * Resuelve la cascada: si el recurso tiene ventanas propias para ese día,
   * las devuelve (y SOLO esas — no se mezclan con el horario del negocio).
   * Si no tiene ninguna, cae al horario por defecto del negocio para ese día.
   */
  getEffectiveWindows(resourceId: string, dayOfWeek: number): Promise<OperatingWindow[]>;
}
