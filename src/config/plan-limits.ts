/**
 * @file plan-limits.ts
 * @description Tipo de los límites de uso por plan de suscripción.
 *
 * Los VALORES viven en la tabla `plan_limits`/`plan_limit_allowed_roles` de
 * la BD de plataforma (platform.schema.sql, BLOQUE PLAN_LIMITS) desde el
 * 18/08/2026 -- antes eran la constante `PLAN_LIMITS` hardcodeada acá
 * mismo. Se leen vía `AppContainer.getPlanLimits(plan)` (container.ts),
 * respaldado por `PlatformRepository.getPlanLimits()`. Este archivo ahora
 * solo declara la forma del dato para que category.service.ts y
 * usuarios-roles/users.routes.ts no tengan que importar del repositorio de
 * plataforma directamente.
 *
 * Se leen en CategoryService (maxCategories -- maxResources está en la
 * interfaz pero ningún service lo aplica todavía, gap preexistente sin
 * relación con este cambio) y en usuarios-roles/users.routes.ts
 * (maxActiveMemberships/allowedRoleNames) para rechazar operaciones que
 * superen el plan del negocio.
 *
 * PRO usa Infinity para evitar comparaciones especiales en el código --
 * `PlatformRepository.getPlanLimits()` mapea `NULL` (columna sin límite en
 * la tabla) a `Infinity` al leer, así que este contrato no cambió.
 */

export interface PlanLimits {
  maxCategories: number;  // máximo de resource_categories activas
  maxResources: number;   // máximo de resources activos
  /** Máximo de memberships ACTIVAS que no sean OWNER (el owner es estructural, no ocupa asiento) -- usuarios-roles/users.routes.ts POST /users. */
  maxActiveMemberships: number;
  /** `roles.name` que este plan puede asignar a una membership vía POST/PUT /users. 'ALL' = sin restricción. OWNER nunca pasa por acá (no se asigna desde esta API). */
  allowedRoleNames: readonly string[] | 'ALL';
  /** L (23/08/2026) -- máximo de roles CUSTOM activos (isSystem=false) del negocio -- usuarios-roles/roles.routes.ts POST /. Los 5 roles de fábrica no cuentan contra este límite. */
  maxCustomRoles: number;
  /** L (23/08/2026) -- grupos de `security/roles.ts` que un rol CUSTOM puede incluir. 'ALL' = sin restricción. No aplica a los 5 roles de fábrica (esos ya vienen fijos desde role_preset_permission_groups). */
  allowedPermissionGroups: readonly string[] | 'ALL';
}
