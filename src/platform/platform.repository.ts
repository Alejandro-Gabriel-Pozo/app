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

export interface Identity {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
}

export interface CreateIdentityInput {
  id: string;
  email: string;
  passwordHash: string;
}

export interface Membership {
  id: string;
  identityId: string;
  businessId: string;
  businessName: string;
  role: string;
  active: boolean;
  createdAt: Date;
}

export interface CreateMembershipInput {
  id: string;
  identityId: string;
  businessId: string;
  role: string;
}

// ---------------------------------------------------------------------------
// Repositorio
// ---------------------------------------------------------------------------

export class PlatformRepository {
  constructor(private readonly db: SqlClient) {}

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
  // Identities — "quién sos" (email + password, único en toda la plataforma)
  // -------------------------------------------------------------------------

  async findIdentityByEmail(email: string): Promise<Identity | undefined> {
    const result = await this.db.query<IdentityRow>(
      'SELECT * FROM identities WHERE email = $1',
      [email.toLowerCase()],
    );
    return result.rows[0] ? this.rowToIdentity(result.rows[0]) : undefined;
  }

  async findIdentityById(id: string): Promise<Identity | undefined> {
    const result = await this.db.query<IdentityRow>(
      'SELECT * FROM identities WHERE id = $1',
      [id],
    );
    return result.rows[0] ? this.rowToIdentity(result.rows[0]) : undefined;
  }

  async createIdentity(input: CreateIdentityInput): Promise<Identity> {
    const result = await this.db.query<IdentityRow>(
      `INSERT INTO identities (id, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [input.id, input.email.toLowerCase(), input.passwordHash],
    );
    return this.rowToIdentity(result.rows[0]!);
  }

  async updateIdentityPassword(identityId: string, passwordHash: string): Promise<void> {
    await this.db.query(
      'UPDATE identities SET password_hash = $1 WHERE id = $2',
      [passwordHash, identityId],
    );
  }

  // -------------------------------------------------------------------------
  // Memberships — "a qué negocio pertenecés y con qué rol"
  // -------------------------------------------------------------------------

  async createMembership(input: CreateMembershipInput): Promise<Membership> {
    const result = await this.db.query<MembershipJoinRow>(
      `INSERT INTO memberships (id, identity_id, business_id, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, identity_id, business_id, role, active, created_at,
         (SELECT name FROM businesses WHERE id = $3) AS business_name`,
      [input.id, input.identityId, input.businessId, input.role],
    );
    return this.rowToMembership(result.rows[0]!);
  }

  /**
   * Membresías activas de una identity, con el nombre del negocio incluido
   * (se usa para el selector de negocio cuando el login es ambiguo).
   */
  async findActiveMembershipsByIdentityId(identityId: string): Promise<Membership[]> {
    const result = await this.db.query<MembershipJoinRow>(
      `SELECT m.id, m.identity_id, m.business_id, m.role, m.active, m.created_at,
              b.name AS business_name
       FROM memberships m
       JOIN businesses b ON b.id = m.business_id
       WHERE m.identity_id = $1 AND m.active = TRUE
       ORDER BY m.created_at ASC`,
      [identityId],
    );
    return result.rows.map((r) => this.rowToMembership(r));
  }

  async findMembership(identityId: string, businessId: string): Promise<Membership | undefined> {
    const result = await this.db.query<MembershipJoinRow>(
      `SELECT m.id, m.identity_id, m.business_id, m.role, m.active, m.created_at,
              b.name AS business_name
       FROM memberships m
       JOIN businesses b ON b.id = m.business_id
       WHERE m.identity_id = $1 AND m.business_id = $2`,
      [identityId, businessId],
    );
    return result.rows[0] ? this.rowToMembership(result.rows[0]) : undefined;
  }

  /**
   * Lista las membresías (con email de la identity) de un negocio.
   * Solo para uso del ADMIN del negocio — no expone passwordHash.
   */
  async listMembershipsByBusiness(businessId: string): Promise<(Membership & { email: string })[]> {
    const result = await this.db.query<MembershipJoinRow & { email: string }>(
      `SELECT m.id, m.identity_id, m.business_id, m.role, m.active, m.created_at,
              b.name AS business_name, i.email
       FROM memberships m
       JOIN businesses b ON b.id = m.business_id
       JOIN identities i ON i.id = m.identity_id
       WHERE m.business_id = $1
       ORDER BY m.created_at ASC`,
      [businessId],
    );
    return result.rows.map((r) => ({ ...this.rowToMembership(r), email: r.email }));
  }

  /**
   * Busca una membership por ID dentro de un negocio.
   * El `businessId` actúa como guardia multi-tenant: un ADMIN
   * no puede acceder a membresías de otro negocio.
   */
  async findMembershipByIdAndBusiness(
    membershipId: string,
    businessId: string,
  ): Promise<(Membership & { email: string }) | undefined> {
    const result = await this.db.query<MembershipJoinRow & { email: string }>(
      `SELECT m.id, m.identity_id, m.business_id, m.role, m.active, m.created_at,
              b.name AS business_name, i.email
       FROM memberships m
       JOIN businesses b ON b.id = m.business_id
       JOIN identities i ON i.id = m.identity_id
       WHERE m.id = $1 AND m.business_id = $2`,
      [membershipId, businessId],
    );
    return result.rows[0] ? { ...this.rowToMembership(result.rows[0]), email: result.rows[0]!.email } : undefined;
  }

  /**
   * Actualiza el rol de una membership. El email/password viven en la
   * identity (compartidos entre negocios) y se editan aparte —
   * ver `updateIdentityPassword`.
   */
  async updateMembershipRole(membershipId: string, businessId: string, role: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE memberships SET role = $1 WHERE id = $2 AND business_id = $3`,
      [role, membershipId, businessId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Desactiva (soft-delete) una membership. No borra el registro
   * ni toca la identity — la persona puede seguir usando su cuenta
   * en otros negocios.
   */
  async deactivateMembership(membershipId: string, businessId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE memberships
       SET active = FALSE
       WHERE id = $1 AND business_id = $2 AND active = TRUE`,
      [membershipId, businessId],
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

  private rowToIdentity(row: IdentityRow): Identity {
    return {
      id: row.id,
      email: row.email,
      passwordHash: row.password_hash,
      createdAt: new Date(row.created_at),
    };
  }

  private rowToMembership(row: MembershipJoinRow): Membership {
    return {
      id: row.id,
      identityId: row.identity_id,
      businessId: row.business_id,
      businessName: row.business_name,
      role: row.role,
      active: row.active,
      createdAt: new Date(row.created_at),
    };
  }
}

// ---------------------------------------------------------------------------
// Forma cruda de las filas devueltas por `pg` (snake_case)
// ---------------------------------------------------------------------------

interface IdentityRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
}

interface MembershipJoinRow {
  id: string;
  identity_id: string;
  business_id: string;
  business_name: string;
  role: string;
  active: boolean;
  created_at: string;
}
