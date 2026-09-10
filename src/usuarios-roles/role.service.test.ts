import { describe, it, expect, beforeEach } from 'vitest';
import {
  RoleService,
  RoleNotFoundError,
  DuplicateRoleNameError,
  InvalidPermissionGroupError,
  CannotModifySystemRoleError,
  RoleInUseError,
} from './role.service.js';
import { InMemoryAuditLogRepository } from '../repositories/in-memory.audit-log.repository.js';
import type { PlatformRepository, Role, CreateRoleInput } from '../platform/platform.repository.js';

/**
 * Fake mínimo de PlatformRepository — mismo criterio que
 * tenant.middleware.test.ts (`{...} as unknown as PlatformRepository`, no
 * hay interfaz IPlatformRepository en este repo). Solo implementa los
 * métodos de roles que RoleService usa.
 */
class FakePlatformRepository {
  roles = new Map<string, Role>();
  activeMembershipsByRole = new Map<string, number>();

  seed(role: Role): void {
    this.roles.set(role.id, role);
  }

  async listRolesByBusiness(businessId: string): Promise<Role[]> {
    return [...this.roles.values()].filter((r) => r.businessId === businessId);
  }

  async getRoleById(id: string, businessId: string): Promise<Role | undefined> {
    const role = this.roles.get(id);
    return role && role.businessId === businessId ? role : undefined;
  }

  async createRole(input: CreateRoleInput): Promise<Role> {
    const now = new Date();
    const role: Role = {
      id: input.id,
      businessId: input.businessId,
      name: input.name,
      isSystem: false,
      active: true,
      permissionGroups: input.permissionGroups,
      createdAt: now,
      updatedAt: now,
    };
    this.roles.set(role.id, role);
    return role;
  }

  async updateRolePermissionGroups(roleId: string, _businessId: string, permissionGroups: string[]): Promise<Role> {
    const role = this.roles.get(roleId)!;
    const updated = { ...role, permissionGroups, updatedAt: new Date() };
    this.roles.set(roleId, updated);
    return updated;
  }

  async renameRole(roleId: string, _businessId: string, name: string): Promise<boolean> {
    const role = this.roles.get(roleId);
    if (!role) return false;
    this.roles.set(roleId, { ...role, name, updatedAt: new Date() });
    return true;
  }

  async deactivateRole(roleId: string, _businessId: string): Promise<boolean> {
    const role = this.roles.get(roleId);
    if (!role) return false;
    this.roles.set(roleId, { ...role, active: false });
    return true;
  }

  async countActiveMembershipsByRole(roleId: string): Promise<number> {
    return this.activeMembershipsByRole.get(roleId) ?? 0;
  }
}

function asPlatformRepo(fake: FakePlatformRepository): PlatformRepository {
  return fake as unknown as PlatformRepository;
}

