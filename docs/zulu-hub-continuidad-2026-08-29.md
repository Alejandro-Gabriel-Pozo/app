# ZULU Hub — Continuidad operativa

- **Fecha de corte:** 2026-08-29, después del deploy de la Fase 3
- **Para qué:** que una sesión nueva sepa **dónde quedó el proyecto y qué sigue**, sin depender del historial conversacional
- **Etiquetas:** `mapa-del-sistema` `continuidad`

Este documento **no repite** las reglas del plan maestro ni el detalle de
`pendientes`. Responde dos preguntas y nada más: *¿dónde quedó?* y *¿cuál es
el próximo bloque?*

---

## 1. Estado de producción

| Repo | `origin/main` | En producción |
|---|---|---|
| `app-main` | `c6c4185` | Fase 3 sí, verificada contra la base. `c6c4185` (Fase 4 Bloque 1) no tiene efecto observable en runtime: no se pudo confirmar que el deploy entró |
| `appfrontend-main` | `515bc3f` | sí — Vercel, `host.zuluhub.com.ar` |

> **Sobre esta tabla:** hasta el 29/08 decía `67151fb`, que ya estaba
> desactualizado al escribirse — el commit siguiente (`dab960f`) fue
> justamente el que agregó este documento, y un doc no puede citar su propio
> hash. Al actualizarla, verificar contra `git rev-parse origin/main`, no
> contra lo que diga la fila anterior.
>
> `c6c4185` agrega `app-main/src/business-context/` — el resolver puro de la
> cascada, **sin cablear**: no toca `getBusinessModules()`, `requireModule()`
> ni ninguna ruta. Ver §4.

**Fase 3 confirmada en producción** (29/08, 17:5x UTC). Verificado
consultando la BD de plataforma, sin aplicar nada a mano:

```text
industries 1 (GENERIC) · industry_capabilities 6 · terminology SYSTEM 10
checks 4 · triggers 4 · modules 6 · business_modules 6
business_modules en PRESET: 0     businesses sin rubro: 1 de 1
```

Las 6 filas de `business_modules` tienen `created_at = updated_at`: el
trigger nunca disparó, así que ningún UPDATE tocó datos históricos.

**Respaldos durables vigentes y sin uso:**

| Proyecto | Branch | Id |
|---|---|---|
| Plataforma | `respaldo-pre-fase3-2026-08-29` | `br-purple-mud-aycvlyj4` |
| Tenants | `respaldo-pre-fase3-2026-08-29` | `br-twilight-poetry-axtplxx1` |

El branch de validación `prueba-fase3-2026-08-29`
(`br-polished-forest-ayhgmb7m`) se **eliminó** el 29/08 después de confirmar
producción. Cumplió su función —validar que `platform.schema.sql` aplica
entero— y había quedado mutado por las pruebas, así que no era un punto de
retorno.

---

## 2. Fases cerradas — no volver a planificarlas

**Corriente visual V2, completa y en producción.** Separación semántica de
tokens, inversión de polaridad, scope oscuro del sidebar, unificación de
toasts y scrims, recalibración de sombras, borrado de `styles.css`,
parser/guard visual y banco de primitives.

> La frase correcta es: **el token layer está reemplazado y verificado, pero
> las pantallas todavía no se reconstruyeron estructuralmente ni tienen
> conectado el color efectivo por módulo.**

**Backend:** Fases 0, 1, 2 y 3 desplegadas y verificadas — cerca eléctrica de
dependencias, sobre de eventos con idempotencia (`processed_events`, schema
v44), `platform_audit_log`, y el modelo de Business Context.

**V3 capa 1** (`515bc3f`): `BusinessContextProvider` con fuente reemplazable,
estados `loading`/`ready`/`error`, `industryKey: null` neutral, y estructura
responsive. `endpointSource()` **rechaza a propósito** mientras no exista el
endpoint.

---

## 3. Pendientes activos

