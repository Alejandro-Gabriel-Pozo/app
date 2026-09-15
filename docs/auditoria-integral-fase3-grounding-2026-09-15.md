# Auditoría técnica integral — Grounding contra sistemas ERP de referencia (complemento a Fase 3)

**Fecha:** 15/09/2026. **Alcance:** solo lectura e investigación externa, ningún archivo de código modificado. Complementa (no repite) `docs/auditoria-integral-fase3-2026-09-15.md` y `docs/auditoria-integral-fase3-duplicacion-2026-09-15.md` — para cada hallazgo priorizado de esos dos informes, se buscó evidencia concreta (código fuente donde estuvo disponible, documentación oficial donde no) de cómo lo resuelven Cloudbeds, Odoo, ERPNext, QloApps y Dolibarr, señalando además dónde esos sistemas **difieren entre sí**, no solo dónde difieren de este repo.

**Nota de procedencia:** este informe fue producido por un agente sin herramientas `Write`/`Edit` (solo lectura + investigación web) y persistido en este archivo por la sesión orquestadora, sin ediciones de contenido.

**Método:** lectura completa de los dos informes de origen; lectura de `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` (que ya contiene grounding ERP extenso sobre la *doctrina de backend* del mecanismo cancelar-con-NC, con citas `archivo:línea` de ERPNext/Odoo 19/QloApps) para no repetir ese trabajo — este informe se concentra en el ángulo que ese documento no cubre: **la UI**, el **rate-limiter**, y **email obligatorio**. Para cada tema: WebSearch + WebFetch sobre documentación oficial y, cuando el sistema es open source y el archivo fue accesible, código fuente real (GitHub raw) con cita de archivo/método.

---

## Tema 1 — F3-01/F3-02/F3-03/F3-04 del informe de flujos: exponer en UI "cancelar con factura ya emitida"

### Contexto del hallazgo original (no se repite el detalle, ver informe fuente)

`app-main/src/facturacion/cancel-with-credit-note.ts`, `cancel-reservation-with-credit-note.service.ts`, `cancel-order-with-credit-note.service.ts`, rutas `POST /:id/cancel-with-credit-note` (rol `EMISOR_NOTA_CREDITO`), `POST /accounts-receivable/:id/reverse`, y `credit-note-requests.routes.ts` — los cuatro con backend completo, probado, con cerca de RBAC dedicada (`CN-ESCAPE-CONTAINMENT-001`), y **cero** consumidores en `appfrontend-main` (grep negativo confirmado en el informe fuente). El botón "Cancelar reserva" existente (`appfrontend-main/src/app/dashboard/reservas/[id]/page.tsx:646-655`) no se ramifica: solo muestra un toast de error que manda al operador "fuera del sistema".

### Grounding — cómo cada sistema de referencia expone esta acción en su UI

**Cloudbeds** (documentación oficial, Help Center — sin código fuente accesible):
- El sistema **no permite reembolsar una transacción que ya tiene factura emitida** — la opción de reembolso queda deshabilitada ("greyed out") hasta que primero se **anule ("void") la factura**. Cuando se anula la factura, el propio artículo de ayuda dice literalmente: *"this action will be reflected on your FACT account and generated as a Credit Note (Nota de Crédito)"* — es decir, Cloudbeds nombra explícitamente "Nota de Crédito" como el resultado, y lo ata al régimen FACT (Argentina). Fuente: [How to void transactions](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/1260805465149-How-to-void-transactions), [Refund reservation payments](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/219779888-Refund-reservation-payments).
- Es una **secuencia forzada de dos pasos** (anular factura → recién ahí reembolsar), no un solo botón con ramas — y cada paso tiene su propio permiso (ver más abajo).
- "Void" solo aplica a autorizaciones/holds y pagos en efectivo dentro de las 24hs; para pagos ya procesados/capturados, el camino real es distinto (reembolso vía el mismo procesador).

