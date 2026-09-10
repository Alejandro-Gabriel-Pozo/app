# ZULU Hub — Continuidad operativa

- **Fecha de corte:** 2026-09-09, **tercer corte del mismo día**. Entre el
  segundo corte (abajo, §1 original) y este, los 6 commits de 3.3-b1/b2/d
  que ese corte describía como "ahead 6, sin pushear" **se pushearon** (el
  push que este mismo corte no vio venir), y arriba de eso corrió un arco
  transversal completo (RBAC-SYNC-001 §4, CONTRACT-001, CONTRACT-COVERAGE-001
  existencia, RBAC-MATRIX-HEADER-STALE-001, RBAC-MATRIX-SECTION2-001,
  LOCK-ORDER-001 punto ciego #2) — ver §2b. No repitas ninguno de esos
  bloques si estás retomando desde acá.
- **Reemplaza a:** `docs/zulu-hub-continuidad-2026-09-08.md` (arco del
  bloque B-núcleo+órdenes cerrado, deploy `9b651f2`). Ese documento sigue
  siendo la referencia de ese arco — no se reescribe acá.
- **Para qué:** que una sesión nueva sepa dónde quedó el proyecto y qué
  sigue, sin depender del historial conversacional.
- **Etiquetas:** `mapa-del-sistema` `continuidad`

---

## 1. Estado de producción (actualizado al tercer corte)

| Repo | `origin/main` | En producción | Local |
|---|---|---|---|
| `app-main` | `9be3eb7` (verificado con `git fetch` + `git rev-parse origin/main` al momento de este corte) | Deploy automático en cada push a `main` (Render) -- los 15 commits del arco RBAC/CONTRACT/LOCK-ORDER de hoy ya están en `origin/main`, no solo commiteados localmente. No confirmado acá si Render ya completó el deploy del último push (`9be3eb7`) -- verificar con `mcp__render__list_deploys` antes de asumirlo. | `7150dfa`, **ahead 1** de `origin/main`: solo `7150dfa` (fix LOCK-ORDER-001, punto ciego #2) -- sin pushear todavía, pendiente de autorización del usuario. |
| `appfrontend-main` | `613c206` | Sin cambio. | Sin cambio, no tocado hoy. |

> Verificar siempre con `git ls-remote origin refs/heads/main` (o
> `git fetch` + `git rev-parse origin/main`) antes de asumir que algo de
> esto llegó a producción -- este corte lo hizo así, no de memoria.

### 1 (original, segundo corte -- historial, ya no es el estado real)

| Repo | `origin/main` | En producción | Local |
|---|---|---|---|
| `app-main` | `e1b70bb` (sin cambio desde el corte anterior) | Deploy vivo sigue siendo el de `9b651f2` — **nada de lo de hoy está deployado**. | `6d55876`, **ahead 6** de `origin/main`: `d6f35a9` (gate diseño), `5a64ae2` (3.3-b1), `9b8209a` (docs precondición), `b0f9d93` (3.3-b2), `766eb84` (docs reconciliación), `6d55876` (3.3-d). Un push de esto es **fast-forward de 6 commits**, no de uno — incluye la ruta HTTP nueva con su RBAC. |
| `appfrontend-main` | `613c206` | Sin cambio. | Sin cambio, no tocado hoy. |

## 2. Qué se hizo hoy — primer arco, 3.3-b1/b2/d (ya pusheado, historial)

1. **Precondición de #29 cumplida** (`docs/pendientes-2026-09-08.md` #29):
   `prices_include_iva=TRUE` en las 2 tenants, 0 reservas con >1 factura
   viva en datos reales, grounding `auditor-circuitos-erp`. Registrado en
   `9b8209a`.
2. **Bloque 3.3-b1** (`5a64ae2`) — orquestador
   `CancelReservationWithCreditNoteService` + puerto
   `ReservationCancelForCreditNote`. SIN ruta en ese commit. 21 unitarios +
   4 integración real + 4 mutaciones. Suite 2006/2006.
3. **Bloque 3.3-b2** (`b0f9d93`) — ruta
   `POST /api/reservations/:id/cancel-with-credit-note` +
   `authorize(Roles.EMISOR_NOTA_CREDITO)` + RBAC completo. El gate corrigió
   3 errores antes de codear (error post-AFIP mapeado a 400 en vez de 422,
   6 códigos sin mapear en `error.middleware.ts`, respuesta sin
   `toReservationDto()`). Suite 2013/2013.
4. **Docs-only** (`766eb84`) — reconcilia anclas stale que el propio 3.3-b2
   volvió falsas en `CLAUDE.md`, el plan canónico y `pendientes`.
5. **Bloque 3.3-d** (`6d55876`) — `classifyReservationLiveInvoice()` +
   reconciliación de `handleReservationCancelled`, espejo de
   `classifyOrderLiveInvoice()`/`handleOrderCancelled()`. **El pasivo de
   deploy que 3.3-b2 creó queda retirado SOLO para "factura DIRECTA +
   reserva SIN `PAYMENT` propio ni filas anuladas previas"** — 2
   residuales medidos contra Postgres real, no cerrados (consolidada-parcial;
   reserva con seña propia vía `recordPayment()`). Mediciones read-only de
   producción (2 tenants): 0 reservas `CANCELLED` con comprobante vivo hoy
   (0 de 28 en Demo); 0 reservas con `PAYMENT` propio y 0 en consolidada,
   de 15 con algún cargo. **El residual es real como mecanismo, pero su
   tamaño en producción hoy es 0.** 4 mutaciones + 9/9 integración real.
   Suite 2017/2018. Detalle completo y firma de triage para el runbook en
   `pendientes-2026-09-08.md` #27 ítem 1.

## 2b. Qué se hizo después de ese corte — arco transversal (pusheado hasta `9be3eb7`, más `7150dfa` local)

Después del segundo corte de arriba, el usuario pidió "algo transversal
que no traiga más deuda futura" y la sesión encaró 6 bloques, cada uno con
su propio gate `architecture-governor` (diseño antes de codear, cierre
después). Todos con mutation testing real, no solo diseño. Detalle
completo de cada uno en `docs/pendientes-2026-09-08.md` (secciones
Seguridad/Higiene) y en `app-main/CLAUDE.md` (secciones RBAC/Contratos).

1. **RBAC-SYNC-001 §4** (`9d8fda1`, `e322dc7`) — nueva cerca
   `rbac-matrix-public-routes-sync.test.ts`: cruza la sección 4 de
   `docs/rbac-matriz-endpoints.md` contra `PUBLIC_ROUTES` en las dos
   direcciones. `e322dc7` corrige un bug real encontrado en la revisión:
   importar `PUBLIC_ROUTES` desde un `*.test.ts` hacía que Vitest
   re-ejecutara sus `describe()` (doble conteo). Extraído a
   `public-routes.fixture.ts`.
2. **CONTRACT-001** (`a96aa90`, `cf59908`) — `src/openapi/spec.ts`
   documentaba 3 de 19 paths con 404 real (2 de `/api/reports` mal
   escritos desde hace ~2.5 meses, 1 fantasma en `/api/resources`).
   Corregidos, y nueva cerca `openapi-spec-route-sync.test.ts` que cruza
   spec vs. rutas reales (existencia, no schemas).
3. **RBAC-MATRIX-HEADER-STALE-001** (`a8f9e67`, `80805f2`, `d39b8b7`,
   `58616b2`, `6beff80`) — el header de la sección 2 de la matriz RBAC ya
   se había desincronizado DOS veces (198/204 el 01/09, 205/206 el mismo
   09/09) del número real que exige `rbac-matrix-sync.test.ts`. Corregido,
   y una cerca nueva (tercer `it()` en `rbac-matrix-sync.test.ts`) que lo
   cruza automáticamente para que no pase una tercera vez. `80805f2` y
   `6beff80` corrigen, respectivamente, una nota que se adelantó a afirmar
   una cerca inexistente y un hash mal atribuido -- los dos encontrados por
   el propio gate en rondas sucesivas de revisión del mismo bloque.
4. **CONTRACT-COVERAGE-001, componente de existencia** (`2194849`,
   `e12e799`, `d57fec9`) — en vez de completar `spec.ts` a mano (18 de 251
   endpoints reales), se generó `docs/inventario-rutas.md`
   (`npm run docs:routes`) booteando la app real y caminando
   `app._router.stack` -- job de CI (`route-inventory-check`) que falla si
   el artefacto commiteado queda desincronizado. 6 mounts arman su router
   dentro de un closure por-request y son invisibles al árbol vivo
   (`CLOSURE_MOUNTS`, allowlist verificado en las 2 direcciones). No cubre
   autz ni schemas de request/response -- declarado explícito.
5. **RBAC-MATRIX-SECTION2-001** (`99eec17`, `fe1118d`, `9be3eb7`) — ninguna
   cerca cruzaba el CONTENIDO fila-por-fila de la sección 2 de la matriz
   (archivo→método+path) contra el código real, solo el conteo agregado.
   Nueva cerca `rbac-matrix-section2-sync.test.ts`, join por CÓDIGO (no
   por el inventario del punto 4 -- ese mapa archivo→prefijo no es función,
   2 archivos montan 2 routers en 2 prefijos distintos). `EXCLUDED_FILES`
   (11 archivos, 85 rutas protegidas en prosa, cuantificado) declara un
   hueco propio sin cerrar: no verifica la dirección "entrada stale" -- si
   alguien normaliza un archivo excluido y se olvida de sacarlo de la
   lista, queda verde ignorando las rutas nuevas. Bloque de código propio,
   sin empezar.
6. **LOCK-ORDER-001, punto ciego #2** (`7150dfa`, **local, sin pushear**)
   -- `LOCK_CALL_RE` no veía `getInFlightCreditNoteTotalForUpdate()`/
   `...ForPairForUpdate()` (agregados 08/09/2026, bloques 2.4/3.3-a).
   Cerrado -- clasificado `SINGLE_INVOICE_CALLERS` (lock de una sola fila
   preexistente, re-lock same-tx, sin riesgo de ABBA). El ADR
   (`docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md:487`)
   había decidido el 08/09 NO tocar esta cerca ("una cerca que ningún test
   puede poner en rojo no es cobertura") -- se revirtió esa decisión hoy
   porque la mutación SÍ la pone en rojo, verificado. **Deuda nueva sin
   anotar en pendientes todavía** (ver §3b): el falso negativo #1 de la
   misma cerca sigue abierto y un doc viejo (`pendientes-2026-09-05.md:131`)
   todavía dice "3 falsos negativos" cuando ahora son 2 abiertos + 1
   cerrado; y un residual de auto-deadlock por anidamiento de
   `PgTransactionManager.run()` que el gate encontró de paso, hoy sin
   ocurrir en ningún call-site real pero sin cerca que lo vigile.

## 3. Deuda declarada de hoy, ninguna bloqueante

- ~~Catch inline 409 en las dos rutas de escape~~ **✅ RESUELTO (mismo día,
  commit posterior a este corte)** — las dos rutas delegan a
  `error.middleware.ts` salvo una excepción declarada
  (`InvalidReservationError` en reservas). Ver `pendientes-2026-09-08.md`
  #27, ítem "Deuda declarada de paso".
- ~~`AFIP_NOT_CONFIGURED`: 422 inline, 503 en el middleware~~ **✅
  RECONCILIADO al valor del middleware (503)** en el mismo commit —
  reversión explícita de la divergencia "deliberada" que este mismo corte
  había declarado horas antes; el motivo original (simetría entre los dos
  escapes) sobrevive porque los dos cambian juntos.
- **Texto "la orden ..." de `CreditNoteCancellationPendingError`/
  `...RejectedError`** reusado tal cual del lado reservas (mensaje
  incorrecto, `.code` correcto) — `domain/errors.ts` append-only en los 3
  bloques, corregir el texto toca clases existentes.
- **Comentarios stale en `outbox.handlers.ts`** introducidos por 3.3-d: el
  docblock de `opts` de `registrarDesenlace()` sigue diciendo "SOLO lo pasa
  `handleOrderCancelled`" — desde `6d55876` son dos callers. Bloque aparte,
  comment-only, no mezclar con código funcional.
- **Harness de integración salteable en silencio:** `describe.skipIf(skipIfNoDb)`
  saltea TODA la suite sin `TEST_DATABASE_URL` en el entorno del proceso,
  `exit 0` sin haber corrido nada. Escribir esto en el runbook antes de
  confiar en "CI verde" como evidencia de que la suite de integración corrió.
  **Confirmado de nuevo en el bloque de LOCK-ORDER-001 de hoy** (§2b ítem
  6): `credit-note-pair-cap.integration.test.ts` salió 100% skipped en
  este entorno, sin `TEST_DATABASE_URL` disponible -- la corrección de esa
  cerca está sostenida por lectura de código y semántica de Postgres, no
  por ejecución real.

## 3b. Deuda nueva del arco transversal, sin anotar en pendientes todavía

Encontrada en el gate de cierre de LOCK-ORDER-001 (§2b ítem 6), pendiente
de anotar con ancla propia en `docs/pendientes-2026-09-08.md` (o el
próximo `pendientes-<fecha>.md` que se abra):

- **`docs/pendientes-2026-09-05.md:131` quedó stale.** Dice "3 falsos
  negativos declarados de la cerca `lock-order.test.ts`" -- después de
  `7150dfa` son 2 abiertos (nombre de variable distinto de `client`; el
  chequeo de `canonicalInvoiceLockOrder()` no verifica que envuelva el
  array correcto) + 1 cerrado (el método `...ForUpdate` nuevo invisible,
  que era justo el que disparó hoy).
- **Riesgo de auto-deadlock por anidamiento de `PgTransactionManager.run()`,
  no vigilado por ninguna cerca.** Si alguna vez `requestInvoice()` se
  llamara DENTRO de una transacción que ya lockeó la misma factura, el
  modo de falla no sería ABBA (mismo lock, mismo xid) sino un deadlock
  entre DOS conexiones distintas del pool (`run()` hace `pool.connect()`
  nuevo por invocación, `src/db/pg.transaction-manager.ts:23`). Hoy no
  ocurre -- los 5 call-sites productivos de `requestInvoice()` corren
  fuera de toda tx abierta, verificado uno por uno -- pero es un supuesto
  que nadie mantiene sincronizado y ninguna cerca protege.

## 4. Próximo bloque

**Ya no hay un bloque de código bloqueante para decidir push/deploy de
`app-main`** — todo lo commiteado hasta acá está resuelto localmente y
verificado. Lo que sigue es una mezcla de decisión del dueño y bloques
chicos ya identificados:

- **Push de `7150dfa`** (LOCK-ORDER-001) — 1 solo commit, fast-forward
  sobre `origin/main` (`9be3eb7`). Verificar con `git fetch` +
  `git rev-parse origin/main` inmediatamente antes, no asumir que sigue
  en `9be3eb7` solo porque este corte lo vio así.
- ~~**Bloque chico de docs, antes de seguir con código nuevo**~~ **✅
  RESUELTO** (`271fdd4`, `1cd9cea`): `pendientes-2026-09-05.md:131`
  corregido a 2 falsos negativos abiertos + 1 cerrado, residual de
  auto-deadlock registrado con ancla en `pendientes-2026-09-08.md`.
- **Segundo candidato transversal elegido por el usuario -- 🟡 PARCIAL,
  2 de 3 catálogos cerrados** (`appfrontend-main` `ba01d3d`,
  `app-main` `f0bee83`, 09/09/2026): el rol `EMISOR_NOTA_CREDITO`
  (backend, `security/roles.ts`) nunca se había propagado a 3 catálogos
  hardcodeados de `appfrontend-main`. Verificado con los dos lados antes
  de tocar código, como pedía este mismo ítem: `dashboard/roles/page.tsx`
  era fail-CLOSED real (PRO/ENTERPRISE no podía armar un rol custom con
  el grupo aunque el backend lo permitiera, `plan_limit_allowed_permission_groups`
  con 0 filas = sin restricción) -- ✅ cerrado, igual que
  `superadmin/planes/page.tsx` (lectura viva, sin propagación, reversible)
  -- ✅ cerrado. **`superadmin/roles-de-fabrica/page.tsx` sigue abierto a
  propósito:** edita PRESETS que SÍ se propagan por backfill a tenants
  existentes en cada boot, y su copy actual ("no afecta a negocios que ya
  existen") es falsa -- agregar el checkbox ahí sin corregir la copy
  habría sido el único camino activamente peligroso de todo el bloque
  (otorgar autoridad fiscal AFIP a cualquier preset, en producción, sin
  revocación real). Cross-repo con `app-main/src/platform/platform.routes.ts:422-423`
  (misma afirmación falsa), bloque aparte con su propio gate. Detalle
  completo en `pendientes-2026-09-08.md` y
  `plan-cierre-cancelacion-nc-y-deuda-estructural-2026-09-08.md:228`.
- **Bloques de código heredados del primer arco, ninguno bloqueante:**
  `3.3-c` (cablear F4 en `findBlockingInvoiceLinkage()`, firma congelada),
  `3.3-e` (índice de rendimiento), el clasificador por PAR
  `(invoiceId, reservationId)` que cerraría el residual consolidada-parcial,
  ensanchar la guarda de `handleReservationCancelled` para el caso
  `PAYMENT` propio, y RBAC-MATRIX-SECTION2-001 (§2b ítem 5): cerrar el
  hueco de "entrada stale" de `EXCLUDED_FILES` antes de normalizar
  cualquiera de los 11 archivos en prosa.
