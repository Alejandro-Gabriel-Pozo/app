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

import type { SqlClient } from '../repositories/sql.client.js';
import type { BusinessPlan} from '../types/enums.js';
import { BusinessStatus, ModuleKey } from '../types/enums.js';
import type { PlanLimits } from '../config/plan-limits.js';

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
  /** Versión de schema.sql aplicada en la tenant DB — null = nunca aplicada vía applyTenantSchema() */
  schemaVersion: number | null;
  /**
   * Empresas multipropiedad (17/08/2026, docs/diseno-empresas-
   * multipropiedad.md) — null = negocio independiente, sin cambios de
   * comportamiento (la enorme mayoría de los tenants hoy).
   */
  companyId: string | null;
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
  /** Login con Google (punto 5/E5) — null hasta que se vincule. */
  googleSub: string | null;
  /** F2 (23/08/2026) — datos de la persona, no del empleo (ver `Membership.employeeNumber`/`hiredAt`). Null hasta que un admin los carga. */
  fullName: string | null;
  dni: string | null;
  phone: string | null;
  createdAt: Date;
}

export interface CreateIdentityInput {
  id: string;
  email: string;
  passwordHash: string;
  fullName?: string | null | undefined;
  dni?: string | null | undefined;
  phone?: string | null | undefined;
}

export interface UpdateIdentityProfileInput {
  fullName?: string | null | undefined;
  dni?: string | null | undefined;
  phone?: string | null | undefined;
}

export interface Membership {
  id: string;
  identityId: string;
  businessId: string;
  businessName: string;
  /** FK a roles.id — fuente de permisos (14/08/2026, ver security/roles.ts) */
  roleId: string;
  /** Nombre del rol (roles.name), solo para mostrar — no se usa para autorizar */
  roleName: string;
  active: boolean;
  /** F2 (23/08/2026) — del EMPLEO en este negocio, no de la persona (ver `Identity.fullName`/`dni`/`phone`). Null hasta que un admin los carga. */
  employeeNumber: string | null;
  hiredAt: Date | null;
  createdAt: Date;
}

export interface CreateMembershipInput {
  id: string;
  identityId: string;
  businessId: string;
  roleId: string;
  employeeNumber?: string | null | undefined;
  hiredAt?: Date | null | undefined;
}

export interface UpdateMembershipEmploymentInput {
  employeeNumber?: string | null | undefined;
  hiredAt?: Date | null | undefined;
}

/** F2 (23/08/2026) — membership + los datos de la identity que ABM/usuarios necesita mostrar (nunca passwordHash). */
export interface MembershipWithIdentity extends Membership {
  email: string;
  fullName: string | null;
  dni: string | null;
  phone: string | null;
}

// ---------------------------------------------------------------------------
// Roles — entidad configurable que reemplaza el enum hardcodeado de rol
// (14/08/2026, Gap analysis - Tango ERP vs modelo actual.md #2)
// ---------------------------------------------------------------------------

export interface Role {
  id: string;
  businessId: string;
  name: string;
  /** Uno de los 5 roles seedeados al crear el negocio — no se puede desactivar */
  isSystem: boolean;
  active: boolean;
  permissionGroups: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateRoleInput {
  id: string;
  businessId: string;
  name: string;
  permissionGroups: string[];
}

/** Resultado combinado para el hook de authenticate() — ver auth.middleware.ts */
export interface MembershipContext {
  active: boolean;
  roleId: string;
  permissionGroups: string[];
}

// ---------------------------------------------------------------------------
// Invitaciones — D2, pendientes-2026-08-19.md. Ver BLOQUE INVITACIONES en
// platform.schema.sql para la clasificación (TRANSACCIÓN) y el
// razonamiento completo.
// ---------------------------------------------------------------------------

export type UserInvitationStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED';

export interface UserInvitation {
  id: string;
  businessId: string;
  businessName: string;
  email: string;
  roleId: string;
  roleName: string;
  status: UserInvitationStatus;
  invitedByIdentityId: string;
  acceptedIdentityId: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface CreateUserInvitationInput {
  id: string;
  businessId: string;
  email: string;
  roleId: string;
  tokenHash: string;
  invitedByIdentityId: string;
  expiresAt: Date;
}

// ---------------------------------------------------------------------------
// Reseteo de contraseña — K1, 23/08/2026, pendientes-2026-08-23.md. Ver
// BLOQUE RESETEO DE CONTRASEÑA en platform.schema.sql para la clasificación
// y el razonamiento completo (mismo criterio que UserInvitation de arriba).
// ---------------------------------------------------------------------------

export type PasswordResetTokenStatus = 'PENDING' | 'USED';

export interface PasswordResetToken {
  id: string;
  identityId: string;
  /** Email de la identity objetivo — join, para el preview del lookup público. */
  identityEmail: string;
  requestedByIdentityId: string;
  businessId: string;
  status: PasswordResetTokenStatus;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface UpsertPasswordResetTokenInput {
  id: string;
  identityId: string;
  requestedByIdentityId: string;
  businessId: string;
  tokenHash: string;
  expiresAt: Date;
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
    const business = this.rowToBusiness(result.rows[0]!);
    await this.provisionDefaultModules(business.id);
    await this.provisionSystemRoles(business.id);
    return business;
  }

