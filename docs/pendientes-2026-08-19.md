# Pendientes — Miércoles 19 de Agosto 2026 (sesión de auditoría de producto)

Arranca a partir de dos documentos de producto entregados en esta sesión
("hallazgos-criticos-producto.md" + addendum de segunda pasada) que
auditan `app-main` contra hallazgos de PO + especificación formal +
video del tenant demo. La auditoría distingue lo que YA está resuelto en
el código real (no reimplementar) de lo que falta de verdad. Ver también
`pendientes-2026-08-18.md` para lo heredado de sesiones anteriores (mail,
PDF de factura, calendario, etc. — todo ✅ resuelto ahí a esta altura).

---

## A. Resuelto en esta sesión

- ✅ **Forma de pago en el comprobante AFIP (schema v28)** — corrección a
  la auditoría original: decía "cero campos, cero referencias
  (formaPago/medioPago/paymentMethod)" tanto para `Invoice` como para
  `FinancialTransaction`. Falso para `FinancialTransaction`
  (`payment_method`/`card_installments` ya existían completos —
  cash-register, orders, customer-account.service.ts). El gap real,
  más acotado: `Invoice`/`InvoicePdfService` nunca los leían, el
  comprobante impreso no mostraba cómo pagó el cliente pese a que el
  dato ya estaba cargado. `invoices.payment_method`/`card_installments`
  nuevos, congelados de la `FinancialTransaction` de origen al crear el
  comprobante (R9) — se imprimen como "Cond. Venta" en el PDF
  ("Contado"/"Tarjeta de Crédito/Débito (N cuotas)"/etc.). Verificado
  con un PDF real generado localmente (mismo fixture de comprobante-5).
  Commit `565b571`.
- ✅ **Factura B no discriminaba IVA (Ley 27.743 / RG 5614/2024 ARCA)**
  — bloqueante legal. El bug estaba en el template `.hbs` de
  `@arcasdk/pdf` (branch `cbteLetra="B"` nunca renderizaba el desglose),
  no en `app-main`. Parcheado vía `patch-package`, agrega la caja
  "Régimen de Transparencia Fiscal al Consumidor" con IVA Contenido +
  Otros Impuestos Nacionales Indirectos. Verificado con los números
  reales del comprobante-5 (Hotel ZULU): $59.355,37 de IVA, exacto.
  Commit `15b6328`.
- ✅ **Búsqueda server-side de productos** — `GET /api/products?q=`,
  mismo criterio que `?name=` de clientes. El filtro SQL ya existía sin
  usarse. Commit `8bfb055`.
- ✅ **Calendario de Reservas no mostraba habitaciones OUT_OF_SERVICE**
  — confirmado que era 100% un gap de frontend (el bloqueo de escritura
  ya funcionaba). `RoomCalendar.tsx` ahora rayó esas filas y les saca el
  click de "nueva reserva". Commit `3188f91` (appfrontend-main).
- ✅ **Reportes de ocupación no descontaban OOO del total disponible**
  — cierra del todo el punto crítico #1. `generateOccupancySummary()`,
  `generateOccupancyByResourceType()` y `getUnderutilizedResources()`
  excluyen recursos OUT_OF_SERVICE antes de agregar. Commit `3f3d762`.
- ✅ **Perfil fiscal de cliente + consulta al padrón de ARCA (backend)**
  — conecta la decisión de arquitectura del 18/08/2026 que había quedado
  solo en un comentario (`customer_tax_profiles` existía en `schema.sql`
  sin repositorio ni consumidor). `SqlCustomerTaxProfileRepository` +
  `PadronService` (`getTaxpayerByCuit`/`resolveCuitByDni`/
  `getIvaReceptorTypes`, ws_sr_padron_a5/a13) + rutas nuevas bajo
  `/api/customers` (`:id/tax-profile`, `padron/lookup-by-cuit`,
  `padron/lookup-by-dni`, `padron/iva-receptor-types`). "Proveedor"
  como concepto quedó explícitamente fuera de esta ronda (decisión
  confirmada con el dueño). Commit `83df646`.
  ✅ **Frontend agregado (19/08/2026, commit `8a6b0ab`,
  appfrontend-main)** — sección "Datos fiscales" en el modal "Editar
  cliente" de la pantalla de Clientes: alta manual + "Buscar por DNI"
  (encadena resolver CUIT → traer datos del padrón, un solo click) +
  "Buscar" junto al campo CUIT/CUIL. Sección oculta entera si el
  negocio no tiene el módulo Facturación habilitado.
  **Todavía sin verificar contra el padrón real** — no hay credenciales
  AFIP en este entorno de desarrollo (ni backend local levantado), el
  mapeo de la respuesta se basó en leer el código fuente del SDK, no en
  una llamada real, y la UI tampoco se probó visualmente en navegador.
  Primer chequeo pendiente en producción: abrir un cliente, usar
  "Buscar por DNI" o "Buscar" con un CUIT real, y confirmar que razón
  social/condición IVA/domicilio vienen poblados y que "Guardar datos
  fiscales" persiste bien (reabrir el modal debe traer lo guardado).

