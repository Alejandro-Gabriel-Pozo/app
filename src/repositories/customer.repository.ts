import { Customer } from '../domain/entities.js';

/**
 * Interfaz de repositorio para clientes.
 * Implementaciones:
 * - InMemoryCustomerRepository (dev/tests)
 * - SqlCustomerRepository (PostgreSQL)
 *
 * Nota: Crítico para deserializar reservaciones desde la BD.
 */
export interface CustomerRepository {
  /** Obtiene un cliente por ID. */
  getById(id: string): Promise<Customer | undefined>;

  /** Obtiene todos los clientes. */
  getAll(): Promise<Customer[]>;

  /** Obtiene un cliente por email (case-insensitive). */
  getByEmail(email: string): Promise<Customer | undefined>;

  /** Búsqueda parcial por nombre. */
  searchByName(name: string): Promise<Customer[]>;

  /** Guarda o actualiza un cliente (upsert). */
  save(customer: Customer): Promise<void>;

  /** Elimina un cliente por ID. */
  delete(id: string): Promise<boolean>;
}
