/**
 * @file invoices.routes.ts
 * @description Facturación electrónica AFIP (Fase 2, WSFEv1 real).
 *
 * GET  /api/business-profile/afip-credentials/status — MANAGEMENT (nunca
 *      devuelve el cert/clave, solo si está configurado y en qué ambiente;
 *      queda en MANAGEMENT a propósito -- decisión F2-06 de
 *      `docs/decisiones-auditoria-fase2-2026-09-15.md` #1 solo escaló
 *      PUT/DELETE, ver docblock de `createAfipCredentialsRouter` más abajo)
 * PUT  /api/business-profile/afip-credentials        — OWNER_ONLY (15/09/2026,
 *      F2-06 -- antes MANAGEMENT, ver docblock de `createAfipCredentialsRouter`)
 * DELETE /api/business-profile/afip-credentials      — OWNER_ONLY (ídem PUT)
 *
 * POST /api/invoices          — FRONT_DESK (pedir el CAE de un cobro ya existente);
 *      si el cargo pertenece a un cliente kind='COMPANY' exige ADEMÁS
 *      MANAGEMENT, chequeo inline en el handler (13/09/2026,
 *      `INVOICE-CHARGES-GUARD-INDIVIDUAL-01` hallazgo 3, ver
 *      `requireManagementForCompanyCharge()` más abajo) — NO aplica si el
 *      cargo es REFUND/ADJUSTMENT (Nota de Crédito del escape de
 *      cancelación, decisión separada del dueño: sigue alcanzando con
 *      `Roles.EMISOR_NOTA_CREDITO`).
 * GET  /api/invoices/unreconciled — FRONT_DESK (10/09/2026, bandeja "factura
 *      viva no conciliada" -- ver InvoiceRepository.listUnreconciledLiveInvoices().
 *      Registrada ANTES de /:id, no la muevas después)
 * GET  /api/invoices/uncertain — MANAGEMENT (23/09/2026, ADR
 *      `ISSUE-BEFORE-REVERSE-WINDOW-001` Bloque 3, §3.9 -- bandeja nueva de
 *      facturas `FAILED_UNCERTAIN` sin resolver, ver
 *      InvoiceRepository.listUncertainInvoices(). Registrada ANTES de
 *      /:id, mismo motivo que /unreconciled)
 * GET  /api/invoices/:id      — FRONT_DESK
 * GET  /api/invoices?financialTransactionId=... — FRONT_DESK
 * GET  /api/invoices?customerId=...              — FRONT_DESK (O2-F2, F2.2 --
 *      todas las facturas de un cliente, cualquier status; antes no existía
 *      ningún endpoint que listara las consolidadas de un cliente)
 * GET  /api/invoices?status=...                  — FRONT_DESK (B3 bloque 2.1,
 *      08/09/2026 -- localizar un caso trabado sin conocer de antemano su
 *      financialTransactionId/customerId; NO es la bandeja completa de B3,
 *      ver docblock de InvoiceRepository.getByStatus())
 * POST /api/invoices/:id/mark-not-issued — EMISOR_NOTA_CREDITO (23/09/2026,
 *      ADR Bloque 3, §3.9 -- mismo efecto que
 *      resolveCreditNoteRequestManually() con outcome NO_EMITIDA, pero SIN
 *      credit_note_request involucrada (CHARGE, o NC con solicitud ya
 *      CERRADA). Rechaza con InvoiceHasOpenCreditNoteRequestError (409) si
 *      la factura tiene una credit_note_request propia todavía ABIERTA --
 *      esa combinación va por POST /credit-note-requests/:id/resolve)
 * POST /api/invoices/:id/reconcile-with-afip — EMISOR_NOTA_CREDITO
 *      (23/09/2026, ADR Bloque 3, §3.14, P-1 -- decisión del dueño
 *      "Reconciliar contra AFIP": consulta el comprobante real contra AFIP
 *      mismo en vez de que el operador tipee un CAE a mano. Mismo grupo que
 *      el resto de esta bandeja, por consistencia operativa -- decisión del
 *      dueño, ver el encabezado del ADR)
 *
 * `requireModule(ModuleKey.FACTURACION)` gatea las MUTACIONES (POST /,
 * POST /consolidated) y el router de credenciales AFIP. Los GET de
 * `/api/invoices/*` van SIN gate a propósito: leer un comprobante fiscal ya
 * emitido es una obligación legal de exhibición/retención
 * (`docs/criterios-datos.md` línea 24 — un DOCUMENTO "jamás" se borra) y no
 * puede quedar detrás de un entitlement revocable. Ver
 * docs/diseno-cascada-enforcement-2026-08-30.md §3d.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { authorize } from '../security/auth.middleware.js';
import { Roles } from '../security/roles.js';
import { requireModule } from '../security/module.middleware.js';
import { ModuleKey } from '../types/enums.js';
import type { AppContainer } from '../container.js';
import { SqlAfipCredentialsRepository } from './sql.afip-credentials.repository.js';
import { AfipCredentialsService } from './afip-credentials.service.js';
import { SqlInvoiceRepository } from './sql.invoice.repository.js';
import { InvoiceService } from './invoice.service.js';
import { InvoicePdfService } from './invoice-pdf.service.js';
import { SqlFinancialTransactionRepository } from '../clientes-finanzas/sql.financial-transaction.repository.js';
import type { FinancialTransactionRepository } from '../clientes-finanzas/financial-transaction.repository.js';
import { SqlBusinessProfileRepository } from '../repositories/sql.business-profile.repository.js';
import { SqlCustomerRepository } from '../clientes-finanzas/sql.customer.repository.js';
import type { CustomerRepository } from '../clientes-finanzas/customer.repository.js';
import { SqlOrderRepository } from '../pos-menu/sql.order.repository.js';
import { SqlProductRepository, SqlProductVariantRepository } from '../pos-menu/sql.product.repository.js';
import { SqlReservationRepository } from '../reservas/sql.reservation.repository.js';
import { SqlResourceRepository } from '../reservas/sql.resource.repository.js';
import { SqlServiceItemRepository } from '../pos-menu/sql.service-item.repository.js';
import { SqlCreditNoteRequestRepository } from './sql.credit-note-request.repository.js';
import { buildTenantTransactionManager } from '../db/tenant-context.js';
import { SaveAfipCredentialsSchema, RequestInvoiceSchema, RequestConsolidatedInvoiceSchema, ReconcileInvoiceWithAfipSchema } from '../api/schemas/facturacion.schemas.js';
import { SqlAccountsReceivableRepository } from '../clientes-finanzas/sql.accounts-receivable.repository.js';
import { SqlAuditLogRepository } from '../repositories/audit-log.repository.js';
import type { InvoiceStatus } from './invoice.entities.js';
import { cbteTipoLabel } from './afip-catalog.constants.js';

/** B3 bloque 2.1 -- únicos valores válidos de `invoices.status` (invoice.entities.ts). */
const VALID_INVOICE_STATUSES: readonly InvoiceStatus[] = ['PENDING', 'ISSUED', 'REJECTED', 'FAILED_UNCERTAIN'];

