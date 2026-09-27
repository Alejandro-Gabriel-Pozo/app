# Anchor-refresh — P-16/D-25 (perfil fiscal), 24/09/2026

**Qué es este documento y por qué es un archivo aparte, no un edit del
original.** `docs/diseno-fiscal-profile-resolver-2026-09-01.md` §12 es un
diseño **gate-aprobado tras 8 rondas** (`8b3fc98`), con un rastro extenso de
"corregido (gate, ronda N)" que documenta el propio proceso de revisión —
ese historial es evidencia, no solo texto a mantener actualizado. Desde el
cierre del gate, otros bloques de la misma Wave 14 (`ISSUE-BEFORE-REVERSE-WINDOW-001`
22-23/09, Bloques 5/6 de NC parity y bandeja de reconciliación) tocaron
`invoice.service.ts`/`sql.invoice.repository.ts` — los mismos archivos que
§12.12/§12.13 citan por línea — y varias citas quedaron desactualizadas.
Editar el original mezclaría un refresh rutinario de anclas con un
documento cuyo valor es justamente ser el registro fijo de lo que el gate
aprobó ronda por ronda. Este addendum se lee **junto al original**: mismas
decisiones, mismo alcance (Commits A-F, A ya implementado), solo anclas
corregidas contra el código vivo del 24/09/2026. No redefine nada de
sustancia — ningún fork nuevo, ninguna decisión nueva.

**Regla para quien implemente Commits B-F:** usar las líneas de ESTE
documento, no las de §12.12/§12.13 del original — el original queda como
registro histórico del razonamiento y de las decisiones del dueño, no como
mapa de líneas vigente.

---

## 1. Número de versión de schema — confirmado y corregido

