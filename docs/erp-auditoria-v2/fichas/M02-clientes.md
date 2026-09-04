# M02 · Clientes / CRM

**Auditado:** 02/09/2026 · **Método:** `00-programa-v2.md`

## 1. Flujo auditado

alta → identificación → actualización → uso comercial → historial →
baja / fusión de duplicados

## 2. Estado

- **Módulo:** ⚠️ Revisado con brechas
- **Flujo "alta, identificación y actualización":** ✅ Completo
- **Flujo "baja":** ◇ Parcial — hay soft-delete (`active`), no hay política
  escrita de qué pasa con la historia
- **Flujo "fusión de duplicados":** ◌ No existe

## 3. Último paso confirmado / primer paso incompleto

- **Último paso confirmado:** la actualización auditada. El hueco de auditar
  sólo `customer_rates` y nunca los campos propios del cliente se cerró en I9
  (23/08/2026) y hoy `displayName`, `kind`, `active` y `enableCurrentAccount`
  dejan diff `[V]` (`src/clientes-finanzas/customers.routes.ts:55`,
  `:306`).
- **Primer paso incompleto:** **la fusión de duplicados**. No existe ningún
  endpoint ni servicio de merge `[V]`
  (`grep -rniE "merge|fusion" src/clientes-finanzas` sin resultado funcional).
  El propio repositorio dice que un duplicado por error de tipeo se deja
  visible a propósito, porque ocultarlo sería peor
  (`src/clientes-finanzas/customer.repository.ts:115`) — decisión razonable que
  deja el problema abierto: hay dos fichas del mismo señor, cada una con su
  saldo.

## 4. Severidad máxima

**S1** — un cliente duplicado tiene el saldo partido en dos, y no hay forma
gobernada de unirlos.

## 5. Superficie

| Pieza | Ubicación |
|---|---|
| Tablas | `customers` (`src/db/schema.sql:318`), `customer_contact_methods`, `customer_addresses`, `customer_tax_profiles`, `customer_rates`, `customer_tags`/`tags` (`:409`, `:414`) |
| Rutas | `src/clientes-finanzas/customers.routes.ts:1` — 21 endpoints |
| Pantallas | `dashboard/clientes`, `dashboard/clientes/[id]` |

## 6. Identidad

`[V]` **Es una de las dos entidades con identidad operativa** (`CLI-nnnnnn`,
`fichas/T01-identidad.md`), y la pantalla la muestra con el helper único
(`appfrontend-main/src/app/dashboard/clientes/page.tsx:145`).

`[V]` `display_name` es el campo canónico y `email` es opcional: se guarda en
`customer_contact_methods`, no en `customers`, para poder dar de alta un walk-in
con nombre y teléfono (`src/clientes-finanzas/customers.routes.ts:9`). Modelo
correcto para un mostrador real.

`[V]` **Pero `customers.email` sigue existiendo, con `UNIQUE`**
(`src/db/schema.sql:322`), en paralelo a `customer_contact_methods`. Dos lugares
para el mismo dato: uno canónico para contacto, otro para login del portal. La
convivencia funciona; el modelo no dice de una cuál manda.

`[V]` `kind IN ('INDIVIDUAL','COMPANY')` (`src/db/schema.sql:324`) — la distinción
que habilita la cuenta corriente de empresa (`fichas/M04-cuentas-corrientes.md`).

## 7. Estados

`[V]` No hay máquina de estados: hay `active BOOLEAN` (`src/db/schema.sql:326`),
soft-delete conforme a `criterios-datos.md`, y `enableCurrentAccount` como
habilitación comercial separada.

## 8. Documentos y movimientos

El cliente no produce documentos. Es el dueño de los movimientos de M04.

`[V]` `customer_tax_profiles` guarda la condición fiscal con **un perfil por
cliente**, con constraint único en la base y el motivo escrito de por qué no se
generaliza todavía a varias razones sociales (`src/db/schema.sql:2661`).

`[V]` `customer_tax_profiles.tax_condition` es **texto libre sin mapeo a los ids
de ARCA** — es uno de los tres bloqueos de `FISCAL-CBTE-001`. El dato de negocio
está capturado y no es utilizable por la integración fiscal.

## 9. Saldos y reportes

`[V]` Dos reportes de CRM —`new-vs-recurring` y `applied-rates`— **sin panel**
(`datos/cobertura.csv`). ↔ `D7`.

