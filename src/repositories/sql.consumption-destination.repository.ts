import { randomUUID } from 'crypto';
import type { SqlClient } from './sql.client.js';
import type {
  ConsumptionDestinationRepository,
  ConsumptionDestination,
  CreateConsumptionDestinationInput,
  UpdateConsumptionDestinationInput,
} from './consumption-destination.repository.js';
import { ConsumptionDestinationNotFoundError } from '../domain/errors.js';

const RETURNING_COLS = `id, business_id, name, active, created_at, updated_at`;

function mapRow(row: Record<string, unknown>): ConsumptionDestination {
  return {
    id:         row['id'] as string,
    businessId: row['business_id'] as string,
    name:       row['name'] as string,
    active:     row['active'] as boolean,
    createdAt:  new Date(row['created_at'] as string),
    updatedAt:  new Date(row['updated_at'] as string),
  };
}

export class SqlConsumptionDestinationRepository implements ConsumptionDestinationRepository {
  constructor(private readonly db: SqlClient) {}

  async findAll(businessId: string): Promise<ConsumptionDestination[]> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT ${RETURNING_COLS} FROM consumption_destinations
       WHERE business_id = $1 AND active = TRUE
       ORDER BY name ASC`,
      [businessId],
    );
    return rows.map(mapRow);
  }

  /**
   * No filtra por active — mismo criterio que SqlWasteReasonRepository.findById()
   * (docs/criterios-datos.md R2): buscar por ID es "dame esta fila", no
   * "dame esta fila si todavía está activa".
   */
  async findById(id: string): Promise<ConsumptionDestination | null> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT ${RETURNING_COLS} FROM consumption_destinations WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async create(input: CreateConsumptionDestinationInput): Promise<ConsumptionDestination> {
    const id = randomUUID();
    const { rows } = await this.db.query<Record<string, unknown>>(
      `INSERT INTO consumption_destinations (id, business_id, name)
       VALUES ($1, $2, $3)
       RETURNING ${RETURNING_COLS}`,
      [id, input.businessId, input.name],
    );
    return mapRow(rows[0]!);
  }

  async update(id: string, input: UpdateConsumptionDestinationInput): Promise<ConsumptionDestination> {
    return this.updateWith(this.db, id, input);
  }

  async updateWithClient(client: SqlClient, id: string, input: UpdateConsumptionDestinationInput): Promise<ConsumptionDestination> {
    return this.updateWith(client, id, input);
  }

  private async updateWith(client: SqlClient, id: string, input: UpdateConsumptionDestinationInput): Promise<ConsumptionDestination> {
    const fields: string[]  = [];
    const params: unknown[] = [];
    let idx = 1;

    if (input.name   !== undefined) { fields.push(`name = $${idx++}`);   params.push(input.name); }
    if (input.active !== undefined) { fields.push(`active = $${idx++}`); params.push(input.active); }

    if (fields.length === 0) {
      const destination = await this.findById(id);
      if (!destination) throw new ConsumptionDestinationNotFoundError(id);
      return destination;
    }

    fields.push('updated_at = NOW()');
    params.push(id);

    const { rows } = await client.query<Record<string, unknown>>(
      `UPDATE consumption_destinations SET ${fields.join(', ')} WHERE id = $${idx} RETURNING ${RETURNING_COLS}`,
      params,
    );
    if (!rows[0]) throw new ConsumptionDestinationNotFoundError(id);
    return mapRow(rows[0]);
  }

  async deactivate(id: string): Promise<void> {
    await this.db.query(
      `UPDATE consumption_destinations SET active = FALSE, updated_at = NOW() WHERE id = $1`,
      [id],
    );
  }
}
