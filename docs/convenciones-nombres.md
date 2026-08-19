# Convención de nombres propuesta

> Complementa `docs/auditoria-modularidad.md` (sección de nomenclatura,
> hallazgos N1-N7). Se escribe este documento aparte porque SÍ se encontró
> ambigüedad real, no como ejercicio preventivo.
>
> **Advertencia de riesgo:** renombrar/mover archivos cambia las rutas de
> import en todo el repo. Ningún renombre de este documento se aplicó
> todavía — es una propuesta para decidir junto con el roadmap de
> `auditoria-modularidad.md`. Cuando se apruebe, usar el refactor
> automatizado del editor (VS Code: clic derecho → "Rename Symbol" / arrastrar
> el archivo en el explorador, que ya actualiza imports) o un script con
> `ts-morph`/`jscodeshift` en vez de mover archivos y corregir imports a
> mano — con 10-60 importadores por archivo (ver fan-in en el informe
> principal), un import olvidado solo se nota en el build, no al leer el
> diff.

---

## El patrón que el propio repo ya usa bien (backend)

La mayoría de `app-main/src` ya sigue una convención implícita, consistente
en la mayoría de los módulos:

```
<entidad>.<capa>.ts
```

Ejemplos reales que ya cumplen el patrón:

| Archivo | Entidad | Capa |
|---|---|---|
| `src/reservas/reservation.service.ts` | reservation | service |
| `src/reservas/sql.reservation.repository.ts` | reservation | repository (impl. SQL) |
| `src/reservas/in-memory.reservation.repository.ts` | reservation | repository (impl. en memoria, para tests) |
| `src/api/mappers/reservation.mapper.ts` | reservation | mapper |
| `src/clientes-finanzas/customer.entities.ts` | customer | entities |
| `src/pos-menu/product.service.ts` | product | service |

El prefijo `sql.`/`in-memory.` antes de la entidad para distinguir
implementaciones de una misma interfaz (`reservation.repository.ts` es la
interfaz, `sql.reservation.repository.ts` y
`in-memory.reservation.repository.ts` son sus dos implementaciones) es un
patrón bueno y consistente en TODO el backend — no se propone cambiarlo.

**La convención propuesta abajo no reemplaza este patrón — lo completa** para
los casos donde ya se desvía (entidades sin sufijo de capa) y para el
frontend, que hoy no tiene ningún patrón de este tipo.

---

## Patrón recomendado

### Backend — entidades de dominio (clases ricas)

```
<entidad-en-minúscula>.entities.ts     (ya es el patrón mayoritario)
```

**Antes → Después:**

| Antes | Después | Módulo |
|---|---|---|
| `src/reservas/Reservation.ts` | `src/reservas/reservation.entities.ts` | reservas |
| `src/pms-estadias/stay.ts` | `src/pms-estadias/stay.entities.ts` | pms-estadias |
| `src/pms-estadias/housekeeping-task.ts` | `src/pms-estadias/housekeeping-task.entities.ts` | pms-estadias |

Nota: `Reservation.ts` es además el único archivo del backend en PascalCase
sin sufijo — el cambio de nombre de archivo (a minúscula + sufijo) es
independiente de si la clase exportada sigue llamándose `Reservation` (debe
seguir así, es el nombre de la entidad, no del archivo).

**Riesgo de este renombre específico:** 🟡 Medio. `Reservation.ts` tiene
fan-in considerable (se importa desde `reservation.service.ts`,
`sql.reservation.repository.ts`, `in-memory.reservation.repository.ts`,
`api/mappers/reservation.mapper.ts`, `reservations.routes.ts`, y varios
tests) — no es el archivo con más importadores del repo, pero sí uno de los
más centrales. Usar "Rename" del editor, no buscar/reemplazar a mano.

### Backend — tipos que pertenecen a un módulo específico

Regla: **si todos los importadores de un archivo `*.types.ts` viven dentro
de un mismo módulo, el archivo vive en ese módulo — no en `src/types/`.**
`src/types/` queda reservado para lo genuinamente transversal (`enums.ts`,
`visual.interface.ts`, `express.d.ts`).

**Antes → Después:**

