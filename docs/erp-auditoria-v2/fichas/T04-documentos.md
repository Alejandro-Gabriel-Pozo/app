# T04 · Documentos

**Auditado:** 02/09/2026 · **Método:** `00-programa-v2.md`

## 1. Flujo auditado

generación → numeración → entrega → consulta → reimpresión → anulación

## 2. Estado

- **Módulo:** ◇ Parcial
- **Flujo "factura electrónica":** ✅ Completo como documento (con la salvedad
  fiscal de `fichas/M10-facturacion.md`)
- **Flujo "cualquier otro documento":** ◌ No existe

## 3. Último paso confirmado / primer paso incompleto

- **Último paso confirmado:** reimpresión de la factura. `GET
  /api/invoices/:id/pdf` existe y el panel lo consume `[V]`
  (`appfrontend-main/src/lib/facturacion/api.ts:32`).
- **Primer paso incompleto:** **el resto del ERP no emite documentos.** No hay
  recibo de cobro, ni comprobante de reembolso, ni ticket de orden, ni
  comprobante de cierre de caja, ni remito. La única cosa imprimible del
  producto es la factura fiscal.

## 4. Severidad máxima

**S1** — un cobro en efectivo no le deja nada al cliente ni al negocio. Es la
operación más frecuente del mostrador.

## 5. Superficie

| Documento | Existe | Endpoint | Consumido |
|---|---|---|---|
| Factura / nota de crédito (PDF ARCA) | **sí** | `GET /api/invoices/:id/pdf` | sí |
| Recibo de cobro | **no** | — | — |
| Comprobante de reembolso | **no** | — | — |
| Ticket / comanda de orden | **no** | — | — |
| Comprobante de cierre de caja (arqueo) | **no** | — | — |
| Folio de estadía | **datos**, no documento | `GET /api/stays/:id/folio` (`src/pms-estadias/stays.routes.ts:177`) | no |
| Constancia de reserva para el huésped | **no** (sólo el mail de confirmación) | — | — |

## 6. Identidad

`[V]` La factura tiene identidad propia y externa: `cbte_tipo` + `cbte_nro` + CAE
de ARCA. Es el único documento del sistema con número.

El folio no tiene identidad: es una consulta que devuelve saldo y transacciones
(`src/pms-estadias/stays.routes.ts:17`), no una entidad que se pueda volver a
pedir idéntica más adelante. Si mañana cambia una tarifa o se agrega un consumo,
"el folio de ayer" no existe.

## 7. Estados

`[V]` `invoices.status` — `PENDING`, `ISSUED`, `REJECTED`, `FAILED_UNCERTAIN`
(`src/db/schema.sql:2608`). El cuarto estado es una buena señal de madurez: el
sistema distingue "ARCA lo rechazó" de "no sé qué pasó". Ningún otro documento
tiene estados porque ningún otro documento existe.

## 8. Documentos y movimientos

`[V]` El PDF se genera de un comprobante **ya emitido**, y rechaza fuerte si no
hay CAE en vez de imprimir un provisorio (`src/facturacion/invoice-pdf.service.ts:9`).
Criterio correcto y escrito.

`[V]` **Pero el PDF no está congelado.** Lee en vivo razón social, condición
fiscal y domicilio del emisor, y la razón social del receptor: reimprimir un
comprobante viejo lo muestra con los datos de hoy
(`src/facturacion/invoice-pdf.service.ts:79`). El comprobante congela sólo
`emisorCuit`. ↔ `FISCAL-CBTE-001`, hallazgo relacionado.

`[V]` Dos simplificaciones deliberadas, declaradas en el propio archivo:
`iibb`/`fechaInicioActividades` vacíos, y el receptor asumido Consumidor Final
(`src/facturacion/invoice-pdf.service.ts:13`). La segunda deja de ser una
simplificación en cuanto se facture a Responsables Inscriptos, que es lo que el
dueño confirmó el 01/09 ↔ `FISCAL-CBTE-001`.

