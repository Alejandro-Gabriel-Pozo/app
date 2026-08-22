/**
 * @file rate-catalog.repository.ts
 * @description Interfaz para el catálogo de tarifas reutilizables (D5,
 * pendientes-2026-08-19.md, decisión confirmada con el dueño 22/08/2026).
 *
 * MAESTRO: una fila = nombre + % de descuento sobre UN resource_id XOR UN
 * service_id (mismo grano que CustomerRate). `POST /customers/:id/rates`
 * con `rateCatalogId` crea una CustomerRate que REFERENCIA esta entrada —
 * es una referencia VIVA (decisión explícita del dueño, corregida el
 * mismo 22/08/2026 antes de cualquier deploy real): editar
 * `discountPercentage` acá cambia de inmediato lo que paga todo cliente ya
 * asignado, resuelto con JOIN en `sql.customer-rate.repository.ts`. Solo
 * `resourceId`/`serviceId` se copian a la `CustomerRate` al crearla — no
 * el %. `update()` queda auditado (`RateCatalogService`, entity
 * `rate_catalog` en `audit_log`) precisamente porque ese cambio mueve
 * plata de gente sin que nadie haya tocado a esos clientes ese día. Ver
 * db/schema.sql BLOQUE rate_catalog.
 */

export interface RateCatalogEntry {
  id: string;
  businessId: string;
  name: string;
  discountPercentage: number;
  resourceId: string | null;
  serviceId: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type CreateRateCatalogEntryDto = {
  id: string;
  businessId: string;
  name: string;
  discountPercentage: number;
} & (
  | { resourceId: string; serviceId?: undefined }
  | { resourceId?: undefined; serviceId: string }
);

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
}
