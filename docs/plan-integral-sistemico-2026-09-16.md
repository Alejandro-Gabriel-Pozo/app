# Plan integral y sistémico — auditoría de 16 fases + pendientes (16/09/2026)

**Fecha:** 2026-09-16
**Fuentes** (ninguna se re-deriva, todas se citan por ID y documento):
- `docs/auditoria-integral-fase15-2026-09-16.md` — 25 decisiones `D-01`..`D-25`.
- `docs/auditoria-integral-fase16-2026-09-16.md` — mapa del sistema, 10 etapas de refactor (§12), 27 acciones priorizadas P0-P4 (§13), 16 preguntas `P-01`..`P-16` (§14).
- `docs/pendientes-2026-09-12.md` (4143 líneas) — inventariado completo por un agente de lectura el 16/09/2026 (~100-110 ítems abiertos, todas las secciones, sin saltear ninguna).

## 0. Qué es este documento y qué no

Es la capa de síntesis que cruza los resultados de la auditoría de 16 fases (visión de sistema, "qué está estructuralmente mal") con `pendientes-2026-09-12.md` (visión de sesión, "qué se dejó a medio hacer en las últimas semanas de trabajo real sobre City Ledger/facturación/RBAC"). **No reemplaza a ninguno de los dos.** `pendientes-2026-09-12.md` sigue siendo el documento que se lee al empezar cada sesión (regla del `CLAUDE.md` raíz); este plan no absorbe su función. Tampoco es el roadmap de producto (`docs/roadmap-pms-multirubro.md`), que sigue sin revalidar desde el 25/08/2026 — dato aparte, no corregido acá (ver §7).

Regla aplicada en todo el documento, tomada directo de la sección "Pendientes — revalidar antes de arrastrar" del `CLAUDE.md`: cada ítem lleva su ancla y su documento de origen citado explícitamente — la causa registrada de `F3-ID-COLLISION-001`/`F5-15` fue exactamente citar un ID sin decir de qué documento, y este plan cruza dos familias de ID que ya colisionan una vez (ver §1).

---

## 1. Colisiones de ID resueltas explícitamente

### D-14 — dos conceptos distintos, mismo ID, dos documentos

- **`D-14` (Fase 15)** = *"La saga de aprovisionamiento de tenant vive cuatro veces, con políticas de fallo distintas"* (`F7-05`). Alta. Requiere característica de regresión + backup durable antes de tocarse.
- **`D-14` (pendientes-2026-09-12.md)** = *"Contrato canónico de paginación (limit/offset, envelope, desempate por `id`) sin correr contra Postgres real, solo repo in-memory"*. 🔍 Verificación pendiente.

**No son el mismo hallazgo.** De acá en más, en cualquier documento nuevo o conversación, citar siempre **"D-14 (Fase 15)"** o **"D-14 (pendientes)"** — nunca "D-14" a secas. Este plan no les asigna un ID nuevo compartido porque cada uno ya tiene tracking propio en su documento de origen; renombrar cualquiera de los dos rompería ese tracking sin necesidad.

### F5-01 — el mismo hallazgo, encontrado por dos caminos, NO duplicado

- **`D-03` (Fase 15)**, basado en `F5-01` (Fase 5) + `F9-15` (Fase 9): token CUSTOMER del portal alcanza 4 rutas mutantes de staff sin guard de pertenencia. Síntesis de auditoría, sin reproducción contra Postgres real declarada como pendiente en Fase 15.
- **`F5-01` (pendientes-2026-09-12.md)**, en "Hallazgos de diseño abiertos, 15/09/2026": el mismo hallazgo — **reproducido con una corrida real contra Postgres** — y su vecino directo `CUSTOMER-TOKEN-STAFF-ROUTE-500-001` (mismo token, 9 rutas GET adicionales, con **un consumidor real roto en producción**: `GET /bookable-services` del portal falla en silencio por un `.catch(() => {})`, dejando el selector de servicios vacío sin error visible al usuario).

**Es un solo hallazgo, no dos.** La ventaja de fusionarlo en el tracking: `pendientes` ya tiene la reproducción real y el caso de producción rota que la auditoría no había buscado; la auditoría (`D-03`) ya tiene las tres opciones de fix comparadas con su tabla de complejidad/riesgo/rollback. **Tratamiento unificado en este plan: §3, fila P0-bis.**

Ningún otro ID se repite entre los dos corpus (verificado por inspección: los `D-XX` de Fase 15 son 25 numerados sin equivalente textual en pendientes salvo los dos casos de arriba; los IDs en mayúsculas de pendientes —`CITY-LEDGER-*`, `CN-ESCAPE-*`, etc.— son todos de trabajo posterior al corte de la auditoría de 16 fases, que no llegó a auditar en detalle el trabajo de City Ledger/reversa/credit-note de los días 12-15/09 — ver §5).

---

## 2. El riesgo más urgente: lo que el próximo deploy se lleva puesto

