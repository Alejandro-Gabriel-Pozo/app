# Pendientes — Sábado 29 de Agosto 2026

Arrastra lo que seguía abierto en `pendientes-2026-08-28.md`. Los ítems
cerrados de ayer quedan allá, no se repiten acá.

---

## 🔴 Abierto — encontrado hoy

### SEM-001 — `--success` se usa como "color de plata"

**Dónde:** `appfrontend-main`, 4 pantallas del dashboard.

Apareció en V2.6.4, buscando otras pantallas con el patrón de "precio propio
vs heredado". `--success` (hoy `--zulu-sage-strong`) significa **estado
positivo** en el sistema: `badge-active`, `badge-completed`, healthy,
housekeeping DONE. Pero también pinta importes, así que **un precio y un
badge "confirmado" comparten color** — y un precio no es un estado positivo.

Inventario completo de los 29 usos de `var(--success*)` en código activo,
clasificado (hecho con el escáner de V2.6.1, ignora comentarios):

| Clase | Cuántos | Qué son |
|---|---:|---|
| **Plata en verde, sin semántica** | **4** | `clientes/[id]:591`, `empresa:148`, `productos:614`, `variantes:251` |
| Balance con signo | 2 | `cuentas-corrientes:253`, `estadias/[id]:266` — usan `balance > 0 ? danger : success`. Eso **sí** es estado ("debe" vs "saldado"), no color de plata. Revisar, no necesariamente cambiar |
| Estado legítimo | 22 | badges, alerts, `btn-success`, `kpi-trend.up`, housekeeping, `RoomCalendar` |
| A decidir aparte | 1 | `FacturarButton:74` pinta de verde el **CAE de AFIP**. No es plata ni estado: es un dato técnico, y el sistema tiene grafito para eso |

**Lo que hay que hacer, en este orden:** decidir si existe un token de valor
monetario (o si los importes van simplemente en texto primario, que es lo que
V2.6.4 hizo para el precio efectivo de variantes), migrar los 4 como
conjunto, y recién ahí revisar los 2 de balance y el CAE.

**No reemplazar `success` por otro color a ciegas** — hay que separar importe,
estado y dato técnico primero. Y verificar en sesión autenticada: las 4
pantallas están detrás del login.

**Dependencia:** esto va **antes** de aplicar el patrón `Propio`/`Heredado`
en los recorridos de tarifas de V4/V6 — ese patrón necesita una semántica
monetaria limpia debajo. No bloquea V3.

### TOAST-003 — hay un tercer sistema de toast

**Dónde:** `appfrontend-main/src/app/admin/page.tsx:40-50`.

Apareció en V2.6.3, confirmando el rol de un `shadow-xl`. No es
`ToastContext` ni la clase `.toast`: es una tercera implementación inline,
con sus propios colores Tailwind oscuros (`bg-emerald-900/90`,
`bg-red-900/90`, `text-emerald-300`, `text-red-300`).

V2.6.2a había unificado dos sistemas de toast; éste no estaba en el
inventario porque no usa ni el contexto ni la clase. Sólo se le migró la
sombra en V2.6.3.

Qué falta: migrar los colores a tokens, unificar la estructura con
`.toast-stack` + `.toast`, cubrir los cuatro tipos, eliminar la tercera
implementación y verificar en runtime detrás del login.

**No asignado a V5(a) a propósito:** vive en `app/admin`, que no es
Superadmin. Es deuda del sistema de notificaciones; se decide después si
entra en V3 o en una fase de consolidación propia.

### A11Y-001 — el modal no tiene focus trap

**Dónde:** `appfrontend-main/src/components/Modal.tsx`.

No es una regresión: **nunca existió**. Salió al verificar V2.6.2b, cuando
el checklist pedía comprobar que el focus trap "siguiera funcionando" y
resultó que no había ninguno que preservar. El diálogo tiene `role="dialog"`,
`aria-modal="true"`, cierre con Escape y con click afuera, pero el foco se
escapa del modal con Tab.

Alcance real: `Modal` lo usan `ConfirmDialog` y varias pantallas, **más 15
modales escritos a mano** (`fixed inset-0 z-50 …`) que ni siquiera pasan por
el componente — esos tampoco tienen `role="dialog"`. Ver el backlog de
migración a ruta dedicada en `appfrontend-main/docs/auditoria-modales.md`.

