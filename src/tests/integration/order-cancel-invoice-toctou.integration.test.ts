/**
 * @file order-cancel-invoice-toctou.integration.test.ts
 * @description ORDER-10 (05/09/2026, docs/diseno-cancelacion-orden-nota-credito-2026-09-05.md)
 * -- verifica, contra Postgres real y con conexiones separadas de verdad
 * (no un solo `await` tras otro), que `OrderService.cancelOrder()` y
 * `InvoiceService.requestInvoice()` no pueden entrelazarse para dejar una
 * Factura B real (CAE de AFIP) emitida sobre una orden CANCELLED sin
 * contrapartida.
 *
 * Antes de este bloque, el guard de `cancelOrder()`
 * (`findBlockingInvoiceLinkage()`, ver `OrderChargeInvoicedError`) sólo
 * miraba SI YA HABÍA una factura al momento de cancelar -- pero
 * `requestInvoice()` nunca miraba el estado de la orden. Dos llamadas
 * concurrentes sobre la MISMA orden (una cancelando, otra facturando el
 * mismo cargo) podían entrelazarse: cancelOrder() ve "sin factura todavía"
 * y cancela: `requestInvoice()`, un instante después, nunca se entera de
 * que la orden ya es CANCELLED y emite igual.
 *
 * El fix (`InvoiceService.requestInvoice()`, guard TOCTOU) hace que las dos
 * rutas tomen el MISMO lock (`SELECT id FROM orders ... FOR UPDATE`) antes
 * de decidir -- la primera que lo consigue gana la carrera; la otra ve el
 * estado YA resuelto por la primera, nunca una foto vieja.
 *
 * **Nota de método (mutation testing real, 05/09/2026):** el primer intento
 * de este archivo tenía UN solo test de "carrera" (`Promise.allSettled` de
 * las dos llamadas sin ningún control de orden). Al desactivar a mano el
 * guard de `requestInvoice()` para confirmar que el test lo detectaba (la
 * misma disciplina de "revertir y probar" de
 * `docs/conocimiento/playbook-idempotencia-bajo-lock.md`), el test SIGUIÓ
 * pasando -- porque en esa corrida `requestInvoice()` ganó la carrera
 * primero, y el guard YA EXISTENTE del lado `cancelOrder()`
 * (`findBlockingInvoiceLinkage()`) atajó el caso igual, por la otra punta.
 * Un test que depende de qué lado gana una carrera no reproducible no es
 * evidencia de que ESTE guard puntual funcione. Por eso el test crítico de
 * abajo (`bloquea mientras...`) NO deja la carrera al azar: sostiene el
 * lock de `orders` a mano en una conexión real (mismo patrón de
 * `for-key-share-lock-semantics.integration.test.ts`, con su mismo brazo de
 * control) y prueba que `requestInvoice()` se queda esperando ese lock
 * específico, indefinidamente, hasta que se libera -- eso sí distingue "el
 * guard de requestInvoice() existe" de "algún guard, cualquiera, atajó
 * esta vez". El test de la carrera libre se conserva aparte, como chequeo
 * de sistema completo (nunca los dos guards a la vez dejan pasar el bug),
 * no como la prueba de ESTE guard.
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 * Si no está definida, la suite completa se saltea.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Arca } from '@arcasdk/core';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import type { SqlClient } from '../../repositories/sql.client.js';
import { PgTransactionManager } from '../../db/pg.transaction-manager.js';

import { OrderService } from '../../pos-menu/order.service.js';
import { SqlOrderRepository } from '../../pos-menu/sql.order.repository.js';
import { ProductService } from '../../pos-menu/product.service.js';
import { SqlProductRepository, SqlProductVariantRepository } from '../../pos-menu/sql.product.repository.js';
import { RecipeService } from '../../pos-menu/recipe.service.js';
import { OrderPricingService } from '../../pos-menu/order-pricing.service.js';
import { SqlRecipeItemRepository } from '../../repositories/sql.recipe-item.repository.js';
import { SqlInventoryLevelRepository } from '../../repositories/sql.inventory-level.repository.js';
import { SqlCustomerRateRepository } from '../../clientes-finanzas/sql.customer-rate.repository.js';
import { SqlAuditLogRepository } from '../../repositories/audit-log.repository.js';
import { SqlDomainEventRepository } from '../../repositories/sql.domain-event.repository.js';
import { SqlBusinessProfileRepository } from '../../repositories/sql.business-profile.repository.js';
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';

import { InvoiceService } from '../../facturacion/invoice.service.js';
import { OrderCancelledCannotInvoiceError } from '../../domain/errors.js';
import { OrderChargeInvoicedError } from '../../domain/errors.js';
import { CBTE_TIPO_FACTURA_B } from '../../facturacion/afip-catalog.constants.js';
import { buildArcaBillingAdapter } from '../../facturacion/arca-sdk-billing.adapter.js';
import type { AfipCredentialsRepository, AfipCredentials, AfipCredentialsStatus, AfipTicketCache } from '../../facturacion/afip-credentials.repository.js';
import type { AccountsReceivableRepository, AccountReceivable } from '../../clientes-finanzas/accounts-receivable.repository.js';
import type { ReservationRepository } from '../../reservas/reservation.repository.js';
import type { Reservation } from '../../reservas/Reservation.js';

/** Mismo helper que `for-key-share-lock-semantics.integration.test.ts` --
 *  ver ese archivo para el razonamiento completo de por qué chequea los DOS
 *  brazos (fulfilled y rejected) y por qué no usa `Promise.race`. */
