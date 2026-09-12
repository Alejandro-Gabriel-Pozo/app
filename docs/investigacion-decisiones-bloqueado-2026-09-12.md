# Investigación de los 7 casos abiertos de "🔴 Bloqueado en una decisión del dueño" (12/09/2026)

Documento de REGISTRO de investigación — no autoriza ningún `CREATE TABLE`,
migración ni código. Cada implementación pasa por `criterios-negocio` +
`architecture-governor` aparte. Origen: pedido explícito del dueño
("Todo lo de Bloqueado en decisión del dueño... manda agentes x caso...
auditor por caso a los sistemas de referencia con niveles de abstracción
desde mecanismo a lógica").

Metodología: primero un `general-purpose` agent catalogó las ~1300 líneas
de la sección 🔴 de `pendientes-2026-09-12.md` y separó lo ya resuelto
(no migrado a `resuelto.md` todavía) de lo genuinamente abierto — 7 casos
reales (de un 8vo que se descartó tras verificación: el diseño concreto de
`CN-ESCAPE-ORPHAN-ADJUSTMENT-001` ya estaba cerrado en
`docs/diseno-salida-manual-nc-y-reapertura-b3-2026-09-12.md:301`, "0 de 10
ítems" abiertos). Para cada uno de los 7, un `auditor-circuitos-erp`
aparte verificó el hallazgo contra el código real y buscó grounding en
Nivel 1 (¿existe el patrón en los sistemas de referencia?) / Nivel 2
(¿cómo lo implementan exactamente?) contra Odoo, ERPNext/Frappe, Dolibarr,
Cloudbeds, QloApps y — donde aplicó — `frappe/hospitality`/`frappe/press`.

Convención de esta sesión: **lo que el grounding resuelve técnicamente**
se separa siempre de **el residuo que es decisión pura del dueño**.

---

## Caso 1 — A7.6: ¿dónde corre la purga del outbox?

**Ya decidido, no reabrir:** retención 90 días, solo eventos resueltos
(10/09/2026).

**Verificado:** no existe ningún mecanismo de purga en el repo hoy. Hay un
precedente de purga manual por endpoint (`DELETE /api/reports/occupancy/purge`,
`Roles.MANAGEMENT`) que el hallazgo original no había visto.

**Grounding:** Frappe/ERPNext, Odoo, Dolibarr y `frappe/press` purgan logs
por retención — unánimemente **fuera del proceso web, nunca en el build**.
Frappe usa exactamente 90 días de default para varios logs (coincidencia
con la decisión ya tomada, no causa). Render Cron Jobs no existe en el
plan free (requiere plan pago, ~$1/mes); el free web service se duerme a
los 15 min de inactividad.

**Recomendación técnica:** escribir la purga como función de dominio +
script standalone (reusa el patrón de `migrate-tenants.ts`, pero
fail-soft, no fail-loud) y exponerla en 2 disparadores sobre la MISMA
función: endpoint superadmin ya (costo cero, bajo `platform.routes.ts`)
+ `type: cron` en `render.yaml` cuando haya plan pago. Descarta un worker
in-process (spin-down del free tier = sin garantía de que corra nunca).

**Residuo del dueño:** ¿pagar el cron de Render ahora, o quedarse con el
endpoint manual por un tiempo? ¿Alcance por-tenant o global? ¿Canal de
aviso si un tenant falla en la corrida?

---

## Caso 2 — Doble comprobante: liberación de cargo tras `REJECTED`

**Verificado, corrige el hallazgo original:** el bloqueo NO es
incondicional. Si el usuario reintenta con el MISMO conjunto de cargos
(caso típico: corregir CUIT/punto de venta y reintentar), `retryExisting()`
ya lo maneja hoy sin bloqueo. El bloqueo real ocurre solo si el conjunto
de cargos cambia antes del reintento — y en ese caso, como el rechazo es
del LOTE consolidado entero, un cargo puede envenenar toda la facturación
futura de esa empresa, sin salida por UI.

**Hallazgo nuevo — la migración propuesta en pendientes no es implementable
tal como está escrita:** un índice parcial de Postgres no puede referenciar
`invoices.status` desde `invoice_charges` (tablas distintas). La forma
correcta, si se hace, es una columna de liberación
(`released_at`/`released_by_invoice_id`) + índice único condicionado a esa
columna — es la forma exacta de ERPNext (`consolidated_invoice = None`,
fila conservada).

**Grounding:** los 5 sistemas de referencia liberan el vínculo con un ACTO
HUMANO explícito sobre el documento — nunca automático por el evento
fiscal. Cero precedente de liberación automática.

**Recomendación técnica: NO migrar ahora.** Bloque 1 (0 DDL, ya): hacer el
atasco legible citando `resolveInvoiceLinkage()` en el mensaje de error.
Bloque 2 (con columna de liberación + acción explícita del usuario) solo
si aparece un caso real — medido: 0 filas de `invoice_charges` fuera de
`ISSUED` en las 2 tenants de producción hoy.

**Residuo del dueño:** tolerancia a intervención manual mientras tanto;
quién puede desvincular (rol — huele a `EMISOR_NOTA_CREDITO` o superior);
timing de la DDL respecto a `FACT-BORRADOR-001` (mismo guard, convendría
la misma ventana de deploy).

---

## Caso 3 — `checkOut()` ignora saldo `PENDING`

**Verificado — la asimetría es sistemática, no un caso de borde.** Cargos
del lado del debe (seña de saldo, ajustes de precio) nacen `PENDING` y
solo liquidan al completar la reserva; cobros nacen `SETTLED` directo. En
el flujo normal (check-out antes de completar), el guard casi nunca ve el
ítem de ingreso principal de la estadía. El mismo filtro rompe además el
camino legítimo de City Ledger (`transferStayBalanceToReceivable` también
lee solo `SETTLED`) y genera una inconsistencia en `getFolio()` (lista con
`PENDING`, saldo sin `PENDING`). No hay intención documentada — el único
test que ejercita el guard esquiva el camino real insertando el cargo ya
`SETTLED` a mano.

**Grounding:** ningún sistema de referencia trata un cargo ya posteado
como "no cuenta para el saldo de salida" — el rango real va de "advertir
y permitir con permiso" (Cloudbeds) a "bloquear salvo función explícita de
folio abierto" (Oracle OPERA, la referencia de industria). El concepto de
"pending que no bloquea" existe SOLO para holds de tarjeta y cargos no
devengados — ninguno de los dos es este caso.

**Recomendación técnica: es un bug, no una política.** El cálculo debería
incluir `PENDING` + `SETTLED` para `CHARGE`/`ADJUSTMENT`.

**Residuo del dueño (3 preguntas separadas):**
1. ¿Bloquear duro (como hoy, 409) o advertir + permitir con permiso
   (patrón Cloudbeds/OPERA)?
2. Si se incluye `PENDING`, cambia el comportamiento de City Ledger
   (empieza a transferir el monto correcto) — ¿aceptable?
3. ¿`getFolio()` debe mostrar un saldo consistente con la lista?

Este ítem merece ancla propia, no seguir como sub-bullet de
`ORDER-CONSOLIDATED-PARTIAL-01`.

---

## Caso 4 — Crédito mal atribuido tras escape NC en orden con estadía transferida

**Verificado, con precisión importante:** `transferStayBalanceToReceivable()`
OMITE `stayId` a propósito en el brazo de la empresa (si no, reabriría el
folio) — por eso el `ADJUSTMENT` del escape, que hereda `stayId`, no puede
alcanzar el lado de la empresa en el ledger. El puntero de vuelta SÍ
existe (`accounts_receivable.stay_id`, con `getByStayId()`) — lo que falta
no es el puntero, es la operación de reclasificación. Consecuencia real:
la empresa puede terminar facturada y cobrada por un cargo que fiscalmente
ya se anuló.

**Grounding — unánime en los 3 ERPs (Odoo, ERPNext, Dolibarr):** la nota
de crédito NUNCA cambia de tercero. La reasignación entre partes se hace
SIEMPRE con un segundo documento (Journal Entry / asiento manual), nunca
re-ejecutando la operación original ni reatribuyendo automático.

**Recomendación técnica:** (a) construir un mecanismo de reclasificación
explícito, disparado por el operador — no (b) intentar hacer
`transferStayBalanceToReceivable()` idempotente/re-ejecutable (no tiene
sentido: el problema no es correrla dos veces, es que falta un movimiento
contrario). Mitigación barata YA disponible, sin decisión de negocio:
exponer la AR existente (`getByStayId`) en la respuesta del escape cuando
haya una — hoy nadie se entera.

**Residuo del dueño:** volumen real (el caso hermano midió 0 filas en
ambos tenants — probablemente 0 acá también); si el operador ya lo corrige
a mano hoy; qué estados de AR cubrir (`PENDIENTE_FACTURAR` / `FACTURADO` /
`COBRADO` son 3 reglas distintas, no una).

---

## Caso 5 — `CN-VOID-COREJECT-STALE-TEST-001`

**Verificado — el test está stale en 2 direcciones, no 1.** El guard SÍ
consulta la clasificación hoy (contradice el título del test). Y como el
test corre el escape real antes de emitir el evento, la segunda
aserción también falla — Vitest corta en la primera, por eso solo se veía
el primer síntoma.

**Hallazgo decisivo:** con el signal actual (`TIPO_NO_LIQUIDABLE`,
agregado por candidato-set, no por fila), "seña viva" y "seña
cobrada-y-reembolsada" son LITERALMENTE indistinguibles — los dos
producen el mismo resultado. La opción B (distinguirlas en el allowlist)
no es implementable hoy sin reescribir el query para devolver detalle por
fila — sería el mismo bloque parkeado que ya existe para `CARGO_ANULADO`.

**Grounding:** los 3 ERPs de referencia NO llevan "vivo/reembolsado" como
estado del pago — lo reconstruyen desde el ledger de imputaciones (mismo
patrón que este repo ya usa en `classifyReservationLiveInvoice`).
Confirma que la distinción no debería vivir en el pago.

**Recomendación técnica: opción A (actualizar el test al comportamiento
nuevo)**, sin ambigüedad — coincide con el diseño ya aprobado, y la opción
B no es viable con el signal de hoy.

**Residuo del dueño:** correr el test actualizado contra Postgres real (no
verificado — el agente no tenía acceso a Bash); si existe en datos reales
el caso "seña reembolsada, cancelada después con NC" (query sugerida, sin
correr); decisión de producto separada — qué hace el sistema con un
`PAYMENT` vivo de una reserva cancelada con NC (saldo a favor / devolución
/ City Ledger) — hoy genera ruido en el log y nada más.

---

## Caso 6 — `1c-ii-b` C2(b): CHECK constraint `order_id`/`reservation_id`

**Corrección de ancla:** la tabla es `financial_transactions`, no
`credit_note_request`. La parte (a), fail-loud de aplicación, ya está
implementada y testeada. Es un guard de LECTURA (bloquea atribución), no
de escritura — no impide que la fila ambigua se cree, y otros lectores por
orden/reserva podrían doble-contarla sin enterarse.

**Grounding — corrige una cita previa del propio repo:** 3 de 4 sistemas
(Odoo, ERPNext, Dolibarr) NO usan CHECK de BD para exclusión mutua
polimórfica — solo validación de aplicación. La afirmación anterior de que
"Odoo lo cierra con CHECK real" estaba sobredicha: los CHECK reales de
Odoo en `account_move_line` son de importes/asiento, no de esta forma.
PERO este mismo repo ya tiene 2 precedentes internos: `chk_invoice_item_origin`
(mismo par conceptual, tabla hermana) y un CHECK agregado hace 4 días en
esta MISMA tabla — dejar esta asimetría es notable puertas adentro, aunque
no lo exija el estándar externo.

**Recomendación técnica: diferir, pero con destino asignado** — engancharlo
al próximo bloque que ya vaya a tocar `schema.sql`, reusando el patrón
`DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` ya usado en esta tabla (no
`NOT VALID`/`VALIDATE`, que no es el patrón idiomático de este repo). No
es urgente: los 2 creadores reales del sistema ya setean exactamente un
sujeto por construcción.

**Residuo del dueño:** tolerancia a abrir un deploy de schema ahora vs.
esperar al próximo bloque de mantenimiento; si es momento de mover los 3
CHECK de esta tabla a un `migrations/NNN_*.sql` numerado en vez de
reaplicar en cada deploy.

---

## Caso 7 — `credit_note_request` / `FACT-BORRADOR-001` §26.3 (5 preguntas + 2 vecinas)

**Ubicación confirmada:** `docs/diseno-factura-borrador-2026-08-31.md`
(v2.11, última revisión 12/09/2026). §26.3 tiene 5 filas, ninguna con ✅.

| # | Pregunta | Grounding | Recomendación técnica | Residuo del dueño |
|---|---|---|---|---|
| Q1 | Presupuesto de reintentos (salida de `ISSUED_PENDING_LEDGER`) | Ninguno externo — el caso (CAE sincrónico fuera de la tx de BD) no existe en Odoo/ERPNext. Grounding interno: `outbox.worker.ts` ya usa 60×5s + distingue error permanente/transitorio | Reusar 60×5s + la clasificación permanente/transitorio ya existente | El número; ¿por tenant o global? |
| Q2 | Quién ve la cola | Odoo/ERPNext tratan esto como permiso del módulo contable | **Partir en dos**: `DRAFT` → `FRONT_DESK` (precedente `GET /api/invoices/unreconciled`); `ISSUED_PENDING_LEDGER` → `MANAGEMENT` (precedente dead-letter del outbox) | Aceptar la partición; verificar que el preset `RECEPTIONIST` alcance |
| Q3 | Borradores abandonados | **3 de 3 (Odoo, ERPNext, Dolibarr) NO caducan solos.** El TTL de Odoo (1h) es de wizards efímeros, no de documentos — corrige el grounding previo citado en pendientes | Reportar por antigüedad, nunca `DELETE` (ya decidido en D3) | El umbral de días; si es por tenant |
| Q4 | Cliente dado de baja con borrador vivo | ERPNext bloquea duro (`disabled`) y hacia atrás también, pero tiene además `is_frozen` + rol de excepción. Odoo no invalida drafts existentes al archivar el partner | Bloquear la CREACIÓN nueva (no invalidar los ya creados) + advertencia visible al confirmar (hoy no hay ni eso) | ¿disabled duro o frozen-con-rol (y qué rol)? **Y una pregunta más urgente: hoy ya se factura a clientes inactivos sin ningún guard ni advertencia — verificar si es intencional, es un bug latente en producción, no solo del borrador** |
| Q5 | Cierre de caja con borradores pendientes | Odoo bloquea (con fricción documentada — hay módulos de terceros solo para evitar el bloqueo). ERPNext valida en la ENTRADA, no en el cierre | Advertir por `DRAFT`, no bloquear por `ISSUED_PENDING_LEDGER` — el cajero puede resolver lo primero, no lo segundo | Si la advertencia se persiste (auditable) o es solo visual; si `ISSUED_PENDING_LEDGER` al menos se muestra |

**2 preguntas vecinas encontradas de paso, no resueltas acá:**
- **§26.2** — el encuadre del que Q1/Q2 son sub-preguntas: la salida de
  `ISSUED_PENDING_LEDGER` en sí. El riesgo ya corre en producción hoy, sin
  borradores (`finalizeIssued()` solo loguea si falla).
- **§27.3** — destino de `POST /api/invoices` (ruta de un solo click):
  ¿sobrevive al borrador, se retira, se redirige? El propio documento la
  marca "no es mía ni del asistente resolverla" — decisión de negocio
  pura, sin propuesta.

---

## Decisiones del dueño (12/09/2026, vía `AskUserQuestion`)

- **Caso 1 (purga outbox):** endpoint manual superadmin ahora, sin cron de
  Render todavía.
- **Caso 2 (doble comprobante rechazado):** adelantar también el bloque 2
  (columna de liberación + acción explícita de desvincular), no esperar a
  que aparezca un caso real. Rol que puede desvincular:
  `EMISOR_NOTA_CREDITO` o superior.
- **Caso 3 (`checkOut()` ignora `PENDING`):** al corregir el cálculo para
  que incluya `PENDING`, el check-out **advierte y permite con permiso**
  (patrón Cloudbeds/OPERA) — no bloquea duro como hoy.
- **Caso 4 (crédito mal atribuido, AR):** construir el mecanismo completo
  de reclasificación ahora, no solo la mitigación barata de detección.
- **Caso 5, residuo (`PAYMENT` vivo tras cancelación con NC):** el fiscal
  (NC) y el flujo de dinero son caminos separados — textual del dueño:
  *"Quedaría crédito, solo si no se hace una devolución del dinero...
  Lo fiscal va x un lado el flujo de dinero x otro."* Lectura operativa:
  cancelar con NC resuelve el lado fiscal; el `PAYMENT` vivo pasa a
  crédito del cliente (cuenta corriente/City Ledger) POR DEFECTO —
  **excepto** si se emite una devolución real de dinero, en cuyo caso no
  se genera crédito (la plata ya volvió). Los dos caminos son mutuamente
  excluyentes para el mismo monto, no aditivos.
- **Caso 6 (CHECK constraint `order_id`/`reservation_id`):** ahora, bloque
  propio — no diferir al próximo bloque de schema.
- **Caso 7-Q1 (presupuesto de reintentos):** reusar 60×5s del outbox
  existente, alcance global (no por tenant).
- **Caso 7-Q2 (quién ve la cola):** partir en dos — `DRAFT` abandonado →
  `FRONT_DESK`; `ISSUED_PENDING_LEDGER` → `MANAGEMENT`.
- **Caso 7-Q3 (umbral de borrador "antiguo"):** 30 días.
- **Caso 7-Q4 (cliente inactivo con borrador):** intencional con
  salvedad — bloquear la CREACIÓN de un borrador/factura nueva para un
  cliente inactivo (con advertencia visible), pero NO invalidar los
  borradores ya existentes (patrón Odoo).
- **Caso 7-Q5 (advertencia en cierre de caja):** persistida, auditable —
  no solo visual.

- **§26.2 (encuadre de fondo — CAE real sin asentar en el ledger):**
  resolverlo ahora, junto con todo lo demás — no diferir a otra sesión.
  `finalizeIssued()` hoy solo loguea si falla, sin reintentar; esto ya
  corre en producción con o sin borradores.
- **§27.3 (destino de `POST /api/invoices`, ruta de un solo click):** se
  retira — todo pasa a través del circuito de borrador, un solo camino,
  no dos coexistiendo.

## Próximos pasos sugeridos (orden, no decisión)

1. Las recomendaciones técnicas de los 7 casos (1, 2, 3, 4, 5, 6, 7-Q1
   a Q5) no necesitan más grounding — lo que falta es que el dueño
   resuelva el residuo puntual de cada una.
2. Cualquier implementación pasa por su propio diseño + gate
   `architecture-governor` — este documento es solo el registro de
   investigación, no autoriza nada.
3. Limpieza de docs pendiente, aparte: sincronizar
   `docs/pendientes-2026-09-12.md` con este documento (hoy las 2 preguntas
   de doble comprobante del Caso 2 viven en la sección "Reclasificación de
   🔴", no en la sección "🔴 Bloqueado" donde alguien las buscaría).
