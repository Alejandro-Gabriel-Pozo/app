import { randomUUID } from 'node:crypto';
import { Customer } from '../domain/entities.js';
import type { CustomerRepository, CustomerWithPassword, Tag } from './customer.repository.js';
import type { SqlClient } from './sql.client.js';

interface CustomerRecord {
  customer: Customer;
  passwordHash: string | null;
  googleSub: string | null;
}

/**
 * Implementación in-memory del repositorio de clientes.
 * Almacena clientes con y sin contraseña (para el portal de clientes).
 */
export class InMemoryCustomerRepository implements CustomerRepository {
  private readonly store = new Map<string, CustomerRecord>();
  private readonly emailIndex = new Map<string, string>(); // email.lower → id
  private readonly googleSubIndex = new Map<string, string>(); // google_sub → id
  private readonly tags = new Map<string, Tag>(); // tagId → Tag
  private readonly customerTags = new Map<string, Set<string>>(); // customerId → Set<tagId>

  async save(customer: Customer): Promise<void> {
    const existing = this.store.get(customer.id);
    const passwordHash = existing?.passwordHash ?? null;
    const googleSub = existing?.googleSub ?? null;
    this.store.set(customer.id, { customer, passwordHash, googleSub });
    const email = customer.email;
    if (email) this.emailIndex.set(email.toLowerCase(), customer.id);
  }

  async saveWithPassword(customer: Customer, passwordHash: string): Promise<void> {
    const existing = this.store.get(customer.id);
    this.store.set(customer.id, { customer, passwordHash, googleSub: existing?.googleSub ?? null });
    const email = customer.email;
    if (email) this.emailIndex.set(email.toLowerCase(), customer.id);
  }

  async getByGoogleSub(sub: string): Promise<Customer | undefined> {
    const id = this.googleSubIndex.get(sub);
    return id ? this.store.get(id)?.customer : undefined;
  }

  async linkGoogleSub(customerId: string, sub: string): Promise<void> {
    const record = this.store.get(customerId);
    if (!record) return;
    this.store.set(customerId, { ...record, googleSub: sub });
    this.googleSubIndex.set(sub, customerId);
  }

  async saveWithGoogle(customer: Customer, googleSub: string): Promise<void> {
    const existing = this.store.get(customer.id);
    this.store.set(customer.id, { customer, passwordHash: existing?.passwordHash ?? null, googleSub });
    const email = customer.email;
    if (email) this.emailIndex.set(email.toLowerCase(), customer.id);
    this.googleSubIndex.set(googleSub, customer.id);
  }

  async saveWithClient(
    _client: SqlClient,
    customer: Customer,
    passwordHash: string,
  ): Promise<void> {
    await this.saveWithPassword(customer, passwordHash);
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
    const email = record.customer.email;
    if (email) this.emailIndex.delete(email.toLowerCase());
    this.store.delete(id);
    return true;
  }

  async anonymize(id: string): Promise<boolean> {
    const record = this.store.get(id);
    if (!record) return false;

    const currentEmail = record.customer.email ?? '';
    if (
      currentEmail.startsWith('deleted-') &&
      currentEmail.endsWith('@anon.local')
    ) {
      return false;
    }

    if (currentEmail) this.emailIndex.delete(currentEmail.toLowerCase());
    if (record.googleSub) this.googleSubIndex.delete(record.googleSub);

    const anonymizedCustomer = new Customer(
      id,
      '[eliminado]',
      `deleted-${id}@anon.local`,
    );

    // googleSub también se limpia -- A7.4 (anonimizar de verdad, no dejar
    // ningún identificador externo vivo que pueda re-vincular la cuenta).
    this.store.set(id, { customer: anonymizedCustomer, passwordHash: null, googleSub: null });
    return true;
  }

  // ── Clientes especiales (kind/active/tags) ──────────────────────────────

  async updateKindAndActive(customerId: string, kind: 'INDIVIDUAL' | 'COMPANY', active: boolean): Promise<void> {
    const record = this.store.get(customerId);
    if (!record) return;
    const updated = new Customer(
      record.customer.id,
      record.customer.displayName,
      record.customer.contactMethods,
      kind,
      active,
    );
    this.store.set(customerId, { customer: updated, passwordHash: record.passwordHash, googleSub: record.googleSub });
  }

  async getTagsByCustomerId(customerId: string): Promise<Tag[]> {
    const ids = this.customerTags.get(customerId) ?? new Set<string>();
    return Array.from(ids)
      .map((id) => this.tags.get(id))
      .filter((t): t is Tag => t !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getAllTags(): Promise<Tag[]> {
    return Array.from(this.tags.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  async findOrCreateTagByName(name: string): Promise<Tag> {
    const existing = Array.from(this.tags.values()).find((t) => t.name === name);
    if (existing) return existing;
    const tag: Tag = { id: `tag-${randomUUID()}`, name };
    this.tags.set(tag.id, tag);
    return tag;
  }

  async addTag(customerId: string, tagId: string): Promise<void> {
    if (!this.customerTags.has(customerId)) this.customerTags.set(customerId, new Set());
    this.customerTags.get(customerId)!.add(tagId);
  }

  async removeTag(customerId: string, tagId: string): Promise<void> {
    this.customerTags.get(customerId)?.delete(tagId);
  }
}
