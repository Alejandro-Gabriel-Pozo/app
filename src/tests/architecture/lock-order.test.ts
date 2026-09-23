import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '../..');

/**
 * LOCK-ORDER-001 (05/09/2026, docs/conocimiento/playbook-idempotencia-bajo-lock.md)
 * -- los dos únicos sitios que hoy toman `FOR UPDATE` sobre más de una fila
 * de `invoices` en la misma transacción (`CustomerAccountService.recordPayment()`,
 * `CancellationRefundService.confirmRefund()`) tienen que ordenar esas
 * facturas con el MISMO comparador antes de lockear -- si no, dos
 * transacciones concurrentes que tocan las mismas facturas pueden esperarse
 * en ciclo (Postgres 40P01, ABBA deadlock). Hasta el 05/09/2026 eso era dos
 * `.sort()` ad-hoc en archivos distintos, coincidiendo por casualidad
 * mantenida a mano -- un revisor de arquitectura llegó a aprobar un cambio
 * dando ese cierre por pendiente sin haber releído el otro lado.
 *
 * No es un parser: cuenta qué archivos invocan las primitivas que lockean
 * una fila de `invoices` (`applyCappedPaymentToInvoice`,
 * `applyCappedRefundToInvoice` de `payment-application.ts`;
 * `getOutstandingForUpdate`/`getRefundableForUpdate`; o
 * `getInFlightCreditNoteTotalForUpdate`/`...ForPairForUpdate` de
 * `invoice.repository.ts`, agregadas 09/09/2026 -- llamadas directo con
 * un `client`) y exige que la lista sea EXACTAMENTE la conocida hoy. Cada
 * caller cae en una de dos categorías, ambas explícitas abajo: lockea MÁS
 * DE UNA factura en la misma transacción (tiene que usar
 * `canonicalInvoiceLockOrder()`, si no hay riesgo de ABBA) o lockea UNA
 * sola (no hay orden que coordinar -- un solo lock no puede formar un
 * ciclo). Mismo criterio de cerca eléctrica que `rbac-matrix-sync.test.ts`
 * / `PUBLIC_ROUTES` de `rbac-route-coverage.test.ts`.
 *
 * SI ESTO ROMPE:
 *   - Un archivo nuevo empezó a lockear facturas. Si loopea sobre varias
 *     (un `for`/`.map` con un array de invoice ids), tiene que ordenar con
 *     `canonicalInvoiceLockOrder()` ANTES del primer lock y sumarse a
 *     `MULTI_INVOICE_CALLERS`. Si resuelve una sola factura por invocación
 *     (ej. vía `resolveInvoiceLinkage()`, sin loop), sumalo a
 *     `SINGLE_INVOICE_CALLERS` con el porqué -- no le agregues
 *     `canonicalInvoiceLockOrder()` de más, no protege nada ahí.
 *
 * FALSOS NEGATIVOS DECLARADOS (architecture-governor, 05/09/2026) -- una
 * cerca es una cerca, no un parser; estos tres casos la esquivan sin que
 * nada avise:
 *   1. `LOCK_CALL_RE` exige el nombre literal `client` como argumento de
 *      `getOutstandingForUpdate`/`getRefundableForUpdate`
 *      (`getOutstandingForUpdate(client`). Un caller que lo invoque con
 *      otro nombre de variable (`getOutstandingForUpdate(tx, id)`) no
 *      matchea y queda invisible para esta cerca.
 *   2. Un método `...ForUpdate` NUEVO agregado dentro de
 *      `sql.invoice.repository.ts` es invisible -- ese archivo está en
 *      `DEFINITION_FILES` (excluido a propósito, porque ahí SIEMPRE
 *      aparece el argumento `client` en la firma) y esta cerca no
 *      distingue "define el método" de "lo llama para lockear varias
 *      filas". **Disparó de verdad, no es hipotético:** los bloques 2.4 y
 *      3.3-a (08/09/2026) agregaron `getInFlightCreditNoteTotalForUpdate()`/
 *      `...ForPairForUpdate()` a `invoice.repository.ts` y esta cerca no se
 *      enteró hasta el 09/09/2026, cuando se agregaron a `LOCK_CALL_RE` a
 *      mano (gate `architecture-governor`) -- el punto ciego siempre iba a
 *      necesitar una corrección manual, y esta fue la primera vez. Mismo
 *      corrección aplicada el 23/09/2026 (Bloque 2c, ADR
 *      `ISSUE-BEFORE-REVERSE-WINDOW-001` §3.2/§3.16) para
 *      `takeRetryClaimWithClient()` -- agregado a mano acá, ver
 *      `SINGLE_INVOICE_CALLERS` para el porqué de la clasificación.
 *   3. El segundo `expect` (`canonicalInvoiceLockOrder\s*\(`) solo prueba
 *      que la función aparece EN ALGÚN LADO del archivo -- no que envuelve
 *      el array que de verdad alimenta el loop de lock. Un archivo podría
 *      llamarla sobre un array irrelevante y lockear otro sin orden, y
 *      esta cerca no lo vería.
 */
const MULTI_INVOICE_CALLERS = [
  'clientes-finanzas/customer-account.service.ts',
  'reservas/cancellation-refund.service.ts',
].sort();

