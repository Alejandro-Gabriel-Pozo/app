# Análisis de implicancias — backlog de UI (D8, D6, C1-A, C3, D7)

- **Fecha:** 2026-08-31
- **Estado:** síntesis entregada y **revisada por `architecture-governor`
  (31/08/2026)**. Decisiones del dueño pendientes: **D7** (elegir salida entre
  5) y **C1-A** (3 puntos de schema/diseño). No se implementó nada.
- **Método:** `DECISION_REVIEW.md` ("análisis de implicancias"), invocado por
  el dueño. Modo estricto: revisión de solo lectura.
- **Origen:** pedido de implementar el frontend de 5 ítems "con backend
  terminado", con la instrucción de verificar backend y contrato **antes** de
  tocar cada pantalla.
- **Etiquetas:** `analisis` `backlog` `ui` `modulos` `contrato-http`

**Restricción declarada por el dueño para esta tanda:** no tocar modelo
multirubro, RBAC ni `BusinessContext`. Esa restricción es la que condiciona
D7 — aunque **no lo bloquea del todo**: ver §5, hay 5 salidas y dos de ellas
no estaban vistas en la primera versión de este documento.

---

## 1. Qué se trabajaría y qué módulos toca

`ModuleKey` = el gate comercial (`requireModule` → 402), no la carpeta de
código. Verificado contra `src/app.ts` el 31/08/2026.

| Ítem | Veredicto | Qué se trabajaría | `ModuleKey` que toca | Dónde |
|---|---|---|---|---|
| **D8** — UI fiscal de producto | **Ya hecho** (28/08) | Nada de UI. Solo queda documentar el contrato de `/api/products` | `POS_RESTAURANTE` (gatea el endpoint, `app.ts:318`) **+** `FACTURACION` (gatea la sección fiscal dentro de la pantalla). Hacen falta **los dos** | `appfrontend-main`: `productos/page.tsx`, `productos/[id]/page.tsx`, `lib/productos/types.ts` — ya escritos |
| **D6** — números con prefijo | UI pura, listo para empezar | Tipos del frontend + traer los 2 prefijos del perfil + columna en 2 listados + alinear el `#` suelto de cuentas corrientes | **Ninguno.** `/api/reservations` (`app.ts:307`), `/api/customers` (`:309`) y `/api/business-profile` (`:329`) van sin `requireModule` | `appfrontend-main`: `dashboard/reservas/page.tsx`, `dashboard/clientes/page.tsx`, `dashboard/cuentas-corrientes/page.tsx`, tipos |
| **C1-A** — CRUD de `deposit_policies` | **Backend nuevo + UI. Bloqueado** | CRUD en el repo (hoy solo 2 métodos de lectura) + rutas nuevas + montaje + auditoría R8 + pantalla | `CUENTAS_CORRIENTES` — guard que la pantalla necesita para no autobloquear al negocio. **Ojo:** el `bucket` de la tabla (`ALOJAMIENTO`/`TURNOS`/`SERVICIOS`) es un valor de columna, **no** un `ModuleKey`, aunque el nombre coincida con uno | `app-main`: `reservas/deposit-policy.repository.ts`, `reservas/sql.deposit-policy.repository.ts`, `deposit-policies.routes.ts` (nuevo), `app.ts` (montaje), `domain/audit.ts` (`updateWithAudit`) + pantalla nueva en el frontend |
| **C3** — líneas de factura | Backend chico + pantalla nueva | Sumar `items` a la respuesta del `GET /:id` existente + tipo + pantalla de detalle (hoy **no existe**) | `FACTURACION`, **pero al revés de lo esperable:** los GET de `/api/invoices/*` están deliberadamente **fuera** del gate por exhibición legal. La pantalla de detalle **no** debe gatearse por FACTURACION | `app-main`: `facturacion/invoices.routes.ts:116-129` (`getItemsByInvoiceId()` ya existe). `appfrontend-main`: `lib/facturacion/types.ts`, `api.ts`, pantalla nueva |
| **D7** — reportes POS/CRM | Media pantalla hecha. **2 paneles CRM libres; 3 POS condicionados a `useModuloVisible`** | 5 paneles sobre andamiaje existente (467 líneas, 5 paneles ya cableados) | `REPORTES` (gate actual del mount, `app.ts:345`) **+ `POS_RESTAURANTE`, que hoy NO gatea nada de esto** — es el bloqueo, ver §5 | `appfrontend-main`: `dashboard/reportes/page.tsx`. Y, según la salida elegida, `app-main/src/api/routes/reports.routes.ts` **o** `BusinessContext` |

