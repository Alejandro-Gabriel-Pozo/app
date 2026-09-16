# Auditoría integral — Fase 14: código muerto y elementos abandonados

**Fecha:** 2026-09-16
**Repos y HEAD verificados al iniciar y al cerrar:**

| Repo | Ruta | HEAD | Fecha | Árbol |
|---|---|---|---|---|
| Backend | `/home/user/app` | `ae73ab26583af9c5f2b4125af01734030aac3097` | 2026-09-16 | limpio (`git status --porcelain` vacío) |
| Frontend | `/home/user/appfrontend` | `3bc77f508498d458b3edfb319cbab7a1080bf7da` | 2026-09-15 | limpio |

**Naturaleza de la fase:** detección, no eliminación. No se modificó ni un archivo de ninguno de los dos repos. Todos los comandos corridos fueron de lectura o análisis estático (`knip`, `depcruise`, `jscpd`, `eslint`, `git log`, `grep`, scripts propios de grafo de importadores en el scratchpad).

---

## 0. Qué NO se re-deriva (cubierto por fases previas)

Esta fase pisa terreno que la **Fase 7** ya araró a fondo. Lo declaro arriba de todo para que nada de lo que sigue se lea como hallazgo nuevo cuando no lo es.

| Ya cubierto | Dónde | Cómo lo trato acá |
|---|---|---|
| `appfrontend/src/app/admin/page.tsx` (página huérfana, guard `localStorage` muerto, login propio, tercer sistema de toast) | **F7-14(1)** (`docs/auditoria-integral-fase7-2026-09-15.md:1292-1310`), F9 (`:561,576`), F11 (`:167`, URL hardcodeada), F1 (`:192`) | **Citado.** Mi aporte nuevo es solo lo que F7-14 no tocó: `ApiBlock.tsx` como componente muerto por transitividad, su prop `noAuth` muerta, y el contrato fósil `ResourceType` → **F14-07** |
| `appfrontend/src/lib/auth.tsx` (3 líneas, `export {}`, comentario falso) | **F7-14(2)** | **Citado, no re-derivado.** Re-verifiqué que sigue vivo en el árbol y que el comentario sigue siendo falso (0 `localStorage` en `app/login/page.tsx`). Sin ficha propia |
| `src/db/postgres-transaction-manager.ts` (alias de compat que existe solo para un test) | **F7-14(3)** | **Citado.** Re-verificado: único importador sigue siendo `src/tests/integration/reservation.service.integration.test.ts:73`. Sin ficha propia |
| 24 `in-memory.*.repository.ts` en `src/` (dobles de prueba en código de producción) | **F7-14(4)** | **Citado.** Mi grafo de importadores los reconfirma (26 archivos `in-memory.*` con `prod=0`). Sin ficha propia |
| `container.ts` — `mode: 'postgresql'`, unión discriminada de un solo miembro | **F7-14(5)** | **Citado.** Sin ficha propia |
| `knip`/`ts-prune`/`jscpd`/`dependency-cruiser` instalados sin job de CI | **F7-14(6)**, F7-11(e) | **Citado.** Es la causa raíz de casi todo lo que sigue |
| `migrations/NNN_*.sql` como histórico no aplicado (`migrations/README.md:1`) | **Fase 13** | **Citado y descartado.** Re-verificado: 10 archivos `003_`→`012_`, README lo declara explícito. No es hallazgo |
| `src/tests/domain/resource.factory.test.ts` apunta a un factory eliminado | **F13-19** | **Citado.** Es test, no producción. Sin ficha propia. Relevante solo como evidencia colateral de **F14-06** (la misma limpieza de `ResourceType` del 03/07/2026 dejó residuos en tres lugares) |
| `POST /api/admin/repair-tenant-db` depende de `DATABASE_URL` no declarada | **F11-02** | **Citado.** No lo repito |
| Pool legado de `pg.client.ts` / `DB_POOL_MAX` sin efecto | **F11-18** | **Citado.** Mi ficha **F14-05** comparte evidencia y lo dice; el aporte incremental es la rama inalcanzable y el plan de retiro |
| "Todo comprobante es Factura B" (consecuencia de negocio) | **Fase 3** (`auditoria-integral-fase3-2026-09-15.md:171`, `fase3-grounding:64`), bloqueado por `docs/diseno-fiscal-profile-resolver-2026-09-01.md` en HOLD | **Citado.** Mi ficha **F14-03** es la cara de *código muerto* del mismo hecho, y llega a una recomendación **opuesta a la habitual** (no marcar como obsoleto) |
| Duplicación semántica (moneda D-16, `ReservationStatus`, contrato `Invoice`) | **Fase 3 duplicación** | **Citado.** Mi **F14-10** es duplicación **literal** medida con `jscpd`, que Fase 3 no reportó |
| `.MD` de 1 byte y `supabase/` como residuos de raíz | **F1 B-05**, re-verificado en **F11** (`:49-51`) | **Citado y descartado.** No abro ficha |
| Dependencias sin uso de `package.json` | **Fase 11** | **Citado.** `knip` sigue reportando `jscpd` y `pino-pretty` como devDeps sin uso en backend. No abro ficha: es manifiesto, no código fuente |

**Mi ángulo nuevo, en una línea:** barrido sistemático de las 14 categorías del protocolo sobre **todo** el código fuente vivo de ambos repos, con verificación real de importadores/referencias por candidato — y en particular tres cosas que ninguna herramienta del repo puede ver: **(a)** superficie HTTP sin consumidor, **(b)** código que solo su propio test mantiene vivo, **(c)** ramas de `switch` sin productor.

---

## 1. Método y herramientas — qué corrí y qué garantiza cada cosa

| Herramienta | Comando | Resultado | Qué ve | **Qué NO ve** |
|---|---|---|---|---|
| `knip` 6.32.2 | `npx knip --no-progress` | **0** archivos sin uso, **29** exports sin uso, **23** tipos exportados sin uso | Grafo real de TS | Considera los `*.test.ts` como entry points ⇒ **código que solo un test importa aparece como vivo** |
| `dependency-cruiser` 18 | `npx depcruise src --config .dependency-cruiser.cjs --output-type err` | `✔ no dependency violations found (311 modules, 1528 dependencies cruised)` | Ciclos, reglas de dominio | Su regla `no-orphans` define huérfano como *sin entrantes **y** sin salientes*: un archivo muerto que importa `express` **nunca** se reporta (ya declarado en F7-11(d)) |
| `jscpd` 5 (backend) | `npx jscpd src --min-lines 25 --min-tokens 150 --ignore "**/*.test.ts,**/tests/**"` | **1** clon, 35 líneas (0.06%), intra-archivo y declarado deliberado | Clones exactos | Duplicación semántica |
| `jscpd` 5 (frontend) | `npx jscpd src --min-lines 30 --min-tokens 200` | **5** clones, 221 líneas (0.90%) | ídem | ídem |
| `ts-prune` (frontend) | `npx ts-prune` | ~120 líneas, dominadas por `default` de páginas Next | Exports sin importador | No entiende que un `default` de `app/**/page.tsx` es un entry point del framework |
| `eslint` backend | `npm run lint` | **limpio, 0 problemas** | Variables sin uso | — |
| `eslint` frontend | `npx eslint .` | **4 warnings** (3 variables sin uso, 1 de Next) | ídem | — |
| **Grafo propio de importadores** | script en scratchpad, resuelve `./`, `../`, `@/`, `import './x.js'` de efecto lateral, `import()` y `require()` | backend: 511 archivos, **32** sin importador de producción; frontend: 131 archivos, **1** sin importador | Archivos vivos solo por tests | Es textual: un import armado dinámicamente se le escapa |
| **Cruce ruta↔consumidor** | `docs/inventario-rutas.md` (262 endpoints, generado) × extracción de paths del frontend | **35** métodos sin consumidor tras exclusiones justificadas | Endpoints huérfanos | Consumidores fuera de estos dos repos (ver §5) |

**Limitación declarada de mis scripts de conteo por `grep`:** cuentan ocurrencias textuales, y un comentario que nombra un símbolo lo hace parecer vivo. Por eso **cada** candidato que reporto como muerto lo verifiqué además a mano leyendo las líneas que devuelve el grep. Donde esa verificación cambió la conclusión lo digo (caso `IVA_ALICUOTA_IDS`, §6).

---

## 2. Hallazgos — tabla resumen

| ID | Categoría del protocolo | Severidad | Certeza | ¿Borrar? |
|---|---|---|---|---|
| F14-01 | endpoints no referenciados | **Alta** | Alta | No sin decisión de producto |
| F14-02 | endpoints / feature abandonada | **Alta** | Alta | **No** — completar o retirar entero |
| F14-03 | funciones sin uso / ramas imposibles | **Media** | Alta | **No** — andamiaje de un diseño en HOLD |
| F14-04 | funciones sin uso | Media | Alta | Sí, con cuidado de interfaz |
| F14-05 | adaptadores reemplazados | Media | Alta | Sí |
| F14-06 | ramas de lógica imposibles | Media | Alta | Parcial (2 sí, 3 son red de seguridad) |
| F14-07 | componentes no utilizados / variables sin uso | Media | Alta | Atado a la decisión de F7-14(d) |
| F14-08 | código duplicado que parece haber sido sustituido | Media | Alta | No borrar: **adoptar** el helper |
| F14-09 | código muerto de contrato | Media | Alta | No sin decisión de producto |
| F14-10 | código duplicado | Media | Alta | No borrar: extraer |
| F14-11 | funciones sin uso | Baja | Alta | Sí (1 de 3); 2 requieren tocar su test |
| F14-12 | comentarios con código obsoleto | Baja | Alta | Corregir, no borrar |
| F14-13 | configuraciones antiguas | Baja | Alta | Sí, con verificación |
| F14-14 | código muerto de barrel | Baja | Media | No — es la convención declarada |
| F14-15 | variables sin uso | Baja | Alta | Sí |
| F14-16 | configuraciones antiguas (doc) | Baja | Alta | Corregir el doc |
| F14-17 | dato anecdótico / endpoint sin efecto downstream | Baja | Alta | No |
| F14-18 | comentarios con código obsoleto | Baja | Alta | Corregir |
| F14-19 | exports superfluos | Baja | Alta | Opcional |

---

## 3. Fichas de hallazgo

### F14-01 — 35 de 262 endpoints (13%) no tienen ningún consumidor en el frontend, y nada en el repo puede detectarlo

**Hallazgo:** el backend expone 262 endpoints (`docs/inventario-rutas.md`, artefacto **generado**, no estimado). Tras excluir 17 paths con justificación explícita (probes de infra, docs dev-only, rutas consumidas con otro cliente, y features construidas el 14-15/09 con UI pendiente), quedan **29 paths / 35 métodos** sin una sola llamada desde `appfrontend-main` — ni el panel admin, ni el portal de cliente, ni el panel superadmin.

**Cómo se determinó que parece no usarse:** cruce mecánico entre el inventario generado de rutas y todos los literales de path del frontend, con normalización de `:param` y `${expr}` a un comodín común, más verificación individual por `grep` de cada familia candidata.

**Qué búsqueda se realizó:**
```
# lado backend (artefacto generado, no regex sobre texto)
docs/inventario-rutas.md  → 262 endpoints / 201 paths

# lado frontend
grep -rhoP "(?<![\w])/(?:api|platform)/[A-Za-z0-9_:\-/.\$\{\}]*" src/ \
  --include=*.ts --include=*.tsx | sed 's/\${[^}]*}/:p/g' | sort -u   → 177 paths

# verificación individual por familia (todas dieron 0):
grep -rn "cash-register|caja" src/ --include=*.ts --include=*.tsx        → 0
grep -rn "rate-catalog"      src/ ...                                     → 0 (los 3 hits de "rateCatalog" son el campo `rateCatalogId`)
grep -rn "audit-log"         src/ ...                                     → 0
grep -rn "cancellation-polic" src/ ...                                    → 0
grep -rn "reactivate|unreconciled|iva-receptor" src/ ...                   → 0
grep -rn "stock/transfer|stock/decrement|business/modules" src/ ...        → 0
grep -rn "locations"         src/ ...  → 11 hits, TODOS son `allocations`  → 0 reales
```

**Lista verificada** (los 35, agrupados):

| Familia | Métodos | Router y montaje |
|---|---|---|
| `/api/cash-register` (`/`, `/:id`, `/current`, `/open`, `/close`) | 5 | `src/clientes-finanzas/cash-register.routes.ts`, montado `src/app.ts:396` |
| `/api/cancellation-policies` (`/` GET+POST, `/:id` GET+PUT+DELETE) | 5 | `src/reservas/cancellation-policies.routes.ts`, `src/app.ts:360` |
| `/api/rate-catalog` (`/` GET+POST, `/:id` PUT+DELETE) | 4 | `src/clientes-finanzas/rate-catalog.routes.ts`, `src/app.ts:362` |
| `/api/reports/pos/{sales-by-product,ticket-summary,waste}` | 3 | `CLOSURE_MOUNTS`, `src/api/routes/reports.routes.ts` |
| `/api/reports/crm/{applied-rates,new-vs-recurring}` | 2 | ídem |
| `DELETE /api/reports/occupancy/purge` | 1 | ídem |
| `/api/products/{:id/stock/decrement, :id/variants/:vid/stock/decrement, stock/transfer}` | 3 | `src/pos-menu/products.routes.ts` |
| `/api/stays/{:id, reservation/:id, resource/:id}` | 3 | `CLOSURE_MOUNTS` |
| `/api/housekeeping/{:id, resource/:id}` | 2 | `CLOSURE_MOUNTS` |
| `/api/locations` (GET+POST) | 2 | `src/api/routes/locations.routes.ts`, `src/app.ts:358` |
| `GET /api/audit-log` | 1 | `src/app.ts:394` |
| `GET /api/business/modules` | 1 | `src/platform/business-context.routes.ts` |
| `GET /api/invoices/unreconciled` | 1 | `src/facturacion/invoices.routes.ts` |
| `GET /api/customers/padron/iva-receptor-types` | 1 | `src/clientes-finanzas/customers.routes.ts` |
| `POST /api/users/:id/reactivate` | 1 | `src/usuarios-roles/users.routes.ts` |

**Exclusiones aplicadas, con motivo** (para que nadie las cuente como huérfanas): `/` y `/openapi.json` (dev-only por `shouldExposeApiDocs()`); `/health`, `/health/db` (probes de Render); `/register` (usado, `appfrontend/src/app/registro/page.tsx:36`); `/platform/businesses` y `/platform/businesses/:id/*` (usados, `appfrontend/src/lib/platformApi.ts:104,108,114,120`); `/platform/outbox/purge` (endpoint de operador con gemelo CLI `npm run purge:outbox`); `/api/admin/set-tenant-url` (F7/F11); `/api/service-items` x2 y `/api/credit-note-requests` x3 (creados el **15/09/2026**, commits `0c58a7a` y `321ab55` — un día antes del HEAD, UI pendiente, **no** abandonados); `/api/accounts-receivable/:id/reverse` (14/09/2026); `/api/reservations/:id/cancellation-refund/{preview,confirm}` (backlog ya declarado en `app-main/CLAUDE.md`, sección `irreversible-action-gate`).

**Evidencia adicional, la más fuerte del hallazgo:** el propio frontend documenta que **no** usa uno de estos endpoints, creyendo que no existe:
- `appfrontend/src/app/dashboard/estadias/[id]/page.tsx:78` — `// Sin GET /api/stays/:id — mismo criterio que el adapter 'estadias'`
- `appfrontend/src/lib/refine/dataProvider.ts:209` — `// Sin GET /api/stays/:id individual (sí existe /:id/folio, que es otra cosa).`

