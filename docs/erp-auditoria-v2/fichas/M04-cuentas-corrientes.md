# M04 · Cuentas corrientes y cobros

**Auditado:** 02/09/2026 · **Método:** `00-programa-v2.md`
**Es el módulo que v1 auditó primero.** Esta ficha confirma su conclusión
(`⚠️ Revisado con brechas`) y la reemplaza con evidencia anclada.

## 1. Flujo auditado

deuda (`CHARGE`) → imputación → intención de pago → medio, moneda e importe →
confirmación → movimiento → saldo → recibo → consulta y reimpresión →
anulación/reversión → auditoría → reporte y conciliación

## 2. Estado

- **Módulo:** ⚠️ Revisado con brechas
- **Flujo "cobrar":** ◇ Parcial — registra y calcula bien; no documenta, no
  atribuye, no se puede corregir
- **Flujo "corregir un cobro mal cargado":** ◌ No existe
- **Flujo "cuenta corriente de empresa" (`accounts_receivable`):** ◇ Parcial

## 3. Último paso confirmado / primer paso incompleto

- **Último paso confirmado:** el **saldo**. Se deriva de movimientos, no se
  guarda, y la consulta es reproducible `[V]`
  (`src/clientes-finanzas/sql.financial-transaction.repository.ts:368`).
  También la imputación: `allocations` permite decir qué factura salda el pago
  `[V]` (`src/clientes-finanzas/customer-account.service.ts:121`).
- **Primer paso incompleto:** **el recibo**. Después del movimiento no hay
  documento, y a partir de ahí no cierra nada más: sin recibo no hay
  reimpresión, sin actor no hay auditoría, sin reversión no hay corrección.

## 4. Severidad máxima

**S0.**

## 5. Superficie

| Pieza | Ubicación |
|---|---|
| Ledger | `financial_transactions`, `src/db/schema.sql:2074` |
| Cuenta corriente de empresa | `accounts_receivable`, `src/db/schema.sql:2193` |
| Servicio de cuenta | `src/clientes-finanzas/customer-account.service.ts:103` (`recordPayment`), `:70` (`getStatement`) |
| Servicio de AR | `src/clientes-finanzas/accounts-receivable.service.ts:108` |
| Endpoints de cobro | `POST /api/customers/:id/payments` (`src/clientes-finanzas/customers.routes.ts:842`), `GET /:id/account` (`:818`), `GET /:id/outstanding-invoices` (`:826`) |
| Endpoints de AR | `src/clientes-finanzas/accounts-receivable.routes.ts:38`, `:56`, `:68` |
| Pantalla | `appfrontend-main/src/app/dashboard/cuentas-corrientes/page.tsx` |

## 6. Identidad

`[V]` `financial_transactions.id` es UUID; **no hay identidad operativa** — ver
`fichas/T01-identidad.md`. Un cobro no tiene número que el cliente pueda citar.

`[V]` `idempotency_key VARCHAR(512)` nullable, con índice único parcial. Es la
llave que hace idempotente el reintento del outbox
(`src/clientes-finanzas/sql.financial-transaction.repository.ts:105`).

`[V]` Semántica del `NULL` bien resuelta en el ledger: `reservation_id`,
`order_id`, `stay_id` nullable con el motivo escrito en el schema — "una vez que
el `CHARGE` se crea con el `customer_id` correcto, aparece solo"
(`src/db/schema.sql:2094`).

## 7. Estados

`[V]` `type IN ('CHARGE','PAYMENT','REFUND','ADJUSTMENT')` y
`status IN ('PENDING','SETTLED','FAILED','VOIDED')` (`src/db/schema.sql:2081`,
`src/db/schema.sql:2085`).

**`VOIDED` existe y no se puede alcanzar desde una acción del usuario.** Se
aplica sólo en cascada, desde la cancelación de reserva, y sólo sobre
`CHARGE`/`ADJUSTMENT`
(`src/clientes-finanzas/financial-transaction.repository.ts:178`). Un `PAYMENT`
mal cargado no tiene camino a `VOIDED`, ni a ningún otro estado.

