import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '../..');

/**
 * CN-ESCAPE-CONTAINMENT-001 (08/09/2026, ADR común cancelar-con-NC
 * `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` §4
 * "Contención", capa (iv); bloque 1.2 del
 * `docs/plan-cierre-cancelacion-nc-y-deuda-estructural-2026-09-08.md`).
 *
 * El riesgo concreto (marcado por el dueño, ADR §4): alguien agrega
 * `skipInvoiceGuard?: boolean` a `cancelOrder()` / `cancelReservation()` para
 * no duplicar código, o un `if (esEscape)` dentro de
 * `findBlockingInvoiceLinkage()`, y la puerta normal fail-closed queda abierta
 * con un flag. El ADR levanta cuatro capas; ésta es la (iv), la única —junto
 * con la (i), rutas/permisos separados— que impide el code path de forma
 * estructural en vez de por convención de revisor (capa ii) o por señal al
 * que escribe (token branded, capa iii).
 *
 * Igual que `lock-order.test.ts` / `rbac-matrix-sync.test.ts`: NO es un
 * parser. Son cercas eléctricas sobre texto, cada una con sus falsos
 * negativos declarados abajo.
 *
 *   (A) DENY-BY-DEFAULT. Ningún archivo de `src/pos-menu/` o `src/reservas/`
 *       importa el módulo del núcleo del escape
 *       (`facturacion/cancel-order-with-credit-note.service.ts` — el
 *       orquestador — y `facturacion/cancel-with-credit-note.ts` — doctrina
 *       fiscal + token de autz) salvo los que figuran en
 *       `NUCLEO_IMPORT_ALLOWLIST` con motivo. `.dependency-cruiser.cjs`
 *       prohíbe `reservas ↔ pos-menu` pero NO `facturacion → pos-menu` (hay
 *       ~16 imports legítimos en esa dirección), así que sin esta cerca nada
 *       impide que `order.service.ts` importe el orquestador — y ahí la capa
 *       (iv) se rompería con la primera línea de esa implementación (ADR §4,
 *       "Si vivieran en el service de cancelación..."). Allow-by-name (la
 *       forma anterior de esta cerca) fue exactamente lo que dejó pasar el
 *       "Hueco 2" del ADR de RBAC — de ahí el deny-by-default.
 *
 *   (B) El conteo de call-sites de los DOS chokepoints del escape es
 *       EXACTAMENTE el de `ESCAPE_CHOKEPOINTS`:
 *        - `authorizeCreditNoteCancellation()` — la fábrica del token branded.
 *        - `cancelOrderWithCreditNote()` — el ENTRYPOINT de la función de
 *          escape. El ADR §4 (iv) pide, textual, "el conteo de call-sites de
 *          **la función de escape**" — no la fábrica. La diferencia importa:
 *          el propio ADR (capa iii) declara que el token se puede fabricar
 *          sin pasar por el mint (`as unknown as CreditNoteCancellationAuthorization`).
 *          Contar sólo mints deja ESE agujero abierto; contar el entrypoint
 *          lo tapa — cualquier invocación del code path cuenta, venga el
 *          token de donde venga. Mismo criterio que `EXPECTED_AUTHORIZE_CALL_SITES`.
 *
 *   (C.1) Las firmas de `cancelOrder()`, `cancelReservation()` y de los dos
 *       `findBlockingInvoiceLinkage()` son EXACTAMENTE las conocidas hoy
 *       (sin parámetro extra). Es la defensa estructural contra "flag como
 *       parámetro".
 *
 *   (C.2) Ninguno de los dos services de cancelación menciona un
 *       identificador de la lista negra de flags de bypass. Es PROFUNDIDAD
 *       —cubre el `if (bandera)` en el cuerpo con un nombre "obvio"—, no
 *       defensa estructural; por eso queda acotada a esos dos archivos (un
 *       barrido amplio daría ruido con `forceCancel` en otros contextos).
 *
 *   (D) Cada ruta de `ESCAPE_ROUTES` exige su grupo de autz. HOY es UNA:
 *       `POST /api/orders/:id/cancel-with-credit-note`
 *       (`pos-menu/orders.routes.ts`) → `Roles.EMISOR_NOTA_CREDITO`, NO
 *       `Roles.ORDERS` ni ningún otro grupo. Es la capa (i): si alguien
 *       degrada ese `authorize(...)`, `rbac-route-coverage` sigue verde (hay
 *       *un* authorize), `rbac-matrix-sync` sigue verde (el conteo no cambia)
 *       y `docs/rbac-matriz-endpoints.md` queda stale en silencio — el
 *       fail-open de autz más caro del ADR, hoy sin cerca. (El ADR §4 (i)
 *       dice `MANAGEMENT`; el grupo dedicado `EMISOR_NOTA_CREDITO` — commit
 *       `6154edc` — es más preciso y es el que el código usa desde el
 *       sub-bloque 4.) OJO: (D) itera una LISTA de rutas, no es una cerca de
 *       CLASE sobre `orders.routes.ts` — una 2ª ruta de escape en ese archivo
 *       la agarra (B) por conteo, no (D); B-reservas suma su fila a
 *       `ESCAPE_ROUTES` a mano, en el mismo cambio que la ruta.
 *
 * ## SI ESTO ROMPE
 *  - (A) Un archivo de `pos-menu/`/`reservas/` importó el núcleo. Si es
 *    `order.service.ts` / `reservation.service.ts`: NO — la lógica de
 *    cancelar-con-NC va en `src/facturacion/` (orquestador propio), nunca
 *    como branch de `cancelOrder()`/`cancelReservation()` (ADR §4 capa iv).
 *    Si es un adaptador de puerto legítimo (como
 *    `order-cancel-for-credit-note.ts`) o la ruta dedicada, sumalo a
 *    `NUCLEO_IMPORT_ALLOWLIST` con el motivo verificado a mano.
 *  - (B) Cambió el conteo de un chokepoint. Si agregaste la ruta/función de
 *    escape de reservas (B-reservas), actualizá la fila correspondiente de
 *    `ESCAPE_CHOKEPOINTS` (y sumá `cancelReservationWithCreditNote` como
 *    3ª fila), en el mismo cambio, con el changelog. Si NO agregaste una
 *    ruta y el número subió, alguien llama al escape desde un sitio nuevo
 *    —con el token fabricado por un cast o no— y es exactamente lo que esta
 *    cerca ataja.
 *  - (C.1) La firma de `cancelOrder()`/`cancelReservation()`/
 *    `findBlockingInvoiceLinkage()` cambió. Si es un flag para saltear el
 *    guard de factura viva: NO (ADR §4 capa i + ii). Si cambió por otra
 *    razón legítima, actualizá `SIGNATURES`.
 *  - (C.2) Aparece un identificador de bypass en un service. Ver (C.1).
 *  - (D) Una ruta de `ESCAPE_ROUTES` dejó de exigir su grupo. Si moviste el
 *    escape a otro grupo, actualizá la fila en `ESCAPE_ROUTES` acá, la matriz
 *    (`docs/rbac-matriz-endpoints.md`) y `roles.ts` en el mismo cambio — y
 *    justificá por qué un grupo distinto sigue siendo un escape fiscal
 *    restringido. Si agregaste una ruta de escape nueva (B-reservas), sumá
 *    su fila a `ESCAPE_ROUTES`.
 *
 * ## FALSOS NEGATIVOS DECLARADOS (una cerca es una cerca, no un parser)
 *  1. (A)/(B) `NUCLEO_IMPORT_RE` y los regex de conteo sólo ven la forma
 *     literal (`from '...'`, `nombre(`). Un `await import('...')` dinámico,
 *     un `require('...')`, o un re-export con alias
 *     (`export { authorizeCreditNoteCancellation as mint }`) usado como
 *     `mint(...)` son invisibles. Hoy nada de eso ocurre; los nombres son
 *     deliberadamente incómodos.
 *  2. (A) barre `src/pos-menu/` + `src/reservas/`. Si `cancelOrder()` se
 *     mudara a un módulo FUERA de esas dos carpetas que importe el núcleo,
 *     queda fuera del barrido. (B) lo ataja parcialmente: el caller nuevo
 *     igual movería el conteo del entrypoint.
 *  3. (C.1) compara la firma textual. Un formateo que la parta en varias
 *     líneas (Prettier no lo hace hoy con este ancho) da un falso POSITIVO
 *     ruidoso (test rojo sin regresión real), no un falso negativo — se
 *     corrige actualizando `SIGNATURES`. Falla al lado seguro.
 *  4. (C.2) es una lista negra fija de nombres. Un flag con un nombre fuera
 *     de la lista (`permitirConComprobante`) es invisible. La defensa
 *     estructural contra "flag como parámetro" es (C.1); (C.2) es
 *     profundidad ante el `if (bandera)` en el cuerpo.
 *  5. (C.1) congela las CUATRO funciones que el ADR §4 nombra. Un guard
 *     nuevo equivalente a `findBlockingInvoiceLinkage()` con otro nombre no
 *     está en `SIGNATURES` — habría que sumarlo a mano.
 *  6. (A) prohíbe el MÓDULO `cancel-with-credit-note.ts` entero, pero ese
 *     archivo aloja además doctrina fiscal PURA
 *     (`CREDIT_NOTE_COMPENSATION_TOLERANCE`,
 *     `isInvoiceFullyCompensatedByIssuedCreditNotes`,
 *     `creditNoteLinesFromInvoiceItems`) que hoy consumen
 *     `facturacion/invoice.service.ts` y `facturacion/sql.invoice.repository.ts`.
 *     Si mañana `order.service.ts`/`reservation.service.ts` necesitaran una
 *     de esas funciones puras legítimamente, (A) se pondría roja sin
 *     regresión real. Falla al lado seguro, pero está acá declarado: la
 *     salida sería extraer esas puras a un archivo aparte, no aflojar (A).
 *  7. (D) mira la línea de `authorize(...)` dentro de una ventana de texto
 *     después del path de la ruta. Un `router.use(authorize(...))` a nivel
 *     de archivo que cubriera esa ruta por otro camino no lo vería — hoy
 *     `orders.routes.ts` no tiene un `router.use` de autz, cada ruta lleva
 *     el suyo inline.
 */

