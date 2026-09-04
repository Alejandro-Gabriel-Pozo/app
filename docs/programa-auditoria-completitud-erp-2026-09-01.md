# Programa de auditoría end-to-end de completitud del ERP

**Versión:** 1.0 (borrador — en revisión por varios agentes, todavía no aplicado)
**Propósito:** detectar productos incompletos, operaciones sueltas y capacidades empresariales que no cierran su ciclo de negocio.
**Unidad de análisis:** módulo → capacidad → flujo de negocio → estados → efectos y evidencias.

## 1. Principio rector

Una funcionalidad no se considera completa porque tenga una pantalla, un endpoint o un test verde. Se considera completa cuando el usuario puede ejecutar el objetivo de negocio de principio a fin y el sistema conserva una representación coherente, auditable y recuperable de lo ocurrido.

> **Un ERP completo no solo registra una operación: la identifica, la ejecuta, la documenta, la relaciona, la audita, permite corregirla y la refleja en los saldos, reportes e integraciones que correspondan.**

La auditoría no debe confundirse con una auditoría de calidad de código. El código, los tests y la interfaz son fuentes de evidencia, pero el objeto principal es la **completitud empresarial**.

## 2. Inventario base de módulos

El inventario debe verificarse contra el menú, rutas, endpoints, entidades y configuración real del producto. Hasta esa verificación, los nombres de módulos se consideran inventario de trabajo, no hechos definitivos.

| ID | Módulo o capacidad | Flujo crítico principal | Estado inicial |
| --- | --- | --- | --- |
| M01 | Alojamiento / Reservas | disponibilidad → reserva → confirmación → estadía → checkout → cierre | ☐ |
| M02 | Clientes / Terceros | alta → identificación → actualización → uso comercial → historial → baja/fusión | ☐ |
| M03 | Turnos | disponibilidad → reserva → confirmación → atención → cierre → cancelación/no-show | ☐ |
| M04 | Cuentas Corrientes | deuda → imputación → pago → movimiento → recibo → reversión → conciliación | ◐ |
| M05 | Caja y medios de pago | apertura → ingreso/egreso → arqueo → cierre → diferencia → conciliación | ☐ |
| M06 | POS / Restaurante / Órdenes | orden → preparación → entrega → cobro → cierre → anulación | ☐ |
| M07 | Productos e Inventario | producto → stock → movimiento → reserva/consumo → ajuste → inventario | ☐ |
| M08 | Recursos | alta → disponibilidad → asignación → uso → mantenimiento → baja | ☐ |
| M09 | Housekeeping | tarea → asignación → ejecución → inspección → cierre | ☐ |
| M10 | Facturación | preparación → selección fiscal → emisión → validación → entrega → anulación/reimpresión | ⛔ |
| M11 | Reportes | origen → cálculo → filtro → exportación → reconciliación | ☐ |
| M12 | Configuración / Administración | configuración → vigencia → aplicación → auditoría → reversión | ☐ |
| T01 | Identidad y numeración | creación → asignación → presentación → búsqueda → histórico | Transversal |
| T02 | Usuarios y permisos | solicitud → autorización → ejecución → auditoría → revocación | Transversal |
| T03 | Auditoría y trazabilidad | hecho → actor → contexto → correlación → consulta | Transversal |
| T04 | Documentos | generación → numeración → entrega → consulta → reimpresión → anulación | Transversal |
| T05 | Integraciones | envío → recepción → idempotencia → reintento → reconciliación | Transversal |

## 3. Checklist común por flujo

Cada flujo debe auditarse con la misma pregunta. Una celda sin evidencia no debe marcarse como completa por inferencia.

### 3.1 Definición del negocio

| Pregunta | Evidencia esperada | Resultado |
| --- | --- | --- |
| ¿Está definido el objetivo del flujo? | Descripción del caso de uso y resultado esperado | ☐ |
| ¿Está identificado el actor? | Rol, usuario, proceso o integración | ☐ |
| ¿Está definido el inicio? | Evento que crea o activa el flujo | ☐ |
| ¿Está definido el final? | Condición de cierre observable | ☐ |
| ¿Están definidos los estados? | Máquina de estados o estados verificables | ☐ |
| ¿Están definidos los caminos alternativos? | Cancelación, rechazo, no-show, timeout, etc. | ☐ |

### 3.2 Identidad y datos