- ✅ **Puerto + adapter para @arcasdk/core en `InvoiceService`** (a
  pedido explícito del dueño, arquitectura para poder cambiar de SDK de
  facturación sin tocar lógica de negocio). `afip-billing.port.ts` +
  `arca-sdk-billing.adapter.ts` nuevos — `InvoiceService` ya no importa
  ningún tipo de `@arcasdk/core`. Commit `0042022`. No es un pendiente
  en sí, mejora interna — se anota acá por completitud del registro de
  la sesión.

## B. Confirmado ya resuelto (no reimplementar)

- Housekeeping↔Reservas, bloqueo de escritura (`isOutOfService()` en
  `reservation-availability.service.ts`).
- IVA discriminado en el cálculo interno (`invoice-pdf.service.ts` arma
  bien `impNeto`/`impIva`/`alicuotaIva` — el gap era solo el template,
  ver punto A).
- Empresa/Plan: gate `requirePlan(ENTERPRISE)` en `POST /api/companies`,
  402 con `plan`/`requiredPlan` en el body.
- Búsqueda de clientes por email/nombre (`?email=`/`?name=`) — mejor de
  lo que el hallazgo original reportaba.
- Categorización de productos por rubro (`categoryId` ya existe).
- Merma como módulo propio del backend (`waste-reason.service.ts`) — el
  hallazgo de "jerarquía de menú" es 100% IA de frontend, nada que tocar
  en `app-main`.

---

## C. Decisiones de negocio SIN resolver — no implementar hasta que se definan

Registradas tal cual pide el documento de auditoría, con las preguntas
sin responder.

### C1. Seña / depósito como concepto de facturación separado
Hoy no existe ningún concepto de seña/depósito parcial — se factura el
total o nada. Preguntas sin responder:
1. ¿La regla de seña (ej. 30% o 50%, sin cerrar el número) vive en el
   producto/servicio, en una política general del negocio, o en ambas
   (producto pudiendo sobreescribir la general)?
2. ¿Se puede facturar la seña como comprobante propio (Factura B
   parcial), separado del comprobante final? Choca con la limitación
   actual de "un monto único por comprobante" (ver C3).
3. Al facturar el saldo final, ¿cómo se descuenta lo ya cobrado como
   seña? (vive en Cuentas Corrientes — hay que ver si el modelo actual
   soporta pagos parciales previos asociados a una reserva).

### C2. Reglas de cancelación → Notas de Crédito por %
Depende de C1 (si la devolución aplica sobre el total o sobre la seña) y
de que exista soporte de Notas de Crédito/Débito (no existe hoy — hay
que confirmar primero qué expone `@arcasdk/core` para esto, mismo
patrón que WSFEv1 en `invoice.service.ts`, no una implementación
paralela). Preguntas sin responder:
1. % de devolución en función de la anticipación al check-in al momento
   de cancelar — la escala exacta no está definida.
2. ¿La devolución aplica sobre el total facturado o sobre la seña
   cobrada? Son dos escenarios distintos.

### C3. Modelo de factura — ítem único vs. multi-línea
`invoice-pdf.service.ts` arma la descripción del ítem como un string
fijo ("Servicios"/"Productos"), sin referenciar el producto real ni la
reserva facturada — porque `Invoice`/`FinancialTransaction` representan
un monto único, sin desglose de líneas (documentado a propósito en el
código). Antes de tocar esto, decidir:
1. ¿Se pasa a un modelo de líneas reales por comprobante (schema de
   `invoices` y probablemente `financial_transactions`)? — cambio de
   modelo grande, no un fix chico.
2. O, más acotado: ¿alcanza con que el ítem único arme una descripción
   legible a partir de qué generó la transacción (nombre de
   reserva/producto), sin desglosar en múltiples líneas?

**No elegir ninguna opción de C1/C2/C3 sin el dueño — son decisiones de
negocio, no técnicas.**

---

## D. Backlog confirmado pendiente (no bloqueado por decisiones de negocio)

Orden sugerido por la auditoría, sin lo ya resuelto en la sección A:

