import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INVOICE_SERVICE_FILE = join(__dirname, '../../facturacion/invoice.service.ts');

/**
 * BUILD-CREDIT-NOTE-THROW-CATALOG-001 (12/09/2026, gate `architecture-governor`
 * + retro de sesión sobre `ORDER-CONSOLIDATED-PARTIAL-01`) -- nace de un
 * hallazgo real, no hipotético: al diseñar el arreglo de
 * `CN-ESCAPE-ORPHAN-ADJUSTMENT-001` (un `ADJUSTMENT` puede quedar `PENDING`
 * para siempre si `buildCreditNote()` tira un error DETERMINÍSTICO después
 * de que la transacción del orquestador ya commiteó -- reintentar con la
 * misma clave de idempotencia recalcula lo mismo y falla igual, porque los
 * insumos, una factura ya emitida, son inmutables), armé una lista a mano de
 * "los 3 errores determinísticos que hay que interceptar". El gate encontró
 * un 4to (`CreditNoteAmbiguousSubjectError`) que se me había pasado -- **y
 * lo agregó el commit INMEDIATO ANTERIOR de esta misma sesión (`e02a4fb`,
 * bloque 1c-ii-b)**. Una lista en prosa, mantenida a mano, quedó
 * desactualizada un commit después de escribirse. Mismo patrón que
 * `ROLES-CATALOG-DRIFT-001`/`RBAC-MATRIX-SECTION2-001`: un catálogo a mano
 * no se entera solo de un caso nuevo agregado en OTRO bloque.
 *
 * Esta cerca reemplaza "acordarse" por "enumerar" -- cuenta, por regex
 * sobre el texto (no AST, ver limitaciones declaradas abajo), TODAS las
 * clases que `InvoiceService.buildCreditNote()` puede tirar, y exige que el
 * conjunto sea EXACTAMENTE `EXPECTED_THROWS`. Cada entrada lleva su
 * clasificación (`DETERMINISTIC` / `TRANSIENT`) y el razonamiento -- la
 * cerca no puede inferir la clasificación sola, pero si aparece una clase
 * nueva sin clasificar, esto se pone rojo y fuerza a alguien a decidirlo
 * antes de mergear, no tres bloques después.
 *
 * ## Qué significa cada clasificación
 * - **`DETERMINISTIC`** -- el throw depende SOLO de datos ya congelados
 *   (una factura `ISSUED`, R9/R12, o los campos del `ADJUSTMENT` mismo,
 *   inmutables tras el INSERT de tx1). Reintentar con la misma clave de
 *   idempotencia recalcula exactamente lo mismo y falla igual, siempre --
 *   es la clase de error que deja un `ADJUSTMENT` huérfano si tx1 ya
 *   commiteó antes de que esto se tire (`CN-ESCAPE-ORPHAN-ADJUSTMENT-001`,
 *   `docs/pendientes-2026-09-10.md`). Candidato directo a la salida manual
 *   que ese bloque (todavía sin encarar) tiene que resolver.
 * - **`TRANSIENT`** -- el throw depende de un estado que SÍ puede cambiar
 *   entre un intento y el siguiente (otras Notas de Crédito en vuelo que
 *   todavía no resolvieron con AFIP). Un reintento futuro puede tener
 *   éxito sin que nadie edite nada -- no es candidato a huérfano
 *   permanente, y NO hay que sumarlo a la lista de errores a interceptar
 *   cuando se encare la salida manual.
 *
 * ## SI ESTO ROMPE
 * `buildCreditNote()` ganó o perdió un `throw`. Si ganó uno:
 * 1. Clasificalo (`DETERMINISTIC`/`TRANSIENT`) con el mismo criterio de
 *    arriba -- fijate en qué datos depende la condición, no en qué tan
 *    grave "suena".
 * 2. Si es `DETERMINISTIC`, sumalo también a la enumeración de
 *    `CN-ESCAPE-ORPHAN-ADJUSTMENT-001` en `docs/pendientes-2026-09-10.md`
 *    -- ese bloque, cuando se encare, tiene que interceptar TODOS los
 *    determinísticos, no la lista que alguien recuerde de memoria.
 * 3. Agregá la entrada a `EXPECTED_THROWS` acá.
 * Si perdió uno (ej. se retiró un guard), sacá la entrada de las dos
 * listas -- no la dejes "por las dudas", eso es exactamente el tipo de
 * afirmación que se vuelve falsa sin que nadie la borre.
 *
 * ## FALSOS NEGATIVOS DECLARADOS -- no es un parser, es una cerca
 * 1. Extracción por regex sobre texto con comentarios ya sacados (mismo
 *    `stripComments` que `lock-order.test.ts`) -- un `throw new X(...)`
 *    dentro de un STRING LITERAL (poco probable en este archivo, no
 *    verificado que sea imposible) matchearía igual, falso positivo.
 * 2. El límite del método (dónde termina `buildCreditNote()`) se detecta
 *    buscando el PRÓXIMO miembro de clase con exactamente 2 espacios de
 *    indentación -- funciona porque TypeScript no permite declarar un
 *    método de clase anidado dentro de otro método. Si el archivo se
 *    reindenta (tabs, 4 espacios), esta cerca deja de encontrar el límite
 *    y falla con "NOT FOUND" en vez de silencioso -- fail-loud, no
 *    fail-open, pero requiere ajustar el regex a mano.
 * 3. Un `throw` que use una variable en vez de `new ClaseError(...)`
 *    literal (`throw err;` de un `catch`, o `throw someVar;`) es invisible
 *    para esta cerca -- verificado a mano que no hay ninguno así dentro de
 *    `buildCreditNote()` hoy (12/09/2026), pero si se agrega uno, esta
 *    cerca no lo va a ver.
 * 4. La extracción es por NOMBRE DE CLASE, no por sitio de código -- si DOS
 *    `throw` distintos usan la misma clase genérica (`Error`), colapsan en
 *    UNA sola entrada de `EXPECTED_THROWS`, cada una con su propia nota
 *    dentro del mismo string. Un TERCER sitio nuevo que tire esa misma
 *    clase no mueve esta cerca -- no hay forma de que el conteo por nombre
 *    detecte "apareció un sitio más" si la clase ya estaba en el set.
 *    Caso real (15/09/2026, Bloque 3 de `credit_note_request`): el guard
 *    `throw new Error(...)` nuevo (orderId/reservationId ambos null antes
 *    del INSERT de `credit_note_request`) comparte clase con el guard
 *    heredado de la rama proporcional -- la nota de `EXPECTED_THROWS.Error`
 *    documenta los dos sitios a mano porque la cerca no puede.
 */

