# Pendientes — Domingo 23 de Agosto 2026

Arranca a partir de `pendientes-2026-08-22.md` (que sigue siendo la fuente
completa de lo ya resuelto hasta ese día: C1-Fase A, C2, C3, D6, D7, D8,
D9-Parte 1/2). Este archivo nuevo existe por dos motivos: (1) el trabajo de
hoy (auditoría de los 9 archivos de pendientes, 08-10 a 08-22) encontró
ítems reales que se habían perdido sin cerrar ni descartar explícitamente,
y (2) el trabajo de ayer (Nivel B de facturación por líneas, C3) había
quedado anotado dentro del `-22.md` en vez de abrir uno nuevo, rompiendo el
propio patrón de "un doc por sesión" — no se repite acá, ya quedó
registrado ahí.

---

## 🔴 URGENTE — ✅ RESUELTO Y VERIFICADO EN PRODUCCIÓN (23/08/2026)

Fix desplegado (commits `34cf958`, `f99a712`, `05d1ad4`, backend;
`e533e59`, frontend). **Verificado por el dueño contra ARCA real en
producción** (`host.zuluhub.com.ar`) — ver Problema 1: CUIT `20224107030`
devolvió datos reales del padrón (200 OK), y un CUIT sin datos devolvió
`null` correctamente (200 OK, no error). Cierra el ítem del todo.

Nota aparte, no un bug: durante la verificación apareció un "Cannot GET"
al probar desde `https://reservasapp-8iisegw7e-alepozod.vercel.app`
(la URL específica de ese deploy puntual que genera Vercel, no el dominio
real) — desapareció al entrar por `host.zuluhub.com.ar`. Para probar
cualquier cambio en producción, usar siempre ese dominio, no el link que
tira Vercel después de cada push.

**Reportado por el dueño en producción** (`host.zuluhub.com.ar`), en el
modal "Editar cliente" → sección "Datos fiscales". Dos problemas
distintos, los dos reales:

### Problema 1 — Errores 400/500 al buscar en el padrón — ✅ RESUELTO (23/08/2026)

**Causa raíz real, confirmada con el log de Render que pidió el dueño**
(no la hipótesis original ni el "cualquier excepción" del fix anterior):
el fault exacto que devolvía ARCA era

```
soap:Fault: Token recibido es para el servicio [wsfe], deberia ser
para servicio [ws_sr_padron_a5,ws_sr_constancia_inscripcion].
```

Un Ticket de Acceso de WSAA (Token+Sign) está scoped a **un solo servicio**
de ARCA — un ticket para `wsfe` (facturación) no sirve para
`ws_sr_padron_a5`/`ws_sr_padron_a13` (padrón). `SqlAfipTicketStorage`
(`afip-ticket-storage.ts`) cacheaba **un solo ticket por negocio** en
`business_profile.afip_ticket_encrypted` — el propio comentario del
código decía explícitamente "solo se usa el servicio WSFE en este
negocio, así que `serviceName` no se usa para particionar nada". Ese
supuesto era cierto hasta el 19/08/2026; dejó de serlo en cuanto
`PadronService` empezó a pedir tickets para otros servicios — el ticket
de `wsfe` ya cacheado (de facturación electrónica) se reusaba para las
llamadas al padrón, y ARCA las rechazaba con el fault de arriba.

**Arreglado:**
- Tabla nueva `afip_tickets` (`service_name` PK, particiona el cache por
  servicio) reemplaza las columnas `business_profile.afip_ticket_*`
  (dropeadas). `CURRENT_SCHEMA_VERSION` subida a 34 — **sin este bump el
  cambio de schema nunca se hubiera aplicado** a negocios ya
  provisionados (`migrate-tenants.ts` se salta un negocio si su
  `schema_version` ya coincide con la constante).
- `AfipCredentialsRepository.getTicket/saveTicket/clearTicket` ahora
  reciben `serviceName`; `SqlAfipTicketStorage` deja de ignorarlo.
- `save()`/`clear()` de credenciales siguen invalidando TODOS los
  tickets cacheados (cambiar de certificado invalida todo, no solo un
  servicio).
- Se mantiene también el fix anterior (`AfipPadronUnavailableError`,
  503 en vez de 500 genérico) como red de seguridad para cualquier OTRA
  excepción real que no sea este bug puntual.
