# Matriz maestra — mapa de madurez del ERP

**Corrida:** erp-auditoria-v2 · **Fecha:** 02/09/2026
**Método:** `00-programa-v2.md` · **Inventario:** `01-inventario-verificado.md`
**Estado de la corrida:** ✅ **completa** — las 21 filas del inventario tienen
ficha, y las 431 anclas citadas resuelven (`scripts/validar-anclas.py`).

---

## 1. Resultado en una línea

**Ningún módulo del ERP está `✅ Completo`.** Diecinueve de veintiuno quedan
`⚠️ Revisado con brechas`, uno queda `◌ Huérfano` (Caja) y uno queda
parcialmente `⛔ Bloqueado` (Facturación). No es un juicio sobre la calidad del
código —que es alta y está inusualmente bien documentado— sino sobre el cierre
de los ciclos de negocio.

**158 hallazgos:** 4 S0 · 42 S1 · 57 S2 · 38 S3 · 17 S4.
**85 son nuevos**, 24 cruzan con un ítem ya conocido (`↔`) y 18 lo contienen
(`⊃`).

---

## 2. Los cuatro S0

Son cuatro, y tres de ellos son el mismo problema visto desde tres lados: **la
plata se puede mover sin dejar rastro y sin poder corregirse.**

| ID | Módulo | Qué | Evidencia |
|---|---|---|---|
| `A2-M04-001` | Cuentas corrientes | Un pago mal cargado no se puede revertir por ningún camino del producto. `VOIDED` existe en el `CHECK` y es inalcanzable para un `PAYMENT`. | `src/db/schema.sql:2085`; `src/clientes-finanzas/financial-transaction.repository.ts:178` |
| `A2-M04-002` | Cuentas corrientes | El cobro no registra quién cobró: `recordPayment()` no setea `confirmed_by`, y el servicio no audita. | `src/clientes-finanzas/customer-account.service.ts:133` |
| `A2-T03-001` | Auditoría | Ocho servicios que mueven plata y operación no escriben una sola fila de auditoría. | `grep -c "auditLog\|AuditLog"` = `0` en los ocho |
| `A2-M10-001` | Facturación | `cbteTipo` fijo en Factura B en los dos caminos de emisión y en el request a ARCA. | `src/facturacion/invoice.service.ts:368`, `:466`, `:540` — ↔ `FISCAL-CBTE-001` |

---

## 3. Matriz por módulo

| ID | Módulo | Estado | Sev. máx | Último paso confirmado | Primer paso incompleto | Hallazgos |
|---|---|---|---|---|---|---|
| M01 | Reservas | ⚠️ | S1 | confirmación + `CHARGE` por outbox | cancelación con reembolso: existe y la UI no la usa | 8 |
| M02 | Clientes / CRM | ⚠️ | S1 | actualización auditada | fusión de duplicados: no existe | 8 |
| M03 | Turnos | ⚠️ | S2 | confirmación del turno | `NO_SHOW`: no existe para turnos | 7 |
| M04 | Cuentas corrientes | ⚠️ | **S0** | el saldo, derivado de movimientos | el recibo — y detrás de él, todo lo demás | 10 |
| M05 | Caja | ◌ | S1 | cierre con arqueo (en el backend) | la apertura: no hay pantalla | 8 |
| M06 | POS / Órdenes | ⚠️ | S1 | cobro con auditoría de transición | el ticket | 8 |
| M07 | Productos e inventario | ⚠️ | S1 | ajuste con motivo obligatorio | entrada de mercadería con documento | 10 |
| M08 | Recursos | ⚠️ | S2 | baja con guardas | efecto de la baja sobre la historia | 6 |
| M09 | Housekeeping | ⚠️ | S2 | inspección con actor | quién ejecutó la tarea | 8 |
| M10 | Facturación | ⛔/⚠️ | **S0** | entrega del PDF | la selección fiscal, que va antes de todo | 8 |
| M11 | Reportes | ⚠️ | S1 | visualización (6 de 11) | la exportación | 8 |
| M12 | Configuración | ⚠️ | S1 | auditoría con candado por sensibilidad | vigencia y reversión | 6 |
| M13 | Portal de clientes | ⚠️ | S1 | baja de cuenta | el pago | 7 |
| M14 | Plataforma | ⚠️ | S1 | cambio de estado y plan, auditado | activación del negocio (paso manual) | 9 |
| M15 | Estadías | ⚠️ | S1 | transferencia a cuenta por cobrar | el folio como entrega | 7 |
| M16 | Tarifario y políticas | ⚠️ | S1 | aplicación del precio | administrar las tarifas: sin pantalla | 10 |
| T01 | Identidad | ⚠️ | S1 | presentación (`RES-000123`) | búsqueda por ese número | 4 |
| T02 | Usuarios y permisos | ⚠️ | S1 | reactivación | el rastro de altas y bajas | 6 |
| T03 | Auditoría | ⚠️ | **S0** | registro del cambio de campo | registro del **hecho de negocio** | 6 |
| T04 | Documentos | ◇ | S1 | reimpresión de la factura | el resto del ERP no emite documentos | 6 |
| T05 | Integraciones | ⚠️ | S1 | reintento manual del outbox | verlo: dead-letter sin pantalla | 8 |

