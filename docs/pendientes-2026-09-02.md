# Pendientes — Miércoles 2 de Septiembre 2026

Arrastra lo que seguía abierto en `pendientes-2026-09-01.md`. Los ítems
cerrados quedan allá marcados, no se repiten acá.

**Arrastre re-chequeado** según la regla de `CLAUDE.md` ("Pendientes —
revalidar antes de arrastrar"): las anclas de los ítems que cambiaron de
estado hoy, o que se cruzaron directamente contra `f6b24aa`, se
re-verificaron contra el código o el documento real; las del resto se
conservan sin re-verificar y se declara así explícitamente en cada bullet,
igual que hizo el archivo anterior.

**Reconciliación documental de esta sesión:** bloque separado, ejecutado
después de `f6b24aa` ("docs: registrar HOLD de diseño levantado"), con
autorización del dueño limitada a este archivo y a `pendientes-2026-09-01.md`.
No toca código, schema, permisos, D+A, Caja, ni el propio `f6b24aa`.

---

## Contexto de sesión (02/09/2026)

| Commit / evento | Qué |
|---|---|
| `f6b24aa` | HOLD de diseño levantado para `diseno-fiscal-profile-resolver-2026-09-01.md` y `vision-identidad-operativa-auditabilidad-2026-09-01.md`, HOLD de implementación explícitamente distinguido y vigente. Documental puro. Local, **sin push** — decisión pendiente aparte. |
| `architecture-governor`, 2 pasadas | Encontró y forzó corregir: autocontradicción en `indice-conocimiento.md`, ancla de línea rota en `mapa-companies-vs-locations-2026-09-01.md` (`:52`→`:58`), afirmaciones de `vision-...md §5` apoyadas en material sin versionar y sin marcar `[P]`, y una segunda vuelta que encontró `mapa-...md:121` todavía afirmando "siguen en HOLD" tras la primera corrección. |
| D+A — especificación final de Bloque 0 y contrato de Bloque 1a | Agente de diseño (`a7db571bf458f8e41`), 8 rondas de revisión auditora del dueño. Diff propuesto y criterios de aceptación completos para Bloque 0; contrato con invariantes en tres capas (estructural/transaccional/verificación) para Bloque 1a. **Ninguno de los dos autorizado a implementarse todavía.** Bloque 1b en HOLD, bloqueado por Gap C1-C (ver abajo). Ver §"Encontrado hoy" para el riesgo de continuidad de este trabajo. |

---

## 🔴 Abierto — encontrado hoy (02/09/2026)

**Precisión de alcance:** "encontrado hoy" significa **nuevo para este
inventario de pendientes**, no necesariamente nuevo para el sistema. Los
tres ítems de esta sección —la brecha de validación de `businessId`, el
corpus de auditoría sin versionar, la especificación de D+A sin
persistir— probablemente existían como deuda antes de esta sesión; lo que
pasó hoy es que se formalizaron con evidencia y quedaron registrados por
primera vez.

### FACT-INV-BIZID-001 — `requestInvoice()` nunca valida que el movimiento pertenezca al negocio del pedido

**Hallazgo del agente de diseño D+A, verificado por esta sesión con grep directo.**

`RequestInvoiceInput.businessId` existe como campo del input
(`app-main/src/facturacion/invoice.service.ts:72`) y se **reenvía** sin
validar hacia la factura que se crea, en las tres ramas de emisión (`:362`,
`:460`, `:649`). **En ningún punto de `requestInvoice()` se compara contra
el `businessId` real del `financial_transaction` que se está facturando** —
verificado con `grep -n businessId invoice.service.ts`, 5 ocurrencias
totales, ninguna es una comparación.

**Severidad preliminar: S1 candidata.** La falta de comparación entre el
`businessId` solicitado y el `businessId` real del movimiento es, por sí
sola, una brecha de validación de pertenencia/aislamiento de tenant en un
ERP multi-tenant — eso alcanza para registrar S1 sin esperar a resolver la
pregunta de explotabilidad. **Se eleva a S0 si se demuestra exposición
cross-tenant real** (que un usuario autenticado pueda facturar o acceder a
movimientos de un `businessId` que no es el suyo).

| Dimensión | Clasificación |
|---|---|
| Falta de comparación entre `businessId` solicitado y `businessId` real del movimiento | **[V]** — verificado con grep, 5 ocurrencias, ninguna compara |
| Existencia de exposición cross-tenant real | **[H]** — pendiente de probar contra la arquitectura de aislamiento y permisos |
| Severidad preliminar | **S1 candidata; eleva a S0 si se demuestra impacto cross-tenant** |
| Dependencia | Revisión del modelo `companies`/`locations` (`mapa-companies-vs-locations-2026-09-01.md`), aislamiento de tenant y autorización de facturación |
| Criterio de cierre | Prueba negativa que impida facturar un movimiento de otro `businessId`, más prueba positiva de que el `businessId` correcto sigue funcionando |

La pregunta abierta sobre `companies`/`locations` (si una misma BD puede
contener movimientos de más de un `businessId`) modifica el **impacto y la
explotabilidad**, no borra el riesgo ni justifica dejar la severidad sin
clasificar.

**Cruce de dependencias (regla permanente del dueño, ver
`docs/erp-auditoria-v2/` y las rondas de revisión D+A):**

| Relación | Con qué |
|---|---|
| Bloqueante | Ninguna todavía — es un hallazgo nuevo, no bloquea nada en curso |
| Precondición | De cerrar el Bloque 0 de D+A con el listón más alto: el diff propuesto de Bloque 0 (§1.1 de la especificación) ya prevé agregar esta guarda como parte de la elegibilidad fiscal, pero no está autorizado a implementarse |
| Dependencia informativa | El modelo `companies`/`locations` (`mapa-companies-vs-locations-2026-09-01.md`), que determina la explotabilidad real |
| Relacionada pero independiente | Ninguna |

**Requiere:** decisión del dueño sobre si amerita verificación urgente fuera
del ciclo normal de Bloque 0, o si espera a la autorización de ese bloque.

### AUDIT-DOC-001 — corpus de auditoría de completitud sin versionar, mismo riesgo que tenían los dos HOLD antes de `f6b24aa`

`docs/erp-auditoria-v2/` (21 fichas, 158 hallazgos, 431 anclas) y
`docs/programa-auditoria-completitud-erp-2026-09-01.md` (borrador v1.0,
**superado** por el v2 de `erp-auditoria-v2/00-programa-v2.md`) siguen
**sin `git add`, sin commit, sin seguimiento** — verificado con
`git status --short` en `app-main`, ambos como `??`.

Es el mismo tipo de riesgo de continuidad que tenían
`diseno-fiscal-profile-resolver-2026-09-01.md` y
`vision-identidad-operativa-auditabilidad-2026-09-01.md` antes de esta
sesión: si se pierde el disco local o el árbol de trabajo, este material —
que ya se está citando como fuente `[DA]` en las rondas de D+A — desaparece
sin dejar rastro en `origin/main`.

**Requiere:** decisión del dueño sobre versionarlo, en su propio bloque
documental separado (mismo patrón que `f6b24aa`: preflight, revisión de
`architecture-governor`, staging por ruta explícita, autorización de
commit y de push por separado). No es parte del alcance de esta
reconciliación.

### DA-CONT-001 — la especificación de D+A vive solo en conversación de agente, no en un documento versionado

Las 8 rondas de diseño y revisión de D+A (Bloque 0 completo, Bloque 1a
completo, clasificación de Gap C1-C, transición de idempotencia) no tienen
todavía ningún archivo propio en `docs/`. Existen únicamente en la
transcripción de esta sesión y en la memoria del agente de diseño.

**El riesgo es de continuidad y reproducibilidad, no de inexistencia
conceptual.** La especificación existe — es madura, pasó 8 rondas de
revisión auditora, y está citada con precisión en esta misma
reconciliación (Gap C1-C, CONTRACT-001, FACT-INV-BIZID-001 arriba). Lo que
falta es el soporte: un `git clone` limpio, una sesión nueva, o un agente
distinto no puede reconstruir ninguna de estas decisiones — a diferencia de
`diseno-fiscal-profile-resolver-2026-09-01.md` y
`vision-identidad-operativa-auditabilidad-2026-09-01.md`, que si algo salía
mal antes de `f6b24aa` existían al menos en el disco local. Esos dos ya son
fuentes válidas de contexto y decisiones previas, versionadas por
`f6b24aa`; el corpus de auditoría (`AUDIT-DOC-001`) y esta especificación
de D+A son una deuda documental **adicional y separada**, no una
invalidación de lo ya versionado.

**Requiere:** decisión del dueño sobre cuándo y cómo persistir esta
especificación (documento propio, o esperar a que el Bloque 0 se autorice y
documentar junto con la implementación). No se resuelve en esta
reconciliación — solo se registra para que no se pierda en silencio.

---

## 🔄 Actualizado hoy — el estado cambió

### FISCAL-CBTE-001 — reformulado: el HOLD del documento se dividió

El hallazgo de código **no cambió** — re-verificado hoy: `cbteTipo` sigue
fijo en `CBTE_TIPO_FACTURA_B` en los tres puntos de emisión
(`invoice.service.ts:368`, `:466`, `:540`; antes solo se citaban los dos
primeros).

**Lo que sí cambió es el estado del documento que lo analiza.**
`docs/diseno-fiscal-profile-resolver-2026-09-01.md` — antes: "análisis y
diseño, HOLD". Ahora, tras `f6b24aa`: **HOLD de diseño levantado; HOLD de
implementación vigente**, sujeto a autorización específica y separada. La
hipótesis `[H]` sobre `getIvaReceptorTypes()` sigue sin confirmar, sin
cambios — depende de un certificado ARCA real, no de esta reconciliación.

**Nota para evitar colisión futura:** el Bloque 0 de D+A también toca
`invoice.service.ts` (`requestInvoice()`), pero para un problema distinto
—elegibilidad por tipo/estado del movimiento, no selección de letra de
comprobante—. La especificación de D+A ya declaró esta restricción de
diseño explícitamente (guarda de entrada previa e independiente del
branching de comprobante) para no estorbar al resolver fiscal cuando ese
bloque se autorice.

### Gap C1-C — clasificación de dependencia agregada por D+A

Ancla re-verificada hoy: los dos `JOIN` (no `LEFT JOIN`) de
`sql.invoice.repository.ts:108` (`getOutstandingByCustomerId`) y `:133`
(`getByReservationId`) siguen descartando en silencio las facturas
consolidadas (`financial_transaction_id` nulo). Sin cambios de código.

**Lo que se agrega:** la especificación de D+A lo clasificó formalmente
como **precondición bloqueante del Bloque 1b** (no del Bloque 0 ni del
1a) — el Bloque 1b necesita agregar el término de restitución de saldo en
esas mismas líneas, y hacerlo sobre un `JOIN` que ya descarta filas
produciría una conciliación parcialmente correcta sin señal. **No entra al
alcance de D+A por estar conectado** — sigue siendo su propio pendiente,
con su propia autorización.

**Sin exposición hoy** — sin cambios: las 11 facturas de la base son de
homologación.

### CONTRACT-001 — nueva dependencia: precondición del paso 3 de idempotencia de D+A

Sin re-verificación de fondo hoy (no se tocó código de contrato/OpenAPI).
**Lo que se agrega:** D+A necesita descartar consumidores externos del
endpoint de cobro antes de autorizar el rechazo duro por falta de clave de
idempotencia (paso 3 de la transición, ver contexto de sesión). Sin
`CONTRACT-001` resuelto, ese paso no se puede autorizar — es la misma
brecha, con un consumidor concreto nuevo.

---

## 🔴 Abierto — arrastrado del 01/09

Detalle completo en `pendientes-2026-09-01.md`. Esta sección distingue dos
estados que **no son lo mismo** y no deben leerse como equivalentes:

### Re-verificados hoy, confirmados abiertos con evidencia fresca

- **DOC-ANCLA-001** — `docs/rbac-matriz-endpoints.md:9` sigue citando `src/tests/governance/rbac-matrix-sync.test.ts` (no existe); el archivo real está en `src/tests/security/` (línea 56 del mismo documento ya lo dice bien — la contradicción interna sigue sin resolver). Confirmado con `ls`/`grep` hoy.

*(`FISCAL-CBTE-001`, `Gap C1-C` y la mitad "hallazgo de código" de las secciones de arriba también fueron re-verificados hoy — están en "Actualizado hoy" para no duplicar la entrada.)*

### Arrastrados sin re-verificación — continuidad, no nueva evidencia

**No se inspeccionaron en esta ronda.** Su estado se conserva porque nadie
lo cerró ni lo tocó, no porque se haya vuelto a comprobar hoy. No leer esta
lista como "auditada de nuevo".

- **RBAC-SYNC-001** (mitad abierta) — nada verifica la sección 4 de la matriz contra `PUBLIC_ROUTES` del test.
- **RBAC-MOUNT-001** (mitad abierta) — ninguna cerca valida el orden de montaje de `src/app.ts`.
- **FACT-BORRADOR-001** — diseño de factura como borrador editable, v2.8, **en HOLD** — documento distinto (`diseno-factura-borrador-2026-08-31.md`), no tocado por `f6b24aa`, sin matices nuevos.
- **SEC-ROT-001** — `DB_ENCRYPTION_KEY` sin procedimiento de rotación.
- **RBAC-OWN-001** — ownership dentro de un tenant sin guard ni test negativo.
- **C3** — líneas de factura: falta backend **y** pantalla de detalle.
- **C1-Fase A** — CRUD de `deposit_policies`. Backend inexistente, 3 decisiones del dueño abiertas.
- **D7** — reportes POS/CRM: 2 paneles CRM libres, 3 POS condicionados a `useModuloVisible('POS_RESTAURANTE')`.
- **C2** — "Cancelar reserva" no usa el preview/confirm de reembolso.
- **Frontend visual:** SEM-001, SEM-002, TOAST-003, A11Y-001, 6 overlays de Superadmin. Última verificación al número de línea: 01/09, no hoy.
- **Backend/infra:** prueba E2E del Outbox (la corre el dueño), FAILOPEN-001.
- **Deuda activa:** rate plans no reutilizables entre servicios (`service_id NOT NULL` abierto), `resource_locks` sin categoría.
- **Heredados:** Redis rate-limit, BullMQ, etapas 2-3 de downgrade, C1-Fase B (bloqueada hasta que el negocio elija proveedor), datos demo en la base real.

### Sin arrastrar — requiere decisión del dueño antes de reescribirse

- **RBAC — mecanismos 1 y 2** — el propio archivo del 01/09 ya lo marcaba
  "⚠️ fila sin referente, requiere la memoria del dueño o se borra". Por la
  regla 1 de `CLAUDE.md` ("un ítem sin referente no se arrastra: se
  reescribe o se borra"), **no se copia a este archivo tal cual**. Queda
  pendiente que el dueño provea el referente (qué son los "mecanismos 1 y
  2") para reescribirlo, o confirme que se borra definitivamente.

### Histórico, no activo

- **D6 → D6-FRONTEND-001 → cerrado.** `D6` (línea original del 31/08, "UI
  pura, confirmado") quedó **superado/reemplazado** por `D6-FRONTEND-001` el
  01/09 al descubrirse que no era UI pura (brecha RBAC:
  `RECEPTIONIST` sin `MANAGEMENT`). `D6-FRONTEND-001` se cerró hoy con
  evidencia — ver el marcador ✅ RESUELTO (02/09/2026) in-place en
  `pendientes-2026-09-01.md`, sección "🔴 Abierto — encontrado hoy
  (01/09/2026)". **No es un pendiente activo**, pero la
  cadena de sustitución —motivo, sucesor, evidencia de cierre— se conserva
  acá a propósito: un ítem reemplazado no se deja huérfano.

---

## Nota de método

Esta reconciliación no volvió a auditar de punta a punta los 13 ítems
arrastrados del 31/08 vía `pendientes-2026-09-01.md` — eso es el trabajo de
`docs/erp-auditoria-v2/` (todavía sin versionar, ver `AUDIT-DOC-001`), no el
de un archivo de pendientes diario. Se re-verificaron con evidencia fresca
los ítems directamente cruzados contra `f6b24aa` y contra la especificación
de D+A de esta sesión; el resto se conserva con la misma disciplina que ya
usaba el archivo anterior — declarado, no asumido.
