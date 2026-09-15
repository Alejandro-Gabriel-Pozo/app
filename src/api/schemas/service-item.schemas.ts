/**
 * @file service-item.schemas.ts
 * @description Schemas Zod para el body de POST/PUT del catálogo de
 * service_items (`service-items.routes.ts`). Mismo criterio que
 * `product.schemas.ts`/`waste.schemas.ts`: un archivo por dominio, no el
 * grab-bag `request.schemas.ts` — los límites reflejan 1:1 las columnas
 * reales de `service_items` en `src/db/schema.sql` (BLOQUE 23).
 */

import { z } from 'zod';

export const CreateServiceItemSchema = z.object({
  categoryId:  z.string().min(1).nullable().optional(),
  name:        z.string().min(1).max(255),
  description: z.string().nullable().optional(),
  // CHECK (price >= 0) en la tabla real -- validado acá también para un 400
  // claro en vez de dejar que la BD lo rechace con un error de constraint.
  price:       z.number().min(0),
});

export const UpdateServiceItemSchema = z.object({
  categoryId:  z.string().min(1).nullable().optional(),
  name:        z.string().min(1).max(255).optional(),
  description: z.string().nullable().optional(),
  price:       z.number().min(0).optional(),
  active:      z.boolean().optional(),
});