- Tests nuevos, incluyendo la regresión concreta: un ticket cacheado
  para `wsfe` no se devuelve para `ws_sr_padron_a5`. `tsc --noEmit` y
  suite completa (904 tests) verdes.
- Se aplica solo automáticamente: `render.yaml` corre `migrate:tenants`
  en el build, así que el próximo deploy crea `afip_tickets` en la BD
  real sin intervención manual.

**El 400 de CUIT inválido no era un bug de UX** — se revisó
`extractErrorMessage` (`appfrontend-main/src/lib/http.ts`) y ya traduce
el mensaje del dígito verificador a un toast entendible. Lo que se vio en
la pestaña de red como "400 Bad Request" es la etiqueta HTTP estándar de
DevTools, no necesariamente lo que se le mostró al usuario.

**Confirmado en producción por el dueño (23/08/2026):** CUIT `20224107030`
(ejemplo oficial del SDK, `getPersonaList_v2`) → `200 OK` con datos reales
del padrón (razón social, condición IVA, domicilio). Un segundo CUIT sin
datos en el padrón → `200 OK` con `null`, comportamiento esperado. Item
cerrado del todo.

<details><summary>Investigación original (histórico, ya resuelta como se explica arriba)</summary>

Errores de red exactos que vio el dueño:
```
POST /api/customers/padron/lookup-by-cuit → 400 (Bad Request)
POST /api/customers/padron/lookup-by-dni  → 500 (Internal Server Error)
POST /api/customers/padron/lookup-by-cuit → 500 (Internal Server Error)
```

**Descartado como causa:** falta de certificado AFIP configurado — ese
caso (`AfipNotConfiguredError`, code `AFIP_NOT_CONFIGURED`) ya está bien
mapeado a **503** en `app-main/src/api/middleware/error.middleware.ts:190`.
Como lo que se ve es 400/500, el problema es otro.

**Hipótesis de la causa raíz, sin confirmar todavía — a verificar primero
en la próxima sesión:**
- El **400** en `lookup-by-cuit` es casi seguro `LookupByCuitSchema.parse()`
  (`customers.routes.ts`) rechazando el CUIT tipeado por no pasar el
  dígito verificador mod-11 de `cuitSchema` — comportamiento esperado,
  pero **sin mensaje claro para quien lo usa** (llega como "Bad Request"
  crudo, sin traducir a un toast entendible).
- El **500** en los dos endpoints (`lookup-by-cuit` y `lookup-by-dni`) es
  más grave: `app-main/src/facturacion/padron.service.ts` — su propio
  docblock (líneas 1-8) confiesa que **nunca se probó contra el padrón
  real de ARCA**, se escribió leyendo el código fuente del SDK
  (`@arcasdk/core`) sin ejecutarlo nunca. Sospecha fuerte: `client.
  registerScopeFiveService.getTaxpayerDetails()` (línea 93) o `client.
  registerScopeThirteenService.getTaxIDByDocument()` (línea 101) **tiran
  una excepción cruda** en vez de devolver `null`/vacío cuando ARCA no
  encuentra el CUIT/DNI — esa excepción no es un `DomainError`, así que
  cae al catch-all genérico de `error.middleware.ts` (línea 70-75) y sale
  como 500 sin traducir.

**Dónde corté la investigación, retomar exactamente acá:** estaba leyendo
el SDK real en
`app-main/node_modules/@arcasdk/core/lib/infrastructure/repositories/register/register-scope-five.repository.js`
y `register-scope-thirteen.repository.js` para confirmar si tiran
excepción o devuelven null/vacío en el caso "no encontrado" — no llegué a
confirmarlo. Es el primer paso antes de tocar código.

**Plan una vez confirmado:**
1. Si el SDK tira excepción en "no encontrado": capturarla en
   `padron.service.ts` (`getTaxpayerByCuit`/`resolveCuitByDni`) y devolver
   `null` ahí (ya es el contrato que `customers.routes.ts` espera — ver
   los comentarios "null si no existe en el padrón", líneas 282-285 y
   299-300 de ese archivo — el contrato está bien diseñado, falta que el
   service lo cumpla de verdad).
2. Cualquier otra excepción real del SDK (timeout, credencial inválida en
   runtime, etc.) — envolver en un `DomainError` nuevo con status
   apropiado (503 si es de infraestructura AFIP, no 500 genérico).
3. Frontend: traducir el 400 de CUIT inválido a un mensaje claro
   ("el CUIT no pasa el dígito verificador", no "Bad Request").
