# Grounding de industria para las 25 preguntas abiertas — informe para decisión del dueño

**Fecha:** 2026-09-16
**Origen:** agente `auditor-circuitos-erp`, invocado para investigar precedente de industria sobre las 25 preguntas que quedaron sin resolver tras la auditoría técnica integral de 16 fases (16 de `docs/auditoria-integral-fase16-2026-09-16.md` §14 / `docs/plan-integral-sistemico-2026-09-16.md` §4.1, más 9 de `docs/pendientes-2026-09-12.md` §4.2). **Persistido verbatim, sin editar el cuerpo del agente** — mismo criterio que el resto de los documentos de esta auditoría.

Metodología: mismos 5 sistemas de referencia de la Fase 3 (Cloudbeds, Odoo, ERPNext, QloApps, Dolibarr), más OPERA Cloud donde el caso es específicamente multi-propiedad hotelera y normativa ARCA/AFIP donde el caso es fiscal argentino. Todo lo que sigue sale de documentación pública citada al pie; donde la fuente es secundaria (prensa/blogs contables en vez de texto oficial) lo digo explícitamente.

No decido nada acá. Cada bloque cierra con "qué te aporta esto para decidir".

---

## Bloque A — Preguntas de la auditoría de 16 fases

### P-01 (D-03) — Token CUSTOMER alcanzando 4 rutas de staff

**Qué hacen los referentes:**

- **Odoo** separa por *tipo de usuario*, no por permisos: una base tiene Internal User, Portal y Public, y el punto clave es que "la opción de usuario Portal no permite al administrador elegir derechos de acceso" — un portal user **no puede** recibir un grupo de permisos de backend, ni siquiera por error de configuración. Encima de eso, las *record rules* limitan al portal a sus propios registros. O sea: separación estructural **más** ownership, las dos capas, no una u otra.
- **PrestaShop / QloApps**: `Customer` (front office) y `Employee` (back office) son entidades distintas, con cookies y contextos distintos. La doc de desarrollador lo dice sin ambigüedad: los usuarios de front office "tienen todos el mismo nivel de autorización", mientras que los permisos de back office son configurables por empleado. No hay un grupo de permisos compartido entre los dos mundos.
- **Cloudbeds**: el guest portal / booking engine y myfrontdesk son superficies de autenticación distintas; los permisos configurables (roles, asignación por propiedad, permisos de organización) existen sólo del lado staff.

**Consenso:** unánime en los 3 que tienen portal de cliente, y en una dirección que reencuadra tus tres opciones: **la industria hace (a) y (c) juntas** — identidad/tipo separado del staff, con grupos de permisos que sólo existen del lado staff — y usa (b) *además*, como segunda capa dentro del portal (las record rules de Odoo son exactamente `requireOwnReservation`). Ninguno de los tres eligió "mismo endpoint con scope reducido".

**Qué te aporta:** la pregunta deja de ser "¿a, b o c?" y pasa a ser "¿queremos las dos capas (separación de grupo + ownership) o aceptamos una sola?". El precedente dice que (b) sola es la opción más frágil, porque protege ruta por ruta y la ruta número 5 que alguien agregue mañana nace desprotegida — que es exactamente el modo de falla que tus cercas de RBAC ya vienen persiguiendo.

---

### P-02 (D-04) — Tope de vida absoluta de sesión

**Qué hacen los referentes:**

- **PCI DSS 4.0, req. 8.2.8**: re-autenticación obligatoria tras **15 minutos de inactividad**. Dato importante para vos: el propio FAQ del PCI Security Standards Council aclara que el requisito **no está pensado para cuentas de terminales POS que acceden a un solo número de tarjeta por transacción**. O sea, el estándar reconoce explícitamente el caso "mostrador en turno largo" como excepción.
- **PrestaShop/QloApps**: cookie de front office y de back office, ambas con vida por defecto de **480 horas (20 días)**, configurable. Es decir, un PMS open source de referencia corre con sesiones de semanas, no de horas.
- No encontré en ninguno de los 5 un **tope de vida absoluta** documentado como práctica por defecto. Lo que sí es universal es el *idle timeout*.

**Consenso:** no hay consenso sobre tope absoluto — hay consenso sobre que la palanca estándar es **inactividad**, no antigüedad. Y hay una excepción normativa explícita para terminales de venta.

**Qué te aporta:** la pregunta "24-48h sí o no" no tiene precedente que la respalde; la que sí lo tiene es "¿tenemos idle timeout y re-autenticación para acciones sensibles (anular, nota de crédito, arqueo)?". Si el sistema toca datos de tarjeta en algún punto, el 8.2.8 pasa de recomendación a requisito, con su carve-out de POS.

---

### P-03 (D-05) — Vincular un negocio a una organización matriz

**Qué hacen los referentes:**

- **Odoo**: la jerarquía se arma poniendo *Parent Company* en la ficha de la compañía, desde una sesión con derechos sobre ambas. Y el punto crítico de seguridad: "los usuarios deben tener acceso concedido explícitamente a cada compañía — **el acceso no se hereda** por la jerarquía padre-hijo". Vincular no otorga nada por sí solo.
- **Cloudbeds**: cuando varias propiedades se agrupan se convierten en una Organization; **el owner/admin de la organización** es quien administra usuarios y asignaciones de propiedad. El alta es top-down, desde el grupo.
- **OPERA Cloud**: configuración de Chain y de Property viven bajo Administration → Enterprise → Chain and Property; la copia de configuración va de la cadena (o de un template) hacia las propiedades. Top-down otra vez.

**Consenso:** unánime — **ningún sistema de referencia permite que una entidad hoja se sume a un grupo por conocer un identificador**. El vínculo lo origina o lo aprueba quien manda en el grupo. Odoo agrega un matiz valioso: aun después de vincular, el acceso no se hereda.

**Qué te aporta:** tanto (A) token de un uso como (B) solicitud+aprobación cierran el agujero; el precedente favorece la forma de (B) (acto deliberado del lado receptor), pero además señala una tercera cosa que tu pregunta no menciona: **vincular no debería implicar visibilidad automática de datos entre sucursales**. Si hoy vincular sí otorga visibilidad, eso es una decisión aparte que conviene explicitar.

---

### P-05 (D-07) — Tarifas fijas convertidas a porcentuales por backfill

**No aplica grounding.** No es una pregunta de producto sino de estado real de datos. Ningún referente puede decirte qué hacer con filas concretas de tu base; primero hace falta la auditoría de datos (cuántas filas, cuáles se tocaron, si el importe resultante difiere del pactado). Recién con ese dato la pregunta se vuelve decidible.

---

### P-06 (D-09) — Schema completo por tenant vs. atajo en deploy

**No aplica grounding de producto.** Es ingeniería de infraestructura interna (trade-off velocidad de deploy vs. deriva silenciosa de schema). No hay análogo de dominio ERP.

---

### P-07 (D-10) — Clave de idempotencia obligatoria en registrar pago

**Qué hacen los referentes — acá el grounding se parte en dos capas, y esa partición es el hallazgo:**

- **Capa API de pagos (Stripe, como estándar de facto):** clave de idempotencia obligatoria en todo POST, generada por el cliente (UUID v4 sugerido), el servidor guarda código y cuerpo de la primera respuesta —**incluso si fue error 500**— y devuelve lo mismo ante reintento; retención mínima 24h. Es el patrón canónico cuando el que reintenta es una máquina.
- **Capa ERP (Odoo, ERPNext, Dolibarr):** **ninguno usa clave de idempotencia en el alta de pago del operador.** Usan tres cosas distintas: (1) máquina de estados del documento (draft → submitted; el segundo submit no aplica), (2) **advertencia de duplicado** por referencia — Odoo detecta "Duplicated vendor reference" y muestra proveedor, referencia y fecha del duplicado, y la comunidad discute explícitamente "avisar vs. bloquear", (3) la conciliación bancaria como red final: ERPNext documenta el manejo de transacciones bancarias duplicadas como "conservar una válida y cancelar/eliminar las demás".