/** Los dos módulos del núcleo del escape. */
const NUCLEO_MODULES = ['cancel-order-with-credit-note.service', 'cancel-with-credit-note'];
const NUCLEO_IMPORT_RE = new RegExp(
  String.raw`\bfrom\s+['"][^'"]*\/(?:` +
    NUCLEO_MODULES.map((m) => m.replace(/\./g, '\\.')).join('|') +
    String.raw`)\.js['"]`,
);

/** Deny-by-default: todo importador del núcleo en `pos-menu/`/`reservas/`
 *  tiene que estar acá con su motivo, verificado a mano. Misma forma que
 *  `PUBLIC_ROUTES` / `PRE_AUTH_API_MOUNTS` / `OWNERSHIP_EXEMPT`. */
const NUCLEO_IMPORT_ALLOWLIST: Record<string, string> = {
  'pos-menu/orders.routes.ts':
    'La ruta dedicada (capa i del ADR §4): POST /api/orders/:id/cancel-with-credit-note, detrás de authorize(Roles.EMISOR_NOTA_CREDITO). Es el ÚNICO punto donde el escape se cablea a HTTP — importa `buildCancelOrderWithCreditNoteService` y `authorizeCreditNoteCancellation` para componerlo. Que exista acá es el diseño; que exista en order.service.ts sería la fuga.',
  'pos-menu/order-cancel-for-credit-note.ts':
    'Adaptador de puerto del sub-bloque 4: `class OrderCancelForCreditNote implements OrderCancelPort`. Importa el CONTRATO (`import type { OrderCancelPort }`) que define el orquestador, no su código — es la inversión que evita que el orquestador (en facturacion/) importe pos-menu. NO es order.service.ts.',
};

