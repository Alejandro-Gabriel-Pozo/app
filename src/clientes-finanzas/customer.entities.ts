/**
 * @file customer.entities.ts
 * @description Entidad de dominio — bounded context de Clientes/Finanzas.
 *
 * Partido de `entities.ts` (15/08/2026, docs/arquitectura-monolito-modular.md
 * sección 4, paso 1 del plan de reorganización por dominio) — ese archivo
 * mezclaba tres bounded contexts (Customer, PhysicalResource, BookableService)
 * en un solo lugar, bloqueando cualquier otro movimiento del plan.
 *
 * ## Cambios v2 — Customer como agregado
 * - ContactMethod interface: canal de contacto tipado (EMAIL, PHONE, WHATSAPP)
 * - Constructor sobrecargado: acepta string (legacy) o ContactMethod[]
 * - Getters email/fullName para compatibilidad con código existente
 *
 * ## Cambios v3
 * - `email` getter retorna `string | undefined` en lugar de ''.
 */

import { InvalidCustomerError } from '../domain/errors.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ContactMethod {
  id: string;
  channel: 'EMAIL' | 'PHONE' | 'WHATSAPP';
  value: string;
  isPrimary: boolean;
  verifiedAt?: Date;
}

export class Customer {
  public readonly displayName: string;
  public readonly contactMethods: ContactMethod[];

  constructor(
    public readonly id: string,
    displayName: string,
    emailOrContacts: string | ContactMethod[] = [],
    /** v2 clientes especiales: INDIVIDUAL (default) o COMPANY */
    public readonly kind: 'INDIVIDUAL' | 'COMPANY' = 'INDIVIDUAL',
    /** v2 clientes especiales: cuenta activa (soft-delete usa esto) */
    public readonly active: boolean = true,
  ) {
    if (!id.trim()) throw new InvalidCustomerError('id es obligatorio');
    if (!displayName.trim()) throw new InvalidCustomerError('fullName es obligatorio');

    this.displayName = displayName;

    if (typeof emailOrContacts === 'string') {
      if (!EMAIL_PATTERN.test(emailOrContacts)) {
        throw new InvalidCustomerError('email inválido');
      }
      this.contactMethods = [
        { id: `ccm-${id}`, channel: 'EMAIL', value: emailOrContacts, isPrimary: true },
      ];
    } else {
      for (const cm of emailOrContacts) {
        if (cm.channel === 'EMAIL' && !EMAIL_PATTERN.test(cm.value)) {
          throw new InvalidCustomerError('email inválido');
        }
      }
      this.contactMethods = emailOrContacts;
    }
  }

  get email(): string | undefined {
    return (
      this.contactMethods.find((c) => c.channel === 'EMAIL' && c.isPrimary)?.value ??
      this.contactMethods.find((c) => c.channel === 'EMAIL')?.value
    );
  }

  /** Alias de displayName — compatibilidad con tests y servicios */
  get fullName(): string {
    return this.displayName;
  }
}