/**
 * Composition root del `InvoiceService` por request (desde `req.db` del
 * tenant activo). Exportada (07/09/2026) para que `orders.routes.ts` la reuse
 * al cablear el orquestador `CancelOrderWithCreditNoteService` (sub-bloque 4
 * del ADR común cancelar-con-NC) — construir los ~11 `Sql*Repository` a mano
 * en dos lugares es exactamente lo que rota. Ambos archivos son `*.routes.ts`
 * (composition roots, exceptuados de `no-repo-concreto-de-otro-dominio`).
 */
export function buildInvoiceService(req: Request): InvoiceService {
  const db = req.db!;
  return new InvoiceService(
    new SqlInvoiceRepository(db),
    new SqlFinancialTransactionRepository(db),
    new SqlBusinessProfileRepository(db),
    new SqlAfipCredentialsRepository(db),
    new SqlOrderRepository(db),
    new SqlProductRepository(db),
    new SqlProductVariantRepository(db),
    new SqlReservationRepository(db, new SqlResourceRepository(db)),
    buildTenantTransactionManager(req),
    // C1-Fase C (23/08/2026) -- cierra el gap FacturarButton/accounts_receivable
    // y resuelve los cargos pendientes de "Facturar ahora".
    new SqlAccountsReceivableRepository(db),
    // I9 (24/08/2026) -- quién pidió cada comprobante, ver docblock del
    // constructor de InvoiceService.
    new SqlAuditLogRepository(db),
    // Bloque D de `service_items` (15/09/2026) -- resuelve nombre/
    // descripción de una línea de factura SERVICE, ver docblock del
    // constructor de InvoiceService.
    new SqlServiceItemRepository(db),
    // Bloque 3 del ADR común cancelar-con-NC (15/09/2026) -- INSERT de
    // credit_note_request dentro de buildCreditNote(), ver docblock del
    // constructor de InvoiceService.
    new SqlCreditNoteRequestRepository(db),
  );
}

