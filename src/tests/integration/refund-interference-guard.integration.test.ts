/**
 * @file refund-interference-guard.integration.test.ts
 * @description REFUND-INT-GUARD-001 (08/09/2026, bloque 3.2-bis de
 * `docs/plan-cierre-cancelacion-nc-y-deuda-estructural-2026-09-08.md`, ver
 * `zulu-hub-continuidad-2026-09-08.md` §4) -- cierra la brecha de
 * verificación del guard BRECHA-REFUND-01-B (`RefundBaseChangedError` en
 * `cancellation-refund.service.ts`, `collectedRecheck !== collected`). Hoy
 * ese guard solo está probado con un fake in-memory
 * (`cancellation-refund.service.test.ts`, `ShiftingCollectedRepository`) que
 * devuelve dos números fabricados en llamadas sucesivas -- prueba la
 * ARITMÉTICA del guard, no que el mecanismo real sostenga contra Postgres.
 * Tres cosas quedaban INFERIDAS, no medidas:
 *
 * 1. El guard dispara ante una escritura CONCURRENTE REAL, no solo ante un
 *    valor fabricado por un fake.
 * 2. El ROLLBACK es real: el REFUND que esta transacción ya insertó (vía
 *    `client`, dentro de la ventana `collected → collectedRecheck`, ANTES
 *    de que el recheck aborte) no sobrevive.
 * 3. El aislamiento pool-vs-`client` se sostiene: la escritura interferente,
 *    hecha por una vía de POOL genuina -- no el `client` que sostiene la
 *    transacción -- queda COMMITEADA de verdad y visible para la relectura;
 *    el ROLLBACK de `confirmRefund()` no la arrastra consigo.
 *
 * ## Mecanismo -- decorator, no dos conexiones corriendo en paralelo
 * A diferencia de `for-key-share-lock-semantics.integration.test.ts` (que sí
 * necesita una carrera real porque mide un lock), acá no hace falta: el
 * guard compara dos LECTURAS SECUENCIALES dentro de la misma invocación
 * (variables `collected` y `collectedRecheck` en
 * `cancellation-refund.service.ts` -- cita por nombre, no línea, desde
 * SCHEMA-ANCHOR-DRIFT-001 10/09/2026). Alcanza con que la escritura
 * interferente ya haya COMMITEADO
 * antes de la segunda lectura -- determinístico, sin sleeps ni
 * `Promise.race`. Se logra decorando `createWithClient()` (el método que
 * `confirmRefund()` usa para insertar SU PROPIO REFUND, ya DENTRO de la
 * ventana `collected → collectedRecheck`): la primera vez que se invoca,
 * antes de delegar al insert real, comete un PAYMENT interferente contra la
 * misma reserva por una vía de pool genuina (`this.create()`, que usa
 * `this.sqlClient` -- nunca el `client` transaccional que recibe como
 * parámetro).
 *
 * Mismo patrón de decorator que ya usa el archivo hermano
 * (`cancellation-refund.integration.test.ts`, residual #2 Escenario A/B),
 * pero sobre OTRO colaborador: ahí se decora `businessProfileRepo.get()`,
 * que corre ANTES de `transactionManager.run()` -- sirve para probar el fix
 * de residual #2 (la interferencia entra a tiempo para que `collected` ya
 * la vea). Acá la ventana es la opuesta -- DESPUÉS de que `collected` ya se
 * leyó -- así que ese hook no serviría: si la interferencia entrara por ahí,
 * `collected` la vería de entrada y el guard nunca dispararía. Por eso se
 * decora `createWithClient()`, que corre estrictamente después de `collected`
 * (`:295`) y estrictamente antes de `collectedRecheck` (`:367`).
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 * Si no está definida, la suite completa se saltea.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCategory, seedResource, seedCustomer, seedReservation } from './helpers/seed.js';

import type { SqlClient } from '../../repositories/sql.client.js';
import type { FinancialTransaction } from '../../clientes-finanzas/financial-transaction.repository.js';
import { CancellationRefundService } from '../../reservas/cancellation-refund.service.js';
import { SqlReservationRepository } from '../../reservas/sql.reservation.repository.js';
import { SqlResourceRepository } from '../../reservas/sql.resource.repository.js';
import { SqlCancellationPolicyRepository } from '../../reservas/sql.cancellation-policy.repository.js';
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';
import { SqlBusinessProfileRepository } from '../../repositories/sql.business-profile.repository.js';
import { PgTransactionManager } from '../../db/pg.transaction-manager.js';
import { RefundBaseChangedError } from '../../domain/errors.js';

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

const BUSINESS_ID = 'biz-test-refund-int-guard-01';

/**
 * `fired` evita que un reparto multi-chunk (varias facturas) dispare la
 * interferencia más de una vez -- para este test alcanza con una, pero el
 * guard tiene que probarse con el mecanismo tal cual lo usa
 * `confirmRefund()` en general, no con una asunción de "un solo chunk".
 */
