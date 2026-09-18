import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '../..');

/**
 * CITY-LEDGER-REVERSE-ROUTE-GROUP-FREEZE-001 (17/09/2026, Wave 11 del plan
 * de ejecución integral, ADR `docs/diseno-reconciliacion-city-ledger-2026-09-12.md`
 * §3.7 (decisión) / §4.4 (mecanismo); gate `architecture-governor` en el
 * diseño, 17/09/2026).
 *
 * `POST /api/accounts-receivable/:id/reverse` es la ÚNICA ruta del repo con
 * dos `authorize(Roles.X)` encadenados (AND-composition, no jerarquía --
 * Express solo sigue a la siguiente función si la anterior llamó a
 * `next()`): exige `Roles.MANAGEMENT` **Y** `Roles.EMISOR_NOTA_CREDITO` a la
 * vez (decisión §3.7 -- cierra por construcción la asimetría RECEPTIONIST
 * que el ADR discute). Confirmado por grep exhaustivo de las 39
 * `*.routes.ts` (comentarios stripeados): 0 otras ocurrencias.
 *
 * Hoy solo UNA cerca protege esta ruta:
 * `rbac-matrix-sync.test.ts::EXPECTED_AUTHORIZE_CALL_SITES` -- un CONTEO
 * total de `authorize()` en todo el repo. Esa cerca ve que hay 2
 * `authorize()` en esta ruta, no CUÁLES grupos -- si alguien degrada
 * `Roles.EMISOR_NOTA_CREDITO` a otro grupo cualquiera manteniendo 2
 * llamadas, el conteo no se mueve y la cerca sigue verde. Ninguna otra
 * cerca RBAC del repo lo cubre: `rbac-route-coverage` solo exige "algún"
 * authz; `rbac-matrix-section2-sync` no valida el GRUPO de cada fila (y
 * `accounts-receivable.routes.ts` está en su propio `EXCLUDED_FILES` --
 * prosa, no bullets parseables).
 *
 * ## Por qué un archivo propio y NO `ESCAPE_ROUTES` de
 * `credit-note-escape-containment.test.ts` (CN-ESCAPE-CONTAINMENT-001)
 *
 * Decisión del gate `architecture-governor` (17/09/2026, diseño de esta
 * Wave): `credit-note-escape-containment.test.ts` está acotado, por su
 * propio docblock y por el ADR que lo origina
 * (`docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` §4), a UN
 * riesgo específico -- que el núcleo del escape con Nota de Crédito
 * (`cancelOrderWithCreditNote`/`cancelReservationWithCreditNote`) se filtre
 * a la cancelación normal. Sus otras cuatro aserciones (A deny-by-default,
 * B conteo de chokepoints, C.1/C.2 firma congelada) son TODAS específicas
 * de esa arquitectura interna y no aplican acá -- `reverseTransfer()` no
 * comparte código, chokepoint ni archivo de servicio con ese escape. El
 * propio repo ya escribió esta distinción antes: el docblock de
 * `facturacion/credit-note-requests.routes.ts` (`POST /:id/resolve`)
 * explica por qué esa ruta, que también necesita su grupo congelado, NO
 * entra en `ESCAPE_ROUTES` -- esa lista es una afirmación semántica sobre
 * rutas que DISPARAN el escape fiscal, no un helper genérico de "congelar
 * un grupo". Meter `reverseTransfer()` ahí contradiría una decisión que
 * este repo ya tomó y documentó.
 *
 *   (A) El grupo exacto exigido por la ruta es el CONJUNTO ORDENADO
 *       `['MANAGEMENT', 'EMISOR_NOTA_CREDITO']` -- ni uno de más, ni uno de
 *       menos, ni renombrado, ni reordenado. Mismo criterio que
 *       `roles-catalog-sync.test.ts` (conjunto ordenado, no un conteo -- un
 *       conteo no detecta un rename que preserva el tamaño). El ORDEN NO es
 *       semántico (`authorize()` es pertenencia a un conjunto, no
 *       jerarquía -- invertir los dos deja el mismo AND), pero se congela
 *       igual: el costo de un swap es un rojo ruidoso y trivial de
 *       corregir, y fuerza a que un humano lo mire antes de asumir que es
 *       inocuo.
 *
 *   (B) `authorizeAny(...)` NO aparece en la ventana de la ruta. Es la
 *       aserción de mayor valor de este archivo: `authorizeAny()`
 *       (`security/auth.middleware.ts`) existe justamente porque alguien
 *       puede confundir "dos `authorize()` encadenados" con OR -- su propio
 *       docblock documenta que una versión anterior del ADR común
 *       cancelar-con-NC daba por sentado, erróneamente, que encadenar era
 *       OR. "Simplificar" las dos llamadas de esta ruta a
 *       `authorizeAny([Roles.MANAGEMENT, Roles.EMISOR_NOTA_CREDITO])`
 *       reabriría en silencio la asimetría RECEPTIONIST que el ADR §3.7
 *       cerró por construcción -- ninguna otra cerca del repo lo detecta
 *       (el conteo de `authorize()` bajaría a 0 pero `EXPECTED_AUTHORIZE_CALL_SITES`
 *       solo cuenta `authorize(`, no `authorizeAny(` -- ver "SI ESTO ROMPE").
 *
 * ## SI ESTO ROMPE
 *  - (A) Cambió el conjunto/orden de grupos exigidos. Si el cambio es
 *    legítimo (el ADR §3.7 se revisó), actualizá `REQUIRED_GROUPS` en el
 *    mismo commit que actualiza el ADR, `docs/rbac-matriz-endpoints.md` y
 *    el docblock de permisos de `accounts-receivable.routes.ts:10-17`. Si
 *    no hay revisión de ADR de por medio: NO -- alguien degradó el
 *    permiso.
 *  - (B) Apareció `authorizeAny` en la ruta. Ver el párrafo de arriba --
 *    convierte el AND en OR. Revertí a los dos `authorize()` encadenados.
 *  - Anti-vacuidad: si `/:id/reverse` no aparece más en el archivo, o
 *    `router.post` no lo precede, la ruta se movió o se borró -- revisar
 *    si este archivo sigue siendo el que corresponde vigilar.
 *  - Si el mensaje dice "no encontré el handler ('async (req')" sin que la
 *    ruta se haya movido: `handlerRe` asume el parámetro se llama
 *    literalmente `req` (`async (req` sin guion bajo) -- un rename inocuo a
 *    `_req` (convención real de este repo para "no uso este parámetro", ver
 *    `api/routes/system.routes.ts:30`) también dispara esta falla, aunque no
 *    haya ningún cambio de permisos de por medio. Si eso pasa: el fix es
 *    ensanchar `handlerRe` (ej. `/async\s*\(\s*_?req/`), NO tocar la ruta.
 *    Nota registrada por el gate `architecture-governor` (pre-commit,
 *    17/09/2026) -- no implementada todavía porque ensanchar el regex es un
 *    cambio de lógica que exige repetir la batería completa de mutaciones;
 *    queda declarada acá para que el próximo que la vea no la confunda con
 *    una degradación de permiso real.
 *
 * ## FALSOS NEGATIVOS DECLARADOS (una cerca es una cerca, no un parser)
 *  1. Si algún día una ruta hermana ganara un `router.use(authorize(...))`
 *    de archivo que cubriera `/:id/reverse` por otro camino (hoy este
 *    archivo no tiene ninguno -- cada ruta lleva su propio `authorize`
 *    inline), esta cerca no lo vería.
 *  2. Matching de texto, no AST: un array de middlewares compuesto
 *    dinámicamente (`...someMiddlewareArray`) en vez de las dos llamadas
 *    literales sería invisible.
 *  3. Esta cerca congela la DECLARACIÓN (qué `authorize()` aparece en el
 *    código), no el EFECTO en runtime (que el actor realmente tenga los
 *    dos grupos) -- eso depende de `role_permission_groups` en la BD de
 *    plataforma, fuera del alcance de una cerca de texto.
 *  4. Si `Roles.EMISOR_NOTA_CREDITO` se renombra en `security/roles.ts`,
 *    este archivo también se pone rojo -- es la SEGUNDA cerca que hay que
 *    actualizar en ese caso (`roles-catalog-sync.test.ts` es la primera).
 *    Complementarias, no redundantes: esa cerca protege el catálogo
 *    completo contra `appfrontend-main`; esta protege esta ruta puntual
 *    contra una degradación de grupo o una conversión AND→OR.
 *  5. La ventana se acota desde el path literal hasta el primer
 *    `async (req` (el handler) -- a diferencia de la ventana de tamaño fijo
 *    de `credit-note-escape-containment.test.ts`, que podría "derramarse"
 *    a la ruta siguiente si la propia no tuviera 400 caracteres hasta su
 *    handler. Si algún día ese límite de handler no se encuentra, la
 *    aserción de anti-vacuidad de más abajo lo hace fallar ruidosamente en
 *    vez de matchear contra la ruta equivocada.
 */