Mientras tanto `docs/inventario-rutas.md:233` lista `GET | /api/stays/:id | CLOSURE_MOUNTS`. **El endpoint existe y el consumidor escribió por duplicado que no existe.** Ver F14-18.

**Impacto:** 13% de la superficie HTTP se mantiene, se testea, se audita en RBAC (7 cercas), se cuenta en el inventario y se despliega sin que nadie la ejerza desde la UI. Cada barrido mecánico del repo paga peaje sobre ella — verificable: el commit `2b005fa` (D-14, contrato de paginación, 15/09/2026) tocó `cash-register.routes.ts`, un router sin un solo consumidor.

**Causa probable:** el repo construye backend-primero por diseño, y **no existe ningún artefacto que cruce "ruta que existe" contra "ruta que alguien llama"**. `docs/inventario-rutas.md` lo dice textualmente de sí mismo: *"Este inventario dice QUÉ RUTAS EXISTEN. NO dice quién puede pegarles… ni la forma del request/response"*. Tampoco dice quién las usa, y esa tercera pregunta no la responde nada.

**Nivel de certeza:** **Alta** para "sin consumidor en estos dos repos". **Media-baja** para "sin consumidor en absoluto" — ver la limitación en §5 (no pude descartar clientes externos).

**Severidad:** **Alta** — no por riesgo de rotura, sino porque es el termómetro que explica F14-02, F14-03, F14-09 y F14-17, y porque la superficie sin ejercer es superficie de ataque y de mantenimiento que nadie está midiendo.

**Recomendación:** **no borrar ninguno todavía.** Producir un artefacto de consumo (tercera columna en `docs/inventario-rutas.md` o un test de arquitectura que cruce inventario × literales del frontend, con allowlist con motivo — mismo patrón que `CLOSURE_MOUNTS`/`PUBLIC_ROUTES`/`EXCLUDED_FILES`, que este repo ya sabe sostener). Recién con ese artefacto verde, decidir familia por familia.

**¿Requiere modificar código?:** No para el hallazgo. Sí para la mitigación (un test nuevo + una columna en el generador).

**Qué riesgo existe:** borrar `/api/audit-log` o `/api/stays/:id` sin el artefacto de consumo es exactamente el modo de falla de `CONTRACT-001` (3 de 19 paths de `spec.ts` daban 404, uno sin detectarse 2.5 meses) pero al revés.

**Cómo verificarlo antes de eliminarlo:** por familia — (a) `grep -rn "<path>" appfrontend/src` → 0; (b) logs de acceso reales de Render para el path, ventana ≥ 30 días; (c) confirmar con el dueño si hay un consumidor fuera de estos repos.

**¿Debería marcarse primero como obsoleto?:** **Sí**, salvo las familias que F14-02/F14-17 tratan aparte. Marca sugerida: `@deprecated` en el docblock del router + fila en `docs/pendientes-<fecha>.md` con el comando que reproduce el 0.

**Prueba necesaria:** test de arquitectura "inventario × consumidores" con allowlist con motivo, verificado en las dos direcciones (ruta sin consumidor que falta en el allowlist, y entrada del allowlist que ya tiene consumidor).

---

### F14-02 — El circuito de Caja está construido entero en el backend y no tiene ni una línea de UI: 5 endpoints, servicio, repositorio y tabla, sin fila en el roadmap

**Hallazgo:** `cash-register` es un vertical **completo** del lado servidor — router, servicio con 3 errores de dominio propios (`ShiftAlreadyOpenError`, `NoOpenShiftError`, `ShiftNotFoundError`), repositorio SQL, tabla en `schema.sql`, gate de módulo (`requireModule(ModuleKey.CUENTAS_CORRIENTES)`) y validación Zod de nivel 2 — con **cero** consumidores. Y no tiene fila propia en `docs/roadmap-pms-multirubro.md`: la única mención de `cash-register` en ese documento (`:115`) es incidental, dentro del ítem de **Multidivisa**.

**Cómo se determinó que parece no usarse:** subconjunto de F14-01, pero elevado a ficha propia porque es el único caso donde falta el **circuito entero**, no un endpoint suelto.

**Qué búsqueda se realizó:**
```
grep -rn "cash-register|cash_register|caja" appfrontend/src --include=*.ts --include=*.tsx  → 0, 0, 0
grep -n -i "caja|cash.register|turno de caja" app/docs/roadmap-pms-multirubro.md            → 1 hit, línea 115, dentro de "Multidivisa"
git log --date=short --reverse -- src/clientes-finanzas/cash-register.routes.ts
  2026-08-15 d364d55 refactor: mover reservas/ y clientes-finanzas/ a bounded contexts propios (paso 4)
  2026-08-17 f5f93b2 feat(business-profile): currency/timezone configurables ...
  2026-08-25 8bcbb43 Cobertura de validación Zod, nivel 1 y 2 ...
  2026-09-15 2b005fa feat(reservas): D-14 contrato canónico de paginación (limit/offset)
git log --reverse -- src/... | head   # origen real anterior al move:
  2026-08-14 672dda5 feat(caja): agregar turno de caja (apertura/cierre/arqueo) — Gap Tango #2
```

**Evidencia:**
- `src/clientes-finanzas/cash-register.routes.ts:1-14` — el docblock enumera los 5 endpoints y su montaje.
- `src/app.ts:83` (import), `src/app.ts:396` (`app.use('/api/cash-register', …)`) — está montado y vivo en producción.
- `src/clientes-finanzas/cash-register.service.ts` — servicio con sus 3 errores de dominio.
- Origen: `672dda5`, **2026-08-14** ("Gap Tango #2"). Un mes y dos días antes del HEAD.
- Los 3 commits posteriores que lo tocaron son **barridos mecánicos transversales** (mover a bounded context, cobertura Zod, tope de paginación), no trabajo sobre la feature.

**Impacto:** el circuito #2 de la secuencia ERP canónica (*"Caja: pago efectivo → turno abierto → cierre → recuento → diferencia"*) está a medio construir y **desaparecido del radar**: no está en el roadmap como fila propia, y por lo tanto —por el mecanismo que el propio `CLAUDE.md` del backend describe en la sección "Roadmap de producto"— nunca puede aparecer en un `pendientes-<fecha>.md`. Es literalmente el incidente del 25/08/2026 que ese documento narra, repetido sobre otra feature.

**Causa probable:** feature construida backend-primero en un sprint de "gap analysis Tango", sin par de UI planificado, y sin fila de roadmap que la sostenga en el radar. No es descuido puntual: es la brecha estructural entre `roadmap` y `pendientes` que el repo ya tiene documentada.

**Nivel de certeza:** **Alta.** 0 hits en el frontend con 3 términos distintos; montaje verificado; fechas de git verificadas.

**Severidad:** **Alta.** No por defecto técnico —el código parece correcto— sino porque un turno de caja sin UI significa que **el dinero en efectivo no tiene circuito de arqueo operable**, y porque la ausencia de fila de roadmap garantiza que nadie lo va a revisar.

**Recomendación:** decisión del dueño, dos caminos y ninguno es "borrar en silencio":
1. **Completar** — es el circuito #2 de la secuencia ERP y ya está el 70% hecho; falta la pantalla.
2. **Retirar entero** (router + servicio + repo + tabla) con un ADR que diga por qué.
En cualquiera de los dos, **crear la fila en `docs/roadmap-pms-multirubro.md` primero** — sin eso, la decisión se vuelve a perder.

**¿Requiere modificar código?:** Sí, en los dos caminos. No en esta fase.

**Qué riesgo existe:** borrar tiene radio alto (toca `schema.sql`, y `schema.sql` se reaplica a **todas** las tenant DB en cada deploy vía `migrate:tenants`). Dejarlo como está tiene riesgo cero técnico y costo de mantenimiento permanente.

**Cómo verificarlo antes de eliminarlo:** `SELECT count(*) FROM cash_register_shifts` en cada tenant productivo. Si hay filas, alguien lo usó por API y el borrado destruye hechos financieros — **prohibido** bajo la regla de no editar hechos financieros históricos.

**¿Debería marcarse primero como obsoleto?:** **No con `@deprecated`.** La marca correcta acá no es "obsoleto" sino **"incompleto"**: fila de roadmap en ❌/⚠️ + ítem en `pendientes-<fecha>.md`. Marcarlo `@deprecated` sería afirmar una decisión de producto que nadie tomó.

**Prueba necesaria:** antes de cualquier movimiento, la query de conteo por tenant. Si se completa, tests de integración con Postgres real sobre apertura/cierre concurrente (dos `POST /open` simultáneos → un solo turno).

---

### F14-03 — `resolveDocTipo()` y 6 constantes fiscales están muertas porque el campo `buyer` no tiene un solo cliente: toda factura sale a Consumidor Final

**Hallazgo:** el módulo de facturación tiene una función documentada y **unit-testeada** que mapea el tipo de documento del cliente al código de AFIP, y constantes para Factura A y Factura C. **Ninguna se llama desde producción.** La razón es una sola y verificable: el único camino de entrada que las usaría —el campo opcional `buyer` de `POST /api/invoices`— **no lo manda ningún cliente**, así que la rama `input.buyer ?? CONSUMIDOR_FINAL` resuelve siempre al default.

**Cómo se determinó que parece no usarse:** script de deadness sobre los 22 exports de `afip-catalog.constants.ts` (excluyendo el archivo declarante y separando referencias de test de las de producción), y después trazado manual del camino completo `frontend → ruta → servicio → payload AFIP`.

**Qué búsqueda se realizó:**
```
# 1. exports de afip-catalog.constants.ts sin consumidor de producción
   → CBTE_TIPO_FACTURA_A, CBTE_TIPO_FACTURA_C, CONCEPTO_PRODUCTOS,
     CONCEPTO_PRODUCTOS_Y_SERVICIOS, DOC_TIPO_CUIT, DOC_TIPO_CUIL,
     DOC_TIPO_CDI, DOC_TIPO_DNI, resolveDocTipo     (9 de 22)
     — de esos, 5 aparecen SOLO en afip-catalog.constants.test.ts
     — y 4 (CONCEPTO_PRODUCTOS, CONCEPTO_PRODUCTOS_Y_SERVICIOS,
        DOC_TIPO_CUIL, DOC_TIPO_CDI) no aparecen en NINGÚN otro archivo

# 2. ¿quién construye el buyer?
grep -rn "InvoiceBuyer" app/src --include=*.ts | grep -v test   → 0 resultados
grep -rn "buyer:" app/src/facturacion/*.ts | grep -v test
  → invoices.routes.ts:210 y :235, ambos `...(body.buyer !== undefined && { buyer: body.buyer })`

# 3. ¿el frontend manda buyer?
grep -rn "docTipo|DocTipo|buyer" appfrontend/src --include=*.ts --include=*.tsx  → 0 resultados

# 4. ¿qué manda entonces?
appfrontend/src/lib/facturacion/api.ts:21  → POST /api/invoices  con body = { financialTransactionId }
appfrontend/src/components/FacturarButton.tsx:135 → invoicesApi.request({ financialTransactionId })
appfrontend/src/lib/facturacion/api.ts:24  → POST /api/invoices/consolidated con body = { companyCustomerId }

# 5. ¿cómo mapea taxIdType → docTipo la producción?
grep -rn "resolveDocTipo|DOC_TIPO_CUIT" app/src --include=*.ts | grep -v test | grep -v afip-catalog.constants
  → 0 resultados. Nadie hace ese mapeo fuera de la función muerta.
```

**Evidencia (cadena completa, verificada línea por línea):**
- `src/facturacion/afip-catalog.constants.ts:106-117` — `resolveDocTipo(taxIdType)`, con docblock que explica el fallback a Consumidor Final. **Único consumidor: su propio test.**
- `src/facturacion/afip-catalog.constants.ts:23,25` — `CBTE_TIPO_FACTURA_A = 1`, `CBTE_TIPO_FACTURA_C = 11`. **Solo aparecen en el test y en el `switch` de `cbteTipoLabel()` del mismo archivo.**
- `src/facturacion/afip-catalog.constants.ts:83,85,94,95` — `CONCEPTO_PRODUCTOS`, `CONCEPTO_PRODUCTOS_Y_SERVICIOS`, `DOC_TIPO_CUIL`, `DOC_TIPO_CDI`. **Cero referencias en todo el repo, ni siquiera en tests.**
- `src/facturacion/invoice.service.ts:89-93` — `const CONSUMIDOR_FINAL: Buyer = { docTipo: DOC_TIPO_CONSUMIDOR_FINAL, docNro: '0', condicionIvaReceptorId: … }`.
- `src/facturacion/invoice.service.ts:592` y `:750` — `const buyer = input.buyer ?? CONSUMIDOR_FINAL;` (individual y consolidada).
- `src/facturacion/invoice.service.ts:651,805,879` — `cbteTipo: CBTE_TIPO_FACTURA_B` / `CbteTipo: CBTE_TIPO_FACTURA_B`, **literal, sin ninguna resolución**.
- `src/facturacion/invoice.service.ts:113` — el comentario lo dice de frente: `/** Sin esto, se factura a Consumidor Final (DocTipo 99, sin CUIT/DNI). */`. Está describiendo el 100% de los casos reales, no un borde.

**Impacto:** dos capas, y hay que separarlas.
1. **Capa de código muerto (mi alcance):** una función fiscal con test verde que nunca corre en producción. El test da **cobertura sin ejercicio** — verde, y sin significado sobre el comportamiento real del sistema.
2. **Capa de negocio (ya cubierta por Fase 3, `:171` y grounding `:64`):** todo comprobante sale Factura B a Consumidor Final. **Incluida la consolidada corporativa** (`:750` usa el mismo default) — una factura a una empresa sin su CUIT no le sirve como crédito fiscal. El perfil fiscal del cliente se captura (`/api/customers/:id/tax-profile`, `padron/lookup-by-cuit`, `padron/lookup-by-dni`) y **nunca llega a AFIP**: es el patrón "dato anecdótico, sin efecto downstream" en su forma más cara.

**Causa probable:** el catálogo AFIP se escribió completo y correcto por anticipado (buena práctica); el resolver que lo consumiría quedó bloqueado por una decisión de producto/fiscal en HOLD (`docs/diseno-fiscal-profile-resolver-2026-09-01.md`). El código muerto es el **andamiaje esperando la decisión**, no un residuo.

**Nivel de certeza:** **Alta** para las 5 afirmaciones de código (cadena verificada extremo a extremo, 5 búsquedas independientes). **Alta** para "el frontend no manda `buyer`". No verificado: si existe otro cliente fuera de estos repos que sí lo mande (§5).

**Severidad:** **Media** en la dimensión de código muerto. La dimensión de negocio ya tiene su severidad asignada en Fase 3 y no la re-califico acá.

**Recomendación:** **NO borrar, y NO marcar como obsoleto.** Esta es la única ficha de la fase donde la recomendación estándar se invierte, y el motivo importa: marcar `@deprecated` algo que está esperando una decisión en HOLD **convertiría una espera en un retiro**, sin que nadie lo decida — exactamente el modo de falla que el `CLAUDE.md` del backend describe en "Preguntas de alcance pueden esconder una decisión de negocio". Lo correcto es lo contrario: un comentario en `afip-catalog.constants.ts` que diga *"sin consumidor de producción hoy — habilitado por `docs/diseno-fiscal-profile-resolver-2026-09-01.md`, en HOLD"*, y un test que **congele** el hecho (ver más abajo), para que si mañana el resolver se conecta, se vea.

**¿Requiere modificar código?:** No en esta fase. Sí una nota de andamiaje (docs/comentario) y, opcionalmente, el test-cerca.

**Qué riesgo existe:** **borrar es el peor resultado posible acá.** Borrar `resolveDocTipo()` y las constantes A/C obligaría a reescribirlas cuando la decisión salga de HOLD, y perdería el docblock que explica por qué el fallback es 99 y no un código inventado — que es el conocimiento caro, no las 10 líneas.

