/**
 * @file app.ts
 * @description Bootstrap de la aplicación Express — arquitectura multi-tenant.
 *
 * ## Orden de middlewares
 * 1.  trust proxy (Render/Cloudflare)
 * 2.  helmetBase — security headers globales (sin CSP, se aplica por ruta)
 * 3.  globalLimiter — baseline anti-DoS (500 req/min/IP)
 * 4.  cors, express.json
 * 5.  /health               — chequea platformClient (PLATFORM_DATABASE_URL)
 * 6.  /docs                 — helmetDocs (CSP permisiva para Swagger UI)
 * 7.  /openapi.json         — helmetBase ya aplicado
 * 8.  /platform/*           — helmetApi + platformLimiter (SUPERADMIN)
 * 9.  POST /register        — helmetApi + authLimiter (público)
 * 10. POST /api/login       — helmetApi + authLimiter (público)
 * 11. /api/customer/*       — helmetApi (portal del cliente)
 * 12. authenticate()        — verifica JWT, protege /api/* restante
 * 13. /api/admin            — mantenimiento (ADMIN, SIN tenantMiddleware)
 *     ⚠️  Montado ANTES de tenantMiddleware a propósito: repair-tenant-db
 *        necesita correr cuando la BD del tenant todavía no está activa.
 * 14. tenantMiddleware()    — inyecta req.db + arranca OutboxWorker por tenant
 * 15. apiLimiter            — 200 req/min/IP sobre /api/* autenticado
 * 16. /api/resources, /reservations, /reports, /customers, /users,
 *     /categories, /products, /orders, /waste-reasons, /bookable-services,
 *     /housekeeping, /stays
 * 17. errorHandler
 */

import express from 'express';
import cors    from 'cors';
import swaggerUi from 'swagger-ui-express';
import type http from 'node:http';

