import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Tests de integración excluidos del run por defecto: requieren
    // TEST_DATABASE_URL (BD postgres real). El `exclude` de acá abajo se
    // aplica SIEMPRE, incluso pasando el path explícito por CLI -- el
    // comentario viejo ("correrlos con: TEST_DATABASE_URL=... npx vitest
    // run src/tests/integration") no funcionaba, `--exclude` tampoco lo
    // pisa, solo lo suma (hallazgo real, 23/08/2026, pendientes-2026-08-23.md
    // sección I, "lo que surgió" al escribir un test de integración nuevo
    // para I1/I2). Correrlos de verdad con vitest.integration.config.ts,
    // que no tiene esta exclusión: TEST_DATABASE_URL=... npm run test:integration
    include: ['src/**/*.test.ts'],
    exclude: [
      'src/tests/integration/**',
      'node_modules/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        // test files
        'src/**/*.test.ts',
        // infra / sin tests todavía
        'src/services/**',
        'src/schemas/**',
        'src/seed/**',
        'src/db/**',
        'src/openapi/**',
        'src/server.ts',
        'src/app.ts',
        'src/container.ts',
        // I7 (24/08/2026, pendientes-2026-08-24.md) -- composición pura,
        // mismo criterio que container.ts/app.ts/server.ts de arriba: solo
        // instancia clases, sin lógica propia que testear.
        'src/platform/platform.container.ts',
        'src/repositories/supabase.occupancy.repository.ts',
        // interfaces y tipos puros — sin lógica ejecutable
        'src/repositories/customer.repository.ts',
        'src/repositories/occupancy.repository.ts',
        'src/repositories/reservation.repository.ts',
        'src/repositories/resource.repository.ts',
        'src/repositories/sql.client.ts',
        'src/domain/**/*.types.ts',
        'src/types/**',
        'src/security/user.types.ts',
        // implementaciones SQL sin tests todavía
        'src/repositories/sql.customer.repository.ts',
      ],
      thresholds: {
        // I7 (24/08/2026, pendientes-2026-08-24.md) -- Fase 2 alcanzada:
        // se sacaron las exclusiones de src/api/**, src/platform/**,
        // src/security/** (antes ni se medían) y se escribieron tests de
        // ruta para los 15 archivos *.routes.ts que estaban en 0%. Estado
        // real tras el cambio: lines/statements 63.6%, functions 69.8%,
        // branches 79.3% -- el piso de acá abajo queda debajo de eso a
        // propósito (margen para fluctuación normal, no para que baje sin
        // que nadie lo note).
        // Objetivo Fase 3: lines/functions/statements → 80%, branches → 70%
        lines: 60,
        functions: 60,
        branches: 50,
        statements: 60,
      },
    },
  },
});