`[V]` `accounts_receivable.status IN ('PENDIENTE_FACTURAR','FACTURADO','COBRADO')`,
declarado explícitamente como que "nunca vuelve atrás"
(`src/clientes-finanzas/accounts-receivable.routes.ts:6`). Una máquina de
estados sin marcha atrás y sin reversión: si se marca `COBRADO` por error, no
hay camino de vuelta.

## 8. Documentos y movimientos

`[V]` El movimiento tiene entidad propia, es inmutable en la práctica (no hay
`UPDATE` de `amount` en ningún lado) y el saldo se deriva de él. Eso está bien
hecho.

`[V]` **No hay documento.** Ningún endpoint produce un recibo. Ver
`fichas/T04-documentos.md`.

`[V]` La corrección **no** produce movimiento inverso porque no hay corrección.
El único movimiento inverso del sistema es el reembolso por cancelación
(`src/reservas/cancellation-refund.service.ts:126`), que es otro flujo.

## 9. Saldos y reportes

`[V]` Fórmula del saldo, en un solo lugar
(`src/clientes-finanzas/sql.financial-transaction.repository.ts:368`):

```
CHARGE +amount · ADJUSTMENT +amount · PAYMENT −amount · REFUND +amount
WHERE customer_id = $1 AND status = 'SETTLED'
```

`[V]` **Hay una segunda convención de signo, distinta, en otra consulta.** La de
caja (`src/clientes-finanzas/sql.cash-register-shift.repository.ts:69`):

```
PAYMENT +amount · CHARGE +amount · REFUND −amount · ELSE 0
WHERE shift_id = $1 AND payment_method = 'CASH' AND status = 'SETTLED'
```

Las dos son defendibles por separado —una mide deuda, la otra mide efectivo en
el cajón— pero el programa pide el signo definido en un solo lugar (§6.9), y acá
está definido dos veces, en dos archivos, sin nada que las mantenga coherentes.

`[V]` `GET /api/reports/accounts-receivable` existe y el panel lo consume
(`datos/cobertura.csv`). Es el único reporte financiero conectado.

`[H]` La consulta de caja suma `CHARGE` como ingreso de efectivo. Un `CHARGE`
con `payment_method = 'CASH'` quedaría vinculado al turno por el auto-link de
`insert()` (`src/clientes-finanzas/sql.financial-transaction.repository.ts:116`)
e inflaría el efectivo esperado. **No verificado si existen filas así** — hace
falta una consulta contra datos reales:
`SELECT count(*) FROM financial_transactions WHERE type='CHARGE' AND payment_method='CASH';`

## 10. Permisos y segregación

`[V]` Registrar un pago: `FRONT_DESK` + `requireModule(CUENTAS_CORRIENTES)`
(`src/clientes-finanzas/customers.routes.ts:843`).
`[V]` Marcar una deuda de empresa como cobrada: `MANAGEMENT`
(`src/clientes-finanzas/accounts-receivable.routes.ts:68`).

**Sin segregación en ningún punto.** El mismo actor registra, confirma y —si
existiera— revertiría. ⊃ `A2-T02-002`.

## 11. Auditoría y trazabilidad

`[V]` `customer-account.service.ts` (226 líneas) no escribe una sola fila de
`audit_log` (`grep -c "auditLog\|AuditLog"` = `0`).

`[V]` **`confirmed_by` existe en la tabla y `recordPayment()` nunca lo setea.**
La columna se puebla sólo desde `cancellation-refund.service.ts:126` y
`reservation.service.ts:737`; el `create()` de un pago manual no la pasa
(`src/clientes-finanzas/customer-account.service.ts:133`).

O sea: **de un cobro manual no queda registrado quién lo cobró, en ningún lado.**
Ni en el ledger, ni en la auditoría. Es la mitad que convierte a
`A2-T03-001` en S0.

`[V]` `accounts_receivable` sí guarda `transferred_by` con el motivo escrito de
por qué no tiene FK (`src/db/schema.sql:2202`). El contraste es útil: cuando el
diseño quiso guardar al actor, supo cómo.

## 12. Errores, idempotencia y fallo parcial

`[V]` Idempotencia bien resuelta: `create()` devuelve `null` si la clave ya
existía y el servicio recupera la fila real en vez de fallar
(`src/clientes-finanzas/customer-account.service.ts:154`).

