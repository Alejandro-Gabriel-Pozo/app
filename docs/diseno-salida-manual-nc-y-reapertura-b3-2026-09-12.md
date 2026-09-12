# Diseño — Salida manual para `CN-ESCAPE-ORPHAN-ADJUSTMENT-001` y reapertura de B3 (`credit_note_request`)

- **Versión:** v7.2 (12/09/2026) — **la doceava lectura del gate**
  (revisión de v7.1) **confirmó el hecho de código que sostiene el
  retiro de `NO_ITEMS`** (`AMOUNT_MISMATCH` nunca dispara con cero
  `invoice_items` de origen — verificado directamente en
  `refund-attribution.ts:242/249` e `invoice.service.ts:906/951`) **y
  aprobó CON CONDICIONES**: la propagación de v7.1 había dejado un
  bloque de §6.1 sin marcar (el hallazgo B3 — la precondición dura sobre
  `chk_invoice_item_origin` — seguía redactado en presente, sin banner de
  retiro, contradiciendo a §0/§9), más 3 defectos de texto menores: una
  referencia colgante en §6.1 a "pregunta nueva, ver §9" cuando esa
  pregunta ya está resuelta; un residuo en la misma sección que asumía
  que una línea sin origen podía llegar a persistir (ya no, bajo v7.0);
  y la cita "implementado en D8" del ítem 10 de §9, que debía decir
  "corte C3" (mismo desliz que §0 ya había corregido, sin propagar acá).
  Las cuatro aplicadas en esta versión, más dos recomendadas (marcar
  RESUELTO el ítem 9 en la tabla de autoridad de §9, y unificar el
  nombre del motivo — `AMOUNT_MISMATCH`, no `MISMATCH` a secas — en el
  bullet de `Origen`). El campo `Estado` se actualiza para reflejar las
  12 pasadas y la aprobación.
- **v7.1** — **propagación del retiro de
  `NO_ITEMS` (v7.0) a los puntos que la onceava lectura del gate**
  (agente `a95e373395c48d4ba`) **encontró desactualizados tras insertar
  §0.** Cinco secciones seguían asumiendo `NO_ITEMS` vivo o con
  referencias colgantes al ítem 10 retirado: §6.1 (nota puntero +
  reescritura de su lista "Lo que esto NO decide"), ítem 9 de §9 (nota
  puntero + conclusión reescrita: ya no queda pregunta de UX pendiente
  para el dueño), la tabla de partición de §9 (recalculada: 0 preguntas
  abiertas, ítem 10 pasa a su propio bucket "Retirado"), el párrafo de
  cierre de §9 (dice "retirado", ya no "delegado a `FACT-BORRADOR-001`")
  y el propio ítem 10 (su frase "nunca choca con `chk_invoice_item_origin`"
  quedaba sobre-general — corregida para aclarar que aplica a las líneas
  que la regla 1 precarga, no a cualquier línea que un operador agregue a
  mano). Más dos correcciones menores de §0 mismo: la cita "Nivel B (D8)"
  era un desliz — el bloque que consume el modelo Nivel A es C3, no D8
  (D8 implementó Nivel A); y faltaba nombrar el gatillo de reapertura del
  supuesto de negocio volátil del punto 2 (si un tenant demo existente se
  promoviera a producción en vez de recrearse desde cero). El campo
  `Estado` de este mismo bloque se actualiza para reflejar las 11
  pasadas y la pendiente. Pendiente una doceava pasada del gate sobre
  v7.1 antes de commitear.
- **v7.0** — **CAMBIO DE ALCANCE, no una corrección
  de texto.** El dueño confirmó explícitamente, vía `AskUserQuestion`, que
  TODOS los tenants existentes hoy son demo/descartables y ninguno pasa a
  producción — y como la migración Nivel A→B ya ocurrió, ningún tenant
  real futuro va a acumular facturas Nivel A. Con eso, `NO_ITEMS` — el
  motivo que las 10 rondas anteriores de gate (v1→v6.9) trataron como
  "dominante" — queda **retirado del alcance**: ver §0 (nuevo), que
  resume qué cambia en §3/§6/§7/§9-ítem-10 y por qué el resto del
  documento (v1→v6.9, sobre el alcance viejo) se conserva sin reescribir
  como registro histórico. El alcance vigente de acá en más es
  únicamente `AMOUNT_MISMATCH`.
- **v6.9** — el dueño planteó, antes de autorizar
  commit, si las facturas Nivel A del ítem 10 podían declararse fuera de
  alcance por ser "datos de Demo" — verificado que NO: `docs/diseno-facturacion-lineas-nivel-b-2026-08-23.md`
  confirma que Nivel A es un período histórico real y permanente, de
  CUALQUIER tenant ("sin reconstrucción retroactiva"), y la cifra "9 de
  11" es solo la población medida en la tenant `Demo`, no el alcance del
  problema. Con eso, el escenario "fuera de alcance" del dueño no aplica
  — `NO_ITEMS` es el motivo dominante que este documento habilita (§3), y
  excluirlo dejaría sin resolver la razón por la que
  `CN-ESCAPE-ORPHAN-ADJUSTMENT-001` existe. Ítem 10 corregido para
  decirlo así de explícito: bloqueado, no resuelto, no excluido —
  ninguna otra sección de este documento lo presenta como cerrado.
- **v6.8** — la décima lectura del gate (agente
  `a098df5000b062d83`) confirmó que el mecanismo de v6.7 es correcto en
  sus 4 puntos verificados, y encontró 2 defectos, los dos de texto: (1)
  la explicación del paralelo con Cloudbeds, agregada DESPUÉS de que esa
  lectura ya había arrancado, afirmaba sin calificar que "la separación
  tipo-folio ya existe estructuralmente" — cierto a nivel `financial_transactions`
  (ledger), pero falso a nivel línea para `NO_ITEMS` (esa factura no
  tiene `invoice_items`, nada que separar), contradiciendo sin querer la
  corrección de v6.7 sobre ese mismo motivo; (2) el campo `Estado` seguía
  diciendo "pendiente la sexta pasada" — la misma clase de dato volátil
  que ya se corrigió una vez en v6.1 y volvió a quedar viejo. Las dos
  corregidas acá. **Con las 4 verificaciones en limpio, la décima
  lectura declaró el diseño sustantivamente terminado** — lo que queda
  es la pregunta de UX del dueño en el ítem 9 y la dependencia externa
  de `FACT-BORRADOR-001` (ítem 10), las dos ya correctamente marcadas
  como fuera de este documento.
- **v6.7** — el gate (novena lectura, agente
  `aae122c846a82466c`) verificó el mecanismo de v6.6 contra el código
  real y encontró un solo hallazgo cargado: la regla 3 decía "una línea
  sin origen no consume cupo de nadie" citando el mecanismo que NO
  aplica a líneas de NC (`distributeGroupAmount()`, que solo lee la
  factura ORIGINAL); el tope real que hay que respetar acá
  (`getInFlightCreditNoteTotalForPairForUpdate()`, exigido por B2) no
  filtra por origen — una línea sin origen consume ese cupo igual,
  completo, lo cual es lo correcto (fail-closed) y no un hueco.
  Corregido, junto con: las reglas 1-2 solo alcanzan al motivo
  `AMOUNT_MISMATCH` (para `NO_ITEMS`, el dominante, no hay líneas de
  origen que precargar — el riesgo queda detrás del ítem 10, no
  resuelto acá); la regla 1 ancla mejor a `invoice.service.ts:909`
  (patrón YA implementado en la rama automática) que a Odoo; y las 3
  reglas se propagaron a la lista de requisitos de §6.1, donde antes
  solo vivían en §9.
- **v6.6** — grounding de `auditor-circuitos-erp`
  contra los 5 sistemas de referencia (pedido explícito del dueño, ítem
  9) devolvió mecanismo concreto: reusar la primitiva ya existente en
  este repo (`FrozenInvoiceItemShare.attributionKey`,
  `refund-attribution.ts`) como origen por línea, con prefill obligatorio
  filtrado al sujeto del ticket (Odoo/ERPNext) y rechazo explícito de
  líneas de otro sujeto (ERPNext) — Dolibarr, el único sin este
  mecanismo, confirmado como el modelo a NO copiar. Ítem 9 pasa de "sin
  propuesta" a "mecanismo propuesto, pendiente de confirmación del
  gate". Pendiente novena pasada antes de dar el documento por
  completo.
- **v6.5** — el dueño respondió 2 de las 3
  preguntas que quedaban abiertas tras v6.4: **ítem 1** (permiso) →
  un solo grupo `EMISOR_NOTA_CREDITO` de punta a punta, sin split D4 —
  la granularidad por acción queda para una iniciativa de RBAC más
  amplia, no para este flujo puntual; **ítem 8** (ventana de cancelación
  tardía) → sí, configurable por tenant (valor default y mecanismo
  quedan como bloque de implementación, sin gate todavía). **Ítem 9**
  (mezcla de sujetos) sigue abierto — el dueño pidió investigar si hay
  algo análogo en los sistemas de referencia antes de definir la UX;
  investigación en curso (`auditor-circuitos-erp`). Partición de §9
  recalculada: de 3 preguntas reales quedan 1.
- **v6.4** — **APROBADO CON CONDICIONES** por el
  gate (octava lectura, agente `ab3445135d21a326c`): re-verificó las 3
  citas de v6.3 de forma independiente (identidad AFIP + código 10048 en
  `referencia-afip-wsfev1.md:570-571`; §25.7/§25.8/§28.1 de
  `FACT-BORRADOR-001` línea por línea; `fiscal_treatment` ausente de
  `src/`, columnas reales de `products`/`bookable_services`/`resources`)
  — las 3 correctas — y encontró un solo defecto repetido 3 veces: el
  ítem 9, la conclusión de §9 y la etiqueta de la tabla de partición
  todavía llamaban "resuelta"/"sin preferencia de negocio" al ítem 6
  como si fuera 2/4, contradiciendo su propio encabezado "resolución
  CONDICIONAL, no cerrada". Corregidas las 3 menciones en esta versión.
  Con esto, **listo para el dueño en las preguntas 1, 8 y 9** — las
  únicas que el gate confirma como genuinamente sustantivas tras 8
  rondas, no pulido de forma.
