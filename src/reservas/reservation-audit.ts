/**
 * @file reservation-audit.ts
 * @description Helper compartido de auditoría de transiciones de estado de
 * `Reservation` (A6.5, `docs/criterios-negocio.md`) — graba `audit_log`
 * dentro de la MISMA transacción que el `UPDATE` de la reserva
 * (`atomic-state-mutation`: nunca un `await` suelto después del commit).
 *
 * Extraído en D-10 (`docs/decisiones-auditoria-fase2-2026-09-15.md` #8,
 * 15/09/2026) al pasar de 1 call-site a 4: hasta acá, SOLO
 * `ReservationCancelForCreditNote` (el escape con Nota de Crédito) dejaba
 * rastro de quién/cuándo cancela — el camino normal
 * (`ReservationService.confirmReservation()`/`cancelReservation()`/
 * `completeReservation()`) no auditaba nada. Mismo idiom fail-loud que
 * `OrderService.recordStatusTransition()` (`pos-menu/order.service.ts`,
 * el molde que esta función sigue) — preferible un error claro a una
 * transición sin rastro.
 *
 * Los 4 call-sites de este helper:
 *  - `ReservationService.confirmReservation()`
 *  - `ReservationService.cancelReservation()`
 *  - `ReservationService.completeReservation()`
 *  - `ReservationCancelForCreditNote.cancelForCreditNote()` (escape fiscal,
 *    ADR común cancelar-con-NC §4 capa iv) — antes armaba el mismo INSERT a
 *    mano; ahora reusa esta función en vez de duplicar la forma.
 */

import type { SqlClient } from '../repositories/sql.client.js';
import type { AuditLogRepository } from '../repositories/audit-log.repository.js';
import type { ReservationStatus } from '../types/enums.js';

export async function auditReservationTransition(
  client: SqlClient,
  auditLogRepo: Pick<AuditLogRepository, 'recordWithClient'>,
  reservationId: string,
  from: ReservationStatus,
  to: ReservationStatus,
  changedBy: string,
): Promise<void> {
  if (!auditLogRepo.recordWithClient) {
    throw new Error(
      'ReservationService requiere un AuditLogRepository con recordWithClient para auditar transiciones de reserva (A6.5).',
    );
  }
  await auditLogRepo.recordWithClient(client, [{
    entity: 'reservations', entityId: reservationId, field: 'status',
    oldValue: from, newValue: to, changedBy,
  }]);
}