`[V]` `idempotencyKey` es **opcional** en el endpoint
(`src/api/schemas/request.schemas.ts:370`). Un doble click del cajero, sin
clave, crea dos pagos. Y como no hay reversión, el segundo no se puede sacar.

`[V]` Validación correcta: lo asignado a facturas no puede superar lo pagado
(`src/clientes-finanzas/customer-account.service.ts:169`).

## 13. Capacidad ausente

1. **Reversión gobernada de un pago.** `PAYMENT_REVERSAL`/`VOID` con vínculo al
   original, motivo obligatorio y aprobación. Es la brecha central del módulo.
2. **Atribución del cobrador.**
3. **Recibo.**
4. **Conciliación bancaria.** `payment_method` admite `TRANSFER` y no hay nada
   contra qué conciliarlo — ver `01-inventario-verificado.md` §4.
5. **Corrección del titular.** Si el pago se imputó al cliente equivocado, la
   única salida es tocar la base.
6. **Marcha atrás en `accounts_receivable`.** `COBRADO` es terminal.
7. **Intereses, recargos por mora y notas de débito.** No existen.

## 14. Brechas

| ID | Sev | Qué falta | Evidencia | Cruce |
|---|---|---|---|---|
| `A2-M04-001` | **S0** | Un pago mal cargado no se puede revertir por ningún camino del producto. `VOIDED` existe y es inalcanzable para un `PAYMENT`. | `src/db/schema.sql:2085`; `src/clientes-finanzas/financial-transaction.repository.ts:178`; ninguna ruta de reversión en `datos/cobertura.csv` | **nuevo** (v1 lo señalaba sin ancla) |
| `A2-M04-002` | **S0** | El cobro no registra quién cobró: `recordPayment()` no setea `confirmed_by` y el servicio no audita. | `src/clientes-finanzas/customer-account.service.ts:133`; `grep -c` = 0 | ⊃ `A2-T03-001` |
| `A2-M04-003` | S1 | Sin recibo: el cobro no le deja nada al cliente. | ausencia de endpoint | ↔ `A2-T04-001` |
| `A2-M04-004` | S1 | `idempotencyKey` opcional en el endpoint de cobro; doble click = dos pagos irreversibles. | `src/api/schemas/request.schemas.ts:370` | **nuevo** |
| `A2-M04-005` | S1 | Dos convenciones de signo en dos archivos, sin nada que las mantenga coherentes. | `sql.financial-transaction.repository.ts:368` vs `sql.cash-register-shift.repository.ts:69` | **nuevo** |
| `A2-M04-006` | S1 | `accounts_receivable` sin marcha atrás: `COBRADO` es terminal y no hay reversión. | `src/db/schema.sql:2200`; `accounts-receivable.routes.ts:6` | **nuevo** |
| `A2-M04-007` | S1 | Saldo del cliente subdeclarado y reembolso sin nota de crédito. | — | ↔ `Gap C1-C` (sin re-describir; ver `pendientes-2026-09-01.md`) |
| `A2-M04-008` | S2 | Sin conciliación de transferencias ni de tarjeta. | `payment_method` admite `TRANSFER`/`CARD`, sin destino | ⊃ ausencia "Tesorería y bancos" |
| `A2-M04-009` | S2 | `CHARGE` con `payment_method='CASH'` inflaría el efectivo esperado del turno. | `sql.cash-register-shift.repository.ts:69`; `sql.financial-transaction.repository.ts:116` | **nuevo** `[H]` — requiere consulta a datos reales |
| `A2-M04-010` | S3 | Sin identidad operativa del movimiento. | `src/db/schema.sql:2075` | ⊃ `A2-T01-002` |

## 15. Criterios de cierre

- Existe `POST /api/financial-transactions/:id/reversal` (o equivalente) que
  crea un movimiento inverso vinculado al original, exige motivo clasificado, es
  idempotente y queda auditado con actor.
- `recordPayment()` setea `confirmed_by` con la identidad del request.
- Un cobro produce un comprobante consultable y reimprimible.
- `idempotencyKey` obligatoria en el endpoint de cobro.
- El signo de cada tipo de movimiento se define una sola vez, y las dos
  consultas lo consumen.
- `accounts_receivable` tiene camino de vuelta o está escrito por qué no.
- La consulta de `A2-M04-009` se corrió contra datos reales y su resultado está
  pegado acá.