Este es el cruce de mayor valor de todo el documento — dos hallazgos independientes, de dos auditorías distintas, describiendo **la misma clase de riesgo** sin que ninguno de los dos documentos lo dijera de frente:

- **Pendientes, "Bloque 3a — mecanismo general de reversa del ledger"** (`reversed_transaction_id`, schema v52→v54): DDL **destructivo** (2 `ADD CONSTRAINT` + 1 `DROP COLUMN`) nunca corrido contra Postgres real. Producción sigue en v52 — el próximo deploy salta dos versiones de una. 🔍, marcado por el propio inventario como "riesgo de deploy" #1 de los 20 más importantes.
- **Fase 15 `D-08` (CRÍTICA)**: `migrate:tenants` reaplica `schema.sql` entero en una sola transacción implícita; los `ALTER TABLE ... ADD CONSTRAINT` sin guard sostienen `AccessExclusiveLock` sobre `reservations` — medido en **45,9 s** con 200k reservas.
- **Fase 15 `D-22` (Alta)**: no existe ninguna prueba del camino de *upgrade* de schema sobre una base poblada — reproducido: un solo tenant con datos que violen una constraint nueva **bloquea el deploy de toda la flota**.

El Bloque 3a de pendientes no es un caso aislado: es exactamente el escenario que D-08/D-22 describen en abstracto, ocurriendo ahora mismo con un cambio concreto ya escrito y sin pushear. **Consecuencia práctica para el orden de trabajo:** antes de pushear el Bloque 3a, corresponde aplicar primero la Etapa 1 (D-21, un cambio de una línea) y idealmente la Etapa 3 de Fase 16 (guard `pg_constraint` extendido, D-08) — o, como mínimo, verificar el Bloque 3a contra una base con volumen realista, no solo contra una base vacía. Ver la fila P0 de §3.

Nota aparte, sin fusionar con lo anterior: `D-21` (Fase 15, CRÍTICA — suite de integración roja, 153/380 tests) tiene como causa exacta el índice `uq_resources_name` del commit `073a8d4` — que es **el mismo commit** que pendientes ya lista en 🔍 Verificaciones pendientes citando la frase *"el índice único parcial `uq_resources_name` nunca corrió contra Postgres real; solo se ejercitó el catch del 23505 con un mock"*. La propia Fase 13 de la auditoría ya cita esta frase de pendientes como "agravante de proceso" (ver `auditoria-integral-fase16-2026-09-16.md` §3, D-21). No hace falta re-cruzarlo acá más que confirmar que el fix de D-21 (una línea en `seed.ts:90`) es independiente del bloque 3a — el índice en sí es correcto y gateado, según la propia auditoría.

---

## 3. Orden de trabajo unificado

Reemplaza, para efectos de "por dónde arrancar", tanto la lista de §13 de Fase 16 como la lectura suelta de las secciones 🔴/🟡 de pendientes — sin descartar ninguna de las dos, que siguen siendo la fuente de detalle. Un ítem "P0" acá bloquea todo lo demás; un ítem sin prioridad explícita sigue abierto en su documento de origen, no se resume.