Criterios de aceptación:

```text
al abrir, el foco entra en el diálogo
Tab no escapa del modal
Shift+Tab cicla correctamente
Escape cierra según el contrato del modal
al cerrar, el foco vuelve al elemento que lo abrió
role="dialog" y aria-modal="true"
```

**Va a V2.7**, la fase de accesibilidad. No se mezcla con las fases de color.

### ✅ V2.6.3 — la escala de sombras estaba calibrada para navy — RESUELTO

`--shadow-sm/md/lg` tenían alfas de 0.30 / 0.35 / 0.45. No era un descuido:
sobre navy, negro sobre casi-negro no se ve, y las tres medían 1.03-1.04 de
visibilidad. Al invertir la polaridad pasaron a 3.19 / 3.80 / 5.64 sobre
`#F5F4EF` — un factor de 3 a 5, sin que nadie tocara la escala.

Recalibradas a `.06/.04`, `.10/.06`, `.16/.08` (`0308c14`), misma geometría,
misma progresión relativa. Y se migraron los dos usos de Tailwind que
mantenían una escala paralela: `Modal.tsx` (`shadow-2xl`) y
`admin/page.tsx` (`shadow-xl`), los dos a `--shadow-lg` por rol.

### ✅ V2.6.4 — los 3 estados mal expresados — RESUELTO

Y **dos de los tres estaban mal clasificados** por la auditoría V1:
"métrica destacada" era un hipervínculo (→ `--zulu-link`), y "valor de
threshold" era el número de un slider que el usuario arrastra, sin
semántica de salud (→ énfasis tipográfico). El tercero, precio propio vs
heredado, sí era el caso de manual y pasó a etiqueta `Propio`/`Heredado`
con un solo color (`43f3aeb`).

El token puente `--zulu-status-emphasis` quedó sin consumidores y se
eliminó. De ahí salió **SEM-001**, arriba.

### 6 overlays blancos de Tailwind en Superadmin

`bg-white/[0.04]`, `border-white/[0.06]`, `divide-white/[0.04]` en
`app/superadmin/*`. Blanco translúcido sobre fondo claro no se ve. Están
contados con techo en `lint:visual` y **se saldan en V5(a)**, cuando
Superadmin se migre entero — hoy sigue con Tailwind crudo.

### `auditoria-dominios.md` tiene 3 filas desactualizadas

Detectado al verificar el deploy de V2.5. La auditoría es del 15/08 y decía
que `host.zuluhub.com.ar` estaba esperando propagación de DNS:

| Fila | Estado real (29/08) |
|---|---|
| `host.zuluhub.com.ar` | Propagado, responde 200. Es el dominio bueno. |
| `reservasapp-teal.vercel.app` | Devuelve 404 en `/`. Ya no es la URL de referencia. |
| `CORS_ORIGIN` | Ya apunta a `host.zuluhub.com.ar` (verificado con `curl`, el header vuelve con ese valor para cualquier Origin). |

Actualizar esas tres filas y la fecha de "última actualización". Cambio
documental, va en su propio commit.

---

## 🔴 Abierto — arrastrado del 28/08

### Prueba E2E del Outbox — la corre el dueño

Queda del despliegue de la Fase 1. Crear y confirmar una reserva de prueba
y verificar: un evento emitido, un mail, **una fila en `processed_events`
por cada handler registrado para ese tipo de evento**, una transacción
financiera, cero en dead-letter. Las consultas están en
`docs/conocimiento/runbook-deploy-render.md`.

### Backlog de producto (HALLAZGO 1 del 27/08, sigue vigente)

| Ítem | Qué falta | Tipo |
|---|---|---|
| **D8** | UI fiscal de producto (`ivaRate`/`unit`/`arcaUnitCode`) | UI pura |
| **D6** | Números de reserva/cliente + prefijos en listados | UI pura |
| **C1-Fase A** | CRUD de `deposit_policies` + rutas + pantalla | Backend nuevo + UI |
| **C3** | Líneas de factura no salen por `GET /api/invoices/:id` | Backend chico + UI |
| **Gap C1-C** | 2 queries con `JOIN financial_transactions` sin vista unificada | Backend puro |
| **C2** | "Cancelar reserva" no usa el preview/confirm de reembolso existente | UI pura |