describe('RoleService', () => {
  let platformRepo: FakePlatformRepository;
  let auditRepo: InMemoryAuditLogRepository;
  let service: RoleService;

  const now = new Date();

  beforeEach(() => {
    platformRepo = new FakePlatformRepository();
    auditRepo = new InMemoryAuditLogRepository();
    service = new RoleService(asPlatformRepo(platformRepo), auditRepo);

    platformRepo.seed({
      id: 'role-biz-1-receptionist',
      businessId: 'biz-1',
      name: 'RECEPTIONIST',
      isSystem: true,
      active: true,
      permissionGroups: ['STAFF', 'FRONT_DESK', 'BOOKING'],
      createdAt: now,
      updatedAt: now,
    });
  });

  describe('createRole', () => {
    it('crea un rol custom con permissionGroups válidos y lo audita', async () => {
      const role = await service.createRole('biz-1', 'Recepcionista Junior', ['STAFF', 'BOOKING'], 'identity-1');

      expect(role.name).toBe('Recepcionista Junior');
      expect(role.isSystem).toBe(false);
      expect(role.permissionGroups).toEqual(['STAFF', 'BOOKING']);

      const entries = await auditRepo.findByEntity('roles', role.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ field: 'permissionGroups', changedBy: 'identity-1' });
    });

    it('rechaza un nombre duplicado (case-insensitive) dentro del mismo negocio', async () => {
      await expect(
        service.createRole('biz-1', 'receptionist', [], 'identity-1'),
      ).rejects.toBeInstanceOf(DuplicateRoleNameError);
    });

    it('permite el mismo nombre en negocios distintos', async () => {
      const role = await service.createRole('biz-2', 'RECEPTIONIST', [], 'identity-1');
      expect(role.businessId).toBe('biz-2');
    });

    it('rechaza un permission_group inválido', async () => {
      await expect(
        service.createRole('biz-1', 'Rol raro', ['NO_EXISTE'], 'identity-1'),
      ).rejects.toBeInstanceOf(InvalidPermissionGroupError);
    });
  });

  describe('updatePermissionGroups', () => {
    it('audita el cambio cuando el set de grupos cambia', async () => {
      await service.updatePermissionGroups('role-biz-1-receptionist', 'biz-1', ['STAFF'], 'identity-1');

      const entries = await auditRepo.findByEntity('roles', 'role-biz-1-receptionist');
      expect(entries).toHaveLength(1);
      expect(entries[0]!.field).toBe('permissionGroups');
    });

    it('no audita nada si el set de grupos no cambia (mismo contenido, distinto orden)', async () => {
      await service.updatePermissionGroups(
        'role-biz-1-receptionist',
        'biz-1',
        ['BOOKING', 'FRONT_DESK', 'STAFF'],
        'identity-1',
      );
      expect(auditRepo.all()).toHaveLength(0);
    });

    it('propaga RoleNotFoundError para un id inexistente', async () => {
      await expect(
        service.updatePermissionGroups('role-inexistente', 'biz-1', ['STAFF'], 'identity-1'),
      ).rejects.toBeInstanceOf(RoleNotFoundError);
    });

    it('funciona sobre roles "sistema" — editar sus permisos es el punto del feature', async () => {
      const updated = await service.updatePermissionGroups('role-biz-1-receptionist', 'biz-1', ['STAFF'], 'identity-1');
      expect(updated.permissionGroups).toEqual(['STAFF']);
    });
  });

  describe('renameRole (10/09/2026, guard isSystem, gate architecture-governor)', () => {
    // M1 -- borrar el guard.
    it('rechaza renombrar un rol "sistema"', async () => {
      await expect(
        service.renameRole('role-biz-1-receptionist', 'biz-1', 'Recepción', 'identity-1'),
      ).rejects.toBeInstanceOf(CannotModifySystemRoleError);
    });

    // M2 -- negar la condición (`!before.isSystem`). Afirma el nombre
    // PERSISTIDO, no solo "no tira" -- un mutante que invierte la
    // condición podría seguir sin tirar por otra razón y este assert lo
    // mataría igual.
    it('renombra un rol custom y persiste el nombre nuevo', async () => {
      const role = await service.createRole('biz-1', 'Custom', ['STAFF'], 'identity-1');

      const renamed = await service.renameRole(role.id, 'biz-1', 'Custom Renombrado', 'identity-1');

      expect(renamed.name).toBe('Custom Renombrado');
      const found = await platformRepo.getRoleById(role.id, 'biz-1');
      expect(found?.name).toBe('Custom Renombrado');
    });

    // M3 -- quitar la mitad `&& before.name !== name` de la condición.
    // El mutante que distingue el diseño aprobado (antes.isSystem &&
    // antes.name !== name) del guard incondicional que se descartó: un
    // PUT con el MISMO nombre sobre un rol de sistema no tiene nada que
    // objetar (preserva el PUT {name, permissionGroups} completo que ya
    // manda el frontend).
    it('un PUT con el MISMO nombre sobre un rol "sistema" no tira y no audita nada', async () => {
      const renamed = await service.renameRole('role-biz-1-receptionist', 'biz-1', 'RECEPTIONIST', 'identity-1');

      expect(renamed.name).toBe('RECEPTIONIST');
      expect(auditRepo.all()).toHaveLength(0);
    });

    // M4 -- comparar case-insensitive. `uq_roles_business_name` es
    // case-sensitive: un rename solo-de-mayúsculas rompe igual el
    // backfill determinístico (`platform.schema.sql`, `INSERT INTO
    // roles (` -- cita por nombre, no línea, desde SCHEMA-ANCHOR-DRIFT-001
    // 10/09/2026).
    it('rechaza un rename solo-de-mayúsculas sobre un rol "sistema" (case-sensitive)', async () => {
      await expect(
        service.renameRole('role-biz-1-receptionist', 'biz-1', 'receptionist', 'identity-1'),
      ).rejects.toBeInstanceOf(CannotModifySystemRoleError);
    });

    // M5 -- mover el guard DESPUÉS de `platformRepo.renameRole(...)`. El
    // fake muta su Map dentro de `renameRole()` -- observable solo si el
    // test relee el estado tras el throw.
    it('tras el throw, el nombre del rol "sistema" sigue siendo el original (el guard corta ANTES de escribir)', async () => {
      await expect(
        service.renameRole('role-biz-1-receptionist', 'biz-1', 'Recepción', 'identity-1'),
      ).rejects.toBeInstanceOf(CannotModifySystemRoleError);

      const found = await platformRepo.getRoleById('role-biz-1-receptionist', 'biz-1');
      expect(found?.name).toBe('RECEPTIONIST');
    });

    // M6 -- guard DESPUÉS de la validación de duplicado. Fija qué error
    // gana cuando las dos condiciones aplican a la vez: el guard corre
    // primero, así que un rol "sistema" tira CannotModifySystemRoleError
    // aunque el nombre destino ya esté ocupado por otro rol.
    it('sobre un rol "sistema", el guard gana aunque el nombre destino ya esté ocupado por otro rol', async () => {
      await service.createRole('biz-1', 'Ya Ocupado', ['STAFF'], 'identity-1');

      await expect(
        service.renameRole('role-biz-1-receptionist', 'biz-1', 'Ya Ocupado', 'identity-1'),
      ).rejects.toBeInstanceOf(CannotModifySystemRoleError);
    });

    it('un rol custom SÍ rechaza con DuplicateRoleNameError si el nombre destino ya está ocupado', async () => {
      const role = await service.createRole('biz-1', 'Custom', ['STAFF'], 'identity-1');
      await service.createRole('biz-1', 'Ya Ocupado', ['STAFF'], 'identity-1');

      await expect(
        service.renameRole(role.id, 'biz-1', 'Ya Ocupado', 'identity-1'),
      ).rejects.toBeInstanceOf(DuplicateRoleNameError);
    });
  });

  describe('deactivateRole', () => {
    it('rechaza desactivar un rol "sistema"', async () => {
      await expect(
        service.deactivateRole('role-biz-1-receptionist', 'biz-1'),
      ).rejects.toBeInstanceOf(CannotModifySystemRoleError);
    });

    it('rechaza desactivar un rol custom con memberships activas', async () => {
      const role = await service.createRole('biz-1', 'Custom', ['STAFF'], 'identity-1');
      platformRepo.activeMembershipsByRole.set(role.id, 2);

      await expect(service.deactivateRole(role.id, 'biz-1')).rejects.toBeInstanceOf(RoleInUseError);
    });

    it('desactiva un rol custom sin memberships activas', async () => {
      const role = await service.createRole('biz-1', 'Custom', ['STAFF'], 'identity-1');
      await service.deactivateRole(role.id, 'biz-1');

      const found = await platformRepo.getRoleById(role.id, 'biz-1');
      expect(found?.active).toBe(false);
    });
  });
});
