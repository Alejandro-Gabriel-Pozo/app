export type NumberSequenceEntityType = 'CUSTOMER' | 'RESERVATION';

/**
 * Número operativo de Reserva/Cliente (D6, pendientes-2026-08-22.md sección
 * D) — mecanismo único reutilizable para ambos tipos. `next()` es la única
 * operación: incrementa atómicamente `number_sequences.next_value` (A8.2/
 * A8.3, criterios-negocio.md) y devuelve el valor recién tomado.
 *
 * Se llama una sola vez, en el alta real de la entidad, ANTES de construir
 * el agregado (`Customer`/`Reservation`) — nunca desde un UPDATE. Ver
 * schema.sql (bloque "número operativo de Reserva/Cliente") para por qué
 * no es una SEQUENCE nativa de Postgres.
 *
 * Gaps aceptables: si el alta falla después de pedir el número (rollback,
 * error de validación posterior), ese número queda saltado para siempre.
 * Es el mismo criterio que docs/criterios-datos.md reserva para
 * TRANSACCIÓN/MAESTRO — la numeración "correlativa e irrompible" (nota¹,
 * PARTE 1) es una garantía exclusiva de DOCUMENTO (comprobantes AFIP), no
 * de este número de referencia humano.
 */
export interface NumberSequenceRepository {
  next(entityType: NumberSequenceEntityType): Promise<number>;
}
