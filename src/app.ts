/**
 * @file app.ts
 * @description Bootstrap de la aplicación Express — arquitectura multi-tenant.
 *
 * ## Orden de middlewares
 * 1.  trust proxy (Render/Cloudflare)
 * 2.  pino-http — log estructurado de cada request (1.1,
 *     docs/auditoria-tecnica-infra-reservas.md), antes de todo lo demás
 *     para que también quede loggeado un request frenado por el rate
 *     limiter o por helmet.
 * 3.  helmetBase — security headers globales (sin CSP, se aplica por ruta)
 * 4.  globalLimiter — baseline anti-DoS (500 req/min/IP)
 * 5.  cors, express.json
 * 6.  /health               — LIVENESS, no toca la base
 *     /health/db            — READINESS, chequea platformClient (cacheado)
 * 7.  /docs                 — helmetDocs (CSP permisiva para Swagger UI)
 *     /openapi.json         — helmetBase ya aplicado
 *     /  (redirect a /docs)
 *     ⚠️  Los tres se montan SOLO fuera de producción (api/docs-exposure.ts)
 * 9.  /platform/*           — helmetApi + platformLimiter (SUPERADMIN)
 * 10. POST /register        — helmetApi + authLimiter (público)
 * 11. POST /api/login       — helmetApi + authLimiter (público)
 * 12. /api/customer/*       — helmetApi (portal del cliente)
 * 13. authenticate()        — verifica JWT, protege /api/* restante
 * 14. /api/admin            — mantenimiento (ADMIN, SIN tenantMiddleware)
 *     ⚠️  Montado ANTES de tenantMiddleware a propósito: set-tenant-url
 *        necesita correr cuando la BD del tenant todavía no está activa.
 * 15. tenantMiddleware()    — inyecta req.db + arranca OutboxWorker por tenant
 * 16. apiLimiter            — 200 req/min/IP sobre /api/* autenticado
 * 17. /api/resources, /reservations, /reports, /customers, /users,
 *     /categories, /products, /service-items, /orders, /waste-reasons,
 *     /bookable-services, /housekeeping, /stays
 * 18. Sentry + errorHandler
 */