| Antes | Después | Evidencia (importadores) |
|---|---|---|
| `src/types/bookable-service.types.ts` | `src/reservas/bookable-service.types.ts` | 5/5 importadores dentro de `src/reservas/` |
| `src/types/resource-category.types.ts` | `src/reservas/resource-category.types.ts` | 4/4 importadores dentro de `src/reservas/` |

**Riesgo:** 🟢 Bajo — 4-5 importadores cada uno, todos ya en el mismo módulo
destino. Es mover un archivo y actualizar rutas relativas, sin cambiar
ningún nombre de símbolo exportado.

### Backend — desambiguar los dos routers "customer"

| Antes | Después | Por qué |
|---|---|---|
| `src/api/routes/customer.routes.ts` | `src/api/routes/customer-portal.routes.ts` | Dejar explícito en el nombre que es el portal público (registro/login/gestión propia), no el CRUD de staff — hoy solo el singular/plural distingue los dos archivos. |
| `src/clientes-finanzas/customers.routes.ts` | *(sin cambio — ya es correcto dentro de su módulo)* | Vive en `clientes-finanzas/`, la carpeta ya lo contextualiza; el problema era solo la confusión CON el otro archivo. |

**Riesgo:** 🟢 Bajo — un solo archivo renombrado, imports acotados a
`app.ts`/tests que registran las rutas.

### Backend — módulo de un solo archivo con nombre genérico

| Antes | Después | Por qué |
|---|---|---|
| `src/services/report.service.ts` | `src/services/occupancy-report.service.ts` (o mover a `src/reservas/` si se confirma que ocupación es 100% de ese módulo) | El nombre actual no dice qué se reporta; el contenido (`OccupancyReportRow`, `OccupancySummary`) es específico de ocupación de recursos. |

**Riesgo:** 🟢 Bajo — módulo con pocos importadores (confirmar con grep antes
de mover, no se midió fan-in exacto en esta auditoría).

### Backend — limpieza (no es un renombre, es un borrado)

| Archivo | Acción |
|---|---|
| `src/reservas/supabase.occupancy.repository.ts` | Borrar — código muerto, 0 importadores reales, import roto. |
| `src/security/express.d.ts` | Borrar — stub vacío, ya documentado en el propio archivo como candidato a eliminar. |

---

### Frontend — el problema no es el nombre de archivo, es la falta de carpetas por dominio

`appfrontend-main/src/lib/types.ts` y `.../lib/api.ts` no están mal
*nombrados* en el sentido literal (son razonables para "el archivo de tipos"
y "el archivo de API" si solo hubiera un dominio) — el problema es que
**no existe ninguna subdivisión por módulo de negocio**, a diferencia del
backend, que si tiene carpetas (`reservas/`, `pms-estadias/`,
`clientes-finanzas/`...). Se propone reproducir esa misma división en
`lib/`:

```
src/lib/
  http.ts                    ← fetch base + manejo de error + interceptor de sesión (hoy duplicado en api.ts/platformApi.ts)
  reservas/
    types.ts                 ← Reservation, ReservationStatus
    api.ts                   ← reservationsApi
  turnos/                    ← si se separa de reservas (ver Fase 4 del roadmap)
  housekeeping/
    types.ts                 ← HousekeepingTask, HousekeepingStatus, LateCheckout
    api.ts                   ← housekeepingApi
  estadias/
    types.ts                 ← Stay, StayStatus, StayFolio, CheckInInput, CheckOutInput
    api.ts                   ← staysApi
  productos/
    types.ts                 ← Product, ProductVariant, RecipeItem, ProductType
    api.ts                   ← productsApi (y las de receta/producción si existen ahí)
  ordenes/
    types.ts                 ← Order, OrderItem, OrderStatus
    api.ts                   ← ordersApi
  clientes/
    types.ts                 ← Customer (DTO del panel admin — ver nota abajo), CustomerRate, CustomerTag
    api.ts                   ← customersApi
  finanzas/
    types.ts                 ← FinancialTransaction, AccountReceivable, TransactionStatus
    api.ts                   ← (repartir según corresponda)
  empresa/
    types.ts                 ← Company, CompanyLink, CompanyProduct
    api.ts                   ← companiesApi
  catalogo/
    types.ts                 ← Category, CategoryField, WasteReason
    api.ts                   ← categoriesApi, wasteReasonsApi
  usuarios/
    types.ts                 ← Role, TeamMember
    api.ts                   ← usersApi
  reservas-servicios/         ← o el nombre que corresponda: BookableService, RatePlan, ResourceLock
    types.ts
    api.ts
```

