/**
 * @file preferences.types.ts
 * @deprecated Eliminado en feat/resource-categories.
 *
 * Los tipos de preferencias por recurso ya no son estáticos.
 * Cada negocio define sus campos en `resource_categories.fields` (JSONB).
 * La validación dinámica ocurre en `CategoryService.validateDetailsAgainstFields()`.
 *
 * Este archivo se mantiene temporalmente vacío para no romper imports
 * que aún no fueron actualizados. Eliminar en el próximo cleanup.
 */

export {};
