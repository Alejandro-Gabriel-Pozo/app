# Diseño — `FiscalProfile` y `ComprobanteTypeResolver`

- **Fecha:** 2026-09-01
- **Estado:** **HOLD DE DISEÑO LEVANTADO (01/09/2026, más tarde el mismo día). HOLD DE IMPLEMENTACIÓN: VIGENTE** — ningún código, schema ni migración de este documento está autorizado; requiere su propia autorización específica y separada cuando llegue ese bloque. Historial: revisado por el
  dueño el 01/09/2026, aceptado como **diseño preliminar**, con el snapshot
  ampliado a los dos lados del comprobante (§2.3), tres estados operativos en
  vez de dos (§5) y redacción neutral del impacto tributario (§8.1). Segunda
  revisión el mismo día: snapshot bilateral cerrado como decisión y `cbteLetra`
  elevado a **identidad canónica del comprobante** (§2.4). Tercera revisión, más
  tarde el mismo día: el HOLD **de diseño** queda levantado por decisión del dueño ("es un
  ERP, la sobreingeniería acá es bienvenida, esto es lo fundamental") — **la
  arquitectura de este documento puede empezar a diseñarse en
  detalle.** Levantar el HOLD de diseño no autoriza implementación: ese es un HOLD distinto, que sigue vigente. Lo que NO cambia con esta decisión: la hipótesis **[H]** sobre
  `getIvaReceptorTypes()` (tabla al final del documento) sigue sin confirmar —
  es un hecho externo (certificado ARCA / validación profesional), no una
  cuestión de ambición de producto. El resolver se sigue diseñando para
  funcionar sin esa hipótesis y mejorar si se confirma, tal como ya especificaba
  §0. No modifica `diseno-factura-borrador-2026-08-31.md` (v2.5+) todavía —
  eso es su propio bloque de implementación, no automático por este cambio de
  estado.
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

**Anclas corridas (22/09/2026, gate `architecture-governor`, ronda 1)** —
las líneas de esta tabla y de "Anclado en" son las del 01/09/2026;
`invoice.service.ts` y `afip-catalog.constants.ts` en particular se
movieron desde entonces (los call sites hoy viven en `:718`/`:931`/
`:1005` y `:621`/`:817`, y `resolveDocTipo()` en `:125-134` — ver §12
para las citas vivas). No re-verificadas línea por línea en este bloque
(mismo criterio que `SCHEMA-ANCHOR-DRIFT-001`: declarar el drift en vez
de recalcular números que van a volver a correrse) — antes de citar
cualquier línea de esta tabla, re-chequear contra el archivo vivo.

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

## 12. Resolución Wave 14 (22/09/2026) — grounding + decisiones del dueño

Este documento quedó con 5 hipótesis [H] abiertas (§11). Esta sección las
cierra una por una, con la evidencia que las cerró — no reescribe las
secciones anteriores (mismo criterio que `SCHEMA-ANCHOR-DRIFT-001`:
corregir hacia adelante).

### 12.0 Corrección de alcance — HOLD del gate (22/09/2026, ronda 1) + decisión del dueño

El gate `architecture-governor` dio **HOLD** sobre la primera versión de
esta sección: §12.8 (tal como estaba redactado) implicaba conectar
`cbteTipo` real (Factura A/B/C), y eso dispara al menos 10 ubicaciones de
`src/` + 4 de `appfrontend-main` que hoy asumen "siempre Factura B" en
firme — incluida la irreversibilidad de Nota de Crédito
(`invoice.service.ts`, `if (original.cbteTipo !== CBTE_TIPO_FACTURA_B)
throw InvoiceNotReversibleError`), la compensación fiscal F4
(`CBTE_TIPOS_NOTA_CREDITO`), la bandeja de reconciliación manual
(`sql.invoice.repository.ts`, 4 sitios con `cbte_tipo = $N` literal) y
`cbteLetra` del PDF (§2.4, todavía "no implementar" en ese momento). Esa
matriz de impacto no estaba en el alcance de esta sección y necesita su
propio diseño.

**Decisión del dueño (`AskUserQuestion`, 22/09/2026): partir el bloque.**

- **14a (este documento, esta sección):** emitir Factura B con los datos
  REALES del receptor (CUIT/condición de IVA reales, en vez del
  `CONSUMIDOR_FINAL` genérico actual) — el `cbteTipo` sigue fijo en
  Factura B, así que **ninguna** de las 10+4 ubicaciones que asumen
  "siempre B" se ve afectada. Confirmado como mejora válida por sí
  sola: hoy se factura a Consumidor Final aunque el cliente tenga CUIT
  cargado.
- **14b (fuera de este documento, bloque futuro con su propio gate):**
  emitir Factura A/C real. Necesita la matriz de impacto completa de las
  10+4 ubicaciones, la superficie de configuración por tenant de §3
  (hoy **[P]**, no construida — ninguna tabla/endpoint/pantalla existe),
  el snapshot bilateral del receptor de §2.3, `cbteLetra` (§2.4), y las
  constantes NC A(3)/NC C(13) todavía sin agregar a
  `CBTE_TIPOS_NOTA_CREDITO`.

**Consecuencia sobre el resto de esta sección:** §12.2 (grounding de
§5.2), §12.3 (bug de `cmp_Clase`), §12.4 (`resolveDocTipo()` fail-loud),
§12.6 (columna `iva_condicion_id`) y §12.7 (validación al guardar el
perfil) **siguen vigentes tal como están** — ninguno depende de emitir
`cbteTipo` ≠ B. §12.8 se reescribe abajo para acotarse a 14a
explícitamente (solo `Buyer`, nunca `cbteTipo`).

### 12.1 Decisiones del dueño (`AskUserQuestion`, 22/09/2026)

- **14a primero, 14b bloque aparte.** Resuelto en 12.0.
- **ARCA caído al emitir → bloquear la emisión.** Cierra la mitad de §5.3
  que quedaba abierta ("si la emisión se bloquea mientras ARCA no
  responde, o si se permite emitir con la configuración declarada y
  validar después"). Se elige la opción conservadora — no emitir con
  datos fiscales sin confirmar. **Esto supera textualmente la frase de
  §4** ("Si solo hubiera validación en vivo, una caída de ARCA
  bloquearía toda la facturación", presentada ahí como razón para NO
  hacerlo) — la razón de §4 sigue siendo válida como advertencia de
  costo, pero el dueño eligió aceptar ese costo. §4 no se reescribe
  (mismo criterio de corregir hacia adelante); esta nota es la
  supersesión explícita que faltaba.
- **Combinación fiscal rara/válida (§5.2) → grounding, no elección
  directa del dueño.** Resuelto en 12.2.
- **Factura E (exportación) → afuera de este bloque (y de 14b también),
  fase futura propia.** Resuelto en 12.5.
- **`resolveDocTipo()` ante `taxIdType` no reconocido → rechazo
  explícito, no fallback silencioso.** Resuelto en 12.4. Verificado
  seguro contra datos reales en 12.10 — no hay `taxIdType` sin
  reconocer hoy en ningún tenant productivo.

### 12.2 Grounding (`auditor-circuitos-erp`, 22/09/2026) — resuelve §5.2

**Veredicto: ninguno de los tres referentes con resolver fiscal real
(Odoo `l10n_ar`, ERPNext/India Compliance, Cloudbeds) elige (a) "rechazo
explícito" ni (b) "cola de revisión" tal como §5.1 las planteaba — las
dos aplican, pero en capas distintas.** El documento (factura) nunca se
bloquea — nace y queda en borrador. Lo que se bloquea es la **emisión
fiscal**. Y la superficie donde el humano resuelve una combinación rara
**no es una cola nueva: es el maestro del cliente** (el `CustomerTaxProfile`
de este documento), validado al guardarlo — mismo momento en que ERPNext
corre `validate_gst_category(gst_category, gstin)` sobre el `party`.

**Ancla más directa (misma AFIP): Odoo `l10n_ar`.**
`_get_journal_letter()` (`l10n_ar/models/account_journal.py`) intersecta
la letra habilitada por el emisor con la habilitada por el receptor; si
la intersección da vacía, la factura **sigue en `draft`, sin
`l10n_latam_document_type_id`** — el bloqueo real llega recién en el
`@api.constrains('state', ...)`, que solo dispara `state == 'posted'`.
Documento sin bloquear, emisión bloqueada — exactamente la distinción de
arriba.

**Consecuencia para §5.1/§5.2:**
- **NO se crea una cola de revisión fiscal nueva** — sería un mecanismo
  sin precedente en los 5 sistemas de referencia (ninguno tiene una cola
  separada para *configuración*; las colas que sí existen, en ERPNext y
  Cloudbeds, son sobre el *resultado* de hablar con el fisco —
  `einvoice_status`/`PENDING_INTEGRATION`, ya cubierto por
  `ISSUED_PENDING_LEDGER`/`EMISSION_FAILED` de
  `docs/diseno-factura-borrador-2026-08-31.md` §5 y por
  `credit_note_requests`, no un mecanismo nuevo).
- **La pregunta abierta de §5.2** ("¿existe una combinación legítima
  pero rara que amerite revisión humana en vez de rechazo?") **se
  responde no** — los tres referentes no tratan el caso raro-pero-válido
  como excepción: lo enumeran como categoría de primera clase en el
  catálogo del maestro (§12.7).
- **El rechazo explícito con salida accionable de §5.2 se mantiene**, en
  emisión, como red de seguridad (patrón `AfipNotConfiguredError` ya
  vigente) — pero deja de ser la superficie PRIMARIA de resolución. La
  primaria pasa a ser la validación al guardar el perfil fiscal (§12.7).

**Matiz que el grounding agrega, no cambia:** el riesgo real no es
bloquear de más (el árbitro — ARCA — existe y publica su propia matriz
vía `FEParamGetCondicionIvaReceptor` filtrada por `ClaseCmp`), es que
**la matriz propia de este sistema sea más angosta que la de ARCA** y
rechace algo que el fisco aceptaría. Precedente negativo confirmado en
Odoo mismo: su matriz vive hardcodeada en Python (`letters_data`), y
`.get(code, [])` sin default para un código de responsabilidad AFIP
nuevo produce el mismo modo de falla — dato extensible, regla no. La
matriz `RI→CF=B`/`RI→RI=A`/`Mono→*=C` de §4 sigue sin hardcodearse por
esta misma razón, ahora con evidencia empírica, no solo principio.

### 12.3 Bug real encontrado, a corregir en este bloque: `cmp_Clase` descartado

`padron.service.ts::getIvaReceptorTypes()` (cita por nombre, no línea,
desde `SCHEMA-ANCHOR-DRIFT-001` — al 22/09/2026, `:158`) y
`arca-sdk-billing.adapter.ts::getIvaReceptorTypes()` (la copia duplicada
de `AfipBillingPort`, ver su propio docblock — al 22/09/2026, `:133`,
corregido en el gate: la ronda 1 de esta sección citaba `:132`, que es
el `withAfipTimeout(...)` de la línea anterior, no la proyección) hacen
la misma proyección lossy:

```ts
return (result.resultGet?.condicionIvaReceptor ?? []).map((t) => ({ id: t.id, description: t.desc }));
```

`t.cmp_Clase` (tipado en el SDK, `IvaReceptorType.cmp_Clase`) se
descarta en los dos. Ese campo es justamente el que ARCA usa para decir
qué condiciones de receptor son válidas **por clase de comprobante** —
sin él, `IvaReceptorTypeOption` no puede alimentar la validación de
§12.7 ni la hipótesis [H] de §0.

**Corrección del gate (ronda 1): son DOS declaraciones del tipo, no
una.** `IvaReceptorTypeOption` existe por duplicado, mismo criterio que
el método mismo: `padron.service.ts::IvaReceptorTypeOption` (la que usa
la ruta real, `GET /api/customers/padron/iva-receptor-types`) **y**
`afip-billing.port.ts::IvaReceptorTypeOption` (la que declara
`AfipBillingPort`, consumida por la copia sin caller de
`arca-sdk-billing.adapter.ts`). **[P] nuevo:** las dos ganan el campo
`cmpClase: string`, y los dos call sites (`padron.service.ts`,
`arca-sdk-billing.adapter.ts`) dejan de proyectar solo
`{id, description}`. No se unifican los dos tipos en este bloque — es
la misma deuda ya declarada en el docblock de
`arca-sdk-billing.adapter.ts` ("duplicado sin resolver, documentado a
propósito"), no algo que este diseño deba resolver de paso. Esto
**degrada la incertidumbre de [H]/§0, no la resuelve del todo**: sigue
sin confirmarse con certificado real qué valores trae la respuesta,
pero deja de ser una incógnita de FORMA — el campo ya está tipado por
el SDK, solo faltaba no tirarlo.

### 12.4 `resolveDocTipo()` — rechazo explícito ante `taxIdType` no reconocido

Reemplaza el `default: return DOC_TIPO_CONSUMIDOR_FINAL`
(`afip-catalog.constants.ts:132`) por un error de dominio nuevo cuando
`taxIdType` no matchea `CUIT`/`CUIL`/`CDI`/`DNI` — mismo patrón que
`resolveIvaAlicuotaId()`/`UnsupportedIvaRateError` (falla explícito en
vez de adivinar, ya elegido dos veces en este archivo).

**Evidencia del grounding a favor:** Dolibarr (`get_default_tva()`,
issue real `dolibarr-community-modules#984`) y PrestaShop/QloApps
(`TaxRulesTaxManager::getTaxCalculator()` → `new TaxCalculator([])`, 0%
silencioso) son los dos referentes que SÍ infieren en silencio ante un
caso no reconocido — y los dos tienen bugs fiscales reales documentados
por eso. El fallback actual de `resolveDocTipo()` es estructuralmente
el mismo antipatrón, todavía inocuo porque **hoy no tiene caller de
producción** (congelado por `invoice.service.test.ts`, describe "D-25").
Este bloque lo conecta — el fallback deja de ser inocuo en el momento en
que lo hace, así que se corrige en el mismo cambio que lo conecta, no
después.

**Ubicación nueva (gate, ronda 4, N1): `afip-catalog.constants.test.ts:20-25`
congela HOY las 4 ramas del fallback, no solo la que este bloque quiere
tocar.** El test actual:

```ts
it('cae a Consumidor Final si no matchea nada conocido, en vez de inventar un código', () => {
  expect(resolveDocTipo('pasaporte')).toBe(DOC_TIPO_CONSUMIDOR_FINAL);
  expect(resolveDocTipo(null)).toBe(DOC_TIPO_CONSUMIDOR_FINAL);
  expect(resolveDocTipo(undefined)).toBe(DOC_TIPO_CONSUMIDOR_FINAL);
  expect(resolveDocTipo('')).toBe(DOC_TIPO_CONSUMIDOR_FINAL);
});
```

Destapa una pregunta de diseño que §12.4 no había separado: el fail-loud
¿cubre las 4 ramas por igual, o distingue "no me dijeron nada" de "me
dijeron algo que no reconozco"? **Decisión técnica (no de negocio — es
sobre qué cuenta como dato ausente vs. dato sucio, ya delimitado por la
firma existente de la función, `taxIdType: string | null | undefined`):**

- `null`/`undefined`/`''` **siguen cayendo a `DOC_TIPO_CONSUMIDOR_FINAL`,
  sin cambio.** Representan "no se proveyó identificación" — el mismo
  caso legítimo que `DocTipo` 99 ya existe para resolver (`DocNro = 0`,
  sin exigir un número). No es un dato sucio, es la ausencia declarada de
  dato — inventar un rechazo acá violaría el principio transversal
  ("la app no le dice al cliente cómo trabajar") tanto como el fallback
  original violaba honest-degradation.
- **Solo un string no vacío que no matchea `CUIT`/`CUIL`/`CDI`/`DNI`**
  (`'pasaporte'`, cualquier otro valor cargado a mano) dispara el rechazo
  explícito nuevo (§12.4 abajo, con el error `UnsupportedTaxIdTypeError`).
  Ese es el caso real que Dolibarr/PrestaShop ilustran: un valor CONCRETO
  que el sistema no supo interpretar, no la ausencia de valor.

**Consecuencia en el test:** de las 4 aserciones actuales, 3
(`null`/`undefined`/`''`) se mantienen sin cambio; solo
`resolveDocTipo('pasaporte')` pasa a `expect(() =>
resolveDocTipo('pasaporte')).toThrow(UnsupportedTaxIdTypeError)`. Listado
explícito en §12.13.

**Ubicación nueva (gate, ronda 4, N6): el "error de dominio nuevo" que
este punto pide no tenía ni clase ni mapeo declarados — faltaban 2
archivos en §12.13.** Mismo patrón exacto que `UnsupportedIvaRateError`
(`src/domain/errors.ts:566-573`, code `'UNSUPPORTED_IVA_RATE'`, mapeado a
**422** en `error.middleware.ts:202` — grupo semántico "request bien
formado, regla de negocio fiscal lo impide", no 400): se agrega
`UnsupportedTaxIdTypeError extends DomainError` en `errors.ts`, junto a
`UnsupportedIvaRateError`, con code `'UNSUPPORTED_TAX_ID_TYPE'` y mensaje
que nombra el `taxIdType` recibido y sugiere `CUIT`/`CUIL`/`CDI`/`DNI`.
Se agrega su `case 'UNSUPPORTED_TAX_ID_TYPE':` al mismo grupo 422 de
`error.middleware.ts:199-210` (junto a `UNSUPPORTED_IVA_RATE`, `:202`) — **no**
al grupo 400 (`resolveDocTipo()` se llama desde `resolveFiscalIdentity()`
en emisión, §12.8, el mismo momento que `resolveIvaAlicuotaId()`; distinto
del 400 "nombra el id" de §12.7, que es sobre el guardado del perfil, otra
superficie). Sin este `case`, el error caería al default genérico — el
mismo modo de falla que el propio docblock de `AfipPadronUnavailableError`
(`errors.ts:554`) documenta como bug real de producción (23/08/2026).

Además del test (arriba), 3 docblocks quedan desactualizados por esta
conexión y se reescriben en el mismo commit (listados en §12.13):
`afip-catalog.constants.ts:99-116` (dice "sin consumidor de producción
hoy"), `afip-catalog.constants.ts:118-124` (docblock propio de
`resolveDocTipo()`, dice "cae a Consumidor Final" sin distinguir las dos
ramas de arriba) y `afip-catalog.constants.ts:136-145` (docblock de
`docTipoLabel()`, se autodescribe como "Inverso de `resolveDocTipo()`" —
deja de ser un inverso total una vez que una de las ramas de entrada pasa
a lanzar en vez de devolver un número; sigue siendo el inverso de las
ramas que SÍ devuelven, aclarar eso).

### 12.5 Alcance explícito: Factura E / WSFEXv1 queda AFUERA de este bloque

El caso "cliente extranjero sin CUIT" (el ejemplo usado al pedir el
grounding) **no es un caso borde dentro de WSFEv1** — es **Factura E de
exportación** (RG 2758), que ARCA resuelve por un web service distinto,
**WSFEXv1**, con identificación genérica por país/tipo de sujeto en vez
de CUIT argentino. `arca-sdk-billing.adapter.ts` solo implementa
`electronicBillingService` (WSFEv1) — WSFEXv1 no está integrado.

**Decisión del dueño (22/09/2026):** Factura E queda fuera de P-16, como
fase futura propia con su propio diseño (otro protocolo, no una
extensión de este resolver). Odoo confirma la separación
estructuralmente: para partners con responsabilidad de exportación
enruta a un *journal* de exportación distinto, no a una rama del mismo
flujo.

**Consecuencia práctica:** si el perfil fiscal de un cliente indica un
`taxIdType` extranjero sin equivalente en `CUIT`/`CUIL`/`CDI`/`DNI`, el
rechazo explícito de §12.4 es el comportamiento correcto — es el borde
declarado del alcance, no un bug. El caso raro-pero-válido que SÍ vive
dentro de WSFEv1 (persona extranjera con Pasaporte/CI Extranjera,
`DocTipo` 94/91 según `FEParamGetTiposDoc`) **tampoco se agrega en este
bloque** — mismo alcance, queda para cuando se diseñe Factura E o se
decida agregarlo aparte.

### 12.6 §7 (migración de `tax_condition`) — deja de ser bloque separado opcional

El grounding mostró que la validación taxIdType↔taxCondition en el
maestro (§12.2/§12.7) es la superficie real donde se resuelve la
ambigüedad — y esa validación necesita un identificador canónico contra
el cual cruzar, no solo texto libre. §7 seguía "convivencia primero,
obligatoriedad después" (`[H]`, sin resolver el CÓMO); ese principio se
mantiene, pero el **campo nuevo, opcional** que §7 ya proponía se
especifica ahora:

- `customer_tax_profiles` gana `iva_condicion_id INTEGER NULL` —
  referencia al `id` numérico que devuelve `getIvaReceptorTypes()`.
  Convive con `tax_condition` (texto libre, columna existente, SIN
  tocar) — no lo reemplaza, no lo obliga. **Opcionalidad en TS, cerrada
  (gate, ronda 7 — el doc lo dejaba sin decidir):** `ivaCondicionId` es
  **opcional** en `UpsertCustomerTaxProfileInput`
  (`ivaCondicionId?: number | null`), mismo patrón que su hermano
  `taxCondition?: string | null` — no requerido. Un campo requerido
  rompería el único call site real hoy (`customers.routes.ts:371-380`,
  que construye el input sin este campo) y su espejo en `appfrontend`,
  sin ninguna ganancia: la columna ya es `NULL` en la base, así que
  exigirlo en TS sin exigirlo en SQL sería una inconsistencia, no una
  garantía real.
- Se puebla desde `getIvaReceptorTypes()` cuando hay certificado
  disponible (autocompletar, mismo patrón que `PadronService` ya usa
  para el resto del perfil), o cargado a mano si ARCA no responde en
  ese momento (§12.7 último párrafo).
- **Precedencia durante la convivencia — corregida (gate, ronda 2:** la
  redacción original decía *"si `iva_condicion_id` es NULL,
  `tax_condition` se usa tal cual"*, que no es ejecutable — `tax_condition`
  es texto libre y `condicionIvaReceptorId` que viaja a ARCA es `number`;
  no hay, ni se construye acá, una función texto→id (sería la matriz
  hardcodeada que §12.2/§4 prohíben). **Regla real:** cuando
  `resolveFiscalIdentity()` (§12.8) necesita el `condicionIvaReceptorId`
  numérico que se manda a ARCA, usa `iva_condicion_id` si no es `NULL`
  (identificador canónico); si es `NULL` (caso de HOY, para el 100% de
  los perfiles existentes — medido, §12.10, ninguna UI lo puebla
  todavía), cae al mismo default que ya usa el sistema hoy
  (`CONSUMIDOR_FINAL`, `id=5`) — **no** a una conversión de
  `tax_condition`. `tax_condition` (texto libre) se sigue usando
  únicamente como ETIQUETA humana en el PDF (§12.11), nunca como
  entrada de un número que va a ARCA — esa es la línea que separa
  "mostrar lo que el negocio tipeó" de "inventarle un código fiscal a
  ARCA". **Contradicción interna corregida (gate, ronda 6): este punto
  decía "poblar `iva_condicion_id` de verdad (por UI o autocompletado)
  queda fuera de 14a", escrito antes de la decisión del dueño P-B
  (§12.11(3), ronda 3) que trae el selector de UI adentro de 14a — las
  dos afirmaciones no pueden ser ciertas a la vez.** §12.11(3) es la que
  vale: el selector "Condición frente al IVA" (que sí puebla
  `iva_condicion_id` vía `getIvaReceptorTypes(claseCmp='B')`, con
  validación de pertenencia en §12.7) entra a 14a, en reemplazo del
  `&lt;input&gt;` de texto libre — el autocompletado del padrón NUNCA lo
  infiere (P-A, mismo §12.11(3)), esa parte sí sigue fuera. Lo que
  degradación honesta cubre no es "sin UI", sino "sin certificado ARCA":
  un tenant sin certificado se queda sin poder cargar el selector (hueco
  aceptado explícitamente, P-B) — no es que 14a deje el campo sin UI por
  decisión de alcance.
- **Lo que §7 seguía sin resolver, SIGUE sin resolverse acá:** migración
  de los datos existentes de `tax_condition` (punto 1), ni si el campo
  pasa a obligatorio (punto 2) — `iva_condicion_id` nace opcional, sin
  bloquear a ningún cliente que ya tenga `tax_condition` cargado en
  texto libre.

### 12.7 Validación al guardar el perfil fiscal — nuevo, cierra §5.2

**Corregido (gate, ronda 3): es un chequeo de PERTENENCIA, no de
"combinación" — la redacción original repetía el mismo error que §12.6
tuvo que corregir.** El catálogo de ARCA (`IvaReceptorType`, SDK) no
tiene dimensión de tipo de documento — es `{id, desc, cmp_Clase}`, nada
de `taxIdType`. No hay forma de validar "`taxIdType` × condición" contra
ese catálogo sin construir la matriz prohibida por §12.2/§4, y además
**contradiría la decisión (1) de §12.11** (sería un guard nuestro
anticipando a ARCA, justo lo que el dueño rechazó).

**Regla real:** `PUT /customers/:id/tax-profile` (`customers.routes.ts`),
cuando se carga `iva_condicion_id` (el selector nuevo de §12.11) y hay
certificado ARCA disponible, verificar que ese `id` **pertenezca** al
catálogo real que devuelve `getIvaReceptorTypes(claseCmp='B')` (ahora
con `cmpClase`, §12.3 — Factura B es el único tipo que 14a emite, así
que es el único `claseCmp` que 14a necesita consultar). Si el `id`
elegido no está en esa lista, **rechazo explícito al GUARDAR** (400,
nombra el id). Si el catálogo mismo viene vacío (`claseCmp` mal
formado, o cualquier otra causa) **se trata como "no disponible", nunca
como "no matchea"** — mismo camino que `AfipPadronUnavailableError` de
abajo, no un rechazo de todos los perfiles.

**Clase de error (gate, ronda 5 — hueco cerrado, mismo tipo de omisión
que N6 en §12.4, una superficie más allá):** el 400 de este párrafo NO
necesita una clase de dominio nueva — a diferencia de §12.4 (emisión,
grupo 422), esto es una validación de request bien delimitada sobre un
único campo al guardar, mismo caso que el resto de
`UpsertTaxProfileSchema`. Usa `ValidationError` (`errors.ts:222-228`,
code `'VALIDATION_ERROR'`, ya mapeada a 400 en `error.middleware.ts` —
grupo `:138-152`), nombrando el `id` rechazado en el mensaje. No se
declara clase nueva para este punto.

**Distinto de emisión (§5.3), a propósito — no se confunden los dos
caminos, y son DOS clases de error distintas, no una** (corrección del
gate, ronda 1 — faltaba nombrarlas): si `resolveAfipClient()` no puede
armar el cliente por falta de configuración del tenant, tira
`AfipNotConfiguredError` (estado 1 de §5.3, permanente hasta que
alguien configure) — ese caso no cambia con este bloque. Si el cliente
SÍ está configurado pero `callPadron()` (`padron.service.ts`) falla al
contactar a ARCA (timeout, servicio caído), tira
`AfipPadronUnavailableError` (estado 3 de §5.3, transitorio). **La
validación de §12.7 solo se salta ante `AfipPadronUnavailableError`** —
ARCA caído en ese momento puntual. Si lo que falta es configuración
(`AfipNotConfiguredError`), guardar el perfil sin validar NO es el
comportamiento correcto: ese es el estado permanente que ya tiene su
propio mensaje accionable (`AfipNotConfiguredError`, patrón ya vigente)
y no debería confundirse con "ARCA está bien, en este momento no
respondió". El catálogo es best-effort en la carga de datos frente al
estado transitorio, no frente al estado de configuración. El bloqueo
por ARCA caído de §12.1 sigue siendo específicamente sobre EMITIR, no
sobre guardar un perfil.

### 12.8 Conexión de `invoice.service.ts` — alcance de implementación, ACOTADO A 14a

**Corrección del gate (ronda 1): esta función NO toca `cbteTipo` en este
bloque — eso es 14b, ver §12.0.** Función nueva (nombre tentativo
`resolveFiscalIdentity(customerId)`) que reemplaza el default silencioso
a `CONSUMIDOR_FINAL` cuando `input.buyer` no viene explícito en
`requestInvoice()`/`requestConsolidatedInvoice()` (los 2 call sites,
`const buyer = input.buyer ?? CONSUMIDOR_FINAL` — cita por nombre, no
línea):

- Si el cliente tiene `CustomerTaxProfile` con datos completos y
  coherentes (mismo criterio de §12.7, con la precedencia de §12.6),
  resuelve **solo el `Buyer`** real (`docTipo`/`docNro`/
  `condicionIvaReceptorId`) — el `cbteTipo` que se manda a AFIP sigue
  siendo `CBTE_TIPO_FACTURA_B`, sin excepción, en TODO este bloque. La
  superficie de configuración por tenant de §3 (qué combinaciones
  habilitó) **no se construye en 14a** — no hace falta: con `cbteTipo`
  fijo en B, no hay matriz emisor×receptor que resolver todavía. §3/§4
  siguen [P], su implementación queda en 14b.
- Si el cliente **no tiene** perfil fiscal cargado, sigue cayendo a
  `CONSUMIDOR_FINAL` — **no es una regresión ni una ambigüedad**:
  "cliente sin perfil fiscal = Consumidor Final" es una decisión de
  negocio ya válida (mismo default de hoy), distinta de "cliente CON
  perfil fiscal incoherente", que sí es el caso que §12.4/§12.7 cubren.

**Ubicación nueva (gate, ronda 4, N3): existe una segunda puerta que
esquiva `resolveFiscalIdentity()` por completo — declarada, no cerrada en
14a.** `BuyerSchema` (`src/api/schemas/facturacion.schemas.ts:15-19`)
permite que `POST /api/invoices` y `POST /api/invoices/consolidated`
manden un `buyer` explícito en el body
(`docTipo`/`docNro`/`condicionIvaReceptorId`, los 3 como número/string
sueltos, sin pasar por el catálogo de ARCA ni por §12.7). Los dos routers
(`invoices.routes.ts:210` y `:235`) lo reenvían tal cual al service —
`input.buyer` explícito **gana** sobre lo que resuelva
`resolveFiscalIdentity()` (la función solo reemplaza el fallback cuando
`input.buyer` NO viene, exactamente como ya dice el primer párrafo de
esta sección). **Decisión técnica (no de negocio, mía — declarar la
superficie, no rediseñarla en este bloque):** esta puerta es capacidad
YA EXISTENTE, previa a este diseño (no la introduce 14a) y **hoy sin
consumidor real** — verificado contra `appfrontend`: cero ocurrencias de
`condicionIvaReceptor`/`docTipo` en `src/`. Queda declarada y NO auditada
en 14a — ver §12.9. Si en el futuro un caller empieza a mandar `buyer`
explícito, la pregunta "¿se valida contra el catálogo o se deja pasar tal
cual, igual que la decisión (1) de §12.11 para el camino del perfil?" es
una decisión de producto propia, con su propio `AskUserQuestion` — no se
resuelve acá por default silencioso.

**Ubicación nueva (gate, ronda 5, N9): el camino PRIMARIO por el que
`condicionIvaReceptorDesc` (columna nueva, §12.11(3)) llega al INSERT no
estaba definido — §12.11(3) solo cubría `buildCreditNote()` (N2, un
camino DERIVADO).** `Buyer` es una interfaz cerrada de 3 campos
(`docTipo`/`docNro`/`condicionIvaReceptorId`, `invoice.service.ts:85-89`)
y los 2 call sites reales que arman el create-input desde un `buyer`
(`requestInvoice()` `:721-723`, `requestConsolidatedInvoice()`
`:934-936`) copian exactamente esos 3 campos — ninguno de los dos copia
una `desc`, porque no existe ningún dato con ese nombre en `Buyer`.

**Resolución:** `resolveFiscalIdentity(customerId)` (§12.8, arriba) NO
devuelve un `Buyer` — devuelve un tipo nuevo, `FiscalIdentity { buyer:
Buyer; condicionIvaReceptorDesc: string | null }`. El campo `buyer` sigue
siendo exactamente lo que hoy se manda a ARCA (sin cambio de forma en el
request fiscal — separación deliberada: `condicionIvaReceptorDesc` es
dato nuestro, para el PDF, nunca viaja al SOAP de AFIP). Los 2 call
sites pasan a construir el create-input con
`condicionIvaReceptorId: identity.buyer.condicionIvaReceptorId` (sin
cambio) **y** `condicionIvaReceptorDesc: identity.condicionIvaReceptorDesc`
(campo nuevo) desde el mismo resultado de `resolveFiscalIdentity()`.
Cuando el cliente no tiene perfil fiscal (cae a `CONSUMIDOR_FINAL`,
último párrafo de arriba), `condicionIvaReceptorDesc` es `null` — mismo
criterio que §12.11(3) ya declara para `iva_condicion_id` nulo.

**El camino de `input.buyer` explícito (N3, `BuyerSchema`) escribe
`NULL`, declarado — no una omisión.** `BuyerSchema` tiene los mismos 3
campos que `Buyer`, sin `desc` (`facturacion.schemas.ts:15-19`) — ese
camino nunca pasa por `resolveFiscalIdentity()` (N3, arriba), así que no
hay ninguna `description` de catálogo que copiar. El create-input recibe
`condicionIvaReceptorDesc: null` en ese caso — mismo resultado que un
cliente sin perfil fiscal (PDF sin condición de IVA impresa para el
receptor, comportamiento actual sin cambio) — **no** un intento de
resolver la `desc` contra el catálogo a partir del `condicionIvaReceptorId`
suelto que mandó el caller, que sería inventar una relación no declarada
por quien llamó al endpoint.

### 12.9 Lo que este bloque sigue sin resolver — fuera de alcance, explícito

**Reordenado (gate, ronda 4, C5 — higiene): esta sección y §12.10 vivían
físicamente después de §12.11/§12.12/§12.13 pese a numerarse antes.**
Movidas acá, entre §12.8 y §12.11, para que el orden físico coincida con
el numérico — sin cambio de contenido salvo las correcciones de esta
ronda, marcadas abajo.

- Factura A/C real (`cbteTipo` ≠ B) — 14b, bloque aparte con su propia
  matriz de impacto (§12.0).
- Factura E / WSFEXv1 (§12.5) — fase futura propia.
- Migración completa de `tax_condition` texto libre → catálogo
  obligatorio (§7 puntos 1/2, parcialmente avanzado por §12.6, no
  cerrado).
- `DocTipo` Pasaporte(94)/CI Extranjera(91) (ligado a §12.5).
- ~~Confirmación con certificado de producción real contra ARCA — hipótesis
  [H] de §0 pasa de "¿existe la relación?" (cerrada, §12.3) a "¿qué
  valores trae en runtime?"~~ **[H] CERRADA (22/09/2026, gate pre-commit
  del Commit A).** Se corrió `getIvaReceptorTypes('B')` contra ARCA
  **homologación** real (nunca producción) con el certificado del tenant
  Demo (`§12.10` — `afip_environment='homologacion'`, `tax_id
  '20423055686'` como CUIT de autenticación, `afip_cuit` en `NULL`).
  Mecanismo de verificación: certificado desencriptado y SDK invocados
  **fuera de esta sesión**, por el dueño, en su propia máquina — esta
  sesión solo trajo el ciphertext de solo lectura (vía Neon) y armó el
  script; `DB_ENCRYPTION_KEY` (clave maestra de TODOS los tenants) nunca
  entró a este contexto, por diseño (`secret-lifecycle-discipline`: el
  radio de acceso tiene que ser proporcional a lo que hace falta
  verificar, no a lo que sería cómodo tener). **Resultado real:** 7
  opciones para `claseCmp='B'` (ids 4/5/7/8/9/10/15 — IVA Sujeto
  Exento/Consumidor Final/Sujeto No Categorizado/Proveedor del
  Exterior/Cliente del Exterior/IVA Liberado Ley 19.640/IVA No
  Alcanzado), **las 7 con `cmp_Clase: "B"` poblado** — confirma que el
  campo existe en la respuesta real de ARCA (no solo en el `.d.ts` del
  SDK) y que filtrar por `claseCmp` funciona como documentado. El fix de
  §12.3 (Commit A) queda validado contra runtime real, no solo contra el
  tipado del SDK.
- Auditoría R8 (rastro de cambios) sobre `PUT /:id/tax-profile` — hoy
  ese endpoint no llama `recordFieldChanges()`, a diferencia del camino
  de campos del cliente en el mismo archivo. §12.7 agrega a ese camino
  sin auditoría el campo que decide qué comprobante se emite; cerrar
  esto (agregar auditoría al endpoint) queda declarado como parte de
  14a, no de un bloque separado — ver alcance de implementación.
- **[N3, agregado ronda 4]** `BuyerSchema` (§12.8) como segunda puerta a
  la identidad fiscal, sin pasar por el catálogo de §12.7 — declarada,
  sin consumidor real hoy, no auditada en 14a. Revisarla es parte del
  bloque que decida si `input.buyer` explícito necesita su propia
  validación, no de 14a.
- **[N4, agregado ronda 4]** `taxIdType` sin catálogo cerrado del lado
  backend (`UpsertTaxProfileSchema`, texto libre) — asimetría con
  `iva_condicion_id`, que sí valida por pertenencia. Decisión de producto
  propia (¿cerrar también ese catálogo?), con su propio
  `AskUserQuestion` si se decide encarar — no resuelta acá.

### 12.10 Evidencia real de producción (22/09/2026) — responde al pedido del gate

Corridas de solo lectura contra los 2 tenants productivos reales (vía
Neon, sin decrypt de `db_url_encrypted` — se ubicaron por nombre de
branch: `tenant-hotel-los-alamos` en el proyecto `ancient-king-17098519`,
y la branch `production` del mismo proyecto resultó ser el tenant
`Demo`/`biz-demo-01`, no la plataforma — la plataforma vive en el
proyecto `morning-unit-50056927`).

**(1) Distribución de `tax_id_type` — responde si el fail-loud de §12.4
es seguro activar ya:**

| Tenant | `customer_tax_profiles` | `tax_id_type` encontrados |
|---|---|---|
| Demo (`biz-demo-01`) | 1 fila | `CUIT` (1) |
| Hotel los Alamos | 0 filas | — |

**Resultado: seguro.** El único valor real en producción hoy es `CUIT`,
que `resolveDocTipo()` ya reconoce — el fail-loud de §12.4 no bloquea a
ningún cliente existente al desplegarse. No hace falta backfill ni
migración previa para este punto puntual.

**(2) Credenciales/config fiscal — responde si hay certificado real
cargado en algún tenant:**

| Tenant | `business_profile.afip_cert_encrypted` | `afip_cuit` | `afip_sales_point` | `tax_condition` (texto libre) |
|---|---|---|---|---|
| Demo | cargado (`has_cert = true`) | `NULL` | `1` | `"Responsabel Inscripto"` |
| Hotel los Alamos | sin cargar | `NULL` | `NULL` | `NULL` |

**Dos hallazgos reales, no inferidos, que entran al alcance de 14a:**

- **Demo tiene certificado ARCA cargado pero `afip_cuit` es `NULL`.**
  Con el guard `AfipNotConfiguredError` ya vigente
  (`invoice.service.ts`, *"falta cargar el CUIT del negocio en Mi
  Negocio"*), este tenant probablemente **ya está bloqueado para emitir
  hoy**, antes de cualquier cambio de este bloque — no es una
  regresión que introduzca 14a, es el estado real que 14a hereda.
- **`business_profile.tax_condition = "Responsabel Inscripto"`** (falta
  la "l" de "Responsable") — **corregido (gate, ronda 3): esto es del
  EMISOR** (`business_profile`, lado Demo como negocio), no del
  receptor. Es una columna homónima pero DISTINTA de
  `customer_tax_profiles.tax_condition` (receptor, donde va
  `iva_condicion_id` de §12.6) — las dos tablas usan el mismo nombre de
  columna para conceptos del mismo tipo en lados opuestos del
  comprobante. `iva_condicion_id` **nunca va a corregir este typo** —
  vive en la tabla del receptor, este typo está en la del emisor, fuera
  de alcance de 14a (§12.9). Sirve igual como evidencia real de que el
  texto libre sin catálogo produce datos sucios — el mismo riesgo que
  §7/§12.6 señalan, del otro lado del comprobante. Se imprime en cada
  PDF hoy, en `emisor.condicionIva` — ver ubicación #3 de la matriz de
  impacto de §12.12 (**corregido, gate ronda 4, C1: decía "§12.9", la
  matriz vive en §12.12**).

**Certificado sí existe en un tenant real** (Demo) — la hipótesis [H]
de §0 se ejecutó contra ese certificado real (homologación) el
22/09/2026, gate pre-commit del Commit A — ver §12.9, ítem cerrado.

### 12.11 Decisiones finales del dueño (`AskUserQuestion`, ronda 2, 22/09/2026) — cierran el HOLD de la ronda 2 del gate

**(1) Cliente con condición real distinta de Consumidor Final,
`cbteTipo` fijo en B → se manda la condición real, no se bloquea
preventivamente.** Decisión textual del dueño: *"si no sabe facturar y
ARCA lo permite, por qué lo permite si el negocio no se da cuenta es
problema del negocio, no nuestro"* — rechaza las 3 opciones tal como
estaban planteadas (mandar/caer a CF/bloquear como elección nuestra) y
elige que **ARCA sea el árbitro real**, no un guard nuestro anticipando
el rechazo. Si ARCA rechaza la combinación, es un `AfipRequestRejectedError`
real (patrón ya vigente, `issue()`), no una `HTTP 400` nuestra antes de
intentar — consistente con el principio transversal ya declarado
("la app no le dice al cliente cómo trabajar").

**Consecuencia técnica real, no una decisión de negocio — hay que
declararla porque cambia lo que "mandar la condición real" puede hacer
hoy:** el único número que existe para mandar es el que resuelve
`iva_condicion_id` (§12.6, corregido). Con **cero perfiles con
`iva_condicion_id` poblado** (§12.10 — ninguna UI lo carga hoy), "mandar
la condición real" no tiene ningún dato real que mandar todavía más allá
de `CONSUMIDOR_FINAL`. La decisión (1) del dueño define la POLÍTICA
(mandar y dejar que ARCA decida); hace falta una superficie mínima para
que esa política tenga con qué operar — ver (3).

**(2) `taxIdType = 'OTRO'` → se saca del formulario.** Cambio en
`appfrontend-main`, `dashboard/clientes/[id]/page.tsx` (el `&lt;select&gt;`
de tipo de documento, `:546-555`) — mismo bloque que el fail-loud de
§12.4, para no activar un rechazo contra un valor que la propia UI
sigue ofreciendo.

**(3) Snapshot mínimo del PDF se adelanta a 14a — y eso exige la
superficie mínima que (1) necesitaba.** Para que el PDF imprima la
condición de IVA real (no vacío, hallazgo del gate en
`invoice-pdf.service.ts:95,116`) y para que la política de (1) tenga un
`iva_condicion_id` real que mandar, 14a incorpora:

- **Backend:** `iva_condicion_id` (§12.6) se puebla desde
  `getIvaReceptorTypes()` — la ruta ya existe
  (`GET /api/customers/padron/iva-receptor-types`, sin consumidor hoy,
  `NO_CONSUMER_ROUTES`) y ahora trae `cmpClase` (§12.3). Guardar
  `iva_condicion_id` en `PUT /:id/tax-profile` valida contra ese
  catálogo (§12.7, con la aclaración de qué `claseCmp` usa — factura B,
  el único tipo que 14a emite).
- **Frontend — decisión del dueño (ronda 3, `AskUserQuestion`): el
  `&lt;input&gt;` de texto libre de `tax_condition` SE REEMPLAZA por el
  selector, no conviven.** El formulario de perfil fiscal del cliente
  gana un selector de "Condición frente al IVA" poblado desde
  `getIvaReceptorTypes(claseCmp='B')` — es el único campo para cargar la
  condición del receptor desde 14a en adelante. **Consecuencia aceptada
  explícitamente:** un tenant sin certificado ARCA (Hotel los Alamos
  hoy, §12.10) se queda sin forma de registrar la condición de IVA de
  sus clientes hasta que consiga el certificado — el dueño evaluó esta
  contrapartida y la aceptó (P-B, ronda 3) en vez de mantener las dos
  vías. La columna `tax_condition` NO se retira del schema
  (compatibilidad con datos históricos, §12.6 sin cambios) — deja de
  tener un campo de UI que la escriba, no deja de existir.
  **Ubicación nueva (gate, ronda 4, N5), aclarada para que no se confunda
  con el input de arriba:** existe un SEGUNDO `&lt;input&gt;` de texto libre
  casi idéntico, en otra pantalla —
  `appfrontend/src/app/dashboard/mi-negocio/page.tsx` (estado `:134`,
  carga `:152`, submit `:181`, input `:248`, mismo label "Condición
  frente al IVA") — pero escribe `business_profile.tax_condition`, la
  columna del EMISOR (el typo real "Responsabel Inscripto" de §12.10),
  no `customer_tax_profiles.tax_condition` del receptor. **Este input
  SOBREVIVE, no se retira** — P-B fue una decisión sobre el perfil fiscal
  del CLIENTE, no sobre el del negocio, y §12.0/§12.9 ya dejan Factura A/C
  y el resto de la configuración del emisor fuera de 14a. Declarado acá
  explícitamente para que la homonimia de columnas (§12.10) no se
  confunda también del lado UI.
- **Autocompletado del padrón — decisión del dueño (ronda 3): nunca
  infiere el `id` del selector nuevo.** Cuando el negocio usa "Buscar en
  ARCA" (`applyTaxpayerLookup()`, `appfrontend-main`) y el padrón
  devuelve `MONOTRIBUTO`/`REGIMEN_GENERAL`, el selector de condición de
  IVA **queda vacío** — el negocio lo elige a mano del catálogo real.
  Mismo criterio que el resto del diseño: nunca mapear un vocabulario
  informal (`MONOTRIBUTO`/`REGIMEN_GENERAL`, un tercer vocabulario
  distinto de `tax_condition` texto libre y de `iva_condicion_id`
  numérico) a un id fiscal sin que el catálogo real lo confirme. Con el
  `&lt;input&gt;` de texto libre retirado (punto anterior), este
  autocompletado deja de tener a qué campo escribir su resultado de
  condición — se retira esa escritura puntual del formulario (el resto
  del autocompletado, razón social/domicilio, no cambia).
- **PDF — dónde se congela la `description` (gate, ronda 3: sin
  especificar, corregido acá).** `invoices` gana una columna nueva,
  `condicion_iva_receptor_desc VARCHAR(255) NULL` (`ALTER TABLE ...
  ADD COLUMN IF NOT EXISTS`, mismo patrón idempotente que el resto de
  `schema.sql`) — snapshot de la `description` que
  `getIvaReceptorTypes()` devolvió para el `iva_condicion_id` resuelto,
  congelado AL EMITIR (mismo criterio R9/§2.3 que el resto del
  documento). El PDF lee esta columna, **nunca** llama a
  `getIvaReceptorTypes()` en vivo (violaría la regla de §2.3 — "el
  generador del PDF no debe leer ningún maestro" — y además rompería la
  generación de comprobantes ya emitidos en un tenant que después pierde
  el certificado, caso real de Hotel los Alamos hoy). Si
  `iva_condicion_id` es `NULL` al emitir (cliente sin cargar el
  selector), la columna nueva queda `NULL` y el PDF mantiene el
  comportamiento actual (`'Consumidor Final'` si
  `condicionIvaReceptorId === 5`, vacío en cualquier otro caso — caso
  que ya no debería ocurrir en 14a, mismo argumento de antes).

**Ubicación nueva (gate, ronda 4, N2): `buildCreditNote()` es un tercer
write-site de la identidad del receptor, y copia `docTipo`/`docNro`/
`condicionIvaReceptorId` del comprobante original pero NO la `desc`
nueva.** `invoice.service.ts:1406-1408` copia los 3 campos del
`original` al armar la Nota de Crédito — correcto y deseado: una NC
hereda la identidad fiscal de la factura que corrige, nunca la
re-resuelve contra el perfil actual del cliente (que pudo cambiar entre
factura y NC). Pero esa copia no incluye `condicion_iva_receptor_desc`
(columna nueva de este punto), así que sin agregarla ahí, la Factura B
original imprime la condición real y su propia NC imprime vacío — mismo
PDF, mismo generador (`invoice-pdf.service.ts`), dato inconsistente entre
los dos documentos del mismo círculo. **Resolución:** `buildCreditNote()`
copia también `condicion_iva_receptor_desc` del `original`, mismo
criterio que los otros 3 campos — es snapshot heredado, no
re-resuelto.

### 12.12 Matriz de impacto — ubicaciones nuevas encontradas en rondas 3 a 7, resueltas

Dieciocho ubicaciones en total: 5 en la ronda 3 (#1-5), 6 en la ronda 4
(#6-11, prefijo N de esa ronda), 2 en la ronda 5 (#12-13, N8-N9), 3 en la
ronda 6 (#14-16) y 2 más en la ronda 7 (#17-18). Ninguna estaba en la
matriz anterior a su propia ronda. Cada una con su resolución:

1. **`appfrontend-main`, `applyTaxpayerLookup()` (segundo escritor de
   `taxCondition` en el mismo formulario)** — resuelto arriba
   (autocompletado nunca infiere el selector nuevo, y pierde su target
   de texto libre al retirarse el `&lt;input&gt;`).
2. **`padron.service.ts::mapTaxpayerDetails()` — tercer vocabulario
   (`MONOTRIBUTO`/`REGIMEN_GENERAL`)** — no se toca en 14a; sigue
   existiendo para lo que ya hace (autocompletar razón social/domicilio
   del emisor vía padrón), pero deja de alimentar cualquier campo de
   condición del receptor (mismo punto que #1).
3. **`invoice-pdf.service.ts` — `emisor.condicionIva` con el typo real
   de `business_profile.tax_condition` (§12.10)** — confirmado FUERA de
   alcance de 14a (lado emisor, no receptor) — declarado explícitamente
   acá para que quede anclado, no descubierto después.
4. **`invoice-pdf.service.ts` — `receptor.razonSocial = customer?.fullName`
   (lectura viva, no `legalName` fiscal del perfil)** — confirmado FUERA
   de alcance de 14a. Es el snapshot bilateral completo de §2.3
   (razón social + domicilio del receptor), ya diferido a 14b en §12.0 —
   14a solo adelanta la pieza de condición de IVA (§12.11(3)), no el
   resto del snapshot. Queda declarado como residuo activo: la primera
   Factura B a un receptor no-Consumidor-Final va a imprimir el nombre
   de display del cliente, no su razón social fiscal, hasta 14b.
5. **`NO_CONSUMER_ROUTES` (11.º artefacto manual del repo,
   `route-consumer-coverage.test.ts`)** — en cuanto el frontend consuma
   `GET /api/customers/padron/iva-receptor-types` (selector nuevo de
   §12.11(3)), la entrada de esa ruta queda stale. **Corregido (gate,
   ronda 4, N7): NO puede ser "el mismo commit"** — el fence vive en
   `app-main` (`route-consumer-coverage.test.ts`) y su consumidor nuevo
   en `appfrontend` (dos repos distintos, imposible en un solo commit).
   Orden elegido y declarado explícitamente en §12.13, no prometido como
   atómico.
6. **[N1] `afip-catalog.constants.test.ts:20-25` congelaba las 4 ramas
   del fallback de `resolveDocTipo()` por igual** — resuelto en §12.4:
   solo la rama de string no vacío no reconocido pasa a rechazo; las 3
   ramas de ausencia de dato (`null`/`undefined`/`''`) se mantienen.
7. **[N2] `buildCreditNote()` (`invoice.service.ts:1406-1408`) no copiaba
   `condicion_iva_receptor_desc` al derivar una Nota de Crédito B** —
   resuelto en §12.11(3): se agrega a la copia, mismo criterio que los
   otros 3 campos heredados del comprobante original.
8. **[N3] `BuyerSchema` (`facturacion.schemas.ts:15-19`) es una segunda
   puerta a la identidad fiscal, vía `POST /api/invoices`/
   `/consolidated`, que esquiva `resolveFiscalIdentity()` y el catálogo
   de §12.7 por completo** — declarada explícitamente en §12.8, **fuera
   de auditoría en 14a** (capacidad preexistente, sin consumidor real
   verificado hoy en `appfrontend`) — ver también §12.9.
9. **[N4] `taxIdType` no tiene catálogo cerrado del lado backend**
   (`UpsertTaxProfileSchema`, `src/clientes-finanzas/customers.routes.ts:119-133`,
   el campo `taxIdType` puntual en `:122` — **corregido, gate ronda 5: la
   cita anterior (`:119-121`) apuntaba a `legalName`/`taxId`, no al campo
   del que habla este punto** — texto libre sin validar contra ningún
   catálogo — asimetría con `iva_condicion_id`,
   que sí valida por pertenencia desde §12.7) — **no se resuelve en esta
   ronda**: es una decisión de producto propia (¿pasa `taxIdType` a
   catálogo cerrado también?), con su propio `AskUserQuestion` si se
   decide encarar. Declarada como pendiente explícita en §12.9, no
   descubierta después.
10. **[N5] Segundo `&lt;input&gt;` de texto libre, casi idéntico, en
    `mi-negocio/page.tsx`** — resuelto en §12.11(3): escribe
    `business_profile.tax_condition` (emisor), no la columna que P-B
    reemplaza (receptor) — sobrevive sin cambios.
11. **[N6] El "error de dominio nuevo" de §12.4 no tenía clase ni mapeo
    declarados, y 2 docblocks adicionales de `afip-catalog.constants.ts`
    quedaban desactualizados** — resuelto en §12.4: `UnsupportedTaxIdTypeError`
    (patrón `UnsupportedIvaRateError`), mapeada a 422 en
    `error.middleware.ts`, y los 2 docblocks (`:118-124` y `:136-145`)
    listados en §12.13 junto al ya declarado `:99-116`.
12. **[N8, ronda 5] La capa de persistencia de `condicion_iva_receptor_desc`
    no estaba nombrada** — §12.11(3) anclaba la tabla (`invoices`,
    `schema.sql:3101`) y un solo write-site derivado (N2), pero nunca la
    entidad ni el repositorio SQL que mueven la columna entre Postgres y
    el dominio. Resuelto: se listan en §12.13 los 2 archivos concretos —
    `invoice.entities.ts` (2 interfaces) y `sql.invoice.repository.ts`
    (tipo de fila, mapper, lista de columnas del INSERT, **la lista de
    placeholders posicionales `$N`, que hay que renumerar**, y el array
    de parámetros) — con sus líneas reales.
13. **[N9, ronda 5] El camino PRIMARIO de escritura de
    `condicionIvaReceptorDesc` no estaba definido, y colisionaba con N3**
    — §12.8 decía que `resolveFiscalIdentity()` resuelve "solo el
    `Buyer`" (interfaz cerrada de 3 campos, sin `desc`), y los 2 call
    sites reales que arman el create-input copian exactamente esos 3
    campos — ningún camino declarado para una Factura B NORMAL (no NC).
    Resuelto en §12.8: `resolveFiscalIdentity()` devuelve un tipo nuevo
    `FiscalIdentity { buyer: Buyer; condicionIvaReceptorDesc: string |
    null }` en vez de solo `Buyer`; los 2 call sites leen la `desc` del
    mismo resultado. El camino de `input.buyer` explícito (N3) escribe
    `NULL` — declarado, no una omisión (ese camino nunca pasa por
    `resolveFiscalIdentity()`, no tiene de dónde sacar una `desc` real).
14. **[ronda 6] `buildIvaBreakdown()` es un TERCER consumidor de
    `buyer`, y es el que arma el request SOAP real — sin anclar.** Los 2
    call sites de `resolveFiscalIdentity()`/`buyer` no son solo los 2
    que arman el create-input (#13) — el mismo `buyer` local también
    alimenta `this.buildIvaBreakdown(items, profile, buyer, concepto)`
    (`invoice.service.ts:628` y `:829`, firma `:974-979` con el
    parámetro `buyer: Buyer` en `:977`), que construye el objeto que
    viaja a ARCA: `DocTipo: buyer.docTipo` (`:1007`), `DocNro:
    Number(buyer.docNro)` (`:1008`), `CondicionIVAReceptorId:
    buyer.condicionIvaReceptorId` (`:1018`). **Resuelto — entrada
    revisada-sin-cambio, mismo criterio que `BuyerSchema` (#8):** los 2
    call sites pasan `identity.buyer` (no `identity`) a
    `buildIvaBreakdown()`, sin tocar su firma — el tipo `Buyer` sigue
    siendo exactamente los 3 campos que hoy viajan al SOAP de AFIP,
    nunca la `desc`. Listado en §12.13 como punto a verificar
    explícitamente en la implementación, no solo a inferir de §12.8.
15. **[ronda 6] El radio de fixtures de N8 (#12) estaba incompleto —
    faltaban 4 archivos.** §12.13 solo nombraba 3 archivos de test.
    Agregar `condicionIvaReceptorDesc` no-opcional a `Invoice`/
    `CreateInvoiceInput` rompe: `cancellation-refund.service.test.ts:170`
    (`makeInvoice`, literal completo `:172-180`),
    `customer-account.service.test.ts:246` **y** `:365` (dos helpers
    `makeInvoice` distintos, mismo archivo), y
    `credit-note-lines.integration.test.ts:118-126` (literal pasado
    directo a `repo.createWithClient()`). **Corregido (gate, ronda 7):
    `tsc` NO detecta el radio completo — no usarlo como criterio único.**
    `cancel-reservation-with-credit-note.service.test.ts:74`
    (`makeInvoice`) usa `{ ...overrides } as Invoice`, un type assertion
    sobre un literal parcial — **no rompe con un campo requerido nuevo**
    (TS no exige que el literal tenga todos los campos cuando media un
    `as`). Se actualiza igual, por consistencia con el resto de los
    fixtures del bloque, pero es una entrada revisada-sin-cambio de
    `tsc`, no una que `tsc` hubiera forzado. Misma entrada
    revisada-sin-cambio para `invoices.routes.test.ts:92`, fixture
    `INVOICE_ROW` — NO tipado (snake_case, alimenta un fake db que
    devuelve `unknown[]`), tampoco rompe `tsc`, así que sin decisión
    explícita quedaría produciendo `condicionIvaReceptorDesc: undefined`
    en silencio a través de la ruta — se decide acá: se agrega igual,
    mismo criterio que el resto, aunque no sea estrictamente necesario
    para que compile. **Regla explícita para §12.13: el radio de
    fixtures se verifica por enumeración de todo literal que hoy provee
    `condicionIvaReceptorId` requerido, no por lo que `tsc --noEmit`
    marque en rojo** — un `as`/type assertion, o un fixture sin tipar,
    quedan afuera de esa señal aunque estén dentro del radio real.
16. **[ronda 6] Toda la capa de persistencia backend de
    `iva_condicion_id` (§12.6) estaba sin nombrar — mismo tipo de hueco
    que N8, en la OTRA columna nueva de este bloque.** §12.13 nombraba
    los espejos del frontend (`appfrontend/src/lib/clientes/types.ts`)
    pero no los originales backend de esas mismas 2 interfaces. Resuelto
    — se listan en §12.13: `customer-tax-profile.entities.ts`
    (`CustomerTaxProfile` `:26-38`, `UpsertCustomerTaxProfileInput`
    `:40-46`, ambas ganan `ivaCondicionId: number | null`),
    `customer-tax-profile.repository.ts:8-12` (`ICustomerTaxProfileRepository`,
    sin cambio de firma — el campo viaja dentro de los tipos que ya usa),
    y `sql.customer-tax-profile.repository.ts` — 4 puntos: `ProfileRow`
    (`:23-39`), `SELECT_SQL` (`:41-49`, **lista de columnas explícita,
    no `SELECT *`** — omitir `ctp.iva_condicion_id` acá da `undefined`
    en runtime SIN error de tipos), `rowToProfile()` (`:51-74`), y
    `upsert()` (`:87-112`, columnas del INSERT `:100`, `VALUES
    ($1..$7, TRUE)` `:101`, `ON CONFLICT (customer_id) DO UPDATE SET`
    `:102-107`, y el array de parámetros `:108`). **Corregido (gate,
    ronda 7): el riesgo posicional del `ON CONFLICT` estaba
    sobreestimado.** Ese bloque asigna por `EXCLUDED.&lt;columna&gt;`
    nombrado (`legal_name = EXCLUDED.legal_name`, etc.), no por posición
    — agregar `iva_condicion_id = EXCLUDED.iva_condicion_id` ahí no
    puede desfasarse. El riesgo posicional real (mismo tipo que N8,
    pero no duplicado) vive únicamente en `VALUES ($1..$7, TRUE)`
    (`:101`) y su array de parámetros (`:108`) — ahí sí hay que
    renumerar en orden. Fixture de test:
    `sql.customer-tax-profile.repository.test.ts`, `PROFILE_ROW`
    (`:18`, usos en `:34`, `:47`, `:61`, `:88`). Backend de
    `customers.routes.ts`: `UpsertTaxProfileSchema` (`:119-124`) gana
    `ivaCondicionId`, sitio de parseo/construcción del input en
    `:371-386`, más `customers.routes.test.ts`. **Schema — corregido
    (gate, ronda 7): `schema.sql:411-421` es el `CREATE TABLE IF NOT
    EXISTS customer_tax_profiles`, no el lugar del `ALTER`** — mismo
    patrón que el resto del archivo (ver `:3154`, `:3186`, `:3210` para
    3 ejemplos reales de `ALTER TABLE invoices ADD COLUMN IF NOT
    EXISTS`, cada uno bastante después de su propio `CREATE TABLE`
    (`:3101`), gateados por su propio comentario de versión — no dentro
    de la definición de la tabla): el `ALTER TABLE customer_tax_profiles
    ADD COLUMN
    IF NOT EXISTS iva_condicion_id INTEGER NULL` va en ese bloque de
    `ALTER`s, con su propia referencia de versión — `:411-421` queda
    como el anchor de la tabla base, no del cambio. Versión de schema:
    `src/platform/tenant-db.setup.ts` necesita un bloque de comentario
    versionado nuevo (mismo formato que los precedentes de esta misma
    tabla — **corregido, gate ronda 7: v27 es `:311-313`, no `:311-312`;
    v35 es `:354-356`, no `:354-357` (`:357` ya es el comienzo de v36)**
    — esos dos son el patrón a seguir, no el lugar del cambio; el número
    de versión real hoy sería **v61**, `CURRENT_SCHEMA_VERSION = 60`
    en `tenant-db.setup.ts:540` — se re-verifica contra el valor
    vigente al momento de implementar, no se fija acá).
17. **[ronda 7] `appfrontend/src/app/dashboard/clientes/[id]/page.tsx` —
    el archivo donde vive el selector de P-B, el cambio más visible de
    14a, estaba ausente de §12.13 y 5 de sus 6 sitios sin anclar en
    ningún lado.** §12.11(2) ancla un solo sitio (`:546-555`, el
    `&lt;select&gt;` de `taxIdType`). Resuelto — 6 sitios reales,
    verificados:
    - Estado inicial de `taxForm` (`:59-62`, `taxCondition` en `:60`) —
      gana `ivaCondicionId: number | null`.
    - `resetTaxForm()` (`:76-89`, `taxCondition` en `:81`) — hidrata el
      campo nuevo desde el perfil cargado.
    - Payload de `upsert` (`:148-152`) — manda `ivaCondicionId`.
    - `applyTaxpayerLookup()` (`:230-236`, escritura de `taxCondition`
      en `:236`) — **se retira esa escritura** (P-A) — el resto del
      autocompletado (razón social/domicilio) no cambia.
    - El `&lt;input&gt;` de texto libre (**corregido, gate ronda 7: el
      sitio real es `:569-574`, no `:563-568` — ese rango es el input
      de "Razón social / nombre completo", un campo distinto**) — se
      REEMPLAZA por el selector nuevo (P-B).
    - Carga del catálogo — sitio nuevo, no existe hoy: estado +
      `padronApi.getIvaReceptorTypes('B')` + manejo de `loading`/`error`
      para el tenant sin certificado (hueco aceptado, P-B).
18. **[ronda 7] `src/facturacion/invoice-pdf.service.ts` — anclado en
    §12.11(3) pero ausente de §12.13.** §12.13 listaba
    `invoice-pdf.service.test.ts` (fixtures) pero no el servicio mismo,
    que es el consumidor que justifica la columna entera (§12.11(3):
    "el PDF lee esta columna"). Sin tocarlo, la columna se agrega, se
    puebla al emitir, se copia a la NC — y el PDF sigue imprimiendo
    `''` (`:116`, `condicionIva: isConsumidorFinal ? 'Consumidor Final'
    : ''`, junto a `isConsumidorFinal` en `:95`), sin efecto observable.
    Resuelto: `:116` pasa a leer `invoice.condicionIvaReceptorDesc` (con
    fallback a `'Consumidor Final'` si `isConsumidorFinal`, vacío solo
    si la columna nueva es `NULL` y no es Consumidor Final).

### 12.13 Artefactos manuales a tocar en el commit de código (lista explícita, pedida por el gate)

**Alcance de esta lista, aclarado (gate, ronda 6 — corrige un hueco
propio de la sección, no una ubicación de código):** hasta la ronda 5
esta lista mezclaba "artefactos de sync" (RBAC, rutas, `NO_CONSUMER_ROUTES`)
con código de dominio (`invoice.entities.ts`, `sql.invoice.repository.ts`)
sin decirlo — el fix de `cmpClase` (§12.3, diseñado desde la ronda 1)
nunca había entrado a la lista pese a ser código real a tocar. **Desde
esta ronda, §12.13 es el inventario COMPLETO de archivos a tocar en 14a
como bloque — sync y dominio por igual —, no solo los de sync.** Ninguno
de estos es RBAC nuevo ni ruta nueva (§12.9 ya lo confirma):

**Split en commits (gate pre-commit, post-aprobación de ronda 8, no
escrito hasta acá — corrección de alcance de esta sección, mismo
criterio que la de ronda 6 de arriba):** 14a se ejecuta como **varios
commits chicos y reversibles**, no uno solo — "un bloque chico y
reversible por vez" (regla de trabajo, `CLAUDE.md` raíz) aplicada
dentro de este bloque. El gate escribió el split completo (Commits A-F,
`app-main` + `appfrontend`, con el orden de dependencia entre ellos —
schema antes que código que lo lee, `cmpClase` antes que el selector
del frontend, selector del frontend antes que `NO_CONSUMER_ROUTES`) al
cerrar la ronda 8. Cada commit se implementa, se verifica (`tsc`
limpio como mínimo; los que tocan `sql.*.repository.ts` necesitan
además integración contra Postgres real, no alcanza con `tsc`) y pasa
su propio gate pre-commit antes de commitear — no se re-abre la ronda
de diseño por eso, es ejecución del mismo diseño ya cerrado. §12.13
sigue siendo el inventario completo de ARCHIVOS; qué archivo va en qué
commit es responsabilidad del gate pre-commit de cada uno, no de esta
sección.

- `NO_CONSUMER_ROUTES` (`src/tests/architecture/route-consumer-coverage.test.ts`)
  — sacar `/api/customers/padron/iva-receptor-types` de la allowlist,
  ahora que el frontend la consume. **Orden cross-repo (gate, ronda 4,
  N7 — corregido: NO es "el mismo commit", son 2 repos):** primero el
  código del selector en `appfrontend` (§12.11(3)), después la entrada de
  `NO_CONSUMER_ROUTES` en `app-main`. Se elige este orden y no el inverso
  porque el fence usa `describe.skipIf` y **no corre en la CI de
  `app-main`** (nunca clona `appfrontend`, `CLAUDE.md` de este repo,
  sección "Consumo") — la ventana entre los dos commits solo se ve roja
  en una sesión con los dos repos clonados al lado (como esta), nunca en
  CI. En el orden inverso (allowlist primero) esa misma ventana se vería
  roja también en cualquier sesión así, sin motivo: "huérfano sin
  declarar" antes de que el consumidor exista de verdad.
- Los 2 tests "D-25" que congelan "siempre Consumidor Final" en
  `invoice.service.test.ts` — **corregido (gate, ronda 4, C2): solo uno
  de los dos es un `describe`** (`describe('D-25', ...)`, hoy en
  `:613`, con un único `it` adentro en `:621`); el segundo (`:2733`) es
  un `it(...)` suelto, sin `describe` "D-25" a su alrededor. Cita por
  nombre del primero y por línea del segundo — ambos se reescriben para
  el comportamiento nuevo (perfil con `iva_condicion_id` → condición
  real; perfil sin perfil fiscal → sigue Consumidor Final).
- `afip-catalog.constants.test.ts:20-25` (N1, §12.4/§12.12#6) — 3 de las
  4 aserciones se mantienen (`null`/`undefined`/`''` → Consumidor Final);
  la de `'pasaporte'` pasa a `expect(() => ...).toThrow(UnsupportedTaxIdTypeError)`.
- `src/domain/errors.ts` (N6, §12.4/§12.12#11) — clase nueva
  `UnsupportedTaxIdTypeError extends DomainError`, junto a
  `UnsupportedIvaRateError` (`:566-573`), mismo patrón.
- `src/api/middleware/error.middleware.ts` (N6) — `case 'UNSUPPORTED_TAX_ID_TYPE':`
  agregado al grupo 422 (`:199-210`, junto a `'UNSUPPORTED_IVA_RATE'` en `:202`).
- 3 docblocks de `afip-catalog.constants.ts` sobre `resolveDocTipo()`/
  `docTipoLabel()` — **corregido (gate, ronda 4, C3): eran 3, no 1.**
  `:99-116` (dice "D-25 -- sin consumidor de producción hoy"), `:118-124`
  (docblock propio de `resolveDocTipo()`, sin distinguir ausencia de dato
  vs. dato no reconocido) y `:136-145` (docblock de `docTipoLabel()`,
  "Inverso de `resolveDocTipo()`" — deja de ser inverso total). Los 3 se
  actualizan en el mismo commit que conecta el caller real.
- `invoice.service.ts:1406-1408` (`buildCreditNote()`, N2, §12.11(3)/
  §12.12#7) — agregar `condicionIvaReceptorDesc` a la copia de campos del
  comprobante original.
- `src/api/schemas/facturacion.schemas.ts:15-19` (`BuyerSchema`, N3,
  §12.8/§12.12#8) — **sin cambio de código en 14a**, solo se declara en
  el diseño (§12.8/§12.9) — nada que tocar acá, listado para que quede
  claro que se revisó y se decidió no tocar, no que se pasó por alto.
- `src/facturacion/invoice.entities.ts` (N8, §12.12#12) — la interfaz
  `Invoice` gana `condicionIvaReceptorDesc: string | null` (junto a
  `condicionIvaReceptorId`, `:63`) y el tipo de create-input gana el
  mismo campo (junto a `condicionIvaReceptorId`, `:144`).
- `src/facturacion/sql.invoice.repository.ts` (N8, §12.12#12) — 4
  puntos, todos en el mismo archivo: `InvoiceRow` gana
  `condicion_iva_receptor_desc: string | null` (junto a
  `condicion_iva_receptor_id`, `:24`); el mapper fila→entidad la
  traduce (junto a `condicionIvaReceptorId: row.condicion_iva_receptor_id`,
  `:59`); el INSERT (`:1307-1320`) gana la columna en la lista
  (`:1309-1310`) **y renumera los placeholders posicionales** — hoy
  `$1`...`$19`, `'PENDING'`, `$20` (`:1311`) — insertar un parámetro
  nuevo corre todos los `$N` siguientes; el array de parámetros
  (`:1313-1320`) gana la entrada en la misma posición. Riesgo señalado
  por el gate (ronda 5): un desfasaje acá es silenciosamente
  type-correcto (ambos extremos son `string`/JSON) y escribiría el
  payload de `afip_request` en la columna equivocada — solo un test de
  integración contra Postgres real lo detecta, `tsc` no.
- `src/facturacion/invoice.service.test.ts`,
  `src/facturacion/sql.invoice.repository.test.ts`,
  `src/facturacion/invoice-pdf.service.test.ts` (N8, radio de la
  columna nueva) — sus fixtures construyen el tipo de create-input; se
  actualizan junto con N8, no es una lista aparte. **Por qué los ~50
  `INSERT INTO invoices` crudos de los tests de integración quedan
  AFUERA de este radio (gate, ronda 7 — razón antes implícita, ahora
  escrita; redacción acotada en ronda 8):** toda lectura de
  `sql.invoice.repository.ts` **tipada a `InvoiceRow`** usa `SELECT *`/
  `i.*` (`:113`, `:119`, `:127`, `:256`, `:281`, `:289`) — nunca una
  lista explícita de columnas como sí tiene
  `sql.customer-tax-profile.repository.ts` (§12.12#16). (Sí hay listas
  explícitas de columnas en el mismo archivo — `:100`, `:104`,
  `:306-309` — pero proyectan a otras interfaces angostas, no a
  `InvoiceRow`, así que no aplican acá.) Con la columna nueva
  `VARCHAR(255) NULL`, un `INSERT` crudo que no la nombra la deja `NULL`
  sin error, mismo comportamiento que "cliente sin perfil fiscal" ya
  declarado en §12.8/§12.11(3). No hace falta tocar esos ~50 INSERTs.
- **[residuo, ronda 8]** `appfrontend/src/lib/facturacion/types.ts::Invoice`
  (`:13-29`) — entrada revisada-sin-cambio, mismo criterio que #8/#14:
  ya es un subconjunto deliberado del `Invoice` del backend (omite
  `docTipo`/`docNro`/`condicionIvaReceptorId`/`moneda`/`impNeto`/
  `impIva` — solo lo que las pantallas actuales necesitan). Por eso
  `condicionIvaReceptorDesc` **no** necesita espejo acá y ninguna
  pantalla existente rompe. Se declara para no reproducir el drift de
  espejos cross-repo ya conocido en este repo (`ROLES-CATALOG-DRIFT-001`,
  la nota de `AccountsReceivableStatus` en `lib/finanzas/types.ts:37-40`).
- `src/facturacion/invoice.service.ts` (N9, §12.8/§12.12#13) —
  `resolveFiscalIdentity()` devuelve `FiscalIdentity { buyer: Buyer;
  condicionIvaReceptorDesc: string | null }` en vez de `Buyer`; los 2
  call sites que hoy copian `buyer.docTipo`/`buyer.docNro`/
  `buyer.condicionIvaReceptorId` (`:721-723`, `:934-936`) agregan
  `condicionIvaReceptorDesc: identity.condicionIvaReceptorDesc` a la
  misma construcción del create-input.
- `appfrontend/src/lib/clientes/types.ts` — `CustomerTaxProfile`
  (`:128-138`, **corregido gate ronda 6: cerraba en `:138`, no `:137`**)
  y `UpsertCustomerTaxProfileInput` (`:140-146`) ganan
  `ivaCondicionId: number | null` (espejo de `iva_condicion_id`,
  §12.6/§12.11(3)) — mismo criterio que el resto del tipo, ya usa
  `taxCondition` como campo hermano.
- `appfrontend/src/lib/clientes/api.ts` — `padronApi` (`:97-102`,
  **corregido gate ronda 6: `:96` es el comentario, el objeto arranca en
  `:97`**) gana un método nuevo, `getIvaReceptorTypes(claseCmp?: string)`,
  que pega a `GET /api/customers/padron/iva-receptor-types` (mismo
  patrón que `lookupByCuit`/`lookupByDni`) — es el consumidor real que
  hace stale a `NO_CONSUMER_ROUTES` (#5 de la matriz, N7).
- **[ronda 6, #14]** `src/facturacion/invoice.service.ts` — los 2 call
  sites de `buildIvaBreakdown(items/allItems, profile, buyer, concepto)`
  (`:628`, `:829`) pasan `identity.buyer`, no `identity` — la firma
  (`:974-979`, parámetro `buyer: Buyer` en `:977`) y el objeto SOAP que
  arma (`DocTipo` `:1007`, `DocNro` `:1008`, `CondicionIVAReceptorId`
  `:1018`) quedan sin cambio de forma. Entrada revisada-sin-cambio,
  mismo criterio que `BuyerSchema` — se verifica explícitamente al
  implementar, no se infiere de §12.8/§12.9.
- **[ronda 6, #15]** 3 fixtures adicionales de `Invoice`/`CreateInvoiceInput`
  que SÍ rompen con `tsc` (radio de N8, además de los 3 ya listados
  arriba): `cancellation-refund.service.test.ts:170` (literal
  `:172-180`), `customer-account.service.test.ts:246` y `:365` (dos
  helpers `makeInvoice`). Dos entradas revisadas-sin-cambio que NO
  rompen `tsc` pero se actualizan igual, por consistencia (**corregido,
  gate ronda 7: `tsc` no es el criterio del radio completo, ver §12.12#15**):
  `cancel-reservation-with-credit-note.service.test.ts:74` (`{ ...overrides
  } as Invoice` — el type assertion no exige todos los campos) e
  `invoices.routes.test.ts:92` (`INVOICE_ROW`, fixture no tipada — no
  rompe `tsc`, se actualiza igual por consistencia, decisión explícita
  para no dejar `condicionIvaReceptorDesc: undefined` fluyendo en
  silencio por esa
  ruta).
- **[ronda 6, #16]** Capa de persistencia backend de `iva_condicion_id`
  (§12.6), sin nombrar hasta esta ronda — espejo backend de las 2
  interfaces de `appfrontend/src/lib/clientes/types.ts` de arriba:
  `src/clientes-finanzas/customer-tax-profile.entities.ts`
  (`CustomerTaxProfile` `:26-38`, `UpsertCustomerTaxProfileInput`
  `:40-46`); `src/clientes-finanzas/customer-tax-profile.repository.ts:8-12`
  (`ICustomerTaxProfileRepository`, sin cambio de firma);
  `src/clientes-finanzas/sql.customer-tax-profile.repository.ts` — 4
  puntos: `ProfileRow` (`:23-39`), `SELECT_SQL` (`:41-49`, **lista
  explícita de columnas, no `SELECT *`** — omitir la columna acá da
  `undefined` en runtime sin error de tipos), `rowToProfile()`
  (`:51-74`), `upsert()` (`:87-112` — columnas del INSERT `:100`,
  `VALUES` `:101`, `ON CONFLICT ... DO UPDATE SET` `:102-107`
  (asigna por `EXCLUDED.&lt;columna&gt;` nombrado — **no** posicional,
  el riesgo de desfasaje real vive solo en `VALUES`/`:101` y el array
  de parámetros `:108`, corregido gate ronda 7 — antes decía "duplicado",
  sobreestimado));
  `sql.customer-tax-profile.repository.test.ts` (`PROFILE_ROW`, `:18`,
  usos en `:34`, `:47`, `:61`, `:88`); `customers.routes.ts` —
  `UpsertTaxProfileSchema` (`:119-124`) gana `ivaCondicionId` (**opcional**
  en TS, §12.6), sitio de parseo/construcción `:371-386`, más
  `customers.routes.test.ts`. Schema: el `ALTER TABLE
  customer_tax_profiles ADD COLUMN IF NOT EXISTS iva_condicion_id
  INTEGER NULL` va en el bloque de `ALTER`s del archivo, **no** dentro
  de `:411-421` (**corregido, gate ronda 7: esa es la `CREATE TABLE`,
  no el lugar del `ALTER`** — mismo patrón que `:3154`/`:3186`/`:3210`
  para `invoices`). Versión: bloque de comentario nuevo en
  `src/platform/tenant-db.setup.ts`, mismo patrón que los precedentes
  de esta tabla (**corregido, gate ronda 7:** v27 `:311-313`, no
  `:311-312`; v35 `:354-356`, no `:354-357` — sería **v61**,
  `CURRENT_SCHEMA_VERSION = 60` en `:540`, re-verificar contra el valor
  vigente al momento de implementar).
- **[Commit A, IMPLEMENTADO]** 3 archivos del fix de `cmpClase` (§12.3,
  ya diseñado en ronda 1, nunca agregado a esta lista — **corrección de
  alcance de §12.13 misma, ronda 6:** de acá en más esta lista es el
  inventario COMPLETO de archivos a tocar en 14a, no solo los de sync):
  `src/facturacion/padron.service.ts` (`IvaReceptorTypeOption` ahora
  `:107-112` — cita post-implementación, gate pre-commit Commit A;
  antes de este commit era `:107-110` — y `getIvaReceptorTypes()` ahora
  `:154-161`, antes `:153-159`, agregó `cmpClase: string`),
  `src/facturacion/afip-billing.port.ts` (segunda declaración de
  `IvaReceptorTypeOption`, mismo campo nuevo), y
  `src/facturacion/arca-sdk-billing.adapter.ts:133` (misma proyección
  lossy, mismo fix — línea sin cambio). Tests actualizados:
  `padron.service.test.ts` (aserción de
  `'mapea id/desc del catálogo oficial de ARCA'`) y
  `arca-sdk-billing.adapter.test.ts`. Verificado: `tsc --noEmit` limpio,
  suite completa 2504/2504 verde, `lint`/`lint:arch` limpios — gate
  pre-commit aprobado con condiciones (commitear docs primero, código
  después, sin `--amend`). **Verificación de runtime real, cerrada el
  mismo día (ver §12.9):** corrida contra ARCA homologación (certificado
  del tenant Demo) confirmó `cmp_Clase` poblado en las 7 opciones que
  devuelve `claseCmp='B'` — la hipótesis [H] de §0 queda cerrada, no solo
  el tipado del SDK.
- **[ronda 7, #17]** `appfrontend/src/app/dashboard/clientes/[id]/page.tsx`
  — 6 sitios (detalle completo en §12.12#17): estado inicial de
  `taxForm` (`:59-62`), `resetTaxForm()` (`:76-89`), payload de
  `upsert` (`:148-152`), `applyTaxpayerLookup()` (retira la escritura,
  `:230-236`), reemplazo del `&lt;input&gt;` de texto libre por el
  selector nuevo (`:569-574`), y la carga del catálogo (sitio nuevo).
- **[ronda 7, #18]** `src/facturacion/invoice-pdf.service.ts:116` —
  lee `invoice.condicionIvaReceptorDesc` en vez de imprimir `''` para
  cualquier receptor no-Consumidor-Final (detalle en §12.12#18).
- `docs/inventario-rutas.md` — sin cambios (ninguna ruta nueva, ninguna
  retirada — solo un consumidor nuevo de una ruta ya existente).
- `docs/rbac-matriz-endpoints.md` / `EXPECTED_AUTHORIZE_CALL_SITES` —
  sin cambios, confirmado en la ronda 3 (ningún `authorize()` nuevo, los
  3 endpoints tocados ya exigen `MANAGEMENT` + `requireModule(FACTURACION)`).

---

## Anclado en

**Re-anclado (gate, ronda 4, C4): las líneas de abajo databan del
01/09/2026 (versión preliminar de este documento) y varias ya no
correspondían al código real — `SCHEMA-ANCHOR-DRIFT-001` (declarar el
drift en vez de recomputar números que van a volver a driftear).
Corregidas contra el árbol al 22/09/2026; las de §12 (Wave 14) tienen su
propia cita, por nombre o línea, dentro de cada subsección — esta lista
es solo para el resto del documento (§0-§11).**

- `src/facturacion/afip-catalog.constants.ts` — `resolveDocTipo()` L125-133,
  `docTipoLabel()` L146-154 (líneas reales al 22/09/2026 — ver también
  §12.4/§12.13 para los docblocks D-25/propio/inverso, citados por nombre)
- `src/facturacion/invoice.service.ts` — los 2 call sites de
  `input.buyer ?? CONSUMIDOR_FINAL` (`:621`, `:817`, §12.8) y
  `buildCreditNote()` (`:1406-1408`, §12.11(3)/§12.12#7) — cita por
  nombre desde §12, no por línea de este bloque viejo
- `src/facturacion/invoice-pdf.service.ts` — **corregidas: L79/L81/L97/L99
  no correspondían.** Reales: `emisorCuit` L86, `isConsumidorFinal` L95,
  `emisor.condicionIva` L109 (**corregido, gate ronda 5: L108 es
  `domicilioComercial`, no este campo**), `receptor.razonSocial` L115,
  `receptor.condicionIva` L116 (§12.11(3)/§12.12#3-4)
- `src/facturacion/padron.service.ts` — `getIvaReceptorTypes()` L153-159
  (proyección lossy, §12.3), `IvaReceptorTypeOption` L107-110
- `src/domain/business-profile.entities.ts` — L53-73 (sin re-verificar en
  esta ronda — no tocado por ninguna corrección N1-N7/C1-C5)
- `src/clientes-finanzas/customer-tax-profile.entities.ts` — L33-34
  (`tax_condition`, sin re-verificar en esta ronda)
- `src/domain/errors.ts` — **corregida: L456 no correspondía.** Reales:
  `AfipNotConfiguredError` L518, `AfipRequestRejectedError` L540,
  `AfipPadronUnavailableError` L554, `UnsupportedIvaRateError` L566-573
  (patrón para `UnsupportedTaxIdTypeError`, §12.4/§12.13, N6)
- `src/db/schema.sql` — **corregidas: L394-404/L2483/L2658 no
  correspondían a este diseño** (son `customer_addresses`, un CHECK de
  `financial_transactions`, y `accounts_receivable.reversed_reason`
  respectivamente — de otro bloque). Reales: `customer_tax_profiles`
  L409-421, `invoices` L3101 (§12.11(3), gana `condicion_iva_receptor_desc`)
- `src/api/schemas/facturacion.schemas.ts` — `BuyerSchema` L15-19 (§12.8,
  N3, agregada en esta ronda)
- `src/api/middleware/error.middleware.ts` — grupo 422 L199-210 (§12.4,
  N6, agregada en esta ronda)
- `docs/criterios-datos.md` — L25, L199
- `docs/diseno-factura-borrador-2026-08-31.md` — §18, §25