**Consenso:** no hay consenso transversal; hay consenso **por capa**. Nadie en el mundo ERP le pide al cajero una clave de idempotencia.

**Qué te aporta:** la pregunta real es *quién reintenta*. Si el reintento lo hace el operador tras un timeout visible, el precedente ERP es CAS sobre el estado del documento + advertencia visible de "ya existe un pago de este cliente por este importe hoy" — no una clave. Si en algún momento el endpoint lo va a llamar una integración (pasarela, app externa, canal), ahí la clave pasa a ser obligatoria por el estándar de la otra capa. Son dos requisitos distintos y hoy están mezclados en una sola pregunta.

---

### P-08 (D-12) — Sweep de recuperación del outbox

**No aplica grounding.** Decisión técnica interna de mensajería/confiabilidad.

---

### P-09 (D-13) y P-11 (D-15) — Build/config interno

**No aplica grounding.** Opciones de instalación/configuración de toolchain, sin análogo de producto ERP.

---

### P-10 (D-19) — PDF de comprobantes síncrono en el camino interactivo

**Qué hacen los referentes:**

- **Odoo** genera los reportes PDF de forma **síncrona dentro del request** (QWeb → wkhtmltopdf), y es un dolor documentado en su propio issue tracker: el issue #15458 describe el bloqueo del GIL y las queries congeladas cuando la impresión escala, y el #199880 (Odoo 18) reporta deadlock del HTTPWorker con ~8 requests concurrentes de PDF, reproducible al 100%. O sea: el patrón "síncrono en el request" es el que usa el ERP más grande del grupo, **y le cuesta caro**.
- La salida que aplica el ecosistema no es pre-generar todo: es (1) **guardar el PDF renderizado como adjunto del documento y reutilizarlo** — la referencia de QWeb Reports de Odoo expone esa opción a nivel de `ir.actions.report` — y (2) mandar los lotes grandes a proceso en segundo plano con seguimiento de progreso, dejando el camino interactivo para el documento suelto.

**Consenso:** sí hay patrón resuelto, y tiene dos partes: **documento suelto = on-demand pero cacheado/materializado tras la primera vez; lote = asincrónico**. Nadie pre-genera de forma eager todo comprobante emitido.

**Qué te aporta:** tu caso tiene un agravante que Odoo no tiene: Chromium por PDF es sustancialmente más caro que wkhtmltopdf. El precedente no te obliga a mover la generación al momento de emitir; te sugiere que el punto de mayor retorno es **materializar una vez y servir el archivo** (el comprobante fiscal es inmutable después del CAE, así que re-renderizarlo no aporta nada). Decidir si además se pre-genera al emitir es tuyo.

---

### P-12 (D-18) — Workers/polling y scale-to-zero

**No aplica grounding de dominio ERP.** Es infraestructura, no producto.

---

### P-13 (D-22) — Alineación de versión de Postgres entre entornos

**No aplica grounding.** Ingeniería interna.

---

### P-14 (D-23) — 35 endpoints sin consumidor: qué familia falta de verdad

Clasificación contra los referentes, familia por familia:

**Siempre tienen UI propia en un PMS/ERP del rubro (si no hay pantalla, el módulo no existe en la práctica):**

| Familia | Evidencia |
|---|---|
| `/api/cash-register` | Los 4 lo tienen con pantalla — detalle en P-15 abajo. |
| `/api/cancellation-policies` | Cloudbeds tiene pantalla dedicada ("Set up Cancellation Policies", más Smart Policies); QloApps tiene "Manage Order Refund Rules" en el back office. |
| `/api/rate-catalog` | Rate Plans & Packages es una pantalla núcleo de Cloudbeds, no un detalle. |
| `/api/housekeeping/*` | Cloudbeds tiene página de Housekeeping completa: condiciones Clean/Dirty/Inspected, columna "Assigned To" por mucama, filtros de inspección e integración con el calendario. Es además el módulo que usa **personal que no entra al resto del sistema** — sin UI, literalmente no hay módulo. |
| `/api/stays/*` | Es el folio. En Cloudbeds el Reservation Folio es de primer nivel: split folio, mover transacciones entre folios, facturar cargos individuales. |
| `/api/products/*/stock/*` | Stock con pantalla es núcleo en Odoo, ERPNext y Dolibarr por igual. |
| `/api/reports/pos/*` y `/api/reports/crm/*` | Reportería con UI es estándar en los 5 (Cloudbeds Cashier Report, Account Balances Report; los report builders de Odoo/ERPNext). |
| `/api/invoices/unreconciled` | La conciliación es una pantalla, no un endpoint: ERPNext tiene Bank Transaction y su herramienta de conciliación; Odoo su vista de reconciliación. |
| `/api/locations` | Ver Q22 — es el eje multi-sucursal, con UI en los 3 hoteleros. |
| `/api/users/:id/reactivate` | Archivar/desarchivar usuarios es UI estándar en Odoo. Pantalla mínima, pero existe. |

**Caso intermedio, honestamente discutible:**

| Familia | Evidencia |
|---|---|
| `/api/audit-log` | ERPNext **sí** tiene UI (Document Versioning + Audit Trail que resalta campo y valor cambiados), pero con limitaciones reconocidas por su propia comunidad: los issues abiertos #49089 y #50570 piden justamente un reporte de historial de cambios por período para auditoría y control, y señalan que el Activity Log actual no da visibilidad suficiente a gerentes/auditores. Odoo core no trae pantalla general de auditoría (se resuelve con el módulo `auditlog` de OCA). Conclusión: es estándar tenerlo, pero el estándar de la industria acá es *mediocre*, así que el costo de no tenerlo es bajo hasta que alguien audite. |

**Razonablemente backend-only / superadmin, sin deuda de UI:**

| Familia | Razón |
|---|---|
| `/api/business/modules` | Gestión de módulos/suscripción: en un SaaS multi-tenant esto vive en el back office del proveedor, no en el del cliente. |
| `/api/customers/padron/iva-receptor-types` | Es una **tabla de parámetros** — ARCA publica las tablas de parámetros de condición frente al IVA justamente para consumirlas como catálogo. Alimenta un combo, no una pantalla. |
| `/api/reports/occupancy/purge` | Operación de mantenimiento, no función de negocio. |

**Qué te aporta:** de 15 familias, **10 son módulos que ningún referente entrega sin pantalla**, 1 es discutible y 3 son legítimamente backend-only. La pregunta "¿retirar o completar?" sólo es genuina para esas 4 últimas; para las 10 primeras la pregunta real es de prioridad y de plan comercial, no de si corresponden.

---

### P-15 (D-24) — Circuito de Caja sin pantalla

**Qué hacen los referentes — este es el más contundente de los 23:**

- **Odoo POS**: Cash Control configurable; apertura con monto inicial ("Opening Control"), cierre con conteo de monedas y billetes, cálculo de Cash Count, y cuando lo contado no coincide con lo esperado aparece una ventana de **Payments Difference** que obliga a reconocer la discrepancia. Documentado desde la versión 13 hasta la 19.
- **ERPNext**: **POS Opening Entry** con cantidad por denominación, obligatorio antes de operar; **POS Closing Entry** con recuento por denominación y tabla que muestra Opening / Expected / Closing / **Difference Amount** por método de pago.
- **Cloudbeds**: Cash Drawer + **Cashier Report**, con balance de apertura y cierre, sobrantes y faltantes por turno, monto de cash drop, y envío automático por mail del Drawer Closure Summary a los destinatarios configurados.
- **Dolibarr**: TakePOS con control de caja "del día, del mes, en apertura, en cierre, por terminal", persistido en la tabla `llx_pos_cash_fence`.