---

## 4. Los cinco patrones que explican casi todo

La auditoría por módulo produce 158 hallazgos. Leídos juntos, **cinco patrones
transversales explican la mayoría**, y atacarlos rinde mucho más que ir módulo
por módulo.

### 4.1 El sistema audita la configuración, no la operación

Trece archivos escriben `audit_log`; los ocho servicios que mueven plata y
operación, ninguno. Se audita el maestro (producto, tarifa, recurso, cliente,
perfil del negocio) y no se audita el hecho (cobro, reembolso, check-out,
cancelación, apertura de caja, alta de usuario).

**Es al revés de lo que pide el control interno.** Bloque sugerido: **D+A**
(documento + auditoría), en `fichas/T03-auditoria.md` §15.

### 4.2 `audit_log` no puede representar una acción

Ocho columnas: entidad, campo, antes, después, quién, cuándo. No hay `action`,
`reason`, `origin` ni `correlation_id`. Aunque los ocho servicios de §4.1
empezaran a escribir hoy, **no habría dónde poner "por qué"**.

Por eso `A2-T03-002` es prerequisito de casi todo lo demás: sin extender el
modelo, agregar auditoría a los módulos produce más filas y no más respuestas.

### 4.3 Lo que se puede hacer, no se puede deshacer

`PAYMENT` sin reversión (`A2-M04-001`), orden `COMPLETED` sin anulación
(`A2-M06-001`), `accounts_receivable` `COBRADO` terminal (`A2-M04-006`),
configuración sin marcha atrás (`A2-M12-006`), negocio `CANCELLED` sin baja de
datos (`A2-M14-002`).

El sistema modela bien los estados de avance y casi no modela la corrección.

### 4.4 Backend construido, producto sin terminar

**46 endpoints reales sin consumidor conocido** (51 menos 5 falsos positivos
declarados). No están repartidos al azar: se concentran en capacidades enteras
que quedaron sin pantalla.

| Capacidad | Endpoints sin pantalla |
|---|---|
| Caja y arqueo | 5 |
| Políticas de cancelación | 5 |
| Catálogo de tarifas | 4 |
| Reportes POS y CRM | 5 |
| Movimientos de stock manuales | 3 |
| Auditoría y outbox | 2 |
| Folio de estadía | 1 |

Es el hallazgo con mejor relación esfuerzo/resultado: **el trabajo difícil ya
está hecho.**

### 4.5 Las buenas soluciones existen y están sin generalizar

Este es el hallazgo más útil de la corrida. Cinco patrones que el sistema ya
resolvió bien, cada uno aplicado en un solo lugar:

| Patrón bien resuelto | Dónde vive | Dónde falta |
|---|---|---|
| Motivo obligatorio por `CHECK` de base | `stock_movements` (`src/db/schema.sql:1593`) | reversión de pago, diferencia de arqueo, `NO_SHOW`, cambio de estado de negocio |
| Actor en columna propia, `NOT NULL` | `stock_movements.created_by` (`:1585`), `cash_register_shifts.opened_by` (`:2309`) | `financial_transactions.confirmed_by`, `stays.checked_out_by` |
| Segregación de funciones | ajuste de precio de reserva (`src/reservas/reservations.routes.ts:13`), override de housekeeping (`src/pms-estadias/stays.routes.ts:13`) | **todos** los flujos de dinero |
| Auditoría de transición dentro de la transacción, fail-loud | `src/pos-menu/order.service.ts:314` | reservas, estadías, pagos, caja |
| Exposición de datos protegida por test de conjunto exacto | `src/platform/business-context.routes.ts:66` | cualquier otro endpoint que devuelva una entidad rica |

**Ninguna de las cinco brechas centrales requiere inventar nada.** Requiere
generalizar lo que este repositorio ya sabe hacer.

---

## 5. Bloques de implementación sugeridos

Ordenados por dependencia, no por severidad. `[P]` — son propuestas; ninguna
está aprobada.

