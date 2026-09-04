# T01 · Identidad y numeración operativa

**Auditado:** 02/09/2026 · **Método:** `00-programa-v2.md`

## 1. Flujo auditado

creación de la entidad → asignación de número → presentación al usuario →
búsqueda por ese número → conservación del número en el histórico

## 2. Estado

- **Módulo:** ⚠️ Revisado con brechas
- **Flujo para `customers` y `reservations`:** ✅ Completo
- **Flujo para las otras nueve entidades operativas:** ◌ Huérfano (no existe)

## 3. Último paso confirmado / primer paso incompleto

- **Último paso confirmado:** presentación. El helper único
  `formatearNumeroOperativo` produce `RES-000123` / `CLI-000045` y está
  aplicado en las cuatro pantallas `[V]`
  (`appfrontend-main/src/lib/business-context/numero-operativo.ts:1`,
  usado en `appfrontend-main/src/app/dashboard/reservas/page.tsx:344`,
  `.../turnos/page.tsx:220`, `.../clientes/page.tsx:145`,
  `.../cuentas-corrientes/page.tsx:57`).
- **Primer paso incompleto:** **búsqueda por número operativo**. No hay endpoint
  que resuelva `RES-000123` → reserva. El filtro `search` de reservas busca por
  `customer_name`/`customer_email` congelados, no por número `[V]`
  (`appfrontend-main/src/lib/reservas/api.ts:14`).

## 4. Severidad máxima

**S1** — hay dos entidades con identidad humana y once sin ella; el operador
que atiende el teléfono no tiene con qué nombrar una orden, una estadía, un
cobro ni un turno de caja.

## 5. Superficie

| Pieza | Ubicación |
|---|---|
| Tabla de secuencias | `src/db/schema.sql:2710` |
| Repositorio | `src/repositories/sql.number-sequence.repository.ts:8` |
| Columnas | `src/db/schema.sql:2724` (`customers.customer_number`), `:2725` (`reservations.reservation_number`) |
| Unicidad | `src/db/schema.sql:2753`, `:2755` |
| Prefijos por tenant | `src/db/schema.sql:2762`, `:2763` |
| Helper de formato (único) | `appfrontend-main/src/lib/business-context/numero-operativo.ts:1` |

## 6. Identidad

| Entidad | ID técnico | ID operativo | Evidencia |
|---|---|---|---|
| `customers` | `VARCHAR(255)` PK | **sí** `CLI-nnnnnn` | `src/db/schema.sql:2724` |
| `reservations` | `VARCHAR(255)` PK | **sí** `RES-nnnnnn` | `src/db/schema.sql:2725` |
| `orders` | PK | **no** | DDL sin columna de número |
| `stays` | PK | **no** | `src/db/schema.sql:1806` |
| `financial_transactions` | PK | **no** | `src/db/schema.sql:2074` |
| `cash_register_shifts` | PK | **no** | `src/db/schema.sql:2306` |
| `housekeeping_tasks` | PK | **no** | `src/db/schema.sql:1867` |
| `accounts_receivable` | PK | **no** | — |
| `invoices` | PK | `cbte_nro` de ARCA | numeración externa, no propia |
| `products` / `resources` / `bookable_services` | PK | **no** | maestros; discutible que lo necesiten |

El `CHECK` de `number_sequences` es el techo estructural: sólo admite dos
valores `[V]` — `entity_type VARCHAR(20) PRIMARY KEY CHECK (entity_type IN
('CUSTOMER', 'RESERVATION'))`, `src/db/schema.sql:2711`. Agregar una tercera
entidad numerada exige migración, no configuración.

## 7. Estados

No aplica: la numeración no tiene máquina de estados. Sí tiene una propiedad
que vale como invariante: el número se asigna **una vez** y no se reutiliza
—`UPDATE ... SET next_value = next_value + 1 RETURNING next_value - 1`
`[V]` (`src/repositories/sql.number-sequence.repository.ts:9`)— así que un
`ROLLBACK` posterior deja un hueco en la secuencia. Es el comportamiento
correcto para un identificador, y conviene que esté escrito: un hueco no es un
bug.