1. **`repair-tenant-db` expuesto** (`src/platform/admin.routes.ts`,
   `/api/admin`) — protegido solo con `Roles.MANAGEMENT` (un Admin de
   tenant normal puede llamarlo), debería requerir un rol de
   PLATAFORMA, no de tenant. El propio comment del archivo ya dice que
   se puede borrar sin efectos secundarios una vez que no se necesite.
2. **Invitación de usuarios** — alta hoy es directa con contraseña
   tipeada por un tercero; falta invitación por mail real (Resend, ya
   integrado) + link de aceptación. Cero código de invite/invitation en
   `usuarios-roles/` hoy.
3. **Protección de datos fiscales del negocio** —
   `business-profile.routes.ts` solo tiene GET/PUT planos bajo
   `Roles.MANAGEMENT`, sin bloqueo tras la primera carga ni auditoría
   para CUIT/razón social/domicilio fiscal. Patrón de referencia YA
   resuelto en el mismo repo: `afip-credentials.repository.ts`
   (`getStatus()` vs. `getDecrypted()` separados) — no es el mismo
   mecanismo 1:1 (estos datos no son un secreto, son inmutables tras
   confirmación), pero es la referencia de diseño a seguir.
4. ✅ **RESUELTO (backend, 19/08/2026) — Clientes, ABM fiscal.**
   `customer.entities.ts` sigue sin CUIT/condición IVA/domicilio (a
   propósito, ver decisión del 18/08 — identidad básica y fiscal son
   conceptos separados) pero ahora existe `CustomerTaxProfile` +
   `SqlCustomerTaxProfileRepository` con esos datos, y `PadronService`
   para autocompletarlos por CUIT o DNI (ver sección A). Bloqueante de
   Factura A destrabado del lado del dato. **Todavía falta**: la
   búsqueda de clientes POR CUIT/DNI (extensión de la búsqueda
   multicriterio existente, `?email=`/`?name=`) no se construyó — lo
   que se conectó es la consulta AL padrón de ARCA (autocompletar desde
   afuera), no una búsqueda contra los perfiles fiscales ya cargados en
   la propia base. Y sin UI en `appfrontend-main` todavía.
5. **Tarifas especiales — precio fijo vs. porcentaje** — cambio de
   modelo, no de UI. `CustomerRate.price: number` es override absoluto;
   pasar a `discountPercentage` implica decidir migración de tarifas ya
   cargadas (¿se recalculan a % contra el precio base actual, o quedan
   "legacy fixed"?) — **sin definir, no asumir ninguna opción**. El
   modelo de "catálogo de tarifas reutilizables" (nombre + % + a qué
   aplica) que pide la especificación tampoco existe hoy — es un
   rediseño de tabla.
6. **Número operativo de Reserva** (y de Cliente, mismo mecanismo) —
   `Reservation.ts` (v9) no tiene número secuencial visible para el
   staff, solo `id` interno. Diseñar como un mecanismo reutilizable
   (secuencia por negocio, prefijo configurable) desde el arranque, no
   como dos soluciones ad hoc para Cliente y Reserva por separado.
   Extensión sugerida: prefijo por empresa cliente (relevante para
   negocios `BusinessPlan.ENTERPRISE`).
7. **Reportes — POS/Restaurante y CRM** — PMS y Financiero ya tienen
   reportes reales (`reports.routes.ts`); faltan específicamente ventas
   por producto/mermas/ticket promedio (POS) y clientes nuevos vs.
   recurrentes/tarifas aplicadas (CRM). Cero endpoints hoy.
8. **Productos — IVA por producto, unidad de medida, código ARCA** —
   hoy la tasa de IVA es global del negocio
   (`business_profile.default_iva_rate`); sumar el campo por producto
   destraba además el punto de "IVA no debe vivir en Mi Negocio" de la
   especificación.
9. ✅ **CORRECCIÓN (19/08/2026) — Clientes, catálogo de tags: NO es un
   gap, ya está implementado completo.** Anotado ayer como "sin
   confirmar" — verificado hoy: `tags`/`customer_tags` existen en
   `schema.sql`, y `SqlCustomerRepository.getTagsByCustomerId()`/
   `getAllTags()`/`findOrCreateTagByName()` ya las usan de punta a
   punta. Se saca de la lista de pendientes.

## E. No verificable desde `app-main` — pendiente confirmar con el frontend

- **Estadías — selector de check-in**: probablemente ya soportado por
  `stays.routes.ts` (varios GET), el trabajo real parece ser de UI
  (autocompletado + filtro a próximas 48-72hs). Confirmar antes de
  tocar backend.
- **Identidad de negocio — reestructurar en secciones** (Identidad /
  Datos fiscales / Horarios / Alojamiento): es IA de frontend; el
  backend ya soporta el desglose en la medida que D3 (protección de
  datos fiscales) separe ese endpoint del resto.
