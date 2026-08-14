# Pendientes — Viernes 14 de Agosto 2026

Consolida lo que quedó diferido de `pendientes-2026-08-13.md` + lo nuevo de
la sesión del 14/08 (comparación contra Tango + auditoría de cambios).
Mismo criterio de agrupación que el archivo anterior: deuda estructural
primero, seguridad después, calidad de código, backlog, observaciones sin
implementar. Marcar `✅ RESUELTO` in-place al cerrar un ítem.

---

## A. Deuda estructural (`app-main`)

### A2. `Owner` / liquidación a terceros — sigue en pausa
Sin cambios desde 13/08. Bloquea solo el vertical de gestión de terceros
(deptos/canchas de otros dueños) — retomar cuando aparezca el caso de uso.

### A4. Gap de proceso de `migrate:tenants` — parcialmente mitigado hoy, sigue sin blindaje automático
Hoy, al agregar `audit_log` a `schema.sql`, se bumpeó `CURRENT_SCHEMA_VERSION`
(1→2) **en el mismo commit** que el cambio de schema, y se aplicó a mano
contra la tenant DB real (`DB-APP-PPMS`, vía Neon MCP) + se actualizó
`businesses.schema_version` en la BD de plataforma (`pdb-ppms`) —
confirmado con evidencia (columnas de `audit_log`, fila en
`schema_migrations`, `schema_version=2`). Esto evitó repetir el incidente
del 13/08.

**Lo que sigue sin resolver — sigue siendo un gap de proceso, no de esta
sesión puntual:** nada en el pipeline fuerza el bump ni la migración
automáticamente. Se hizo bien hoy porque se acordó a mano, igual que el
13/08 se hizo mal por lo mismo. Alternativas ya anotadas en el archivo
anterior (chequeo en CI, `migrate:tenants` en el deploy de Render) — siguen
sin decidir.

---

## B. Seguridad (`appfrontend-main`) — sin cambios esta sesión

- B1. 7 vulnerabilidades `high` restantes (Next 14→16) — sigue diferido a
  propósito.
- B2. Migración de auth a httpOnly cookie — **paso 3/N sigue sin empezar**
  (reescribir `api.ts`/`AuthContext.tsx`, `/api/auth/refresh`, decidir
  portal clientes/plataforma). Nada tocado hoy.

---

## C. Calidad de código (`app-main`)

