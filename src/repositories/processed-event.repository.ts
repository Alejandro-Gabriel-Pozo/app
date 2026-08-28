/**
 * @file processed-event.repository.ts
 * @description Puerto de `processed_events` — idempotencia POR HANDLER del
 * OutboxWorker (A10.3, criterios-negocio.md). Ver el bloque
 * `processed_events` en src/db/schema.sql para el porqué completo y
 * docs/plan-separacion-dominios-multirubro-2026-08-28.md §8 (Fase 1).
 *
 * ## Qué problema resuelve, concretamente
 * El worker entrega at-least-once y corre TODOS los handlers de un evento
 * con `Promise.all`. Si uno falla, el evento entero se reintenta y los que
 * ya habían salido bien vuelven a correr. Los handlers financieros y los de
 * inventario ya se defienden solos con una clave natural propia
 * (`idempotencyKey` + ON CONFLICT; insert-then-act sobre `stock_movements`).
 * El de mail no tiene ninguna clave natural que reclamar — mandar un mail no
 * deja una fila con la que chocar — y `reservation.confirmed` tiene
 * exactamente dos consumidores: el financiero y el de mail. Esta tabla es la
 * red para ese caso.
 *
 * ## No es MAESTRO/TRANSACCIÓN/DOCUMENTO
 * docs/criterios-datos.md Parte 1: es estado interno del despachador, mismo
 * trato que `schema_migrations`. Sin código de negocio (R1), sin `deleted_at`
 * (R3), sin auditoría (R8) — nada de eso aplica a una marca de "este handler
 * ya corrió para este evento".
 */

import type { SqlClient } from './sql.client.js';

export interface ProcessedEventRepository {
  /**
   * Reclama el casillero (evento, handler) para este intento.
   *
   * Es un INSERT ... ON CONFLICT DO NOTHING, no un SELECT seguido de un
   * INSERT: la decisión y la escritura son la MISMA operación (A8.2 — dos
   * ciclos de poll solapados no pueden leer "no procesado" a la vez y correr
   * el handler dos veces).
   *
   * @returns `true` si este llamado ganó el casillero — el handler debe
   *   correr. `false` si ya estaba tomado — el handler ya corrió antes y hay
   *   que saltearlo.
   */
  claim(domainEventId: number, handlerName: string): Promise<boolean>;

  /**
   * Libera el casillero. Lo llama el worker cuando el handler que lo había
   * reclamado FALLA: sin esto, un handler que reventó quedaría marcado como
   * procesado y nunca se reintentaría, convirtiendo un fallo transitorio
   * (la BD un segundo caída) en trabajo perdido en silencio.
   */
  release(domainEventId: number, handlerName: string): Promise<void>;
}

export class SqlProcessedEventRepository implements ProcessedEventRepository {
  constructor(private readonly sqlClient: SqlClient) {}

  async claim(domainEventId: number, handlerName: string): Promise<boolean> {
    // RETURNING + rows.length, no rowCount: `rowCount` es OPCIONAL en la
    // interfaz SqlClient, y un adaptador que no lo reporte haría que
    // `(rowCount ?? 0) > 0` diera false siempre — o sea, "ya procesado" para
    // todo, saltándose TODOS los handlers en silencio. `rows` siempre viene.
    const result = await this.sqlClient.query<{ domain_event_id: string }>(
      `INSERT INTO processed_events (domain_event_id, handler_name)
       VALUES ($1, $2)
       ON CONFLICT (domain_event_id, handler_name) DO NOTHING
       RETURNING domain_event_id`,
      [domainEventId, handlerName],
    );

    // 1 fila devuelta = ganó el casillero; 0 = ya estaba tomado.
    return result.rows.length > 0;
  }

  async release(domainEventId: number, handlerName: string): Promise<void> {
    await this.sqlClient.query(
      `DELETE FROM processed_events
       WHERE domain_event_id = $1 AND handler_name = $2`,
      [domainEventId, handlerName],
    );
  }
}
