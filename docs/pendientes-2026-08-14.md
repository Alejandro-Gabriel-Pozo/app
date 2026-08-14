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

## C. Calidad de código (`app-main`) — sin cambios esta sesión

- C2. Boilerplate try/catch — sigue parcial (falta auditar
  `users`/`categories`/`auth`/`locations` routes).
- C8. `dependency-cruiser` — sigue con 5 `no-orphans` sin triage y sin
  Graphviz para el grafo visual.

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
