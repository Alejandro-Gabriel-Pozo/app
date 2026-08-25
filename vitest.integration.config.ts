import { defineConfig } from 'vitest/config';

/**
 * Config separada para tests de integración (23/08/2026,
 * pendientes-2026-08-23.md sección I — "lo que surgió" al verificar la
 * auditoría externa). `vitest.config.ts` excluye `src/tests/integration/**`
 * SIEMPRE, incluso pasando ese path explícito por CLI (`exclude` en la
 * config gana aunque se pase un include/filtro por argumento, y
 * `--exclude` desde CLI solo SUMA patrones, no reemplaza los del archivo)
 * — por eso el comando viejo documentado ahí nunca funcionó. Esta config
 * no tiene esa exclusión, así que corre justo lo que la otra no corre.
 *
 * Uso:
 *   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres \
 *     npx vitest run --config vitest.integration.config.ts
 *   (o el script `npm run test:integration`, mismo comando)
 *
 * Requiere TEST_DATABASE_URL apuntando a un servidor PostgreSQL real con
 * permisos CREATE/DROP DATABASE — ver src/tests/README.md.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/tests/integration/**/*.test.ts'],
    // 25/08/2026 -- el default de 5000ms no alcanza contra un TEST_DATABASE_URL
    // remoto/pooled (Neon u otro Postgres administrado sobre la red, no
    // localhost): CREATE DATABASE + aplicar schema.sql completo + varios
    // roundtrips por test. Encontrado verificando Bug 2 -- la suite entera
    // nunca se había corrido de punta a punta hasta esa sesión.
    testTimeout: 30_000,
  },
});
