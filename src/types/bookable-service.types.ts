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

/**
 * Tarifa de un servicio (18/08/2026, spec de mejoras PMS) — un mismo
 * `BookableService` puede tener varias `RatePlan` simultáneas (Rack,
 * Corporativa, No reembolsable), cada una con su propio precio y vigencia.
 * `validFrom`/`validTo` son fechas de calendario (no instantes) — una
 * tarifa de temporada aplica por día. `null` en cualquiera de las dos =
 * sin restricción de ese extremo.
 */
export interface RatePlan {
  id:                  string;
  serviceId:           string;
  name:                string;
  price:               number;
  includesBreakfast:   boolean;
  cancellationPolicy:  string | null;
  validFrom:           string | null; // YYYY-MM-DD
  validTo:             string | null; // YYYY-MM-DD
  active:              boolean;
  createdAt:           Date;
  updatedAt:           Date;
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

// ---------------------------------------------------------------------------
// DTOs — Rate Plan
// ---------------------------------------------------------------------------

export interface CreateRatePlanDTO {
  id:                  string;
  serviceId:           string;
  name:                string;
  price:               number;
  includesBreakfast?:  boolean | undefined;
  cancellationPolicy?: string | null | undefined;
  validFrom?:          string | null | undefined;
  validTo?:            string | null | undefined;
}

export interface UpdateRatePlanDTO {
  name?:                string | undefined;
  price?:               number | undefined;
  includesBreakfast?:   boolean | undefined;
  cancellationPolicy?:  string | null | undefined;
  validFrom?:           string | null | undefined;
  validTo?:             string | null | undefined;
  active?:              boolean | undefined;
}
