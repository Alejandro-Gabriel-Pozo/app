import { z } from 'zod';

/**
 * Certificado AFIP — el negocio pega el contenido de los dos archivos que
 * le dio AFIP (o que él mismo generó junto al CSR). No se valida el
 * contenido PEM acá (eso lo hace WSAA en el primer intento de
 * autenticación real) — Zod solo garantiza que no llegue vacío.
 */
export const SaveAfipCredentialsSchema = z.object({
  cert: z.string().trim().min(1, 'El certificado (.crt) es obligatorio'),
  key: z.string().trim().min(1, 'La clave privada es obligatoria'),
  environment: z.enum(['homologacion', 'produccion']),
});

const BuyerSchema = z.object({
  docTipo: z.number().int().positive(),
  docNro: z.string().trim().min(1),
  condicionIvaReceptorId: z.number().int().positive(),
});

export const RequestInvoiceSchema = z.object({
  financialTransactionId: z.string().min(1),
  buyer: BuyerSchema.optional(),
  /** 1=Productos, 2=Servicios, 3=Ambos. Default Servicios si se omite. */
  concepto: z.number().int().min(1).max(3).optional(),
});

/** C1-Fase C (23/08/2026) — "Facturar ahora": un comprobante cubriendo todo lo PENDIENTE_FACTURAR de una empresa. */
export const RequestConsolidatedInvoiceSchema = z.object({
  companyCustomerId: z.string().min(1),
  buyer: BuyerSchema.optional(),
  concepto: z.number().int().min(1).max(3).optional(),
});

/**
 * Bloque 5 del ADR común cancelar-con-NC (15/09/2026, §6.5 bis) — body de
 * `POST /api/credit-note-requests/:id/resolve`. `cbteNro`/`cae`/`caeVto`
 * son obligatorios SOLO cuando `outcome === 'EMITIDA'` (el operador
 * encontró un CAE real a mano contra AFIP) — `.superRefine()`, no una
 * validación a mano en la ruta ni en el service (A6.2/A6.3: esa capa la
 * cubre `transitionWithClient()`, esta capa cubre la FORMA del request).
 * `caeVto` en formato `YYYY-MM-DD` — mismo formato que `Invoice.caeVto`
 * (`sql.invoice.repository.ts::rowToEntity()`, columna DATE de Postgres).
 */
/**
 * ADR ISSUE-BEFORE-REVERSE-WINDOW-001 (23/09/2026), Bloque 3, §3.14 (P-1) --
 * body de `POST /api/invoices/:id/reconcile-with-afip`. `cbteNro` es un
 * ÍNDICE que el sistema verifica contra AFIP (`getVoucherInfo()`), no el
 * CAE en sí -- el operador lo aporta porque el sistema no tiene forma de
 * identificar SOLO cuál comprobante de AFIP corresponde a esta factura
 * puntual (ver el docblock de `InvoiceService.reconcileWithAfip()`).
 */
export const ReconcileInvoiceWithAfipSchema = z.object({
  cbteNro: z.number().int().positive(),
});

export const CreditNoteRequestResolveSchema = z
  .object({
    outcome: z.enum(['EMITIDA', 'NO_EMITIDA']),
    note: z.string().trim().min(1).optional(),
    cbteNro: z.number().int().positive().optional(),
    cae: z.string().trim().min(1).optional(),
    caeVto: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'caeVto debe tener formato YYYY-MM-DD').optional(),
  })
  .superRefine((data, ctx) => {
    if (data.outcome !== 'EMITIDA') return;
    if (data.cbteNro === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cbteNro'], message: 'cbteNro es obligatorio cuando outcome es EMITIDA' });
    }
    if (data.cae === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cae'], message: 'cae es obligatorio cuando outcome es EMITIDA' });
    }
    if (data.caeVto === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['caeVto'], message: 'caeVto es obligatorio cuando outcome es EMITIDA' });
    }
  });
