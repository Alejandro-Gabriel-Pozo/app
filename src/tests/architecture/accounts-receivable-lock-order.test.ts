import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '../..');

/**
 * ACCOUNTS-RECEIVABLE-LOCK-ORDER-001 (Wave 13, Zona 2, 21/09/2026, gate
 * `architecture-governor`, docs/diseno-invoice-retry-charge-guard-2026-09-18.md
 * §3.1/§3.3) -- mismo problema que `LOCK-ORDER-001` (`lock-order.test.ts`),
 * generalizado a `accounts_receivable`: los dos únicos sitios que hoy toman
 * `FOR UPDATE` sobre MÁS DE UNA fila de `accounts_receivable` en la misma
 * transacción (`InvoiceService.requestConsolidatedInvoice()`, el guard
 * fresco; `InvoiceService.assertChargesStillInvoiceable()`, el guard de
 * retry) tienen que ordenar esas filas con el MISMO comparador antes de
 * lockear -- si no, dos transacciones concurrentes que comparten cargos
 * pueden esperarse en ciclo (Postgres 40P01, ABBA deadlock). Nace ya
 * corregido (a diferencia de `LOCK-ORDER-001`, que nació DESPUÉS de que dos
 * `.sort()` ad-hoc coincidieran por casualidad durante semanas) -- el gate
 * de esta Wave encontró la divergencia durante el diseño, antes de que el
 * código de retry existiera.
 *
 * No es un parser: cuenta qué archivos invocan las primitivas que lockean
 * más de una fila de `accounts_receivable` (`accountsReceivableRepo.getByIdWithLock(client`
 * / `accountsReceivableRepo.getByFinancialTransactionIdWithLock(client` en
 * `invoice.service.ts`; `arRepo.getByIdWithLock(client` en
 * `accounts-receivable.service.ts`) y exige que la lista sea EXACTAMENTE la
 * conocida hoy. Cada caller cae en una de dos categorías, ambas explícitas
 * abajo: lockea MÁS DE UNA AR en la misma transacción (tiene que usar
 * `canonicalAccountsReceivableLockOrder()`) o lockea UNA sola (no hay orden
 * que coordinar -- un solo lock no puede formar un ciclo). Mismo criterio
 * de cerca eléctrica que `lock-order.test.ts`.
 *
 * SI ESTO ROMPE:
 *   - Un archivo nuevo empezó a lockear `accounts_receivable`. Si loopea
 *     sobre varias (un `for`/`.map` con un array de AR), tiene que ordenar
 *     con `canonicalAccountsReceivableLockOrder()` ANTES del primer lock y
 *     sumarse a `MULTI_AR_CALLERS`. Si resuelve una sola AR por invocación
 *     (sin loop), sumalo a `SINGLE_AR_CALLERS` con el porqué -- no le
 *     agregues `canonicalAccountsReceivableLockOrder()` de más, no protege
 *     nada ahí.
 *
 * FALSOS NEGATIVOS DECLARADOS (architecture-governor, 18-21/09/2026 --
 * ronda 2/3 del gate de diseño) -- una cerca es una cerca, no un parser:
 *   1. `LOCK_CALL_RE` exige el nombre literal del RECEPTOR
 *      (`accountsReceivableRepo.`/`arRepo.`) antes del método -- a
 *      diferencia de `lock-order.test.ts`, que solo exige el nombre del
 *      método + `client` como argumento (`getOutstandingForUpdate(client`,
 *      sin receptor). Un caller futuro que reciba el repositorio bajo otro
 *      nombre de campo (ej. `accountsReceivableRepository`) es invisible
 *      para esta cerca.
 *   2. `DEFINITION_FILES` es INERTE bajo este regex, a diferencia del
 *      precedente -- en `lock-order.test.ts`, excluir `payment-application.ts`
 *      SÍ importa (`getOutstandingForUpdate(client` matchea la firma real
 *      ahí). Acá, `LOCK_CALL_RE` exige el receptor `accountsReceivableRepo|arRepo`,
 *      y ninguno de los 3 archivos de `DEFINITION_FILES` tiene una llamada
 *      con ese receptor (son la interfaz y su implementación SQL, que
 *      definen `getByIdWithLock`/`getByFinancialTransactionIdWithLock` sin
 *      receptor de por medio). Se mantiene por simetría con el precedente,
 *      no porque haga falta.
 *   3. El segundo `expect` (`canonicalAccountsReceivableLockOrder\s*\(`)
 *      solo prueba que la función aparece EN ALGÚN LADO del archivo -- no
 *      que envuelve el array que de verdad alimenta el loop de lock. Un
 *      archivo podría llamarla sobre un array irrelevante y lockear otro
 *      sin orden, y esta cerca no lo vería. (Mismo FN #3 de `lock-order.test.ts`.)
 */
