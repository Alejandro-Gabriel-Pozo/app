import type { Customer } from '../domain/customer.entities.js';
import type { SqlClient } from './sql.client.js';

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
}