| Pregunta | Evidencia esperada | Resultado |
| --- | --- | --- |
| ¿Cada entidad tiene ID técnico estable? | Columna/UUID y relaciones | ☐ |
| ¿Existe identidad operativa cuando corresponde? | Número, código o referencia humana | ☐ |
| ¿La entidad tiene dueño y ámbito? | Tenant, compañía, sucursal, unidad o moneda | ☐ |
| ¿La nullability tiene semántica explícita? | Diferencia entre ausente, pendiente, inválido y no aplicable | ☐ |
| ¿Se conservan los datos necesarios para explicar la operación? | Snapshot o referencia histórica | ☐ |
| ¿Se evita usar UUID como identidad humana? | UI, documentos y reportes | ☐ |

### 3.3 Operaciones y ciclo de vida

| Pregunta | Evidencia esperada | Resultado |
| --- | --- | --- |
| ¿Existe alta o inicio formal? | UI, API y persistencia | ☐ |
| ¿Existe consulta posterior? | Listado, detalle, búsqueda y filtros | ☐ |
| ¿Existe modificación gobernada? | Reglas, permisos e historial | ☐ |
| ¿Existe confirmación o aprobación si corresponde? | Estado y segregación de funciones | ☐ |
| ¿Existe cancelación? | Estado y efectos reversibles | ☐ |
| ¿Existe anulación o reversión? | Hecho compensatorio sin borrar historia | ☐ |
| ¿El flujo es idempotente? | Clave de idempotencia o protección contra duplicados | ☐ |
| ¿Los fallos parciales tienen tratamiento? | Estado pendiente, reintento o compensación | ☐ |

### 3.4 Documentos, movimientos y saldos

| Pregunta | Evidencia esperada | Resultado |
| --- | --- | --- |
| ¿La operación genera el documento que el negocio necesita? | Recibo, factura, orden, nota, comprobante | ☐ |
| ¿El documento tiene identidad propia? | Número, fecha, estado y relación con origen | ☐ |
| ¿Puede consultarse y reimprimirse? | Endpoint, UI y documento histórico | ☐ |
| ¿El movimiento financiero tiene entidad propia? | Movimiento identificable e inmutable | ☐ |
| ¿El saldo se deriva de movimientos? | Consulta o cálculo reproducible | ☐ |
| ¿La corrección produce un movimiento inverso? | Reversión o ajuste vinculado | ☐ |
| ¿La operación aparece en reportes y cierres? | Reporte, caja, conciliación o exportación | ☐ |

### 3.5 Auditoría y trazabilidad

| Pregunta | Evidencia esperada | Resultado |
| --- | --- | --- |
| ¿Se sabe quién ejecutó la operación? | Actor y usuario | ☐ |
| ¿Se sabe cuándo ocurrió? | Fecha de negocio y fecha de registro | ☐ |
| ¿Se sabe desde dónde se ejecutó? | Pantalla, API, job o integración | ☐ |
| ¿Se conserva el antes y el después? | Audit log o historial funcional | ☐ |
| ¿Existe correlation ID? | Cadena de eventos relacionada | ☐ |
| ¿Puede navegarse desde el efecto hasta el origen? | Relaciones y enlaces de trazabilidad | ☐ |
| ¿El historial sobrevive a cambios maestros? | Snapshot o versionado | ☐ |

### 3.6 Permisos y control interno

| Pregunta | Evidencia esperada | Resultado |
| --- | --- | --- |
| ¿Quién puede crear? | Matriz RBAC y prueba | ☐ |
| ¿Quién puede aprobar? | Rol separado si el riesgo lo exige | ☐ |
| ¿Quién puede anular o revertir? | Permiso explícito y auditoría | ☐ |
| ¿Se evita que una sola persona controle todo el ciclo? | Segregación de funciones | ☐ |
| ¿Las exportaciones y documentos tienen protección? | Autorización y registro | ☐ |
| ¿Las acciones privilegiadas dejan motivo? | Motivo obligatorio y clasificación | ☐ |

### 3.7 UX y operación

| Pregunta | Evidencia esperada | Resultado |
| --- | --- | --- |
| ¿La pantalla distingue loading, vacío, error y no aplicable? | Estados visuales verificables | ☐ |
| ¿La pantalla muestra una identidad consistente? | Mismo helper y contrato | ☐ |
| ¿El usuario puede corregir sin tocar la base? | Flujo formal de corrección | ☐ |
| ¿Se informa qué ocurrió cuando una integración falla? | Mensaje y estado operativo | ☐ |
| ¿El soporte puede reconstruir un caso? | Detalle, auditoría y correlation ID | ☐ |
| ¿Existen logs, métricas y alertas suficientes? | Observabilidad operativa | ☐ |

## 4. Estados de evaluación

