import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import type { SqlClient } from '../../repositories/sql.client.js';
import { PgTransactionManager } from '../../db/pg.transaction-manager.js';

import { OrderService, OrderNotServableError } from '../../pos-menu/order.service.js';
import { SqlOrderRepository } from '../../pos-menu/sql.order.repository.js';
import { ProductService } from '../../pos-menu/product.service.js';
import { SqlProductRepository, SqlProductVariantRepository } from '../../pos-menu/sql.product.repository.js';
import { RecipeService } from '../../pos-menu/recipe.service.js';
import { OrderPricingService } from '../../pos-menu/order-pricing.service.js';
import { SqlRecipeItemRepository } from '../../repositories/sql.recipe-item.repository.js';
import { SqlInventoryLevelRepository } from '../../repositories/sql.inventory-level.repository.js';
import { SqlCustomerRateRepository } from '../../clientes-finanzas/sql.customer-rate.repository.js';
import { SqlAuditLogRepository } from '../../repositories/audit-log.repository.js';
import type { AuditLogRepository } from '../../repositories/audit-log.repository.js';
import { SqlDomainEventRepository } from '../../repositories/sql.domain-event.repository.js';
import { SqlBusinessProfileRepository } from '../../repositories/sql.business-profile.repository.js';
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';
import {
  handleOrderConfirmed,
  handleOrderCompleted,
  handleOrderCancelled,
} from '../../workers/outbox.handlers.js';
import type { DomainEvent } from '../../repositories/domain-event.repository.js';

/**
 * O3 (03/09/2026) — verificación funcional CONTROLADA del ciclo de una orden.
 *
 * Distinta de `order-effects.integration.test.ts`, que prueba invariantes de
 * borde uno por uno. Acá se recorre el flujo entero de punta a punta y se
 * comparan **conteos y estados persistidos antes y después de cada paso** —
 * no respuestas HTTP. Cada paso declara su delta esperado y falla si aparece
 * un efecto que nadie pidió.
 *
 * Atraviesa: OrderService real, repositorios SQL reales, transacciones reales
 * y los handlers reales del outbox.
 *
 * Lo que NO cubre, declarado: el `OutboxWorker` en sí. Los handlers se
 * invocan directo con los eventos que el productor dejó en `domain_events`;
 * el poll, el casillero de `processed_events` y el camino a dead-letter
 * quedan fuera.
 */

const BIZ = 'biz-o3';
const LOC = 'loc-o3';
const CUS = 'cus-o3';
const PROD = 'prod-o3';
const ACTOR = 'user-o3';

interface Foto {
  ordenes: number;
  items: number;
  reservado: number;
  cargos: number;
  cargosPendientes: number;
  cargosLiquidados: number;
  cargosAnulados: number;
  eventos: number;
  eventosDespachados: number;
  enDeadLetter: number;
  auditorias: number;
}