/**
 * Hallazgo 3 de `INVOICE-CHARGES-GUARD-INDIVIDUAL-01` (13/09/2026, gate
 * `architecture-governor`, decisión del dueño vía `AskUserQuestion`):
 * facturar individualmente un cargo de un cliente EMPRESA es una decisión
 * de facturación corporate -- mismo criterio que ya usan
 * transfer-to-receivable/mark-invoiced/mark-collected/consolidated (todos
 * `Roles.MANAGEMENT`, ver `docs/rbac-matriz-endpoints.md`). Un cliente
 * INDIVIDUAL sigue siendo `Roles.FRONT_DESK` (operación de mostrador
 * normal, sin cambios).
 *
 * **Acotado a Factura, a propósito (decisión separada del dueño,
 * 13/09/2026):** NO aplica si `tx.type` es `REFUND`/`ADJUSTMENT` -- ese es
 * el fork de Nota de Crédito del escape de cancelación
 * (`invoice.service.ts:402`), que ya tiene su propio rol dedicado
 * (`Roles.EMISOR_NOTA_CREDITO`, deliberadamente por debajo de `MANAGEMENT`,
 * `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` §10 q7,
 * con grounding ERP). Este guard no reabre esa decisión -- si el fork de
 * `invoice.service.ts:402` cambia de forma, revisar este predicado también.
 *
 * Función inline llamada a mano en el handler (NO middleware): necesita el
 * body ya parseado por Zod para saber a qué cargo se refiere, antes de
 * poder resolver a qué cliente pertenece. Mismo patrón que el
 * `overrideHousekeeping`/`overridePendingBalance` de `stays.routes.ts`
 * (elevación condicional a MANAGEMENT, 403 explícito), con el estilo de
 * lookup-y-responder-uno-mismo de `requireOwnReservation()`
 * (`api/routes/customer.routes.ts`). Un middleware Express nuevo en la
 * cadena rompería la cerca `invoices.routes.test.ts` que cuenta
 * `route.stack.length === 3` ("gate + authorize + handler") para los 2 POST.
 */
export async function requireManagementForCompanyCharge(
  financialTransactionId: string,
  financialTransactionRepo: Pick<FinancialTransactionRepository, 'getById'>,
  customerRepo: Pick<CustomerRepository, 'getById'>,
  req: Request,
  res: Response,
): Promise<boolean> {
  const tx = await financialTransactionRepo.getById(financialTransactionId);
  // No encontrado: no es este guard el que decide el 404 -- requestInvoice()
  // ya lanza FinancialTransactionNotFoundError (invoice.service.ts:377) más
  // adelante en el mismo handler. Dejar pasar.
  if (!tx) return true;

  if (tx.type === 'REFUND' || tx.type === 'ADJUSTMENT') return true;

  const customer = await customerRepo.getById(tx.customerId);
  // `financial_transactions.customer_id` es `NOT NULL REFERENCES
  // customers(id)` (schema.sql, columna `customer_id` de la tabla
  // `financial_transactions`) -- un cargo sin cliente resoluble es
  // inalcanzable hoy en producción. Fail-CLOSED de todos modos (no un `?.`
  // mudo que deje pasar en silencio): si esa garantía alguna vez se rompe,
  // mejor un 403 ruidoso que facturar sin poder confirmar a quién.
  if (!customer) {
    res.status(403).json({
      code: 'FORBIDDEN',
      message: 'No se pudo resolver el cliente de este cargo -- no se puede confirmar el permiso requerido.',
    });
    return false;
  }
  if (customer.kind !== 'COMPANY') return true;

  const allowed = (req.user!.permissionGroups ?? []).includes(Roles.MANAGEMENT);
  if (!allowed) {
    res.status(403).json({
      code: 'FORBIDDEN',
      message: 'Facturar individualmente un cargo de un cliente empresa es una decisión de facturación corporate -- solo un encargado puede hacerlo.',
    });
    return false;
  }
  return true;
}

