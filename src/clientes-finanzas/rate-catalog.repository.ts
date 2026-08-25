/**
 * @file rate-catalog.repository.ts
 * @description Interfaz para el catálogo de tarifas reutilizables (D5,
 * pendientes-2026-08-19.md, decisión confirmada con el dueño 22/08/2026).
 *
 * MAESTRO: una fila = nombre + % de descuento sobre un SCOPE (mismo grano
 * que `CustomerRate` — desde D9-Parte 1, pendientes-2026-08-22.md, son 5
 * modos posibles, exactamente uno: `resourceId`/`serviceId`/`productId`
 * a nivel ÍTEM, `categoryId` a nivel CATEGORÍA, `bucket` a nivel BUCKET.
 * Ver customer-rate.repository.ts para el detalle completo de los 3
 * niveles). `POST /customers/:id/rates` con `rateCatalogId` crea una
 * CustomerRate que REFERENCIA esta entrada — es una referencia VIVA
 * (decisión explícita del dueño, corregida el mismo 22/08/2026 antes de
 * cualquier deploy real): editar `discountPercentage` acá cambia de
 * inmediato lo que paga todo cliente ya asignado, resuelto con JOIN en
 * `sql.customer-rate.repository.ts`. El SCOPE (no el %) sí se copia a la
 * `CustomerRate` al crearla. `update()` queda auditado (`RateCatalogService`,
 * entity `rate_catalog` en `audit_log`) precisamente porque ese cambio
 * mueve plata de gente sin que nadie haya tocado a esos clientes ese día.
 * Ver db/schema.sql BLOQUE rate_catalog / D9-Parte 1.
 */

import type { SqlClient } from '../repositories/sql.client.js';

export interface RateCatalogEntry {
  id: string;
  businessId: string;
  name: string;
  discountPercentage: number;
  resourceId: string | null;
  serviceId: string | null;
  /** Nivel ÍTEM nuevo (D9-Parte 1) — habilitado en la API desde D9-Parte 2. */
  productId: string | null;
  /** Nivel CATEGORÍA (D9-Parte 1). */
  categoryId: string | null;
  /** Nivel BUCKET (D9-Parte 1) — `'ALOJAMIENTO'|'TURNOS'|'SERVICIOS'|'PRODUCTOS'`. */
  bucket: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Exactamente uno de los 5 (`chk_rate_catalog_scope`, schema.sql) — Zod ya lo validó antes de llegar acá. */
export type CreateRateCatalogEntryDto = {
  id: string;
  businessId: string;
  name: string;
  discountPercentage: number;
  resourceId?: string;
  serviceId?: string;
  productId?: string;
  categoryId?: string;
  bucket?: string;
};

export interface UpdateRateCatalogEntryDto {
  name?: string | undefined;
  discountPercentage?: number | undefined;
}

export interface IRateCatalogRepository {
  findById(id: string, businessId: string): Promise<RateCatalogEntry | undefined>;
  listActiveByBusiness(businessId: string): Promise<RateCatalogEntry[]>;
  create(dto: CreateRateCatalogEntryDto): Promise<RateCatalogEntry>;
  /** Solo `name`/`discountPercentage` — el target (resourceId/serviceId) no se edita, se recrea la entrada si hace falta cambiarlo. */
  update(id: string, businessId: string, dto: UpdateRateCatalogEntryDto): Promise<RateCatalogEntry | undefined>;
  /** Soft — pone active=FALSE, no borra la fila (tarifas ya creadas la siguen referenciando). */
  deactivate(id: string, businessId: string): Promise<boolean>;

  /**
   * Igual que `update()`/`deactivate()`, pero contra un `client` explícito
   * — para que el UPDATE comparta transacción con el INSERT de auditoría
   * (`domain/audit.ts::updateWithAudit()`). Opcionales en la interfaz.
   */
  updateWithClient?(client: SqlClient, id: string, businessId: string, dto: UpdateRateCatalogEntryDto): Promise<RateCatalogEntry | undefined>;
  deactivateWithClient?(client: SqlClient, id: string, businessId: string): Promise<boolean>;
}
