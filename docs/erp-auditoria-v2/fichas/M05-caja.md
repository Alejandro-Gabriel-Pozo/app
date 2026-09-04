# M05 · Caja y arqueo

**Auditado:** 02/09/2026 · **Método:** `00-programa-v2.md`

> El caso más limpio del inventario: un módulo backend correcto, completo y
> bien pensado, que **no existe para el usuario**.

## 1. Flujo auditado

apertura → ingresos y egresos → arqueo → cierre → diferencia → conciliación

## 2. Estado

- **Módulo:** ◌ Huérfano
- **Flujo "abrir y cerrar turno" en el backend:** ✅ Completo
- **Flujo "abrir y cerrar turno" en el producto:** ◌ No existe
- **Flujo "conciliación":** ◌ No existe

## 3. Último paso confirmado / primer paso incompleto

- **Último paso confirmado, en el backend:** el cierre con arqueo.
  `closeShift()` calcula `expectedCashAmount = apertura + neto de efectivo del
  turno` y persiste `variance = contado − esperado`, con el motivo escrito de
  por qué se congela al cerrar `[V]`
  (`src/clientes-finanzas/cash-register.service.ts:99`).
- **Primer paso incompleto:** **la apertura**, porque no hay desde dónde
  hacerla. Los cinco endpoints no tienen consumidor `[V]`
  (`datos/cobertura.csv`), y no hay una sola aparición de `cash-register`,
  `caja` ni `arqueo` en `appfrontend-main/src` `[V]`
  (`grep -rln "cash-register\|caja\|arqueo" appfrontend-main/src` → sin
  resultados).

## 4. Severidad máxima

**S1** — y el efecto se propaga fuera del módulo: mientras no haya turno
abierto, **todo pago en efectivo se guarda con `shift_id = NULL`**, así que
ningún arqueo futuro va a poder incluirlos.

## 5. Superficie

| Pieza | Ubicación | Consumido |
|---|---|---|
| `GET /api/cash-register/current` | `src/clientes-finanzas/cash-register.routes.ts:60` | **no** |
| `GET /api/cash-register` | `:72` | **no** |
| `GET /api/cash-register/:id` | `:87` | **no** |
| `POST /api/cash-register/open` | `:98` | **no** |
| `POST /api/cash-register/close` | `:119` | **no** |
| Tabla | `cash_register_shifts`, `src/db/schema.sql:2306` | — |
| Servicio | `src/clientes-finanzas/cash-register.service.ts:45` | — |
| Pantalla | **ninguna** | — |

## 6. Identidad

`[V]` `id` UUID, sin identidad operativa. Un turno de caja es exactamente el
tipo de cosa que se nombra en voz alta ("el turno del martes a la tarde") y no
tiene número. ⊃ `A2-T01-002`.

`[V]` `opened_by` / `closed_by` guardan la identity del actor
(`src/db/schema.sql:2309`, `src/db/schema.sql:2315`). **Es el único flujo de dinero del sistema
que sí registra quién** — y es el que no se puede usar.

## 7. Estados

`[V]` `status IN ('OPEN','CLOSED')` (`src/db/schema.sql:2313`), con un índice
único parcial que garantiza a nivel base que no haya dos turnos abiertos por
negocio (`src/db/schema.sql:2325`). El servicio no hace chequeo previo: deja que
la base sea la única fuente de verdad y traduce el `23505`
(`src/clientes-finanzas/cash-register.service.ts:70`). Es el patrón correcto
para concurrencia y está bien argumentado.

No hay estado intermedio ni reapertura. `CLOSED` es terminal.

## 8. Documentos y movimientos

`[V]` El vínculo turno↔movimiento no lo arma este servicio: lo arma
`SqlFinancialTransactionRepository.insert()` en la misma sentencia, y **sólo si
`payment_method = 'CASH'` y hay un turno OPEN**; si no, queda `NULL` para
siempre (`src/clientes-finanzas/sql.financial-transaction.repository.ts:116`;
criterio declarado también en el schema, `src/db/schema.sql:2336`).

Consecuencia directa, no hipotética: **hoy no hay forma de abrir un turno, así
que todo `shift_id` es `NULL`.** El arqueo, si mañana se conecta la pantalla,
va a arrancar de cero: lo cobrado antes no se puede reasignar.

`[V]` No hay comprobante de cierre de caja. ↔ `A2-T04-006`.

## 9. Saldos y reportes

`[V]` `expected_cash_amount` y `variance` se persisten al cerrar, no se
recalculan — decisión correcta y escrita: "un cargo que se linkee después de
cerrado no debe mover el arqueo"
(`src/clientes-finanzas/cash-register.service.ts:99`).

`[V]` Ningún reporte incluye caja: los 11 endpoints de `/api/reports/*` son de
ocupación, cuentas por cobrar, POS y CRM (`datos/cobertura.csv`).

`[V]` La consulta de efectivo esperado usa una convención de signo distinta de
la del saldo de cliente, e incluye `CHARGE` como ingreso
(`src/clientes-finanzas/sql.cash-register-shift.repository.ts:69`).
↔ `A2-M04-005`, `A2-M04-009`.

## 10. Permisos y segregación