### C1-A — decisiones y datos pendientes

Sin cambios respecto del 28/08: las 4 reglas de MAESTRO que
`deposit_policies` incumple (R3, R8, R1, R4), la lista real de tipos de
habitación de la Hostería (dato del dueño, no se infiere), y el guard de
`ModuleKey.CUENTAS_CORRIENTES` para que un negocio no se autobloquee al
configurar seña sin ese módulo. Detalle en
`diseno-sena-unidades-c1a-2026-08-27.md`.

### Deuda técnica activa

- **🟠 Rate plans no reutilizables entre servicios** — `rate_plans.service_id`
  NOT NULL con unique `(service_id, name)`. El molde de la solución existe
  (`rate_catalog`), falta aplicarlo.
- **`resource_locks` solo bloquea recursos concretos por ID**, no "uno
  cualquiera de la categoría X". Sin caso de uso activo todavía.

### Heredados, todavía abiertos

- **Deuda estructural:** Redis rate-limit, BullMQ, etapas 2–3 de
  reconciliación al bajar de plan.
- **C1-Fase B** — gateway de pago real. Bloqueada hasta que el negocio elija
  proveedor. **No elegir ninguna opción sin el dueño.**
- **D7** — pantalla de reportes POS/CRM, sin UI desde el 22/08.
- **RBAC — mecanismos 1 y 2** del handoff externo, sin empezar.
- **Operación:** datos de prueba (demo) en la base real.

---

## ✅ Resuelto hoy (29/08/2026) — corriente visual V2.5 → V2.6.2d

Nueve commits en `appfrontend-main`, todos en producción. El detalle está en
los mensajes de commit; acá queda lo que conviene recordar.

### V2.5 — inversión de polaridad (`4624f95`)

Primer cambio visible de la corriente. La base pasa de navy a blanco cálido,
con el sidebar en scope oscuro propio (`.zulu-shell-dark`).

**El hallazgo:** en la sesión autenticada, el ítem activo del nav medía
**2.56**. Usaba superficies `*-soft` claras dentro del sidebar negro.
Corregido a **4.69** con variantes oscuras. El banco de primitives no podía
verlo porque el nav se estiliza inline en `layout.tsx`, no con una clase.

### Hotfix del toast (`9ce9338`)

`.toast.error` pasó de 7.01 a **2.57** con la inversión: fondo oscuro
traslúcido compuesto sobre una página que ahora es clara. Se resolvió con
relleno **opaco**, que es lo que elimina la dependencia del fondo. Mismo
defecto que el nav: una isla oscura que sobrevivió a la inversión.

### V2.6.1 — el instrumental (`7fb3d4e`)

La fase más importante de la corriente. **El guard mentía en las dos
direcciones:** matcheaba sus propios comentarios (falso positivo) y decía
"0 hex crudos" cuando había 21 colores escritos como `rgba()` que ninguna
regla miraba (falso negativo). El cian neón sobrevivió a V2.2, V2.3, V2.4 y
V2.5 dentro de un `drop-shadow(... rgba(0,224,255,0.24))`, y se descubrió
recién midiendo el CSS servido **en producción**.

Ahora las reglas de color pasan por un escáner que separa código activo de
comentarios y strings (`scripts/lib/`), con **31 pruebas** en el runner
nativo de Node. La regla que expresa es la que faltaba: *un color literal
sólo puede aparecer declarando una custom property; toda regla que consume
color pasa por `var(--token)`*.

El banco también mentía: decía cubrir ocho consumidores del rojo, renderizaba
cinco, y **uno de los ocho no existe** (no hay regla de "input inválido" en
el CSS). Se reconstruyó contra el CSS real: 10 selectores, los 10 renderizados.

**Lección para futuras fases:** "lint sin deuda" no significaba que no
hubiera deuda; significaba que el guard no la podía ver. Antes de confiar en
un contador, comprobar que mira la forma en que el problema está escrito.

### V2.6.2a–d — saldar la deuda que el guard destapó

