# Auditoría técnica integral — Fase 7: revisar arquitectura

Fecha: 15/09/2026. Alcance: `/home/user/app` (backend `app-main`) + `/home/user/appfrontend` (frontend). Fase 7 del protocolo de 16 fases del dueño.

**Nota de proceso — agente sin `Write`/`Edit`.** Este informe se entregó como texto a la sesión orquestadora para que lo persista. No se modificó, borró, movió ni renombró ningún archivo de código. La única ejecución fue `npx depcruise src --config .dependency-cruiser.cjs` en modo `--output-type err` y `--output-type json` (lectura; el JSON se escribió en el scratchpad de la sesión, fuera del repo).

**Nota de trazabilidad.** Cuatro hallazgos de esta fase reformulan material ya levantado: los 4 Alto de `docs/auditoria-integral-fase2-2026-09-15.md` y `C6-02`/`C6-05`/`C6-06`/`C6-17` de `docs/auditoria-integral-fase6-2026-09-15.md`. Donde eso pasa, **no se repite el detalle** — se cita el ID y se agrega sólo lo que el lente de esta fase (separación de capas, dirección de dependencias, arquitectura accidental) aporta. Los otros diez son nuevos. `C6-17` se usa además como ancla de la arquitectura objetivo, tal como lo pidió el encargo.

---

## 0. Método

Se evaluó la pila que pide el protocolo:

```text
Presentación → transporte → validación de entrada → lógica de aplicación
→ reglas de negocio → persistencia → servicios externos → configuración
```

contra el árbol real, no contra los documentos de arquitectura del repo (que resultaron ser parte del hallazgo — ver F7-09 y F7-13). Cada afirmación numérica de este informe es **medida**, con el comando o el archivo:línea que la produce. Se aplicó el criterio del protocolo: *"no supongas que el nombre de un archivo describe correctamente su responsabilidad"* — de ahí salieron F7-11 (cinco `SqlXRepository` viviendo en el archivo de su puerto) y F7-14 (`lib/auth.tsx`, un módulo vacío cuyo comentario describe un mecanismo de auth que ya no existe).

---

## 1. El mapa de capas real

| Capa del protocolo | Dónde vive realmente | Veredicto |
|---|---|---|
| **Presentación** | `appfrontend/src/app/**` (51 `page.tsx`, 47 con `'use client'`; los 4 restantes son envoltorios de `<Suspense>` sin datos), `src/components/**` (15 componentes) | Separada del backend de forma **total y verificada** (ver §2, chequeo 2). Contiene reglas de negocio espejadas — F7-12 |
| **Transporte** | `src/app.ts` (594 líneas, 33 mounts), 39 `*.routes.ts`, `next.config.js` (proxy same-origin), `src/api/middleware/**` | El transporte también hace composición, DDL y sagas — F7-01, F7-05 |
| **Validación de entrada** | `src/api/schemas/**` (18 archivos Zod) **y** 46 `z.object()` inline en 16 `*.routes.ts` | Dos convenciones vivas — F7-10. Lo bueno: `zod` no aparece en **ningún** archivo fuera de `api/` + `app.ts` |
| **Lógica de aplicación** | los `*.service.ts` de cada dominio… y también handlers Express (`customers.routes.ts`, los 4 de aprovisionamiento) | Frontera porosa — Fase 2 (4º Alto), F7-05 |
| **Reglas de negocio** | `src/reservas/`, `src/pos-menu/`, `src/pms-estadias/`, `src/clientes-finanzas/`, `src/facturacion/`, `src/usuarios-roles/` + `src/domain/` | Libre de Express (positivo confirmado). Conoce el protocolo de AFIP — F7-04. Escribe SQL crudo en un caso — F7-08 |
| **Persistencia** | 2 `schema.sql` (4302 + 1578 líneas), ~60 `sql.*.repository.ts`, `src/repositories/` | Consultas centralizadas (positivo). Un servicio la saltea — F7-08. 5 archivos rompen la convención de nombres de la que depende la cerca — F7-11 |
| **Servicios externos** | `facturacion/afip-billing.port.ts` + `arca-sdk-billing.adapter.ts`, `email/email.sender.ts`, `security/google-oauth.ts`, `platform/neon-provisioning.ts` | **Dos de cuatro con puerto limpio, dos sin ninguno** — F7-04 |
| **Configuración** | `render.yaml` (16 claves), `process.env` en 26 archivos (30 nombres, 2 estilos de acceso), `src/config/` (1 archivo, sólo un `interface`), constantes literales repartidas | La capa que peor está — F7-06 |

---

## 2. Los diez chequeos del protocolo, respondidos

**1. ¿Los controladores contienen lógica de negocio importante?** **Sí, en cuatro lugares concretos.** Ya conocido para `clientes-finanzas/customers.routes.ts` (Fase 2, 4º Alto). Nuevo y más grave: la saga de aprovisionamiento de tenant (llamada a la API de Neon → DDL → cifrado → 2 escrituras en la BD de plataforma) vive entera en handlers Express, **cuatro veces** (F7-05). Y `api/routes/audit-log.routes.ts:33-60` hace un join entre dos bases de datos dentro del handler, sin servicio (F7-10).

**2. ¿Los componentes de interfaz acceden directamente a la base de datos?** **No. Confirmado, con medición.** `appfrontend/package.json` no declara `pg` ni `@neondatabase/*`; cero ocurrencias de `'use server'`, cero `route.ts`/`route.tsx`, cero `middleware.ts`, cero `actions.ts` en todo `src/`; el frontend lee exactamente **dos** variables de entorno (`NEXT_PUBLIC_GOOGLE_CLIENT_ID`, `NODE_ENV`); las 4 páginas sin `'use client'` son envoltorios de `<Suspense>` con cero acceso a datos. Todo el tráfico pasa por `src/lib/http.ts::apiFetch()` → `/api/*` same-origin → rewrite de `next.config.js` hacia `NEXT_PUBLIC_API_URL`. Es el chequeo que el repo aprueba más limpio de los diez.

**3. ¿Los servicios externos están mezclados con reglas internas?** **Sí, de forma asimétrica.** AFIP tiene un puerto ejemplar para la **respuesta** y ninguno para el **request** — el payload WSFEv1 se arma dentro del servicio de negocio y se persiste como columna (F7-04). Neon y Google OAuth no tienen puerto (F7-04). El email sí (positivo).

**4. ¿Las consultas están centralizadas o claramente organizadas?** **Sí, casi.** Un solo desvío real: `pos-menu/order.service.ts:602-606,626-632` ejecuta `UPDATE orders …` crudo salteando su propio repositorio (F7-08). El resto del SQL vive en repositorios; los hits de "SELECT/INSERT" en otros servicios son comentarios, salvo `clientes-finanzas/payment-application.ts:49` (un `pg_advisory_xact_lock`, primitiva deliberada y documentada).

**5. ¿La configuración está dispersa?** **Sí, es el peor chequeo de los diez.** 30 nombres de variable leídos en 26 archivos, 16 declarados en `render.yaml`, 11 declarados en ningún lado, sin `.env.example` en el backend, `src/config/` con un solo archivo que ya no contiene valores, el TTL del JWT resuelto de cinco formas distintas (una ignora la variable) y `DEFAULT_SENDER_NAME = 'ZuluHub'` declarado tres veces (F7-06).

**6. ¿Las reglas de negocio dependen del framework cuando no hace falta?** **No, y esto está genuinamente bien.** Barrido completo: `express` se importa sólo en `app.ts`, los `*.routes.ts`, `api/middleware/**`, `db/tenant-context.ts` y `security/resolve-plan-limits.ts`. Ningún `*.service.ts` ni ninguna entidad importa Express. La regla `entidades-sin-express-ni-pg` de `.dependency-cruiser.cjs` lo sostiene para `*.entities.ts`/`*.types.ts`; para los servicios lo sostiene la disciplina, sin cerca.

**7. ¿Los módulos tienen conocimiento innecesario de detalles internos?** **Sí.** `src/app.ts` importa 14 clases `Sql*Repository` de 5 dominios distintos y hace 33 `new Sql…` (F7-01). `facturacion/invoice.service.ts` conoce el formato de cable de AFIP (F7-04). `pms-estadias/stay.service.ts` conoce y escribe el agregado `Reservation` de `reservas/` (F7-02).

**8. ¿El flujo de dependencias tiene una dirección clara?** **No.** 20 pares de carpetas con imports en **las dos** direcciones, 7 de ellos entre los 6 dominios de negocio declarados (F7-03).

**9. ¿Existen dependencias circulares?** **A nivel de archivo, no — verificado con herramienta.** `npx depcruise src --config .dependency-cruiser.cjs --output-type err` → `✔ no dependency violations found (311 modules, 1528 dependencies cruised)`. Esto cierra el bloque `No confirmado` que Fase 2 dejó abierto sobre `platform.repository.ts`. **A nivel de módulo/carpeta, sí: 20** (F7-03). La regla `no-circular` opera sobre archivos y no puede verlos.

**10. ¿Hay varias arquitecturas compitiendo dentro del mismo proyecto?** **Sí, cinco capas superpuestas identificadas:** (a) la estructura por capas (`api/`+`services/`+`repositories/`+`domain/`) contra la estructura por bounded context (`reservas/`, `pos-menu/`…), con residuos vivos de la primera — F7-09; (b) dos convenciones de validación — F7-10; (c) dos arquitecturas de acceso a datos en el frontend, conviviendo en 19 de 21 pantallas — F7-13; (d) dos mecanismos de sesión en el frontend, uno de ellos huérfano — F7-14; (e) cinco documentos que se declaran fuente de verdad del contrato HTTP — F7-09.

---

## 3. Hallazgos

Catorce: cuatro reformulados con lente de Fase 7 (F7-02, F7-04, F7-07, F7-12 en parte) y diez nuevos.

---

### F7-01 — Cinco composition roots con tres convenciones, y dos servicios cableados dos veces byte a byte

```text
Hallazgo: la construcción del grafo de objetos no tiene un lugar. Está
repartida en cinco sitios con tres convenciones distintas, con 286
instanciaciones `new Sql…Repository` en 31 archivos no-test, y dos
servicios (`StayService`, `AccountsReceivableService`) cableados dos veces
cada uno en archivos distintos, con listas de dependencias idénticas
mantenidas a mano.

Evidencia:
 (1) `src/container.ts` — se declara "Composition Root" en su docblock
     (:2) y hoy sólo construye 4 funciones cross-tenant contra la BD de
     plataforma. Su discriminante `mode: 'postgresql'` (:118, :226) es una
     unión de un solo miembro: el vestigio de un modo alternativo que ya
     no existe.
 (2) los 39 `*.routes.ts` — convención documentada en el docblock de
     `.dependency-cruiser.cjs` ("en este repo la capa de rutas ES el
     composition root"). Volumen real: `reservas/reservations.routes.ts`
     41 `new Sql…`, `clientes-finanzas/customers.routes.ts` 35,
     `facturacion/invoices.routes.ts` 27, `pos-menu/products.routes.ts` 24,
     `reservas/bookable-services.routes.ts` 23, `pos-menu/orders.routes.ts`
     20, `api/routes/customer.routes.ts` 18, `reservas/resources.routes.ts` 14.
 (3) `src/app.ts:401-530` — SEIS mounts arman el grafo completo (repos +
     servicios) dentro de un middleware por-request declarado inline en
     `app.ts`: `/api/reports` (:401-426), `/api/system` (:431-437),
     `/api/housekeeping` (:440-452), `/api/maintenance-windows` (:454-475),
     `/api/stays` (:478-512), `/api/accounts-receivable` (:514-530). Son los
     mismos 6 de `CLOSURE_MOUNTS`. `app.ts` importa 14 clases
     `Sql*Repository` de 5 dominios (:103-122) y hace 33 `new Sql…`.
 (4) `src/workers/outbox.registry.ts` — 13 `new Sql…` en 26 imports; es el
     composition root del procesamiento en background.
 (5) `src/facturacion/invoices.routes.ts:84` exporta `buildInvoiceService(req)`,
     que `src/pos-menu/orders.routes.ts:60` importa. Un `*.routes.ts` que
     es, además, librería de factories de otro dominio.

 El cableado duplicado, medido:
 - `StayService`: `src/app.ts:493-496` y `src/reservas/reservations.routes.ts:224-239`
   (`buildStayService`). Los 6 argumentos son los mismos, en el mismo orden,
   construidos con las mismas 6 líneas previas.
 - `AccountsReceivableService`: `src/app.ts:498-509` y `src/app.ts:518-527`,
   8 argumentos posicionales cada uno, en el mismo archivo, a 9 líneas de
   distancia.
 - `new SqlReservationRepository(req.db, new SqlResourceRepository(req.db))`
   aparece en 19 sitios no-test.

Impacto: agregar una dependencia a `StayService` o a
`AccountsReceivableService` exige encontrar y editar 2 sitios; omitir uno
compila (son parámetros posicionales del mismo tipo — C6-12) y produce un
servicio a medio cablear en una sola de las rutas que lo exponen. Los 6
closures de `app.ts` además construyen un `Router` de Express nuevo en CADA
request (`createReportsRouter(reportService)` dentro del middleware), y son
exactamente los 6 mounts que el árbol vivo de Express no puede caminar —
la razón de existir del octavo artefacto manual del repo (`CLOSURE_MOUNTS`).
O sea: el costo de esta convención ya se está pagando en otro lugar del repo,
documentado, sin que se hubiera nombrado la causa.

Causa probable: la restricción real es legítima y está bien entendida — los
repos dependen de `req.db`, que no existe al arrancar el proceso, así que no
pueden vivir en un container de boot. Lo que faltó es el paso siguiente: un
*container por request*. Sin él, cada ruta resolvió el problema donde estaba
trabajando, y `app.ts` absorbió los casos que no encajaban en un
`*.routes.ts` (los que necesitan dos servicios a la vez, o un
`TransactionManager` de tenant).

Nivel de certeza: Alta. Los 5 sitios y los 2 duplicados están leídos
completos; los conteos son medidos (`grep -c "new Sql"` por archivo).

Severidad: Alta (mantenibilidad y radio de error, no defecto funcional hoy).

Recomendación: extender `src/db/tenant-context.ts` — que YA es exactamente
este patrón para una dependencia y nació de un incidente real (pool de
plataforma usado donde iba el del tenant, hallazgo #1 del review del
08/08/2026, ver su docblock :10-17) — a un `tenant-container.ts` con una
función `buildX(req)` por servicio, y hacer que los 39 `*.routes.ts` y los 6
closures de `app.ts` la llamen en vez de instanciar. Es mecánico,
verificable por compilación y no cambia comportamiento. Ver §5.

¿Requiere modificar código?: Sí. No implementado.

Prueba necesaria: una cerca de arquitectura del tipo que el repo ya usa diez
veces: contar `new Sql[A-Za-z]*Repository` fuera de `tenant-container.ts` y
exigir 0, con allowlist y motivo por entrada. Congelar el número actual (286)
antes de mover nada, para que el refactor se mida en vez de afirmarse.
```

---

### F7-02 — `pms-estadias` ↔ `reservas`: el archivo declara en su propio docblock la regla que rompe 340 líneas más abajo, y la cerca no puede verlo

