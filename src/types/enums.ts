export enum ResourceType {
  CABIN = 'CABIN',
  TOUR_SEAT = 'TOUR_SEAT',
  RESTAURANT_TABLE = 'RESTAURANT_TABLE',
  SPA = 'SPA',
}

export enum ReservationStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
  COMPLETED = 'COMPLETED',
}

export enum TableShape {
  CIRCLE = 'CIRCLE',
  SQUARE = 'SQUARE',
  RECTANGLE = 'RECTANGLE',
}

export enum UserRole {
  ADMIN = 'ADMIN',
  RECEPTIONIST = 'RECEPTIONIST',
  WAITER = 'WAITER',
}

export enum BedPreference {
  SINGLE = 'SINGLE',
  DOUBLE = 'DOUBLE',
  KING = 'KING',
}

export enum TableLocation {
  WINDOW = 'WINDOW',
  TERRACE = 'TERRACE',
  INSIDE = 'INSIDE',
}

export enum TherapistGenderPreference {
  MALE = 'MALE',
  FEMALE = 'FEMALE',
  ANY = 'ANY',
}