export function createInvoicesRouter(container: AppContainer): Router {
  const router = Router();
  const gate = requireModule(container, ModuleKey.FACTURACION);

  // ── POST /api/invoices ───────────────────────────────────────────────────
  router.post(
    '/',
    gate,
    authorize(Roles.FRONT_DESK),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = RequestInvoiceSchema.parse(req.body);

        const allowed = await requireManagementForCompanyCharge(
          body.financialTransactionId,
          new SqlFinancialTransactionRepository(req.db!),
          new SqlCustomerRepository(req.db!),
          req,
          res,
        );
        if (!allowed) return;

        const invoice = await buildInvoiceService(req).requestInvoice({
          businessId: req.user!.businessId!,
          financialTransactionId: body.financialTransactionId,
          changedBy: req.user!.id,
          ...(body.buyer !== undefined && { buyer: body.buyer }),
          ...(body.concepto !== undefined && { concepto: body.concepto }),
        });
        res.status(201).json(invoice);
      } catch (err) { next(err); }
    },
  );

  // ── POST /api/invoices/consolidated ─────────────────────────────────────
  // C1-Fase C (23/08/2026) -- "Facturar ahora": un comprobante cubriendo
  // TODO lo PENDIENTE_FACTURAR de una empresa en este momento. Solo
  // MANAGEMENT -- mismo criterio que transfer-to-receivable/mark-invoiced/
  // mark-collected (stays.routes.ts / accounts-receivable.routes.ts): es
  // una decisión de facturación corporate, no una operación de mostrador.
  router.post(
    '/consolidated',
    gate,
    authorize(Roles.MANAGEMENT),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = RequestConsolidatedInvoiceSchema.parse(req.body);
        const invoice = await buildInvoiceService(req).requestConsolidatedInvoice({
          businessId: req.user!.businessId!,
          companyCustomerId: body.companyCustomerId,
          changedBy: req.user!.id,
          ...(body.buyer !== undefined && { buyer: body.buyer }),
          ...(body.concepto !== undefined && { concepto: body.concepto }),
        });
        res.status(201).json(invoice);
      } catch (err) { next(err); }
    },
  );

  // ── GET /api/invoices/unreconciled ──────────────────────────────────────
  // Bandeja "factura viva no conciliada" (10/09/2026, gate
  // `architecture-governor`) -- NO es `credit_note_request` (esa tabla
  // sigue en HOLD). Ver el docblock de `InvoiceRepository.listUnreconciledLiveInvoices()`
  // y de `UnreconciledLiveInvoice` para el mecanismo completo. Registrada
  // ANTES de `/:id` a propósito -- si fuera después, Express matchearía
  // `unreconciled` como un `:id` y esta ruta quedaría inalcanzable, sin
  // ningún error visible (`GET /api/invoices/unreconciled` devolvería
  // 404 `INVOICE_NOT_FOUND`, no la lista).
  router.get(
    '/unreconciled',
    authorize(Roles.FRONT_DESK),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const list = await new SqlInvoiceRepository(req.db!).listUnreconciledLiveInvoices(req.db!);
        res.json(list);
      } catch (err) { next(err); }
    },
  );

  // ── GET /api/invoices/uncertain ──────────────────────────────────────────
  // ADR ISSUE-BEFORE-REVERSE-WINDOW-001 (23/09/2026), Bloque 3, §3.9 --
  // bandeja nueva, ver InvoiceRepository.listUncertainInvoices(). RBAC
  // MANAGEMENT (decisión del dueño, mismo criterio que el reporte (d) de
  // §3.10 -- ambos exponen estado de facturación sin reconciliar).
  // Registrada ANTES de /:id, mismo motivo que /unreconciled.
  router.get(
    '/uncertain',
    authorize(Roles.MANAGEMENT),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const list = await new SqlInvoiceRepository(req.db!).listUncertainInvoices();
        res.json(list);
      } catch (err) { next(err); }
    },
  );

  // ── GET /api/invoices/:id ─────────────────────────────────────────────────
  router.get(
    '/:id',
    authorize(Roles.FRONT_DESK),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const invoice = await new SqlInvoiceRepository(req.db!).getById(String(req.params['id']));
        if (!invoice) {
          res.status(404).json({ code: 'INVOICE_NOT_FOUND', message: 'Comprobante no encontrado' });
          return;
        }
        res.json(invoice);
      } catch (err) { next(err); }
    },
  );

  // ── GET /api/invoices/:id/pdf ────────────────────────────────────────────
  // PDF oficial (@arcasdk/pdf, Puppeteer) del comprobante ya emitido -- ver
  // docblock de InvoicePdfService para las simplificaciones de este corte.
  router.get(
    '/:id/pdf',
    authorize(Roles.FRONT_DESK),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const db = req.db!;
        const pdfService = new InvoicePdfService(
          new SqlInvoiceRepository(db),
          new SqlBusinessProfileRepository(db),
          new SqlCustomerRepository(db),
        );
        const id = String(req.params['id']);
        const pdf = await pdfService.generate(id);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="comprobante-${id}.pdf"`);
        res.send(pdf);
      } catch (err) { next(err); }
    },
  );

  // ── POST /api/invoices/:id/mark-not-issued ──────────────────────────────
  // ADR ISSUE-BEFORE-REVERSE-WINDOW-001 (23/09/2026), Bloque 3, §3.9 -- ver
  // docblock del archivo y de InvoiceService.markInvoiceNotIssued().
  router.post(
    '/:id/mark-not-issued',
    authorize(Roles.EMISOR_NOTA_CREDITO),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const invoice = await buildInvoiceService(req).markInvoiceNotIssued({
          invoiceId: String(req.params['id']),
          resolvedBy: req.user!.id,
        });
        res.json(invoice);
      } catch (err) { next(err); }
    },
  );

  // ── POST /api/invoices/:id/reconcile-with-afip ──────────────────────────
  // ADR ISSUE-BEFORE-REVERSE-WINDOW-001 (23/09/2026), Bloque 3, §3.14 (P-1)
  // -- ver docblock del archivo y de InvoiceService.reconcileWithAfip().
  router.post(
    '/:id/reconcile-with-afip',
    authorize(Roles.EMISOR_NOTA_CREDITO),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = ReconcileInvoiceWithAfipSchema.parse(req.body);
        const invoice = await buildInvoiceService(req).reconcileWithAfip({
          invoiceId: String(req.params['id']),
          cbteNro: body.cbteNro,
          resolvedBy: req.user!.id,
        });
        res.json(invoice);
      } catch (err) { next(err); }
    },
  );

  // ── GET /api/invoices?financialTransactionId=...  |  ?customerId=... ───────
  router.get(
    '/',
    authorize(Roles.FRONT_DESK),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const financialTransactionId = req.query['financialTransactionId'];
        const customerId = req.query['customerId'];

        if (typeof financialTransactionId === 'string' && financialTransactionId) {
          const invoices = await new SqlInvoiceRepository(req.db!).getByFinancialTransactionId(financialTransactionId);
          res.json(invoices);
          return;
        }

        // O2-F2 (03/09/2026, F2.2) -- todas las facturas de un cliente,
        // cualquier status. No verifica pertenencia de businessId acá porque
        // el aislamiento ya es físico (una BD por negocio, req.db) -- A2.8.
        // `cbteTipoLabel` (11/09/2026, INVOICE-CHARGES-FACTURACION-SCREEN-01)
        // -- SOLO esta rama la agrega, es la única que alimenta la pantalla
        // "Facturación" del panel. Las otras respuestas de este archivo
        // (`:152`, `:168`, `:207`, `:231`) quedan sin tocar a propósito.
        if (typeof customerId === 'string' && customerId) {
          const invoices = await new SqlInvoiceRepository(req.db!).getByCustomerId(customerId);
          res.json(invoices.map((inv) => ({ ...inv, cbteTipoLabel: cbteTipoLabel(inv.cbteTipo) })));
          return;
        }

        // B3 bloque 2.1 (08/09/2026) -- localizar un caso trabado sin
        // financialTransactionId/customerId de antemano (D1 del ADR común
        // cancelar-con-NC). Mismo criterio de aislamiento que arriba: sin
        // filtro de businessId, la tenant DB ya lo garantiza.
        const status = req.query['status'];
        if (typeof status === 'string' && status) {
          if (!VALID_INVOICE_STATUSES.includes(status as InvoiceStatus)) {
            res.status(400).json({ code: 'VALIDATION_ERROR', message: `status inválido: ${status}` });
            return;
          }
          const invoices = await new SqlInvoiceRepository(req.db!).getByStatus(status as InvoiceStatus);
          res.json(invoices);
          return;
        }

        res.status(400).json({ code: 'VALIDATION_ERROR', message: 'financialTransactionId, customerId o status es obligatorio' });
      } catch (err) { next(err); }
    },
  );

  return router;
}

/**
 * Router aparte porque cuelga de `/api/business-profile`, no de
 * `/api/invoices` — mismo negocio (config del emisor), pero un secreto,
 * no un dato del perfil que ya viaja entero por `GET /api/business-profile`.
 *
 * **F2-06 (15/09/2026, `docs/decisiones-auditoria-fase2-2026-09-15.md` #1):**
 * PUT/DELETE (guardar/borrar el certificado y la clave privada) pasan de
 * `MANAGEMENT` a `OWNER_ONLY` -- mismo nivel que el candado que ya protege
 * el resto del perfil fiscal una vez cargado el CUIT
 * (`business-profile.service.ts::FISCAL_PROFILE_LOCKED`). GET `/status`
 * queda en `MANAGEMENT` a propósito: el handler solo devuelve
 * `{ configured, environment }` (`AfipCredentialsStatus`) -- nunca el
 * cert/clave, ni cifrados -- así que no hay secreto que proteger con un
 * rol más alto, es lectura pura del mismo tipo que ya es seguro exponer
 * por `GET /api/business-profile` completo.
 *
 * **F2-05 (mismo commit):** PUT/DELETE dejan de construir
 * `SqlAfipCredentialsRepository` a mano y usan `AfipCredentialsService`
 * (`afip-credentials.service.ts`), que envuelve el UPDATE de
 * `business_profile` + el DELETE de `afip_tickets` en una sola transacción
 * (`buildTenantTransactionManager(req)`, ya se construye en este mismo
 * archivo para `buildInvoiceService()`) y deja rastro en `audit_log` del
 * HECHO del cambio (nunca el valor del secreto) -- ver docblock del
 * servicio para el detalle de qué se audita.
 */
export function createAfipCredentialsRouter(container: AppContainer): Router {
  const router = Router();
  const gate = requireModule(container, ModuleKey.FACTURACION);

  router.get(
    '/status',
    gate,
    authorize(Roles.MANAGEMENT),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const status = await new SqlAfipCredentialsRepository(req.db!).getStatus();
        res.json(status);
      } catch (err) { next(err); }
    },
  );

  router.put(
    '/',
    gate,
    authorize(Roles.OWNER_ONLY),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = SaveAfipCredentialsSchema.parse(req.body);
        const repo = new SqlAfipCredentialsRepository(req.db!);
        const service = new AfipCredentialsService(repo, new SqlAuditLogRepository(req.db!), buildTenantTransactionManager(req));
        const status = await service.save(body.cert, body.key, body.environment, req.user!.id);
        res.json(status);
      } catch (err) { next(err); }
    },
  );

  router.delete(
    '/',
    gate,
    authorize(Roles.OWNER_ONLY),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const repo = new SqlAfipCredentialsRepository(req.db!);
        const service = new AfipCredentialsService(repo, new SqlAuditLogRepository(req.db!), buildTenantTransactionManager(req));
        await service.clear(req.user!.id);
        res.status(204).send();
      } catch (err) { next(err); }
    },
  );

  return router;
}
