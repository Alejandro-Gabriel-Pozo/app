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