El estado del módulo y el estado de cada flujo deben mantenerse separados.

| Estado | Definición |
| --- | --- |
| ☐ No revisado | No se recorrió el flujo crítico. |
| ◐ En auditoría | Se está reconstruyendo el flujo y sus evidencias. |
| ⚠️ Revisado con brechas | El flujo fue recorrido y tiene faltantes documentados. |
| ◇ Parcial | La operación principal existe, pero no cierra documentos, auditoría, reversión o reportes. |
| ◎ Operación suelta | Un dato cambia o un endpoint actúa, pero no existe una entidad/ciclo que lo explique. |
| ◌ Huérfano | Existe entidad, endpoint o pantalla sin consumidor, origen o cierre. |
| ✅ Completo | Flujo crítico verificado de extremo a extremo y sus excepciones relevantes están gobernadas. |
| ⛔ Bloqueado | Depende de una fuente externa, dato de producción, decisión legal o proveedor. |
| — No aplica | Se justificó por qué la dimensión no corresponde. |

## 5. Evidencia y disciplina epistemológica

Cada afirmación debe marcarse como una de estas categorías:

| Marca | Significado | Cómo se cierra |
| --- | --- | --- |
| `[V]` | Hecho verificado en código, ejecución, base o producción | Cita de archivo/línea, comando, respuesta o captura. |
| `[P]` | Decisión o propuesta de diseño | Aprobación explícita del dueño. |
| `[H]` | Hipótesis no confirmada | Ejecución contra sistema externo, dato real o validación profesional. |

Una propuesta `[P]` no debe depender silenciosamente de una hipótesis `[H]`. Si depende, debe existir una alternativa que permita diseñar sin afirmar como hecho lo que aún no se confirmó.

## 6. Severidad

La severidad se asigna por impacto empresarial, no por dificultad de programación.

| Nivel | Criterio |
| --- | --- |
| S0 Crítica | Puede alterar dinero, saldos, documentos legales o datos sin posibilidad de corrección gobernada. |
| S1 Alta | Una operación diaria no tiene ciclo de vida, auditoría, documento o reversión suficiente. |
| S2 Media | El flujo existe, pero carece de consulta, reportes, permisos finos o manejo de excepción no crítico. |
| S3 Baja | Defecto de presentación, comodidad o automatización sin impacto sobre la verdad empresarial. |
| S4 Observación | Riesgo futuro o mejora sin impacto actual demostrado. |

## 7. Matriz maestra de resultados

Cada flujo auditado debe producir una ficha. No se debe marcar un módulo como completo mientras exista un flujo crítico S0 o S1 abierto.

```
Módulo:
Flujo crítico:
Owner del flujo:
Estado del módulo:
Estado del flujo:
Último paso confirmado:
Primer paso incompleto:
Severidad máxima:

Entidades involucradas:
IDs técnicos:
IDs operativos:
Documentos:
Movimientos/saldos:
Permisos:
Integraciones:
Auditoría:
Reportes/conciliación:

Hechos [V]:
Decisiones [P]:
Hipótesis [H]:

Brechas:
Impacto:
Dependencias:
Bloqueos externos:
Bloque de implementación sugerido:
Criterios de cierre:
```

Matriz de síntesis:

| Módulo | Flujo | Estado | Severidad | Brecha principal | Evidencia | Próximo bloque |
| --- | --- | --- | --- | --- | --- | --- |
| Cuentas Corrientes | Pago | ⚠️ | S0/S1 | Reversión, atribución, recibo y conciliación | `[V]` auditoría de pagos | Diseñar D+A |
| Reservas | Ciclo de reserva | ☐ | — | Por auditar | — | — |
| Clientes | Alta y mantenimiento | ☐ | — | Por auditar | — | — |
| Turnos | Crear-atender-cerrar | ☐ | — | Por auditar | — | — |
| Facturación | Emitir-anular | ⛔ | — | Dependencia fiscal/ARCA | `[H]` | Mantener HOLD |

## 8. Aplicación inicial: Cuentas Corrientes

El primer flujo debe ser:

```
Deuda
→ imputación
→ intención de pago
→ medio, moneda e importe
→ confirmación
→ movimiento
→ saldo
→ recibo
→ consulta y reimpresión
→ anulación/reversión
→ auditoría
→ reporte y conciliación
```

La conclusión preliminar del flujo de pagos es:

> **Cuentas Corrientes queda `⚠️ Revisado con brechas`, no completo.** El registro del pago y el cálculo del saldo existen parcialmente, pero el producto no cierra todavía la corrección de errores, la atribución del cobrador, el documento de respaldo, la auditoría del ledger, la segregación de funciones ni la conciliación.

