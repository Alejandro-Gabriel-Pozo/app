# M11 · Reportes

**Auditado:** 02/09/2026 · **Método:** `00-programa-v2.md`

## 1. Flujo auditado

origen del dato → cálculo → filtro → visualización → exportación →
reconciliación

## 2. Estado

- **Módulo:** ⚠️ Revisado con brechas
- **Flujo "ver ocupación y cuentas por cobrar":** ✅ Completo
- **Flujo "ver POS y CRM":** ◌ Huérfano — 5 de 11 endpoints sin panel
- **Flujo "exportar":** ◌ No existe

## 3. Último paso confirmado / primer paso incompleto

- **Último paso confirmado:** la visualización. Seis endpoints tienen panel
  (`appfrontend-main/src/app/dashboard/reportes/page.tsx:361` y siguientes).
- **Primer paso incompleto:** **la exportación**. No hay CSV, XLSX ni PDF en
  ningún reporte `[V]` (`grep -rniE "csv|xlsx|export"` sobre
  `reports.routes.ts` y `report.service.ts` → sólo `export function`/`export
  interface`, ninguna exportación de datos). Un reporte que no sale del navegador
  no sirve para el contador ni para una reunión.

## 4. Severidad máxima

**S2** — el dato existe y es correcto; falta llegar a destino.

## 5. Superficie

| Endpoint | Panel |
|---|---|
| `GET /api/reports/occupancy` | sí |
| `GET /api/reports/occupancy/summary` | sí |
| `GET /api/reports/occupancy/by-category` | sí |
| `GET /api/reports/occupancy/underutilized` | sí |
| `GET /api/reports/accounts-receivable` | sí |
| `GET /api/reports/pos/sales-by-product` | **no** |
| `GET /api/reports/pos/waste` | **no** |
| `GET /api/reports/pos/ticket-summary` | **no** |
| `GET /api/reports/crm/new-vs-recurring` | **no** |
| `GET /api/reports/crm/applied-rates` | **no** |
| `DELETE /api/reports/occupancy/purge` | **no** |

Servicio: `src/services/report.service.ts:45`. Montaje con construcción del
servicio por request y `requireModule(REPORTES)` (`src/app.ts:394`).

## 6. Identidad

`[V]` Un reporte no es una entidad: se calcula al pedirlo. No hay reporte
guardado, versionado ni programado.

`[V]` `occupancy_records` es la única tabla del módulo, y es **derivada** — tiene
su propio `purge` (`src/api/routes/reports.routes.ts:230`). Una tabla derivada
con borrado manual y sin política de retención escrita.

## 7. Estados

No aplica.

## 8. Documentos y movimientos

No aplica — y ahí está `A2-M11-001`: un reporte que no se puede exportar tampoco
es documento.

## 9. Saldos y reportes

`[V]` **Ningún reporte de dinero salvo cuentas por cobrar.** No hay: ingresos
por período, ventas por medio de pago, cierre diario, resumen de caja, IVA
ventas. Para un ERP, el módulo de reportes está construido alrededor de la
ocupación (que es PMS), no de la plata.

`[V]` La reconciliación —que es la razón por la que el programa incluye este
módulo— **no tiene ningún reporte**: nada cruza `financial_transactions` contra
`invoices`, ni contra `cash_register_shifts`, ni contra el outbox.

## 10. Permisos y segregación

`[V]` Los once endpoints son `MANAGEMENT`, y el docblock lo declara con su
consecuencia: "HOUSEKEEPING y RECEPTIONIST no tienen acceso a reportes"
(`src/api/routes/reports.routes.ts:5`).

`[V]` **`DELETE /occupancy/purge` está al mismo nivel de permiso que leer un
reporte.** Borrar datos históricos y mirarlos piden exactamente lo mismo
(`src/api/routes/reports.routes.ts:232`). Es la brecha de control interno del
módulo: un borrado destructivo sin permiso propio, sin motivo y sin auditoría.

## 11. Auditoría y trazabilidad

`[V]` Ni la consulta ni la exportación ni el `purge` dejan rastro. El programa
pide registro sobre exportaciones y documentos (§6.6); acá no hay ninguno.
⊃ `A2-T03-001`.

## 12. Errores, idempotencia y fallo parcial

`[V]` Los cuatro schemas de query están validados con Zod
(`src/api/routes/reports.routes.ts:23`).

`[V]` El `authenticate()` local se sacó de cada handler tras un bug real: el
`authenticate()` global resuelve `permissionGroups` vía un hook, y uno local sin
ese hook pisaba `req.user`, dejaba los grupos `undefined` y `authorize()`
rechazaba con 403 a todo el mundo (`src/api/routes/reports.routes.ts:8`). Vale
conservarlo: es el tipo de bug que vuelve si alguien "ordena" los handlers.

## 13. Capacidad ausente

1. **Exportación.** CSV como mínimo.
2. **Reportes de dinero:** ingresos por período, por medio de pago, cierre
   diario.
3. **Reportes de reconciliación:** ledger vs. facturas, ledger vs. caja,
   eventos despachados vs. movimientos creados.
4. **Permiso y auditoría propios para el `purge`.**
5. **Programación y envío automático** (el reporte del lunes a la mañana por
   mail).
6. **Política de retención de `occupancy_records`.**

## 14. Brechas

| ID | Sev | Qué falta | Evidencia | Cruce |
|---|---|---|---|---|
| `A2-M11-001` | S1 | `DELETE /occupancy/purge` borra histórico con el mismo permiso que leer, sin motivo y sin auditoría. | `src/api/routes/reports.routes.ts:232` | **nuevo** |
| `A2-M11-002` | S1 | Sin ningún reporte de reconciliación: nada cruza ledger, facturas y caja. | `datos/cobertura.csv` (11 endpoints, ninguno cruza) | **nuevo** |
| `A2-M11-003` | S2 | Sin exportación en ningún formato. | `grep` sin resultados sobre `reports.routes.ts` y `report.service.ts` | **nuevo** |
| `A2-M11-004` | S2 | 5 de 11 endpoints sin panel (3 POS, 2 CRM). | `datos/cobertura.csv` | ↔ `D7` |
| `A2-M11-005` | S2 | Sin reportes de ingresos ni de cierre diario. | `datos/cobertura.csv` | **nuevo** |
| `A2-M11-006` | S3 | `occupancy_records` sin política de retención escrita, con `purge` manual. | `src/api/routes/reports.routes.ts:230` | **nuevo** |
| `A2-M11-007` | S3 | Ninguna consulta de reporte deja rastro. | ausencia de auditoría | ⊃ `A2-T03-001` |
| `A2-M11-008` | S4 | Sin envío programado. | ausencia de worker | **nuevo** |

## 15. Criterios de cierre

- Todo reporte se puede exportar.
- `purge` tiene permiso propio, motivo y auditoría.
- Existe al menos un reporte de reconciliación entre ledger, facturas y caja.
- Los cinco endpoints sin panel tienen pantalla o se retiran con la decisión
  escrita.