- **v6.3** — el gate (séptima lectura, agente
  `ad9a10067c60af997`) encontró que v6.2 cerró el ítem 6 de más:
  investigó contra una búsqueda web bloqueada/indirecta en vez de
  contra `docs/referencia-afip-wsfev1.md` (ya citado por este mismo
  documento y verificado ahora sí, directamente, contra ese archivo) —
  mismo patrón que ya causó 2 rondas de HOLD antes. Verificado en esta
  versión: la identidad de `ImpTotConc`/`ImpOpEx`/`ImpIVA` es real pero
  **no** es el error 10048 (ese código es "Bienes Usados-Monotributista",
  no aplica acá); y "la línea hereda el `fiscal_treatment` del catálogo"
  contradecía `FACT-BORRADOR-001` §25.7 vigente ("una línea `MANUAL` no
  hereda nada: elige") — `fiscal_treatment` además no existe en `src/`
  hoy. Ítem 6 reabierto como resolución CONDICIONAL: la ecuación sigue
  sin ser configurable por nadie, pero la clasificación por línea la
  elige el operador/contador caso por caso (no hereda de un catálogo que
  no tiene ese dato) — igual queda fuera de la mesa del dueño, pero por
  una razón distinta y más acotada que v6.2. Aritmética de §9 rehecha
  como partición de 5 grupos (antes sumaba de más). Pendiente octava
  pasada del gate.
- **v6.2** — sobre v6.1, investigación directa
  contra fuentes de AFIP/ARCA (manual WSFEv1, errores reales reportados
  contra `ingadhoc/odoo-argentina`, `afipsdk.com` — no contra
  `afipts.com`, bloqueado por el proxy de este entorno) resolvió el
  ítem 6 de §9 (`EXENTO`/`NO_GRAVADO` en línea manual), que hasta acá
  se trataba como pregunta del dueño. Hallazgo: no hay margen de
  decisión de negocio ahí en ningún nivel — la ecuación
  `ImpTotal = ImpTotConc + ImpNeto + ImpOpEx + ImpTrib + ImpIVA` es fija
  y universal (error AFIP 10048 si no cierra), y la clasificación fiscal
  de cada línea la hereda del `fiscal_treatment` ya asignado al
  producto/servicio en el catálogo (§25.2), no la reinventa un operador
  al completar una NC. Reclasificado de "pregunta del dueño" a
  "resuelto — requisito de implementación", con un residuo acotado
  (líneas `NO_ITEMS` sin origen de catálogo, juicio contable puntual, ya
  cubierto por el permiso del ítem 1). Reduce las preguntas reales para
  el dueño de 4 a 3 (1, 8, 9). Pendiente confirmación de esta
  investigación en la próxima pasada del gate antes de presentarse al
  dueño.
- **v6.1** — **APROBADO CON CONDICIONES** por el
  gate `architecture-governor` (sexta lectura, agente
  `a69ccbea9af0e2902`), las 6 aplicadas en esa versión (texto
  solamente, sin contenido de diseño nuevo): (1) la aritmética de §9
  ("11 de 10 filas") corregida a un solo conteo consistente; (2) los dos
  párrafos que se contradecían sobre cuántos ítems quedaron resueltos,
  reconciliados; (3) el motivo dado para descartar la opción (b) del
  ítem 2 era falso (decía que rompía callers de backend —
  `CancelOrderWithCreditNoteResult` tiene CERO importadores fuera de su
  archivo, verificado) — reemplazado por el motivo real; (4) agregado un
  requisito nuevo no opcional al ítem 2: sin un `case` para la excepción
  nueva en `domainErrorStatus()`, el escalado a revisión manual se
  presentaría como 500 genérico, no como el resultado que este documento
  busca; (5) el ítem 2 solo nombraba el tipo de resultado de órdenes —
  agregado el de reservas, misma forma; (6) el campo `Estado` del
  encabezado seguía diciendo "pendiente quinta pasada" cuando la quinta
  ya había aprobado v5.1. Sobre la base v5.1, **aprobada por el
  gate**, el responsable del proyecto clasificó §9 por AUTORIDAD DE
  DECISIÓN (qué preguntas son del dueño del negocio, cuáles del
  responsable fiscal + ARCA, cuáles internas del equipo técnico) y fijó
  una regla transversal: una política de negocio es CANDIDATA a hacerse
  configurable POR TENANT en vez de hardcodeada como default global —
  pero ninguna configuración de tenant puede relajar un invariante
  fiscal, de autorización, idempotencia o integridad. Aplicado desde v6:
  el ítem 2 de §9 (forma del resultado del escalado) se resolvió
  directamente — es arquitectura interna, no una decisión de negocio, y
  ya no llega al dueño; los ítems 1, 6 y 8 se marcaron como candidatos a
  política configurable por tenant (alcance nuevo, no diseñado en
  detalle, declarado en cada ítem — el ítem 1, en particular, puede no
  necesitar mecanismo nuevo, ver corrección v6.1 ahí); el ítem 9 se cerró
  explícitamente
  como invariante NUNCA configurable, sin excepción de tenant.
- **v5.1** — **APROBADO para revisión del dueño**
  por el gate `architecture-governor` (quinta lectura, agente
  `a226ae15b90c6d5e1`), con 2 condiciones de texto aplicadas en esa
  versión (sin contenido de diseño nuevo): (C1) §6.1/§9 citaban mal
  la query del hallazgo B4 — `getInFlightCreditNoteTotalForPairForUpdate`
  no tiene "par de reservas" (ya generalizada, 1c-ii-a) y filtra por FT
  revertidora, no por origen de línea — el riesgo real está en
  `getIssuedCreditNoteCompensationTotalForReservation()`/`...ForOrder()`,
  corregido; (C2) §4 nombraba una columna
  (`reversed_financial_transaction_id`) que no existe en ningún lado del
  repo ni en la DDL de §6 — corregido a `financial_transaction_id`, la
  columna real. Más 3 precisiones menores recomendadas por la misma
  lectura (conteo de preguntas de §9, la salida "editable" de
  `EMISIÓN_FALLIDA` que en realidad tiene dos ramas distintas, y que las
  dos salidas previas de `FACT-BORRADOR-001` para `chk_invoice_item_origin`
  ya están cerradas). Cuatro rondas de HOLD previas del gate
  `architecture-governor` ya corregidas in-place (marcadas "Corrección
  post-gate" en cada sección que tocan, nunca reescribiendo el documento
  entero):
  - **v1→v2** (agente `ac7b299150a0ebb8c`): 3 citas incorrectas contra el
    código real (§3/§7 re-derivaban en prosa un conjunto que ya tiene
    dueño mecánico en `build-credit-note-throw-catalog.test.ts`; §6
    citaba SQL retirado de `FACT-BORRADOR-001`; §8 asumía una cobertura
    de permisos que no existe para la ruta nueva) y 2 fences no
    anticipadas (`credit-note-escape-containment.test.ts` aserción D no
    cubre el paso nuevo; `REVERSED-INVOICE-ID-CONVENTION-001` habría
    colisionado con el nombre de columna de la v1, ya evitado por el
    renombre a `associated_invoice_id`).
  - **v2→v3** (agente `af45d825fb017a7dd`): verificó los 10 fixes de v2
    contra el código vivo (todos correctos) y encontró 2 defectos NUEVOS,
    creados por la interacción de esos mismos fixes — §5 y §6 se
    contradecían sobre cuándo `discarded_at` era escribible, y esa
    contradicción combinada con el `UNIQUE` nuevo podía re-crear el
    `ADJUSTMENT` huérfano original bajo descartar+reintentar — más un
    hallazgo bloqueante que ninguna ronda anterior había ubicado: nada
    asignaba dueño al tx2 del escape (cancelar la entidad, settlear
    cargos) cuando la NC se completa a mano, y `frozenChargeIds` no
    tenía dónde persistirse para ese caso (§7.1, nuevo).
  - **v3→v4** (agente `a0ae4c561708bdf70`): verificó N1-N9 de la ronda
    anterior (todos correctos) y encontró que §7.1 —creado para cerrar el
    hallazgo previo— repetía el mismo patrón un nivel más abajo: describía
    solo la mitad de órdenes del tx2 y generalizaba desde ahí, sin la
    clase de error propia de reservas
    (`CreditNoteIssuedReservationNotCancellableError`), su guard adicional
    (`CreditNoteReservationInvoiceSetChangedError`) ni su orden de lock —
    y expuso una pregunta que ninguna ronda anterior había hecho:
    ¿un borrador `CREDIT_NOTE` se liga al ledger igual que uno
    `SALES_INVOICE` (INSERT de `CHARGE`, `FACT-BORRADOR-001` §23.4/§23.5),
    o distinto? Sin responderla, el disparador de §7.1 era circular
    (`ISSUED` no puede disparar lo que produce `ISSUED`), el diagrama de
    §5 contradecía los estados reales de `FACT-BORRADOR-001`, y la
    respuesta de §2 a la objeción 3 ("el ticket no toca N5") quedaba sin
    verificar contra los 5 call sites reales de `NC_LINKAGE_UNION`. Los
    tres, mas la disparidad de §7.1, resueltos en el nuevo §6.1 y en la
    reescritura de §7.1.
  - **v4→v5** (cuarta lectura): 4 hallazgos bloqueantes, todos dentro de
    lo escrito en la ronda anterior (§2/§6.1/§7.1) — (B1) v4 reintrodujo,
    un nivel más abajo, el mismo error de v3: un edge
    `EMITIDA_PENDIENTE_LEDGER → BLOQUEADA` que `FACT-BORRADOR-001` no
    tiene; corregido, el paso de ledger que falla deja el borrador en
    `EMITIDA_PENDIENTE_LEDGER`, reintentado idempotentemente, nunca
    bloqueado. (B2) el método que §6.1 dice reutilizar
    (`createWithClient()`) no ejecuta los topes de NC (viven en
    `buildCreditNote()`, que este flujo NO reutiliza) — declarado como
    requisito nuevo, no opcional. (B3) el motivo dominante `NO_ITEMS`
    produce líneas sin origen, y el CHECK real
    (`chk_invoice_item_origin`) exige exactamente uno — colisión que
    `FACT-BORRADOR-001` ya declara sin resolver, ahora nombrada acá como
    precondición dura. (B4) nada impide que una edición manual mezcle
    sujetos en una NC contra una consolidada, exactamente la "5ta rama"
    que dos de las 5 queries de `NC_LINKAGE_UNION` advierten que
    quedaría fail-open — pregunta nueva para el dueño. Más 5 hallazgos
    menores (M1-M5): falta una rama nueva en `requestInvoice()` (la
    clave de idempotencia sola no alcanza); `retryExisting()` reusa el
    payload AFIP persistido, no uno recalculado desde el borrador
    editado; el tx2 de órdenes no tiene guard de re-verificación
    (residual aceptado, no cerrado); "toda falla → BLOQUEADA" no
    reflejaba el conjunto real de salidas de los puertos (`YA_ESTABA` es
    éxito); y los dos punteros ticket↔borrador de §6 no son la misma
    relación contada dos veces (cardinalidades distintas), aclarado.
- **Estado:** **propuesta de diseño, NO aprobada, NO implementada.** No se
  escribió código, no se creó ninguna tabla, no se escribió ninguna
  migración. Doce pasadas del gate `architecture-governor` (v1→v7.2). La
  onceava (agente `a95e373395c48d4ba`) aprobó con condiciones el retiro
  de `NO_ITEMS` de v7.0 (§0) y pidió propagar ese retiro a §6.1/§9 —
  aplicado en v7.1. La doceava (revisión de v7.1) confirmó el hecho de
  código que sostiene el retiro (`AMOUNT_MISMATCH` nunca dispara con cero
  `invoice_items` de origen — verificado en `refund-attribution.ts:242/249`/
  `invoice.service.ts:906/951`) y aprobó CON CONDICIONES: la propagación
  de v7.1 había dejado un bloque de §6.1 sin marcar (el hallazgo B3, la
  precondición dura sobre `chk_invoice_item_origin`, seguía redactado en
  presente sin banner de retiro) y 3 correcciones de texto menores (una
  referencia colgante a "pregunta nueva, ver §9" ya resuelta, un residuo
  sobre líneas sin origen que ya no deberían llegar a persistir, y la
  cita "implementado en D8" del ítem 10, que debía decir "corte C3" —
  mismo desliz que §0 ya había corregido sin propagar acá). Las cuatro
  aplicadas en v7.2, más dos recomendadas (RESUELTO explícito en la fila
  del ítem 9 de la tabla de autoridad, y `AMOUNT_MISMATCH` en vez de
  `MISMATCH` a secas en el bullet de `Origen`). Con eso, **no queda
  ninguna pregunta abierta para el dueño** (partición de §9: 0 de 10
  ítems) y **no queda ninguna sección con un residuo de `NO_ITEMS` sin
  marcar retirado**. Sigue bloqueado por UNA precondición externa real
  (ítem 3 de §9 — secuenciación detrás de la cadena de HOLD de
  `invoice_drafts` en `FACT-BORRADOR-001`, no una
  pregunta de nadie). Con la doceava lectura aprobando estas correcciones
  como el único requisito pendiente, **este documento queda listo para
  commit docs-only** — sujeto siempre a la autorización explícita del
  dueño para el commit en sí (nunca inferida del stop-hook).
- **Método:** `docs/DECISION_REVIEW.md` — toca datos fiscales (Nota de
  Crédito, AFIP/ARCA) y reabre una decisión de gate previa (B3, gate 2.2,
  08/09/2026).
- **Origen:** `CN-ESCAPE-ORPHAN-ADJUSTMENT-001` (`docs/pendientes-2026-09-10.md`,
  hallazgo del gate `architecture-governor` al cerrar 1c-ii-c, 11/09/2026) —
  un `ADJUSTMENT` puede quedar `PENDING` para siempre si
  `InvoiceService.buildCreditNote()` tira un error determinístico después de
  que la transacción del orquestador ya commiteó. Grounding
  `auditor-circuitos-erp` (11/09/2026, unánime en 5 sistemas): ninguno
  bloquea con un error terminal — todos dejan un documento en borrador que
  un humano completa. Decisiones del dueño tomadas en la sesión que originó
  este documento (12/09/2026): (1) la salida manual se habilita SOLO para
  los motivos `NO_ITEMS` (factura Nivel A) y `AMOUNT_MISMATCH` (el monto
  no cierra) — no para `SUBJECT_NOT_IN_INVOICE`/`MISSING_FROZEN_IVA_ENTRY`,
  que siguen rechazando duro por oler a bug de datos [**RETIRADO en v7.0,
  ver §0 — `NO_ITEMS` salió del alcance; queda solo `AMOUNT_MISMATCH`**]; (2) la edición es
  línea por línea (Odoo/ERPNext), no un monto único con tope (QloApps); (3)
  comparte infraestructura con `FACT-BORRADOR-001` (documento editable) en
  vez de un mecanismo propio aislado; (4) esto reabre B3 (`credit_note_request`,
  HOLD desde el gate 2.2 del 08/09/2026) en vez de dejarlo aparte.
- **Documentos que este reconcilia, sin reabrir sus decisiones ya tomadas
  salvo donde se dice explícitamente:**
  - `docs/diseno-factura-borrador-2026-08-31.md` (`FACT-BORRADOR-001`, v2.10)
    — el mecanismo de documento editable (`invoice_drafts`), hoy acotado a
    factura de venta inicial. Este documento propone generalizarlo, NO
    reescribe ninguna de sus 6 decisiones (D1-D6) ni su máquina de estados.
  - `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` (ADR
    común cancelar-con-NC) — §6.5 recomienda una fila-solicitud
    `credit_note_request` al estilo `OrderReturn` de QloApps para N11+N12+B3;
    el gate 2.2 la puso en HOLD con 4 objeciones concretas y 3 "gatillos de
    reapertura". Este documento argumenta que el gatillo 1 ya se cumple (ver
    §2) y responde una por una las 4 objeciones (ver §2 también).
  - `docs/pendientes-2026-09-10.md` — bloque `CN-ESCAPE-ORPHAN-ADJUSTMENT-001`
    y la cerca `BUILD-CREDIT-NOTE-THROW-CATALOG-001` (fuente de verdad de
    qué throws de `buildCreditNote()` son determinísticos).
- **Etiquetas:** `facturacion` `afip` `documento` `borrador` `workflow`
  `permisos` `transversal`

---

## 0. Retiro de `NO_ITEMS` del alcance (v7.0, 12/09/2026) — leer esto primero

**Decisión del dueño, confirmada explícitamente vía `AskUserQuestion`
(12/09/2026): `NO_ITEMS` (facturas Nivel A) queda RETIRADO del alcance de
este documento.** Motivo, en dos pasos verificados:

1. **Hecho de código, verificado contra
   `docs/diseno-facturacion-lineas-nivel-b-2026-08-23.md`:** "Nivel A" no
   es una etiqueta de la tenant `Demo` — es un período histórico real,
   cerrado por la migración de facturación por líneas ("Nivel B", C3,
   que consume el modelo Nivel A ya implementado antes): toda factura
   emitida DESPUÉS de esa migración tiene `invoice_items` reales; ninguna
   factura emitida ANTES los tiene, "sin reconstrucción retroactiva",
   para cualquier tenant que existiera en ese momento.
2. **Hecho de negocio, confirmado por el dueño, no verificable desde el
   código:** **todos los tenants que existen hoy son demo/descartables
   — ninguno se convierte en cliente de producción.** Como la migración a
   Nivel B ya pasó, cualquier tenant real que se dé de alta de acá en
   adelante nace directamente en Nivel B — nunca va a acumular facturas
   Nivel A. Con los dos hechos juntos: `NO_ITEMS` no es un caso que un
   cliente real vaya a encontrar nunca. Excluirlo no dispensa un
   problema real sin resolver — dispensa uno que no va a existir.

   **Supuesto y gatillo de revisión (corrección post-gate, onceava
   lectura) — el punto 2 es un hecho de negocio volátil, no verificable
   desde el código, y este retiro entero se apoya en él.** Si alguna vez
   un tenant de los que existen hoy se PROMUEVE a cliente de producción
   (en vez de recrearse desde cero como cliente nuevo), sus facturas
   Nivel A viajan con él y `NO_ITEMS` vuelve a ser un caso real — nada en
   este documento lo va a detectar solo. Gatillo de reapertura: cualquier
   decisión de "promover tenant demo a producción" tiene que re-chequear
   este §0 antes de ejecutarse.

**Qué cambia, concretamente, respecto de las 10 rondas de gate previas
(v1→v6.9, todas sobre un alcance que incluía `NO_ITEMS`):**

- **§3** — el alcance queda acotado a `AMOUNT_MISMATCH` únicamente.
  `CreditNoteAttributionBlockedError` (con cualquiera de sus 3 razones,
  `NO_ITEMS` incluida) queda enteramente fuera — **ya no hace falta** el
  prerrequisito de agregarle un campo `reason` legible (§3 lo pedía
  solo para filtrar `NO_ITEMS`). `OrderInvoiceHasNoLinesError` (rama
  heredada) también queda fuera.
- **Riesgo residual, recalculado:** de los 6 throws `DETERMINISTIC` del
  catálogo, esta salida manual cubre **1** (`CreditNoteAttributionMismatchError`),
  no 3. Los otros 5 (`InvoiceNotReversibleError`,
  `CreditNoteAmbiguousSubjectError`, `CreditNoteAttributionBlockedError`
  completo, `OrderInvoiceHasNoLinesError`, el `Error` genérico) siguen
  produciendo un `ADJUSTMENT` huérfano sin ticket — aceptado, no de este
  documento.
- **§6** — la tabla de mapeo `reason`→origen pierde la fila `NO_ITEMS`;
  el `CHECK` de `credit_note_request.reason` queda con un solo valor
  habilitado (`AMOUNT_MISMATCH`).
- **§7** — el `catch` de los dos orquestadores se simplifica: atrapa
  ÚNICAMENTE `CreditNoteAttributionMismatchError`, sin condición. Ya no
  atrapa `OrderInvoiceHasNoLinesError` ni `CreditNoteAttributionBlockedError`
  (con ningún `reason`).
- **Ítem 10 de §9** (la precondición dura de `chk_invoice_item_origin`)
  **queda RETIRADO — no es más un bloqueo de este documento.** Sigue
  siendo un problema real de `FACT-BORRADOR-001` para su propio caso
  (borradores de factura de venta con línea `MANUAL`), pero deja de
  condicionar esta salida manual de NC.
- **Ítem 9 de §9** — pierde el residuo "para `NO_ITEMS` sigue sin
  resolver": con un solo motivo habilitado (`AMOUNT_MISMATCH`, que
  siempre tiene `invoice_items` de origen), las reglas ya propuestas
  aplican sin excepción, no condicionadas por motivo.

**Lo que NO se toca:** las secciones §1-§9 de abajo, tal como quedaron
en v6.9, se conservan como registro histórico de cómo se llegó a este
alcance más chico — no se reescriben ni se borran (regla de este mismo
repo: corregir hacia adelante, no reescribir). Donde dicen "`NO_ITEMS`
es el motivo dominante" o describen su mecanismo, léase en pasado: así
era el alcance hasta v6.9, antes de este retiro. Este §0 es la fuente de
verdad vigente; el resto es el camino que llevó hasta acá.

---

## 1. Por qué este documento existe y no dos parches separados

Encarar la salida manual sin leer primero si ya existía diseño para esto
habría repetido el error que ya está registrado en
`docs/diseno-factura-borrador-confirmar-2026-09-11.md` (retirado por
exactamente esa razón). Búsqueda hecha antes de proponer nada: existen DOS
piezas de diseño previo, no relacionadas entre sí hasta ahora:

1. **`FACT-BORRADOR-001`** — el "documento editable antes de confirmar",
   explícitamente **fuera de alcance para la Nota de Crédito** (§22:
   *"No cambia la Nota de Crédito. Sigue siendo el único camino de
   corrección después de emitida. El borrador cubre el antes; no
   compiten."* — cita textual, corregida post-gate v4→v5, la versión
   anterior parafraseaba entre comillas). Resuelve el **contenido**
   (líneas, montos, IVA) de un documento que un humano arma o completa a
   mano.
2. **B3 / `credit_note_request`** — la fila-solicitud recomendada en el
   ADR común para el caso "NC atascada, visibilidad + resolución humana",
   HOLD desde el gate 2.2. Resuelve el **ticket** (dónde vive, quién lo ve,
   cuándo se resuelve) — no el contenido.

Los dos hacían falta para cerrar `CN-ESCAPE-ORPHAN-ADJUSTMENT-001`: sin
ticket, nadie encuentra el `ADJUSTMENT` atascado para completarlo; sin
documento editable, encontrarlo no alcanza para resolverlo. Este documento
los une, sin reabrir lo que cada uno ya decidió salvo lo señalado en §2 y §6.

---

## 2. Por qué B3 se reabre ahora — respondiendo, una por una, las objeciones del gate 2.2

El gate 2.2 (08/09/2026) no rechazó el diseño de `credit_note_request` en
abstracto — rechazó construirlo **para el caso que existía entonces**
(NC `FAILED_UNCERTAIN`, AFIP no contestó). Ese caso sigue teniendo las
mismas objeciones, sin cambios. El caso NUEVO (`CN-ESCAPE-ORPHAN-ADJUSTMENT-001`)
es estructuralmente distinto en el punto exacto que sostenía la objeción
principal. Repaso objeción por objeción:

**Objeción 1 — "`state` sería una PROYECCIÓN de `invoices.status`, dos
filas contando el mismo hecho."** Cierta para el caso AFIP-incierto: ahí
siempre existe una fila `invoices` (`PENDING`/`FAILED_UNCERTAIN`) que es
la fuente de verdad real. **Falsa para el caso nuevo:** cuando
`buildCreditNote()` tira `OrderInvoiceHasNoLinesError`/
`CreditNoteAttributionMismatchError`, la excepción ocurre **antes** de
`InvoiceRepository.createWithClient()` — verificado, ver
`BUILD-CREDIT-NOTE-THROW-CATALOG-001`. **No existe ninguna fila `invoices`
que proyectar.** El ticket no puede ser una proyección de algo que no
existe — es, en este caso, el ÚNICO registro de que hay una tarea humana
pendiente. Un mismo mecanismo puede servir a los dos casos si el ticket
sabe distinguir "tengo una `invoices` vinculada, mi estado sigue la de
ella" de "no tengo ninguna, mi estado es autoritativo" (ver §5).