interface ThrowClassification {
  classification: 'DETERMINISTIC' | 'TRANSIENT';
  note: string;
}

const EXPECTED_THROWS: Record<string, ThrowClassification> = {
  InvoiceNotReversibleError: {
    classification: 'DETERMINISTIC',
    note:
      'Primer guard de la función -- tx.reversedInvoiceId ausente, o la factura resuelta no está ISSUED, o no es Factura B. Los tres datos son inmutables una vez la factura se emitió (R9/R12) o el ADJUSTMENT se creó. Reachability desde los 2 escapes: ARGUMENTADA como inalcanzable (resolveInvoiceLinkage(charge.id) resuelve la factura del CARGO, no de una NC) pero NO verificada independientemente -- hallazgo abierto del gate architecture-governor (11/09/2026), sigue sin cerrar.',
  },
  CreditNoteAmbiguousSubjectError: {
    classification: 'DETERMINISTIC',
    note:
      '1c-ii-b (11/09/2026) -- tx.orderId Y tx.reservationId no-nulos a la vez. Invariante de aplicación (financial_transactions no tiene CHECK que lo impida), inmutable tras el INSERT de tx1. Hoy inalcanzable desde los 2 escapes reales (cada uno setea exactamente un sujeto por construcción) -- mismo perfil que el resto de esta tabla igual.',
  },
  CreditNoteAttributionBlockedError: {
    classification: 'DETERMINISTIC',
    note:
      'resolveRefundableForPair() (N4-a/1a) da BLOCKED -- factura sin invoice_items, sujeto ausente de la factura, o grupo de tasa sin entrada congelada en afip_request.Iva[]. Los tres insumos son inmutables tras emitir (R9/R12). Reachable HOY vía reservas (3.3-a, en producción); vía órdenes (1c-ii-b) recién si accounts_receivable alguna vez setea orderId -- hoy no lo hace.',
  },
  CreditNoteAttributionMismatchError: {
    classification: 'DETERMINISTIC',
    note:
      'abs(tx.amount) no coincide con attribution.attributedTotal -- los dos derivados de datos congelados (el ADJUSTMENT ya creado, la factura ya emitida). Misma reachability que CreditNoteAttributionBlockedError.',
  },
  OrderInvoiceHasNoLinesError: {
    classification: 'DETERMINISTIC',
    note:
      'originalItems.length === 0 (factura "Nivel A", pre-23/08/2026), congelado. Reachable HOY, población medida (9 de 11 facturas de la tenant Demo, refund-attribution.ts) -- para CUALQUIER ADJUSTMENT (orden o reserva) que llegue a la rama heredada, no solo órdenes pese al nombre de la clase (deuda de wording registrada, sin bloque asignado, ver domain/errors.ts).',
  },
  Error: {
    classification: 'DETERMINISTIC',
    note:
      '[buildCreditNote] DOS sitios distintos tiran esta misma clase genérica -- la extracción por regex es por NOMBRE de clase, no por sitio de código, así que colapsan en una sola entrada acá (falso negativo declarado, ver "SI ESTO ROMPE" arriba: un tercer sitio nuevo con la misma clase tampoco movería esta cerca). (1) rama heredada, un ADJUSTMENT parcial sin orderId ni reservationId. (2) Bloque 3 de credit_note_request (15/09/2026): mismo guard, ahora también antes del INSERT de credit_note_request -- ambos null ahí exigiría violar el CHECK `chk_credit_note_request_order_or_reservation` (="1"), así que se falla legible antes de llegar a Postgres. Los DOS son determinísticos por el mismo argumento: NO son DomainError (mapean a 500 genérico, no a un `code` propio) y HOY son estructuralmente inalcanzables desde los 2 escapes reales (cada uno setea exactamente un sujeto) -- invariante rota si salta, no un caso de negocio.',
  },
  CreditNoteCapExceededError: {
    classification: 'TRANSIENT',
    note:
      'Tope global N5 -- depende de OTRAS Notas de Crédito en vuelo (PENDING/FAILED_UNCERTAIN) contra la misma factura, que pueden resolver a REJECTED y liberar cupo. Un reintento MÁS TARDE puede tener éxito sin que nadie edite nada -- no es candidato a CN-ESCAPE-ORPHAN-ADJUSTMENT-001.',
  },
  CreditNotePairCapExceededError: {
    classification: 'TRANSIENT',
    note:
      'Mismo mecanismo que CreditNoteCapExceededError, acotado al tope por par (invoiceId, sujeto). Mismo motivo para excluirlo de CN-ESCAPE-ORPHAN-ADJUSTMENT-001.',
  },
};

