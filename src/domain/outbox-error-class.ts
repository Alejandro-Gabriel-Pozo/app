/**
 * @file outbox-error-class.ts
 * @description ORDER-13 / O5 (07/09/2026,
 * docs/diseno-order13-o5-dead-letter-2026-09-07.md) — clasificación de un
 * SQLSTATE de Postgres para la política de reintento del outbox. UNA fuente de
 * verdad, consumida por dos lugares con contratos distintos:
 *  - `OutboxWorker.classifyError()` — decide el `maxRetries` efectivo (permanente
 *    → 1, dead-letter en el primer intento).
 *  - `describeDeadLetter()` — decide si el mensaje al operador dice "falla
 *    temporal, reintentá" o "conflicto de datos, revisar".
 *
 * Match por PERTENENCIA A UN SET, nunca por texto del mensaje — la trampa que
 * ERPNext documenta en `repost_item_valuation.py:577-580` (clasificaba por
 * substring del traceback y se perdía "deadlock detected" de Postgres porque
 * solo conocía "Deadlock found" de MariaDB). El equivalente correcto es el
 * `isinstance(e, RecoverableErrors)` de ese mismo archivo (`:36`, `:580`).
 */

/**
 * SQLSTATE que casi siempre se resuelven solos reintentando: contención de
 * locks, caídas de conexión, timeouts. Lista estándar de Postgres.
 */
export const TRANSIENT_PG_CODES: ReadonlySet<string> = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
  '08000', '08003', '08004', '08006', '08007', // connection exceptions
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '57014', // query_canceled (statement_timeout)
]);

export type PgErrorClass = 'transient' | 'permanent' | 'other';

/**
 * @param code SQLSTATE de 5 chars (`err.code` de `pg`), sin el prefijo `PG_`.
 * - `transient`: está en `TRANSIENT_PG_CODES`.
 * - `permanent`: clase `23xxx` (integrity_constraint_violation) — reintentar
 *   nunca lo va a resolver.
 * - `other`: cualquier otro (clase 42 sintaxis/objeto inexistente, clase 22
 *   dato inválido, XX000…). En el worker hoy cae al DEFAULT transitorio (ver
 *   `classifyError`); `describeDeadLetter` lo trata como genérico, NO como
 *   "falla temporal" (governor, 07/09/2026).
 */
export function classifyPgSqlState(code: string): PgErrorClass {
  if (TRANSIENT_PG_CODES.has(code)) return 'transient';
  if (code.startsWith('23')) return 'permanent';
  return 'other';
}