**Objeción 2 — "`resolved_by` no tiene consumidor real hoy."** Dejaba de
ser cierta el día que se construya un flujo real de reconciliación manual
— y **ese es exactamente lo que este documento propone construir** (la
edición línea por línea de la NC). Coincide, sin buscarlo a propósito, con
el **gatillo de reapertura #1** que el propio gate 2.2 dejó escrito:
*"Existe un flujo real de reconciliación manual de `FAILED_UNCERTAIN`
(consumidor real de `resolved_by`)"* — el flujo que se construye acá no es
exactamente ESE (es sobre atribución fallida, no sobre AFIP incierto), pero
es la misma clase de flujo y el mismo consumidor real que la condición
pedía. **Precisión post-gate: el gatillo nombra un consumidor de la
columna `resolved_by`, y el `credit_note_request` de §6 no tiene esa
columna** — lo que este documento satisface es la MITAD "flujo real de
reconciliación manual" del gatillo, no la columna en sí (ver §5 para por
qué se sustituye por auditoría de campo en vez de agregarla). **Los otros
dos gatillos (pool mixto con fan-out automático, portal de clientes
creando solicitudes) siguen sin activarse — no son parte de este
documento.**

**Objeción 3 — "el índice único parcial rompe pool mixto y no cierra N5
de todos modos."** Sigue siendo cierta y sigue vigente: este documento **no
propone** ningún índice único sobre `(entity_type, entity_id)` ni sobre
`(reversed_invoice_id)`. **Precisión post-gate (tercera lectura) — "el
ticket nuevo no lo toca ni lo duplica" era una afirmación sin verificar
contra el mecanismo real de N5.** El tope lo hacen cumplir 5 queries que
se unen contra `NC_LINKAGE_UNION` (`sql.invoice.repository.ts`) — un JOIN
mantenido A MANO, no por tipo, que el propio archivo advierte que hay que
extender si aparece un tercer camino de vinculación. La razón por la que
el ticket efectivamente NO lo toca no es que sea irrelevante — es que la
NC que termina emitiéndose sigue vinculándose EXACTAMENTE por el mismo
camino que hoy (`invoices.financial_transaction_id`), nunca por
`invoice_draft_id` — eso es una decisión explícita, no una consecuencia
automática de "el ticket es otra tabla". Ver §6.1 (nuevo en esta versión)
para el razonamiento completo — sin esa decisión, la objeción 3 SÍ
quedaría sin cerrar por una vía que ninguna versión anterior de este
documento había rastreado hasta sus consumidores reales.

**Corrección post-gate (v4→v5, hallazgo B2 de la cuarta lectura) — lo de
arriba cierra la VISIBILIDAD del tope, no su EJECUCIÓN, y son dos cosas
distintas.** Que la NC manual sea indistinguible de una automática para
las 5 queries de `NC_LINKAGE_UNION` (visibilidad, cerrado) no dice nada
sobre si el tope se CHEQUEA al momento de crearla. Los dos checks reales
(`getInFlightCreditNoteTotalForUpdate` para N5 global,
`getInFlightCreditNoteTotalForPairForUpdate` para el tope por par) viven
en `buildCreditNote()` (`invoice.service.ts`), no en
`InvoiceRepository.createWithClient()` — que es el método que §6.1 dice
que el flujo manual reutiliza, y que no valida nada por sí mismo (ver
§6.1, corregido, para el detalle completo y la obligación que esto
implica para el código nuevo).

**Objeción 4 — "sin campo de monto congelado, sin precedente ERP."** Sigue
sin precedente y sigue sin proponerse acá. El monto real vive en
`invoice_draft_items` (generalizado, §6) mientras se edita, y en
`invoices.imp_total` una vez emitida — el ticket no lleva un tercer número
paralelo.

**Conclusión de esta sección:** B3 se reabre, pero **acotado al caso nuevo**
(atribución determinística fallida, ambos escapes). El caso AFIP-incierto
original **NO** se resuelve con este mecanismo todavía — sigue con el
"triple sin nombre" (N11) que ya funciona hoy sin schema. Extender el
ticket a cubrir también ese caso es un bloque futuro, no de este documento
(ver §9). **Precisión post-gate:** como el caso AFIP-incierto queda
explícitamente afuera, la corrección A6.6 del gate 2.2 (línea 544 del ADR
común — quién puede mover `invoices.status` de `PENDIENTE_CAE` a
`CANCELADO` en ese flujo) tampoco es de este documento: es una deuda del
flujo AFIP-incierto original, sin cambios acá, y sigue sin resolverse ahí.
Este documento no la hereda porque no toca esa máquina de estados.

---

## 3. Alcance exacto de esta salida manual

**Retirado en v7.0 — ver §0.** Todo lo que sigue en esta sección describe
el alcance vigente hasta v6.9 (`NO_ITEMS` + `AMOUNT_MISMATCH`). Desde
v7.0 el alcance real es **solo `AMOUNT_MISMATCH`** — `NO_ITEMS` y todo lo
que dependía de él (el prerrequisito del campo `reason` en
`CreditNoteAttributionBlockedError`, `OrderInvoiceHasNoLinesError`) ya no
aplican. Se conserva sin reescribir como registro histórico.

**Corrección post-gate (12/09/2026, segunda lectura de `architecture-governor`)
— este bloque re-derivaba en prosa un conjunto que ya tiene dueño mecánico.**
La primera versión trataba `NO_ITEMS`/`SUBJECT_NOT_IN_INVOICE`/
`MISSING_FROZEN_IVA_ENTRY` como si fueran nombres de clase intercambiables
con las entradas de `EXPECTED_THROWS`. Son otra cosa: los tres son valores
del campo `reason` de UN solo resultado `BLOCKED` que devuelve
`resolveRefundableForPair()` (`refund-attribution.ts:162`,
`kind: 'BLOCKED'; reason: 'NO_ITEMS' | 'SUBJECT_NOT_IN_INVOICE' |
'MISSING_FROZEN_IVA_ENTRY'`), y las tres ramas se propagan como **una sola**
clase, `CreditNoteAttributionBlockedError` (`domain/errors.ts`) — que hoy
interpola `reason` en el mensaje pero **no lo expone como propiedad**
(`code` queda fijo en `CREDIT_NOTE_ATTRIBUTION_BLOCKED` para las tres). La
fuente de verdad del catálogo completo de throws es
`EXPECTED_THROWS` en `build-credit-note-throw-catalog.test.ts` — este
bloque se re-deriva contra esa cerca, no de memoria:

- **Motivos que la habilitan, correctamente separados por origen:**
  - `OrderInvoiceHasNoLinesError` (rama heredada, `originalItems.length
    === 0`) — clase propia, sin ambigüedad, siempre en alcance.
  - `CreditNoteAttributionBlockedError` **solo cuando su `reason` interno
    es `'NO_ITEMS'`** — las otras dos razones que puede cargar la MISMA
    clase (`SUBJECT_NOT_IN_INVOICE`, `MISSING_FROZEN_IVA_ENTRY`) siguen
    rechazando duro, sin ticket ni borrador.
  - `CreditNoteAttributionMismatchError` — clase propia, sin ambigüedad.
- **Prerrequisito de código que este documento declara, no descubre en
  implementación:** filtrar por `reason` requiere agregarle a
  `CreditNoteAttributionBlockedError` un campo legible (`reason:
  'NO_ITEMS' | 'SUBJECT_NOT_IN_INVOICE' | 'MISSING_FROZEN_IVA_ENTRY'`,
  hoy solo interpolado en el string del mensaje) — un cambio real en
  `domain/errors.ts`, dentro del radio de `BUILD-CREDIT-NOTE-THROW-CATALOG-001`
  (no cambia el conjunto de clases tiradas, así que esa cerca sigue en
  verde; sí cambia lo que un `catch` puede leer). Sin este campo, "solo
  `NO_ITEMS`" no es implementable — el bloque de implementación arranca
  por acá, antes que el enganche de §7.
- **Riesgo residual aceptado, no cerrado por este documento:** de los 6
  throws `DETERMINISTIC` del catálogo, esta salida manual cubre 3
  (`OrderInvoiceHasNoLinesError`, `CreditNoteAttributionBlockedError` con
  `reason='NO_ITEMS'`, `CreditNoteAttributionMismatchError`). Los otros 3
  siguen produciendo un `ADJUSTMENT` huérfano sin ticket:
  `InvoiceNotReversibleError` (alcanzabilidad **no verificada
  independientemente** — hallazgo abierto del gate desde el 11/09/2026),
  `CreditNoteAmbiguousSubjectError` y el `Error` genérico de "ADJUSTMENT
  parcial sin sujeto" (los dos argumentados hoy inalcanzables desde los 2
  escapes reales, no verificados con un test que lo pruebe). Si algún día
  se prueba que alguno de estos SÍ es alcanzable, este documento no lo
  resuelve — es backlog nuevo, no una omisión de esta salida manual.
  Si más adelante se decide habilitar también `SUBJECT_NOT_IN_INVOICE`/
  `MISSING_FROZEN_IVA_ENTRY`, es una decisión propia (mismo criterio de
  "cada motivo es su propia pregunta").
- **Los dos escapes** (`cancel-order-with-credit-note.service.ts`,
  `cancel-reservation-with-credit-note.service.ts`) — el hallazgo original
  es de los dos, y el ticket/borrador generalizado no distingue el
  orquestador de origen más que por qué campo (`order_id`/`reservation_id`)
  trae la `financial_transaction` revertidora.
- **Edición línea por línea** (producto/servicio, cantidad, precio, tasa de
  IVA) — mismo nivel de libertad que Odoo/ERPNext, reusando
  `invoice_draft_items` de `FACT-BORRADOR-001` sin cambios de forma (ver §6).
- **NO** entra en este documento: el flujo AFIP-incierto original de B3,
  pool mixto, el portal de clientes creando solicitudes, ni ninguno de los
  bloqueantes mecánicos de `FACT-BORRADOR-001` (C-1 a C-4, §26.1) que no
  se tocan acá.

---

## 4. Las tres entidades y cómo se relacionan

```
financial_transactions (ADJUSTMENT, ya existe, creado por el orquestador)
        │  1
        │  (financial_transaction_id, la columna real de §6 --
        │   corrección post-gate v5→v5.1: esta línea decía
        │   "reversed_financial_transaction_id", un nombre que no existe
        │   en ningún lado del repo ni en la DDL de §6)
        ▼  0..1
credit_note_request (TICKET — nuevo, generaliza B3)
        │  1
        │  (credit_note_request_id, nuevo en invoice_drafts)
        ▼  0..1
invoice_drafts (CONTENIDO EDITABLE — ya diseñado en FACT-BORRADOR-001,
                generalizado en §6 para poder ser también una NC)
        │  1
        │  (invoice_id, ya existe en invoice_drafts)
        ▼  0..1
invoices (DOCUMENTO FINAL — ya existe, sin cambios de forma)
```

El `ADJUSTMENT` no cambia de fila ni se duplica en ningún punto de este
flujo — sigue siendo la misma fila desde que el orquestador la crea en tx1
hasta que tx2 la settlea, exactamente como hoy. Lo único que cambia es que,
si `buildCreditNote()` tira uno de los dos motivos habilitados, el
orquestador **ya no propaga el error al caller** — crea (o encuentra, si
es un reintento) el `credit_note_request` y devuelve un resultado que dice
"escalado a revisión manual", en vez de un 409.

**Nota (v3):** este diagrama termina en `invoices` porque ahí termina el
CONTENIDO — pero el tx2 del escape (cancelar la entidad, settlear el
`ADJUSTMENT` y los cargos congelados) sigue sin dueño en el camino
manual hasta que alguien lo corre. Ver §7.1, agregado en esta versión
específicamente porque ninguna sección anterior lo asignaba.

---

## 5. `credit_note_request` — máquina de estados

Reusa el molde de `FACT-BORRADOR-001` §5 (declarada como dato en un solo
lugar, A6.1) pero con la asimetría de la objeción 1 resuelta explícita:

```
PENDIENTE_COMPLETAR ──crear/editar borrador──▶ PENDIENTE_COMPLETAR (sigue igual, editable)
        │
        └──confirmar borrador (emitir NC)──▶ EMITIENDO
                                                 │
                                                 ├──CAE ok──▶ EMITIDA_PENDIENTE_LEDGER
                                                 │                │
                                                 │                └──paso de ledger de §6.1/§7.1 ok──▶ RESUELTO (terminal)
                                                 │                └──si falla, SIGUE en EMITIDA_PENDIENTE_LEDGER
                                                 │                   (reconciliación idempotente, igual que
                                                 │                   FACT-BORRADOR-001 -- nunca un edge a BLOQUEADA,
                                                 │                   ver §7.1 corregido)
                                                 ├──AFIP rechazó/incierto sin contactar──▶ EMISIÓN_FALLIDA
                                                 │                (NO editable directo -- FACT-BORRADOR-001 §5: "no
                                                 │                (hasta reabrir)". Dos salidas, no una: "reintentar
                                                 │                sin editar" vuelve a EMITIENDO; "reabrir" mueve a
                                                 │                PENDIENTE_COMPLETAR recién ahí editable. Corregido
                                                 │                v5→v5.1 -- versiones previas decían "editable" sin
                                                 │                distinguir las dos salidas)
                                                 └──AFIP contactado, incierto──▶ BLOQUEADA (terminal para el sistema,
                                                                                   sale solo por reconciliación humana, A8.6)
   (solo con borrador vinculado) ──descartar el borrador──▶ (ese borrador queda DESCARTADO, D3: nunca
                                                              DELETE físico) ── el ticket se re-vincula a un
                                                              borrador NUEVO, ver más abajo — el TICKET nunca
                                                              queda en un estado "descartado" propio
```

**Corrección post-gate (v3→v4, NEW-2b) — el diagrama de v3 tenía un
`EMITIENDO ──▶ RESUELTO` directo que `FACT-BORRADOR-001` no tiene.** Ese
documento **no** tiene ninguna transición directa `ISSUING → ISSUED` —
TODA emisión pasa por `ISSUED_PENDING_LEDGER` primero (`§5`:
`DRAFT ──issue()──▶ ISSUING ──CAE ok──▶ ISSUED_PENDING_LEDGER
──CHARGE ok──▶ ISSUED`). v3 inventaba una bifurcación ("ledger asentado"
vs. "ledger pendiente") que no existe en el documento que dice heredar
sin reescribir. Corregido: un solo camino, siempre vía
`EMITIDA_PENDIENTE_LEDGER` — lo que varía por `document_kind` es en QUÉ
consiste "el paso de ledger" (para `SALES_INVOICE`, un INSERT de CHARGE;
para `CREDIT_NOTE`, el tx2 completo del escape, ver §6.1 y §7.1, los dos
nuevos en esta versión).

