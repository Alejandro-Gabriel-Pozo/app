# I11 — Vulnerabilidades npm en @arcasdk/pdf (extract-zip / puppeteer)

> **✅ RESUELTO (24/08/2026, `pendientes-2026-08-24.md`).** Este documento
> es la investigación/plan original (movido acá desde una carpeta externa
> del dueño el mismo día que se implementó). El plan de abajo estaba
> incompleto en un punto clave — no contemplaba que el fix real también
> exige subir Node de 20 a 22+ (`@puppeteer/browsers` recién saca
> `extract-zip` en su versión 3.0.2, que sube el mínimo de Node a
> `>=22.12.0`, sin excepción). Ver `pendientes-2026-08-24.md` para el
> detalle completo de lo implementado y verificado. El paso 4 de abajo
> (PR upstream a `ralcorta/arcasdk`) queda sin hacer a propósito — es una
> acción pública sobre un repo de terceros, pendiente de confirmar aparte.

## Contexto del problema

`app-main` depende de `@arcasdk/pdf` (`^0.2.0`) para generar los PDF de factura con CAE/QR — `@arcasdk` es el SDK que habla con ARCA (ex-AFIP) para timbrar los comprobantes, no es un generador de PDF genérico.

Ese paquete usa `puppeteer@24.43.1` internamente, que a su vez depende de `extract-zip` — con 5 CVEs reportadas. `npm audit` no ofrece fix automático porque el bump directo rompe algo que hoy funciona (generación de PDF de facturas reales).

## Por qué no es tan urgente como para tocar a las apuradas

- La superficie de ataque real de `extract-zip` es el momento de *instalar* dependencias (descarga el binario de Chrome desde el CDN de Google), no cada factura generada en producción. No es input de usuario, así que no es algo que un atacante dispare por HTTP contra la app.
- Forzar el bump sin verificar bien podía romper la generación de PDF con CAE/QR — plata real, documentos fiscales.
- Por eso la decisión fue: no mitigación parcial bajo presión, ir directo a la solución de fondo, ahora que hay tiempo disponible.

## Hallazgo clave: `@arcasdk` es open source y activo

Repo: `github.com/ralcorta/arcasdk` — MIT, 158 stars, **25 pull requests abiertos** al momento de revisar. No es un paquete abandonado esperando que un tercero lo actualice — es un proyecto vivo donde se puede mandar el fix directamente.

**Y el fix es más simple de lo que parecía:** Puppeteer 25 no solo pasó a ESM — directamente **eliminó `extract-zip` del código** (reemplazado por `tar`/`unzip` del sistema operativo). Bumpear a puppeteer 25 no es "cambiar de riesgo", es la solución real y definitiva.

**El obstáculo puntual:** el código compilado de `@arcasdk/pdf` (`invoice-pdf-generator.js`) hace `require("puppeteer")` clásico (CommonJS). Puppeteer 25 es ESM puro, así que ese `require()` rompe con `ERR_REQUIRE_ESM`. El cambio necesario es acotado, no una reescritura.

## Plan de acción

1. **Localizar el código fuente real** (no el compilado en `node_modules`): forkear `github.com/ralcorta/arcasdk`, entrar a `packages/pdf`, encontrar el archivo fuente equivalente a `invoice-pdf-generator.js` (probablemente `.ts` en `src/`) y el `require("puppeteer")` exacto.

2. **Aplicar el cambio:**
   - Reemplazar `const puppeteer = require("puppeteer")` por un `import()` dinámico (`const puppeteer = await import("puppeteer")`, ajustando la función contenedora a `async` si no lo es ya).
   - Bumpear `puppeteer` a `^25.8.0` en el `package.json` de `packages/pdf`.

3. **Verificar antes de proponer nada:**
   - Correr los tests del paquete si los tiene.
   - Generar un PDF de prueba real (no mockeado) con datos de factura de ejemplo y confirmar que sale bien formado — este es el paso que más importa, porque el bug original de I11 nunca se detectó por tests porque todo estaba mockeado.

4. **Mandar el PR** al repo de `ralcorta/arcasdk` con el cambio + una descripción clara del motivo (elimina la dependencia transitiva de `extract-zip`, resuelve las 5 CVEs reportadas). **Sin hacer todavía** — acción pública sobre un repo de terceros, no se hizo sin confirmarlo aparte.

5. **Mientras se mergea (o si tarda):** aplicar el mismo cambio localmente en `app-main` con `patch-package` sobre `node_modules/@arcasdk/pdf`, para no depender del timeline del mantenedor. Documentar el patch en el propio repo (motivo + qué hace) para no perderlo si se reinstalan dependencias. **Hecho** — ver `patches/@arcasdk+pdf+0.2.0.patch`.

6. **Al cerrar:** actualizar `docs/pendientes-2026-08-23.md`, sección I11, marcando la resolución real (no solo "riesgo aceptado") y quitando el bloqueo. **Hecho en `pendientes-2026-08-24.md`** (el archivo del día real en que se implementó).