| Orden | Ítem | Origen | Por qué primero | Bloquea |
|---|---|---|---|---|
| **P0** | `D-21` (Fase 15) — 1 línea en `seed.ts:90` | Fase 15/16 | Sin esto, ninguna otra verificación (incluida la del Bloque 3a) puede correr contra la suite de integración | Todo lo que dependa de `npm run test:integration` |
| **P0** | Verificar Bloque 3a (reversa del ledger, schema v52→v54) contra Postgres real con volumen, **antes** de pushear | pendientes + D-08/D-22 (Fase 15) | DDL destructivo nunca ensayado, próximo deploy salta 2 versiones | El deploy que lo lleve |
| **P0-bis** | `F5-01` / `D-03` fusionado (token CUSTOMER alcanza rutas de staff) | pendientes + Fase 15 | Reproducido contra Postgres real, con un consumidor de producción ya roto (`GET /bookable-services`); 3 opciones de fix ya comparadas en Fase 15 | Requiere decisión del dueño (P-01, Fase 15) — no bloquea otro trabajo, pero es explotable hoy |
| **P1** | `§7.2(b)` — doble emisión de CAE AFIP contra un cargo ya revertido por `reverseTransfer()`, sin rastro en logs | pendientes (#2 de los 20 más importantes) | Dinero + fiscal, sin lock que lo evite; fuera del alcance de la auditoría de 16 fases (trabajo posterior) | Requiere gate propio, alto impacto |
| **P1** | `D-01` (Fase 15) — bump `next`≥16.3.3 + `sharp`≥0.35.4 + `npm audit` en CI | Fase 15/16 | 2 advisories CRITICAL de RCE, patch de menor radio de toda la auditoría | Ninguna |
| **P1** | `D-07(a)` (Fase 15) — consulta de diagnóstico de solo lectura contra cada tenant | Fase 15/16 | Define si D-07 es Crítica o Alta real; sin esto no se puede decidir P-05 | D-07(c) |
| **P1** | `CITY-LEDGER-REVERSE-ROUTE-GROUP-FREEZE-001` | pendientes (#5 de los 20 más importantes) | El escape fiscal de la reversa puede degradarse de `EMISOR_NOTA_CREDITO` a cualquier otro rol sin que las 7 cercas RBAC lo detecten — mismo patrón que `CN-ESCAPE-CONTAINMENT-001` ya resolvió para otras 2 rutas | Ninguna — es agregar `ESCAPE_ROUTES` a la cerca existente |
| **P2** | `D-08` (Fase 15) — extender guard `pg_constraint` a las 28 posiciones | Fase 15/16 | 45,9 s de bloqueo por deploy, creciente | P0 (D-21) |
| **P2** | `CITY-LEDGER-AR-DOUBLE-TRANSFER-001` | pendientes (#6) | Misma deuda de un huésped transferida 2 veces a una empresa | Requiere diseño propio |
| **P2** | `CN-ESCAPE-ORPHAN-ADJUSTMENT-001` | pendientes (#7) | Alcanzable HOY (9/11 facturas de la tenant Demo); decisión de producto ya tomada, falta implementar | Bloqueado detrás del HOLD de `invoice_drafts`/`FACT-BORRADOR-001` |
| **P2** | `D-02`, `D-11`, `D-10` (Fase 15) — secretos en logs + contrato de `TransactionManager` + `idempotencyKey` al abrir formulario | Fase 15/16 (Etapa 4) | Bloque chico y de bajo riesgo, cierra 3 huecos de dinero/seguridad a la vez | Ninguna |
| **P2** | `CITY-LEDGER-GUARD-RETRY-EMITS-001` | pendientes | Reintentar una emisión puede disparar una Factura B real evadiendo el warning de AR viva | Requiere diseño y gate propio |
| **P2** | `POOL-MIXTO-MANUAL-01` | pendientes (#9) | Una reserva con >1 factura ISSUED viva queda permanentemente inalcanzable para el escape con NC | Impacto operativo alto, sin medir volumen real |
| **P3** | `D-17` (Fase 15) — N+1 de reservas | Fase 15/16 | 401 queries por página de 200; ya con el patrón de fix existente en el repo | P0 (D-21) |
| **P3** | `locations` (Área 3.2, auditoría transversal) | pendientes (#11) | Bloquea multi-sucursal real para toda la app; roadmap lo declara resuelto sin serlo | Requiere decisión del dueño: `locations` vs `companies` |
| **P3** | `SEC-ROT-001` Parte 2/3 | pendientes (#10) | Rotación de `DB_ENCRYPTION_KEY` no es una capacidad operativa real hoy | Ninguna técnica, sí de tiempo |
| **P3** | Resto de `D-XX` con decisión del dueño pendiente (`D-04,05,06,09,12,13,15,18,19,22,23,24,25`) | Fase 15/16 §14 | Ver §4 — requieren respuesta del dueño antes de poder priorizarse con más precisión | Ver P-XX individuales |
| **P4** | `1.B` — sidebar gatea por nombre de rol, no por grupo | pendientes (#15) | Rompe roles personalizados, feature paga — impacto de negocio, no solo UX | Ninguna técnica |
| **P4** | Resto de 🟡 "listo para encarar" de pendientes (~16 ítems) sin cruce con la auditoría | pendientes | Sin bloqueo de decisión, solo falta tiempo/gate — no repetidos acá, ver el documento original | — |

**Lo que este orden NO incluye:** los ~35 ítems de "🔍 Verificaciones pendientes" de menor impacto (no listados entre los 20 más importantes del inventario), los 5 ítems "🟢 deuda aceptada", los ~9 "menores/cosmético", y el backlog de producto sin fecha — todos siguen íntegros en `pendientes-2026-09-12.md`, sin necesidad de repetirlos acá.

---

## 4. Preguntas pendientes del dueño — unificadas

Fase 15/16 ya dejó 16 preguntas `P-01`..`P-16` (§14 de Fase 16) que no se pueden resolver leyendo código. Pendientes, por su lado, acumula sus propios ítems 🔴 "bloqueado en decisión del dueño". No hay solapamiento de contenido entre las dos listas (temas distintos: la de Fase 15/16 es sobre los hallazgos estructurales de la auditoría; la de pendientes es sobre el trabajo de City Ledger/facturación de los últimos días) — **salvo el caso ya resuelto en §1 (F5-01/D-03, que este plan trata como P0-bis, no como pregunta abierta: las 3 opciones ya están comparadas, falta que el dueño elija entre (a)/(b)/(c)).**

### 4.1 — Las 16 de Fase 15/16 (`P-01`..`P-16`)

Sin repetir el detalle — ver `auditoria-integral-fase16-2026-09-16.md` §14 completo. Lista de referencia rápida:

| # | Tema | Decisión que falta |
|---|---|---|
| P-01 | D-03 (=F5-01, ver §1) | (a) rechazar tokens CUSTOMER en rutas de staff / (b) guard por ruta / (c) partir `BOOKING` en dos grupos |
| P-02 | D-04 | ¿Tope de vida absoluta de sesión? |
| P-03 | D-05 | ¿Token de un solo uso o aprobación en dos pasos para vincular empresas? |
| P-04 | D-06 | ¿Retirar `repair-tenant-db` o renombrar la variable + guarda? |
| P-05 | D-07 | Con el conteo de filas candidatas: ¿qué hacer con las tarifas ya convertidas? |
| P-06 | D-09 | ¿Deploy más lento (apply completo por tenant) o mantener el salto validado? |
| P-07 | D-10 | ¿`idempotencyKey` obligatoria? |
| P-08 | D-12 | ¿Se implementa el sweep de casilleros reclamados sin efecto? |
| P-09 | D-13 | ¿Cuál de las 3 opciones de build? + dato de Render pendiente |
| P-10 | D-19 | ¿Sacar la generación de PDF del camino interactivo? + límite de RAM real |
| P-11 | D-15 | ¿Qué literales pasan a ser config por tenant? |
| P-12 | D-18 | **HOLD explícito** — dirección del bus de `wake()` |
| P-13 | D-22 | ¿Query de pre-chequeo como runbook? ¿Alinear PG 17/18? |
| P-14 | D-23 | Familia por familia, ¿qué se retira y qué se completa? |
| P-15 | D-24 (Caja) | ¿Completar o retirar con ADR? |
| P-16 | D-25 | **HOLD explícito** — ¿desbloquear el resolver fiscal? |

### 4.2 — Las de pendientes, sin equivalente en Fase 15/16 (trabajo posterior a la auditoría)

| Tema | Documento origen | Decisión que falta |
|---|---|---|
| `CUSTOMER-EMAIL-REQUIRED-001` | pendientes | ¿Corregir el escape hatch o aceptarlo? |
| `CANCEL-WITH-NC-UI-001` | pendientes | ¿Banner persistente, modal, o aceptar el toast de 4s para la advertencia de City Ledger? |
| Penalidad retenida en reembolso parcial | pendientes | Dueño ya dijo "depende del rubro" — falta diseñar el mecanismo configurable |
| `credit_note_request` LA TABLA | pendientes | Sigue en HOLD (repetido en 3 secciones del propio archivo) |
| `ORDER-CONSOLIDATED-PARTIAL-01` bloque `1d` | pendientes | HOLD, sin fecha |
| `CANCEL-POLICY-SCOPE-BASE-001` Bloque 2 | pendientes | Reservas CONFIRMED antes de la columna nueva: ¿regla viva o rechazar el cálculo? |
| Hueco doble comprobante — pregunta de negocio | pendientes | ¿Liberar el cargo automático al rechazo AFIP, o requiere acción explícita? |
| `locations` vs `companies` (Área 3.2) | pendientes | Modelo de multi-sucursal — bloquea 4 rubros |
| `4.3` — reserva por tipo de unidad vs. unidad concreta | pendientes | Decisión de producto de costo alto |

**Total unificado: 16 (Fase 15/16) + 9 (pendientes, sin solapar) = 25 preguntas reales pendientes del dueño**, más la de P0-bis (§1) que ya tiene sus opciones comparadas por partida doble.

---

## 5. Lo que la auditoría de 16 fases NO alcanzó a cubrir

La auditoría de 16 fases cerró su corte de evidencia en HEAD `986d73c` (Fase 16). El trabajo de City Ledger (`reverseTransfer()`, Bloque 3a/3b/3c), `credit_note_request`, y la auditoría transversal de navegación/portal de clientes — todo fechado 12-15/09/2026 en `pendientes-2026-09-12.md` — es **posterior** al alcance que las Fases 0-14 relevaron y **no tiene contraparte `F{N}-YY`** en ningún documento de fase. Esto no es un hueco de la auditoría: es trabajo que ocurrió en paralelo. Consecuencia práctica: los ~30 IDs `CITY-LEDGER-*`/`CN-ESCAPE-*`/`INVOICE-CHARGES-*` de pendientes son la única fuente de verdad sobre esa área — no buscar una síntesis de Fase 15/16 que no existe para ellos.

---

## 6. Ítems ya resueltos que ninguno de los dos documentos necesita repetir

Listados por el propio inventario de pendientes como "ya resueltos que el archivo todavía menciona de pasada" — no se repiten acá: `FN#2 lock-order test`, `EMISOR_NOTA_CREDITO` bloque 5.1, guard `isSystem` en `renameRole()`, Polling adaptativo bloque 1 (implementación), `REFUND-ISSUED-RACE-01` Block B, `PLAN-LIMITS-SEED-REVERT-001`, `PRESET-REVOKE-001`, `SCHEMA-ANCHOR-DRIFT-001` (decisión tomada), saga `ORDER-CONSOLIDATED-PARTIAL-01` hasta 1c-ii-c, `STAY-ADJUSTMENT-PRICE-001`, `REFUND-ATTRIBUTION-RESIDUAL-001`, `CN-VOID-COREJECT-STALE-TEST-001`, hueco doble comprobante (técnicamente, no la pregunta de negocio — ver §4.2), `INVOICE-CHARGES-BUTTON-DEADEND-01`, `RESERVATION-STATUS-EXPIRED-FRONTEND-01` (implementación), `OUTBOX-RETRY-HIST-01` + `OUTBOX-BACKOFF-01`, `OUTBOX-DL-COMPENSATOR-01` Bloque A, `CUSTOMER-PORTAL-NO-OUTBOX-WORKER-001`, `SEC-ROT-001` Parte 1, `FACT-BORRADOR-001` decisiones D1-D6/PN-2/PN-6.

De Fase 15/16: ninguna decisión `D-XX` está resuelta — la propia Fase 15 §0 confirma que los 8 commits previos a su corte son solo documentación de auditoría, ninguna remediación aterrizó en código.

---

## 7. Nota aparte, no resuelta acá: el roadmap de producto

`docs/roadmap-pms-multirubro.md` no se revalidó desde el 25/08/2026 (21 días). Por regla propia del documento (`CLAUDE.md`, sección "Roadmap de producto"), no se revalida solo — hace falta pedirlo explícitamente. Dos cruces que este plan detecta y dejan nota, sin revalidar el roadmap entero:

- **D-24 (Fase 15, Caja)** ya señala que el roadmap solo menciona Caja de forma incidental dentro de Multidivisa — confirma lo que el roadmap mismo no puede ver de sí mismo.
- **`locations` (Área 3.2, pendientes)** contradice directamente la fila del roadmap que declara "Transferencia entre depósitos ✅ Resuelto" — esa transferencia depende de `locations`, que la propia auditoría transversal encontró estructuralmente inalcanzable en producción (sin `PUT`/`DELETE`, 0 en frontend). **Esto es una discrepancia real que amerita revalidar esa fila puntual**, no el roadmap completo.

---

## Apéndice — cómo se construyó este documento

1. Relectura completa de `auditoria-integral-fase15-2026-09-16.md` (832 líneas) y `auditoria-integral-fase16-2026-09-16.md` (717 líneas) — sin re-derivar evidencia, solo síntesis de lo ya escrito.
2. Inventario completo de `docs/pendientes-2026-09-12.md` (4143 líneas) por un agente de lectura dedicado, en 9 tramos, sin saltear secciones — reporte íntegro recibido el 16/09/2026.
3. Cruce manual de los dos corpus buscando: (a) colisiones de ID, (b) el mismo hallazgo bajo dos nombres, (c) hallazgos generales de la auditoría que explican o agravan un ítem puntual de pendientes, (d) huecos de cobertura en cualquiera de las dos direcciones.
4. Este documento no reclasifica severidades ni cierra ningún ítem — cada fila sigue remitiendo a su documento de origen para el detalle completo, las opciones de solución comparadas, y las pruebas necesarias.

---

## Apéndice A — Correcciones del gate (`architecture-governor`, 16/09/2026)

Verificación independiente previa al commit, contra los archivos fuente
reales (`auditoria-integral-fase15-2026-09-16.md`,
`auditoria-integral-fase16-2026-09-16.md`,
`pendientes-2026-09-12.md`, `decisiones-auditoria-fase2-2026-09-15.md`,
`roadmap-pms-multirubro.md`), no contra el inventario del agente de
lectura que produjo §1, §2, §3, §4.2 y §6. El cuerpo del documento
(§0 a §7 y el Apéndice "cómo se construyó") **no se edita** — misma
convención que las Fases 12 a 16. Ninguna conclusión del cuerpo se
retira: las ocho correcciones son de aparato de cita y de calibración
de severidad.

Lo que sí se verificó y quedó confirmado sin cambios: el Bloque 3a
(`pendientes:867-908`, incluido el salto **v52 → v54** textual y la
composición del DDL destructivo), `D-08` (45 855 ms medidos,
`fase15:249`), `D-22` (`fase15:629-637`), `D-21`
(`fase15:604-620`), `CITY-LEDGER-REVERSE-ROUTE-GROUP-FREEZE-001` con
su frase *"las 7 cercas RBAC del repo quedan en verde"*
(`pendientes:177-180`), el mapeo completo `P-01`..`P-16` → `D-XX`
(`fase16:613-628`, los 16 correctos), los 9 ítems de §4.2, la fila
`roadmap-pms-multirubro.md:237` y el corte de evidencia en HEAD
`986d73c` (`fase16:8`). Escaneo de instrucción encubierta sobre
`pendientes-2026-09-12.md` y sobre este documento: sin hallazgos.

### A.1 — La colisión de ID no es una, son diez, y el segundo `D-14` no es de `pendientes`

§1 presenta `D-14` como *"dos conceptos distintos, mismo ID, dos
documentos"* y propone citar *"D-14 (Fase 15)"* o *"D-14
(pendientes)"*. Las dos mitades necesitan corrección.

**El dueño del segundo `D-14` es un tercer documento.**
`pendientes-2026-09-12.md:91` lo declara: *"grounding de D-14,
docs/decisiones-auditoria-fase2-2026-09-15.md #12"*. Ese archivo
existe y tiene `## 12. D-14 — Contrato de paginación`. `pendientes`
**cita** el ID; no lo posee.

**Y ese registro colisiona diez veces, no una.** Numera 15 decisiones
del dueño, y todas sus `D-XX` caen dentro del rango `D-01`..`D-25` de
Fase 15: **D-02, D-03, D-07, D-08, D-09, D-10, D-14, D-15, D-16,
D-23**.

De esas diez, tres aparecen literalmente dentro de `pendientes` —
enumeración exhaustiva de `D-NN` en ese archivo, descartando falsos
positivos de IDs tipo `…FRONTEND-01`:

| ID | En `pendientes` | En Fase 15 |
|---|---|---|
| `D-03` | `:93` — horizonte de ventana de mantenimiento en dos tramos | `:89` — token del portal alcanza 4 rutas mutantes de staff |
| `D-10` | `:60` — auditoría de transiciones de reserva | `:298` — la `idempotencyKey` del pago está atada al intento |
| `D-14` | `:70` — contrato canónico de paginación | `:417` — la saga de aprovisionamiento vive cuatro veces |

Por lo tanto, la frase de `:33` — *"Ningún otro ID se repite entre los
dos corpus (verificado por inspección…)"* — **es falsa**. Y el caso
`D-03` es el peor: este mismo documento usa `D-03` sin calificar en
§1, en la fila P0-bis de §3 y en P-01 de §4.1. Es el modo de falla de
`F3-ID-COLLISION-001` que la línea 13 invoca como justificación del
documento, reproducido adentro del documento.

Debe leerse: *"`D-14` es una de **diez** colisiones entre el registro
de Fase 15 (`D-01`..`D-25`) y `docs/decisiones-auditoria-fase2-2026-09-15.md`
(D-02, D-03, D-07, D-08, D-09, D-10, D-14, D-15, D-16, D-23). Tres de
ellas —`D-03`, `D-10`, `D-14`— aparecen citadas dentro de
`pendientes-2026-09-12.md`. Regla: **ningún `D-XX` se cita sin su
documento**, y el documento correcto para el segundo sentido es
`decisiones-auditoria-fase2-2026-09-15.md`, no `pendientes`."*

Renumerar cualquiera de las dos familias queda **fuera** de esta
corrección: toca documentos que otros ya citan, y `pendientes:978-981`
tiene esa misma decisión abierta para `F3-0N`.

### A.2 — §1 y §3 amplifican `F5-01` / `CUSTOMER-TOKEN-STAFF-ROUTE-500-001` contra el texto de su fuente

Dos afirmaciones del cuerpo contradicen literalmente a
`pendientes-2026-09-12.md`.

**(i) "un consumidor real roto en producción"** (§1) y *"un consumidor
de producción ya roto"* (§3, P0-bis). La fuente califica lo contrario
(`:1025-1027`): *"encontrado por el gate `architecture-governor` al
verificar F5-01, 15/09/2026, **confirmado por camino de código — no
observado corriendo contra producción**"*. Los anclas
(`appfrontend-main/src/lib/customerApi.ts:221`, llamado desde
`app/portal/[businessSlug]/cuenta/reservas/page.tsx:112,130`, con
`.catch(() => {})`) son reales; el **efecto en producción** no está
observado.

**(ii) "es explotable hoy"** (§3, P0-bis, columna *Bloquea*). La
fuente afirma lo opuesto, y con corrida real
(`pendientes:1003-1014`): *"**hoy NO hay bypass de escritura** — las 4
rutas devuelven 500 antes de tocar la BD del tenant"*, por `TypeError`
en `reservations.routes.ts:369` y throw de `db/tenant-context.ts:78`.
La misma entrada aclara que *"el 500 de hoy es un efecto colateral no
diseñado, no una protección deliberada"* — lo que mantiene la
prioridad alta del ítem, pero **no** lo vuelve explotable hoy.

Debe leerse: *"…y su vecino directo `CUSTOMER-TOKEN-STAFF-ROUTE-500-001`
(mismo token, 9 rutas GET adicionales, con **un consumidor confirmado
por camino de código —no observado contra producción— que hoy recibe
ese 500 y lo traga en silencio**)"*; y, en la fila P0-bis: *"…**hoy no
explotable como escritura** (las 4 rutas mueren en un 500 accidental
antes de tocar la BD, medido), pero la protección es colateral, no
diseñada, y el fix obvio la retira"*.

### A.3 — Las dos fuentes se contradicen sobre el comportamiento actual de las 4 rutas, y el documento no lo señala

Esto **no es un error del cuerpo**: es el hallazgo que el cuerpo debía
producir y no produjo, siendo la reconciliación de fuentes de verdad
su propósito declarado (§0).

- `auditoria-integral-fase15-2026-09-16.md:99`, D-03, *Comportamiento
  actual*: *"**Las 4 rutas aceptan la request.**"*
- `pendientes-2026-09-12.md:1004`, F5-01, corrida real del 15/09
  re-verificada por el gate con log de servidor: *"las 4 rutas
  devuelven **500** antes de tocar la BD del tenant"*.

Las dos no pueden ser ciertas a la vez. La de `pendientes` es
posterior y está medida; la de Fase 15 es de lectura de código y su
propio *Nivel de certeza* (`:101`) marca como `No confirmado` que una
request real obtenga 2xx.

Relacionado: §1 afirma que D-03 es *"Síntesis de auditoría, sin
reproducción contra Postgres real"* y que `pendientes` aporta la
reproducción *"que la auditoría no había buscado"*. Fase 15 `:96` cita
**ese mismo test** como evidencia ya existente: *"reproducción ya
existente en `src/tests/integration/customer-token-staff-route-ownership.integration.test.ts`"*.
Lo que `pendientes` agrega no es el test — es el **resultado medido**
del test y el vecino `…-500-001`.

Debe agregarse a §1: *"**Contradicción abierta entre las dos fuentes,
no resuelta acá:** Fase 15 `:99` afirma que las 4 rutas aceptan la
request; `pendientes:1004` mide que devuelven 500 antes de tocar la
BD. Prevalece la medición de `pendientes` (posterior, con log de
servidor), y la línea de Fase 15 queda marcada como superada por
evidencia de runtime — pero corregirla es un bloque aparte, con su
propio gate."*

### A.4 — §2 atribuye una cita textual que no existe

§2 afirma: *"La propia Fase 13 de la auditoría ya cita esta frase de
pendientes como **«agravante de proceso»** (ver
`auditoria-integral-fase16-2026-09-16.md` §3, D-21)."*

Corrido por el gate: la cadena `agravante de proceso` **no aparece en
Fase 15 ni en Fase 16**. Los únicos hits de "agravante" en ambos
archivos son *"Tres agravantes"* en D-07 (`fase15:221`,
`fase16:151`), sobre la conversión de tarifas — otro hallazgo. Y Fase
16 §3 (`:31`), donde se sitúa la cita, no reproduce la frase de
`pendientes` en ningún punto.

La referencia real existe, en otro documento y otra sección: Fase 15
`:620`, D-21, *Causa probable* (b), que cita
`docs/pendientes-2026-09-12.md:48-51` y concluye —sin usar la
expresión "agravante de proceso"— que *"el residuo estaba registrado y
aun así se pusheó sin correr la suite que sí podía verlo"*.

Debe leerse: *"La propia Fase 15 cita esa frase de pendientes en la
*Causa probable* (b) de `D-21` (`auditoria-integral-fase15-2026-09-16.md:620`,
contra `docs/pendientes-2026-09-12.md:48-51`), y concluye que «el
residuo estaba registrado y aun así se pusheó sin correr la suite que
sí podía verlo»."*

### A.5 — El ranking "#N de los 20 más importantes" no tiene referente en ningún documento versionado

§2 y ocho filas de §3 anclan su prioridad en *"#1 / #2 / #5 / #6 / #7
/ #9 / #10 / #11 / #15 de los 20 más importantes"*, atribuyéndolo a
`pendientes` (*"pendientes (#2 de los 20 más importantes)"*).

`grep -n "20 más importantes" docs/pendientes-2026-09-12.md` → **0
coincidencias**. Ese archivo no contiene ninguna lista de veinte ni
ningún ranking numerado. La procedencia real es el **reporte del
agente de lectura** que inventarió el archivo el 16/09/2026 — un
artefacto de sesión, no versionado, no citable.

Es exactamente la regla 1 de `CLAUDE.md` §"Pendientes — revalidar
antes de arrastrar": *"Ningún ítem sin ancla verificable… Un ítem sin
referente no se arrastra: se reescribe o se borra."*

Debe leerse, en cada una de esas nueve citas: sustituir
*"pendientes (#N de los 20 más importantes)"* por
*"pendientes, §<sección> — prioridad asignada por este plan, no por el
documento fuente"*. El orden relativo de §3 se conserva; lo que se
retira es la apariencia de que `pendientes` lo respalda.

### A.6 — §3 presenta como decidido un fix que la fuente deja explícitamente abierto

La fila P1 de `CITY-LEDGER-REVERSE-ROUTE-GROUP-FREEZE-001` dice, en
*Bloquea*: *"Ninguna — es agregar `ESCAPE_ROUTES` a la cerca
existente"*.

`pendientes:184-186` deja ese punto sin resolver: *"No resuelto acá —
bloque aparte, con su propio diseño (**decidir si se extiende
`ESCAPE_ROUTES` a esta ruta o se crea una cerca nueva específica de
AND-composition**)"*.

La distinción es sustantiva: `POST /api/accounts-receivable/:id/reverse`
lleva **dos** `authorize()` encadenados
(`accounts-receivable.routes.ts:99-100` — `Roles.MANAGEMENT` +
`Roles.EMISOR_NOTA_CREDITO`), mientras que `ESCAPE_ROUTES` de
`credit-note-escape-containment.test.ts` congela **un** grupo por
ruta. Y el archivo sigue en `EXCLUDED_FILES` de
`rbac-matrix-section2-sync` (`pendientes:172`), lo que agrega un
artefacto más a sincronizar.

Debe leerse: *"Ninguna técnica — pero el diseño no está decidido:
extender `ESCAPE_ROUTES` (que hoy congela un grupo por ruta) o crear
una cerca nueva de AND-composition para los dos `authorize()`
encadenados. Requiere su propio bloque, como dice la fuente."*

### A.7 — §3 deja caer `D-16` y `D-20` sin declararlo

§3 se declara reemplazo, *"para efectos de por dónde arrancar"*, de la
lista de §13 de Fase 16. De las 25 decisiones `D-01`..`D-25`, este
documento **no menciona `D-16` ni `D-20` en ninguna línea**
(verificado por barrido de las 25).

Las dos son **P2** en Fase 16 §13 — la misma banda que ítems que el
plan sí incluye:

- `D-16` (`fase16:585`) — las cuatro formas de error 400 contra un
  solo parser; el usuario ve *"Error inesperado"* con los mensajes por
  campo presentes y sin leer.
- `D-20` (`fase16:587`) — ninguna llamada HTTP saliente tiene timeout
  y ningún pool tiene `statement_timeout`, **incluido el camino de
  login**.

La sección *"Lo que este orden NO incluye"* enumera solo omisiones del
lado `pendientes`, así que la ausencia queda invisible.

Debe agregarse a *"Lo que este orden NO incluye"*: *"…y **dos
decisiones de Fase 15 que este orden no prioriza y que siguen abiertas
en su documento de origen: `D-16` (cuatro formas de error 400) y
`D-20` (ninguna llamada saliente con timeout, ningún pool con
`statement_timeout`), ambas P2 en Fase 16 §13**."*

### A.8 — §5 generaliza de más: `credit_note_request` sí tiene contraparte de fase

§5 afirma que el trabajo de City Ledger, `credit_note_request` y la
auditoría transversal *"no tiene contraparte `F{N}-YY` en ningún
documento de fase"*. Medido sobre los 20 archivos
`docs/auditoria-integral-fase*.md`:

| Concepto | Coincidencias | Veredicto |
|---|---|---|
| `reverseTransfer` | **0** | §5 correcto |
| `CITY-LEDGER` | **0** | §5 correcto |
| `credit_note_request` | **14** | §5 incorrecto |

Las 14 no son menciones de pasada: Fase 10 aporta nueve, incluidas las
FK (`:466-467`, `:475`), la duplicación deliberada de
`reversed_invoice_id` (`:159`) y un hallazgo propio en
`sql.credit_note_request.repository.ts:147` (`:1020`); Fase 0 lo
registra en su alcance (`:24`, `:55`, `:59`); Fase 8 (`:419`); y Fase
16 mapea el flujo completo con su cerca (`:97`). Además, §1 de este
mismo plan documenta que `F5-01` (portal de clientes) sí tiene
contraparte de fase — lo que vuelve la frase internamente
inconsistente.

Debe leerse: *"El trabajo de City Ledger (`reverseTransfer()`, Bloques
3a/3b/3c) y la auditoría transversal de navegación son posteriores al
alcance que las Fases 0-14 relevaron: `reverseTransfer` y
`CITY-LEDGER` tienen **cero** coincidencias en los 20 documentos de
fase. **`credit_note_request` es la excepción y sí fue auditado** —
Fase 10 (FKs, duplicación declarada, y un hallazgo propio en
`sql.credit_note_request.repository.ts:147`), Fase 0 (alcance), Fase 8
y el mapa de Fase 16 §5. Para esa familia, buscar la contraparte de
fase antes de tratar `pendientes` como fuente única."*

### A.9 — Dos precisiones menores, sin cambio de conclusión

**(a) El conteo de líneas del Apéndice.** El punto 1 cita Fase 16 como
*"717 líneas"*; `wc -l docs/auditoria-integral-fase16-2026-09-16.md` →
**716**. (Fase 15 sí da 832, correcto.) Mismo modo de falla que la
Apéndice A.1 del propio Fase 16 ya registró para un `ls | wc -l`: un
conteo escrito antes de que el artefacto quedara fijo.

**(b) "Producción sigue en v52" es inferencia, no medición.** §2 lo
afirma como hecho. La fuente lo califica (`pendientes:883-888`):
*"Inferencia por git + `render.yaml` …, no una lectura directa de
`schema_migrations` — un `SELECT MAX(version) FROM schema_migrations`
de solo lectura contra las dos tenants la confirmaría como hecho
medido en vez de inferido"*. Dado que §2 es el argumento de mayor
consecuencia del documento (bloquea un push), la distinción
medido/inferido debe viajar con él: *"Producción sigue en v52
—inferido por git + `render.yaml`, no leído de `schema_migrations`—"*.
