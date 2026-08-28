# Pendientes — Viernes 28 de Agosto 2026

Arranca a partir de `pendientes-2026-08-27.md`. Sesión de continuidad: retomar
lo que quedó pendiente de esa lista (deuda promovida + rollback forzado) y
avanzar. Documento de plan/ejecución que se sigue usando:
`plan-resolucion-bugs-deuda-2026-08-27.md` (actualizado hoy con la sección
"Sesión 28/08/2026").

**Resultado de hoy:** los 5 bugs + A6.1 + consumo interno + columnas
obligatorias de la sesión del 27/08 se commitearon y desplegaron (estaban
todos sin pushear). El rollback forzado contra Postgres real (deuda
heredada) se resolvió. El bug de cobro de temporada (🔴, el de más valor de
la lista) se resolvió de punta a punta, con un diseño en capas acordado con
el dueño. Y apareció un **hallazgo nuevo no previsto**: un bug real de
deploy en `schema.sql` (ver abajo) que bloqueaba cualquier redeploy futuro,
encontrado y corregido en el momento.

---

## ✅ Resuelto hoy (28/08/2026)

- **Deploy de la sesión 27/08** — 6 commits atómicos (bugs #1-#5, A6.1,
  consumo interno, columnas obligatorias) pusheados y verificados en
  producción (sin login — por SQL de solo lectura contra Neon, ver
  restricción abajo).
- **Rollback forzado real contra Postgres** (deuda heredada de RBAC paso 1) —
  branch de Neon dedicado (`test-integration-db`), suite de integración
  completa corrida por primera vez contra Postgres real (22/22, luego 25/25
  con el fix de temporada), y `audit-log-transactional.integration.test.ts`
  nuevo (3 tests) que fuerza un error a mitad de transacción y confirma
  `ROLLBACK` real de negocio+auditoría juntos.
- **🔴 Temporada que cruza el rango de la estadía** (bug de cobro vivo, el de
  más valor de la deuda promovida el 27/08) — causa raíz real: `rate_plans`
  tenía `UNIQUE(service_id, name)`, imposible cargar dos vigencias del mismo
  nombre (temporada alta/baja). Fix en capas (Fase 1 de un diseño mayor
  acordado con el dueño — base/temporada/fecha especial/revenue management,
  solo la primera capa implementada hoy):
  - Schema v43: `EXCLUDE USING gist` con rango **semiabierto**
    `[valid_from, valid_to + 1)` — dos cuidados técnicos que señaló el dueño
    explícitamente, ambos verificados contra Postgres real.
  - `bookable-service.service.ts`: ya no rechaza cualquier nombre repetido,
    solo uno cuya vigencia se solapa.
  - `reservation-pricing.service.ts`: resuelve el precio **por noche**
    (antes: una sola vez contra la fecha de inicio).
  - Verificado: suite local 1566/1566, + integración real 5/5 (rango
    semiabierto, solape real, nombre normalizado, R2/R3).
- **Incidente de deploy encontrado y corregido** (no estaba en ningún
  pendiente — apareció al pushear el fix de temporada): `schema.sql` tenía
  **dos bloques** `DROP CONSTRAINT`/`ADD CONSTRAINT` para
  `chk_stock_movements_movement_type` — uno viejo (sin `'CONSUMPTION'`, de
  la fase PRODUCTION del carve-out) y uno nuevo (con `'CONSUMPTION'`, de la
  sesión 27/08). Como `schema.sql` corre de arriba a abajo como una sola
  transacción, y ya había una fila `movement_type='CONSUMPTION'` real en
  producción (se probó la feature contra el server real el mismo día que se
  agregó), el bloque viejo reventaba el `ADD CONSTRAINT` antes de llegar al
  nuevo — bloqueaba **cualquier** deploy futuro, no solo el de temporada.
  Diagnosticado con el log real de Render que pasó el dueño; corregido
  eliminando el bloque muerto (R14, un solo camino de escritura); test de
  regresión nuevo (`schema-redeploy-idempotent.integration.test.ts`) que
  reproduce el incidente exacto contra Postgres real. Verificado: grep
  contra todo `schema.sql` confirma que no hay otro par de constraints
  duplicadas del mismo tipo. Deploy re-verificado exitoso (`✅ biz-demo-01 —
  migrado a v43`).

