/**
 * @file role.service.ts
 * @description Lógica de negocio para roles configurables (14/08/2026,
 * Gap analysis - Tango ERP vs modelo actual.md #2). Reemplaza el enum
 * hardcodeado de rol — ver security/roles.ts y platform.schema.sql BLOQUE
 * ROLES para el diseño completo.
 *
 * `roles` vive en la BD de plataforma (PlatformRepository), pero la
 * auditoría (R8/A9.4) vive en `audit_log`, tabla del TENANT — este service
 * recibe ambos repositorios. No hay contradicción: roles.routes.ts se
 * monta después de tenantMiddleware (mismo lugar que users.routes.ts),
 * así que req.db (tenant) está disponible ahí aunque las operaciones
 * reales de roles vayan contra la BD de plataforma.
 */

import type { PlatformRepository, Role } from '../platform/platform.repository.js';
import type { AuditLogRepository } from '../repositories/audit-log.repository.js';
import { diffFields, recordFieldChanges } from '../domain/audit.js';
import { Roles as PermissionGroups, type PermissionGroup } from '../security/roles.js';
import { DomainError } from '../domain/errors.js';

const AUDIT_ENTITY = 'roles';

const VALID_PERMISSION_GROUPS: readonly string[] = Object.values(PermissionGroups);

