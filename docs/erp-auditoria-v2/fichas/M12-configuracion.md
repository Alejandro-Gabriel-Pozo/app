# M12 · Configuración del negocio

**Auditado:** 02/09/2026 · **Método:** `00-programa-v2.md`

## 1. Flujo auditado

configuración → vigencia → aplicación → auditoría → reversión

## 2. Estado

- **Módulo:** ⚠️ Revisado con brechas
- **Flujo "editar el perfil del negocio":** ✅ Completo — es el mejor flujo
  auditado y con mejor control de acceso del sistema
- **Flujo "vigencia y reversión":** ◌ No existe

## 3. Último paso confirmado / primer paso incompleto

- **Último paso confirmado:** la auditoría **con candado por sensibilidad**. Una
  vez cargado el CUIT, tocar cualquier campo fiscal exige `OWNER_ONLY` además de
  `MANAGEMENT`, y **todo** `update()` queda en `audit_log`, no sólo los campos
  fiscales `[V]` (`src/api/routes/business-profile.routes.ts:10`;
  `src/domain/business-profile.service.ts:96`).
- **Primer paso incompleto:** **la vigencia**. Un cambio de configuración se
  aplica al instante y para atrás: cambiar `timezone` o `currency` reinterpreta
  todo el histórico. No hay `valid_from`, ni versión, ni reversión.

## 4. Severidad máxima

**S1** — cambiar la moneda o el huso horario de un negocio con operación cargada
reinterpreta datos ya registrados, sin aviso y sin vuelta atrás.

## 5. Superficie

| Pieza | Ubicación |
|---|---|
| Tabla | `business_profile` — 7 líneas en el `CREATE TABLE` y **25 `ALTER TABLE ... ADD COLUMN`** posteriores `[V]` (`grep -c "ALTER TABLE business_profile ADD COLUMN" src/db/schema.sql` → 25) |
| Servicio | `src/domain/business-profile.service.ts:56` |
| Rutas | `business-profile.routes.ts` (2), `business-hours.routes.ts` (3), `business-modules.routes.ts` (1), `business-plan-limits.routes.ts` (1), `business-context.routes.ts` (1) |
| Pantallas | `dashboard/mi-negocio`, `dashboard/empresa` |

## 6. Identidad

`[V]` `business_profile` es una fila única por tenant (una base por negocio). No
necesita identidad propia.

`[V]` **La forma en que creció es el hallazgo**: 7 líneas de definición original
y 25 columnas agregadas después. El perfil del negocio se convirtió en el cajón
donde va todo lo que es "config": moneda, huso, prefijos de numeración, datos
fiscales, credenciales AFIP cifradas, domicilio. Funciona, y hace que cualquier
consulta al perfil traiga datos fiscales junto a datos de presentación — que es
exactamente el riesgo que `business-context.routes.ts` tuvo que resolver a mano
(ver §10).

## 7. Estados

`[V]` Sin estados. Sin vigencia. Sin versión.

`[V]` `ModuleKey` tiene 6 valores (`src/types/enums.ts:86`) y define qué módulos
ve cada negocio; `plan_limits` los acota por plan
(`src/db/platform.schema.sql`). Los dos son configuración conmutable en caliente.

## 8. Documentos y movimientos

No aplica.

## 9. Saldos y reportes

No aplica. Pero **la configuración alimenta los saldos**: `currency` sale de acá
(`src/clientes-finanzas/customer-account.service.ts:127`) y se copia a cada
`financial_transaction`. Cambiarla no reescribe los movimientos viejos, que
conservan su moneda — eso está bien. Lo que no está resuelto es qué pasa con los
totales que suman filas de dos monedas distintas. `[H]` — la consulta de saldo no
filtra por moneda (`src/clientes-finanzas/sql.financial-transaction.repository.ts:377`).

## 10. Permisos y segregación

`[V]` **El caso mejor resuelto de todo el sistema.** `GET /api/business/context`
es `STAFF` y hace **destructuring explícito, nunca spread**, con el motivo
escrito: la entidad `BusinessProfile` trae `taxId`, `taxCondition`, `afipCuit` y
`afipSalesPoint`, y spreadearla filtraría datos fiscales a recepción
(`src/platform/business-context.routes.ts:66`).