**Lección para sesiones futuras:** cuando se agregue un valor nuevo a un
`CHECK`/constraint ya existente, **editar el bloque existente in-place**
(o borrar el viejo al agregar el nuevo) — nunca dejar un segundo bloque
`DROP`/`ADD` más abajo en el archivo. `schema.sql` se reaplica ENTERO en
cada deploy; un bloque viejo más arriba corre primero y puede romper con
datos reales que el bloque nuevo sí permitiría.

### Restricción encontrada hoy, aplica a toda sesión futura

**No puedo loguearme en el panel real** (entrar contraseñas para
autenticarme está prohibido de forma dura para el agente, incluso con
autorización explícita del dueño — regla del harness, no del proyecto). La
verificación "navegador real, contra el servidor real" que hicieron
sesiones anteriores con click-a-click **no la puede repetir el agente**
para la parte de login. Alternativas usadas hoy: verificación por SQL de
solo lectura contra Neon (sin autenticarse contra la app), o pedirle al
dueño que corra el checklist él mismo. Tenerlo en cuenta al planear
verificación en próximas sesiones.

---

## Backlog de producto — sin tocar (HALLAZGO 1 del 27/08, sigue vigente)

Verificado contra código real el 27/08 — la etiqueta "backend-only, falta
UI" no era cierta para la mitad. Ver detalle completo en
`pendientes-2026-08-27.md`, sección HALLAZGO 1, y los pasos 1/2/6/7/8/9/10
de `plan-resolucion-bugs-deuda-2026-08-27.md`.

| Ítem | Qué falta | Tipo |
|---|---|---|
| **D8** | UI fiscal de producto (`ivaRate`/`unit`/`arcaUnitCode`) — backend ya los acepta | UI pura |
| **D6** | Números de reserva/cliente + prefijos en listados — backend ya los expone | UI pura |
| **C1-Fase A** (configurar) | CRUD de `deposit_policies` (create/update/list/deactivate) + rutas + pantalla | Backend nuevo + UI |
| **C3** | Líneas de factura no salen por `GET /api/invoices/:id` | Backend chico + UI |
| **Gap C1-C** | 2 queries con `JOIN financial_transactions` directo sin vista unificada | Backend puro |
| **C2** | Botón "Cancelar reserva" no usa el preview/confirm de reembolso ya existente | UI pura |

---

## C1-A — decisiones y datos pendientes

**Documento de diseño:** `diseno-sena-unidades-c1a-2026-08-27.md` (modelo de
seña en 3 formas, ya definido). Lo que falta:

1. **4 reglas de MAESTRO que `deposit_policies` incumple** — a decidir con la
   CRUD (paso 10 del plan):
   - **R3** — tiene `active`, no `deleted_at` (¿"pausado" vs "cargado mal"?)
   - **R8** — no pasa por `recordFieldChanges()` (auditoría de cambios de %)
   - **R1** — sin `code`; probablemente declarar que no aplica (el scope es
     la identidad) — confirmar con el dueño igual
   - **R4** — vigencia, backlog explícito
2. **Lista real de tipos de habitación de la Hostería** — bloquea dimensionar
   cuántos servicios "Estadía X" y rate plans crear. Dato a pedirle al dueño,
   no a inferir.
3. **Hallazgo operativo sin resolver:** `POST /customers/:id/payments` está
   gateado por `ModuleKey.CUENTAS_CORRIENTES`. Un negocio que configure seña
   sin ese módulo se autobloquea (`DepositNotPaidError` sin endpoint para
   cobrar). La pantalla de configuración de seña necesita ese guard cuando
   se construya.

---

## Deuda técnica — activa, no "cuando duela"

- **🟠 Rate plans no reutilizables entre servicios.** `rate_plans.service_id`
  es NOT NULL con unique `(service_id, name)`: "Con desayuno" se crea una
  vez por tipo de habitación, renombrarlo son N ediciones. Con lo confirmado
  el 27/08 (N tipos × con/sin desayuno × reembolsable/no × temporada) son
  ~2 docenas de filas a mano. Mismo problema que las tarifas especiales
  resolvieron con `rate_catalog` (catálogo reutilizable, referencia viva) —
  el molde existe, aplicarlo acá es el fix. **No confundir con el fix de
  temporada de hoy** — ese resolvió "cobrar bien por noche", esto es
  "no tener que cargar la misma tarifa N veces".
