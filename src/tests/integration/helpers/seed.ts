/**
 * @file src/tests/integration/helpers/seed.ts
 * @description Funciones de seed para fixtures de tests de integración.
 *
 * Cada función inserta una fila en la BD de test y devuelve el objeto
 * con todos sus campos (incluido el id generado).
 * Se usan `overrides` para personalizar campos en tests específicos.
 */

import { randomUUID } from 'node:crypto';
import type { SqlClient } from '../../../repositories/sql.client.js';

// ---------------------------------------------------------------------------
// Tipos de retorno
// ---------------------------------------------------------------------------

export interface SeededCategory {
  id: string;
  name: string;
  description: string | null;
  fields: unknown[];
  active: boolean;
}

export interface SeededResource {
  id: string;
  name: string;
  categoryId: string;
  basePrice: number;
  capacity: number;
  active: boolean;
}

export interface SeededCustomer {
  id: string;
  fullName: string;
  displayName: string;
  email: string;
}

export interface SeededUser {
  id: string;
  businessId: string;
  email: string;
  role: string;
}

export interface SeededReservation {
  id: string;
  resourceId: string;
  customerId: string;
  startTime: Date;
  endTime: Date;
  status: string;
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

export async function seedCategory(
  db: SqlClient,
  overrides: Partial<{ id: string; name: string; description: string; fields: unknown[] }> = {},
): Promise<SeededCategory> {
  const id = overrides.id ?? randomUUID();
  const name = overrides.name ?? 'Habitación';
  const description = overrides.description ?? null;
  const fields = overrides.fields ?? [];

  await db.query(
    `INSERT INTO resource_categories (id, name, description, fields)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [id, name, description, JSON.stringify(fields)],
  );
  return { id, name, description, fields, active: true };
}

export async function seedResource(
  db: SqlClient,
  categoryId: string,
  overrides: Partial<{ id: string; name: string; basePrice: number; capacity: number }> = {},
): Promise<SeededResource> {
  const id = overrides.id ?? randomUUID();
  const name = overrides.name ?? 'Habitación 101';
  const basePrice = overrides.basePrice ?? 1000;
  const capacity = overrides.capacity ?? 1;

  await db.query(
    `INSERT INTO resources (id, name, category_id, base_price, capacity)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, name, categoryId, basePrice, capacity],
  );
  return { id, name, categoryId, basePrice, capacity, active: true };
}

export async function seedCustomer(
  db: SqlClient,
  overrides: Partial<{ id: string; fullName: string; email: string }> = {},
): Promise<SeededCustomer> {
  const id = overrides.id ?? randomUUID();
  const fullName = overrides.fullName ?? 'Juan Pérez';
  const email = overrides.email ?? `test_${randomUUID()}@test.com`;
  const displayName = fullName;

  // customer_number es NOT NULL (D6, 22/08/2026) -- se resuelve acá con el
  // mismo mecanismo atómico que SqlNumberSequenceRepository.next(), en vez
  // de duplicar ese repositorio solo para el seed de tests.
  await db.query(
    `WITH n AS (
       UPDATE number_sequences SET next_value = next_value + 1
       WHERE entity_type = 'CUSTOMER'
       RETURNING next_value - 1 AS value
     )
     INSERT INTO customers (id, full_name, display_name, email, password_hash, customer_number)
     VALUES ($1, $2, $3, $4, 'hash_dummy', (SELECT value FROM n))`,
    [id, fullName, displayName, email],
  );
  return { id, fullName, displayName, email };
}

export async function seedUser(
  db: SqlClient,
  businessId: string,
  overrides: Partial<{ id: string; email: string; role: string }> = {},
): Promise<SeededUser> {
  const id = overrides.id ?? randomUUID();
  const email = overrides.email ?? `admin_${randomUUID()}@test.com`;
  const role = overrides.role ?? 'ADMIN';

  await db.query(
    `INSERT INTO users (id, business_id, full_name, email, password_hash, role)
     VALUES ($1, $2, 'Admin Test', $3, 'hash_dummy', $4)`,
    [id, businessId, email, role],
  );
  return { id, businessId, email, role };
}

export async function seedReservation(
  db: SqlClient,
  resourceId: string,
  customerId: string,
  overrides: Partial<{
    id: string;
    startTime: Date;
    endTime: Date;
    status: string;
    customerName: string;
    totalPrice: number;
  }> = {},
): Promise<SeededReservation> {
  const id = overrides.id ?? randomUUID();
  const startTime = overrides.startTime ?? new Date('2030-01-01T10:00:00Z');
  const endTime = overrides.endTime ?? new Date('2030-01-01T12:00:00Z');
  const status = overrides.status ?? 'PENDING';
  const customerName = overrides.customerName ?? 'Juan Pérez';
  const totalPrice = overrides.totalPrice ?? 1000;

  // reservation_number es NOT NULL (D6, 22/08/2026) -- mismo mecanismo
  // atómico que seedCustomer() más arriba, ver el comentario ahí.
  await db.query(
    `WITH n AS (
       UPDATE number_sequences SET next_value = next_value + 1
       WHERE entity_type = 'RESERVATION'
       RETURNING next_value - 1 AS value
     )
     INSERT INTO reservations
       (id, resource_id, customer_id, customer_name, start_time, end_time, status, total_price, reservation_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, (SELECT value FROM n))`,
    [id, resourceId, customerId, customerName, startTime, endTime, status, totalPrice],
  );
  return { id, resourceId, customerId, startTime, endTime, status };
}
