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
