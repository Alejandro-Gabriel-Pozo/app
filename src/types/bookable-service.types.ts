/**
 * @file bookable-service.types.ts
 * @description Tipos de dominio para servicios agendables y sus horarios.
 *
 * ## exactOptionalPropertyTypes — Convención de DTOs
 *
 * Con `exactOptionalPropertyTypes: true` en tsconfig, `prop?: string`
 * significa que la clave puede ESTAR AUSENTE, pero NO puede estar
 * presente con valor `undefined`.
 *
 * Esto conflictuúa con Zod, que infiere `.optional()` como `T | undefined`
 * (la clave puede existir con valor undefined). Para que los DTOs sean
 * assignables desde el output de Zod, las props opcionales deben declarar
 * `prop?: string | undefined`.
 *
 * REGLA: todas las propiedades opcionales de DTOs que se asignan desde
 * Zod deben incluir `| undefined` explícitamente.
 *
 * NO hacer: `description?: string`
 * SÍ hacer: `description?: string | undefined`
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export type BookingMode = 'slot' | 'block' | 'event';

// ---------------------------------------------------------------------------
// Entidades
// ---------------------------------------------------------------------------

export interface BookableService {
  id:              string;
  categoryId:      string;
  name:            string;
  description?:    string | undefined;
  bookingMode:     BookingMode;
  durationMinutes: number | null;
  price:           number;
  active:          boolean;
  createdAt:       Date;
  updatedAt:       Date;
  /** Schedules cargados inline en GET /:id */
  schedules?:      ServiceSchedule[] | undefined;
}

export interface ServiceSchedule {
  id:          string;
  serviceId:   string;
  dayOfWeek:   number;  // 0 = lunes ... 6 = domingo
  startTime:   string;  // HH:MM:SS
  maxCapacity: number;
  active:      boolean;
}

// ---------------------------------------------------------------------------
// DTOs — Bookable Service
// ---------------------------------------------------------------------------

export interface CreateBookableServiceDTO {
  id:               string;
  categoryId:       string;
  name:             string;
  description?:     string | undefined;
  bookingMode:      BookingMode;
  durationMinutes?: number | null | undefined;
  price:            number;
}

export interface UpdateBookableServiceDTO {
  categoryId?:      string | undefined;
  name?:            string | undefined;
  description?:     string | undefined;
  bookingMode?:     BookingMode | undefined;
  durationMinutes?: number | null | undefined;
  price?:           number | undefined;
  active?:          boolean | undefined;
}

// ---------------------------------------------------------------------------
// DTOs — Service Schedule
// ---------------------------------------------------------------------------

export interface CreateServiceScheduleDTO {
  id:          string;
  serviceId:   string;
  dayOfWeek:   number;
  startTime:   string;
  maxCapacity: number;
}

export interface UpdateServiceScheduleDTO {
  dayOfWeek?:   number | undefined;
  startTime?:   string | undefined;
  maxCapacity?: number | undefined;
  active?:      boolean | undefined;
}