/**
 * Adjunta el tracker de asentamiento **en el instante en que se llama** y
 * devuelve un lector sincrónico.
 *
 * Que el `.then(ok, err)` se adjunte YA no es un detalle de estilo: es lo
 * único que marca el rechazo como manejado. La versión anterior de este test
 * lo adjuntaba dentro de `settledWithin`, que se llamaba para los DOS brazos
 * sincrónicamente (`Promise.all`), así que daba igual. Con la ventana
 * adaptativa el brazo bloqueado se consulta hasta CONTROL_CAP_MS después —
 * y en esa ventana un rechazo temprano (timeout del pool, conexión cortada,
 * datos mal sembrados) saldría como `unhandledRejection` de Node en vez de
 * como la aserción de más abajo, posiblemente atribuido a otro archivo que
 * esté corriendo en paralelo. Misma patología que el `ECONNREFUSED` de libpq
 * que se arregló en el commit de F2: un rojo que no explica por qué.
 * Levantado por `architecture-governor` (condición C2) al revisar este
 * cambio, antes de commitear.
 */
function trackSettled<T>(promise: Promise<T>): () => boolean {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  return () => settled;
}

/**
 * Sondea `isSettled` hasta `capMs`. Devuelve si llegó a asentarse y cuánto
 * tardó. Recibe el lector —no la promesa— justamente para que el handler ya
 * esté adjuntado desde antes (ver `trackSettled`).
 *
 * Existe por el residual #4 de ORDER-10 (05/09/2026): la versión anterior de
 * este test le daba una ventana FIJA de 4s a los dos brazos, y contra un
 * TEST_DATABASE_URL remoto (Neon, latencia real) el brazo de CONTROL no
 * alcanzaba a resolver dentro de esa ventana. Resultado: el test caía en rojo
 * por latencia del entorno **sin haber probado ni refutado el guard**.
 * Verificado en una corrida completa de la suite el 05/09/2026 (147/148, el
 * único fallo era éste, y el mensaje era el del brazo de control).
 *
 * La ventana ahora la define el propio control en vez de un número fijo — ver
 * el uso más abajo.
 */