**Reformula el 3.º Alto de Fase 2 + `C6-02` (que a su vez reformula `F5-13`).** El detalle de los dos escritores, las invariantes divergentes y el CHARGE fuera de transacción están completos ahí. Anclas: `src/pms-estadias/stay.service.ts:353,366,460`, expuestos bajo `src/reservas/reservations.routes.ts:676-725`.

**Lo que ni Fase 2 ni C6-02 cubrieron — tres cosas, todas de arquitectura:**

**(a) El archivo tiene una sección "## Separación de responsabilidades" que declara lo contrario de lo que hace.** `src/pms-estadias/stay.service.ts:14-16`, textual:

```
 * ## Separación de responsabilidades
 * - StayService NO modifica el estado de Reservation — eso lo hace ReservationService.
 *   El flujo correcto es: ReservationService.confirmReservation() → StayService.checkIn().
```

Tres líneas más arriba, el mismo docblock (`:9-11`) lista `requestScheduleChange`/`approveScheduleChange`/`rejectScheduleChange` entre las responsabilidades del archivo — y son exactamente los tres métodos que escriben `Reservation`. La regla y su excepción están en el mismo comentario, a ocho líneas de distancia, sin que ninguna de las dos mencione a la otra. Esto no es un comentario viejo: es la regla correcta escrita por alguien que ya había decidido incumplirla, sin registrar la decisión. Es el caso más puro de arquitectura accidental de todo el informe.

**(b) El cruce es de 8 imports, no de 3.** Medido sobre el grafo real:

```
src/pms-estadias/stay.service.ts            -> src/reservas/Reservation.ts
src/pms-estadias/stay.service.ts            -> src/reservas/reservation.repository.ts
src/pms-estadias/stay.service.ts            -> src/reservas/reservation.service.ts
src/pms-estadias/housekeeping.routes.ts     -> src/reservas/reservation.repository.ts
src/pms-estadias/maintenance-window.service.ts -> src/reservas/reservation-time.utils.ts
src/pms-estadias/maintenance-window.service.ts -> src/reservas/Reservation.ts
src/pms-estadias/maintenance-window.service.ts -> src/reservas/reservation.repository.ts
src/pms-estadias/maintenance-window.service.ts -> src/reservas/resource.repository.ts
```

Fase 2 midió `stay.service.ts`. `maintenance-window.service.ts` tiene el mismo patrón (4 imports de `reservas/`, incluida la entidad rica `Reservation`) y no se había levantado. El cruce inverso es de 7 imports, lo que hace de este par uno de los 20 ciclos de carpeta de F7-03.

**(c) La cerca no puede ver este cruce, y el motivo es estructural.** La regla `no-repo-concreto-de-otro-dominio` de `.dependency-cruiser.cjs` prohíbe que un dominio importe `^src/(DOMINIOS)/(sql|in-memory)\.` de otro. Los imports de arriba son todos del **puerto** (`reservation.repository.ts`) y de la **entidad** (`Reservation.ts`) — ninguno matchea el patrón. La regla está diseñada para atrapar "leer la tabla privada del vecino", y lo que pasa acá es peor y distinto: **escribir el agregado del vecino a través de su propio puerto**. No hay regla para eso, y la única frontera con regla dura (`reservas-y-pos-no-se-mezclan`) es la que tiene 0 imports en las dos direcciones.

```text
Hallazgo: la frontera `pms-estadias`↔`reservas` es un cruce de 8 imports en
una dirección y 7 en la otra, incluye la escritura del agregado ajeno, está
declarada como prohibida en el docblock del archivo que la rompe, y es
invisible para la única herramienta de arquitectura del repo por una razón
de diseño de la regla, no por un descuido de configuración.
Evidencia: stay.service.ts:9-11 contra :14-16 (la regla y su excepción en el
mismo comentario) · stay.service.ts:353,366,460 · maintenance-window.service.ts
(4 imports de reservas/, no levantados antes) · reservations.routes.ts:676-725 ·
.dependency-cruiser.cjs (patrón `(sql|in-memory)\.` de
`no-repo-concreto-de-otro-dominio`) · grafo real de depcruise, 8/7 imports.
Impacto: además del CHARGE huérfano ya dimensionado en C6-02, el efecto de
arquitectura: `reservas/` no puede razonar sobre sus propias invariantes
leyendo `reservas/`. Un invariante nuevo en `ReservationService` hay que
recordarlo en tres archivos de dos carpetas, y ninguna herramienta avisa.
Causa probable: la feature de cambio de horario nació dentro del flujo de
check-in/check-out; se implementó donde estaba el contexto de trabajo y se
expuso bajo la URL de reservas para que el frontend la encontrara donde la
esperaba (el propio `reservations.routes.ts:218-223` lo dice: "se monta acá
(no en /api/stays) porque los 3 endpoints nuevos toman un reservationId").
La razón declarada es de RUTA, no de dominio — y se resolvió moviendo el
dominio en vez de la ruta.
Nivel de certeza: Alta para las tres partes. La (a) es cita textual; la (b)
es el grafo medido; la (c) es el patrón de la regla leído contra las rutas
de los imports reales.
Severidad: Alta.
Recomendación: la opción (a) de F5-13 §5 — mover la responsabilidad a
`reservas/` detrás de un puerto — tiene ahora precedente construido,
probado en tres niveles y ejemplar en este mismo repositorio: `C6-17`
(`ReservationCancelPort`). El diseño concreto está en §5.2. Con el cambio
hecho, la regla que falta es de una línea: prohibir que
`^src/pms-estadias/` importe `^src/reservas/` salvo por un puerto declarado.
Mientras la decisión no se tome, la mitigación de menor radio es la que
C6-02 ya propone como opción (c): una regla con allowlist de 3 archivos y
motivo, para que el cruce siga existiendo pero no pueda crecer en silencio.
¿Requiere modificar código?: Sí. Requiere DECISIÓN DEL DUEÑO (la misma que
C6-02/F5-13 están esperando — no es una decisión nueva).
Prueba necesaria: la de C6-02, sin cambios. Se agrega una de clase: la regla
de `.dependency-cruiser.cjs` con su allowlist, verificada en las dos
direcciones (cruce sin declarar → falla; entrada del allowlist que ya no
matchea → falla), mismo criterio que los diez artefactos manuales del repo.
```

---

### F7-03 — Cero ciclos de archivo, veinte ciclos de carpeta: la única regla de circularidad mide la unidad que no es

```text
Hallazgo: `no-circular` de `.dependency-cruiser.cjs` pasa limpio y eso es
cierto y valioso — no hay ciclos entre ARCHIVOS. Pero la unidad de
arquitectura de este repo es la CARPETA (el bounded context: `reservas/`,
`pos-menu/`, `facturacion/`…), y a ese nivel hay 20 pares con imports en
las dos direcciones, 7 de ellos entre los 6 dominios que
`.dependency-cruiser.cjs` declara como contextos con carpeta propia.
Ninguna regla mira esa capa.

Evidencia: `npx depcruise src --config .dependency-cruiser.cjs
--output-type err` → `✔ no dependency violations found (311 modules, 1528
dependencies cruised)`. Reduciendo el mismo grafo (salida `--output-type
json`) a aristas entre carpetas de primer nivel de `src/` y quedándose con
los pares que existen en ambos sentidos:

  clientes-finanzas <-> reservas        (10 / 14 imports)
  api               <-> reservas        (12 /  8)
  clientes-finanzas <-> facturacion     ( 6 / 13)
  pms-estadias      <-> reservas        ( 8 /  7)   ← F7-02
  facturacion       <-> pos-menu        ( 9 /  6)
  facturacion       <-> reservas        ( 5 /  9)
  domain            <-> repositories    ( 4 /  9)
  clientes-finanzas <-> pos-menu        ( 4 /  8)
  platform          <-> security        (10 /  1)
  api               <-> clientes-finanzas ( 3 / 6)
  clientes-finanzas <-> security        ( 7 /  2)
  api               <-> platform        ( 6 /  2)
  security          <-> types           ( 6 /  1)
  db                <-> platform        ( 1 /  5)
  platform          <-> raíz (container.ts / logger.ts) ( 5 / 1)
  clientes-finanzas <-> pms-estadias    ( 3 /  2)
  pos-menu          <-> workers         ( 2 /  3)
  api               <-> pms-estadias    ( 1 /  3)
  platform          <-> workers         ( 2 /  1)
  api               <-> facturacion     ( 1 /  2)
  → 20 pares.

Tres instancias con nombre y archivo, para que no quede en la tabla:
 · `src/container.ts` importa `src/platform/platform.repository.ts`, y
   `src/platform/platform.container.ts` + `business-hours.routes.ts` +
   `business-modules.routes.ts` + `business-plan-limits.routes.ts` +
   `companies.routes.ts` importan `src/container.ts`. El composition root
   y el módulo de plataforma se importan mutuamente.
 · `src/db/tenant-context.ts` importa `getTenantRawPool` de
   `src/platform/tenant.middleware.ts` (:69): el builder único de la capa
   de persistencia depende de un middleware de transporte. Es la otra cara
   de F7-07.
 · `src/domain/audit.ts` importa `src/repositories/audit-log.repository.ts`
   mientras 9 archivos de `src/repositories/` importan `src/domain/`
   (`errors.ts` ×7, `business-profile.entities.ts` ×2). `domain/` es a la
   vez kernel compartido y módulo con servicios propios.
 · `facturacion` <-> `pos-menu` tiene 15 imports cruzados
   (`facturacion/invoices.routes.ts` → `pos-menu/sql.order.repository.ts`,
   `pos-menu/orders.routes.ts` → `facturacion/invoices.routes.ts`, …)
   mientras `reservas` <-> `pos-menu` tiene 0 y es el único par con regla
   dura. La separación que se declara valiosa es exactamente la que no
   estaba en riesgo.

Impacto: cada par bidireccional es un dominio que no se puede leer, testear
ni extraer solo. `reservas/` participa en 5 de los 20. La consecuencia
práctica no es hipotética: es la razón por la que `facturacion/` tiene dos
orquestadores casi espejo de ~650 líneas (`cancel-order-…` y
`cancel-reservation-…`, 2.º Medio de Fase 2) — el núcleo común no se pudo
compartir porque el grafo no lo permitía sin cruzar una frontera. La
duplicación está documentada como decisión; el ciclo que la fuerza, no.
Causa probable: `no-circular` se escribió con el default de
dependency-cruiser (`to: { circular: true }`, granularidad de módulo =
archivo), y se verificó verde contra el código real antes de dejarla —
correctamente, según su propio docblock. Nadie preguntó después si la
unidad que mide es la que importa en un monolito modular por carpetas.
Nivel de certeza: Alta para los 20 pares (derivados del mismo JSON que
produce la corrida verde) y para las 4 instancias citadas (imports leídos).
Media para el enunciado "cada par es un problema": algunos son kernel
compartido legítimo (`security` <-> `types`: 6 imports contra 1; `domain`
<-> `repositories`) y otros son el composition root haciendo su trabajo
(`api` <-> los dominios). Sin triage, el 20 es una cota superior, no una
lista de defectos.
Severidad: Media-Alta.
Recomendación: dos pasos, en orden. (1) Barato y no invasivo: agregar a
`.dependency-cruiser.cjs` una regla `no-circular` con
`options.moduleSystems`/agrupamiento por carpeta — o, si eso no se puede
expresar en la config, congelar los 20 pares en un test de arquitectura con
el snapshot y el motivo de cada uno (mismo patrón que `EXCLUDED_FILES` de
`RBAC-MATRIX-SECTION2-001`: la deuda queda MEDIDA adentro de la cerca, y un
par nuevo pone la suite roja). Eso no arregla nada y es exactamente por eso
que es el primer paso: hoy el número puede crecer sin que nadie se entere.
(2) Triage de los 20 en tres cubetas — kernel compartido aceptado / ciclo
del composition root (se resuelve con F7-01) / ciclo de dominio real (se
resuelve con puertos, F7-02 y §5.2). Sin (1), el (2) se vuelve a perder.
¿Requiere modificar código?: No para (1) — es un test nuevo, cero líneas de
`src/`. Sí para (2).
Prueba necesaria: el test del paso (1) es la prueba. Verificarlo en las dos
direcciones: par nuevo sin declarar → falla nombrándolo; entrada declarada
que ya no existe en el grafo → falla nombrándola.
```

---

### F7-04 — AFIP: el puerto aísla la respuesta y deja pasar el request; y dos integraciones externas sin ningún puerto

**Reformula el 2.º Alto de Fase 2** (`buildCreditNote()`, ~420 líneas mezclando validación + cálculo + armado del payload AFIP). El lente de Fase 7 agrega el recorrido completo del formato externo por las capas, que ese informe no trazó.

**(a) El puerto de AFIP declara por escrito que el request no lo cruza.** `src/facturacion/afip-billing.port.ts:1-14`, textual: *"el `afipRequest` de entrada queda IGUAL sin importar el SDK — es el protocolo crudo WSFEv1 … Lo que cambia entre SDKs es cómo se llama al método y la forma de la RESPUESTA, así que es eso lo que este puerto normaliza."* Y la firma lo confirma: `createNextVoucher(request: Record<string, unknown>)` (`:47`). El razonamiento es correcto para el objetivo declarado (cambiar de SDK sin tocar `InvoiceService`) y **no** cubre el otro objetivo (que las reglas de negocio no conozcan el protocolo externo). El puerto es el mejor de los cuatro del repo y no protege esta frontera.

**(b) El formato de cable de AFIP atraviesa tres capas.** Trazado:

| Capa | Evidencia |
|---|---|
| Reglas de negocio | `invoice.service.ts:876-894` (factura) y `:1207-1224` (Nota de Crédito) arman el objeto literal con `PtoVta`, `CbteTipo`, `Concepto`, `DocTipo`, `CbteFch`, `ImpTotal`, `ImpNeto`, `MonId: 'PES'`, `Iva`, `CbtesAsoc`. `toAfipDate()` (`:153`, exportada a nivel de módulo) es el formateador `yyyymmdd` de WSFEv1. 28 tokens del protocolo (`Cbte*`/`Imp[A-Z]*`/`PtoVta`/`DocNro`) en el archivo. |
| Persistencia | `src/db/schema.sql:2925` — `afip_request JSONB`. El payload del proveedor externo **es una columna de la base de datos del tenant**. |
| Reintento | `invoice.service.ts:589` — `this.issue(client, invoice, invoice.afipRequest as Record<string, unknown>, …)`. El reintento releé la columna y la reenvía **con un cast sin chequeo**. |

Cambiar de proveedor de facturación electrónica no es "escribir un adapter nuevo": es migrar una columna `JSONB` con el formato del proveedor viejo, más los dos constructores de payload dentro del servicio de negocio.

**(c) Dos de las cuatro integraciones externas no tienen puerto.**

