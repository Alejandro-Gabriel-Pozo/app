import type { Customer } from './customer.entities.js';
import type { SqlClient } from '../repositories/sql.client.js';

/**
 * Registro de cliente con contraseña (solo para autenticación interna).
 * Nunca se expone en respuestas de la API.
 */
export interface CustomerWithPassword {
  customer: Customer;
  passwordHash: string;
}

export interface Tag {
  id: string;
  name: string;
}

/** D7 (22/08/2026) — ver docblock de getNewVsRecurringReport() para las definiciones. */
export interface NewVsRecurringReport {
  newCustomersCount: number;
  recurringCustomersCount: number;
  activeCustomersCount: number;
}

/**
 * Contrato del repositorio de clientes.
 */
export interface CustomerRepository {
  save(customer: Customer): Promise<void>;

  /**
   * Persiste un cliente junto con su password hash.
   * Usado por CustomerAuthService al registrar un cliente nuevo.
   */
  saveWithPassword(customer: Customer, passwordHash: string): Promise<void>;

  /**
   * Versión transaccional de saveWithPassword().
   * Recibe un SqlClient ya dentro de BEGIN — no adquiere conexión propia.
   * Llamar solo desde dentro de withTransaction() de db/pg.client.ts.
   */
  saveWithClient(client: SqlClient, customer: Customer, passwordHash: string): Promise<void>;

  getById(id: string): Promise<Customer | undefined>;
  getAll(): Promise<Customer[]>;
  getByEmail(email: string): Promise<Customer | undefined>;

  /**
   * Devuelve el cliente junto con su password hash para verificación.
   * Solo para uso interno de CustomerAuthService — nunca exponer al cliente.
   */
  getByEmailWithPassword(email: string): Promise<CustomerWithPassword | undefined>;

  // ── Login con Google del portal (punto 5/E5, 15/08/2026) ────────────────

  /** Matchea por `google_sub` — estable de por vida, ver schema.sql para el porqué. */
  getByGoogleSub(sub: string): Promise<Customer | undefined>;

  /** Primer login con Google de un customer ya existente (manual o con password) — vincula el `sub`. */
  linkGoogleSub(customerId: string, sub: string): Promise<void>;

  /**
   * Alta por Google Sign-In — sin password (a diferencia de
   * saveWithPassword). Solo para customers genuinamente nuevos, nunca
   * llamar si ya existe uno con ese email (usar linkGoogleSub en ese caso).
   */
  saveWithGoogle(customer: Customer, googleSub: string): Promise<void>;

  searchByName(name: string): Promise<Customer[]>;

  /**
   * Busca por CUIT/CUIL/DNI (`customer_tax_profiles.tax_id`), normalizado
   * sin guiones (mismo criterio que `cuitSchema`, `api/schemas/common.schemas.ts`).
   * Match EXACTO, no parcial (a diferencia de `searchByName`) -- es un
   * identificador preciso, no texto libre. Devuelve un array, no un único
   * `Customer`, porque `tax_id` no tiene unicidad a nivel de base (solo hay
   * un perfil fiscal POR cliente, `customer_tax_profiles_customer_uniq` --
   * nada impide que dos clientes distintos terminen con el mismo CUIT/DNI
   * cargado por error de tipeo, y ocultar ese duplicado sería peor que
   * mostrarlo).
   */
  searchByTaxId(taxId: string): Promise<Customer[]>;

  delete(id: string): Promise<boolean>;

  /**
   * Anonimiza (pseudo-elimina) un cliente.
   * Reemplaza PII con valores neutros y elimina el password hash.
   * El ID se preserva para mantener integridad referencial con reservas.
   */
  anonymize(id: string): Promise<boolean>;

  // ── Clientes especiales (kind/active/tags) ──────────────────────────────

  /**
   * Actualiza kind/active directamente — a propósito NO pasa por save()/
   * _upsertCustomer(), que no toca estas columnas para no resetearlas a los
   * defaults en cada guardado de displayName/contactMethods.
   */
  updateKindAndActive(customerId: string, kind: 'INDIVIDUAL' | 'COMPANY', active: boolean): Promise<void>;

  getTagsByCustomerId(customerId: string): Promise<Tag[]>;
  getAllTags(): Promise<Tag[]>;
  findOrCreateTagByName(name: string): Promise<Tag>;
  addTag(customerId: string, tagId: string): Promise<void>;
  removeTag(customerId: string, tagId: string): Promise<void>;

  /**
   * D7 (22/08/2026, pendientes-2026-08-19.md sección D) — reporte CRM.
   * Decisiones confirmadas con el dueño (`AskUserQuestion`, 22/08/2026):
   * "activo en el período" = tuvo al menos una reserva u orden CONFIRMED/
   * COMPLETED en [from, to]. De ESE conjunto: "nuevo" = su `created_at`
   * también cae en [from, to] (se dio de alta y compró en la misma
   * ventana). "Recurrente" = tiene más de una reserva/orden CONFIRMED/
   * COMPLETED en TODA su historia (no limitado al rango — es un estado
   * del cliente, no del período). Un cliente puede no caer en ninguna de
   * las dos categorías (ej. se registró antes del período y esta es su
   * única compra de siempre) — no son categorías exhaustivas.
   */
  getNewVsRecurringReport(from: Date, to: Date): Promise<NewVsRecurringReport>;
}