/** Mismo criterio que `lock-order.test.ts` -- saca `/* *\/` y `//` antes de matchear. */
function stripComments(content: string): string {
  const withoutBlocks = content.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlocks
    .split('\n')
    .map((line) => line.split('//')[0])
    .join('\n');
}

/**
 * Extrae el cuerpo de un método de clase por nombre, buscando el próximo
 * miembro con exactamente 2 espacios de indentación como límite -- no es un
 * parser real, ver "FALSOS NEGATIVOS DECLARADOS" en el docblock del archivo.
 */
function extractMethodBody(fileContent: string, methodName: string): string {
  const startRe = new RegExp(`\\n {2}(private )?(async )?${methodName}\\(`);
  const startMatch = startRe.exec(fileContent);
  if (!startMatch) {
    throw new Error(`extractMethodBody: no encontré el método "${methodName}" -- ¿se renombró o se reindentó el archivo?`);
  }
  const bodyStart = startMatch.index + 1;
  const memberRe = /\n {2}(private )?(async )?[A-Za-z_]+[^\n]*\{/g;
  memberRe.lastIndex = bodyStart + startMatch[0].length;
  const nextMatch = memberRe.exec(fileContent);
  if (!nextMatch) {
    throw new Error(`extractMethodBody: no encontré el límite (próximo miembro de clase) después de "${methodName}"`);
  }
  return fileContent.slice(bodyStart, nextMatch.index);
}

function extractThrowClasses(body: string): string[] {
  const stripped = stripComments(body);
  const throwRe = /throw new ([A-Za-z_]+)\(/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = throwRe.exec(stripped))) {
    found.add(m[1]!);
  }
  return [...found];
}

describe('BUILD-CREDIT-NOTE-THROW-CATALOG-001 -- todo throw de buildCreditNote() está enumerado y clasificado', () => {
  it('el conjunto de clases que buildCreditNote() puede tirar es exactamente el esperado', () => {
    const fileContent = readFileSync(INVOICE_SERVICE_FILE, 'utf-8');
    const body = extractMethodBody(fileContent, 'buildCreditNote');
    const found = extractThrowClasses(body).sort();
    const expected = Object.keys(EXPECTED_THROWS).sort();

    expect(
      found,
      'buildCreditNote() ganó o perdió un throw. Ver el docblock de este archivo (sección "SI ESTO ROMPE"): clasificalo DETERMINISTIC/TRANSIENT, y si es DETERMINISTIC sumalo también a CN-ESCAPE-ORPHAN-ADJUSTMENT-001 en docs/pendientes-2026-09-10.md antes de actualizar EXPECTED_THROWS acá.',
    ).toEqual(expected);
  });

  it('cada entrada de EXPECTED_THROWS tiene una nota no vacía (la clasificación no es una lista muda)', () => {
    const withoutNote = Object.entries(EXPECTED_THROWS).filter(([, v]) => !v.note || v.note.trim().length === 0);
    expect(withoutNote.map(([k]) => k)).toEqual([]);
  });
});