El detalle está en [pendientes-2026-08-29.md](pendientes-2026-08-29.md). Acá
sólo la lista, para no duplicar:

| ID | Qué | Regla |
|---|---|---|
| `SEM-001` | 4 importes pintados con `--success` | Va **antes** del patrón de precios de V4/V6 |
| `SEM-002` | CAE de AFIP en verde (dato técnico) | Separado de SEM-001: llevan a soluciones distintas |
| `TOAST-003` | Tercer sistema de toast en `app/admin` | No asignarlo a V5(a): vive fuera de Superadmin |
| `A11Y-001` | Sin focus trap en `Modal` + 15 modales a mano | Va a **V7**. Todo componente nuevo de V3 nace accesible |
| — | 6 overlays blancos de Tailwind en Superadmin | V5(a) |
| — | Prueba E2E del Outbox | La corre el dueño; consultas en el runbook |
| — | 3 filas desactualizadas en `auditoria-dominios.md` | Cambio documental propio |

Más el backlog de producto (D8, D6, C1-A, C3, C2, Gap C1-C) y la deuda
técnica heredada, los dos en `pendientes-2026-08-29.md`.

---

## 4. Próximo bloque, único

**Fase 4 — `GET /api/business/context` (Bloque 2).** El resolver de la
cascada **ya está**: `c6c4185` agregó `src/business-context/` como funciones
puras, con 48 tests, sin cablear a nada. Lo que falta es el adaptador de
lectura contra las tablas reales y la ruta, montada **después** de
`tenantMiddleware` (necesita `req.db` para `currency`/`timezone` de
`business_profile`). Después, el frontend cambia `mockSource()` por la
fuente real **sin tocar pantallas**.

**El Bloque 2 no es un refactor de lectura.** Meter la cascada dentro de
`getBusinessModules()` cambia `requireModule()` y con eso el 402 de todas
las rutas con gate. Hoy sería inerte —el único negocio tiene `industry_key`
NULL, `min_plan` NULL y los 6 módulos `active`+`implemented`— pero deja de
serlo en cuanto una de esas precondiciones se caiga. Va con su propio diff y
pruebas sobre los gates, no arrastrado por el endpoint.

El contrato está cerrado: payload en §5.4 y consumo (los tres estados,
`permissionGroups`, `industryName`, `industryKey` NULL ≠ `GENERIC`) en §5.5
de [plan-separacion-dominios-multirubro-2026-08-28.md](plan-separacion-dominios-multirubro-2026-08-28.md).

No implementar la navegación con arrays estáticos ni con
`if (industry === …)`. El shell visual ya existe contra un mock fiel;
labels, módulos efectivos y colores dependen del contexto del backend.

---

## 5. Cómo trabajar acá

1. **Confirmar el estado real antes de actuar**: `git log`, `git status`,
   `git rev-parse origin/main`. No asumir que un commit autorizado se
   pusheó.
2. **Un bloque chico, reversible y verificable** por vez.
3. **Verificar contra la base o el runtime, no contra la pantalla ni contra
   "no se vio un error".** Los hallazgos importantes de esta corriente
   aparecieron midiendo; los conteos con grep produjeron falsos positivos
   **cuatro veces**, siempre por comentarios que se contaban a sí mismos.
4. **Después de cada commit, informar**: hash, si está local o pusheado, si
   llegó a producción, archivos, comandos de verificación y las limitaciones
   de lo que no se pudo verificar.
5. No decir *"sin deuda"* apoyándose sólo en el guard: un contador dice cero
   cuando no sabe mirar la forma en que el problema está escrito. Pasó con
   `rgba()`, con `bg-white/10` y con los bloques `DO $` — ver el runbook.

**Documento de dirección:**
[plan-multirubro-maestro-2026-08-29.md](plan-multirubro-maestro-2026-08-29.md),
con la tabla de conciliación contra lo implementado. Es visión de producto,
no orden de reimplementación: marcar cada sección como completa, parcial o
pendiente antes de ejecutar.