describe.skipIf(skipIfNoDb)('O3 — flujo funcional controlado (integración)', () => {
  let db: SqlClient;
  let dbName: string;
  let pool: pg.Pool;

  let service: OrderService;
  let financialRepo: SqlFinancialTransactionRepository;
  let profileRepo: SqlBusinessProfileRepository;
  let txManager: PgTransactionManager;

  beforeAll(async () => {
    ({ db, dbName, pool } = await createTestDatabase());

    await db.query(`INSERT INTO locations (id, name) VALUES ($1,'O3')`, [LOC]);
    await db.query(
      `INSERT INTO customers (id, full_name, display_name, customer_number)
       VALUES ($1,'Cliente O3','Cliente O3',1)`, [CUS]);
    await db.query(
      `INSERT INTO products (id, business_id, name, base_price, product_type, sku)
       VALUES ($1,$2,'Producto O3',100,'RETAIL','SKU-O3')`, [PROD, BIZ]);

    txManager     = new PgTransactionManager(pool);
    financialRepo = new SqlFinancialTransactionRepository(db);
    profileRepo   = new SqlBusinessProfileRepository(db);

    const productService = new ProductService(
      new SqlProductRepository(db), new SqlProductVariantRepository(db),
      new SqlAuditLogRepository(db), new SqlInventoryLevelRepository(db), txManager,
    );
    service = new OrderService(
      new SqlOrderRepository(db), txManager, new SqlDomainEventRepository(db), productService,
      new RecipeService(new SqlRecipeItemRepository(db), new SqlProductRepository(db), new SqlProductVariantRepository(db)),
      new OrderPricingService(productService, new SqlCustomerRateRepository(db)),
      financialRepo, new SqlInvoiceRepository(db),
      new SqlAuditLogRepository(db),
    );
  }, 60_000);

  afterAll(async () => { await dropTestDatabase(dbName, pool); });

  beforeEach(async () => {
    await db.query('DELETE FROM audit_log');
    await db.query('DELETE FROM financial_transactions');
    await db.query('DELETE FROM domain_events');
    await db.query('DELETE FROM order_items');
    await db.query('DELETE FROM orders');
    await db.query('DELETE FROM inventory_levels');
    await db.query(
      `INSERT INTO inventory_levels (id, business_id, product_id, location_id, stock_quantity, reserved_quantity)
       VALUES ($1,$2,$3,$4,100,0)`, [randomUUID(), BIZ, PROD, LOC]);
  });

  // ── instrumentación ───────────────────────────────────────────────────────

  /** Todo lo que puede cambiar por un paso del flujo, en una sola consulta. */
  async function foto(): Promise<Foto> {
    const { rows } = await db.query<Record<string, string>>(`
      SELECT
        (SELECT count(*) FROM orders)                                          AS ordenes,
        (SELECT count(*) FROM order_items)                                     AS items,
        (SELECT coalesce(sum(reserved_quantity),0) FROM inventory_levels)      AS reservado,
        (SELECT count(*) FROM financial_transactions)                          AS cargos,
        (SELECT count(*) FROM financial_transactions WHERE status='PENDING')   AS cargos_pendientes,
        (SELECT count(*) FROM financial_transactions WHERE status='SETTLED')   AS cargos_liquidados,
        (SELECT count(*) FROM financial_transactions WHERE status='VOIDED')    AS cargos_anulados,
        (SELECT count(*) FROM domain_events)                                   AS eventos,
        (SELECT count(*) FROM domain_events WHERE dispatched_at IS NOT NULL)   AS eventos_despachados,
        (SELECT count(*) FROM domain_events WHERE failed_at IS NOT NULL)       AS en_dead_letter,
        (SELECT count(*) FROM audit_log WHERE entity='orders')                 AS auditorias`);
    const f = rows[0]!;
    return {
      ordenes: +f['ordenes']!, items: +f['items']!, reservado: +f['reservado']!,
      cargos: +f['cargos']!, cargosPendientes: +f['cargos_pendientes']!,
      cargosLiquidados: +f['cargos_liquidados']!, cargosAnulados: +f['cargos_anulados']!,
      eventos: +f['eventos']!, eventosDespachados: +f['eventos_despachados']!,
      enDeadLetter: +f['en_dead_letter']!, auditorias: +f['auditorias']!,
    };
  }

  /**
   * Corre un paso y verifica el delta EXACTO contra la foto previa. Todo
   * contador que no esté en `esperado` tiene que quedar igual: un efecto que
   * nadie declaró es una falla, no un detalle.
   */
  async function paso<T>(
    _nombre: string, antes: Foto, esperado: Partial<Foto>, accion: () => Promise<T>,
  ): Promise<{ resultado: T; despues: Foto }> {
    const resultado = await accion();
    const despues = await foto();
    const proyectado: Foto = { ...antes };
    for (const [k, v] of Object.entries(esperado)) {
      proyectado[k as keyof Foto] = antes[k as keyof Foto] + (v as number);
    }
    expect(despues).toEqual(proyectado);
    return { resultado, despues };
  }

  async function eventoReal(orderId: string, tipo: string): Promise<DomainEvent> {
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT id, business_id, aggregate_type, aggregate_id, event_type, payload, retry_count
         FROM domain_events WHERE event_type=$1 AND payload->>'orderId'=$2 ORDER BY id DESC LIMIT 1`,
      [tipo, orderId]);
    const f = rows[0]!;
    return {
      id: Number(f['id']), businessId: f['business_id'] as string,
      aggregateType: f['aggregate_type'] as DomainEvent['aggregateType'],
      aggregateId: f['aggregate_id'] as string, eventType: f['event_type'] as string,
      payload: f['payload'] as Record<string, unknown>, retryCount: Number(f['retry_count'] ?? 0),
    };
  }

  const crear = () => service.createOrder({
    businessId: BIZ, customerId: CUS, locationId: LOC,
    items: [{ itemType: 'PRODUCT', productId: PROD, quantity: 3 }],
  });

  // ── el flujo completo, paso por paso ─────────────────────────────────────

  it('O3-01: crear → confirmar → cobrar, con el delta exacto en cada paso', async () => {
    let f = await foto();
    expect(f).toEqual({
      ordenes: 0, items: 0, reservado: 0, cargos: 0, cargosPendientes: 0,
      cargosLiquidados: 0, cargosAnulados: 0, eventos: 0, eventosDespachados: 0,
      enDeadLetter: 0, auditorias: 0,
    });

    // 1 · Crear. Sin efectos financieros ni de stock: es un carrito abierto.
    const { resultado: orden, despues: f1 } = await paso(
      'crear', f, { ordenes: +1, items: +1 }, crear);
    expect(orden.status).toBe('DRAFT');
    expect(orden.totalAmount).toBe(300);   // 3 x precio base resuelto server-side
    f = f1;

    // 2 · Confirmar. UNA reserva, UN evento, UNA fila de auditoría. Todavía
    //     sin cargo: eso lo hace el worker.
    const { resultado: confirmada, despues: f2 } = await paso(
      'confirmar', f, { reservado: +3, eventos: +1, auditorias: +1 },
      () => service.confirmOrder(orden.id, ACTOR));
    expect(confirmada.status).toBe('CONFIRMED');
    expect(confirmada.confirmedAt).not.toBeNull();   // ORDER-14
    f = f2;

    // 3 · El handler crea el CHARGE. Un solo cargo, PENDING.
    const confirmadoEvt = await eventoReal(orden.id, 'order.confirmed');
    const { despues: f3 } = await paso(
      'crear cargo', f, { cargos: +1, cargosPendientes: +1 },
      () => handleOrderConfirmed(financialRepo, profileRepo, txManager)(confirmadoEvt));
    f = f3;

    // 4 · REINTENTO del mismo evento: cero efectos. Es la prueba de que la
    //     identidad es del acto y no del mensaje.
    await paso('reintentar creación', f, {},
      () => handleOrderConfirmed(financialRepo, profileRepo, txManager)(confirmadoEvt));

    // 5 · Completar. Un evento y una auditoría más; el cargo sigue PENDING
    //     hasta que el worker lo liquide.
    const { despues: f5 } = await paso(
      'completar', f, { eventos: +1, auditorias: +1 },
      () => service.completeOrder(orden.id, ACTOR, { paymentMethod: 'CASH', cardInstallments: null, cardSurchargeAmount: null }));
    f = f5;

    // 6 · El handler liquida. El cargo se mueve de PENDING a SETTLED: el
    //     total no cambia, sólo su estado.
    const completadoEvt = await eventoReal(orden.id, 'order.completed');
    const { despues: f6 } = await paso(
      'liquidar', f, { cargosPendientes: -1, cargosLiquidados: +1 },
      () => handleOrderCompleted(financialRepo)(completadoEvt));
    f = f6;

    // 7 · REINTENTO de la liquidación: cero efectos, y no lanza.
    await paso('reintentar liquidación', f, {},
      () => handleOrderCompleted(financialRepo)(completadoEvt));

    // 8 · Estado final, verificado sobre los datos y no sobre las respuestas.
    const { rows: cargos } = await db.query<{ status: string; amount: string; payment_method: string | null }>(
      `SELECT status, amount, payment_method FROM financial_transactions WHERE order_id=$1`, [orden.id]);
    expect(cargos).toHaveLength(1);
    expect(cargos[0]!.status).toBe('SETTLED');
    expect(Number(cargos[0]!.amount)).toBe(300);
    expect(cargos[0]!.payment_method).toBe('CASH');

    const { rows: auditorias } = await db.query<{ old_value: string; new_value: string; changed_by: string }>(
      `SELECT old_value, new_value, changed_by FROM audit_log
        WHERE entity='orders' AND entity_id=$1 ORDER BY changed_at ASC`, [orden.id]);
    expect(auditorias.map((a) => `${a.old_value}->${a.new_value}`))
      .toEqual(['DRAFT->CONFIRMED', 'CONFIRMED->COMPLETED']);
    expect(auditorias.every((a) => a.changed_by === ACTOR)).toBe(true);

    // 9 · El outbox: dos eventos, ninguno en dead-letter.
    const { rows: eventos } = await db.query<{ event_type: string; failed_at: string | null }>(
      `SELECT event_type, failed_at FROM domain_events
        WHERE payload->>'orderId'=$1 ORDER BY id ASC`, [orden.id]);
    expect(eventos.map((e) => e.event_type)).toEqual(['order.confirmed', 'order.completed']);
    expect(eventos.every((e) => e.failed_at === null)).toBe(true);
  });

  // ── la cancelación, en su propio caso ────────────────────────────────────

  it('O3-02: crear → confirmar → cancelar, con el cargo anulado y el delta exacto', async () => {
    let f = await foto();

    const { resultado: orden, despues: f1 } = await paso(
      'crear', f, { ordenes: +1, items: +1 }, crear);
    f = f1;

    const { despues: f2 } = await paso(
      'confirmar', f, { reservado: +3, eventos: +1, auditorias: +1 },
      () => service.confirmOrder(orden.id, ACTOR));
    f = f2;

    const { despues: f3 } = await paso(
      'crear cargo', f, { cargos: +1, cargosPendientes: +1 },
      async () => handleOrderConfirmed(financialRepo, profileRepo, txManager)(
        await eventoReal(orden.id, 'order.confirmed')));
    f = f3;

    // Cancelar: evento y auditoría. La reserva NO se libera acá -- eso es del
    // handler de inventario, que está fuera del alcance de O2/O3.
    const { resultado: cancelada, despues: f4 } = await paso(
      'cancelar', f, { eventos: +1, auditorias: +1 },
      () => service.cancelOrder(orden.id, ACTOR));
    expect(cancelada.status).toBe('CANCELLED');
    f = f4;

    // El handler anula el cargo: de PENDING a VOIDED.
    const canceladoEvt = await eventoReal(orden.id, 'order.cancelled');
    const { despues: f5 } = await paso(
      'anular', f, { cargosPendientes: -1, cargosAnulados: +1 },
      () => handleOrderCancelled(financialRepo)(canceladoEvt));
    f = f5;

    // Reintento: cero efectos.
    await paso('reintentar anulación', f, {},
      () => handleOrderCancelled(financialRepo)(canceladoEvt));

    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM financial_transactions WHERE order_id=$1`, [orden.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('VOIDED');

    const { rows: auditorias } = await db.query<{ old_value: string; new_value: string }>(
      `SELECT old_value, new_value FROM audit_log
        WHERE entity='orders' AND entity_id=$1 ORDER BY changed_at ASC`, [orden.id]);
    expect(auditorias.map((a) => `${a.old_value}->${a.new_value}`))
      .toEqual(['DRAFT->CONFIRMED', 'CONFIRMED->CANCELLED']);
  });

  // ── el flujo no deja efectos cuando se rechaza ───────────────────────────

  it('O3-03: una transición rechazada no mueve NINGÚN contador', async () => {
    const { resultado: orden } = await paso(
      'crear', await foto(), { ordenes: +1, items: +1 }, crear);
    const f = await foto();

    // Completar desde DRAFT: 409, y nada más.
    await expect(service.completeOrder(orden.id, ACTOR)).rejects.toThrow();
    expect(await foto()).toEqual(f);

    // Y confirmar dos veces: la segunda es 200 idempotente, sin efectos.
    await service.confirmOrder(orden.id, ACTOR);
    const g = await foto();
    await service.confirmOrder(orden.id, ACTOR);
    expect(await foto()).toEqual(g);
  });

  // ── servir: el único paso del ciclo que nunca se había ejecutado ──────────

  /**
   * T-SERVIR-01 (03/09/2026) — el caso que le faltaba a esta suite y que
   * habría atajado el incidente del 03/09 en `biz-demo-01`.
   *
   * `markServed()` tenía cobertura de unit (repo in-memory), de repo con
   * `FakeSqlClient` -- que **assertaba el texto** del SQL sin ejecutarlo -- y
   * de ruta con el servicio mockeado. Ninguna de las tres toca Postgres, así
   * que el `UPDATE orders SET served_at = NOW()` nunca se ejecutó contra una
   * tabla real en todo el repo: era la única de las cuatro transiciones sin
   * ese piso. En producción la columna no existía y el UPDATE respondía 42703
   * -> 500 (ver schema v46 en schema.sql, BLOQUE 4).
   *
   * Verifica que `served_at` se SELLA, que `status` NO cambia (servedAt es
   * independiente del estado, schema.sql BLOQUE 14), y que el único efecto
   * es UNA fila de auditoría (ORDER-16, 03/09/2026): el `paso()` con delta
   * `{ auditorias: +1 }` exige delta cero en reservas, cargos, eventos y
   * dead-letter, y exactamente una auditoría más.
   */
  it('O3-04 / T-SERVIR-01 / E-I1: servir sella served_at, no cambia status y deja exactamente su fila de auditoría', async () => {
    const { resultado: orden } = await paso(
      'crear', await foto(), { ordenes: +1, items: +1 }, crear);
    await paso('confirmar', await foto(), { reservado: +3, eventos: +1, auditorias: +1 },
      () => service.confirmOrder(orden.id, ACTOR));

    // Servir: solo suma su fila de auditoría (ORDER-16). No emite domain
    // event (D1) y no toca stock ni finanzas.
    const { resultado: servida } = await paso(
      'servir', await foto(), { auditorias: +1 }, () => service.markServed(orden.id, ACTOR));

    expect(servida.status).toBe('CONFIRMED');       // NO pasa a un estado nuevo
    expect(servida.servedAt).not.toBeNull();        // el sello ocurrió
    expect(servida.completedAt).toBeNull();
    expect(servida.cancelledAt).toBeNull();

    // Persistido de verdad, no sólo en el objeto devuelto: es exactamente la
    // lectura que en producción devolvía 42703.
    const { rows } = await db.query<{ status: string; served_at: string | null }>(
      `SELECT status, served_at FROM orders WHERE id = $1`, [orden.id]);
    expect(rows[0]!.status).toBe('CONFIRMED');
    expect(rows[0]!.served_at).not.toBeNull();

    // La fila de auditoría del sello: field='served_at', actor real,
    // old_value NULL, new_value = el served_at en ISO (ms de precisión).
    const { rows: aud } = await db.query<{ field: string; old_value: string | null; new_value: string | null; changed_by: string }>(
      `SELECT field, old_value, new_value, changed_by FROM audit_log
        WHERE entity='orders' AND entity_id=$1 AND field='served_at'`, [orden.id]);
    expect(aud).toHaveLength(1);
    expect(aud[0]!.old_value).toBeNull();
    expect(aud[0]!.changed_by).toBe(ACTOR);
    expect(new Date(aud[0]!.new_value!).getTime())
      .toBe(new Date(servida.servedAt!).getTime());

    // Servir de nuevo: 200 idempotente, mismo sello, cero efectos nuevos
    // -- NI una segunda fila de auditoría (D5).
    const { resultado: repetida } = await paso(
      'servir otra vez', await foto(), {}, () => service.markServed(orden.id, ACTOR));
    expect(repetida.servedAt).toEqual(servida.servedAt);
    const { rows: aud2 } = await db.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE entity='orders' AND entity_id=$1 AND field='served_at'`, [orden.id]);
    expect(Number(aud2[0]!.n)).toBe(1);
  });

  // ── ORDER-16: D9 (solo CONFIRMED) y atomicidad de la auditoría ───────────

  /** Rebuild de OrderService con un AuditLogRepository inyectable, para los
   *  casos que necesitan forzar un fallo del INSERT de auditoría. Reusa el
   *  `db` y el `txManager` reales de la suite. */
  function buildServiceWithAudit(auditRepo: AuditLogRepository): OrderService {
    const ps = new ProductService(
      new SqlProductRepository(db), new SqlProductVariantRepository(db),
      new SqlAuditLogRepository(db), new SqlInventoryLevelRepository(db), txManager,
    );
    return new OrderService(
      new SqlOrderRepository(db), txManager, new SqlDomainEventRepository(db), ps,
      new RecipeService(new SqlRecipeItemRepository(db), new SqlProductRepository(db), new SqlProductVariantRepository(db)),
      new OrderPricingService(ps, new SqlCustomerRateRepository(db)),
      financialRepo, new SqlInvoiceRepository(db),
      auditRepo,
    );
  }

  const servedAudits = (orderId: string) =>
    db.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE entity='orders' AND entity_id=$1 AND field='served_at'`,
      [orderId],
    ).then((r) => Number(r.rows[0]!.n));

  const servedAtOf = (orderId: string) =>
    db.query<{ served_at: string | null }>(`SELECT served_at FROM orders WHERE id=$1`, [orderId])
      .then((r) => r.rows[0]!.served_at);

  it('E-I2: servir una orden COMPLETED es 409 ORDER_NOT_SERVABLE, sin sello ni fila (D9)', async () => {
    const orden = await crear();
    await service.confirmOrder(orden.id, ACTOR);
    await service.completeOrder(orden.id, ACTOR, { paymentMethod: 'CASH', cardInstallments: null, cardSurchargeAmount: null });
    const antes = await foto();

    await expect(service.markServed(orden.id, ACTOR)).rejects.toThrow(OrderNotServableError);

    expect(await servedAtOf(orden.id)).toBeNull();
    expect(await servedAudits(orden.id)).toBe(0);
    expect(await foto()).toEqual(antes); // TRANSICION_SERVIR intacta: cero efectos
  });

  it('E-I3: servir una orden CANCELLED es 409 ORDER_NOT_SERVABLE, sin sello ni fila (D9)', async () => {
    const orden = await crear();
    await service.confirmOrder(orden.id, ACTOR);
    await service.cancelOrder(orden.id, ACTOR);
    const antes = await foto();

    await expect(service.markServed(orden.id, ACTOR)).rejects.toThrow(OrderNotServableError);

    expect(await servedAtOf(orden.id)).toBeNull();
    expect(await servedAudits(orden.id)).toBe(0);
    expect(await foto()).toEqual(antes);
  });

  it('E-I4: dos markServed concurrentes -- las DOS terminan bien (CAMBIO + YA_ESTABA), un sello, UNA fila', async () => {
    const orden = await crear();
    await service.confirmOrder(orden.id, ACTOR);

    const resultados = await Promise.allSettled([
      service.markServed(orden.id, ACTOR),
      service.markServed(orden.id, ACTOR),
    ]);

    // Las DOS terminan válidamente. El SELECT ... FOR UPDATE de
    // transitionWithClient serializa las transacciones: una toma el lock,
    // sella y commitea (rama CAMBIO); la otra, al liberarse el lock, re-lee
    // served_at IS NOT NULL y devuelve el resultado idempotente (rama
    // YA_ESTABA). Ninguna rechaza.
    expect(resultados.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const valores = resultados.map((r) => {
      if (r.status !== 'fulfilled') throw new Error('markServed concurrente no debería rechazar');
      return r.value;
    });

    // Las dos respuestas traen el MISMO sello, no nulo -- la que fue CAMBIO
    // lo escribió, la que fue YA_ESTABA lo releyó.
    expect(valores[0]!.servedAt).not.toBeNull();
    expect(valores[1]!.servedAt).not.toBeNull();
    expect(valores[0]!.servedAt).toEqual(valores[1]!.servedAt);

    // Persistido: un solo sello, y coincide con lo que devolvieron.
    const persistido = await servedAtOf(orden.id);
    expect(persistido).not.toBeNull();
    expect(new Date(persistido!).getTime()).toBe(new Date(valores[0]!.servedAt!).getTime());

    // Exactamente UNA fila field='served_at': solo la rama CAMBIO audita (D5)
    // y solo una de las dos llamadas fue CAMBIO.
    expect(await servedAudits(orden.id)).toBe(1);
  });

  it('E-I5: si el INSERT de auditoría falla, el rollback deshace served_at (D4)', async () => {
    const orden = await crear();
    await service.confirmOrder(orden.id, ACTOR);
    const antes = await foto();

    const svc = buildServiceWithAudit({
      record:          async () => {},
      recordWithClient: async () => { throw new Error('audit boom (E-I5)'); },
      findByEntity:    async () => [],
    });

    await expect(svc.markServed(orden.id, ACTOR)).rejects.toThrow(/audit boom/);

    // La única prueba real de D4: el UPDATE del sello se revirtió con el INSERT.
    expect(await servedAtOf(orden.id)).toBeNull();
    expect(await servedAudits(orden.id)).toBe(0);
    expect(await foto()).toEqual(antes);
  });

  it('E-I6: actor ausente viola changed_by NOT NULL y el rollback deshace served_at', async () => {
    const orden = await crear();
    await service.confirmOrder(orden.id, ACTOR);
    const antes = await foto();

    // Simula una ruta que no pasó req.user!.id. El NOT NULL de
    // audit_log.changed_by (schema.sql BLOQUE 10) rechaza el INSERT.
    await expect(service.markServed(orden.id, undefined as unknown as string)).rejects.toThrow();

    expect(await servedAtOf(orden.id)).toBeNull();
    expect(await servedAudits(orden.id)).toBe(0);
    expect(await foto()).toEqual(antes);
  });
});
