# Retirado — superseded por `FACT-BORRADOR-001`

- **Fecha de retiro:** 2026-09-11
- **Estado:** documento retirado. No es una propuesta viva. Se conserva por
  historial (mismo criterio que el repo usa para secciones `SUPERSEDIDO` en
  vez de borrar) y porque el pedido que lo originó — *"no se debería poder
  facturar con un solo click, revisá el modelo de Odoo"* — sigue vigente y
  su respuesta real vive en otro documento.

## Por qué se retira

Este documento proponía un modelo propio (reusar `invoices.status='PENDING'`
como "borrador", sin tabla nueva, permiso único `FRONT_DESK` para crear y
confirmar, descarte por `DELETE` físico) sin haber buscado primero si ya
existía diseño para el mismo problema. **Sí existía:**
`docs/diseno-factura-borrador-2026-08-31.md` (`FACT-BORRADOR-001`, v2.10,
~2050+ líneas), escrito dos semanas antes, con **6 decisiones del dueño ya
formalizadas** (D1-D6) y una máquina de estados completa.

Ese documento no es una alternativa a evaluar junto a esta — **es la
autoridad**, y varias de sus decisiones ya tomadas **contradicen
directamente** lo que este documento proponía:

| Punto | Este documento (retirado) proponía | `FACT-BORRADOR-001` ya decidió | Decisión de |
|---|---|---|---|
| Modelo de datos | Sin tabla nueva — reusar `invoices.status='PENDING'` | Tabla propia `invoice_drafts` (T1); `invoices.status` **no cambia de significado** — `PENDING` sigue siendo "emisión en curso", nunca "borrador editable" (T2) | dueño, vía criterio técnico T1/T2 |
| Descarte de un borrador | `DELETE` físico (lo dejaba como "pregunta abierta para el gate") | `status='DISCARDED'`, **nunca borrado físico** — es una TRANSACCIÓN (R14), no un dato descartable | **D3**, dueño |
| Permiso para confirmar/emitir | Un solo `FRONT_DESK` para crear y confirmar | Permiso nuevo y separado, `FISCAL_ISSUE` — "fiscal, no se hereda del operativo" (§14) | **D4**, dueño |
| Cuándo nace el cargo (`FinancialTransaction`) | No lo trataba (asumía que el cargo ya existía antes del borrador, caso individual) | Nace **después** del CAE confirmado, vía `financial_transactions.invoice_draft_id` (opción C, §23) — con `ISSUED_PENDING_LEDGER` como estado intermedio nombrado para la ventana entre CAE y cargo asentado | **PN-1**, dueño |
| Origen de la línea (multirubro) | No lo trataba | Discriminador `source_kind` (`ORDER_ITEM`/`RESERVATION`/`STAY`/`MANUAL`) que viaja a `invoice_items` congelado | dueño, §24 |
| Tratamiento fiscal (gravado/exento/no gravado/tasa 0) | No lo trataba | Modelo de 4 tratamientos con `fiscal_treatment`/`arca_iva_id`, la emisión bloquea `EXENTO`/`NO_GRAVADO` hasta que `buildIvaBreakdown` deje de hardcodear `ImpTotConc`/`ImpOpEx` en 0 | dueño, §25 |

No son matices de forma: D3 y D4 en particular son decisiones de negocio
del dueño, no mías ni del asistente — pisarlas con un modelo distinto sin
ni siquiera saber que existían habría sido exactamente el tipo de error
que `CLAUDE.md` (raíz) manda evitar ("preguntas de alcance que esconden
una decisión de negocio").

## Qué sí aporta este documento retirado, y dónde vive ahora

Tres cosas de acá **no** están en `FACT-BORRADOR-001` y sí son un aporte
real — se trasladaron como hallazgos nuevos al **§27** de ese documento
(fechado 11/09/2026, sesión de reconciliación):

1. El grounding contra Odoo 19.0 real (código fuente, no memoria) que
   confirma que el mínimo de acciones humanas explícitas antes de un
   comprobante fiscal final es 3, y que ni ahí la llamada al ente fiscal
   externo vive en la misma acción que postea el documento.
2. Un hueco real que `FACT-BORRADOR-001` no trata en ninguna de sus 26
   secciones: **qué pasa con los guards `OrderCancelledCannotInvoiceError`/
   `ReservationCancelledCannotInvoiceError`** cuando un borrador vive
   varios días — ¿se revalidan al confirmar? El documento nunca los
   menciona (0 resultados de grep).
3. Una pregunta que tampoco se trata: **¿qué pasa con `POST /api/invoices`
   (la ruta actual de un solo paso) una vez que exista el camino de
   borrador/confirmar?** Si queda montada sin cambios, es un bypass
   completo del punto entero del rediseño.

**Estado real del trabajo de facturación estilo Odoo:** sigue en fase de
diseño, no de implementación. `FACT-BORRADOR-001` mismo se declara "NO
aprobado como diseño final", bloqueado por ítems mecánicos (§26.1, C-1 a
C-4) y de decisión (C-5, registrado en `pendientes-2026-09-10.md`, no en
§26.1 de ese documento) más una serie de decisiones de negocio del dueño
todavía pendientes (§26.3: presupuesto de reintentos de
`ISSUED_PENDING_LEDGER`, quién ve esa cola, política sobre borradores
abandonados, cliente dado de baja, cierre de caja). Ver `FACT-BORRADOR-001`
§27 para el detalle completo y el estado actualizado al 11/09/2026.

## Nota posterior (11/09/2026, mismo día) — no cierra esta retirada

Después de retirar este documento, el dueño instruyó re-verificar **incluso
D1-D6** contra Odoo real, con Odoo ganando donde diverja — "más allá de las
decisiones que haya tomado antes". Eso incluye a D3 y D4, citadas arriba
como motivo de retiro: si esa investigación (en curso, ver
`FACT-BORRADOR-001` para su resultado cuando esté) concluye que Odoo hace
algo distinto de lo que D3/D4 fijaron, **la corrección se aplica sobre
`FACT-BORRADOR-001` directamente** (es el documento vivo), no revive este
documento retirado. Este archivo sigue siendo el registro de un error de
proceso real (proponer sin buscar primero) — ese error no se borra aunque
alguna de las decisiones que motivó la retirada termine cambiando por otra
razón.
