import { Customer } from '../domain/entities.js';
import { CustomerRepository } from './customer.repository.js';

/**
 * Implementación en memoria del repositorio de clientes.
 * Ideal para desarrollo y tests. No persiste entre reinicios.
 */
export class InMemoryCustomerRepository implements CustomerRepository {
  private customers: Map<string, Customer> = new Map();

  async save(customer: Customer): Promise<void> {
    this.customers.set(customer.id, customer);
  }

  async getById(id: string): Promise<Customer | undefined> {
    return this.customers.get(id);
  }

  async getAll(): Promise<Customer[]> {
    return Array.from(this.customers.values());
  }

  async getByEmail(email: string): Promise<Customer | undefined> {
    const lower = email.toLowerCase();
    return Array.from(this.customers.values()).find(
      (c) => c.email.toLowerCase() === lower,
    );
  }

  async searchByName(name: string): Promise<Customer[]> {
    const lower = name.toLowerCase();
    return Array.from(this.customers.values()).filter((c) =>
      c.fullName.toLowerCase().includes(lower),
    );
  }

  async delete(id: string): Promise<boolean> {
    return this.customers.delete(id);
  }
}
