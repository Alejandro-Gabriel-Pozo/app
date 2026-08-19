/**
 * @file sql.category.repository.ts
 * @description Implementación PostgreSQL del repositorio de categorías.
 * Usa SqlClient (interfaz genérica) en lugar del Pool de pg directamente.
 *
 * ## Cambios
 * - findById() YA NO filtra por active (docs/criterios-datos.md R2: "buscar
 *   por ID nunca filtra por estado"). Antes filtraba active = TRUE, lo que
 *   volvía invisible cualquier categoría desactivada — el bug de categorías
 *   fantasma del 13/08/2026: un recurso apuntando a una categoría pausada
 *   quedaba con una referencia que ningún código podía resolver. El chequeo
 *   de "¿está disponible para algo nuevo?" ahora es explícito en el caller
 *   (resources.routes.ts), no un efecto secundario de este método.
 * - findAll()/countActive() excluyen deleted_at IS NOT NULL además de
 *   active = TRUE — esos sí son listados/conteos, ahí el filtro corresponde.
 * - update() lanza CategoryNotFoundError (tipado) en vez de Error genérico
 *   para que el instanceof en categories.routes.ts lo capture como 404.
 * - create() y update() usan columnas explícitas en RETURNING en lugar
 *   de RETURNING * para no filtrar columnas futuras sin procesar.
 */

import type { SqlClient } from '../repositories/sql.client.js';
import type { ICategoryRepository } from './category.repository.js';
import type {
  ResourceCategory,
  CreateCategoryDTO,
  UpdateCategoryDTO,
  CategoryField,
} from './resource-category.types.js';
import { CategoryNotFoundError } from '../domain/errors.js';

const RETURNING_COLS = `
  id, name, description, fields, active, is_lodging, created_at, updated_at
`;

function mapRow(row: Record<string, unknown>): ResourceCategory {
  const description = row['description'] as string | undefined;
  return {
    id:        row['id'] as string,
    name:      row['name'] as string,
    ...(description !== undefined && { description }),
    fields:    (row['fields'] as CategoryField[]) ?? [],
    active:    row['active'] as boolean,
    isLodging: row['is_lodging'] as boolean,
    createdAt: new Date(row['created_at'] as string),
    updatedAt: new Date(row['updated_at'] as string),
  };
}

export class SqlCategoryRepository implements ICategoryRepository {
  constructor(private readonly sqlClient: SqlClient) {}

  async findAll(): Promise<ResourceCategory[]> {
    const result = await this.sqlClient.query(
      `SELECT ${RETURNING_COLS}
       FROM resource_categories
       WHERE active = TRUE AND deleted_at IS NULL
       ORDER BY created_at ASC`,
    );
    return (result.rows as Record<string, unknown>[]).map(mapRow);
  }

  /**
   * Retorna null solo si la fila no existe. NO filtra por active/deleted_at
   * — ver docs/criterios-datos.md R2. Buscar por ID es "dame esta fila",
   * no "dame esta fila si todavía me gusta". El caller decide qué hacer
   * con una categoría pausada o borrada (ej. resources.routes.ts la
   * rechaza explícitamente para altas nuevas).
   */
  async findById(id: string): Promise<ResourceCategory | null> {
    const result = await this.sqlClient.query(
      `SELECT ${RETURNING_COLS}
       FROM resource_categories
       WHERE id = $1`,
      [id],
    );
    const rows = result.rows as Record<string, unknown>[];
    return rows.length ? mapRow(rows[0] ?? {}) : null;
  }

  async countActive(): Promise<number> {
    const result = await this.sqlClient.query(
      `SELECT COUNT(*)::int AS total FROM resource_categories WHERE active = TRUE AND deleted_at IS NULL`,
    );
    const rows = result.rows as Array<{ total: number }>;
    return rows[0]?.total ?? 0;
  }

  async create(dto: CreateCategoryDTO): Promise<ResourceCategory> {
    const result = await this.sqlClient.query(
      `INSERT INTO resource_categories (id, name, description, fields, is_lodging)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${RETURNING_COLS}`,
      [dto.id, dto.name, dto.description ?? null, JSON.stringify(dto.fields ?? []), dto.isLodging ?? false],
    );
    const rows = result.rows as Record<string, unknown>[];
    return mapRow(rows[0] ?? {});
  }

  async update(id: string, dto: UpdateCategoryDTO): Promise<ResourceCategory> {
    const setClauses: string[] = [];
    const values: unknown[]    = [];
    let idx = 1;

    if (dto.name        !== undefined) { setClauses.push(`name = $${idx++}`);        values.push(dto.name); }
    if (dto.description !== undefined) { setClauses.push(`description = $${idx++}`); values.push(dto.description); }
    if (dto.fields      !== undefined) { setClauses.push(`fields = $${idx++}`);      values.push(JSON.stringify(dto.fields)); }
    if (dto.active      !== undefined) { setClauses.push(`active = $${idx++}`);      values.push(dto.active); }
    if (dto.isLodging   !== undefined) { setClauses.push(`is_lodging = $${idx++}`);  values.push(dto.isLodging); }

    if (setClauses.length === 0) {
      const cat = await this.findById(id);
      if (!cat) throw new CategoryNotFoundError(id);
      return cat;
    }

    values.push(id);
    // Sin "AND active = TRUE": editar (o reactivar, vía dto.active = true)
    // una categoría pausada tiene que funcionar — antes quedaba atrapada
    // como "no encontrada" en cuanto se desactivaba, sin forma de arreglarla
    // salvo escribiendo SQL a mano.
    const result = await this.sqlClient.query(
      `UPDATE resource_categories
       SET ${setClauses.join(', ')}
       WHERE id = $${idx}
       RETURNING ${RETURNING_COLS}`,
      values,
    );
    const rows = result.rows as Record<string, unknown>[];
    if (!rows.length) throw new CategoryNotFoundError(id);
    return mapRow(rows[0] ?? {});
  }

  async deactivate(id: string): Promise<void> {
    await this.sqlClient.query(
      `UPDATE resource_categories SET active = FALSE WHERE id = $1`,
      [id],
    );
  }
}
