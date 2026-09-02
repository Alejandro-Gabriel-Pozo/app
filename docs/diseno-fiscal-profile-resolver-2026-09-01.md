# Diseño — `FiscalProfile` y `ComprobanteTypeResolver`

- **Fecha:** 2026-09-01
- **Estado:** **análisis y diseño. HOLD de implementación.** Revisado por el
  dueño el 01/09/2026: aceptado como **diseño preliminar**, con el snapshot
  ampliado a los dos lados del comprobante (§2.3), tres estados operativos en
  vez de dos (§5) y redacción neutral del impacto tributario (§8.1). Segunda
  revisión el mismo día: snapshot bilateral cerrado como decisión y `cbteLetra`
  elevado a **identidad canónica del comprobante** (§2.4). No modifica
  `diseno-factura-borrador-2026-08-31.md` (v2.5+), ni schema, ni código, ni
  hay commit. Deuda **transversal**, fuera de D5 y del borrador.
- **Origen:** al verificar §25 contra el manual del desarrollador de WSFEv1
  (fuente primaria, revisión del 17/05/2024) apareció una limitación mayor que
  la que se estaba mirando: el sistema **fuerza siempre Factura B** aunque
  captura la condición de IVA del receptor.
- **Etiquetas:** `fiscal` `multirubro` `deuda-existente` `arca`

---

## 0. Estado epistémico — leer antes que nada

Este documento distingue tres cosas que es fácil confundir, y una de ellas
**no está demostrada**:

| Afirmación | Estado |
|---|---|
| `PadronService.getIvaReceptorTypes(claseCmp?)` existe, acepta el parámetro y consulta el catálogo oficial de ARCA | **Verificado** en código (`padron.service.ts:137-139`) |
| Sin `claseCmp`, ARCA devuelve el catálogo completo | **Verificado** en el comentario del propio método (`:136`) |
| El método devuelve `{ id, description }[]` | **Verificado** (`:91-94`, `:140`) |
| Esa respuesta constituye una **relación comprobante ↔ condición de receptor** suficiente para resolver `CbteTipo` | ⚠️ **HIPÓTESIS ABIERTA.** Requiere ejecutarlo con certificado real. **El contrato de este documento no la asume.** |

La formulación segura es: **ARCA publica un catálogo consultable y el SDK
permite acotarlo por `claseCmp`; falta confirmar si esa respuesta constituye la
relación necesaria para el resolver.**

**Consecuencia de diseño:** el resolver se especifica de modo que **funcione sin
esa hipótesis** —resolviendo desde configuración explícita del tenant— y que
**mejore si la hipótesis se confirma** —usando ARCA para validar—. No se
diseña un resolver que dependa de algo no verificado.

### 0.1 Cómo leer este documento — tres categorías, marcadas

Cada sección lleva una etiqueta. **No mezclar las tres es el punto**: sin la
distinción, un lector futuro no puede saber qué está comprobado y qué
propusimos.

| Marca | Significa | Cómo se refuta |
|---|---|---|
| **[V]** | **Verificado en el repositorio** — hay cita `archivo:línea` leída el 01/09/2026 | abriendo el archivo |
| **[P]** | **Regla de diseño propuesta** — no está en el código; es lo que este documento recomienda | discutiéndola; es una decisión, no un hecho |
| **[H]** | **Hipótesis abierta** — depende de una respuesta real de ARCA o de validación profesional | ejecutando contra ARCA, o consultando a un contador |

**Ninguna [P] se apoya en una [H].** Es la razón por la que el resolver se
especifica para funcionar sin confirmar la semántica de
`getIvaReceptorTypes`.

---

## 1. [V] Tres capacidades distintas, hoy confundidas en una

| Capacidad | Qué hace | Estado hoy |
|---|---|---|
| **Consultar el catálogo** | pedirle a ARCA qué condiciones de receptor existen | **implementada**, sin certificado para ejecutarla |
| **Validar una combinación** | ¿emisor X + receptor Y + comprobante Z es válida? | **no existe** |
| **Resolver el `CbteTipo`** | dado emisor y receptor, ¿qué comprobante corresponde? | **no existe** — está fijo en Factura B |

Separarlas importa porque tienen dependencias distintas: la primera necesita
certificado; la segunda, un contrato; la tercera, una decisión de negocio del
tenant. Hoy las tres se resuelven con una constante.

### Lo que hay, verificado

