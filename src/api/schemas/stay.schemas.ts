/**
 * @file stay.schemas.ts
 * @description Schemas Zod para POST /api/stays/check-in y check-out —
 * antes tomaban `req.body` crudo sin validar ninguno de sus campos.
 */

import { z } from 'zod';
import { TIME_ONLY_REGEX } from './common.schemas.js';

export const CheckInSchema = z.object({
  reservationId: z.string().min(1, 'reservationId es obligatorio'),
  resourceId: z.string().min(1, 'resourceId es obligatorio'),
  notes: z.string().max(500).optional(),
  /** Gating de check-in por limpieza (25/08/2026) — la ruta valida que quien lo pide sea MANAGEMENT antes de reenviarlo al servicio. */
  overrideHousekeeping: z.boolean().optional(),
});

export const CheckOutSchema = z.object({
  notes: z.string().max(500).optional(),
  nextCleaningShift: z.enum(['MORNING', 'AFTERNOON', 'NIGHT']).optional(),
  /** Warn-and-override de saldo pendiente (12/09/2026) — la ruta valida que quien lo pide sea MANAGEMENT antes de reenviarlo al servicio. */
  overridePendingBalance: z.boolean().optional(),
});

export const TransferToReceivableSchema = z.object({
  companyCustomerId: z.string().min(1, 'companyCustomerId es obligatorio'),
  notes: z.string().max(500).optional(),
});

/**
 * Horario de check-in/check-out fuera del estándar (18/08/2026,
 * pendientes-2026-08-18.md punto N). El propio comentario original acá
 * decía "si se agrega un tercer lugar que lo necesite, vale la pena
 * moverlo a un módulo compartido" — ese tercer lugar (y un cuarto y un
 * quinto) ya existían (auditoria-modularidad.md, DRY-1); ahora usa el
 * regex centralizado en common.schemas.ts.
 */
const timeOnly = z.string().regex(
  TIME_ONLY_REGEX,
  'Formato de hora inválido — usar HH:MM o HH:MM:SS',
);

export const RequestScheduleChangeSchema = z.object({
  requestedCheckInTime: timeOnly.optional(),
  requestedCheckOutTime: timeOnly.optional(),
}).refine(
  (data) => data.requestedCheckInTime !== undefined || data.requestedCheckOutTime !== undefined,
  { message: 'Debe pedirse una hora de check-in o de check-out' },
);

export const ApproveScheduleChangeSchema = z.object({
  chargeAmount: z.number().min(0).optional(),
});