import express from 'express';
import cors    from 'cors';
import swaggerUi from 'swagger-ui-express';
import { pinoHttp } from 'pino-http';
import type http from 'node:http';
import * as Sentry from '@sentry/node';
import { ZodError } from 'zod';
import { DomainError, ValidationError } from './domain/errors.js';
import { logger, redactedReqSerializer } from './logger.js';

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
import { createServiceItemsRouter }      from './pos-menu/service-items.routes.js';
import { createWasteReasonsRouter }      from './pos-menu/waste-reasons.routes.js';
import { createConsumptionDestinationsRouter } from './pos-menu/consumption-destinations.routes.js';
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
import { createCreditNoteRequestsRouter } from './facturacion/credit-note-requests.routes.js';
import { createBusinessModulesRouter }   from './platform/business-modules.routes.js';
import { createBusinessPlanLimitsRouter } from './platform/business-plan-limits.routes.js';
import { createBusinessContextRouter }    from './platform/business-context.routes.js';
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
import { createAppContainer, createPlatformPool, closePlatformPool, buildPlatformTransactionManager } from './container.js';
import { checkDatabaseHealth }           from './db/pg.client.js';
import { CachedDbHealth }                from './db/health-cache.js';
import { shouldExposeApiDocs }           from './api/docs-exposure.js';
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
import { SqlInvoiceRepository }              from './facturacion/sql.invoice.repository.js';
import { SqlOrderRepository }                from './pos-menu/sql.order.repository.js';
import { SqlStockMovementRepository }        from './repositories/sql.stock-movement.repository.js';
import { buildTenantTransactionManager }     from './db/tenant-context.js';
import { stopAllWorkers }                from './workers/outbox.registry.js';
import { createEmailSender }             from './email/email.sender.js';
import { getCorsOriginSetting, getFrontendOrigin, getHealthDbTtlMs, getHealthDbFailTtlMs } from './config/env.js';
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
  // 2. pino-http — log estructurado de cada request/response (1.1). `req.id`
  //    autogenerado (entero incremental por proceso, NO un UUID -- corregido
  //    17/09/2026, gate `architecture-governor`: pino-http@11's
  //    reqIdGenFactory, logger.js:233-239) queda disponible como correlación
  //    en el resto de los logs de ese request si algún handler lo necesita.
  //
  //    D-02 (17/09/2026, Wave 8): `serializers.req` se pasa ACÁ ADEMÁS de
  //    en `logger.ts` -- `pino-http` arma su propio `req` serializer al
  //    crear el child logger de cada request (verificado contra
  //    pino-http@11, logger.js::wrapChild()) y lo prioriza sobre el de la
  //    instancia base si no se lo pasamos explícito acá. Sin esto, cada
  //    línea de tráfico seguiría emitiendo headers completos (Authorization,
  //    cookies) y la query string entera pese al redact/serializer de
  //    `logger.ts`. Misma función importada, no una copia.
  // -------------------------------------------------------------------------
  app.use(pinoHttp({ logger, serializers: { req: redactedReqSerializer } }));

  // -------------------------------------------------------------------------
  // 3. Helmet base — security headers globales, sin CSP.
  // -------------------------------------------------------------------------
  app.use(helmetBase);

  // -------------------------------------------------------------------------
  // 4. Global limiter — baseline anti-DoS.
  // -------------------------------------------------------------------------
  app.use(globalLimiter);

  // platformClient se crea UNA sola vez y se reutiliza en toda la app,
  // incluyendo el health check. Es el pool real de PLATFORM_DATABASE_URL.
  const platformClient = createPlatformPool();
  const platformRepo   = new PlatformRepository(platformClient, buildPlatformTransactionManager());
  const companyRepo    = new CompanyRepository(platformClient);

  const authService = new AuthService(platformRepo);
  const container   = await createAppContainer();

  // Empresas multipropiedad (17/08/2026) — único worker de propagación del
  // proceso, no por tenant (ver company-sync.registry.ts).
  startCompanySyncWorker(companyRepo, platformRepo);

  // -------------------------------------------------------------------------
  // 5. CORS + body parser
  // -------------------------------------------------------------------------
  const corsOrigin = getCorsOriginSetting();

  // Base para links que mandamos por mail (invitación de usuarios, D2) —
  // reusa CORS_ORIGIN ("dominio del frontend", ver render.yaml) en vez de
  // sumar una segunda variable de entorno con el mismo dominio adentro.
  // `'*'` (dev sin CORS_ORIGIN seteada) no es una URL real, así que cae al
  // puerto default de Next.js en local.
  const frontendUrl = getFrontendOrigin();

  app.use(cors({
    origin:         corsOrigin,
    methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));
  app.use(express.json());

  // -------------------------------------------------------------------------
  // 6. Salud del servicio.
  //
  //    Historia previa, conservada porque explica de dónde viene el uso de
  //    platformClient: el chequeo usaba el pool interno de pg.client.ts
  //    (DATABASE_URL legacy), que no está seteada en Render y por eso siempre
  //    devolvía db:"error". Se corrigió a platformClient
  //    (PLATFORM_DATABASE_URL) y ese sigue siendo el pool que se consulta —
  //    ahora desde /health/db, no desde /health.
  // -------------------------------------------------------------------------
  // /health         — LIVENESS. No toca la base. Es el `healthCheckPath` de
  //                   render.yaml y el destino del bot que mantiene despierto
  //                   el servicio: un ping acá ya no despierta Neon.
  // /health/db      — READINESS. Chequea la base, con caché de TTL corto y
  //                   single-flight (ver db/health-cache.ts). 503 si no
  //                   responde. `?fresh=1` fuerza consulta real.
  //
  // Se separan a propósito: antes un solo endpoint devolvía `status: 'ok'`
  // junto con `db: 'error'` — dos afirmaciones contradictorias en la misma
  // respuesta, y con 200 en las dos. "El proceso está vivo" y "la base
  // responde" son preguntas distintas y ahora tienen respuestas distintas.
  //
  // `/health` NUNCA devuelve 503 por un problema de base: Render lo usa como
  // health check y reiniciaría el servicio por una caída de Neon que el
  // proceso no puede resolver reiniciándose.
  const dbHealth = new CachedDbHealth(() => checkDatabaseHealth(platformClient), {
    okTtlMs:   getHealthDbTtlMs(),
    failTtlMs: getHealthDbFailTtlMs(),
  });

  app.get('/health', (_req, res) => {
    res.json({
      status:        'ok',
      mode:          'multi-tenant',
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  app.get('/health/db', async (req, res) => {
    const snapshot = await dbHealth.get({ fresh: req.query['fresh'] === '1' });
    res.status(snapshot.ok ? 200 : 503).json({
      db:        snapshot.ok ? 'connected' : 'error',
      checkedAt: new Date(snapshot.checkedAt).toISOString(),
      ageMs:     snapshot.ageMs,
      cached:    snapshot.cached,
    });
  });

  // Documentación interactiva — NO se monta en producción (ver
  // api/docs-exposure.ts para el porqué y las alternativas descartadas).
  // Sin montar, Express responde 404 por sí solo: un 401 confirmaría que el
  // recurso existe.
  if (shouldExposeApiDocs()) {
    app.get('/', (_req, res) => res.redirect('/docs'));
    app.get('/openapi.json', (_req, res) => res.json(openApiSpec));

    // /docs — CSP permisiva para que Swagger UI cargue sus assets de CDN
    app.use('/docs', helmetDocs, swaggerUi.serve, swaggerUi.setup(openApiSpec, {
      customSiteTitle: 'Reservations API',
      swaggerOptions:  { persistAuthorization: true, docExpansion: 'list', filter: true },
    }));
  } else {
    // Ruidoso a propósito: que no se monte tiene que verse en el boot, no
    // deducirse de un 404 (DEFENSIVE_DEVELOPING.md:33).
    logger.info('[docs] /docs, /openapi.json y el redirect de / NO se montan (NODE_ENV=production)');
  }

  // -------------------------------------------------------------------------
  // 9. /platform/* — helmetApi (CSP estricta) + platformLimiter
  // -------------------------------------------------------------------------
  const platformContainer = createPlatformContainer();
  app.use('/platform', ...helmetApi, platformLimiter, createPlatformRouter(platformContainer));

  // -------------------------------------------------------------------------
  // 10-11. /register + /api/login — helmetApi + authLimiter (anti brute-force)
  // -------------------------------------------------------------------------
  app.use('/register',  ...helmetApi, authLimiter, createBusinessRouter(platformRepo));
  app.use('/api/login', ...helmetApi, authLimiter, createAuthRouter(authService));

  // -------------------------------------------------------------------------
  // 12. /api/customer — portal del cliente
  // -------------------------------------------------------------------------
  app.use('/api/customer', createCustomerRouter(container, platformRepo));

  // -------------------------------------------------------------------------
  // 13. helmetApi sobre todo /api/* — cubre customer, admin y rutas de tenant.
  // -------------------------------------------------------------------------
  app.use('/api', ...helmetApi);

  // /api/admin — ANTES del authenticate() de tenant de más abajo (19/08/2026,
  // auditoría de producto: set-tenant-url estaba detrás de
  // Roles.MANAGEMENT de TENANT, es decir cualquier OWNER/ADMIN de cualquier
  // negocio podía reapuntar su propia BD, incluso a una URL
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
  // 15. tenantMiddleware — inyecta req.db + arranca OutboxWorker por tenant
  // -------------------------------------------------------------------------
  app.use('/api', tenantMiddleware(platformRepo));

  // -------------------------------------------------------------------------
  // 16. apiLimiter — después de autenticación y resolución de tenant
  // -------------------------------------------------------------------------
  app.use('/api', apiLimiter);

  // -------------------------------------------------------------------------
  // 17. Rutas protegidas de empleados (todas usan req.db del tenant)
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
  app.use('/api/service-items', requireModule(container, ModuleKey.POS_RESTAURANTE), createServiceItemsRouter(container));
  app.use('/api/orders',   requireModule(container, ModuleKey.POS_RESTAURANTE), createOrdersRouter(container));
  app.use('/api/waste-reasons', requireModule(container, ModuleKey.POS_RESTAURANTE), createWasteReasonsRouter(container));
  app.use('/api/consumption-destinations', requireModule(container, ModuleKey.POS_RESTAURANTE), createConsumptionDestinationsRouter(container));
  app.use('/api/bookable-services', createBookableServicesRouter(container));
  app.use('/api/business-hours',    createBusinessHoursRouter(container));
  // Montado ANTES de /api/business-profile a propósito: es más específico
  // (Express prueba routers en orden de registro, pero conviene no
  // depender de que el router menos específico no matchee el path por
  // casualidad).
  app.use('/api/business-profile/afip-credentials', createAfipCredentialsRouter(container));
  app.use('/api/business-profile',  createBusinessProfileRouter());
  // /api/business/context — Fase 4 Bloque 4B. Va ACÁ (post-tenantMiddleware +
  // apiLimiter) porque necesita req.db para business_profile, a diferencia de
  // /api/business/modules y /api/business/plan-limits (pre-tenant). authorize
  // (Roles.STAFF) vive dentro del router.
  app.use('/api/business/context', createBusinessContextRouter(platformRepo));
  app.use('/api/invoices',          createInvoicesRouter(container));
  // Bloque 5 del ADR común cancelar-con-NC (15/09/2026, §6.5 bis) -- bandeja
  // de reconciliación manual, mismo módulo `facturacion`, montada junto a
  // /api/invoices (mismo criterio de posición: después del gate de tenant
  // de más arriba en este archivo).
  app.use('/api/credit-note-requests', createCreditNoteRequestsRouter(container));
  app.use('/api/audit-log',         createAuditLogRouter(platformRepo));
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
      const maintenanceWindowRepo = new SqlMaintenanceWindowRepository(req.db);
      const businessProfileRepo = new SqlBusinessProfileRepository(req.db);
      // D7 (22/08/2026) — reportes POS/CRM.
      const orderRepo = new SqlOrderRepository(req.db);
      const stockMovementRepo = new SqlStockMovementRepository(req.db);
      const customerRepo = new SqlCustomerRepository(req.db);
      const reservationRepo = new SqlReservationRepository(req.db, new SqlResourceRepository(req.db));
      const reportService = new ReportService(
        occupancyRepo,
        accountsReceivableRepo,
        maintenanceWindowRepo,
        businessProfileRepo,
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
      const businessProfileRepo = new SqlBusinessProfileRepository(req.db);
      const housekeepingService = new HousekeepingService(housekeepingRepo, businessProfileRepo);
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
        // D-03 (15/09/2026) — TransactionManager del TENANT (mismo builder
        // que StayService/AccountsReceivableService más abajo), para que
        // el INSERT de la ventana + el UPDATE de needs_maintenance_review
        // sean atómicos.
        buildTenantTransactionManager(req),
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
      // Bug 5 (11/09/2026) — TransactionManager del TENANT (A2.8: mismo
      // pool cacheado que `req.db`, no el de plataforma), para que
      // StayService pueda envolver sus 3 cambios de horario en una
      // transacción real. Mismo builder que ya usa `arService` dos líneas
      // más abajo.
      const stayService = new StayService(
        stayRepo, reservationRepo, housekeepingRepo, financialRepo, businessProfileRepo,
        buildTenantTransactionManager(req),
      );

      const arService = new AccountsReceivableService(
        new SqlAccountsReceivableRepository(req.db),
        financialRepo,
        stayRepo,
        new SqlCustomerRepository(req.db),
        buildTenantTransactionManager(req),
        businessProfileRepo,
        new SqlInvoiceRepository(req.db),
        reservationRepo,
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
        new SqlInvoiceRepository(req.db),
        new SqlReservationRepository(req.db, new SqlResourceRepository(req.db)),
      );
      const router = createAccountsReceivableRouter(arService);
      router(req, _res, next);
    },
  );

  // -------------------------------------------------------------------------
  // 18. Sentry + error handler — siempre al final
  // shouldHandleError filtra los errores esperados del negocio (ya se
  // mapean a su propio status en error.middleware.ts, no son bugs) --
  // sin esto, Sentry se llenaría de "ruido" tipo RESOURCE_NOT_FOUND (404)
  // o VALIDATION_ERROR (400) y taparía los errores 500 genuinos.
  // -------------------------------------------------------------------------
  Sentry.setupExpressErrorHandler(app, {
    shouldHandleError: (err) =>
      !(err instanceof DomainError) &&
      !(err instanceof ValidationError) &&
      !(err instanceof ZodError),
  });
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
    logger.info({ signal }, 'Señal recibida. Cerrando servidor...');

    try { await stopAllWorkers(); }
    catch (err) { logger.error({ err }, 'Error al detener outbox workers'); }

    try { await stopCompanySyncWorker(); }
    catch (err) { logger.error({ err }, 'Error al detener el worker de propagación de empresas'); }

    if (onShutdown) {
      try { await onShutdown(); }
      catch (err) { logger.error({ err }, 'Error en onShutdown'); }
    }

    try { await closeTenantPools(); }
    catch (err) { logger.error({ err }, 'Error al cerrar tenant pools'); }

    try { await closePlatformPool(); }
    catch (err) { logger.error({ err }, 'Error al cerrar platform pool'); }

    server.close(() => {
      logger.info('Servidor cerrado correctamente.');
      process.exit(0);
    });

    setTimeout(() => {
      logger.error('Cierre forzado por timeout.');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT',  () => { void shutdown('SIGINT'); });
}