- **a** (`f0f6007`): había **dos sistemas de toast** con colores distintos
  para el mismo rol. El global (`ToastContext`, 39 pantallas) pintaba con
  Tailwind crudo por debajo de AA. Unificados en `.toast-stack` + `.toast`.
  De paso: `animate-slide-in` **nunca existió** — estaba definida sólo en
  `styles.css`, que no importa nadie, así que el toast jamás se animó.
- **b** (`2a3de19`): **17 scrims** con dos valores distintos (no seis, como
  yo había dicho contando archivos) unificados en `--zulu-scrim`. Y la regla
  de overlays blancos resultó **igual de ciega**: sólo miraba
  `rgba(255,255,255,…)` y no la forma Tailwind `bg-white/10`, con 24 casos
  sin ver. Uno era un hover invisible en el botón de cerrar del modal.
- **c** (`a378fee`): cero colores crudos en pantallas. Y **`.response-block`
  estaba en 1.36** — ilegible en `/admin` y en Reportes cada vez que una
  llamada respondía bien. Era la peor de las tres islas oscuras porque sus
  dos pantallas están detrás del login y el banco no podía mostrarla.
- **glows** (`11fbc2d`): decisión del dueño. El halo del isotipo se conserva
  como `--zulu-brand-glow` (excepción de marca, con nombre para que no
  vuelva a parecer residuo); el del botón primario se elimina.
- **d** (`371d9c5`): borrado `styles.css`, un sistema de diseño oscuro
  completo y paralelo que **no importaba nadie**. La prueba no fue "no tiene
  imports" sino que el CSS generado por `next build` quedó **idéntico byte a
  byte** antes y después.

**Estado del guard al cerrar:** 7 de 8 reglas en 0. La única con techo son
los 6 overlays blancos de Superadmin, que van a V5(a).

### Nota de método

Seis de los hallazgos de esta corriente sólo aparecieron **midiendo en
runtime**, no leyendo el diff — y dos fueron errores de mi propio método de
medición (leer un `rgba` como si fuera opaco; medir un elemento con el
puntero encima y quedarme con el valor del `:hover`). El banco de primitives
y la sesión autenticada son complementarios: el banco prueba las piezas, la
sesión prueba la composición, y hay bugs que sólo aparecen en uno de los dos.

---

## Corriente visual — dónde quedó

```text
✅ V1     auditoría
✅ V2.1   split semántico          ✅ V2.2  overlays
✅ V2.3   hex y fallbacks          ✅ V2.4  alias y Bastión
✅ V2.5   inversión de polaridad   ✅ V2.6.1 instrumental
✅ V2.6.2 a/b/c/d + glows
✅ V2.6.3 recalibración de sombras   ✅ V2.6.4 los 3 estados mal expresados
🔜 V3     reconstrucción del shell   — espera Fase 4 (BusinessContext)
🔜 V4     contexto de módulo (brass/clay)  — depende de SEM-001 para tarifas
🔜 V5(a)  migración visual de Superadmin — espera Fase 5
🔜 V7     responsive y accesibilidad (A11Y-001 entra acá)
```

**V2 está cerrada.** El token layer está reemplazado, la polaridad
invertida, el instrumental es confiable y la deuda que destapó está saldada
salvo lo que quedó asignado a fases posteriores.

Las tres deudas nuevas del día — **SEM-001**, **TOAST-003** y **A11Y-001** —
no tienen fase todavía y no deberían tenerla por inercia: cada una se decide
cuando se la encare. Lo que sí está fijado es que **SEM-001 va antes que los
recorridos de tarifas de V4/V6**.

Nota de numeración: A11Y-001 va a **V7**, no a un "V2.7". El plan (§16 del
documento de separación de dominios) ya define V7 como responsive y
accesibilidad con entregable propio; no hacen falta dos numeraciones para
lo mismo.

---

## Backend — dónde quedó

Fases 0, 1 y 2 desplegadas y verificadas (schema v44, `platform_audit_log`).
**La Fase 3 no empezó:** modelo de `BusinessContext`, preset `GENERIC`, y los
endpoints de cambio de rubro con preview. Las siete decisiones del dueño
están cerradas y registradas en
`plan-separacion-dominios-multirubro-2026-08-28.md` §14.
