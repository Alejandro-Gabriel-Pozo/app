/**
 * @file error-400-single-shape.test.ts
 * @description `VALIDATION-ERROR-SHAPE-001` (D-16, 17/09/2026, Wave 9 --
 * `docs/auditoria-integral-fase15-2026-09-16.md:466-494`, opción
 * recomendada (a)+(c)).
 *
 * El backend emitía CUATRO formas distintas de 400 de validación. Solo
 * dos son la fuente real del bug (**corrección 17/09/2026, gate
 * `architecture-governor`, segunda pasada -- la primera versión de esta
 * nota afirmaba que las cuatro rompían el frontend; medido contra
 * `appfrontend/src/lib/http.ts`, eso era falso para dos de las cuatro,
 * ver abajo**):
 *   - Forma A (`res.status(400).json({ code: 'VALIDATION_ERROR', errors:
 *     err.errors })`, `errors` como ARRAY) y Forma B (el helper
 *     `validationError()` duplicado, misma forma de `errors`) -- el
 *     frontend busca `errors.fieldErrors`/`errors.formErrors` (la forma
 *     de `.flatten()`); un array no los tiene, cae al default y el
 *     usuario ve el literal "Error inesperado".
 *   - Forma C (`err.flatten()` + un `message` fijo agregado) SÍ trae
 *     `fieldErrors`, así que el frontend la parseaba bien -- era una
 *     inconsistencia de mantenimiento (dos definiciones del mismo
 *     mensaje), no el bug de "Error inesperado".
 *   - Un quinto caso, sin Zod (`audit-log.routes.ts`, un `if` a mano con
 *     `{ code, message }` SIN `errors`), degrada a mensaje-sin-mapeo-por-
 *     campo -- tampoco "Error inesperado" (el frontend sí lee `message`),
 *     pero tampoco la forma canónica.
 * Unificar las cinco en una sola (la de `error.middleware.ts`) sigue
 * siendo correcto para las cinco -- pero la severidad real de A/B es
 * mayor que la de C/5º caso, y el mensaje de commit de este bloque lo
 * declara así.
 *
 * El fix (17/09/2026) borró las 17+1 ramas locales de Forma A/B/C/5º caso
 * detectadas en la auditoría -- TODO `*.routes.ts` deja que `ZodError`
 * propague a `next(err)`/`next(parsed.error)`, y `error.middleware.ts` es
 * el ÚNICO lugar que lo serializa.
 *
 * **Hallazgo del gate (HOLD, 17/09/2026, primera pasada): el survey que
 * armó la lista de 20 archivos buscó el identificador `ZodError` -- ciego
 * a una Forma A que usa `safeParse()` + `parsed.error.errors.map(...)`
 * SIN nombrar `ZodError` en ningún lado
 * (`reservas/reservations.routes.ts:541`, la ruta hermana de
 * `ESCAPE_ROUTES` del lado de reservas -- su comentario original incluso
 * afirmaba, de forma ahora comprobada falsa, que las dos rutas de
 * `ESCAPE_ROUTES` respondían con la misma forma). Corregida en la
 * segunda pasada.** Por eso esta cerca tiene DOS reglas, no una -- la del
 * identificador `ZodError` sola es necesaria pero no suficiente, porque
 * no ve una Forma A escrita sin nombrarlo.
 *
 * ## SI ESTO ROMPE
 * - **Regla 1 (`ZodError`):** un archivo nuevo (o uno de los que este
 *   bloque ya arregló) volvió a referenciar `ZodError`. Leé el archivo:
 *   si es un `catch`/`.safeParse()` que arma su propia respuesta 400 en
 *   vez de `next(err)`/`next(parsed.error)`, arreglalo igual que el
 *   resto (borrar la rama local, dejar que propague).
 * - **Regla 2 (literal `VALIDATION_ERROR`):** un archivo emite el string
 *   `VALIDATION_ERROR` -- con o sin Zod de por medio, capa que la Regla 1
 *   no ve (mismo hueco que dejó pasar `reservations.routes.ts:541`).
 *   Si el archivo no está en `VALIDATION_ERROR_LITERAL_ALLOWLIST`, es un
 *   caso NUEVO -- arreglalo (delegar con `next()`) en vez de agregarlo al
 *   allowlist. Si el conteo de un archivo YA listado cambió, revisalo: si
 *   BAJÓ porque arreglaste alguna de sus ocurrencias, actualizá el número
 *   (o sacá la entrada si llegó a 0); si SUBIÓ, es una ocurrencia nueva
 *   sin arreglar, no infles el número sin mirar qué la causó.
 *
 * ## LO QUE ESTA CERCA NO GARANTIZA
 * 1. Es una cerca eléctrica de texto (mismo criterio que
 *    `route-enumeration.fixture.ts`), no un parser AST -- una forma de
 *    400 construida sin el identificador `ZodError` NI el literal
 *    `VALIDATION_ERROR` (ej. un `code` distinto, o un objeto armado en
 *    una función helper con el string partido) sería invisible para las
 *    dos reglas. No es solo teórico: es exactamente cómo se filtró
 *    `reservations.routes.ts:541` la primera vez (regla 1 sola). La
 *    regla 2 cierra ESE caso puntual, no la clase general.
 * 2. No valida el CONTENIDO de `error.middleware.ts` -- solo que nada más
 *    compita con él. Ver `error.middleware.test.ts` para el caso que fija
 *    la forma canónica exacta (`{ code, message, errors: flatten() }`).
 * 3. No valida el lado frontend (`appfrontend/src/lib/http.ts`) -- que
 *    efectivamente parsee bien la forma canónica es responsabilidad de
 *    ese repo, sin cerca compartida (mismo límite que
 *    `route-consumer-coverage.test.ts` declara para su propio cruce).
 * 4. `VALIDATION_ERROR_LITERAL_ALLOWLIST` deja 4 sitios reales sin
 *    arreglar a propósito, con su conteo exacto medido tras `stripComments`
 *    (no una excepción muda, y no el conteo crudo de un `grep` -- ver nota
 *    abajo) -- `reservas/bookable-services.routes.ts` (2 -- un tercer
 *    `grep` hit en `:30` es un COMENTARIO que documenta el comportamiento,
 *    no código; las 2 reales son los checks manuales de `resourceId`/
 *    `date`), `facturacion/invoices.routes.ts` (2, `status` inválido/
 *    obligatorio), `facturacion/credit-note-requests.routes.ts` (1,
 *    `state` obligatorio), `pos-menu/orders.routes.ts` (1 -- distinto de
 *    los otros tres: no es un check de validación manual sino
 *    `InvalidPaymentInfoError` -- un error de DOMINIO -- mapeado a
 *    `code: 'VALIDATION_ERROR'` con solo `message`, encontrado recién al
 *    escribir esta regla 2, no por el hallazgo original ni por la
 *    primera pasada del gate). Los 4 son de menor severidad que A/B (ver
 *    arriba: el frontend sí muestra el `message` real, solo sin mapeo
 *    por campo) -- bloque aparte, registrado en
 *    `docs/pendientes-2026-09-12.md`.
 * 5. El alcance de `findRouteFiles()` es SOLO `*.routes.ts` (mismo filtro
 *    que usa `route-enumeration.fixture.ts` para las cercas RBAC) -- un
 *    helper fuera de ese patrón de nombre que armara un 400 de validación
 *    a mano sería invisible para las dos reglas. Medido a propósito, no
 *    asumido: hoy los únicos `.status(400)` de todo `src/` que NO están
 *    en un `*.routes.ts` son los dos de `error.middleware.ts` (líneas 35
 *    y 54) -- el propio serializador canónico, no un competidor.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRouteFiles, stripComments } from '../security/route-enumeration.fixture.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(__dirname, '../..');

const ZOD_ERROR_RE = /\bZodError\b/;

/**
 * Allowlist chica con motivo -- mismo criterio que `PUBLIC_ROUTES`/
 * `PRE_AUTH_API_MOUNTS`/`OWNERSHIP_EXEMPT`/`ESCAPE_ROUTES`. Vacía hoy: las
 * 18 rutas que este bloque tocó quedaron todas delegando a `next(err)`,
 * y ninguna necesita nombrar `ZodError` para hacerlo.
 */