**Corrección post-gate (v4→v5, hallazgo B1 — el mismo error de v3 se
reintrodujo un nivel más abajo.** v4 agregó un edge
`EMITIDA_PENDIENTE_LEDGER ──▶ BLOQUEADA` que TAMPOCO existe en
`FACT-BORRADOR-001`: ese estado sale ÚNICAMENTE por
`──CHARGE ok──▶ ISSUED` o por su propio loop de reconciliación idempotente
(`ISSUED_PENDING_LEDGER` es, en palabras del documento que se hereda,
"estado real, no de error" — sale por convergencia, no por bloqueo).
`EMISSION_BLOCKED`/`BLOQUEADA` significa algo específico y distinto: AFIP
CONTACTADO sin poder confirmar (A8.6) — una falla del tx2 de este
documento ocurre con el CAE YA confirmado, la situación opuesta.
Corregido: una falla del paso de ledger (§7.1) NO mueve el borrador a
ningún estado nuevo — se queda en `EMITIDA_PENDIENTE_LEDGER`,
reintentado idempotentemente por el mismo mecanismo de convergencia que
`FACT-BORRADOR-001` ya declara para ese estado (§26.2, citado en el
origen de este documento: el mismo patrón dead-letter del `OutboxWorker`
que ya se usó una vez para este tipo de limbo). El ticket, que solo LEE y
traduce el estado del borrador (§5), muestra "emitida, pendiente de
asentar" durante todo ese reintento — nunca inventa un estado propio.

**Corrección post-gate (v2→v3) — "4 estados" era incorrecto, y la
propuesta de v2 para `discarded_at` se contradecía a sí misma (§5 decía
"mismo UPDATE transaccional", el CHECK de §6 lo hacía estructuralmente
imposible) y, combinada con el `UNIQUE` de §6, podía dejar el
`ADJUSTMENT` trabado para siempre si un ticket se descartaba antes de
tener borrador y después se reintentaba el escape.** Las dos corregidas
juntas acá, con una sola regla, no dos que se pisan:

Mapeo con los **7** estados que `FACT-BORRADOR-001` §5 ya declara para
`invoice_drafts` (`DRAFT`→`PENDIENTE_COMPLETAR`, `ISSUING`→`EMITIENDO`,
`ISSUED_PENDING_LEDGER`→`EMITIDA_PENDIENTE_LEDGER`, `ISSUED`→`RESUELTO`,
`EMISSION_FAILED`→**`EMISIÓN_FALLIDA`** (nombre propio, distinto de
`PENDIENTE_COMPLETAR` — v2 los colapsaba en uno solo, perdiendo la
diferencia entre "recién creado, nadie empezó" y "falló la emisión,
reintentable sin editar"; con nombre propio el mapeo vuelve a ser 1:1),
`EMISSION_BLOCKED`→`BLOQUEADA`, `DISCARDED`→ ver abajo) — **el ticket NO
tiene una máquina de estados propia y paralela: mientras exista un
`invoice_drafts` vinculado, el estado del ticket ES el estado del
borrador, expuesto con nombres propios de cara al operador** (resuelve la
objeción 1 sin inventar una segunda fuente de verdad: hay un solo UPDATE
de estado real, el de `invoice_drafts`; `credit_note_request` solo LEE y
traduce el nombre para la bandeja). Ninguna transición del ticket es
libre: sigue exactamente la lista de transiciones válidas que
`invoice_drafts` ya declara (A6.2/A6.3 del ADR común, heredadas acá) — un
intento de mover el ticket a un estado no alcanzable desde el actual del
borrador es un error tipado, no un UPDATE silencioso. `BLOQUEADA` es
terminal PARA EL SISTEMA (A6.4): ningún código la reabre solo; sale
exclusivamente por reconciliación humana (A8.6), igual que hoy declara
`FACT-BORRADOR-001` para `EMISSION_BLOCKED`.

**`DISCARDED` — regla única, sin excepción por ventana:** descartar **NO
es una operación del ticket**, solo del borrador. Antes de que exista un
`invoice_drafts` vinculado, el ticket tiene un único estado posible,
`PENDIENTE_COMPLETAR` — no hay nada que descartar todavía (el
`ADJUSTMENT` sigue necesitando resolución; no desaparece porque un
operador decida no mirarlo). Una vez que hay borrador vinculado y ese
borrador se descarta (D3, terminal para ESA fila de `invoice_drafts`,
nunca DELETE), el ticket **no absorbe ningún estado "descartado"
propio** — simplemente deja de tener un borrador vigente y puede
re-vincularse a uno NUEVO (`invoice_drafts.id` distinto, mismo
`credit_note_request.id`) cuando alguien retoma la reconciliación. Esto
es lo que hace posible mantener el `UNIQUE (financial_transaction_id)`
de §6 sin reabrir la objeción 3: nunca hace falta una segunda fila de
ticket para el mismo `ADJUSTMENT`, solo un segundo borrador. Un ticket sin
borrador vinculado y sin nadie completándolo simplemente permanece en
`PENDIENTE_COMPLETAR` de forma indefinida — visible en la bandeja, nunca
oculto — que es la propiedad que este documento existe para lograr. Este
documento NO decide si además hace falta una forma de "cerrar sin
resolver" el ticket (p. ej. management decide absorber la diferencia sin
NC) — no es un caso que `NO_ITEMS`/`AMOUNT_MISMATCH` necesiten para
funcionar, y no se propone acá (si hiciera falta, es una pregunta propia,
no una extensión implícita de `DESCARTADO`).

**Antes de que exista un `invoice_drafts` vinculado**, el ticket vive en
`PENDIENTE_COMPLETAR` de forma autoritativa — acá sí es la única fuente
de verdad, porque no hay nada más que proyectar (esto es lo que la
objeción 1 no contemplaba, porque el caso que la motivó siempre tenía una
`invoices` existente).

**Nota sobre `resolved_by`** (objeción 2 del gate 2.2): este documento NO
agrega esa columna al ticket. Quién completó o descartó un borrador ya
queda registrado por el mecanismo existente de auditoría de campo
(**Corrección post-gate (v3→v4, NEW-4) — la variante citada era la
equivocada.** `domain/audit.ts::recordFieldChangesWithClient()`, no
`recordFieldChanges()` a secas: esta última es la variante
DELIBERADAMENTE no transaccional, reservada por `CLAUDE.md` (raíz) al
único caso cross-DB (`RoleService.updatePermissionGroups()`, rol en
plataforma / auditoría en tenant). Un documento fiscal como
`invoice_drafts` no es ese caso — su auditoría de campo tiene que ir en
la MISMA transacción que el UPDATE que audita, la variante
`WithClient()`) sobre `invoice_drafts` — una columna `resolved_by`
paralela en `credit_note_request` sería un segundo lugar contando el
mismo hecho. Sustitución deliberada, no un olvido.

---

## 6. Generalización del modelo de datos (`FACT-BORRADOR-001` §6 + `credit_note_request` nuevo)

**Sigue en HOLD — esbozo, no migración**, mismo criterio que §6 del
documento que generaliza.

**Retirado en v7.0 — ver §0.** El `CHECK` de `reason` de abajo y la
tabla de mapeo describen el alcance vigente hasta v6.9. Desde v7.0 el
único valor real es `'AMOUNT_MISMATCH'` — la fila `'NO_ITEMS'` de la
tabla y del `CHECK` queda retirada, no habilitada. Se conserva sin
reescribir como registro histórico.

**Corrección post-gate (v1→v2) — el `CHECK` de `reason` inventaba un valor
que no existe en ningún catálogo real, y el `CHECK` de puntero era una
tautología (`... OR TRUE` no restringe nada).**

**Corrección post-gate (v2→v3) — la tabla original no tenía dueño para el
tx2 del escape (cancelar la entidad, settlear el `ADJUSTMENT` y los
cargos congelados) ni un lugar donde persistir `frozenChargeIds`, que hoy
solo vive en memoria dentro de la misma llamada síncrona de tx1→tx2 de
cada orquestador — inservible si la finalización pasa días después, en un
código distinto (§7 tiene el detalle de POR QUÉ hace falta). Agregado acá
como columna, capturada en el mismo momento en que el `catch` del
orquestador ya tiene esos ids en memoria — no una re-derivación nueva,
que es justo lo que el comentario de bloque 1c-i prohíbe.**

`reason` es una **etiqueta de negocio propia de este ticket** — no
reproduce el nombre de una clase de error ni un valor literal de
`BLOCKED.reason` de `refund-attribution.ts` (esos son dos vocabularios de
código distintos, ver §3). El mapeo hacia el código que la escribe:

| `reason` del ticket | Producido por |
|---|---|
| `'NO_ITEMS'` | `OrderInvoiceHasNoLinesError` (rama heredada) **o** `CreditNoteAttributionBlockedError` con `reason` interno `'NO_ITEMS'` (rama de atribución, requiere el campo nuevo de §3) |
| `'AMOUNT_MISMATCH'` | `CreditNoteAttributionMismatchError` |

```sql
-- credit_note_request — TRANSACCIÓN, workflow (A6.1-A6.6, NO A3.8 -- no es
-- una fila del ledger financiero, mismo encuadre que ya fijó el gate 2.2
-- para B3).
CREATE TABLE IF NOT EXISTS credit_note_request (
  id                              VARCHAR(255)  PRIMARY KEY,
  business_id                     VARCHAR(255)  NOT NULL,
  -- La fila que originó el ticket -- SIEMPRE existe (el ADJUSTMENT ya está
  -- creado por el orquestador antes de que buildCreditNote() falle).
  financial_transaction_id        VARCHAR(255)  NOT NULL
                                    REFERENCES financial_transactions(id) ON DELETE RESTRICT,
  -- Etiqueta de negocio propia de este ticket, NO un nombre de clase ni un
  -- valor de BLOCKED.reason -- ver la tabla de mapeo arriba.
  reason                          VARCHAR(40)   NOT NULL
                                    CHECK (reason IN ('NO_ITEMS', 'AMOUNT_MISMATCH')),
  -- NULL hasta que alguien arranca a completar el borrador. Mutable en el
  -- tiempo (§5): si ESE borrador se descarta, este campo pasa a apuntar a
  -- un borrador NUEVO -- nunca se crea un segundo credit_note_request
  -- para el mismo financial_transaction_id.
  invoice_draft_id                VARCHAR(255)  REFERENCES invoice_drafts(id) ON DELETE RESTRICT,
  created_at                      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  -- CORREGIDO (v2->v3): sin discarded_at propio -- §5 explica por qué
  -- "descartado" es SOLO un estado del borrador vinculado, nunca del
  -- ticket. La objeción "resolved_at" del gate 2.2 (necesario para que
  -- la bandeja distinga "hace 3 minutos" de "hace 3 días") se resuelve
  -- leyendo invoice_drafts.updated_at cuando hay borrador vinculado;
  -- sin borrador vinculado se lee como "todavía sin empezar".
  --
  -- NUEVO (v2->v3, cierra N3/N4 de la segunda lectura del gate): el
  -- conjunto de cargos congelados que el orquestador ya calculó en tx1
  -- (frozenChargeIds -- `[charge.id]` para órdenes, la intersección
  -- invoiceChargeIds ∩ reservationChargeIds para reservas) y que hoy solo
  -- vive en memoria dentro de la misma llamada síncrona tx1→tx2. Si la
  -- finalización de la NC pasa días después por este ticket, ese cálculo
  -- ya no está en memoria de nadie -- y RE-derivarlo es exactamente lo
  -- que el comentario de bloque 1c-i prohíbe ("NUNCA re-derivado acá --
  -- una re-derivación con getChargeIdsForInvoice settlearía también el
  -- cargo de OTRA orden en una consolidada"). Se captura acá, en el
  -- mismo INSERT que crea el ticket, con los ids que el catch del
  -- orquestador YA tiene en memoria en ese momento -- no un cálculo
  -- nuevo, el mismo dato movido de una variable a una columna.
  frozen_charge_ids               VARCHAR(255)[] NOT NULL,
  -- Lock optimista -- mismo patrón que invoice_drafts.version
  -- (FACT-BORRADOR-001 §6, DEFAULT 1, no 0 -- alineado acá para no
  -- inducir un off-by-one en un helper que termine compartiéndose entre
  -- las dos tablas). Dos operadores abriendo la misma bandeja no pueden
  -- pisarse un UPDATE del ticket sin darse cuenta.
  version                         INTEGER       NOT NULL DEFAULT 1,

  -- Un ADJUSTMENT genera UN ticket real por construcción (no es el caso
  -- "pool mixto" de la objeción 3 -- ahí N solicitudes LEGÍTIMAS
  -- comparten una misma entidad; acá es 1:1, la objeción 3 no aplica).
  -- Único real: cierra la carrera de dos reintentos concurrentes del
  -- mismo escape creando dos tickets para el mismo ADJUSTMENT. Sigue
  -- siendo seguro con la regla de §5 (re-vincular a un borrador nuevo en
  -- vez de crear un ticket nuevo) -- nunca hace falta una segunda fila.
  CONSTRAINT uq_credit_note_request_financial_transaction
    UNIQUE (financial_transaction_id)
);
```

**Nota R2 (`docs/criterios-datos.md`, Parte 5) — pendiente del checklist
de la ADR común, sin cargar hasta esta versión:** el repositorio de
`credit_note_request` (`findById`, la lectura que arma la bandeja) NO
lleva ningún filtro implícito de estado — un ticket con borrador
`DISCARDED` sigue siendo `findById`-eable como cualquier otro, igual que
`invoice_drafts` no oculta sus filas `DISCARDED` (D3). Sin este ticket, el
checklist de la ADR común quedaba con un ítem sin marcar desde el
08/09/2026.

**Cambios sobre `invoice_drafts` (`FACT-BORRADOR-001` §6):**

**Corrección sobre la primera versión de este documento (12/09/2026, antes
de mostrárselo al dueño) — el discriminador NO puede ser un solo nullable.**
La primera versión proponía `reversed_invoice_id` nullable como
discriminador implícito (`NULL` = factura, `NOT NULL` = NC). El dueño
señaló, al preguntar "¿por qué compartir infra?", que la razón real es
dejar la puerta abierta a agregar **Nota de Débito** como tercer tipo de
documento el día que haga falta — y un nullable binario **se rompe con 3
tipos**: `NOT NULL` deja de decir CUÁL de los dos no-factura es. Además,
"reversed" (revertir) describe lo que hace una NC, no lo que haría una ND
(suma, no revierte) — el nombre tampoco generaliza. Corregido con un
discriminador explícito, mismo patrón CASE-based que `CLAUDE.md` (raíz)
ya exige para "exactamente uno de N" (`chk_customer_rate_pricing_mode`,
`chk_deposit_policy_scope`, `chk_rate_catalog_scope`) — nunca el diseño
polimórfico de columnas nullable sin discriminador que esa misma regla
rechaza:

```sql
ALTER TABLE invoice_drafts ADD COLUMN IF NOT EXISTS
  document_kind VARCHAR(20) NOT NULL DEFAULT 'SALES_INVOICE'
    CHECK (document_kind IN ('SALES_INVOICE', 'CREDIT_NOTE'));
  -- Solo 2 valores habilitados HOY -- 'DEBIT_NOTE' queda reservado en el
  -- nombre del patrón, no en el CHECK: agregarlo el día que exista
  -- CBTE_TIPO_NOTA_DEBITO_B (no definido todavía en
  -- afip-catalog.constants.ts, verificado) es un ALTER de un CHECK
  -- existente, no un modelo nuevo. 'SALES_INVOICE' default -- todo
  -- borrador de hoy sigue siendo ese valor sin migración de datos.

ALTER TABLE invoice_drafts ADD COLUMN IF NOT EXISTS
  associated_invoice_id VARCHAR(255) REFERENCES invoices(id) ON DELETE RESTRICT;
  -- Nombre NEUTRAL a propósito -- no "reversed_invoice_id": una Nota de
  -- Débito no revierte la factura asociada, la complementa. Mismo rol
  -- que CbtesAsoc de AFIP (asocia el comprobante nuevo al original),
  -- para CUALQUIER document_kind que no sea 'SALES_INVOICE'. NULL
  -- cuando document_kind = 'SALES_INVOICE' (nada que asociar); NOT NULL
  -- para 'CREDIT_NOTE' (y para 'DEBIT_NOTE', cuando exista).
  --
  -- CONSTRAINT chk_invoice_draft_kind_pointer, forma real en bloque de
  -- implementación: (document_kind = 'SALES_INVOICE' AND associated_invoice_id IS NULL)
  -- OR (document_kind != 'SALES_INVOICE' AND associated_invoice_id IS NOT NULL).

ALTER TABLE invoice_drafts ADD COLUMN IF NOT EXISTS
  credit_note_request_id VARCHAR(255) REFERENCES credit_note_request(id) ON DELETE RESTRICT;
  -- NULL para toda factura de venta. NOT NULL solo para un borrador que
  -- nació de un ticket (document_kind = 'CREDIT_NOTE' hoy; el mismo
  -- campo sirve para 'DEBIT_NOTE' si ese tipo también termina naciendo
  -- de un ticket de revisión -- no decidido, no es parte de este
  -- documento).
```

**Corrección post-gate (v4→v5, hallazgo M5) — este puntero NO es el
mismo hecho contado dos veces, aunque a primera lectura lo parezca.**
`credit_note_request.invoice_draft_id` es el puntero "CUÁL borrador está
vigente ahora" para el ticket — mutable, un solo valor a la vez (§5: si
ESE borrador se descarta, el puntero pasa a uno nuevo).
`invoice_drafts.credit_note_request_id` es el puntero "de qué ticket nació
ESTA fila de borrador en particular" — fijo para siempre en esa fila,
nunca cambia. Son cardinalidades distintas: un ticket puede tener VARIOS
`invoice_drafts` a lo largo del tiempo (uno vigente, N descartados, cada
uno reteniendo su propio origen para historial — D3, nunca DELETE), pero
cada `invoice_drafts` tiene UN solo ticket de origen. No son dos columnas
contando lo mismo — son la relación N:1 (drafts→ticket) y su puntero
"actual" 1:1 (ticket→draft vigente) vistos desde cada lado; ninguno se
puede derivar del otro sin una query.

**Corrección post-gate — la cita de `invoice_draft_items` era sobre el SQL
que `FACT-BORRADOR-001` ya marcó retirado.** El §6 de ese documento lleva
un banner ⛔ explícito: *"ESTE SQL ESTÁ DESACTUALIZADO... codifica tres
modelos superados a la vez"*. La forma vigente de la columna de IVA no es
`iva_rate` a secas — §25.2 (vigente, no superseded por la re-verificación
Odoo de §28.1: esa lista nombra §8/§24/§7.5/T18, no §25) la reemplazó por
`fiscal_treatment` (`GRAVADO`/`TASA_CERO`/`EXENTO`/`NO_GRAVADO`) +
`arca_iva_id` + un `iva_rate` condicional. `invoice_draft_items` **no
cambia de forma para esta generalización** (una línea de NC manual usa
los mismos campos que una línea de factura de venta, `fiscal_treatment`
incluido) — la corrección es de cita, no de diseño: no agrega columnas,
pero las columnas que sí toca son las de §25.2, no las del bloque
retirado.

**Hueco fiscal que esta cita corregida expone.** §25.3
exige que la emisión RECHACE explícitamente `fiscal_treatment` en
`EXENTO`/`NO_GRAVADO` mientras `ImpTotConc`/`ImpOpEx` sigan hardcodeados a
`0` — y `buildCreditNote()` hoy hardcodea ambos a `0`
(`invoice.service.ts:702/704` dentro de `buildIvaBreakdown()`, y
`:1021/1023` dentro de `buildCreditNote()`).

**Corrección post-gate (v6.2→v6.3) — la v6.2 cerró esto de más, citando
mal AFIP y contradiciendo sin darse cuenta una regla vigente de
`FACT-BORRADOR-001`.** Investigado v6.2 contra el buscador web
(`afip.gob.ar`/`afipts.com` bloqueados por el proxy de este entorno) en
vez de contra la referencia YA CITADA por este mismo bloque unas líneas
arriba (`docs/referencia-afip-wsfev1.md`, que sí existe en el repo y
deriva del manual oficial) — el mismo error que ya causó dos rondas
previas de HOLD (citar de memoria/de una búsqueda en vez del archivo
vivo). Verificado ahora contra esa referencia local:

