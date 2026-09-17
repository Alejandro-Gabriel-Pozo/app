/**
 * @file transaction-manager.ts
 * @description Puerto de aplicación para gestión de transacciones.
 *
 * Al definir TransactionManager como interfaz en la capa de aplicación,
 * los servicios dejan de depender de `pg.client.ts` (infraestructura).
 * La implementación concreta (PgTransactionManager) vive en src/db/
 * y se inyecta desde container.ts.
 *
 * ## Qué significa una excepción de `run()` (D-11, 17/09/2026, Wave 8 --
 * `docs/auditoria-integral-fase15-2026-09-16.md`, F8-01/C6-06)
 *
 * Si `work()` nunca llegó a ejecutarse, o se rechazó y la implementación
 * pudo revertir la transacción antes de que el error salga de acá, el
 * estado en la base de datos es el de antes de la llamada -- ese es el
 * caso común y es seguro asumirlo.
 *
 * Lo que `run()` **no** puede garantizar: si el fallo ocurre DESPUÉS de
 * que `work()` terminó y la implementación ya envió el COMMIT (p. ej. la
 * conexión se corta entre el COMMIT y su confirmación), el caller no
 * tiene forma de saber si la transacción se aplicó del lado del servidor
 * o no -- "no pasó nada" y "pasó todo" son el MISMO evento observable
 * desde acá. Por eso **todo caller que escriba un efecto no idempotente
 * (sobre todo dinero) a través de `run()` necesita una clave natural que
 * haga que un reintento del mismo caller sea seguro** -- no asumir que
 * una excepción de `run()` implica que nada se escribió. Mismo criterio
 * ya aplicado en este repo: `invoice:${financialTransactionId}` en
 * `invoice.service.ts`, y los handlers del outbox (`outbox.handlers.ts`).
 * Los callers que hoy NO tienen esa clave natural quedan registrados en
 * `docs/pendientes-2026-09-12.md` (D-10) -- este contrato es lo que
 * habilita auditarlos, no los corrige por sí solo.
 *
 * **Efecto observable en el pool de conexiones, corregido en la segunda
 * pasada del gate (17/09/2026):** una excepción de `run()` puede dejar la
 * conexión subyacente DESCARTADA del pool en vez de reusada -- pero solo
 * cuando el ROLLBACK que la implementación intenta después del error NO
 * se pudo confirmar (conexión cortada, timeout). Si el ROLLBACK se
 * confirma (el caso común), la conexión vuelve al pool normal -- no hay
 * descarte "por las dudas" en cada error de negocio corriente. Quien mire
 * métricas del pool (conexiones abiertas/descartadas) puede ver ese
 * patrón exactamente en los eventos de conexión cortada, no en cualquier
 * excepción de `run()`.
 */

import type { SqlClient } from '../repositories/sql.client.js';

export interface TransactionManager {
  run<T>(work: (client: SqlClient) => Promise<T>): Promise<T>;
}
