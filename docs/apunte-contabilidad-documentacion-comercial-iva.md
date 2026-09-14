# Apunte — Documentación comercial e IVA (Contabilidad, Unidad 2)

> Material de referencia transcripto de un apunte de estudio ("Educación
> Adultos 2000 · Contabilidad", Unidad 2 — buenosaires.gob.ar). No es un ADR
> ni un documento de diseño del sistema: es insumo de consulta sobre
> conceptos contables argentinos (documentación comercial, cheques,
> facturación A/B/C, IVA) que pueden ser relevantes como contexto de dominio
> para `src/facturacion/` (AFIP, tipos de factura, notas de crédito/débito).
> No reemplaza ni fija ninguna decisión de `docs/criterios-negocio.md` ni de
> `docs/diseno-factura-borrador-2026-08-31.md`.

## c. Funciones de la documentación comercial

- **Función de control** — permite verificar que lo pactado (pedido,
  cantidad, precio) coincide con lo entregado/facturado.
- **Función contable** — es la base para registrar los asientos: toda
  registración necesita un comprobante que la respalde.
- **Función jurídica** — sirve como prueba legal de la operación ante un
  conflicto o una fiscalización.

## d. Relación documento → significado (original vs. duplicado)

Regla general: **original (o cuerpo) → para quien *recibe* el documento**;
**duplicado (o talón) → para quien *emite* el comprobante** (se lo queda
como registro propio).

| Documento | Lo tiene / lo recibe | Significa |
|---|---|---|
| Factura original | el comprador | Compra |
| Factura duplicado | el vendedor | Venta |
| Remito original | el comprador | Mercaderías recibidas |
| Remito duplicado | el vendedor | Mercaderías entregadas |
| Pedido original | el vendedor | Pedidos recibidos |
| Pedido duplicado | el comprador | Pedidos efectuados |
| Recibo original | quien pagó | Pago |
| Recibo duplicado | quien cobró | Cobro |
| Nota de Débito | — | Aumento de deuda |
| Nota de Crédito | — | Disminución de deuda |

## e. Cheques

- Es una **orden de pago** emitida contra un banco en el cual el titular
  tiene fondos depositados o autorización para girar en descubierto.
- Requiere **cuenta corriente**.
- Formas de cobrarlo: **por ventanilla**, **depositarlo** en cuenta propia,
  o **endosarlo** (transferirlo a un tercero).
- **Cheque a la orden**: emitido a nombre de una persona. Se puede
  depositar en cta. cte., cobrar por ventanilla o endosar.
- **Cheque no a la orden**: emitido a nombre de una persona con el agregado
  "NO A LA ORDEN" a continuación del nombre. Puede depositarse en cta. cte.
  o cobrarse por ventanilla, pero **no puede endosarse**.
- **Cheque cruzado**: lleva dos líneas paralelas en el ángulo superior
  izquierdo. Función: el cheque **no puede cobrarse por ventanilla**, solo
  depositarse en cta. cte.
- **Cobro por ventanilla**: el beneficiario presenta el cuerpo del cheque
  al cajero y guarda el talón (si lo tuviere), acreditando su identidad. El
  cajero verifica si el cheque puede pagarse; si es así, lo paga previo
  endoso del beneficiario; si no, lo rechaza.
- El documento para efectuar depósitos bancarios es la **nota de crédito
  bancaria** o **boleta de depósito**.
- **Motivos de rechazo**: falta de fondos, o cuestiones formales — falta de
  firma, firma que no coincide con el registro del banco, importe en letras
  que no coincide con el importe en números, etc.

## f. Cuadro — tipos de factura

| Factura | Vendedor | Comprador | ¿Incluye IVA? | ¿IVA discriminado? |
|---|---|---|---|---|
| A | R.I. | R.I. | Sí (21%) | Sí |
| B | R.I. | C.F. | Sí (21%) | No |
| B | R.I. | Monot./Ex. | Sí (21%) | No |
| C | Monotributo | Cualquiera | No | ---- |
| C | Exento | Cualquiera | No | ---- |

(R.I. = Responsable Inscripto; C.F. = Consumidor Final; Monot./Ex. =
Monotributista / Exento)

## g. Crédito fiscal y débito fiscal

- **Crédito fiscal**: el valor pagado en concepto de IVA en las compras.
- **Débito fiscal**: el valor cobrado en concepto de IVA en las ventas.
- La diferencia entre crédito y débito fiscal es el valor que la empresa
  debe entregar a la AFIP (cuando el débito es mayor que el crédito), o el
  importe que queda como saldo a favor para el mes siguiente (cuando el
  crédito es mayor que el débito). Ese valor equivale al 21% del valor
  agregado por la empresa.

## h. Ejercicio resuelto — caso práctico

Situación: un mayorista le vende a un maxikiosco (ambos R.I.), y el
maxikiosco le vende a un consumidor final.

- La factura que emite el mayorista es **factura A** (R.I. a R.I.):
  - Subtotal: 300
  - IVA: 63
  - Total: 363
- La factura que emite el maxikiosco al consumidor final es **factura B**.
- Total de esa factura: **$484** (incluye IVA, pero no se discrimina).
- Total del crédito fiscal: **$63**. Total del débito fiscal: **$84**.
- Deberá entregar a la AFIP: **$21** (diferencia entre débito y crédito
  fiscal).
- ¿Hay valor agregado por la empresa? **Sí** — $100 (precio de compra
  $300, precio de venta $400).

## Diagrama — síntesis del circuito

```
OPERACIONES COMERCIALES
 └─ respaldadas por → DOCUMENTACIÓN COMERCIAL
     ├─ Función de control
     ├─ Función contable
     └─ Función jurídica

 COMPRA VENTA
 ├─ Al contado
 └─ A crédito
     ├─ Documentada (con pagaré)
     └─ Sin documentar (en cta. corriente)

 Entrega de un bien a cambio de un PRECIO (valor de un bien expresado en dinero)
     ├─ Rebajas: descuentos y bonificaciones
     └─ Recargos, intereses

 COMPROBANTE                SECUENCIA
 ├─ Nota de Pedido  ········ Pedido
 ├─ Remito ·········· Entrega de bienes
 ├─ Factura ········· Notificación de deuda
 ├─ Nota de Débito ·· Notificación de aumento de deuda
 ├─ Nota de Crédito · Notificación de disminución de deuda
 └─ Recibo / Pagaré / Cheque ·· Pago

 Como mínimo dos copias:
 ├─ Original (o cuerpo)   → para quien recibe el documento
 └─ Duplicado (o talón)   → para quien emite el comprobante

 IMPUESTO AL VALOR AGREGADO (IVA)
 ├─ Grava la venta de bienes o servicios
 └─ Recae sobre el consumidor final (impuesto al consumo)
     └─ EMPRESAS: responsables de cobrar el IVA en las ventas que realizan
         ├─ Compra → pagan IVA → IVA Crédito Fiscal
         ├─ Venta  → cobran IVA → IVA Débito Fiscal
         └─ Diferencia:
             ├─ Débito Fiscal > Crédito Fiscal → se debe a la AFIP
             └─ Crédito Fiscal > Débito Fiscal → saldo a favor de la empresa
                 (se compensa el mes siguiente)

 Categorías de sujetos:
 ├─ R.I.  — Responsable Inscripto: facturación anual superior al límite AFIP
 ├─ R.N.I. — Responsable No Inscripto: facturación anual inferior al límite AFIP
 ├─ Exentos — actividades eximidas por disposición especial
 ├─ Monotributo — régimen especial simplificado
 └─ Consumidor Final — sobre quién recae el impuesto

 FACTURACIÓN (alícuota general 21%)
 ├─ Factura A: de R.I. a R.I. o a R.N.I. ·········· con IVA discriminado
 ├─ Factura B: de R.I. a C.F., monot. o exento ···· incluye IVA pero no se discrimina
 └─ Factura C: de monot. o exento a cualquiera ···· no incluye IVA
```

---

*Fuente: capturas de apunte personal ("Educación Adultos 2000 · Contabilidad",
Unidad 2, buenosaires.gob.ar), transcriptas el 14/09/2026. Contenido
educativo general — no verificado contra normativa AFIP vigente ni contra el
código de `src/facturacion/` de este repo.*