## 9. Saldos y reportes

El folio es lo más parecido a un estado de cuenta imprimible, y no se imprime:
`GET /api/stays/:id/folio` no tiene consumidor en el panel `[V]`
(`datos/cobertura.csv`).

## 10. Permisos y segregación

`[V]` Los `GET` de `/api/invoices/*` van **sin** `requireModule` a propósito:
exhibir un comprobante fiscal ya emitido es una obligación legal y no puede
quedar detrás de un entitlement revocable
(`src/facturacion/invoices.routes.ts:14`). Es una de las mejores decisiones de
diseño del repo y conviene que quede registrada como tal.

`[V]` No hay registro de **quién descargó** un PDF. El programa lo pide en §6.6
("las exportaciones y documentos tienen protección: autorización **y registro**").
Hay autorización; no hay registro.

## 11. Auditoría y trazabilidad

`[V]` `invoice.service.ts` sí escribe auditoría (`src/facturacion/invoice.service.ts:158`)
— es de los pocos servicios de dinero que lo hace. La descarga del PDF, no.

## 12. Errores, idempotencia y fallo parcial

`[V]` `FAILED_UNCERTAIN` es el manejo explícito del caso peor de una integración
fiscal: no se sabe si ARCA emitió o no (`src/db/schema.sql:2608`). Es el patrón
correcto.

`[H]` No verificado en esta corrida: qué hace el sistema para resolver un
`FAILED_UNCERTAIN` (consulta al padrón, reintento, decisión manual). Se
confirmaría leyendo `invoice.service.ts` entero; queda para la ficha M10.

## 13. Capacidad ausente

1. **Recibo de cobro.** Es el documento que el negocio necesita todos los días y
   el que no existe. Sin factura, un pago no le deja nada al cliente.
2. **Entidad "documento" genérica.** Hoy `invoices` es un caso especial. Cada
   documento nuevo va a nacer como tabla ad-hoc salvo que se decida un modelo.
3. **Congelamiento de los datos del emisor y del receptor** al momento de emitir.
4. **Registro de descarga/exportación.**
5. **Anulación de documento no fiscal.** No aplica hoy porque no hay documentos
   no fiscales.

## 14. Brechas

| ID | Sev | Qué falta | Evidencia | Cruce |
|---|---|---|---|---|
| `A2-T04-001` | S1 | No existe recibo de cobro ni comprobante de reembolso. | ausencia de endpoint en `datos/endpoints.csv` | ⊃ `Gap C1-C` (que ya señala "reembolso sin nota de crédito") |
| `A2-T04-002` | S1 | El PDF de un comprobante viejo se reimprime con los datos de emisor/receptor de hoy. | `src/facturacion/invoice-pdf.service.ts:79` | ↔ `FISCAL-CBTE-001` (hallazgo relacionado del mismo documento) |
| `A2-T04-003` | S2 | El folio es una consulta, no un documento: no se puede reimprimir el de ayer. | `src/pms-estadias/stays.routes.ts:177` | **nuevo** |
| `A2-T04-004` | S2 | Nadie registra quién descargó un comprobante. | `src/facturacion/invoices.routes.ts:14` (hay autorización, no registro) | **nuevo** |
| `A2-T04-005` | S2 | El PDF asume Consumidor Final; el dueño confirmó que va a facturar a Responsables Inscriptos. | `src/facturacion/invoice-pdf.service.ts:13` | ↔ `FISCAL-CBTE-001` |
| `A2-T04-006` | S3 | Sin ticket/comanda de orden ni comprobante de arqueo. | ausencia de endpoint | **nuevo** |

## 15. Criterios de cierre

- Un cobro genera un comprobante consultable y reimprimible, con número propio.
- El PDF de un comprobante emitido hace un año se ve igual que el día que se
  emitió.
- Queda registro de cada descarga de documento fiscal.
- Está decidido si el folio es documento o consulta, y escrito dónde.