- **La identidad `ImpTotal = ImpTotConc+ImpNeto+ImpOpEx+ImpTrib+ImpIVA`
  es real y universal** (`referencia-afip-wsfev1.md`, tabla de
  validaciones) — pero **no lleva el código 10048**: esa fila está
  marcada `—` (sin código). **10048 es una regla distinta y más
  específica: "Bienes Usados-Monotributista: `ImpTotal` =
  `ImpTotConc+ImpTrib`"** — no aplica a NC estándar tipo B (este repo
  emite únicamente `CBTE_TIPO_NOTA_CREDITO_B`, congelado por
  `afip-catalog.constants.test.ts`). La cláusula de tipo C que v6.2
  citaba tampoco aplica acá, por el mismo motivo.
- **La conclusión de v6.2 — "la clasificación fiscal de cada línea la
  hereda del `fiscal_treatment` del catálogo, no la elige el
  operador" — contradice directamente `FACT-BORRADOR-001` §25.7,
  vigente (§28.1 no la supersede):** *"una línea `MANUAL` no hereda
  nada: **elige** un tratamiento habilitado."* Y §25.8 pone
  explícitamente fuera de alcance "qué tratamiento le corresponde a un
  bien o servicio concreto" — "materia normativa, requiere validación
  profesional". Además, `fiscal_treatment` **no existe en ningún lado
  del código hoy** (cero ocurrencias en `src/`) — lo único que existe es
  `products.iva_rate` (`schema.sql`, NUMERIC nullable = hereda
  `business_profile.default_iva_rate`), que es una TASA, no un
  discriminador `GRAVADO`/`EXENTO`/`NO_GRAVADO` — no puede distinguir
  "gravado al 0%" de "exento". `bookable_services`/`resources` no tienen
  ningún campo fiscal. "Heredar del catálogo" no es un requisito de
  implementación sobre una decisión ya tomada — es una decisión de
  modelado TODAVÍA no tomada, que además invertiría una regla vigente de
  otro documento.

**Corregido: ver §9 ítem 6, ahora una resolución condicional, no
cerrada.**

`cbte_tipo` sigue sin persistirse en el borrador (§6 de
`FACT-BORRADOR-001`, sin cambios) — se resuelve en la emisión, con un
`switch`/CASE sobre `document_kind` (nunca una interpolación directa,
mismo criterio de seguridad ya aplicado en
`getInFlightCreditNoteTotalForPairForUpdate()` para elegir columna SQL):
`'SALES_INVOICE'` ⟹ `CBTE_TIPO_FACTURA_B`; `'CREDIT_NOTE'` ⟹
`CBTE_TIPO_NOTA_CREDITO_B` + `CbtesAsoc` armado con los datos de
`associated_invoice_id` — mismo cálculo que ya hace `buildCreditNote()`
hoy para la rama automática.

**`creation_idempotency_key` — divergencia declarada, no un olvido.**
`FACT-BORRADOR-001` §10.1 la define `NOT NULL` + única globalmente,
**provista por el cliente** ("un borrador libre no tiene clave natural").
Un `invoice_drafts` que nace de este flujo SÍ tiene una clave natural — no
hay cliente que la provea, porque nadie clickeó "nuevo borrador": nace del
propio `catch` del orquestador. Clave propuesta:
`credit-note-request:<financial_transaction_id>` (determinística, igual
para cualquier reintento del mismo `ADJUSTMENT`). Es una divergencia
explícita del D-nivel de razonamiento de `FACT-BORRADOR-001` para ESTE
caller únicamente — no cambia el contrato para el caso de factura de
venta, que sigue siendo provisto por el cliente.

**Dependencia dura, no un detalle de implementación:** `invoice_drafts`
**no existe hoy** — cero ocurrencias en `src/db/schema.sql` y cero en
`src/**/*.ts` (verificado). Sigue en HOLD detrás de los bloqueantes
mecánicos C-1 a C-4 (§26.1 de `FACT-BORRADOR-001`) y las decisiones de
dueño pendientes de §26.3/§27.2, y su propio §28 (Odoo, v2.10) todavía no
pasó su gate. **Este documento no se puede implementar antes de que esa
cadena de HOLD se resuelva** — no es una decisión de este documento, es
una precondición externa (ver §9, pregunta reformulada).

**Referencias a `reversed_invoice_id`/binario en el resto de este
documento (§1, §4) describen la intención general, no el nombre de
columna final** — donde este documento habla de "borrador de NC" o
"`reversed_invoice_id`" en prosa, léase `document_kind = 'CREDIT_NOTE'` +
`associated_invoice_id`, la forma corregida de esta sección.

**Nota de cerca (F1) — ya resuelta por el renombre de esta misma
corrección, no por evaluar de nuevo.** La primera versión de esta sección
usaba `reversed_invoice_id` como nombre de columna en `invoice_drafts`, lo
que habría colisionado con `REVERSED-INVOICE-ID-CONVENTION-001`
(`reversed-invoice-id-convention.test.ts`): esa cerca escanea TODO
`src/**/*.ts` buscando escrituras de `reversedInvoiceId` y exige que el
conjunto de archivos sea exactamente sus 3 `WRITE_SITES` (los write sites
de `financial_transactions`, no de `invoice_drafts`) con `type: 'REFUND'`
o `'ADJUSTMENT'`. `associated_invoice_id` es un nombre de columna
distinto en una tabla distinta — no matchea `WRITE_RE`
(`\breversedInvoiceId:\s*`) y no entra en el radar de esa cerca. Sin
impacto, verificado, no hace falta extenderla.

---

## 6.1 Qué significa "ledger" para un borrador `CREDIT_NOTE` — NUEVO (v3→v4)

**Nota v7.1 — ver §0.** Esta sección describe el mecanismo del ledger
para ambos motivos habilitados hasta v6.9 (`NO_ITEMS`+`AMOUNT_MISMATCH`);
sigue vigente para `AMOUNT_MISMATCH` (el único motivo real desde v7.0)
sin cambios — **con una excepción real, no cubierta por "salvo donde se
lo nombra explícitamente":** el bloque "Corrección post-gate (v4→v5,
hallazgo B3)" más abajo declaraba una precondición dura ESPECÍFICA de
`NO_ITEMS` (una factura Nivel A sin `invoice_items` no tiene dónde
escribir una línea manual) sin retirarla al insertar §0 — la doceava
lectura del gate lo marcó como propagación incompleta. Se retira ahí
mismo, con el mismo banner que llevan §3/§6/§7. El requisito corregido
más abajo ("Lo que esto NO decide") ya refleja el alcance vigente.

**Hallazgo bloqueante de la tercera lectura del gate, sin sección propia
en ninguna versión anterior.** `FACT-BORRADOR-001` define
`ISSUED_PENDING_LEDGER → ISSUED` para el ÚNICO `document_kind` que
conocía (`SALES_INVOICE`) como "INSERT de un `CHARGE` nuevo con origen
`invoice_draft_id`" (§23.4/§23.5 de ese documento, que incluso pide una
columna nueva, `financial_transactions.invoice_draft_id`, para esa
trazabilidad). Ninguna versión anterior de este documento dijo qué
significa ese mismo paso para `document_kind = 'CREDIT_NOTE'` — y NO
puede ser lo mismo, porque el punto de partida es distinto en un sentido
estructural:

- Un borrador `SALES_INVOICE` **crea deuda donde no había ninguna** — el
  `CHARGE` que el paso de ledger inserta es la PRIMERA fila del ledger
  para ese documento.
- Un borrador `CREDIT_NOTE` de este flujo **nace de una fila que YA
  EXISTE** — el `ADJUSTMENT` que el orquestador creó en tx1, mucho antes
  de que el borrador existiera. No hay nada que insertar: hay que
  SETTLEAR lo que ya está.

**Decisión que este documento toma, no delegada a implementación:** para
`document_kind = 'CREDIT_NOTE'`, el "paso de ledger" de
`ISSUED_PENDING_LEDGER → ISSUED` **es exactamente el tx2 de §7.1**
(cancelar la entidad + settlear el `ADJUSTMENT` + settlear
`frozen_charge_ids`) — nunca un INSERT de `CHARGE`, nunca la columna
`financial_transactions.invoice_draft_id` de §23.5 (esa columna sigue
siendo exclusiva de `SALES_INVOICE`; una `CREDIT_NOTE` de este flujo no
la usa ni la necesita). La fila `invoices` que resulta de la emisión (con
CAE) se crea con `financial_transaction_id` apuntando al `ADJUSTMENT` del
ticket — el MISMO campo, la MISMA forma que produce `buildCreditNote()`
hoy en el camino automático. Quien construye esa fila ya no es
`buildCreditNote()` (que fue lo que falló y disparó todo esto) sino un
código nuevo, no descrito en detalle acá, que arma el request AFIP a
partir de las líneas editadas de `invoice_draft_items` +
`associated_invoice_id` (para `CbtesAsoc`) — pero que reutiliza el MISMO
método de creación de `invoices` que usa hoy el camino automático,
precisamente para no abrir un tercer camino de vinculación.

**Por qué esta decisión, y no la alternativa de tratarla como una
factura de venta más:**

1. **Cierra la objeción 3 del §2 de verdad, no por afirmación.** Con
   `financial_transaction_id` como único vínculo, la NC de este flujo es
   indistinguible — para `resolveInvoiceLinkage()` y las 5 queries que se
   unen contra `NC_LINKAGE_UNION` (`sql.invoice.repository.ts`) — de
   cualquier NC emitida hoy por el camino automático. **No hace falta una
   tercera rama en ninguno de esos 5 call sites.** Si en cambio se
   vinculara por `invoice_draft_id` (el camino que SÍ generaliza
   `FACT-BORRADOR-001` para `SALES_INVOICE`), esa NC sería invisible para
   el tope N5 y para el guard `InvoiceAlreadyLinkedByOtherPathError`
   (`invoice.service.ts`) — exactamente el tercer camino que el docblock
   de `NC_LINKAGE_UNION` advierte que hay que agregar a mano si aparece.
2. **Corrige el trigger circular de §7.1.** Si el paso de ledger fuera
   posterior a `ISSUED`, `ISSUED` no podría ser su resultado. Con esta
   decisión, §7.1 dispara en `EMITIDA_PENDIENTE_LEDGER` (CAE confirmado,
   ledger pendiente) y su ÉXITO es lo que produce la transición a
   `RESUELTO`/`ISSUED` — nunca al revés.
3. **Resuelve la clave de idempotencia de emisión sin inventar una
   nueva.** **Corrección post-gate (v4→v5) — la razón citada para
   `FACT-BORRADOR-001` §23.4 era inventada.** No dice "múltiples
   borradores podrían competir por el mismo período" — dice
   textualmente que `invoice:<ftId>` "no sirven para una línea libre: no
   hay transacción ni ids". No son casos opuestos, uno tiene id
   (`financial_transaction_id`, este flujo) y el otro no (una factura de
   venta libre). La conclusión sigue en pie por esa razón corregida:
   `requestInvoice()` ya usa `invoice:${financialTransactionId}`
   (`invoice.service.ts`) — se mantiene sin cambios PARA LA CLAVE, mismo
   criterio de divergencia declarada que ya usa
   `creation_idempotency_key` más arriba en esta sección.

**Corrección post-gate (v4→v5, hallazgo M1 de la cuarta lectura) — la
clave se mantiene, pero la FUNCIÓN no puede quedarse igual.**
`invoice.service.ts` rutea TODO `financial_transaction` de `type`
`REFUND`/`ADJUSTMENT` a `buildCreditNote()` sin condición
(`requestInvoice()`, ~línea 402). Reenganchado con un `ADJUSTMENT` que ya
tiene un `credit_note_request` vinculado, `buildCreditNote()` vuelve a
recalcular la MISMA atribución que ya falló de forma determinística — no
hay forma de que "solo la clave se mantenga" sin que la función también
gane una rama nueva: antes de llamar a `buildCreditNote()`,
`requestInvoice()` (o quien la llame para este caso) tiene que chequear
si existe un `credit_note_request` para ese `financial_transaction_id`
con un borrador vinculado listo para emitir, y en ese caso construir el
`invoices` desde las líneas editadas — no desde
`resolveRefundableForPair()`. Bloque de implementación, no decidido en
detalle acá, pero declarado como requisito, no un detalle que se
descubre solo.

**Corrección post-gate (v4→v5, hallazgo M2) — el mecanismo de reintento
existente reutiliza el payload AFIP PERSISTIDO, no uno recalculado, y eso
rompe el propósito completo de este documento si no se declara.**
`retryExisting()` (`invoice.service.ts`) reintenta con
`existing.afipRequest` — el payload que quedó grabado en la fila
`invoices` la vez anterior, no algo derivado de nuevo del borrador. Para
una NC rechazada por AFIP (`EMISIÓN_FALLIDA` que se REABRE a
`PENDIENTE_COMPLETAR` — §5 corregido, la única de sus dos salidas que
habilita editar), un operador que edita las líneas y reintenta usando ese
mecanismo tal cual
recibiría el MISMO payload ya rechazado, sin que el edit se refleje. El
código nuevo de este flujo (mismo bloque que M1) tiene que construir un
payload AFIP FRESCO desde el estado actual del borrador en cada intento
— no puede depender de `retryExisting()` reusando lo persistido, que es
correcto para el caso de `FACT-BORRADOR-001` (nada cambia entre
reintentos ahí) pero incorrecto acá (todo el punto es que algo SÍ
cambió: la edición humana).

**Corrección post-gate (v4→v5, hallazgo B2) — falta re-ejecutar los
topes de NC antes de crear la fila.** `InvoiceRepository.createWithClient()`
(el método que este flujo reutiliza) es un INSERT sin validación propia —
los dos topes reales (`getInFlightCreditNoteTotalForUpdate` para N5
global, `getInFlightCreditNoteTotalForPairForUpdate` para el tope por
par) viven en `buildCreditNote()`, el código que el flujo manual
justamente NO reutiliza para construir la fila (M1). **Requisito nuevo,
no opcional:** el código nuevo tiene que re-ejecutar los dos checks bajo
el mismo `FOR UPDATE` sobre `original.id` antes del `createWithClient()`
— si no, la objeción 3 de §2 queda cerrada solo en visibilidad, no en
ejecución, y el motivo habilitado `AMOUNT_MISMATCH` (el monto no cierra)
es precisamente el caso donde un operador tipeando montos a mano con el
tope sin re-chequear podría emitir por encima de lo que la factura
original admite.