/** Cada entrada documenta por qué NO necesita `canonicalInvoiceLockOrder()`
 *  -- verificado a mano que resuelve una única factura por llamada, sin
 *  loop, así que no puede sostener dos locks a la vez en la misma
 *  transacción (arquitecture-governor, 05/09/2026). */
const SINGLE_INVOICE_CALLERS: Record<string, string> = {
  'clientes-finanzas/accounts-receivable.service.ts':
    'markCollected() resuelve UNA factura por resolveInvoiceLinkage(), sin loop -- un solo lock, no hay ABBA que ordenar',
  'facturacion/invoice.service.ts':
    'getInFlightCreditNoteTotalForUpdate()/...ForPairForUpdate() ejecutan DOS sentencias FOR UPDATE, pero las dos sobre la MISMA fila preexistente (original.id) -- la segunda es un re-lock de una fila que la propia transacción ya tiene tomada (mismo xid, misma conexión vía PgTransactionManager.run()), Postgres la concede de inmediato sin esperar. Nunca se sostienen dos filas de invoices PREEXISTENTES distintas a la vez (createWithClient() inserta la NC nueva en la misma tx, pero es invisible para otras transacciones hasta el commit -- no puede participar de un ciclo de espera). Un solo lock real, no hay ABBA que ordenar. Verificado (gate architecture-governor, 09/09/2026): el docblock del método getInFlightCreditNoteTotalForPairForUpdate() en sql.invoice.repository.ts (cita por nombre, no línea, desde SCHEMA-ANCHOR-DRIFT-001 10/09/2026) documenta que toma su PROPIO FOR UPDATE, no depende de un lock previo -- el comentario del call-site que decía lo contrario (invoice.service.ts, corregido en el mismo commit) describía el diseño anterior a esa corrección del 08/09/2026. Bloque 2c (23/09/2026, §3.2/§3.16): `retryExisting()` también llama a `takeRetryClaimWithClient(client, existing.id)` -- una sola fila, la propia (`existing.id`), por invocación, sin loop; corre DESPUÉS de assertChargesStillInvoiceable() dentro de la MISMA transacción, nunca sostiene dos filas de invoices PREEXISTENTES distintas a la vez tampoco. El orden AR→factura de esa transacción (no el orden entre dos invoices) lo congela `AR-INVOICE-LOCK-ORDER-001` (`src/tests/architecture/invoice-ar-cross-lock-order.test.ts`), una cerca distinta -- esta acá solo clasifica que no hace falta canonicalInvoiceLockOrder().',
};

/** Definen las primitivas de lock -- no son "callers" que lockeen varias
 *  facturas a la vez, se excluyen del barrido (`payment-application.ts`
 *  opera sobre UNA factura por llamada; los otros dos son la interfaz y su
 *  implementación SQL, no callers). */
const DEFINITION_FILES = new Set([
  'clientes-finanzas/payment-application.ts',
  'facturacion/invoice.repository.ts',
  'facturacion/sql.invoice.repository.ts',
]);

const LOCK_CALL_RE =
  /\b(applyCappedPaymentToInvoice|applyCappedRefundToInvoice)\s*\(|\bgetOutstandingForUpdate\s*\(\s*client\b|\bgetRefundableForUpdate\s*\(\s*client\b|\bgetInFlightCreditNoteTotalForUpdate\s*\(\s*client\b|\bgetInFlightCreditNoteTotalForPairForUpdate\s*\(\s*client\b|\btakeRetryClaimWithClient\s*\(\s*client\b/;

/** Igual que en `rbac-matrix-sync.test.ts`: saca `/* *\/` y `//` antes de
 *  matchear -- si no, un comentario que MENCIONA `canonicalInvoiceLockOrder()`
 *  (como el que documenta esta misma regla dentro del código real) satisface
 *  el regex sin que el código realmente la llame. Verificado con un caso
 *  real: al probar que esta cerca detecta una regresión, un comentario
 *  vecino a la línea revertida bastó para que el test siguiera en verde. */
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

describe('LOCK-ORDER-001 -- todo lock multi-fila sobre invoices usa el orden canónico compartido', () => {
  it('los callers de las primitivas de lock son exactamente los esperados, clasificados y en regla', () => {
    const files = findTsFiles(SRC_DIR);
    const callers: string[] = [];

    for (const file of files) {
      const rel = relative(SRC_DIR, file).replace(/\\/g, '/');
      if (DEFINITION_FILES.has(rel)) continue;
      const code = stripComments(readFileSync(file, 'utf-8'));
      if (LOCK_CALL_RE.test(code)) callers.push(rel);
    }

    const expected = [...MULTI_INVOICE_CALLERS, ...Object.keys(SINGLE_INVOICE_CALLERS)].sort();
    expect(
      callers.sort(),
      'Un archivo nuevo lockea invoices. Clasificalo: MULTI_INVOICE_CALLERS (loopea, necesita canonicalInvoiceLockOrder()) o SINGLE_INVOICE_CALLERS (una sola factura por llamada, con el porqué).',
    ).toEqual(expected);

    for (const rel of MULTI_INVOICE_CALLERS) {
      const code = stripComments(readFileSync(join(SRC_DIR, rel), 'utf-8'));
      expect(
        code,
        `${rel} lockea MÁS DE UNA factura por transacción sin usar canonicalInvoiceLockOrder() -- riesgo de ABBA con el otro sitio que sí lo usa.`,
      ).toMatch(/canonicalInvoiceLockOrder\s*\(/);
    }
  });
});