| Integración | Puerto | Quién la llama | Estado |
|---|---|---|---|
| Facturación electrónica | `AfipBillingPort` (4 métodos, docblock que declara su propio criterio de crecimiento) | `InvoiceService`, `PadronService` | Limpio para la respuesta; ver (a)/(b) |
| Email | `EmailSender` + `ResendEmailSender` + `NoopEmailSender` + `createEmailSender()` (`email/email.sender.ts:83,111,142,151`) | servicios y workers | **Ejemplar.** Interfaz, dos implementaciones, factory, fail-open declarado |
| Aprovisionamiento Neon | **ninguno.** `provisionTenantDatabase()` es una función suelta, con `requireEnv()` propio (`neon-provisioning.ts:59-65`) y `fetch` directo a `https://console.neon.tech/api/v2` (`:47`) | `platform/business.routes.ts:176` y `platform/platform.routes.ts:400` — **directo desde handlers Express** | Ver F7-05 |
| Google OAuth | **ninguno.** `verifyGoogleIdToken()` función suelta; caché JWKS **mutable a nivel de módulo** (`google-oauth.ts:57`); `GOOGLE_CLIENT_ID` leído adentro (`:93-99`); `fetch` a `googleapis.com` (`:53,65`) | `security/auth.service.ts:40`, `security/customer.auth.service.ts:12` | Sin puerto → estado global → **export de test en código de producción**: `__resetGoogleJwksCacheForTests()` (`:83`), con un docblock que explica que sin él "6 de 7 casos pasaban por la razón equivocada" |

```text
Hallazgo: de las 4 integraciones externas del backend, una (email) está
detrás de un puerto ejemplar, una (AFIP) tiene un puerto que a propósito
sólo cubre la dirección de vuelta —dejando el protocolo WSFEv1 dentro del
servicio de negocio Y dentro del schema de la BD—, y dos (Neon, Google
OAuth) no tienen ninguno: se invocan como funciones sueltas, leen su propia
configuración del entorno, hacen su propio `fetch`, y una de ellas mantiene
estado mutable de proceso con una puerta trasera de test exportada desde
`src/`.
Evidencia: afip-billing.port.ts:1-14,45-49 · invoice.service.ts:153,
589,876-894,1207-1224 · db/schema.sql:2925 · email/email.sender.ts:83,111,
142,151 · neon-provisioning.ts:47,59-65 + business.routes.ts:176 +
platform.routes.ts:400 · google-oauth.ts:53,57,65,83,93-99 +
auth.service.ts:40 + customer.auth.service.ts:12.
Impacto: (i) no se puede testear la construcción del payload de AFIP sin
`InvoiceService` entero, ni el login con Google sin monkeypatchear `fetch`
global y resetear una caché de módulo; (ii) un cambio de proveedor de
facturación es una migración de datos, no un adapter; (iii) la caché JWKS
compartida por proceso es estado global cross-tenant en una app
multi-tenant — hoy es benigno (las claves de Google son públicas y globales)
pero es el precedente estructural equivocado en el archivo de
autenticación; (iv) `__resetGoogleJwksCacheForTests` viaja a `dist/` y
es invocable en producción.
Causa probable: el repo tiene un criterio explícito y razonable de "sin SDK
nuevo cuando el protocolo es simple" (JWT a mano con `node:crypto`, Resend
con un solo `fetch`). Ese criterio decide bien la DEPENDENCIA y no dice nada
sobre la FRONTERA — y en dos de cuatro casos se aplicó el primero sin el
segundo. El puerto de AFIP existe porque hubo una migración de SDK real que
lo forzó; los otros dos nunca tuvieron ese evento.
Nivel de certeza: Alta. Las 4 integraciones se leyeron completas; la columna
`afip_request` está verificada en el schema; el `as Record<string, unknown>`
del reintento es cita literal.
Severidad: Alta para (b) — es dinero, AFIP y el schema de la BD.
Media para (c).
Recomendación: NO envolver AFIP entero (el propio puerto advierte contra
"envolver el SDK por las dudas", y tiene razón). Tres bloques chicos e
independientes: (1) mover el armado del payload a un
`afip-request.builder.ts` de `facturacion/`, sin cambiar el formato ni la
columna — puro movimiento, testeable solo, radio 1 archivo + tests; es
además el primer corte natural del `buildCreditNote()` de 420 líneas del
2.º Alto de Fase 2, así que los dos hallazgos se pagan con el mismo
bloque. (2) `GoogleTokenVerifier` como interfaz de un método, inyectada en
los dos `*.auth.service.ts` — elimina el export de test y el estado global
del camino de autenticación. (3) `TenantProvisioner` como interfaz de un
método, que es además el prerrequisito de F7-05. Ninguno de los tres
requiere decisión de negocio.
¿Requiere modificar código?: Sí. No implementado.
Prueba necesaria: para (1), un test unitario del builder que fije el payload
byte a byte contra el que produce hoy el servicio (característica de
regresión antes de mover). Para (2), los 7 casos de
`google-oauth.test.ts` reescritos contra un fake, sin
`__resetGoogleJwksCacheForTests` — si pasan sin él, el estado global se fue.
```

---

### F7-05 — La saga de aprovisionamiento de tenant (API externa → DDL → cifrado → 2 escrituras) vive en cuatro handlers Express, duplicada, con políticas de fallo distintas

```text
Hallazgo: la secuencia que da de alta la base de datos de un negocio nuevo
—llamar a la API de Neon, aplicar `schema.sql` completo, cifrar el
connection string, activar el negocio, registrar la versión de schema— no
existe como unidad en ningún lado. Está escrita cuatro veces, a mano, en
tres archivos de rutas, con diferencias de contenido y de política de fallo
entre copias. Es simultáneamente el peor caso de "lógica de negocio en el
controlador", de "servicio externo mezclado con reglas internas" y de
"acción irreversible sin gate" del repositorio.

Evidencia, las cuatro copias:
 1. `src/platform/business.routes.ts:176-181` (alta pública `POST /register`)
    provisionTenantDatabase → applyTenantSchema → encryptConnectionString →
    activateBusiness → updateSchemaVersion.
    Política de fallo: **fail-open declarado** (`:182-184`) — el `catch`
    loguea y el negocio queda `PENDING`; el registro devuelve 201.
 2. `src/platform/platform.routes.ts:399-404`
    (`POST /platform/businesses/:id/provision`, el "reintentar" del
    superadmin). Comentario propio, `:385-386`: *"Misma secuencia que
    business.routes.ts"*. Misma secuencia de 5 pasos.
    Política de fallo: propaga con `next(err)` → 500.
 3. `src/platform/admin.routes.ts:95-99` (`POST /api/admin/repair-tenant-db`)
    applyTenantSchema → encryptConnectionString → activateBusiness →
    updateSchemaVersion → **evictTenantPool** (paso extra que 1 y 2 no tienen).
 4. `src/platform/admin.routes.ts:143-147` (`POST /api/admin/set-tenant-url`)
    idéntica a la 3, con el comentario *"Mismo criterio que
    repair-tenant-db"* (`:139-140`).
 Y la quinta implementación de la misma idea, fuera de rutas:
    `src/scripts/migrate-tenants.ts:65` (`npm run migrate:tenants`, que corre
    en el `buildCommand` de `render.yaml` contra TODAS las tenant DB).

Ninguna de las cuatro es transaccional — no puede serlo: cruza la API de
Neon, una BD de tenant y la BD de plataforma. Ninguna tiene compensación.
Ninguna vive detrás de una interfaz. Las dos de `admin.routes.ts` leen
`DB_ENCRYPTION_KEY` del entorno dentro del handler y responden un
`500 MISSING_DB_ENCRYPTION_KEY` a mano (`:129-136`).

Un dato que agrava lo anterior: `src/server.ts:14` afirma en su docblock
*"Tenant schemas se aplican vía tenant.middleware al primer request del
tenant."* Eso es falso. `applyTenantSchema` no se llama nunca desde
`tenant.middleware.ts`; lo que ese middleware hace es COMPARAR
`business.schema_version` contra `CURRENT_SCHEMA_VERSION` y emitir un
`logger.warn` (`tenant.middleware.ts:91-96`, warn-only declarado en su
propio docblock `:8-12`). O sea: el entry point del proceso documenta que
la aplicación del schema pasa por un camino que no existe.

Impacto: es una acción irreversible y de radio ancho (crea
infraestructura, corre DDL) invocada desde cuatro handlers HTTP sin un solo
lugar que la describa. Un cambio en la secuencia —por ejemplo agregar el
`evictTenantPool` que hoy tienen 2 de 4— hay que aplicarlo a mano en cuatro
sitios; que dos de las cuatro ya diverjan es la evidencia de que eso no
ocurre. El fail-open de la copia 1 es una decisión declarada y correcta
para el alta pública; el hecho de que las otras tres tengan políticas
distintas sin que ninguna lo mencione, no. Y la afirmación falsa de
`server.ts` es exactamente el modo de falla que el `CLAUDE.md` de este repo
ya narra dos veces (el "LOCAL/sin pushear", el roadmap sin revalidar): un
documento que lleva un dato que sólo el código puede responder.
Causa probable: la secuencia se escribió primero para el alta pública, y
cada vez que hizo falta un camino nuevo (reintento del superadmin, reparar
a mano, apuntar a una URL propia) se copió el bloque al handler nuevo — es
más rápido que extraerlo, y en un repo que commitea directo a `main` sin PR
nadie ve las cuatro copias juntas.
Nivel de certeza: Alta. Los cuatro handlers y el script se leyeron
completos; las divergencias (`evictTenantPool`, política de fallo) están
verificadas línea por línea. La afirmación falsa de `server.ts` se verificó
buscando TODOS los call-sites de `applyTenantSchema` (4 en rutas + 1 en el
script, 0 en middleware).
Severidad: Alta.
Recomendación: extraer un `platform/tenant-provisioning.service.ts` con UN
método (`provisionAndActivate(businessId, source, connectionString?)`) que
contenga los 5 pasos, reciba el `TenantProvisioner` de F7-04(c) como
dependencia inyectada, y declare en su contrato qué pasa en cada punto de
fallo y cuál es el estado resultante — incluido el `evictTenantPool`, que
pasa a ser parte de la secuencia y no de dos de sus copias. Los cuatro
handlers quedan en 3 líneas cada uno y siguen eligiendo su política de
respuesta (fail-open en el alta pública, 500 en el panel), que es lo único
que legítimamente difiere entre ellos. Aparte y en el mismo bloque:
corregir el docblock de `server.ts:14`. El orden importa — esto NO se toca
antes de F7-04(c) y no se toca sin backup durable, porque el camino corre
DDL contra bases de datos de producción (criterio `irreversible-action-gate`
que el propio repo declara).
¿Requiere modificar código?: Sí. No implementado. El bloque de docs
(`server.ts:14`) es independiente y se puede hacer solo, hoy.
Prueba necesaria: una característica de regresión ANTES de extraer — un
test de integración por cada uno de los 4 caminos que asere el estado final
(`businesses.status`, `db_url_encrypted` presente, `schema_version`, pool
evictado o no). Hoy las 4 copias no tienen ese test en común, así que la
extracción sería a ciegas. La prueba de que la extracción no cambió nada es
que los 4 tests pasen sin modificarse.
```

---

### F7-06 — La configuración no tiene capa: 30 variables en 26 archivos, 11 sin declarar, un mismo knob resuelto de cinco formas y un literal triplicado

```text
Hallazgo: `src/config/` existe y ya no contiene configuración — sólo el
`interface PlanLimits` (los valores se movieron a la BD de plataforma el
18/08/2026, declarado en su propio docblock). La configuración real está
repartida en tres estratos sin relación entre sí: variables de entorno
leídas en el punto de uso, constantes literales en archivos de dominio y
de transporte, y un manifiesto de deploy que declara poco más de la mitad
de lo que el código lee.

Evidencia — estrato 1, entorno:
 · 30 nombres distintos leídos desde `src/`, en DOS estilos de acceso que
   ningún grep encuentra a la vez: `process.env.X` (27 nombres) y
   `process.env['X']` (9 nombres, entre ellos `HEALTH_DB_TTL_MS`,
   `HEALTH_DB_FAIL_TTL_MS`, `API_BASE`, `CONNECTIONS`, `START_OFFSET_DAYS`,
   que la primera forma no ve).
 · leídos desde 26 archivos distintos. Los 6 con más lecturas: `app.ts` (6),
   `db/pg.client.ts` (4), `platform/admin.routes.ts` (3),
   `workers/outbox.registry.ts` (2), `security/auth.service.ts` (2),
   `email/email.sender.ts` (2).
 · `render.yaml` declara 16 claves. **En el código y no en `render.yaml`:**
   `JWT_EXPIRES_IN`, `LOG_LEVEL`, `MAX_TENANT_POOLS`, `DB_POOL_MAX`,
   `DB_POOL_IDLE_MS`, `DB_ENCRYPTION_KEY_OLD`, `PORT`, `DATABASE_URL`,
   `BUSINESS_ID`, `HEALTH_DB_TTL_MS`, `HEALTH_DB_FAIL_TTL_MS` (11).
   En `render.yaml` y no en el código: `NODE_VERSION` (1, correcto — la usa
   Render).
 · el backend **no tiene `.env.example`**. El frontend sí. O sea: el repo
   con 30 knobs no tiene inventario y el repo con 2 sí.

Evidencia — estrato 2, el mismo knob resuelto de cinco formas. El TTL del
token de sesión de staff:
 1. `security/auth.service.ts:98` — `parseExpiresIn(process.env.JWT_EXPIRES_IN ?? '24h')`
 2. `security/customer.auth.service.ts:66` — la misma línea, otra vez
 3. `api/routes/customer.routes.ts:646` — la misma línea, **dentro de un
    handler**, importando `parseExpiresIn` de `auth.service.js`
 4. `security/auth.middleware.ts:112` — parámetro con default `expiresIn = 86_400`
 5. `platform/business.routes.ts:189` — `const EXPIRES_IN_SECONDS = 86_400`,
    **hardcodeado**, en el handler del alta pública de negocio.
 Consecuencia medible: si el dueño pone `JWT_EXPIRES_IN=1h`, los logins de
 `api/routes/auth.routes.ts:178,228,273` (que usan `result.expiresIn`, o sea
 el valor configurado) duran 1 hora, y el token que recibe un dueño al
 registrar su negocio dura 24. Nada en el código relaciona los dos sitios.

Evidencia — estrato 3, literales de política en archivos de transporte y de
dominio:
 · `DEFAULT_SENDER_NAME = 'ZuluHub'` declarado **tres veces**, en tres
   archivos, uno de ellos exportado desde un `*.routes.ts`:
   `usuarios-roles/password-reset.routes.ts:34` (exportado),
   `usuarios-roles/user-invitation.routes.ts:60` (const local),
   `email/email.sender.ts:71` (el "correcto", usado por los workers).
 · `PASSWORD_RESET_EXPIRES_HOURS = 24` en
   `usuarios-roles/password-reset.routes.ts:33` — una política de seguridad
   viviendo en un archivo de rutas, importada desde
   `usuarios-roles/users.routes.ts:49,393`.
 · `OUTBOX_RETENTION_DAYS = 90` en `platform/outbox-purge.ts:47` —
   constante pura, sin variable de entorno, consumida por un endpoint
   (`platform.routes.ts:16`) y por un script.
 · `MAX_TENANT_POOLS` con default `'200'` en `platform/tenant.middleware.ts:60`.
 · el límite de paginación de reservas: "default 50, tope 200, global, no
   por plan/tenant" — declarado textualmente en
   `reservas/reservations.routes.ts:243-249`.
 · en el frontend, `MAX_RETRIES = 3` y `BASE_DELAY_MS = 1_500` en
   `src/lib/http.ts:61-63`.

Impacto: (i) nadie puede responder "qué se puede configurar en este
sistema" sin grepear dos veces con dos patrones distintos; (ii) el caso
del TTL no es teórico — es una divergencia de comportamiento medible hoy;
(iii) tres copias de `'ZuluHub'` significan que cambiar el nombre de la
marca es una cacería, no una edición; (iv) los knobs sin declarar en
`render.yaml` son invisibles para quien opera el deploy: existen y nadie
sabe que existen.
Causa probable: el repo hizo bien el movimiento difícil (sacar `PLAN_LIMITS`
de una constante TS a la tabla `plan_limits` de la BD de plataforma) y
nunca hizo el fácil (un módulo que lea el entorno una vez y lo valide).
Cada valor nuevo se leyó donde se necesitaba, que siempre es el camino de
menor resistencia y siempre produce esto.
Nivel de certeza: Alta. Todos los números salen de barridos completos sobre
`src/` y del cruce con `render.yaml`; las 5 formas del TTL y las 3 del
sender están leídas línea por línea.
Severidad: Alta. No por el riesgo de cada ítem suelto, sino porque es la
capa que el protocolo nombra explícitamente y es la única de las ocho que
no tiene ningún lugar propio.
Recomendación: un `src/config/env.ts` que lea y valide TODAS las variables
UNA vez al arrancar (Zod, que ya está en el repo), exporte un objeto
congelado y falle ruidosamente al boot si falta una obligatoria —
`honest-degradation`, criterio que el propio `CLAUDE.md` declara y que este
repo aplica bien en otros lados (`migrate:tenants` tumba el build, OAuth
fail-closed) y mal acá (`db/pg.client.ts::sslConfig()` cae a `ssl: false`
en silencio si falta `NEON_SSL`, hallazgo ya registrado en `CLAUDE.md`).
Después, tres bloques chicos e independientes: mover
`PASSWORD_RESET_EXPIRES_HOURS` y los literales de política ahí; dejar UNA
declaración de `DEFAULT_SENDER_NAME` (la de `email/`) y borrar las otras
dos; y hacer que `business.routes.ts:189` use el mismo TTL configurado que
`auth.routes.ts`. El tercero es el único con cambio de comportamiento
observable (el token del alta pública pasa a respetar `JWT_EXPIRES_IN`) —
chico, pero es un cambio, no una limpieza.
Nota de regla de negocio: varios de estos literales son candidatos a
configuración por tenant o por producto, no a constante global —
`OUTBOX_RETENTION_DAYS`, el tope de paginación (cuyo propio comentario
declara que es "global, no por plan/tenant"), `PASSWORD_RESET_EXPIRES_HOURS`.
Eso NO se decide en esta fase: es la misma clase de decisión que `PLAN_LIMITS`
ya resolvió moviéndose a la BD de plataforma, y cada uno merece su pregunta
propia. Lo que esta fase afirma es sólo que hoy no hay ningún lugar donde
esa pregunta se pueda siquiera formular.
¿Requiere modificar código?: Sí. Los tres primeros bloques no requieren
decisión del dueño. La conversión de un literal en configuración por tenant,
sí, uno por uno.
Prueba necesaria: una cerca de conteo, del tipo que el repo ya usa diez
veces: `process.env` (en los dos estilos) fuera de `src/config/env.ts` tiene
que ser 0, con allowlist y motivo (`instrument.ts` antes del boot,
`scripts/`). Congelar el 30 actual antes de mover nada.
```