const ZOD_ERROR_ALLOWLIST: Record<string, string> = {};

const VALIDATION_ERROR_LITERAL_RE = /'VALIDATION_ERROR'|"VALIDATION_ERROR"/g;

/**
 * Conteo EXACTO medido por archivo (no una excepción muda) -- ver punto 4
 * de "LO QUE ESTA CERCA NO GARANTIZA" arriba. Un archivo listado con un
 * conteo que ya no matchea (subió o bajó) rompe la cerca -- fuerza
 * revisar el delta en vez de dejarlo pasar en silencio.
 */
const VALIDATION_ERROR_LITERAL_ALLOWLIST: Record<string, number> = {
  'reservas/bookable-services.routes.ts': 2,
  'facturacion/invoices.routes.ts': 2,
  'facturacion/credit-note-requests.routes.ts': 1,
  'pos-menu/orders.routes.ts': 1,
};

describe('VALIDATION-ERROR-SHAPE-001 -- ningún *.routes.ts maneja/emite un 400 de validación por su cuenta', () => {
  it('regla 1: ningún archivo fuera de ZOD_ERROR_ALLOWLIST referencia el identificador ZodError', () => {
    const files = findRouteFiles(SRC_DIR);
    const violations: string[] = [];
    const usedKeys = new Set<string>();

    for (const absPath of files) {
      const relPath = relative(SRC_DIR, absPath).split('\\').join('/');
      const content = stripComments(readFileSync(absPath, 'utf-8'));
      if (!ZOD_ERROR_RE.test(content)) continue;

      if (relPath in ZOD_ERROR_ALLOWLIST) {
        usedKeys.add(relPath);
        continue;
      }
      violations.push(relPath);
    }

    expect(
      violations,
      'Estos *.routes.ts referencian ZodError -- probablemente construyen su propia respuesta ' +
        '400 en vez de delegar con next(err)/next(parsed.error), reintroduciendo una de las formas ' +
        'de error que D-16 unificó. Ver el docblock de este test.',
    ).toEqual([]);

    const stale = Object.keys(ZOD_ERROR_ALLOWLIST).filter((k) => !usedKeys.has(k));
    expect(
      stale,
      'Estas entradas de ZOD_ERROR_ALLOWLIST ya no matchean ningún archivo real -- sacalas.',
    ).toEqual([]);
  });

  it('regla 2: ningún *.routes.ts emite el literal VALIDATION_ERROR fuera de los conteos exactos de VALIDATION_ERROR_LITERAL_ALLOWLIST', () => {
    const files = findRouteFiles(SRC_DIR);
    const violations: string[] = [];
    const usedKeys = new Set<string>();

    for (const absPath of files) {
      const relPath = relative(SRC_DIR, absPath).split('\\').join('/');
      const content = stripComments(readFileSync(absPath, 'utf-8'));
      const matches = content.match(VALIDATION_ERROR_LITERAL_RE);
      const count = matches ? matches.length : 0;
      if (count === 0) continue;

      const allowed = VALIDATION_ERROR_LITERAL_ALLOWLIST[relPath];
      if (allowed === undefined) {
        violations.push(`${relPath}: ${count} ocurrencia(s) del literal 'VALIDATION_ERROR', no está en VALIDATION_ERROR_LITERAL_ALLOWLIST`);
        continue;
      }
      usedKeys.add(relPath);
      if (count !== allowed) {
        violations.push(`${relPath}: ${count} ocurrencia(s) medidas, el allowlist dice ${allowed} -- revisar qué cambió`);
      }
    }

    expect(
      violations,
      'El literal VALIDATION_ERROR apareció donde no se esperaba, o el conteo de un archivo ya ' +
        'listado cambió sin actualizar VALIDATION_ERROR_LITERAL_ALLOWLIST. Ver el docblock de este test.',
    ).toEqual([]);

    const stale = Object.keys(VALIDATION_ERROR_LITERAL_ALLOWLIST).filter((k) => !usedKeys.has(k));
    expect(
      stale,
      'Estas entradas de VALIDATION_ERROR_LITERAL_ALLOWLIST ya no matchean ningún archivo real -- sacalas.',
    ).toEqual([]);
  });
});
