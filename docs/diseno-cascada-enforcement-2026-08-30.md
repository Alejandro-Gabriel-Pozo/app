# Diseño — cableado acotado de la cascada de capacidades en el gate de módulos

- **Fecha:** 2026-08-30
- **Estado:** **implementada** en `dbf9503` (app-main, 30/08/2026), precedida
  por `e384e3a` (sync del maestro RBAC). Ajustes del análisis de implicancias
  aplicados: **P5** — nivel de log (`info` en el 402 fail-closed normal, `warn`
  sólo cuando `restrictedBy = NOT_IMPLEMENTED`); **P6** — bloque
  `invoices.routes.ts` de `rbac-matriz-endpoints.md` reescrito. Los escalones y
  decisiones diferidos van a Fase 5 — ver
  [diseno-lifecycle-plan-fase5-2026-08-30.md](diseno-lifecycle-plan-fase5-2026-08-30.md).
- **Etiquetas:** `capacidades` `entitlements` `autorización` `Fase-5`

## 1. Contexto

`PlatformRepository.getBusinessModules()` resuelve hoy sólo con los escalones 1
(system default → `false`, fail-closed) y 3 (override del tenant,
`business_modules.enabled`). `resolveCapabilities()` (la cascada de 5 escalones)
existe como función pura desde `c6c4185` (Fase 4 Bloque 1) pero **no está
cableada**. `comoRecordDeModulos()` ya proyecta su resultado a la misma forma
`Record<moduleKey, boolean>` que consume `requireModule()`.

Meter la cascada **completa** dentro del gate cambiaría el `402
MODULE_NOT_ENABLED` de ~20 grupos de rutas (POS_RESTAURANTE, CUENTAS_CORRIENTES,
REPORTES, HOUSEKEEPING, ALOJAMIENTO, FACTURACION) y de la ruta
`GET /api/business/modules`.

## 2. Por qué acotado

El análisis conceptual (criterios de negocio + modelo) mostró dos problemas en
la versión completa:

- **Adelanta Fase 5.** Los escalones 2 (preset de rubro) y 4 (`min_plan`)
  dependen de tablas de plataforma (`industry_capabilities`, `modules.min_plan`)
  que hoy **no tienen ruta de escritura de Superadmin ni auditoría** (Fase 5,
  `plan-separacion-dominios-multirubro-2026-08-28.md` §10/§12). Cablearlos ahora
  arma un kill-switch de blast-radius total sin rastro ni preview.
- **Problema legal en la lectura de comprobantes.** `GET /api/invoices/*` está
  detrás de `requireModule(FACTURACION)`. Si la cascada resuelve FACTURACION →
  `false` (bajó de plan, `implemented=false`, preset), el resultado es `402` al
  **leer un comprobante fiscal ya emitido**, contra la obligación de retención y
  exhibición (`criterios-datos.md` línea 24: un DOCUMENTO "jamás" se borra).

## 3. Alcance autorizado (a-e)

| # | Cambio |
|---|---|
| **a** | Reemplazar el cuerpo de `getBusinessModules()` por la forma **2 queries + `implemented`**: `SELECT module_key, implemented FROM modules` + `SELECT module_key, enabled FROM business_modules WHERE business_id = $1`, y `modules[k] = (enabledByKey.get(k) ?? false) && implemented`. Es escalón 1 + 3 + `NOT_IMPLEMENTED` exacto. **No se rutea por `resolveCapabilities()`** en el bloque acotado: hacerlo obligaría a alimentarle input adulterado (`industryKey: null` mentido, `active: true` fingido) para neutralizar los 3 escalones diferidos — el anti-patrón de `DEFENSIVE_DEVELOPING.md` §1.5. El resolver se cablea en **Fase 5** con input real completo, sin parámetro de modo (ver `diseno-lifecycle-plan-fase5-2026-08-30.md` §5). Para `biz-demo-01` (todo `implemented`) el resultado es idéntico al `getBusinessModules()` actual. |
| **b** | **Diferir a Fase 5**: escalón 2 (preset — puede *habilitar* un módulo sin fila en `business_modules`) y escalón 4 (`min_plan`). |
| **c** | `NOT_ACTIVE` (`active=false`) y `DELETED` (`deleted_at`): son kill-switches de plataforma con blast-radius total → se manejan como **acción explícita y auditada**, no como input pasivo de un gate por request. No entran en el enforcement de este bloque (la forma 2-queries sólo mira `implemented`). |
| **d** | En este bloque, **sacar `requireModule` de `GET /api/invoices/*`** — el caso legalmente forzado (lectura de comprobantes AFIP ya emitidos). `POST`/`DELETE` de invoices quedan gateados. La clasificación amplia de lecturas de TRANSACCIÓN (reservas, órdenes, estadías, cuentas corrientes, housekeeping GET) es **prerequisito de Fase 5** — debe hacerse *antes* de que escalón 2/4 entren en vivo. Nota: con la versión acotada un módulo sólo se apaga vía `NOT_IMPLEMENTED` ("sin código" ⟹ sin documentos detrás), así que el lockout de lectura no es load-bearing todavía; se cementa la invariante antes de Fase 5. Invariante: la lectura de documentos/transacciones ya emitidos **nunca** se gatea por un entitlement revocable. |
| **e** | En el `402`, incluir `restrictedBy` — con la forma 2-queries se deriva inline: `implemented ? null : 'NOT_IMPLEMENTED'` (en el bloque acotado es el único valor posible), y `origin` = `enabledByKey.has(k) ? 'TENANT_OVERRIDE' : 'SYSTEM_DEFAULT'`. Al body del `402` y a un log estructurado. Contrato aditivo/opcional en `MODULE_NOT_ENABLED` (`http.ts`), backend-only, sin cambio de frontend. Sin PII (`criterios-negocio.md` A7.1). |

