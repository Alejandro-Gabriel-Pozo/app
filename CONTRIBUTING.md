# Guía de Contribución

Este documento recoge las convenciones y reglas del proyecto derivadas de
experiencia real en code review. El objetivo es que los bugs ya encontrados
**no vuelvan a aparecer**.

---

## Índice

1. [Cambios de firma en servicios](#1-cambios-de-firma-en-servicios)
2. [Imports de infraestructura](#2-imports-de-infraestructura)
3. [Interfaces de repositorios](#3-interfaces-de-repositorios)
4. [SSL y configuración de BD](#4-ssl-y-configuración-de-bd)
5. [Tests](#5-tests)
6. [Commits](#6-commits)
7. [Schema SQL para tests de integración](#7-schema-sql-para-tests-de-integración)
8. [Import type — regla de linter](#8-import-type--regla-de-linter)

---

## 1. Cambios de firma en servicios

> **Regla:** cuando se modifica la firma de un método público de un servicio
> (agregar, quitar o cambiar un parámetro), el mismo commit **debe** incluir:
>
> 1. El servicio modificado
> 2. Todos los tests que lo usan, actualizados
> 3. Un comentario inline en el test explicando la restricción

**¿Por qué?** Un cambio de firma sin actualizar los tests rompe el CI de forma
silenciosa: TypeScript puede no detectarlo si el parámetro tiene un default,
y el test sigue compilando pero prueba el comportamiento incorrecto.

**Ejemplo — parámetro obligatorio agregado:**

```ts
// MAL — businessId sin pasar, el servicio lanzará Error en runtime
const confirmed = await service.confirmReservation('res-1');

// BIEN — constante documentada + comentario que explica por qué existe
const TEST_BUSINESS_ID = 'biz-test';

// businessId es obligatorio desde fix/reservation-businessid-required.
// Los eventos de dominio se persisten con este ID — no puede ser vacío.
const confirmed = await service.confirmReservation('res-1', TEST_BUSINESS_ID);
```

**Historial:** `confirmReservation`, `cancelReservation` y `completeReservation`
tenían `businessId = ''` como default silencioso. Un llamado sin el argumento
persistía eventos de dominio con `businessId: ''` — dato corrupto procesado
luego por el OutboxWorker. Corregido en `fix/reservation-businessid-required`.

---

## 2. Imports de infraestructura

> **Regla:** el path canónico del cliente SQL es
> `'../repositories/sql.client.js'`. No existe `'../db/sql-client.js'`.

Estructura de imports de infraestructura:

```
src/
  repositories/
    sql.client.ts          ← interfaz SqlClient  ✅ usar este
    sql.reservation.repository.ts
    housekeeping.repository.ts
    ...
  db/
    pg.client.ts           ← implementación de Pool (no exporta SqlClient)
    transaction-manager.ts
    pg.transaction-manager.ts
```

**Ejemplo:**

```ts
// MAL — path inexistente, crash en runtime
import { SqlClient } from '../db/sql-client.js';

// BIEN
import { SqlClient } from '../repositories/sql.client.js';
```

**Historial:** `housekeeping.repository.ts` tenía el import roto. Corregido
en `fix/code-review-bugs`.

---

## 3. Interfaces de repositorios

> **Regla:** antes de llamar un método de repositorio, verificar el nombre
> exacto en la interfaz del archivo `*.repository.ts` correspondiente.

Los repositorios del proyecto no tienen una convención uniforme de nombres
(razón histórica: algunos se escribieron antes del refactor multi-tenant).
Consultar siempre la interfaz:

| Repositorio | Buscar por ID |
|---|---|
| `ReservationRepository` | `getById(id)` — **no** `findById` |
| `StayRepository` | `findById(id, businessId)` |
| `HousekeepingRepository` | `findById(id, businessId)` |
| `ResourceRepository` | `getById(id)` |

**Ejemplo:**

```ts
// MAL — findById no existe en ReservationRepository → TypeError en runtime
const reservation = await this.reservationRepository.findById(
  input.reservationId,
  input.businessId,
);

// BIEN — método correcto, sin businessId (la interfaz no lo recibe)
const reservation = await this.reservationRepository.getById(
  input.reservationId,
);
```

**Historial:** `stay.service.ts` llamaba `findById()` en lugar de `getById()`.
Cada intento de check-in fallaba con `TypeError`. Corregido en
`fix/code-review-bugs`.

---

## 4. SSL y configuración de BD

> **Regla:** **nunca** usar `rejectUnauthorized: false` en producción.

`rejectUnauthorized: false` deshabilita la verificación del certificado SSL
del servidor de BD, exponiendo la conexión a ataques MITM. Render y Neon
emiten certificados válidos — no hay razón para saltear la verificación.

```ts
// MAL — deshabilita verificación SSL en producción
ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false

// BIEN
ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false
```

Si necesitás conectarte a una BD con certificado autofirmado (ej: staging
interno), pasá el CA bundle via variable de entorno:

```ts
ssl: process.env.NODE_ENV === 'production'
  ? {
      rejectUnauthorized: true,
      ...(process.env.SSL_CERT && { ca: process.env.SSL_CERT }),
    }
  : false
```

**Historial:** `container.ts` tenía `rejectUnauthorized: false`. Corregido
en `fix/code-review-bugs`.

---

## 5. Tests

### Comentarios obligatorios en restricciones no obvias

Cada vez que un test depende de una restricción de negocio o de una decisión
arquitectural no obvia (parámetro obligatorio, orden de operaciones, estado
previo requerido), agregar un comentario que explique **por qué**:

```ts
// businessId es obligatorio — el servicio valida que no esté vacío
// antes de persistir el evento de dominio (fix/reservation-businessid-required).
const confirmed = await service.confirmReservation('res-1', TEST_BUSINESS_ID);
```

### Constantes de prueba documentadas

No usar strings mágicos inline. Definir constantes con nombre descriptivo
al inicio del describe:

```ts
// BIEN
const TEST_BUSINESS_ID = 'biz-test';
const TEST_RESOURCE_ID = 'room-101';

// MAL
await service.confirmReservation('res-1', 'biz-test');
```

### Mock de TransactionManager

El `InMemoryTransactionManager` ejecuta el work directamente sin abrir
una transacción real. Es suficiente para tests unitarios porque lo que
importa es verificar que el servicio llama `saveWithClient` e
`insertWithClient` en la misma unidad de trabajo — no que haya un
`BEGIN`/`COMMIT` real.

---

## 6. Commits

> Antes que nada: ver `docs/DEFENSIVE_DEVELOPING.md`. Todo PR debe responder
> el checklist de developing defensivo (el template de PR ya lo incluye).
> Para que el checklist aparezca también al commitear localmente:
>
> ```bash
> git config commit.template .gitmessage
> ```

Usar [Conventional Commits](https://www.conventionalcommits.org/):

```
feat:  nueva funcionalidad
fix:   corrección de bug
docs:  solo documentación
test:  agregar o corregir tests
refactor: cambio de código sin fix ni feature
chore: tareas de mantenimiento (deps, config)
```

El mensaje debe responder: **¿qué cambia y por qué?**

```
# BIEN
fix(stay): reservationRepository.getById() en lugar de findById()

findById() no existe en la interfaz ReservationRepository.
Cada POST /api/stays/check-in fallaba con TypeError.

# MAL
fix: arreglo bug
```

---

## 7. Schema SQL para tests de integración

> **Regla:** el archivo `db/schema.sql` debe existir en el repo y mantenerse
> actualizado. **Nunca** borrarlo ni moverlo.

### ¿Qué es y para qué sirve?

`src/tests/integration/helpers/db.ts` lee `db/schema.sql` con `readFileSync`
**en el módulo top-level** (fuera de cualquier `beforeAll`). Esto significa
que si el archivo no existe, el proceso de Vitest falla **antes de ejecutar
cualquier test** con:

```
Error: ENOENT: no such file or directory, open '/home/runner/work/app/app/db/schema.sql'
```

La suite entera queda marcada como `FAIL` con 0 tests ejecutados.

### Estructura de archivos SQL del proyecto

```
repo/
  db/
    schema.sql              ← estado consolidado de TODA la BD  ✅ este es el que usan los tests
  supabase/
    migrations/
      001_init.sql          ← migration original (histórico)
  migrations/
    003_add_customers.sql   ← migraciones incrementales
    004_...sql
    00N_...sql
```

### Regla al agregar una migración

Cada vez que se crea un archivo en `migrations/`, el mismo commit debe
refleja el cambio también en `db/schema.sql`:

```bash
# 1. Crear la migración incremental
touch migrations/009_add_nueva_tabla.sql
# ... escribir ALTER TABLE / CREATE TABLE ...

# 2. Reflejar el cambio en el schema consolidado
#    (agregar la tabla/columna nueva al CREATE TABLE correspondiente en db/schema.sql)
vim db/schema.sql

# 3. Commitear ambos juntos
git add migrations/009_add_nueva_tabla.sql db/schema.sql
git commit -m "feat(db): add nueva_tabla — migration + schema consolidado"
```

### Contenido mínimo de db/schema.sql

El archivo debe ser **idempotente** (ejecutable múltiples veces sin error).
Usar siempre `CREATE TABLE IF NOT EXISTS` y `CREATE INDEX IF NOT EXISTS`.

```sql
-- BIEN — idempotente
CREATE TABLE IF NOT EXISTS reservations (
  id UUID PRIMARY KEY,
  ...
);

-- MAL — rompe si se corre dos veces
CREATE TABLE reservations (
  id UUID PRIMARY KEY,
  ...
);
```

**Historial:** el archivo nunca existió en el repo. Los tests de integración
fallaban con `ENOENT` en cada corrida del CI. Creado en
`fix/add-db-schema-sql` (2026-08-08).

---

## 8. Import type — regla de linter

> **Regla:** cuando todos los símbolos de un `import` se usan únicamente como
> tipos TypeScript, usar `import type { ... }` en lugar de `import { ... }`.

### ¿Por qué lo exige el linter?

La regla `@typescript-eslint/consistent-type-imports` garantiza que los
imports de solo-tipos no generen ninguna referencia en el JavaScript emitido.
El proyecto tiene `--max-warnings 0`, así que **un solo warning rompe el CI**.

### Cuándo usar cada forma

```ts
// ✅ BIEN — todos los símbolos son tipos (interfaces, type aliases, enums usados solo como tipo)
import type { Request, Response, NextFunction } from 'express';
import type { Reservation } from '../domain/Reservation.js';
import type { SqlClient } from '../repositories/sql.client.js';

// ✅ BIEN — mezcla: algunos son valores, otros son tipos → import normal
//    (UserRole se usa en runtime como valor, BusinessStatus también)
import { UserRole, BusinessStatus } from '../types/enums.js';
import { ReservationService } from '../services/reservation.service.js';

// ✅ BIEN — mezcla explícita (alternativa más granular)
import { ReservationService, type ReservationInput } from '../services/reservation.service.js';

// ❌ MAL — Request/Response/NextFunction son solo tipos en este archivo
import { Request, Response, NextFunction } from 'express';
```

### Regla práctica

| Símbolo | ¿`import type`? |
|---|---|
| Interface / `type X = ...` | Siempre `import type` |
| Clase usada solo como anotación de parámetro | `import type` |
| Clase instanciada con `new` | Import normal |
| Enum usado como valor (`UserRole.ADMIN`) | Import normal |
| Enum usado solo en anotación de tipo | `import type` |
| `Request`, `Response`, `NextFunction` de Express | Casi siempre `import type` |

### Cómo verificar antes de commitear

```bash
# Ver todos los warnings del linter
npm run lint

# Aplicar autofix (seguro — solo cambia imports)
npx eslint src --ext .ts --fix

# Verificar que no quedan warnings
npm run lint
```

### Cómo configurar el editor para evitarlo

VS Code con la extensión ESLint muestra los warnings inline. Activar
`"editor.codeActionsOnSave": { "source.fixAll.eslint": true }` en
`.vscode/settings.json` para que el fix se aplique automáticamente al
guardar.

```json
{
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  }
}
```

**Historial:** 106 warnings de `consistent-type-imports` en 50 archivos
rompieron el CI. Corregidos con `eslint --fix` via workflow
`lint-autofix.yml` (2026-08-08). El workflow se puede eliminar
una vez que el fix esté mergeado.
