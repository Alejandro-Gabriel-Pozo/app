/**
 * @file auth.middleware.wrapper.ts
 * @description Re-exporta `authenticate` y `authorize` desde security/auth.middleware
 * para que los routers de api/routes los importen sin cruzar capas.
 *
 * Evita que api/routes importe directamente desde security/ (que es una
 * capa de infraestructura más profunda), manteniendo la separación de capas.
 */
export { authenticate, authorize } from '../../security/auth.middleware.js';
