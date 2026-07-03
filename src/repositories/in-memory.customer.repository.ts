import { Customer } from '../domain/entities.js';
import { CustomerRepository, CustomerWithPassword } from './customer.repository.js';

interface CustomerRecord {
  customer: Customer;
  passwordHash: string | null;
}

/**
 * Implementación in-memory del repositorio de clientes.
 * Almacena clientes con y sin contraseña (para el portal de clientes).
 */
export class InMemoryCustomerRepository implements CustomerRepository {
  private readonly store = new Map<string, CustomerRecord>();
  private readonly emailIndex = new Map<string, string>(); // email.lower → id

  async save(customer: Customer): Promise<void> {
    const existing = this.store.get(customer.id);
    const passwordHash = existing?.passwordHash ?? null;
    this.store.set(customer.id, { customer, passwordHash });
    this.emailIndex.set(customer.email.toLowerCase(), customer.id);
  }

  async saveWithPassword(customer: Customer, passwordHash: string): Promise<void> {
    this.store.set(customer.id, { customer, passwordHash });
    this.emailIndex.set(customer.email.toLowerCase(), customer.id);
  }

  async getById(id: string): Promise<Customer | undefined> {
    return this.store.get(id)?.customer;
  }

  async getAll(): Promise<Customer[]> {
    return Array.from(this.store.values()).map((r) => r.customer);
  }

  async getByEmail(email: string): Promise<Customer | undefined> {
    const id = this.emailIndex.get(email.toLowerCase());
    return id ? this.store.get(id)?.customer : undefined;
  }

  async getByEmailWithPassword(email: string): Promise<CustomerWithPassword | undefined> {
    const id = this.emailIndex.get(email.toLowerCase());
    if (!id) return undefined;
    const record = this.store.get(id);
    if (!record || record.passwordHash === null) return undefined;
    return { customer: record.customer, passwordHash: record.passwordHash };
  }

  async searchByName(name: string): Promise<Customer[]> {
    const q = name.toLowerCase();
    return Array.from(this.store.values())
      .map((r) => r.customer)
      .filter((c) => c.fullName.toLowerCase().includes(q));
  }

  async delete(id: string): Promise<boolean> {
    const record = this.store.get(id);
    if (!record) return false;
    this.emailIndex.delete(record.customer.email.toLowerCase());
    this.store.delete(id);
    return true;
  }

  /**
   * Anonimiza el cliente en memoria: reemplaza PII con valores neutros
   * y limpia el passwordHash. El registro permanece en el store para
   * que las reservas sigan apuntando a un ID válido.
   * La entrada en emailIndex se elimina (el email anonimizado no debe
   * ser buscable).
   */
  async anonymize(id: string): Promise<boolean> {
    const record = this.store.get(id);
    if (!record) return false;

    // Verificar que no esté ya anonimizado
    if (record.customer.email.startsWith('deleted-') && record.customer.email.endsWith('@anon.local')) {
      return false;
    }

    // Limpiar índice del email original
    this.emailIndex.delete(record.customer.email.toLowerCase());

    const anonymizedCustomer = new Customer(
      id,
      '[eliminado]',
      `deleted-${id}@anon.local`,
    );

    this.store.set(id, { customer: anonymizedCustomer, passwordHash: null });
    // No indexar el email anonimizado — no debe ser buscable
    return true;
  }
}