| # | Bloque | Cierra | Depende de |
|---|---|---|---|
| B1 | Extender el modelo de auditoría: `action`, `reason`, `origin`, `correlation_id` | `A2-T03-002`, habilita B2 y B4 | — |
| B2 | Reversión gobernada de pago: movimiento inverso vinculado, motivo clasificado, idempotente, auditado | `A2-M04-001`, `A2-M04-002`, `A2-M06-001` | B1 |
| B3 | Pantalla de caja + egresos de caja | `A2-M05-001`, `A2-M05-002`, `A2-M05-003` | — |
| B4 | Auditoría de hechos en los ocho servicios de §4.1 | `A2-T03-001` y sus siete `⊃` | B1 |
| B5 | Recibo de cobro como documento con número | `A2-T04-001`, `A2-M04-003`, `A2-M15-001` | T01 (numeración) |
| B6 | Pantallas de tarifario y políticas de cancelación | `A2-M16-001`, `A2-M16-002` | — |
| B7 | Segregación de funciones en flujos de dinero | `A2-T02-002` y sus `⊃` | — |
| B8 | Reportes de reconciliación y exportación | `A2-M11-002`, `A2-M11-003` | — |

**B3 y B6 no dependen de nada y son las de mejor relación esfuerzo/resultado**:
conectan backend ya construido y probado.

---

## 6. Decisiones que necesitan al dueño

No son brechas técnicas: son preguntas de producto que la auditoría no puede
responder sola.

1. **¿Compras y proveedores entran al alcance?** Hoy no existen y no figuran en
   ningún `pendientes-*` ni como fila propia del roadmap (`A2-M07-001`).
2. **¿Contabilidad?** El ledger es comercial, no contable
   (`01-inventario-verificado.md` §4).
3. **¿La plataforma le va a facturar a sus clientes?** (`A2-M14-003`).
4. **¿La caja es por negocio o por punto de venta?** (`A2-M05-005`).
5. **¿Hace falta moneda por tarifa?** (`A2-M16-007`).
6. **¿Turnos y alojamiento comparten serie de numeración?** (`A2-M03-005`).
7. **¿Planilla de pasajeros?** Obligación a confirmar (`A2-M15-004`).
8. Las decisiones ya abiertas de `FACT-BORRADOR-001` (6) y `C1-Fase A` (3), que
   esta auditoría **no** re-abre.

---

## 7. Lo que esta corrida no verificó

Declarado para que no se lea como cobertura completa. Veinte hallazgos
quedaron marcados `[H]`, cada uno con su método de confirmación en la ficha. Los
cuatro que más pesan:

| Qué | Ficha | Cómo se cierra |
|---|---|---|
| Si existen filas `CHARGE` con `payment_method='CASH'` que inflen el arqueo | `M04` §9 | consulta contra datos reales |
| Si la consulta de saldo mezcla monedas en la práctica | `M12` §14 | consulta contra datos reales |
| Si `inventory_levels` puede divergir de `stock_movements` | `M07` §9 | lectura del repositorio + consulta |
| Cómo se resuelve un comprobante `FAILED_UNCERTAIN` | `M10` §12 | lectura de `invoice.service.ts` completo |

Tampoco se ejecutó nada: **no se corrieron los tests, ni se tocó producción, ni
se consultó ninguna base**. Toda la evidencia es de código y de configuración.

---

## 8. Hallazgo sobre el propio proceso

`pendientes-2026-09-01.md` declara `D6-FRONTEND-001` como "backend hecho y
pusheado; **frontend sin empezar**". **Está implementado y commiteado** `[V]`:
cinco commits en `appfrontend-main` (`35c693e`, `472d5f2`, `7d551d8`, `d7ff13c`,
`e36d24f`), el helper único vive en
`appfrontend-main/src/lib/business-context/numero-operativo.ts:1` y está aplicado
en las cuatro pantallas.

Es exactamente el modo de falla que la regla 2 del `CLAUDE.md` de `app-main`
("al arrastrar, se re-chequea el ancla") existe para evitar, y esta vez el
desfase fue de horas, no de días. `A2-T01-004` lo registra; marcarlo
`✅ RESUELTO` in-place es una edición al archivo de pendientes, fuera del alcance
de esta corrida (`00-programa-v2.md` §5.1).

---

## 9. Cómo se reproduce todo esto

```bash
cd app-main
bash   docs/erp-auditoria-v2/scripts/extraer-endpoints.sh > docs/erp-auditoria-v2/datos/endpoints.csv
bash   docs/erp-auditoria-v2/scripts/extraer-montajes.sh  > docs/erp-auditoria-v2/datos/montajes.csv
python docs/erp-auditoria-v2/scripts/extraer-consumo-frontend.py
python docs/erp-auditoria-v2/scripts/extraer-uso-tablas.py
python docs/erp-auditoria-v2/scripts/cruzar-cobertura.py
python docs/erp-auditoria-v2/scripts/extraer-hallazgos.py
python docs/erp-auditoria-v2/scripts/validar-anclas.py
```

Salidas: `datos/*.csv` (hechos base), `fichas/*.md` (21 fichas),
`datos/hallazgos.csv` (158 filas ordenadas por severidad) y este documento.