`[V]` Y tiene cerca: **un test de conjunto exacto de claves** detecta si alguien
cambia esa línea (`src/platform/business-context.routes.ts:70`). Es el único
lugar del repo donde una decisión de exposición de datos está protegida por un
test que falla al agregar una clave.

`[V]` El candado `OWNER_ONLY` sobre el perfil fiscal ya cargado es el único uso
de ese grupo en los 245 endpoints (`datos/endpoints.csv`).

## 11. Auditoría y trazabilidad

`[V]` `business-profile.service.ts` audita **todo** `update()`, no sólo lo
fiscal (`src/api/routes/business-profile.routes.ts:15`;
`src/domain/business-profile.service.ts:96`). Es el modelo a copiar.

`[V]` Lo que **no** se audita: el encendido y apagado de módulos
(`business-modules.routes.ts`) y el cambio de plan, que se hace desde plataforma
(ver `fichas/M14-plataforma.md`). Apagar `FACTURACION` a un negocio es una
decisión con consecuencias y no deja rastro en el tenant.

## 12. Errores, idempotencia y fallo parcial

`[V]` `GET /api/business/context` resuelve el `businessId` **siempre** desde
`req.businessId` (que viene del JWT), y ningún parámetro de URL, body o query
puede seleccionar otro negocio (`src/platform/business-context.routes.ts:56`).
Está escrito como invariante, no como detalle.

`[V]` Si el negocio no existe, devuelve 404 **sin consultar `business_profile`**
(`src/platform/business-context.routes.ts:62`). Corta el camino antes de tocar la
base del tenant.

## 13. Capacidad ausente

1. **Vigencia y versión de la configuración.**
2. **Reversión.** No hay "volver a la configuración de ayer".
3. **Auditoría del encendido/apagado de módulos.**
4. **Advertencia al cambiar `currency` o `timezone`** con operación ya cargada.
5. **Configuración por sucursal.** `locations` existe (`src/db/schema.sql`), pero
   moneda, huso y prefijos son por negocio. ↔ `A2-T01-003`.

## 14. Brechas

| ID | Sev | Qué falta | Evidencia | Cruce |
|---|---|---|---|---|
| `A2-M12-001` | S1 | Cambiar `currency` o `timezone` reinterpreta el histórico, sin vigencia ni advertencia ni reversión. | `business_profile` sin `valid_from`; `src/clientes-finanzas/customer-account.service.ts:127` | **nuevo** |
| `A2-M12-002` | S1 | La consulta de saldo suma sin filtrar por moneda. | `src/clientes-finanzas/sql.financial-transaction.repository.ts:377` | **nuevo** `[H]` |
| `A2-M12-003` | S2 | Encender o apagar un módulo no deja auditoría en el tenant. | `src/platform/business-modules.routes.ts:21` | **nuevo** |
| `A2-M12-004` | S2 | `business_profile` acumula 25 columnas agregadas: config, fiscal y credenciales en la misma fila. | `grep -c "ALTER TABLE business_profile ADD COLUMN"` = 25 | **nuevo** |
| `A2-M12-005` | S3 | Sin configuración por sucursal. | `src/db/schema.sql:2762` | ⊃ `A2-T01-003` |
| `A2-M12-006` | S3 | Sin reversión de configuración. | ausencia de endpoint | **nuevo** |

## 15. Criterios de cierre

- Un cambio de moneda o huso avisa qué histórico afecta, o queda bloqueado con
  operación cargada.
- El saldo no suma monedas distintas, o está escrito por qué no puede pasar.
- El encendido y apagado de módulos deja rastro.

---

**Nota de método.** Este módulo tiene las dos mejores piezas de control del
repositorio: el destructuring explícito con test de conjunto exacto
(`src/platform/business-context.routes.ts:66`) y el candado `OWNER_ONLY` sobre el
perfil fiscal. Las dos son locales: nadie las generalizó. Buena parte de las
brechas de las otras quince fichas se cerrarían aplicando lo que este módulo ya
resolvió.
