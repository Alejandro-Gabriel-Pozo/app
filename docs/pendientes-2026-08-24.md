# Pendientes — Lunes 24 de Agosto 2026

Arranca a partir de `pendientes-2026-08-23.md`. **Nota de corrección**: gran
parte de esa sesión (F1-Pieza 2/3, C1-Fase C recorte confirmado) se hizo en
la práctica hoy 24/08/2026, pero quedó fechada "23/08/2026" dentro del
archivo y en los comentarios de código que dejó — la sesión venía de
continuidad directa del día anterior y no se cortó el archivo a tiempo. No
se corrige retroactivamente (es solo texto narrativo, no afecta nada
funcional) — de acá en adelante se abre este archivo nuevo con la fecha
real, siguiendo el patrón "un doc por sesión/día" de siempre.

Al cierre de `pendientes-2026-08-23.md`: **F1 completa (las 4 piezas)** y
**C1-Fase C (recorte BillingPolicy + consolidada + "Facturar ahora")
resueltos**. Detalle completo de ambos ahí, no se repite acá.

---

## Pendientes heredados de `pendientes-2026-08-23.md`, todavía abiertos

- **C1-Fase B** — gateway de pago real, hold corto canal web, auto-release.
  Bloqueada hasta que el negocio elija un proveedor de pago (proyecto
  externo). No elegir ninguna opción sin el dueño.
- **Backlog de UI, backend-only sin pantalla:** configurar/cobrar seña
  desde la ficha de reserva (C1-Fase A); preview/confirmar reembolso al
  cancelar (C2); líneas reales de factura en el detalle (C3); número de
  reserva/cliente en listados + prefijo editable (D6); pantalla de
  reportes POS/CRM (D7); carga de IVA/unidad/código ARCA al crear producto
  (D8); verificación server-side de precio para productos en POS
  (D9-Parte 2).
- **I3** — `audit_log.changed_by` sigue sin poder resolverse a un nombre
  (identities vive en la BD de plataforma, audit_log en la del tenant).
- **I7** — cobertura de rutas mala: 15 de 17 archivos medidos en 0%, 14 ni
  se miden (excluidos de `vitest.config.ts`).
- **I8** — mensaje de error obsoleto en `users.routes.ts:135,151` ("no
  existe flujo de invitación automático" — sí existe desde D2).
- **I9** — falta auditar documentos (facturas, notas de crédito) — solo se
  resolvió la mitad (campos propios de Cliente).
- **F2** — research amplio contra normativa nacional para ABM de usuarios,
  nadie lo pidió puntualmente todavía.
- **L** — reconciliar roles/asientos al bajar de plan (downgrade, sigue
  laxo) + link muerto de `UpgradePrompt` → `/settings/billing` (no existe
  self-serve billing).
- **Gap conocido de C1-Fase C:** una factura consolidada (`invoices.
  financial_transaction_id = null`) no aparece en `getByReservationId()`
  (nota de crédito, C2) ni en `getOutstandingByCustomerId()` (conciliación
  de pagos, I4) — ambas hacen `JOIN` directo contra esa columna. Aceptado
  a propósito para el recorte de hoy, revisar si hace falta más adelante.

---

## I11 — ✅ RESUELTO DE FONDO (24/08/2026)

Encontrado durante la investigación externa (`i11-arcasdk-pdf-puppeteer.md`,
movido a `docs/`) un hallazgo real que ese documento no contemplaba: el fix
no es solo cambiar el `require()` de `puppeteer` en `@arcasdk/pdf` — el
paquete `@puppeteer/browsers` recién elimina `extract-zip` en su versión
`3.0.2`, y esa misma versión (y toda la serie 3.x/25.x de puppeteer) sube
el requisito mínimo a **Node ≥22.12.0**. No existe combinación que saque
`extract-zip` y siga soportando Node 20. Confirmado con el dueño
(`AskUserQuestion`): encarar el fix completo, no solo el parche del
`require()`.

**Implementado:**
- `package.json` — `engines.node` de `"20.x"` a `">=22.12.0"`; `overrides.
  puppeteer` fuerza `^25.8.0` en toda la resolución de dependencias
  (incluida la que declara `@arcasdk/pdf` internamente, `^24.43.1`).
- `render.yaml` — `NODE_VERSION` de `"20"` a `"22"`. `.puppeteerrc.cjs` y
  el paso explícito `npx puppeteer browsers install chrome` del
  `buildCommand` no necesitaron cambios (siguen funcionando igual con
  puppeteer 25).
- `patches/@arcasdk+pdf+0.2.0.patch` — sumado el fix real: en
  `invoice-pdf-generator.js`, el `require("puppeteer")` de nivel de módulo
  (rompe con `ERR_REQUIRE_ESM` contra puppeteer 25, que es ESM puro sin
  entrada `require()`) se reemplaza por `import()` dinámico dentro de
  `_generateSingle()` — no depende de la interop `require(esm)` de Node
  (variable según versión exacta de Node 22.x/23.x), es la solución
  explícita y robusta. El patch existente (args `--no-sandbox` para
  contenedores + el bloque HTML de Transparencia Fiscal) se conserva
  intacto, solo se sumó el cambio nuevo.
- **Verificado de punta a punta, no mockeado** (la razón por la que el bug
  original de I11 nunca se detectó): script standalone que instancia
  `InvoicePdfGenerator` directo y genera un PDF real con datos de factura
  de ejemplo — salió un PDF válido (`%PDF-1.4`, 1 página, verificado con
  `pdf-lib`). Script borrado después de confirmar.
- `npm audit` — **0 vulnerabilidades** (eran 5). Suite completa de
  `app-main` verde (1017 tests), `tsc --noEmit` limpio.

**Fuera de este alcance, anotado para después:** el paso 4 del documento
original (forkear `ralcorta/arcasdk`, mandar el PR upstream con el mismo
fix) — es una acción pública sobre un repo de terceros, no se hizo sin
confirmarlo aparte con el dueño. El patch local vía `patch-package` ya
resuelve el problema real en este repo mientras tanto; el PR upstream es
opcional, para que el próximo `npm install` de otro proyecto que use
`@arcasdk/pdf` no necesite este mismo patch.

**Pendiente de verificar:** correr el build real de Render (o al menos
`npm run build` local) con Node 22 antes de deployar — no se probó el
pipeline de deploy completo, solo el fix puntual en este entorno.

---

## Rediseño visual ZULU (contenido externo) y housekeeping — 24/08/2026

El dueño trajo una carpeta externa (`ZULU-frontend-actualizado/`, fuera de
este repo) con una pasada de pulido visual hecha por otra sesión —
isotipo/logo nuevo (`ZuluBrand.tsx`), retintado de `/admin` + `ApiBlock` +
pantallas de acceso, tokens navy/cian más refinados. Basada en una copia
de `appfrontend-main` de más temprano en el día, **anterior** al trabajo
de F1-Pieza 2/3 y C1-Fase C de hoy — una copia completa hubiera borrado
todo eso. En progreso: traer solo lo nuevo (`ZuluBrand.tsx` + las pantallas
de marca) sobre el estado actual del repo, sin pisar nada.

`housekeeping-ventana-mantenimiento.md` (también en esa carpeta, movido a
`docs/`) — diseño para reemplazar el flag `OUT_OF_SERVICE` por una entidad
`maintenance_window` (inicio/fin, bloqueo por horizonte configurable,
reasignación automática vía `findAvailableResourceInCategory()`). Sin
implementar todavía — el dueño eligió encarar I11 primero.
