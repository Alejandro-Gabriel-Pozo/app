# Pendientes — Martes 1 de Septiembre 2026

Arrastra lo que seguía abierto en `pendientes-2026-08-31.md`. Los ítems
cerrados quedan allá marcados, no se repiten acá.

**Arrastre re-chequeado** según la regla de `CLAUDE.md` ("Pendientes —
revalidar antes de arrastrar"): las anclas de los ítems que cambiaron de
estado hoy se verificaron contra el código; las del resto se conservan sin
re-verificar y se declara así.

---

## Contexto de sesión (01/09/2026)

Sesión larga. Lo que se movió, en commits:

| Commit | Qué |
|---|---|
| `c776b9a` | separar liveness de readiness (`/health` vs `/health/db`) — del dueño |
| `0170ee5` | no montar `/docs`, `/openapi.json` ni `/` en producción — del dueño |
| `df9cf08` | encabezado de la §2 de la matriz RBAC, 198/35 → 204/37 |
| `ef6afcc` | **D6-backend**: los dos prefijos en el payload de `business/context` |

Y dos documentos de diseño, los dos en **HOLD**:
`diseno-factura-borrador-2026-08-31.md` (v2.8) y
`diseno-fiscal-profile-resolver-2026-09-01.md` (nuevo, se versiona con este
commit).

> **Nota agregada 02/09/2026, registro histórico sin editar arriba:** el HOLD de
> `diseno-fiscal-profile-resolver-2026-09-01.md` se dividió más tarde el mismo
> 01/09 en HOLD de diseño (levantado) y HOLD de implementación (vigente) — ver
> `indice-conocimiento.md` para el estado actual, no esta línea.
> `diseno-factura-borrador-2026-08-31.md` es un documento distinto, no tocado
> por ese cambio, y sigue en HOLD sin matices nuevos.

---

## 🔴 Abierto — encontrado hoy (01/09/2026)

### D6-FRONTEND-001 — backend hecho y pusheado; falta el frontend — ✅ RESUELTO (02/09/2026)

**Cerrado.** Verificado hoy contra `appfrontend-main` (`HEAD` = `origin/main` = `e36d24f`):
mirror de tipo en `src/lib/business-context/types.ts:93-94`, type-guard en
`src/lib/business-context/sources.ts:177-178`, helper único en
`src/lib/business-context/numero-operativo.ts` (commits `5cae5b3`, `472d5f2`),
usado en las tres pantallas requeridas —
`dashboard/reservas/page.tsx`, `dashboard/clientes/page.tsx`,
`dashboard/cuentas-corrientes/page.tsx` — más `dashboard/page.tsx` y
`dashboard/turnos/page.tsx` de más. Sin divergencia entre pantallas.

**Estado original (01/09/2026), registro histórico — superado por el cierre de arriba:** backend en `ef6afcc`, ya en `origin/main`. **Frontend sin empezar.**

**D6 NO era "UI pura", y las tres revisiones que lo dijeron se equivocaron.**
`GET /api/business-profile` exige `MANAGEMENT`
(`business-profile.routes.ts:39`), pero el preset **`RECEPTIONIST` no tiene
`MANAGEMENT`** — solo `STAFF`, `FRONT_DESK`, `BOOKING`
(`platform.schema.sql:307`). O sea que un recepcionista ve el listado de
reservas (`FRONT_DESK`, `reservations.routes.ts:226`) y recibía **403** al
pedir el prefijo.

**Cómo se resolvió:** extender el payload de `GET /api/business/context`, que
ya es `STAFF` y ya leía `business_profile` para `currency`/`timezone`
(`business-context.routes.ts:63`). **Cero rutas nuevas, cero call-sites, cero
cambios de RBAC** — las cercas siguen en 204/37.

**Lo que falta, en su propio bloque:**

1. Espejo del tipo en `appfrontend-main/src/lib/business-context/types.ts`.
2. `isBusinessContext()` (`sources.ts:149`) — el type-guard.
3. Helper de formato **único** (`RES-000123` / `CLI-000045`, prefijo + 6
   dígitos), aplicado a **las TRES** pantallas: `dashboard/reservas`,
   `dashboard/clientes` y `dashboard/cuentas-corrientes` (`page.tsx:51`, hoy
   muestra `#123` crudo). Si se hacen dos y se deja la tercera, se produce la
   divergencia que el ítem existe para evitar.

> ⚠️ **Orden de deploy obligatorio: backend primero.** El type-guard rechaza
> con `Error` si recibe una forma que no espera, y el provider lo mapea a
> `status: 'error'` — el shell del dashboard perdería nav por módulo, colores
> y terminología. Desplegar el frontend antes que el backend rompe más de lo
> que arregla.

**Deuda de proceso de este ítem:** `ef6afcc` **no tuvo revisión independiente**.
El `architecture-governor` se quedó sin límite de uso en el punto 8 de 9;
alcanzó a confirmar el punto 6 y no entregó informe. Lo verificado es de
primera mano y no independiente: 11 tests del contrato en verde, la
demostración de que el test de conjunto exacto **falla** al inyectar una clave,
cercas RBAC 204/37, `tsc` exit 0 y suite completa exit 0.

### FISCAL-CBTE-001 — el tipo de comprobante no se resuelve, está fijo

**Documento:** `docs/diseno-fiscal-profile-resolver-2026-09-01.md` (análisis y
diseño, **HOLD**). El detalle está allá.

**Redacción neutral, a propósito.** Lo verificable en el código: `cbteTipo`
está **fijo** en `CBTE_TIPO_FACTURA_B` en los dos caminos de emisión
(`invoice.service.ts:368`, `:466`); `condicionIvaReceptorId` se captura, se
manda a AFIP y **no participa** de esa elección; no existe lógica de selección
A/B/C; y la nota de crédito hereda la limitación (`NOTA_CREDITO_B` es la
única).

> **La configuración actual puede emitir un tipo de comprobante que no coincida
> con la situación fiscal del receptor. El impacto tributario y la combinación
> correcta deben ser confirmados por un profesional y/o por la normativa
> aplicable.** No se registra acá ninguna conclusión tributaria.

**Dato del dueño (01/09):** sí se va a facturar a empresas Responsables
Inscriptos.

**Tres bloqueos, ninguno de código:** no hay lógica de selección A/B/C;
`customer_tax_profiles.tax_condition` es texto libre sin mapeo a los ids de
ARCA; y el catálogo de condición de receptor **no se puede consultar sin
certificado de producción** — aunque el método ya existe
(`padron.service.ts:137`).

**Hallazgo relacionado, mismo documento:** el comprobante congela **solo**
`emisorCuit`. El PDF lee en vivo razón social, condición fiscal y domicilio del
emisor, y la razón social del receptor (`invoice-pdf.service.ts:79-105`).
Reimprimir un comprobante viejo lo muestra con los datos de hoy.

### DOC-ANCLA-001 — cita rota en la matriz RBAC, sin corregir a propósito

`docs/rbac-matriz-endpoints.md` cita el test de la cerca bajo el directorio
**`governance/`**, que no existe: el archivo vive en
`src/tests/security/rbac-matrix-sync.test.ts`. **Preexistente.**

Se dejó sin tocar para no exceder el alcance de `df9cf08`, que era corregir
únicamente el encabezado 198/35.

*(La ruta equivocada no se transcribe entera acá a propósito: el preflight la
resolvería como referencia viva y marcaría este archivo como roto. Documentar
un ancla rota sin romper el propio validador exige escribirla así — es un
límite del validador, no del hallazgo.)*

Es la **segunda** ruta mal citada que aparece en documentos que se leen cada
sesión — la primera fue el hook en `CLAUDE.md`, corregida el 01/09. Las dos las
encontró el preflight, no una lectura.

**Espera decisión:** corregirla en su propio commit documental.

---

## 🔄 Actualizados hoy — el estado cambió

### RBAC-SYNC-001 — la mitad visible se corrigió

El encabezado de la §2 pasó a `(204 call-sites, 37 archivos)` en `df9cf08`,
verificado por ejecución de la cerca.

**La otra mitad sigue abierta:** nada verifica la sección 4 de la matriz contra
el `PUBLIC_ROUTES` del test. Ese cruce se mantiene a ojo.

### RBAC-MOUNT-001 — una pregunta abierta quedó cerrada con evidencia

El ítem decía que `/health`, `/openapi.json` y `/docs` *"probablemente
respondan"* contra el origin del backend, marcado **no probado**.

**Probado el 01/09** contra `https://app-chny.onrender.com`, después del deploy
de `0170ee5`:

| Endpoint | HTTP |
|---|---|
| `/health` | 200 — liveness, sin tocar la base |
| `/health/db` | 200 — readiness, con caché verificado en producción |
| `/docs` | **404** |
| `/openapi.json` | **404** |

O sea que **ya no están expuestos**. Lo que sigue abierto del ítem es lo otro:
ninguna cerca valida el orden de montaje de `src/app.ts`.

### D6 — reemplazado por D6-FRONTEND-001

La línea del 31/08 decía *"UI pura, confirmado, listo para empezar"* y citaba
`criterios-datos.md:26` como criterio resuelto. **Las dos cosas estaban mal**:
no era UI pura (ver arriba), y esa cita ya había sido retirada en la §3 del
documento de implicancias por no sostener el argumento.

---

## 🔴 Abierto — arrastrado del 31/08

Detalle completo en `pendientes-2026-08-31.md`. **Anclas no re-verificadas hoy**
salvo donde se indica.

- **CONTRACT-001** — el OpenAPI no lo verifica nada; 5 recursos sin documentar
  y 2 rutas documentadas que dan 404.
- **FACT-BORRADOR-001** — diseño de factura como borrador editable, v2.8, en
  HOLD. 6 decisiones del dueño abiertas (§26.3) y 4 correcciones del propio
  documento (§26.1).
- **SEC-ROT-001** — `DB_ENCRYPTION_KEY` sin procedimiento de rotación.
- **RBAC-OWN-001** — ownership dentro de un tenant sin guard ni test negativo.
- **Gap C1-C** — ⚠️ **bug de plata**, no refactor: saldo del cliente
  subdeclarado y reembolso sin nota de crédito. Sin exposición hoy porque no
  hay facturación real.
- **C3** — líneas de factura: falta backend **y** pantalla de detalle.
- **C1-Fase A** — CRUD de `deposit_policies`. Backend inexistente, **3
  decisiones del dueño** abiertas.
- **D7** — reportes POS/CRM: 2 paneles CRM libres, 3 POS condicionados a
  `useModuloVisible('POS_RESTAURANTE')`.
- **C2** — "Cancelar reserva" no usa el preview/confirm de reembolso.
- **Frontend visual:** SEM-001, SEM-002, TOAST-003, A11Y-001, 6 overlays de
  Superadmin. Los cinco verificados al número de línea el 01/09.
- **Backend/infra:** prueba E2E del Outbox (la corre el dueño), FAILOPEN-001.
- **Deuda activa:** rate plans no reutilizables entre servicios (la unicidad
  `(service_id, name)` **ya se resolvió** el 28/08; lo abierto es
  `service_id NOT NULL`), `resource_locks` sin categoría.
- **Heredados:** Redis rate-limit, BullMQ, etapas 2-3 de downgrade, C1-Fase B
  (bloqueada hasta que el negocio elija proveedor), datos demo en la base real.
- **RBAC — mecanismos 1 y 2** — ⚠️ **fila sin referente**, requiere la memoria
  del dueño o se borra.

---

## Lección de hoy — verificar accesibilidad, no solo existencia

D6 pasó por **tres** revisiones independientes que lo declararon "UI pura, sin
decisiones pendientes". Las tres verificaron que el backend **expusiera** los
campos. **Ninguna verificó quién podía leerlos.**

El bloqueo apareció recién al implementar, y era estructural: el endpoint que
tiene el dato exige un grupo de permisos que el usuario de esa pantalla no
tiene.

Quedó como **regla 5** en `CLAUDE.md`.