El original (§12.12#16) decía: *"la versión real hoy sería v61,
`CURRENT_SCHEMA_VERSION = 60` en `tenant-db.setup.ts:540`"*.

**Estado real al 24/09/2026:**

- `export const CURRENT_SCHEMA_VERSION = 62;` — `src/platform/tenant-db.setup.ts:561`
  (no `:540`, no valor `60`).
- Entre la escritura del diseño (22/09) y hoy se sumaron **v61** y **v62**,
  ambos de un ADR *distinto* (`ISSUE-BEFORE-REVERSE-WINDOW-001`,
  23/09/2026, Bloques 2a/2b — `invoices.pending_since` + su CHECK), no del
  perfil fiscal.
- **La próxima versión a usar para el bump de `iva_condicion_id` en
  `customer_tax_profiles` (Commit del bloque B/C) es v63**, no v61.
- Los dos precedentes de formato que el original usaba como referencia
  siguen exactos, sin drift: v27 en `tenant-db.setup.ts:311-313`, v35 en
  `:354-356`. Seguir ese mismo formato de comentario para v63.

## 2. `src/facturacion/invoice.service.ts` — drift real, confirmado

### 2.1 `buildIvaBreakdown()` — call sites y firma

| Cita del original | Cita vigente (24/09/2026) |
|---|---|
| Call site 1: `:628` | **`:661`** (`this.buildIvaBreakdown(items, profile, buyer, concepto)`, dentro de `requestInvoice()`) |
| Call site 2: `:829` | **`:863`** (`this.buildIvaBreakdown(allItems, profile, buyer, concepto)`, dentro de `requestConsolidatedInvoice()`) |
| Firma: `:974-979`, `buyer: Buyer` en `:977` | **Firma `:1008-1013`, `buyer: Buyer` en `:1011`** (método privado, arranca en `:1008` con el docblock de una línea en `:1007`) |
| SOAP request — `DocTipo: buyer.docTipo` `:1007` | **`:1041`** |
| SOAP request — `DocNro: Number(buyer.docNro)` `:1008` | **`:1042`** |
| SOAP request — `CondicionIVAReceptorId: buyer.condicionIvaReceptorId` `:1018` | **`:1052`** |

Confirmado sin cambio de forma: los 2 call sites siguen pasando
`identity.buyer` sería el cambio a aplicar (§12.8/§12.12#13/#14 del
original) — la firma de `buildIvaBreakdown()` sigue exactamente igual
(`buyer: Buyer`, no `FiscalIdentity`), así que ese punto del diseño no
necesita rework, solo las líneas de arriba.

### 2.2 `buildCreditNote()` — sitio real de copia de campos a la NC

El original citaba `invoice.service.ts:1406-1408` para agregar
`condicionIvaReceptorDesc` a la copia de campos del comprobante original
al armar la Nota de Crédito.

**Cita vigente:** el método `buildCreditNote()` arranca en `:1110` (sin
cambio en su firma). El objeto que se pasa a
`this.invoiceRepo.createWithClient()` — el sitio real de la copia — está
en **`:1429-1451`**, con `condicionIvaReceptorId: original.condicionIvaReceptorId`
en **`:1442`**. Agregar ahí, en la misma línea de al lado:
`condicionIvaReceptorDesc: original.condicionIvaReceptorDesc` (o el campo
que `resolveFiscalIdentity()`/el original comprobante exponga — mismo
criterio que el resto de los campos heredados, sin cambio de diseño).

(No confundir con `:1381` — `CondicionIVAReceptorId: original.condicionIvaReceptorId`
dentro del objeto `afipRequest` que arma el SOAP de la NC — ese es un sitio
DISTINTO, ya cubierto por el punto 2.1 de arriba en su forma general; no
lleva `desc` porque el SOAP de AFIP no la pide, mismo criterio que
`buildIvaBreakdown()`.)

### 2.3 Tests "D-25" — congelan el estado actual, citados en §12.13

| Original | Vigente (24/09/2026) |
|---|---|
| `describe('D-25', ...)` en `:613`, único `it` en `:621` | **`describe(...)` en `:754`, único `it` en `:758`** (`src/facturacion/invoice.service.test.ts`) |
| segundo, `it(...)` suelto sin `describe` alrededor, en `:2733` | **`:3440`** |

Confirmado sin cambio de forma: el segundo sigue siendo un `it()` suelto,
no un `describe` — la distinción que el original ronda 4/C2 hacía sigue
siendo cierta, solo cambiaron las líneas (desplazamiento de +141 y +707
líneas respectivamente, por el resto de trabajo de Wave 14 en el mismo
archivo entre el 22 y el 23/09).

## 3. `src/facturacion/invoice.entities.ts` — drift real, confirmado

| Campo | Original | Vigente |
|---|---|---|
| `Invoice` — interfaz arranca | (no citado explícito) | `:57` |
| `Invoice.condicionIvaReceptorId` | `:63` | **`:77`** |
| `CreateInvoiceInput` — interfaz arranca | (no citado explícito) | `:158` |
| `CreateInvoiceInput.condicionIvaReceptorId` | `:144` | **`:172`** |

`condicionIvaReceptorDesc: string | null` se agrega inmediatamente después
de cada una (junto a `:77` y junto a `:172`), mismo criterio que el
original.

## 4. `src/facturacion/sql.invoice.repository.ts` — drift real, y un cambio estructural (no solo de línea)

| Campo | Original | Vigente |
|---|---|---|
| `InvoiceRow` — interfaz arranca | (no citado explícito) | `:19` |
| `InvoiceRow.condicion_iva_receptor_id` | `:24` | **`:32`** |
| `rowToEntity()` — función arranca | (no citado explícito) | `:52` |
| mapper `condicionIvaReceptorId: row.condicion_iva_receptor_id` | `:59` | **`:68`** |
| `createWithClient()` — método arranca | (no citado explícito) | `:1534` |
| `INSERT INTO invoices` (texto SQL) | `:1307-1320` | **`:1548-1553`** (dentro del `client.query<InvoiceRow>(...)`, que arranca en `:1547`) |
| lista de columnas | `:1309-1310` | **`:1550`** (una sola línea — la lista de columnas es más larga hoy, ver abajo) |
| array de parámetros | `:1313-1320` | **`:1554-1561`** |

**Cambio estructural, no solo de línea — el gate de Commits B-F tiene que
leer esto antes de tocar el archivo:**

El original describía la lista de VALUES como `$1...$19, 'PENDING', $20`
(un solo literal, `status`, entre los placeholders y el último parámetro
`$20` de `afip_request`). **Eso ya no es así.** El Bloque 2a de
`ISSUE-BEFORE-REVERSE-WINDOW-001` (23/09/2026, v61) agregó `pending_since`
al mismo INSERT, como un SEGUNDO literal inline:

```
INSERT INTO invoices
   (id, business_id, financial_transaction_id, customer_id, idempotency_key, environment,
    pto_vta, cbte_tipo, emisor_cuit, concepto, doc_tipo, doc_nro, condicion_iva_receptor_id, moneda,
    imp_neto, imp_iva, imp_total, payment_method, card_installments, status, pending_since, afip_request)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'PENDING', NOW(), $20)
 RETURNING *
```

O sea: la lista de columnas hoy tiene **22** columnas (no 20), y el patrón
de VALUES es `$1...$19, 'PENDING', NOW(), $20` (dos literales —
`'PENDING'` y `NOW()` — no uno). `condicion_iva_receptor_id` sigue en la
posición 13 de la lista, igual que antes. Insertar
`condicion_iva_receptor_desc` justo después (posición 14) implica:

- Renumerar `$14`...`$19` (moneda en adelante) a `$15`...`$20`.
- El último placeholder (`afip_request`, hoy `$20`) pasa a **`$21`**. El
  resultado final del renumerado coincide con lo que el original ya
  anticipaba (`$20`→`$21`), pero el original describía el patrón como un
  solo literal (`'PENDING'`) entre los placeholders — hoy son DOS
  literales inline (`'PENDING', NOW()`). Quien renumere mirando solo la
  descripción vieja del original, sin mirar el SQL real de arriba, puede
  insertar el placeholder nuevo en el lugar equivocado respecto de
  `NOW()` (antes en vez de después, o viceversa) aunque el conteo final
  de `$N` le cierre igual.
- El array de parámetros (`:1554-1561`) gana la entrada nueva en la misma
  posición relativa (después de `input.condicionIvaReceptorId`).

El riesgo que el gate ya señaló (ronda 5, §12.13) — *"un desfasaje acá es
silenciosamente type-correcto... solo un test de integración contra
Postgres real lo detecta, `tsc` no"* — sigue vigente y ahora es más fácil
de gatillar por accidente, justamente porque hay un literal más en el
medio.

### 4.1 Radio de fixtures de `Invoice`/`CreateInvoiceInput` — re-verificado, SIN drift

A diferencia de lo de arriba, estas citas del original **coinciden
exactamente** con el código vigente — no hicieron falta correcciones:

- `src/reservas/cancellation-refund.service.test.ts:170` (`makeInvoice`) — confirmado.
- `src/clientes-finanzas/customer-account.service.test.ts:246` y `:365` (dos helpers `makeInvoice` distintos) — confirmado, ambos.
- `src/tests/integration/credit-note-lines.integration.test.ts:118-126` (literal pasado a `repo.createWithClient()`) — confirmado (el `it()` está en `:112`, el `createWithClient(` en `:118`).
- `src/facturacion/cancel-reservation-with-credit-note.service.test.ts:74` (`{ ...overrides } as Invoice`) — confirmado.
- `src/facturacion/invoices.routes.test.ts:92` (`INVOICE_ROW`) — confirmado.

## 5. `src/api/middleware/error.middleware.ts` — el grupo 422 creció

El original decía: *"grupo 422 (`:199-210`, junto a `'UNSUPPORTED_IVA_RATE'`
en `:202`)"*.