import { createResourcesRouter }         from './reservas/resources.routes.js';
import { createLocationsRouter }         from './api/routes/locations.routes.js';
import { createReservationsRouter }      from './reservas/reservations.routes.js';
import { createReportsRouter }           from './api/routes/reports.routes.js';
import { createSystemRouter }            from './api/routes/system.routes.js';
import { createAuthRouter }              from './api/routes/auth.routes.js';
import { createMeRouter }                from './api/routes/me.routes.js';
import { createBusinessRouter }          from './platform/business.routes.js';
import { createCustomerRouter }          from './api/routes/customer.routes.js';
import { createCustomersRouter }         from './clientes-finanzas/customers.routes.js';
import { createRateCatalogRouter }       from './clientes-finanzas/rate-catalog.routes.js';
import { createCategoryRouter }          from './reservas/categories.routes.js';
import { createAuditLogRouter }          from './api/routes/audit-log.routes.js';
import { createUsersRouter }             from './usuarios-roles/users.routes.js';
import { createUserInvitationsRouter, createInvitationAcceptanceRouter } from './usuarios-roles/user-invitation.routes.js';
import { createPasswordResetRouter } from './usuarios-roles/password-reset.routes.js';
import { createRolesRouter }             from './usuarios-roles/roles.routes.js';
import { createPlatformRouter }          from './platform/platform.routes.js';
import { createAdminRouter }             from './platform/admin.routes.js';
import { createProductsRouter }          from './pos-menu/products.routes.js';
import { createWasteReasonsRouter }      from './pos-menu/waste-reasons.routes.js';
import { createCancellationPoliciesRouter } from './reservas/cancellation-policies.routes.js';
import { createOrdersRouter }            from './pos-menu/orders.routes.js';
import { createBookableServicesRouter }  from './reservas/bookable-services.routes.js';
import { createHousekeepingRouter }      from './pms-estadias/housekeeping.routes.js';
import { createMaintenanceWindowsRouter } from './pms-estadias/maintenance-windows.routes.js';
import { createStaysRouter }             from './pms-estadias/stays.routes.js';
import { createAccountsReceivableRouter } from './clientes-finanzas/accounts-receivable.routes.js';
import { createBusinessHoursRouter }     from './platform/business-hours.routes.js';
import { createBusinessProfileRouter }   from './api/routes/business-profile.routes.js';
import { createInvoicesRouter, createAfipCredentialsRouter } from './facturacion/invoices.routes.js';
import { createBusinessModulesRouter }   from './platform/business-modules.routes.js';
import { createBusinessPlanLimitsRouter } from './platform/business-plan-limits.routes.js';
import { createCashRegisterRouter }      from './clientes-finanzas/cash-register.routes.js';
import { errorHandler }                  from './api/middleware/error.middleware.js';
import { globalLimiter, authLimiter, platformLimiter, apiLimiter } from './api/middleware/rate-limit.middleware.js';
import { helmetBase, helmetApi, helmetDocs } from './api/middleware/helmet.middleware.js';
import { openApiSpec }                   from './openapi/spec.js';
import { authenticate }                  from './security/auth.middleware.js';
import { requireModule }                 from './security/module.middleware.js';
import { ModuleKey }                     from './types/enums.js';
import { AuthService }                   from './security/auth.service.js';
import { PlatformRepository }            from './platform/platform.repository.js';
import { createPlatformContainer }       from './platform/platform.container.js';
import { tenantMiddleware }              from './platform/tenant.middleware.js';
import { CompanyRepository }             from './platform/company.repository.js';
import { createCompaniesRouter }         from './platform/companies.routes.js';
import { startCompanySyncWorker, stopCompanySyncWorker } from './platform/company-sync.registry.js';
import type { AppContainer} from './container.js';
import { createAppContainer, createPlatformPool, closePlatformPool } from './container.js';
import { checkDatabaseHealth }           from './db/pg.client.js';
import { SqlHousekeepingRepository }     from './pms-estadias/housekeeping.repository.js';
import { SqlMaintenanceWindowRepository } from './pms-estadias/sql.maintenance-window.repository.js';
import { SqlStayRepository }             from './pms-estadias/stay.repository.js';
import { HousekeepingService }           from './pms-estadias/housekeeping.service.js';
import { MaintenanceWindowService }      from './pms-estadias/maintenance-window.service.js';
import { StayService }                   from './pms-estadias/stay.service.js';
import { SqlResourceRepository }         from './reservas/sql.resource.repository.js';
import { SqlReservationRepository }      from './reservas/sql.reservation.repository.js';
import { SqlOccupancyRepository }        from './reservas/sql.occupancy.repository.js';
import { SqlDomainEventRepository }      from './repositories/sql.domain-event.repository.js';
import { ReportService }                 from './services/report.service.js';
import { closeTenantPools }              from './platform/tenant.middleware.js';
import { SqlFinancialTransactionRepository } from './clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlAccountsReceivableRepository }   from './clientes-finanzas/sql.accounts-receivable.repository.js';
import { SqlCustomerRepository }             from './clientes-finanzas/sql.customer.repository.js';
import { AccountsReceivableService }         from './clientes-finanzas/accounts-receivable.service.js';
import { SqlBusinessProfileRepository }      from './repositories/sql.business-profile.repository.js';
import { SqlOrderRepository }                from './pos-menu/sql.order.repository.js';
import { SqlStockMovementRepository }        from './repositories/sql.stock-movement.repository.js';
import { buildTenantTransactionManager }     from './db/tenant-context.js';
import { stopAllWorkers }                from './workers/outbox.registry.js';
import { createEmailSender }             from './email/email.sender.js';
import type { Request, Response, NextFunction } from 'express';