- **`resource_locks` solo bloquea recursos concretos por ID**, no "uno
  cualquiera de la categoría X". El recurso **principal** sí se resuelve por
  pool; los **bloqueados** no. Sigue siendo deuda futura — sin caso de uso
  activo todavía (aparecería primero con spa de varios terapeutas o tour de
  varios guías).

---

## Pendientes heredados, todavía abiertos (arrastrados de 08-25 vía 08-27)

- **Deuda estructural:** Redis rate-limit, BullMQ, etapas 2–3 de
  reconciliación al bajar de plan.
- **C1-Fase B** — gateway de pago real, hold corto canal web, auto-release.
  Bloqueada hasta que el negocio elija un proveedor de pago (proyecto
  externo). **No elegir ninguna opción sin el dueño.**
- **D7** — pantalla de reportes POS/CRM (backend tiene
  `applied_customer_rate_id` desde el 22/08, sigue sin UI).
- **RBAC — mecanismos 1 y 2** del handoff externo, sin empezar.
- **Operación:** datos de prueba (demo) dejados en la base real, confirmado
  con el dueño en su momento.

---

## Taxonomía de tipos de reserva — análisis, diseño y corrección de datos (28/08/2026)

Sesión aparte del plan de ejecución de abajo — hallazgo traído por el
dueño sobre `is_lodging`/`is_exclusive`/`booking_mode` sumándose sin
preguntarse si hacía falta una sola taxonomía.

- **Análisis:** los 3 campos son ejes independientes, no una taxonomía
  disfrazada — confirmado contra código real (cada uno lo lee un
  módulo distinto) y contra el único caso que parecía nonsensical
  (`is_lodging=true` + `booking_mode≠'block'`), explícitamente
  legítimo según comentario del propio equipo
  (`reservation.service.ts:236-238`). No se unifican en un enum.
- **Hallazgo real, no de modelo:** `is_exclusive` no tiene NINGÚN
  control en la UI hoy (ni Categorías ni Servicios) — por eso
  Peluquería y Spa de `biz-demo-01` quedaron en `false` (cupo
  compartido) cuando debían ser `true` (exclusivo). No fue un error
  de carga, fue una combinación imposible de cargar bien.
- **Corregido en datos reales, con OK explícito del dueño:**
  `UPDATE resource_categories SET is_exclusive = true WHERE id IN
  ('cat-salon-barberia-1786584586896', 'cat-spa-1786546869768')` —
  verificado por SELECT posterior.
- **Diseño de UI documentado, sin implementar todavía:** selector
  nombrado en 2 lugares (categoría controla `is_exclusive` con 2
  opciones nombradas; servicio controla `booking_mode` con 3 opciones
  cuyo copy se adapta al `is_exclusive` heredado), resumen siempre
  visible de los valores reales (nunca oculto), sin opción
  pre-seleccionada, lista de opciones creciente en vez de modo
  avanzado. Documento completo:
  `diseno-taxonomia-tipos-reserva-2026-08-28.md`. Patrón extraído
  como playbook reutilizable:
  `conocimiento/playbook-campos-interactuantes-selector-nombrado.md`.
- **Implementado y verificado (28/08/2026), mismo día:**
  - Backend: `isExclusive` obligatorio de punta a punta (DTO/Zod/
    repositorio, sin `?? false`); `schema.sql` saca el `DEFAULT` de
    `is_exclusive`/`booking_mode` (`ALTER COLUMN ... DROP DEFAULT`,
    idempotente). Corregidos 2 lugares que dependían del default y
    hubieran roto: `src/db/seed.tenant.sql` (script manual legado) y
    la fixture de `rate-plans-seasonal-exclude.integration.test.ts`.
  - Frontend: selector nombrado de 2 opciones en Categorías
    (`is_exclusive`) y de 3 opciones contextuales en Servicios
    (`booking_mode`, copy según la categoría elegida), sin
    preselección, resumen siempre visible. **Hallazgo de paso, no
    buscado:** el adapter `categorias.create` de
    `lib/refine/dataProvider.ts` descartaba `isLodging` en el alta
    (solo sobrevivía editando la categoría después de creada) —
    corregido en el mismo cambio, no era optativo dejarlo así.
  - Verificado con click real (login del dueño, resto por el agente)
    contra `biz-demo-01`: alta de categoría exclusiva → confirmado en
    la respuesta y en Postgres; alta de servicio `slot` sobre esa
    categoría con el copy de "Turno" → confirmado en respuesta y en
    Postgres; copy contextual de cupo compartido verificado sobre
    Mesas. `tsc`/`eslint` limpios, suite 1566/1566 (1 flake
    preexistente de timing, no relacionado). Datos de prueba
    desactivados al cerrar.
  - Detalle completo: `diseno-taxonomia-tipos-reserva-2026-08-28.md`
    §6; patrón reutilizable en
    `conocimiento/playbook-campos-interactuantes-selector-nombrado.md`.

