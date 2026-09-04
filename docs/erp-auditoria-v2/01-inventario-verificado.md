# Inventario verificado de módulos

**Fecha:** 02/09/2026 · **Método:** `00-programa-v2.md` §2
**Derivado de:** `datos/endpoints.csv`, `datos/montajes.csv`,
`datos/consumo-frontend.csv`, `datos/cobertura.csv`, `datos/uso-tablas.csv`,
`src/db/schema.sql`, `src/db/platform.schema.sql` y
`appfrontend-main/src/app/**/page.tsx`.

Este documento reemplaza el "inventario de trabajo" de v1, que era una lista
propuesta. Acá cada fila tiene las tres columnas de existencia: **router
montado**, **tabla propia**, **pantalla**. Ese cruce es en sí mismo un
resultado: cinco módulos fallan en al menos una de las tres.

---

## 1. Números base `[V]`

| Medida | Valor | Cómo se obtuvo |
|---|---|---|
| Endpoints declarados | **245** | `datos/endpoints.csv`; invariante contra el grep crudo: 245 = 245 |
| Prefijos montados en `app.ts` | 42 filas (35 prefijos distintos) | `datos/montajes.csv` |
| Llamadas HTTP del frontend | 202 | `datos/consumo-frontend.csv` |
| Endpoints **sin consumidor conocido** | **51** de 245 (21 %), de los cuales 5 son falso positivo conocido (ver `00-programa-v2.md` §3.1) → **46** reales a confirmar | `datos/cobertura.csv`, columna `consumidores == "-"` |
| Tablas del schema de tenant | 49 | `src/db/schema.sql` |
| Tablas del schema de plataforma | 23 | `src/db/platform.schema.sql` |
| Tablas sin uso fuera de `src/db/` | 0 | `datos/uso-tablas.csv` |
| Pantallas (`page.tsx`) | 50 | `appfrontend-main/src/app` |
| Módulos de negocio conmutables (`ModuleKey`) | 6 | `src/types/enums.ts:86` |

El 21 % de endpoints sin consumidor es el número más informativo de la tabla, y
también el más fácil de malinterpretar: **no** son 51 endpoints muertos. Son 51
lugares donde hay que mirar. La ficha de cada módulo los resuelve uno por uno.

---

## 2. Inventario

Leyenda de las tres columnas de existencia: `sí` / `no` / `parcial`.

| ID | Módulo | Router | Tabla | Pantalla | Endpoints | Ficha |
|---|---|---|---|---|---|---|
| M01 | Reservas (alojamiento) | sí | sí | sí | 15 | `fichas/M01-reservas.md` |
| M02 | Clientes / CRM | sí | sí | sí | 21 | `fichas/M02-clientes.md` |
| M03 | Turnos y servicios agendables | sí | sí | sí | 16+5 | `fichas/M03-turnos.md` |
| M04 | Cuentas corrientes y cobros | sí | sí | sí | 3 + 6 en `customers` | `fichas/M04-cuentas-corrientes.md` |
| M05 | Caja y arqueo | sí | sí | **no** | 5 | `fichas/M05-caja.md` |
| M06 | POS / Órdenes | sí | sí | sí | 10 | `fichas/M06-pos-ordenes.md` |
| M07 | Productos e inventario | sí | sí | sí | 30 | `fichas/M07-productos-inventario.md` |
| M08 | Recursos y categorías | sí | sí | sí | 8+5 | `fichas/M08-recursos.md` |
| M09 | Housekeeping y mantenimiento | sí | sí | sí | 11+4 | `fichas/M09-housekeeping.md` |
| M10 | Facturación (ARCA/AFIP) | sí | sí | parcial | 8 | `fichas/M10-facturacion.md` |
| M11 | Reportes | sí | — deriva | parcial | 11 | `fichas/M11-reportes.md` |
| M12 | Configuración del negocio | sí | sí | sí | 3+2+1+1 | `fichas/M12-configuracion.md` |
| M13 | Portal de clientes | sí | sí | sí | 12 | `fichas/M13-portal-clientes.md` |
| M14 | Plataforma y superadmin | sí | sí (platform) | sí | 12+2+3 | `fichas/M14-plataforma.md` |
| M15 | Estadías y folio | sí | sí | sí | 9 | `fichas/M15-estadias.md` |
| M16 | Tarifario y políticas | sí | sí | **parcial** | 4+5 | `fichas/M16-tarifario-politicas.md` |
| T01 | Identidad y numeración | — | sí | — | — | `fichas/T01-identidad.md` |
| T02 | Usuarios, roles y permisos | sí | sí | sí | 21 | `fichas/T02-usuarios-permisos.md` |
| T03 | Auditoría y trazabilidad | sí | sí | **no** | 1 | `fichas/T03-auditoria.md` |
| T04 | Documentos | parcial | parcial | parcial | — | `fichas/T04-documentos.md` |
| T05 | Integraciones, eventos y correo | sí | sí | **no** | 2 | `fichas/T05-integraciones.md` |

