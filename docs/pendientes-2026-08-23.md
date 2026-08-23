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

## 🔴 URGENTE — BUG en producción, sin resolver: búsqueda de padrón ARCA (23/08/2026)

**Reportado por el dueño en producción** (`host.zuluhub.com.ar`), en el
modal "Editar cliente" → sección "Datos fiscales". Dos problemas
distintos, los dos reales, hay que resolver los dos:

### Problema 1 — Errores 400/500 al buscar en el padrón

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

### Problema 2 — UX de búsqueda mal diseñada (confirmado, no es percepción)

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

### G1. Búsqueda de clientes por CUIT/DNI

`pendientes-2026-08-19.md` (sección D4, ABM fiscal) ya lo dejaba anotado
explícito: *"Todavía falta: la búsqueda de clientes POR CUIT/DNI... no se
construyó — lo que se conectó es la consulta AL padrón de ARCA
(autocompletar desde afuera), no una búsqueda contra los perfiles fiscales
ya cargados en la propia base"*. Confirmado hoy contra el código real
(`src/clientes-finanzas/customers.routes.ts:376`): el listado de clientes
solo soporta `?email=`/`?name=` — sin filtro por CUIT ni DNI. El 22/08 se
tocó bastante el módulo de clientes/facturación (C1-Fase A, C2, C3) pero
ninguno pasó por este endpoint. Sigue pendiente, sin UI tampoco.

---

## H. Hallazgo nuevo, sin cerrar (23/08/2026)

### H1. `dashboard/ordenes/[id]/page.tsx` — nunca estuvo en Bastión ni pasó a ZULU

Encontrado al auditar la migración de diseño (F3): a diferencia de las
otras ~19 pantallas del dashboard, el detalle de una orden
(`appfrontend-main/src/app/dashboard/ordenes/[id]/page.tsx`) no usa
`.bastion` ni el tema oscuro base — tiene su propia paleta de colores
hardcodeada en hex/rgba directo (`STATUS_COLOR`, ej. `#10b981`, `#f87171`,
`#60a5fa`), independiente de cualquiera de los dos sistemas de diseño que
pasaron por el resto del dashboard. No se tocó — quedó fuera del alcance
de F3 porque el inventario de esa migración se armó a partir de qué
pantallas usaban `.bastion`, y esta nunca lo usó. Pendiente: migrarla a
los tokens `.zulu` (mismo criterio que el resto — reemplazar los hex
literales por `var(--warning)`/`var(--danger)`/`var(--info)`/etc. según el
estado que representen).

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