/** Carpetas de dominio barridas por (A). */
const DOMAIN_DIRS = ['pos-menu', 'reservas'];

/** Los dos services de cancelación normal — blanco explícito del ADR §4. */
const CANCEL_SERVICE_FILES = ['pos-menu/order.service.ts', 'reservas/reservation.service.ts'];

/** Los dos chokepoints del code path del escape. `g` en el regex para
 *  contar TODAS las invocaciones, no una por línea. `definitionFile` se
 *  excluye del barrido: ahí está la firma del símbolo, no una invocación. */
// ADR común cancelar-con-NC sub-bloque 4 (07/09/2026):
//  - authorizeCreditNoteCancellation: 1 caller de producción, el handler de
//    POST /api/orders/:id/cancel-with-credit-note (arma el token con
//    req.user!.id como confirmedBy).
//  - cancelOrderWithCreditNote: 1 caller, la misma ruta
//    (buildCancelOrderWithCreditNoteService(req).cancelOrderWithCreditNote(...)).
// B-reservas va a sumar una 3ª fila `cancelReservationWithCreditNote` y a
// subir `authorizeCreditNoteCancellation` a 2 (su ruta emite el token) —
// ambas cosas en el mismo cambio que agregue esa ruta, con changelog.
const ESCAPE_CHOKEPOINTS: Array<{
  symbol: string;
  regex: RegExp;
  definitionFile: string;
  expectedSites: number;
  expectedFiles: string[];
}> = [
  {
    symbol: 'authorizeCreditNoteCancellation',
    regex: /\bauthorizeCreditNoteCancellation\s*\(/g,
    definitionFile: 'facturacion/cancel-with-credit-note.ts',
    expectedSites: 1,
    expectedFiles: ['pos-menu/orders.routes.ts'],
  },
  {
    symbol: 'cancelOrderWithCreditNote',
    regex: /\bcancelOrderWithCreditNote\s*\(/g,
    definitionFile: 'facturacion/cancel-order-with-credit-note.service.ts',
    expectedSites: 1,
    expectedFiles: ['pos-menu/orders.routes.ts'],
  },
];

/** Firmas congeladas de las funciones que el ADR §4 nombra explícitamente
 *  como blanco de un flag de bypass. */
const SIGNATURES: Array<{ file: string; signature: string }> = [
  {
    file: 'pos-menu/order.service.ts',
    signature: 'async cancelOrder(id: string, changedBy: string): Promise<OrderWithTransitions> {',
  },
  {
    file: 'pos-menu/order.service.ts',
    signature:
      "private async findBlockingInvoiceLinkage(orderId: string): Promise<InvoiceLinkage & { kind: 'ISSUED' | 'NOT_ISSUED' } | null> {",
  },
  {
    file: 'reservas/reservation.service.ts',
    signature: 'async cancelReservation(id: string, businessId: string): Promise<Reservation> {',
  },
  {
    file: 'reservas/reservation.service.ts',
    signature:
      "private async findBlockingInvoiceLinkage(reservationId: string): Promise<InvoiceLinkage & { kind: 'ISSUED' | 'NOT_ISSUED' } | null> {",
  },
];

/** Lista negra de nombres de flag de bypass. No exhaustiva (FN #4). */
const BYPASS_FLAG_RE =
  /\b(skipInvoiceGuard|skipGuard|skipInvoiceCheck|skipBlockingInvoice|skipBlocking|bypassInvoice|bypassCreditNote|bypassGuard|esEscape|isEscape|skipCreditNote|allowInvoiced|forceCancel|forceInvoiced)\b/i;

/** (D) Las rutas del escape y el grupo que cada una tiene que exigir. HOY es
 *  UNA (órdenes). B-reservas suma la suya
 *  (`POST /api/reservations/:id/cancel-with-credit-note`) como 2ª fila acá —
 *  en el mismo cambio que la ruta. Es un array, no un objeto, justamente
 *  para que agregar la fila sea el recordatorio: si (D) quedara singular,
 *  la ruta de reservas nacería sin cerca de capa (i) y (B) —que sí se pone
 *  roja al agregar el call-site— no lo cubre (cuenta invocaciones, no
 *  verifica el `authorize` de cada ruta). */
const ESCAPE_ROUTES: Array<{ file: string; pathLiteral: string; requiredAuthorize: string }> = [
  {
    file: 'pos-menu/orders.routes.ts',
    pathLiteral: "'/:id/cancel-with-credit-note'",
    requiredAuthorize: 'authorize(Roles.EMISOR_NOTA_CREDITO)',
  },
];

/** Igual que `lock-order.test.ts`: saca comentarios de bloque y de línea
 *  antes de matchear — si no, este mismo docblock (que menciona
 *  `authorizeCreditNoteCancellation(`, `skipInvoiceGuard`,
 *  `cancelOrderWithCreditNote(`) satisface los regex sin que el código lo
 *  haga. */
function stripComments(content: string): string {
  const withoutBlocks = content.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlocks
    .split('\n')
    .map((line) => line.split('//')[0])
    .join('\n');
}

function findTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      results.push(full);
    }
  }
  return results;
}