**Consenso:** **4 de 4, unánime, incluyendo los dos que no son hoteleros.** Y no es un módulo "avanzado": en ERPNext el POS Opening Entry es *bloqueante* — no podés vender sin abrir caja.

**Qué te aporta:** la pregunta "¿completar o retirar?" no tiene precedente que respalde el "retirar" en un sistema que maneja efectivo. La pregunta real que queda es **quién arquea hoy y con qué** — si ya lo hacen en papel o en una planilla, el backend existente es la mitad cara del trabajo ya hecha; si nadie arquea, entonces la decisión es sobre la operación, no sobre el software.

---

### P-16 (D-25) — Todo sale a Consumidor Final, resolver fiscal desconectado

Este es el único con una fecha externa encima, así que lo separo en dos hechos.

**Hecho 1 — identificación del comprador (no urgente):** según RG 5700/2025 de ARCA, identificar al consumidor final es obligatorio recién cuando la operación **iguala o supera $10.000.000**, sin importar el medio de pago; en ese caso hay que consignar CUIT, CUIL o número de documento. Apellido, nombre y domicilio del comprador pueden omitirse en operaciones con consumidor final. O sea: emitir a "Consumidor Final" sin datos **es legal** por debajo de ese tope.

**Hecho 2 — condición frente al IVA del receptor (sí urgente):** la RG 5616/2024 incorpora como dato **obligatorio** la condición del receptor frente al IVA en el pedido de CAE. Según las fuentes que encontré, **ARCA rechaza automáticamente el CAE cuando ese campo va vacío o nulo a partir del 1/12/2026**, con plazo de adecuación hasta el 30/11/2026. Si eso es correcto, no es una mejora opcional: es una fecha de corte en la que dejarías de poder facturar.

**Hecho 3 — el caso empresa:** para que una empresa use el comprobante como crédito fiscal necesita una factura A con su CUIT. Un comprobante emitido como Consumidor Final no le sirve, y eso rompe estructuralmente el circuito de City Ledger / facturación a empresas post-estadía que ya construiste.

**Advertencia de fuente, importante:** el Hecho 2 lo obtuve de prensa especializada y blogs contables (iProfesional, El Cronista, SIAP/Blog del Contador, Tributo Simple, CajaOS), no del texto de la resolución en el sitio de ARCA. La fecha y el alcance exacto **conviene confirmarlos con tu contador o contra el texto oficial antes de planificar**. Lo que sí es verificable sin discusión es el Hecho 3, que es aritmética fiscal, no normativa cambiante.

**Qué te aporta:** si el Hecho 2 se confirma, la pregunta "¿desbloqueamos el resolver fiscal ahora?" deja de ser una decisión de producto y pasa a ser una fecha en el calendario. Y aun si la fecha se corriera, el Hecho 3 solo ya justifica el trabajo, porque la facturación a empresas es un circuito que ya está construido y hoy emite comprobantes que el cliente empresa no puede usar.

---

## Bloque B — Preguntas de `pendientes-2026-09-12.md`

### `CUSTOMER-EMAIL-REQUIRED-001`

**No aplica grounding.** Una acotación de una línea que salió gratis del research de P-01: si ese campo es lo que habilita el alta de acceso al portal, ahí sí hay precedente (en Odoo el portal user es una identidad con email), así que vale chequear si la pregunta es "validación de formulario" o "requisito para autogestión" — son dos preguntas distintas.

---

### `CANCEL-WITH-NC-UI-001` — Advertencia de deuda mostrada en un toast de 4 segundos

**Qué hacen los referentes:**

- **Odoo** modela explícitamente **dos niveles distintos**: *Warning* (informativo, el usuario sigue) y *Blocking Message* (impide confirmar), configurables por partner con monto de aviso y monto de bloqueo separados. Y cuando el cliente tiene deuda, el monto adeudado **se muestra en el encabezado del formulario del pedido**, de forma persistente — no como notificación que se va.
- **Cloudbeds** trata el saldo como **estado visible permanente del registro**: punto rojo en la barra de la reserva cuando hay saldo pendiente, "Balance due" resaltado en rojo en el panel de reserva para que el front desk lo vea sin abrir el folio, y advertencia al intentar check-in si está activo el requisito de pago total. Su documentación de API agrega que el check-out sólo procede sin saldo abierto.

**Consenso:** unánime en lo que importa para tu pregunta — **ninguno de los referentes comunica una advertencia de dinero mediante una notificación efímera**. Es estado persistente sobre el registro, o mensaje modal en el momento de la acción. Donde sí divergen es en si debe *bloquear*: Odoo lo hace configurable (aviso vs. bloqueo), Cloudbeds bloquea el check-out.

**Qué te aporta:** la opción "está bien como toast" no tiene respaldo en ningún referente. Entre banner persistente y modal de confirmación, el precedente sugiere que **no son excluyentes**: el estado (hay deuda) vive como banner/indicador permanente en la pantalla, y la confirmación aparece en el momento exacto de la acción destructiva. Nota: esto es sólo sobre *presentación*; no toca tu decisión ya cerrada sobre check-out con saldo pendiente.

---

### Penalidad retenida en reembolso parcial

**Qué hacen los referentes:**

- **Cloudbeds**: la política de cancelación se configura **por rate plan / por canal**, con porcentajes propios por plan (los ejemplos de su documentación muestran no-reembolsable 15% de la tarifa base, early booker 10%, temporada alta 25%); los valores "dependen enteramente de vos". Algunos canales admiten monto fijo en vez de porcentaje. Los templates de términos y condiciones incluyen escalas por antelación (ej. cancelación con menos de 60 días: 30% no reembolsable). Y las Smart Policies se **atan a la reserva en el momento de crearla**.
- **QloApps**: las reglas de reembolso son entidades con tipo de pago, **monto a deducir del anticipo o del total**, y **cantidad de días de antelación** antes de los cuales el cliente cobra el reembolso. Sobre eso, el admin aprueba manualmente cada solicitud pudiendo reembolsar total o parcialmente.
- **Odoo / ERPNext / Dolibarr**: no modelan penalidad de cancelación en absoluto — no son sistemas de reserva. La penalidad termina siendo una línea más en la factura o en la nota de crédito.

**Consenso:** entre los dos hoteleros, sí: la penalidad es un **atributo de la política/tarifa**, con escala por antelación, y **se fija al crear la reserva**, no al cancelarla. Ninguno la configura "por negocio entero", y ninguno la configura "por rubro".

**Qué te aporta:** tu premisa ("depende del rubro") no tiene análogo directo — los referentes ni siquiera son multirubro. Pero el eje que ellos sí usan (política/tarifa + antelación, atada al documento al crearse) es más fino que "por rubro" y lo contiene: un spa y un hotel simplemente tendrían políticas distintas. Si el mecanismo se modela a nivel de política, "por rubro" sale gratis como configuración por defecto. La elección del eje sigue siendo tuya.

---

### `credit_note_request` — emisión fiscal de NC que falla de forma ambigua

**Qué hacen los referentes — y acá hay un dato de AFIP que vale más que los 5 sistemas juntos:**

