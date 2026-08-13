/**
 * @file location.repository.ts
 * @description Interfaz + implementación PostgreSQL del repositorio de
 * locations (sucursales). Ver el bloque LOCATIONS en src/db/schema.sql para
 * el porqué de esta entidad y su alcance actual (estructural, sin selección
 * de sucursal en el resto de la app todavía).
 */

import type { SqlClient } from './sql.client.js';

export interface Location {
  id: string;
  name: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateLocationInput {
  id: string;
  name: string;
}

export interface LocationRepository {
  findAll(): Promise<Location[]>;
  findById(id: string): Promise<Location | null>;
  create(input: CreateLocationInput): Promise<Location>;
}

interface LocationRow {
  id: string;
  name: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

function rowToLocation(row: LocationRow): Location {
  return {
    id: row.id,
    name: row.name,
    active: row.active,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class SqlLocationRepository implements LocationRepository {
  constructor(private readonly db: SqlClient) {}

  async findAll(): Promise<Location[]> {
    const result = await this.db.query<LocationRow>(
      `SELECT id, name, active, created_at, updated_at FROM locations
       WHERE active IS NOT FALSE ORDER BY created_at ASC`,
    );
    return result.rows.map(rowToLocation);
  }

  async findById(id: string): Promise<Location | null> {
    const result = await this.db.query<LocationRow>(
      `SELECT id, name, active, created_at, updated_at FROM locations WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? rowToLocation(result.rows[0]) : null;
  }

  async create(input: CreateLocationInput): Promise<Location> {
    const result = await this.db.query<LocationRow>(
      `INSERT INTO locations (id, name) VALUES ($1, $2)
       RETURNING id, name, active, created_at, updated_at`,
      [input.id, input.name],
    );
    return rowToLocation(result.rows[0]!);
  }
}