## 4. Qué NO cambia

- **Fail-closed.** Escalón 1 = `false`; sólo el escalón 3 (override) prende. Un
  módulo del catálogo sin fila en `business_modules` sigue en `false`.
- **La distinción 503 vs 402.** `container.getBusinessModules` sigue haciendo
  `findById` y **lanzando** ante negocio inexistente (→ 503), distinto de "módulo
  deshabilitado" (→ 402). Un throw dentro de `resolveCapabilities` / la
  validación de forma mapea a **503**, nunca a "todo false" ni "todo true".
- **RBAC.** Cero cambios en `authorize()` / `rbac-matriz-endpoints.md` / el
  conteo de `rbac-matrix-sync.test.ts`. La cascada vive 100% en el plano de
  entitlement, no toca el de autorización por rol.

## 5. Verificación

**Ejecutado en `dbf9503`:** `tsc --noEmit`, `npm run lint`, `npm run lint:arch`
(0 violaciones) y `npx vitest run` (1695 pasan, 1 skip, 1 todo, 0 fallan) en
verde. Pendiente: chequeo en el runtime desplegado y contra la BD de plataforma
de `biz-demo-01` (abajo).

- `tsc --noEmit`; suite `vitest` completa verde. ✅ (`dbf9503`)
- Test de **equivalencia**: para un snapshot tipo `biz-demo-01` (`industry_key`
  NULL, sin `min_plan`, todos `active`+`implemented`), el `Record` resultante es
  idéntico al del `getBusinessModules()` actual — la función
  `equivaleAGetBusinessModules()` (`capability.resolver.ts`) ya lo predice.
  Cubierto por `platform.repository.test.ts` (caso "override + `implemented` →
  enabled"). ✅
- Test de **divergencia por `NOT_IMPLEMENTED`**: un módulo con `implemented=false`
  → `false` en el nuevo, aunque tenga fila `business_modules.enabled=true`.
  Cubierto por `platform.repository.test.ts` + `module.middleware.test.ts`. ✅
- **Chequeo read-only contra la BD de plataforma de `biz-demo-01`**: correr la
  nueva resolución contra datos reales y confirmar `Record` idéntico al actual.
  ⏳ pendiente (runtime).
- **Rollback:** `git revert dbf9503` (y `e384e3a` si hace falta). Sin cambio de
  schema ni de datos — la cascada lee columnas que ya existen.

## 6. Qué queda para Fase 5

Escalón 2 (preset), escalón 4 (`min_plan`), los kill-switches `active`/`deleted`
con superficie controlada, y las decisiones de producto (retroactividad de
presets, acople plan↔módulo, aviso/gracia/corte). Todo en
[diseno-lifecycle-plan-fase5-2026-08-30.md](diseno-lifecycle-plan-fase5-2026-08-30.md).

**Forma del ruteo por el resolver, decidida (B):** Fase 5 reemplaza el cuerpo de
2 queries por `comoRecordDeModulos(resolveCapabilities(inputReal))` con el input
**real completo** (`industryKey` real, `plan` real, catálogo real) y el resolver
corre los 5 escalones. **Sin parámetro de "qué escalones".** El motivo —que hoy
el nav ya consume la cascada completa y el gate sólo 1+3, y Fase 5 los hace
converger— está en `diseno-lifecycle-plan-fase5-2026-08-30.md` §5.

## 7. Referencias

- `src/business-context/capability.resolver.ts` (`resolveCapabilities`,
  `comoRecordDeModulos`, `equivaleAGetBusinessModules`, `restriccionQueAplica`).
- `src/platform/platform.repository.ts` `getBusinessModules()`.
- `src/security/module.middleware.ts` `requireModule()`.
- `plan-separacion-dominios-multirubro-2026-08-28.md` §5.3 (cascada), §10
  (auditoría — gap), §12 (fases), §14 D5 (cambio de rubro).
- `criterios-datos.md` (MAESTRO/TRANSACCIÓN/DOCUMENTO), `criterios-negocio.md`
  A7.1 / A9.4.