---

## Commit + push de la sesión (28/08/2026, tarde) — hallazgo: 27/08 llevaba un día sin subirse

Con OK explícito del dueño ("commit y push"), antes de commitear encontré
que `appfrontend-main` tenía bastante más sin subir de lo que se hizo hoy:
trabajo del **27/08** (fechado y documentado en comentarios del propio
código) que nunca se pusheó, aunque el backend correspondiente sí está
deployado desde ayer y el índice de conocimiento lo daba por
"implementado — backend + dashboard + los 3 caminos del portal". No era
así: solo el backend había salido. La pantalla "Destinos de Consumo", el
guard de servicio obligatorio en alojamiento (Reservas + portal de
clientes) y el SKU obligatorio en variantes de producto llevaban 24hs+
completos, verificados en el propio código, pero **sin pushear**.

**Corregido, con confirmación del dueño de incluirlo en el mismo push:**

- `app-main`, 1 commit (`f05b5eb`) — taxonomía (`is_exclusive`
  obligatorio, `DROP DEFAULT` en schema, docs).
- `appfrontend-main`, 4 commits atómicos (`0ee207b..728b8f9`):
  1. `feat(consumo): destinos de consumo interno + guards de servicio obligatorio`
     — el lote del 27/08.
  2. `fix(productos): SKU obligatorio + registrar consumo interno` — 2
     archivos del mismo lote del 27/08 que se habían quedado afuera del
     commit 1 al armarlo (`productos/page.tsx`,
     `productos/[id]/page.tsx`, `lib/productos/api.ts`).
  3. `feat(productos): UI fiscal de producto` — D8, paso 1 de hoy.
  4. `feat(taxonomia): selector nombrado de is_exclusive/booking_mode`
     — el resto de hoy.

Varios archivos (`dashboard/layout.tsx`, `lib/catalogo/api.ts`,
`lib/catalogo/types.ts`, `lib/refine/dataProvider.ts`,
`productos/page.tsx`, `productos/[id]/page.tsx`) tenían el 27/08 y el
28/08 entreverados en los mismos hunks — se separaron a mano (revertir
la parte propia, commitear el resto, reaplicar) en vez de `git add -p`,
para no partir mal un hunk con contexto compartido. `tsc`/`eslint`
verificados limpios en cada estado intermedio, no solo al final. Push
confirmado a `origin/main` en los dos repos.

**Corrección de exactitud en el índice** (mismo criterio que la sección
"Contradicciones código ↔ docs"): la fila de
`indice-conocimiento.md` sobre
`diseno-precio-servicio-vs-recurso-2026-08-27.md` decía "implementado
— backend + dashboard + los 3 caminos del portal". El backend sí; el
frontend recién se pusheó hoy — corregido en el mismo cambio, con nota
de la fecha real.

**Lección para sesiones futuras:** "está en el código local, con
comentario fechado y tests verdes" **no** es lo mismo que "está
pusheado" — verificar `git status`/`git log origin/main..HEAD` antes de
dar por deployado algo que el índice describe como "implementado",
sobre todo si pasó más de una sesión desde que se escribió esa fila.

---

## Plan de ejecución acordado — estado actualizado

Pasos 0, 3, 4, 5 ✅ resueltos (ver `plan-resolucion-bugs-deuda-2026-08-27.md`
para el detalle completo de cada uno, incluida la sesión de hoy). **Paso 1
(D8) ✅ resuelto** (ver detalle abajo). Siguen abiertos, en el orden ya
acordado: **2** (D6), **6** (Gap C1-C), **7** (C3), **8** (C1-A.2, cobrar
seña), **9** (C2, reembolso), **10** (C1-A.1, configurar seña — necesita
las 4 decisiones de arriba), **11** (pantalla de reasignación de
mantenimiento).

