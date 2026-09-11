/**
 * @file db.test.ts
 * @description `INTEGRATION-HARNESS-DROPDB-MASK-01` (11/09/2026, gate
 * `architecture-governor`) -- prueba puntual del guard de
 * `dropTestDatabase()`: cuando `pool` es `undefined` (createTestDatabase()
 * falló en beforeAll antes de devolverlo), no debe tirar. No necesita
 * Postgres real -- por eso NO usa `describe.skipIf(skipIfNoDb)` como el
 * resto de este directorio: corre siempre, con o sin TEST_DATABASE_URL,
 * aunque vitest.integration.config.ts sea el único runner que lo alcanza
 * (vitest.config.ts excluye `src/tests/integration/**` siempre).
 */

import { describe, it, expect } from 'vitest';
import { dropTestDatabase } from './db.js';

describe('dropTestDatabase() -- guard cuando pool nunca se asignó', () => {
  it('no tira si pool es undefined (createTestDatabase() falló en beforeAll)', async () => {
    await expect(dropTestDatabase('cualquier_nombre', undefined)).resolves.toBeUndefined();
  });
});
