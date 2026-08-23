# Tests

Suite de tests usando [Vitest](https://vitest.dev/).

## Estructura

```
src/tests/
├── domain/
│   ├── customer.test.ts                          # Entidad Customer — validaciones del constructor
│   └── availability.test.ts                      # Lógica de disponibilidad (overlap, blocking status)
├── repositories/
│   ├── in-memory-customer.repository.test.ts     # InMemoryCustomerRepository
│   └── in-memory-customer.repository.anonymize.test.ts
├── security/
│   └── customer.auth.service.test.ts             # CustomerAuthService (register, login, timing-safe)
└── integration/
    ├── helpers/
    │   ├── db.ts       # Lifecycle: crea y destruye BD temporal por suite
    │   └── seed.ts     # Fixtures tipados: seedCategory, seedResource, seedCustomer, seedReservation
    └── reservation.service.integration.test.ts   # Tests de integración para ReservationService
```

## Tipos de test

### Unitarios (domain/, repositories/, security/)
- Sin base de datos real.
- Los repositorios usan implementaciones in-memory.
- Rápidos, sin estado externo.

### Integración (integration/)
- Requieren una BD PostgreSQL real accesible vía `TEST_DATABASE_URL`.
- Cada suite crea su propia BD temporal (`test_<uuid>`) y la destruye al finalizar.
- No usan mocks: el stack completo (repositorio SQL + TransactionManager + servicio) es real.
- Los tests corren con `vitest run --reporter=verbose`.

## Comandos

```bash
# Tests unitarios (sin BD)
npm test

# Modo watch
npm run test:watch

# Con cobertura
npx vitest run --coverage

# Tests de integración (requiere TEST_DATABASE_URL)
# `npm test`/`vitest run` normal NUNCA los corre -- vitest.config.ts los
# excluye siempre, incluso pasando este path explícito por CLI (hallazgo
# real, 23/08/2026, pendientes-2026-08-23.md sección I). Config separada:
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres npm run test:integration
```

## Variables de entorno para integración

| Variable | Descripción | Ejemplo |
|---|---|---|
| `TEST_DATABASE_URL` | Conexión al servidor PostgreSQL con permisos `CREATE DATABASE` | `postgres://postgres:postgres@localhost:5432/postgres` |

## Convenciones

- **Un `describe` por clase / función pública** probada.
- **Un `it` por comportamiento observable**, no por línea de código.
- Los tests de repositorios usan implementaciones in-memory — sin mocks de base de datos.
- Los tests de servicios (unitarios) usan repositorios in-memory reales para mayor fidelidad.
- Los tests de integración usan BD real y verifican el estado final en la BD, no solo el valor de retorno.
- Cada test es independiente: cada fixture se inserta con IDs únicos (randomUUID) y fechas que no solapan entre tests.