### C2. Boilerplate try/catch + contrato `NOT_FOUND` — ✅ RESUELTO (14/08/2026)
Auditados los 4 archivos que quedaban pendientes, uno por uno contra
`domainErrorStatus()` — el hallazgo real fue que la premisa original ("mismo
patrón en los 4 archivos") era parcialmente incorrecta:

- **`categories.routes.ts` — sí tenía el patrón, y arreglarlo destapó un bug
  de raíz:** existían **dos clases `CategoryNotFoundError` distintas** —
  una en `domain/errors.ts` (`DomainError` real, code `CATEGORY_NOT_FOUND`,
  ya mapeada a 404 en `error.middleware.ts`, pero **nunca importada por
  nadie**) y otra en `category.service.ts` (`extends Error` a secas, sin
  `.code`) que era la que realmente se usaba en todo el código
  (`sql.category.repository.ts`, `category.service.ts`,
  `categories.routes.ts`). Por eso no se podía sacar el `instanceof` sin
  que un 404 real cayera al 500 genérico. Se unificaron en la de
  `domain/errors.ts` (la correcta), se actualizaron los 2 imports, y se
  sacaron los 3 bloques `instanceof CategoryNotFoundError` de
  `categories.routes.ts` — ahora responden `CATEGORY_NOT_FOUND` en vez de
  `NOT_FOUND` genérico. Confirmado contra `appfrontend-main` que
  `isNotFound()` (el único consumidor posible de `NOT_FOUND` genérico)
  sigue sin ningún caller — no rompe nada.
- **`users.routes.ts` — no tenía el patrón.** Sus 404 son chequeos
  manuales (`if (!member) res.status(404)...`) sin lanzar ningún error de
  dominio — no hay ninguna clase para migrar. No es deuda de C2, es un
  estilo distinto (más simple, funciona bien para este archivo).
- **`auth.routes.ts` — no tenía el patrón.** Su manejo local es específico
  de `INVALID_CREDENTIALS`/`INVALID_BUSINESS_SELECTION` (401, no 404) —
  mensajes de auth deliberadamente genéricos por seguridad, correcto que
  se manejen ahí y no en `domainErrorStatus()`.
- **`locations.routes.ts` — no tenía el patrón.** Sin ningún manejo de
  `DomainError`, solo `ZodError`. Nada que tocar.

1 test ajustado (import de `CategoryNotFoundError` movido a
`domain/errors.ts`), 309/310 suite verde, typecheck y lint limpios.

### C8. `dependency-cruiser` — ✅ RESUELTO (14/08/2026)
Los 5 `no-orphans` resultaron ser restos de migraciones anteriores, **ya
vaciados a propósito** (`export {}`) y documentados como deprecados en su
propio header: `types/preferences.types.ts`, `services/validation.registry.ts`,
`services/validation.factory.ts`, `security/jwt.service.ts`,
`schemas/preferences.schemas.ts`. Confirmado con grep que ningún otro
archivo los referencia (ni por import ni por nombre de símbolo) antes de
borrarlos. `depcruise` post-borrado: 0 `no-orphans`, solo queda la 1
violación ya conocida y justificada (`supabase.occupancy.repository.ts`,
excluida en `tsconfig.json`, scaffolding de una integración abandonada).
`docs/analysis/dependency-graph.dot` y `dependency-violations.html`
regenerados. Typecheck, lint y suite completa (309/310) verdes.

**Sigue sin la parte visual** (sin Graphviz instalado, software de
sistema) — no se tocó, es lo que ya estaba documentado como fuera de
alcance.

---

## D. Backlog conocido — sin cambios + 3 ítems nuevos de la comparación con Tango

Sin cambios: FACTURACION sin ruta, filtro de rubro en `resource_categories`
(ver E1), `tsconfig.json` excluye tests del typecheck.

**Nuevos (14/08/2026), de `Gap analysis - Tango ERP vs modelo actual.md`
— gaps de producto, no de reglas (esos ya se resolvieron hoy, ver sección
F):**

- **Roles como entidad configurable, no enum de código.** Hoy cualquier
  ajuste de permisos requiere tocar código y redeployar. Se cruza con
  E4a (estandarizar ABM/usuarios) — no es un ítem nuevo aislado, es
  evidencia concreta de por qué E4a importa.
- **Sin concepto de caja/turno** (apertura, cierre, saldo). Relevante si el
  POS se vende como reemplazo real de caja registradora, no solo carrito de
  cobro.
- **`FinancialTransaction` no modela medios de pago con cuotas/recargo por
  tarjeta.** Un cobro con tarjeta en 3 cuotas no tiene dónde vivir ese
  desglose hoy.

Ninguno de los tres se diseñó ni se implementó — quedan anotados para
priorizar cuando corresponda.

---

## E. Observaciones post-deploy del usuario — sin cambios esta sesión

E1-E7 siguen exactamente como en `pendientes-2026-08-13.md` — nada de esto
se tocó hoy. Ver ese archivo para el detalle completo de cada uno.

---

## F. Trabajo de hoy (14/08/2026)

### F1. Comparación Tango ERP vs modelo actual — ✅ HECHO
`Gap analysis - Tango ERP vs modelo actual.md` (en
`C:\Users\Usuario\Downloads\Logica de negocio\`). Alcance acotado a lo que
aplica al rubro del producto (se descartó explícitamente todo lo de
payroll/contabilidad completa/activo fijo/compras). Los 3 gaps de producto
nuevos quedaron en la sección D de este archivo.

### F2. Auditoría de cambios — R8/A9.4 — ✅ HECHO, alcance parcial a propósito
Tabla `audit_log` + `AuditLogRepository` (Sql/InMemory) + `diffFields()` +
wireado en `CategoryService.updateCategory` y
`ProductService.updateProduct`/`updateVariant` + endpoint de lectura
`GET /api/audit-log`. 8 tests nuevos, typecheck y lint limpios, 306/307
suite verde (el 1 que falta es el flaky de reloj real ya conocido).
Aplicado contra la tenant DB real y deployado (commits `0e92baf`/`552d307`,
pusheados a `origin/main`).

**Deliberadamente fuera de alcance — no asumir que está cubierto:**
- `create`/`deactivate` no dejan rastro, solo `update`.
- La escritura del audit log **no es transaccional** con el UPDATE
  principal (dos queries separadas) — si el insert de auditoría falla
  después de un update exitoso, el cambio queda sin rastro. Límite
  conocido, no resuelto.

### F4. Ampliar auditoría a PhysicalResource y BookableService — ✅ HECHO (14/08/2026)
Los otros dos maestros con precio, cerrando la lista que motivó R8.
`BookableServiceService.updateService` sigue el mismo patrón que
Category/Product (constructor gana `AuditLogRepository`, `changedBy` como
3er parámetro). `resources.routes.ts` **no tiene `ResourceService` propio**
(la lógica vive directo en el router) — se auditó ahí mismo, mismo patrón,
sin crear un service nuevo solo para esto. `visualData` (posición en el
plano) quedó explícitamente afuera del diff — es metadata de UI, no un
dato de negocio disputable, auditarlo generaría ruido en cada
drag-and-drop.

3 tests nuevos (`bookable-service.service.test.ts`, con fake mínimo del
repositorio — no hay `InMemoryBookableServiceRepository` en el repo
todavía). Sin test dedicado para `resources.routes.ts` — no hay ningún
test de rutas en este repo (mismo hallazgo que C1/C2), verificado con
typecheck + suite completa en su lugar. 309/310 tests verdes, typecheck y
lint limpios. Commiteado y pusheado (`6bb84be`) — no toca `schema.sql`, sin bump de
versión ni `migrate:tenants` necesarios.

**Verificación pendiente, distinta a la de F3:** a diferencia del endpoint
nuevo de F2 (verificable sin login, esperando 401 vs 404), esto modifica
el comportamiento de rutas que ya existen y requieren sesión MANAGEMENT
— no verificable con un curl sin credenciales. Falta confirmar en el
navegador: editar un recurso o un servicio agendable en producción y
chequear que `GET /api/audit-log?entity=resources&entityId=...` (o
`bookable_services`) devuelva la fila nueva.

### F3. Verificar el deploy en Render — ✅ RESUELTO (14/08/2026)
`curl https://app-chny.onrender.com/api/audit-log?entity=x&entityId=y` sin
auth devolvió `401` (rechazo por falta de token), no `404` — confirma que
el router nuevo ya está montado en producción, el deploy de `d60de60`
terminó. `GET /health` respondió `200`.