**Vigente:** el mismo `ADR ISSUE-BEFORE-REVERSE-WINDOW-001` (Bloque 3,
23/09/2026) agregó dos `case` nuevos (`AFIP_VOUCHER_NOT_FOUND`,
`AFIP_VOUCHER_MISMATCH`) al mismo grupo, antes de `UNSUPPORTED_IVA_RATE`.
El grupo 422 ahora es **`:205-218`** (`return 422;` en `:218`), con
`case 'UNSUPPORTED_IVA_RATE':` en **`:210`** (no `:202`). El `case
'UNSUPPORTED_TAX_ID_TYPE':` nuevo (N6 del original) se agrega junto a
`:210`, no junto a `:202`.

## 6. `src/facturacion/afip-catalog.constants.ts` — sin drift real

Re-verificado contra el código vigente — las 3 citas del original
coinciden:

- Docblock D-25 general: `:99-116` — confirmado.
- Docblock propio de `resolveDocTipo()`: `:118-124` — confirmado.
- Docblock de `docTipoLabel()`: el original citaba `:136-145`; el bloque
  real hoy es aproximadamente `:134-144` (arranca 2 líneas antes de lo
  citado, cierra 1 línea antes) — diferencia de borde, no de contenido;
  re-verificar el rango exacto al tocar el archivo, no asumir ninguna de
  las dos citas a ciegas.
- `afip-catalog.constants.test.ts:20-25` (`'pasaporte'` → debe pasar a
  `toThrow(UnsupportedTaxIdTypeError)`) — confirmado, sin drift.

## 7. `src/domain/errors.ts` — sin drift

`UnsupportedIvaRateError` (el patrón a seguir para
`UnsupportedTaxIdTypeError`) sigue en `:566-573`, exactamente como citaba
el original.

## 8. Todo lo de `customer_tax_profiles` / `iva_condicion_id` — re-verificado, SIN drift en ningún archivo