async function waitUntilSettled(
  isSettled: () => boolean,
  capMs: number,
): Promise<{ settled: boolean; elapsedMs: number }> {
  const start = Date.now();
  while (!isSettled() && Date.now() - start < capMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { settled: isSettled(), elapsedMs: Date.now() - start };
}

/**
 * Techo duro de espera del brazo de control. No es la ventana del test — es
 * el punto en el que se declara que el entorno no sirve para medir esto.
 */
const CONTROL_CAP_MS = 30_000;

/**
 * Margen que se le da al brazo BLOQUEADO **después** de que el de control ya
 * terminó. Los dos hacen exactamente el mismo trabajo previo al lock y salen
 * en paralelo: si el bloqueado no estuviera esperando un lock, resolvería a
 * pocos milisegundos del control. 1,5s es holgado para esa diferencia y sigue
 * siendo un orden de magnitud menos que la latencia que rompía la versión
 * anterior.
 */
const BLOCKED_GRACE_MS = 1_500;

const BIZ = 'biz-order10-toctou';
const LOC = 'loc-order10-toctou';
const CUS = 'cus-order10-toctou';
const PROD = 'prod-order10-toctou';
const ACTOR = 'user-order10-toctou';

/** Sin certificado real: `requestInvoice()` nunca debería tocar la red -- `clientFactory` la reemplaza más abajo. */
class FakeAfipCredentialsRepository implements AfipCredentialsRepository {
  async getStatus(): Promise<AfipCredentialsStatus> { return { configured: true, environment: 'homologacion' }; }
  async getDecrypted(): Promise<AfipCredentials | null> { return { cert: 'CERT', key: 'KEY', environment: 'homologacion' }; }
  async save(): Promise<void> {}
  async clear(): Promise<void> {}
  async getTicket(): Promise<AfipTicketCache | null> { return null; }
  async saveTicket(): Promise<void> {}
  async clearTicket(): Promise<void> {}
}

/** Ninguna de las dos órdenes de este archivo tiene cliente empresa -- nada que buscar/marcar. */
class FakeAccountsReceivableRepo implements Pick<
  AccountsReceivableRepository, 'getByFinancialTransactionId' | 'markInvoiced' | 'getPendingByCompanyCustomerId' | 'getByStayId'
> {
  async getByFinancialTransactionId(): Promise<AccountReceivable | undefined> { return undefined; }
  async getPendingByCompanyCustomerId(): Promise<AccountReceivable[]> { return []; }
  /** §9.4 (13/09/2026) -- exposición de AR viva en `requestInvoice()`; este archivo no la ejercita. */
  async getByStayId(): Promise<AccountReceivable[]> { return []; }
  async markInvoiced(): Promise<AccountReceivable | undefined> { return undefined; }
}

/** Los ítems de este archivo son PRODUCT -- `resolveOrderItemLine` nunca llama a esto. */
class FakeReservationRepository implements Pick<ReservationRepository, 'getById'> {
  async getById(): Promise<Reservation | undefined> { return undefined; }
}

/** Mismo patrón que invoice.service.test.ts -- AFIP siempre aprueba, sin pegarle a la red real. */
function fakeArcaClient(): Arca {
  return {
    electronicBillingService: {
      getLastVoucher: async () => ({ cbteNro: 10, cbteTipo: CBTE_TIPO_FACTURA_B, ptoVta: 3 }),
      createNextVoucher: async () => ({
        response: {
          FeCabResp: { Resultado: 'A', CbteTipo: CBTE_TIPO_FACTURA_B },
          FeDetResp: { FECAEDetResponse: [{ Resultado: 'A', CbteDesde: 11 }] },
        },
        cae: 'CAE-ORDER10-TOCTOU',
        caeFchVto: '20301231',
      }),
      getVoucherInfo: async () => ({}),
    },
  } as unknown as Arca;
}

describe.skipIf(skipIfNoDb)('ORDER-10 -- TOCTOU entre cancelOrder() y requestInvoice() sobre la misma orden', () => {
  let db: SqlClient;
  let pool: pg.Pool;
  let dbName: string;

  let orderService: OrderService;
  let invoiceService: InvoiceService;
  let financialRepo: SqlFinancialTransactionRepository;

  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());

    await db.query(`INSERT INTO locations (id, name) VALUES ($1,'ORDER-10')`, [LOC]);
    await db.query(
      `INSERT INTO customers (id, full_name, display_name, customer_number)
       VALUES ($1,'Cliente ORDER-10','Cliente ORDER-10',1)`, [CUS]);
    await db.query(
      `INSERT INTO products (id, business_id, name, base_price, product_type, sku)
       VALUES ($1,$2,'Producto ORDER-10',100,'RETAIL','SKU-ORDER10')`, [PROD, BIZ]);
    // El guard de AfipNotConfiguredError exige CUIT y punto de venta cargados
    // -- `clientFactory` reemplaza el cliente real, así que nunca hace falta
    // un certificado de verdad.
    await db.query(`UPDATE business_profile SET tax_id = '20111111112', afip_sales_point = 3`);

    const pgTxManager = new PgTransactionManager(pool);
    const orderRepo = new SqlOrderRepository(db);
    financialRepo = new SqlFinancialTransactionRepository(db);
    const invoiceRepo = new SqlInvoiceRepository(db);
    const productRepo = new SqlProductRepository(db);
    const productVariantRepo = new SqlProductVariantRepository(db);

    const productService = new ProductService(
      productRepo, productVariantRepo, new SqlAuditLogRepository(db), new SqlInventoryLevelRepository(db), pgTxManager,
    );
    orderService = new OrderService(
      orderRepo, pgTxManager, new SqlDomainEventRepository(db), productService,
      new RecipeService(new SqlRecipeItemRepository(db), productRepo, productVariantRepo),
      new OrderPricingService(productService, new SqlCustomerRateRepository(db)),
      financialRepo, invoiceRepo,
      new SqlAuditLogRepository(db),
    );

    invoiceService = new InvoiceService(
      invoiceRepo,
      financialRepo,
      new SqlBusinessProfileRepository(db),
      new FakeAfipCredentialsRepository(),
      orderRepo,
      productRepo,
      productVariantRepo,
      new FakeReservationRepository(),
      pgTxManager,
      new FakeAccountsReceivableRepo(),
      new SqlAuditLogRepository(db),
      () => buildArcaBillingAdapter(fakeArcaClient()),
    );
  }, 60_000);

  afterAll(async () => { await dropTestDatabase(dbName, pool); });

  beforeEach(async () => {
    await db.query('DELETE FROM audit_log');
    await db.query('DELETE FROM invoice_items');
    await db.query('DELETE FROM invoice_charges');
    await db.query('DELETE FROM invoices');
    await db.query('DELETE FROM financial_transactions');
    await db.query('DELETE FROM domain_events');
    await db.query('DELETE FROM order_items');
    await db.query('DELETE FROM orders');
    await db.query('DELETE FROM inventory_levels');
    await db.query(
      `INSERT INTO inventory_levels (id, business_id, product_id, location_id, stock_quantity, reserved_quantity)
       VALUES ($1,$2,$3,$4,100,0)`, [randomUUID(), BIZ, PROD, LOC]);
  });

  async function seedConfirmedOrderWithCharge(): Promise<{ orderId: string; chargeId: string }> {
    const order = await orderService.createOrder({
      businessId: BIZ, customerId: CUS, locationId: LOC,
      items: [{ itemType: 'PRODUCT', productId: PROD, quantity: 1 }],
    });
    await orderService.confirmOrder(order.id, ACTOR);

    // El CHARGE normalmente lo crea el handler del outbox (order.confirmed);
    // acá se inserta directo -- lo único que importa para este test es que
    // exista un CHARGE de la orden, no cómo llegó a existir.
    const charge = await financialRepo.create({
      id: randomUUID(), businessId: BIZ, customerId: CUS, orderId: order.id,
      type: 'CHARGE', amount: 100, currency: 'ARS', status: 'SETTLED',
    });

    return { orderId: order.id, chargeId: charge!.id };
  }

  // -------------------------------------------------------------------------
  // Caso secuencial -- rápido, 100% determinístico. No es la evidencia que
  // pidió el governor (esa es la carrera de abajo), pero es el criterio de
  // aceptación más básico del ADR: una vez cancelada la orden, facturar su
  // cargo SIEMPRE rechaza, sin importar la concurrencia.
  // -------------------------------------------------------------------------
  it('secuencial: cancelada la orden primero, requestInvoice() del cargo rechaza con OrderCancelledCannotInvoiceError', async () => {
    const { orderId, chargeId } = await seedConfirmedOrderWithCharge();

    await orderService.cancelOrder(orderId, ACTOR);

    await expect(
      invoiceService.requestInvoice({ businessId: BIZ, financialTransactionId: chargeId, changedBy: ACTOR }),
    ).rejects.toThrow(OrderCancelledCannotInvoiceError);

    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM invoices WHERE financial_transaction_id = $1`, [chargeId],
    );
    expect(Number(rows[0]!.count)).toBe(0);
  }, 15_000);

  // -------------------------------------------------------------------------
  // La carrera real -- DOS conexiones de Postgres genuinas (cada `run()` de
  // PgTransactionManager hace su propio `pool.connect()`), disparadas con
  // Promise.all para que compitan de verdad por el `FOR UPDATE` de `orders`.
  //
  // No hace falta forzar quién gana: cualquiera de los dos desenlaces es
  // válido, lo que NUNCA puede pasar es que los dos tengan éxito a la vez
  // (orden CANCELLED + factura ISSUED del mismo cargo). Eso es exactamente
  // lo que el bug real de producción hacía en silencio.
  // -------------------------------------------------------------------------
  it('concurrente: cancelOrder() y requestInvoice() sobre la misma orden nunca terminan las dos OK', async () => {
    const { orderId, chargeId } = await seedConfirmedOrderWithCharge();

    const [cancelResult, invoiceResult] = await Promise.allSettled([
      orderService.cancelOrder(orderId, ACTOR),
      invoiceService.requestInvoice({ businessId: BIZ, financialTransactionId: chargeId, changedBy: ACTOR }),
    ]);

    // Nunca las dos: o se canceló la orden y no hay factura, o se facturó
    // y la orden sigue como estaba. Ambas a la vez es exactamente el bug.
    const ambasOk = cancelResult.status === 'fulfilled' && invoiceResult.status === 'fulfilled';
    expect(
      ambasOk,
      'cancelOrder() y requestInvoice() resolvieron las DOS con éxito -- el guard TOCTOU no está cerrando la ' +
      'ventana de carrera. Ver InvoiceService.requestInvoice() (getByIdForUpdate antes de crear la factura).',
    ).toBe(false);

    const { rows: orderRows } = await db.query<{ status: string }>(
      `SELECT status FROM orders WHERE id = $1`, [orderId],
    );
    const { rows: invoiceRows } = await db.query<{ status: string }>(
      `SELECT status FROM invoices WHERE financial_transaction_id = $1`, [chargeId],
    );

    if (cancelResult.status === 'fulfilled') {
      // Ganó la cancelación: la orden quedó CANCELLED y nunca se llegó a
      // crear ninguna fila de `invoices` para este cargo (el guard de
      // requestInvoice() tira ANTES del INSERT).
      expect(cancelResult.value.status).toBe('CANCELLED');
      expect(orderRows[0]!.status).toBe('CANCELLED');
      expect(invoiceRows).toHaveLength(0);
      expect(invoiceResult.status).toBe('rejected');
      if (invoiceResult.status === 'rejected') {
        expect(invoiceResult.reason).toBeInstanceOf(OrderCancelledCannotInvoiceError);
      }
    } else {
      // Ganó la facturación: el comprobante quedó ISSUED (CAE real de la
      // AFIP fake) y la orden NUNCA llegó a CANCELLED -- el guard de
      // cancelOrder() (OrderChargeInvoicedError) frenó la transición.
      expect(invoiceResult.status).toBe('fulfilled');
      if (invoiceResult.status === 'fulfilled') {
        expect(invoiceResult.value.status).toBe('ISSUED');
      }
      expect(invoiceRows[0]?.status).toBe('ISSUED');
      expect(orderRows[0]!.status).toBe('CONFIRMED');
      expect(cancelResult.status).toBe('rejected');
      if (cancelResult.status === 'rejected') {
        expect(cancelResult.reason).toBeInstanceOf(OrderChargeInvoicedError);
      }
    }
  }, 15_000);

  // -------------------------------------------------------------------------
  // La evidencia crítica que pidió architecture-governor: NO deja el orden de
  // llegada al azar. Sostiene a mano, en una conexión real, el MISMO efecto
  // que `cancelOrder()` aplica bajo lock (orders.status = 'CANCELLED', sin
  // commitear) y prueba que `requestInvoice()` se queda esperando ESE lock
  // puntual -- no que "algún guard, cualquiera" haya interceptado la orden
  // de llegada de esta corrida en particular. Con brazo de control, mismo
  // criterio que `for-key-share-lock-semantics.integration.test.ts`.
  // -------------------------------------------------------------------------
  it('requestInvoice() se queda esperando el lock de orders() mientras una cancelación está en vuelo, y una vez liberado ve la orden ya CANCELLED (no una foto vieja)', async () => {
    const { orderId: lockedOrderId, chargeId: lockedChargeId } = await seedConfirmedOrderWithCharge();
    const { chargeId: controlChargeId } = await seedConfirmedOrderWithCharge();

    const connA = await pool.connect();
    let blockedInvoice: Promise<unknown> | undefined;
    let controlInvoice: Promise<unknown> | undefined;

    try {
      // Mismo efecto que la transición que `cancelOrder()` aplica DENTRO de
      // su transacción (transitionWithClient: UPDATE de orders bajo lock),
      // sostenido sin commitear -- simula el instante exacto en el que
      // cancelOrder() ya decidió cancelar pero todavía no terminó.
      await connA.query('BEGIN');
      await connA.query(
        `UPDATE orders SET status = 'CANCELLED', cancelled_at = NOW() WHERE id = $1 AND status = 'CONFIRMED'`,
        [lockedOrderId],
      );

      blockedInvoice = invoiceService.requestInvoice({
        businessId: BIZ, financialTransactionId: lockedChargeId, changedBy: ACTOR,
      });
      // Handler adjuntado en el mismo tick en que nace la promesa -- ver el
      // docblock de trackSettled(). Este brazo no se consulta hasta después
      // de que el control resuelva (hasta CONTROL_CAP_MS más tarde).
      const blockedSettled = trackSettled(blockedInvoice);
      // Brazo de control -- mismo camino, MISMA cantidad de trabajo previo
      // al lock (idempotencia, tx, perfil, ítems), pero sobre una orden SIN
      // ningún lock sostenido. Si esta tampoco resolviera dentro de la
      // ventana, el resultado del brazo bloqueado no probaría nada: algo
      // más (latencia de red hacia Neon, pool saturado) estaría frenando
      // ambas por igual.
      controlInvoice = invoiceService.requestInvoice({
        businessId: BIZ, financialTransactionId: controlChargeId, changedBy: ACTOR,
      });
      const controlSettled = trackSettled(controlInvoice);

      // Ventana ADAPTATIVA (residual #4 de ORDER-10, 05/09/2026). Antes: 4s
      // fijos para los dos brazos, en paralelo. Contra Neon eso hacía fallar
      // el brazo de control por latencia pura. Ahora la referencia temporal
      // es el propio control: se espera a que el brazo SIN lock termine, y
      // recién entonces se pregunta si el bloqueado sigue pendiente. El
      // invariante afirmado es el real -- "el brazo bloqueado sobrevive al de
      // control" -- y no depende de la latencia absoluta del entorno.
      const control = await waitUntilSettled(controlSettled, CONTROL_CAP_MS);

      expect(
        control.settled,
        `El brazo de CONTROL (orden SIN ningún lock sostenido) no resolvió en ${CONTROL_CAP_MS} ms -- algo más está ` +
        'frenando la conexión (latencia hacia TEST_DATABASE_URL, pool saturado), no específicamente el lock de ' +
        'orders(). El resultado del brazo bloqueado no es confiable mientras este control esté fallando.',
      ).toBe(true);

      // El control ya terminó. El bloqueado hizo el mismo trabajo previo y
      // salió en paralelo: si no estuviera esperando el lock de orders(), ya
      // tendría que haber resuelto también.
      await new Promise((resolve) => setTimeout(resolve, BLOCKED_GRACE_MS));
      expect(
        blockedSettled(),
        `requestInvoice() resolvió ANTES de que la transacción que sostiene CANCELLED sobre orders() hiciera ` +
        `commit -- el guard TOCTOU (getByIdForUpdate() como primera operación de la transacción) no está tomando ` +
        `el lock, o no lo está tomando ANTES de decidir. Ver InvoiceService.requestInvoice(). ` +
        `(El brazo de control resolvió en ${control.elapsedMs} ms; al bloqueado se le dieron ${BLOCKED_GRACE_MS} ms más.)`,
      ).toBe(false);
    } finally {
      // Mismo orden que FOR-KEY-SHARE-001: terminar la transacción que
      // sostiene el lock PRIMERO -- libera cualquier `requestInvoice()` que
      // haya quedado esperando. Recién después, drenar las dos promesas
      // (ignorando acá su resultado -- ya se evaluó arriba, o el test ya
      // está fallando por otra razón) y liberar la conexión.
      await connA.query('COMMIT').catch(() => {});
      if (blockedInvoice) await blockedInvoice.catch(() => {});
      if (controlInvoice) await controlInvoice.catch(() => {});
      connA.release();
    }

    // Liberado el lock, requestInvoice() ve la orden YA CANCELLED -- por el
    // commit de arriba, no por una foto vieja tomada antes de bloquear.
    await expect(blockedInvoice).rejects.toThrow(OrderCancelledCannotInvoiceError);

    const { rows: invoiceRows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM invoices WHERE financial_transaction_id = $1`, [lockedChargeId],
    );
    expect(Number(invoiceRows[0]!.count)).toBe(0);

    // El brazo de control, sin ningún lock en el medio, factura normal.
    const controlValue = await controlInvoice as { status: string };
    expect(controlValue.status).toBe('ISSUED');
    // 60s (antes 20s): la ventana adaptativa puede esperar hasta
    // CONTROL_CAP_MS por el control, más el sembrado de las dos órdenes y el
    // drenaje final. Contra Neon la corrida real de este test rondaba los 16s
    // con la ventana fija; el techo tiene que quedar por encima del peor caso
    // del control, no del caso feliz.
  }, 60_000);
});