const MULTI_AR_CALLERS = ['facturacion/invoice.service.ts'];

/** Cada entrada documenta por qué NO necesita `canonicalAccountsReceivableLockOrder()`
 *  -- verificado a mano que resuelve una única AR por llamada, sin loop, así
 *  que no puede sostener dos locks a la vez en la misma transacción
 *  (architecture-governor, 18/09/2026). */
const SINGLE_AR_CALLERS: Record<string, string> = {
  'clientes-finanzas/accounts-receivable.service.ts':
    'markCollected() (:661) y reverseTransfer() (:852) -- un lock por método, en métodos distintos, nunca dos AR a la vez en la misma transacción.',
};

/** Definen las primitivas de lock -- no son "callers" que lockeen varias AR
 *  a la vez (mismo criterio que `lock-order.test.ts`; ver FN #2 arriba --
 *  la exclusión es inerte bajo este regex, se mantiene por simetría). */
const DEFINITION_FILES = new Set([
  'clientes-finanzas/accounts-receivable.repository.ts',
  'clientes-finanzas/sql.accounts-receivable.repository.ts',
  'clientes-finanzas/payment-application.ts',
]);

const LOCK_CALL_RE =
  /\b(?:accountsReceivableRepo|arRepo)\.getByIdWithLock\s*\(\s*client\b|\b(?:accountsReceivableRepo|arRepo)\.getByFinancialTransactionIdWithLock\s*\(\s*client\b/;

/** Igual que en `lock-order.test.ts`: saca `/* *\/` y `//` antes de
 *  matchear -- si no, un comentario que MENCIONA `canonicalAccountsReceivableLockOrder()`
 *  satisface el regex sin que el código realmente la llame. */
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

describe('ACCOUNTS-RECEIVABLE-LOCK-ORDER-001 -- todo lock multi-fila sobre accounts_receivable usa el orden canónico compartido', () => {
  it('los callers de las primitivas de lock son exactamente los esperados, clasificados y en regla', () => {
    const files = findTsFiles(SRC_DIR);
    const callers: string[] = [];

    for (const file of files) {
      const rel = relative(SRC_DIR, file).replace(/\\/g, '/');
      if (DEFINITION_FILES.has(rel)) continue;
      const code = stripComments(readFileSync(file, 'utf-8'));
      if (LOCK_CALL_RE.test(code)) callers.push(rel);
    }

    const expected = [...MULTI_AR_CALLERS, ...Object.keys(SINGLE_AR_CALLERS)].sort();
    expect(
      callers.sort(),
      'Un archivo nuevo lockea accounts_receivable. Clasificalo: MULTI_AR_CALLERS (loopea, necesita canonicalAccountsReceivableLockOrder()) o SINGLE_AR_CALLERS (una sola AR por llamada, con el porqué).',
    ).toEqual(expected);

    for (const rel of MULTI_AR_CALLERS) {
      const code = stripComments(readFileSync(join(SRC_DIR, rel), 'utf-8'));
      expect(
        code,
        `${rel} lockea MÁS DE UNA accounts_receivable por transacción sin usar canonicalAccountsReceivableLockOrder() -- riesgo de ABBA con el otro sitio que sí lo usa.`,
      ).toMatch(/canonicalAccountsReceivableLockOrder\s*\(/);
    }
  });
});