Las decisiones previas para diseñar el siguiente bloque son:

| Decisión | Recomendación inicial |
| --- | --- |
| Reversión de pago mal cargado | Crear una reversión vinculada al pago original; no editar ni borrar. |
| `REFUND` versus reversión | `REFUND` solo para devolución real de fondos; usar `PAYMENT_REVERSAL` o `VOID` para corrección. |
| Corrección del cliente | Revertir el pago mal imputado y crear uno nuevo; nunca cambiar el titular del original. |
| Motivo | Obligatorio, clasificado y auditable. |
| Auditoría | Actor, timestamp, origen, motivo, antes/después y correlation ID. |
| Idempotencia | Una misma solicitud de reversión no puede producir dos movimientos. |
| Segregación | Cajero registra; supervisor aprueba reversiones confirmadas o sobre umbral. |
| Recibo sin factura | Recibo no fiscal o constancia interna, sujeto a validación profesional. |

## 9. Orden de auditoría

Para trabajar rápido sin perder profundidad, el orden recomendado es:

1. Auditar el flujo financiero más riesgoso: Cuentas Corrientes y pagos.
2. Auditar Caja y medios de pago, porque depende de pagos, cierres y conciliación.
3. Auditar Facturación, manteniendo separadas las hipótesis fiscales.
4. Auditar Reservas y Alojamiento.
5. Auditar POS/Órdenes, Productos/Inventario y Recursos.
6. Auditar Clientes, Turnos y Housekeeping.
7. Auditar Reportes, Configuración e Integraciones como capacidades transversales.

Los módulos pueden auditarse en paralelo cuando sus flujos no compartan saldos, documentos, permisos críticos o datos maestros. La implementación, en cambio, debe priorizar brechas transversales que afectan varios módulos.

## 10. Regla de cierre

Un módulo se puede marcar como `✅ Completo` únicamente cuando:

- su flujo crítico tiene inicio y cierre definidos;
- todas las entidades relevantes tienen identidad;
- los estados principales y alternativos son explícitos;
- las operaciones diarias pueden corregirse sin tocar la base;
- los documentos y movimientos necesarios existen;
- los saldos y reportes son coherentes;
- la auditoría permite responder quién, qué, cuándo, cómo y por qué;
- los permisos son adecuados;
- los errores y reintentos están gobernados;
- y la evidencia distingue hechos, decisiones e hipótesis.

Si una dimensión no fue verificada, el estado correcto no es "completo": es "no verificable" o "revisado con brecha".

## 11. Encargo para el agente

> Realizá una auditoría de completitud funcional, contable y de trazabilidad por módulo y por flujo de negocio. No hagas una revisión archivo por archivo ni implementes mientras auditás. Para cada módulo, elegí sus flujos críticos, recorré el ciclo completo y completá la ficha estándar. Verificá producto, entidades, estados, IDs, operaciones, documentos, movimientos, saldos, permisos, auditoría, errores, idempotencia, integraciones, reportes y experiencia de usuario. Marcá cada afirmación como `[V]`, `[P]` o `[H]`. No conviertas una hipótesis en hecho y no cierres un módulo si tiene un flujo S0 o S1 abierto. Empezá por Cuentas Corrientes, con el flujo deuda → pago → movimiento → saldo → recibo → reversión → conciliación. Registralo como `⚠️ Revisado con brechas` mientras falten reversión gobernada, atribución, recibo o conciliación. Después continuá módulo por módulo sin detenerte para implementar cada hallazgo. Entregá una matriz maestra, fichas por módulo, severidad, evidencia, dependencias, bloques de implementación y criterios de cierre. No toques código, schema, producción, permisos ni commits hasta que el mapa de brechas completo sea revisado.

## 12. Resultado esperado

El resultado de esta auditoría no es una lista de bugs. Es un **mapa de madurez del ERP** que permite distinguir:

- qué capacidades ya son confiables;
- qué operaciones funcionan solo parcialmente;
- qué datos cambian sin una historia empresarial completa;
- qué módulos tienen pantallas pero no cierran el proceso;
- qué decisiones requieren al dueño del producto;
- qué dependencias son externas;
- y qué bloques de construcción transversal pueden resolver brechas en varios módulos.

La auditoría termina cuando existe una visión completa de la realidad del ERP, no cuando todos los módulos reciben un tilde. El objetivo es poder decir con precisión: **"este módulo está completo en este flujo, incompleto en este otro, por esta causa, con esta evidencia y con este impacto"**.
