/**
 * @file platform.repository.ts
 * @description Repositorio de la BD central — gestiona negocios y usuarios de plataforma.
 *
 * Esta BD central (Supabase proyecto 1) es independiente de las BDs por negocio.
 * El `pgClient` que recibe apunta a la BD central, no a la de ningún tenant.
 *
 * ## Schema esperado
 * Ver src/db/platform.schema.sql
 */

import { SqlClient } from '../repositories/sql.client.js';
import { BusinessPlan, BusinessStatus } from '../types/enums.js';
import { UserStore, SystemUser } from '../security/user.store.js';
import { UserRole } from '../types/enums.js';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface Business {
  id: string;
  name: string;
  slug: string;
  plan: BusinessPlan;
  status: BusinessStatus;
  /** Email del dueño/admin principal del negocio */
  ownerEmail: string;
  /** ID del proyecto en Supabase */
  supabaseProjectId: string | null;
  /** Connection string cifrada con AES-256-GCM */
  dbUrlEncrypted: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateBusinessInput {
  id: string;
  name: string;
  slug: string;
  plan: BusinessPlan;
  ownerEmail: string;
}

export interface PlatformUser {
  id: string;
  email: string;
  businessId: string;
  role: string;
  passwordHash: string;
  active: boolean;
  createdAt: Date;
}

export interface CreatePlatformUserInput {
  id: string;
  email: string;
  businessId: string;
  role: string;
  passwordHash: string;
}

export interface UpdatePlatformUserInput {
  email?: string;
  role?: string;
  passwordHash?: string;
}

// ---------------------------------------------------------------------------
// Repositorio
// ---------------------------------------------------------------------------

export class PlatformRepository implements UserStore {
  constructor(private readonly db: SqlClient) {}

  // -------------------------------------------------------------------------
  // UserStore — requerido por AuthService
  // -------------------------------------------------------------------------

  /**
   * Implementa UserStore.findByEmail para que AuthService pueda usar
   * PlatformRepository directamente.
   */
  async findByEmail(email: string): Promise<SystemUser | undefined> {
    const platformUser = await this.findUserByEmail(email);
    if (!platformUser) return undefined;
    return {
      id: platformUser.id,
      email: platformUser.email,
      role: platformUser.role as UserRole,
      passwordHash: platformUser.passwordHash,
    };
  }

  // -------------------------------------------------------------------------
  // Businesses
  // -------------------------------------------------------------------------

  async createBusiness(input: CreateBusinessInput): Promise<Business> {
    const result = await this.db.query<Business>(
      `INSERT INTO businesses (id, name, slug, plan, status, owner_email)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [input.id, input.name, input.slug, input.plan, BusinessStatus.PENDING, input.ownerEmail],
    );
    return this.rowToBusiness(result.rows[0]!);
  }

  async activateBusiness(
    businessId: string,
    supabaseProjectId: string,
    dbUrlEncrypted: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE businesses
       SET status = $1, supabase_project_id = $2, db_url_encrypted = $3, updated_at = NOW()
       WHERE id = $4`,
      [BusinessStatus.ACTIVE, supabaseProjectId, dbUrlEncrypted, businessId],
    );
  }

  /**
   * Actualiza el estado de un negocio.
   * Usado por el SUPERADMIN para suspender, activar o cancelar negocios.
   */
  async updateBusinessStatus(
    businessId: string,
    status: BusinessStatus,
  ): Promise<void> {
    await this.db.query(
      `UPDATE businesses
       SET status = $1, updated_at = NOW()
       WHERE id = $2`,
      [status, businessId],
    );
  }

  async findById(id: string): Promise<Business | undefined> {
    const result = await this.db.query<Business>(
      'SELECT * FROM businesses WHERE id = $1',
      [id],
    );
    return result.rows[0] ? this.rowToBusiness(result.rows[0]) : undefined;
  }

  async findBySlug(slug: string): Promise<Business | undefined> {
    const result = await this.db.query<Business>(
      'SELECT * FROM businesses WHERE slug = $1',
      [slug],
    );
    return result.rows[0] ? this.rowToBusiness(result.rows[0]) : undefined;
  }

  async existsByEmailOrSlug(email: string, slug: string): Promise<boolean> {
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM businesses
       WHERE owner_email = $1 OR slug = $2`,
      [email, slug],
    );
    return parseInt(result.rows[0].count, 10) > 0;
  }

  /**
   * Lista todos los negocios de la plataforma.
   * Solo para uso del SUPERADMIN — no filtrar por tenant.
   */
  async listAll(): Promise<Business[]> {
    const result = await this.db.query<Business>(
      'SELECT * FROM businesses ORDER BY created_at DESC',
    );
    return result.rows.map((r) => this.rowToBusiness(r));
  }

  // -------------------------------------------------------------------------
  // Platform users — auth
  // -------------------------------------------------------------------------

  /**
   * Implementa UserStore.findByEmail para que AuthService pueda usar
   * PlatformRepository directamente.
   */
  async createPlatformUser(input: CreatePlatformUserInput): Promise<PlatformUser> {
    const result = await this.db.query<PlatformUser>(
      `INSERT INTO platform_users (id, email, business_id, role, password_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.id, input.email, input.businessId, input.role, input.passwordHash],
    );
    return this.rowToUser(result.rows[0]!);
  }

  async findUserByEmailAndBusiness(
    email: string,
    businessId: string,
  ): Promise<PlatformUser | undefined> {
    const result = await this.db.query<PlatformUser>(
      `SELECT * FROM platform_users
       WHERE email = $1 AND business_id = $2 AND active = TRUE`,
      [email.toLowerCase(), businessId],
    );
    return result.rows[0] ? this.rowToUser(result.rows[0]) : undefined;
  }

  async findUserByEmail(email: string): Promise<PlatformUser | undefined> {
    const result = await this.db.query<PlatformUser>(
      `SELECT * FROM platform_users
       WHERE email = $1 AND active = TRUE
       LIMIT 1`,
      [email.toLowerCase()],
    );
    return result.rows[0] ? this.rowToUser(result.rows[0]) : undefined;
  }

  // -------------------------------------------------------------------------
  // Platform users — gestión por ADMIN
  // -------------------------------------------------------------------------

  /**
   * Lista todos los usuarios activos e inactivos de un negocio.
   * Solo para uso del ADMIN del negocio — no expone passwordHash.
   */
  async listUsersByBusiness(businessId: string): Promise<PlatformUser[]> {
    const result = await this.db.query<PlatformUser>(
      `SELECT * FROM platform_users
       WHERE business_id = $1
       ORDER BY created_at ASC`,
      [businessId],
    );
    return result.rows.map((r) => this.rowToUser(r));
  }

  /**
   * Busca un usuario por ID dentro de un negocio.
   * El `businessId` actúa como guardia multi-tenant: un ADMIN
   * no puede acceder a usuarios de otro negocio.
   */
  async findUserByIdAndBusiness(
    userId: string,
    businessId: string,
  ): Promise<PlatformUser | undefined> {
    const result = await this.db.query<PlatformUser>(
      `SELECT * FROM platform_users
       WHERE id = $1 AND business_id = $2`,
      [userId, businessId],
    );
    return result.rows[0] ? this.rowToUser(result.rows[0]) : undefined;
  }

  /**
   * Verifica si ya existe un usuario con ese email en el negocio.
   */
  async existsUserByEmailInBusiness(
    email: string,
    businessId: string,
    excludeUserId?: string,
  ): Promise<boolean> {
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM platform_users
       WHERE email = $1 AND business_id = $2
       ${excludeUserId ? 'AND id != $3' : ''}`,
      excludeUserId
        ? [email.toLowerCase(), businessId, excludeUserId]
        : [email.toLowerCase(), businessId],
    );
    return parseInt(result.rows[0].count, 10) > 0;
  }

  /**
   * Actualiza email, rol y/o contraseña de un usuario.
   * Solo actualiza los campos presentes en el input.
   */
  async updateUser(
    userId: string,
    businessId: string,
    input: UpdatePlatformUserInput,
  ): Promise<PlatformUser | undefined> {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (input.email !== undefined) {
      setClauses.push(`email = $${idx++}`);
      values.push(input.email.toLowerCase());
    }
    if (input.role !== undefined) {
      setClauses.push(`role = $${idx++}`);
      values.push(input.role);
    }
    if (input.passwordHash !== undefined) {
      setClauses.push(`password_hash = $${idx++}`);
      values.push(input.passwordHash);
    }

    if (setClauses.length === 0) return this.findUserByIdAndBusiness(userId, businessId);

    values.push(userId, businessId);
    const result = await this.db.query<PlatformUser>(
      `UPDATE platform_users
       SET ${setClauses.join(', ')}
       WHERE id = $${idx++} AND business_id = $${idx}
       RETURNING *`,
      values,
    );
    return result.rows[0] ? this.rowToUser(result.rows[0]) : undefined;
  }

  /**
   * Desactiva (soft-delete) un usuario.
   * No borra el registro para preservar historial de reservas.
   */
  async deactivateUser(userId: string, businessId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE platform_users
       SET active = FALSE
       WHERE id = $1 AND business_id = $2 AND active = TRUE`,
      [userId, businessId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  // -------------------------------------------------------------------------
  // Mappers
  // -------------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private rowToBusiness(row: any): Business {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      plan: row.plan as BusinessPlan,
      status: row.status as BusinessStatus,
      ownerEmail: row.owner_email,
      supabaseProjectId: row.supabase_project_id ?? null,
      dbUrlEncrypted: row.db_url_encrypted ?? null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private rowToUser(row: any): PlatformUser {
    return {
      id: row.id,
      email: row.email,
      businessId: row.business_id,
      role: row.role,
      passwordHash: row.password_hash,
      active: row.active,
      createdAt: new Date(row.created_at),
    };
  }
}