`[V]` Los cinco endpoints exigen `MANAGEMENT`
(`datos/endpoints.csv`, filas de `cash-register.routes.ts`), detrás de
`requireModule(CUENTAS_CORRIENTES)` (`src/app.ts:388`).

Dos observaciones:

1. **Quien abre y cierra la caja es `MANAGEMENT`, y quien cobra es `FRONT_DESK`.**
   Esa separación es correcta y es el único caso del sistema donde aparece algo
   parecido a la segregación de funciones. Vale registrarlo como lo bueno que es.
2. No se reutilizó un `ModuleKey` propio a propósito, para no forzar una decisión
   de pricing todavía sin definir (`src/clientes-finanzas/cash-register.routes.ts:11`).
   Decisión declarada; se acepta.

## 11. Auditoría y trazabilidad

`[V]` `cash-register.service.ts` (125 líneas) no escribe `audit_log`
(`grep -c` = `0`). El actor queda igual, porque la tabla tiene `opened_by` y
`closed_by` propios: es el diseño que el resto de los módulos de dinero debería
haber copiado.

`[V]` La diferencia de arqueo (`variance`) se guarda **sin motivo**. Un faltante
de caja se registra como número y nadie tiene dónde explicar por qué.

## 12. Errores, idempotencia y fallo parcial

`[V]` Apertura concurrente: resuelta por índice único, una gana y la otra recibe
`ShiftAlreadyOpenError` (`src/clientes-finanzas/cash-register.service.ts:91`).

`[V]` Cierre sin turno abierto: `NoOpenShiftError`
(`src/clientes-finanzas/cash-register.service.ts:111`).

`[V]` Validación de query con Zod, agregada tras una auditoría previa —
`?limit=abc` pasaba `NaN` (`src/clientes-finanzas/cash-register.routes.ts:39`).

`[H]` No verificado: qué pasa con un pago en efectivo registrado mientras se
cierra el turno (carrera entre `insert()` y `close()`). Se confirmaría con una
prueba de integración concurrente; no hay una hoy.

## 13. Capacidad ausente

1. **La pantalla.** Todo lo demás de esta lista depende de ella.
2. **Movimientos de caja que no son cobros:** retiro de efectivo, adelanto,
   gasto menor, cambio de fondo fijo. Hoy sólo entran a la caja las filas de
   `financial_transactions` con medio `CASH`; no hay forma de registrar que se
   sacó plata del cajón para pagar el flete.
3. **Motivo obligatorio en la diferencia de arqueo.**
4. **Comprobante de cierre.**
5. **Cajas múltiples.** Un turno abierto **por negocio**, no por punto de venta
   ni por cajero (`src/db/schema.sql:2325`). Con dos mostradores, comparten caja.
6. **Conciliación de tarjeta y transferencia.** Los pagos que no son efectivo
   quedan con `shift_id NULL` por diseño y no tienen ningún otro cierre
   (`src/db/schema.sql:2336`). No hay lote de tarjeta, no hay extracto bancario.

## 14. Brechas

| ID | Sev | Qué falta | Evidencia | Cruce |
|---|---|---|---|---|
| `A2-M05-001` | S1 | Los cinco endpoints de caja no tienen pantalla: ningún turno se abre nunca. | `datos/cobertura.csv`; `grep` sin resultados en el frontend | **nuevo** |
| `A2-M05-002` | S1 | Sin turno abierto, todo pago en efectivo queda con `shift_id NULL` y no es recuperable para un arqueo futuro. | `src/clientes-finanzas/sql.financial-transaction.repository.ts:116`; `src/db/schema.sql:2336` | **nuevo** |
| `A2-M05-003` | S1 | No hay egresos de caja: retiro, gasto, adelanto, cambio de fondo. | ausencia en `datos/endpoints.csv` | **nuevo** |
| `A2-M05-004` | S2 | La diferencia de arqueo se guarda sin motivo. | `src/db/schema.sql:2319` (`variance` sin columna de motivo) | **nuevo** |
| `A2-M05-005` | S2 | Un solo turno abierto por negocio: no hay caja por punto de venta ni por cajero. | `src/db/schema.sql:2325` | **nuevo** |
| `A2-M05-006` | S2 | Tarjeta y transferencia no tienen ningún cierre ni conciliación. | `src/db/schema.sql:2336` | ⊃ ausencia "Tesorería y bancos" |
| `A2-M05-007` | S3 | Sin comprobante de cierre. | ausencia de endpoint | ↔ `A2-T04-006` |
| `A2-M05-008` | S4 | Carrera cobro/cierre no verificada. | ausencia de test | **nuevo** `[H]` |

## 15. Criterios de cierre

- Existe pantalla de caja con apertura, cierre, arqueo e historial.
- Se puede registrar un egreso de caja que no sea un cobro.
- La diferencia exige motivo.
- Está decidido —y escrito— si la caja es por negocio o por punto de venta.
- Tarjeta y transferencia tienen un cierre propio, o está escrito por qué no.

---

**Nota de método.** Este módulo es el argumento a favor de auditar por
completitud empresarial y no por calidad de código. Un `lint`, un `tsc` y la
suite de tests pasan en verde sobre `cash-register.service.ts`: el código es
bueno. La cerca RBAC lo cuenta. El módulo, para el negocio, no existe.
