import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '../..');

/**
 * AR-INVOICE-LOCK-ORDER-001 (23/09/2026, ADR `ISSUE-BEFORE-REVERSE-WINDOW-001`,
 * §3.2/§3.16, "N7", gate `architecture-governor`, ronda 15-bis -- condición
 * MANDATORIA del gate de implementación del Bloque 2c).
 *
 * Distinto de `LOCK-ORDER-001` (`lock-order.test.ts`, dos filas de
 * `invoices` en la misma tx) y de `ACCOUNTS-RECEIVABLE-LOCK-ORDER-001`
 * (`accounts-receivable-lock-order.test.ts`, dos filas de
 * `accounts_receivable` en la misma tx) -- esta cerca es CRUZADA: congela
 * el orden entre DOS RECURSOS distintos (`accounts_receivable` e
 * `invoices`) cuando una misma transacción sostiene un lock de cada uno a
 * la vez.
 *
 * **La propiedad, tal como la cerró §3.16 (ronda 15-bis, corrigiendo la
 * premisa de la ronda 15):** de los 4 call-sites de producción reales que
 * hoy sostienen a la vez un lock de AR y un lock de `invoices` en la misma
 * transacción --
 *   1. `applyCappedPaymentToInvoice()` vía `CustomerAccountService.recordPayment()`
 *      -- NO sostiene lock de AR (sin AR de por medio, ver §3.16).
 *   2. `applyCappedPaymentToInvoice()` vía `AccountsReceivableService.markCollected()`
 *      -- SÍ sostiene los dos, en orden AR→factura.
 *   3. `applyCappedRefundToInvoice()` vía `CancellationRefundService.confirmRefund()`
 *      -- NO sostiene lock de AR (reembolso al huésped, sin AR de por medio).
 *   4. `getInFlightCreditNoteTotalForUpdate()`/`...ForPairForUpdate()` vía
 *      `InvoiceService.buildCreditNote()` -- NO sostiene lock de AR (corre
 *      SIN transacción abierta desde los orquestadores de escape, ver
 *      §3.16 punto 3).
 *
 * -- el ÚNICO que sostiene los dos locks a la vez es `markCollected()`
 * (caso 2), y lo hace en orden AR→factura. La toma exclusiva nueva del
 * Bloque 2c (`InvoiceService.retryExisting()`, vía
 * `takeRetryClaimWithClient()`, DENTRO del mismo `transactionManager.run()`
 * que `assertChargesStillInvoiceable()`) introduce el ÚNICO OTRO lugar del
 * repo que sostiene los dos locks a la vez -- y usa el MISMO orden
 * AR→factura (AR primero, vía `assertChargesStillInvoiceable()`; la factura
 * propia después, vía `takeRetryClaimWithClient()`). Si cualquiera de los
 * dos invirtiera el orden, dos transacciones concurrentes (una tomando AR
 * primero, otra tomando factura primero) podrían esperarse en ciclo
 * (Postgres 40P01, ABBA deadlock) -- exactamente el riesgo que N7 planteó y
 * que esta cerca cierra con código, no con una afirmación de texto (ver el
 * párrafo "Condición obligatoria..." de §3.16).
 *
 * No es un parser: cuenta qué archivos sostienen a la vez un lock de AR
 * (`accountsReceivableRepo`/`arRepo` . `getByIdWithLock`/
 * `getByFinancialTransactionIdWithLock`, mismo `LOCK_CALL_RE` que
 * `accounts-receivable-lock-order.test.ts`, duplicado acá -- ver
 * `docs/indice-conocimiento.md`/CLAUDE.md para el criterio de no extraer un
 * regex de dos líneas a un módulo compartido) y un lock de `invoices`
 * (mismo `LOCK_CALL_RE` que `lock-order.test.ts`, duplicado acá también,
 * MÁS `takeRetryClaimWithClient(client`) EN EL MISMO ARCHIVO, y exige que
 * esa lista sea EXACTAMENTE la conocida hoy (aserción 1). Para cada
 * caller conocido, verifica además (aserción 2) que, DENTRO de la función
 * puntual que sostiene los dos locks (ventana acotada por anclas de texto,
 * mismo criterio que `city-ledger-reverse-route-group-freeze.test.ts`), el
 * lock de AR aparece ANTES que el de `invoices` -- no alcanza con que el
 * ARCHIVO contenga los dos regex en cualquier orden, un archivo con dos
 * funciones DISTINTAS (una que lockea AR, otra que lockea invoices, sin
 * relación) pasaría igual la aserción 1 sin decir nada sobre el orden real.
 *
 * SI ESTO ROMPE:
 *   - Aserción 1 (enumeración): un archivo nuevo empezó a sostener un lock
 *     de AR y uno de `invoices` a la vez. Verificá con qué orden -- si es
 *     AR→factura, sumalo a `KNOWN_CROSS_LOCK_CALLERS` con una entrada nueva
 *     en `CALLER_WINDOWS` (ancla de inicio/fin + los dos regex puntuales) y
 *     la aserción 2 lo va a validar. Si es factura→AR, es un ABBA real
 *     contra `markCollected()`/`retryExisting()` -- no lo agregues, arreglá
 *     el orden.
 *   - Aserción 2 (orden dentro de la ventana): alguien invirtió el orden de
 *     los dos `await` dentro de `markCollected()` o de la transacción de
 *     `retryExisting()`. Revertí -- el orden AR→factura no es una
 *     preferencia de estilo, es lo que evita el ABBA (ver arriba).
 *
 * FALSOS NEGATIVOS DECLARADOS (una cerca es una cerca, no un parser):
 *   1. Mismos 3 falsos negativos que `lock-order.test.ts`/
 *      `accounts-receivable-lock-order.test.ts` heredan sus respectivos
 *      regexes (nombre de variable receptor no literal, método `...ForUpdate`
 *      nuevo dentro de un `DEFINITION_FILE`, `canonicalXLockOrder()`
 *      mencionada pero no aplicada al array real).
 *   2. La ventana de cada caller conocido está acotada por anclas de texto
 *      (ancla de inicio → ancla de fin), no por un parser de AST -- si el
 *      cuerpo de la función crece y el orden real de los `await` queda
 *      igual pero un comentario o string literal en el medio menciona el
 *      OTRO patrón antes de tiempo, el índice podría ser engañoso. Mitigado
 *      por `stripComments()` (igual que las otras cercas del directorio),
 *      pero no por un parser real de imports/strings.
 *   3. Esta cerca verifica la DECLARACIÓN (qué texto aparece en qué orden),
 *      no el runtime -- no reemplaza al test de integración contra Postgres
 *      real que prueba que la toma exclusiva de 2c efectivamente excluye a
 *      un `retryExisting()` concurrente
 *      (`src/tests/integration/invoice-retry-exclusive-claim.integration.test.ts`).
 */

