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
