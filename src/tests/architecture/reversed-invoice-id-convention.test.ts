import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '../..');

/**
 * REVERSED-INVOICE-ID-CONVENTION-001 (07/09/2026, ADR común cancelar-con-NC
 * sub-bloque 5 parte (c), condición 3 del re-gate §10).
 *
 * `financial_transactions.reversed_invoice_id` significa "esta fila revierte
 * la factura X". Sólo dos `type` lo hacen: `REFUND` (reembolso de reserva,
 * `CancellationRefundService.confirmRefund()`) y `ADJUSTMENT` (escape de
 * cancelación de orden, `CancelOrderWithCreditNoteService`). `CHARGE`/`PAYMENT`
 * usan `settled_invoice_id` o nada.
 *
 * La mitad SQL de F4 (`InvoiceRepository.getIssuedCreditNoteCompensationTotal()`,
 * `sql.invoice.repository.ts`, `AND r.type IN ('REFUND', 'ADJUSTMENT')`) y N1.b
 * usan esa whitelist. Es fail-closed: una fila revertidora con un `type` fuera
 * de la lista NO cuenta como compensación → F4 sub-declara → la cancelación
 * queda bloqueada de más. No es un fail-open, pero igual es incorrecto.
 * Desde **schema v47** (08/09/2026) el CHECK
 * `chk_financial_transactions_reversed_invoice_type` impone la convención a
 * nivel base (ver "ALCANCE" abajo); esta cerca cubre la mitad de CÓDIGO.
 *
 * ## ALCANCE — esta cerca cubre la MITAD DE CÓDIGO; la de datos la cierra el CHECK
 * La condición 3 del re-gate, textual, pide "ninguna FILA con
 * `reversed_invoice_id IS NOT NULL AND type NOT IN ('REFUND','ADJUSTMENT')`"
 * — una aserción sobre DATOS. Esta cerca es estática: verifica que ningún
 * write site en TypeScript setea `reversedInvoiceId` sobre una fila de
 * `financial_transactions` con un `type` fuera de la whitelist.
 *
 * **La mitad de DATOS la cierra `chk_financial_transactions_reversed_invoice_type`**
 * (`CHECK (reversed_invoice_id IS NULL OR type IN ('REFUND','ADJUSTMENT'))`,
 * schema v47, 08/09/2026 — bloque 1.1 del
 * `plan-cierre-cancelacion-nc-y-deuda-estructural-2026-09-08.md`). Desde ese
 * CHECK, un `UPDATE` en SQL crudo, una migración o un backfill que intenten
 * crear la fila prohibida son **rechazados por Postgres** — o sea que el FN #3
 * ("SQL crudo salta esta cerca") ya no deja pasar el hecho, sólo deja pasar
 * este test en verde sin haberlo visto. Las dos mitades juntas cubren la
 * condición 3.
 *
 * Esta cerca sigue teniendo valor propio: falla en el commit que introduce el
 * write site equivocado (feedback en CI, antes del deploy), mientras que el
 * CHECK sólo se entera cuando la fila intenta entrar en runtime.
 *
 * ## SI ESTO ROMPE
 *  - Un archivo NUEVO escribe `reversedInvoiceId` en una `financial_transactions`.
 *    Verificá que el MISMO write setea `type: 'REFUND'` o `type: 'ADJUSTMENT'`
 *    (los dos únicos que revierten una factura; `CHARGE`/`PAYMENT` no). Sumalo
 *    a `WRITE_SITES`.
 *  - Si un `type` NUEVO legítimamente revierte una factura: la whitelist de
 *    `getIssuedCreditNoteCompensationTotal()` (`sql.invoice.repository.ts`) y
 *    N1.b tienen que crecer para incluirlo, EN EL MISMO CAMBIO — si no, F4
 *    sub-declara la compensación de ese tipo.
 *
 * ## FALSOS NEGATIVOS DECLARADOS (architecture-governor, 07/09/2026 — una
 * cerca es una cerca, no un parser)
 *  1. El chequeo de `type` es a nivel ARCHIVO: prueba que
 *     `type: 'REFUND'|'ADJUSTMENT'` aparece EN ALGÚN LADO del archivo, no que
 *     envuelve el MISMO object literal que setea `reversedInvoiceId`. Un
 *     archivo podría setear `reversedInvoiceId` en un write y `type: 'CHARGE'`
 *     en otro objeto no relacionado, y esta cerca no lo vería. (Análogo al
 *     FN #3 de `lock-order.test.ts`.)
 *  2. `type` seteado vía variable (`type: txType` con `txType = 'REFUND'` más
 *     arriba) no matchea el literal — invisible.
 *  3. Un `INSERT`/`UPDATE ... reversed_invoice_id` en SQL CRUDO fuera del
 *     repo, o una migración/backfill, es invisible PARA ESTA CERCA: sólo ve la
 *     capa de object-literal TS. **Pero desde schema v47 lo ataja el CHECK
 *     `chk_financial_transactions_reversed_invoice_type`** (ver "ALCANCE"): la
 *     fila prohibida es rechazada por Postgres aunque esta cerca no la vea.
 *  4. La exclusión de decl de tipo es textual
 *     (`/reversedInvoiceId\??:\s*string\b/`) — un write a una var tipada
 *     `string` con esa forma de línea podría excluirse mal (improbable).
 *  5. `cancellation-refund.service.ts` hace `chunks.push({ reversedInvoiceId: invoice.id })`
 *     a un array INTERMEDIO, no directo a `financial_transactions`; la cerca
 *     no distingue "struct intermedio" de "write de FT" — confía en que el
 *     archivo está en `WRITE_SITES` por una razón verificada a mano (el write
 *     real de FT lleva `type: 'REFUND'`).
 *  6. `DEFINITION_FILES` se excluye a nivel ARCHIVO. Hoy es correcto (ahí
 *     `reversedInvoiceId` es firma de interfaz y mapeo de columna). Pero
 *     `sql.financial-transaction.repository.ts` es JUSTAMENTE donde viven
 *     `create()`/`createWithClient()`: un write real de FT agregado DENTRO de
 *     ese archivo sería invisible para esta cerca — **lo ataja igual el CHECK
 *     de schema v47** (una fila con `type` fuera de la whitelist no entra).
 */