| Pieza | Dónde | Estado |
|---|---|---|
| `CBTE_TIPO_FACTURA_A/B/C` | `afip-catalog.constants.ts:23-25` | declaradas; **solo B se usa** |
| `CBTE_TIPO_NOTA_CREDITO_B` | `:33` | única NC; el docblock dice que es *"la única asociable a una Factura B"* |
| `cbteTipo` en la emisión | `invoice.service.ts:368`, `:466` | **fijo** en `FACTURA_B` en los dos caminos |
| Alcance declarado | `afip-catalog.constants.ts:22` | *"solo los usados por **Fase 2 (Factura B)**"* |
| `condicionIvaReceptorId` | `invoice.service.ts:342`, `:441` | parámetro; default `CONSUMIDOR_FINAL` |
| Constantes de condición | `:128` | **una sola**: `CONSUMIDOR_FINAL = 5` |
| Condición del receptor por cliente | `customer_tax_profiles.tax_condition` (`schema.sql:400`) | existe, **texto libre nullable** |
| ¿Facturación lee ese perfil? | `invoices.routes.ts:82`, `:107` | **no** — pasa `buyer` solo si viene en el body |

**Es limitación existente, completa.** Existiría igual si el borrador nunca se
construye. El borrador es solo el lugar natural para exponerla.

---

## 2. Modelo canónico — `FiscalProfile`

### 2.1 [P] Dos perfiles, no uno

- **`FiscalProfile` del emisor** — del tenant. Consolida lo que hoy está en
  `business_profile`, sin duplicarlo.
- **`FiscalProfile` del receptor** — del cliente. Hoy en
  `customer_tax_profiles`.

### 2.2 [V + P] Lo que NO se debe unificar

> ⚠️ **`taxId` y `afipCuit` se mantienen separados.** No son lo mismo, y la
> separación es deliberada: el CUIT con el que se autentica ante ARCA puede no
> ser el CUIT legal. Es un hallazgo real de la Fase 2, documentado en
> `business-profile.entities.ts:64-73` (19/08/2026). Un `FiscalProfile` que
> los unifique "porque son el mismo número" rompe un caso que ya ocurrió.

### 2.3 [V + P] Snapshot en el comprobante — el conjunto mínimo

**El defecto verificado — y son DOS snapshots, no uno.** R9 y R12 aplican
igual a los dos lados del comprobante, así que el diseño necesita
`issuerSnapshot` **y** `receiverSnapshot`.

`InvoicePdfService` resuelve en paralelo el perfil del negocio **y el cliente
vivo** (`invoice-pdf.service.ts:71-75`: `businessProfileRepo.get()` +
`customerRepo.getById(invoice.customerId)`). Lo que sale de cada fuente:

**Lado emisor — 3 lecturas vivas, 1 congelada**

| Línea | Dato | Origen |
|---|---|---|
| `:79` | `emisorCuit` | **congelado** (`invoice.emisorCuit ?? …`) |
| `:97` | `razonSocial` | `profile.legalName` — **vivo** |
| `:99` | `condicionIva` | `profile.taxCondition` — **vivo** |
| `:81` | `domicilioComercial` | `profile.fiscalAddress*` — **vivo** |

**Lado receptor — 1 lectura viva, 3 congeladas**

| Línea | Dato | Origen |
|---|---|---|
| `:105` | `razonSocial` | `customer?.fullName` — **vivo** |
| `:106` | `condicionIva` | derivado de `invoice.condicionIvaReceptorId` — **congelado** |
| `:107-108` | `documentoTipo` / `documentoNro` | `invoice.docTipo` / `invoice.docNro` — **congelados** |

Renombrar un cliente reescribe la razón social de todos sus comprobantes
históricos — el mismo daño que R9 describe con *"renombrar «Barbero Isahia» a
«Barbero Juan» reescribe la historia de todas las reservas pasadas"*.

**Criterio para fijar el conjunto mínimo, no una lista arbitraria:**

> El comprobante debe congelar **todo lo que el PDF necesita para explicarse
> sin consultar ningún maestro**. La regla operativa: **el generador del PDF no
> debe leer `BusinessProfile`, `Customer` ni `CustomerTaxProfile`** — si
> necesita un dato, ese dato va en el snapshot correspondiente.

**Por qué las tres, si hoy solo lee dos.** `CustomerTaxProfile` **no se lee
hoy** (verificado: cero referencias en `invoice-pdf.service.ts`). Se incluye
**preventivamente**: el día que se emita una Factura A hace falta la **razón
social fiscal** del receptor y su domicilio, que viven ahí
(`customer-tax-profile.entities.ts:29`, `:35`) y **no** en
`customer.fullName`, que es nombre de display. El reflejo natural sería
leerlos en vivo — y reintroduciría el mismo defecto que esta sección corrige.
La regla se escribe antes de que el caso exista, no después.