4. **No dar por cerrado sin probar con un CUIT/DNI real** — pedirle uno
   de prueba al dueño, dado que esto nunca se verificó contra ARCA real
   (ni en dev ni en producción).

</details>

### Problema 2 — ✅ RESUELTO (23/08/2026) — UX de búsqueda mal diseñada

**Decisión del dueño, confirmada con `AskUserQuestion`:** campo único con
auto-detección (11 dígitos → CUIT, 7-8 dígitos → DNI). Antes de implementar
se encontró una restricción real: el SDK de ARCA (`@arcasdk/core`) no tiene
NINGÚN método de búsqueda por razón social — los webservices
`ws_sr_padron_a5`/`a13` solo aceptan CUIT o DNI como clave, no es que falte
conectarlo, es que el servicio no lo soporta. Confirmado con el dueño:
si se tipea algo que no son solo dígitos, se avisa que la búsqueda por
razón social no está disponible contra ARCA (no se intenta una búsqueda
local de clientes como alternativa — eso queda fuera de este ítem, ver G1).

**Implementado (commit `e533e59`, appfrontend-main):**
`dashboard/clientes/page.tsx` — un solo input + botón "Buscar" con
`handleTaxLookup()`, reemplaza los dos mecanismos viejos
(`handleLookupByDni`/`handleLookupByCuit` y sus estados `dniInput`/
`lookingUpByCuit`/`lookingUpByDni`). `tsc --noEmit` y `next build` verdes.
**No verificado en navegador por Claude** (mismo motivo que F3: sin backend
local conectado) — pendiente que el dueño lo pruebe en producción.

<details><summary>Investigación original (histórico)</summary>

Confirmado leyendo `appfrontend-main/src/app/dashboard/clientes/page.tsx`
(sección "Datos fiscales" del modal, líneas ~490-584): hoy hay **dos
buscadores separados pisándose**, no uno solo:

1. Un input+botón "Buscar por DNI" (líneas 497-512) — independiente,
   funciona solo (`handleLookupByDni`, línea 181).
2. Un selector CUIT/CUIL/DNI/OTRO (línea 516-525) + input "Número" +
   botón "Buscar" (línea 532-540) — pero ese botón está **deshabilitado
   si el selector no es CUIT o CUIL** (línea 535:
   `disabled={... || !['CUIT', 'CUIL'].includes(taxForm.taxIdType)}`).
   Elegir "DNI" en ese selector no rompe nada técnicamente, pero **no
   sirve para nada** — el botón queda deshabilitado y el usuario no
   entiende por qué. Elegir "Otro" (razón social) tampoco tiene ningún
   camino de búsqueda — nunca se implementó.

**Pedido explícito del dueño, confirmar antes de implementar (no asumir
el diseño exacto):** una sola casilla de búsqueda que acepte DNI, CUIT o
razón social indistintamente, y desde ahí complete el resto — no dos
mecanismos separados como hoy. Antes de codear, decidir con el dueño:
¿el campo único auto-detecta qué tipo de dato es (por longitud/formato) o
hay que elegir el tipo aparte pero con un solo flujo de búsqueda? Y razón
social contra el padrón de ARCA no tiene un endpoint de búsqueda hoy
(`padron.service.ts` no expone nada por nombre) — si se pide buscar por
razón social contra ARCA, es una cuarta consulta nueva al SDK, no algo
que ya exista y solo haya que conectar.

**No implementado nada de esto todavía — ni el fix del bug ni el
rediseño de UX.** Es lo primero a retomar en la próxima sesión.

</details>

---

## F. Ítems recuperados — se perdieron en el corte de esquema E→A/B/C/D (23/08/2026)

