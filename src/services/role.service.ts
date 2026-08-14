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
import { diffFields } from '../domain/audit.js';
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
  constructor(id: string) {
    super(`El rol '${id}' es un rol de sistema y no se puede desactivar.`, 'CANNOT_MODIFY_SYSTEM_ROLE');
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
   * Reemplaza el set de permission_groups de un rol existente — incluye
   * roles "sistema" (R11: bloquear hacia adelante no aplica acá, editar
   * QUÉ puede hacer OWNER/ADMIN/etc. es exactamente el punto de este
   * feature). Lo único que un rol "sistema" no puede es desactivarse —
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
    const updated = await this.platformRepo.updateRolePermissionGroups(id, businessId, permissionGroups);

    const changes = diffFields(
      { permissionGroups: [...before.permissionGroups].sort() },
      { permissionGroups: [...permissionGroups].sort() },
    );
    if (changes.length > 0) {
      await this.auditLogRepo.record(
        changes.map((c) => ({
          entity: AUDIT_ENTITY,
          entityId: id,
          field: c.field,
          oldValue: c.oldValue,
          newValue: c.newValue,
          changedBy,
        })),
      );
    }

    return updated;
  }

  async renameRole(id: string, businessId: string, name: string, changedBy: string): Promise<Role> {
    const before = await this.getRole(id, businessId);

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