**Corrección post-gate (v4→v5, hallazgo B3) — precondición dura no
declarada: el esquema hoy RECHAZA la forma de línea que el motivo
dominante habilitado produce. [RETIRADO en v7.0 — ver §0; se conserva
como registro histórico de por qué existía, igual que el ítem 10 de §9
al que este bloque apunta.]** `chk_invoice_item_origin`
(`src/db/schema.sql`) exige que cada `invoice_items` tenga EXACTAMENTE
uno de `order_item_id`/`reservation_id` no nulo — un XOR estricto que
`createWithClient()` no valida por sí mismo, solo lo hereda del CHECK.
`invoice_draft_items`, en cambio, permite líneas SIN ningún origen a
propósito (`FACT-BORRADOR-001` — una línea libre "no inventa una
FinancialTransaction"), y ese mismo documento declara la colisión
**sin resolver** (§17.3 — relajar el CHECK, "rechazado definitivamente";
§24.4 proponía reemplazarlo por un discriminador `source_kind` con rama
`MANUAL`, pero §28.1 lo marca `SUPERSEDIDO` sin reemplazo, "vuelve el
modelo de v1: columnas nullable por origen, sin invariante de base" —
**las dos salidas que ese documento había considerado están cerradas
hoy**, no una sin explorar). Para el motivo `NO_ITEMS` — el dominante
entre los dos habilitados HASTA v6.9 — esto no era un caso de borde: una
factura Nivel A no tiene `invoice_items` de origen, así que CUALQUIER
línea manual para ese caso era necesariamente sin origen. **Este
documento no decide el destino del CHECK** (le corresponde a
`FACT-BORRADOR-001`) — lo declaraba acá como precondición dura, en la
misma categoría que la cadena de HOLD de §6: sin que esa colisión se
resolviera del lado de `FACT-BORRADOR-001`, el caso `NO_ITEMS` de este
documento no tenía dónde escribir sus líneas. **Con `NO_ITEMS` retirado
del alcance (§0, v7.0), esta precondición ya no bloquea nada acá** —
sigue siendo un problema real de `FACT-BORRADOR-001` para SU propio
caso (línea `MANUAL` de un borrador de factura de venta), no de este
documento.

**Corrección post-gate (v4→v5, hallazgo B4; cita corregida en v5→v5.1 —
la query nombrada no existe con ese par, y el mecanismo real es más
preciso de lo que la v5 decía) — abrir la edición línea por línea sin
restricción de sujeto puede producir una NC fail-open O fail-closed, y no
hay una regla acá que lo impida.**

**Corrección de cita:** `getInFlightCreditNoteTotalForPairForUpdate`
**no tiene "un par de reservas"** — el bloque 1c-ii-a ya lo generalizó a
un único método con un discriminador cerrado
(`subject: { kind: 'RESERVATION' | 'ORDER'; id }`, §6 de este mismo
documento lo cita así). Y ese método filtra por **la NC/porción en
vuelo** que generó cada FT revertidora contra `invoiceId` — no por qué
sujeto aparece en las LÍNEAS de la factura — así que una edición manual
de líneas no puede mezclarle sujetos a ESE tope: no lo toca.

**El riesgo real está en los otros dos** (`getIssuedCreditNoteCompensationTotalForReservation()`
/ `getIssuedCreditNoteCompensationTotalForOrder()`, `sql.invoice.repository.ts`)
— esos SÍ atribuyen por origen de línea (`JOIN invoice_items ii ON …
ii.reservation_id = $2` / `JOIN order_items oi ON oi.id = ii.order_item_id
AND oi.order_id = $2`) y sus propios docblocks son los que advierten que
sumar el `imp_total` COMPLETO sin proratear es una propiedad de las 4
ramas de `buildCreditNote()`, no del schema, y que una "5ta rama" que
reparta una NC entre sujetos "quedaría fail-open sin que nada lo
detecte". Una edición manual de líneas, sin restricción, PUEDE mezclar
líneas de más de un sujeto (ej. dos reservas de una consolidada) —
sobre-contando la compensación de cada uno si se cuenta completo por
sujeto vía estas dos queries, o dejándola en cero para ambos si
`NO_ITEMS` obligaba a líneas sin sujeto (B3, esas líneas no matchean
ninguno de los dos JOIN — precondición retirada en v7.0, ver más arriba
en esta misma sección). Este documento NO decide cómo impedir que una
edición manual mezcle sujetos — ver §9 ítem 9, **resuelto en v7.1 por
las reglas 1-2** (prefill obligatorio filtrado al sujeto del ticket +
rechazo duro de cualquier línea de otro sujeto).

**Lo que esto NO decide:** el detalle completo del código nuevo que arma
el request AFIP desde `invoice_draft_items` (bloque de implementación,
fuera de este documento) — solo que, cuando exista, tiene que cumplir
las propiedades de arriba: vincular por `financial_transaction_id`
(nunca `invoice_draft_id`), setear `cbte_tipo` desde `document_kind`,
re-ejecutar los dos topes de NC bajo el mismo lock, satisfacer
`chk_invoice_item_origin` en toda línea agregada a mano — rechazarla si
no lo cumple (**corregido v7.0→v7.1: ya no "bloqueado nombrando el ítem
10"** — con `AMOUNT_MISMATCH` como único motivo, las líneas precargadas
siempre tienen origen real, §0; una línea agregada a mano sin origen es
simplemente inválida y se rechaza al guardar, requisito de
implementación puro, no una precondición externa pendiente), mantener la
clave `invoice:<ftId>`, construir el payload AFIP de nuevo en cada
intento en vez de reusar el persistido, **calcular
`ImpNeto`/`ImpOpEx`/`ImpTotConc` reales a partir del tratamiento que el
operador elige por línea** (nunca hardcodeados a `0`, y nunca heredados
de un catálogo que hoy no tiene ese dato — ver §9 ítem 6, corregido
v6.2→v6.3), y **(agregado v6.6→v6.7, ver §9 ítem 9) precargar
`invoice_draft_items` filtrado al sujeto del ticket, nunca en blanco
(mismo patrón que `invoice.service.ts:909` ya aplica en la rama
automática), rechazar al guardar cualquier línea agregada a mano cuyo
origen sea de OTRO sujeto o que no tenga origen (§0, v7.0: bajo el
alcance vigente ninguna línea sin origen debería llegar a persistirse —
si el guard de arriba funciona, esto es belt-and-braces, no un caso
esperado).**

---

## 7. Dónde se engancha en los dos orquestadores

**Retirado en v7.0 — ver §0.** El `catch` descrito abajo (con la rama
condicional por `reason` para `CreditNoteAttributionBlockedError`) es el
alcance vigente hasta v6.9. Desde v7.0 el `catch` se simplifica a
atrapar ÚNICAMENTE `CreditNoteAttributionMismatchError`, sin condición
— `OrderInvoiceHasNoLinesError` y `CreditNoteAttributionBlockedError`
(con cualquier `reason`) quedan fuera de alcance, no atrapados. Se
conserva sin reescribir como registro histórico.

**Corrección post-gate — el catch original apuntaba a las clases
equivocadas para "solo `NO_ITEMS`" (mismo error de §3, corregido acá en
consistencia).** En `cancel-order-with-credit-note.service.ts` y
`cancel-reservation-with-credit-note.service.ts`, en el `catch` que hoy
distingue `AfipRequestUncertainError`/`AfipRequestRejectedError` (mismo
punto que se evaluó para la alternativa `FAILED` descartada, ver
`docs/pendientes-2026-09-10.md`): agregar una tercera rama que atrapa

- `OrderInvoiceHasNoLinesError` — siempre, sin condición.
- `CreditNoteAttributionBlockedError` — **solo si** `err.reason ===
  'NO_ITEMS'` (el campo nuevo de §3); si `err.reason` es
  `'SUBJECT_NOT_IN_INVOICE'` o `'MISSING_FROZEN_IVA_ENTRY'`, este `catch`
  la re-lanza sin tocarla — sigue propagando el 409 de hoy.
- `CreditNoteAttributionMismatchError` — siempre, sin condición.

y, en cualquiera de los tres casos, crea (o adopta, si ya existe uno para
ese `financial_transaction_id` — el `UNIQUE` de §6 es lo que hace ese
"adoptar" seguro bajo reintentos concurrentes) el `credit_note_request`
**capturando `frozenChargeIds` en la misma fila** (§6 — el catch ya tiene
esos ids en memoria en este punto exacto, es el único momento en que
están disponibles sin re-derivar), y devuelve un resultado tipado
"escalado a revisión manual" en vez de propagar el error 409 de hoy.

**Corrección post-gate (v2→v3) — la reentrancia no es por
`financial_transaction_id` como "clave de idempotencia".** v2 decía que
el reintento era seguro porque el `ADJUSTMENT` "es reentrante (misma
clave de idempotencia)". Impreciso: las claves de idempotencia reales de
cada orquestador son `cancel-order-with-cn:<orderId>`
(`cancel-order-with-credit-note.service.ts`) e
`idempotencyKey(reservationId, invoiceId)` para reservas — ninguna es
literalmente `financial_transaction_id`. Lo que sí es cierto, verificado
tramo por tramo: un reintento con esa clave no re-crea el `ADJUSTMENT`
(el fast-path de "ya cancelada" no aplica, porque la entidad sigue sin
cancelar), tx1 vuelve a entrar, reutiliza el `ADJUSTMENT` existente,
`requestInvoice()` vuelve a tirar el mismo error determinístico, y cae en
el mismo `catch` que este bloque describe. El **id del `ADJUSTMENT` es
estable entre reintentos** — eso es lo que hace determinística la clave
derivada de `invoice_drafts.creation_idempotency_key` en §6
(`credit-note-request:<financial_transaction_id>`), no la clave de
idempotencia del orquestador en sí.

