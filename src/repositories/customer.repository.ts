import { Customer } from '../domain/entities.js';

/**
 * Registro de cliente con contraseña (solo para autenticación interna).
 * Nunca se expone en respuestas de la API.
 */
export interface CustomerWithPassword {
  customer: Customer;
  passwordHash: string;
}

/**
 * Contrato del repositorio de clientes.
 *
 * La mayoría de métodos trabajan con `Customer` sin contraseña.
 * `saveWithPassword` y `getByEmailWithPassword` son exclusivos del
 * flujo de autenticación del portal de clientes.
 */
export interface CustomerRepository {
  save(customer: Customer): Promise<void>;

  /**
   * Persiste un cliente junto con su password hash.
   * Usado exclusivamente por CustomerAuthService al registrar un cliente nuevo.
   */
  saveWithPassword(customer: Customer, passwordHash: string): Promise<void>;

  getById(id: string): Promise<Customer | undefined>;
  getAll(): Promise<Customer[]>;
  getByEmail(email: string): Promise<Customer | undefined>;

  /**
   * Devuelve el cliente junto con su password hash para verificación.
   * Solo para uso interno de CustomerAuthService — nunca exponer al cliente.
   */
  getByEmailWithPassword(email: string): Promise<CustomerWithPassword | undefined>;

  searchByName(name: string): Promise<Customer[]>;
  delete(id: string): Promise<boolean>;

  /**
   * Anonimiza (pseudo-elimina) un cliente.
   *
   * En lugar de borrar el registro — lo cual rompería la integridad referencial
   * con las reservas existentes — reemplaza todos los datos personales con
   * valores neutros y elimina el password hash, impidiendo futuros logins.
   *
   * Datos que se limpian:
   * - `full_name`     → '[eliminado]'
   * - `email`         → 'deleted-{id}@anon.local'
   * - `password_hash` → NULL
   *
   * El ID del cliente se preserva para mantener el historial de reservas.
   *
   * @returns `true` si el cliente existía y fue anonimizado, `false` si no existía.
   */
  anonymize(id: string): Promise<boolean>;
}