**Odoo** (código y documentación oficial):
- La acción vive en la **factura** (`account.move`), no en la orden de venta. Botón **"Credit Note"** sobre la factura validada, que abre un wizard (`account_move_reversal.py`) pidiendo motivo, diario y fecha de reversión; ofrece explícitamente la opción **"Full Refund"**, que crea la NC, la valida y la concilia automáticamente contra la factura original — flujo de un clic para el caso "cancelar factura completa".
- Documentación oficial: *"Issuing a credit/debit note is the only legal method for canceling, refunding, or modifying a validated invoice."* Fuente: [Credit notes and refunds — Odoo 19.0](https://www.odoo.com/documentation/19.0/applications/finance/accounting/customer_invoices/credit_notes.html).
- Código: `addons/account/wizard/account_move_reversal.py` (líneas 15, 66-174, ya citadas en `diseno-cancelacion-con-nota-credito-comun-2026-09-06.md:1081`).

**ERPNext** (código y documentación oficial, `frappe/erpnext`):
- Acción separada: menú **Create → "Return / Credit Note"** sobre el `Sales Invoice`, distinta del botón "Cancel" del mismo documento. La documentación oficial explicita el criterio de cuándo usar cada uno: *"If a customer requests a return before processing a payment, you can simply cancel the Sales Invoice. If your statutory laws don't allow you to cancel the Sales Invoice, you can create a Credit Note against a Sales Invoice."* Fuente: [Sales Return Management](https://docs.erpnext.com/docs/user/manual/en/sales-return-use-cases).
- Es decir: ERPNext también separa explícitamente "cancelar sin más" (pre-pago) de "emitir NC" (post-pago/post-factura) — el mismo criterio que ya adoptó este repo (`findBlockingInvoiceLinkage` bloquea el cancelar directo solo si hay `CHARGE` facturado).
- Código de referencia (ya citado en el ADR del repo): `controllers/sales_and_purchase_return.py:450-758` (`make_return_doc`).

**Dolibarr** (código, `Dolibarr/dolibarr`):
- Botón dedicado **"Generate creditnote"** / "Create credit note" en la ficha (card) de la factura — condicionado por el tipo/estado de la factura (issues reales del repo, p. ej. `#15037`, muestran que el botón se activa/desactiva según si la factura es "situation invoice" u otro tipo especial). Fuente: [GitHub issue #15037](https://github.com/Dolibarr/dolibarr/issues/15037), [Module Customers Invoices — Dolibarr Wiki](https://wiki.dolibarr.org/index.php?title=Module_Customers_Invoices).
- Mismo patrón que Odoo/ERPNext: acción sobre el documento de factura, separada del flujo de cancelación simple.

**QloApps** (código, `Qloapps/QloApps` — ya citado con archivo:línea en el ADR interno del repo):
- Distinto de los tres anteriores: acá la acción vive en el **estado de la orden** (`OrderReturn`/`OrderReturnState`), no en un documento de factura separado — cuando el staff de back office cambia el estado de una solicitud de reembolso a "Refund Completed", el sistema genera el credit slip (o vale/reembolso directo, mutuamente excluyentes). Documentación: [Manage Order Refund request](https://docs.qloapps.com/hrs/manage_refund_request/). Código ya citado en `diseno-cancelacion-con-nota-credito-comun-2026-09-06.md:1083`: `classes/order/OrderReturn.php`, `AdminOrderRefundRequestsController.php:360-600`.
- El gate de habilitación del botón en QloApps es `getTotalPaid() > 0` (equivalente conceptual a "factura viva" en este repo) — ya señalado como precedente directo en el ADR interno (`diseno-cancelacion-con-nota-credito-comun-2026-09-06.md:1031-1038`).

### Diferencias entre sistemas de referencia (no solo "todos vs. este repo")

1. **Dónde vive la acción:** Odoo/ERPNext/Dolibarr la atan al documento de **factura** (acción "Credit Note" sobre `account.move`/`Sales Invoice`/factura). QloApps la ata al **estado de la orden/reserva** (transición de estado dispara la generación del documento). Cloudbeds fuerza una **secuencia de dos pasos obligatoria** (anular factura → reembolsar) en vez de una sola acción con wizard. Esto importa para la recomendación: el diseño ya adoptado en este repo (reserva→factura→NC, con `invoice_items.reservation_id` como ancla — ver `diseno-cancelacion-con-nota-credito-comun-2026-09-06.md:499`) está más cerca del patrón Odoo/ERPNext/Dolibarr (factura como unidad) que del patrón QloApps (orden como unidad), lo cual es coherente con que el ADR interno ya haya citado a ERPNext/Odoo como precedente principal para la doctrina de backend.
2. **Un clic vs. wizard vs. secuencia forzada:** Odoo ofrece "Full Refund" como atajo de un clic para el caso 100% (crea+valida+concilia la NC automáticamente); ERPNext y Dolibarr requieren pasar por el flujo completo de creación de documento (más pasos, pero mismo botón de entrada); Cloudbeds **no tiene un solo botón** — son dos permisos y dos pantallas distintas en secuencia obligatoria.
3. **Granularidad de permisos:** Cloudbeds separa "Void transactions" de "Add Refund" como dos privilegios independientes asignables por rol (fuente: [Role privileges](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/19300997644443-Role-privileges), [Add, edit or delete roles](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/218512377-Add-edit-or-delete-roles)). Odoo/ERPNext/Dolibarr, en cambio, gatean esto con el **grupo genérico de Contabilidad/Facturación** (no hay, por defecto, un rol "emisor de NC" separado de "puede ver/editar toda la contabilidad") — para lograr algo más granular en ERPNext hace falta tocar el Role Permission Manager a mano por doctype. **Este es un dato relevante para una decisión ya tomada en este repo** (06/09/2026, `EMISOR_NOTA_CREDITO` como grupo nuevo, no reutilizar `MANAGEMENT`, ver `diseno-cancelacion-con-nota-credito-comun-2026-09-06.md:1005,1009`): esa decisión está más alineada con la filosofía de permisos granulares de Cloudbeds (el sistema de referencia hotelero) que con la filosofía de grupos amplios de los ERP generalistas — no es una contradicción con nada, es una confirmación adicional post-hoc de que la decisión ya tomada tiene precedente real, no solo teórico.

### Sobre "backend capaz, UI sin conectar" como patrón de release — límite de este grounding

No fue posible conseguir evidencia concreta y citable de si Cloudbeds, Odoo, ERPNext, Dolibarr o QloApps alguna vez liberaron una capacidad de backend equivalente (endpoint completo, probado, con su propio control de permisos) sin consumidor de UI en el mismo release. Para los sistemas cerrados (Cloudbeds) no hay visibilidad de su proceso interno. Para los open source, el histórico de commits/PRs públicos no se revisó en profundidad por tiempo — un único punto de datos parcial: la PR real `frappe/erpnext#20192` ("fix: status of sales and purchase invoice with credit or debit note") toca tanto lógica de servidor como el estado que se refleja en la vista del documento en el mismo PR, lo cual es consistente con (pero no prueba de forma concluyente) la práctica de no separar backend y UI en releases distintos para funcionalidad de cara al usuario. **Se declara este punto como no verificado con la solidez del resto del informe** — no se afirma que ningún sistema de referencia separe backend/UI en release, solo que no se encontró evidencia pública citable de que lo hagan ni de que no lo hagan.

### Recomendación (no implementada, según encargo)

El consenso 5/5 en que esto es una **acción separada del botón "Cancelar"** (nunca la misma acción con una rama oculta) respalda directamente la recomendación ya escrita en F3-01 del informe fuente: exponer "Cancelar con Nota de Crédito" como acción distinta (botón separado o, como mínimo, una segunda opción ofrecida tras el error 409), condicionada al rol `EMISOR_NOTA_CREDITO`/`MANAGEMENT` — no como rama silenciosa del botón de cancelar existente. El patrón Odoo ("Full Refund" de un clic para el caso 100% compensado) es un candidato de UX razonable para el caso más común de este repo (factura íntegramente cubierta por la NC), a evaluar contra el patrón QloApps de bandeja de solicitudes (más cercano a lo que F3-04 ya identificó como pendiente — `credit-note-requests`).

**Extensión a F3-03/F3-04 (reversión de City Ledger y bandeja de reconciliación):** ninguno de los 5 sistemas de referencia expone la reversión de un traspaso a cuentas por cobrar como acción aislada sin relación visual con la factura/reserva de origen — en todos los casos revisados, la acción de reversión/corrección aparece en el mismo lugar donde se ve el documento original (la factura en Odoo/ERPNext/Dolibarr, la orden en QloApps, la transacción en Cloudbeds), no en una pantalla separada sin ese contexto. Esto es un dato adicional a favor de integrar F3-03 en la misma pantalla de cuentas corrientes/City Ledger que ya muestra el traspaso, tal como recomienda el informe fuente — no una recomendación nueva, sino un refuerzo con grounding.

---

## Tema 2 — F3-06: selección de tipo de comprobante (`cbteTipo`) según condición fiscal del receptor

### Contexto del hallazgo original

`app-main/src/facturacion/invoice.service.ts:651,805,879` usa `CBTE_TIPO_FACTURA_B` fijo, sin variar según si el receptor es Responsable Inscripto (que debería recibir Factura A) — hallazgo re-confirmado, sin cambios desde el 02/09, bloqueado por una decisión de producto/fiscal declarada en HOLD (`docs/diseno-fiscal-profile-resolver-2026-09-01.md`).

### Grounding — específicamente Odoo `l10n_ar` (localización argentina real, código accesible)

Por instrucción explícita del encargo, este tema **no** se buscó en sistemas sin integración fiscal argentina (ERPNext, Dolibarr, QloApps no tienen localización AR). Se priorizó Odoo `l10n_ar`, con evidencia de código real:

- **Documentación oficial:** *"The document type and corresponding transactions associated with customers and vendors is defined by the AFIP Responsibility type. This field should be defined in the Partner form."* Fuente: [Argentina — Odoo 19.0 documentation](https://www.odoo.com/documentation/19.0/applications/finance/fiscal_localizations/argentina.html).
- **Código real, confirmado por lectura directa** (`addons/l10n_ar/models/account_move.py`, Odoo 17.0, vía GitHub raw): el método **`_get_l10n_latam_documents_domain()`** construye un dominio de filtro (`domain += ['|', ('l10n_ar_letter', '=', False), ('l10n_ar_letter', 'in', letters)]`) que **restringe los tipos de documento disponibles** (A/B/C/etc.) según las "letras" válidas para la contraparte, resueltas por un método complementario **`_get_journal_letter()`** que toma en cuenta el partner (receptor) de la operación. Hay manejo especial para notas de crédito (códigos 99/186/188/189/60 se permiten fuera de la restricción normal de letra).
- **Configuración adicional confirmada por documentación:** el campo `l10n_ar_afip_responsibility_type_id` en la ficha del partner (Many2one a `l10n_ar.afip.responsibility.type`) es el dato de entrada que alimenta esa resolución — se define una vez en la ficha del cliente, no se recalcula por transacción a mano.
- **Lo que NO se pudo confirmar con el archivo leído:** el detalle exacto de cómo `_get_journal_letter()` combina el tipo de responsabilidad del **partner** con el tipo de responsabilidad de la **compañía emisora** (normalmente Responsable Inscripto emite Factura A a otro RI, Factura B a Consumidor Final/Monotributista) — el archivo fetcheado no expuso ese método completo. Se declara explícitamente como no verificado en detalle, en vez de inferirlo.

### Diferencias entre sistemas de referencia

No aplica — por diseño del encargo, solo se buscó evidencia de un sistema con localización AR real (Odoo `l10n_ar`), así que no hay una segunda implementación con la que contrastar. Se deja constancia de que ERPNext/Dolibarr/QloApps no tienen módulo AFIP nativo — cualquier comparación con ellos en este punto específico sería inventada, y el encargo explícitamente pidió no hacerlo.

### Recomendación

El patrón confirmado en Odoo (resolución de letra de comprobante a partir de un campo de responsabilidad fiscal en la ficha del cliente + reglas de dominio/filtro, no una constante fija) es el **mecanismo genérico esperable** para resolver este hallazgo — coherente con lo que ya describe `docs/diseno-fiscal-profile-resolver-2026-09-01.md` (en HOLD). No se propone una solución nueva: el hallazgo sigue bloqueado por una decisión de producto ya declarada pendiente, tal como señala el informe fuente — este grounding solo aporta una referencia de implementación real (Odoo `l10n_ar`, `addons/l10n_ar/models/account_move.py::_get_l10n_latam_documents_domain()`/`_get_journal_letter()`) para cuando esa decisión se retome.

---

## Tema 3 — F3-02 del informe de duplicación: doble rate-limiter de login

### Contexto del hallazgo original

`authLimiter` (`express-rate-limit`, montado en `app.ts:272` sobre `/api/login`) y `loginRateLimiter` (`Map` en memoria dentro de `auth.routes.ts`) — dos contadores independientes con el mismo umbral hoy (10 intentos/15 min), pero mecanismos distintos, sin que ninguno sepa del otro; el comentario propio de `loginRateLimiter` ya declara que no sirve para multi-instancia. `app-main/render.yaml:5` confirma `plan: free` — Render free tier corre una sola instancia, lo cual reduce el riesgo inmediato pero no invalida el hallazgo de diseño.

### Grounding — cómo protegen fuerza bruta de login los sistemas de referencia

**Frappe/ERPNext** — protección nativa, un solo punto de configuración: lockout con parámetros por defecto **5 intentos fallidos, ventana de 5 minutos, bloqueo de 30 minutos**, configurados centralmente (histórico: `site_config.json`; documentado también como parte de `Security Settings` del framework). Fuente: discusión de GitHub `frappe/frappe#1645` y documentación oficial de rate-limiting del framework, [Rate Limiting — Frappe Framework docs](https://docs.frappe.io/framework/user/en/rate-limiting). El framework además trae rate-limiting HTTP genérico (fixed-window, responde 429) como mecanismo de plataforma, no reimplementado por cada app instalada encima.

**Odoo** — protección nativa **mínima o ausente** por defecto: el propio issue oficial del repo, `odoo/odoo#25696` ("I cant find any bruteforce protection of logins in Odoo 11"), documenta la ausencia histórica de protección de fuerza bruta nativa robusta. La forma real de protegerlo es instalar un **módulo específico** (p. ej. `auth_brute_force`, con parámetros configurables como `auth_brute_force.max_by_ip` = 50 y `auth_brute_force.max_by_ip_user` = 10) — un módulo único, que se convierte en el único punto de control **si se instala**, pero no es parte del núcleo. Fuentes: [Authentication - Brute-Force Filter — Odoo Apps](https://apps.odoo.com/apps/modules/11.0/auth_brute_force), [issue #25696](https://github.com/odoo/odoo/issues/25696).

**Dolibarr** — delega la protección de fuerza bruta **fuera de la aplicación**: retraso ("delay") propio en la página de login + CAPTCHA opcional, pero el bloqueo por IP se resuelve con **`fail2ban` externo** leyendo los logs de intentos fallidos que Dolibarr sí genera. La propia wiki de seguridad del proyecto declara: *"Brute force attacks on login pages are not qualified as vulnerabilities if the recommended fail2ban rules were not installed."* Fuente: [Security information — Dolibarr Wiki](https://wiki.dolibarr.org/index.php/Security_information).

### Diferencias entre sistemas de referencia

Tres filosofías genuinamente distintas, no una sola "buena práctica" uniforme:

1. **Frappe/ERPNext:** protección **nativa, dentro de la aplicación, un solo punto de configuración** (parámetros de lockout centralizados). El más parecido a lo que este repo *debería* tener si decide quedarse con un mecanismo app-level.
2. **Odoo:** protección nativa **débil/inexistente por defecto**, resuelta con **un módulo opcional** — sigue siendo un solo punto de control si se instala, pero la responsabilidad de tenerlo activado recae en cada instalación.
3. **Dolibarr:** protección de fuerza bruta **explícitamente delegada a la capa de infraestructura** (`fail2ban`), no a la aplicación — la aplicación solo genera los logs; el punto de control único vive afuera del código.

Lo que **ninguno de los tres hace** es lo que hace este repo: **dos mecanismos app-level activos simultáneamente y sin coordinación** sobre el mismo endpoint. El denominador común entre las tres filosofías de referencia no es "dónde" vive la protección (dentro de la app como Frappe, opt-in como Odoo, o en infraestructura como Dolibarr) sino que en los tres casos hay **un solo punto de verdad**, sea cual sea la capa elegida.

### Recomendación

Grounding a favor de resolver la pregunta abierta del informe fuente (¿cuál de los dos mecanismos conservar?) por el criterio de "un solo punto de verdad", no por cuál mecanismo es técnicamente superior en aislamiento — ambas opciones (conservar `authLimiter` de `express-rate-limit`, con camino más claro a un store distribuido tipo Redis si Render pasa a multi-instancia, similar en espíritu al parámetro centralizado de Frappe; o conservar `loginRateLimiter` in-memory) son válidas siempre que la otra se retire. No se resuelve acá — sigue siendo decisión del dueño, tal como ya lo declara el informe fuente.

---

## Tema 4 — F3-03 del informe de duplicación: email obligatorio en frontend vs. opcional en backend

### Contexto del hallazgo original

`appfrontend-main/src/app/dashboard/clientes/page.tsx:199-203` tiene `required` en el input de email del modal "Nuevo cliente"; el backend (`app-main/src/clientes-finanzas/customers.routes.ts:73-88`, `CreateCustomerSchema`) trata `email` como "atajo opcional" — solo `displayName`/`fullName` es obligatorio, y el mecanismo de `contactMethods` ya soporta alta con solo teléfono/WhatsApp.

### Grounding — ¿los sistemas de referencia permiten alta de cliente sin email?

**Odoo** — confirmado por lectura directa de código fuente (`odoo/addons/base/models/res_partner.py`, v17.0): el campo es
```python
email = fields.Char()
```
sin `required=True`. Es decir, **a nivel de modelo, el email es opcional** para cualquier `res.partner` (incluidos clientes). Documentación/foros comunitarios confirman además que el campo solo se vuelve obligatorio en un contexto específico y distinto (cuando el partner está vinculado a un usuario del sistema con acceso de login) — no para el caso general de alta de cliente. Fuente: [Don't require email to create customer — Odoo forum](https://www.odoo.com/forum/help-1/dont-require-email-to-create-customer-130642), código citado arriba.

**ERPNext** — confirmado parcialmente por lectura del `customer.json` (doctype `Customer`, `frappe/erpnext`): el campo `email_id` visible en el doctype `Customer` no lleva `reqd: 1` (ausente = opcional por defecto en Frappe). **Matiz declarado:** ese campo específico es de tipo `Read Only`, poblado por `fetch_from: customer_primary_contact.email_id` — es decir, en `Customer` el email real vive en el doctype `Contact` asociado, y no se verificó en este grounding si `Contact.email_id` en sí es obligatorio a nivel de framework. Se declara esto como **no verificado con la misma solidez** que el caso Odoo — el dato confirmado es que el doctype `Customer` (el "cliente" propiamente dicho) no fuerza email como campo propio obligatorio, no que ningún camino de ERPNext lo requiera nunca.

**Dolibarr** — evidencia más débil (documentación/foro comunitario, no código fuente confirmado): la wiki oficial y discusiones de la comunidad son consistentes en que el email no es obligatorio por defecto al crear un tercero (`societe`), y que hacerlo obligatorio requiere configuración/personalización adicional. Se declara explícitamente como evidencia de menor solidez que Odoo (no se confirmó contra el código fuente de `Dolibarr/dolibarr` en este grounding).

**QloApps / PrestaShop** — diferencia real, con causa arquitectónica identificable: el email **es estructuralmente obligatorio**, porque el registro de "cliente" en un sistema construido sobre una base de e-commerce (PrestaShop) **es también la credencial de login** de la cuenta del cliente en el sitio — no es un simple dato de contacto opcional, es el identificador único de autenticación. El flujo de "guest checkout" de PrestaShop captura email igual (para poder ofrecer luego "crear cuenta con este email"), y el propio sistema rechaza duplicados de email entre invitados y cuentas registradas. Fuentes: [PrestaShop guest checkout — Forum/GitHub issues #10122, #23007](https://github.com/PrestaShop/PrestaShop/issues/10122), [QloApps Room Guest Details](https://qloapps.com/qloapps-room-guest-details-2/).

**Cloudbeds** — documentado explícitamente como campo obligatorio no configurable: *"mandatory fields (first and last name, email and country) [...] cannot be removed or made non-mandatory."* Fuente: [Reservation Details Page — Cloudbeds](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/8354513114907-Reservation-Details-Page-Everything-you-need-to-know), [Custom Fields — Cloudbeds](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/218511447-Custom-Fields-Everything-you-need-to-know).

### Diferencias entre sistemas de referencia

Divergencia real de familias de producto, no un matiz menor:

- **ERP/CRM generalistas (Odoo, ERPNext, con evidencia más débil también Dolibarr):** el email es **dato de contacto opcional** en el maestro de cliente — el negocio puede dar de alta un cliente identificado por nombre y, opcionalmente, cualquier canal de contacto (teléfono, dirección, email). Coincide con el diseño actual del backend de este repo.
- **Sistemas de reservas orientados a e-commerce/hotelería (Cloudbeds, QloApps):** el email es **obligatorio por diseño**, por dos motivos distintos entre sí — Cloudbeds lo trata como dato mínimo de contacto del huésped no negociable (política de producto); QloApps/PrestaShop lo requiere porque **es la credencial de autenticación** de la cuenta del cliente en el motor de reservas (razón estructural, no de política).

### Recomendación

No hay un "estándar de industria" único que resuelva esto — la pregunta que ya plantea el informe fuente (¿el negocio realmente quiere email obligatorio en el alta de cliente del dashboard, o el modal debería alinearse con el backend?) sigue siendo genuinamente una decisión de producto, ahora con más contexto: la respuesta correcta depende de qué "personalidad" de sistema está jugando esta pantalla puntual. Si el alta desde el dashboard de `appfrontend-main` es más parecida al alta de cliente de un ERP/CRM (Odoo/ERPNext: mostrador, alta rápida con lo que se tenga) — el backend actual ya es correcto y el frontend debería alinearse (sacar el `required`). Si en cambio esa pantalla cumple el rol de alta de un huésped que va a recibir comunicaciones automáticas o necesita portal propio (más parecido a Cloudbeds/QloApps) — el email obligatorio tiene justificación real y la corrección debería ir al backend, no al frontend, tal como ya sugiere el informe fuente. No se resuelve acá — se entrega el grounding para que la decisión del dueño tenga precedente citable de ambos lados.

---

## Fuentes citadas (todas las URLs usadas en este grounding)

- [Argentina — Odoo 19.0 documentation](https://www.odoo.com/documentation/19.0/applications/finance/fiscal_localizations/argentina.html)
- Odoo GitHub, `addons/l10n_ar/models/account_move.py` (v17.0, vía raw.githubusercontent.com) — método `_get_l10n_latam_documents_domain()`
- Odoo GitHub, `addons/l10n_ar/models/res_partner.py` (v17.0)
- [Credit notes and refunds — Odoo 19.0 documentation](https://www.odoo.com/documentation/19.0/applications/finance/accounting/customer_invoices/credit_notes.html)
- Odoo GitHub, `odoo/addons/base/models/res_partner.py` (v17.0) — campo `email`
- [I cant find any bruteforce protection of logins in Odoo 11 — odoo/odoo#25696](https://github.com/odoo/odoo/issues/25696)
- [Authentication - Brute-Force Filter — Odoo Apps Store](https://apps.odoo.com/apps/modules/11.0/auth_brute_force)
- [Don't require email to create customer — Odoo forum](https://www.odoo.com/forum/help-1/dont-require-email-to-create-customer-130642)
- [Sales Return Management — ERPNext docs](https://docs.erpnext.com/docs/user/manual/en/sales-return-use-cases)
- `frappe/erpnext`, `erpnext/selling/doctype/customer/customer.json` (develop, vía raw.githubusercontent.com) — campo `email_id`
- [Rate Limiting — Frappe Framework docs](https://docs.frappe.io/framework/user/en/rate-limiting)
- [Lockout User After Certain Number of Bad Password Attempts — frappe/frappe#1645](https://github.com/frappe/frappe/issues/1645)
- [Security information — Dolibarr Wiki](https://wiki.dolibarr.org/index.php/Security_information)
- [Module Customers Invoices — Dolibarr Wiki](https://wiki.dolibarr.org/index.php?title=Module_Customers_Invoices)
- [FIX: Create credit note button is not activated on a situation invoice — Dolibarr/dolibarr#15037](https://github.com/Dolibarr/dolibarr/issues/15037)
- [How to void transactions — Cloudbeds Help Center](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/1260805465149-How-to-void-transactions)
- [Refund reservation payments — Cloudbeds Help Center](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/219779888-Refund-reservation-payments)
- [Role privileges — Cloudbeds Help Center](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/19300997644443-Role-privileges)
- [Add, edit or delete roles — Cloudbeds Help Center](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/218512377-Add-edit-or-delete-roles)
- [Reservation Details Page — Cloudbeds Help Center](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/8354513114907-Reservation-Details-Page-Everything-you-need-to-know)
- [Custom Fields — Cloudbeds Help Center](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/218511447-Custom-Fields-Everything-you-need-to-know)
- [Manage Order Refund request — QloApps User Guide](https://docs.qloapps.com/hrs/manage_refund_request/)
- [QloApps Room Guest Details](https://qloapps.com/qloapps-room-guest-details-2/)
- [Creating a customer account from a guest email account — PrestaShop/PrestaShop#10122](https://github.com/PrestaShop/PrestaShop/issues/10122)
- [Unable to create Guest order — PrestaShop/PrestaShop#23007](https://github.com/PrestaShop/PrestaShop/issues/23007)
- Referencias internas ya citadas en `app-main/docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` (ERPNext/Odoo 19/QloApps con `archivo:línea`), reutilizadas sin re-verificar en esta pasada.

## Limitaciones declaradas de este grounding

1. No se consiguió evidencia pública citable sobre si algún sistema de referencia alguna vez liberó backend sin UI conectada como patrón de release (Tema 1) — se declaró explícitamente como no verificado, no se inventó una respuesta.
2. El detalle exacto de cómo Odoo `l10n_ar` combina responsabilidad fiscal del receptor **y** de la compañía emisora para resolver la letra del comprobante no se confirmó completo — el método `_get_journal_letter()` no se leyó en su totalidad.
3. La evidencia de "email opcional" en Dolibarr es de documentación/foro, no de código fuente confirmado — más débil que la evidencia equivalente para Odoo (código) y ERPNext (JSON de doctype, con el matiz declarado sobre dónde vive el campo real).
4. `myfrontdesk.cloudbeds.com` (dominio de documentación de Cloudbeds) bloqueó `WebFetch` directo (egress bloqueado por el proxy del entorno) — toda la evidencia de Cloudbeds de este informe viene de los resúmenes de `WebSearch`, no de lectura directa de la página fuente. Se preservan las URLs para que quien lo necesite las abra directamente.
5. No se corrió ningún test, no se tocó Postgres, no se modificó código en ninguno de los dos repos — mismo alcance de solo-lectura que las fases anteriores.