### Paso 1 — D8: UI fiscal de producto — ✅ RESUELTO (28/08/2026)

Deuda de UI pura (el backend ya aceptaba `ivaRate`/`unit`/`arcaUnitCode`
desde el 22/08). Implementado en `appfrontend-main`:

- `src/lib/productos/types.ts` — los 3 campos agregados a `Product`/
  `CreateProductInput`/`UpdateProductInput`.
- `src/hooks/useBusinessModules.ts` (nuevo) — extraído del bloque
  duplicado que tenía `dashboard/layout.tsx` para el gating por módulo del
  nav; ahora también lo usan las 2 pantallas de producto. `layout.tsx`
  refactorizado para usarlo (elimina la duplicación en el mismo cambio).
- `dashboard/productos/page.tsx` (alta) y `dashboard/productos/[id]/page.tsx`
  (edición) — sección `<details>` colapsable "Datos fiscales (AFIP/ARCA)",
  gateada por `modules['FACTURACION'] !== false` (mismo criterio que el
  nav). `unit` es `<input list>` con datalist de sugerencias (unidad, kg,
  g, litro, ml, hora, m², docena) — texto libre, no restringe.
  `arcaUnitCode` es número crudo sin selector, con nota de que no se
  valida contra catálogo todavía (tal como pedía el enunciado del paso).
  `ivaRate`/`arcaUnitCode` coercionan `''`→`null` recién en el submit
  (nunca a 0 — vacío es "hereda"/"sin código", no "cero").

**Verificado de punta a punta, con click real** (el dueño hizo login en
`localhost:3000`, el agente hizo el resto sin tocar la sesión):
alta de un producto de prueba con los 3 campos → confirmado en la
respuesta 201 de `POST /api/products`; edición (cambio de `ivaRate`/`unit`,
`arcaUnitCode` vaciado) → confirmado en la respuesta 200 de
`PUT /api/products/:id` (`arcaUnitCode` quedó `null`, no `0`, al vaciarlo).
Confirmación final **contra la base, no contra la pantalla**: SQL de solo
lectura contra el proyecto Neon `ancient-king-17098519` (BD de tenant de
`biz-demo-01`, distinta de la BD de plataforma) — la fila real tenía
`iva_rate=10.50`, `unit='litro'`, `arca_unit_code=NULL`, calzando exacto
con lo cargado. El producto de prueba (`TEST fiscal D8 — borrar`,
`SKU TEST-D8-001`) se desactivó al cerrar (soft-delete, `active=false`
confirmado por SQL — `deleteProduct()` nunca hace hard-delete, ver
`sql.product.repository.ts:285-291`), con OK explícito del dueño.

**Hallazgo de entorno, no bloqueante, anotar para la próxima sesión que
necesite levantar el backend local:** `app-main/src/server.ts` lee
`process.env.PLATFORM_DATABASE_URL` pero el proyecto no usa `dotenv` —
nada carga `.env` automáticamente. `source .env` en Git Bash tampoco
alcanza: las URLs de Neon en el `.env` llevan `?sslmode=require&channel_binding=require`
sin comillas, y bash interpreta ese `&` como operador de background job,
así que la asignación se pierde (corre en una subshell que no persiste).
Hubo que exportar variable por variable con un loop `IFS='=' read`. Si
esto se repite seguido, vale la pena agregar `dotenv`/`--env-file` al
script `dev`, pero no se tocó en esta sesión (fuera de alcance del paso).

**Hallazgo confirmado, no nuevo pero re-verificado:** el
`PLATFORM_DATABASE_URL` del `.env` local de `app-main` apunta a la
**misma base de producción** (proyecto Neon `pdb-ppms` /
`morning-unit-50056927`, único negocio `biz-demo-01`) — no hay BD de
desarrollo separada. Cualquier verificación "local" en esta etapa del
proyecto toca datos reales; no es nuevo (mismo patrón que la sesión
27-28/08 con Neon) pero vale dejarlo explícito para quien levante el
backend local de acá en más.
