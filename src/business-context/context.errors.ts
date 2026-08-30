/**
 * @file context.errors.ts
 * @description Error tipado del read path del Business Context (Fase 4).
 * En su propio archivo para que lo compartan el repositorio (validación de
 * FORMA SQL) y el adaptador (validación de DOMINIO) sin ciclo de imports.
 */

/**
 * Error de INTEGRIDAD o de FORMA de los datos de plataforma detectado al
 * armar el contexto:
 *
 * - forma SQL: una columna esperada ausente del resultado, un agregado que
 *   no es un array, un `NULL` en una columna `NOT NULL`;
 * - dominio: `businesses.plan` que no es un `BusinessPlan`,
 *   `business_modules.source` o `modules.context_color` fuera de su enum, un
 *   `deleted_at` que no parsea como fecha.
 *
 * Es un `Error` real: conserva `message`, `name`, `stack` y funciona con
 * `instanceof` (target ES2022). NO extiende `DomainError` a propósito — no es
 * un 4xx de negocio. La ruta del Bloque 4B lo captura con
 * `if (e instanceof ContextDataError)` y responde **503 PLATFORM_UNAVAILABLE**,
 * mismo criterio que `container.getBusinessModules()` ante un negocio
 * inexistente. En 4A no hay ruta: el error se propaga al caller de los tests.
 */
export class ContextDataError extends Error {
  readonly code = 'PLATFORM_DATA_INVALID' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ContextDataError';
  }
}
