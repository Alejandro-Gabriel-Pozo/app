# M10 · Facturación (ARCA / AFIP)

**Auditado:** 02/09/2026 · **Método:** `00-programa-v2.md`

> **Advertencia de alcance.** Esta ficha no registra ninguna conclusión
> tributaria. Lo fiscal está analizado en
> `docs/diseno-fiscal-profile-resolver-2026-09-01.md` (en HOLD) y su corrección
> la tiene que confirmar un profesional. Acá se audita **completitud de
> producto**: si el flujo cierra, si se puede corregir, si queda registro.

## 1. Flujo auditado

preparación → selección fiscal → emisión → validación → entrega →
anulación/reimpresión

## 2. Estado

- **Módulo:** ⛔ Bloqueado (parcialmente) + ⚠️ Revisado con brechas
- **Flujo "emitir un comprobante":** ◇ Parcial
- **Flujo "elegir el comprobante correcto":** ⛔ Bloqueado — tres dependencias
  externas, ninguna de código
- **Flujo "anular":** ◇ Parcial — hay nota de crédito, sólo tipo B

## 3. Último paso confirmado / primer paso incompleto

- **Último paso confirmado:** la entrega. El PDF oficial con QR se genera de un
  comprobante ya emitido y el panel lo descarga `[V]`
  (`src/facturacion/invoice-pdf.service.ts:1`;
  `appfrontend-main/src/lib/facturacion/api.ts:32`).
- **Primer paso incompleto:** **la selección fiscal**, que está antes de todo lo
  demás. `cbteTipo` está fijo en `CBTE_TIPO_FACTURA_B` en los dos caminos de
  emisión `[V]` (`src/facturacion/invoice.service.ts:368`, `:466`) y en el
  request a ARCA (`:540`).

## 4. Severidad máxima

**S0** — documento legal que puede no corresponder a la situación fiscal del
receptor. El dueño confirmó el 01/09 que va a facturar a Responsables
Inscriptos. ↔ `FISCAL-CBTE-001`.

## 5. Superficie

| Pieza | Ubicación |
|---|---|
| Tablas | `invoices`, `invoice_items`, `invoice_charges`, `afip_tickets` (`src/db/schema.sql:2593`) |
| Servicio | `src/facturacion/invoice.service.ts:158` |
| PDF | `src/facturacion/invoice-pdf.service.ts:1` |
| Padrón | `src/facturacion/padron.service.ts:137` |
| Rutas | `src/facturacion/invoices.routes.ts:1` — 8 endpoints |
| Gate | `requireModule(FACTURACION)` sobre las **mutaciones**, no sobre los `GET` (`src/facturacion/invoices.routes.ts:14`) |

## 6. Identidad

`[V]` Es la única entidad del sistema con identidad operativa externa completa:
`pto_vta` + `cbte_tipo` + `cbte_nro` + `cae` + `cae_vto`
(`src/db/schema.sql:2594`).

`[V]` `condicion_iva_receptor_id INTEGER NOT NULL` se captura y se manda
(`src/db/schema.sql:2600`, `src/facturacion/invoice.service.ts:553`) y **no
participa** de la elección del tipo de comprobante.

## 7. Estados

`[V]` `status IN ('PENDING','ISSUED','REJECTED','FAILED_UNCERTAIN')`
(`src/db/schema.sql:2608`). El cuarto estado —"no sé si ARCA emitió"— es lo que
distingue una integración fiscal pensada de una que asume el camino feliz.

`[V]` `afip_request` y `afip_response` se guardan como `JSONB`
(`src/db/schema.sql:2610`): el comprobante conserva el diálogo exacto con ARCA.

## 8. Documentos y movimientos

Ver `fichas/T04-documentos.md`, que audita el documento en sí. Lo que agrega
esta ficha:

`[V]` La nota de crédito hereda la limitación del tipo: `NOTA_CREDITO_B` es la
única (`src/facturacion/invoice.service.ts:612`, `:655` — `CBTE_TIPO_NOTA_CREDITO_B` es la única constante de nota de crédito, `src/facturacion/afip-catalog.constants.ts:33`).

`[V]` El `REFUND` sin `reversedInvoiceId` se rechaza — un reembolso tiene que
decir qué factura corrige (`src/domain/errors.ts:166`).

## 9. Saldos y reportes

`[V]` `getOutstandingByCustomerId` alimenta el modal de conciliación de cobros
(`src/facturacion/invoice.repository.ts:47`). Es la conexión entre facturación y
cuenta corriente, y funciona.

No hay libro de IVA ventas, ni exportación para el contador, ni resumen fiscal
por período. Es la ausencia más grande del módulo después de la selección de
tipo.

