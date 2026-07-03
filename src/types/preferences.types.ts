/**
 * @file preferences.types.ts
 * @description Alias de compatibilidad para la migración a resource-categories.
 *
 * `PreferenceDetailsByResource` fue eliminado como tipo estructurado.
 * Se mantiene como alias de `Record<string, unknown>` para que los archivos
 * que aún lo importan compilen sin cambios adicionales.
 *
 * @deprecated Usar `Record<string, unknown>` directamente en código nuevo.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PreferenceDetailsByResource = Record<string, any>;
