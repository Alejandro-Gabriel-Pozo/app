# Plan — Hacer el sistema multi-rubro

La arquitectura de fondo (`ResourceCategory` + `BookableService` con
`bookingMode: slot/block/event`) ya está diseñada para multi-rubro. Lo que
falta es limpiar restos del modelo viejo (hotelería/gastronomía hardcodeada)
y, más adelante, algunas decisiones de diseño para cuando sumes rubros reales.

---

## 🔴 Bloqueante real (1 solo)

### `report.service.ts` → `generateOccupancyByResourceType()`

Hoy adivina el tipo de recurso mirando el **nombre** del recurso:

```ts
if (stat.resourceName.toLowerCase().includes('cabin') || ...) type = 'CABIN';
else if (stat.resourceName.toLowerCase().includes('mesa') || ...) type = 'RESTAURANT_TABLE';
else if (stat.resourceName.toLowerCase().includes('spa') || ...) type = 'SPA';
else if (stat.resourceName.toLowerCase().includes('tour') || ...) type = 'TOUR_SEAT';
else type = 'OTHER';
```

Un salón con un recurso llamado "Silla 1" o "Box 2" siempre cae en `OTHER`.

**Cambio:** reemplazar el heurístico por agrupar directamente por
`categoryId` / `categoryName` — el dato real que ya existe en cada
`Resource`, en vez de adivinar por substring del nombre.

---

## 🟡 Documentación desactualizada (no rompe nada, pero confunde)

### `openapi/spec.ts` línea 227

Documenta una ruta que ya no existe:

```ts
'/api/resources/type/{type}': {
  get: {
    ...
    schema: { type: 'string', enum: ['CABIN', 'RESTAURANT_TABLE', 'SPA', 'TOUR_SEAT'] },
```

`resources.routes.ts` ya reemplazó `getByType(type)` por
`getByCategory(categoryId)` — este bloque del Swagger es un endpoint
fantasma que además sesga la percepción del producto hacia hotelería.

**Cambio:**
- Borrar esa entrada del spec.
- Agregar un ejemplo de categoría no hotelera (ej. "Corte de pelo" o "Turno
  peluquería") junto al de "Cabaña" que ya existe en el spec, para que la
  documentación no quede sesgada a un solo rubro.

---

## 🟢 Decisiones de diseño — no son bugs, para cuando sumes el 2do/3er rubro real

### 1. Roles fijos por tenant

`UserRole` incluye `HOUSEKEEPING` y `WAITER` como valores del enum global.
Para un salón esos roles simplemente no se usan — no rompen nada, pero
tampoco tiene sentido que un negocio de barbería vea "Housekeeping" en su
panel.

No es urgente. Si en algún momento el onboarding muestra roles al dueño del
negocio, ahí sí conviene filtrar por rubro.

### 2. Módulos siempre montados

`/api/housekeeping` y `/api/stays` se montan siempre, para todos los
tenants, tengan o no sentido para su rubro. Hoy es inofensivo (un salón
simplemente no los usa), pero si a futuro el rubro define qué módulos ve un
negocio en el panel, conviene un flag tipo `business.features` en vez de
"éstá todo montado siempre".

### 3. `Business` sin campo de rubro/industria

No hace falta para que el backend funcione — las categorías son 100%
dinámicas. Pero si más adelante querés precargar categorías sugeridas al
dar de alta un negocio nuevo ("Salón de belleza" → sugiere "Corte",
"Color", "Manicura"), ahí conviene agregarlo como metadata opcional.

---

## Orden sugerido

| # | Cambio | Prioridad | Por qué |
|---|--------|-----------|----------|
| 1 | Fix heurístico en `report.service.ts` | 🔴 Alta | Reportes rotos para cualquier rubro que no sea hotel/restaurante |
| 2 | Limpiar `/type/{type}` fantasma del OpenAPI | 🟡 Media | No rompe nada, pero confunde a quien consuma la API |
| 3 | Roles y módulos por feature flag | 🟢 Baja | Solo cuando el panel/UI empiece a diferenciar por rubro |
| 4 | Campo de rubro en `Business` (metadata) | 🟢 Baja | Solo si vas a hacer onboarding con categorías sugeridas |

Con el ítem 1 resuelto, el sistema ya sirve tal cual para el cliente de
salón/spa. El resto es pulido de UX/onboarding, no técnica de fondo.
