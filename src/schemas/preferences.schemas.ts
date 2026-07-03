/**
 * @file preferences.schemas.ts
 * @deprecated Eliminado en feat/resource-categories.
 *
 * Los schemas Zod por tipo de recurso (AccommodationSchema, RestaurantSchema,
 * SpaSchema, TourSeatSchema) ya no son necesarios. La validación de `details`
 * en reservas se hace en runtime contra `resource_categories.fields`.
 *
 * Este archivo se mantiene temporalmente vacío para no romper imports
 * que aún no fueron actualizados. Eliminar en el próximo cleanup.
 */

export {};