  /**
   * Inserta los roles "sistema" (OWNER/ADMIN/RECEPTIONIST/HOUSEKEEPING/
   * WAITER) leyendo el preset de cada uno desde `role_presets`/
   * `role_preset_permission_groups` — mismo criterio y mismo motivo que
   * provisionDefaultModules(): vive DENTRO de createBusiness() para que
   * sea imposible que un caller nuevo se olvide de provisionarlos.
   *
   * Hasta el 18/08/2026 esto era un array TS hardcodeado acá, duplicado a
   * mano contra el UNION ALL de platform.schema.sql (mismo dato, dos
   * lugares). Ahora role_presets es la única fuente — ver el comentario
   * de esa tabla en platform.schema.sql. Los negocios que ya existían
   * antes de que role_presets existiera se migran aparte en el backfill
   * de ese mismo archivo (BLOQUE ROLES).
   */
  private async provisionSystemRoles(businessId: string): Promise<void> {
    const presets = await this.db.query<{ name: string; permission_group: string | null }>(
      `SELECT rp.name, rppg.permission_group
       FROM role_presets rp
       LEFT JOIN role_preset_permission_groups rppg ON rppg.preset_name = rp.name`,
    );

    const groupsByPreset = new Map<string, string[]>();
    for (const { name, permission_group: group } of presets.rows) {
      if (!groupsByPreset.has(name)) groupsByPreset.set(name, []);
      if (group) groupsByPreset.get(name)!.push(group);
    }

    for (const [name, groups] of groupsByPreset) {
      const roleId = `role-${businessId}-${name.toLowerCase()}`;
      await this.db.query(
        `INSERT INTO roles (id, business_id, name, is_system)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (business_id, name) DO NOTHING`,
        [roleId, businessId, name],
      );
      for (const group of groups) {
        await this.db.query(
          `INSERT INTO role_permission_groups (role_id, permission_group)
           VALUES ($1, $2)
           ON CONFLICT (role_id, permission_group) DO NOTHING`,
          [roleId, group],
        );
      }
    }
  }

  /**
   * Inserta una fila en business_modules por cada módulo del catálogo.
   * Vive DENTRO de createBusiness (no en cada caller del endpoint de
   * registro) a propósito: getBusinessModules es fail-closed, así que un
   * negocio sin estas filas queda sin ningún módulo. Poniéndolo acá es
   * imposible que un caller nuevo se olvide de provisionar.
   *
   * Default: solo ALOJAMIENTO habilitado — el resto arranca deshabilitado
   * hasta que exista una pantalla de selección/pago por módulo (decisión
   * de producto, agosto 2026). Antes de esta tabla, todo estaba disponible
   * gratis para todos; los negocios que ya existían se migran aparte con
   * TODO habilitado (ver backfill en platform.schema.sql) para no cortarles
   * nada de un día para el otro.
   */
  private async provisionDefaultModules(businessId: string): Promise<void> {
    const catalog = await this.db.query<{ module_key: string }>(
      `SELECT module_key FROM modules`,
    );
    for (const { module_key: moduleKey } of catalog.rows) {
      const enabled = moduleKey === ModuleKey.ALOJAMIENTO;
      await this.db.query(
        `INSERT INTO business_modules (business_id, module_key, enabled)
         VALUES ($1, $2, $3)
         ON CONFLICT (business_id, module_key) DO NOTHING`,
        [businessId, moduleKey, enabled],
      );
    }
  }