const ROUTE_FILE = 'clientes-finanzas/accounts-receivable.routes.ts';
const PATH_LITERAL = "'/:id/reverse'";
const REQUIRED_GROUPS = ['MANAGEMENT', 'EMISOR_NOTA_CREDITO'];

/** Igual que las otras cercas de este directorio: comentarios de bloque y
 *  de línea fuera del matching -- si no, el propio docblock de arriba (que
 *  menciona `authorize(Roles.X)`/`authorizeAny(`) satisface los regex sin
 *  que el código lo haga. */
function stripComments(content: string): string {
  const withoutBlocks = content.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlocks
    .split('\n')
    .map((line) => line.split('//')[0])
    .join('\n');
}

describe('CITY-LEDGER-REVERSE-ROUTE-GROUP-FREEZE-001 -- POST /accounts-receivable/:id/reverse exige MANAGEMENT Y EMISOR_NOTA_CREDITO, no OR', () => {
  it('el AND-composition de authorize() está intacto: conjunto ordenado exacto, sin authorizeAny', () => {
    const code = stripComments(readFileSync(join(SRC_DIR, ROUTE_FILE), 'utf-8'));

    const pathAt = code.indexOf(PATH_LITERAL);
    expect(pathAt, `no encontré la ruta ${PATH_LITERAL} en ${ROUTE_FILE} -- ¿se movió o se borró?`).toBeGreaterThan(
      -1,
    );

    // router.post( precede al path literal -- anti-vacuidad: confirma que
    // seguimos mirando una ruta POST real, no un string suelto en un
    // comentario o docblock que stripComments no haya sacado.
    const beforePath = code.slice(Math.max(0, pathAt - 60), pathAt);
    expect(
      beforePath.includes('router.post('),
      `${PATH_LITERAL} en ${ROUTE_FILE} no está precedido por 'router.post(' -- ¿ancla movida?`,
    ).toBe(true);

    // Ventana acotada al handler, no a un tamaño fijo (C5 del gate): desde
    // el path literal hasta el primer 'async (req' -- ahí termina la
    // cadena de middlewares de esta ruta.
    const handlerRe = /async\s*\(req/;
    const afterPath = code.slice(pathAt);
    const handlerMatch = handlerRe.exec(afterPath);
    expect(
      handlerMatch,
      `no encontré el handler ('async (req') después de ${PATH_LITERAL} en ${ROUTE_FILE} -- la ruta cambió de forma.`,
    ).not.toBeNull();
    const window = afterPath.slice(0, handlerMatch!.index);

    // (B) authorizeAny NO aparece -- convertiría el AND en OR y reabriría
    // la asimetría RECEPTIONIST que el ADR §3.7 cerró por construcción.
    // Corre ANTES que (A) a propósito: si alguien reemplaza los dos
    // authorize() por un solo authorizeAny([...]), el regex de (A) no
    // matchea nada (foundGroups queda []) y el mensaje genérico de "conjunto
    // vacío" taparía el mensaje específico que nombra la trampa -- este
    // orden asegura que la mutación authorizeAny se reporte con SU propio
    // mensaje, no como un caso más de "grupo degradado".
    expect(
      window.includes('authorizeAny'),
      `${ROUTE_FILE}: la ruta ${PATH_LITERAL} usa authorizeAny(...) -- eso es OR, no AND. Reabre la asimetría RECEPTIONIST que el ADR §3.7 (docs/diseno-reconciliacion-city-ledger-2026-09-12.md) cerró por construcción. Revertí a los dos authorize() encadenados.`,
    ).toBe(false);

    // (A) Conjunto ORDENADO exacto de grupos -- ni de más, ni de menos, ni
    // renombrado, ni reordenado.
    const foundGroups = [...window.matchAll(/authorize\(Roles\.([A-Z_]+)\)/g)].map((m) => m[1]);
    expect(
      foundGroups,
      `${ROUTE_FILE}: la ruta ${PATH_LITERAL} exige ${JSON.stringify(foundGroups)}, se esperaba ${JSON.stringify(REQUIRED_GROUPS)}. Si es una revisión legítima del ADR §3.7, actualizá REQUIRED_GROUPS acá + docs/rbac-matriz-endpoints.md + el docblock de permisos del router, en el mismo commit. Si no, alguien degradó o reordenó el permiso.`,
    ).toEqual(REQUIRED_GROUPS);
  });
});