**Ventana no cerrada, declarada en vez de ignorada:** la creación del
ticket ocurre DESPUÉS de que `buildCreditNote()` tira, en una transacción
separada de tx1 (que ya commiteó). Si el proceso muere entre el throw y el
`INSERT` del ticket, el `ADJUSTMENT` queda huérfano SIN ticket — el mismo
fallo original, en una ventana más angosta. No es una regresión permanente:
el próximo reintento del mismo escape (automático o manual) vuelve a pasar
por `buildCreditNote()`, vuelve a fallar igual (determinístico) y esta vez,
si el proceso no muere, llega a crear el ticket. Autosana con un reintento
más, no requiere un mecanismo nuevo — pero requiere que ALGO reintente; si
nadie vuelve a invocar el escape para ese `ADJUSTMENT`, la ventana queda
abierta indefinidamente. Un sweep periódico sobre `ADJUSTMENT`s sin ticket
y sin factura (mismo criterio informal que ya resuelve el "triple sin
nombre" de N11 hoy, sin schema) cerraría esto del todo — no se propone
como parte de este documento, queda nombrado como mitigación futura.

**No decidido en este documento, bloque de implementación aparte:** la
forma exacta de ese resultado (¿un nuevo campo en
`CancelOrderWithCreditNoteResult`? ¿una excepción tipada nueva que el
`route` mapea a un 202/200 con el id del ticket?) y la ruta/pantalla para
que un operador vea la bandeja y complete el borrador — no existe ninguna
pantalla hoy (mismo hueco que `FACT-BORRADOR-001` declara para B3 en
general, "frontend en pasadas posteriores"). Ver §9, pregunta 2, para el
análisis ya hecho de esta primera parte.

---

## 7.1 Quién corre el tx2 del escape cuando la NC se completa a mano

**Corrección post-gate (v2→v3) — hallazgo bloqueante: ninguna sección
anterior asignaba dueño a esto.** §4 termina el diagrama en `invoices`;
v3 comprimía "CAE ok, ledger asentado" en una sola flecha a `RESUELTO`. Esa
flecha, en el camino AUTOMÁTICO de hoy, esconde el tx2 completo de cada
orquestador — y en el camino manual, **nada asignaba quién lo corre** ni
cuándo, con una ventana que pasa de milisegundos (caso automático) a
potencialmente días.

**Corrección post-gate (v3→v4, NEW-1) — la primera versión de esta
sección describía solo la mitad de órdenes y generalizaba desde ahí.**
La tercera lectura del gate encontró que el tx2 de reservas NO es el
mismo mecanismo con otro nombre — tiene una clase de error propia, un
guard adicional que el de órdenes no tiene, y un orden de lock distinto.
Separado explícitamente abajo, en vez de un solo bloque genérico.

**Disparador, corregido (v3→v4, consistente con §6.1):** este tx2 corre
cuando el borrador vinculado alcanza `EMITIDA_PENDIENTE_LEDGER` (CAE
confirmado, D1: nunca antes de eso) — NO en `ISSUED`, que es el ESTADO
RESULTANTE de que este mismo tx2 tenga éxito (§6.1 explica por qué
`ISSUED` como disparador sería circular). Un consumidor NUEVO —no
descrito en ningún documento previo, ni `FACT-BORRADOR-001` ni el ADR
común— tiene que ejecutar, en una transacción propia:

**Corrección post-gate (v4→v5, hallazgos B1/M4) — "toda falla → BLOQUEADA"
no es el conjunto de salidas real de los puertos, y `BLOQUEADA` no es un
estado que `EMITIDA_PENDIENTE_LEDGER` pueda alcanzar (ver §5, corregido).
Reescrito con el conjunto de salidas real y sin ese edge inventado:**

**Caso `financial_transaction_id` del ticket → `order_id`
(`cancel-order-with-credit-note.service.ts`):**

1. Leer `frozen_charge_ids` del ticket (§6 — nunca re-derivado).
2. `OrderCancelPort.cancelForCreditNote(client, orderId, changedBy)`.
3. **Éxito** (`CAMBIO` o `YA_ESTABA` — este segundo caso, "la orden ya
   estaba cancelada por otro camino mientras se editaba el borrador", es
   uno de los más probables cuanto más se estira la ventana manual, no
   una rareza): `settleByIdsWithClient` sobre el `ADJUSTMENT` y sobre
   `frozen_charge_ids` — este éxito es lo que produce la transición del
   borrador a `ISSUED`/`RESUELTO` (§6.1).
4. **No-éxito** (`CreditNoteIssuedOrderNotCancellableError`,
   `NO_EXISTE`, `NO_ELEGIBLE`, `ESTADO_DESCONOCIDO`): el borrador
   **permanece en `EMITIDA_PENDIENTE_LEDGER`** (§5 corregido — no hay
   edge a `BLOQUEADA`) y este paso se reintenta idempotentemente, mismo
   mecanismo de convergencia que `FACT-BORRADOR-001` ya declara para ese
   estado. Un `NO_EXISTE` no va a converger solo (es un problema de
   integridad de datos) — este documento no distingue todavía "reintentar
   para siempre" de "escalar a revisión humana tras N intentos" para ese
   caso puntual; queda como parte del mecanismo de reintento/dead-letter
   ya citado, no resuelto en detalle acá.
5. **Residual declarado, no cerrado (hallazgo M3):** a diferencia del
   caso de reservas de abajo, el tx2 de órdenes **no tiene ningún guard
   de re-verificación** equivalente a
   `CreditNoteReservationInvoiceSetChangedError` — nada re-chequea que la
   orden no haya sido facturada de nuevo por otro camino en la ventana
   (que acá se estira a días). Este documento no agrega ese guard —
   queda nombrado como riesgo residual aceptado, no decidido.

**Caso `financial_transaction_id` del ticket → `reservation_id`
(`cancel-reservation-with-credit-note.service.ts`) — DISTINTO, no una
copia con otro nombre:**

1. Leer `frozen_charge_ids` del ticket.
2. **Lock primero, re-verificación recién después, EL PUERTO AL FINAL** —
   mismo orden que el código real ya impone ("C3 del gate: lock propio
   primero, re-verificación, RECIÉN AHÍ el puerto"), no un detalle
   opcional: `getByIdWithLock` sobre la reserva.
3. **Re-verificar que el conjunto de facturas vinculadas sigue siendo el
   mismo que se revirtió** — el guard que YA existe para cerrar la
   ventana tx1→tx2 en el camino automático
   (`CreditNoteReservationInvoiceSetChangedError`). En el camino manual
   esta ventana es la que más se ensancha (de milisegundos a días) — es
   el punto exacto donde este guard importa más, no uno que se pueda
   omitir por ser "el mismo mecanismo que en órdenes".
4. `ReservationCancelPort.cancelForCreditNote(client, reservationId,
   businessId, changedBy)` — firma distinta a la de órdenes (lleva
   `businessId`), no intercambiable.
5. **Éxito** (`CAMBIO` o `YA_ESTABA`): `settleByIdsWithClient` sobre el
   `ADJUSTMENT` y sobre `frozen_charge_ids` — produce la transición a
   `ISSUED`/`RESUELTO`, igual que en órdenes.
6. **No-éxito** (el guard del paso 3, `CreditNoteIssuedReservationNotCancellableError`
   — clase PROPIA, distinta de la de órdenes, el código ya la separa a
   propósito — `NO_EXISTE`, `NO_ELEGIBLE`): mismo tratamiento que el paso
   4 de órdenes — el borrador permanece en `EMITIDA_PENDIENTE_LEDGER`,
   reintentado idempotentemente, sin edge a `BLOQUEADA`.

**Lo que este documento NO decide:** si "una orden/reserva se cancela
días después de que se disparó su escape" es aceptable tal cual, o si
necesita su propia decisión de negocio (¿hay una ventana máxima? ¿hace
falta re-confirmar con el cliente antes de cancelar tarde?) — nueva
pregunta, ver §9. Tampoco decide el punto exacto en que un reintento
que nunca converge (p. ej. `NO_EXISTE` persistente) debería escalar a
revisión humana en vez de seguir reintentando para siempre — mismo
mecanismo de dead-letter que `FACT-BORRADOR-001` §26.2 ya cita como
precedente, sin especificar acá el umbral.

---

## 8. Permisos

**Corrección post-gate — la premisa "ya exige `EMISOR_NOTA_CREDITO` de
punta a punta" es falsa para el paso que este documento agrega.** La
aserción D de `credit-note-escape-containment.test.ts` congela
exactamente 2 rutas: `POST /:id/cancel-with-credit-note` en
`pos-menu/orders.routes.ts` y en `reservas/reservations.routes.ts`. El
paso de completado manual (§7) **no ocurre en ninguna de las dos** — pasa
en un request separado, más tarde, sobre una ruta que no existe todavía
(la bandeja/edición del borrador de §7/§9). La aserción B tampoco lo
cubre: cuenta call-sites de `cancelOrderWithCreditNote`/
`cancelReservationWithCreditNote`/`authorizeCreditNoteCancellation`, y un
camino nuevo de confirmación de borrador no invoca ninguno de los tres.
**Esto significa que la ruta nueva sería el PRIMER camino que emite una NC
por fuera del cuello de botella con token de marca
(`CreditNoteCancellationAuthorization`)** — exactamente la propiedad de
contención que el capa iv del ADR común protege. No es un detalle menor:
es una consideración de contención que el gate tiene que ver antes de
aprobar cualquier permiso acá.

Con la premisa corregida, la propuesta sigue siendo la misma pero por una
razón distinta: no hay un actor "operativo" separado del "fiscal" en este
flujo (a diferencia de una factura de venta nueva, que CUALQUIER empleado
puede iniciar, motivo real de D4) — así que crear/editar el borrador de NC
Y confirmarlo/emitirlo requerirían los dos `EMISOR_NOTA_CREDITO`, sin el
split de D4. Pero como la ruta nueva queda FUERA del grupo congelado por
la aserción D, esto ya no es "heredado automáticamente" — es una elección
de diseño real, que además implica extender la contención (una nueva
aserción de cerca, o una fila nueva en `ESCAPE_ROUTES`-equivalente, a
decidir con el gate) en vez de solo citarla. Sigue necesitando su propio
`AskUserQuestion` (ver §9, pregunta 1, reformulada).

---

## 9. Qué NO decide este documento — preguntas abiertas para el dueño

**Corrección post-gate (v6→v6.1, sexta lectura, aprobada con
condiciones) — la aritmética de este bloque no cerraba (contaba 11 de
10 filas) y dos párrafos consecutivos se contradecían sobre cuántos
ítems quedaron resueltos, porque v6 movió el ítem 2 al grupo resuelto
sin re-chequear el párrafo de arriba. Reescrito, un solo conteo:**

**Post-gate (v1→v6.1): de las 5 preguntas originales, 3 se resolvieron
directamente en este documento (2, 4, y desde v6 también el ítem 2 con
el detalle abajo — el conteo original de v1→v5.1 incluía solo 2 y 4;
"3" ya contempla el ítem 2), 1 se reformuló porque su premisa era falsa,
1 quedó igual, y se agregaron 5 nuevas a lo largo de las rondas 2 a 4 del
gate.**

**Autoridad de decisión, por pregunta (aclaración del responsable del
proyecto, 12/09/2026) — no todas las preguntas "para el dueño" las
decide la misma persona, y no todas admiten una única respuesta global
para toda instalación del sistema.** Clasificación aplicada acá, por
primera vez en este documento, y con una regla que rige todo lo que
sigue, **corregida en v6.1 de "se hace" a "es candidata a" — 1 y 8
siguen abiertas y son candidatas reales a configuración por tenant; el
ítem 6, corregido en v6.3, resultó ser lo contrario — ni pregunta del
dueño ni candidato a configuración, ver su fila abajo:** una política
del negocio/tenant **es candidata** a
hacerse configurable por tenant en vez de hardcodeada como default
global de la app — pero ninguna configuración de tenant puede desactivar
un invariante fiscal, de autorización, idempotencia o integridad. Eso
último no es negociable ni siquiera como opción de configuración.

| Pregunta | Quién decide | Configurable por tenant? |
|---|---|---|
| 1 (permiso) | **RESUELTO por el dueño (12/09/2026): un solo grupo, `EMISOR_NOTA_CREDITO` de punta a punta, sin el split de D4** — la granularidad por acción (ver/editar/publicar/borrar) queda para una iniciativa de RBAC más amplia, no para este flujo puntual | Ya expresable HOY sin mecanismo nuevo (`role_permission_groups`) |
| 2 (forma del resultado) | Equipo técnico — arquitectura interna, no expuesta al negocio | No aplica (no es política de negocio) — **resuelto en esta versión, ver ítem 2 corregido** |
| 3 (secuenciación de la bandeja) | Equipo técnico — depende de un HOLD externo (`FACT-BORRADOR-001`) | No aplica |
| 6 (`EXENTO`/`NO_GRAVADO` en línea manual) | **Nadie decide SI se permite elegir (invariante AFIP: la ecuación `ImpTotConc+ImpNeto+ImpOpEx+ImpTrib+ImpIVA=ImpTotal` es fija, sin código de error específico pero real, verificada contra `docs/referencia-afip-wsfev1.md`). El contador del tenant SÍ decide QUÉ tratamiento le corresponde a cada línea `MANUAL` — `FACT-BORRADOR-001` §25.7/§25.8 ya dice que una línea manual "elige", nunca "hereda", y que esa elección es materia normativa** | Parcial — la ecuación no es configurable por nadie; la clasificación por línea la resuelve el operador/contador que completa el ticket caso por caso, no una tabla de configuración de tenant |
| 8 (ventana de cancelación tardía) | **RESUELTO por el dueño (12/09/2026): sí, configurable por tenant.** El valor default, el mecanismo de configuración y qué pasa al vencer siguen como bloque de implementación (sin gate todavía) | Sí — confirmado por el dueño |
| 9 (mezcla de sujetos en NC manual) | **RESUELTO (v7.1) — nadie la configura, invariante del sistema, siempre activo.** El negocio puede decidir políticas sobre facturas consolidadas en general, pero NUNCA puede habilitar que una NC mezcle sujetos de forma ambigua | No — esto no es política de negocio, es integridad fiscal obligatoria |

**Corrección post-gate (v6.2→v6.3, séptima lectura) — el ítem 6 se había
cerrado de más en v6.2 (citando una búsqueda web en vez del archivo del
repo, y contradiciendo sin querer una regla vigente de
`FACT-BORRADOR-001`); reabierto como resolución condicional, ver su
fila y su cuerpo abajo. También corregida acá la aritmética de v6.1→v6.2
(sumaba 11, después 10 con un conteo inflado) a una partición de 5
grupos que sí cierra:**

**Corrección post-gate (v6.4→v6.5) — el dueño respondió 1 y 8 (12/09/2026):
se mueven de "pregunta abierta" a "resuelta", la partición se actualiza:**

**Corrección post-gate (v7.0→v7.1) — con `NO_ITEMS` retirado (§0), el
ítem 9 se resuelve (rules 1-2 cierran el riesgo completo para
`AMOUNT_MISMATCH`, ver ítem 9 reescrito) y el ítem 10 queda RETIRADO, no
"precondición externa" — ya no aplica a nada de este documento. Partición
final, sin preguntas abiertas para el dueño:**

| Grupo | Ítems | Cantidad |
|---|---|---|
| Preguntas reales abiertas para el dueño | — (ninguna) | 0 |
| Resueltas por el dueño o directamente en el documento (1, 8 por el dueño; 2, 4 lisas; 6 condicional; 9 por retiro de `NO_ITEMS`) | 1, 2, 4, 6, 8, 9 | 6 |
| Precondición externa (no pregunta de nadie) | 3 | 1 |
| Retirado en v7.0 — ya no aplica a este documento | 10 | 1 |
| Recordatorio, no pregunta | 7 | 1 |
| Organización, baja apuesta | 5 | 1 |

(0 + 6 + 1 + 1 + 1 + 1 = 10, cierra.)

1. **¿El permiso de §8 es correcto, o el completado manual de una NC
   también necesita el split operativo/fiscal de D4** (ej. un rol
   distinto revisa/completa el borrador y otro, más restringido, confirma)?
   **Reformulada:** ya no es una formalidad heredada de la aserción D
   (§8 corrige por qué) — es una elección real, y trae consigo extender
   la contención de NC (nueva cerca o fila nueva, a acordar con el gate)
   para la ruta nueva. Del dueño del negocio + responsable fiscal del
   tenant. **Matiz agregado (12/09/2026):** la respuesta puede no ser
   única para toda la app — un negocio chico puede no tener separación de
   roles real, uno grande sí. **Corrección post-gate (v6→v6.1) — esto
   probablemente NO necesita un mecanismo de configuración nuevo.**
   `role_permission_groups` (`platform.schema.sql`) ya es datos por
   tenant — qué grupos de permiso tiene cada preset de rol se decide hoy
   por negocio, sin tabla nueva (`EMISOR_NOTA_CREDITO` ya está sembrado
   en varios presets). La decisión que sigue siendo global y de código es
   OTRA: cuántos grupos de permiso distintos exige la ruta nueva (¿uno
   solo, o uno para editar el borrador y `EMISOR_NOTA_CREDITO` aparte
   para confirmar, al estilo D4?) — una vez fijados esos grupos, cada
   tenant ya puede asignarlos distinto vía el mecanismo existente, sin
   construir nada nuevo. Ojo con esto al decidir: tratarlo como "hace
   falta una tabla de configuración nueva" arriesga duplicar RBAC que ya
   existe.

   **RESUELTO por el dueño (12/09/2026):** un solo grupo, no el split de
   D4 — `EMISOR_NOTA_CREDITO` de punta a punta, igual que hoy. Motivo
   explícito del dueño: separar por ACCIÓN (ver/editar/publicar/borrar)
   es un eje de granularidad de RBAC más amplio que este flujo puntual,
   y ese eje va a llegar como una iniciativa transversal de RBAC más
   adelante — anticipar acá una partición fina para UN solo flujo
   adelantaría, mal, una decisión que corresponde tomar para TODO el
   sistema a la vez. Un grupo más grande y simple ahora, sabiendo que se
   va a re-granularizar después con ese proyecto más amplio, no como
   parche de este flujo. Cierra este ítem — no llega más al dueño.
2. ~~Forma exacta del resultado que el orquestador devuelve~~ — **RESUELTO
   en este documento, no llega al dueño (aclaración del responsable del
   proyecto, 12/09/2026: es arquitectura interna, no una política de
   negocio).** `CancelOrderWithCreditNoteResult.creditNote` **y**
   `CancelReservationWithCreditNoteResult.creditNote` (misma forma, los
   dos orquestadores — corrección post-gate v6→v6.1: v6 solo nombraba el
   de órdenes) son `Invoice` no-nullable — cualquier resultado de
   escalado los rompe de alguna forma. **Decisión: opción (a), excepción
   tipada nueva** (`CreditNoteEscalatedToManualReviewError`, con el id
   del ticket) que el `route` mapea a 202/200 — no toca ninguno de los
   dos tipos de resultado, y separa dos casos que ya son semánticamente
   distintos (éxito vs. escalado). **Corrección post-gate (v6→v6.1) — el
   motivo original para descartar (b) era falso, verificado y
   reemplazado:** decía que (b) "tocaría un tipo que otros callers de
   backend sí importan" — verificado que
   `CancelOrderWithCreditNoteResult` tiene CERO importadores fuera de su
   propio archivo, y su único consumidor
   (`pos-menu/orders.routes.ts`) hace `res.json(result)`, un pass-through
   que (b) tampoco rompería. El motivo real para preferir (a) es el ya
   dado — separación semántica éxito/escalado — no un caller que se
   protegería.
   **Requisito nuevo, no opcional (mismo criterio que M1/M2/B2 de §6.1):**
   adoptar (a) exige agregar un `case` para
   `CreditNoteEscalatedToManualReviewError` en `domainErrorStatus()`
   (`api/middleware/error.middleware.ts`) — ese switch devuelve **500
   genérico** para cualquier `DomainError.code` sin case explícito (dice
   su propio header), y desde el 09/09/2026 la ruta de órdenes delegó
   toda su lógica de status a ese switch (se le sacó la escalera
   inline). Sin ese `case`, el escalado a revisión manual — el propósito
   entero de este documento — se presentaría al operador como un error
   interno 500, no como "escalado a revisión". También sería el primer
   código de ese switch que mapea a un 2xx en vez de 4xx/5xx — declarado
   acá, no descubierto en implementación.
3. **Bandeja/pantalla** — **reformulada como secuenciación, no como
   diseño:** no se puede planear en serio (ni siquiera como "bloque
   propio o no") hasta que la cadena de HOLD de `invoice_drafts` (C-1 a
   C-4 de §26.1, decisiones de §26.3/§27.2, y el propio §28 de
   `FACT-BORRADOR-001` pendiente de gate) se resuelva — esa tabla no
   existe (verificado, ver §6). Este documento queda bloqueado en esa
   cadena antes que en cualquier decisión propia sobre la bandeja.
4. ~~El CHECK real de `credit_note_request`~~ — **resuelto en este
   documento, no llega al dueño.** §6/§5 (v3) ya definen la regla real —
   sin `discarded_at` propio (v2 lo tuvo, contradictorio con la regla de
   descarte de §5, corregido) —, un `UNIQUE`
   sobre `financial_transaction_id` (la objeción 3 no aplicaba a un
   vínculo 1:1) y un `version` para lock optimista. Ingeniería, no
   producto.
5. **¿Este documento debe fusionarse formalmente dentro de
   `FACT-BORRADOR-001` como una sección más (§29), o queda como documento
   hermano que lo referencia?** Sin cambios: documento hermano,
   referencia cruzada en ambos — preferencia de organización, no técnica.
6. **¿Una línea de NC manual puede usar `fiscal_treatment`
   `EXENTO`/`NO_GRAVADO`? — Resolución CONDICIONAL, no cerrada
   (corrección post-gate v6.2→v6.3, séptima lectura).** v6.2 cerró esto
   de más, citando una búsqueda web en vez del archivo del repo que el
   propio §6 ya cita (`docs/referencia-afip-wsfev1.md`) — mismo error
   que ya causó dos rondas previas de HOLD (citar sin verificar contra
   el artefacto vivo). Reabierto con lo que SÍ verifica y lo que NO:

   - **Lo que sigue firme, verificado contra la referencia local del
     repo, no contra la web:** la ecuación
     `ImpTotal = ImpTotConc+ImpNeto+ImpOpEx+ImpTrib+ImpIVA` es real y
     universal (tabla de validaciones de `referencia-afip-wsfev1.md`) —
     **sin código de error propio** (v6.2 le puso el **10048**
     equivocadamente; ese código es una regla distinta y más específica,
     "Bienes Usados-Monotributista", que no aplica a la NC B que este
     repo emite). No es una decisión de nadie — es aritmética, para
     cualquier tenant.
   - **Lo que v6.2 se equivocó en concluir, y queda retirado:**
     "la línea hereda el `fiscal_treatment` del catálogo" contradice
     directamente `FACT-BORRADOR-001` §25.7 (vigente, no superseded por
     §28.1): *"una línea `MANUAL` no hereda nada: **elige** un
     tratamiento habilitado"* — y §25.8 pone "qué tratamiento le
     corresponde a un bien concreto" explícitamente fuera de alcance,
     "materia normativa, requiere validación profesional". Además,
     `fiscal_treatment` **no existe en ningún lado de `src/` hoy** — lo
     único que existe es `products.iva_rate` (NUMERIC nullable, hereda
     `business_profile.default_iva_rate`), una TASA que no puede
     distinguir `EXENTO` de "gravado al 0%"; `bookable_services`/
     `resources` no tienen ningún campo fiscal. "Heredar del catálogo"
     no es una implementación sobre una decisión ya tomada — es una
     decisión de modelado que ni siquiera existe todavía, y que además
     invertiría una regla vigente de `FACT-BORRADOR-001`. Esa reversión,
     si se quiere, es una decisión de ESE documento y su propio gate —
     no de este.
   - **Lo que queda, entonces, real y sin cerrar:** con la ecuación fija
     (arriba) y sin mecanismo de herencia (§25.7 dice que no lo hay), el
     operador/contador que completa cada línea `MANUAL` de la NC **elige**
     su tratamiento caso por caso — ni configurable por tenant, ni
     heredable automáticamente. El requisito de implementación real es
     que `buildCreditNote()` deje de hardcodear `ImpTotConc`/`ImpOpEx` a
     `0` y calcule esos valores a partir de lo que el operador elige por
     línea (no de una herencia que no existe) — y que la elección quede
     resguardada por el mismo permiso del ítem 1 (quien puede completar
     el ticket), igual que cualquier asiento manual.
   - **No decidido acá:** si además de esto conviene agregar
     `fiscal_treatment` al catálogo de productos/servicios para reducir
     el trabajo manual en el futuro — eso es alcance de
     `FACT-BORRADOR-001` (§25.2/§25.7/§25.8), no de este documento, y
     colisiona con su propia regla de "MANUAL elige, no hereda" tal como
     está escrita hoy.
7. **NUEVO — artefactos RBAC a actualizar cuando la ruta nueva de §7/§9.1
   exista** (no una pregunta de diseño, un recordatorio de qué mover en
   el mismo cambio, nombrados por el gate 2.2 desde el 08/09/2026 sin que
   este documento los hubiera cargado): `EXPECTED_AUTHORIZE_CALL_SITES`
   (`rbac-matrix-sync.test.ts`, hoy 207), el encabezado de conteo de la
   sección 2 de `docs/rbac-matriz-endpoints.md`, y si la ruta cae en
   `facturacion/invoices.routes.ts` — su candidato natural — el
   `hiddenCount: 9` de `EXCLUDED_FILES` en
   `rbac-matrix-section2-sync.test.ts` (ese archivo describe rutas en
   prosa, no en bullets parseables; agregar una ruta sin normalizarlo
   primero pone esa cerca en rojo).
8. **NUEVO (v3, §7.1) — ¿es aceptable que una orden/reserva se cancele
   días después de haberse disparado el escape, si eso es lo que tarda un
   operador en completar la NC a mano?** El camino automático cancela en
   la misma llamada (ventana de milisegundos); el manual estira esa
   ventana a lo que tarde la reconciliación humana, con más chance real
   de que la entidad haya cambiado de estado por otro camino mientras
   tanto. **Corrección post-gate (v4→v5):** el manejo ya no lleva el
   ticket a `BLOQUEADA` (ese edge no existe en el estado real del
   borrador, ver §5/§7.1 corregidos) — el borrador reintenta
   idempotentemente en `EMITIDA_PENDIENTE_LEDGER`. La pregunta de fondo
   se mantiene: ¿alcanza con reintentar para siempre, o hace falta una
   ventana máxima / un umbral de escalamiento a revisión humana / una
   re-confirmación antes de cancelar tarde? **Del dueño del negocio**
   (política comercial: cuánto tiempo es razonable dejar una
   cancelación pendiente) — y, mismo matiz que el ítem 1, candidata a
   ser **configurable por tenant** (una ventana máxima en días,
   configurable, con un default conservador) en vez de una constante
   única para toda la app — alcance no diseñado acá. Cualquiera sea el
   valor, el sistema sigue imponiendo sus propios invariantes (§7.1) por
   encima de la configuración: la ventana no puede convertirse en una
   forma de saltear la re-verificación de estado.

   **RESUELTO por el dueño (12/09/2026): sí, configurable por tenant.**
   Confirma la candidatura de arriba — cada negocio define su propia
   ventana máxima. **No decidido todavía, bloque de implementación
   aparte:** el valor default (conservador, a definir), el mecanismo de
   configuración (columna en `business_profile`, o algo más elaborado) y
   qué pasa exactamente al vencer la ventana (¿escala a revisión humana
   automática, ¿deja de reintentar, ¿solo alerta?) — la política ("sí,
   por tenant") está resuelta, el mecanismo no. Cierra la pregunta de
   política — no llega más al dueño; el mecanismo es bloque de
   implementación, sin gate propio todavía.
9. **Nota v7.1 — ver §0. Con `NO_ITEMS` retirado del alcance, la
   pregunta de UX que este ítem dejaba abierta se DISUELVE — no queda
   re-scopeada, queda resuelta.** Las reglas 1-2 de abajo (precarga
   obligatoria + rechazo de líneas de otro sujeto) ya cierran el riesgo
   completo para `AMOUNT_MISMATCH` (único motivo real desde v7.0, según
   el propio texto de abajo) — la reserva "para `NO_ITEMS` sigue
   bloqueado" ya no aplica a nada, porque `NO_ITEMS` no es más un caso de
   este documento. Este ítem pasa de "1 pregunta de UX pendiente" a
   "resuelto, sin pregunta para el dueño" — ver la conclusión reescrita
   al final de este ítem.

   **NUEVO (v4→v5, hallazgo B4; cita corregida v5→v5.1) — ¿cómo se
   impide que una edición manual de líneas mezcle más de un sujeto
   (reserva u orden) en una NC contra una factura consolidada?**
   `getIssuedCreditNoteCompensationTotalForReservation()`/`...ForOrder()`
   (`sql.invoice.repository.ts`, no el tope por par —ver §6.1— que filtra
   por FT revertidora, no por origen de línea) suman el `imp_total`
   COMPLETO de la NC al sujeto de cada línea sin proratear — una
   propiedad de las 4 ramas de `buildCreditNote()`, no del schema, y esos
   mismos docblocks advierten que una "5ta rama" que reparta entre
   sujetos "quedaría fail-open sin que nada lo detecte". Una edición
   manual sin restricción puede producir exactamente esa 5ta rama por
   accidente — y para el motivo `NO_ITEMS` (líneas sin origen, ver
   pregunta de `chk_invoice_item_origin` en §6.1) ni siquiera hay un
   campo de origen del que derivar el sujeto de una línea para validarlo.
   **Aclaración (12/09/2026): esto NO es una política configurable por
   tenant.** A diferencia de los ítems 1 y 8, acá no hay una
   preferencia legítima de negocio que el sistema deba respetar —
   mezclar sujetos de forma ambigua en una NC es un problema de
   integridad fiscal, no de gusto del negocio, y tiene que bloquearse
   SIEMPRE, para todo tenant, sin excepción configurable. Lo único que
   queda para el dueño del negocio es una pregunta distinta y más
   acotada: si su operación usa facturas consolidadas con `NO_ITEMS` con
   frecuencia, en qué UX evitar que un operador arme sin querer una línea
   ambigua — no si permitirlo.
   **Corrección post-gate (v6→v6.1) — se retira "Del dueño." suelto al
   final: como se aclaró arriba, la mezcla en sí NUNCA es una decisión
   del dueño; lo único que le queda es la pregunta de UX ya acotada en
   el párrafo anterior.**

   **Actualización (v6.6, 12/09/2026; corregida v6.6→v6.7, novena
   lectura) — mecanismo concreto, grounded contra los 5 sistemas de
   referencia (`auditor-circuitos-erp`), ya no "sin propuesta":**

   - **Odoo** copia siempre las líneas del origen al revertir
     (`copy_data(include_business_fields=True)`, nunca un editor en
     blanco) y ata el tope de cada sujeto a `sale_order_line_id` **por
     línea** — una línea agregada a mano sin ese vínculo simplemente no
     descuenta cupo de nadie (`_compute_qty_invoiced()`, docstring:
     *"intentional... risk of reinvoicing automatically"* si se hiciera
     al revés).
   - **ERPNext** es más estricto: rechaza en firme (`frappe.throw`)
     cualquier línea de devolución cuya fila no exista en el documento
     origen exacto. Y para el caso literal de este ítem —devoluciones
     contra una factura que consolidó varios documentos (`POS Invoice
     Merge Log`)— la solución real de upstream (PR `frappe/erpnext#46277`)
     **no fue validar y bloquear una NC mezclada: fue partirla
     automáticamente en una NC por sujeto** (`distinguish_return_pos_invoices()`).
   - **QloApps** persiste el origen a la granularidad exacta que hace
     falta acá (`id_htl_booking` por línea de `order_slip_detail`) —
     mismo nivel que "reserva" en este repo.
   - **Dolibarr**, el único sin origen por línea, es también el único que
     NO resuelve este problema — explícitamente no es el modelo a copiar.
   - **Cloudbeds** ataja el problema ANTES, no al emitir: obliga un folio
     por reserva como precondición para cualquier operación per-reserva
     (mismo espíritu que "prefill obligatorio", aplicado al contenedor
     en vez de a la línea).

   **Por qué el paralelo con Cloudbeds aplica acá, y qué significa
   concretamente (agregado 12/09/2026, a pedido del dueño; corregido en
   la décima lectura del gate — la primera versión de este párrafo
   afirmaba la separación sin distinguir dos niveles distintos, y
   contradecía sin querer la corrección de más arriba sobre `NO_ITEMS`):**
   Cloudbeds necesita el folio como salvaguarda porque, si no separa los
   cargos por reserva desde el principio, se mezclan en una cuenta común
   sin trazabilidad de origen — recién al operar sobre esa cuenta ya no
   hay forma de saber de quién es cada cargo.

   **Acá la separación existe a NIVEL LEDGER, siempre — pero NO a nivel
   línea, para el motivo dominante.** `financial_transactions` (el
   `ADJUSTMENT`, el cargo, etc.) siempre nace con su
   `order_id`/`reservation_id` propio — eso vale incluso para las
   facturas Nivel A de `NO_ITEMS` (la anomalía de "ningún sujeto seteado"
   está contemplada aparte, `invoice.service.ts:973-975`, y es un caso
   de integridad de datos, no la regla). La "consolidada" es una
   agregación al facturar para AFIP; el ledger de abajo nunca pierde de
   quién es cada cargo — eso es lo que hace posible `attributionKey` y
   el patrón de `invoice.service.ts:909` **cuando hay líneas de
   `invoice_items` de las que derivarlo**. Pero para `NO_ITEMS`
   (`refund-attribution.ts`: *"la factura no tiene `invoice_items`...
   9 de las 11 de la tenant `Demo` están en este caso"*) **no hay
   separación a nivel línea que preservar — no hay líneas**. El folio-
   equivalente de Cloudbeds existe en este repo al nivel del `ADJUSTMENT`
   (ledger), no al nivel de cada línea de la factura vieja.

   Lo que este documento agrega es una ventana NUEVA que no existía: un
   editor manual donde un humano tipea/agrega líneas a mano, que podría
   saltarse la separación de línea existente si no se lo obliga a
   trabajar sobre datos ya etiquetados. Por eso la regla 1 (precarga
   obligatoria, nunca editor en blanco) es la pieza que más importa de
   las tres **para `AMOUNT_MISMATCH`** (que sí tiene líneas de origen que
   preservar) — para `NO_ITEMS` la regla 1 precarga cero líneas y queda
   inerte, consistente con la corrección de arriba: ese caso sigue
   bloqueado detrás del ítem 10, no resuelto por esta regla.

   **Corrección post-gate (v6.6→v6.7) — la regla 1 tiene mejor ancla que
   Odoo: ya está implementada en el camino automático de este mismo
   repo.** `invoice.service.ts:909` —
   `originalItems.filter((i) => i.reservationId === reservationId)` —
   YA precarga las líneas de la NC filtradas al sujeto del ticket, antes
   de que este documento existiera. La regla 1 no es una idea nueva
   tomada de Odoo, es continuar un patrón que el propio repo ya aplica
   en la rama automática.

   **Precisión necesaria sobre qué se reusa:** `attributionKey` **no es
   una columna persistida ni un validador compartido** — es un campo de
   la interfaz `FrozenInvoiceItemShare`, derivado por cada call site
   (`i.reservationId` en la rama de reservas; un JOIN a `orderIdMap` en
   la de órdenes). Y por M1 (§6.1), el camino manual **no llama a
   `resolveRefundableForPair()`** — construye desde las líneas editadas.
   Nada de `refund-attribution.ts` se ejecuta en el camino manual; lo
   que se reusa es el PATRÓN (clave de origen opaca por línea, ya
   validado en producción), no el código.

   1. **Prefill obligatorio, no editor en blanco** — precargar solo los
      `invoice_items` cuyo origen coincide con el sujeto del `ADJUSTMENT`
      del ticket, mismo patrón que `invoice.service.ts:909` ya aplica en
      la rama automática (Odoo/ERPNext coinciden en este punto — nunca
      mostrar ítems de OTRO sujeto de la misma consolidada para elegir).
   2. **Rechazo explícito al guardar** si una línea agregada a mano
      referencia un `order_item_id`/`reservation_id` de un sujeto
      distinto al del ticket (ERPNext).
   3. **Corrección post-gate (v6.6→v6.7) — "no consume cupo de nadie"
      era falso contra un tope que este mismo documento exige (B2,
      §6.1).** Hay tres mecanismos de tope distintos, y la afirmación
      original citaba el que NO aplica acá:
      - `distributeGroupAmount()` (el que sí tolera `attributionKey ===
        null`) solo lee `invoice_items` de la factura ORIGINAL — nunca
        ve líneas de la NC. No es el mecanismo relevante para una línea
        manual.
      - `getInFlightCreditNoteTotalForPairForUpdate()` — el tope que B2
        exige re-ejecutar antes de emitir — **no filtra por origen de
        línea**: suma el `imp_total` COMPLETO de la NC contra el sujeto
        del ticket. Una línea sin origen consume ese cupo COMPLETO,
        igual que cualquier otra línea de la NC. Esto es lo correcto y
        seguro (fail-closed sobre el tope), no un hueco.
      - `getIssuedCreditNoteCompensationTotalForReservation()`/
        `...ForOrder()` sí filtran por origen de línea — una línea sin
        origen no le suma nada a NINGÚN sujeto ahí, pero si la MISMA NC
        tiene otra línea con origen de ese sujeto, el `imp_total`
        completo (línea sin origen incluida) igual se le atribuye a ese
        sujeto por esas queries.
      Conclusión corregida: una línea sin origen no crea un hueco de
      tope — el tope real (B2) la cuenta igual, completa, contra el
      único sujeto del ticket. Lo que sí sigue sin sentido es que exista
      una línea "sin sujeto" dentro de un ticket que YA tiene un sujeto
      fijo (§3) — ver el punto siguiente.

   **Corrección post-gate (v6.6→v6.7) — las reglas 1-2 no alcanzan al
   motivo dominante, y la v6.6 cerraba la pregunta sin decirlo.**
   `NO_ITEMS` (`items.length === 0`, `refund-attribution.ts`) y
   `OrderInvoiceHasNoLinesError` (`originalItems.length === 0`,
   `invoice.service.ts`) significan, por definición, que la factura
   original **no tiene ninguna línea** — la regla 1 precarga CERO líneas
   para ese caso, y la regla 2 nunca dispara porque no hay nada
   legítimo contra qué comparar. Cerrado, entonces, solo para
   `AMOUNT_MISMATCH` (que sí tiene líneas de origen). Para `NO_ITEMS` —
   el motivo que este documento mismo llama dominante — el riesgo sigue
   bloqueado detrás de la precondición del ítem 10
   (`chk_invoice_item_origin`, sin resolver, de `FACT-BORRADOR-001`): sin
   una forma de escribir una línea `invoice_items` sin origen, no hay
   ni riesgo de mezcla ni mecanismo que diseñar todavía — la pregunta se
   resuelve sola el día que `FACT-BORRADOR-001` resuelva esa precondición,
   no antes.

   **Conclusión, corregida v7.0→v7.1 — este ítem queda RESUELTO, no
   parcialmente cerrado.** El mecanismo de ERPNext (partir
   automáticamente en N NC si detecta más de un sujeto) no hace falta
   porque cada `credit_note_request` de este documento ya nace acotado a
   UN sujeto (el del `ADJUSTMENT`, §3, verificado: los dos orquestadores
   hardcodean a `null` el sujeto contrario al crear el `ADJUSTMENT` — la
   premisa 1:1 se sostiene por esos dos call-sites y por
   `CreditNoteAmbiguousSubjectError`, no por un CHECK de base; ese guard
   sigue siendo uno de los 3 throws sin verificar independientemente,
   §3). El riesgo real es más chico: un operador agregando por error una
   línea ajena a ESE sujeto, no un ticket que nazca ambiguo — y las
   reglas 1-2 lo cierran completo, porque `AMOUNT_MISMATCH` (único motivo
   real desde v7.0) siempre tiene líneas de origen reales para precargar
   y validar. **No queda ninguna pregunta de UX pendiente para el dueño
   en este ítem** — lo que hasta v6.9 era "para `NO_ITEMS` queda detrás
   del ítem 10" ya no aplica a nada, porque no hay más un caso `NO_ITEMS`
   que necesite ese mecanismo.
10. ~~**RETIRADO en v7.0 — ver §0.**~~ Con `NO_ITEMS` fuera de alcance,
    esta precondición ya no bloquea este documento — `AMOUNT_MISMATCH`
    (el único motivo habilitado ahora) siempre tiene `invoice_items` de
    origen que precargar, así que las líneas que la regla 1 precarga
    (§9, ítem 9) nunca chocan con `chk_invoice_item_origin`. Eso NO es
    una garantía general del CHECK: una línea que el operador agregue a
    mano, fuera de ese precargado (§6.1, "Lo que esto NO decide"), sigue
    teniendo que satisfacer el mismo CHECK o ser rechazada — el punto
    es que `AMOUNT_MISMATCH` siempre tiene con qué precargar, no que el
    CHECK deje de aplicar. Sigue siendo un problema real de
    `FACT-BORRADOR-001` para SU propio caso (línea `MANUAL` de un
    borrador de factura de venta) — no de este documento. Se conserva
    el ítem sin reescribir como registro histórico de por qué existía.

    **NUEVO (v4→v5) — precondición dura sobre `chk_invoice_item_origin`
    (§6.1, hallazgo B3), no una pregunta en sí pero un bloqueo que hay que
    conocer antes de decidir sobre las preguntas 1-9:** el motivo
    `NO_ITEMS` (el dominante de los dos habilitados) produce
    necesariamente líneas de `invoice_items` sin `order_item_id` ni
    `reservation_id` — y el CHECK actual exige exactamente uno de los
    dos. `FACT-BORRADOR-001` declara esta colisión sin resolver (§17,
    §22, §24.4). Este documento no la resuelve — la nombra como
    precondición dura, en la misma cadena de HOLD que `invoice_drafts`
    (§6).

    **Corrección post-gate (12/09/2026) — "Nivel A" NO es un dato de
    prueba de la tenant `Demo`, es un período histórico real, permanente,
    de CUALQUIER tenant.** Verificado contra
    `docs/diseno-facturacion-lineas-nivel-b-2026-08-23.md`: antes del
    corte Nivel A→Nivel B [**corregido v7.0→v7.1: el corte es el bloque
    C3, que consume el modelo Nivel A ya implementado antes en D8 — no
    "implementado en D8" como decía esta oración hasta v7.0**], NINGUNA
    factura de NINGÚN tenant guardaba `invoice_items` — y ese documento declara
    explícitamente *"Facturas viejas (emitidas con Nivel A, sin
    `invoice_items`)... Sin reconstrucción retroactiva. Solo las
    facturas emitidas DESPUÉS de este cambio tienen líneas reales."* La
    cifra "9 de 11" que cita `EXPECTED_THROWS`
    (`build-credit-note-throw-catalog.test.ts`) es la población MEDIDA
    en la tenant `Demo` — no el alcance del problema. Cualquier tenant
    real dado de alta antes del corte tiene el mismo perfil de facturas
    Nivel A, para siempre, por diseño (nunca se reconstruyen).

    **Consecuencia — el escenario "declarar Nivel A fuera de alcance
    porque son datos de Demo" no aplica:** no son datos de Demo, son un
    período real. Y `NO_ITEMS` es, por diseño de este mismo documento
    (§3), uno de los dos motivos que la salida manual HABILITA — el que
    este documento llama dominante. Excluir Nivel A del editor detallado
    dejaría sin resolver exactamente el caso que motivó
    `CN-ESCAPE-ORPHAN-ADJUSTMENT-001` en primer lugar. Por eso este
    documento NO declara Nivel A fuera de alcance — lo declara
    **bloqueado**, honestamente, detrás de la precondición externa de
    arriba: sin que `FACT-BORRADOR-001` resuelva `chk_invoice_item_origin`
    (vía un origen `MANUAL`/`LEGACY_INVOICE` u otro mecanismo — no
    decidido, no es de este documento), el motivo `NO_ITEMS` de la salida
    manual queda implementable en el resto de sus reglas (permiso,
    ticket, tx2) pero sin dónde escribir sus líneas — bloqueado, no
    resuelto, y así lo dice el resto de este documento (§3, §9 ítem 9,
    acá mismo) en ningún lugar como si ya estuviera cerrado.

**Corrección post-gate (v7.0→v7.1) — con el retiro de `NO_ITEMS`, no
queda ninguna pregunta abierta para el dueño en este documento.** 1 y 8
ya los respondió el dueño el 12/09/2026; 2, 4 y 6 quedaron resueltos
directamente en este documento (6 con resolución condicional, v6.3 — no
llega al dueño, pero no es un "resuelto" liso como 2/4); 9 queda
resuelto por el retiro de `NO_ITEMS` (rules 1-2 cierran el riesgo
completo para el único motivo real, `AMOUNT_MISMATCH`); 10 queda
RETIRADO — ya no aplica a este documento, no es una precondición externa
suya. Solo la 3 sigue siendo una precondición externa real
(secuenciación detrás de la cadena de HOLD de `invoice_drafts` en
`FACT-BORRADOR-001`, no una pregunta de nadie).

**Nada de esto se implementa sin pasar primero por `architecture-governor`
— y aunque ninguna pregunta de este documento quede pendiente del dueño,
sigue bloqueado por la precondición externa 3 (secuenciación detrás de
`FACT-BORRADOR-001`) hasta que esa cadena de HOLD se resuelva ahí, no
acá.**
