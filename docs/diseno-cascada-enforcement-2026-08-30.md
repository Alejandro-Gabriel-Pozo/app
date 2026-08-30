# Diseño — cableado acotado de la cascada de capacidades en el gate de módulos

- **Fecha:** 2026-08-30
- **Estado:** decidido. La implementación de la versión acotada (a-e) está
  **autorizada**, sin encarar todavía. Los escalones y decisiones diferidos van
  a Fase 5 — ver [diseno-lifecycle-plan-fase5-2026-08-30.md](diseno-lifecycle-plan-fase5-2026-08-30.md).
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
| **a** | Rutear `getBusinessModules()` por `resolveCapabilities()` + `comoRecordDeModulos()`, enforcando **sólo escalones 1-3** (= comportamiento actual) **+ `NOT_IMPLEMENTED`** (módulo catalogado sin código detrás — genuino "no disponible"). Para `biz-demo-01` es un refactor sin cambio de resultado. |
| **b** | **Diferir a Fase 5**: escalón 2 (preset — puede *habilitar* un módulo sin fila en `business_modules`) y escalón 4 (`min_plan`). |
| **c** | `NOT_ACTIVE` (`active=false`) y `DELETED` (`deleted_at`): son kill-switches de plataforma con blast-radius total → se manejan como **acción explícita y auditada**, no como input pasivo de un gate por request. No entran en el enforcement de este bloque. |
| **d** | **Sacar `requireModule` de las rutas GET de DOCUMENTO/TRANSACCIÓN** (`GET /api/invoices/*`, `GET /api/reservations/:id`, listados equivalentes) — o reemplazar por un chequeo "estuvo habilitado alguna vez". El gate de entitlement queda sobre **creación/mutación**. Invariante: la lectura de documentos/transacciones ya emitidos **nunca** se gatea por un entitlement revocable. |
| **e** | Llevar `origin` (`SYSTEM_DEFAULT`/`INDUSTRY_PRESET`/`TENANT_OVERRIDE`) y `restrictedBy` (`MIN_PLAN`/`NOT_ACTIVE`/`NOT_IMPLEMENTED`/`DELETED`) — que `resolveCapabilities` produce y `comoRecordDeModulos` descarta — al body del `402` y a un log estructurado. Sin PII (`criterios-negocio.md` A7.1). |

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

- `tsc --noEmit`; suite `vitest` completa verde.
- Test de **equivalencia**: para un snapshot tipo `biz-demo-01` (`industry_key`
  NULL, sin `min_plan`, todos `active`+`implemented`), el `Record` resultante es
  idéntico al del `getBusinessModules()` actual — la función
  `equivaleAGetBusinessModules()` (`capability.resolver.ts`) ya lo predice.
- Test de **divergencia por `NOT_IMPLEMENTED`**: un módulo con `implemented=false`
  → `false` en el nuevo, aunque tenga fila `business_modules.enabled=true`.
- **Chequeo read-only contra la BD de plataforma de `biz-demo-01`**: correr la
  nueva resolución contra datos reales y confirmar `Record` idéntico al actual.
- **Rollback:** `git revert`. Sin cambio de schema ni de datos — la cascada lee
  columnas que ya existen.

## 6. Qué queda para Fase 5

Escalón 2 (preset), escalón 4 (`min_plan`), los kill-switches `active`/`deleted`
con superficie controlada, y las decisiones de producto (retroactividad de
presets, acople plan↔módulo, aviso/gracia/corte). Todo en
[diseno-lifecycle-plan-fase5-2026-08-30.md](diseno-lifecycle-plan-fase5-2026-08-30.md).

## 7. Referencias

- `src/business-context/capability.resolver.ts` (`resolveCapabilities`,
  `comoRecordDeModulos`, `equivaleAGetBusinessModules`, `restriccionQueAplica`).
- `src/platform/platform.repository.ts` `getBusinessModules()`.
- `src/security/module.middleware.ts` `requireModule()`.
- `plan-separacion-dominios-multirubro-2026-08-28.md` §5.3 (cascada), §10
  (auditoría — gap), §12 (fases), §14 D5 (cambio de rubro).
- `criterios-datos.md` (MAESTRO/TRANSACCIÓN/DOCUMENTO), `criterios-negocio.md`
  A7.1 / A9.4.