/** Los archivos que escriben `reversedInvoiceId` en una fila de
 *  `financial_transactions`. Verificado a mano que el `type` del write es
 *  `REFUND` (`cancellation-refund.service.ts`, el chunk `type: 'REFUND'`
 *  dentro del loop de reparto) / `ADJUSTMENT`
 *  (`cancel-order-with-credit-note.service.ts`, el `createWithClient(...)`
 *  con `reversedInvoiceId: originalInvoiceId` -- citas por nombre, no
 *  línea, desde SCHEMA-ANCHOR-DRIFT-001 10/09/2026),
 *  `cancel-reservation-with-credit-note.service.ts` -- bloque 3.3-b1,
 *  09/09/2026, mismo `type: 'ADJUSTMENT'`, ahora con `reservationId`
 *  seteado en vez de `null`;
 *  `clientes-finanzas/accounts-receivable.service.ts` -- Bloque 3c-ii
 *  (14/09/2026, `reverseTransfer()`), las DOS filas `ADJUSTMENT`
 *  compensatorias (pata empresa y pata huésped) escriben
 *  `reversedInvoiceId: null` explícito -- invariante que las excluye de
 *  NC (§4.2 del ADR de City Ledger), no "la pata huésped" nada más: es un
 *  archivo nuevo en la lista, no una escritura nueva en uno ya listado). */
const WRITE_SITES = [
  'facturacion/cancel-order-with-credit-note.service.ts',
  'facturacion/cancel-reservation-with-credit-note.service.ts',
  'reservas/cancellation-refund.service.ts',
  'clientes-finanzas/accounts-receivable.service.ts',
].sort();

/** Ahí `reversedInvoiceId` es la firma de la interfaz
 *  (`financial-transaction.repository.ts:85`) y el mapeo columna↔entidad
 *  (`sql.financial-transaction.repository.ts:928`, más los `?? null` de los
 *  INSERT), no un write de negocio. Ver FN #6 por lo que esta exclusión
 *  esconde. */
const DEFINITION_FILES = new Set([
  'clientes-finanzas/financial-transaction.repository.ts',
  'clientes-finanzas/sql.financial-transaction.repository.ts',
]);