  /**
   * Entitlements del negocio, FAIL-CLOSED: un module_key del catálogo que
   * no tenga fila en business_modules se devuelve como `false`, nunca
   * `true`. Así, si se agrega un módulo nuevo al catálogo después, no
   * queda gratis por accidente para negocios que nunca lo pidieron — ver
   * el bloque ENTITLEMENTS en platform.schema.sql.
   */
  async getBusinessModules(businessId: string): Promise<Record<string, boolean>> {
    const [catalog, entitlements] = await Promise.all([
      this.db.query<{ module_key: string }>(`SELECT module_key FROM modules`),
      this.db.query<{ module_key: string; enabled: boolean }>(
        `SELECT module_key, enabled FROM business_modules WHERE business_id = $1`,
        [businessId],
      ),
    ]);

    const enabledByKey = new Map(
      entitlements.rows.map(row => [row.module_key, row.enabled]),
    );

    const modules: Record<string, boolean> = {};
    for (const { module_key: moduleKey } of catalog.rows) {
      modules[moduleKey] = enabledByKey.get(moduleKey) ?? false;
    }
    return modules;
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
   * Registra la versión de schema.sql aplicada en la tenant DB de este
   * negocio. Llamada por applyTenantSchema() (tenant-db.setup.ts) después
   * de correr el schema, y por src/scripts/migrate-tenants.ts para el
   * backfill masivo. Ver columna businesses.schema_version.
   */
  async updateSchemaVersion(businessId: string, version: number): Promise<void> {
    await this.db.query(
      `UPDATE businesses SET schema_version = $1, updated_at = NOW() WHERE id = $2`,
      [version, businessId],
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

  /**
   * Empresas multipropiedad (17/08/2026) — todas las sucursales de una
   * misma company, para que el worker de propagación sepa a quién
   * avisarle un cambio de catálogo canónico. No filtra por status: una
   * sucursal SUSPENDED igual debería recibir la sincronización cuando
   * vuelva a estar ACTIVE, no perderla en silencio.
   */
  async findBusinessesByCompanyId(companyId: string): Promise<Business[]> {
    const result = await this.db.query<Business>(
      'SELECT * FROM businesses WHERE company_id = $1',
      [companyId],
    );
    return result.rows.map((row) => this.rowToBusiness(row));
  }

  /** Vincula (o desvincula, con `companyId = null`) un negocio a una empresa. */
  async linkBusinessToCompany(businessId: string, companyId: string | null): Promise<void> {
    await this.db.query(
      'UPDATE businesses SET company_id = $1, updated_at = NOW() WHERE id = $2',
      [companyId, businessId],
    );
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
  // Plan limits — límites de uso por plan (18/08/2026, deuda estructural,
  // reemplaza la constante TS `PLAN_LIMITS` — ver platform.schema.sql
  // BLOQUE PLAN_LIMITS para el diseño completo).
  // -------------------------------------------------------------------------

  /**
   * `undefined` si el plan no tiene fila en `plan_limits` — el caller
   * (AppContainer.getPlanLimits, container.ts) lo trata como config de
   * plataforma faltante y lanza, mismo contrato de error que
   * getBusinessPlan/getBusinessModules ante un negocio inexistente (fail
   * fast en vez de devolver un límite por default en silencio).
   *
   * `NULL` en las columnas numéricas = sin límite → se mapea a `Infinity`
   * acá para que el resto del código (PlanLimitError, comparaciones
   * `current >= limit`) no tenga que conocer el detalle de la columna.
   * 0 filas en `plan_limit_allowed_roles` para el plan = sin restricción
   * de roles → se mapea a `'ALL'`.
   */
  async getPlanLimits(plan: BusinessPlan): Promise<PlanLimits | undefined> {
    const limitsResult = await this.db.query<{
      max_categories: number | null;
      max_resources: number | null;
      max_active_memberships: number | null;
    }>(
      `SELECT max_categories, max_resources, max_active_memberships
       FROM plan_limits WHERE plan = $1`,
      [plan],
    );
    const row = limitsResult.rows[0];
    if (!row) return undefined;

    const rolesResult = await this.db.query<{ role_name: string }>(
      `SELECT role_name FROM plan_limit_allowed_roles WHERE plan = $1`,
      [plan],
    );

    return {
      maxCategories: row.max_categories ?? Infinity,
      maxResources: row.max_resources ?? Infinity,
      maxActiveMemberships: row.max_active_memberships ?? Infinity,
      allowedRoleNames: rolesResult.rows.length > 0
        ? rolesResult.rows.map((r) => r.role_name)
        : 'ALL',
    };
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

  /**
   * Login con Google — matchear primero por `sub` (estable de por vida),
   * ver docblock de la columna en platform.schema.sql para el porqué.
   */
  async findIdentityByGoogleSub(sub: string): Promise<Identity | undefined> {
    const result = await this.db.query<IdentityRow>(
      'SELECT * FROM identities WHERE google_sub = $1',
      [sub],
    );
    return result.rows[0] ? this.rowToIdentity(result.rows[0]) : undefined;
  }

  /** Primer login con Google de una identity existente — vincula el `sub`. */
  async linkGoogleAccount(identityId: string, sub: string): Promise<void> {
    await this.db.query(
      'UPDATE identities SET google_sub = $1, updated_at = NOW() WHERE id = $2',
      [sub, identityId],
    );
  }

  async createIdentity(input: CreateIdentityInput): Promise<Identity> {
    const result = await this.db.query<IdentityRow>(
      `INSERT INTO identities (id, email, password_hash, full_name, dni, phone)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [input.id, input.email.toLowerCase(), input.passwordHash, input.fullName ?? null, input.dni ?? null, input.phone ?? null],
    );
    return this.rowToIdentity(result.rows[0]!);
  }

  async updateIdentityPassword(identityId: string, passwordHash: string): Promise<void> {
    await this.db.query(
      'UPDATE identities SET password_hash = $1 WHERE id = $2',
      [passwordHash, identityId],
    );
  }

  /** F2 (23/08/2026) — solo los campos que se pasan explícitamente se tocan (mismo criterio que UpdateUserBodySchema en users.routes.ts). */
  async updateIdentityProfile(identityId: string, input: UpdateIdentityProfileInput): Promise<void> {
    if (input.fullName !== undefined) {
      await this.db.query('UPDATE identities SET full_name = $1, updated_at = NOW() WHERE id = $2', [input.fullName, identityId]);
    }
    if (input.dni !== undefined) {
      await this.db.query('UPDATE identities SET dni = $1, updated_at = NOW() WHERE id = $2', [input.dni, identityId]);
    }
    if (input.phone !== undefined) {
      await this.db.query('UPDATE identities SET phone = $1, updated_at = NOW() WHERE id = $2', [input.phone, identityId]);
    }
  }

  // -------------------------------------------------------------------------
  // Memberships — "a qué negocio pertenecés y con qué rol"
  // -------------------------------------------------------------------------

  async createMembership(input: CreateMembershipInput): Promise<Membership> {
    const result = await this.db.query<MembershipJoinRow>(
      `INSERT INTO memberships (id, identity_id, business_id, role_id, employee_number, hired_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, identity_id, business_id, role_id, active, employee_number, hired_at, created_at,
         (SELECT name FROM businesses WHERE id = $3) AS business_name,
         (SELECT name FROM roles WHERE id = $4) AS role_name`,
      [input.id, input.identityId, input.businessId, input.roleId, input.employeeNumber ?? null, input.hiredAt ?? null],
    );
    return this.rowToMembership(result.rows[0]!);
  }

  /** F2 (23/08/2026) — legajo/fecha de ingreso son del empleo, no de la persona (ver `updateIdentityProfile`). */
  async updateMembershipEmployment(membershipId: string, input: UpdateMembershipEmploymentInput): Promise<void> {
    if (input.employeeNumber !== undefined) {
      await this.db.query('UPDATE memberships SET employee_number = $1, updated_at = NOW() WHERE id = $2', [input.employeeNumber, membershipId]);
    }
    if (input.hiredAt !== undefined) {
      await this.db.query('UPDATE memberships SET hired_at = $1, updated_at = NOW() WHERE id = $2', [input.hiredAt, membershipId]);
    }
  }

  /**
   * Membresías activas de una identity, con el nombre del negocio incluido
   * (se usa para el selector de negocio cuando el login es ambiguo).
   */
  async findActiveMembershipsByIdentityId(identityId: string): Promise<Membership[]> {
    const result = await this.db.query<MembershipJoinRow>(
      `SELECT m.id, m.identity_id, m.business_id, m.role_id, m.active, m.employee_number, m.hired_at, m.created_at,
              b.name AS business_name, r.name AS role_name
       FROM memberships m
       JOIN businesses b ON b.id = m.business_id
       JOIN roles r ON r.id = m.role_id
       WHERE m.identity_id = $1 AND m.active = TRUE
       ORDER BY m.created_at ASC`,
      [identityId],
    );
    return result.rows.map((r) => this.rowToMembership(r));
  }

  async findMembership(identityId: string, businessId: string): Promise<Membership | undefined> {
    const result = await this.db.query<MembershipJoinRow>(
      `SELECT m.id, m.identity_id, m.business_id, m.role_id, m.active, m.employee_number, m.hired_at, m.created_at,
              b.name AS business_name, r.name AS role_name
       FROM memberships m
       JOIN businesses b ON b.id = m.business_id
       JOIN roles r ON r.id = m.role_id
       WHERE m.identity_id = $1 AND m.business_id = $2`,
      [identityId, businessId],
    );
    return result.rows[0] ? this.rowToMembership(result.rows[0]) : undefined;
  }

  /**
   * Contexto de autorización para authenticate() — reemplaza al viejo
   * isMembershipActive() (14/08/2026). LEFT JOIN a role_permission_groups
   * a propósito: un rol recién creado sin ningún grupo asignado todavía
   * debe resolver `permissionGroups: []`, no "membership no encontrada".
   */
  async getMembershipContext(identityId: string, businessId: string): Promise<MembershipContext | null> {
    const result = await this.db.query<{ active: boolean; role_id: string; permission_groups: string[] }>(
      `SELECT m.active, m.role_id,
              COALESCE(ARRAY_AGG(rpg.permission_group) FILTER (WHERE rpg.permission_group IS NOT NULL), ARRAY[]::text[]) AS permission_groups
       FROM memberships m
       LEFT JOIN role_permission_groups rpg ON rpg.role_id = m.role_id
       WHERE m.identity_id = $1 AND m.business_id = $2
       GROUP BY m.active, m.role_id`,
      [identityId, businessId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { active: row.active, roleId: row.role_id, permissionGroups: row.permission_groups };
  }

  /**
   * Lista las membresías (con email de la identity) de un negocio.
   * Solo para uso del ADMIN del negocio — no expone passwordHash.
   */
  async listMembershipsByBusiness(businessId: string): Promise<MembershipWithIdentity[]> {
    const result = await this.db.query<MembershipJoinRow & IdentityProfileColumns>(
      `SELECT m.id, m.identity_id, m.business_id, m.role_id, m.active, m.employee_number, m.hired_at, m.created_at,
              b.name AS business_name, r.name AS role_name, i.email, i.full_name, i.dni, i.phone
       FROM memberships m
       JOIN businesses b ON b.id = m.business_id
       JOIN roles r ON r.id = m.role_id
       JOIN identities i ON i.id = m.identity_id
       WHERE m.business_id = $1
       ORDER BY m.created_at ASC`,
      [businessId],
    );
    return result.rows.map((r) => this.rowToMembershipWithIdentity(r));
  }

  /**
   * Busca una membership por ID dentro de un negocio.
   * El `businessId` actúa como guardia multi-tenant: un ADMIN
   * no puede acceder a membresías de otro negocio.
   */
  async findMembershipByIdAndBusiness(
    membershipId: string,
    businessId: string,
  ): Promise<MembershipWithIdentity | undefined> {
    const result = await this.db.query<MembershipJoinRow & IdentityProfileColumns>(
      `SELECT m.id, m.identity_id, m.business_id, m.role_id, m.active, m.employee_number, m.hired_at, m.created_at,
              b.name AS business_name, r.name AS role_name, i.email, i.full_name, i.dni, i.phone
       FROM memberships m
       JOIN businesses b ON b.id = m.business_id
       JOIN roles r ON r.id = m.role_id
       JOIN identities i ON i.id = m.identity_id
       WHERE m.id = $1 AND m.business_id = $2`,
      [membershipId, businessId],
    );
    return result.rows[0] ? this.rowToMembershipWithIdentity(result.rows[0]) : undefined;
  }

  /**
   * Actualiza el rol de una membership (ahora vía roleId, no un string de
   * enum). El email/password viven en la identity (compartidos entre
   * negocios) y se editan aparte — ver `updateIdentityPassword`.
   */
  async updateMembershipRole(membershipId: string, businessId: string, roleId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE memberships SET role_id = $1 WHERE id = $2 AND business_id = $3`,
      [roleId, membershipId, businessId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Cuenta las membresías activas de un negocio que NO sean OWNER --
   * límite de asientos por plan (17/08/2026, F2, pendientes-2026-08-17.md).
   * El OWNER es estructural (existe siempre, se crea al registrar el
   * negocio, nunca vía POST /users) y no ocupa "asiento" a los fines de
   * este límite -- lo que el plan limita es cuánto STAFF adicional podés
   * sumar, no si el negocio puede existir con su dueño.
   */
  async countActiveStaffMembershipsByBusiness(businessId: string): Promise<number> {
    const result = await this.db.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
       FROM memberships m
       JOIN roles r ON r.id = m.role_id
       WHERE m.business_id = $1 AND m.active = TRUE AND r.name != 'OWNER'`,
      [businessId],
    );
    return result.rows[0]?.total ?? 0;
  }

  // -------------------------------------------------------------------------
  // Roles — CRUD de la entidad configurable (14/08/2026)
  // -------------------------------------------------------------------------

  async listRolesByBusiness(businessId: string): Promise<Role[]> {
    const result = await this.db.query<RoleJoinRow>(
      `SELECT r.id, r.business_id, r.name, r.is_system, r.active, r.created_at, r.updated_at,
              COALESCE(ARRAY_AGG(rpg.permission_group) FILTER (WHERE rpg.permission_group IS NOT NULL), ARRAY[]::text[]) AS permission_groups
       FROM roles r
       LEFT JOIN role_permission_groups rpg ON rpg.role_id = r.id
       WHERE r.business_id = $1
       GROUP BY r.id
       ORDER BY r.is_system DESC, r.created_at ASC`,
      [businessId],
    );
    return result.rows.map((r) => this.rowToRole(r));
  }

  /** `businessId` es guardia multi-tenant — mismo criterio que findMembershipByIdAndBusiness. */
  async getRoleById(roleId: string, businessId: string): Promise<Role | undefined> {
    const result = await this.db.query<RoleJoinRow>(
      `SELECT r.id, r.business_id, r.name, r.is_system, r.active, r.created_at, r.updated_at,
              COALESCE(ARRAY_AGG(rpg.permission_group) FILTER (WHERE rpg.permission_group IS NOT NULL), ARRAY[]::text[]) AS permission_groups
       FROM roles r
       LEFT JOIN role_permission_groups rpg ON rpg.role_id = r.id
       WHERE r.id = $1 AND r.business_id = $2
       GROUP BY r.id`,
      [roleId, businessId],
    );
    return result.rows[0] ? this.rowToRole(result.rows[0]) : undefined;
  }

  async createRole(input: CreateRoleInput): Promise<Role> {
    await this.db.query(
      `INSERT INTO roles (id, business_id, name, is_system) VALUES ($1, $2, $3, FALSE)`,
      [input.id, input.businessId, input.name],
    );
    for (const group of input.permissionGroups) {
      await this.db.query(
        `INSERT INTO role_permission_groups (role_id, permission_group) VALUES ($1, $2)`,
        [input.id, group],
      );
    }
    return (await this.getRoleById(input.id, input.businessId))!;
  }

  /**
   * Reemplaza el set completo de permission_groups de un rol — mismo
   * patrón que `PUT .../resource-locks` (resource-lock.service.ts):
   * borra todo lo que tenía y escribe el set nuevo, más simple que un
   * diff y suficiente para el volumen de filas de esta tabla.
   */
  async updateRolePermissionGroups(roleId: string, businessId: string, permissionGroups: string[]): Promise<Role> {
    await this.db.query(`DELETE FROM role_permission_groups WHERE role_id = $1`, [roleId]);
    for (const group of permissionGroups) {
      await this.db.query(
        `INSERT INTO role_permission_groups (role_id, permission_group) VALUES ($1, $2)`,
        [roleId, group],
      );
    }
    return (await this.getRoleById(roleId, businessId))!;
  }

  async renameRole(roleId: string, businessId: string, name: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE roles SET name = $1 WHERE id = $2 AND business_id = $3`,
      [name, roleId, businessId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Soft-delete. El guard "no desactivar un rol sistema" y "no desactivar
   * si tiene memberships activas" (docs/criterios-datos.md R5) viven en
   * RoleService, no acá — este método solo ejecuta.
   */
  async deactivateRole(roleId: string, businessId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE roles SET active = FALSE WHERE id = $1 AND business_id = $2 AND active = TRUE`,
      [roleId, businessId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Cuenta memberships activas usando un rol — usado por el guard de deactivateRole. */
  async countActiveMembershipsByRole(roleId: string): Promise<number> {
    const result = await this.db.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM memberships WHERE role_id = $1 AND active = TRUE`,
      [roleId],
    );
    return result.rows[0]?.total ?? 0;
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
  // Invitaciones — D2, pendientes-2026-08-19.md
  // -------------------------------------------------------------------------

  async createInvitation(input: CreateUserInvitationInput): Promise<UserInvitation> {
    const result = await this.db.query<UserInvitationJoinRow>(
      `INSERT INTO user_invitations
         (id, business_id, email, role_id, token_hash, invited_by_identity_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, business_id, email, role_id, token_hash, status,
         invited_by_identity_id, accepted_identity_id, expires_at, accepted_at,
         revoked_at, created_at,
         (SELECT name FROM businesses WHERE id = $2) AS business_name,
         (SELECT name FROM roles WHERE id = $4) AS role_name`,
      [input.id, input.businessId, input.email.toLowerCase(), input.roleId, input.tokenHash, input.invitedByIdentityId, input.expiresAt],
    );
    return this.rowToUserInvitation(result.rows[0]!);
  }

  /** Guardia de idempotencia (R13): como máximo una invitación PENDING por (negocio, email). */
  async findPendingInvitationByBusinessAndEmail(businessId: string, email: string): Promise<UserInvitation | undefined> {
    const result = await this.db.query<UserInvitationJoinRow>(
      `SELECT ui.id, ui.business_id, ui.email, ui.role_id, ui.token_hash, ui.status,
              ui.invited_by_identity_id, ui.accepted_identity_id, ui.expires_at, ui.accepted_at,
              ui.revoked_at, ui.created_at,
              b.name AS business_name, r.name AS role_name
       FROM user_invitations ui
       JOIN businesses b ON b.id = ui.business_id
       JOIN roles r ON r.id = ui.role_id
       WHERE ui.business_id = $1 AND LOWER(ui.email) = $2 AND ui.status = 'PENDING'`,
      [businessId, email.toLowerCase()],
    );
    return result.rows[0] ? this.rowToUserInvitation(result.rows[0]) : undefined;
  }

  async listPendingInvitationsByBusiness(businessId: string): Promise<UserInvitation[]> {
    const result = await this.db.query<UserInvitationJoinRow>(
      `SELECT ui.id, ui.business_id, ui.email, ui.role_id, ui.token_hash, ui.status,
              ui.invited_by_identity_id, ui.accepted_identity_id, ui.expires_at, ui.accepted_at,
              ui.revoked_at, ui.created_at,
              b.name AS business_name, r.name AS role_name
       FROM user_invitations ui
       JOIN businesses b ON b.id = ui.business_id
       JOIN roles r ON r.id = ui.role_id
       WHERE ui.business_id = $1 AND ui.status = 'PENDING'
       ORDER BY ui.created_at DESC`,
      [businessId],
    );
    return result.rows.map((r) => this.rowToUserInvitation(r));
  }

  /** `businessId` es guardia multi-tenant — mismo criterio que findMembershipByIdAndBusiness. */
  async findInvitationByIdAndBusiness(id: string, businessId: string): Promise<UserInvitation | undefined> {
    const result = await this.db.query<UserInvitationJoinRow>(
      `SELECT ui.id, ui.business_id, ui.email, ui.role_id, ui.token_hash, ui.status,
              ui.invited_by_identity_id, ui.accepted_identity_id, ui.expires_at, ui.accepted_at,
              ui.revoked_at, ui.created_at,
              b.name AS business_name, r.name AS role_name
       FROM user_invitations ui
       JOIN businesses b ON b.id = ui.business_id
       JOIN roles r ON r.id = ui.role_id
       WHERE ui.id = $1 AND ui.business_id = $2`,
      [id, businessId],
    );
    return result.rows[0] ? this.rowToUserInvitation(result.rows[0]) : undefined;
  }

  /**
   * Reenviar = rotar token + expiración sobre la MISMA fila (R13 — no crea
   * una segunda invitación PENDING para el mismo email). Solo si sigue
   * PENDING — reenviar una invitación ya ACCEPTED/REVOKED no tiene sentido
   * (R11, bloqueo hacia adelante).
   */
  async rotateInvitationToken(id: string, businessId: string, tokenHash: string, expiresAt: Date): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE user_invitations
       SET token_hash = $1, expires_at = $2
       WHERE id = $3 AND business_id = $4 AND status = 'PENDING'`,
      [tokenHash, expiresAt, id, businessId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Cancela una invitación pendiente — no se puede revocar una ya aceptada (R11). */
  async revokeInvitation(id: string, businessId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE user_invitations
       SET status = 'REVOKED', revoked_at = NOW()
       WHERE id = $1 AND business_id = $2 AND status = 'PENDING'`,
      [id, businessId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Resuelve una invitación por el token que llega en el link del mail —
   * SIN filtro de businessId a propósito: el token ES la credencial, mismo
   * criterio que resolver una identity por email en el login antes de
   * saber a qué negocio se va a entrar. El caller valida `status`/
   * `expiresAt` — este método solo busca.
   */
  async findInvitationByTokenHash(tokenHash: string): Promise<UserInvitation | undefined> {
    const result = await this.db.query<UserInvitationJoinRow>(
      `SELECT ui.id, ui.business_id, ui.email, ui.role_id, ui.token_hash, ui.status,
              ui.invited_by_identity_id, ui.accepted_identity_id, ui.expires_at, ui.accepted_at,
              ui.revoked_at, ui.created_at,
              b.name AS business_name, r.name AS role_name
       FROM user_invitations ui
       JOIN businesses b ON b.id = ui.business_id
       JOIN roles r ON r.id = ui.role_id
       WHERE ui.token_hash = $1`,
      [tokenHash],
    );
    return result.rows[0] ? this.rowToUserInvitation(result.rows[0]) : undefined;
  }

  /** Terminal — una vez ACCEPTED, nunca vuelve a PENDING (R11/R12). */
  async markInvitationAccepted(id: string, acceptedIdentityId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE user_invitations
       SET status = 'ACCEPTED', accepted_at = NOW(), accepted_identity_id = $1
       WHERE id = $2 AND status = 'PENDING'`,
      [acceptedIdentityId, id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  // -------------------------------------------------------------------------
  // Reseteo de contraseña — K1, 23/08/2026, pendientes-2026-08-23.md
  // -------------------------------------------------------------------------

  /**
   * A lo sumo un token PENDING por identity (R13, mismo criterio que
   * invitaciones) — pedir un link nuevo rota la MISMA fila en vez de
   * insertar una segunda. `ON CONFLICT` sobre el índice parcial
   * `uq_password_reset_tokens_identity_pending` hace esto atómico (evita el
   * read-then-write que sí tiene el flujo de invitaciones, A8.3).
   */
  async upsertPasswordResetToken(input: UpsertPasswordResetTokenInput): Promise<PasswordResetToken> {
    const result = await this.db.query<PasswordResetTokenJoinRow>(
      `WITH upserted AS (
         INSERT INTO password_reset_tokens
           (id, identity_id, requested_by_identity_id, business_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (identity_id) WHERE status = 'PENDING'
         DO UPDATE SET token_hash = EXCLUDED.token_hash,
                        requested_by_identity_id = EXCLUDED.requested_by_identity_id,
                        business_id = EXCLUDED.business_id,
                        expires_at = EXCLUDED.expires_at
         RETURNING id, identity_id, requested_by_identity_id, business_id, status, expires_at, used_at, created_at
       )
       SELECT u.*, i.email AS identity_email
       FROM upserted u
       JOIN identities i ON i.id = u.identity_id`,
      [input.id, input.identityId, input.requestedByIdentityId, input.businessId, input.tokenHash, input.expiresAt],
    );
    return this.rowToPasswordResetToken(result.rows[0]!);
  }

  /**
   * Resuelve un token de reseteo por el hash que llega en el link del mail —
   * SIN filtro de businessId, mismo criterio que findInvitationByTokenHash
   * (el token ES la credencial). El caller valida `status`/`expiresAt`.
   */
  async findPasswordResetTokenByHash(tokenHash: string): Promise<PasswordResetToken | undefined> {
    const result = await this.db.query<PasswordResetTokenJoinRow>(
      `SELECT prt.id, prt.identity_id, prt.requested_by_identity_id, prt.business_id,
              prt.status, prt.expires_at, prt.used_at, prt.created_at,
              i.email AS identity_email
       FROM password_reset_tokens prt
       JOIN identities i ON i.id = prt.identity_id
       WHERE prt.token_hash = $1`,
      [tokenHash],
    );
    return result.rows[0] ? this.rowToPasswordResetToken(result.rows[0]) : undefined;
  }

  /** Terminal — un token usado no vuelve a PENDING (mismo criterio que invitaciones ACCEPTED). */
  async markPasswordResetTokenUsed(id: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE password_reset_tokens
       SET status = 'USED', used_at = NOW()
       WHERE id = $1 AND status = 'PENDING'`,
      [id],
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
      schemaVersion: row.schema_version ?? null,
      companyId: row.company_id ?? null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private rowToIdentity(row: IdentityRow): Identity {
    return {
      id: row.id,
      email: row.email,
      passwordHash: row.password_hash,
      googleSub: row.google_sub,
      fullName: row.full_name,
      dni: row.dni,
      phone: row.phone,
      createdAt: new Date(row.created_at),
    };
  }

  private rowToMembership(row: MembershipJoinRow): Membership {
    return {
      id: row.id,
      identityId: row.identity_id,
      businessId: row.business_id,
      businessName: row.business_name,
      roleId: row.role_id,
      roleName: row.role_name,
      active: row.active,
      employeeNumber: row.employee_number,
      hiredAt: row.hired_at ? new Date(row.hired_at) : null,
      createdAt: new Date(row.created_at),
    };
  }

  private rowToMembershipWithIdentity(row: MembershipJoinRow & IdentityProfileColumns): MembershipWithIdentity {
    return {
      ...this.rowToMembership(row),
      email: row.email,
      fullName: row.full_name,
      dni: row.dni,
      phone: row.phone,
    };
  }

  private rowToRole(row: RoleJoinRow): Role {
    return {
      id: row.id,
      businessId: row.business_id,
      name: row.name,
      isSystem: row.is_system,
      active: row.active,
      permissionGroups: row.permission_groups,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private rowToUserInvitation(row: UserInvitationJoinRow): UserInvitation {
    return {
      id: row.id,
      businessId: row.business_id,
      businessName: row.business_name,
      email: row.email,
      roleId: row.role_id,
      roleName: row.role_name,
      status: row.status as UserInvitationStatus,
      invitedByIdentityId: row.invited_by_identity_id,
      acceptedIdentityId: row.accepted_identity_id,
      expiresAt: new Date(row.expires_at),
      acceptedAt: row.accepted_at ? new Date(row.accepted_at) : null,
      revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
      createdAt: new Date(row.created_at),
    };
  }

  private rowToPasswordResetToken(row: PasswordResetTokenJoinRow): PasswordResetToken {
    return {
      id: row.id,
      identityId: row.identity_id,
      identityEmail: row.identity_email,
      requestedByIdentityId: row.requested_by_identity_id,
      businessId: row.business_id,
      status: row.status as PasswordResetTokenStatus,
      expiresAt: new Date(row.expires_at),
      usedAt: row.used_at ? new Date(row.used_at) : null,
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
  google_sub: string | null;
  full_name: string | null;
  dni: string | null;
  phone: string | null;
  created_at: string;
}

interface MembershipJoinRow {
  id: string;
  identity_id: string;
  business_id: string;
  business_name: string;
  role_id: string;
  role_name: string;
  active: boolean;
  employee_number: string | null;
  hired_at: string | null;
  created_at: string;
}

/** Columnas de `identities` que se agregan a un JOIN de membership cuando hace falta mostrar el perfil (F2, 23/08/2026). */
interface IdentityProfileColumns {
  email: string;
  full_name: string | null;
  dni: string | null;
  phone: string | null;
}

interface RoleJoinRow {
  id: string;
  business_id: string;
  name: string;
  is_system: boolean;
  active: boolean;
  permission_groups: string[];
  created_at: string;
  updated_at: string;
}

interface UserInvitationJoinRow {
  id: string;
  business_id: string;
  business_name: string;
  email: string;
  role_id: string;
  role_name: string;
  token_hash: string;
  status: string;
  invited_by_identity_id: string;
  accepted_identity_id: string | null;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

interface PasswordResetTokenJoinRow {
  id: string;
  identity_id: string;
  identity_email: string;
  requested_by_identity_id: string;
  business_id: string;
  status: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}
