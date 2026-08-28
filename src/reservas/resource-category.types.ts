/**
 * @file resource-category.types.ts
 * @description Tipos de dominio para categorías de recursos.
 *
 * Una ResourceCategory define un tipo de producto reservable creado
 * por el negocio en runtime (p.ej. "Cabaña", "Turno de baño", "Mesa").
 * Reemplaza el enum ResourceType hardcodeado.
 *
 * El campo `fields` describe el formulario de preferencias que el cliente
 * completa al reservar. El servidor valida `details` en la reserva contra
 * estos campos en tiempo de ejecución.
 */

/** Tipos de campo soportados en el formulario de reserva */
export type CategoryFieldType = 'text' | 'number' | 'select' | 'boolean' | 'date';

/** Definición de un campo del formulario de reserva */
export interface CategoryField {
  name: string;              // clave del campo en el objeto details
  label: string;             // texto visible al usuario
  type: CategoryFieldType;
  required: boolean;
  options?: string[];        // solo para type === 'select'
}

/** Entidad de dominio */
export interface ResourceCategory {
  id: string;
  name: string;
  description?: string;
  fields: CategoryField[];
  active: boolean;
  /**
   * Backlog E1 (13/08/2026, decisión de alcance completo 18/08) — separa el
   * panel de Estadías/PMS del de Turnos/servicios. true = esta categoría
   * agrupa recursos de alojamiento (habitaciones, cabañas — se reservan con
   * "Reservas" y se gestionan con check-in/check-out en Estadías). false =
   * todo lo demás (sillas de peluquería, mesas, canchas — se reservan como
   * "Turnos"). Default false porque no hay forma de inferir esto en
   * categorías ya existentes — el dueño tiene que marcarlas a mano.
   */
  isLodging: boolean;
  /**
   * Bug 1/Bug 2 (25/08/2026, docs/auditoria-tecnica-infra-reservas.md) —
   * decisión explícita del dueño: NO reutilizar `isLodging` para esto.
   * Pricing (`isLodging`, tarifa por noche) y exclusividad de reserva
   * (`isExclusive`, capacidad=1 sin importar `resources.capacity`) son dos
   * ejes de negocio distintos que hoy coinciden 1:1 (toda categoría de
   * alojamiento es también exclusiva) pero no tienen por qué seguir
   * coincidiendo — a futuro puede haber recursos exclusivos que no son
   * alojamiento (eventos, alquileres por hora). true = uso exclusivo
   * (`checkAvailability()` binaria, cualquier solapamiento bloquea, mismo
   * comportamiento que ya existía). false = cupo compartido (`capacity`
   * real, varias reservas conviven hasta llenarlo — tours, clases). Default
   * false, backfill copiando `isLodging` al agregar la columna (coinciden
   * hoy) — igual que `isLodging`, requiere revisión manual antes de que el
   * negocio confíe en el valor.
   */
  isExclusive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** DTO para crear una categoría */
export interface CreateCategoryDTO {
  id: string;
  name: string;
  description?: string;
  fields: CategoryField[];
  isLodging?: boolean;
  /**
   * Obligatorio desde 28/08/2026 (docs/diseno-taxonomia-tipos-reserva-2026-08-28.md
   * §5) -- ya no tiene default silencioso ni en el schema ni en el
   * repositorio. Antes de esto no había NINGÚN control en la UI para este
   * campo, así que toda categoría de Turnos quedaba en `false` (cupo
   * compartido) sin que nadie lo hubiera elegido -- caso real: Peluquería
   * y Spa de biz-demo-01.
   */
  isExclusive: boolean;
}

/** DTO para actualizar una categoría */
export interface UpdateCategoryDTO {
  name?: string;
  description?: string;
  fields?: CategoryField[];
  active?: boolean;
  isLodging?: boolean;
  isExclusive?: boolean;
}
