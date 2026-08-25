/**
 * @file report.schemas.ts
 * @description Schemas Zod para el query string de `reports.routes.ts`.
 * Las 11 rutas hacían `new Date(req.query.from as string)` directo, sin
 * chequear que `from`/`to` existan ni que tengan formato de fecha — sin
 * `from`, `new Date(undefined)` da `Invalid Date` en silencio (no un
 * 400) y el reporte sale calculado con basura. `DateRangeQuerySchema` es
 * la base común (nivel 2 de cobertura de Zod, 25/08/2026,
 * docs/auditoria-tecnica-infra-reservas.md).
 */

import { z } from 'zod';
import { dateOnlySchema } from './common.schemas.js';

export const DateRangeQuerySchema = z.object({
  from: dateOnlySchema,
  to: dateOnlySchema,
});

export const OccupancySummaryQuerySchema = DateRangeQuerySchema.extend({
  limit: z.coerce.number().int().min(1).optional(),
});

export const UnderutilizedQuerySchema = DateRangeQuerySchema.extend({
  threshold: z.coerce.number().min(0).optional(),
});

export const PurgeQuerySchema = z.object({
  before: dateOnlySchema,
});
