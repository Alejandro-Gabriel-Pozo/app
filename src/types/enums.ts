/**
 * EXPIRED (22/08/2026, docs/diseno-sena-deposito-fase-a-2026-08-22.md,
 * C1-Fase A) — estado terminal nuevo, distinto de CANCELLED: una reserva
 * que venció su hold sin cobrar la seña (reservation-hold-expiry.worker.ts),
 * nunca disparado por una acción de usuario (A6.6, criterios-negocio.md).
 * No confundir con CANCELLED, que sí es una decisión (cliente/staff).
 */
export enum ReservationStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
  COMPLETED = 'COMPLETED',
  EXPIRED = 'EXPIRED',
}

/**
 * Discrimina el tipo de sesión de un token — YA NO es "el rol" del staff
 * (14/08/2026, Gap analysis - Tango ERP vs modelo actual.md #2). OWNER/
 * ADMIN/RECEPTIONIST/HOUSEKEEPING/WAITER dejaron de ser valores de código:
 * ahora son filas de la tabla `roles` (platform.schema.sql, BLOQUE ROLES),
 * editables por negocio sin deploy — el rol de un membership vive en
 * `memberships.role_id` → `roles`, resuelto en cada request contra
 * `role_permission_groups` (ver security/auth.middleware.ts).
 *
 * CUSTOMER es el único valor que sigue siendo código: los clientes no
 * tienen membership ni fila en `roles` (son un actor estructuralmente
 * distinto — ver docs/pendientes-2026-08-13.md B2), así que necesitan un
 * discriminador fijo para que auth.middleware.ts sepa "este token es de un
 * cliente, no de un empleado" sin ninguna consulta a la BD.
 */
export enum UserRole {
  CUSTOMER = 'CUSTOMER',
}

/**
 * Roles de la plataforma (superadmin).
 * Solo para gestión interna — nunca expuestos a negocios.
 */
export enum PlatformRole {
  SUPERADMIN = 'SUPERADMIN',
}

/**
 * Planes de suscripción disponibles para los negocios.
 * Los límites de cada plan están en la tabla `plan_limits` de la BD de
 * plataforma (platform.schema.sql, BLOQUE PLAN_LIMITS — 18/08/2026, antes
 * era la constante TS `PLAN_LIMITS`). `src/config/plan-limits.ts` solo
 * declara la forma del dato (`PlanLimits`).
 *
 * ENTERPRISE (18/08/2026, empresas multipropiedad) — el único plan que
 * puede crear/unirse a una `company` (catálogo compartido entre varios
 * negocios, ver docs/diseno-empresas-multipropiedad.md). Mismos límites
 * numéricos que PRO (sin límite) en el seed de `plan_limits` — Enterprise
 * es superset de PRO, no un tier con topes propios distintos.
 */
export enum BusinessPlan {
  FREE       = 'FREE',
  STARTER    = 'STARTER',
  PRO        = 'PRO',
  ENTERPRISE = 'ENTERPRISE',
}

/**
 * Estado del negocio en la plataforma.
 */
export enum BusinessStatus {
  PENDING   = 'PENDING',
  ACTIVE    = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  CANCELLED = 'CANCELLED',
}

/**
 * Módulos habilitables por negocio (add-ons de facturación modular).
 * Ver src/db/platform.schema.sql (tablas `modules` y `business_modules`)
 * y src/platform/platform.repository.ts (getBusinessModules).
 *
 * POS_RESTAURANTE y ALOJAMIENTO son módulos comercialmente distintos aunque
 * convivan en un mismo negocio (ej. un hotel con su propio restaurante) —
 * no conflacionar en un solo módulo "hospitalidad".
 *
 * ALOJAMIENTO es el único que se habilita por defecto en negocios nuevos
 * (ver PlatformRepository.createBusiness) — el resto arranca deshabilitado
 * hasta que exista una pantalla de selección/pago.
 */
export enum ModuleKey {
  REPORTES            = 'REPORTES',
  HOUSEKEEPING        = 'HOUSEKEEPING',
  CUENTAS_CORRIENTES  = 'CUENTAS_CORRIENTES',
  POS_RESTAURANTE     = 'POS_RESTAURANTE',
  FACTURACION         = 'FACTURACION',
  ALOJAMIENTO         = 'ALOJAMIENTO',
}