export async function createApp(): Promise<{
  app: express.Application;
  container: AppContainer;
}> {
  const app = express();

  // -------------------------------------------------------------------------
  // 1. trust proxy — DEBE ir primero, antes de cualquier middleware que lea
  //    req.ip (rate limiter, logging). Sin esto, en Render/Cloudflare req.ip
  //    resuelve a la IP interna del proxy.
  // -------------------------------------------------------------------------
  app.set('trust proxy', 1);

  // -------------------------------------------------------------------------
  // 2. Helmet base — security headers globales, sin CSP.
  // -------------------------------------------------------------------------
  app.use(helmetBase);

  // -------------------------------------------------------------------------
  // 3. Global limiter — baseline anti-DoS.
  // -------------------------------------------------------------------------
  app.use(globalLimiter);

  // platformClient se crea UNA sola vez y se reutiliza en toda la app,
  // incluyendo el health check. Es el pool real de PLATFORM_DATABASE_URL.
  const platformClient = createPlatformPool();
  const platformRepo   = new PlatformRepository(platformClient);
  const companyRepo    = new CompanyRepository(platformClient);

  const authService = new AuthService(platformRepo);
  const container   = await createAppContainer();

  // Empresas multipropiedad (17/08/2026) — único worker de propagación del
  // proceso, no por tenant (ver company-sync.registry.ts).
  startCompanySyncWorker(companyRepo, platformRepo);

  // -------------------------------------------------------------------------
  // 4. CORS + body parser
  // -------------------------------------------------------------------------
  const corsOrigin =
    process.env.CORS_ORIGIN ??
    (process.env.NODE_ENV === 'production' ? false : '*');

  // Base para links que mandamos por mail (invitación de usuarios, D2) —
  // reusa CORS_ORIGIN ("dominio del frontend", ver render.yaml) en vez de
  // sumar una segunda variable de entorno con el mismo dominio adentro.
  // `'*'` (dev sin CORS_ORIGIN seteada) no es una URL real, así que cae al
  // puerto default de Next.js en local.
  const frontendUrl =
    process.env.CORS_ORIGIN && process.env.CORS_ORIGIN !== '*'
      ? process.env.CORS_ORIGIN
      : 'http://localhost:3000';

  app.use(cors({
    origin:         corsOrigin,
    methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));
  app.use(express.json());

  // -------------------------------------------------------------------------
  // 5. /health — chequea platformClient (PLATFORM_DATABASE_URL), no DATABASE_URL.
  //    Antes usaba el pool interno de pg.client.ts (DATABASE_URL legacy)
  //    que no está seteada en Render → siempre retornaba db:"error".
  // -------------------------------------------------------------------------
  app.get('/health', async (_req, res) => {
    const dbOk = await checkDatabaseHealth(platformClient);
    res.json({
      status: 'ok',
      mode:   'multi-tenant',
      db:     dbOk ? 'connected' : 'error',
    });
  });

  app.get('/', (_req, res) => res.redirect('/docs'));
  app.get('/openapi.json', (_req, res) => res.json(openApiSpec));

  // /docs — CSP permisiva para que Swagger UI cargue sus assets de CDN
  app.use('/docs', helmetDocs, swaggerUi.serve, swaggerUi.setup(openApiSpec, {
    customSiteTitle: 'Reservations API',
    swaggerOptions:  { persistAuthorization: true, docExpansion: 'list', filter: true },
  }));

  // -------------------------------------------------------------------------
  // 8. /platform/* — helmetApi (CSP estricta) + platformLimiter
  // -------------------------------------------------------------------------
  const platformContainer = createPlatformContainer();
  app.use('/platform', ...helmetApi, platformLimiter, createPlatformRouter(platformContainer));

  // -------------------------------------------------------------------------
  // 9-10. /register + /api/login — helmetApi + authLimiter (anti brute-force)
  // -------------------------------------------------------------------------
  app.use('/register',  ...helmetApi, authLimiter, createBusinessRouter(platformRepo));
  app.use('/api/login', ...helmetApi, authLimiter, createAuthRouter(authService));

  // -------------------------------------------------------------------------
  // 11. /api/customer — portal del cliente
  // -------------------------------------------------------------------------
  app.use('/api/customer', createCustomerRouter(container, platformRepo));

  // -------------------------------------------------------------------------
  // 12. helmetApi sobre todo /api/* — cubre customer, admin y rutas de tenant.
  // -------------------------------------------------------------------------
  app.use('/api', ...helmetApi);

  // /api/admin — ANTES del authenticate() de tenant de más abajo (19/08/2026,
  // auditoría de producto: repair-tenant-db/set-tenant-url estaban detrás de
  // Roles.MANAGEMENT de TENANT, es decir cualquier OWNER/ADMIN de cualquier
  // negocio podía reapuntar su propia BD -- set-tenant-url incluso a una URL
  // arbitraria mandada en el body). Ahora exige un token de PLATAFORMA
  // (authenticatePlatform(), PLATFORM_JWT_SECRET) -- un superadmin no tiene
  // token de tenant, así que este mount tiene que resolver ANTES de que el
  // authenticate() de tenant de la línea de abajo lo rechace con 401 primero.
  // Mismo motivo por el que /platform/* vive fuera de /api por completo.
  app.use('/api/admin', createAdminRouter(platformRepo));

  // /api/invitations — aceptar una invitación de usuario (D2,
  // pendientes-2026-08-19.md). PÚBLICO a propósito, mismo motivo que
  // /api/admin: quien acepta todavía no tiene ningún JWT (ni de tenant ni
  // de plataforma) — el token de la invitación es la única credencial.
  app.use('/api/invitations', createInvitationAcceptanceRouter(platformRepo, container));

  // /api/password-resets — reseteo de contraseña, público (K1 aceptar +
  // L self-service "olvidé mi contraseña", 23/08/2026,
  // pendientes-2026-08-23.md). Mismo motivo que /api/invitations: quien
  // todavía no puso su contraseña nueva no tiene ningún JWT.
  // authLimiter (no globalLimiter solo) — L, 23/08/2026: POST /request es
  // texto libre (email) sin sesión, mismo vector de enumeración/spam que
  // /api/login; antes de este cambio el mount entero no tenía ningún
  // límite dedicado.
  app.use('/api/password-resets', authLimiter, createPasswordResetRouter(platformRepo, createEmailSender(), frontendUrl));

  // authenticate() — protege /api/* desde aquí. Se le pasa
  // resolveMembershipContext (14/08/2026, reemplaza al viejo chequeo
  // booleano de memberships.active) para que además de la revocación
  // inmediata de acceso (Roles.MANAGEMENT desactiva desde /api/users), los
  // permisos del rol actual (role_id → role_permission_groups) también se
  // resuelvan en cada request — un cambio de permisos hecho por el dueño
  // del negocio tiene efecto de inmediato, no recién cuando el JWT expire
  // (hasta JWT_EXPIRES_IN, default 24h). Ver security/auth.middleware.ts.
  app.use('/api', authenticate(undefined, (identityId, businessId) =>
    platformRepo.getMembershipContext(identityId, businessId),
  ));

  // (/api/admin se movió arriba, antes de este authenticate() de tenant --
  // ver comentario ahí, 19/08/2026.)

  // /api/companies — empresas multipropiedad (17/08/2026). Solo toca la BD
  // de plataforma (req.user, no req.db), mismo motivo que /api/admin va
  // antes de tenantMiddleware.
  app.use('/api/companies', createCompaniesRouter(platformRepo, companyRepo, container));

  // /api/auth/me + /api/auth/logout (B2) — solo lee req.user, tampoco
  // necesita req.db de tenant.
  app.use('/api/auth', createMeRouter(platformRepo, authService));

  // /api/business/modules — tampoco necesita req.db (consulta la BD de
  // plataforma vía container), así que va antes de tenantMiddleware.
  app.use('/api/business/modules', createBusinessModulesRouter(container));

  // /api/business/plan-limits — L (23/08/2026), mismo motivo que modules
  // arriba: el dashboard necesita saber maxCustomRoles/allowedPermissionGroups
  // sin ser MANAGEMENT, para el gating visual del CRUD de roles propios.
  app.use('/api/business/plan-limits', createBusinessPlanLimitsRouter(container));

  // -------------------------------------------------------------------------
  // 14. tenantMiddleware — inyecta req.db + arranca OutboxWorker por tenant
  // -------------------------------------------------------------------------
  app.use('/api', tenantMiddleware(platformRepo));

  // -------------------------------------------------------------------------
  // 15. apiLimiter — después de autenticación y resolución de tenant
  // -------------------------------------------------------------------------
  app.use('/api', apiLimiter);

  // -------------------------------------------------------------------------
  // 16. Rutas protegidas de empleados (todas usan req.db del tenant)
  // -------------------------------------------------------------------------
  app.use('/api/resources',         createResourcesRouter());
  app.use('/api/locations',         createLocationsRouter());
  app.use('/api/reservations',      createReservationsRouter(container));
  app.use('/api/cancellation-policies', createCancellationPoliciesRouter(container));
  app.use('/api/customers',         createCustomersRouter(container));
  app.use('/api/rate-catalog',      createRateCatalogRouter());
  // /api/users/invitations ANTES de /api/users a propósito: el router de
  // /api/users tiene GET/PUT /:id — montado primero, "invitations"
  // matchearía ese :id y nunca llegaría a este router.
  app.use('/api/users/invitations', createUserInvitationsRouter(platformRepo, container, createEmailSender(), frontendUrl));
  app.use('/api/users',             createUsersRouter(platformRepo, container, createEmailSender(), frontendUrl));
  app.use('/api/roles',             createRolesRouter(platformRepo, container));
  app.use('/api/categories',        createCategoryRouter(container));
  app.use('/api/products', requireModule(container, ModuleKey.POS_RESTAURANTE), createProductsRouter(container));
  app.use('/api/orders',   requireModule(container, ModuleKey.POS_RESTAURANTE), createOrdersRouter(container));
  app.use('/api/waste-reasons', requireModule(container, ModuleKey.POS_RESTAURANTE), createWasteReasonsRouter(container));
  app.use('/api/bookable-services', createBookableServicesRouter(container));
  app.use('/api/business-hours',    createBusinessHoursRouter(container));
  // Montado ANTES de /api/business-profile a propósito: es más específico
  // (Express prueba routers en orden de registro, pero conviene no
  // depender de que el router menos específico no matchee el path por
  // casualidad).
  app.use('/api/business-profile/afip-credentials', createAfipCredentialsRouter(container));
  app.use('/api/business-profile',  createBusinessProfileRouter());
  app.use('/api/invoices',          createInvoicesRouter(container));
  app.use('/api/audit-log',         createAuditLogRouter());
  app.use(
    '/api/cash-register',
    requireModule(container, ModuleKey.CUENTAS_CORRIENTES),
    createCashRegisterRouter(container),
  );

  app.use(
    '/api/reports',
    requireModule(container, ModuleKey.REPORTES),
    (req: Request, _res: Response, next: NextFunction) => {
      const occupancyRepo = new SqlOccupancyRepository(req.db);
      const accountsReceivableRepo = new SqlAccountsReceivableRepository(req.db);
      const housekeepingRepo = new SqlHousekeepingRepository(req.db);
      // D7 (22/08/2026) — reportes POS/CRM.
      const orderRepo = new SqlOrderRepository(req.db);
      const stockMovementRepo = new SqlStockMovementRepository(req.db);
      const customerRepo = new SqlCustomerRepository(req.db);
      const reservationRepo = new SqlReservationRepository(req.db, new SqlResourceRepository(req.db));
      const reportService = new ReportService(
        occupancyRepo,
        accountsReceivableRepo,
        housekeepingRepo,
        orderRepo,
        stockMovementRepo,
        customerRepo,
        reservationRepo,
      );
      const router = createReportsRouter(reportService);
      router(req, _res, next);
    },
  );

  // Sin requireModule() a propósito — observabilidad de infraestructura,
  // no un módulo de negocio (mismo criterio que /api/audit-log).
  app.use(
    '/api/system',
    (req: Request, _res: Response, next: NextFunction) => {
      const domainEventRepo = new SqlDomainEventRepository(req.db);
      const router = createSystemRouter(domainEventRepo);
      router(req, _res, next);
    },
  );

  app.use(
    '/api/housekeeping',
    requireModule(container, ModuleKey.HOUSEKEEPING),
    (req: Request, _res: Response, next: NextFunction) => {
      const housekeepingRepo    = new SqlHousekeepingRepository(req.db);
      const housekeepingService = new HousekeepingService(housekeepingRepo);
      const resourceRepo    = new SqlResourceRepository(req.db);
      const reservationRepo = new SqlReservationRepository(req.db, resourceRepo);
      const router = createHousekeepingRouter(housekeepingService, reservationRepo);
      router(req, _res, next);
    },
  );

  app.use(
    '/api/maintenance-windows',
    requireModule(container, ModuleKey.HOUSEKEEPING),
    (req: Request, _res: Response, next: NextFunction) => {
      const maintenanceWindowRepo = new SqlMaintenanceWindowRepository(req.db);
      const resourceRepo    = new SqlResourceRepository(req.db);
      const reservationRepo = new SqlReservationRepository(req.db, resourceRepo);
      const businessProfileRepo = new SqlBusinessProfileRepository(req.db);
      const maintenanceWindowService = new MaintenanceWindowService(
        maintenanceWindowRepo,
        resourceRepo,
        reservationRepo,
        businessProfileRepo,
      );
      const router = createMaintenanceWindowsRouter(maintenanceWindowService);
      router(req, _res, next);
    },
  );

  app.use(
    '/api/stays',
    requireModule(container, ModuleKey.ALOJAMIENTO),
    (req: Request, _res: Response, next: NextFunction) => {
      const stayRepo        = new SqlStayRepository(req.db);
      const resourceRepo    = new SqlResourceRepository(req.db);
      const reservationRepo = new SqlReservationRepository(req.db, resourceRepo);
      const housekeepingRepo = new SqlHousekeepingRepository(req.db);
      const financialRepo   = new SqlFinancialTransactionRepository(req.db);
      const businessProfileRepo = new SqlBusinessProfileRepository(req.db);
      const stayService = new StayService(stayRepo, reservationRepo, housekeepingRepo, financialRepo, businessProfileRepo);

      const arService = new AccountsReceivableService(
        new SqlAccountsReceivableRepository(req.db),
        financialRepo,
        stayRepo,
        new SqlCustomerRepository(req.db),
        buildTenantTransactionManager(req),
        businessProfileRepo,
      );

      const router = createStaysRouter(stayService, arService);
      router(req, _res, next);
    },
  );

  app.use(
    '/api/accounts-receivable',
    requireModule(container, ModuleKey.CUENTAS_CORRIENTES),
    (req: Request, _res: Response, next: NextFunction) => {
      const arService = new AccountsReceivableService(
        new SqlAccountsReceivableRepository(req.db),
        new SqlFinancialTransactionRepository(req.db),
        new SqlStayRepository(req.db),
        new SqlCustomerRepository(req.db),
        buildTenantTransactionManager(req),
        new SqlBusinessProfileRepository(req.db),
      );
      const router = createAccountsReceivableRouter(arService);
      router(req, _res, next);
    },
  );

  // -------------------------------------------------------------------------
  // 17. Error handler — siempre al final
  // -------------------------------------------------------------------------
  app.use(errorHandler);

  return { app, container };
}

export interface GracefulShutdownOptions {
  onShutdown?: () => Promise<void>;
}

export function registerGracefulShutdown(
  server: http.Server,
  options: GracefulShutdownOptions = {},
): void {
  const { onShutdown } = options;

  const shutdown = async (signal: string) => {
    console.log(`\n[server] ${signal} recibido. Cerrando servidor...`);

    try { await stopAllWorkers(); }
    catch (err) { console.error('[server] Error al detener outbox workers:', err); }

    try { await stopCompanySyncWorker(); }
    catch (err) { console.error('[server] Error al detener el worker de propagación de empresas:', err); }

    if (onShutdown) {
      try { await onShutdown(); }
      catch (err) { console.error('[server] Error en onShutdown:', err); }
    }

    try { await closeTenantPools(); }
    catch (err) { console.error('[server] Error al cerrar tenant pools:', err); }

    try { await closePlatformPool(); }
    catch (err) { console.error('[server] Error al cerrar platform pool:', err); }

    server.close(() => {
      console.log('[server] Servidor cerrado correctamente.');
      process.exit(0);
    });

    setTimeout(() => {
      console.error('[server] Cierre forzado por timeout.');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT',  () => { void shutdown('SIGINT'); });
}
