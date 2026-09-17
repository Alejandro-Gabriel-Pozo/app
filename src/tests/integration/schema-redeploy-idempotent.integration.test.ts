/**
 * @file schema-redeploy-idempotent.integration.test.ts
 * @description Regresión para el incidente de deploy real del 28/08/2026
 * (docs/conocimiento/runbook-deploy-render.md, mismo tipo de falla que su
 * "Procedimiento 2" -- ver ese runbook para el precedente del 25/08).
 *
 * `schema.sql` corre de arriba a abajo como UNA transacción en cada deploy
 * (`migrate:tenants` -- idempotente, se reaplica ENTERO). Hasta hoy tenía
 * DOS bloques `DROP CONSTRAINT IF EXISTS chk_stock_movements_movement_type` +
 * `ADD CONSTRAINT` para la MISMA constraint: uno viejo (sin 'CONSUMPTION',
 * de la fase PRODUCTION del carve-out) y uno nuevo (con 'CONSUMPTION', de
 * la sesión del 27/08). El viejo corría PRIMERO -- con una fila
 * `movement_type='CONSUMPTION'` YA real en la base (la feature se probó
 * contra el server real el mismo día que se agregó), el bloque viejo
 * revienta el ADD CONSTRAINT ANTES de llegar al bloque nuevo que sí la
 * permite. El deploy entero fallaba (`Build failed`) -- Render no
 * desplegaba nada nuevo (fail-closed, seguía sirviendo la versión anterior,
 * sin datos corruptos), pero cualquier cambio bloqueaba hasta arreglar esto.
 *
 * Este test reproduce el escenario exacto: aplica schema.sql, inserta una
 * fila CONSUMPTION real (como hizo la verificación en vivo del 27/08), y
 * vuelve a aplicar schema.sql ENTERO otra vez (simula el redeploy) -- debe
 * completar sin error. `createTestDatabase()` no sirve acá (aplica el
 * schema UNA sola vez contra una BD nueva, nunca reproduce "ya hay datos
 * reales cuando se reaplica") -- este test aplica dos veces a propósito.
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 * Si no está definida, la suite se saltea (skipIfNoDb).
 */

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

import { skipIfNoDb, requireTestDatabaseUrl } from './helpers/db.js';
import { PgSqlClient } from '../../repositories/sql.client.js';
import { applyTenantSchema } from '../../platform/tenant-db.setup.js';
import { seedCategory, seedResource, seedCustomer, seedReservation } from './helpers/seed.js';

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