**Cómo se encontraron:** auditoría completa de los 9 archivos de pendientes
(08-10 a 08-22, ~6000 líneas), rastreando cada ítem con nombre propio a
través de las sesiones. El 19/08 la sesión de auditoría de producto
reemplazó el esquema de numeración viejo (E1–E7, definido en
`pendientes-2026-08-13.md`) por el nuevo (A/B/C/D) basado en el documento
de auditoría externo — pero tres ítems de la lista vieja no se remapearon.
Confirmado con grep: `pendientes-2026-08-19.md` no tiene **ninguna**
mención a E1–E7 (el esquema simplemente dejó de nombrarse), y el 18/08 los
tres todavía figuraban abiertos en bloque ("E2–E7... falta que se defina
alcance"). Desde el 19/08 no vuelven a aparecer ni como ✅ resueltos ni
como descartados en ningún archivo posterior.

### F1. Auditoría de cuentas corrientes (ex-E3)

Pedido tal como lo planteó el usuario el 13/08: revisar y reestructurar la
lógica operativa del módulo de cuentas corrientes. Sin alcance ni lista de
problemas concretos todavía entonces — seguía así el 18/08. Lo único que
tocó ese módulo desde entonces fue `CustomerAccountService.recordPayment()`
dentro de C1-Fase A (seña/depósito, 22/08) — es un cambio funcional
puntual, no la auditoría que se había pedido. Punto de partida para cuando
se retome: `CustomerAccountService` (`src/clientes-finanzas/` o
equivalente actual), rutas `GET/POST /api/customers/:id/account` y
`/payments`. Falta que el usuario indique qué específicamente no funciona
como espera — sin eso, no hay nada que auditar todavía.

### F2. Estandarización de ABM/alta de usuarios (ex-E4a)

Mitad de investigación de E4 original — la otra mitad (E4b, tarifa % vs.
precio fijo) sí se resolvió como D5 el 22/08, esta no. Pedido de
investigación/diseño amplio: estandarizar ABM y alta de usuarios,
validando contra normativa nacional real (evitar "flujos ficticios" sin
aplicabilidad comercial). Sin hallazgo del repo que lo acote todavía —
requiere una sesión aparte de research antes de tocar código. Sin cambios
desde el 13/08.

### F3. ✅ RESUELTO (23/08/2026) — Auditar y remodelar el frontend "según estándar de innovación" (ex-E6)

Pedido del usuario, textual, del 13/08 — quedó sin acotar hasta que el
dueño trajo una referencia visual concreta hoy mismo: la guía de
transferencia de diseño "ZULU" (landing propia, navy/cian, Space Grotesk +
IBM Plex), con `AskUserQuestion` confirmando alcance (reemplazo completo
del dashboard, no convivencia con Bastión, el sistema que estaba en uso
hasta hoy). Ejecutado en dos tandas sobre `appfrontend-main`:

- **Fase A** (commit `3a10e39`): tokens `.zulu` en `globals.css`,
  tipografía (Space Grotesk reemplaza Fraunces), shell (`dashboard/
  layout.tsx`) reskinado, `Modal`/`ConfirmDialog` dejan de hardcodear
  color, componentes nuevos `SignalBadge`/`TelemetryCard`/`SystemRail`
  (este último con datos reales del outbox, no decorativo), pantalla de
  inicio del dashboard migrada completa como piloto end-to-end.
- **Fase B** (commit `c0c714d`): las ~18 pantallas restantes que seguían
  en Bastión migradas al mismo patrón, `RoomCalendar`/`FacturarButton`
  actualizados, bloque `.bastion` completo retirado de `globals.css`
  (confirmado sin referencias activas antes de borrarlo).

**Decisión de diseño explícita, no trivial:** se retiró la distinción de
acento por módulo que tenía Bastión (brass=PMS, clay=POS) — la guía ZULU
reserva el ámbar solo para alertas contextuales, nunca como acento
primario, así que todo el dashboard comparte un solo acento (cian); PMS y
POS se siguen distinguiendo por vocabulario, no por color.

`tsc --noEmit` y `next build` verdes en los dos commits. **No verificado
en navegador por Claude** — el backend local no conecta (`app-main/.env`
no tiene `DATABASE_URL` de tenant, solo `PLATFORM_DATABASE_URL`) y no hay
credenciales de prueba para producción; el dueño lo revisó directo en
producción tras cada push.

---

## G. Gap puntual confirmado, no cerrado (23/08/2026)

### G1. ✅ RESUELTO (23/08/2026) — Búsqueda de clientes por CUIT/DNI

`pendientes-2026-08-19.md` (sección D4, ABM fiscal) ya lo dejaba anotado
explícito: *"Todavía falta: la búsqueda de clientes POR CUIT/DNI... no se
construyó — lo que se conectó es la consulta AL padrón de ARCA
(autocompletar desde afuera), no una búsqueda contra los perfiles fiscales
ya cargados en la propia base"*. Confirmado contra el código real
(`src/clientes-finanzas/customers.routes.ts:376`): el listado de clientes
solo soportaba `?email=`/`?name=` — sin filtro por CUIT ni DNI.

**Arreglado (commit `b3ebd3e` backend, `58f36d6` frontend):**
- `POST /customers/search-by-tax-id` — body, nunca query string (A7.2:
  el CUIT/DNI es PII). Match exacto normalizado (sin guiones/espacios)
  contra `customer_tax_profiles.tax_id`; devuelve un array porque esa
  columna no tiene unicidad a nivel de base. No filtra por `active`
  (R2). Índice nuevo, `CURRENT_SCHEMA_VERSION` a 35.
- Frontend: el mismo campo de búsqueda de la lista de clientes
  auto-detecta CUIT/DNI (7+ dígitos) y consulta ese endpoint en vez de
  filtrar nombre/email en memoria — sin UI nueva, reusa el buscador
  existente.

`tsc --noEmit`, suite completa (906 tests) y `next build` verdes. No
verificado en navegador (mismo motivo que el resto de la sesión — sin
backend local conectado).

---

## H. Hallazgo nuevo, sin cerrar (23/08/2026)

### H1. ✅ RESUELTO (23/08/2026) — `dashboard/ordenes/[id]/page.tsx` — nunca estuvo en Bastión ni pasó a ZULU

Encontrado al auditar la migración de diseño (F3): a diferencia de las
otras ~19 pantallas del dashboard, el detalle de una orden
(`appfrontend-main/src/app/dashboard/ordenes/[id]/page.tsx`) no usaba
`.bastion` ni el tema oscuro base — tenía su propia paleta de colores
hardcodeada en hex/rgba directo (`STATUS_COLOR`, ej. `#10b981`, `#f87171`,
`#60a5fa`), independiente de cualquiera de los dos sistemas de diseño que
pasaron por el resto del dashboard. Quedó fuera del alcance de F3 porque
el inventario de esa migración se armó a partir de qué pantallas usaban
`.bastion`, y esta nunca lo usó.

**Arreglado (commit `a59c4c6`, appfrontend-main):** wrapper con clase
`.zulu` agregado, todos los hex/rgba reemplazados por
`var(--success/danger/info/text-*/border)` según el estado que
representan, el badge de estado pasa a reusar las clases `.badge-*`
compartidas (mismo `STATUS_BADGE_CLASS` que ya usa
`dashboard/ordenes/page.tsx`, un solo lugar de verdad) en vez de un
`STATUS_COLOR` propio con dot pintado a mano, y las tarjetas pasan a
`className="card"` en vez de una `.detail-card` local con
`background: #13151e` fijo. `tsc --noEmit` y `next build` verdes. No
verificado en navegador (mismo motivo que F3 — sin backend local
conectado).

---

## Nota de proceso, no un pendiente en sí

El hallazgo de `tsconfig.json` (13/08: excluía `src/**/*.test.ts` del
typecheck, ningún test se tipaba nunca) se corrigió en algún punto entre
el 14/08 y hoy — el archivo actual solo excluye
`src/reservas/supabase.occupancy.repository.ts`. No se encontró ningún
"✅ RESUELTO" que lo documente en ningún archivo intermedio; probablemente
se corrigió de paso en otro cambio. No es un pendiente — es una nota para
no reabrirlo por error pensando que sigue roto.

---

## C. Decisiones de negocio sin resolver (arrastrado de 08-22, sin cambios)

- **C1-Fase B** (integración con gateway de pago real, hold corto para
  canal web, auto-release automático) y **C1-Fase C** (`BillingEntity`
  separado de `Guest`, facturación corporate consolidada, cuentas por
  cobrar/statements) — documentadas como referencia en
  `docs/diseno-sena-deposito-fase-a-2026-08-22.md`, sin diseñar en
  detalle. **No elegir ninguna opción sin el dueño.**

## Backlog de UI arrastrado (arrastrado de 08-22, sin cambios)

Todo lo siguiente está **backend only** — implementado, con tests verdes,
pero sin pantalla en `appfrontend-main`: configurar seña/depósito y
cobrarla desde la ficha de reserva (C1-Fase A); preview/confirmar
reembolso al cancelar (C2); líneas reales de factura en el detalle (C3);
número de reserva/cliente en listados + prefijo editable en Mi Negocio
(D6); pantalla de reportes POS/CRM (D7); carga de IVA/unidad/código ARCA
al crear/editar un producto (D8); verificación en el panel de POS de la
autoridad de precio server-side para productos (D9-Parte 2).