- **AFIP/ARCA lo reconoce como caso conocido y lo resuelve consultando, no adivinando.** El timeout de WSFEv1 deja exactamente tu ambigüedad (¿llegó el pedido? ¿se asignó el CAE y se perdió la respuesta? ¿ni llegó?), y el camino documentado es **`FECompConsultar`**: dado tipo de comprobante, punto de venta y número, devuelve toda la información del pedido de autorización **más el CAE y su vencimiento**. Existe además WSCDC para constatación de comprobantes. Es decir: la incertidumbre es resoluble automáticamente, no es un estado terminal.
- **Odoo (l10n_ar)** implementa justamente eso: botón "consultar comprobante en AFIP" en modo desarrollador para auditar y resolver, más la capacidad de forzar el número de comprobante ante desincronización para recuperar los datos de AFIP. El documento no se marca como fallido irreversible: queda en un estado que un humano resuelve.
- **ERPNext (India Compliance)** es el ejemplo más literal de "bandeja": el IRN que falla deja la factura en estado **Pending** dentro de una **E-Invoice List** filtrable, con generación masiva, log descargable de éxitos y fallos, y re-disparo individual desde el menú de acciones del documento. Más reintento automático durante caídas del portal fiscal.

**Consenso:** sí, el patrón existe y es de **dos partes**: (1) consulta de vuelta a la autoridad fiscal para desambiguar, (2) lista/bandeja persistente de documentos con emisión pendiente, con re-disparo manual y log. Ninguno deja el documento en falla terminal ni manda al usuario a resolverlo afuera del sistema.

**Qué te aporta:** esto es grounding directo del principio que tu propio ADR ya declaró ("la app no le dice al cliente cómo trabajar; le permite formalizar una decisión que ya tomó"). El HOLD sobre la tabla puede reencuadrarse: antes de decidir la forma de la bandeja, conviene ver **cuánta ambigüedad elimina `FECompConsultar`** — si la consulta resuelve el 95% de los casos automáticamente, la bandeja queda para un residuo chico y su diseño se simplifica mucho.

---

### `ORDER-CONSOLIDATED-PARTIAL-01` bloque 1d — consumos parciales de cuenta abierta

**Sí aplica grounding**, y bastante bueno:

- **Cloudbeds** resuelve exactamente el caso F&B a la habitación: el folio admite **split folio** (varios folios en una misma reserva, cada uno con su balance y su factura), **mover transacciones** entre folios (las pendientes una sola vez, las ya posteadas las veces que haga falta), y en la facturación de grupos "ya no es obligatorio facturar un folio entero — podés seleccionar cargos individuales de cada folio y sumarlos a una sola factura". O sea: selección **a nivel de línea** dentro de un documento.
- **ERPNext** confirma que la contracara (la NC granular sobre facturas consolidadas) es un problema real y resuelto upstream: el PR `frappe/erpnext#46277` corrige que se generaba **una sola nota de crédito** sin importar cuántas facturas POS consolidadas distintas originaban las devoluciones, y arregla el enlace incorrecto de los ítems agregando el campo de referencia a la factura POS de origen. El fix es "una NC separada por factura consolidada", con trazabilidad ítem → documento de origen.
- **Odoo POS**, en cambio, es el contraejemplo útil: permite dividir la cuenta por producto o cantidad al momento de pagar, pero en el estándar **no se pueden crear facturas parciales** — de ahí la cantidad de módulos de terceros que llenan ese hueco.

**Consenso:** el lado hotelero (folio) lo tiene resuelto a nivel de línea; el lado POS puro es más débil y lo parchea el ecosistema. La lección repetida entre Cloudbeds y el PR de ERPNext es la misma: **la línea tiene que saber de qué documento de origen viene**, porque si no, la devolución parcial no se puede atribuir.

**Qué te aporta:** valida que el problema no es tuyo solo y que la solución madura pasa por trazabilidad línea→origen, no por prohibir la consolidación. El modelo exacto de consolidación sigue siendo decisión tuya.

---

### `CANCEL-POLICY-SCOPE-BASE-001` Bloque 2 — regla nueva sobre reservas anteriores al campo

**Qué hacen los referentes:**

- **Cloudbeds** es taxativo: una vez creada la reserva con una Smart Policy asociada, **esa política no se puede cambiar**, ni siquiera si la reserva se mueve a otra habitación o a otro rate plan; para cambiarla hay que cancelar y volver a reservar. Y "Cancel for Any Reason" debe elegirse al momento de reservar y **no puede aplicarse retroactivamente**.
- **QloApps** deja la resolución en manos del humano: las solicitudes de reembolso quedan pendientes hasta que el admin las aprueba, y el admin puede reembolsar total o parcialmente "de acuerdo a la regla de reembolso". Si la regla no aplica limpio, hay una persona que define el monto.
- **Odoo / ERPNext** (patrón general de ERP): los cambios en datos maestros no reescriben documentos ya posteados; el documento lleva su propio snapshot en las líneas.

**Consenso:** unánime y en una sola dirección — **snapshot al crear el documento, nunca regla viva sobre documentos existentes**. Y para los documentos que anteceden a la regla, la salida es un default o una resolución manual, **jamás un rechazo**. Ningún referente bloquea una operación porque el documento sea anterior al campo.

**Qué te aporta:** esto convierte tu pregunta binaria en una de tres, donde la tercera es la que usa la industria: ni regla viva ni rechazo, sino **snapshot para lo nuevo + camino manual/default explícito para lo viejo**. Coincide además con el precedente que tu propio repo ya fijó en el caso `CN-ESCAPE-ORPHAN-ADJUSTMENT-001`.

---

### Hueco doble comprobante — ¿liberar el cargo automáticamente tras rechazo de AFIP?

**Qué hacen los referentes:**

- **ERPNext (India Compliance)**: el asiento contable ya está posteado y el paso fiscal tiene ciclo de vida propio. La factura con IRN fallido queda en Pending, aparece en la lista, y se re-dispara manualmente desde el menú de acciones; el reintento automático está previsto **para caídas del portal fiscal** (indisponibilidad), no para errores de validación.
- **Odoo**: la factura queda posteada y el envío electrónico es un estado separado con su error; el usuario corrige y reenvía. En Argentina específicamente, l10n_ar suma el botón de consulta a AFIP y la posibilidad de forzar el número para resincronizar.

**Consenso:** sí, hay patrón, y la línea divisoria es nítida: **fallo transitorio (red, portal caído, timeout) → reintento automático; rechazo por validación (dato mal o faltante) → siempre manual**, porque el dato tiene que cambiar antes de reintentar y una máquina reintentando lo mismo va a fallar igual n veces. Ninguno libera silenciosamente y deja el cargo listo para refacturar sin que un humano vea el error.

**Qué te aporta:** la pregunta "¿automático o manual?" tiene una respuesta de industria condicionada al **tipo de rechazo**, no una respuesta única. Lo que habría que poder distinguir en el código es esa clase de error; si hoy no se distingue, esa es la decisión previa.

---

### `locations` vs `companies` — ¿2 niveles o 3?

**Qué hacen los referentes:**

- **Cloudbeds**: **Organization → Property**, dos niveles. Los usuarios se asignan a propiedades con un rol por asignación ("Add assignment" para múltiples propiedades/roles), y lo que está debajo de la propiedad son habitaciones y tipos de alojamiento, no otro nivel organizativo.
- **OPERA Cloud**: **Chain → Property**, dos niveles, con configuración a nivel cadena que se copia hacia las propiedades.
- **Odoo**: dos niveles en el eje legal/organizativo (compañía y sucursal, que es **la misma entidad con un padre**, no un modelo distinto), y **un eje aparte y ortogonal** para el espacio físico: almacenes y ubicaciones de stock. La doc marca además que, salvo contabilidad heredada del padre, todas las configuraciones se definen por sucursal.