**Conjunto mínimo con el PDF actual:**

| Lado | A congelar | Ya congelado |
|---|---|---|
| **Emisor** | razón social, condición fiscal, domicilio comercial | CUIT de autenticación |
| **Receptor** | razón social | `docTipo`, `docNro`, `condicionIvaReceptorId` |

**Si el PDF crece, el snapshot crece con él** — el criterio es estable aunque
la lista no lo sea.

**El repo ya aplica esta regla, para un solo campo.** El desglose de IVA se lee
del `afipRequest` congelado en vez de recalcularse
(`readAfipIvaGroups(invoice.afipRequest)`, `:93`), y el docblock explica por
qué: recalcular desde `impNeto`/`impIva` daría *"un blend sin sentido fiscal,
ej. «18.2%», que no es ninguna alícuota real de AFIP"*. **Es exactamente el
razonamiento de esta sección, ya aceptado.** Lo que falta es extenderlo del
desglose a la identidad de las partes.

**Nota de alcance:** el §18 del diseño de borrador registra este mismo defecto
del lado receptor. Son el mismo problema y conviene resolverlos juntos, en un
bloque propio.

### 2.4 [V + P] Identidad canónica del comprobante — y por qué el resolver no devuelve un entero

**El hallazgo que lo motiva.** `cbteLetra` (`invoice-pdf.service.ts:111`) es:

```
invoice.cbteTipo === CBTE_TIPO_FACTURA_B ? 'B' : String(invoice.cbteTipo)
```

Una Factura A se imprimiría con la letra **"1"**. No es un error de formato:
**demuestra que la suposición «solo B» está filtrada en dos capas** —la
elección del comprobante **y** su representación gráfica—, y la representación
es justamente lo que la RG 4291 regula (Art. 15: la representación debe
respetar los modelos previstos para cada tipo).

**Consecuencia para el contrato del resolver.** Si el resolver devuelve un
`number`, el PDF tiene que reconstruir la semántica por su cuenta — y el
fallback numérico es exactamente lo que pasa cuando la reconstruye mal. La
salida debería ser una **decisión estructurada**, conceptualmente:

| Campo | Para qué |
|---|---|
| **tipo** | el `CbteTipo` numérico que va a ARCA |
| **letra** | la letra normativa (A/B/C), **derivada de la identidad, nunca de un fallback** |
| **descripción** | el nombre del comprobante, para pantalla y PDF |
| **fuente** | de dónde salió la decisión: configuración del tenant, validación ARCA, o ambas |
| **estado de validación** | si se validó contra ARCA, si no se pudo, o si se resolvió solo por configuración |

**La letra la deriva el resolver o un catálogo de presentación; el PDF no la
infiere.** Y `fuente` + `estado de validación` importan porque el mismo tipo
de comprobante puede haberse elegido con o sin confirmación de ARCA — y el §5
necesita distinguirlo para saber qué hacer ante una indisponibilidad.

> **No implementar.** Es contrato conceptual para la fase siguiente. Se
> documenta acá para que el resolver no nazca devolviendo un entero y repita el
> problema en una capa nueva.

---

## 3. [V + P] Configuración habilitada por tenant

**El tenant configura y habilita; no redefine las reglas fiscales.**

| Nivel | Quién decide | Qué |
|---|---|---|
| Modelo canónico | subdominio de facturación | que existe el perfil, el snapshot y el resolver |
| Configuración | **el tenant** | su condición fiscal, credenciales, punto de venta, y **qué combinaciones habilita** |
| Política operativa | el sistema | qué hacer ante una combinación no configurada (§5) |

Superficie que ya existe por tenant: `business_profile` (`taxId`, `taxIdType`,
`taxCondition`, `afipCuit`, `afipSalesPoint`, `defaultIvaRate`) y
`afip_credentials` (certificado cifrado + `environment`). **El contrato
consolida, no inventa.**

**Ningún rubro impone A, B o C.** La condición fiscal es del tenant, no de la
industria. Un hotel monotributista y una barbería monotributista emiten igual;
un hotel RI y un hotel monotributista, no.

---

## 4. [P] Validación contra ARCA — sobre precedentes [V]

Dos capas, deliberadamente separadas:

