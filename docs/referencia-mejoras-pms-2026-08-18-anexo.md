# Anexo — Detalle completo de adultos/niños y exportación PDF/Excel

> Complementa `referencia-mejoras-pms-2026-08-18.md`. Fuente original:
> `C:\Users\Usuario\Downloads\Anotaciones PMS\anexo_adultos_ninos_exportacion.md`,
> agregado acá el 18/08/2026.

---

# Anexo Complementario — Detalle Completo de Requisitos

Este documento complementa `especificacion_funcional_PMS.md` con el desarrollo completo de cada punto, sin resumir.

## A. Adultos y niños — desarrollo completo

### Problema actual
Hoy la reserva no distingue cantidad de adultos y niños como datos estructurados. Esto impide:
- Mostrarlo en el tooltip del calendario.
- Sumarlo o filtrarlo en reportes.
- Usarlo para cálculos de ocupación por persona (no solo por habitación).

### Cambio de modelo de datos requerido
- Agregar a la tabla/entidad de reserva dos columnas numéricas independientes:
  - `adultos` (entero, obligatorio, mínimo 1)
  - `ninos` (entero, opcional, default 0)
- No usar un campo de texto libre ni combinarlo dentro de "observaciones". Debe ser un dato consultable con SQL directo (SUM, GROUP BY, etc.), igual a como lo hacen sistemas como Cloudbeds al exportar el número exacto de huéspedes por reserva.

### Dónde debe aparecer
1. **Formulario de nueva reserva / edición**: dos campos numéricos, "Adultos" y "Niños", junto a fechas y habitación.
2. **Tooltip del calendario**: línea "Adultos: 2 · Niños: 1" junto a huésped y fechas.
3. **Modal de check-in**: mostrar el dato heredado de la reserva, editable si hubo cambio de última hora.
4. **Tarjeta de housekeeping** (opcional): útil para el personal de limpieza saber cuántas personas ocupan la habitación.

### Impacto en reportes
- Todo reporte de reservas debe agregar columnas `Adultos` y `Niños` por fila.
- El reporte de ocupación debe poder totalizar "Total huéspedes del día" = suma de adultos + niños de todas las reservas activas ese día, siguiendo el patrón de reportes de ocupación estándar de la industria (occupancy summary con breakdown de personas).
- Debe permitir filtrar/segmentar reservas por rango de adultos o presencia de niños (ej. para detectar demanda familiar).

---

## B. Exportación a PDF y Excel — desarrollo completo

### Principio de diseño
Excel se usa para análisis y manipulación de datos (tablas dinámicas, filtros propios del usuario); PDF se usa para impresión, archivo formal y envío a terceros. Por eso ambos formatos deben coexistir, no reemplazarse entre sí.

### Reportes que deben ser exportables

**1. Listado de reservas**
- Formato: PDF y Excel.
- Debe exportar exactamente lo que está filtrado en pantalla (por cliente, por estado, por rango de fechas).
- Columnas mínimas: Cliente, Recurso/Habitación, Check-in, Check-out, Precio, Estado, Adultos, Niños.

**2. Plano / resumen de ocupación**
- Formato: PDF y Excel.
- Debe incluir, por cada día del rango consultado:
  - Total habitaciones habitadas
  - Total reservadas
  - Porcentaje de ocupación
  - Total disponible
  - Total publicado
  - Plazas restantes
  - Total adultos y total niños alojados ese día
- Debe ofrecer la variante "con habitaciones OOO (fuera de servicio)" y "sin OOO", para no distorsionar el % de ocupación real.

**3. Reporte de housekeeping**
- Formato: PDF (prioritario, para imprimir y repartir al personal de limpieza en papel).
- Debe incluir: habitación, estado, turno, adultos/niños (opcional), y notas del housekeeper.

### Comportamiento del botón de exportación
- Ubicado en la esquina superior derecha de cada tabla/reporte.
- Al hacer clic, mostrar un menú desplegable con dos opciones: "Exportar a PDF" y "Exportar a Excel (.xlsx)".
- El archivo generado debe:
  - Respetar los filtros y el rango de fechas activos en la vista actual.
  - Incluir encabezado con nombre del alojamiento y fecha/hora de generación del reporte.
  - Nombrarse automáticamente con un patrón claro, ej. `ocupacion_2026-08-18_2026-09-17.xlsx`.

### Consideración técnica para el developer
- Para Excel: generar archivos `.xlsx` reales (no CSV renombrado), para que se puedan usar fórmulas y formato de columnas.
- Para PDF: mantener la tabla legible en una página apaisada (landscape) cuando el reporte tenga muchas columnas, como el plano de ocupación.

---

## C. Checklist de validación para QA

- [ ] El campo `adultos` no permite valor 0 o vacío.
- [ ] El campo `ninos` acepta 0 sin error.
- [ ] El tooltip del calendario muestra adultos y niños sin necesidad de abrir el modal.
- [ ] El reporte de reservas exportado a Excel contiene las columnas Adultos y Niños.
- [ ] El reporte de reservas exportado a PDF respeta los filtros de estado activos en pantalla.
- [ ] El plano de ocupación exportado muestra el total de adultos y niños alojados por día.
- [ ] Existe la opción de ver ocupación "con OOO" y "sin OOO" en el mismo reporte.
