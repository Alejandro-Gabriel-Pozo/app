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

## Plan de ejecución acordado — estado actualizado

Pasos 0, 3, 4, 5 ✅ resueltos (ver `plan-resolucion-bugs-deuda-2026-08-27.md`
para el detalle completo de cada uno, incluida la sesión de hoy). Siguen
abiertos, en el orden ya acordado: **1** (D8), **2** (D6), **6** (Gap C1-C),
**7** (C3), **8** (C1-A.2, cobrar seña), **9** (C2, reembolso), **10**
(C1-A.1, configurar seña — necesita las 4 decisiones de arriba), **11**
(pantalla de reasignación de mantenimiento).