**Consenso:** unánime — **2 niveles en el eje organizativo** (grupo → propiedad/sucursal), y lo físico (habitación, almacén, ubicación de stock) modelado en un **eje separado**, no como un tercer escalón de la jerarquía de negocio. Odoo es el más explícito: sucursal y almacén son cosas distintas que conviven.

**Qué te aporta:** tu par `companies` (matriz) + negocio/sucursal **ya es** el modelo de 2 niveles de la industria. La lectura que sugiere el precedente es que `locations` probablemente no compite con `companies` sino que pertenece al otro eje (el físico/inventario), y que fusionarlos mezclaría dos ejes que los tres referentes mantienen separados a propósito. Con un matiz de Odoo que vale la pena tener presente al decidir: **la configuración no se hereda del padre** (salvo contabilidad) — o sea, el nivel matriz agrupa y consolida, no configura por las sucursales.

---

### 4.3 — Reserva por tipo de unidad con asignación diferida

**Qué hacen los referentes:**

- **Cloudbeds**: la reserva sin habitación asignada es un **ciudadano de primera clase**, no un caso borde. Tiene artículo propio ("Find and handle unassigned reservations"), las reservas sin asignar aparecen como "Unassigned" en la columna de alojamiento y "N/A" en número de habitación, hay una sección de asignaciones pendientes en el calendario, existe **Auto Assign All**, y al mover una reserva a otro tipo de alojamiento se la puede pasar a N/A para que caiga en esa cola. Incluso documentan el riesgo asociado (sobreventa mientras la reserva sigue sin asignar), lo que confirma que la disponibilidad se computa **por tipo**, no por unidad.
- **QloApps**: el objeto que se vende es el **room type**; la disponibilidad se reporta por tipo (habitaciones disponibles, parcialmente disponibles, reservadas, no disponibles) y el admin **reasigna o intercambia habitaciones** manualmente según disponibilidad y preferencia del huésped.
- **OPERA**: la distinción room type / room number es estructural en el producto desde siempre.

**Consenso:** unánime y estructural, no cosmético. Es *el* modelo de datos de la hotelería: se vende inventario por tipo, la unidad física se asigna después (típicamente el día de llegada, para optimizar bloqueos, upgrades y continuidad de estadías).

**Costo de no tenerlo, en concreto:** (1) la conexión con canales/OTAs mapea tipos de alojamiento — vender por unidad concreta obliga a inventar una correspondencia artificial; (2) asignar al reservar fragmenta el inventario y genera huecos que un PMS normal evita reasignando; (3) upgrades, cambios de habitación y manejo de overbooking pasan a ser trabajo manual; (4) los rubros no hoteleros tienen el mismo patrón (un turno con "cualquier profesional disponible" es el mismo problema con otro nombre), así que el gap no es sólo de alojamiento.

**Qué te aporta:** de las 23 preguntas con grounding, esta es la que tiene el respaldo más fuerte y menos ambiguo. No es "¿lo agregamos?" sino "¿en qué momento asumimos el costo de un cambio que toca el núcleo de disponibilidad?" — y ese costo sube con cada mes de datos nuevos bajo el modelo actual.

---

## Cierre — dónde el grounding es decisivo y dónde la decisión sigue siendo tuya

**Donde el grounding cambia la pregunta (la industria ya lo resolvió, y de forma unánime):** las más fuertes son **4.3 (reserva por tipo de unidad)** — es el modelo de datos de la hotelería, no una feature—, **P-15 (caja)** —4 de 4 referentes lo tienen, y en ERPNext hasta bloquea la venta—, **`locations` vs `companies`** —2 niveles organizativos + eje físico separado, coincidente en Cloudbeds, OPERA y Odoo—, **`CANCEL-POLICY-SCOPE-BASE-001`** —snapshot al crear, manual para lo viejo, nunca rechazo—, **P-01** —separación por tipo de identidad *más* ownership, las dos capas—, **P-03** —el vínculo siempre es top-down, nadie se suma a un grupo por conocer un ID—, **`credit_note_request`** —existe el patrón bandeja, y además AFIP ofrece `FECompConsultar` para desambiguar antes de necesitarla— y **`CANCEL-WITH-NC-UI-001`** —ningún referente comunica dinero con una notificación efímera. En todas estas, la pregunta ya no es "¿A o B?" sino "¿cuándo lo encaramos y a qué costo?". Caso aparte y más urgente: **P-16** no es siquiera una decisión de producto — si la RG 5616 se confirma con la fecha que indican las fuentes secundarias, es un vencimiento de calendario, y el caso de factura A con CUIT para empresas ya justifica el trabajo por sí solo, independientemente de esa fecha.

**Donde el grounding informa pero la decisión sigue siendo genuinamente tuya:** **P-02** (no hay consenso sobre tope absoluto de sesión; el estándar es idle timeout, y el PCI hasta exceptúa terminales POS — depende de si hay datos de tarjeta en alcance y de cómo opera tu mostrador), **P-07** (el precedente se parte por capa: clave de idempotencia si el que reintenta es una máquina, estado del documento + advertencia de duplicado si es el cajero — depende de qué integraciones pienses abrir), **P-10** (consenso sólo en "el lote va a segundo plano"; el volumen real de tus comprobantes define si el camino interactivo molesta), **penalidad en reembolso parcial** (los hoteleros la modelan por tarifa/política con escala de antelación, pero ninguno es multirubro — el eje "por rubro" es tuyo, aunque el eje por política lo contiene), **P-14** (el grounding te dice qué familias ningún referente entrega sin pantalla, pero cuáles retirar depende de tu roadmap y de tus planes comerciales), **`ORDER-CONSOLIDATED-PARTIAL-01`** (hay precedente claro sobre trazabilidad línea→origen, pero el modelo de consolidación en sí es diseño propio) y **hueco doble comprobante** (el patrón industria distingue fallo transitorio de rechazo por validación, pero requiere que el código sepa distinguir esos dos casos primero).

**Sin grounding aplicable, confirmado:** P-04 (D-06, retirar/renombrar el endpoint `repair-tenant-db` — no incluido en el pedido de grounding original, agregado acá por ser de la misma clase que las siguientes), P-05 (requiere auditoría de datos propia antes de ser decidible), P-06, P-08, P-09, P-11, P-12, P-13 y `CUSTOMER-EMAIL-REQUIRED-001` — todas de infraestructura, build o validación interna, sin análogo de producto ERP. La única con matiz: `CUSTOMER-EMAIL-REQUIRED-001` deja de ser "validación de formulario" si ese campo es lo que habilita el acceso al portal de autogestión.

---

## Fuentes