---

## 2. D8 — ya está hecho, el backlog se arrastró

Cerrado el 28/08 con verificación contra la base (`pendientes-2026-08-28.md`
L619): alta y edición con click real, y SQL confirmando `iva_rate=10.50`,
`unit='litro'`, `arca_unit_code=NULL`. El código lo confirma
(`productos/page.tsx:24`).

Viajó como abierto por los pendientes del 29, 30 y 31 sin revalidarse — la
misma lección que `pendientes-2026-08-27.md` (HALLAZGO 1, L17; la cita
textual está en L31) ya había dejado escrita para estos seis ítems ("*backend-only se anotó sin re-verificar contra el
código*"). **Sin decisión de negocio: sale de la lista.**

**Confirmado por `architecture-governor` el 31/08/2026:** los 3 campos están
en `lib/productos/types.ts` (entidad + los 2 tipos de input) y en las 2
pantallas de producto, con el mapeo de submit vacío→`null`. Verificación a
nivel de **código fuente**; el governor no re-corrió la evidencia de base del
28/08 ni verificó con click.

---

## 3. D6 — el criterio NO resuelve la duda; lo que habilita D6 es otra cosa

**Criterio.** `criterios-datos.md:26` — la identidad de una TRANSACCIÓN es
"ID técnico + correlativo". Una reserva es TRANSACCIÓN
(`criterios-datos.md:23`). R9 (`criterios-datos.md:199`) dice que una
transacción **no debe depender del estado presente** de los maestros que
referencia, y enumera lo que congela: "precio, impuestos, **nombre**, código,
y datos fiscales del cliente".

**Corrección (31/08/2026, revisión del governor).** La primera versión de este
documento sostenía que la línea 26 *resolvía* la duda: el prefijo no es parte
de la identidad, luego formatear con el prefijo vivo no viola R9. **Ese
argumento no se sostiene.** La línea 26 habla de *identidad*; R9 habla de
*dependencia del estado presente*. Son preguntas distintas y responder una no
descarga la otra. Peor: el ejemplo canónico de R9 es "renombrar 'Barbero
Isahia' a 'Barbero Juan' reescribe la historia de todas las reservas pasadas",
que es estructuralmente el mismo daño que el residuo de acá abajo. **El
criterio del repo está silencioso sobre este caso.**

**Implicancia.** El prefijo vive en `business_profile` (MAESTRO) y no está
congelado en la reserva: formatear con el prefijo vivo re-etiqueta las
reservas históricas si alguien lo cambia.

**Qué habilita D6 realmente** — no el criterio, sino dos hechos:

1. **La decisión ya está tomada en código.** El docblock de
   `reservation.mapper.ts:34` (D6, 22/08/2026) prescribe formatear con
   `businessProfile.reservationNumberPrefix`. Seguirlo no es una decisión
   nueva; apartarse sí lo sería.
2. **No existe pantalla de edición del prefijo**, así que hoy nadie lo cambia.

**Precisión sobre el punto 2 — la exposición es menor de lo que parece, pero
NO es teórica.** El camino de escritura ya está vivo: `PUT
/api/business-profile` (`business-profile.routes.ts:45`, MANAGEMENT, sin gate
de módulo) acepta los dos prefijos vía `request.schemas.ts:474-475`, y
`sql.business-profile.repository.ts:147-153` los escribe. Lo único que falta
es la pantalla.

**Opción visible.** Implementar como dice el docblock, sin migración ni
snapshot.

**Gatillo de revisión, obligatorio:** el día que se construya una pantalla
para editar el prefijo, **hay que volver a responder R9** — o se congela el
prefijo en la reserva, o se acepta el re-etiquetado como decisión de producto
explícita. Dejar de diferirlo por ausencia de pantalla en cuanto la pantalla
exista.

---

## 4. C1-A — dos de las cuatro reglas se activan justo con la CRUD

**Criterio.** `criterios-datos.md:17` obliga a declarar la clase de toda tabla
nueva. Ya está declarado: `diseno-sena-unidades-c1a-2026-08-27.md:221`
clasifica `deposit_policies` como MAESTRO y lista 4 reglas que incumple.

**Implicancia.** Dos se activan al darle la pantalla, no antes:

- **R8 auditoría.** Cambiar un % de seña es el caso "un cliente discute un
  cobro". El `update` tiene que pasar por `updateWithAudit()` (`audit.ts:131`).
  No es opcional ni posterior.
- **R3 borrado ≠ pausado.** La tabla tiene `active` y no `deleted_at`. Con UI
  de alta, "pausé la seña de temporada baja" y "cargué mal el %" quedan
  indistinguibles para siempre. El diseño lo marca **decisión pendiente**.

**Hallazgo operativo heredado del mismo documento:** `POST
/customers/:id/payments` está gateado por `CUENTAS_CORRIENTES`. Un negocio que
configure seña sin ese módulo se autobloquea — no puede confirmar la reserva
ni cobrar. La pantalla necesita ese guard.

**Estado de los bloqueos de la §7 de ese diseño — son CUATRO, no tres.** El
punto 1 (Paso 0) está **resuelto** desde el 27/08. Siguen abiertos **tres**:

- **2.** el fallback de la tabla de su §4 (el diseño recomienda **a**);
- **3.** `deleted_at` en `deposit_policies` (R3) — sí/no;
- **4.** snapshot de "qué política ganó" (`applied_deposit_policy_id`) — sí/no.

El punto 4 **faltaba en la primera versión de este documento**; lo detectó la
revisión del governor del 31/08. Es decisión de schema, igual que el 3.

---

## 5. D7 — no se puede implementar dentro del alcance fijado

**Criterio.** `enums.ts:78` — "*POS_RESTAURANTE y ALOJAMIENTO son módulos
comercialmente distintos aunque convivan en un mismo negocio — no conflacionar
en un solo módulo hospitalidad*". Y `enums.ts:82-84`: salvo ALOJAMIENTO, "*el
resto arranca deshabilitado hasta que exista una pantalla de selección/pago*"
(la frase que importa está en L83).

**Implicancia.** Todo `/api/reports` está detrás de un único
`requireModule(ModuleKey.REPORTES)` (`app.ts:345`), y `reports.routes.ts` no
tiene **ni un solo** `requireModule` en sus 10 rutas.

La cuenta exacta importa, porque parte de D7 no está bloqueada:

| Reporte | Lee de | Sin POS muestra |
|---|---|---|
| `pos/sales-by-product` | `orderRepository` | vacío |
| `pos/ticket-summary` | `orderRepository` | vacío |
| `pos/waste` | `stockMovementRepository` | vacío |
| `crm/applied-rates` | `orderRepository` **+** `reservationRepository` | **datos reales de reservas** |
| `crm/new-vs-recurring` | `customerRepository` (cero POS) | **datos reales** |

O sea: **4 de 5 tocan repos de POS, pero solo 3 de 5 quedan vacíos sin POS**
(`report.service.ts:246-279`).

Como el schema de tenant es el mismo para todos, las tablas existen y
devuelven vacío. Un negocio con REPORTES y sin POS_RESTAURANTE —el caso por
defecto según la línea 84— recibiría tres paneles vacíos de un módulo que no
compró: conflacionar los dos módulos en la superficie, justo lo que la línea
78 prohíbe.

Y la pantalla hoy **no tiene ningún gating**: no hay `useModuloVisible` ni
`BusinessContext` en `reportes/page.tsx`; depende enteramente del 402 del
backend.

**Es la misma clase de inconsistencia que el caso de referencia nav-vs-gate**
de `DECISION_REVIEW.md`: dos superficies calculando "habilitado" con
definiciones distintas.

**Corrección (31/08/2026, revisión del governor): la primera versión de este
documento decía que no había salida dentro del alcance. Era falso — hay
cinco opciones, y dos de ellas no estaban vistas.**

| Salida | Qué implica | ¿Dentro del alcance? |
|---|---|---|
| **(a)** paneles vacíos | Contradice `enums.ts:78` | Sí, pero es decisión consciente de producto |
| **(b)** **modificar** `BusinessContext` | Tocar `lib/business-context/` | **No** — excluido por el dueño |
| **(c)** `requireModule(POS_RESTAURANTE)` en las 3 rutas | Tocar el modelo multirubro | **No** — excluido por el dueño |
| **(d)** **consumir** el hook que ya existe | `useModuloVisible('POS_RESTAURANTE')` en `reportes/page.tsx`. **No toca ningún archivo de `lib/business-context/`** | **SÍ — resuelto por el dueño el 31/08** |
| **(e)** **partir D7**: los 2 paneles CRM ya | `new-vs-recurring` y `applied-rates` no quedan vacíos sin POS | **Sí, sin decisión previa** |

**Sobre (d) — la distinción que la primera versión no hizo, y cómo la resolvió
el dueño.** Modificar `BusinessContext` y *consumirlo* no son lo mismo.
`useModuloVisible` ya está exportado del provider y **ya se consume en
producción**: `productos/page.tsx:63` y `productos/[id]/page.tsx:108` llaman
`useModuloVisible('FACTURACION')` — es el propio trabajo de D8, mergeado en
`367a65f`.

> **Decisión del dueño (31/08/2026):** *"consumir BusinessContext está
> permitido. La restricción 'no tocar BusinessContext' significa no modificar
> `lib/business-context/`, el provider, el resolver ni el contrato. No prohíbe
> consumir `useModuloVisible()`."*

Lo que **sigue prohibido** en este frente, explícitamente: agregar
`requireModule(POS_RESTAURANTE)` a las rutas de backend, y tocar
`getBusinessModules()`, `requireModule()` o el 402.

**Advertencia honesta sobre (d), que la respalda en vez de bloquearla:** el
hook es **fail-open por diseño** (docblock del provider: *"que esto devuelva
`true` NO significa que la capacidad esté habilitada. No usarlo como
autorización"*). Durante loading/error los paneles se renderizan igual. Pero
el problema de §5 es de **presentación**, no de autorización — el gate real
sigue siendo el 402 del backend. Para este uso, fail-open es la semántica
correcta.

**(e) — D7 no es atómico, y el dueño lo separó explícitamente.** Los cinco
paneles siguen caminos distintos:

| Panel | Camino resuelto por el dueño (31/08) |
|---|---|
| `crm/new-vs-recurring` | No queda vacío sin POS. **Sigue su propio análisis funcional**, no depende de esta decisión |
| `crm/applied-rates` | Ídem — combina órdenes y reservas, sin POS muestra datos reales de reservas |
| `pos/sales-by-product` | **Condicionado a `useModuloVisible('POS_RESTAURANTE')`**, o documentado como bloque de implementación separado |
| `pos/ticket-summary` | Ídem |
| `pos/waste` | Ídem |

---

## 6. C3 — tres implicancias concretas

**Criterio.** `criterios-datos.md:25` — un DOCUMENTO "nunca se edita, ni un
carácter". A3.7 en `criterios-negocio.md:153` — "si el IVA cambia, las
facturas viejas no cambian". Y `invoices.routes.ts:14-20` declara que los GET de
`/api/invoices/*` van sin gate a propósito (la declaración está en L15-16; la
cláusula de obligación legal, en L17), porque exhibir un comprobante
emitido es obligación legal y "no puede quedar detrás de un entitlement
revocable".

1. **La pantalla pinta `invoice_items` tal como están guardados**, sin
   enriquecer con datos de producto actuales. El backend ya los congela
   (`invoice.service.ts:298` snapshotea `ivaRate`/`arcaUnitCode`;
   `sql.invoice.repository.ts:221` los lee de la fila). Un `JOIN` a productos
   para "mejorar" el nombre reescribiría el documento en pantalla.
2. **Las líneas salen por el `GET /:id` que ya existe, no por una sub-ruta
   nueva.** Si quedaran del lado gateado, un negocio con FACTURACION revocada
   vería la cabecera y no las líneas: exhibición parcial, que incumple la
   obligación por la mitad.
3. **No existe pantalla de detalle.** `invoicesApi.get()` está definido
   (`lib/facturacion/api.ts:25`) y no lo llama nadie. Hay que construirla.

Sin decisión de negocio pendiente.

---

## 7. Contrato HTTP — dónde va cada cosa

**Criterio.** `HTTP_CONTRACTS.md:3` declara su propio alcance: "*define los
códigos de respuesta exactos de cada endpoint*". No describe payloads en
ningún endpoint — para reservas lista método, ruta y códigos y nada más.

**Implicancia.** Meter la forma de las respuestas ahí contradice el propósito
escrito del documento. El lugar de la forma es `src/openapi/spec.ts`.

**Opción visible.** Forma en el OpenAPI, fila de códigos en
`HTTP_CONTRACTS.md`.

**Cobertura actual, verificada el 31/08:**

| | Cubre |
|---|---|
| `HTTP_CONTRACTS.md` (228 líneas) | categorías, recursos, reservas, autenticación, usuarios — **solo códigos** |
| `src/openapi/spec.ts` (1003 líneas) | 18 rutas: health, login, repair-tenant-db, resources ×3, reservations ×5, bookable-services ×4, reportes ×3. **De esas 18, dos no existen** — ver §8 |
| **Sin documentar** | productos, clientes, facturas, perfil de negocio, `reports/pos/*` y `reports/crm/*` (5), `occupancy/by-category`, `accounts-receivable`, `deposit_policies` (no existe) |

`reservationNumber` y `customerNumber` **no aparecen en el OpenAPI**: el
contrato que D6 necesita no está documentado.

---

## 8. Paso 5 — inconsistencia estructural no preguntada

**El OpenAPI no tiene ninguna verificación.** No hay test que lo contraste
contra las rutas reales (`src/tests/` tiene `domain`, `integration`,
`repositories`, `security` y ninguno lo toca). Documentar 5 recursos nuevos
agrega un artefacto más mantenido a mano que nadie chequea — **la misma
enfermedad que RBAC-SYNC-001** (`pendientes-2026-08-31.md`).

**Y no es una predicción: el spec YA miente, hoy.** Lo encontró la revisión
del governor del 31/08. `src/openapi/spec.ts` documenta
`/api/reports/summary` y `/api/reports/underutilized`; las rutas montadas de
verdad son `/api/reports/occupancy/summary` y
`/api/reports/occupancy/underutilized` (`reports.routes.ts`). **2 de las 18
rutas documentadas devuelven 404.** El modo de falla que este documento
describía en futuro ya ocurrió, y nadie se enteró porque nada lo chequea.

No se propone resolverlo en esta tanda. Sí queda dicho que documentar el
contrato **no** cierra el problema: produce documentación no verificada, mejor
que nada y peor de lo que parece.

---

## 9. Decisiones pendientes del dueño

En orden de bloqueo:

**Resueltas el 31/08/2026 — ya no son preguntas:**

- **D7** — consumir `BusinessContext` está permitido (no modificarlo). Los 3
  paneles POS van condicionados a `useModuloVisible('POS_RESTAURANTE')` o como
  bloque separado; los 2 CRM siguen su propio análisis. Sin tocar backend.
- **D8** — confirmado y fuera de la lista, con el caveat de evidencia
  registrado en §2 (validación contra código de `367a65f`, no runtime).
- **D6** — aceptado con la justificación corregida de §3, y con el gatillo de
  reapertura de R9 vigente.

**Sigue abierto — decisión de negocio del dueño:**

- **C1-A — tres puntos**, los tres en `diseno-sena-unidades-c1a-2026-08-27.md`
  §7 (que tiene **cuatro** bloqueos, uno ya resuelto): el fallback de la §4,
  `deleted_at` (R3) y el snapshot `applied_deposit_policy_id`.

**D6 y C3 quedan listos para implementar apenas haya OK:** los dos tienen
criterio, ninguno tiene decisión de negocio pendiente. Orden natural: D6
primero por ser el más chico.

---

## Anclado en

- `docs/DECISION_REVIEW.md` — el método aplicado
- `docs/criterios-datos.md` L17, L22, L24-26, L199 — clases y R9
- `docs/criterios-negocio.md` L153 — A3.7
- `docs/diseno-sena-unidades-c1a-2026-08-27.md` §5 y §7 — C1-A
- `docs/pendientes-2026-08-27.md` HALLAZGO 1 — la etiqueta que se arrastró
- `docs/pendientes-2026-08-28.md` L619 — cierre de D8
- `src/app.ts` L307, L309, L318, L329, L335, L345 — los gates verificados
- `src/types/enums.ts` L78, L84 — módulos comercialmente distintos
- `src/facturacion/invoices.routes.ts` L17 — exhibición legal