---

### F7-07 — Un middleware de transporte es dueño del pool, del LRU, de la versión de schema y del ciclo de vida de los workers

**Reformula `C6-05`** (el tipo que miente sobre la garantía de `req.db`) **y `C6-06`** (`TransactionManager.run()` sin cláusulas de contrato). Esos dos documentaron el **contrato**; lo que sigue es la **capa**, que es lo que no se documentó.

```text
Hallazgo: `src/platform/tenant.middleware.ts` es un middleware de Express
—capa de transporte— y es el único dueño de: la resolución de tenant, el
descifrado del connection string, la creación y el cacheo de los pools de
Postgres, la política de evicción LRU, el chequeo de versión de schema, y
el arranque y la parada de los workers de outbox. Seis responsabilidades de
cuatro capas distintas en un middleware.

Evidencia: su propio docblock las enumera (`:1-27`, 7 pasos). Instancias:
 · pool + cache + LRU: `:44-60` (`MAX_TENANT_POOLS`, default 200) y el
   comentario que explica por qué el LRU tuvo que volverse real ("una fuga
   de conexiones pg y de timers de 5s (uno por OutboxWorker) que nunca se
   libera sola").
 · versión de schema: `:91-96`, warn-only.
 · ciclo de vida de los workers: `:37` importa `ensureTenantWorker`/
   `stopTenantWorker` de `workers/outbox.registry.js`; `:207` los arranca.
 · la dirección de dependencia invertida que esto produce:
   `src/db/tenant-context.ts:69` —el "único lugar autorizado" para
   construir un `PgTransactionManager` de tenant, según su propio
   docblock— importa `getTenantRawPool` DE este middleware. La capa de
   persistencia depende de la de transporte. Es una de las 20 aristas de
   F7-03 (`db` <-> `platform`).
 · `ensureTenantWorker` tiene exactamente dos call-sites en producción:
   `tenant.middleware.ts:207` y `api/routes/customer.routes.ts:582`. Los
   dos son handlers/middlewares HTTP. Ninguno es `server.ts`.

Consecuencia estructural, no hipotética: **el drenaje del outbox de un
tenant depende de que a ese tenant le llegue tráfico HTTP.** Si un negocio
no recibe requests, su `OutboxWorker` no está corriendo y sus eventos de
dominio esperan. Si el LRU lo desaloja (201.º tenant activo), su worker se
detiene (`stopTenantWorker`). `src/server.ts:63-64` lo dice sin problematizarlo:
*"Los workers de outbox por tenant arrancan desde tenantMiddleware."*
Impacto: los efectos financieros de `workers/outbox.handlers.ts` (crear
transacciones financieras al confirmar/completar/cancelar una reserva o una
orden, 789 líneas, Medio de Fase 2) quedan acoplados al tráfico HTTP del
negocio. Para un PMS donde el uso es por ráfagas (un hotel chico que abre
el panel dos veces al día) eso no es lo mismo que "eventualmente
consistente": es "consistente cuando alguien abra el navegador". Segundo
impacto: `C6-05` ya midió que el tipo `req.db: SqlClient` (no opcional)
miente porque ESTE middleware tiene una rama que hace `next()` sin fijarlo
(`:193-196`) — el lente de capas agrega por qué la mentira es inevitable
mientras la garantía la dé un middleware: un tipo global no puede expresar
"esto lo cumple el pipeline A y no el pipeline B".
Causa probable: `req.db` es la forma natural de pasar el pool del tenant a
un handler, y una vez que el middleware tiene el pool es el lugar más
barato para colgarle todo lo demás que depende del pool. Cada paso fue
localmente razonable; los siete juntos no los diseñó nadie. El propio
archivo documenta dos fixes reactivos sobre esto (el LRU que antes sólo
warneaba, la `sslConfig` que antes era una copia divergente con
`rejectUnauthorized: false`) — señal de que la acumulación ya produjo
defectos reales, no sólo desorden.
Nivel de certeza: Alta para las seis responsabilidades y para la inversión
`db → platform` (imports leídos). Alta para "el worker arranca sólo desde
HTTP" (2 call-sites, barrido completo). **Media** para el impacto
operativo del outbox sin tráfico: no se midió contra producción.
  No confirmado.
  Información faltante: cuánto tarda en drenarse el outbox de un tenant sin
  tráfico, y si algún tenant real tiene hoy eventos `PENDING` viejos por
  esta causa.
  Cómo verificarlo: `SELECT business_id, count(*), min(created_at) FROM
  domain_events WHERE processed_at IS NULL GROUP BY 1` en cada tenant DB
  (o vía el endpoint de `/api/system`), cruzado contra la última actividad
  HTTP de ese negocio.
Severidad: Alta para la parte de outbox si la verificación confirma retraso
real; Media para la separación de capas en sí.
Recomendación: dos separaciones, independientes entre sí y de bajo riesgo
cada una. (1) Sacar la resolución y el cacheo de pools a un
`platform/tenant-pool.registry.ts` que no conozca Express, y dejar el
middleware como un adaptador de 15 líneas que llama al registry y cuelga el
resultado en `req`. Eso da vuelta la flecha `db → platform` y hace testeable
el LRU sin levantar Express. (2) Arrancar los workers desde `server.ts`
sobre la lista de negocios activos de la BD de plataforma, no desde el
request. El (2) es un cambio de comportamiento operativo (más timers
corriendo, drenaje independiente del tráfico) y necesita la verificación de
arriba antes de decidirse — no es una limpieza.
¿Requiere modificar código?: Sí. El (1) no requiere decisión del dueño; el
(2) sí, y depende del resultado de la query.
Prueba necesaria: para (1), los tests de `tenant.middleware.test.ts` y
`tenant-isolation.test.ts` deben pasar sin modificarse — son la
característica de regresión. Para (2), la query de arriba antes y un test
de integración que asere que el outbox de un tenant sin requests avanza.
```

---

### F7-08 — Un servicio saltea su propio repositorio y escribe SQL; el repo ya midió la consecuencia: nueve tests verdes que no prueban nada

```text
Hallazgo: `OrderService` —capa de aplicación— ejecuta SQL crudo contra las
tablas `orders` y `order_items`, salteando `IOrderRepository`. La
consecuencia no es teórica y no la descubrió esta auditoría: está medida y
declarada por el propio repositorio, en el test.

Evidencia:
 · `src/pos-menu/order.service.ts:602-606`:
     await client.query('UPDATE orders SET total_amount = $1, updated_at = NOW() WHERE id = $2', [total, id]);
 · `src/pos-menu/order.service.ts:626-632` (`recalculateTotalWithClient`):
     UPDATE orders SET total_amount = COALESCE((SELECT SUM(subtotal) FROM order_items WHERE order_id = $1), 0), …
 · el docblock que lo justifica (`:613-624`) es honesto y su razonamiento es
   correcto en su propio marco: no se calcula en JS porque
   `SqlOrderRepository.getByIdForUpdate()` devuelve una foto nueva mientras
   `InMemoryOrderRepository.getByIdForUpdate()` devuelve la MISMA
   referencia sobre la que `addItemWithClient()` ya hizo `push()` — sumar el
   ítem aparte lo contaría dos veces en memoria.
 · y la consecuencia, escrita por el propio repo en
   `src/pos-menu/order.service.test.ts:1224-1241`, textual: *"`InMemoryTransactionManager`
   le pasa a `recalculateTotalWithClient()` un `client.query()` que es un
   no-op … Si se borrara esa llamada de `OrderService.addItem()`/`removeItem()`,
   estos 9 tests seguirían en verde -- exactamente el mismo modo de falla
   que dejó vivir el bug real (el fake hace bien lo que el SQL hacía mal)."*
   La cobertura real vive sólo en
   `src/tests/integration/order-flow.integration.test.ts`.
 · es el ÚNICO caso del repo: barrido de `SELECT|INSERT INTO|UPDATE … SET|
   DELETE FROM` en archivos que no son `*repository.ts` ni `*.routes.ts` →
   el resto de los hits son comentarios, salvo el `pg_advisory_xact_lock` de
   `clientes-finanzas/payment-application.ts:49`, que es una primitiva
   deliberada y documentada.

Impacto: es el criterio "pruebas aisladas" de la arquitectura objetivo
fallando en un caso concreto. Nueve tests unitarios del ciclo de vida de
una orden —dinero— son verdes por una razón distinta de la que el lector
supone, y el repo lo sabe. La causa raíz no es el SQL: es que la abstracción
del repositorio tiene DOS implementaciones con semántica de aliasing
distinta, y ninguna de las dos lo declara en su contrato (es la clase de
hueco de `C6-06`/`C6-08`, aplicada al aliasing en vez de a la opcionalidad).
Saltear el repositorio fue la reacción correcta a ese defecto y dejó el
servicio acoplado al nombre de dos tablas y de dos columnas.
Causa probable: el fix de ORDER-17 (05/09/2026) resolvía un bug real de
`total_amount`; el camino más corto y verificable contra Postgres era el
SQL. El defecto de contrato subyacente (qué garantiza `getByIdForUpdate()`
sobre la identidad del objeto devuelto) nunca se nombró como tal.
Nivel de certeza: Alta. Las dos queries, el docblock que las justifica y el
docblock que declara la consecuencia son citas literales.
Severidad: Media.
Recomendación: declarar el contrato de aliasing en `IOrderRepository`
—`getByIdForUpdate()` devuelve una copia, nunca una referencia viva— y
hacer que `InMemoryOrderRepository` lo cumpla (un clon superficial). Con eso,
el recálculo puede volver al repositorio (`orderRepo.recalculateTotalWithClient`)
sin el riesgo de doble conteo, y los 9 tests unitarios vuelven a probar lo
que dicen probar. Es el mismo patrón que `C6-17` aplica a los desenlaces:
resolver en el CONTRATO lo que hoy se resuelve con un `if` o con un bypass.
¿Requiere modificar código?: Sí. No requiere decisión del dueño.
Prueba necesaria: los 3 tests de `ORDER-17` de
`order-flow.integration.test.ts` (Postgres real) son la característica de
regresión y no se tocan. Se agrega uno que borre a propósito la llamada al
recálculo y asere que los 9 unitarios se ponen ROJOS — si siguen verdes, el
fix no funcionó.
```

---

### F7-09 — Cinco documentos se declaran fuente de verdad del contrato HTTP; el que más lo afirma cubre 20 de 262 endpoints y afirma algo que ya se midió falso

`docs/HTTP_CONTRACTS.md` está **declarado fuera de alcance** en `docs/auditoria-integral-fase6-2026-09-15.md` §8.1, que lo nombra como "el primer candidato obvio". Se audita acá.