1. **Configuración declarativa del tenant** — qué combinaciones habilitó.
   Funciona sin red y sin certificado.
2. **Validación contra ARCA en la emisión** — confirma que la combinación sigue
   siendo válida y que los identificadores existen.

**Por qué las dos y no una sola.** Si solo hubiera configuración, el sistema
emitiría con datos que ARCA podría haber cambiado. Si solo hubiera validación
en vivo, una caída de ARCA bloquearía toda la facturación y la configuración
del tenant no sería auditable.

**Precedente que sostiene esta forma.** El repo ya eligió *no adivinar* dos
veces, y en las dos dejó escrito el porqué:

- `IVA_ALICUOTA_IDS` (`afip-catalog.constants.ts:147-149`): solo 3 entradas
  confirmadas; el docblock (`:140-143`) dice que las demás *"NO se hardcodean
  acá sin poder confirmarlos contra `getIvaTipos()`/`FEParamGetTiposIva()` del
  SDK en vivo"*.
- `condicionIvaReceptorId` (`:10-18`): no se hardcodea ninguna tabla; se pide
  como parámetro explícito *"hasta que haya certificado real"*.
- `resolveIvaAlicuotaId()` (`:160-166`): **falla explícito antes que adivinar**.

> **Por eso la matriz `RI → CF = B`, `RI → RI = A`, `Monotributo → * = C` NO se
> hardcodea.** Sería asesoramiento fiscal en código, y contradiría una postura
> que este repo ya tomó dos veces con su justificación escrita.

---

## 5. [P] Política operativa ante ausencia, ambigüedad o imposibilidad

Tres situaciones distintas, no una:

| Situación | Ejemplo |
|---|---|
| **Ausencia** | el tenant no habilitó la combinación emisor+receptor |
| **Ambigüedad** | más de una combinación habilitada aplica |
| **Imposibilidad de validar** | ARCA no responde, o no hay certificado |

### 5.1 Las alternativas, comparadas

| Opción | Ante una combinación no resuelta | Veredicto |
|---|---|---|
| **Inferir** la más probable | emite un comprobante que el sistema eligió | **Descartada.** Asesoramiento fiscal implícito; contradice §4 |
| **Fail-closed mudo** | rechaza sin decir qué falta | Insuficiente: bloquea sin salida |
| **Rechazo explícito con estado accionable** | rechaza, nombra la combinación faltante, apunta a la pantalla | **Recomendada — a validar, no cerrada** |
| **Revisión operativa** (cola humana) | difiere la emisión a una persona | Solo si la combinación es legítima pero rara; agrega una cola con los mismos problemas que `ISSUED_PENDING_LEDGER` |

### 5.2 Por qué la tercera, y por qué no es "fail-closed" a secas

El repo **ya tiene el patrón vivo**: `AfipNotConfiguredError`
(`domain/errors.ts:456`) no solo rechaza — **dice qué falta y dónde
arreglarlo**:

- *"falta cargar el CUIT del negocio en Mi Negocio"* (`invoice.service.ts:322`)
- *"falta el punto de venta AFIP en Mi Negocio"* (`:323`)
- *"falta cargar el certificado AFIP en Mi Negocio"* (`:326`)

**Fail-closed describe el resultado; "requiere configuración" describe el
resultado más el camino de salida.** Sin lo segundo, un tenant nuevo no puede
facturar y no sabe por qué.

**Queda como política recomendada a validar**, no como decisión de
implementación cerrada. Lo que falta para cerrarla: saber si existe alguna
combinación legítima pero rara que amerite revisión humana en vez de rechazo.

### 5.3 Tres estados distintos, no dos

Colapsarlos produce mensajes que mienten. Un tenant bien configurado no debe
ver "requiere configuración" porque ARCA está caído.

| Estado | Qué pasó | Naturaleza | Salida |
|---|---|---|---|
| **Tenant no configurado** | falta el CUIT, el punto de venta, el certificado o la condición fiscal del emisor | permanente hasta que alguien actúe | `requiere configuración` + qué falta y dónde — patrón `AfipNotConfiguredError` |
| **Combinación no habilitada** | el tenant está configurado, pero **esta** combinación emisor+receptor no está entre las habilitadas | permanente hasta una decisión | **rechazo explícito, sin inferir**. Nombra la combinación; no elige una "probable" |
| **ARCA indisponible** | no se pudo validar contra el catálogo | **transitorio** | política de indisponibilidad y reintento, **distinta** de un error de configuración |

