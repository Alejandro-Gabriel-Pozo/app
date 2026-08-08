/**
 * @file postgres-transaction-manager.ts
 * @description Alias de compatibilidad para tests de integración.
 *
 * El test reservation.service.integration.test.ts importa:
 *   import { PostgresTransactionManager } from '../../db/postgres-transaction-manager.js'
 *
 * La implementación real vive en pg.transaction-manager.ts y exporta
 * PgTransactionManager. Este módulo re-exporta bajo el nombre esperado
 * por los tests sin duplicar lógica.
 */
export { PgTransactionManager as PostgresTransactionManager } from './pg.transaction-manager.js';