Este subsistema completo NO se tocó desde que el diseño se escribió — cada
cita del original (§12.12#16/§12.13) coincide exactamente con el código
vigente, verificado línea por línea el 24/09/2026:

- `src/clientes-finanzas/customer-tax-profile.entities.ts`:
  `CustomerTaxProfile` `:26-38`, `UpsertCustomerTaxProfileInput` `:40-46`.
- `src/clientes-finanzas/customer-tax-profile.repository.ts`:
  `ICustomerTaxProfileRepository` `:8-12`.
- `src/clientes-finanzas/sql.customer-tax-profile.repository.ts`:
  `ProfileRow` `:23-39`, `SELECT_SQL` `:41-49`, `rowToProfile()` `:51-74`,
  `upsert()` `:87-112` (columnas del INSERT `:100`, `VALUES` `:101`,
  `ON CONFLICT ... DO UPDATE SET` `:102-107`, array de parámetros `:108`).
- `src/clientes-finanzas/customers.routes.ts`: `UpsertTaxProfileSchema`
  `:119-124` (campo `taxIdType` en `:122`), sitio de parseo/construcción
  del input `:370-386` (parse en `:370`, objeto de `upsert()` `:371-385`,
  `res.json()` en `:386`).
- `src/db/schema.sql`: `CREATE TABLE IF NOT EXISTS customer_tax_profiles`
  en `:411` (cierra `:420`, el original citaba hasta `:421` — diferencia
  de 1 línea, sin importancia práctica), `CREATE TABLE IF NOT EXISTS
  invoices` en `:3101`, los 3 `ALTER TABLE invoices ADD COLUMN IF NOT
  EXISTS` de referencia en `:3154`/`:3186`/`:3210` — los tres confirmados
  exactos.

## 9. Lado `appfrontend` — re-verificado, SIN drift en ningún archivo

Igual que el punto 8: nada de esto se tocó desde que el diseño se
escribió. Confirmado el 24/09/2026 contra el checkout real de
`appfrontend` (disponible en esta sesión, `/home/user/appfrontend`):

- `appfrontend/src/app/dashboard/clientes/[id]/page.tsx` — los 6 sitios
  del original (§12.12#17), todos confirmados exactos: estado inicial de
  `taxForm` `:59-62`; `resetTaxForm()` `:76-89`; payload de `upsert`
  `:148-152`; `applyTaxpayerLookup()` (retira la escritura de
  `taxCondition`) `:230-236`; el `<select>` de `taxIdType` `:546-555`; el
  `<input>` de texto libre "Condición frente al IVA" a reemplazar por el
  selector nuevo, `:569-574`.
- `appfrontend/src/lib/clientes/types.ts`: `CustomerTaxProfile`
  `:128-138`, `UpsertCustomerTaxProfileInput` `:140-146` — confirmados.
- `appfrontend/src/lib/clientes/api.ts`: `padronApi` arranca en `:97`
  (`lookupByCuit` en `:98`) — confirmado, el método nuevo
  `getIvaReceptorTypes()` se agrega ahí.
- `appfrontend/src/lib/facturacion/types.ts`: `Invoice` en `:13`
  (`InvoiceWithLabel extends Invoice` empieza en `:45`, así que el rango
  `:13-29` del original queda confirmado sin necesidad de ajuste — sigue
  siendo la entrada revisada-sin-cambio que el original ya declaraba).

## 10. Lo que este addendum NO cubrió — declarado, no una omisión

No se re-verificó línea por línea (fuera del radio explícitamente pedido
por la tarea que generó este addendum — schema version, `buildIvaBreakdown()`,
`INSERT INTO invoices`, `buildCreditNote()`, y lo que apareciera cerca al
tocar esos archivos):

- `src/api/schemas/facturacion.schemas.ts::BuyerSchema` (`:15-19` en el
  original) — no tocado por ningún commit reciente detectado; probable sin
  drift, pero no confirmado línea por línea acá.
- `docs/inventario-rutas.md` / `docs/rbac-matriz-endpoints.md` /
  `EXPECTED_AUTHORIZE_CALL_SITES` — el original ya declaraba "sin cambios"
  para este bloque; no se re-corrió `npm run docs:routes` desde acá para
  confirmarlo, dado que ningún cambio de este addendum toca rutas ni RBAC.
- `NO_CONSUMER_ROUTES` (`route-consumer-coverage.test.ts`) — el orden
  cross-repo que el original fija (código del selector en `appfrontend`
  primero, allowlist en `app-main` después) no se re-verificó porque no
  depende de ninguna línea de código, es una regla de secuencia de commits.

**No se rediseñó nada.** El resolver (`resolveFiscalIdentity()` devolviendo
`FiscalIdentity { buyer, condicionIvaReceptorDesc }`), el split en
Commits A-F, y todas las decisiones del dueño (§12.1, §12.11) del
documento original siguen siendo la sustancia vigente — este addendum solo
corrige dónde está cada línea hoy.