El tercero es el que más fácil se confunde y el que peor se comporta si se
confunde: durante una caída de ARCA, un tenant correcto vería un mensaje que
le pide configurar algo que ya configuró.

**Queda abierto para el tercero:** si la emisión se bloquea mientras ARCA no
responde, o si se permite emitir con la configuración declarada y validar
después. Es la misma familia de decisión que `ISSUED_PENDING_LEDGER` en el
diseño de borrador, y **no se resuelve acá**.

---

## 6. [P] Inmutabilidad histórica — dos ejes

| Eje | Qué no debe pasar | Regla |
|---|---|---|
| **Cambia la condición del emisor** | que un comprobante viejo se reimprima con la condición nueva | R9 — congelar en el snapshot (§2.3) |
| **Cambia la configuración del tenant** | que habilitar A, o cambiar el punto de venta, reinterprete comprobantes ya emitidos | R12 — `criterios-datos.md:25`, un DOCUMENTO *"nunca se edita"* |

Los dos apuntan a lo mismo: **el contexto fiscal del emisor vive en el
comprobante, no se resuelve en lectura.**

---

## 7. [H] Migración de `customer_tax_profiles.tax_condition` — bloque separado

Hoy es **texto libre sin catálogo cerrado**
(`customer-tax-profile.entities.ts:33`). Con `getIvaReceptorTypes()`
disponible, la tentación es convertirlo en una referencia obligatoria al
catálogo. **No se hace acá, y no se asume resuelto.**

Lo que haría falta antes, y este documento no resuelve:

1. **Migración de los datos existentes**: qué pasa con las filas cuyo texto
   libre no matchea ningún id del catálogo.
2. **Compatibilidad**: si el campo pasa a obligatorio, todo cliente sin
   condición cargada bloquea su facturación.
3. **Comportamiento sin ARCA**: si el catálogo no se puede consultar, ¿se
   permite cargar la condición igual?

**El contrato puede introducir un identificador canónico** —un campo nuevo,
opcional— **sin asumir que la migración está resuelta**. Convivencia primero,
obligatoriedad después.

---

## 8. [P] Cómo describir esto fuera del documento

### 8.1 Redacción neutral del riesgo — obligatoria

Al registrar esta deuda en `pendientes` o en cualquier resumen, **no se
redacta como conclusión tributaria**. Decir *"sale Factura B y el cliente no
puede tomar el crédito fiscal"* convierte una observación técnica en
asesoramiento fiscal, que es justo lo que §4 prohíbe hacer en el código.

**Formulación a usar:**

> La configuración actual puede emitir un tipo de comprobante que no coincida
> con la situación fiscal del receptor. **El impacto tributario y la
> combinación correcta deben ser confirmados por un profesional y/o por la
> normativa aplicable.**

Lo que sí se puede afirmar sin validación profesional, porque es verificable en
el código: que `cbteTipo` está fijo en `FACTURA_B` (`invoice.service.ts:368`,
`:466`), que `condicionIvaReceptorId` se captura y no participa de esa
elección, y que no existe lógica de selección A/B/C.

**La observación es técnica; la consecuencia fiscal es de un profesional.**

---

## 9. Qué NO decide este documento

- **La condición fiscal del tenant actual.** Es dato operativo, no de diseño.
  Decide qué combinaciones habilitar y cómo probarlas en la primera
  implementación — **no** el modelo.
- **La semántica de `getIvaReceptorTypes(claseCmp)`** (§0). Hipótesis abierta.
- **Qué comprobante corresponde a cada combinación.** Es materia normativa y
  requiere validación profesional. El documento define **dónde vive la regla y
  cómo se valida**, nunca cuál es.
- **La migración de `tax_condition`** (§7).
- Nada de `CREATE TABLE`, migraciones ni código.

---

## 10. Limitaciones de este análisis

- **No se ejecutó nada:** ni suite, ni typecheck, ni una query, ni una llamada
  a ARCA. Todo es lectura de código, con cita verificada el 01/09/2026.
- **No hay certificado de producción**, así que ninguna afirmación sobre el
  comportamiento real de ARCA está observada.
- **No se leyó `@arcasdk/core`** ni el adaptador real
  (`arca-sdk-billing.adapter.ts`). Si el SDK transforma la respuesta de
  `getIvaReceptorTypes`, no se vio.
- **No se revisó el frontend**: qué pantalla cargaría la configuración fiscal
  del tenant no está analizado.