function relOf(file: string): string {
  return relative(SRC_DIR, file).replace(/\\/g, '/');
}

describe('CN-ESCAPE-CONTAINMENT-001 -- el núcleo del escape con Nota de Crédito no se filtra a la cancelación normal', () => {
  it('(A) ningún archivo de pos-menu/ o reservas/ importa el núcleo salvo el allowlist (deny-by-default)', () => {
    const importers: string[] = [];
    for (const d of DOMAIN_DIRS) {
      for (const file of findTsFiles(join(SRC_DIR, d))) {
        const code = stripComments(readFileSync(file, 'utf-8'));
        if (NUCLEO_IMPORT_RE.test(code)) importers.push(relOf(file));
      }
    }

    // Anti-vacuidad del regex: los dos services SÍ importan de facturacion/
    // (el tipo InvoiceRepository) -- prueba que el barrido mira imports reales.
    for (const rel of CANCEL_SERVICE_FILES) {
      const code = stripComments(readFileSync(join(SRC_DIR, rel), 'utf-8'));
      expect(code, `${rel} ya no importa nada de facturacion/ -- revisá el ancla de anti-vacuidad`).toMatch(
        /\bfrom\s+['"][^'"]*\/facturacion\/[^'"]+\.js['"]/,
      );
    }

    const offenders = importers.filter((rel) => !(rel in NUCLEO_IMPORT_ALLOWLIST));
    expect(
      offenders,
      'Un archivo de pos-menu/ o reservas/ importa el módulo del núcleo del escape sin estar en NUCLEO_IMPORT_ALLOWLIST. Si es order.service.ts / reservation.service.ts: NO (ADR §4 capa iv). Si es un adaptador de puerto legítimo o la ruta dedicada, sumalo al allowlist con motivo.',
    ).toEqual([]);

    // Los dos services nombrados por el ADR nunca pueden estar ni siquiera en
    // el allowlist.
    for (const rel of CANCEL_SERVICE_FILES) {
      expect(importers, `${rel} importa el núcleo -- prohibido sin excepción (ADR §4 capa iv)`).not.toContain(rel);
    }

    // Dirección "entrada stale": cada clave del allowlist tiene que existir y
    // seguir importando el núcleo, o sobra.
    for (const rel of Object.keys(NUCLEO_IMPORT_ALLOWLIST)) {
      const code = stripComments(readFileSync(join(SRC_DIR, rel), 'utf-8'));
      expect(
        NUCLEO_IMPORT_RE.test(code),
        `${rel} está en NUCLEO_IMPORT_ALLOWLIST pero ya no importa el núcleo -- sacá la entrada.`,
      ).toBe(true);
    }
  });

  it('(B) el conteo de call-sites de cada chokepoint del escape es el esperado', () => {
    // Sólo código de PRODUCCIÓN: `findTsFiles` ya excluye `*.test.ts`, pero
    // deja pasar helpers no-test bajo `src/tests/` (`integration/helpers/db.ts`,
    // `seed.ts`). Un helper de setup que invocara el escape o el mint no es un
    // call-site que esta cerca deba contar -- de ahí el filtro. Deliberado, no
    // accidente.
    const files = findTsFiles(SRC_DIR).filter((f) => !relOf(f).startsWith('tests/'));

    for (const cp of ESCAPE_CHOKEPOINTS) {
      const callers: string[] = [];
      let total = 0;
      for (const file of files) {
        const rel = relOf(file);
        if (rel === cp.definitionFile) continue;
        const code = stripComments(readFileSync(file, 'utf-8'));
        const hits = code.match(cp.regex)?.length ?? 0;
        if (hits > 0) {
          callers.push(rel);
          total += hits;
        }
      }
      expect(
        total,
        `Cambió el conteo de call-sites de ${cp.symbol}(). Si agregaste la ruta de escape de reservas, actualizá su fila en ESCAPE_CHOKEPOINTS con el changelog. Si no, alguien llama al escape desde un sitio nuevo.`,
      ).toBe(cp.expectedSites);
      expect(callers.sort(), `archivos con call-sites de ${cp.symbol}()`).toEqual([...cp.expectedFiles].sort());
    }
  });

  it('(C.1) las firmas de cancelOrder/cancelReservation/findBlockingInvoiceLinkage son las conocidas (sin parámetro de bypass)', () => {
    for (const { file, signature } of SIGNATURES) {
      const code = stripComments(readFileSync(join(SRC_DIR, file), 'utf-8'));
      expect(
        code.includes(signature),
        `La firma esperada no aparece en ${file}:\n  ${signature}\n¿Se agregó un parámetro de bypass, o cambió la firma por otra razón? (ADR §4 capa ii)`,
      ).toBe(true);
    }
  });

  it('(C.2) ni order.service.ts ni reservation.service.ts mencionan un flag de bypass conocido', () => {
    for (const rel of CANCEL_SERVICE_FILES) {
      const code = stripComments(readFileSync(join(SRC_DIR, rel), 'utf-8'));
      const match = code.match(BYPASS_FLAG_RE);
      expect(
        match,
        `${rel} menciona "${match?.[0]}" -- si es un flag para saltear el guard de factura viva, NO: el escape es una función separada en src/facturacion/ con su propia ruta y permiso (ADR §4 capa i + ii).`,
      ).toBeNull();
    }
  });

  it('(D) cada ruta de escape con NC exige su grupo de autz (capa i)', () => {
    for (const route of ESCAPE_ROUTES) {
      const code = stripComments(readFileSync(join(SRC_DIR, route.file), 'utf-8'));
      const at = code.indexOf(route.pathLiteral);
      expect(at, `no encontré la ruta ${route.pathLiteral} en ${route.file}`).toBeGreaterThan(-1);
      // Ventana desde el path hasta el arrow del handler -- ahí va el authorize.
      const window = code.slice(at, at + 400);
      expect(
        window.includes(route.requiredAuthorize),
        `${route.file}: la ruta del escape fiscal ${route.pathLiteral} no exige ${route.requiredAuthorize}. Degradar ese authorize NO lo detecta rbac-route-coverage ni rbac-matrix-sync -- es el fail-open de autz más caro del ADR (ver docblock (D)).`,
      ).toBe(true);
    }
  });
});