```text
Hallazgo: el contrato HTTP de este sistema está declarado en cinco lugares,
tres de los cuales se autodenominan fuente de verdad. Ninguna herramienta
cruza el CONTENIDO de uno contra otro; la única cerca que existe verifica
EXISTENCIA de rutas para uno de los cinco.

Evidencia, los cinco:
 1. `docs/HTTP_CONTRACTS.md` (228 líneas). Línea 3-4, textual: *"Es la
    fuente de verdad para implementar el cliente API del frontend."*
    Cubre **20 filas de endpoint, 5 recursos** (categorías, recursos,
    reservas, autenticación, usuarios) de los **262** reales. Sin fecha, sin
    "última actualización", sin condición de retiro.
 2. `src/openapi/spec.ts` (1023 líneas). OpenAPI 3.0.3 escrito a mano.
    Cubre ~18 de 262. Tiene cerca: `CONTRACT-001`
    (`openapi-spec-route-sync.test.ts`), que verifica que cada path+método
    documentado EXISTA — no la forma del request/response.
 3. `docs/inventario-rutas.md` (275 líneas). Generado
    (`npm run docs:routes`), 262 endpoints, verificado en CI. Es el único
    de los cinco que no puede quedar stale — y a propósito no dice nada
    sobre forma ni permisos.
 4. `appfrontend/src/lib/http.ts:10-21` — el tipo `ApiError`, la unión
    discriminada que el frontend realmente implementa.
 5. `src/api/middleware/error.middleware.ts:1-20` — se declara fuente de
    verdad de la serialización de errores, y declara además su propio
    bypass: *"PlanLimitError y los errores de plataforma se capturan
    localmente en cada router … antes de llegar aquí."*

La contradicción concreta, medible: `HTTP_CONTRACTS.md:13` afirma *"Todos
los errores devuelven al menos `code` y `message`"* y `:27` afirma que
`VALIDATION_ERROR` trae `errors` con *"shape de ZodError.flatten()"*.
`C6-03` midió que **dos de las cuatro formas vivas de 400** no cumplen eso:
la Forma A emite el array crudo de `ZodIssue` (≥14 archivos, p. ej.
`reservations.routes.ts:308`, `orders.routes.ts:193`) y la Forma B emite
`{path: string, message}[]` (helper `validationError()` duplicado en
`orders.routes.ts:143-145` y `cash-register.routes.ts:57-59`). El documento
que se declara fuente de verdad del cliente describe el contrato que el
cliente implementa y que el servidor cumple en ~la mitad de los call-sites.
Se agrega una forma que `C6-03` no contó, porque no pasa por Zod:
`api/routes/audit-log.routes.ts:39-45` emite `{code: 'VALIDATION_ERROR',
message}` **sin `errors`**, validando a mano con
`String(req.query['entity'] ?? '')`. No es una quinta serialización de Zod
—es validación escrita a mano con el código de Zod—, así que
`extractFieldErrors()` del frontend devuelve `{}` y el usuario ve el
`message` genérico.
Y una contradicción más, de mecanismo de sesión: `HTTP_CONTRACTS.md:113-205`
incluye una "Guía de implementación para el frontend" cuyo troubleshooting
instruye `localStorage.clear(); sessionStorage.clear()` para forzar el
logout. Desde B2 (13/08/2026) la sesión de staff es una cookie httpOnly
(`appfrontend/src/lib/http.ts:127-133`, `credentials: 'include'`;
`AuthContext.tsx:6` declara el cambio) — `localStorage.clear()` no cierra
nada. El documento instruye un procedimiento que dejó de funcionar hace un
mes.
Impacto: un desarrollador (o un modelo) que necesite el contrato de un
endpoint tiene cinco lugares donde mirar, ninguna regla de precedencia, y
tres de ellos pueden estar mal sin que nada falle. El costo ya se pagó:
`C6-03` documenta el precedente registrado en el propio repo
(`appfrontend/.../ordenes/page.tsx:179-180`, "el alta fallaba siempre").
Causa probable: `HTTP_CONTRACTS.md` se escribió cuando la API tenía ~20
endpoints y era, en ese momento, exactamente lo que dice ser. Creció la API,
no el documento, y nadie lo retiró — el mismo modo de falla que el propio
`CLAUDE.md` ya narra para `roadmap-pms-multirubro.md` (25/08/2026:
"pasó semanas sin revalidarse … todo lo que quedaba ❌ había desaparecido
del radar sin que nadie lo decidiera"). La diferencia es que el roadmap
tiene ahora una regla de revalidación y este documento no.
Nivel de certeza: Alta. Los cinco documentos se leyeron; los conteos (20
filas, 5 recursos, 262 endpoints) son medidos; la contradicción de las
Formas A/B está medida por `C6-03`; la de `localStorage` se verificó contra
el frontend (los únicos `localStorage.getItem('token')` vivos están en
`appfrontend/src/app/admin/page.tsx:24,110`, la página huérfana de F7-14 —
ningún camino de login actual escribe esa clave).
Severidad: Alta. Es el chequeo "una única fuente de verdad" de la
arquitectura objetivo, fallando en la superficie más consultada del sistema.
Recomendación: NO completar `HTTP_CONTRACTS.md` a mano — es el modo de falla
que ya causó `CONTRACT-001` y que el repo ya rechazó explícitamente al
resolver `CONTRACT-COVERAGE-001` generando el inventario en vez de escribirlo.
Tres bloques: (1) declarar la precedencia en el encabezado de los tres
documentos (inventario = existencia, generado; `spec.ts` = forma, a mano, 18
endpoints; `HTTP_CONTRACTS.md` = ?). (2) Decidir qué es
`HTTP_CONTRACTS.md`: si es el catálogo de `code → status` + campos extra,
entonces retirarle la tabla de endpoints (que `inventario-rutas.md` ya cubre
mejor) y la guía de implementación (que está mal), y dejarlo en lo que sí
aporta y nadie más tiene. (3) Corregir las dos afirmaciones falsas
(`localStorage`, "todos los errores devuelven `code` y `message`" → declarar
las Formas A/B como deuda medida, con su conteo, mismo criterio que
`EXCLUDED_FILES`). El (3) se puede hacer hoy, solo, sin tocar código.
¿Requiere modificar código?: No para (1) y (3) — son docs. Sí para unificar
las formas de 400, que es `C6-03`/`F5-04` y ya está en su propia cola.
Prueba necesaria: para que el (2) no se vuelva a podrir, la cerca de la
clase que el repo ya usa siete veces: parsear las filas de endpoint de
`HTTP_CONTRACTS.md` y cruzarlas contra `docs/inventario-rutas.md` en las dos
direcciones, con allowlist y motivo. Si el (2) le saca la tabla de
endpoints, esta cerca no hace falta — y eso es el argumento a favor del (2).
```

---

### F7-10 — Dos convenciones de validación vivas, y un handler que valida a mano y hace un join cross-BD

