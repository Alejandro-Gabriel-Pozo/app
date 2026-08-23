import type { SqlClient } from './sql.client.js';
import type { NumberSequenceRepository, NumberSequenceEntityType } from './number-sequence.repository.js';

export class SqlNumberSequenceRepository implements NumberSequenceRepository {
  constructor(private readonly sqlClient: SqlClient) {}

  async next(entityType: NumberSequenceEntityType): Promise<number> {
    const { rows } = await this.sqlClient.query<{ next_value: number }>(
      `UPDATE number_sequences SET next_value = next_value + 1
       WHERE entity_type = $1
       RETURNING next_value - 1 AS next_value`,
      [entityType],
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`number_sequences sin fila para '${entityType}' -- ¿se corrió schema.sql?`);
    }
    return row.next_value;
  }
}