- El **conjunto mínimo del snapshot** (§2.3) se derivó de lo que el PDF lee
  hoy. Si hay otros consumidores del perfil en contextos históricos, no se
  buscaron.

---

## 11. Resumen por categoría

Para no tener que releer el documento entero para saber qué es qué.

### [V] Verificado en el repositorio

| Hecho | Cita |
|---|---|
| `cbteTipo` fijo en `FACTURA_B` en los dos caminos de emisión | `invoice.service.ts:368`, `:466` |
| Alcance declarado: *"solo los usados por Fase 2 (Factura B)"* | `afip-catalog.constants.ts:22` |
| Una sola constante de condición de receptor (`CONSUMIDOR_FINAL = 5`) | `:128` |
| `condicionIvaReceptorId` es parámetro con default consumidor final | `invoice.service.ts:342`, `:441` |
| Facturación **no** lee `customer_tax_profiles` | `invoices.routes.ts:82`, `:107` |
| El PDF lee 3 datos vivos del emisor y 1 del receptor | `invoice-pdf.service.ts:79-105` |
| El PDF **no** lee `CustomerTaxProfile` hoy | cero referencias en ese archivo |
| `cbteLetra` imprime el número si el tipo no es B | `invoice-pdf.service.ts:111` |
| El desglose de IVA ya se lee del `afipRequest` congelado | `:93` |
| `getIvaReceptorTypes(claseCmp?)` existe y consulta el catálogo oficial | `padron.service.ts:137-139` |
| `taxId` y `afipCuit` son deliberadamente independientes | `business-profile.entities.ts:64-73` |
| El repo ya elige fallar antes que adivinar (`resolveIvaAlicuotaId`) | `afip-catalog.constants.ts:160-166` |
| `AfipNotConfiguredError` rechaza diciendo qué falta y dónde | `domain/errors.ts:456`, `invoice.service.ts:322-326` |

### [P] Reglas de diseño propuestas — decisiones, no hechos

| Regla | Dónde |
|---|---|
| Snapshot **bilateral**: `issuerSnapshot` + `receiverSnapshot` | §2.3 |
| El PDF no lee `BusinessProfile`, `Customer` ni `CustomerTaxProfile` | §2.3 |
| El resolver devuelve **identidad canónica**, no un entero | §2.4 |
| `taxId` y `afipCuit` se mantienen separados en el `FiscalProfile` | §2.2 |
| El tenant configura y habilita; no redefine reglas fiscales | §3 |
| Dos capas: configuración declarativa **+** validación ARCA | §4 |
| No se hardcodea la matriz RI→CF / RI→RI / Mono→* | §4 |
| Tres estados operativos distintos, no dos | §5.3 |
| Rechazo explícito con salida accionable ante combinación no habilitada | §5.2 |
| El contexto fiscal del emisor vive en el comprobante, no en lectura | §6 |
| Redacción neutral obligatoria del impacto tributario | §8.1 |

### [H] Hipótesis y decisiones que dependen de algo externo

| Cuestión | De qué depende | Estado |
|---|---|---|
| ¿`getIvaReceptorTypes(claseCmp)` devuelve una relación comprobante↔receptor? | ejecutarlo con certificado real | **abierta** — §0 |
| ¿Qué hacer si ARCA está caído: bloquear o emitir con configuración validada? | decisión de negocio + tolerancia operativa | **abierta** — §5.3 |
| ¿Cómo migrar `tax_condition` de texto libre a catálogo? | diseño de compatibilidad y migración | **abierta** — §7 |
| ¿Qué comprobante corresponde a cada combinación fiscal? | normativa + profesional | **fuera de alcance** — §9 |
| ¿Existe una combinación legítima y rara que amerite revisión humana? | operación real | **abierta** — §5.2 |

---

## Anclado en

- `src/facturacion/afip-catalog.constants.ts` — L10-18, L22-25, L33, L128, L140-143, L147-149, L160-166
- `src/facturacion/invoice.service.ts` — L322-326, L342, L368, L441, L466
- `src/facturacion/invoice-pdf.service.ts` — L79, L81, L97, L99
- `src/facturacion/padron.service.ts` — L14-22, L91-94, L136-141
- `src/domain/business-profile.entities.ts` — L53-73
- `src/clientes-finanzas/customer-tax-profile.entities.ts` — L33-34
- `src/domain/errors.ts` — L456
- `src/db/schema.sql` — L394-404, L2483, L2658
- `docs/criterios-datos.md` — L25, L199
- `docs/diseno-factura-borrador-2026-08-31.md` — §18, §25