```text
Hallazgo: la validación de entrada tiene un lugar propio y bien hecho
(`src/api/schemas/`, 18 archivos), y conviven con él 46 `z.object()`
declarados inline dentro de 16 `*.routes.ts` — cuatro archivos usan las dos
convenciones a la vez. Y hay un handler que no usa ninguna de las dos.

Evidencia, medido sobre los 39 `*.routes.ts` no-test:
 · 46 `z.object(` inline en 16 archivos. Los mayores:
   `clientes-finanzas/customers.routes.ts` 9, `platform/platform.routes.ts` 6,
   `api/routes/customer.routes.ts` 6, `usuarios-roles/user-invitation.routes.ts` 3,
   `usuarios-roles/password-reset.routes.ts` 3, `api/routes/auth.routes.ts` 3.
 · 21 archivos importan de `api/schemas/`.
 · 4 archivos hacen las dos cosas: `customers.routes.ts`,
   `reservas/resources.routes.ts`, `pos-menu/products.routes.ts`,
   `clientes-finanzas/cash-register.routes.ts`.
 · el reparto no sigue ninguna línea visible: los 5 dominios "nuevos"
   (`pos-menu`, `pms-estadias`, `facturacion`, `reservas`) están casi todos
   del lado de `api/schemas/`; `usuarios-roles/` y `platform/` están casi
   todos del lado inline. Es una frontera temporal, no de diseño.
 · el positivo que hay que decir: `zod` no se importa en NINGÚN archivo
   fuera de `src/api/` y `src/app.ts` (barrido completo). La validación no
   se filtró a los servicios ni a las entidades. Eso está bien y es raro.
 · el caso sin ninguna convención:
   `src/api/routes/audit-log.routes.ts:36-45` valida con
   `String(req.query['entity'] ?? '')` + un `if (!entity || !entityId)` y
   emite un 400 a mano. Y el mismo handler (`:47-56`) hace la orquestación
   completa: lee el audit log de la BD del TENANT
   (`new SqlAuditLogRepository(req.db!)`), resuelve los nombres de los
   autores contra la BD de PLATAFORMA (`platformRepo.findIdentitiesByIds`),
   arma el `Map` y enriquece las filas. Un join entre dos bases de datos,
   en un handler de 30 líneas, sin capa de servicio.
 · seis archivos de rutas no tienen ni schema importado ni `z.object`
   inline: `platform/business-context.routes.ts`,
   `platform/business-plan-limits.routes.ts`,
   `platform/business-modules.routes.ts`, `api/routes/system.routes.ts`,
   `api/routes/me.routes.ts`, `api/routes/audit-log.routes.ts`.
   Verificado: los tres de `platform/` exponen un único `router.get('/')`
   sin parámetros, así que no tienen nada que validar. No es un hueco.

Impacto: (i) para saber qué acepta un endpoint hay que mirar dos lugares
posibles, y en 4 archivos los dos; (ii) los schemas inline no son
reutilizables ni referenciables desde `spec.ts` (que importa de
`api/schemas/`), lo que alimenta F7-09; (iii) el handler de audit-log es el
caso de manual del chequeo 1 del protocolo — la lógica de aplicación (un
join cross-BD) está en el controlador, y como está en el controlador no se
puede testear sin Express ni reusar desde otro lado.
Causa probable: `api/schemas/` nació con la estructura por capas
(ver F7-13); cuando la estructura se movió a carpetas por dominio, los
archivos nuevos siguieron importando de ahí (bien) y los que no tenían
schema todavía declararon el suyo donde estaban (`usuarios-roles/`,
`platform/`). Nadie decidió que hubiera dos convenciones; tampoco nadie
decidió que hubiera una.
Nivel de certeza: Alta. Todos los conteos son medidos por archivo; el
handler de audit-log se leyó completo.
Severidad: Media.
Recomendación: elegir UNA y escribirla en `CLAUDE.md` (hoy no está: la
sección "Modularidad" del `CLAUDE.md` de `app-main` habla de dónde viven los
TIPOS, no los schemas). Dado que 21 archivos ya importan de `api/schemas/` y
que `spec.ts` depende de ello, la convención con menos movimiento es
`api/schemas/<dominio>.schemas.ts`. Mover los 46 inline es mecánico y se
puede hacer por dominio, un archivo por bloque. Aparte y de menor radio:
extraer el join de `audit-log.routes.ts` a un servicio —es el mismo caso y
la misma solución que el 4.º Alto de Fase 2 (`customers.routes.ts` sin capa
de servicio), en versión chica: 30 líneas en vez de 956.
¿Requiere modificar código?: Sí, mecánico. No requiere decisión del dueño
más allá de elegir la convención.
Prueba necesaria: cerca de conteo: `z.object(` en `*.routes.ts` tiene que
ser 0, allowlist con motivo. Congelar el 46 antes de mover.
```

---

### F7-11 — La cerca de arquitectura depende de una convención de nombres que cinco archivos rompen, y dos carpetas enteras están fuera de su alcance

```text
Hallazgo: `.dependency-cruiser.cjs` es el único mecanismo de arquitectura
del repo y está bien pensado (5 reglas de dominio, medidas contra el código
antes de escribirse, corriendo en CI vía `lint:arch`). Tiene tres huecos
estructurales —no de configuración— que hacen que pase verde sobre cosas
que apunta a prohibir.

Evidencia:
 (a) La regla `no-repo-concreto-de-otro-dominio` identifica "implementación
     concreta" por el NOMBRE DEL ARCHIVO: `^src/(DOMINIOS)/(sql|in-memory)\.`.
     Cinco archivos exportan una clase `Sql…Repository` desde el archivo de
     su PUERTO, sin el prefijo:
       src/pms-estadias/stay.repository.ts        → `SqlStayRepository` (:62)
       src/pms-estadias/housekeeping.repository.ts → `SqlHousekeepingRepository`
       src/platform/location.repository.ts        → `SqlLocationRepository`
       src/repositories/audit-log.repository.ts   → `SqlAuditLogRepository`
       src/repositories/processed-event.repository.ts → `SqlProcessedEventRepository`
     Para esos cinco, la regla no puede dispararse nunca. Hoy no hay
     violación activa —se verificó: `clientes-finanzas/accounts-receivable.service.ts:25`
     y `workers/outbox.handlers.ts:49` importan `import type { StayRepository }`,
     el puerto, correctamente— pero el día que un `*.service.ts` importe
     `SqlStayRepository`, la cerca sigue verde.
 (b) `docs/convenciones-nombres.md:39-44` afirma que el prefijo
     `sql.`/`in-memory.` es *"un patrón bueno y consistente en TODO el
     backend"*. Es falso en 5 archivos, ninguno de los cuales aparece en ese
     documento ni en `docs/auditoria-modularidad.md` (grep sobre los 5
     nombres en los dos: cero hits). Y el mismo documento declara
     (`:6-15`) que **ningún renombre suyo se aplicó todavía** — o sea que
     la brecha entre la convención escrita y el árbol real está declarada
     como abierta, y la cerca se construyó asumiéndola cerrada.
 (c) Dos carpetas con lógica de negocio están fuera del `from` de las 5
     reglas de dominio, porque `DOMINIOS` sólo lista las 6 carpetas de
     bounded context:
       · `src/workers/` — `outbox.handlers.ts` (789 líneas con la lógica de
         efectos financieros de DOS dominios, Medio de Fase 2) y
         `outbox.registry.ts` (que importa concretamente
         `SqlStayRepository`, `:42`) pueden importar cualquier
         implementación de cualquier dominio sin restricción.
       · `src/app.ts` — importa 14 clases `Sql*Repository` de 5 dominios
         (`:103-122`). Ninguna regla lo mira.
 (d) La regla `no-orphans` no puede detectar código muerto que importe algo.
     `orphan` en dependency-cruiser exige cero aristas en AMBAS direcciones.
     Medido sobre el grafo: **1 orphan reportado**
     (`src/tests/security/public-routes.fixture.ts`) contra **36 módulos de
     `src/` con cero dependientes**, de los cuales 24 son los
     `in-memory.*.repository.ts` (usados sólo por tests, que están excluidos
     del grafo) y uno es `src/db/postgres-transaction-manager.ts`. La regla
     existe, corre, y ve 1 de 36. `knip` (`npm run deadcode`) está instalado
     y NO corre en CI (verificado contra los 6 jobs de
     `.github/workflows/ci.yml`).
 (e) En el frontend no hay ninguna cerca de arquitectura.
     `dependency-cruiser`, `jscpd` y `ts-prune` están en
     `appfrontend/package.json` como devDependencies y **no hay archivo de
     configuración de ninguno, ni script que los invoque, ni step de CI que
     los corra** (verificado: `ls -a` sin config; `scripts` = dev, build,
     lint, typecheck, lint:visual, test:visual, test:unit).

Impacto: la sensación de cobertura excede la cobertura. `lint:arch` en verde
se lee como "los límites entre dominios se respetan", y lo que garantiza es
"los límites entre 6 de las 12 carpetas de `src/` se respetan, medidos por
el nombre de los archivos, sin ver ciclos de carpeta (F7-03), sin ver
`workers/` ni `app.ts`, y con la detección de código muerto viendo el 3% de
los casos". Es el modo de falla que el `CLAUDE.md` de este repo ya nombra
para el gate de Bash: *"la contención depende de dos cosas que nadie
mantiene sincronizadas"*, y *"el hook simplemente no se entera"*. Acá son
tres.
Causa probable: cada regla se escribió para atrapar un caso concreto y
verificada contra el código de ese momento (28/08/2026) — lo que es
exactamente el proceso correcto. Lo que no se hizo después es revisar los
supuestos de la regla cuando el árbol cambió: 5 archivos que rompen la
convención de la que depende (a), 2 carpetas nuevas de lógica que su `from`
no lista (c).
Nivel de certeza: Alta para (a)-(e). Todos son mediciones: el grep de
`export class Sql…Repository` fuera de `sql.*`, el grep de los 5 nombres en
los dos documentos, el `from` de las reglas leído, el conteo orphan-vs-cero-
dependientes derivado del JSON de la propia corrida, el `package.json` y los
workflows del frontend.
Severidad: Media. Ninguno de los tres huecos tiene una violación activa hoy
(verificado para (a) y (c)); los tres son latentes. Pero es la severidad de
un mecanismo de contención, no de un defecto: su valor es prevenir, y sobre
lo que no ve no previene nada.
Recomendación: tres cambios chicos, todos en archivos de config/test, cero
líneas de `src/`. (1) En `no-repo-concreto-de-otro-dominio`, agregar al
patrón de `to.path` los 5 archivos que mezclan puerto e implementación —
o mejor, un test que falle si aparece un `export class Sql…Repository` en un
archivo no llamado `sql.*` (ataca la causa, no el síntoma, y es la
precondición para (1)). (2) Sumar `workers` al alcance de las reglas de
dominio como consumidor legítimo de puertos pero no de implementaciones,
con allowlist para `outbox.registry.ts` (que es un composition root — ver
F7-01) y motivo. (3) Poner `npm run deadcode` (knip) en CI, o cambiar
`no-orphans` por una regla de "cero dependientes" con allowlist de los 24
`in-memory.*` y motivo. Y en el frontend: o se configura
`dependency-cruiser` con 2-3 reglas reales (p. ej. `app/**` no importa de
`lib/refine/**` salvo por el provider; `lib/<dominio>/` no importa de otro
`lib/<dominio>/`), o se desinstalan las tres herramientas. Tenerlas
instaladas sin correr es peor que no tenerlas: aparecen en el manifiesto
como si el repo las usara.
¿Requiere modificar código?: No. Todo es config y tests.
Prueba necesaria: cada uno de los tres cambios ES una prueba. Verificarlos
con una violación de mentira antes de dejarlos —exactamente lo que el
docblock de `.dependency-cruiser.cjs` dice que se hizo con
`entidades-sin-express-ni-pg` ("Verificado con una violación de prueba antes
de dejarla"). Una regla que nunca se vio fallar no se sabe si corre.
```

---

### F7-12 — El frontend no toca la base de datos (confirmado) y sí tiene reglas de negocio: un guard de autorización espejado "aproximado", el cálculo de noches, y una política de imputación de pagos sin contraparte

**Amplía** lo que fases previas notaron sobre `FacturarButton.tsx` con dos casos nuevos y con el veredicto positivo del chequeo 2.

```text
Hallazgo: la presentación está perfectamente separada de la persistencia
—cero acceso a BD, cero server actions, cero route handlers, 2 variables de
entorno— y no está separada de las reglas de negocio. Tres casos, de
distinta naturaleza.

Evidencia — caso 1, una regla de AUTORIZACIÓN reimplementada con otra
entrada (ya conocido como residuo declarado, se recontextualiza):
 `appfrontend/src/components/FacturarButton.tsx:110` —
 `const blockedByCompanyManagementGuard = customerKind === 'COMPANY' && !isManagement`
 espeja el guard que el backend aplica en
 `facturacion/invoices.routes.ts:142` (`requireManagementForCompanyCharge`).
 El propio componente declara en su docblock (`:62-88`) que el espejo es
 **aproximado y por qué**: `useIsManagement()` compara el NOMBRE del rol
 (`role === 'OWNER' || role === 'ADMIN'`, `hooks/useAuthRole.ts`), el
 backend compara el GRUPO de permisos; `GET /api/auth/me` no expone
 `permissionGroups`, así que un rol personalizado con el grupo `MANAGEMENT`
 y otro nombre —que `dashboard/roles/page.tsx` permite crear— queda
 bloqueado en el frontend aunque el backend lo autorizaría. Lo notable para
 esta fase no es el falso negativo (declarado, con gate, y con la ventana de
 primer render también declarada) sino la CAUSA de capa: el frontend tiene
 que adivinar la regla porque el contrato que le daría el dato real
 (`permissionGroups` en `/api/auth/me`) no existe. La lógica está en la
 capa de presentación porque el contrato no le da alternativa.

Evidencia — caso 2, una regla de CÁLCULO duplicada con otro algoritmo
(nuevo):
 `appfrontend/src/app/dashboard/reservas/page.tsx:138-140` —
 `Math.round((new Date(form.checkOut).getTime() - new Date(form.checkIn).getTime()) / 86_400_000)`
 calcula las noches de una estadía en el navegador, con la zona horaria
 local del operador. El backend calcula lo mismo en
 `src/reservas/reservation-pricing.service.ts:333` con la misma fórmula
 (`Math.round((end - start) / 86_400_000)`). "Cuántas noches tiene esta
 reserva" es la variable que multiplica el precio: es la regla de negocio
 central del rubro alojamiento, escrita dos veces en dos repos. Y es
 exactamente el eje que `F5-02`/`F5-10` ya midieron como frágil del lado
 del backend (getters locales donde el docblock afirma UTC; un test con
 fecha local-naive contra una producción que manda instantes UTC) — el
 lente de Fase 7 agrega que hay una tercera implementación, en otra
 zona horaria, en otro repo, que ninguna de esas dos fichas alcanza.

Evidencia — caso 3, una POLÍTICA financiera que sólo existe en el frontend
(nuevo):
 `appfrontend/src/app/dashboard/cuentas-corrientes/page.tsx:163-177` —
 `toggleInvoice()` decide cómo se reparte un pago entre facturas abiertas:
 `Math.min(inv.outstanding, remaining || inv.outstanding)` sobre
 `remaining = Math.max(0, (parseFloat(payAmount) || 0) - allocatedTotal)`.
 Es una regla de imputación (llenar cada factura hasta su saldo, en el
 orden en que el usuario tildó, hasta agotar el pago).
 El backend, `clientes-finanzas/customer-account.service.ts:166-305`,
 valida y consolida las `allocations` que recibe con todo el rigor que
 corresponde (`round2`, orden canónico de lock `canonicalInvoiceLockOrder`,
 advisory lock de idempotencia) y **sin `allocations` no imputa a ninguna
 factura** (`:175-183`: una sola fila PAYMENT sin factura). O sea: la
 autoridad sobre el monto está bien puesta en el backend, y la POLÍTICA de
 reparto —qué factura se salda primero y con cuánto— existe únicamente en
 un componente React, sin contraparte ni default del lado del servidor.
 Segundo detalle de capa: el frontend suma con `parseFloat` crudo mientras
 el backend usa `round2()`; el `allocatedTotal` que el operador ve puede
 diferir en centavos del que el backend valida.

Impacto: caso 1, un falso negativo ya declarado y gateado. Caso 2, si el
navegador del operador está en otra zona horaria que el servidor, la
cantidad de noches que la pantalla muestra al armar la reserva puede no ser
la que el backend cobra — el operador confirma un precio distinto del que
vio. Caso 3, la política de imputación no se puede cambiar, auditar ni
aplicar desde otro cliente (el portal, una API, un import) porque no existe
fuera de esa pantalla.
Causa probable: en los tres, el frontend necesitaba una respuesta que el
backend no expone (el grupo de permisos, las noches calculadas, una
sugerencia de imputación) y la calculó. Es la consecuencia esperable de un
contrato que devuelve datos crudos y deja la derivación al cliente.
Nivel de certeza: Alta para los tres (código leído completo en los dos
lados). Media para el impacto del caso 2: no se probó con dos zonas
horarias distintas.
  No confirmado.
  Información faltante: si el desfase de noches entre navegador y servidor
  se produce en la práctica con las zonas horarias reales de los usuarios
  (todos AR/UTC-3 hoy, presumiblemente).
  Cómo verificarlo: abrir `dashboard/reservas` con
  `TZ=Pacific/Kiritimati` en el navegador, armar una reserva de 2 noches
  cruzando medianoche, y comparar `nightsCount` de la pantalla contra las
  líneas que devuelve `POST /api/reservations`.
Severidad: Media. Caso 2 sube a Alta si la verificación confirma el desfase.
Recomendación: el patrón de solución es el mismo para los tres y es de
CONTRATO, no de frontend: que el backend devuelva el dato derivado en vez de
los insumos. (1) Exponer `permissionGroups` en `GET /api/auth/me` —
es un cambio de contrato cruzado entre los dos repos, ya identificado como
bloque propio con su gate en `pendientes-2026-09-08.md` §5.1; con eso
`useIsManagement()` pasa a comparar lo mismo que el backend y el espejo deja
de ser aproximado. (2) Que la respuesta de cotización/preview de una reserva
incluya `nights` calculado por el servidor, y que la pantalla lo muestre en
vez de calcularlo. (3) Decidir si la política de imputación es del producto
—en cuyo caso va al backend, como default aplicado cuando llegan
`allocations` vacías, y el frontend la muestra— o es una ayuda de UX
explícita, en cuyo caso se declara como tal en el componente y se acepta que
otro cliente no la tenga. El (3) es una decisión de negocio, no de
arquitectura.
¿Requiere modificar código?: Sí, en los dos repos. (1) y (3) requieren
DECISIÓN DEL DUEÑO ((1) por ser contrato cruzado, (3) por ser política
financiera). El (2) no.
Prueba necesaria: para (2), la verificación de zona horaria de arriba como
característica de regresión. Para (3), un test del backend que asere qué
hace `recordPayment` sin `allocations` — hoy el comportamiento está
documentado en el docblock y conviene fijarlo antes de agregarle un default.
```

---

### F7-13 — Dos arquitecturas de acceso a datos en el frontend, conviviendo en 19 de 21 pantallas migradas; y un documento "canónico" que describe una estructura de backend que el backend abandonó

```text
Hallazgo: el frontend tiene dos arquitecturas de acceso a datos vivas
—Refine (`useTable`/`useForm`/`useCreate`…) sobre `lib/refine/dataProvider.ts`,
y fetch directo vía `lib/<dominio>/api.ts`— y conviven DENTRO del mismo
archivo en 19 de las 21 pantallas migradas. La segunda parte del hallazgo es
por qué existe la primera: el `dataProvider` es una capa de traducción cuya
única razón de ser es que el contrato HTTP del backend no es uniforme, y su
propio docblock lo enumera.

Evidencia:
 · 21 archivos de `src/app/` importan `@refinedev/core`. De esos, **19**
   además llaman a un `*Api.` directo. Ejemplo mínimo:
   `dashboard/clientes/page.tsx:3` usa `useTable`/`useCreate` y `:56` llama
   `customersApi.searchByTaxId()`.
 · 30 archivos de `src/app/` llaman `*Api.list/get/create/update/remove`.
 · el `CLAUDE.md` del frontend declara una excepción que cubre parte de esto
   ("un fetch crudo de OTRO recurso solo para llenar un combo … no es una
   excepción que declarar") — correcto, y no cubre el caso de una pantalla
   que gestiona su recurso por las dos vías. No se hizo el triage
   caso-por-caso de los 19 en esta fase.
     No confirmado.
     Información faltante: de los 19, cuántos son el combo-de-otro-recurso
     ya exceptuado y cuántos operan SU propio recurso por fuera de Refine.
     Cómo verificarlo: por cada uno de los 19, comparar el `resource` del
     `useTable`/`useForm` contra el `*Api` que llama — si coinciden, es
     desvío; si no, está exceptuado.
 · `src/lib/refine/dataProvider.ts:10-21`, su propio docblock, textual:
   *"La API real NO es REST uniforme: list() pagina server-side y devuelve
   PaginatedResponse<T> en algunos recursos (reservas, clientes, órdenes...)
   pero no en otros (categorías, productos, que devuelven T[] a secas);
   update() usa PUT en unos recursos y PATCH en otros; varios recursos no
   tienen GET /:id (solo list()); y varios NO tienen un delete real …
   Por eso este data provider no arma URLs genéricas."* Medido del lado del
   backend: 23 `router.put(` contra 5 `router.patch(` en los 39
   `*.routes.ts`. Los 357 líneas del `dataProvider` son, casi enteras, la
   factura de esa no-uniformidad — incluidos `toArray()`/`toPaginated()`
   (`:41-52`), dos helpers que existen sólo para absorber las 3 formas de
   respuesta de lista que `C6-04` documenta.
 · la otra arquitectura que compite, del lado del backend, es la
   ESTRUCTURA. `appfrontend/ARCHITECTURE.md:3` se declara *"la referencia
   canónica"* y describe el backend así (`:29-33`): *"Servicios: lógica de
   negocio (`ReservationService`, `OrderService`, `CategoryService`…) en
   `src/services/`"*, *"Repositorios: acceso a base de datos
   (`SqlReservationRepository`, etc.) en `src/repositories/`"*,
   *"API REST: rutas Express en `src/api/routes/`"*. El árbol real:
   `src/services/` tiene **1** archivo (`report.service.ts`, y ninguno de
   los tres servicios que el documento nombra); `src/repositories/` no
   tiene `SqlReservationRepository` (vive en `src/reservas/`);
   `src/api/routes/` tiene **8 de los 39** archivos de rutas. Las cuatro
   carpetas que el documento describe son el residuo arqueológico de la
   arquitectura por capas, todavía en pie y todavía usada
   (`src/api/schemas/` la importan 21 archivos de 6 dominios distintos),
   conviviendo con la arquitectura por bounded context que la reemplazó y
   que el `CLAUDE.md` de `app-main` documenta como vigente. El mismo
   documento dice *"Next.js 14"* (`:51`) contra `next: 16.3.1` del
   `package.json`, y *"Deploy: Render (Static Site / Web Service)"* contra
   el CI del propio repo, que dice Vercel
   (`.github/workflows/ci.yml:7`: *"es el repo que auto-deploya a
   producción (Vercel)"*).

Impacto: (i) el documento que se declara canónico para decidir "en qué repo
va esto" describe una estructura de backend que no existe — quien lo siga
crea archivos en `src/services/` y `src/repositories/`, que es exactamente
la deuda que Fase 2 levantó como "cajón" (2 Medios); (ii) el `dataProvider`
es una capa de 357 líneas que hay que mantener sincronizada a mano con cada
inconsistencia nueva del backend, y su costo es invisible desde el backend —
nadie que agregue un `PATCH` donde el resto usa `PUT` ve que el frontend
pagó por eso; (iii) dos arquitecturas de acceso a datos en el mismo archivo
hacen que "cómo se recarga esta lista" tenga dos respuestas por pantalla.
Causa probable: (i) `ARCHITECTURE.md` se escribió antes de la separación por
dominios y nunca se retiró ni se actualizó — mismo modo de falla que
`HTTP_CONTRACTS.md` (F7-09) y que el roadmap de producto del 25/08/2026.
(ii) Refine se adoptó de a una pantalla, con un roadmap explícito
(`docs/roadmap-migracion-refine.md`) y excepciones declaradas, lo cual es la
forma correcta de migrar — y una migración correcta en curso es,
mientras dura, dos arquitecturas.
Nivel de certeza: Alta para todos los conteos y las citas. Media para "los
19 son desvío": ver el bloque No confirmado.
Severidad: Media. La convivencia Refine/fetch es deuda de transición
declarada y gestionada. La parte grave es `ARCHITECTURE.md`, que es
desinformación activa en el documento que más se consulta al empezar algo.
Recomendación: dos bloques, independientes. (1) Hoy, sin tocar código:
corregir o retirar `appfrontend/ARCHITECTURE.md`. Si se corrige, la tabla de
"qué vive acá" del backend tiene que describir las carpetas por dominio y
nombrar `src/services/`, `src/repositories/`, `src/api/routes/` y
`src/api/schemas/` por lo que son hoy — cuatro residuos de la estructura
anterior, tres de ellos ya identificados como deuda en Fase 2. Si se
retira, hay que decir en su lugar cuál es la referencia canónica (el
`CLAUDE.md` de cada repo). (2) Hacer visible el costo del `dataProvider`
desde el lado del backend: la lista de no-uniformidades de su docblock
(`:10-21`) es, literalmente, un backlog de contrato del backend —
`C6-04` (3 formas de lista), PUT vs PATCH, recursos sin `GET /:id`. Moverla
a `pendientes-<fecha>.md` con una referencia, para que deje de vivir sólo
como comentario en el repo que la sufre.
¿Requiere modificar código?: No para (1) y (2) — docs. El triage de los 19
puede derivar en cambios de frontend.
Prueba necesaria: ninguna para (1)/(2). Para el triage, el procedimiento del
bloque No confirmado.
```

---

### F7-14 — Arquitectura accidental residual: seis piezas que sobrevivieron a la decisión que las reemplazó

```text
Hallazgo: seis estructuras vivas en el árbol —compiladas, deployadas, en
algunos casos alcanzables— que no responden a ninguna decisión vigente.
Ninguna es grave por sí sola; juntas son el retrato de lo que el protocolo
llama arquitectura accidental, y cuatro de las seis son invisibles para
todas las herramientas del repo.

Evidencia:
 (1) `appfrontend/src/app/admin/page.tsx` (234 líneas). Una consola manual
     de API (bloques `<ApiBlock>` por endpoint) con: su propio guard de
     auth (`:23-26`, `localStorage.getItem('token')` → redirect), su propio
     login (`:99-113`, `POST /api/login` con
     `localStorage.setItem('token', t)`), y su propio sistema de toast
     —el tercero de la app, con clases Tailwind crudas, reconocido en un
     comentario del propio archivo (`:44-46`: *"OJO: este es un TERCER
     sistema de toast … No se unifica acá porque V2.6.3 es sólo elevación;
     queda anotado"*)—. No está enlazada desde ningún lado (los únicos
     links son a `/dashboard/admin`, que es la versión vigente de 111
     líneas: `dashboard/page.tsx:299`, `NavList.tsx:155`,
     `dashboard/layout.tsx:71`). La clave `'token'` que su guard lee no la
     escribe ningún camino de login actual —la sesión de staff es una
     cookie httpOnly desde B2 (13/08/2026)—, así que su guard sólo puede
     pasar si alguien la setea desde esa misma página. Sus llamadas a la
     API sí funcionan: `ApiBlock.tsx:3,52` usa `apiFetch`, que manda la
     cookie. O sea: una pantalla de superusuario alcanzable por URL, con un
     mecanismo de sesión muerto y un camino de login propio, en producción.
 (2) `appfrontend/src/lib/auth.tsx` (3 líneas). Un módulo vacío
     (`export {}`) cuyo único contenido es un comentario falso:
     *"Auth is handled via localStorage in src/app/login/page.tsx"*. Cero
     importadores (`grep -rn "lib/auth'"` → 0 hits). Es el caso literal del
     criterio del protocolo: el nombre del archivo y su comentario
     describen una responsabilidad que el archivo no tiene y que el sistema
     ya no tiene.
 (3) `src/db/postgres-transaction-manager.ts` (12 líneas). Un módulo de
     `src/` —que se compila a `dist/`— cuya única razón de existir es
     satisfacer el nombre de import de UN test, y que lo declara:
     *"Alias de compatibilidad para tests de integración. El test
     reservation.service.integration.test.ts importa PostgresTransactionManager …
     Este módulo re-exporta bajo el nombre esperado por los tests"*
     (`:1-11`). Único importador:
     `src/tests/integration/reservation.service.integration.test.ts:73`.
     Cero dependientes en código de producción. El test da forma al árbol de
     producción; lo correcto era cambiar una línea del test.
 (4) 24 `in-memory.*.repository.ts` en `src/` (no `*.test.ts`, o sea código
     de producción por ubicación) con **cero dependientes** en el grafo.
     Son dobles de prueba, y su lugar correcto es `src/tests/` o un
     `__fakes__` — no `src/reservas/`, `src/pos-menu/`,
     `src/clientes-finanzas/`. Viajan a `dist/`. Y son invisibles para
     `no-orphans` por la razón de F7-11(d).
 (5) `src/container.ts:118,226` — `mode: 'postgresql'`, una unión
     discriminada de un solo miembro, y `createAppContainer()` (`:122-131`)
     que valida una env y llama a `createPostgresContainer()`, la única
     rama. Es la firma de un modo alternativo (in-memory, presumiblemente
     el que usaban los 24 archivos de (4)) que se retiró sin retirar su
     discriminante. Cualquiera que lea el tipo va a creer que hay otro modo.
 (6) `appfrontend/package.json` — `dependency-cruiser`, `jscpd` y
     `ts-prune` instalados, sin config, sin script, sin CI (F7-11(e)).
     Y en el backend, `knip` con script `deadcode` que ningún job corre.

Impacto: cada pieza le cuesta a un lector nuevo (humano o modelo) una
hipótesis falsa: que hay un modo in-memory, que hay dos
`TransactionManager`, que la auth pasa por `localStorage`, que el frontend
tiene análisis de dependencias. La (1) es además superficie: una pantalla no
enlazada que emite `POST /api/login` y que un cambio futuro en el manejo de
`'token'` podría reactivar de formas no previstas.
Causa probable: en los seis, la decisión nueva se implementó sin retirar la
anterior, y ninguna herramienta del repo puede ver "código que nadie usa
pero que importa algo" (F7-11(d)). El caso (3) tiene una causa propia y más
interesante: un test pidió un nombre y la respuesta fue crear el nombre en
producción.
Nivel de certeza: Alta para las seis. Los conteos de dependientes salen del
grafo de depcruise; los importadores se verificaron con barridos completos;
las citas son literales.
Severidad: Baja-Media. Baja individualmente; Media como conjunto, porque son
el termómetro de que el repo no tiene un mecanismo de retiro.
Recomendación: ordenadas por relación entre efecto y riesgo, todas chicas.
 (a) Borrar `appfrontend/src/lib/auth.tsx` (cero importadores, cero riesgo).
 (b) Cambiar el import del test de integración a `PgTransactionManager` y
     borrar `src/db/postgres-transaction-manager.ts`.
 (c) Sacar `mode` de `AppContainer` o documentar por qué queda.
 (d) Decidir sobre `appfrontend/src/app/admin/page.tsx`: borrarla (la
     reemplazó `dashboard/admin/page.tsx`) o, si se quiere conservar como
     consola de dev, moverla bajo `src/app/dev/` —donde el repo ya pone
     `dev/shell` y `dev/primitives`— y sacarle el login propio. Requiere
     DECISIÓN DEL DUEÑO: es una herramienta, y puede seguir usándola.
 (e) Mover los 24 `in-memory.*` a una ubicación de test. Es el de mayor
     radio de los seis (24 archivos + los imports de ~40 tests) y no debería
     hacerse antes de (f).
 (f) Poner `knip` en CI, o la regla de "cero dependientes" de F7-11(3).
     Sin esto, la lista de arriba se vuelve a formar.
¿Requiere modificar código?: Sí, (a)-(e). (f) es CI.
Prueba necesaria: para (a)-(c), `npm run build` + la suite completa. Para
(e), la suite completa sin modificar ningún test más allá de la ruta de
import. Para (d), verificar que ningún camino de la app enlace a `/admin`
antes de borrarla (hecho: 0 links).
```

---

## 4. Arquitectura accidental — el patrón detrás de los catorce

No son catorce problemas independientes. Son cuatro mecanismos, cada uno visible en varios hallazgos.

**1. El repo tiene la solución construida, en un solo lugar, sin mecanismo que la propague.** Es el mismo patrón transversal nº1 que Fase 6 encontró en contratos, y acá vale para estructuras. Existe **un** puerto de bounded context (`ReservationCancelPort`, C6-17) y **un** cruce sin puerto que lo necesita con las mismas características (F7-02). Existe **un** "único lugar autorizado para construir" (`db/tenant-context.ts`, nacido de un incidente) y **cinco** composition roots (F7-01). Existe **un** adaptador de servicio externo ejemplar (`EmailSender`) y **dos** integraciones sin puerto (F7-04). Existe **un** artefacto de contrato generado y verificado (`inventario-rutas.md`) y **dos** escritos a mano que se pudrieron (F7-09). En los cuatro casos el patrón bueno está a dos carpetas de distancia del malo.

**2. Las reglas de arquitectura miden la unidad equivocada.** `no-circular` mide archivos cuando la unidad es la carpeta (F7-03). `no-repo-concreto-de-otro-dominio` mide nombres de archivo cuando la unidad es la clase exportada (F7-11a). `no-orphans` mide aristas bidireccionales cuando la unidad es "tiene dependientes" (F7-11d). `EXPECTED_AUTHORIZE_CALL_SITES` mide un total cuando la unidad es la ruta — y de eso el repo ya aprendió, y construyó cuatro cercas más para cubrirlo. La lección está aprendida para RBAC y no se transfirió a arquitectura.

**3. El transporte absorbió todo lo que no tenía casa.** `*.routes.ts` es composición (F7-01), librería de factories de otro dominio (F7-01.5), dueño de constantes de política (F7-06), declarador de schemas (F7-10) y ejecutor de sagas con DDL y llamadas a APIs externas (F7-05). `tenant.middleware.ts` es dueño del pool, del LRU y de los workers (F7-07). La razón es estructural y honesta: `req` es lo único que tiene el contexto del tenant, así que todo lo que necesita ese contexto termina donde está `req`. Mientras no exista una capa "por request" que no sea Express, el transporte va a seguir siendo el único lugar posible.

**4. Nada se retira.** Seis residuos vivos (F7-14), cuatro carpetas de la arquitectura anterior en pie (F7-13), dos documentos canónicos describiendo sistemas que ya no existen (F7-09, F7-13), dos convenciones de validación (F7-10), dos arquitecturas de acceso a datos (F7-13), un discriminante de un modo retirado (F7-14.5). El repo es excepcionalmente bueno documentando lo que agrega —cada decisión tiene su comentario fechado con el gate que la aprobó— y no tiene ningún mecanismo para dar de baja. El `resuelto.md` y la convención de corte-y-pega del 12/09/2026 resuelven esto exactamente, para pendientes. Nunca se aplicó a estructuras ni a documentos.

---

## 5. Arquitectura objetivo mínima

Lo que sigue **no es una arquitectura nueva**. Son cinco reglas, todas con una implementación de referencia **ya construida, probada y justificada en este repositorio**. La propuesta es hacer default lo que hoy es excepción, no importar un modelo de otro contexto. Ninguna de las cinco requiere renombrar carpetas ni mover dominios.

### 5.1 La forma

```text
src/
  app.ts                      ← SOLO montaje: prefijo → router. Cero `new`.
  config/env.ts               ← el único `process.env` del proceso (F7-06)
  <dominio>/                  ← reservas, pos-menu, pms-estadias,
                                clientes-finanzas, facturacion, usuarios-roles
    <entidad>.entities.ts       reglas de negocio, sin framework  ← ya cumple
    <entidad>.repository.ts     el PUERTO                          ← ya cumple
    sql.<entidad>.repository.ts la implementación                  ← ya cumple (F7-11a: 5 excepciones)
    <entidad>.service.ts        lógica de aplicación               ← ya cumple
    <dominio>.ports.ts        ← NUEVO: lo que este dominio expone a otros
    <entidad>.routes.ts        SOLO: validar → llamar → serializar
  platform/                   ← tenancy, provisioning, superadmin  ← ya cumple
  security/                   ← auth, autz                          ← ya cumple
  tenant-container.ts         ← NUEVO: el único `new Sql…` del repo
  domain/                     ← kernel compartido (money, audit, errors)
  workers/                    ← registro + despacho. Los handlers, en su dominio.
```

Cinco cambios sobre el árbol real: `config/env.ts`, `tenant-container.ts`, un `<dominio>.ports.ts` por dominio que exponga algo, los handlers de outbox mudados a su dominio, y `app.ts` sin `new`. Todo lo demás ya está donde va.

### 5.2 Regla 1 — Un dominio cruza a otro sólo por un puerto declarado. Referencia: `C6-17`.

El repo ya tiene el patrón completo y probado en tres niveles:

```
src/facturacion/cancel-reservation-with-credit-note.service.ts:130-163
  → declara `ReservationCancelOutcome` (unión de 4 desenlaces explícitos)
    y `ReservationCancelPort` (1 método)
src/reservas/reservation-cancel-for-credit-note.ts
  → lo implementa, en el dominio DUEÑO del agregado
```

Aplicado a `pms-estadias` → `reservas` (F7-02, C6-02), el cambio es de la misma forma y del mismo tamaño:

```
src/pms-estadias/stay.service.ts  declara en pms-estadias.ports.ts:

  export type ScheduleChangeOutcome =
    | { resultado: 'APROBADO';    reservation: ReservationScheduleView; charge: ChargeSpec | null }
    | { resultado: 'YA_RESUELTO'; reservation: ReservationScheduleView }
    | { resultado: 'NO_ELEGIBLE'; motivo: 'ESTADO' | 'PROXIMA_LLEGADA' }
    | { resultado: 'NO_EXISTE' };

  export interface ReservationSchedulePort {
    approveScheduleChange(client: SqlClient, reservationId: string,
                          businessId: string, changedBy: string): Promise<ScheduleChangeOutcome>;
    requestScheduleChange(...): Promise<...>;
    rejectScheduleChange(...): Promise<...>;
  }

src/reservas/reservation-schedule-change.ts  lo implementa (es donde vive el agregado).
```

Cuatro propiedades que se heredan de C6-17 sin discutirlas de nuevo, porque ahí ya están justificadas: los desenlaces son **valores** y sólo las fallas son excepciones; el puerto recibe el `client` de la transacción del orquestador (lo que permite meter el CHARGE **dentro** de la transacción y cerrar el hueco declarado en `stay.service.ts:417-426`); las dependencias entran como `Pick<>` mínimos; y `pms-estadias` deja de importar la entidad rica `Reservation` — usa su propia vista mínima, el patrón que `reservas/reservation-customer.entities.ts::ReservationCustomer` ya estableció en la Fase 7 del roadmap de modularidad para el caso inverso. **Una corrección sobre C6-17, declarada por Fase 6 misma:** usar objeto nombrado en vez de tres `string` posicionales (`C6-12` — el mejor contrato del repo comparte el defecto más extendido del repo; no hay razón para heredarlo).

Con eso hecho, la regla se vuelve mecánica: `^src/<dominio>/` sólo puede importar de `^src/<otro>/` a través de `<otro>.ports.ts`. Es una línea en `.dependency-cruiser.cjs` y resuelve estructuralmente F7-02 y parte de F7-03.

### 5.3 Regla 2 — Un solo lugar construye el grafo por request. Referencia: `db/tenant-context.ts`.

Ese archivo ya es esta regla, para una dependencia, y su docblock ya declara la doctrina: *"Este archivo es el único lugar autorizado para construir un `PgTransactionManager` para rutas de tenant."* Nació de un incidente real (pool de plataforma donde iba el del tenant, hallazgo #1 del review del 08/08/2026), tiene precondición declarada y fail-fast explícito.

`src/tenant-container.ts` es ese mismo archivo, extendido a los ~20 servicios: una función `buildX(req)` por servicio, cada una con la precondición declarada. Los 39 `*.routes.ts`, los 6 closures de `app.ts` y `workers/outbox.registry.ts` la llaman. Efectos: los 286 `new Sql…` de 31 archivos pasan a un archivo; los dos cableados duplicados dejan de poder divergir (F7-01); `app.ts` deja de importar 14 repositorios concretos de 5 dominios (F7-07 de la lista de chequeos, punto 7); los closures de `app.ts` se vuelven `app.use(prefix, requireModule(...), routerFor(buildX))`, lo que **elimina la razón de existir de `CLOSURE_MOUNTS`** — el octavo artefacto manual del repo desaparece, con lo que este bloque paga deuda que hoy se sostiene a mano.

### 5.4 Regla 3 — Un servicio externo se toca sólo por un adaptador. Referencia: `email/email.sender.ts`.

Interfaz (`EmailSender`), implementación real (`ResendEmailSender`), implementación degradada (`NoopEmailSender`), factory que decide según configuración (`createEmailSender()`), y la política de degradación declarada en el docblock. Cuatro piezas, 160 líneas. Eso es todo lo que hace falta.

Aplicarlo a los dos que no lo tienen: `TenantProvisioner` (1 método, envuelve las 2 llamadas a la API de Neon) y `GoogleTokenVerifier` (1 método, elimina el estado global de proceso y el export `__resetGoogleJwksCacheForTests` de `src/`). Y al request de AFIP: un `afip-request.builder.ts` en `facturacion/`, que es además el primer corte del `buildCreditNote()` de 420 líneas (2.º Alto de Fase 2). **No** envolver `@arcasdk/core` entero — el propio `afip-billing.port.ts:11-14` argumenta bien contra eso y hay que respetarlo.

### 5.5 Regla 4 — La configuración se lee una vez, al arrancar, en un lugar. Sin referencia interna: hay que construirla.

Es la única de las cinco sin implementación de referencia en el repo, y por eso la más simple de especificar: `src/config/env.ts` lee y valida las 30 variables con Zod (ya está en el repo), exporta un objeto congelado, y falla al boot si falta una obligatoria. Después, `process.env` fuera de ese archivo tiene que ser 0 con allowlist. Los literales de política (`PASSWORD_RESET_EXPIRES_HOURS`, `OUTBOX_RETENTION_DAYS`, `DEFAULT_SENDER_NAME`, el tope de paginación) se mudan ahí como valores por defecto **con un lugar visible donde discutir si cada uno debería ser por tenant o por producto** — que es la pregunta que hoy no se puede ni formular porque los valores están en un `*.routes.ts` y en un servicio. El precedente de cómo se resuelve esa pregunta cuando la respuesta es "sí": `PLAN_LIMITS`, que dejó de ser constante TS y pasó a la tabla `plan_limits` de la BD de plataforma el 18/08/2026, con `src/config/plan-limits.ts` quedando como el tipo. Ese movimiento es el modelo; esta regla es la condición para poder repetirlo.

### 5.6 Regla 5 — Cada regla anterior tiene una cerca, y cada cerca se ve fallar una vez. Referencia: los diez artefactos manuales del repo.

Este repositorio ya sabe hacer esto mejor que la mayoría: diez artefactos manuales, cada uno con allowlist chica, motivo por entrada, y verificación en las dos direcciones. Lo que falta no es el mecanismo — es aplicarlo a arquitectura, donde hoy hay un solo instrumento con tres huecos estructurales (F7-11).

Las cuatro cercas que faltan, todas de conteo con allowlist y todas congelando el número de HOY antes de mover nada:

| Regla | Cerca | Número a congelar hoy |
|---|---|---|
| 5.2 puertos | import cross-dominio fuera de `<dominio>.ports.ts` | los cruces actuales, por par |
| 5.3 container | `new Sql[A-Za-z]*Repository` fuera de `tenant-container.ts` | **286** en 31 archivos |
| 5.4 config | `process.env` fuera de `config/env.ts` | **30** nombres en 26 archivos |
| 5.2/F7-03 ciclos | pares de carpeta bidireccionales | **20** |

Y el criterio que el propio `.dependency-cruiser.cjs` aplicó a `entidades-sin-express-ni-pg` ("Verificado con una violación de prueba antes de dejarla"): **una regla que nunca se vio fallar no se sabe si corre.** Las cuatro se prueban con una violación de mentira antes de quedar.

### 5.7 Qué da esta arquitectura, contra los seis criterios que pidió el protocolo

| Criterio | Cómo lo da |
|---|---|
| **Única fuente de verdad** | El agregado tiene un dueño y un puerto (5.2). La configuración tiene un archivo (5.4). El grafo tiene un constructor (5.3). El contrato HTTP: el inventario generado para existencia, `spec.ts` para forma, y el retiro de los dos documentos que compiten (F7-09) |
| **Módulos comprensibles** | `<dominio>.ports.ts` es la respuesta a "qué le puedo pedir a este dominio", en un archivo, en vez de en los 8-15 imports que otros dominios tienen hoy |
| **Pruebas aisladas** | Los servicios ya están libres de Express (confirmado). Lo que falta es lo de 5.3 y 5.4 (hoy testear una ruta exige Express + `req.db` + el entorno) y lo de F7-08 (el contrato de aliasing que hoy obliga a saltear el repositorio y deja 9 tests verdes que no prueban nada) |
| **Cambios localizados** | Los duplicados de F7-01 y F7-05 son la medida directa de lo contrario: hoy un cambio en `StayService` toca 2 archivos y uno en la secuencia de aprovisionamiento toca 4 |
| **Errores rastreables** | `error.middleware.ts` ya es el lugar correcto; lo que falta es que los ~30 bypasses locales dejen de existir (`C6-03`/`C6-09`/`C6-10`, ya en cola) y que los servicios externos tengan errores propios en vez de `throw new Error` genérico (5.4) |
| **Crecimiento controlado** | 5.6. Es lo único de las cinco reglas que no es opcional: sin las cercas, esta arquitectura vuelve al estado actual, y el repo ya tiene la evidencia de que eso pasa (el roadmap de 7 fases se aplicó completo, y nueve de los catorce hallazgos de esta fase son estructuras que nacieron después) |

---

## 6. Secuencia sugerida

Mismo criterio que el roadmap de 7 fases y que §9 de Fase 6: por relación entre efecto y radio, sin decidir por el dueño. **Nada de esto se implementa en esta fase.**

| # | Bloque | Radio | Reversible | Requiere decisión del dueño |
|---|---|---|---|---|
| 1 | Corregir `server.ts:14` (afirma un camino de migración que no existe) | 1 línea de comentario | Sí | No |
| 2 | Corregir o retirar `appfrontend/ARCHITECTURE.md` (F7-13) | 1 doc | Sí | **Sí** (corregir vs. retirar) |
| 3 | Corregir las 2 afirmaciones falsas de `HTTP_CONTRACTS.md` + declarar precedencia entre los 3 artefactos de contrato (F7-09) | 3 docs | Sí | **Sí** (qué es ese documento) |
| 4 | Borrar `appfrontend/src/lib/auth.tsx`; cambiar el import del test de integración y borrar `db/postgres-transaction-manager.ts`; sacar `container.mode` (F7-14 a/b/c) | 3 archivos | Sí | No |
| 5 | Las 4 cercas de conteo de §5.6, congelando 286 / 30 / 20 / los cruces actuales | 4 tests nuevos, 0 líneas de `src/` | Sí | No |
| 6 | Cerrar los 3 huecos de `.dependency-cruiser.cjs` + `knip` en CI (F7-11) | config + CI | Sí | No |
| 7 | `src/config/env.ts` + mover los literales de política + una sola declaración de `DEFAULT_SENDER_NAME` (F7-06) | ~26 archivos, mecánico | Sí | No |
| 8 | `business.routes.ts:189` usa el TTL configurado (F7-06) | 2 líneas | Sí | **Sí** (cambia comportamiento observable) |
| 9 | `afip-request.builder.ts` — extraer el armado del payload WSFEv1 (F7-04b + 2.º Alto Fase 2) | 1 archivo nuevo + `invoice.service.ts` | Sí, con test de forma previo | No |
| 10 | `GoogleTokenVerifier` + `TenantProvisioner` como puertos (F7-04c) | 2 archivos nuevos + 4 call-sites | Sí | No |
| 11 | `src/tenant-container.ts` — Regla 2 (F7-01). Retira `CLOSURE_MOUNTS` | ~31 archivos + `app.ts` | Sí, por dominio | No (sí gate por radio) |
| 12 | Unificar la validación en `api/schemas/` — 46 inline (F7-10) | 16 archivos, mecánico, por dominio | Sí | No (sí elegir la convención) |
| 13 | Extraer `tenant-provisioning.service.ts` — las 4 copias de la saga (F7-05) | 3 archivos de rutas | **No sin backup** (corre DDL en producción) | No, pero exige gate de acción irreversible |
| 14 | `ReservationSchedulePort` — el cruce `pms-estadias`↔`reservas` (F7-02, C6-02, F5-13) | 3 archivos + tests | Sí, con integración previa | **Sí** (es la decisión que C6-02 ya está esperando) |
| 15 | Contrato de aliasing de `IOrderRepository`; el recálculo vuelve al repositorio (F7-08) | 3 archivos | Sí | No |
| 16 | Arrancar los workers de outbox desde `server.ts` (F7-07) | 2 archivos | **No** (cambia comportamiento operativo) | **Sí**, y depende de la query del bloque No confirmado de F7-07 |
| 17 | Mover los 24 `in-memory.*` a ubicación de test (F7-14e); mover los handlers de outbox a su dominio | 24 + 2 archivos, muchos imports | Sí | No |
| 18 | Decidir sobre `appfrontend/src/app/admin/page.tsx` (F7-14d) | 1 archivo | Sí | **Sí** (es una herramienta que puede estar en uso) |

**Notas de precedencia, con el mismo criterio que Fase 6 §9:**

- Los bloques **1-4** son de documentación y borrado, suman ~10 líneas netas, y son los de mayor rendimiento absoluto de la fase: hoy los tres documentos que un lector nuevo consulta primero (`ARCHITECTURE.md`, `HTTP_CONTRACTS.md`, el docblock de `server.ts`) contienen afirmaciones falsas sobre la estructura del sistema. Es el único caso de todo el informe donde el costo es cero y el efecto es inmediato.
- El bloque **5 es la precondición de todo lo demás.** Sin los cuatro números congelados, ningún refactor de los bloques 7-17 se puede *medir* — sólo afirmar. Y este informe muestra qué pasa con lo afirmado y no medido: `docs/convenciones-nombres.md` afirma que el prefijo `sql.` es consistente en todo el backend y hay 5 excepciones que ese documento no conoce.
- El bloque **11 paga deuda ajena**: retira `CLOSURE_MOUNTS`, el octavo artefacto manual del repo. Es el argumento más fuerte a su favor y no es evidente desde el hallazgo.
- El bloque **13 es el único con riesgo de producción real** (corre DDL contra bases de tenants). No se toca antes del 10, y bajo el criterio `irreversible-action-gate` que el propio repo declara.
- El bloque **14 no es una decisión nueva.** Es la de `C6-02`/`F5-13`, con tres opciones ya planteadas. Lo que esta fase agrega es que la opción (a) tiene ahora el diseño concreto de §5.2 y que el archivo declara en su propio docblock la regla que rompe, lo que la hace más difícil de dejar como está.
- El bloque **16 no debería evaluarse sin la query de F7-07 en mano** — mismo criterio con el que Fase 6 §9 vinculó su bloque 10 a `F5-01` y al test `d115402`.

---

## 7. Alcance excluido y no confirmado

Declarado para que Fase 8 no lo dé por cubierto.

1. **No se ejecutó ningún test.** La única ejecución fue `depcruise` (lectura). Todo lo demás es lectura de código. Los cinco bloques `No confirmado.` del informe llevan su comando exacto: el drenaje del outbox sin tráfico HTTP (F7-07), el desfase de noches por zona horaria (F7-12), el triage de las 19 pantallas Refine+fetch (F7-13).
2. **El triage de los 20 ciclos de carpeta no se hizo** (F7-03). El 20 es una cota superior medida, no una lista de 20 defectos: `security` <-> `types` (6/1) es kernel compartido y `api` <-> los dominios es el composition root. Sin el triage, el número sirve para congelarlo, no para priorizarlo.
3. **`src/openapi/spec.ts` no se auditó línea por línea** — sólo su rol en el conjunto de artefactos de contrato (F7-09). `CONTRACT-001` cubre existencia; la forma de sus 18 paths sigue sin verificar contra los schemas de Zod reales.
4. **Los 4 paneles de frontend fuera del dashboard** (`app/superadmin/*`, `app/portal/*`, `app/dev/*`, `app/registro`) se leyeron sólo para los chequeos 2 y 10. No se evaluó su separación de capas interna.
5. **`src/db/schema.sql` (4302 líneas) y `platform.schema.sql` (1578) no se auditaron como arquitectura de datos.** Un solo archivo de schema por base, reaplicado idempotente en cada deploy, es una decisión estructural con su propia superficie (orden de bloques, dependencias entre tablas, qué pasa si falla a mitad) que esta fase no toca. Lo único que se verificó es la columna `afip_request` de F7-04.
6. **No se evaluó la arquitectura de los workers más allá de su ubicación y su ciclo de vida.** El contrato productor↔consumidor del outbox (payload, `version`, idempotencia del handler, evento espurio) sigue sin cubrir — Fase 6 §8.2 ya lo declaró excluido y sigue excluido.
7. **No se midió el impacto en performance de ninguno de los hallazgos.** El `Router` de Express construido por request en los 6 closures de `app.ts` (F7-01) se reporta como hallazgo estructural, no como problema de rendimiento: no se midió.
8. **Los `docs/` no se auditaron exhaustivamente contra el código.** Se cruzaron los cuatro que esta fase necesitaba (`ARCHITECTURE.md`, `HTTP_CONTRACTS.md`, `convenciones-nombres.md`, `arquitectura-monolito-modular.md`) y tres de los cuatro tenían al menos una afirmación falsa sobre la estructura real. La tasa sugiere que un barrido completo de los ~40 documentos de diseño encontraría más, pero **eso es una inferencia, no una medición** — es una fase propia.
