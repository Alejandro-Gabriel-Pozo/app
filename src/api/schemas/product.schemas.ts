/**
 * @file product.schemas.ts
 * @description Schemas Zod para el body de POST/PUT de productos y
 * variantes (`products.routes.ts`). Antes de este archivo, esas cuatro
 * rutas pasaban `req.body` sin validar hasta el INSERT/UPDATE
 * parametrizado en `sql.product.repository.ts` — un tipo o campo
 * incorrecto no daba un 400 limpio, dependía de qué tolerara Postgres.
 * Los límites (VARCHAR(255), CHECK base_price >= 0, etc.) reflejan
 * 1:1 las columnas reales de `products`/`product_variants` en
 * `src/db/schema.sql` — no son arbitrarios.
 *
 * `stockQuantity`/`stockMinAlert` viajan en el body de creación (el
 * route las renombra a `initialStockQuantity`/`initialStockMinAlert`
 * antes de llamar al service, ver Fase 1 del carve-out de inventario en
 * `product.entities.ts`) — acá se validan con el nombre que el cliente
 * realmente manda.
 */

import { z } from 'zod';

const ProductTypeSchema = z.enum(['RAW_MATERIAL', 'COMPOSITE', 'RETAIL']);

export const CreateProductSchema = z.object({
  categoryId:       z.string().min(1).nullable().optional(),
  // name/basePrice son obligatorios para un alta local, pero NO cuando
  // viene companyProductId -- ahí products.routes.ts salta directo a
  // CompanyCatalogService.createLinkedProduct() (copia nombre/precio del
  // maestro de la empresa, el cliente no manda nada de eso). El refine de
  // abajo es el que de verdad exige name/basePrice en el caso normal.
  name:             z.string().min(1).max(255).optional(),
  description:      z.string().nullable().optional(),
  basePrice:        z.number().min(0).optional(),
  sku:              z.string().max(100).nullable().optional(),
  hasVariants:      z.boolean().optional(),
  stockQuantity:    z.number().min(0).optional(),
  stockMinAlert:    z.number().min(0).optional(),
  productType:      ProductTypeSchema.optional(),
  assembleOnDemand: z.boolean().optional(),
  ivaRate:          z.number().min(0).nullable().optional(),
  unit:             z.string().max(20).nullable().optional(),
  arcaUnitCode:     z.number().int().nullable().optional(),
  /** Empresas multipropiedad — id del producto canónico elegido del catálogo de la empresa. */
  companyProductId: z.string().min(1).optional(),
}).superRefine((b, ctx) => {
  if (!b.companyProductId) {
    if (!b.name) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'name es obligatorio salvo que mandes companyProductId.', path: ['name'] });
    if (b.basePrice === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'basePrice es obligatorio salvo que mandes companyProductId.', path: ['basePrice'] });
  }
  if (b.assembleOnDemand && b.productType !== 'COMPOSITE') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'assembleOnDemand solo puede ser true cuando productType es COMPOSITE (chk_products_assemble_on_demand).', path: ['assembleOnDemand'] });
  }
});

export const UpdateProductSchema = z.object({
  categoryId:       z.string().min(1).nullable().optional(),
  name:             z.string().min(1).max(255).optional(),
  description:      z.string().nullable().optional(),
  basePrice:        z.number().min(0).optional(),
  sku:              z.string().max(100).nullable().optional(),
  hasVariants:      z.boolean().optional(),
  active:           z.boolean().optional(),
  productType:      ProductTypeSchema.optional(),
  assembleOnDemand: z.boolean().optional(),
  ivaRate:          z.number().min(0).nullable().optional(),
  unit:             z.string().max(20).nullable().optional(),
  arcaUnitCode:     z.number().int().nullable().optional(),
});

export const CreateProductVariantSchema = z.object({
  name:             z.string().min(1).max(255),
  attributes:       z.record(z.string()).optional(),
  sku:              z.string().max(100).nullable().optional(),
  priceOverride:    z.number().min(0).nullable().optional(),
  stockQuantity:    z.number().min(0).optional(),
  stockMinAlert:    z.number().min(0).optional(),
});

export const UpdateProductVariantSchema = z.object({
  name:          z.string().min(1).max(255).optional(),
  attributes:    z.record(z.string()).optional(),
  sku:           z.string().max(100).nullable().optional(),
  priceOverride: z.number().min(0).nullable().optional(),
  active:        z.boolean().optional(),
});
