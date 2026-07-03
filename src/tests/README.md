# Tests

Suite de tests unitarios usando [Vitest](https://vitest.dev/).

## Estructura

```
src/tests/
├── domain/
│   ├── customer.test.ts              # Entidad Customer — validaciones del constructor
│   └── availability.test.ts          # Lógica de disponibilidad (overlap, blocking status)
├── repositories/
│   └── in-memory-customer.repository.test.ts  # InMemoryCustomerRepository
└── security/
    └── customer.auth.service.test.ts # CustomerAuthService (register, login, timing-safe)
```

## Comandos

```bash
# Ejecutar todos los tests una vez
npm test

# Modo watch (re-corre al guardar)
npm run test:watch

# Con cobertura
npx vitest run --coverage
```

## Convenciones

- **Un `describe` por clase / función pública** probada.
- **Un `it` por comportamiento observable**, no por línea de código.
- Los tests de repositorios usan implementaciones in-memory — sin mocks de base de datos.
- Los tests de servicios usan repositorios in-memory reales para mayor fidelidad.
- Cada test es independiente: `beforeEach` recrea el repositorio y restaura el entorno.
