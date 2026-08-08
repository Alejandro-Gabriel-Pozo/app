import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Tests de integración excluidos del run por defecto:
    // requieren TEST_DATABASE_URL (BD postgres real).
    // Correrlos con: TEST_DATABASE_URL=... npx vitest run src/tests/integration
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
        'src/api/**',
        'src/services/**',
        'src/platform/**',
        'src/security/**',
        'src/schemas/**',
        'src/seed/**',
        'src/db/**',
        'src/openapi/**',
        'src/server.ts',
        'src/app.ts',
        'src/container.ts',
        'src/repositories/supabase.occupancy.repository.ts',
        // interfaces y tipos puros — sin lógica ejecutable
        'src/repositories/customer.repository.ts',
        'src/repositories/occupancy.repository.ts',
        'src/repositories/reservation.repository.ts',
        'src/repositories/resource.repository.ts',
        'src/repositories/sql.client.ts',
        'src/domain/**/*.types.ts',
        'src/types/**',
        // implementaciones SQL sin tests todavía
        'src/repositories/sql.customer.repository.ts',
      ],
      thresholds: {
        // TODO: subir gradualmente por módulo a medida que se agregan tests.
        // Objetivo Fase 2: lines/functions/statements → 60%, branches → 50%
        // Objetivo Fase 3: lines/functions/statements → 80%, branches → 70%
        lines: 30,
        functions: 30,
        branches: 25,
        statements: 30,
      },
    },
  },
});