class InterferingFinancialTransactionRepository extends SqlFinancialTransactionRepository {
  private fired = false;

  constructor(
    db: SqlClient,
    private readonly reservationId: string,
    private readonly customerId: string,
    private readonly interferenceAmount: number,
  ) {
    super(db);
  }

  override async createWithClient(
    client: SqlClient,
    tx: Omit<FinancialTransaction, 'createdAt'>,
  ): Promise<FinancialTransaction | null> {
    if (!this.fired && tx.type === 'REFUND') {
      this.fired = true;
      // Por POOL (this.create() -> this.sqlClient), NUNCA por `client` --
      // es lo que hace de esto una prueba de aislamiento real y no un
      // insert más dentro de la misma transacción.
      await this.create({
        id: randomUUID(),
        businessId: BUSINESS_ID,
        customerId: this.customerId,
        reservationId: this.reservationId,
        type: 'PAYMENT',
        amount: this.interferenceAmount,
        currency: 'ARS',
        status: 'SETTLED',
      });
    }
    return super.createWithClient(client, tx);
  }
}

describe.skipIf(skipIfNoDb)('REFUND-INT-GUARD-001 -- confirmRefund() ante una escritura concurrente REAL en la ventana collected→collectedRecheck', () => {
  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  it('el guard dispara, el rollback es real, y la interferencia por pool queda commiteada -- las 3 cosas hoy inferidas, medidas contra Postgres real', async () => {
    const category = await seedCategory(db);
    const resource = await seedResource(db, category.id);
    const guest = await seedCustomer(db);
    const reservation = await seedReservation(db, resource.id, guest.id, {
      totalPrice: 1000,
      status: 'CANCELLED',
      startTime: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000), // 10 días a futuro
    });

    await db.query(
      `INSERT INTO cancellation_policies (id, business_id, min_days_before_checkin, refund_percentage)
       VALUES ($1, $2, 0, 100)`,
      [randomUUID(), BUSINESS_ID],
    );

    await new SqlFinancialTransactionRepository(db).create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: guest.id,
      reservationId: reservation.id, type: 'PAYMENT', amount: 1000,
      currency: 'ARS', status: 'SETTLED',
    });

    const interferingRepo = new InterferingFinancialTransactionRepository(db, reservation.id, guest.id, 500);

    const service = new CancellationRefundService(
      new SqlReservationRepository(db, new SqlResourceRepository(db)),
      new SqlCancellationPolicyRepository(db),
      interferingRepo,
      new SqlInvoiceRepository(db),
      new SqlBusinessProfileRepository(db),
      new PgTransactionManager(pool),
    );

    // Una sola invocación -- las dos aserciones de abajo leen la MISMA
    // promesa ya resuelta (rechazada), no dos llamadas: `fired` sólo debe
    // dispararse una vez, y una segunda invocación real ya no reproduciría
    // la ventana (la interferencia ya habría commiteado en la primera).
    const attempt = service.confirmRefund(reservation.id, BUSINESS_ID, 'user-1');

    // (1) el guard dispara ante una escritura concurrente REAL.
    await expect(attempt).rejects.toBeInstanceOf(RefundBaseChangedError);
    await expect(attempt).rejects.toMatchObject({ code: 'REFUND_BASE_CHANGED' });

    // (2) el rollback es real: el REFUND que la transacción abortada ya
    // había insertado vía `client` (createWithClient, DENTRO de la ventana,
    // ANTES del recheck que aborta) no sobrevivió al ROLLBACK.
    const { rows: refundRows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM financial_transactions WHERE reservation_id = $1 AND type = 'REFUND'`,
      [reservation.id],
    );
    expect(Number(refundRows[0]!.count)).toBe(0);

    // (3) el aislamiento pool-vs-client se sostiene: la interferencia,
    // commiteada por una vía de pool ajena al `client` de la transacción
    // abortada, sigue ahí -- el ROLLBACK de confirmRefund() no la arrastra.
    const { rows: paymentRows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM financial_transactions WHERE reservation_id = $1 AND type = 'PAYMENT'`,
      [reservation.id],
    );
    expect(Number(paymentRows[0]!.count)).toBe(2);

    // Evidencia adicional -- no es una coincidencia de conteo de filas: la
    // relectura ve efectivamente 1500 (1000 original + 500 de
    // interferencia), que es EXACTAMENTE lo que hace disparar el guard.
    const collectedAfter = await new SqlFinancialTransactionRepository(db)
      .getCollectedPaymentTotalForReservation(reservation.id);
    expect(collectedAfter).toBe(1500);
  }, 15_000);
});
