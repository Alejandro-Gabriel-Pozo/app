# Referencia externa — Especificación de mejoras PMS (adultos/niños, exportación, dashboard)

> Documento de referencia, no de implementación — backlog de requisitos
> nuevos, ninguno con código escrito todavía. Fuente original:
> `C:\Users\Usuario\Downloads\Anotaciones PMS\especificacion_funcional_PMS.md`
> (+ el anexo `docs/referencia-mejoras-pms-2026-08-18-anexo.md`), agregado
> acá el 18/08/2026 para que no dependa de una carpeta fuera del repo.
> Referenciado desde `roadmap-pms-multirubro.md`, secciones "Housekeeping y
> Mantenimiento" y "Reportes y estadísticas".

---

# Especificación Funcional — Mejoras PMS

## 1. Diagnóstico UX inicial

### Aciertos de tu aplicación
- **Carga cognitiva baja y diseño limpio**: uso de espacio en blanco y tipografía clara que reduce fatiga visual, frente al sistema legacy que satura de información simultánea.
- **Flujos de trabajo orientados a la acción**: vista de lista y modal de check-in con botones claros ("Confirmar", "Cancelar") que guían la tarea.
- **Interactividad moderna**: calendario con drag & drop ("Arrastrá una reserva...") frente a sistemas legacy que requieren múltiples clics.

### Áreas de mejora identificadas
- **Métricas clave y densidad de información**: falta un dashboard con ocupación %, ingresos y plazas restantes, como el "Cuadro de Mando" del sistema de referencia.
- **Mapeo visual de housekeeping**: los indicadores actuales (círculos pequeños) son demasiado sutiles frente a bloques de color grandes del legacy.
- **Indicadores de estado en el calendario**: falta reflejar pagado / check-in realizado / saldo pendiente con badges o bordes de color.

---

## 2. Fundamentos y mejores prácticas

### Cómo calcular ADR y RevPAR
- **ADR** = Ingresos por habitaciones ÷ Habitaciones vendidas.
- **Ocupación %** = (Habitaciones ocupadas ÷ Habitaciones disponibles) × 100.
- **RevPAR** = ADR × Ocupación (decimal), equivalente a Ingresos totales por habitaciones ÷ Habitaciones disponibles.
- Clave: "habitaciones disponibles" debe excluir las que están fuera de servicio por mantenimiento ese día.

### Diseño de dashboards
- No mostrar una métrica aislada: combinar ocupación, ADR y RevPAR evita decisiones erróneas (alta ocupación con tarifas bajas puede rendir menos que ocupación media con tarifas altas).
- Métricas adicionales recomendadas: GOPPAR, TRevPAR, plazas restantes en tiempo real.

### Mejores prácticas UI housekeeping
- Priorizar habitaciones por lógica operativa: check-out con llegada el mismo día > check-out simple > stayover.
- Bloques de color grandes por estado, agrupados por piso, con cambio de estado en una sola interacción.
- Estado "No molestar" debe registrarse con marca de tiempo, no descartarse silenciosamente.

### Cómo armar una especificación funcional
- Introducción: objetivo, usuarios afectados, alcance.
- Descripción general: módulos involucrados e interacción entre ellos.
- Requisitos funcionales: actor, entrada, lógica interna, salida esperada.
- Reglas de negocio: condiciones específicas del modelo.
- Exclusiones: qué queda fuera de esta fase.

### Métricas clave de la industria hotelera
- Ocupación %, ADR, RevPAR, GOPPAR, TRevPAR, plazas restantes, adultos/niños totales por día.

---

## 3. Especificación funcional unificada

### 3.1 Integración Housekeeping ↔ Calendario ↔ Disponibilidad
**Regla de negocio**: una habitación marcada "En reparación/mantenimiento" en housekeeping debe:
- Bloquear automáticamente esas fechas en el calendario de reservas.
- Restarse del total de habitaciones disponibles usado en ocupación, ADR y RevPAR ese día.
- Sincronizarse como fuente única de verdad (sin registros duplicados entre módulos).
- Los reportes de ocupación deben poder mostrarse con y sin habitaciones fuera de servicio (OOO).

### 3.2 Tooltip enriquecido en el calendario
Debe mostrar todos los campos relevantes de la reserva sin abrir modal:

| Campo | Estado actual |
|---|---|
| Huésped, ingreso, egreso | Ya existe |
| Adultos y niños (desagregados) | Falta — ver 3.3 |
| Origen de la reserva | A confirmar |
| Tarifa/tarifario, producto | A confirmar |
| Observaciones internas | Ya existe |

### 3.3 Adultos y niños como campo estructurado
- Modelo de datos: columnas separadas `adultos` (entero) y `niños` (entero), no texto libre.
- Visualización: "Adultos: 2 · Niños: 1" en tooltip del calendario y modal de check-in.
- Reportabilidad: todo reporte de reservas u ocupación debe incluir columnas de adultos y niños, totalizables por día/rango.

### 3.4 Exportación a PDF y Excel

| Reporte | Formato | Debe incluir |
|---|---|---|
| Listado de reservas | PDF y Excel | Filtros activos + columnas adultos/niños |
| Plano/resumen de ocupación | PDF y Excel | Fecha, entradas, salidas, ocupadas, bloqueadas (OOO), libres, % ocupación, adultos/niños totales |
| Reporte de housekeeping | PDF | Estado por habitación y turno |

- Botón de exportación con dropdown (PDF/Excel) en la parte superior de cada reporte, respetando filtros activos.

### 3.5 Dashboard de métricas
- Ocupación %, ADR, RevPAR (con y sin OOO), plazas restantes.
- Idealmente desagregado por adultos/niños totales del día.

---

## 4. Ticket final para el developer

| # | Requisito | Prioridad |
|---|---|---|
| 1 | Sincronizar housekeeping-mantenimiento con calendario y cálculo de disponibilidad | Alta |
| 2 | Agregar campos estructurados `adultos` y `niños` en el modelo de reserva | Alta |
| 3 | Enriquecer tooltip del calendario con todos los campos de la reserva | Alta |
| 4 | Exportación PDF/Excel en reportes de reservas y ocupación | Media |
| 5 | Dashboard con ocupación, ADR, RevPAR (con/sin OOO) y plazas restantes | Media |
| 6 | Housekeeping con bloques de color grandes por estado | Baja |