/** Mismo regex que `accounts-receivable-lock-order.test.ts::LOCK_CALL_RE`. */
const AR_LOCK_RE =
  /\b(?:accountsReceivableRepo|arRepo)\.getByIdWithLock\s*\(\s*client\b|\b(?:accountsReceivableRepo|arRepo)\.getByFinancialTransactionIdWithLock\s*\(\s*client\b/;

/** Mismo regex que `lock-order.test.ts::LOCK_CALL_RE`, más `takeRetryClaimWithClient` (Bloque 2c). */
const INVOICE_LOCK_RE =
  /\b(applyCappedPaymentToInvoice|applyCappedRefundToInvoice)\s*\(|\bgetOutstandingForUpdate\s*\(\s*client\b|\bgetRefundableForUpdate\s*\(\s*client\b|\bgetInFlightCreditNoteTotalForUpdate\s*\(\s*client\b|\bgetInFlightCreditNoteTotalForPairForUpdate\s*\(\s*client\b|\btakeRetryClaimWithClient\s*\(\s*client\b/;

/** Definen las primitivas de lock -- mismo criterio que las dos cercas precedentes: no son "callers" reales. */
const DEFINITION_FILES = new Set([
  'clientes-finanzas/accounts-receivable.repository.ts',
  'clientes-finanzas/sql.accounts-receivable.repository.ts',
  'clientes-finanzas/payment-application.ts',
  'facturacion/invoice.repository.ts',
  'facturacion/sql.invoice.repository.ts',
]);

const KNOWN_CROSS_LOCK_CALLERS = ['clientes-finanzas/accounts-receivable.service.ts', 'facturacion/invoice.service.ts'].sort();

/** Ventana acotada de texto por caller conocido, para verificar el ORDEN
 *  real (no solo la presencia) del lock de AR antes que el de `invoices`. */
const CALLER_WINDOWS: Record<
  string,
  { startAnchor: string; endAnchor: string; arCallToken: string; invoiceCallToken: string }
> = {
  'clientes-finanzas/accounts-receivable.service.ts': {
    startAnchor: 'async markCollected(id: string): Promise<AccountReceivableMarkCollectedResult> {',
    endAnchor: 'async reverseTransfer(',
    arCallToken: 'getByIdWithLock(client',
    invoiceCallToken: 'applyCappedPaymentToInvoice(',
  },
  'facturacion/invoice.service.ts': {
    startAnchor: 'private async retryExisting(existing: Invoice): Promise<Invoice> {',
    endAnchor: 'private async assertNoOtherLiveInvoiceForCharges(',
    arCallToken: 'assertChargesStillInvoiceable(client',
    invoiceCallToken: 'takeRetryClaimWithClient(client',
  },
};

/** Igual que en `lock-order.test.ts`/`accounts-receivable-lock-order.test.ts`. */
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

describe('AR-INVOICE-LOCK-ORDER-001 -- todo lock cruzado AR+invoices en la misma transacción va en orden AR→factura', () => {
  it('el conjunto de callers que sostienen los dos locks a la vez es EXACTAMENTE el esperado', () => {
    const files = findTsFiles(SRC_DIR);
    const callers: string[] = [];

    for (const file of files) {
      const rel = relative(SRC_DIR, file).replace(/\\/g, '/');
      if (DEFINITION_FILES.has(rel)) continue;
      const code = stripComments(readFileSync(file, 'utf-8'));
      if (AR_LOCK_RE.test(code) && INVOICE_LOCK_RE.test(code)) callers.push(rel);
    }

    expect(
      callers.sort(),
      'Un archivo nuevo sostiene a la vez un lock de accounts_receivable y uno de invoices. Si el orden real es AR→factura, clasificalo en KNOWN_CROSS_LOCK_CALLERS + CALLER_WINDOWS (invoice-ar-cross-lock-order.test.ts). Si es factura→AR, es un riesgo de ABBA real contra markCollected()/retryExisting() -- no lo agregues, arreglá el orden.',
    ).toEqual(KNOWN_CROSS_LOCK_CALLERS);
  });

  it.each(Object.entries(CALLER_WINDOWS))('%s: el lock de AR aparece antes que el de invoices, dentro de la función que sostiene los dos', (rel, window) => {
    const code = stripComments(readFileSync(join(SRC_DIR, rel), 'utf-8'));

    const startAt = code.indexOf(window.startAnchor);
    expect(startAt, `no encontré '${window.startAnchor}' en ${rel} -- ¿se movió o se renombró la función?`).toBeGreaterThan(-1);

    const afterStart = code.slice(startAt + window.startAnchor.length);
    const endAt = afterStart.indexOf(window.endAnchor);
    expect(endAt, `no encontré '${window.endAnchor}' después de '${window.startAnchor}' en ${rel} -- ¿la función siguiente se movió o se renombró?`).toBeGreaterThan(-1);

    const body = afterStart.slice(0, endAt);

    const arIndex = body.indexOf(window.arCallToken);
    const invoiceIndex = body.indexOf(window.invoiceCallToken);
    expect(arIndex, `no encontré '${window.arCallToken}' dentro de la ventana de ${rel} -- ¿ya no lockea AR ahí?`).toBeGreaterThan(-1);
    expect(invoiceIndex, `no encontré '${window.invoiceCallToken}' dentro de la ventana de ${rel} -- ¿ya no lockea invoices ahí?`).toBeGreaterThan(-1);

    expect(
      arIndex < invoiceIndex,
      `${rel}: '${window.invoiceCallToken}' aparece ANTES que '${window.arCallToken}' -- eso invierte el orden AR→factura y reabre el riesgo de ABBA (40P01) contra el otro caller que sí respeta ese orden. Revertí el orden de los dos await.`,
    ).toBe(true);
  });
});