**Cómo verificarlo antes de eliminarlo:** no aplica; la recomendación es no eliminar. Para confirmar la deadness: `grep -rn "resolveDocTipo" app/src appfrontend/src` → 2 hits, ambos en `afip-catalog.constants.ts` y su test.

**¿Debería marcarse primero como obsoleto?:** **No.** Marcar como **pre-construido y bloqueado**, que es una etiqueta distinta y el repo no la tiene todavía.

**Prueba necesaria:** una cerca chica que congele el hecho — un test que afirme que `cbteTipo` emitido es siempre `CBTE_TIPO_FACTURA_B` y `buyer` siempre `CONSUMIDOR_FINAL` **mientras el resolver esté en HOLD**, y que falle ruidosamente el día que eso cambie. Convierte una ausencia silenciosa en una afirmación verificada — mismo criterio que las 7 cercas de RBAC.

---

### F14-04 — `IReservationRepository.getAll()` lleva un mes `@deprecated` con cero llamadores, y sigue viva porque está en una interfaz

**Hallazgo:** `getAll()` está declarada en la interfaz del repositorio de reservas, implementada dos veces (SQL e in-memory), marcada `@deprecated` en los dos lados, y **no la llama nadie**. Su último llamador se retiró el 23/08/2026 (K2). Sobrevive porque una interfaz obliga a sus implementaciones, y ninguna herramienta del repo mira miembros de interfaz sin uso.

**Cómo se determinó que parece no usarse:** partí de los marcadores `@deprecated` del repo y busqué llamadores reales de cada uno.

**Qué búsqueda se realizó:**
```
grep -rn "@deprecated" app/src --include=*.ts    # 5 marcadores en total
grep -rn "getAll()" app/src --include=*.ts | grep -iv "resource|occupancy|customer|snapshot"
  → src/reservas/sql.reservation.repository.ts:475   (implementación)
    src/reservas/reservation.repository.ts:158       (declaración en la interfaz)
    src/reservas/in-memory.reservation.repository.ts:194 (implementación)
    src/reservas/reservations.routes.ts:280          (COMENTARIO, no llamada)
  → cero llamadas reales, en producción y en tests
grep -rn "\.getAll()" app/src --include=*.ts | grep -v "\.test\.ts"
  → solo 2 hits, ambos sobre SqlResourceRepository (otro repositorio):
    src/reservas/resources.routes.ts:126, src/api/routes/customer.routes.ts:500
```

**Evidencia:**
- `src/reservas/reservation.repository.ts:157-158` — `/** @deprecated Usar getFiltered({}) */` / `getAll(): Promise<Reservation[]>;`
- `src/reservas/sql.reservation.repository.ts:474-477` — `/** @deprecated Usar getFiltered({}) para consistencia. Se mantiene por compatibilidad. */` y el cuerpo, que es un `return this.getFiltered({});` — un passthrough puro.
- `src/reservas/in-memory.reservation.repository.ts:194` — segunda implementación.
- `src/reservas/reservations.routes.ts:279-281` — el comentario que documenta el retiro del llamador: *"K2 (23/08/2026, pendientes-2026-08-23.md, SC16) — antes llamaba a `getAll()` (deprecado), sin leer query params: siempre un SELECT sin LIMIT sobre toda la tabla."*
- "Se mantiene por compatibilidad" — **con nadie**: no hay ningún consumidor, ni interno ni externo, de un método de repositorio (capa interna, no expuesta por HTTP).

**Impacto:** bajo en runtime, concreto en lectura: cualquiera que lea la interfaz ve dos formas de listar reservas y tiene que averiguar cuál rige. Y hay un riesgo latente real: `getAll()` es el método que hacía *"siempre un SELECT sin LIMIT sobre toda la tabla"* — mientras siga en la interfaz, alguien puede volver a usarlo y reintroducir el problema de rendimiento que K2 arregló.

**Causa probable:** el llamador se retiró (K2) y el método se marcó `@deprecated` en vez de borrarse, con la fórmula "se mantiene por compatibilidad" aplicada a una capa **interna** donde esa compatibilidad no existe. El `@deprecated` no lo detecta ninguna herramienta porque ESLint no tiene la regla activada y `knip` no mira miembros de interfaz.

**Nivel de certeza:** **Alta.** Dos búsquedas independientes con 0 llamadores; el comentario del propio repo fecha el retiro del último.

**Severidad:** **Media.** Sube de Baja porque el método revive un antipatrón de rendimiento ya corregido, no porque ocupe líneas.

**Recomendación:** borrar los tres lugares (declaración + 2 implementaciones) en un bloque chico y reversible.

**¿Requiere modificar código?:** Sí. Fuera del alcance de esta fase.

**Qué riesgo existe:** **Bajo.** Es un passthrough a `getFiltered({})`; si algún test lo usara, `tsc` lo señala al instante. Verifiqué que no.

**Cómo verificarlo antes de eliminarlo:** `npx tsc --noEmit` + `npm test` después del borrado. Si compila y la suite pasa, no había consumidores — el compilador de TS es prueba suficiente para un miembro de interfaz, a diferencia de un endpoint HTTP.

**¿Debería marcarse primero como obsoleto?:** **Ya lo está**, hace un mes, y no pasó nada. Ese es el dato: en este repo `@deprecated` no dispara ninguna acción porque no hay lint rule (`@typescript-eslint/no-deprecated`) ni job que lo mire. **Marcarlo de nuevo no agrega información.** O se borra, o se activa la regla de lint para que la marca signifique algo.

**Prueba necesaria:** `npm run build` + `npm test` + `npm run lint:arch`.

---

### F14-05 — El bloque de pool legado de `pg.client.ts` es inalcanzable: 3 exports sin referencias y una rama que ningún llamador puede tomar

**Hallazgo:** `src/db/pg.client.ts` contiene un pool lazy de tenant único —anterior al modelo multi-tenant— cuyos cuatro puntos de entrada están muertos: `pgClient`, `withTransaction()` y `closeDatabasePool()` no tienen **ninguna** referencia en todo el repo (ni en tests), y la única rama restante que llegaría a `getPool()` —el `else` de `checkDatabaseHealth()`— es inalcanzable porque su único llamador de producción siempre pasa el cliente.

**Relación con Fase 11:** **F11-18 ya reportó este archivo** desde el ángulo de configuración (`DB_POOL_MAX`/`DB_POOL_IDLE_MS`/`DATABASE_URL` que no dimensionan nada). Comparto su evidencia y la cito. **El aporte incremental de esta ficha es:** (a) nombrar la rama inalcanzable como tal, (b) delimitar el bloque exacto retirable, (c) dar el procedimiento de verificación del retiro. F11-18 dijo qué variables mienten; esta ficha dice qué líneas se van.

**Cómo se determinó que parece no usarse:** cruce de `knip` (que reportó los 3 exports) con verificación manual de cada uno **incluyendo tests**, más trazado del único llamador vivo.

**Qué búsqueda se realizó:**
```
npx knip --no-progress
  → pgClient  src/db/pg.client.ts:111
    withTransaction  src/db/pg.client.ts:125
    closeDatabasePool  src/db/pg.client.ts:172      (los tres en "Unused exports")

grep -rn "\bpgClient\b" app/src --include=*.ts
  → 2 hits: la declaración (:111) y una MENCIÓN EN COMENTARIO en platform.repository.ts:6
grep -rn "\bcloseDatabasePool\b" app/src --include=*.ts
  → 1 hit: la declaración (:172). Nada más, en todo el repo.
grep -rn "withTransaction" app/src --include=*.ts   # filtrando comentarios
  → declaración (:125) + 3 menciones en comentarios, todas en PASADO:
    clientes-finanzas/sql.customer.repository.ts:259 "…usaba `withTransaction()` de…"
    clientes-finanzas/customer.repository.ts:64      "Llamar solo desde dentro de withTransaction()…"
    reservas/reservation.service.ts:28               "…se recibe como `TransactionManager` inyectado."
  → cero llamadas reales

grep -rn "checkDatabaseHealth" app/src --include=*.ts
  → único llamador de producción: src/app.ts:220
    const dbHealth = new CachedDbHealth(() => checkDatabaseHealth(platformClient), …)
    — SIEMPRE con argumento.
```

**Evidencia:**
- `src/db/pg.client.ts:77-105` — `let _pool` + `getPool()`, el pool legado.
- `src/db/pg.client.ts:111-119` — `export const pgClient`. Sin referencias.
- `src/db/pg.client.ts:125-149` — `export async function withTransaction`. Sin referencias.
- `src/db/pg.client.ts:163-164` — `} else { await getPool().query('SELECT 1'); }` → **rama inalcanzable en producción.**
- `src/db/pg.client.ts:172-177` — `export async function closeDatabasePool`. Sin referencias.
- `src/app.ts:220` — el único llamador, con argumento.
- Lo vivo del archivo son solo 3 exports: `stripSslMode()` y `sslConfig()` (importados por `container.ts:28`, `tenant.middleware.ts:38`, `company-sync.worker.ts:28`, `tenant-db.setup.ts:37`, `outbox-purge.ts:43`, `server.ts:26`) y `checkDatabaseHealth()` (`app.ts:100`).
- El propio archivo lo rotula 4 veces: `:9` *"Legado"*, `:25` *"legado, útil en tests y scripts locales"*, `:74` *"Pool lazy (legado…)"*, `:108` *"SqlClient (legado)"*. **La etiqueta está puesta; el retiro no se hizo.** Y "útil en tests" es falso: verifiqué que ningún test lo usa.

**Impacto:** un archivo llamado `pg.client.ts` en un sistema multi-tenant expone una API de tenant único que parece utilizable y no lo es. Quien la use, abre un pool contra `DATABASE_URL` —una variable **no declarada en `render.yaml`**— y en el mejor caso tira; en el peor, si alguien setea `DATABASE_URL` "a algo razonable", escribe en la base equivocada. Es la misma clase de riesgo que F11-02 describe para `repair-tenant-db`.

**Causa probable:** migración a multi-tenant con retiro incompleto del adaptador anterior. El docblock se actualizó con la palabra "legado" en vez de eliminarse el código.

**Nivel de certeza:** **Alta.** `knip` y grep manual coinciden en los 3 exports; el llamador único está verificado al número de línea.

**Severidad:** **Media.** Por el riesgo de pool contra la base equivocada, no por las líneas.

**Recomendación:** retirar en un bloque chico: borrar `_pool`, `getPool()`, `pgClient`, `withTransaction()`, `closeDatabasePool()`, simplificar `checkDatabaseHealth(client: SqlClient)` a parámetro **obligatorio**, y limpiar la tabla de variables del docblock (`DATABASE_URL`, `DB_POOL_MAX`, `DB_POOL_IDLE_MS`) — que es la mitad de lo que F11-18 pide. El archivo queda con 3 funciones vivas y ninguna trampa.

**¿Requiere modificar código?:** Sí. Fuera del alcance de esta fase.

**Qué riesgo existe:** **Bajo**, con una salvedad: hacer obligatorio el parámetro de `checkDatabaseHealth()` es un cambio de firma. `tsc` lo verifica de forma exhaustiva y hay un solo call site.

**Cómo verificarlo antes de eliminarlo:** `npx tsc --noEmit` → debe pasar limpio; `npm test` + `npm run test:integration`; y después del deploy, `GET /health/db` contra producción (el único camino que ejercita `checkDatabaseHealth`).

**¿Debería marcarse primero como obsoleto?:** **No.** Ya está marcado "legado" en 4 lugares desde hace meses y eso no produjo el retiro. Repetir la marca es repetir lo que no funcionó.

**Prueba necesaria:** `tsc --noEmit`, suite completa, y `GET /health/db` con 200 en producción tras el deploy.

---

### F14-06 — Cinco ramas del mapa de status de `error.middleware.ts` no las puede tomar ningún error real; tres son fósiles de un enum borrado el 03/07/2026

**Hallazgo:** el `switch` que traduce código de dominio a status HTTP tiene 113 `case`. **Tres** corresponden a códigos que **no produce nada en todo el repo** (ni producción ni tests). **Dos más** (`AUTH_ERROR`, `FORBIDDEN`) tienen clase productora declarada pero que **nunca se instancia ni se lanza** en producción — los 401/403 reales se escriben directo con `res.status(...)`, sin pasar por el middleware de error.

**Cómo se determinó que parece no usarse:** extracción de los 113 códigos del `switch` y búsqueda del productor de cada uno, separando producción de tests.