`[V]` `GET /api/customers` (listado sin filtro) figura sin consumidor: el panel
usa `POST /api/customers/search` (`appfrontend-main/src/lib/clientes/api.ts:17`).
Es el patrón correcto —la búsqueda es PII y va en el body— y deja el `GET`
plano como candidato a retiro.

## 10. Permisos y segregación

`[V]` `MANAGEMENT` para el grueso; `FRONT_DESK` para cuenta corriente,
facturas pendientes y registrar pago
(`src/clientes-finanzas/customers.routes.ts:843`). El perfil fiscal está detrás
de `requireModule(FACTURACION)` con el motivo escrito de por qué el gate va ahí
y no en el router entero (`src/clientes-finanzas/customers.routes.ts:322`).

## 11. Auditoría y trazabilidad

`[V]` **Audita, y bien**: `diffFields` + `recordFieldChangesWithClient` dentro de
transacción, con entidad `customers` (`src/clientes-finanzas/customers.routes.ts:59`,
`:306`). Igual que en recursos, la auditoría vive en la ruta y no en un servicio
— inconsistencia menor, resultado correcto. ⊃ `A2-M08-005`.

`[V]` Lo que **no** se audita del cliente: el alta, la baja (`active = false`) y
la asignación de tags. `diffFields` sólo corre sobre el `PATCH`.

## 12. Errores, idempotencia y fallo parcial

`[V]` Verificación de duplicado por email primario al crear
(`src/clientes-finanzas/customers.routes.ts:622`). Es una advertencia, no una
unicidad: el duplicado por nombre o por teléfono pasa igual.

## 13. Capacidad ausente

1. **Fusión de duplicados.** La brecha central.
2. **Auditoría del alta y la baja.**
3. **`tax_condition` mapeada a los ids de ARCA.** ↔ `FISCAL-CBTE-001`.
4. **Consentimiento y datos personales.** No hay campo de consentimiento de
   marketing ni de baja de comunicaciones, y el módulo guarda email, teléfono,
   domicilio y CUIT. `[H]` — si eso es exigible depende de la normativa; no está
   decidido en ningún documento del repo.
5. **Historial comercial unificado del cliente.** El estado de cuenta existe; no
   hay una vista de "todo lo que hizo este cliente" (reservas + órdenes +
   estadías + pagos).
6. **CRM real:** segmentación, campañas, recordatorios. Hay `tags` y nada que
   los consuma más allá del filtro.

## 14. Brechas

| ID | Sev | Qué falta | Evidencia | Cruce |
|---|---|---|---|---|
| `A2-M02-001` | S1 | No hay fusión de clientes duplicados: dos fichas del mismo cliente, dos saldos. | `src/clientes-finanzas/customer.repository.ts:115`; ausencia de endpoint | **nuevo** |
| `A2-M02-002` | S2 | No se audita el alta ni la baja del cliente, sólo el `PATCH`. | `src/clientes-finanzas/customers.routes.ts:306` | ⊃ `A2-T03-001` |
| `A2-M02-003` | S2 | `tax_condition` es texto libre sin mapeo a ARCA. | `src/db/schema.sql:2661` | ↔ `FISCAL-CBTE-001` |
| `A2-M02-004` | S2 | Los dos reportes de CRM no tienen panel. | `datos/cobertura.csv` | ↔ `D7` |
| `A2-M02-005` | S3 | `customers.email` y `customer_contact_methods` guardan el mismo dato, sin regla escrita de cuál manda. | `src/db/schema.sql:322` vs `src/clientes-finanzas/customers.routes.ts:9` | **nuevo** |
| `A2-M02-006` | S3 | Sin vista de historial comercial unificado del cliente. | ausencia de endpoint | **nuevo** |
| `A2-M02-007` | S3 | Sin consentimiento ni baja de comunicaciones, con PII cargada. | ausencia de columna en `customers` | **nuevo** `[H]` |
| `A2-M02-008` | S4 | `GET /api/customers` sin consumidor: el panel usa `POST /search`. | `datos/cobertura.csv` | **nuevo** |

## 15. Criterios de cierre

- Existe fusión de duplicados que reasigna movimientos e historia sin borrar.
- El alta y la baja del cliente quedan auditadas.
- `tax_condition` está mapeada a los ids de ARCA.
- Está decidido y escrito qué manda entre `customers.email` y
  `customer_contact_methods`.