**Caja / POS**
- [Odoo 19 — Point of Sale Workflow (apertura y cierre de caja)](https://www.odoo.com/documentation/19.0/applications/sales/point_of_sale/use.html)
- [Odoo 14 — Cash control](https://www.odoo.com/documentation/14.0/applications/sales/point_of_sale/shop/cash_control.html)
- [ERPNext — POS Opening Entry](https://zikpro.com/erpnextdocs/pos-opening-entry/)
- [ERPNext — Point of Sale (manual v13)](https://docs.erpnext.com/docs/v13/user/manual/en/accounts/point-of-sales)
- [Cloudbeds — Cashier Report](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/25931992998683-Cashier-Report)
- [Cloudbeds — Close Cash Drawer and generate a cashier's report](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/360059266553-Close-Cash-Drawer-and-generate-a-cashier-s-report)
- [Dolibarr Wiki — Module Point of sale (TakePOS)](https://wiki.dolibarr.org/index.php/Module_Point_of_sale_(TakePOS))
- [Dolibarr Wiki — Table llx_pos_cash_fence](https://wiki.dolibarr.org/index.php/Table_llx_pos_cash_fence)

**Reservas por tipo de unidad / housekeeping / folio**
- [Cloudbeds — Find and handle unassigned reservations](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/217997178-Find-and-handle-unassigned-reservations)
- [Cloudbeds — Move Reservations From An Accommodation Type to a New One](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/14741132209563-Move-Reservations-From-An-Accommodation-Type-to-a-New-One)
- [Cloudbeds — Housekeeping room conditions](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/216540808-Housekeeping-room-conditions)
- [Cloudbeds — Housekeeping filters (Inspection table)](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/25727203533851-Housekeeping-filters-Inspection-table)
- [Cloudbeds — Manage Split Folio in reservation](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/360002778113-Manage-Split-Folio-in-reservation)
- [Cloudbeds — Updated Group Invoicing: More Flexibility and Control](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/41211873232667-Updated-Group-Invoicing-More-Flexibility-and-Control)
- [QloApps — Manage Room Types](https://docs.qloapps.com/catalog/manage_room_types/)
- [QloApps — partially available room feature](https://qloapps.com/partially-available-room-feature/)

**Políticas de cancelación y reembolso**
- [Cloudbeds — Set up Cancellation Policies](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/222401327-Set-up-Cancellation-Policies)
- [Cloudbeds — Smart Policies FAQ](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/44193585068059-Smart-Policies-FAQ)
- [Cloudbeds — Distribution Channel Rate Plans](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/220703588-Distribution-Channel-Rate-Plans)
- [Cloudbeds — Cancel for Any Reason FAQ](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/39346559617947-Cancel-for-Any-Reason-FAQ)
- [QloApps — Manage Order Refund Rule](https://docs.qloapps.com/hrs/manage_refund_rules/)
- [QloApps — Manage Order Refund request](https://docs.qloapps.com/hrs/manage_refund_request/)

**Multi-propiedad / jerarquía**
- [Odoo 19 — Multi-company](https://www.odoo.com/documentation/19.0/applications/general/companies/multi_company.html)
- [Odoo 19 — Companies](https://www.odoo.com/documentation/19.0/applications/general/companies.html)
- [Cloudbeds — Organizations, everything you need to know](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/1260803386269-Organizations-Everything-you-need-to-know)
- [Cloudbeds — Organization user permissions](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/4402912536603-Organization-user-permissions)
- [OPERA Cloud — Configuring Chain](https://docs.oracle.com/en/industries/hospitality/opera-cloud/23.4/ocsuh/t_admin_configuring_chain.htm)
- [OPERA Cloud — Configuring Properties](https://docs.oracle.com/en/industries/hospitality/opera-cloud/22.5/ocsuh/t_admin_configuring_properties.htm)

**Identidad, portal y sesión**
- [Odoo 19 — Users (Internal / Portal / Public)](https://www.odoo.com/documentation/19.0/applications/general/users.html)
- [Odoo 19 — Access rights](https://www.odoo.com/documentation/19.0/applications/general/users/access_rights.html)
- [PrestaShop DevDocs — Users (front office vs back office)](https://devdocs.prestashop-project.org/8/development/components/users/)
- [PrestaShop — Duración de cookies de Back Office (issue #12043)](https://github.com/PrestaShop/PrestaShop/issues/12043)
- [PCI SSC FAQ — propósito del requisito 8.2.8 (15 min de inactividad)](https://www.pcisecuritystandards.org/faq/articles/Frequently_Asked_Question/what-is-the-purpose-of-pci-dss-requirement-8-2-8-which-requires-users-to-reauthenticate-after-15-minutes-of-idle-time/)

**Pagos, duplicados, advertencias**
- [Stripe — Idempotent requests](https://docs.stripe.com/api/idempotent_requests)
- [Stripe — Designing robust and predictable APIs with idempotency](https://stripe.com/blog/idempotency)
- [Odoo — Duplicated vendor reference al crear facturas de proveedor (issue #59685)](https://github.com/odoo/odoo/issues/59685)
- [Odoo — Customer Credit Limit With Warning and Blocking](https://apps.odoo.com/apps/modules/15.0/om_credit_limit)
- [ERPNext — Bank Transaction (manejo de duplicados en conciliación)](https://docs.frappe.io/erpnext/bank-transaction)
- [Cloudbeds — Check-in y check-out (saldo abierto)](https://developers.cloudbeds.com/docs/check-in-upsell-upgrade)
- [Cloudbeds — Reservation Details Page (indicadores de saldo)](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/8354513114907-Reservation-Details-Page-Everything-you-need-to-know)

**Fiscal / facturación electrónica**
- [ARCA/AFIP — Datos de los comprobantes (emisión y autorización)](https://www.afip.gob.ar/fe/emision-autorizacion/datos-comprobantes.asp)
- [AFIP — Actualización del importe para identificar consumidores finales](https://servicioscf.afip.gob.ar/publico/sitio/contenido/novedad/ver.aspx?id=4511)
- [Límite para facturar a consumidor final sin datos (tusfacturas, sept. 2026)](https://www.tusfacturas.app/cual-es-el-limite-facturacion-afip-a-consumidor-final-sin-especificar-datos.html)
- [Condición IVA del receptor en facturas electrónicas — RG 5616 (CajaOS)](https://www.cajaos.com/blog/condicion-iva-receptor-factura-electronica-rg-5616) *(fuente secundaria — confirmar fecha y alcance con el contador)*
- [ARCA rechazará facturas sin condición de IVA del receptor (SIAP / Blog del Contador)](https://siap.blogdelcontador.com.ar/novedades/arca-rechazara-facturas-sin-condicion-iva-receptor-diciembre-2026/) *(fuente secundaria)*
- [AFIP WSFEv1 — timeout y desambiguación](https://sites.google.com/site/facturaelectronicax/wsfev1/wsfev1/wsfev1-fallos-conexi%C3%B3n/wsfev1-time-out)
- [PyAfipWs — Constatación de comprobantes (WSCDC)](https://sistemasagiles.com.ar/site/websites/otros_webservices/constatacion_comprobantes.html)
- [Odoo — Localización fiscal Argentina (l10n_ar)](https://www.odoo.com/documentation/17.0/es/applications/finance/fiscal_localizations/argentina.html)
- [ERPNext / India Compliance — e-Invoice Generation and Cancellation](https://docs.indiacompliance.app/docs/ewaybill-and-einvoice/generating_e_invoice)
- [frappe/erpnext PR #46277 — NC separada por factura POS consolidada](https://github.com/frappe/erpnext/pull/46277)

**PDF / reportes**
- [Odoo — QWeb Reports (referencia de desarrollador)](https://www.odoo.com/documentation/19.0/developer/reference/backend/reports.html)
- [odoo/odoo issue #15458 — performance de reportes PDF (GIL, queries congeladas)](https://github.com/odoo/odoo/issues/15458)
- [odoo/odoo issue #199880 — deadlock de HTTPWorker con PDFs concurrentes](https://github.com/odoo/odoo/issues/199880)

**Auditoría / versionado**
- [ERPNext — Document Versioning](https://docs.erpnext.com/docs/user/manual/en/document-versioning)
- [Frappe — Audit Trail](https://docs.frappe.io/framework/user/en/audit-trail)
- [frappe/erpnext issue #49089 — pedido de reporte de historial de cambios para auditoría](https://github.com/frappe/erpnext/issues/49089)

**POS y facturación parcial**
- [Odoo 16 — Bills (split bill en restaurante)](https://www.odoo.com/documentation/16.0/applications/sales/point_of_sale/restaurant/split.html)

---

## Apéndice A — Correcciones del gate (`architecture-governor`, 16/09/2026)

Verificación independiente previa al commit. **El research de industria
no se pudo reproducir:** este gate no tiene acceso a búsqueda web, así
que **ninguna afirmación sobre Cloudbeds, Odoo, ERPNext, QloApps,
Dolibarr, OPERA Cloud o ARCA fue corroborada contra su fuente**. Lo que
sí se verificó es coherencia interna, calibración de los cuantificadores
contra la evidencia que el propio documento presenta, y fidelidad a las
25 preguntas tal como están en `plan-integral-sistemico-2026-09-16.md`
§4.1/§4.2 (y, donde hizo falta, contra
`auditoria-integral-fase16-2026-09-16.md` y
`pendientes-2026-09-12.md`). El cuerpo (líneas 1-393) **no se edita** —
misma convención que las Fases 12 a 16 y que el plan integral. Ninguna
conclusión se retira: las ocho correcciones son de cifra, de
cuantificador y de aparato de cita, salvo A.6, que corrige una pregunta
mal representada.

Lo que se verificó y quedó confirmado sin cambios: el mapeo completo
`P-01`..`P-16` → `D-XX` (los 16 coinciden con §4.1); los 9 ítems de
§4.2, todos con bloque; las 25 preguntas presentes en el Cierre sin que
se caiga ninguna (9 + 7 + 9 = 25); los 16 bloques con grounding que
cierran con "Qué te aporta" (16 de 16, medido); "35 endpoints sin
consumidor" contra `fase16:364` (29 paths / 35 métodos); el encuadre de
D-25 y su Hecho 3 contra `fase16:366` (la factura a empresa sin CUIT no
sirve como crédito fiscal está en la fuente); el encuadre de D-24 contra
`fase16:365` (la fuente también se inclina a "incompleto", no a
retirar); y la **advertencia de fuente secundaria del Hecho 2 de P-16**,
que aparece en cuatro lugares —metodología (`:6`), hedges dentro de la
afirmación (`:176`), párrafo propio en negrita (`:180`) y arrastrada al
Cierre (`:308`)— más dos anotaciones en Fuentes: **está donde tiene que
estar, no enterrada**. Escaneo de instrucción encubierta sobre este
documento: **sin hallazgos** (0 caracteres zero-width/bidi/BOM, sin
instrucciones dirigidas a un lector o agente, 24 dominios todos
coherentes con el contenido citado).

### A.1 — "23 preguntas con grounding" son 16

`:302` dice *"de las 23 preguntas con grounding"* y `:157` *"el más
contundente de los 23"*. El propio documento se desmiente dos veces:
tiene **16** bloques con "Qué te aporta" (medido), y su Cierre `:312`
lista **9** preguntas *"sin grounding aplicable"*. 25 − 9 = **16**.

El 23 no sale de la nada: es exactamente el número de encabezados `###`
del documento (medido). Pero los encabezados son otra cosa — 23
encabezados cubren 24 preguntas (P-09 y P-11 comparten uno; P-04 no
tiene ninguno), y 7 de esos encabezados dicen "No aplica grounding".

Debe leerse, en `:302`: *"de las **16** preguntas con grounding…"*. Y en
`:157`: *"este es el más contundente **de los 16 bloques con
grounding**"*, sujeto además a A.2.

### A.2 — Dos bloques distintos reclaman ser el más fuerte

`:157` declara a **P-15 (Caja)** *"el más contundente"*; `:302` declara
a **4.3 (reserva por tipo de unidad)** *"la que tiene el respaldo más
fuerte y menos ambiguo"*. Son dos superlativos sobre el mismo eje y no
pueden ser los dos ciertos. El Cierre `:308` resuelve el empate de
hecho —lista 4.3 primero y P-15 segundo— pero nunca declara el criterio.

Debe leerse: **4.3** conserva el superlativo global (es el único caso
donde el consenso es *estructural*: el modelo de datos, no una
funcionalidad); **P-15** pasa a *"el más contundente **por unanimidad
del conteo**: 4 de 4, incluidos los dos referentes que no son
hoteleros"*. Son dos formas distintas de ser fuerte y el documento
tiene evidencia para distinguirlas.

### A.3 — P-14: la suma de familias da 14, no 15, y falta el bloqueo que la fuente declara

**(i) Aritmética.** `:151` dice *"de 15 familias, 10 son módulos que
ningún referente entrega sin pantalla, 1 es discutible y 3 son
legítimamente backend-only"*. 10 + 1 + 3 = **14**.

El **15 es el correcto** — `fase16:626` pregunta por *"cuáles de las 15
se retiran"* y `fase16:364` enumera exactamente 15 familias. El error
está en el **10**: la primera tabla tiene 10 *filas*, pero una de ellas
—`/api/reports/pos/*` y `/api/reports/crm/*`— agrupa **dos** familias
que la fuente cuenta por separado. Son **11** familias en 10 filas.

Debe leerse: *"de 15 familias, **11** son módulos que ningún referente
entrega sin pantalla (en 10 filas: `reports/pos` y `reports/crm` van
juntas), 1 es discutible y 3 son legítimamente backend-only"*.

**(ii) Precondición omitida, más importante que la aritmética.** El
bloque cierra con *"La pregunta '¿retirar o completar?' sólo es genuina
para esas 4 últimas"*, sin mencionar que la fuente **condiciona toda la
pregunta**. `fase16:626` la enuncia en dos partes: *"Con el artefacto de
consumo verde: familia por familia… **Y previamente: ¿existe algún
consumidor de la API fuera de estos dos repos?** — la auditoría no pudo
descartarlo"*. Y `fase16:57` / `:589` son explícitos: *"Borrar sin
artefacto de consumo es el modo de falla de `CONTRACT-001` al revés"*,
con *"cero borrados en este bloque"* como criterio de aceptación.

Debe agregarse: *"**Nota del gate:** nada de esto habilita un borrado
todavía. `fase16:626` antepone una pregunta que la auditoría no pudo
responder —¿hay consumidores de la API fuera de estos dos repos?— y
`fase16:57`/`:589` fijan **cero borrados** hasta que exista el artefacto
de consumo verde en las dos direcciones. Este grounding informa **qué
familias corresponden**; no levanta el bloqueo sobre **retirar**
ninguna."*

### A.4 — "ningún referente entrega sin pantalla" descansa, según la familia, en 1 solo sistema

`:151` afirma que 10 (11, ver A.3) familias son *"módulos que **ningún
referente** entrega sin pantalla"*. La tabla que lo sostiene tiene una
base de evidencia que va de 1 a 5 sistemas por fila:

| Familia | Sistemas citados en la tabla |
|---|---|
| `/api/rate-catalog`, `/api/housekeeping/*`, `/api/stays/*` | **1** (solo Cloudbeds) |
| `/api/users/:id/reactivate` | **1** (solo Odoo) |
| `/api/cancellation-policies` | 2 (Cloudbeds, QloApps) |
| `/api/invoices/unreconciled` | 2 (ERPNext, Odoo) |
| `/api/locations`, `/api/products/*/stock/*` | 3 |
| `/api/cash-register` | 4 |
| `/api/reports/pos/*`, `/api/reports/crm/*` | 5 |

En housekeeping y folio el caso es más agudo: son módulos que los tres
referentes no hoteleros **no tienen en absoluto**, así que no pueden
ser evidencia ni a favor ni en contra — el cuantificador universal
recorre un conjunto de tamaño 1.

Esto no vuelve falsa la conclusión, que sigue siendo plausible. Vuelve
falso el *"ningún referente"*. Y contrasta con la disciplina que el
propio documento ejerce en P-15 (*"4 de 4"*), P-01 (*"unánime en los 3
que tienen portal de cliente"*) y penalidad (*"entre los dos
hoteleros"*): el documento sabe escopear; acá dejó de hacerlo.

Debe leerse: *"…**11 son módulos que ningún referente de los que tienen
ese módulo entrega sin pantalla** — con la salvedad de que en
`rate-catalog`, `housekeeping`, `stays` y `users/reactivate` ese
"ninguno" recorre **un solo sistema**, porque los demás no tienen el
módulo"*.

### A.5 — Otros dos cuantificadores universales sobre base parcial

Mismo patrón que A.4, en dos bloques que el Cierre clasifica como
*"unánime"*:

- **P-03, `:50`:** *"**ningún sistema de referencia** permite que una
  entidad hoja se sume a un grupo por conocer un identificador"*. La
  evidencia cubre Odoo, Cloudbeds y OPERA Cloud — **3**, y uno de ellos
  (OPERA) está fuera de los 5 sistemas base. ERPNext, QloApps y
  Dolibarr no se tratan.
- **`CANCEL-WITH-NC-UI-001`, `:201`,** repetido en el Cierre `:308`:
  *"**ninguno de los referentes** comunica una advertencia de dinero
  mediante una notificación efímera"* / *"ningún referente comunica
  dinero con una notificación efímera"*. La evidencia cubre Odoo y
  Cloudbeds — **2 de 5**.

Las dos afirmaciones son probablemente ciertas; ninguna está mostrada.
Importa porque en los dos casos el documento usa esa unanimidad para
**descartar una de las opciones del dueño** (en
`CANCEL-WITH-NC-UI-001`, textualmente: *"la opción 'está bien como
toast' no tiene respaldo en ningún referente"*).

Debe leerse: en P-03, *"ninguno de **los 3 que investigué** (Odoo,
Cloudbeds, OPERA)…"*; en `CANCEL-WITH-NC-UI-001`, *"ninguno de **los 2
que investigué para esta pregunta** (Odoo, Cloudbeds)…"*, en el cuerpo
y en el Cierre.

### A.6 — `CUSTOMER-EMAIL-REQUIRED-001`: el documento contesta otra pregunta, y esa otra reabre una decisión ya cerrada

`:190` reencuadra el ítem como *"vale chequear si la pregunta es
'validación de formulario' o 'requisito para autogestión' — son dos
preguntas distintas"*. **No es la pregunta abierta.**

`pendientes-2026-09-12.md:922-939` la define: el dueño **ya decidió**
*"email obligatorio, sin excepción — se elimina el alta solo-teléfono"*
(`decisiones-auditoria-fase3-2026-09-15.md` §2), el schema lo cumple, y
lo que queda abierto es un **escape hatch de API**:
`customers.routes.ts:625-637` deja que un `contactMethods` explícito sin
canal EMAIL prevalezca, de modo que el email que el schema exige *"pasa
la validación pero nunca se persiste"* y el cliente *"queda creado sin
ningún email real"*. Sin caller real hoy. La pregunta de §4.2 es
*"¿corregir el escape hatch o aceptarlo?"*.

El reencuadre del documento no es neutral: al plantear si el email es
"solo validación de formulario", **sugiere que podría no ser
obligatorio** — que es exactamente lo que el dueño ya cerró. El costo es
bajo (el bloque está marcado "No aplica grounding" y son dos renglones),
pero el encuadre no puede quedar en pie.

Debe leerse: *"**No aplica grounding.** La decisión de fondo —email
obligatorio, sin excepción— **ya la tomó el dueño**
(`decisiones-auditoria-fase3-2026-09-15.md` §2); lo que queda abierto no
es si el email hace falta, sino si se cierra un bypass de API
(`customers.routes.ts:625-637`) que hoy permite crear un cliente sin
email real, sin caller conocido. Eso es integridad de datos, no
producto: ningún referente puede decidirlo. El único aporte lateral del
research de P-01 es que en Odoo el portal user **es** una identidad con
email, lo que sube la consecuencia de ese bypass si mañana el email
habilita el acceso al portal — no la cambia hoy."*

Y en el Cierre `:312`, la frase *"La única con matiz:
`CUSTOMER-EMAIL-REQUIRED-001` deja de ser 'validación de formulario'
si…"* debe leerse: *"La única con matiz: el bypass de
`CUSTOMER-EMAIL-REQUIRED-001` sube de severidad si ese campo pasa a
habilitar el acceso al portal de autogestión."*

### A.7 — Dos desajustes menores entre el cuerpo y el Cierre

**(i) P-10 queda subdeclarado en el Cierre.** El cuerpo `:100` afirma un
patrón resuelto **de dos partes**: *"documento suelto = on-demand pero
cacheado/materializado tras la primera vez; lote = asincrónico"*, y su
"Qué te aporta" `:102` señala que la primera mitad es *"el punto de
mayor retorno"*. El Cierre `:310` lo reduce a *"consenso sólo en 'el
lote va a segundo plano'"*, perdiendo justo la mitad que el cuerpo
destaca. Debe leerse: *"P-10 (consenso en dos partes —lote a segundo
plano y documento suelto materializado tras la primera vez—; lo que
queda abierto es si además se pre-genera al emitir, y el volumen real de
tus comprobantes define si el camino interactivo molesta)"*.

**(ii) P-04, "confirmado".** `:312` lo agrupa bajo *"Sin grounding
aplicable, **confirmado**"* mientras la misma línea revela que *"no
[fue] incluido en el pedido de grounding original"*. La revelación es
honesta y este gate la verificó: `P-04` aparece **una sola vez en todo
el documento** (`:312`), no hay cobertura simulada en ninguna parte. Pero
"confirmado" es la palabra equivocada para lo único que no se
investigó. Debe leerse: *"P-04 (D-06… — **no investigado**: no entró en
el pedido de grounding original; se lo clasifica acá por ser de la misma
clase que las siguientes, sin research propio)"*. Con eso, el conteo
honesto del documento es **24 preguntas investigadas + 1 clasificada por
analogía**, no 25 investigadas.

### A.8 — Dos precisiones de aparato de cita

**(i) §4.2 no es de `pendientes`.** El encabezado `:4` cita *"más 9 de
`docs/pendientes-2026-09-12.md` §4.2"*. Verificado: ese archivo **no
tiene ninguna §4.2** — sus encabezados son títulos en prosa, no
numerados. §4.1 y §4.2 son secciones de
`plan-integral-sistemico-2026-09-16.md`. Los 9 ítems **se originan** en
`pendientes`; la numeración es del plan. Debe leerse: *"…más 9 de
`docs/plan-integral-sistemico-2026-09-16.md` §4.2, originadas en
`docs/pendientes-2026-09-12.md`"*. Es el mismo modo de falla que A.1 del
apéndice del plan integral: un `§` citado sin su documento dueño.

**(ii) Tres de las cinco fuentes del Hecho 2 no están linkeadas.** La
advertencia `:180` nombra cinco medios —iProfesional, El Cronista,
SIAP/Blog del Contador, Tributo Simple, CajaOS— pero la lista de Fuentes
solo linkea **dos** (CajaOS `:374`, SIAP `:375`). iProfesional, El
Cronista y Tributo Simple no tienen URL, así que el contador no puede
retrazarlas. En la única afirmación del documento con fecha límite
regulatoria encima (rechazo de CAE desde el 1/12/2026), tres de cinco
fuentes citadas son irrecuperables. **No invalida la advertencia** —que
este gate confirma presente, visible y repetida en cuatro lugares— pero
la lista de Fuentes debe agregar las tres URL faltantes o la línea `:180`
debe nombrar solo las dos que sí quedan linkeadas.