/**
 * `credit_note_request` (schema v57, Bloque 1 del ADR común cancelar-con-NC
 * -- repositorio + entidades, sin wiring en ningún orquestador todavía) tiene
 * su PROPIA columna `reversed_invoice_id` -- "duplicado acá a propósito"
 * respecto de `financial_transactions.reversed_invoice_id` (ver el docblock
 * de `CREATE TABLE credit_note_request` en `schema.sql`: evita un JOIN solo
 * para saber qué factura está en juego al listar la bandeja). Mismo NOMBRE
 * de campo, TABLA distinta -- esta cerca lee el archivo entero sin distinguir
 * a qué entidad pertenece el object literal (FN #1 del docblock de arriba),
 * así que el mapeo columna↔entidad de `CreditNoteRequest.reversedInvoiceId`
 * matchea el mismo regex que un write real de `financial_transactions` sin
 * serlo. Mismo criterio que `DEFINITION_FILES`: exclusión por archivo,
 * verificada a mano (15/09/2026) que ninguno de los dos toca
 * `financial_transactions`.
 */
const OTHER_ENTITY_REVERSED_INVOICE_ID_FILES = new Set([
  'facturacion/sql.credit-note-request.repository.ts',
  'facturacion/in-memory.credit-note-request.repository.ts',
]);

/** Asignación de la propiedad `reversedInvoiceId` (key + `:`). Las lecturas
 *  (`.reversedInvoiceId` / `?.reversedInvoiceId`) no tienen `:` después del
 *  identificador y no matchean. */
const WRITE_RE = /(?<![.?])\breversedInvoiceId:\s*/;
/** Decl de tipo, a excluir: `reversedInvoiceId?: string | null` /
 *  `reversedInvoiceId: string | null` en una interfaz o en un tipo inline. */
const TYPE_DECL_RE = /\breversedInvoiceId\??:\s*string\b/;
const TYPE_LITERAL_RE = /\btype:\s*'(REFUND|ADJUSTMENT)'/;

/** Igual que `lock-order.test.ts` / `rbac-matrix-sync.test.ts`: saca `/* *\/`
 *  y `//` antes de matchear -- si no, un comentario que MENCIONA
 *  `reversedInvoiceId:` o `type: 'REFUND'` satisface el regex sin que el
 *  código lo haga. */
function stripComments(content: string): string {
  const withoutBlocks = content.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlocks
    .split('\n')
    .map((line) => line.split('//')[0])
    .join('\n');
}

/** Deja sólo las líneas con un write de `reversedInvoiceId` que NO son decl
 *  de tipo. */
function writeLines(code: string): string[] {
  return code
    .split('\n')
    .filter((line) => WRITE_RE.test(line) && !TYPE_DECL_RE.test(line));
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

describe('REVERSED-INVOICE-ID-CONVENTION-001 -- reversed_invoice_id sólo en filas REFUND/ADJUSTMENT (mitad de código)', () => {
  it('los write sites de reversedInvoiceId en financial_transactions son exactamente los esperados y setean type REFUND/ADJUSTMENT', () => {
    const files = findTsFiles(SRC_DIR);
    const found: string[] = [];

    for (const file of files) {
      const rel = relative(SRC_DIR, file).replace(/\\/g, '/');
      if (DEFINITION_FILES.has(rel) || OTHER_ENTITY_REVERSED_INVOICE_ID_FILES.has(rel)) continue;
      const code = stripComments(readFileSync(file, 'utf-8'));
      if (writeLines(code).length > 0) found.push(rel);
    }

    expect(
      found.sort(),
      'Un archivo nuevo escribe reversedInvoiceId en una financial_transactions. Verificá que el MISMO write setea type: \'REFUND\' o \'ADJUSTMENT\' y sumalo a WRITE_SITES (ver "SI ESTO ROMPE").',
    ).toEqual(WRITE_SITES);

    // Anti-vacuidad: si el regex de write deja de matchear el productor real,
    // `found` queda vacío, el toEqual de arriba falla, y este bloque nunca se
    // alcanza -- pero lo dejamos explícito por si WRITE_SITES se editara mal.
    expect(WRITE_SITES.length).toBe(4);

    for (const rel of WRITE_SITES) {
      const code = stripComments(readFileSync(join(SRC_DIR, rel), 'utf-8'));
      expect(
        writeLines(code).length,
        `${rel} está en WRITE_SITES pero ya no tiene ningún write de reversedInvoiceId -- si el productor se movió, actualizá WRITE_SITES.`,
      ).toBeGreaterThan(0);
      expect(
        code,
        `${rel} escribe reversedInvoiceId pero no setea type: 'REFUND' ni 'ADJUSTMENT' -- una fila revertidora con otro type rompe la whitelist de F4 (getIssuedCreditNoteCompensationTotal).`,
      ).toMatch(TYPE_LITERAL_RE);
    }
  });
});