---

## 3. Correcciones al inventario de v1

| Fila de v1 | Qué pasa realmente |
|---|---|
| M01 "Alojamiento / Reservas" con checkout en el mismo flujo | Son **dos** módulos: `reservas/` (reserva) y `pms-estadias/` (estadía, check-in, checkout, folio). Se parte en M01 y M15. |
| M08 "Recursos" | Existe, y arrastra `resource_categories`, `resource_hours` y `resource_locks`. Se conserva el ID. |
| M12 "Configuración / Administración" | Existe como `business_profile` + `business_hours` + módulos + terminología. Se conserva. |
| T01…T05 transversales | Los cinco existen. `T04 Documentos` es el más débil: no hay entidad "documento", hay PDF de factura y nada más. |
| — | **Faltaban en v1:** M13 Portal de clientes (12 endpoints, 6 pantallas, tabla `customers` con auth propia), M14 Plataforma/superadmin (17 endpoints, schema entero aparte), M15 Estadías, M16 Tarifario y políticas. |
| — | **Faltaba la dimensión de ausencia:** v1 no tenía dónde anotar que no existe compras/proveedores, ni tesorería/bancos, ni contabilidad. Ver §4. |

---

## 4. Áreas de ERP que no existen `[V]`

Verificado por ausencia de tabla en los dos schemas y ausencia de router:

| Área | Evidencia de la ausencia | Estado |
|---|---|---|
| Compras y proveedores | No hay tabla `suppliers`/`purchase_*` en `src/db/schema.sql`; ningún router. El stock sólo entra por `stock_movements` tipo `IN` sin documento de compra. | Brecha — ver `fichas/M07-productos-inventario.md` |
| Tesorería y bancos | No hay tabla de cuentas bancarias ni de conciliación. `financial_transactions.payment_method` admite `TRANSFER` pero no hay a dónde conciliarlo. | Brecha — ver `fichas/M05-caja.md` |
| Contabilidad (asientos, plan de cuentas) | Ninguna tabla. El "ledger" es `financial_transactions`, que es un ledger comercial, no contable. | Decisión de producto pendiente — ver `10-matriz-maestra.md` |
| Nómina y activos fijos | Ninguna tabla, ningún router. | Fuera de alcance declarado |

Ninguna de estas cuatro ausencias aparece hoy en un `pendientes-*.md`. Tres de
ellas tampoco en `docs/roadmap-pms-multirubro.md` como fila propia.

---

## 5. Pantallas sin backend y backend sin pantalla

Los dos casos límite que el cruce hace visibles:

**Backend sin pantalla (candidatos a `◌ huérfano`):**

- **Caja** — `/api/cash-register` × 5, y ni una sola aparición de "caja",
  "arqueo" o "cash-register" en `appfrontend-main/src`. Es el caso más nítido
  del inventario. Ficha `M05`.
- **Auditoría** — `GET /api/audit-log` sin consumidor. Ficha `T03`.
- **Outbox dead-letter** — `GET /api/system/outbox/dead-letter` sin consumidor.
  Ficha `T05`.
- **Reportes POS y CRM** — 5 de 11 endpoints de reportes sin panel. Ficha `M11`,
  cruza con `D7`.
- **Políticas de cancelación** — los 5 endpoints sin consumidor. Ficha `M16`.
- **Tarifario** — los 4 endpoints de `rate-catalog` sin consumidor. Ficha `M16`.
- **Movimientos de stock manuales** — `stock/decrement` (×2) y `stock/transfer`
  sin consumidor. Ficha `M07`.

**Pantalla sin módulo de negocio propio:** `app/dev/primitives` y
`app/dev/shell` son pantallas de desarrollo, no de producto. No entran al
inventario; se anotan acá para que no las cuente una corrida futura.

---

## 6. Cómo se regenera este inventario

```bash
cd app-main
bash   docs/erp-auditoria-v2/scripts/extraer-endpoints.sh > docs/erp-auditoria-v2/datos/endpoints.csv
bash   docs/erp-auditoria-v2/scripts/extraer-montajes.sh  > docs/erp-auditoria-v2/datos/montajes.csv
python docs/erp-auditoria-v2/scripts/extraer-consumo-frontend.py
python docs/erp-auditoria-v2/scripts/extraer-uso-tablas.py
python docs/erp-auditoria-v2/scripts/cruzar-cobertura.py
python docs/erp-auditoria-v2/scripts/validar-anclas.py
```

Los seis son idempotentes y sólo escriben dentro de `docs/erp-auditoria-v2/`.