**Qué búsqueda se realizó:**
```
# 1. barrido automático de los 113 case contra productores
   → 3 sin ningún productor, en ninguna parte del repo:
     INVALID_RESERVATION_CONFLICT · INVALID_RESOURCE · UNSUPPORTED_RESOURCE_TYPE

# 2. los dos que el barrido dio por vivos, verificados a mano:
grep -rn "'AUTH_ERROR'" app/src --include=*.ts
  → error.middleware.ts:213 (el case)
    domain/errors.ts:233     (la clase AuthError)
    tests/domain/errors.test.ts:76
  → ningún `new AuthError(` en producción

grep -rn "'FORBIDDEN'" app/src --include=*.ts
  → 11 productores reales, y TODOS escriben la respuesta directo:
    security/auth.middleware.ts:380,420 · platform/platform.auth.middleware.ts:116
    facturacion/invoices.routes.ts:166,176 · pms-estadias/stays.routes.ts:124,156
    api/routes/customer.routes.ts:323,356
  → ningún `throw new ForbiddenError(` en producción

# 3. origen de los fósiles
git log -S "UNSUPPORTED_RESOURCE_TYPE" --date=short -- src/
  → 2026-07-03  5741305  chore: final cleanup — remove ResourceType from all production files
git log -S "INVALID_RESERVATION_CONFLICT" --date=short -- src/
  → 2026-08-09  5cc8cba  fix(error-middleware): mapear 402, 503 y errores de tenant
```

**Evidencia:**
- `src/api/middleware/error.middleware.ts:140-141` — `case 'INVALID_RESOURCE':` / `case 'UNSUPPORTED_RESOURCE_TYPE':`
- `src/api/middleware/error.middleware.ts:213` — `case 'AUTH_ERROR':`
- `src/api/middleware/error.middleware.ts:241` — `case 'FORBIDDEN':`
- `src/api/middleware/error.middleware.ts:306` — `case 'INVALID_RESERVATION_CONFLICT':`
- `src/domain/errors.ts:231-235` (`AuthError`) y `:237-241` (`ForbiddenError`) — ver F14-11: **solo las referencia su propio test**.
- **Los dos fósiles de `ResourceType` son los interesantes:** el enum se borró en `5741305` (03/07/2026) y quedó residuo en **tres** lugares distintos — estos dos `case`, el test que F13-19 ya reportó, y **`appfrontend/src/app/admin/page.tsx:143`**, que todavía ofrece al operador `options: ['CABIN','RESTAURANT_TABLE','SPA','TOUR_SEAT']`, los valores exactos del enum borrado hace 2.5 meses (ver F14-07).
- `INVALID_RESERVATION_CONFLICT` es distinto: se **agregó** el 09/08/2026 en un commit de mapeo de status, para un código que nunca existió. **Nació inalcanzable.**

**Impacto:** bajo en runtime (un `case` no tomado no cuesta nada) y real en confianza: el mapa de status es el documento de facto de "qué errores puede devolver esta API", y hoy declara 5 que no puede devolver. Un lector —humano o modelo— que busque quién produce `UNSUPPORTED_RESOURCE_TYPE` va a perder el tiempo, o peor, va a inferir que el sistema todavía tiene tipos de recurso.

**Causa probable:** dos causas distintas, y conviene no mezclarlas. (a) Los 3 fósiles: limpiezas que retiraron el productor y no el consumidor — `5741305` se llama literalmente *"final cleanup"* y no fue final. (b) `AUTH_ERROR`/`FORBIDDEN`: dos mecanismos coexistentes para el mismo hecho (error de dominio vs. respuesta HTTP directa), donde ganó el segundo y el primero no se retiró.

**Nivel de certeza:** **Alta** para los 5. Barrido automático + verificación manual de cada uno + trazado en `git log -S`.

**Severidad:** **Media.**

**Recomendación:** **tratamiento distinto por grupo, y esto es lo importante de la ficha.**
- **Los 3 fósiles** (`INVALID_RESOURCE`, `UNSUPPORTED_RESOURCE_TYPE`, `INVALID_RESERVATION_CONFLICT`): borrar. Cero productores en todo el repo.
- **`AUTH_ERROR` y `FORBIDDEN`: NO borrar sin decidir primero.** El propio archivo declara, en el bloque de 402 (`:216-218`), que usa este mapa como **red de seguridad** a propósito: *"Red de seguridad: PlanLimitError se captura localmente en los routers. Si por algún motivo llega aquí, devolvemos 402 igual."* Con ese criterio escrito, borrar `case 'FORBIDDEN'` degradaría un 403 a 500 el día que alguien sí lance un `ForbiddenError`. La pregunta *"¿este `switch` es un mapa de lo que pasa, o una red de lo que podría pasar?"* es una decisión de diseño que el repo tiene contestada a medias, y no me corresponde resolverla.

**¿Requiere modificar código?:** Sí para los 3 fósiles. Los otros 2, decisión previa.

**Qué riesgo existe:** borrar los 3 fósiles tiene riesgo prácticamente nulo. Borrar los otros 2 convierte 401/403 en 500 en un camino futuro.

**Cómo verificarlo antes de eliminarlo:** `grep -rn "'<CODIGO>'" app/src --include=*.ts` → debe devolver **solo** la línea del `case`. Es exactamente el criterio que usé, y es barato de repetir.

**¿Debería marcarse primero como obsoleto?:** **No** para los 3 fósiles — marcar un `case` muerto es más ruido que borrarlo. **Sí** para `AUTH_ERROR`/`FORBIDDEN`: un comentario que diga *"sin productor hoy; se conserva como red de seguridad, mismo criterio que el bloque 402"* convierte una ambigüedad en una decisión escrita.

**Prueba necesaria:** `npm test` (hay tests de `error.middleware`). Y si se decide conservar la red de seguridad, un test que lance `new ForbiddenError()` por el middleware y espere 403 — hoy esa garantía no la prueba nadie.

---

### F14-07 — `ApiBlock.tsx` muere con la página de F7-14(1); su prop `noAuth` no se lee; y su formulario ofrece un enum borrado hace 2.5 meses

**Hallazgo:** tres cosas encadenadas que F7-14 no cubrió, colgando de la página huérfana que **sí** cubrió.
1. `src/components/ApiBlock.tsx` (componente de 16, el más grande de los no compartidos) tiene **un solo consumidor: `src/app/admin/page.tsx`**. Si esa página se retira —F7-14(d) lo plantea y lo deja a decisión del dueño—, el componente queda huérfano en el mismo movimiento. F7-14 lo nombra como evidencia (*"ApiBlock.tsx:3,52 usa apiFetch"*) pero no como candidato.
2. La prop `noAuth` está **declarada en `Props` y nunca desestructurada** — se pasa y se descarta.
3. El formulario "Crear reserva" ofrece `resourceType` con los cuatro valores del enum `ResourceType` **borrado el 03/07/2026** (`5741305`).

**Cómo se determinó que parece no usarse:** grafo propio de importadores del frontend (con resolución del alias `@/`), más lectura directa de la firma del componente, más cruce contra el enum del backend.

**Qué búsqueda se realizó:**
```
# (1) consumidores de ApiBlock
grep -rn "ApiBlock" appfrontend/src | grep -v "^src/components/ApiBlock.tsx:"
  → 14 hits, TODOS en src/app/admin/page.tsx (líneas 4, 99, 120, 121, 131, 132,
    152, 156, 160, 164, 174, 186, 200, 227)
  contraste — ApiSection.tsx (nombre parecido) SÍ está vivo:
  grep -rn "ApiSection" … → src/app/dashboard/reportes/page.tsx:3,383,399,418,434,469

# (2) noAuth
grep -n "noAuth" appfrontend/src/components/ApiBlock.tsx appfrontend/src/app/admin/page.tsx
  → ApiBlock.tsx:20   noAuth?: boolean            (en el type Props)
    admin/page.tsx:102 noAuth                     (se pasa)
  → la desestructuración real, ApiBlock.tsx:36-38:
      export default function ApiBlock({
        method, label, buildUrl, buildBody, inputs = [], onToken,
      }: Props) {
    — noAuth NO está. Nunca se lee.

# (3) el enum fósil
appfrontend/src/app/admin/page.tsx:143
  { key: 'resourceType', …, options: ['CABIN','RESTAURANT_TABLE','SPA','TOUR_SEAT'], required: true }
grep -rn "CABIN|RESTAURANT_TABLE|TOUR_SEAT|ResourceType" app/src --include=*.ts
  → 0 usos vivos. Solo comentarios históricos que documentan su eliminación:
    reservas/resource-category.types.ts:7  "Reemplaza el enum ResourceType hardcodeado."
    reservas/resource.repository.ts:6,8    "Se reemplaza getByType(type: ResourceType)…"
```

**Evidencia:** `appfrontend/src/components/ApiBlock.tsx:20` (declaración de `noAuth`), `:36-38` (desestructuración sin `noAuth`), `:50-57` (siempre `apiFetch`, que manda la cookie). `appfrontend/src/app/admin/page.tsx:102` (pasa `noAuth`), `:143` (el enum fósil), `:110` (`localStorage.setItem('token', t)` — escritura que nadie lee salvo el guard de la propia página, `:24`).

**Impacto:** `noAuth` es **una prop que miente**: el bloque de login la pasa para declarar "esta llamada no lleva auth", y el componente manda la cookie igual. Es el tipo de residuo que un lector interpreta como intención de diseño. El enum fósil significa que ese formulario produciría un 400 hoy — la consola "de emergencia" está rota y nadie se enteró en 2.5 meses, lo que a su vez es la mejor evidencia de que **nadie la usa**, que es justo el dato que F7-14(d) declaró faltante para decidir.

**Causa probable:** la página quedó fuera del circuito de mantenimiento (no la enlaza nada, no la abre nadie), así que ningún cambio de contrato la actualizó. `noAuth` es residuo de una versión anterior del componente.

**Nivel de certeza:** **Alta** para los tres puntos.

**Severidad:** **Media**, y sube por una razón de proceso: **el enum fósil es información nueva para la decisión pendiente de F7-14(d)**. Esa ficha dijo *"Requiere DECISIÓN DEL DUEÑO: es una herramienta, y puede seguir usándola"*. Una herramienta cuyo formulario principal está roto hace 2.5 meses sin que nadie reclame es evidencia fuerte de que **no** se está usando.

**Recomendación:** **no abrir una decisión nueva** — aportar estos tres datos a la decisión de F7-14(d), que ya está abierta. Si se retira la página, `ApiBlock.tsx` se va en el mismo commit. Si se conserva bajo `src/app/dev/` (opción de F7-14(d)), hay que arreglar el enum y sacar `noAuth` — conservarla tal cual es conservar una herramienta rota.

**¿Requiere modificar código?:** Sí, condicionado a la decisión ya pendiente.

**Qué riesgo existe:** borrar `ApiBlock.tsx` junto con su única página tiene riesgo nulo (`tsc` lo verifica). El riesgo real es el inverso: **conservar** la página sin arreglar el enum deja una herramienta de emergencia que falla justo cuando se la necesita.

**Cómo verificarlo antes de eliminarlo:** `grep -rn "ApiBlock" appfrontend/src` → debe quedar en 0 tras borrar `app/admin/`; después `npx tsc --noEmit` y `npm run build`.

**¿Debería marcarse primero como obsoleto?:** La página ya tiene ficha abierta hace un día (F7-14). Marcarla otra vez no aporta; **lo que aporta es cerrar la decisión**, y esta ficha le da el dato que le faltaba.

**Prueba necesaria:** `npm run build` + `npx tsc --noEmit` del frontend tras el cambio.

---

### F14-08 — `DATE_ONLY_REGEX` es el helper compartido que nadie adoptó: 0 importadores y 6 reescrituras del mismo regex, una con el mismo nombre

**Hallazgo:** `src/api/schemas/common.schemas.ts` existe para ser la fuente única de los regex compartidos, y para el regex de **hora** funciona (4 importadores). Para el de **fecha**, no: `DATE_ONLY_REGEX` **no lo importa nadie** y el mismo literal está reescrito en **6 lugares** — incluido un archivo que declara su propia constante **con el mismo nombre**.

**Cómo se determinó que parece no usarse:** `knip` marcó `DATE_ONLY_REGEX` como export sin uso; al verificar por qué, aparecieron las copias.

**Qué búsqueda se realizó:**
```
npx knip → DATE_ONLY_REGEX  src/api/schemas/common.schemas.ts:24  (Unused exports)

grep -rn 'd{4}-' app/src --include=*.ts | grep -v "\.test\.ts"
  src/api/schemas/common.schemas.ts:24        export const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;   ← el compartido
  src/api/schemas/maintenance-window.schemas.ts:9  const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;      ← MISMO NOMBRE, local
  src/api/schemas/bookable-service.schemas.ts:65   const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, …)
  src/api/schemas/facturacion.schemas.ts:51        caeVto: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, …)
  src/pms-estadias/housekeeping.routes.ts:61       !/^\d{4}-\d{2}-\d{2}$/.test(rawDate as string)
  src/pms-estadias/housekeeping.routes.ts:99       !/^\d{4}-\d{2}-\d{2}$/.test(rawDate as string)
  src/reservas/bookable-services.routes.ts:274     !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)

# contraste: el gemelo de HORA sí fue adoptado
grep -rn "common.schemas" app/src --include=*.ts | grep -v test
  → TIME_ONLY_REGEX importado por: openapi/spec.ts:6, api/schemas/request.schemas.ts:29,
    api/schemas/stay.schemas.ts:8, api/schemas/bookable-service.schemas.ts:7
  → dateOnlySchema importado por: api/schemas/report.schemas.ts:13  (y nada más)
  → DATE_ONLY_REGEX importado por: NADIE
```

**Evidencia:** las 7 líneas de arriba, todas verificadas. Y `bookable-service.schemas.ts` es el caso más elocuente: **importa `TIME_ONLY_REGEX` del helper compartido en la línea 7 y reescribe el regex de fecha a mano en la línea 65**, en el mismo archivo.

**Impacto:** siete definiciones del mismo formato. Hoy son idénticas —lo verifiqué carácter por carácter— así que no hay bug. Pero el día que haga falta aceptar `YYYY-M-D` o rechazar `2026-02-30`, el cambio tiene que ocurrir en siete lugares y basta olvidar uno para que dos endpoints validen distinto la misma fecha. La copia de `maintenance-window.schemas.ts:9` es la peor: **mismo nombre, distinto archivo** — un lector que vea `DATE_ONLY_REGEX` ahí va a asumir que es el compartido.

**Causa probable:** el `CLAUDE.md` del backend declara la regla **solo para la hora**: *"Regex de hora HH:MM/HH:MM:SS → `api/schemas/common.schemas.ts` (`TIME_ONLY_REGEX`/`timeOnlySchema`), no lo reescribas inline."* El de fecha se exportó junto al de hora pero nunca entró en la regla escrita, y por eso nadie lo adoptó. **La convención funcionó exactamente hasta donde estaba escrita** — es un dato útil sobre cómo se sostienen las convenciones en este repo.

**Nivel de certeza:** **Alta.** Los 7 sitios verificados a mano; el contraste con `TIME_ONLY_REGEX` verificado.

**Severidad:** **Media.** Sube de Baja porque toca validación de entrada en endpoints fiscales (`caeVto`) y de disponibilidad.

**Recomendación:** **no borrar `DATE_ONLY_REGEX` — adoptarlo.** Es el caso donde "export sin uso" no significa "sobra", sino "la convención no se aplicó". Reemplazar las 6 copias por el import, borrar la constante duplicada de `maintenance-window.schemas.ts:9`, y **agregar la fila de fecha al `CLAUDE.md`**, al lado de la de hora — sin eso, la copia vuelve en el próximo archivo nuevo.

**¿Requiere modificar código?:** Sí, 6 archivos. Cambio mecánico y de bajo radio.

**Qué riesgo existe:** **Bajo.** Los 7 literales son idénticos; el reemplazo es semánticamente nulo. El único cuidado es el choque de nombres en `maintenance-window.schemas.ts`.

**Cómo verificarlo antes de eliminarlo:** comparar los 7 literales carácter por carácter antes de unificar (ya lo hice: idénticos). Después, `npm test` — hay tests de schemas que ejercitan la validación de fecha.

**¿Debería marcarse primero como obsoleto?:** **No.** Es lo contrario de obsoleto: es el canónico sin adoptar.

**Prueba necesaria:** `npm test` + `npm run lint`. Los tests de schema existentes cubren el cambio.

---

### F14-09 — El contrato de "disponibilidad parcial" (v4) está declarado, documentado y sin un solo consumidor en ninguno de los dos repos

**Hallazgo:** `src/types/visual.interface.ts` declara tres tipos —`OccupancyStatus`, `OccupancyState`, `ResourceVisualState`— bajo un encabezado *"## Cambios v4 — Disponibilidad parcial"*, con docblocks que describen hasta los colores que el frontend debería pintar. **Ninguno lo importa nadie, en ninguno de los dos repos.** Del archivo solo vive `VisualMetadata`.

**Cómo se determinó que parece no usarse:** `knip` los reportó como tipos exportados sin uso; verifiqué los importadores del archivo en backend y busqué los nombres y los campos en el frontend.

**Qué búsqueda se realizó:**
```
npx knip → OccupancyStatus (:36), OccupancyState (:38), ResourceVisualState (:61)
           en "Unused exported types"

grep -rn "visual.interface" app/src --include=*.ts
  → 5 importadores, y los 5 importan SOLO VisualMetadata:
    reservas/resource.entities.ts:29 · reservas/sql.resource.repository.ts:26
    reservas/resources.routes.ts:44 · api/mappers/reservation.mapper.ts:14
    tests/domain/resource.entities.test.ts:5

grep -rn "OccupancyState|ResourceVisualState|OccupancyStatus|availableSlots|occupiedSlots" appfrontend/src
  → 0 hits de los tres tipos.
  → los hits de "availableSlots" son otra cosa: hooks/useReservationsScreen.ts:181,198
    (un string[] de horarios de turno, no el OccupancyState del backend)

grep -rn "availableSlots|occupiedSlots|totalCapacity" app/src --include=*.ts | grep -v visual.interface
  → reservas/resource.entities.ts:102  availableSlots(…)  → devuelve NUMBER, no OccupancyState
    reservas/reservation-availability.service.ts:199,340  const slotsLeft = resource.availableSlots(…)
```

**Evidencia:** `src/types/visual.interface.ts:36` (`OccupancyStatus`), `:38-49` (`OccupancyState`), `:61-66` (`ResourceVisualState`), y `:53-60` — el docblock que promete el consumidor que no existe: *"El frontend puede usar este tipo directamente para pintar el plano: `occupancy.status === 'available'` → verde, `'partial'` → amarillo + badge "X lugares"…"*.

**Impacto:** el cálculo de capacidad parcial **sí existe** en el dominio (`PhysicalResource.availableSlots()` devuelve un número y se usa en dos lugares del servicio de disponibilidad), pero el **contrato** que lo expondría —el que distingue `partial` de `full` y lleva el desglose ocupado/libre— no llega a ninguna capa superior. El frontend no puede mostrar "8/15 lugares" porque el backend nunca se lo manda en esa forma. Es un tipo que documenta una capacidad que el producto no tiene, en el archivo que `CLAUDE.md` reserva para lo *"genuinamente transversal"*.

**Causa probable:** diseño de contrato adelantado a la implementación ("Cambios v4"), con la parte de dominio construida y la de transporte/UI nunca conectada.

**Nivel de certeza:** **Alta.** Verificado en los dos repos, con búsqueda por nombre de tipo y por nombre de campo.

**Severidad:** **Media.** Como código, es inerte. Como documentación, afirma una capacidad de producto inexistente en un archivo que se lee como referencia.

**Recomendación:** **no borrar sin preguntar.** Son 30 líneas de tipos, y la pregunta real —*"¿la disponibilidad parcial es una feature viva del roadmap o se descartó?"*— es de producto. Es el mismo patrón que F14-03: andamiaje, no residuo. Lo que sí corresponde ya, sin decisión de nadie: **corregir el docblock** para que no afirme en presente (*"El frontend puede usar este tipo directamente"*) algo que no ocurre.

**¿Requiere modificar código?:** No para el hallazgo. Sí, mínimo, para el docblock.

**Qué riesgo existe:** borrar es reversible y barato (`tsc` lo verifica). El riesgo es de conocimiento: se pierde el diseño de `partial`/`full`/`blocked`, que es la parte pensada.

**Cómo verificarlo antes de eliminarlo:** preguntar al dueño si "disponibilidad parcial" sigue en el roadmap; después `npx tsc --noEmit` en los dos repos.

**¿Debería marcarse primero como obsoleto?:** **No como obsoleto** — la misma etiqueta que propongo en F14-03: **"declarado, sin implementar"**, con fila en `docs/roadmap-pms-multirubro.md`. Es exactamente el tipo de cosa que el roadmap existe para llevar.

**Prueba necesaria:** ninguna para detectarlo. Si se implementa, test de integración que devuelva `partial` con capacidad parcialmente ocupada.

---

### F14-10 — 188 líneas duplicadas literales entre `reservas` y `turnos`, con el hook compartido que debía sustituirlas ya creado y en uso

**Hallazgo:** `jscpd` encuentra **4 clones exactos, 188 líneas**, entre `dashboard/reservas/page.tsx` y `dashboard/turnos/page.tsx`. Lo que hace de esto un hallazgo de esta fase y no de Fase 3: **el helper que venía a sustituir esa duplicación ya existe, ya se usa en las dos pantallas, y la duplicación sobrevivió igual.**

**Cómo se determinó:** `jscpd` sobre el frontend, con el resultado cruzado contra la convención declarada.

**Qué búsqueda se realizó:**
```
npx jscpd src --min-lines 30 --min-tokens 200 --ignore "**/*.test.*"
  → 5 exact clones, 221 líneas (0.90%) en 101 archivos
  4 de los 5 son el par reservas/turnos:
    reservas/page.tsx 138-171  ↔  turnos/page.tsx  86-112   (34 líneas)
    reservas/page.tsx 283-316  ↔  turnos/page.tsx 164-197   (34 líneas)
    reservas/page.tsx 384-426  ↔  turnos/page.tsx 259-301   (43 líneas)
    reservas/page.tsx 531-607  ↔  turnos/page.tsx 403-484   (77 líneas)
  el 5º es otro par: recursos/[id]/page.tsx 204-241 ↔ recursos/page.tsx 144-183 (38 líneas)

# el helper existe y las dos pantallas lo usan
appfrontend/src/hooks/useReservationsScreen.ts
  reservas/page.tsx:146  const { availableSlots, setAvailableSlots, loadingSlots } = useAvailableSlots(…)
  turnos/page.tsx:90     const { availableSlots, setAvailableSlots, loadingSlots } = useAvailableSlots(…)
```

**Evidencia:** las 4 parejas de rangos de arriba, más el `CLAUDE.md` del frontend, que declara la convención en presente: *"Traer recursos/servicios/categorías, filtrar por `isLodging`, listar/buscar/paginar reservas, y confirmar/cancelar/completar → ya existe `useReservationsScreen(isLodging)` (`hooks/useReservationsScreen.ts`), **compartido entre Reservas y Turnos**. Si agregás una tercera pantalla con esta misma forma, extendé el hook, no copies el bloque."*

El bloque duplicado más grande (77 líneas, `reservas:531-607` ↔ `turnos:403-484`) es el **selector de turnos disponibles en el JSX**; el de 34 líneas de `reservas:138-171` incluye `selectSlot()` y el comienzo de `handleCreateReservation()` — o sea, **lógica de submit**, no solo markup.

**Por qué no lo re-deriva de Fase 3:** revisé `auditoria-integral-fase3-duplicacion-2026-09-15.md`. Trata el par reservas/turnos **una sola vez** (`:478`) y solo para la máquina de estados, concluyendo *"No se reporta como hallazgo — impacto insuficiente"*. La duplicación literal de 188 líneas no está medida ahí. Fase 3 miró duplicación **semántica**; esto es textual y `jscpd` lo cuantifica.

**Impacto:** la convención declara una fuente única que en los hechos cubre solo una parte. Un cambio en el flujo de creación de reserva hay que hacerlo dos veces, y el `CLAUDE.md` dice que no hace falta. Ese desajuste entre regla escrita y código es más caro que la duplicación misma: quien confíe en la regla va a tocar un solo lado.

**Causa probable:** extracción parcial. Se extrajo lo que era fácil de extraer (fetch de datos, filtros, acciones) y se dejó lo que estaba entrelazado con JSX y estado de formulario, sin registrar que la extracción quedó a medias.

**Nivel de certeza:** **Alta.** Medición de herramienta + verificación de que el hook existe y se usa.

**Severidad:** **Media.**

**Recomendación:** **no borrar nada** — los dos lados están vivos. Completar la extracción (el selector de turnos es el candidato obvio: 77 líneas, alta cohesión, ya depende de `useAvailableSlots`), o —si se decide que no conviene— **corregir el `CLAUDE.md`** para que declare qué cubre el hook y qué no. Hoy la regla promete más de lo que el código cumple.

**¿Requiere modificar código?:** Sí para extraer; no si se elige corregir el documento.

**Qué riesgo existe:** extraer JSX compartido entre dos pantallas con estado de formulario propio tiene riesgo medio de regresión visual. No hacerlo tiene riesgo permanente de fix aplicado a un solo lado.

**Cómo verificarlo antes de eliminarlo:** no se elimina. Para confirmar la medición: el comando `jscpd` de arriba es reproducible y determinista.

**¿Debería marcarse primero como obsoleto?:** No aplica.

**Prueba necesaria:** `npm run test:unit` + `npm run build` + revisión visual de las dos pantallas si se extrae.

---

### F14-11 — Tres clases de error muertas, y dos de ellas siguen vivas **únicamente** porque su test las instancia

**Hallazgo:** de las 84 clases de `src/domain/errors.ts`, **tres no se usan en producción**. `CustomerRateNotFoundError` no tiene **ninguna** referencia en todo el repo —ni su propio test—. `AuthError` y `ForbiddenError` tienen exactamente un referente cada una: `src/tests/domain/errors.test.ts`.

**Cómo se determinó que parece no usarse:** barrido de las 84 clases separando referencias de producción de las de test, y verificación manual de las 3 (necesaria: mi script cuenta ocurrencias textuales, y un comentario puede dar un falso "vivo" — ver §6).

**Qué búsqueda se realizó:**
```
# barrido de las 84 clases
  → 3 sin referencia en código de producción:
    errors.ts:231  AuthError                  → 1 archivo: src/tests/domain/errors.test.ts
    errors.ts:237  ForbiddenError             → 1 archivo: src/tests/domain/errors.test.ts
    errors.ts:261  CustomerRateNotFoundError  → 0 archivos. Cero, en todo el repo.

# verificación manual
grep -rn "\bCustomerRateNotFoundError\b" app/src --include=*.ts
  → 1 solo hit: src/domain/errors.ts:261 (la declaración)
grep -n "AuthError|ForbiddenError" app/src/tests/domain/errors.test.ts
  → :11,:12 (imports) · :73,:75,:81 (AuthError) · :86,:88 (ForbiddenError)
grep -rn "new AuthError\(|new ForbiddenError\(|throw new CustomerRateNotFoundError" app/src --include=*.ts
  → 0 en producción

# contraste: el vecino de al lado SÍ se usa
grep -rn "CustomerRateConflictError" app/src --include=*.ts   → sí tiene call sites de producción
```

**Evidencia:** `src/domain/errors.ts:231-235`, `:237-241`, `:261-265`. `src/tests/domain/errors.test.ts:73-90`. Y el vínculo con F14-06: `case 'AUTH_ERROR'` (`error.middleware.ts:213`) y `case 'FORBIDDEN'` (`:241`) son los `case` inalcanzables **de estas mismas dos clases**.

**Impacto:** el caso interesante no es el desperdicio, es **`AuthError`/`ForbiddenError`**. Están cubiertas por tests que pasan, así que aparecen verdes en cobertura y vivas para `knip` (que trata los tests como entry points). Es la forma más difícil de código muerto: **un test que no prueba un comportamiento del sistema, sino que mantiene con vida el código que prueba**. `CustomerRateNotFoundError` es el caso trivial: 5 líneas y nada más.

**Causa probable:** `AuthError`/`ForbiddenError` son el mecanismo de autz **anterior**; ganó responder con `res.status(401|403).json(...)` directo desde el middleware (11 sitios verificados en F14-06) y el mecanismo viejo no se retiró. `CustomerRateNotFoundError` se creó por simetría con `CustomerRateConflictError` —que sí se usa— para un camino de error que nunca se implementó.

**Nivel de certeza:** **Alta** para las tres.

**Severidad:** **Baja** por sí misma. **Media leída junto a F14-06**, porque las dos fichas describen las dos puntas del mismo mecanismo retirado a medias.

**Recomendación:**
- `CustomerRateNotFoundError`: borrar. Cero referencias, cero riesgo.
- `AuthError` / `ForbiddenError`: **atar la decisión a la de F14-06.** Si se decide que el mapa de status es una red de seguridad, las clases se quedan y hay que **agregar el test que hoy falta**: lanzar `ForbiddenError` **a través del middleware** y verificar 403 — lo que hoy prueba `errors.test.ts` es solo que el constructor asigna un string, no que el sistema haga algo con él. Si se decide que el mapa refleja lo que pasa, se van las clases, sus dos `case` y el bloque del test, todo junto.

**¿Requiere modificar código?:** Sí, y para 2 de 3 también un test.

**Qué riesgo existe:** borrar `CustomerRateNotFoundError`, nulo. Borrar las otras dos sin resolver F14-06 deja dos `case` sin clase productora — peor que ahora.

**Cómo verificarlo antes de eliminarlo:** `grep -rn "\b<Clase>\b" app/src --include=*.ts` → para `CustomerRateNotFoundError` debe dar exactamente 1 hit (su declaración). Después `npx tsc --noEmit` + `npm test`.

**¿Debería marcarse primero como obsoleto?:** **No.** Marcar una clase de error como obsoleta no cambia nada mientras su test la siga instanciando. El paso útil no es una marca: es **mirar los tests de `errors.test.ts` y preguntarse cuáles prueban comportamiento y cuáles solo prueban un constructor.**

**Prueba necesaria:** `npm test`. Y si se conservan, el test de integración por el middleware que hoy no existe.

---

### F14-12 — El docblock de `tenant-db.setup.ts` describe como "flujo actual" un alta manual que el aprovisionamiento automático reemplazó tres días después

**Hallazgo:** `src/platform/tenant-db.setup.ts` lleva una sección titulada **"## Flujo actual de alta de un negocio (creación de BD manual, resto ya no)"** cuyo paso 2 dice *"Alguien crea la BD del negocio a mano (hoy: un proyecto Neon)"*. Ese texto se escribió el **12/08/2026**; el aprovisionamiento automático (`neon-provisioning.ts`, `provisionTenantDatabase()`) entró el **15/08/2026**, está montado, y el frontend lo usa. El docblock nunca se actualizó.

**Cómo se determinó:** el archivo apareció en el barrido de marcadores `legado/obsoleto`; al verificar qué estaba retirado, resultó que lo retirado era el texto.

**Qué búsqueda se realizó:**
```
grep -rniE "legad[oa]|legacy|obsolet[oa]|ya no se usa" app/src --include=*.ts | grep -v "\.test\.ts"
  → src/platform/tenant-db.setup.ts:6  "Ese flujo automático ya no se usa (dejaron de operar con Supabase)"

grep -rn "neon-provisioning" app/src --include=*.ts
  → src/platform/business.routes.ts:43   import { provisionTenantDatabase } …
    src/platform/platform.routes.ts:14   import { provisionTenantDatabase } …
    (+ 2 tests que lo mockean)  → el módulo está VIVO

git log --date=short -- src/platform/neon-provisioning.ts
  2026-08-15 ee0c34d feat(platform): aprovisionamiento automatico de tenants (Neon) …
  2026-08-15 d1fc676 fix(platform): endpoint real de la API de Neon para el connection string

git log -L 13,25:src/platform/tenant-db.setup.ts --date=short
  → el bloque "Flujo actual" data de 2026-08-12 (d5643ce). Tres días ANTES.

# y el consumidor existe del otro lado
appfrontend/src/lib/platformApi.ts:114
  platformFetch(`/platform/businesses/${id}/provision`, { … })
```

**Evidencia:** `src/platform/tenant-db.setup.ts:1-30` (el docblock completo, con su sección "Flujo actual"), `src/platform/neon-provisioning.ts:107` (`provisionTenantDatabase`), `src/platform/business.routes.ts:43` y `src/platform/platform.routes.ts:14` (importadores vivos), `appfrontend/src/lib/platformApi.ts:114` (consumidor).

**Un matiz que corresponde dejar dicho:** la **primera mitad** de ese mismo docblock (`:5-8`) es un ejemplo de retiro **bien hecho** — el flujo de Supabase se eliminó del código y el comentario explica por qué el archivo ya no se llama `supabase.provisioner.ts`. El mismo archivo documenta correctamente un retiro viejo y describe mal el flujo vigente.

**Impacto:** el docblock del archivo que aplica el schema de tenant es lo primero que lee alguien que investiga un alta de negocio. Hoy lo manda a un procedimiento manual que el producto ya no usa, y **no menciona el endpoint automático que sí existe**. En una emergencia de aprovisionamiento eso es tiempo perdido en el peor momento.

**Causa probable:** el commit que trajo el aprovisionamiento automático tocó `neon-provisioning.ts`, `business.routes.ts` y `platform.routes.ts`, pero no el docblock del módulo vecino que describía el flujo anterior. Es el mismo patrón que el `CLAUDE.md` del backend narra en su regla 4 de "Pendientes" (*"si el ítem cita un documento versionado, cita la versión — y se re-chequea en el mismo commit"*), aplicado a un docblock en vez de a un pendiente.

**Nivel de certeza:** **Alta.** Fechas de git verificadas en los dos archivos; importadores vivos verificados; consumidor del frontend verificado.

**Severidad:** **Baja** por efecto en runtime (cero). Real por efecto en tiempo de diagnóstico.

**Recomendación:** corregir el docblock: agregar `POST /platform/businesses/:id/provision` como paso automático vigente, y reetiquetar el flujo manual como el camino de respaldo que es. **No borrar** el flujo manual del texto: sigue siendo válido y es el que documentan los runbooks (`docs/conocimiento/runbook-deploy-render.md:411`).

**¿Requiere modificar código?:** No — solo comentario. Es el cambio de menor riesgo de toda la fase.

**Qué riesgo existe:** ninguno al corregirlo. Dejarlo mantiene una instrucción incorrecta en el camino crítico de alta de tenant.

**Cómo verificarlo antes de eliminarlo:** no se elimina nada. Antes de reescribir, confirmar con el dueño si el alta manual sigue siendo el fallback soportado (los runbooks dicen que sí).

**¿Debería marcarse primero como obsoleto?:** No aplica — la corrección **es** la acción.

**Prueba necesaria:** ninguna (comentario). Idealmente, releer `docs/conocimiento/runbook-deploy-render.md:411` en el mismo cambio para que los dos textos digan lo mismo.

---

### F14-13 — `src/pages/` existe con solo un `.gitkeep` en un proyecto App Router: un Pages Router fantasma

**Hallazgo:** el frontend tiene `src/pages/`, cuyo único contenido es un `.gitkeep` de 0 bytes. Next.js 16 trata `src/pages/` como la raíz del **Pages Router**. Hoy es inocuo porque `.gitkeep` no es una ruta, pero es un directorio que el framework inspecciona y que no corresponde a ninguna decisión vigente.

**Cómo se determinó:** inventario de directorios del frontend; `src/pages` llamó la atención en un proyecto cuyo `AGENTS.md` advierte que esta versión de Next difiere de lo conocido.

**Qué búsqueda se realizó:**
```
ls -la appfrontend/src/pages
  → total 8 · solo .gitkeep (0 bytes)
git log --date=short -- appfrontend/src/pages
  → 2026-08-25  0ee207b  refactor(dashboard): migrar modales a rutas dedicadas (auditoría UX)
find appfrontend/src -name "*.css"
  → solo src/app/globals.css   (confirma que no hay restos de Pages Router)
```

**Evidencia:** `appfrontend/src/pages/.gitkeep`, creado en `0ee207b` (25/08/2026) — el mismo commit que creó `src/lib/auth.tsx`, el archivo muerto de F7-14(2). Existe también `src/components/.gitkeep`, pero ese convive con 15 componentes reales: es un residuo inofensivo de scaffolding inicial. **`src/pages/.gitkeep` es el único que sostiene un directorio por lo demás vacío.**

**Impacto:** bajo hoy. El riesgo es de futuro y de ambigüedad: el directorio comunica que este proyecto usa Pages Router, y basta que alguien deposite ahí un `.tsx` —cosa que el propio directorio invita a hacer— para que Next.js empiece a resolver rutas por dos sistemas a la vez. En un repo cuyo `AGENTS.md` abre con *"This is NOT the Next.js you know"*, un directorio que sugiere el router equivocado es una trampa barata de sacar.

**Causa probable:** scaffolding inicial (`pages`, `components`) conservado con `.gitkeep`; el proyecto adoptó App Router y `src/pages/` quedó sin vaciarse.

**Nivel de certeza:** **Alta** para el hecho. **No confirmado:** el efecto exacto de un `src/pages/` vacío en Next.js **16.3.1** — ver §5.

**Severidad:** **Baja.**

**Recomendación:** borrar `src/pages/` (y con él su `.gitkeep`). Dejar `src/components/.gitkeep` donde está — no molesta.

**¿Requiere modificar código?:** No; borrado de directorio.

**Qué riesgo existe:** **Muy bajo**, con una condición: verificar antes que ninguna config lo referencie.

**Cómo verificarlo antes de eliminarlo:**
```
grep -rn "src/pages" appfrontend --include=*.js --include=*.json --include=*.ts --exclude-dir=node_modules --exclude-dir=.next
npm run build     # debe compilar igual
npx next build    # comparar la lista de rutas emitidas antes y después
```

**¿Debería marcarse primero como obsoleto?:** **No.** Un directorio vacío no admite marca útil: o se borra o se queda.

**Prueba necesaria:** `npm run build` con la misma lista de rutas antes y después.

---

### F14-14 — Los barrels de compatibilidad tienen ~40 re-exports que no importa nadie

**Hallazgo:** `appfrontend/src/lib/types.ts` (47 líneas) y `src/lib/api.ts` (38) son barrels de compatibilidad. Están **vivos** —53 archivos hacen 93 imports de ellos— pero `ts-prune` marca ~40 símbolos re-exportados que **ningún archivo importa desde el barrel**.

**Cómo se determinó:** `ts-prune`, filtrando el ruido de entry points de Next.

**Qué búsqueda se realizó:**
```
npx ts-prune
  → ~40 entradas en src/lib/types.ts y src/lib/api.ts, entre ellas:
    RecordWasteInput, RecordConsumptionInput, CustomerTag, CustomerListFilters,
    UpsertCustomerTaxProfileInput, TaxpayerLookupResult, CreateResourceInput,
    UpdateResourceInput, CreateTeamMemberInput, UserInvitationStatus,
    CreateBookableServiceInput, ResourceLock, CreateRatePlanInput,
    CreateServiceScheduleInput, StayStatus, CheckInInput, CheckOutInput,
    RecordProductionInput, Company, OrderItemType, CreateOrderInput,
    ListOrdersFilters, DeadLetterEvent, InvoiceStatus, …

grep -rn "from '@/lib/types'|from '@/lib/api'" appfrontend/src --include=*.ts --include=*.tsx | wc -l  → 93
grep -rln … | wc -l                                                                                    → 53
```

**Evidencia:** `appfrontend/src/lib/types.ts:11-47` y `src/lib/api.ts`. El docblock del barrel explica su razón de ser (`:1-9`): *"queda como punto de entrada único para que las pantallas del dashboard que ya hacían `import type { X } from '@/lib/types'` no necesiten tocar un solo import"*.

**Impacto:** mínimo. Un re-export sin importador cuesta una línea y nada en runtime (`export type` se borra en compilación). **Lo reporto por completitud del barrido, y con una conclusión explícita de no-acción**, para que una ejecución futura de `ts-prune` no lo redescubra como si fuera deuda.

**Causa probable:** ninguna: es exactamente lo que la convención pide. El `CLAUDE.md` del frontend instruye *"se agrega también como re-export en el barrel"* para **todo** tipo nuevo, sin condicionarlo a que alguien lo importe desde ahí. Un barrel construido con esa regla **acumula entradas sin importador por diseño**.

**Nivel de certeza:** **Media.** El conteo es de `ts-prune` y no verifiqué las ~40 una por una — a diferencia del resto de la fase, donde sí lo hice. Lo declaro porque la acción recomendada es "ninguna" y el costo de equivocarse es cero.

**Severidad:** **Baja.**

**Recomendación:** **no tocar.** Y, si se quiere cerrar el tema, una línea en el `CLAUDE.md` del frontend diciendo que un re-export sin importador en estos dos archivos **es el resultado esperado de la convención, no deuda** — así la próxima corrida de `ts-prune` no reabre esto.

**¿Requiere modificar código?:** No.

**Qué riesgo existe:** podar el barrel según `ts-prune` **rompería** su propósito: el próximo archivo que haga `import { X } from '@/lib/types'` fallaría, que es justo lo que el barrel viene a evitar.

**Cómo verificarlo antes de eliminarlo:** no eliminar.

**¿Debería marcarse primero como obsoleto?:** No. Marcar como **convención declarada**.

**Prueba necesaria:** ninguna.

---

### F14-15 — Un `const` que dispara una búsqueda en array y descarta el resultado

**Hallazgo:** en el `onChange` del selector de productos del detalle de orden, se hace `products.find(...)`, se asigna a `prod` y no se usa.

**Cómo se determinó:** `npx eslint .` en el frontend.

**Qué búsqueda se realizó:**
```
npx eslint .
  → src/app/dashboard/ordenes/[id]/page.tsx  595:27  warning
      'prod' is assigned a value but never used  @typescript-eslint/no-unused-vars
  (las otras 2 warnings de variables son descartes intencionales: '_' y '_key')
```

**Evidencia:**
```tsx
// appfrontend/src/app/dashboard/ordenes/[id]/page.tsx:593-596
onChange={e => {
  const prod = products.find(p => p.id === e.target.value)   // ← nunca se lee
  setNewItem(n => ({ ...n, productId: e.target.value }))
}}
```

**Impacto:** un escaneo lineal del array de productos en cada cambio del selector, descartado. Irrelevante en rendimiento. Lo que importa es la **señal**: la forma del código (buscar el producto completo, y a la vez setear solo el id) es el residuo de una lógica que sí usaba el producto —muy probablemente para precargar el precio unitario— y que se retiró. Encaja con `D9-Parte 2` del backend (`src/pos-menu/sql.order.repository.ts:188-196`), donde el `unitPrice` dejó de venir del llamador y pasó a resolverse server-side.

**Causa probable:** retiro de la resolución de precio en cliente, dejando la búsqueda que la alimentaba.

**Nivel de certeza:** **Alta** para la variable muerta. **Hipótesis, no confirmada:** que el motivo haya sido D9-Parte 2 — no rastreé el `git log -S` de esa línea.

**Severidad:** **Baja.**

**Recomendación:** borrar la línea. Si la intención era mostrar el precio al elegir producto y se perdió, eso es una decisión de UI aparte.

**¿Requiere modificar código?:** Sí, una línea.

**Qué riesgo existe:** ninguno. ESLint ya prueba que nadie la lee.

**Cómo verificarlo antes de eliminarlo:** el propio warning de ESLint es la verificación. `npm run build` después.

**¿Debería marcarse primero como obsoleto?:** No. Es una línea muerta: se borra.

**Prueba necesaria:** `npx eslint .` sin ese warning + `npm run build`.

---

### F14-16 — El inventario de deuda visual del `CLAUDE.md` del frontend cita un archivo borrado hace 18 días

**Hallazgo:** el `CLAUDE.md` del frontend, en su punto 2 de reglas del sistema de diseño, dice: *"Queda pendiente `src/styles.css`, que **no lo importa nadie** — un sistema de diseño oscuro entero, muerto… **Aporta 24 de las 89**."* Ese archivo **fue borrado el 29/08/2026** en el commit `371d9c5`, titulado precisamente *"chore(visual): V2.6.2d — borrar styles.css, sistema de diseño muerto"*.

**Cómo se determinó:** intenté contar las clases Tailwind crudas que el documento atribuye a ese archivo y el archivo no existe.

**Qué búsqueda se realizó:**
```
find appfrontend/src -name "*.css"     → solo src/app/globals.css
git log --diff-filter=D --date=short -- "*styles.css"
  → 2026-08-29  371d9c5  chore(visual): V2.6.2d — borrar styles.css, sistema de diseño muerto
grep -rhoE "\b(bg|text|border|from|to|via|ring|divide)-(slate|gray|…|rose)-[0-9]{2,3}" \
  appfrontend/src --include=*.tsx --include=*.ts | wc -l
  → 69   (el documento afirma 89, de las cuales 24 serían de styles.css)
```

**Evidencia:** ausencia del archivo en el árbol; commit de borrado `371d9c5`; el texto del `CLAUDE.md` frontend, sección "Sistema de diseño", regla 2. El único rastro vivo es un comentario **correcto** en `appfrontend/src/context/ToastContext.tsx:43-46`, que narra el hecho en pasado — ese no es el problema.

**Impacto:** el inventario de deuda visual sobredeclara. Mi conteo da **69** clases crudas; el documento afirma **89**, de las cuales 24 se atribuyen a un archivo inexistente (89 − 24 = 65, razonablemente cerca de mis 69: mi regex no excluye comentarios, y el propio documento advierte sobre eso). Quien planifique la Fase V2 sobre el número del documento va a dimensionar mal.

**Causa probable:** el commit `371d9c5` hizo el trabajo y no actualizó la cita que lo daba por pendiente. Exactamente el modo de falla que el propio `CLAUDE.md` del backend describe en "Contratos" sobre las citas de 254/259/262 endpoints — *"una cita que nadie re-chequea después de regenerarse el artefacto"*. Acá pasó en el otro repo.

**Nivel de certeza:** **Alta** para el borrado y para la cita stale. **Media** para mi conteo de 69: es un regex sobre texto que incluye comentarios, y el propio documento advierte *"contarlas ignorando comentarios"*.

**Severidad:** **Baja.**

**Recomendación:** recontar con el criterio que el documento pide (ignorando comentarios) y actualizar la regla 2 del `CLAUDE.md` del frontend: sacar `src/styles.css` y corregir el total. **La cifra corregida hay que medirla, no derivarla restando** — el propio documento ya se quemó una vez con eso (*"Este punto decía 69, concentradas en `app/superadmin/*`, y las dos mitades eran falsas"*).

**¿Requiere modificar código?:** No; documentación.

**Qué riesgo existe:** ninguno al corregir.

**Cómo verificarlo antes de eliminarlo:** correr `npm run lint:visual` (`scripts/check-visual-debt.mjs`) — es el contador propio del repo y es la fuente correcta para el número, no mi regex.

**¿Debería marcarse primero como obsoleto?:** No aplica.

**Prueba necesaria:** `npm run lint:visual` + `npm run test:visual`.

---

### F14-17 — `POST /api/locations` deja crear sucursales que ningún camino del sistema puede seleccionar

**Hallazgo:** `/api/locations` expone GET y POST. El POST crea una `location`. **Nada en el sistema permite elegir entre locations**: cada consumidor real resuelve la sucursal por defecto vía `resolveDefaultLocationId()`. Una segunda location creada por ese endpoint queda persistida y estructuralmente inalcanzable.

**Cómo se determinó:** `/api/locations` apareció en F14-01 sin consumidor; al rastrear si la entidad tenía efecto downstream, resultó que lo tiene solo para la fila por defecto.

**Qué búsqueda se realizó:**
```
grep -rn "locations" appfrontend/src --include=*.ts --include=*.tsx
  → 11 hits, TODOS son `allocations` (cuentas corrientes). Cero consumidores reales.

grep -rn "LocationRepository|location.repository" app/src --include=*.ts | grep -v in-memory
  → api/routes/locations.routes.ts:20,34,46   (el CRUD)
    reservas/resources.routes.ts:35,109        new SqlLocationRepository(req.db).findAll()
    pos-menu/orders.routes.ts:67               import { resolveDefaultLocationId }
    pos-menu/products.routes.ts:77             import { resolveDefaultLocationId }
  → los dos consumidores de escritura usan SIEMPRE el default; ninguno elige.

grep -n "location" app/src/db/schema.sql | head -30
  → :59 CREATE TABLE locations · :67 INSERT … WHERE NOT EXISTS (una fila 'loc-default')
    :182-185 resources.location_id NOT NULL REFERENCES locations(id), backfill a 'loc-default'
    :1259 inventory_levels.location_id NOT NULL · :1483-1486 orders.location_id NOT NULL
```

**Evidencia:** `src/api/routes/locations.routes.ts:40-59` (el POST), y **el propio archivo declara la situación** en `:8-12`: *"Alcance deliberadamente chico: esto existe para que la entidad no quede como scaffolding muerto (alguien tiene que poder crear una segunda location si el negocio abre una sucursal), **no para resolver selección de sucursal en el resto de la app — eso es trabajo aparte, todavía sin ningún router/UI que lo use**."* Y `src/db/schema.sql:52` lo dice otra vez: *"ningún router que permita elegir entre locations al reservar/vender"*.

**Impacto:** es el patrón **"dato anecdótico, sin efecto downstream"** en su forma exacta: un dato que se puede crear y persistir, y que ningún módulo lee después. Una segunda location creada por API queda huérfana: `resources`, `orders` e `inventory_levels` la tienen como FK obligatoria pero todos los caminos de escritura resuelven `'loc-default'`. Stock, órdenes y recursos seguirían anotándose contra la sucursal vieja, en silencio y sin error.

**Causa probable:** decisión deliberada y documentada — se construyó el endpoint mínimo **para evitar** que la tabla fuera scaffolding muerto. La ironía es que el remedio produjo el mismo síntoma un nivel más arriba: en vez de una tabla que nadie escribe, hay un endpoint que escribe filas que nadie lee.

**Nivel de certeza:** **Alta.** El código, el schema y el propio docblock coinciden.

**Severidad:** **Baja hoy** (con un solo tenant y una sola location, el daño es cero). **Media si alguien lo usa**: crear una sucursal y descubrir que el stock se sigue descontando de la otra es una inconsistencia de inventario silenciosa.

**Recomendación:** **no borrar** — es una decisión tomada y escrita. Dos mitigaciones baratas, cualquiera alcanza: (a) que el POST devuelva junto con el 201 una advertencia explícita de que la location creada todavía no es seleccionable; o (b) gatearlo detrás de un flag hasta que exista la selección. **La opción que no corresponde es dejarlo tal cual y a la vez tratarlo como feature disponible.**

**¿Requiere modificar código?:** No para el hallazgo. Sí, mínimo, para la mitigación.

**Qué riesgo existe:** borrarlo devolvería la tabla al estado de scaffolding que el autor quiso evitar, y hay que respetar esa decisión. Dejarlo sin advertencia deja disponible una operación cuyo efecto no es el que su nombre sugiere.

**Cómo verificarlo antes de eliminarlo:** `SELECT count(*) FROM locations` por tenant. Si algún tenant tiene más de una fila, **alguien ya lo usó** y hay que revisar la consistencia de `resources`/`orders`/`inventory_levels` **antes** de cualquier otra cosa.

**¿Debería marcarse primero como obsoleto?:** **No.** Marcar como **incompleto/no seleccionable**, que es lo que es. Es el mismo criterio que F14-02 y F14-09: "obsoleto" y "todavía no terminado" son etiquetas distintas y este repo hoy no distingue entre las dos.

**Prueba necesaria:** la query de conteo por tenant. Si se implementa la selección, test de integración que verifique que el stock se descuenta de la location correcta.

---

### F14-18 — Dos comentarios del frontend afirman que `GET /api/stays/:id` no existe; el inventario generado prueba que sí

**Hallazgo:** dos archivos del frontend declaran, en comentario, que el backend no tiene `GET /api/stays/:id`. El endpoint existe y está listado en el inventario generado.

**Cómo se determinó:** al depurar un falso positivo de mi cruce de rutas (el path aparecía del lado frontend pero ninguna llamada real lo producía), el match resultó ser estos dos comentarios.

**Qué búsqueda se realizó:**
```
grep -rn "/api/stays/:id" appfrontend/src
  → src/app/dashboard/estadias/[id]/page.tsx:78
      // Sin GET /api/stays/:id — mismo criterio que el adapter 'estadias'
    src/lib/refine/dataProvider.ts:209
      // Sin GET /api/stays/:id individual (sí existe /:id/folio, que es otra cosa).

grep -n "api/stays" app/docs/inventario-rutas.md
  → :233  | GET | `/api/stays/:id` | CLOSURE_MOUNTS |     ← existe

cat appfrontend/src/lib/estadias/api.ts
  → staysApi expone: listActive, checkIn, checkOut, noShow, getFolio, transferToReceivable
  → efectivamente NO hay un get(id). El comentario describe bien la decisión,
    y mal el motivo.
```

**Evidencia:** las cuatro líneas de arriba. Es distinto de un comentario vecino que **sí** es correcto: `dataProvider.ts:262` dice *"Sin GET /api/consumption-destinations/:id individual (sí existe list())"* — y ahí el endpoint realmente no existe en el inventario. O sea: el repo usa esta forma de comentario con precisión en un caso y con un error de hecho en el otro.

**Impacto:** doble. (1) El detalle de estadía trae la lista entera y filtra en cliente, pudiendo pedir un solo registro — ineficiencia adoptada por una premisa falsa. (2) Más caro: **estos comentarios harían que una auditoría futura de endpoints huérfanos descarte `GET /api/stays/:id` como inexistente** en vez de reportarlo. Un comentario equivocado que se propaga a través de quien lo lee.

**Causa probable:** se verificó contra `src/lib/estadias/api.ts` (el cliente del frontend) y no contra el backend. Cuando se escribió, `docs/inventario-rutas.md` quizá no existía todavía (es del 09/09/2026) — pero `/api/stays/:id` sí.

**Nivel de certeza:** **Alta.** El inventario es un artefacto **generado** booteando la app real y caminando `app._router.stack`, no una regex sobre texto: si dice que la ruta existe, existe.

**Severidad:** **Baja.**

**Recomendación:** corregir los dos comentarios: la decisión de no usarlo puede seguir siendo la correcta, pero el motivo tiene que ser el real (*"existe, no lo usamos porque el adapter resuelve por lista"*), no *"no existe"*. Y en el mismo movimiento, decidir en F14-01 qué se hace con el endpoint.

**¿Requiere modificar código?:** No; dos comentarios.

**Qué riesgo existe:** ninguno al corregir. Dejarlo así garantiza que la próxima auditoría se lo salte.

**Cómo verificarlo antes de eliminarlo:** `grep -n "api/stays" app/docs/inventario-rutas.md` — nueve líneas, `:233` entre ellas.

**¿Debería marcarse primero como obsoleto?:** No aplica.

**Prueba necesaria:** ninguna.

---

### F14-19 — 29 exports y 23 tipos exportados que nadie importa: casi todos son sobre-exportación, no código muerto

**Hallazgo:** `knip` reporta 29 exports y 23 tipos exportados sin uso en el backend. Verifiqué uno por uno los de mayor riesgo: **la enorme mayoría se usa dentro de su propio archivo** y lo que sobra es el `export`, no el símbolo. Los genuinamente muertos ya tienen ficha propia (F14-03, F14-05, F14-08, F14-11).

**Cómo se determinó:** `knip` + verificación manual por símbolo.

**Qué búsqueda se realizó:** `grep -rn "\b<símbolo>\b" app/src --include=*.ts` por cada candidato. Resultados representativos:

| Símbolo | Ancla | Veredicto |
|---|---|---|
| `toResourceDto` | `api/mappers/reservation.mapper.ts:83` | **vivo** — usado en `:100` del mismo archivo |
| `CategoryFieldSchema` | `api/schemas/category.schemas.ts:10` | **vivo** — `:26` y `:37` |
| `RATE_SCOPE_BUCKETS` | `api/schemas/request.schemas.ts:346` | **vivo** — `:347` |
| `PaymentMethodSchema` | `api/schemas/request.schemas.ts:425` | **vivo** — `:438`, `:472` |
| `TRANSIENT_PG_CODES` | `domain/outbox-error-class.ts:23` | **vivo** — `:47` |
| `IVA_ALICUOTA_IDS` | `facturacion/afip-catalog.constants.ts:192` | **vivo** — `:208`, `:224` |
| `ReservationNotConfirmedError` | `pms-estadias/stay.service.ts:62` | **vivo** — lanzado en `:187` |
| `InvalidStayTransitionError` | `pms-estadias/stay.ts:29` | **vivo** — `:140`, `:157` |
| `getActiveReservationsForResource` | `reservas/availability.ts:35` | **vivo** — `:55` |
| `buildPasswordResetUrl` | `usuarios-roles/password-reset.routes.ts:36` | **vivo** — `:57` |
| `ORDER_STATUSES`, `ServiceScheduleNotFoundError`, `ScheduleConflictError`, `DEFAULT_SENDER_NAME` | varios | **vivos** en su propio archivo |
| `authenticate` (re-export) | `api/middleware/auth.middleware.wrapper.ts:9` | **muerto** — ver abajo |

**Un caso que merece nombrarse, aunque no llega a ficha:** `src/api/middleware/auth.middleware.wrapper.ts` existe, según su propio docblock, *"para que los routers de `api/routes` los importen sin cruzar capas"*. Verifiqué quién lo usa:
```
grep -rn "auth.middleware.wrapper" app/src --include=*.ts
  → platform/companies.routes.ts:36 · clientes-finanzas/customers.routes.ts:25
    clientes-finanzas/rate-catalog.routes.ts:26
  → NINGUNO está en api/routes/

grep -n "auth.middleware" app/src/api/routes/*.ts | grep -v test
  → los 8 archivos de api/routes/ importan DIRECTO de '../../security/auth.middleware.js'
    (audit-log:23, auth:36, business-profile:20, customer:88, locations:18,
     me:46, reports:20, system:16)
```
O sea: **la abstracción se aplica exactamente al revés de como se documenta** — ninguno de sus destinatarios la usa, y sus 3 usuarios reales son módulos para los que no se escribió. Y su export `authenticate` no lo usa nadie (los 3 importan solo `authorize`). Es deuda de coherencia, no código muerto: el archivo está vivo.

**Impacto:** bajo. Un `export` de más amplía la superficie de un módulo y hace ruido en toda corrida de `knip` — que es justo lo que hace difícil ver los 4 casos que sí importan.

**Causa probable:** `export` puesto por defecto al declarar.

**Nivel de certeza:** **Alta** para los verificados individualmente (la tabla). **Media** para el resto de la lista de `knip`, que no abrí uno por uno.

**Severidad:** **Baja.**

**Recomendación:** bajar a privado los `export` verificados como internos, en un bloque mecánico. Y el valor real del ejercicio: **una vez hecho, la salida de `knip` queda corta y legible**, que es la condición para que `deadcode` sirva en CI (F7-14(f)). Hoy no sirve porque el 85% de su salida es ruido.

**¿Requiere modificar código?:** Sí, mecánico.

**Qué riesgo existe:** **Bajo** — `tsc` verifica cada quite de `export` de forma exhaustiva.

**Cómo verificarlo antes de eliminarlo:** `npx tsc --noEmit` tras cada quite. Cuidado con los que un test importa: ahí el `export` es necesario aunque `knip` no lo diga (`knip` trata los tests como entry points, así que un símbolo usado solo por su test **no** aparece en esta lista — ese es justo el punto ciego de F14-11).

**¿Debería marcarse primero como obsoleto?:** No. Son símbolos vivos con visibilidad de más.

**Prueba necesaria:** `npx tsc --noEmit` + `npm test`.

---

## 4. Verificado y descartado explícitamente

Categorías del protocolo que barrí y en las que **no** encontré hallazgo, o donde el candidato resultó legítimo. Las listo porque una ausencia verificada vale tanto como un hallazgo.

| Candidato | Búsqueda | Veredicto |
|---|---|---|
| **Archivos sin importadores (backend)** | grafo propio, 511 archivos | **Ninguno**, más allá de los ya conocidos. Los 32 "sin importador de producción" son: 26 `in-memory.*` (F7-14(4)), 5 scripts CLI, `server.ts`, `express.d.ts`, y `postgres-transaction-manager.ts` (F7-14(3)). `knip` coincide: 0 archivos sin uso |
| **Archivos sin importadores (frontend)** | grafo propio con alias `@/`, 131 archivos | **Uno solo**: `src/lib/auth.tsx`, ya cubierto por F7-14(2). Los 15 componentes, 2 hooks, 4 contexts y 15 módulos de `lib/<dominio>/` están todos importados |
| **Scripts olvidados** | `grep` de cada script en `package.json`, `render.yaml`, `docs/` | **Ninguno.** Los 2 que no están en `package.json` son herramientas de operador documentadas: `encrypt-database-url.ts` (`docs/conocimiento/runbook-rotacion-db-encryption-key.md:32,93`, `runbook-deploy-render.md:411`) y `concurrency-test-reservations.ts` (`docs/indice-conocimiento.md:128`, citado por F9 y F12) |
| **Comentarios con código comentado** | `grep -rnE "^\s*//\s*(const\|let\|return\|if\|await\|import\|export\|function\|res\.)"` en los dos repos | **Ninguno.** Los ~30 matches del backend son líneas de prosa que empiezan con un nombre de función (`// getAll() ya no filtra…`). El frontend: 2 matches, ambos prosa. **Los dos repos están limpios en esta categoría** |
| **Variables sin uso (backend)** | `npm run lint` (`--max-warnings 0`) | **Ninguna.** Salida limpia. ESLint ya es cerca efectiva acá |
| **Variables sin uso (frontend)** | `npx eslint .` | **1 real** (F14-15). Las otras 2 son descartes intencionales (`_`, `_key`) |
| **Duplicación estructural (backend)** | `jscpd --min-lines 25 --min-tokens 150` sobre 248 archivos no-test | **1 clon, 35 líneas (0.06%)**, intra-archivo, en `facturacion/sql.invoice.repository.ts:879-914` ↔ `:979-1007`. **Deliberado y declarado**: el propio código dice *"reusado verbatim"* y *"mismo criterio que classifyReservationLiveInvoice"* — son las variantes órdenes/reservas del mismo clasificador. No es hallazgo |
| **Feature flags abandonadas** | `ModuleKey` y `Roles` contra sus call sites | **Ninguna.** Los 6 `ModuleKey` (`src/types/enums.ts:86-93`) están todos en uso (POS_RESTAURANTE 21, CUENTAS_CORRIENTES 8, ALOJAMIENTO 8, FACTURACION 7, HOUSEKEEPING 2, REPORTES 1). Los 9 grupos de `security/roles.ts` están todos en `authorize()` reales (MANAGEMENT 152 … CUSTOMER_ONLY 1) |
| **Adaptadores del data provider de Refine** | 13 adapters × `resource: '<x>'` en pantallas | **Ninguno huérfano.** Los 13 de `dataProvider.ts` se corresponden 1:1 con `REFINE_RESOURCES` (`dashboard/layout.tsx:35-47`) y todos tienen pantalla. *(Falso positivo propio: mi primer grep no matcheó las claves con comillas `'motivos-merma'`/`'destinos-consumo'`, `:246` y `:260`.)* |
| **`migrations/NNN_*.sql`** | `migrations/README.md` + `ls` | **10 archivos**, `003_`→`012_`, histórico declarado no aplicado. **Ya citado por Fase 13.** Correcto que existan |
| **`patches/`** | versión parcheada vs instalada | **Sano.** `patches/@arcasdk+pdf+0.2.0.patch` contra `@arcasdk/pdf` **0.2.0** instalado — el parche aplica. Si el `^0.2.0` de `package.json` resolviera a 0.3.x, el parche quedaría huérfano; hoy no pasa |
| **`instrument.ts`** | falso positivo de mi primer script | **Vivo.** `src/server.ts:17` lo importa por efecto lateral (`import './instrument.js';`). Mi regex inicial no cubría imports sin `from`; lo corregí y re-corrí todo |
| **`neon-provisioning.ts`** | importadores | **Vivo.** `business.routes.ts:43`, `platform.routes.ts:14`, y consumido desde `appfrontend/src/lib/platformApi.ts:114`. Lo obsoleto es el docblock que lo ignora (F14-12) |
| **`.MD` de 1 byte / `supabase/`** | `git ls-files`, `od -c` | **Ya cubierto por F1 B-05 y re-verificado en F11.** Confirmo: `.MD` sigue trackeado con 1 byte (`\n`), de `eb2e024` *"Update and rename .env to .MD"*, que borró un `.env` de 13 líneas. **La exposición de secretos en la historia de git es alcance de Fase 9, no mío** |
| **Clases de error de dominio** | barrido de las 84 de `errors.ts` | **81 de 84 vivas.** Solo 3 muertas (F14-11) |
| **Schemas Zod exportados** | barrido de los 70 `export const` de `api/schemas/*.ts` | **67 de 70** con consumidor externo. Los 3 restantes se usan en su propio archivo (F14-19) |
| **Códigos del mapa de status** | barrido de los 113 `case` de `error.middleware.ts` | **108 de 113 alcanzables.** 5 no (F14-06) |

---

## 5. No confirmado

```
No confirmado.
Información faltante: si alguno de los 35 endpoints de F14-01 tiene un consumidor
  FUERA de estos dos repositorios — integración de un cliente, script de operador,
  colección de Postman, webhook, o un panel interno no versionado acá.
Cómo verificarlo: logs de acceso de Render para el servicio del backend, filtrando
  por los 29 paths, ventana >= 30 días; y preguntar al dueño si hay algún consumidor
  externo. Sin eso, "sin consumidor en estos dos repos" NO equivale a "sin consumidor".
```

```
No confirmado.
Información faltante: si algún tenant productivo tiene filas en `cash_register_shifts`
  (F14-02) o más de una fila en `locations` (F14-17). De eso depende por completo
  qué se puede hacer con esas dos features: si hay filas, hay hechos de negocio
  registrados por API y el borrado deja de estar sobre la mesa.
Cómo verificarlo: por cada tenant activo, `SELECT count(*) FROM cash_register_shifts;`
  y `SELECT count(*) FROM locations;` — solo lectura. Requiere acceso a las BD de
  producción, que esta auditoría no tiene.
```

```
No confirmado.
Información faltante: el efecto exacto de un directorio `src/pages/` vacío
  (solo .gitkeep) en Next.js 16.3.1 — si el resolver del Pages Router se activa
  igual, si emite warning, o si lo ignora por completo.
Cómo verificarlo: leer node_modules/next/dist/docs/ (el AGENTS.md del frontend
  obliga a consultarlo, esta versión difiere de lo conocido), y comparar la salida
  de `npx next build` con y sin el directorio.
```

```
No confirmado.
Información faltante: si `POST /platform/businesses` (alta de negocio desde el
  panel superadmin) tiene consumidor. Verifiqué que el GET del mismo path y los
  `/:id/{status,provision,plan}` se usan (platformApi.ts:104,108,114,120), pero
  no aislé el POST.
Cómo verificarlo: grep -rn "platformApi.*businesses.*POST\|method: 'POST'" \
  appfrontend/src/lib/platformApi.ts y leer la sección de creación de negocio.
```

```
No confirmado.
Información faltante: si el `const prod` muerto de F14-15 es residuo de D9-Parte 2
  (la resolución server-side de unitPrice) o de otro cambio. Lo planteo como
  hipótesis por la coincidencia con src/pos-menu/sql.order.repository.ts:188-196,
  no como hecho.
Cómo verificarlo: git log -S "const prod = products.find" -- \
  src/app/dashboard/ordenes/\[id\]/page.tsx  en el repo appfrontend.
```

```
No confirmado.
Información faltante: si los ~40 re-exports sin importador de F14-14 son
  efectivamente todos alcanzables desde su módulo de dominio. Confié en ts-prune
  sin verificar los 40 uno por uno, a diferencia del resto de la fase.
Cómo verificarlo: por cada símbolo, grep -rn "from '@/lib/<dominio>/types'" y
  confirmar que el importador real existe. Costo bajo, valor bajo: la recomendación
  es no tocar nada.
```

---

## 6. Nota de método — dos falsos positivos propios, y qué los produjo

Los dejo escritos porque condicionan cuánto pesa cada número de este informe.

1. **Imports de efecto lateral.** Mi primer grafo de importadores marcó `src/instrument.ts` como sin importador. Era falso: `src/server.ts:17` hace `import './instrument.js';`, sin `from`, y mi regex solo cubría `from '…'`, `import(…)` y `require(…)`. Corregí el patrón y **re-corrí el análisis completo** de los dos repos. Todos los números de este informe salen de la versión corregida.

2. **Símbolos nombrados en comentarios.** Mi script de deadness por clase/constante cuenta ocurrencias textuales, así que un comentario que menciona un símbolo lo hace parecer vivo. Caso concreto: `IVA_ALICUOTA_IDS` no apareció como muerto porque `src/domain/errors.ts:562` lo nombra **en un comentario**. Por eso **verifiqué a mano, leyendo las líneas devueltas, todos los símbolos que reporto como muertos** — y donde eso cambió la conclusión lo dejé anotado (F14-19).

La consecuencia práctica: los hallazgos donde afirmo "cero referencias" (F14-11 `CustomerRateNotFoundError`, F14-05 `pgClient`/`closeDatabasePool`, F14-06 los 3 códigos fósiles, F14-03 las 4 constantes AFIP) están verificados línea por línea, no solo contados.

---

## 7. Observación transversal — por qué se acumula

Tres mecanismos explican casi todo lo de arriba, y ninguno es descuido individual:

1. **Ninguna herramienta del repo puede ver lo que esta fase busca.** `depcruise` define huérfano como *sin entrantes **y** sin salientes*, así que un archivo muerto que importa `express` nunca aparece (ya declarado en F7-11(d)). `knip` trata los `*.test.ts` como entry points, así que **código que solo su test mantiene vivo le resulta vivo** — es literalmente F14-11. Y **ninguna** de las dos ve un endpoint sin consumidor, un `case` sin productor, o un método de interfaz sin llamador. Los tres tipos de hallazgo más caros de esta fase son invisibles para todo el tooling instalado.

2. **El repo tiene el hábito de marcar en vez de retirar.** `pg.client.ts` dice "legado" en 4 lugares desde hace meses y sigue entero. `getAll()` lleva un mes `@deprecated` sin lint rule que lo mire. Los `case` fósiles sobrevivieron a un commit que se llama *"final cleanup"*. **La marca, sin un mecanismo que la lea, es una nota mental compartida** — y este repo ya aprendió eso mismo con los pendientes (la convención de cortar-y-pegar a `resuelto.md` nació exactamente de que *"esa marca depende de que alguien la escriba y nadie más la toque"*). El mismo modo de falla, aplicado al código.

3. **No hay etiqueta para "construido y todavía no conectado".** F14-02 (caja), F14-03 (resolver fiscal), F14-09 (disponibilidad parcial) y F14-17 (locations) **no son código muerto**: son andamiaje esperando una decisión o una pantalla. Hoy el repo solo tiene `@deprecated`, que significa lo contrario. Sin una etiqueta propia, estas cuatro cosas o se leen como basura —y alguien las borra— o se leen como features —y alguien las promete. La distinción entre *"esto se retiró"* y *"esto todavía no se terminó"* no está en ninguna parte del código, y es la que más cuesta cuando falta.

---

## 8. Resumen por severidad

| Severidad | Cantidad | IDs |
|---|---|---|
| **Crítica** | **0** | — |
| **Alta** | **2** | F14-01 (35 endpoints sin consumidor), F14-02 (circuito de Caja sin UI ni fila de roadmap) |
| **Media** | **8** | F14-03, F14-04, F14-05, F14-06, F14-07, F14-08, F14-09, F14-10 |
| **Baja** | **9** | F14-11, F14-12, F14-13, F14-14, F14-15, F14-16, F14-17, F14-18, F14-19 |
| **Total** | **19** | |

**Por tipo (taxonomía de la regla general 9):**

| Tipo | IDs |
|---|---|
| Código muerto | F14-04, F14-05, F14-06, F14-07, F14-11, F14-19 |
| Deuda técnica | F14-08, F14-10, F14-13, F14-14 |
| Requisito ambiguo / decisión de producto pendiente | F14-01, F14-02, F14-03, F14-09, F14-17 |
| Documentación desactualizada (subtipo de deuda) | F14-12, F14-16, F14-18 |
| Bug de implementación | F14-15 (una línea), F14-07 punto 3 (enum fósil produciría 400) |

**Cobertura de las 14 categorías del protocolo:**

| # | Categoría | Resultado |
|---|---|---|
| 1 | funciones sin uso | F14-03, F14-04, F14-11, F14-19 |
| 2 | archivos sin importadores | **0 nuevos** (todos ya en F7-14) |
| 3 | endpoints no referenciados | **F14-01 (35), F14-02** |
| 4 | componentes no utilizados | F14-07 (`ApiBlock.tsx`) |
| 5 | variables sin uso | F14-15; F14-07 (prop `noAuth`) |
| 6 | feature flags abandonadas | **ninguna** — `ModuleKey` y `Roles` 100% en uso |
| 7 | migraciones antiguas | ya en Fase 13 — verificado y descartado |
| 8 | scripts olvidados | **ninguno** — los 2 fuera de `package.json` están documentados |
| 9 | dependencias sin uso | ya en Fase 11 — citado |
| 10 | comentarios con código obsoleto | F14-12, F14-16, F14-18 |
| 11 | ramas de lógica imposibles | **F14-06 (5)**, F14-05 (rama de `checkDatabaseHealth`) |
| 12 | configuraciones antiguas | F14-13, F14-16 |
| 13 | adaptadores reemplazados | F14-05, F14-11 (`AuthError`/`ForbiddenError`) |
| 14 | duplicado que parece sustituido | **F14-08** (helper no adoptado), F14-10 (extracción a medias) |

**Estado de la fase:** completada en modo detección. **Cero archivos modificados en cualquiera de los dos repos** — verificado: `git status --porcelain` vacío en `/home/user/app` y en `/home/user/appfrontend` al abrir y al cerrar. Ningún candidato fue eliminado ni marcado; todos quedan con su procedimiento de verificación documentado, tal como pide el protocolo.

**Archivos de referencia (rutas absolutas):**
- `/home/user/app/docs/inventario-rutas.md` — artefacto generado, base del cruce de F14-01
- `/home/user/app/docs/auditoria-integral-fase7-2026-09-15.md` — F7-14, la cobertura previa que esta fase no re-deriva
- `/home/user/app/docs/auditoria-integral-fase11-2026-09-16.md` — F11-18 y F11-02
- `/home/user/app/docs/auditoria-integral-fase3-duplicacion-2026-09-15.md` y `.../fase3-grounding-2026-09-15.md`
- `/home/user/app/docs/roadmap-pms-multirubro.md` — sin fila para Caja (F14-02)
- `/home/user/app/docs/diseno-fiscal-profile-resolver-2026-09-01.md` — el HOLD que explica F14-03

---

## Apéndice A — corrección del gate (`architecture-governor`, 2026-09-16)

Dos correcciones sobre el cuerpo del informe, detectadas al reproducir los
hallazgos de forma independiente. **Ninguna cambia la severidad ni la
recomendación de su ficha.** El cuerpo queda verbatim; esto es el registro
de lo que hay que leer distinto.

### A.1 — F14-03: `DOC_TIPO_CUIL` y `DOC_TIPO_CDI` NO tienen "cero referencias"

La viñeta de evidencia de F14-03 afirma: *"`afip-catalog.constants.ts:83,85,94,95`
— `CONCEPTO_PRODUCTOS`, `CONCEPTO_PRODUCTOS_Y_SERVICIOS`, `DOC_TIPO_CUIL`,
`DOC_TIPO_CDI`. Cero referencias en todo el repo, ni siquiera en tests."*
Y §6 lista esas 4 constantes entre las afirmaciones de "cero referencias"
**verificadas línea por línea**.

Medido por el gate: cierto para 2 de las 4, **falso para las otras 2**.

| Símbolo | Hits reales en `src/` | Veredicto |
|---|---|---|
| `CONCEPTO_PRODUCTOS` | 1 — solo su declaración (`:83`) | ✅ cero referencias, como dice |
| `CONCEPTO_PRODUCTOS_Y_SERVICIOS` | 1 — solo su declaración (`:85`) | ✅ cero referencias, como dice |
| `DOC_TIPO_CUIL` | **3** — `:94` (decl), `:110` (`case 'CUIL':` dentro de `resolveDocTipo()`), `:130` (`case DOC_TIPO_CUIL:` dentro de `docTipoLabel()`) | ❌ tiene 2 referencias |
| `DOC_TIPO_CDI` | **3** — `:95` (decl), `:111`, `:131` | ❌ tiene 2 referencias |

Y `docTipoLabel()` **sí es código vivo de producción**:
`src/facturacion/invoice-pdf.service.ts:37` lo importa y `:117` lo llama
(`documentoTipo: docTipoLabel(invoice.docTipo)`).

De dónde salió el error: el bloque "Qué búsqueda se realizó" del propio
F14-03 dice, **correctamente**, que estas 4 *"no aparecen en NINGÚN otro
archivo"* — que es exactamente lo que reporta `knip` (unused **export**: sin
importador fuera de su archivo). La viñeta de evidencia escaló "ningún otro
archivo" a "cero referencias en todo el repo". No son símbolos sin
referencias: son símbolos sin **importador externo**.

**Efecto sobre el hallazgo: ninguno en contra — lo refuerza.** Como
`input.buyer` no lo manda ningún cliente, `invoice.docTipo` es siempre
`DOC_TIPO_CONSUMIDOR_FINAL` (99), así que las ramas `case DOC_TIPO_CUIL:` y
`case DOC_TIPO_CDI:` de `docTipoLabel()` **tampoco se ejecutan nunca**: son
dos instancias más de la categoría que cubre F14-06 (rama sin productor),
esta vez dentro de una función viva cuyo único camino real es el `default`
(`'Sin Identificar'`). La recomendación de F14-03 —**no borrar, no marcar
`@deprecated`**, es andamiaje bloqueado por el HOLD de
`docs/diseno-fiscal-profile-resolver-2026-09-01.md`— no cambia, y ahora
alcanza también a estas dos ramas.

### A.2 — F14-16: `npm run lint:visual` no produce el número de clases Tailwind crudas

F14-16 recomienda, en "Cómo verificarlo": *"correr `npm run lint:visual`
(`scripts/check-visual-debt.mjs`) — es el contador propio del repo y es la
fuente correcta para el número, no mi regex."*

El gate corrió `npm run lint:visual` en `appfrontend-main`. Ese script tiene
**8 contadores** y **ninguno cuenta clases Tailwind de color crudas**
(`bg-slate-800`, `text-emerald-400` — la métrica del "89"/"69"). Sus
contadores son: `var(--accent)` en pantallas y en CSS, clase `.bastion`
residual, **color crudo** en `.ts/.tsx` y en CSS (eso es hexadecimales, la
regla 1 del `CLAUDE.md`, no la regla 2), overlay blanco sin token en forma
`rgba()` y en forma Tailwind, y alias engañoso `.btn-mini-clay/-sage`. La
corrida real termina en **"Sin deuda visual nueva"** y **no emite ningún
número comparable con 89 ni con 69**.

Quien siga esa instrucción va a leer "sin deuda" y no va a obtener la cifra
que la ficha pide corregir.

**Sustituir esa instrucción por:** medir con un contador explícito de clases
Tailwind de color, excluyendo comentarios (que es lo que el propio
`CLAUDE.md` del frontend pide: *"contarlas ignorando comentarios: un
comentario que documenta una clase ya sacada la vuelve a sumar"*). Dato del
gate: corrí **el mismo regex del informe, de forma independiente, y da
también 69** — o sea, el 69 del informe es reproducible, pero sigue siendo
un piso con comentarios adentro, no el número final. **La cifra que se
escriba en el `CLAUDE.md` del frontend hay que medirla con un contador que
excluya comentarios; si se quiere que `lint:visual` sea la fuente, hay que
agregarle ese contador primero** — eso es un bloque aparte, no parte de la
corrección del documento.

El resto de F14-16 está **confirmado al detalle**: `src/styles.css` no existe
(el único `.css` del frontend es `src/app/globals.css`), fue borrado el
**2026-08-29** en **`371d9c5`** *"chore(visual): V2.6.2d — borrar styles.css,
sistema de diseño muerto"* (hash, fecha y título verificados), y el
`CLAUDE.md` del frontend sigue citándolo como pendiente vivo con sus "24 de
las 89".