describe.skipIf(skipIfNoDb)('schema.sql -- redeploy con datos reales ya cargados (incidente 28/08/2026)', () => {
  let dbName: string;
  let pool: pg.Pool;

  afterAll(async () => {
    if (!pool) return;
    await pool.end();
    const baseUrl = requireTestDatabaseUrl();
    const adminPool = new Pool({ connectionString: baseUrl });
    try {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    } finally {
      await adminPool.end();
    }
  });

  it('reaplicar schema.sql con una fila CONSUMPTION real ya cargada NO revienta (antes rompía todo el deploy)', async () => {
    const baseUrl = requireTestDatabaseUrl();
    const schemaSql = readFileSync(resolve(__dirname, '../../db/schema.sql'), 'utf-8');

    dbName = `test_redeploy_${randomUUID().replace(/-/g, '')}`;
    const adminPool = new Pool({ connectionString: baseUrl });
    try {
      await adminPool.query(`CREATE DATABASE "${dbName}"`);
    } finally {
      await adminPool.end();
    }

    const url = new URL(baseUrl);
    url.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: url.toString(), max: 5 });
    const db = new PgSqlClient(pool);

    // 1) Deploy inicial -- primera vez que corre schema.sql en esta BD.
    await db.query(schemaSql, []);

    // 2) La feature se usa de verdad: una fila CONSUMPTION real, igual que
    //    la verificación en vivo del 27/08 (producto + destino + movimiento).
    await db.query(
      `INSERT INTO products (id, business_id, name, base_price, sku) VALUES ('prod-redeploy-1', 'biz-redeploy-1', 'Producto Redeploy', 100, 'SKU-REDEPLOY-1')`,
    );
    await db.query(
      `INSERT INTO consumption_destinations (id, business_id, name) VALUES ('dest-redeploy-1', 'biz-redeploy-1', 'Personal')`,
    );
    // location_id: NOT NULL para todo movement_type != 'TRANSFER'
    // (chk_stock_movements_location) -- 'loc-default' lo crea el propio
    // schema.sql (BLOQUE locations, arriba) si la BD no tiene ninguna fila.
    await db.query(
      `INSERT INTO stock_movements (id, business_id, product_id, movement_type, quantity, created_by, consumption_destination_id, location_id)
       VALUES ('mov-redeploy-1', 'biz-redeploy-1', 'prod-redeploy-1', 'CONSUMPTION', 3, 'user-redeploy-1', 'dest-redeploy-1', 'loc-default')`,
    );

    // 3) El redeploy siguiente -- MISMO schema.sql, reaplicado ENTERO,
    //    contra una BD que YA tiene la fila CONSUMPTION real de arriba.
    //    Antes del fix esto tiraba: "check constraint
    //    chk_stock_movements_movement_type... is violated by some row".
    await expect(db.query(schemaSql, [])).resolves.not.toThrow();

    // La fila real sigue intacta -- el redeploy no debe tocar datos de negocio.
    const { rows } = await db.query<{ movement_type: string }>(
      `SELECT movement_type FROM stock_movements WHERE id = 'mov-redeploy-1'`,
    );
    expect(rows[0]?.movement_type).toBe('CONSUMPTION');
  }, 60_000);

  /**
   * Bloque A de docs/diseno-factura-borrador-2026-08-31.md §29.7 (gate
   * architecture-governor, 15/09/2026, SOLO schema): `service_items` nueva +
   * `order_items.service_item_id` + rediseño de los 2 CHECK polimórficos de
   * `order_items` a nombre nuevo (chk_order_item_type /
   * chk_order_item_polymorphic_service), mismo criterio que v51 (guard
   * pg_constraint con nombre nuevo, para que el DROP+ADD del segundo deploy
   * sea un no-op barato en vez de revalidar la tabla entera). Reproduce el
   * mismo patrón que el test de arriba: aplica schema.sql, inserta una fila
   * SERVICE real (order_item + service_item), reaplica schema.sql ENTERO
   * -- no debe fallar, y la fila real debe seguir intacta.
   */
  it('reaplicar schema.sql con un order_item SERVICE real ya cargado NO revienta (Bloque A, service_items)', async () => {
    const baseUrl = requireTestDatabaseUrl();
    const schemaSql = readFileSync(resolve(__dirname, '../../db/schema.sql'), 'utf-8');

    const svcDbName = `test_redeploy_svc_${randomUUID().replace(/-/g, '')}`;
    const adminPool = new Pool({ connectionString: baseUrl });
    try {
      await adminPool.query(`CREATE DATABASE "${svcDbName}"`);
    } finally {
      await adminPool.end();
    }

    const url = new URL(baseUrl);
    url.pathname = `/${svcDbName}`;
    const svcPool = new Pool({ connectionString: url.toString(), max: 5 });
    const db = new PgSqlClient(svcPool);

    try {
      // 1) Deploy inicial.
      await db.query(schemaSql, []);

      // 2) Uso real: catálogo de servicio + una orden con un order_item
      //    item_type='SERVICE' referenciándolo -- el camino que la
      //    constraint polimórfica nueva tiene que aceptar.
      await db.query(`INSERT INTO locations (id, name) VALUES ('loc-svc-redeploy-1', 'Sucursal Redeploy')`);
      await db.query(
        `INSERT INTO service_items (id, business_id, name, price) VALUES ('svcitem-redeploy-1', 'biz-svc-redeploy-1', 'Cargo por cancelacion', 500.00)`,
      );
      await db.query(
        `INSERT INTO orders (id, business_id, location_id, status, total_amount) VALUES ('order-svc-redeploy-1', 'biz-svc-redeploy-1', 'loc-svc-redeploy-1', 'DRAFT', 500.00)`,
      );
      await db.query(
        `INSERT INTO order_items (id, order_id, item_type, service_item_id, quantity, unit_price, subtotal)
         VALUES ('oi-svc-redeploy-1', 'order-svc-redeploy-1', 'SERVICE', 'svcitem-redeploy-1', 1, 500.00, 500.00)`,
      );

      // 3) El redeploy siguiente -- MISMO schema.sql, reaplicado ENTERO,
      //    contra una BD que YA tiene la fila SERVICE real de arriba.
      await expect(db.query(schemaSql, [])).resolves.not.toThrow();

      // Los datos reales siguen intactos.
      const { rows } = await db.query<{ item_type: string; service_item_id: string }>(
        `SELECT item_type, service_item_id FROM order_items WHERE id = 'oi-svc-redeploy-1'`,
      );
      expect(rows[0]?.item_type).toBe('SERVICE');
      expect(rows[0]?.service_item_id).toBe('svcitem-redeploy-1');

      // Los nombres nuevos de los CHECK son los que quedan activos --
      // los viejos (order_items_item_type_check / chk_order_item_polymorphic)
      // ya no existen tras el segundo deploy.
      const { rows: constraints } = await db.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'order_items'::regclass AND contype = 'c'`,
      );
      const names = constraints.map((c) => c.conname);
      expect(names).toContain('chk_order_item_type');
      expect(names).toContain('chk_order_item_polymorphic_service');
      expect(names).not.toContain('order_items_item_type_check');
      expect(names).not.toContain('chk_order_item_polymorphic');
    } finally {
      await svcPool.end();
      const cleanupPool = new Pool({ connectionString: baseUrl });
      try {
        await cleanupPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [svcDbName],
        );
        await cleanupPool.query(`DROP DATABASE IF EXISTS "${svcDbName}"`);
      } finally {
        await cleanupPool.end();
      }
    }
  }, 60_000);
});

/**
 * D-07(c) (16/09/2026, docs/auditoria-integral-fase15-2026-09-16.md,
 * docs/inventario-dml-schema-2026-09-16.md) -- las 3 sentencias DML de
 * schema.sql con "condición de disparo abierta" (D-07/F10-02, F10-16,
 * F10-17) se gatean por versión. Este bloque usa `applyTenantSchema()`
 * real (no `db.query(schemaSql, [])` a secas como el resto del archivo)
 * porque es la función que ADEMÁS inserta la fila de `schema_migrations`
 * -- sin eso, el gate nunca vería la versión ya aplicada y el DML de
 * abajo correría en cada reapply igual que antes del fix, dejando el
 * test en falso verde.
 *
 * FORMA DEL GATE (corregida 17/09/2026, SCHEMA-VERSION-GATE-NOT-PERMANENT-001,
 * decisión del dueño, opción A -- docs/resuelto.md): ya no es
 * `schema_migrations version = 60` (igualdad exacta) -- pasó a
 * `(SELECT COALESCE(MAX(version), 0) FROM schema_migrations) < 60`. Un
 * tenant cuya versión más alta ya pasó el cutover 60 nunca vuelve a
 * correr el DML, sin depender de que la fila 60 exacta exista.
 *
 * ESTE COMMIT RETIRA EL CANARIO que este describe block era hasta ahora:
 * antes del fix, bumpear `CURRENT_SCHEMA_VERSION` a 61 sin actualizar
 * estos gates ponía los 3 tests de abajo en rojo (el `MAX` real seguía
 * en 60 tras el reapply con la nueva versión, pero el gate viejo
 * comparaba contra la constante hardcodeada `60` de este archivo, que
 * dejaba de coincidir con la versión real que `applyTenantSchema()`
 * acababa de insertar). Con `MAX(version) < 60`, un bump a 61 hace que
 * `MAX` pase a 61 tras el reapply, `61 < 60` da `FALSE`, el DML se
 * saltea -- y estos 3 tests siguen en VERDE, porque ese es exactamente
 * el comportamiento correcto (el backfill ya no debe correr para un
 * tenant que superó el cutover). El aviso automático de "che, revisá si
 * hay que bumpear el número del gate" desaparece -- ver
 * `docs/pendientes-2026-09-12.md`, cerca de numeración de gates de
 * versión (bloque siguiente, no decidido todavía).
 */
describe.skipIf(skipIfNoDb)('D-07(c) -- las 3 sentencias DML de schema.sql con disparo abierto quedan gateadas', () => {
  async function withIsolatedTestDb<T>(
    prefix: string,
    fn: (db: PgSqlClient, url: string) => Promise<T>,
  ): Promise<T> {
    const baseUrl = requireTestDatabaseUrl();
    const dbName = `test_${prefix}_${randomUUID().replace(/-/g, '')}`;
    const adminPool = new Pool({ connectionString: baseUrl });
    try {
      await adminPool.query(`CREATE DATABASE "${dbName}"`);
    } finally {
      await adminPool.end();
    }

    const url = new URL(baseUrl);
    url.pathname = `/${dbName}`;
    const pool = new Pool({ connectionString: url.toString(), max: 5 });
    const db = new PgSqlClient(pool);
    try {
      return await fn(db, url.toString());
    } finally {
      await pool.end();
      const cleanupPool = new Pool({ connectionString: baseUrl });
      try {
        await cleanupPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [dbName],
        );
        await cleanupPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      } finally {
        await cleanupPool.end();
      }
    }
  }

  /**
   * Reproduce la Evidencia de F10-02 (fase15:230) tal cual: fixed_price=800,
   * base_price=0 -> deploy sin cambios (base_price=0 no matchea) -> sube
   * base_price -> ANTES del gateo, el redeploy pisaba fixed_price a NULL.
   */
  it(
    'customer_rates: una tarifa fija legacy (base_price=0 al momento del primer deploy) NO se convierte en el redeploy tras subir el precio base',
    async () =>
      withIsolatedTestDb('d07_customer_rates', async (db, url) => {
        // 1) Deploy inicial -- crea las tablas Y registra schema_migrations
        //    version=60 (a diferencia del resto de este archivo, acá importa).
        await applyTenantSchema(url);

        // 2) Estado legacy: cliente + recurso con base_price=0 (el catálogo
        //    real no tenía precio cargado todavía) + tarifa fija creada
        //    ANTES del 22/08/2026 (created_at explícito, retroactivo a
        //    propósito). Usa los seeds compartidos de helpers/seed.ts para
        //    customer_number/location_id (NOT NULL sin default, ver su
        //    propio docblock) -- no repite esas columnas a mano acá.
        const customer = await seedCustomer(db);
        const category = await seedCategory(db);
        const resource = await seedResource(db, category.id, { basePrice: 0 });
        await db.query(
          `INSERT INTO customer_rates (id, business_id, customer_id, resource_id, fixed_price, created_at)
           VALUES ('cr-d07-1', 'biz-d07-1', $1, $2, 800, '2026-01-01T00:00:00Z')`,
          [customer.id, resource.id],
        );

        // 3) Operación normal de catálogo: el precio base pasa a tener valor real.
        await db.query(`UPDATE resources SET base_price = 1000 WHERE id = $1`, [resource.id]);

        // 4) Redeploy -- MISMO CURRENT_SCHEMA_VERSION, schema_migrations ya
        //    tiene la fila de la versión 60 (paso 1). Antes del gateo, este
        //    paso convertía fixed_price=800 -> discount_percentage=20, NULL.
        await applyTenantSchema(url);

        const { rows } = await db.query<{ fixed_price: string | null; discount_percentage: string | null }>(
          `SELECT fixed_price, discount_percentage FROM customer_rates WHERE id = 'cr-d07-1'`,
        );
        expect(rows[0]?.fixed_price).toBe('800.00');
        expect(rows[0]?.discount_percentage).toBeNull();
      }),
    60_000,
  );

  it(
    'invoices.afip_contacted: una fila FAILED_UNCERTAIN creada DESPUÉS del primer deploy no se revierte en el redeploy (F10-16)',
    async () =>
      withIsolatedTestDb('f10_16_invoices', async (db, url) => {
        // 1) Deploy inicial -- registra schema_migrations version=60. Nada
        //    para tocar todavía (la tabla invoices está vacía).
        await applyTenantSchema(url);

        // 2) Fila creada DESPUÉS del primer deploy, con el mismo estado que
        //    el backfill original corregía: FAILED_UNCERTAIN,
        //    afip_contacted=TRUE, error_message que matchea el patrón.
        //    seedCustomer() resuelve customer_number (NOT NULL sin default).
        const customer = await seedCustomer(db);
        await db.query(
          `INSERT INTO financial_transactions (id, business_id, customer_id, type, amount)
           VALUES ('ft-f1016-1', 'biz-f1016-1', $1, 'CHARGE', 100)`,
          [customer.id],
        );
        await db.query(
          `INSERT INTO invoices (
             id, business_id, financial_transaction_id, customer_id, idempotency_key, environment,
             pto_vta, cbte_tipo, concepto, doc_tipo, doc_nro, condicion_iva_receptor_id,
             imp_neto, imp_iva, imp_total, status, afip_contacted, error_message
           ) VALUES (
             'inv-f1016-1', 'biz-f1016-1', 'ft-f1016-1', $1, 'idem-f1016-1', 'homologacion',
             1, 6, 1, 99, '0', 5,
             100, 21, 121, 'FAILED_UNCERTAIN', TRUE, 'no se pudo consultar FECompUltimoAutorizado: timeout'
           )`,
          [customer.id],
        );

        // 3) Redeploy -- antes del gateo, esto pisaba afip_contacted a FALSE
        //    (habilitando un reintento automático) sin que nadie lo pidiera.
        await applyTenantSchema(url);

        const { rows } = await db.query<{ afip_contacted: boolean }>(
          `SELECT afip_contacted FROM invoices WHERE id = 'inv-f1016-1'`,
        );
        expect(rows[0]?.afip_contacted).toBe(true);
      }),
    60_000,
  );

  it(
    'reservation_lines: una reserva sin líneas creada DESPUÉS del primer deploy no recibe líneas fabricadas en el redeploy (F10-17)',
    async () =>
      withIsolatedTestDb('f10_17_reservation_lines', async (db, url) => {
        // 1) Deploy inicial -- registra schema_migrations version=60. No hay
        //    reservas todavía, el loop del backfill no encuentra nada.
        await applyTenantSchema(url);

        // 2) Reserva creada DESPUÉS del primer deploy, sin reservation_lines
        //    -- mismo estado que el docblock del backfill describe para una
        //    reserva legacy restaurada o un camino que salta syncLines().
        //    seedReservation() resuelve reservation_number/deposit_amount
        //    (NOT NULL sin default) y NO inserta reservation_lines -- ese es
        //    justo el estado que este test necesita reproducir.
        const customer = await seedCustomer(db);
        const category = await seedCategory(db);
        const resource = await seedResource(db, category.id, { basePrice: 500 });
        const reservation = await seedReservation(db, resource.id, customer.id, {
          startTime: new Date('2026-09-20T10:00:00Z'),
          endTime: new Date('2026-09-22T10:00:00Z'),
          totalPrice: 1000,
        });

        // 3) Redeploy -- antes del gateo, esto fabricaba 2 reservation_lines
        //    (una aproximación por noche) que nadie pidió.
        await applyTenantSchema(url);

        const { rows } = await db.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM reservation_lines WHERE reservation_id = $1`,
          [reservation.id],
        );
        expect(rows[0]?.count).toBe('0');
      }),
    60_000,
  );
});