El nombre exacto de cada subcarpeta debe coincidir 1:1 con el nombre del
módulo de negocio del backend cuando exista una correspondencia clara (ej.
`reservas/`, `pos-menu/` → `productos/` u `ordenes/`) — así un desarrollador
que ya conoce la estructura del backend puede predecir dónde está cada tipo
del frontend sin buscarlo.

**Sobre `Customer` en el frontend (hallazgo N7):** este documento no
propone que el frontend deje de tener su propio DTO de `Customer` — es
correcto que NO importe la clase de dominio del backend. Se propone que,
al mover el tipo a `src/lib/clientes/types.ts`, se lo renombre a algo que
dejara explícito que es una proyección para el panel admin, ej.
`CustomerAdminView` o simplemente confiar en que la carpeta `clientes/` ya
da el contexto y dejarlo como `Customer` (ambas opciones son razonables —
es una decisión de estilo, no un hallazgo de severidad alta, así que se
deja abierta para cuando se aborde la Fase 5 del roadmap).

**Riesgo de este cambio en particular:** 🔴 Alto — es exactamente la Fase 5
del roadmap de `auditoria-modularidad.md`. `types.ts` tiene 63 exports y
`api.ts` decenas de funciones, importados desde las 17 pantallas del
dashboard + 9 componentes. **Usar refactor automatizado del editor (mover
archivo con "Update imports on file move" activado en VS Code/TypeScript) o
un script de `ts-morph`, nunca mover a mano.** Se puede hacer incremental
(un dominio por vez, empezando por el más chico — ej. `catalogo/` o
`clientes/` — para validar el patrón antes de mover `reservas/`, el más
grande).

---

## Resumen — archivos/símbolos a renombrar o mover

| # | Archivo actual | Acción | Riesgo | Fase del roadmap |
|---|---|---|---|---|
| 1 | `src/reservas/Reservation.ts` | Renombrar a `reservation.entities.ts` | 🟡 Medio | No asignada — evaluar junto al dueño si vale la pena solo por consistencia (bajo beneficio, ver nota abajo) |
| 2 | `src/pms-estadias/stay.ts` | Renombrar a `stay.entities.ts` | 🟢 Bajo | No asignada |
| 3 | `src/pms-estadias/housekeeping-task.ts` | Renombrar a `housekeeping-task.entities.ts` | 🟢 Bajo | No asignada |
| 4 | `src/types/bookable-service.types.ts` | Mover a `src/reservas/` | 🟢 Bajo | Fase 2 |
| 5 | `src/types/resource-category.types.ts` | Mover a `src/reservas/` | 🟢 Bajo | Fase 2 |
| 6 | `src/api/routes/customer.routes.ts` | Renombrar a `customer-portal.routes.ts` | 🟢 Bajo | No asignada |
| 7 | `src/services/report.service.ts` | Renombrar/mover (confirmar destino) | 🟢 Bajo | No asignada |
| 8 | `src/reservas/supabase.occupancy.repository.ts` | Borrar | 🟢 Mínimo | Fase 1 |
| 9 | `src/security/express.d.ts` | Borrar | 🟢 Mínimo | Fase 1 |
| 10 | `appfrontend-main/src/lib/types.ts` + `lib/api.ts` | Dividir en `lib/<dominio>/types.ts` + `api.ts` (ver árbol arriba) | 🔴 Alto | Fase 5 |

**Nota sobre los items 1-3 y 6-7:** son de bajo beneficio relativo (no
reducen duplicación ni acoplamiento, solo mejoran consistencia de lectura) —
se marcan explícitamente como **"no asignados a ninguna fase todavía"**
porque el costo de renombrar (aunque sea bajo) no se justifica solo por
estética. Se recomienda agruparlos con la Fase 2 (que ya toca imports) o
descartarlos si el dueño prefiere no tocar nada que no aporte beneficio
medible.
