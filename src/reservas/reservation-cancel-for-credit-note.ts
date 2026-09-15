/**
 * @file reservation-cancel-for-credit-note.ts
 * @description Implementación de `ReservationCancelPort` (definido en
 * `src/facturacion/cancel-reservation-with-credit-note.service.ts`) — el
 * pedazo "cancelar la RESERVA" del escape administrativo del ADR común
 * `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` (bloque
 * 3.3-b1).
 *
 * ## Por qué vive acá y no en el orquestador (ADR §4, F5 capa iv)
 * `Reservation.cancel()` y `ReservationRepository.saveWithClient()` son del
 * dominio `reservas/`. Si el orquestador (en `src/facturacion/`) los
 * importara, cruzaría la cerca. Este archivo es el único punto donde el
 * escape toca el agregado `Reservation`; el orquestador solo conoce la
 * interfaz `ReservationCancelPort`.
 *
 * ## Diferencia estructural con el precedente de órdenes (`order-cancel-for-credit-note.ts`)
 * Órdenes usa `transitionWithClient` (un UPDATE condicional atómico, sin
 * necesidad de re-lockear). `Reservation` no tiene un primitivo equivalente:
 * `ReservationRepository.saveWithClient()` PISA el agregado entero desde el
 * objeto en memoria. Por eso este adaptador tiene que:
 *  1. Re-lockear la fila DENTRO de esta tx (`getByIdWithLock`) -- el lock de
 *     tx1 del orquestador ya se soltó en su commit;
 *  2. Chequear el estado ANTES de mutar (no cazar la excepción de
 *     `Reservation.cancel()`, que es genérica e indistinguible de un estado
 *     realmente no elegible);
 *  3. Recién ahí mutar el objeto YA LOCKEADO (no el que el orquestador leyó
 *     en tx1 -- ese es una instancia vieja, de otra transacción) y
 *     persistirlo con `saveWithClient()`.
 *
 * ## Auditoría (A6.5) -- D-10 (15/09/2026, decisiones-auditoria-fase2, #8)
 * Hasta el 15/09/2026 este adaptador era el ÚNICO lugar que escribía
 * `audit_log` para una transición de `Reservation` -- `cancelReservation()`
 * del camino normal no auditaba nada (asimetría cerrada por D-10, ver
 * `reservation.service.ts`). Ahora los 4 call-sites (los 3 del camino
 * normal + este) comparten `auditReservationTransition()`
 * (`reservation-audit.ts`) -- lo que sigue siendo propio de ESTE adaptador
 * es el `changedBy`: acá es quien autorizó la Nota de Crédito (override
 * administrativo con autor nombrado), no el sistema ni quien pidió el
 * cambio por el camino normal.
 *
 * ## Qué NO hace (a diferencia de `cancelReservation()`)
 *  - **No** llama a `findBlockingInvoiceLinkage()`: la factura viva es
 *    justamente la que la Nota de Crédito ya compensó -- bloquear acá sería
 *    el bug (mismo criterio que el adaptador de órdenes).
 *  - **No** abre su propia `transactionManager.run()`: corre dentro de tx2
 *    del orquestador (transición + settle del ADJUSTMENT + settle de los
 *    cargos son una sola unidad atómica, N1.a).
 *
 * ## Costo declarado (mismo residual #3 que órdenes, se salda en 3.3-d)
 * `handleReservationCancelled` → `registrarDesenlace()` va a ver cargo(s)
 * con comprobante fiscal vinculado y los escala a `grave`
 * (`CARGO_CON_COMPROBANTE_VIVO`) por cada escape, hasta que `3.3-d`
 * (`classifyReservationLiveInvoice()`) le enseñe a reconocerlos como ya
 * compensados. Registrado en `docs/pendientes-2026-09-08.md` §6.6.
 */

import type { SqlClient } from '../repositories/sql.client.js';
import type { DomainEventRepository } from '../repositories/domain-event.repository.js';
import type { AuditLogRepository } from '../repositories/audit-log.repository.js';
import type { ReservationRepository } from './reservation.repository.js';
import type { ReservationCancelPort, ReservationCancelOutcome } from '../facturacion/cancel-reservation-with-credit-note.service.js';
import { ReservationStatus } from '../types/enums.js';
import { auditReservationTransition } from './reservation-audit.js';

export class ReservationCancelForCreditNote implements ReservationCancelPort {
  constructor(
    private readonly reservationRepo: Pick<ReservationRepository, 'getByIdWithLock' | 'saveWithClient'>,
    private readonly domainEventRepository: Pick<DomainEventRepository, 'insertWithClient'>,
    private readonly auditLogRepo: Pick<AuditLogRepository, 'recordWithClient'>,
  ) {}

  async cancelForCreditNote(
    client: SqlClient,
    reservationId: string,
    businessId: string,
    changedBy: string,
  ): Promise<ReservationCancelOutcome> {
    // Re-lock DENTRO de tx2 -- el lock de tx1 del orquestador ya se soltó
    // en su commit; sin este `getByIdWithLock` propio, la mutación de abajo
    // correría sobre una lectura no serializada.
    //
    // Llamado como MÉTODO (`repo.getByIdWithLock(...)`), nunca como función
    // desacoplada -- `SqlReservationRepository.getByIdWithLock` usa `this`
    // internamente (`this.baseSelect()`, `this.resourceRepository`);
    // extraerlo a una const suelta y volver a invocarlo pierde el binding y
    // revienta en runtime contra Postgres real (encontrado corriendo la
    // integración de este mismo bloque, 09/09/2026).
    const repo = this.reservationRepo;
    if (!repo.getByIdWithLock) {
      throw new Error(
        'ReservationCancelForCreditNote requiere un ReservationRepository con getByIdWithLock -- sin lock, la mutación del escape no está serializada (RESERVA-10).',
      );
    }
    const reservation = await repo.getByIdWithLock(client, reservationId);
    if (!reservation) return { resultado: 'NO_EXISTE' };

    if (reservation.status === ReservationStatus.CANCELLED) {
      // Idempotente por CHEQUEO DE ESTADO -- no re-audita, no re-emite.
      return { resultado: 'YA_ESTABA', reservation };
    }
    if (reservation.status !== ReservationStatus.PENDING && reservation.status !== ReservationStatus.CONFIRMED) {
      // COMPLETED / EXPIRED -- terminal, no admite CANCELLED.
      return { resultado: 'NO_ELEGIBLE', reservation };
    }

    const previousStatus = reservation.status;
    reservation.cancel(); // muta en memoria la instancia YA LOCKEADA de esta tx

    await this.reservationRepo.saveWithClient(client, reservation);

    await auditReservationTransition(
      client, this.auditLogRepo, reservation.id, previousStatus, ReservationStatus.CANCELLED, changedBy,
    );

    await this.domainEventRepository.insertWithClient(client, {
      businessId,
      aggregateType: 'RESERVATION',
      aggregateId: reservation.id,
      eventType: 'reservation.cancelled',
      payload: {
        reservationId: reservation.id,
        customerId: reservation.customer.id,
        resourceId: reservation.resource.id,
        cancelledAt: new Date().toISOString(),
      },
    });

    return { resultado: 'CAMBIO', reservation, previousStatus };
  }
}
