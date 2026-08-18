# Referencia externa — AFIP WSFEv1 (manual del desarrollador)

> Documento de referencia, no de implementación. Transcripción completa
> del manual oficial de AFIP **"Facturación Electrónica — RG 2485 –
> Proyecto FE v2.10 — Manuales para el desarrollador"** (AFIP-SDG SIT,
> revisión correspondiente al 09 de Agosto de 2017, 131 páginas), para
> tenerlo a mano cuando se aborde la implementación de facturación
> electrónica (ver `roadmap-pms-multirubro.md`, "Factura Electrónica
> A/B/T (AFIP)" — hoy ❌, sin arrancar). Mismo criterio que
> `docs/referencia-qloapps.md`: nombrar la decisión/spec ya validada
> antes de construir algo propio, no una implementación en sí.

**PDF fuente (no forma parte de este repo):**
`C:\Users\Usuario\Downloads\arcasdk-main\arcasdk-main\manual_desarrollador_COMPG_v2_10.pdf`

**Antes de implementar nada de esto a mano:** en esa misma carpeta
(`arcasdk-main/arcasdk-main`) hay un SDK open-source de Node/TypeScript ya
armado para los web services de AFIP (tiene su propio `docs/` con
`basic-use.md`, `services/`, `credential_management.md`, etc.). Es el
vehículo de implementación más probable — revisar esa documentación
primero, antes de escribir un cliente SOAP propio contra lo que sigue acá
abajo.

---

## 1. Introducción

### 1.1 Objetivo

Este documento está dirigido a quienes tengan que desarrollar el software
cliente consumidor de los WebServices correspondientes al servicio de
Facturación Electrónica - RG 2485 v2.

### 1.2 Alcance

Brinda las especificaciones técnicas para desarrollar el cliente de
WebServices para usar el WSFEv1. Debe complementarse con los documentos
relativos a "Servicio de Autenticación y Autorización y Establecimiento
del canal de comunicación" (WSAA) y las Resoluciones Generales
involucradas.

### 1.3 Autenticación (WSAA)

Para utilizar cualquiera de los métodos de este WS hace falta un **Ticket
de Acceso** provisto por el WS de Autenticación y Autorización (**WSAA**),
que es un servicio SEPARADO de WSFEv1.

- Para consumir WSAA hace falta antes un **certificado digital** obtenido
  desde clave fiscal, asociado al WS de negocio **"Facturación
  Electrónica"**.
- Al pedir el Ticket de Acceso, el tag `service` debe ir con el valor
  **`"wsfe"`**.
- El ticket dura **12 horas**.
- Documentación completa: `www.afip.gob.ar/ws`.

El ticket resultante entrega un **Token** y un **Sign** — ambos se envían
en CADA llamada a WSFEv1 dentro del bloque `<Auth>` (ver 4.1.2 para la
forma exacta), junto con el **CUIT** del contribuyente representado.

### 1.4 Tratamiento de errores en el WS

Todos los servicios devuelven errores con la misma estructura:

```xml
<Errors>
   <Err>
      <Code>int</Code>
      <Msg>string</Msg>
   </Err>
   <Err>
      <Code>int</Code>
      <Msg>string</Msg>
   </Err>
</Errors>
```

| Campo | Detalle | Obligatorio |
|---|---|---|
| `Errors` | Array de objeto `Err`. Información correspondiente a errores | N |
| `Code` | Código de error | S |
| `Msg` | Mensaje descriptivo del error | S |

Para errores internos de infraestructura, la misma estructura `Errors` se
usa con estos códigos:

| Código de error | Causa |
|---|---|
| 500 | Error interno de aplicación |
| 501 | Error interno de base de datos |
| 502 | Error interno de base de datos - Autorizador CAE / Régimen CAEA – Transacción Activa |
| 600 | No se corresponden token y firma. Usuario no autorizado a realizar esta operación |
| 601 | CUIT representada no incluida en token |
| 602 | No existen datos en nuestros registros |

### 1.5 Tratamiento de eventos

Estructura paralela a `Errors`, para mensajes informativos (no son
errores que bloqueen la operación):

```xml
<Events>
   <Evt>
      <Code>int</Code>
      <Msg>string</Msg>
   </Evt>
   <Evt>
      <Code>int</Code>
      <Msg>string</Msg>
   </Evt>
</Events>
```

| Campo | Detalle | Obligatorio |
|---|---|---|
| `Events` | Array de objeto `Evt`. Información correspondiente al mensaje | N |
| `Code` | Código de evento | S |
| `Msg` | Detalla el evento que se desea comunicar | S |

### 1.6 Dirección URL

| Ambiente | Servicio | WSDL |
|---|---|---|
| Homologación | `https://wswhomo.afip.gov.ar/wsfev1/service.asmx` | `https://wswhomo.afip.gov.ar/wsfev1/service.asmx?WSDL` |
| Producción | `https://servicios1.afip.gov.ar/wsfev1/service.asmx` | `https://servicios1.afip.gov.ar/wsfev1/service.asmx?WSDL` |

### 1.7 Canales de Atención

- Homologación — certificados y accesos: `http://www.afip.gob.ar/ws/`
- Homologación — aspectos funcionales del WS: `wsfev1@afip.gov.ar`
- Producción: `sri@afip.gov.ar`
- Normativa: `facturaelectronica@afip.gov.ar`

### 1.8 Sitios de Consulta

- Biblioteca Electrónica — ABC (consultas y respuestas frecuentes sobre
  funcionalidades del WS, normativa, aplicativos y sistemas, opción
  Facturación y Registración).
- Documentación de ayuda: `http://www.afip.gob.ar/fe/ayuda.asp`.

---

## 2. WS de Negocio

### 2.1 Operaciones — qué métodos usar según CAE o CAEA

Un contribuyente **solo necesita implementar los métodos de la RG por la
que está alcanzado**. Si optó por CAEA, por ejemplo, no necesita soporte
para `FEParamGetPtosVenta`.

**Distinción CAE vs. CAEA (clave para decidir qué camino implementar):**
- **CAE** (Código de Autorización Electrónico) — autorización **online,
  comprobante por comprobante**, en el momento de la venta. Es el camino
  típico de una integración de facturación online (POS, e-commerce).
- **CAEA** (Código de Autorización Electrónico Anticipado) — código
  **pedido con anticipación** (por período), que después se usa para
  emitir muchos comprobantes **offline**, y se informa a AFIP
  DESPUÉS de emitidos (régimen informativo). Pensado para continuidad
  operativa cuando no hay conexión en el momento de la venta (ej. locales
  sin internet estable).

**Para "CAE – RG2485 V2":**
- Método de autorización de comprobantes electrónicos por CAE
  (`FECAESolicitar`) — ver 4.1.

**Para "CAEA – RG2485 V2":**
- Método de obtención de CAEA (`FECAEASolicitar`) — ver 4.2.
- Método de consulta de CAEA (`FECAEAConsultar`) — ver 4.3.
- Método para informar CAEA sin movimiento (`FECAEASinMovimientoInformar`) — ver 4.13.
- Método para informar comprobantes emitidos con CAEA (`FECAEARegInformativo`) — ver 4.17.
- Método para consultar CAEA sin movimiento (`FECAEASinMovimientoConsultar`) — ver 4.18.

**Para ambos regímenes (catálogos de referencia + utilitarios):**
- `FEParamGetTiposCbte` (4.4), `FEParamGetTiposConcepto` (4.5),
  `FEParamGetTiposDoc` (4.6), `FEParamGetTiposIva` (4.7),
  `FEParamGetTiposMonedas` (4.8), `FEParamGetTiposOpcional` (4.9),
  `FEParamGetTiposTributos` (4.10), `FEParamGetPtosVenta` (4.11),
  `FEParamGetCotizacion` (4.12), `FEDummy` (4.14),
  `FECompUltimoAutorizado` (4.15), `FECompTotXRequest` (4.16),
  `FECompConsultar` (4.19), `FEParamGetTiposPaises` (4.20).

**Camino típico de una integración CAE online** (el más relevante para
POS/e-commerce): `FEDummy` (chequeo de infraestructura) → catálogos 4.4-
4.10/4.20 una vez al arrancar/cachear → `FECompUltimoAutorizado` (saber
desde qué número seguir) → `FECAESolicitar` (autorizar cada comprobante)
→ `FECompConsultar` (auditoría/reimpresión).

---

## 4.1 Método de autorización de comprobantes electrónicos por CAE (`FECAESolicitar`)

**Propósito:** autoriza online, comprobante por comprobante (o lote de
comprobantes del MISMO tipo/punto de venta), la emisión de una factura
electrónica. Es el método central del régimen CAE. Tres resultados
posibles:
- Supera **todas** las validaciones → aprobado, se asigna CAE + fecha de
  vencimiento.
- No supera alguna validación **no excluyente** → aprobado CON
  OBSERVACIONES, igual se asigna CAE + vencimiento.
- No supera alguna validación **excluyente** → RECHAZADO, no se asigna CAE.

Validación **excluyente** = si no se supera, rechaza la solicitud entera.
Validación **no excluyente** = si no se supera, aprueba igual pero con
observaciones (`Observaciones` en la respuesta, no bloquea).

### 4.1.1 Dirección URL (Homologación)

`https://wswhomo.afip.gov.ar/wsfev1/service.asmx?op=FECAESolicitar`

### 4.1.2 Mensaje de solicitud

```xml
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                   xmlns:ar="http://ar.gov.afip.dif.FEV1/">
  <soapenv:Header/>
  <soapenv:Body>
    <ar:FECAESolicitar>
      <ar:Auth>
        <ar:Token>string</ar:Token>
        <ar:Sign>string</ar:Sign>
        <ar:Cuit>long</ar:Cuit>
      </ar:Auth>
      <ar:FeCAEReq>
        <ar:FeCabReq>
          <ar:CantReg>int</ar:CantReg>
          <ar:PtoVta>int</ar:PtoVta>
          <ar:CbteTipo>int</ar:CbteTipo>
        </ar:FeCabReq>
        <ar:FeDetReq>
          <ar:FECAEDetRequest>
            <ar:Concepto>int</ar:Concepto>
            <ar:DocTipo>int</ar:DocTipo>
            <ar:DocNro>long</ar:DocNro>
            <ar:CbteDesde>long</ar:CbteDesde>
            <ar:CbteHasta>long</ar:CbteHasta>
            <ar:CbteFch>string</ar:CbteFch>
            <ar:ImpTotal>double</ar:ImpTotal>
            <ar:ImpTotConc>double</ar:ImpTotConc>
            <ar:ImpNeto>double</ar:ImpNeto>
            <ar:ImpOpEx>double</ar:ImpOpEx>
            <ar:ImpTrib>double</ar:ImpTrib>
            <ar:ImpIVA>double</ar:ImpIVA>
            <ar:FchServDesde>string</ar:FchServDesde>
            <ar:FchServHasta>string</ar:FchServHasta>
            <ar:FchVtoPago>string</ar:FchVtoPago>
            <ar:MonId>string</ar:MonId>
            <ar:MonCotiz>double</ar:MonCotiz>
            <ar:CbtesAsoc>
              <ar:CbteAsoc>
                <ar:Tipo>short</ar:Tipo>
                <ar:PtoVta>int</ar:PtoVta>
                <ar:Nro>long</ar:Nro>
              </ar:CbteAsoc>
            </ar:CbtesAsoc>
            <ar:Tributos>
              <ar:Tributo>
                <ar:Id>short</ar:Id>
                <ar:Desc>string</ar:Desc>
                <ar:BaseImp>double</ar:BaseImp>
                <ar:Alic>double</ar:Alic>
                <ar:Importe>double</ar:Importe>
              </ar:Tributo>
            </ar:Tributos>
            <ar:Iva>
              <ar:AlicIva>
                <ar:Id>short</ar:Id>
                <ar:BaseImp>double</ar:BaseImp>
                <ar:Importe>double</ar:Importe>
              </ar:AlicIva>
            </ar:Iva>
            <ar:Opcionales>
              <ar:Opcional>
                <ar:Id>string</ar:Id>
                <ar:Valor>string</ar:Valor>
              </ar:Opcional>
            </ar:Opcionales>
          </ar:FECAEDetRequest>
        </ar:FeDetReq>
      </ar:FeCAEReq>
    </ar:FECAESolicitar>
  </soapenv:Body>
</soapenv:Envelope>
```

#### `Auth` (autenticación — igual en TODOS los métodos de este WS)

| Campo | Detalle | Obligatorio |
|---|---|---|
| `Auth` | Info de autenticación. Contiene `Token`, `Sign`, `Cuit` | S |
| `Token` | Token devuelto por el WSAA | S |
| `Sign` | Sign devuelto por el WSAA | S |
| `Cuit` | CUIT contribuyente (representado o emisora) | S |

#### `FeCAEReq`

| Campo | Detalle | Obligatorio |
|---|---|---|
| `FeCAEReq` | Info del comprobante o lote. Contiene `FeCabReq` y `FeDetReq` | S |
| `FeCabReq` | Info de cabecera del comprobante o lote | S |
| `FeDetReq` | Info de detalle del comprobante o lote | S |

**`FeCabReq`** (cabecera, aplica a TODO el lote):

| Campo | Tipo | Detalle | Obligatorio |
|---|---|---|---|
| `CantReg` | Int(4) | Cantidad de registros del detalle del comprobante o lote | S |
| `PtoVta` | Int(4) | Punto de Venta del comprobante. Si se informa más de un comprobante, todos deben corresponder al mismo punto de venta | S |
| `CbteTipo` | Int(3) | Tipo de comprobante que se está informando (ver 4.4, `FEParamGetTiposCbte`). Si se informa más de uno, todos deben ser del mismo tipo | S |

**`FeDetReq` → `FECAEDetRequest`** (un elemento por comprobante del lote):

| Campo | Tipo | Detalle | Obligatorio |
|---|---|---|---|
| `Concepto` | Int(2) | 1 = Productos, 2 = Servicios, 3 = Productos y Servicios | S |
| `DocTipo` | Int(2) | Código de tipo de documento identificatorio del comprador (ver 4.6, `FEParamGetTiposDoc`) | S |
| `DocNro` | Long(11) | Nro. de identificación del comprador | S |
| `CbteDesde` | Long(8) | Nro. de comprobante desde. Rango 1-99999999 | S |
| `CbteHasta` | Long(8) | Nro. de comprobante hasta. Rango 1-99999999 | S |
| `CbteFch` | String(8) | Fecha del comprobante, `yyyymmdd`. Para `Concepto=1`: hasta 5 días antes/después de la fecha de generación. Para `Concepto=2` o `3`: hasta 10 días antes/después. Si no se envía, se asigna la fecha de proceso | N |
| `ImpTotal` | Double(13+2) | Importe total del comprobante. Debe ser = `ImpTotConc + ImpOpEx + ImpNeto` + todos los campos de IVA + `ImpTrib` | S |
| `ImpTotConc` | Double(13+2) | Importe neto no gravado. ≤ ImpTotal, no puede ser < 0 | S |
| `ImpNeto` | Double(13+2) | Importe neto gravado. ≤ ImpTotal, no puede ser < 0. **Para tipo C: corresponde al Importe del Sub Total.** Para Bienes Usados-Monotributista: no informar o = 0 | S |
| `ImpOpEx` | Double(13+2) | Importe exento. ≤ ImpTotal, no < 0. **Para tipo C: = 0.** Para Bienes Usados-Monotributista: no informar o = 0 | S |
| `ImpTrib` | Double(13+2) | Suma de los importes del array `Tributos` | S |
| `ImpIVA` | Double(13+2) | Suma de los importes del array `Iva`. **Para tipo C: = 0.** Para Bienes Usados-Monotributista: no informar o = 0 | S |
| `FchServDesde` | String(8) | Fecha de inicio del servicio a facturar, `yyyymmdd`. **Obligatorio si `Concepto` = 2 o 3** | N |
| `FchServHasta` | String(8) | Fecha de fin del servicio, `yyyymmdd`. **Obligatorio si `Concepto` = 2 o 3.** No puede ser < `FchServDesde` | N |
| `FchVtoPago` | String(8) | Fecha de vencimiento del pago, `yyyymmdd`. **Obligatorio si `Concepto` = 2 o 3.** Debe ser ≥ fecha del comprobante | N |
| `MonId` | String(3) | Código de moneda (ver 4.8, `FEParamGetTiposMonedas`) | S |
| `MonCotiz` | Double(4+6) | Cotización de la moneda. **Para PES (pesos argentinos) debe ser 1** | S |
| `CbtesAsoc` | Array | Comprobantes asociados (notas de crédito/débito referenciando la factura original, etc.) — ver abajo | N |
| `Tributos` | Array | Tributos asociados al comprobante — ver abajo | N |
| `Iva` | Array | Alícuotas de IVA y sus importes. **Para tipo C y Bienes Usados-Monotributista: NO informar este array** | N |
| `Opcionales` | Array | Campos auxiliares, reservados para usos futuros/adicionales por R.G. — ver tabla de regímenes abajo | N |
| `Compradores` | Array | Múltiples compradores de un mismo comprobante (agregado en v2.10) — ver abajo | N |

**`CbtesAsoc` → `CbteAsoc`** (comprobantes relacionados con el que se autoriza):

| Campo | Tipo | Detalle | Obligatorio |
|---|---|---|---|
| `Tipo` | Int(3) | Código de tipo de comprobante (ver `FEParamGetTiposCbte`) | S |
| `PtoVta` | Int(4) | Punto de venta | S |
| `Nro` | Long(8) | Número de comprobante | S |
| `Cuit` | String(11) | CUIT emisor del comprobante asociado | N |

**`Tributos` → `Tributo`**:

| Campo | Tipo | Detalle | Obligatorio |
|---|---|---|---|
| `Id` | Int(2) | Código de tributo (ver 4.10, `FEParamGetTiposTributos`) | S |
| `Desc` | String(80) | Descripción del tributo | N |
| `BaseImp` | Double(13+2) | Base imponible para la determinación del tributo | S |
| `Alic` | Double(3+2) | Alícuota | S |
| `Importe` | Double(13+2) | Importe del tributo | S |

**`Iva` → `AlicIva`**:

| Campo | Tipo | Detalle | Obligatorio |
|---|---|---|---|
| `Id` | Int(2) | Código de tipo de IVA (ver 4.7, `FEParamGetTiposIva`) | S |
| `BaseImp` | Double(13+2) | Base imponible para la determinación de la alícuota | S |
| `Importe` | Double(13+2) | Importe | S |

**`Opcionales` → `Opcional`**:

| Campo | Tipo | Detalle | Obligatorio |
|---|---|---|---|
| `Id` | String(4) | Código de opcional (ver 4.9, `FEParamGetTiposOpcional`) | S |
| `Valor` | String(250) | Valor | S |

Los datos opcionales **solo se incluyen si el emisor pertenece al
conjunto de emisores habilitados** a informar ese régimen. Ejemplos de
`Id`/`Valor` documentados según régimen:

| Régimen | `Id` | `Valor` de ejemplo |
|---|---|---|
| Régimen de Promoción Industrial | `2` | `12345678` |
| Educación pública de gestión privada (RG 3.368) | `10`, `1011`, `1012` | `1`, `80`, `30000000007` (3 opcionales juntos) |
| Operaciones económicas con bienes inmuebles (RG 2.820) | `11` | `1` |
| Locación temporaria de inmuebles con fines turísticos (RG 3.687) | `12` | `1` |
| Representantes de Modelos (RG 2.863) | `13` | `1` |
| Agencias de publicidad (RG 2.863) | `14` | `1` |
| Personas físicas, actividad de modelaje (RG 2.863) | `15` | `1` |
| Tipo B/C, locación inmuebles "casa-habitación", facturación directa (RG 4004-E) | `17` | `2` |
| Tipo B/C, locación inmuebles "casa-habitación", facturación a través de intermediario (RG 4004-E) | `17` | `1` |
| Tipo B/C, "casa-habitación", directa con cotitulares o indirecta con datos del/los titular/es (RG 4004-E) — van **al menos 2 registros juntos** | `1801` (CUIT titular) + `1802` (denominación) | `30000000007` + `DENOMINACION EJEMPLO` |

**`Compradores` → detalle** (múltiples compradores de un mismo
comprobante, agregado en la revisión 2.10 del 09/08/2017):

| Campo | Tipo | Detalle | Obligatorio |
|---|---|---|---|
| `DocTipo` | Int(2) | Tipo de documento del comprador | S |
| `DocNro` | String(80) | Número de documento del comprador | S |
| `Porcentaje` | Double(2+2) | Porcentaje de titularidad que tiene el comprador | S |

### 4.1.3 Mensaje de respuesta

Retorna la información del comprobante o lote, agregándole el CAE
otorgado si fue aprobado. Ante cualquier anomalía retorna `Errors` (o un
array de observaciones, según corresponda).

```xml
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"
               xmlns:ar="http://ar.gov.afip.dif.fev1/">
  <soap:Header/>
  <soap:Body>
    <FECAESolicitarResponse>
      <FECAESolicitarResult>
        <FeCabResp>
          <Cuit>long</Cuit>
          <PtoVta>int</PtoVta>
          <CbteTipo>int</CbteTipo>
          <FchProceso>string</FchProceso>
          <CantReg>int</CantReg>
          <Resultado>string</Resultado>
          <Reproceso>string</Reproceso>
        </FeCabResp>
        <FeDetResp>
          <FEDetResponse>
            <Concepto>int</Concepto>
            <DocTipo>int</DocTipo>
            <DocNro>long</DocNro>
            <CbteDesde>long</CbteDesde>
            <CbteHasta>long</CbteHasta>
            <Resultado>string</Resultado>
            <CAE>string</CAE>
            <CbteFch>string</CbteFch>
            <CAEFchVto>string</CAEFchVto>
            <Obs>
              <Observaciones>
                <Code>int</Code>
                <Msg>string</Msg>
              </Observaciones>
            </Obs>
          </FEDetResponse>
        </FeDetResp>
        <Events>
          <Evt>
            <Code>int</Code>
            <Msg>string</Msg>
          </Evt>
        </Events>
        <Errors>
          <Err>
            <Code>int</Code>
            <Msg>string</Msg>
          </Err>
        </Errors>
      </FECAESolicitarResult>
    </FECAESolicitarResponse>
  </soap:Body>
</soap:Envelope>
```

| Campo | Detalle | Obligatorio |
|---|---|---|
| `FECAESolicitarResult` | Info del comprobante/lote, con el CAE otorgado. Contiene `FeCabResp`, `FeDetResp`, `Errors`, `Events` | S |
| `FeCabResp` | Info de cabecera | S |
| `FeDetResp` | Info de detalle, con el CAE otorgado | S |
| `Errors` | Errores detectados | N |
| `Events` | Eventos | N |

**`FeCabResp`:**

| Campo | Tipo | Detalle | Obligatorio |
|---|---|---|---|
| `Cuit` | Long(11) | CUIT del contribuyente | S |
| `PtoVta` | Int(4) | Punto de venta | S |
| `CbteTipo` | Int(3) | Tipo de comprobante | S |
| `FchProceso` | String(14) | Fecha de proceso, formato `yyyymmddhhmiss` | S |
| `CantReg` | Int(4) | Cantidad de registros del detalle del comprobante o lote | S |
| `Resultado` | String(1) | Resultado: `A` (aprobado), `R` (rechazado), `P` (parcial — solo aplica a lotes) | S |
| `Reproceso` | String | Campo no operativo para esta versión | N |

**`FeDetResp` → `FEDetResponse`:**

| Campo | Tipo | Detalle | Obligatorio |
|---|---|---|---|
| `Concepto` | Int(2) | Concepto | S |
| `DocTipo` | Int(2) | Código de tipo de documento del comprador | S |
| `DocNro` | Long(11) | Nro. de identificación del comprador | S |
| `CbteDesde` | Long(8) | Nro. de comprobante desde | S |
| `CbteHasta` | Long(8) | Nro. de comprobante registrado hasta | S |
| `CbteFch` | String(8) | Fecha del comprobante | N |
| `Resultado` | String(1) | Resultado | S |
| `CAE` | String(14) | Código de Autorización Electrónico otorgado | N |
| `CAEFchVto` | String(8) | Fecha de vencimiento del CAE | N |
| `Obs` → `Observaciones` | Array | Detalle de observaciones del comprobante (ver abajo) | N |

**`Obs` → `Observaciones`:**

| Campo | Tipo | Detalle | Obligatorio |
|---|---|---|---|
| `Code` | Int(5) | Código de observación | S |
| `Msg` | String(255) | Mensaje | S |

### 4.1.4 Validaciones y errores

Cada validación pertenece a uno de dos grupos:
- **Excluyente** → si falla, RECHAZA el comprobante entero (no se otorga CAE).
- **No excluyente** → si falla, el comprobante se APRUEBA igual, pero
  vuelve con `Observaciones` (código + mensaje) detallando qué no se
  cumplió — nunca bloquea.

Los códigos de error/observación de este método están en el rango
**10000-10151+** (fueron creciendo release a release, ver el historial de
modificaciones al principio del documento). Tabla completa, agrupada por
objeto sobre el que aplica cada control — **excluyentes primero**:

#### Controles sobre `<Auth>` (excluyentes)

| Código | Descripción |
|---|---|
| 10000 | Verificación registral del CUIT emisor (inscripción, autorización a emitir, domicilio fiscal). Mensajes posibles: `01` CUIT no es responsable inscripto en el impuesto · `02` CUIT no autorizada a emitir comprobantes electrónicos originales o el período de inicio autorizado es posterior a la generación de la solicitud · `03` CUIT con inconvenientes en el domicilio fiscal · `04` CUIT no autorizada a emitir clase "A" (no aplica a tipo C) · `05` CUIT emisor no registrado de forma activa en las bases de la Administración · `06` Debe poseer al menos una actividad activa (no aplica a tipo C) · `07` No autorizada a emitir según RG 3411 (solo aplica a comprobante 49 – Bien Usado) · `08` CUIT no corresponde a un exento en IVA · `09` CUIT no autorizada a emitir clase M |

#### Controles sobre `<FeCabReq>` (excluyentes)

| Código | Campo/Grupo | Descripción |
|---|---|---|
| 10001 | `<CantReg>` | `<CantReg>` debe estar entre 1 y 9998 |
| 10002 | `<CantReg>` | La cantidad de registros de detalle debe ser igual a lo informado en `<CantReg>` de cabecera |
| 10003 | `<CantReg>` | La cantidad de registros en detalle debe ser ≤ el valor permitido — consultar `FECompTotXRequest` |
| 10004 | `<PtoVta>` | `<PtoVta>` debe estar entre 1 y 9998 |
| 10005 | `<PtoVta>` | El punto de venta informado debe estar dado de alta y ser del tipo RECE |
| 10006 | `<CbteTipo>` | `<CbteTipo>` debe ser numérico > 0 |
| 10007 | `<CbteTipo>` | `<CbteTipo>` debe corresponder a la clase correcta: **A** = 01,02,03,04,05,34,39,60,63 · **B** = 06,07,08,09,10,35,40,64,61 · **C** = 11,12,13,15 · **M** = 51,52,53,54 · **Bienes Usados** = 49. Consultar `FEParamGetTiposCbte` |

#### Controles sobre `<FeDetReq>` (excluyentes)

| Código | Campo/Grupo | Descripción |
|---|---|---|
| 10008 | `<CbteDesde>` | Debe estar entre 1 y 99999999 |
| 10010 | `<CbteHasta>` | Debe estar entre 1 y 99999999 |
| 10011 | `<CbteTipo>`/`<CbteDesde>`/`<CbteHasta>` | `<CbteHasta>` ≥ `<CbteDesde>` para tipo B. **Para tipo C, `<CbteHasta>` debe ser IGUAL a `<CbteDesde>`** |
| 10012 | `<CbteTipo>`/`<CbteDesde>`/`<CbteHasta>` | Para clase A, C, M y 49-Bienes Usados: `CbteDesde` debe ser igual a `CbteHasta` (no se permite lote, solo comprobante individual) |
| 10013 | `<CbteTipo>`/`<DocTipo>` | Para clase A y M: `DocTipo` debe ser 80 (CUIT) |
| 10014 | — | Para clase B con `CbteHasta ≠ CbteDesde`: `ImpTotal / (CbteHasta − CbteDesde + 1) < $1000` |
| 10015 | `<CbteTipo>`/`<DocTipo>`/`<DocNro>` | Reglas combinadas para tipo B: en pedidos múltiples (`CbteDesde≠CbteHasta`) `DocTipo` debe ser 99 y `DocNro`=0. En pedidos individuales con `DocTipo`=99, `DocNro` debe ser 0. En individuales con `DocTipo` 80/86/87, el número debe existir en padrones AFIP (excepción: `DocTipo`=80 y `DocNro`=23000000000 = "No Categorizado", no se valida). Si `DocTipo`≠80/86/87 debe ser uno de los valores de `FEParamGetTiposDoc` y debe informarse `DocNro`. Para individuales tipo B con monto > $1000: `DocTipo` debe ser uno de `FEParamGetTiposDoc` excepto 99, y debe informar `DocNro`. Para tipo 49-Bienes Usados: mismo criterio (DocTipo válido excepto 99, obligatorio DocNro; si 80/86/87 valida contra padrones) |
| — | `<CbteDesde>` | El número informado debe ser mayor en 1 al último informado para igual punto de venta y tipo de comprobante — consultar `FECompUltimoAutorizado` |
| 10016 | `<CbteDesde>`/`<CbteFch>` | `CbteFch`: nulo o en rango N-5/N+5 (N=fecha de envío) para `Concepto=1`; nulo o N-10/N+10 para `Concepto=2,3`. Debe ser ≥ fecha del último comprobante emitido para ese tipo/punto de venta |
| 10018 | `<AlicIVA>` | Si `ImpIVA`=0, `<IVA>`/`<AlicIva>` solo pueden informarse con Id=3 (IVA 0%). Si `ImpIVA`>0, `<IVA>`/`<AlicIva>` son obligatorios. `<AlicIva>` es obligatorio si viene `<IVA>`. No aplica a tipo C |
| 10019 | `<AlicIVA><id>` | El campo `Id` es obligatorio. Para `CbteTipo` 2,3,7,8,52,53 es opcional informarlo. Siempre que se informe, debe ser un valor de `FEParamGetTiposIva`. No aplica a tipo C |
| 10020 | `<AlicIVA><BaseImp>` | Obligatorio, > 0. Excepto para comprobantes 2,3,7,8,52,53 (puede ser 0 o no informarse). No aplica a tipo C |
| 10021 | `<AlicIVA><Importe>` | Obligatorio, ≥ 0. Excepto para comprobantes 2,3,7,8,52,53 (puede ser 0 o no informarse). No aplica a tipo C |
| 10022 | `<AlicIVA><id>` | `Id` no debe repetirse — totalizar por alícuota. No aplica a tipo C. La suma de `<Importe>` en `<IVA>` debe ser igual a `ImpIVA` |

#### Controles sobre `<FeDetReq>` (excluyentes, continuación — códigos 10023-10151)

| Código | Campo/Grupo | Descripción |
|---|---|---|
| 10023 | `<ImpIVA>`/`<AlicIVA><Importe>` | Margen de error: relativo ≤0.01% o absoluto ≤0.01×cant. de alícuotas. No aplica a tipo C |
| 10024 | `<Tributo>` | Si `ImpTrib`>0, `<Tributos>`/`<Tributo>` son obligatorios (y no nulos). Si `ImpTrib`=0, no deben enviarse |
| 10025 | `<Tributo><id>` | Obligatorio, debe ser un valor de `FEParamGetTiposTributos` |
| 10026 | `<Tributo><BaseImp>` | Obligatorio, ≥0 |
| 10027 | `<Tributo><Alic>` | Obligatorio, ≥0 |
| 10028 | `<Tributo><importe>` | Obligatorio, ≥0 |
| 10029 | `<ImpTrib>`/`<Tributo><importe>` | Suma de `<Tributo><Importe>` debe ser igual a `ImpTrib`. Margen de error: relativo ≤0.01% o absoluto ≤0.01×cant. de tributos |
| 10030 | `<concepto>` | Obligatorio, debe corresponder a `FEParamGetTiposConcepto`: 1=Productos, 2=Servicios, 3=Productos y Servicios |
| 10031-10036 | `<FchServDesde>`/`<FchServHasta>`/`<FchVtoPago>` | Dependencia cruzada entre las tres: si se informa una, las otras dos también son obligatorias. `FchServDesde` ≤ `FchServHasta`. `FchVtoPago` no puede ser anterior a la fecha del comprobante. Formato `yyyymmdd` |
| 10037 | `<MonId>` | Obligatorio, debe corresponder a `FEParamGetTiposMonedas` |
| 10038 | `<MonCotiz>` | Obligatorio, >0 |
| 10039 | `<MonId>`/`<MonCotiz>` | Obligatorio, igual a 1 cuando `MonId`=PES |
| 10040 | `<CbtesAsoc>`/`<CbteTipo>` | Si se envía `<CbtesAsoc>`, `CbteTipo` a autorizar debe ser 01,02,03,06,07,08,12,13,51,52,53. Combinaciones válidas de tipo asociado por tipo a autorizar: 02/03→01,02,03,04,05,34,39,60,63,88,991 · 07/08→06,07,08,09,10,35,40,61,64,88,991 · 12/13→11,12,13,15 · 52/53→51,52,53,54,88,991 · 01/06/51→88,991 |
| 10042 | `<Tributo><Id>`/`<Desc>` | `Desc` obligatorio cuando `Id`=99 |
| 10043 | `<ImpTotConc>` | ≥0. Tipo C: =0. Bienes Usados-Monotributista: corresponde al importe del subtotal |
| 10044 | `<ImpOpEx>` | ≥0. Tipo C: =0. Bienes Usados-Monotributista: no informar o =0 |
| 10045 | `<ImpNeto>` | ≥0. Tipo C: corresponde al Importe del Sub Total. Bienes Usados-Monotributista: no informar o =0 |
| 10046 | `<ImpTrib>` | ≥0 |
| 10047 | `<ImpIVA>` | ≥0. Tipo C: =0. Bienes Usados-Monotributista: no informar o =0 |
| — | `<ImpTotal>` | Debe ser = `ImpTotConc+ImpNeto+ImpOpEx+ImpTrib+ImpIVA`. **Tipo C:** debe ser = `ImpNeto+ImpTrib` |
| 10048 | varios importes | Bienes Usados-Monotributista: `ImpTotal` = `ImpTotConc+ImpTrib` |
| 10049-10051 | `<FchServDesde>`/`<FchServHasta>`/`<FchVtoPago>`, `<AlicIVA>` | Obligatorias si `Concepto`=2 o 3, formato `yyyymmdd`. Importes de `AlicIVA` deben corresponder al tipo de IVA (no aplica a 2,3,7,8,52,53). Margen de error ≤0.01%/0.01. No aplica a tipo C |
| 10052 | `<Opcionales>` | Si se envía, `<Opcional>` es obligatorio |
| 10053 | `<Opcional>` | `Id` obligatorio, debe ser de `FEParamGetTiposOpcional` |
| 10054 | `<Opcional>` | `Id` obligatorio y no debe repetirse — **excepto 1801/1802 (RG 4004-E), que sí pueden repetirse** |
| 10055 | `<Opcional>` | `Valor` obligatorio |
| 10056 | Importes en general | Deben informarse con la precisión indicada (ver tipos Double(N+M) de cada campo) |
| 10057-10060 | `<CbteAsoc><Tipo/PtoVta/Nro>` | Si se envía `CbteAsoc`: `Tipo`>0, `PtoVta`>0, `Nro` entre 0 y 99999999, sin comprobantes repetidos |
| 10061-10062 | `<ImpNeto>`/`<AlicIVA><BaseImp>` | Suma de `BaseImp` en `AlicIva` = `ImpNeto`. No aplica si `CbteTipo` es 02,03,07,08, tipo C (11,12,13,15) o tipo M (52,53). Margen de error ≤0.01%/0.01×cant. alícuotas |
| 10064-10066 | `<CbtesAsoc>`, `<Opcionales><Id=2><Valor>`, `<ImpTotal>` | Si envía `CbtesAsoc`, `CbteAsoc` obligatorio. Si `Id`=2 (Promoción Industrial), `Valor` numérico de 8 dígitos ≥0 — número de proyecto (debe corresponder al CUIT emisor) o 0 si no aplica. `Id`=2 solo válido si `CbteTipo` ∈ {1,2,3,6,7,8}. `ImpTotal` ≥0 |
| 10067 | `<ImpTrib>`/`<DocTipo>`/`<DocNro>` | Tipo B, `DocTipo`=80 y `DocNro`=23000000000 (No Categorizado): `ImpTrib`>0 |
| 10068-10070 | `<Opcionales>`, `<DocNro>`, `<ImpNeto>`/`<Iva>` | `<Opcionales>` solo si `CbteTipo` ∈ {1,2,3,4,6,7,8,9,11,12,13,15,49,51,52,53,54}. `DocNro` del receptor ≠ `DocNro` del emisor. Si `ImpNeto`>0, `<Iva>` es obligatorio |
| 10075-10085 | `<Opcionales>` (Bienes Usados) | Emisor Monotributista tipo 49: NO informar `<IVA>`/`<AlicIva>`; SÍ obligatorio informar opcionales: `Id=91` (Nombre/Apellido, alfanum. ≤100) obligatorio, `Id=92` (código de país, numérico 3 posiciones, ver `FEParamGetTiposPaises`) — obligatorio si `TipoDoc`∈{30,91,94}, prohibido si no —, `Id=93` (domicilio, alfanum. ≤250) obligatorio. `Concepto` solo puede ser 1-Productos |
| 10086-10096 | `<Opcionales>` (RG 3668, tipo A) | `Id` posibles: 5,61,62,7 — si informa uno, todos son obligatorios. `Id=5`=código de excepción (numérico 2, valores 01-06: Locador/Prestador del mismo, Congresos/Eventos, RG 74, Bienes de Cambio, Ropa de trabajo, Intermediario). `Id=61`=tipo de doc firmante (numérico 2, ver `FEParamGetTiposDoc`). `Id=62`=nro doc firmante (numérico ≤11, valida contra padrones si tipo 80/86/87). `Id=7`=carácter del firmante (numérico 2, 01=Titular,02=Director/Presidente,03=Apoderado,04=Empleado). 10096: tipo C, contribuyente exento → el punto de venta debe ser del tipo "COMPROBANTES – EXENTO EN IVA – WEB SERVICES" |
| 10097-10099 | `<Opcionales>` (RG 3368, educación privada) | `Id=10`: 0/1 (no comprendida/comprendida). `Id=1011`: tipo doc del titular del pago. `Id=1012`: nro doc del titular (≤11 num. para 80/86/87/96, o alfanum ≤20 para el resto) |
| 10110-10118 | `<Opcionales>` (RG 2820/3687/2863) | `Id=11` (bienes inmuebles), `Id=12` (locación turística), `Id=13` (repr. modelos), `Id=14` (agencias publicidad), `Id=15` (personas modelaje): todos numérico 1 carácter, 0/1. **Solo se puede informar UNA resolución por comprobante.** `Id=10`+valor=1 exige informar 1011/1012 juntos (y viceversa: valor=0 no debe informarlos) |
| 10119 | `<MonId>`/`<MonCotiz>` | Si moneda≠PES: la cotización no puede ser <50% ni >100% de la oficial (`FEParamGetCotizacion`) |
| 10120-10132 | `<CbteAsoc>`, `<Opcionales>` (RG 4004-E, casa-habitación) | Si `CbteAsoc.Tipo`∈{88,991}: debe estar registrado y confirmado, y el receptor debe coincidir con el del comprobante asociado. `Id=17`: valor 1=intermediario, 2=directo (solo tipo B/C). `Id=1801`=CUIT propietario/locador (num. 11, valida en padrones, no puede repetirse, no puede ser el mismo CUIT que el emisor). `Id=1802`=nombre/apellido (alfanum ≤100). Si `Id=17`=1 (intermediario): 1801/1802 obligatorios. Si `Id=17`=2 (directo): opcionales, solo si hay cotitulares. Cantidad de 1801 debe ser igual a cantidad de 1802 |
| 10133-10150 | `<Compradores>` (múltiples compradores, agregado v2.10) | Habilitado solo para tipo A/B/C/M, y solo si el `DocTipo` del receptor del comprobante es 80/86/87. Cada `Comprador`: `DocTipo` obligatorio (solo 80/86/87 habilitados), `DocNro` obligatorio (num. 11, ≠ CUIT emisor, no repetido, registrado y activo en AFIP — y activo en IVA si tipo A/M), `Porcentaje` obligatorio (num. 2+2, >0). Mínimo 2 compradores, uno debe ser el receptor del comprobante. El de MAYOR porcentaje debe coincidir con el receptor. Suma de porcentajes = 100%. Solo válido si `Concepto`=1-Producto |
| 10151 | `<CbteAsoc><Cuit>` | Si se informa, no puede ir en blanco — numérico de 11 caracteres |

#### Validaciones No Excluyentes (aprueban con observación, código en la respuesta bajo `Obs`)

| Código | Campo/Grupo | Descripción |
|---|---|---|
| 10017 | `<CbteTipo>`/`<DocNro>` | Para tipo A y M, `DocNro` debería estar registrado y activo en el padrón de AFIP |
| 10041 | `<CbteAsoc><Tipo/PtoVta/Nro>` | Si el punto de venta del comprobante asociado es electrónico, el número debería existir en las bases para ese punto de venta/tipo |
| 10063 | `<DocTipo>`/`<DocNro>` | Para clase A y M, el receptor debería ser un contribuyente activo en IVA |

### 4.1.5 Operatoria ante errores

Escenario con un lote de N comprobantes en un mismo request:

- **Aprobación total** — los N comprobantes fueron aprobados.
- **Rechazo total** — por dos motivos posibles: (a) problema del emisor
  (`Errors` con todas las causas), o (b) rechazo del PRIMER comprobante
  del lote (`Obs` con el motivo).
- **Rechazo parcial** — algún comprobante intermedio del lote es
  rechazado. Ejemplo: lote de 100 comprobantes (51 a 150); si el 101
  falla, se aprueban 51-100, el 101 sale rechazado, y **102-150 quedan
  como "no procesados"** — porque el WS exige correlatividad numérica y
  de fecha, así que una inconsistencia arrastra a todos los subsiguientes.
  Para seguir, hay que corregir el 102 y reenviar un nuevo request desde ahí.

**Operatoria ante errores de comunicación (timeout):** si el cliente
manda una solicitud y no le llega respuesta (timeout), no sabe si el CAE
se asignó y la respuesta se perdió en el camino, o si la solicitud nunca
llegó. Reenviar la MISMA solicitud a ciegas puede fallar con un error de
correlatividad si en realidad sí se había procesado. La forma correcta de
resolver la duda es **consultar antes de reintentar**: `FECompConsultar`
(4.19, dado tipo/punto de venta/número devuelve toda la info + el CAE si
ya se emitió) o `FECompUltimoAutorizado` (4.15, para saber si avanzó el
correlativo).

*(4.1.6 "Ejemplos" del PDF trae 3 casos armados con XML de request/
response completo — Factura A con IVA+Tributos, y variantes — página
37-47 del PDF original. No se transcriben acá línea por línea porque el
contenido real (qué campo va con qué valor) ya está cubierto arriba en
las tablas de request/response; consultar el PDF directamente si hace
falta ver el XML completo armado de un caso real.)*

---

## 4.2 Método de obtención de CAEA (`FECAEASolicitar`)

**Propósito:** solicita un CAEA (Código de Autorización Electrónico
Anticipado) para un período/quincena. Distinto del `FECAESolicitar` de
4.1 pese al nombre parecido — ojo, **mismo verbo, method distinto,
namespace/operación distinta** (`FECAEASolicitar` vs `FECAESolicitar`,
una letra de diferencia).

**Ventana de solicitud:** dentro de los **5 días corridos anteriores** al
comienzo de cada quincena. Dos quincenas por mes: Q1 = día 1 al 15, Q2 =
día 16 al último día del mes.

### 4.2.1 Dirección URL (Homologación)

`https://wswhomo.afip.gov.ar/wsfev1/service.asmx?op=FECAEASolicitar`

### 4.2.2 Mensaje de solicitud

```xml
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                   xmlns:ar="http://ar.gov.afip.dif.FEV1/">
  <soapenv:Header/>
  <soapenv:Body>
    <ar:FECAEASolicitar>
      <ar:Auth>
        <ar:Token>string</ar:Token>
        <ar:Sign>string</ar:Sign>
        <ar:Cuit>long</ar:Cuit>
      </ar:Auth>
      <ar:Periodo>int</ar:Periodo>
      <ar:Orden>short</ar:Orden>
    </ar:FECAEASolicitar>
  </soapenv:Body>
</soapenv:Envelope>
```

| Campo | Tipo | Detalle | Obligatorio |
|---|---|---|---|
| `Auth` | — | Igual que 4.1 (`Token`/`Sign`/`Cuit`) | S |
| `Periodo` | Int(6) | Período del CAEA, formato `yyyymm` | S |
| `Orden` | Short(1) | Orden dentro del período: 1 = Quincena 1, 2 = Quincena 2 | S |

### 4.2.3 Mensaje de respuesta

```xml
<FECAEASolicitarResponse>
  <FECAEASolicitarResult>
    <ResultGet>
      <CAEA>string</CAEA>
      <Periodo>int</Periodo>
      <Orden>short</Orden>
      <FchVigDesde>string</FchVigDesde>
      <FchVigHasta>string</FchVigHasta>
      <FchTopeInf>string</FchTopeInf>
      <FchProceso>string</FchProceso>
      <Observaciones>
        <Obs><Code>int</Code><Msg>string</Msg></Obs>
      </Observaciones>
    </ResultGet>
    <Errors><Err><Code>int</Code><Msg>string</Msg></Err></Errors>
    <Events><Evt><Code>int</Code><Msg>string</Msg></Evt></Events>
  </FECAEASolicitarResult>
</FECAEASolicitarResponse>
```

| Campo | Detalle | Obligatorio |
|---|---|---|
| `ResultGet` | Info completa del CAEA autorizado | S |
| `Errors` | Errores detectados | N |
| `Events` | Eventos | N |

**`ResultGet`:**

| Campo | Tipo | Detalle | Obligatorio |
|---|---|---|---|
| `CAEA` | String(14) | Código de Autorización Electrónico Anticipado | S |
| `Periodo` | Int(6) | Período, `yyyymm` | S |
| `Orden` | Short(1) | Quincena 1 o 2 | S |
| `FchVigDesde` | String(8) | Fecha de vigencia desde | N |
| `FchVigHasta` | String(8) | Fecha de vigencia hasta | N |
| `FchTopeInf` | String(8) | Fecha tope para informar los comprobantes vinculados a este CAEA (ver 4.17) | N |
| `FchProceso` | String(14) | Fecha de proceso, `yyyymmddhhmiss` | N |
| `Observaciones` → `Obs` | Array | Observaciones del CAEA generado (`Code` Int(5) S, `Msg` String(255) S) | N |

### 4.2.4 Validaciones y errores

Rango de códigos de este método: **15000+**.

**Excluyentes** (sobre `<FeCAEAReq>`):

| Código | Descripción |
|---|---|
| 15000-15012 (grupo) | CUIT debe estar empadronado y activo en el régimen CAEA; registrado como Autoimpresor; con al menos un punto de venta activo del régimen CAEA; sin problemas de domicilio; inscripto en IVA; con al menos una actividad económica declarada; empadronado en el régimen de emisión de comprobantes electrónicos |
| — | `Periodo`: formato `AAAAMM` |
| — | `Orden`: debe ser 1 o 2 |
| — | Fecha de envío: hasta 5 días corridos antes del inicio de la quincena |
| — | Si `Orden`=1, `Periodo` debe ser el mes calendario **siguiente**. Si `Orden`=2, `Periodo` debe ser el mes/año de la solicitud |
| — | No debe existir ya un CAEA otorgado para esa CUIT con igual `Periodo`+`Orden` |

**No excluyente:**

| Código | Descripción |
|---|---|
| 15100 | CUIT debería estar autorizada a emitir comprobantes clase A |

*(4.2.5/4.2.6 del PDF traen 2 ejemplos de request/response completos —
sin observaciones y con observación 15100 — página 52-53. Cubiertos por
las tablas de arriba.)*

---

## 4.3 Método de consulta de CAEA (`FECAEAConsultar`)

**Propósito:** consulta el/los CAEA ya otorgados para un período/orden
dado (recuperar `FchVigDesde`/`FchVigHasta`/`FchTopeInf` de un CAEA que
ya se pidió).

**URL:** `https://wswhomo.afip.gov.ar/wsfev1/service.asmx?op=FECAEAConsultar`

**Request:** `Auth` (igual siempre) + `Periodo` (Int(6), `yyyymm`, S) +
`Orden` (Short(1), 1 o 2, S).

**Response — `ResultGet`:** mismos campos que la respuesta de 4.2
(`CAEA`, `Periodo`, `Orden`, `FchVigDesde`, `FchVigHasta`, `FchTopeInf`,
`FchProceso`, `Observaciones`→`Obs`) — acá casi todos vienen como N
(no obligatorio) salvo `Periodo`/`Orden` que siguen S.

**Validaciones excluyentes:**

| Código | Campo | Descripción |
|---|---|---|
| 15004 | `<Periodo>` | Obligatorio, formato `AAAAMM` |
| 15005 | `<Orden>` | Obligatorio, valores permitidos 1 o 2 |

---

## 4.4-4.10 y 4.20 — Recuperadores de catálogos de referencia

Estos 8 métodos comparten EXACTAMENTE la misma forma (solo cambia el
nombre de la operación y del elemento repetido en la respuesta) — se
documentan juntos acá en vez de repetir la misma tabla 8 veces.

**Request (igual en los 8):** solo `Auth` (`Token`/`Sign`/`Cuit`).

```xml
<ar:{NombreDelMétodo}>
  <ar:Auth>
    <ar:Token>string</ar:Token>
    <ar:Sign>string</ar:Sign>
    <ar:Cuit>long</ar:Cuit>
  </ar:Auth>
</ar:{NombreDelMétodo}>
```

**Response (igual en los 8):** `ResultGet` con un array de un elemento
repetido, cada uno con `Id`/`Desc`/`FchDesde`/`FchHasta`, más `Errors` y
`Events`.

```xml
<ResultGet>
  <{ElementoRepetido}>
    <Id>...</Id>
    <Desc>string</Desc>
    <FchDesde>string</FchDesde>
    <FchHasta>string</FchHasta>
  </{ElementoRepetido}>
  <!-- ...uno por cada valor del catálogo... -->
</ResultGet>
```

**Importante:** el manual NO imprime los valores concretos del catálogo
(son dinámicos — ese es justo el propósito del método: consultarlos en
vivo en vez de hardcodearlos en el cliente). Al implementar, cachear el
resultado de cada uno (rara vez cambian) en vez de llamarlos en cada
operación — son de solo lectura y estables.

| Método | Endpoint (`?op=`) | Elemento repetido | `Id` tipo | Qué devuelve |
|---|---|---|---|
| 4.4 `FEParamGetTiposCbte` | `FEParamGetTiposCbte` | `CbteTipo` | Int(3) | Tipos de comprobante habilitados (los mismos códigos que aparecen agrupados por clase A/B/C/M/Bienes Usados en la validación 10007 de 4.1). **Valores confirmados en el texto** (validación 700 de 4.17, subconjunto válido para CAEA — no incluye clase C): `1`=Factura A, `2`=Nota de Débito A, `3`=Nota de Crédito A, `6`=Factura B, `7`=Nota de Débito B, `8`=Nota de Crédito B, `51`=Factura M, `52`=Nota de Débito M, `53`=Nota de Crédito M. Clase C conocidos por agrupación: `11`=Factura C, `12`=ND C, `13`=NC C, `15`=?(agrupado con C). Bienes Usados: `49` |
| 4.5 `FEParamGetTiposConcepto` | `EparamGetTiposConcepto` *(sic — así figura en el manual, posible typo del PDF; verificar el WSDL real)* | `ConceptoTipo` | Int(2) | Los 3 conceptos: 1=Productos, 2=Servicios, 3=Productos y Servicios |
| 4.6 `FEParamGetTiposDoc` | `FEParamGetTiposDoc` | `DocTipo` | Int(2) | Tipos de documento del receptor (80=CUIT, 86=CUIL, 87=CDI, 96=DNI, 99=Consumidor Final/Doc.Genérico, etc. — códigos exactos vía la consulta en vivo) |
| 4.7 `FEParamGetTiposIva` | `FEParamGetTiposIva` | `IvaTipo` | Int(2) | Alícuotas de IVA (3=0%, y las demás alícuotas vigentes — código exacto vía consulta) |
| 4.8 `FEParamGetTiposMonedas` | `FEParamGetTiposMonedas` | `Moneda` | **String(3)** | Códigos de moneda (PES=Pesos argentinos confirmado en 4.1 — `MonCotiz` debe ser 1 solo para PES; el resto vía consulta) |
| 4.9 `FEParamGetTiposOpcional` | `FEParamGetTiposOpcional` | `OpcionalTipo` | **String(4)** | Códigos de dato opcional — el mapeo completo Id→régimen/RG ya está documentado en la tabla de 4.1.2 ("Opcionales") y en las validaciones 10086-10132 de 4.1.4 |
| 4.10 `FEParamGetTiposTributos` | `FEParamGetTiposTributos` | `TributoTipo` | Int(2) | Códigos de tributo (impuestos internos, percepciones, etc.) |
| 4.20 `FEParamGetTiposPaises` | `FEParamGetTiposPaises` | `PaisTipo` (ver 4.20 más abajo — comparte forma pero con un campo extra) | — | Códigos de país (usado en el opcional `Id=92` de Bienes Usados) |

Campos de cada elemento repetido (`Id`/`Desc`/`FchDesde`/`FchHasta`),
mismos en los 7 primeros:

| Campo | Detalle | Obligatorio |
|---|---|---|
| `Id` | Código del valor de catálogo (tipo varía por método, ver tabla arriba) | S |
| `Desc` | String(250) — descripción | S |
| `FchDesde` | String(8) — fecha de vigencia desde | S |
| `FchHasta` | String(8) — fecha de vigencia hasta | N |

---

## 4.11 Puntos de venta habilitados para CAE/CAEA (`FEParamGetPtosVenta`)

**Propósito:** consulta los puntos de venta que la CUIT tiene gestionados
para ambos regímenes (CAE y CAEA).

**URL:** `?op=FEParamGetPtosVenta`. **Request:** solo `Auth`.

**Response — `ResultGet` → `PtoVenta`:**

| Campo | Tipo | Detalle | Obligatorio |
|---|---|---|---|
| `Nro` | Int(4) | Número de punto de venta | S |
| `EmisionTipo` | String(8) | `CAE` o `CAEA` | S |
| `Bloqueado` | String(1) | `S`/`N` — si está bloqueado, hay que regularizar en el ABM de puntos de venta | S |
| `FchBaja` | String(8) | Fecha de baja, si corresponde | N |

---

## 4.12 Cotización de moneda (`FEParamGetCotizacion`)

**Propósito:** última cotización orientativa (base de datos aduanera) de
una moneda — usada para validar el `MonCotiz` que se manda en 4.1
(código 10119: no puede diferir más de -50%/+100% de este valor).

**URL:** `?op=FEParamGetCotizacion`.

**Request:** `Auth` + `MonId` (String, S — código de moneda a consultar).

**Response — `ResultGet`:**

| Campo | Tipo | Detalle | Obligatorio |
|---|---|---|---|
| `MonId` | String(3) | Código de moneda | S |
| `MonCotiz` | Double(4+6) | Cotización | N |
| `FchCotiz` | String(8) | Fecha de la cotización, `yyyymmdd` | N |

**Validaciones excluyentes:**

| Código | Descripción |
|---|---|
| 12000 | `MonId` debe ser uno de los habilitados en el WS (ver `FEParamGetTiposMonedas`) |
| 12001 | `MonId` es obligatorio |

---

## 4.13 Informar CAEA sin movimiento (`FECAEASinMovimientoInformar`)

**Propósito:** informa a AFIP que un CAEA otorgado (para un punto de
venta dado) NO tuvo ningún comprobante emitido — obligación del régimen
CAEA cuando no hubo actividad.

**URL:** `?op=FECAEASinMovimientoInformar`.

**Request:** `Auth` + `PtoVta` (Int, S) + `CAEA` (string, S).

**Response — `FECAEASinMovimientoResult`:**

| Campo | Tipo | Detalle | Obligatorio |
|---|---|---|---|
| `CAEA` | String(14) | El CAEA informado | S |
| `FchProceso` | String(8) | Fecha de procesamiento | N |
| `Resultado` | String(1) | Aprobado o Rechazado | N |
| `PtoVta` | Int(4) | Punto de venta vinculado | S |

**Validaciones:**

| Código | Descripción |
|---|---|
| 1200-1209 (grupo) | El CAEA debe ser del tipo correcto y corresponder a la CUIT del `<Auth><Cuit>`. El par CAEA/PtoVta no debe estar ya usado en algún comprobante. La fecha de envío debe ser posterior al inicio de vigencia del CAEA. `PtoVta` debe estar habilitado para CAEA, activo durante la vigencia del CAEA, y entre 1-9998. El CAEA debe tener formato válido. El punto de venta no debe haber sido ya notificado como sin movimiento |

---

## 4.14 Método Dummy — chequeo de infraestructura (`FEDummy`)

**Propósito:** "ping" de los 3 componentes de infraestructura del
servicio — útil como health-check antes de operar (y para diagnosticar
si un fallo es de AFIP o del propio cliente).

**URL:** `?op=FEDummy`. **Request:** sin parámetros — solo `<ar:FEDummy/>` vacío, ni `Auth`.

**Response — `FEDummyResult`:**

| Campo | Tipo | Detalle |
|---|---|---|
| `AppServer` | String(2) | Estado del servidor de aplicaciones |
| `DbServer` | String(2) | Estado del servidor de base de datos |
| `AuthServer` | String(2) | Estado del servidor de autenticación |

---

## 4.15 Último comprobante autorizado (`FECompUltimoAutorizado`)

**Propósito:** devuelve el último número de comprobante autorizado para
un tipo/punto de venta — clave para saber desde qué número seguir
(`CbteDesde` del próximo `FECAESolicitar` debe ser este + 1, validación
10015 de 4.1) y para recuperarse de errores de comunicación (ver 4.1.5).

**URL:** `?op=FECompUltimoAutorizado`.

**Request:** `Auth` + `PtoVta` (Int, S) + `CbteTipo` (Int, S).

**Response — `FECompUltimoAutorizadoResult`:**

| Campo | Tipo | Detalle | Obligatorio |
|---|---|---|---|
| `PtoVta` | Int(4) | Punto de venta | S |
| `CbteTipo` | Int(3) | Tipo de comprobante | S |
| `CbteNro` | Long(8) | Último número de comprobante registrado | N |

**Validaciones excluyentes:**

| Código | Descripción |
|---|---|
| 11000 | `PtoVta` debe ser válido |
| 11001 | `CbteTipo` debe ser uno de los habilitados (`FEParamGetTiposCbte`) |
| 11002 | `PtoVta` debe ser un punto de venta habilitado (`FEParamGetPtosVenta`) |

---

## 4.16 Cantidad máxima de registros por request (`FECompTotXRequest`)

**Propósito:** devuelve cuántos comprobantes como máximo se pueden meter
en UN solo request de `FECAESolicitar` (4.1) o `FECAEARegInformativo`
(4.17) — el límite real detrás de la validación 10003 de 4.1.

**URL:** `?op=FECompTotXRequest`. **Request:** solo `Auth`.

**Response — `FECompTotXRequestResult`:**

| Campo | Tipo | Detalle | Obligatorio |
|---|---|---|---|
| `RegXReq` | Int(4) | Cantidad máxima de registros permitida por request | S |

---

## 4.17 Informar comprobantes emitidos con CAEA (`FECAEARegInformativo`)

**Propósito:** régimen informativo — para cada comprobante YA EMITIDO
offline usando un CAEA (obtenido en 4.2), se lo informa a AFIP
después del hecho. Se envía un comprobante o lote por request, cada uno
procesado independientemente:
- Supera todas las validaciones → aprobado.
- No supera una excluyente → RECHAZADO.
- No supera una no excluyente → aprobado CON OBSERVACIONES.

**Diferencia estructural clave respecto a 4.1 (`FECAESolicitar`):** la
request es CASI idéntica (`FeCabReq`/`FeDetReq` con los mismos campos),
con dos diferencias: (1) agrega el campo **`CAEA`** al final de cada
detalle — el código ya obtenido que se está informando, en vez de recibir
un CAE nuevo; (2) **no tiene el array `Compradores`** (múltiples
compradores) que sí tiene 4.1.

### 4.17.1 Dirección URL (Homologación)

`https://wswhomo.afip.gov.ar/wsfev1/service.asmx?op=FECAEARegInformativo`

### 4.17.2 Mensaje de solicitud

```xml
<ar:FECAEARegInformativo>
  <ar:Auth>
    <ar:Token>string</ar:Token>
    <ar:Sign>string</ar:Sign>
    <ar:Cuit>long</ar:Cuit>
  </ar:Auth>
  <ar:FeCAEARegInfReq>
    <ar:FeCabReq>
      <ar:CantReg>int</ar:CantReg>
      <ar:PtoVta>int</ar:PtoVta>
      <ar:CbteTipo>int</ar:CbteTipo>
    </ar:FeCabReq>
    <ar:FeDetReq>
      <ar:FECAEADetRequest>
        <ar:Concepto>int</ar:Concepto>
        <ar:DocTipo>int</ar:DocTipo>
        <ar:DocNro>long</ar:DocNro>
        <ar:CbteDesde>long</ar:CbteDesde>
        <ar:CbteHasta>long</ar:CbteHasta>
        <ar:CbteFch>string</ar:CbteFch>
        <ar:ImpTotal>double</ar:ImpTotal>
        <ar:ImpTotConc>double</ar:ImpTotConc>
        <ar:ImpNeto>double</ar:ImpNeto>
        <ar:ImpOpEx>double</ar:ImpOpEx>
        <ar:ImpIVA>double</ar:ImpIVA>
        <ar:ImpTrib>double</ar:ImpTrib>
        <ar:FchServDesde>string</ar:FchServDesde>
        <ar:FchServHasta>string</ar:FchServHasta>
        <ar:FchVtoPago>string</ar:FchVtoPago>
        <ar:MonId>string</ar:MonId>
        <ar:MonCotiz>double</ar:MonCotiz>
        <ar:CbtesAsoc>
          <ar:CbteAsoc>
            <ar:Tipo>short</ar:Tipo>
            <ar:PtoVta>int</ar:PtoVta>
            <ar:Nro>long</ar:Nro>
          </ar:CbteAsoc>
        </ar:CbtesAsoc>
        <ar:Tributos>
          <ar:Tributo>
            <ar:Id>short</ar:Id>
            <ar:Desc>string</ar:Desc>
            <ar:BaseImp>double</ar:BaseImp>
            <ar:Alic>double</ar:Alic>
            <ar:Importe>double</ar:Importe>
          </ar:Tributo>
        </ar:Tributos>
        <ar:Iva>
          <ar:AlicIva>
            <ar:Id>short</ar:Id>
            <ar:BaseImp>double</ar:BaseImp>
            <ar:Importe>double</ar:Importe>
          </ar:AlicIva>
        </ar:Iva>
        <ar:Opcionales>
          <ar:Opcional>
            <ar:Id>string</ar:Id>
            <ar:Valor>string</ar:Valor>
          </ar:Opcional>
        </ar:Opcionales>
        <ar:CAEA></ar:CAEA>
      </ar:FECAEADetRequest>
    </ar:FeDetReq>
  </ar:FeCAEARegInfReq>
</ar:FECAEARegInformativo>
```

Campos: **idénticos a `FeCabReq`/`FeDetReq` de 4.1.2** (ver tablas
completas ahí — `Concepto`, `DocTipo`, `DocNro`, `CbteDesde/Hasta`,
`CbteFch`, los 6 importes, `FchServDesde/Hasta`, `FchVtoPago`, `MonId`,
`MonCotiz`, `CbtesAsoc`/`Tributos`/`Iva`/`Opcionales` con la misma forma
y las mismas reglas de opcionales por régimen), **más**:

| Campo | Tipo | Detalle | Obligatorio |
|---|---|---|---|
| `CAEA` | String(14) | Código de Autorización Electrónico Anticipado que se está informando | S |

*(Nota: `ImpTrib` e `ImpIVA` aparecen en orden invertido en el XML de
este método respecto a 4.1, sin cambio de significado.)*

### 4.17.3 Mensaje de respuesta

Misma forma que 4.1.3, con `CAEA` en vez de `CAE`/`CAEFchVto` en el
detalle (tiene sentido — el CAEA ya existía, no se otorga vencimiento
nuevo acá):

```xml
<FECAEARegInformativoResponse>
  <FECAEARegInformativoResult>
    <FeCabResp>
      <Cuit>long</Cuit>
      <PtoVta>int</PtoVta>
      <CbteTipo>int</CbteTipo>
      <FchProceso>string</FchProceso>
      <CantReg>int</CantReg>
      <Resultado>string</Resultado>
    </FeCabResp>
    <FeDetResp>
      <FECAEADetResponse>
        <Concepto>int</Concepto>
        <DocTipo>int</DocTipo>
        <DocNro>long</DocNro>
        <CbteDesde>long</CbteDesde>
        <CbteHasta>long</CbteHasta>
        <Resultado>string</Resultado>
        <CAEA>string</CAEA>
        <CbteFch>string</CbteFch>
        <Obs><Observaciones><Code>int</Code><Msg>string</Msg></Observaciones></Obs>
      </FECAEADetResponse>
    </FeDetResp>
    <Events><Evt><Code>int</Code><Msg>string</Msg></Evt></Events>
    <Errors><Err><Code>int</Code><Msg>string</Msg></Err></Errors>
  </FECAEARegInformativoResult>
</FECAEARegInformativoResponse>
```

`FeCabResp` — igual que 4.1.3 (sin `Reproceso`). `FeDetResp` →
`FECAEADetResponse` — igual que 4.1.3 pero `CAEA` en vez de
`CAE`/`CAEFchVto`.

### 4.17.4 Validaciones y errores

**Rango de códigos distinto al de 4.1** — acá se usan sobre todo
**700-799**, más algunos reusados de la serie 10000s y varios 1400s.
Cuidado al implementar: **no asumir que el código de error es suficiente
para saber de qué método vino** — siempre loguear también el nombre del
método.

**Sobre `<Auth>`:**

| Código | Descripción |
|---|---|
| 10000 | CUIT del emisor debe estar registrada y activa (mismo código que 4.1, reusado) |

**Sobre `<FeCabReq>`:**

| Código | Descripción |
|---|---|
| 10001-10003 | Mismas reglas de `CantReg` que 4.1 (rango 1-9998, coincide con cabecera, ≤ límite de `FECompTotXRequest`) |
| 700 | `CbteTipo` obligatorio. **Valores permitidos para CAEA** (subconjunto de los de CAE — nota: no incluye clase C): `1`=Factura A, `2`=ND A, `3`=NC A, `6`=Factura B, `7`=ND B, `8`=NC B, `51`=Factura M *(CAEA observa comprobante)*, `52`=ND M *(ídem)*, `53`=NC M *(ídem)* |
| 1300 | `PtoVta` entre 1 y 9998 |
| 701 | El punto de venta debe ser del tipo habilitado para CAEA-RG2485 y no estar bloqueado a la fecha de emisión del comprobante |

**Sobre `<FECAEADetRequest>`:**

| Código | Campo | Descripción |
|---|---|---|
| 702 | `CbteFch` | Debe estar dentro del rango de vigencia (`FchVigDesde`/`FchVigHasta`) del CAEA |
| 703 | `CbteDesde`/`CbteHasta`/`PtoVta`/`CbteTipo` | El número debe ser mayor en 1 al último informado para igual punto de venta/tipo — consultar `FECompUltimoAutorizado` |
| 704 / 1414 | `CAEA`/`PtoVta`, fecha de envío | La fecha del comprobante debe ser ≥ a la del último comprobante informado para igual tipo/punto de venta. Informar con la modalidad CAEA exige que la fecha de informe sea posterior al inicio de vigencia del CAEA vinculado |
| 705 | `MonId` | Debe corresponder a la CUIT que está informando |
| 709 | — | Fecha de alta del punto de venta debe ser ≤ fecha de vigencia "hasta" del CAEA |
| 1401 | `MonId` | Obligatorio, debe ser de `FEParamGetTiposMonedas` |
| 713 | `Concepto` | Obligatorio: 1=Productos, 2=Servicios, 3=Productos y Servicios (`FEParamGetTiposConcepto`) |
| 715 | `ImpIVA`/`Iva`/`AlicIva` | Si `ImpIVA`=0, solo puede informarse `Iva`/`AlicIva` con Id=3 (0%). Si `ImpIVA`>0, son obligatorios. `AlicIva` obligatorio si viene `Iva` |
| 717 | `ImpTotConc` | ≥0, 13 enteros + 2 decimales |
| 718 | `ImpOpEx` | ≥0, 13+2 |
| 719 | `ImpNeto` | ≥0, 13+2 |
| 723 | `ImpTrib` | ≥0, 13+2 |
| 1407 | `ImpIVA` | ≥0, 13+2 |
| 726 | `MonCotiz` | Obligatorio, >0. =1 si `MonId`=PES. Si ≠PES, >0. 4 enteros + 6 decimales |
| 780 | `CAEA` | Debe corresponder a un CAEA registrado en las bases de la Administración |
| 781 | `PtoVta`/`CbteFch` | Fecha de alta del punto de venta debe ser ≤ fecha del comprobante |

**Sobre `<FECAEADetRequest>` (continuación, excluyentes):**

| Código | Campo | Descripción |
|---|---|---|
| 782 | `CAEA` | Obligatorio, numérico de 14 posiciones |
| 783 | `CbteFch` | Obligatorio, formato `yyyymmdd` |
| 784 | `CbteDesde`/`CbteHasta` | Obligatorio, entero, entre 1 y 99999999 |
| 1416 | `CbteHasta`/`CbteDesde` | Para tipo B, `CbteHasta` ≥ `CbteDesde` |
| 1415 | `CbteTipo`/`CbteDesde`/`CbteHasta` | Para facturas B en lote (`CbteDesde≠CbteHasta`): `DocNro`=0 y `DocTipo`=99 |
| 1417 | `DocTipo`/`DocNro`/`CbteDesde`/`CbteHasta` | Facturas B individuales ≥$1000: `DocTipo` de `FEParamGetTiposDoc` (≠99), `DocNro`>0 |
| 1418 | ídem | Facturas B individuales <$1000, `DocTipo`=99: `DocNro`=0 |
| 1419 | ídem | Facturas B individuales <$1000, `DocTipo`≠99: `DocNro`>0 |
| 1422 | `CbteTipo`/`CbteDesde`/`CbteHasta` | Para tipo B con `CbteDesde≠CbteHasta`: `ImpTotal/(CbteHasta−CbteDesde+1) < $1000` |
| 711 | `CbteTipo`/`CbteDesde`/`CbteHasta` | Para clase A, `CbteDesde` = `CbteHasta` |
| 1403 | `CbteTipo`/`DocTipo` | Clase A: `DocTipo`=80 (CUIT) |
| 1409 | `ImpTotal` | ≥0, 13+2 |
| 1404 | `DocTipo`/`DocNro` | Si se informan, `DocTipo` debe ser de `FEParamGetTiposDoc` |
| 1405 | `CbteTipo`/`DocNro` | Tipo B: `DocNro` entre 0 y 99999999999 |
| 1421 | `CbteTipo`/`DocNro` | Tipo A: `DocNro` entre 20000000000 y 60000000000 |
| 788 | `DocTipo`/`DocNro` | Si `DocTipo`=80, el documento no puede ser el mismo que `<Auth><Cuit>` |
| 1423 | `ImpTrib`/`Tributos`/`Tributo` | Si `ImpTrib`=0, no informar `Tributos`. Si >0, `Tributos`/`Tributo` obligatorios y no vacíos |
| 1426 | `Opcionales`/`CbteTipo` | No obligatorio; solo válido si `CbteTipo` ∈ {1,2,3,6,7,8} |
| 1432 | `Compradores` | **No está habilitado informar `Compradores` en el régimen CAEA** (confirma la diferencia con 4.1) |

**No excluyentes:**

| Código | Campo | Descripción |
|---|---|---|
| 708 | `CbteTipo`/`DocNro` | Tipo A: `DocNro` debería estar registrado y ACTIVO en el padrón AFIP |
| 724/728 | Importes | `ImpTotal` = suma de `ImpTotConc+ImpNeto+ImpOpEx+ImpTrib+ImpIVA` |
| 725/1402/727 | `FchServHasta`, IVA | Margen de error ≤0.01%/0.01. Solo informar `FchServHasta` si `Concepto`=2 o 3 |
| 1420/1408 | `CbteTipo`/`DocTipo`/`DocNro` | Tipo A: receptor debe estar activo en IVA |
| — | `ImpNeto`/`AlicIva.BaseImp` | Suma de `BaseImp` = `ImpNeto` (no aplica a 02,03,07,08). Margen de error ≤0.01%/0.01×alícuotas |
| — | Tipo B individual, `DocTipo`∈{80,86,87} | `DocNro` debe estar en padrones (excepción: 80+23000000000=No Categorizado) |
| 1411 | `FchVtoPago` | ≥ fecha del comprobante |
| 729 | `FchVtoPago` | Solo si `Concepto`=2 o 3 |
| 1412 | `FchServDesde`/`FchServHasta` | `FchServDesde` ≤ `FchServHasta` |
| 1406 | `ImpTrib` | = suma de `Tributos.Importe`. Margen de error ≤0.01%/0.01×tributos |
| 1424 | `CAEA`/`PtoVta` | No debe estar informado como "sin movimientos" |
| 1425 | `ImpTrib`/`DocTipo`/`DocNro` | Tipo B, `DocTipo`=80, `DocNro`=23000000000: `ImpTrib`>0 |
| 1413 | `FchServDesde`/`FchServHasta`/`FchVtoPago` | Formato `yyyymmdd` |
| 1427 | `ImpNeto`/`Iva`/`AlicIva` | Si `ImpNeto`>0, `AlicIva` obligatorio |
| 1429 | `Auth.Cuit`/`CbteTipo`/`CbteFch` | No habilitado a emitir "A" a la fecha — el comprobante queda observado (no rechazado) |
| 1430 | ídem | Clase "M" no alcanzada por el Procedimiento Especial de CAEA |
| 1431 | ídem | Debe estar dado de alta en IVA al momento de emitir |

**Sobre `<CbtesAsoc>` (excluyentes):**

| Código | Descripción |
|---|---|
| 800 | Si envía `CbtesAsoc`, `CbteAsoc` obligatorio y no vacío |
| 802 | `PtoVta` > 0 |
| 803 | `Nro` entre 0 y 99999999 |
| 804 | Comprobantes no pueden repetirse |
| 805 | `Tipo` > 0 |
| 807 | `CbtesAsoc` solo válido si `CbteTipo` ∈ {1,2,3,6,7,8,51,52,53} |
| 808 | `Cuit` (si se informa) numérico de 11 caracteres |

**Sobre `<CbtesAsoc>` (no excluyentes):**

| Código | Descripción |
|---|---|
| 806 | `Tipo` debe ser 1,2,3,88,991 si el comprobante informado es 2 o 3 |
| 801/809 | `Tipo` debe ser 6,7,8,88,991 si es 7 u 8; debe ser 51,52,53 si es 52 o 53; debe ser 88 o 991 si es 1,6,51 |
| — | Si el punto de venta asociado es electrónico, el número debe existir en las bases |
| — | Si `Tipo`∈{88,991}: debe estar registrado |
| 810 | Si `Tipo`∈{88,991}: debe estar confirmado |
| 811 | Si `Tipo`∈{88,991}: el receptor debe coincidir con el del comprobante asociado |

**Sobre `<Tributo>` (excluyentes):**

| Código | Descripción |
|---|---|
| 900/908/907 | `Id` obligatorio (`FEParamGetTiposTributos`). `Desc` opcional, obligatorio si `Id`=99 |
| 905/906 | `Importe` ≥0, 13+2. `BaseImp` obligatorio ≥0, 13+2 |
| — | `Alic` obligatorio ≥0, 3+2 |

**Sobre `<IVA>` (excluyentes):**

| Código | Descripción |
|---|---|
| 1000/1003 | `Id` — consultar `FEParamGetTiposIva`, opcional para tipos 2,3,7,8 |
| 1008/1009 | `Id` no repetible (totalizar por alícuota). `Importe` obligatorio ≥0, 13+2 |
| — | `BaseImp` obligatorio >0 (excepto 2,3,7,8: puede ser 0/no informarse), 13+2 |

**Sobre `<IVA>` (no excluyente):**

| Código | Descripción |
|---|---|
| 1006 | Los importes de `AlicIVA` deben corresponderse con los porcentajes (excepto 2,3,7,8). Margen de error ≤0.01%/0.01 |

**Sobre `<Opcionales>` (excluyentes):**

| Código | Descripción |
|---|---|
| 1100/1101 | `Id` obligatorio, =2 (Régimen de Promoción Industrial) |
| 1105/1103 | `Id` obligatorio, no repetible |
| 1104 | `Valor` obligatorio |
| — | Si envía `Opcionales`, `Id` y `Valor` obligatorios. Si `Id`=2, `Valor` numérico de 8 dígitos ≥0 |

**Sobre `<Opcionales>` (no excluyente):**

| Código | Descripción |
|---|---|
| 1106 | Si `Id`=2 y aplica Promoción Industrial: `Valor`=nro. de proyecto (debe corresponder al CUIT emisor), si no aplica `Valor`=0 |

### 4.17.5 Operatoria ante errores

Mismo patrón que 4.1.5, con el campo `Resultado` explícito por caso:
- **Aceptación total** → `Resultado = A` (todos aprobados).
- **Rechazo total** → `Resultado = R`. Dos causas posibles: problema del
  emisor/cabecera (solo `Errors`) o rechazo de cada uno de los
  comprobantes (`FeCabResp`+`FeDetResp`+`Observaciones`/`Errors` por
  comprobante).
- **Rechazo parcial** → `Resultado = P`. Mismo mecanismo de
  correlatividad que 4.1: un comprobante intermedio rechazado arrastra a
  todos los subsiguientes del lote como "no procesados".

**Errores de comunicación:** mismo problema y misma solución que 4.1.5 —
usar `FECompConsultar` (devuelve resultado, tipo de emisión CAEA, fecha
de vencimiento/proceso y observaciones) o `FECompUltimoAutorizado` antes
de reintentar a ciegas.

*(4.17.6 "Operatoria ante errores, Ejemplos" trae varios casos armados
con XML completo — página 97-113 del PDF. No se transcriben acá por el
mismo motivo que 4.1.6: el contenido de campos ya está cubierto arriba.)*

---

## 4.18 Consultar CAEA sin movimiento (`FECAEASinMovimientoConsultar`)

**Propósito:** consulta, para un CAEA dado, qué puntos de venta fueron
notificados como "sin movimiento" (4.13) — y opcionalmente filtra por un
punto de venta puntual.

**URL:** `?op=FECAEASinMovimientoConsultar`.

**Request:** `Auth` + `CAEA` (string, S) + `PtoVta` (Int, S).

**Response — `ResultGet` → `FECAEASinMov`:**

| Campo | Tipo | Detalle | Obligatorio |
|---|---|---|---|
| `CAEA` | String(14) | El CAEA consultado | S |
| `FchProceso` | String(8) | Fecha en que se informó como sin movimiento | S |
| `PtoVta` | Int(4) | Punto de venta vinculado | S |

**Validaciones:**

| Código | Descripción |
|---|---|
| 10100 | No se ingresó el CAEA o el formato es inválido |
| 10101 | No se ingresó el Punto de Venta o el formato es inválido |
| 10102 | El CAEA no está registrado en las bases como "sin movimientos" |
| 10105 | El punto de venta ingresado registra comprobantes informados (contradice "sin movimiento") |

---

## 4.19 Consultar Comprobantes Emitidos (`FECompConsultar`)

**Propósito:** dado tipo/número/punto de venta, devuelve TODOS los datos
de un comprobante ya emitido — incluyendo qué tipo de emisión se usó
(CAE o CAEA) y el código de autorización. Es la herramienta central para
recuperarse de errores de comunicación (ver 4.1.5/4.17.5) y para
auditoría/reimpresión.

**URL:** `?op=FECompConsultar`.

**Request — `FeCompConsReq`:**

| Campo | Detalle | Obligatorio |
|---|---|---|
| `CbteTipo` | Tipo de comprobante | S |
| `CbteNro` | Número de comprobante | S |
| `PtoVta` | Punto de venta | S |

**Response — `ResultGet`:** todos los campos de entrada de
`FECAEDetRequest` (4.1.2 — `Concepto`, `DocTipo`, `DocNro`,
`CbteDesde/Hasta`, `CbteFch`, los 6 importes, fechas de servicio,
`MonId`/`MonCotiz`, `CbtesAsoc`, `Tributos`, `Iva`, `Opcionales`,
`Compradores`), **más**:

| Campo | Detalle | Obligatorio |
|---|---|---|
| `Resultado` | Resultado del procesamiento del comprobante | S |
| `CodAutorizacion` | Código de Autorización (el CAE o el CAEA usado) | S |
| `EmisionTipo` | `CAE` o `CAEA` — con QUÉ régimen se autorizó este comprobante | S |
| `FchVto` | Vencimiento del código: si `EmisionTipo`=CAE, la fecha de vencimiento del CAE otorgado; si CAEA, la fecha "vigencia hasta" del CAEA | S |
| `FchProceso` | Fecha de procesamiento del comprobante | S |
| `Observaciones` → `Obs` | Observaciones identificadas al generar el comprobante | N |
| `PtoVta` | Punto de venta | S |
| `CbteTipo` | Tipo de comprobante | S |

**Ejemplo real de la respuesta** (confirma valores concretos de
catálogo): `EmisionTipo=CAE`, `Resultado=A`, IVA con `Id=5` (21%,
`BaseImp=100`→`Importe=21`) e `Id=4` (10.5%, `BaseImp=50`→`Importe=5.25`)
— dato útil: **`AlicIva.Id=4` = 10.5%, `Id=5` = 21%** (confirmado por el
cálculo del ejemplo, no solo declarado).

**Validaciones:**

| Código | Descripción |
|---|---|
| 10200/10201/10104 | No se ingresó el Punto de Venta o formato inválido / el punto de venta no está registrado |
| 10202 | No se ingresó el Tipo de Comprobante o es inválido |
| — | No se ingresó el número de comprobante o el formato es inválido |

---

## 4.20 Códigos de país (`FEParamGetTiposPaises`)

**Propósito:** catálogo de países — usado en el opcional `Id=92` de
Bienes Usados-Monotributista (ver validación 10080-10082 de 4.1.4).

**URL:** `?op=FEParamGetTiposPaises`. **Request:** solo `Auth`.

**Response — `ResultGet` → `PaisTipo`** (nota: este catálogo, a
diferencia de los de 4.4-4.10, NO tiene `FchDesde`/`FchHasta`):

| Campo | Tipo | Detalle | Obligatorio |
|---|---|---|---|
| `Id` | Int(3) | Código de país | S |
| `Desc` | String(250) | Descripción | S |

---

## 4.21 Margen de error (Error Absoluto y Error Relativo)

Fórmulas usadas en TODAS las validaciones de "margen de error" citadas
arriba (10023, 10029, 10049-10051, 10061-10062, 10066, 1406, 1408, 1420,
1006, etc. — la regla general es: relativo ≤0.01% o absoluto ≤0.01,
multiplicado por la cantidad de elementos del array cuando corresponde):

- **Error Absoluto** (`eabs`) = diferencia entre el valor medido
  (calculado por el cliente) y el valor real (calculado por AFIP).
- **Error Relativo** (`erel`) = cociente entre el error absoluto y el
  valor real.
- En ambos casos se toma el **valor absoluto** — el signo no importa.
- **Criterio de redondeo del servicio: Round Half Even** (también
  conocido como "redondeo bancario" — a la práctica, al calcular
  importes/IVA del lado del cliente hay que redondear igual, si no los
  totales pueden no cuadrar dentro del margen tolerado).

---

## Anexos del documento original (no transcritos en detalle)

- **ANEXO 1** (página 122-129): grilla comparativa de códigos de
  error/observación entre la versión 1 y la versión 1.1 del release
  (crosswalk histórico de migración, año 2011). Es documentación de
  migración de una versión vieja del WS a otra, no vigente para una
  implementación nueva hoy — todos los códigos ACTUALES ya están
  transcritos en las tablas de validaciones de cada método arriba. La
  extracción de texto de esta tabla en particular queda muy degradada
  (columnas multi-fila mal alineadas) — consultar el PDF original si
  hace falta reconstruir ese historial puntual.
- **ANEXO 2** (página 130-131): guía para el desarrollador del cliente
  consumidor específica de comprobantes tipo "C" (agregados por RG
  3067/2011) — probablemente aclaraciones puntuales sobre las
  diferencias ya capturadas arriba en cada validación marcada "no aplica
  para comprobantes tipo C" / "para comprobantes tipo C". No se
  transcribió por separado porque el contenido sustantivo (qué campos
  van en 0 para tipo C, qué arrays no se informan) ya quedó cubierto en
  las validaciones 10011, 10012, 10043-10047, etc. de 4.1.4.