## 10. Permisos y segregación

`[V]` Emitir: `FRONT_DESK`. Consolidar: `MANAGEMENT`. Credenciales AFIP:
`MANAGEMENT` (`src/facturacion/invoices.routes.ts:5`).

`[V]` Los `GET` van sin `requireModule` a propósito: exhibir un comprobante
emitido es obligación legal y no puede quedar detrás de un entitlement
revocable (`src/facturacion/invoices.routes.ts:14`). Decisión ejemplar.

Sin segregación: quien emite puede emitir la nota de crédito que la anula.

## 11. Auditoría y trazabilidad

`[V]` `invoice.service.ts` **sí** audita, y audita el campo correcto: `cbteTipo`
(`src/facturacion/invoice.service.ts:178`). Es de los pocos servicios de dinero
que escribe `audit_log`.

`[V]` No queda registro de quién descargó el PDF. ↔ `A2-T04-004`.

## 12. Errores, idempotencia y fallo parcial

`[V]` `FAILED_UNCERTAIN` cubre el caso peor. `[H]` **No verificado en esta
corrida** cómo se resuelve una fila en ese estado: si hay consulta al padrón,
reintento o decisión manual. Se confirmaría leyendo `invoice.service.ts` entero
y buscando el consumidor de ese estado.

`[V]` `GET /api/invoices/status` no tiene consumidor en el panel
(`datos/cobertura.csv`). Un comprobante en `FAILED_UNCERTAIN` no se ve desde
ninguna pantalla.

## 13. Capacidad ausente

1. **Lógica de selección A/B/C.** ⛔ Tres bloqueos, ninguno de código, detallados
   en `docs/diseno-fiscal-profile-resolver-2026-09-01.md`: no hay lógica de
   selección; `customer_tax_profiles.tax_condition` es texto libre sin mapeo a
   los ids de ARCA; y el catálogo de condición de receptor no se puede consultar
   sin certificado de producción, aunque el método ya existe
   (`src/facturacion/padron.service.ts:137`).
2. **Congelamiento de los datos del emisor y del receptor.** ↔ `A2-T04-002`.
3. **Libro de IVA ventas y exportación contable.**
4. **Pantalla del estado fiscal** (rechazos, inciertos, pendientes).
5. **Factura como borrador editable.** ↔ `FACT-BORRADOR-001`, v2.8, en HOLD, con
   6 decisiones del dueño abiertas.
6. **Líneas de factura: backend y pantalla de detalle.** ↔ `C3`.

## 14. Brechas

| ID | Sev | Qué falta | Evidencia | Cruce |
|---|---|---|---|---|
| `A2-M10-001` | **S0** | `cbteTipo` fijo en Factura B en los dos caminos de emisión y en el request a ARCA. | `src/facturacion/invoice.service.ts:368`, `:466`, `:540` | ↔ `FISCAL-CBTE-001` (no se re-describe; el detalle está en el documento de diseño) |
| `A2-M10-002` | S1 | El comprobante congela sólo `emisorCuit`; el PDF lee el resto en vivo. | `src/facturacion/invoice-pdf.service.ts:79` | ↔ `A2-T04-002` / `FISCAL-CBTE-001` |
| `A2-M10-003` | S1 | Un comprobante en `FAILED_UNCERTAIN` o `REJECTED` no se ve desde ninguna pantalla. | `datos/cobertura.csv` (`/api/invoices/status` sin consumidor) | **nuevo** |
| `A2-M10-004` | S1 | Sin libro de IVA ventas ni exportación para el contador. | ausencia en `datos/endpoints.csv` | **nuevo** |
| `A2-M10-005` | S2 | La nota de crédito hereda el tipo fijo. | `src/facturacion/invoice.service.ts:612` | ⊃ `FISCAL-CBTE-001` |
| `A2-M10-006` | S2 | Sin segregación: quien emite puede anular. | `src/facturacion/invoices.routes.ts:5` | ⊃ `A2-T02-002` |
| `A2-M10-007` | S2 | Líneas de factura sin backend ni pantalla de detalle. | — | ↔ `C3` |
| `A2-M10-008` | S3 | No se verificó cómo se resuelve un `FAILED_UNCERTAIN`. | — | **nuevo** `[H]` |

## 15. Criterios de cierre

- El tipo de comprobante se resuelve de la condición fiscal del receptor, con la
  combinación confirmada por un profesional.
- El comprobante congela emisor y receptor al emitir.
- Hay pantalla donde se ven rechazos e inciertos.
- Existe exportación fiscal por período.
- `FISCAL-CBTE-001` y `FACT-BORRADOR-001` salen de HOLD con las decisiones del
  dueño tomadas.