export class RoleNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Rol '${id}' no encontrado.`, 'ROLE_NOT_FOUND');
  }
}

export class DuplicateRoleNameError extends DomainError {
  constructor(name: string) {
    super(`Ya existe un rol llamado '${name}' en este negocio.`, 'DUPLICATE_ROLE_NAME');
  }
}

export class InvalidPermissionGroupError extends DomainError {
  constructor(group: string) {
    super(`'${group}' no es un grupo de permisos válido.`, 'INVALID_PERMISSION_GROUP');
  }
}

export class CannotModifySystemRoleError extends DomainError {
  constructor(id: string, action: string = 'desactivar') {
    super(`El rol '${id}' es un rol de sistema y no se puede ${action}.`, 'CANNOT_MODIFY_SYSTEM_ROLE');
  }
}

export class RoleInUseError extends DomainError {
  constructor(id: string, count: number) {
    super(`El rol '${id}' tiene ${count} usuario(s) activo(s) — reasignalos antes de desactivarlo.`, 'ROLE_IN_USE');
  }
}

function assertValidPermissionGroups(groups: string[]): void {
  for (const g of groups) {
    if (!VALID_PERMISSION_GROUPS.includes(g)) throw new InvalidPermissionGroupError(g);
  }
}

/**
 * PRESET-REVOKE-001 Parte 1 (10/09/2026) -- comparación por CONJUNTO
 * ordenado, no por array ni por longitud a secas: `['A','B']` y
 * `['B','A']` son el mismo set (el orden de `permissionGroups` nunca fue
 * significativo, ver `diffFields` un poco más abajo en este archivo, que
 * ya ordena antes de comparar).
 */
function sameGroupSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((g, i) => g === sortedB[i]);
}

export class RoleService {
  constructor(
    private readonly platformRepo: PlatformRepository,
    private readonly auditLogRepo: AuditLogRepository,
  ) {}

  async listRoles(businessId: string): Promise<Role[]> {
    return this.platformRepo.listRolesByBusiness(businessId);
  }

  async getRole(id: string, businessId: string): Promise<Role> {
    const role = await this.platformRepo.getRoleById(id, businessId);
    if (!role) throw new RoleNotFoundError(id);
    return role;
  }

  /**
   * `id` se genera acá (slug del nombre + timestamp), mismo criterio que
   * CategoryService.createCategory() — determinístico no hace falta, a
   * diferencia de los 5 roles "sistema" que sí lo necesitan para el
   * backfill de platform.schema.sql.
   */
  async createRole(
    businessId: string,
    name: string,
    permissionGroups: string[],
    changedBy: string,
  ): Promise<Role> {
    assertValidPermissionGroups(permissionGroups);

    const existing = await this.platformRepo.listRolesByBusiness(businessId);
    if (existing.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
      throw new DuplicateRoleNameError(name);
    }

    const id = `role-${businessId}-${slugify(name)}-${Date.now()}`;
    const role = await this.platformRepo.createRole({ id, businessId, name, permissionGroups });

    await this.auditLogRepo.record([{
      entity: AUDIT_ENTITY,
      entityId: role.id,
      field: 'permissionGroups',
      oldValue: null,
      newValue: permissionGroups,
      changedBy,
    }]);

    return role;
  }

  /**
   * Reemplaza el set de permission_groups de un rol existente.
   *
   * **PRESET-REVOKE-001 Parte 1 (10/09/2026, gate `architecture-governor`)
   * -- reversión de una decisión de diseño anterior, con fecha, no
   * "nunca existió":** hasta hoy, R11 decía "bloquear hacia adelante no
   * aplica acá, editar QUÉ puede hacer OWNER/ADMIN/etc. es exactamente el
   * punto de este feature" -- eso dejó de ser cierto. Ahora un rol
   * "sistema" **no puede** customizar su propio set de grupos por acá.
   * La única vía de cambiar qué puede hacer un rol de sistema es el
   * preset de fábrica (`PUT /platform/role-presets/:name`), que desde
   * la Parte 2 de este mismo bloque propaga a todos los negocios al
   * instante, en las dos direcciones (altas y bajas).
   *
   * Guard por CAMBIO DE SET, no incondicional: comparado como conjunto
   * ordenado (mismo criterio que `renameRole()`, `before.name !== name`)
   * -- el frontend manda siempre `{name, permissionGroups}` juntos
   * (`appfrontend-main/src/app/dashboard/roles/page.tsx`), así que un PUT
   * idempotente sobre un rol de sistema (el set no cambia) no debe dar
   * 409. Reusa `CannotModifySystemRoleError` (mismo 409 que `renameRole()`
   * y `deactivateRole()`, cero wiring nuevo).
   *
   * Lo único que un rol "sistema" sigue sin poder es desactivarse —
   * ver deactivateRole().
   */
  async updatePermissionGroups(
    id: string,
    businessId: string,
    permissionGroups: string[],
    changedBy: string,
  ): Promise<Role> {
    assertValidPermissionGroups(permissionGroups);

    const before = await this.getRole(id, businessId); // throws si no existe

    if (before.isSystem && !sameGroupSet(before.permissionGroups, permissionGroups)) {
      throw new CannotModifySystemRoleError(id, 'editar los grupos de permiso de');
    }

    const updated = await this.platformRepo.updateRolePermissionGroups(id, businessId, permissionGroups);

    const changes = diffFields(
      { permissionGroups: [...before.permissionGroups].sort() },
      { permissionGroups: [...permissionGroups].sort() },
    );
    // Orden a propósito (25/08/2026, paso 1 del handoff de RBAC/auditoría):
    // el update de plataforma ya se hizo arriba, ANTES de este audit de
    // tenant — sin transacción real posible entre las dos BDs (ver docblock
    // de archivo), este es el orden más seguro de los dos. Si este segundo
    // paso falla, se pierde el rastro pero el permiso ya cambió de verdad
    // (mismo riesgo que existía antes de que audit_log existiera). Si fuera
    // al revés (audit primero), un fallo del update de plataforma dejaría
    // una fila de audit_log afirmando un cambio que nunca pasó — mucho peor
    // para algo que se usa como fuente de verdad de "quién cambió qué".
    await recordFieldChanges(this.auditLogRepo, AUDIT_ENTITY, id, changes, changedBy);

    return updated;
  }

  async renameRole(id: string, businessId: string, name: string, changedBy: string): Promise<Role> {
    const before = await this.getRole(id, businessId);

    // Guard isSystem (10/09/2026, gate `architecture-governor`, bloque
    // previo a PRESET-REVOKE-001) -- dos razones, ninguna cosmética:
    // (a) el backfill de arranque (`platform.schema.sql`, `INSERT INTO
    // roles (` -- cita por nombre, no línea, desde SCHEMA-ANCHOR-DRIFT-001
    // 10/09/2026) inserta
    // con `id` determinístico (`role-<biz>-<nombre-preset-en-minúscula>`)
    // bajo `ON CONFLICT (business_id, name)`. Un rename libera ese par
    // `(business_id, name)` -- el próximo INSERT ya no matchea ese
    // conflict target y choca contra `roles_pkey`, SIN capturar
    // (`server.ts:33-59`, `process.exit(1)`): el próximo arranque del
    // proceso revienta. (b) `roles.name` es de facto una clave técnica de
    // autorización, no solo una etiqueta: `users.routes.ts:201,276` y
    // `user-invitation.routes.ts:156` comparan `role.name === 'OWNER'`
    // para bloquear asignar OWNER por esas rutas, y `users.routes.ts:213`
    // resuelve el techo de plan (`allowedRoleNames`) por nombre -- un
    // ADMIN (que ya tiene `Roles.MANAGEMENT`, suficiente para `PUT
    // /api/roles/:id`) podría renombrar el OWNER del negocio y saltarse
    // los dos guards por nombre.
    //
    // `before.name !== name` (no un guard incondicional): preserva el
    // `PUT {name, permissionGroups}` completo que ya manda el frontend
    // (`appfrontend-main/src/app/dashboard/roles/page.tsx:110`, siempre
    // los dos campos) -- si el nombre no cambia, este método no tiene
    // nada que objetar, y no pre-decide la pregunta todavía abierta de
    // `PRESET-REVOKE-001` sobre si `updatePermissionGroups()` sigue
    // permitido para roles de sistema. Comparación exacta (no
    // case-insensitive): `uq_roles_business_name` es case-sensitive, así
    // que un rename solo-de-mayúsculas (`OWNER` -> `owner`) rompe el
    // mismo backfill igual.
    //
    // Medido en producción (10/09/2026, Neon `morning-unit-50056927`,
    // branch `br-royal-mouse-aybe2ai3`): 0 roles de sistema renombrados
    // hoy -- puramente preventivo hacia adelante, no hay outage latente.
    if (before.isSystem && before.name !== name) throw new CannotModifySystemRoleError(id, 'renombrar');

    const existing = await this.platformRepo.listRolesByBusiness(businessId);
    if (existing.some((r) => r.id !== id && r.name.toLowerCase() === name.toLowerCase())) {
      throw new DuplicateRoleNameError(name);
    }

    await this.platformRepo.renameRole(id, businessId, name);

    if (before.name !== name) {
      await this.auditLogRepo.record([{
        entity: AUDIT_ENTITY,
        entityId: id,
        field: 'name',
        oldValue: before.name,
        newValue: name,
        changedBy,
      }]);
    }

    return this.getRole(id, businessId);
  }

  /**
   * R5 (docs/criterios-datos.md): bloquea si hay memberships activas
   * usando este rol — no hay flujo de "reasignar en cascada" todavía
   * (deliberado, mismo criterio que "esta semana"/"cuando duela" del
   * resto de R5 en categorías). Los 5 roles "sistema" nunca se pueden
   * desactivar — sin eso, un negocio podría quedarse sin ningún rol al
   * que asignarle OWNER/ADMIN de vuelta.
   */
  async deactivateRole(id: string, businessId: string): Promise<void> {
    const role = await this.getRole(id, businessId);
    if (role.isSystem) throw new CannotModifySystemRoleError(id);

    const activeCount = await this.platformRepo.countActiveMembershipsByRole(id);
    if (activeCount > 0) throw new RoleInUseError(id, activeCount);

    await this.platformRepo.deactivateRole(id, businessId);
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export type { PermissionGroup };
