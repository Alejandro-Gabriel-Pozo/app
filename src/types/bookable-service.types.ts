/**
 * @file bookable-service.types.ts
 * @description Tipos de dominio para servicios agendables y sus horarios.
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
  description?:    string;
  bookingMode:     BookingMode;
  durationMinutes: number | null;
  price:           number;
  active:          boolean;
  createdAt:       Date;
  updatedAt:       Date;
  /** Schedules cargados inline en GET /:id */
  schedules?:      ServiceSchedule[];
}

export interface ServiceSchedule {
  id:          string;
  serviceId:   string;
  dayOfWeek:   number;  // 0 = lunes … 6 = domingo
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
  description?:     string;
  bookingMode:      BookingMode;
  durationMinutes?: number | null;
  price:            number;
}

export interface UpdateBookableServiceDTO {
  categoryId?:      string;
  name?:            string;
  description?:     string;
  bookingMode?:     BookingMode;
  durationMinutes?: number | null;
  price?:           number;
  active?:          boolean;
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
  dayOfWeek?:   number;
  startTime?:   string;
  maxCapacity?: number;
  active?:      boolean;
}