## 8. Documentos y movimientos

El número operativo **no** llega a ningún documento. El PDF de factura usa la
numeración de ARCA `[V]` (`src/facturacion/invoice-pdf.service.ts:79`). No hay
recibo, así que no hay número de recibo. Ver `fichas/T04-documentos.md`.

## 9. Saldos y reportes

Los reportes no exponen número operativo: `datos/cobertura.csv` muestra los 11
endpoints de `/api/reports/*` y ninguno recibe ni devuelve `*_number`.
**`[V]` por búsqueda** (`grep -n "_number" src/api/routes/reports.routes.ts`
sin resultados).

## 10. Permisos y segregación

No aplica — la numeración no es una acción con permiso propio; hereda el del
endpoint que crea la entidad.

## 11. Auditoría y trazabilidad

El número **no** se audita, y está bien: es inmutable. Lo que sí falta es lo
inverso — poder ir de un número a su historia. Ver `fichas/T03-auditoria.md`,
que muestra que `GET /api/audit-log` exige `entity` + `entityId` (el UUID), no
acepta el número operativo `[V]` (`src/api/routes/audit-log.routes.ts:36`).

## 12. Errores, idempotencia y fallo parcial

`[V]` El repositorio lanza si falta la fila de la secuencia
(`src/repositories/sql.number-sequence.repository.ts:16`) — fail-loud, correcto.

`[V]` `customer_number` se excluye a propósito del `ON CONFLICT DO UPDATE` para
que un PATCH no lo pise con `NULL`; por eso el contrato del frontend lo declara
nullable aunque las lecturas vivas vengan pobladas
(`appfrontend-main/src/lib/business-context/numero-operativo.ts:9`).

## 13. Capacidad ausente

1. **Búsqueda por número operativo.** Es la operación que justifica tener el
   número. Hoy el número se muestra y no se puede usar para encontrar nada.
2. **Numeración para las entidades que el operador nombra por teléfono:** orden,
   estadía, cobro/recibo, turno de caja.
3. **Numeración configurable por sucursal o por punto de venta.** Los prefijos
   son por tenant (`business_profile`), no por `location`. Con multipropiedad
   (`docs/diseno-empresas-multipropiedad.md`) dos sucursales comparten la misma
   serie. `[H]` — si eso es problema depende del negocio; no está decidido en
   ningún documento.

## 14. Brechas

| ID | Sev | Qué falta | Evidencia | Cruce |
|---|---|---|---|---|
| `A2-T01-001` | S1 | No se puede buscar por `RES-000123` / `CLI-000045`. El número es decorativo. | `src/api/routes/audit-log.routes.ts:36`; `appfrontend-main/src/lib/reservas/api.ts:14` | **nuevo** |
| `A2-T01-002` | S1 | Nueve entidades operativas sin identidad humana; el `CHECK` de `number_sequences` sólo admite dos. | `src/db/schema.sql:2711` | ⊃ `D6-FRONTEND-001` (que resolvía la presentación de las dos que sí tienen) |
| `A2-T01-003` | S2 | La serie es por tenant, no por sucursal ni por punto de venta. | `src/db/schema.sql:2762` | **nuevo** |
| `A2-T01-004` | S3 | `pendientes-2026-09-01.md` declara `D6-FRONTEND-001` "sin empezar"; está implementado y commiteado. | 5 commits en `appfrontend-main` (`35c693e`, `472d5f2`, `7d551d8`, `d7ff13c`, `e36d24f`) | ↔ `D6-FRONTEND-001` |

## 15. Criterios de cierre

- `GET /api/reservations?search=RES-000123` resuelve, y lo mismo para clientes.
- El `CHECK` de `number_sequences` admite las entidades que el negocio nombra en
  voz alta, o hay una decisión escrita de por qué no.
- Ningún documento ni pantalla muestra un UUID donde el operador espera un
  número.
- `D6-FRONTEND-001` marcado `✅ RESUELTO` in-place en `pendientes-2026-09-01.md`.
