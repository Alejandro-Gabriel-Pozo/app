/**
 * @file business-profile.service.ts
 * @description D3 (pendientes-2026-08-19.md) — el perfil fiscal del
 * negocio (razón social, CUIT, condición IVA, domicilio fiscal) hasta acá
 * era un GET/PUT plano bajo Roles.MANAGEMENT, sin bloqueo tras la primera
 * carga ni auditoría. Patrón de referencia: `afip-credentials.repository.ts`
 * separa `getStatus()` de `getDecrypted()` para que un secreto no pueda
 * salir por el camino equivocado — acá el dato no es un secreto (es
 * información pública del negocio, ya viaja entera en GET), así que el
 * mecanismo es otro: no una separación de LECTURA, sino una restricción de
 * ESCRITURA que se activa sola una vez que el perfil fiscal ya se cargó.
 *
 * ## Regla (interpretación de "inmutables tras confirmación")
 * "Confirmado" = `taxId` (CUIT) ya no es null. Antes de esa primera carga,
 * el perfil fiscal completo sigue editable por cualquier Roles.MANAGEMENT
 * (alta inicial, sin fricción). Después, CAMBIAR el VALOR de cualquier
 * campo de `FISCAL_FIELDS` exige `isOwner=true` (Roles.OWNER_ONLY, resuelto
 * en la capa HTTP — este servicio no conoce roles, solo la regla). El gate
 * mira el diff real (mismo `diffFields` que arma la auditoría), no si el
 * campo vino en el body: el frontend reenvía el formulario entero en cada
 * submit, así que "presente en el patch" siempre sería true y bloquearía
 * incluso un cambio de `pricesIncludeIva` sin tocar nada fiscal. No es un
 * lock permanente: el propio dueño siempre puede corregir un error real
 * (razón social mal tipeada, domicilio viejo). Un ADMIN no-dueño ya no
 * puede tocarlo solo, y si el dueño lo cambia, queda auditado (abajo).
 * Un solo campo (CUIT) como señal de "ya confirmado" en vez de exigir los
 * 11 campos completos — más simple, y es el campo del que depende
 * facturar de verdad.
 *
 * ## Auditoría
 * Se audita el diff COMPLETO de cada `update()` (no solo los campos
 * fiscales) — mismo criterio que `CategoryService.updateCategory()`: es
 * la misma entidad (`business_profile`), no tiene sentido tener rastro
 * parcial de una mitad de sus campos y no de la otra.
 */

import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { AuditLogRepository } from '../repositories/audit-log.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { BusinessProfile, UpdateBusinessProfileInput } from './business-profile.entities.js';
import { diffFields, updateWithAudit } from './audit.js';
import { FiscalProfileLockedError } from './errors.js';

const AUDIT_ENTITY = 'business_profile';

const FISCAL_FIELDS = [
  'legalName', 'taxId', 'taxIdType', 'taxCondition',
  'fiscalAddressLine1', 'fiscalAddressCity', 'fiscalAddressState',
  'fiscalAddressPostalCode', 'fiscalAddressCountry',
  'afipSalesPoint', 'afipCuit',
] as const satisfies readonly (keyof UpdateBusinessProfileInput)[];

export class BusinessProfileService {
  constructor(
    private readonly repository: BusinessProfileRepository,
    private readonly auditLogRepository: AuditLogRepository,
    private readonly transactionManager: TransactionManager,
  ) {}

  async get(): Promise<BusinessProfile> {
    return this.repository.get();
  }

  /**
   * `changedBy` es el identity_id (JWT sub) de quien hace el cambio (R8).
   * `isOwner` ya viene resuelto por la capa HTTP (permissionGroups
   * incluye Roles.OWNER_ONLY) — ver docblock del archivo.
   */
  async update(
    input: UpdateBusinessProfileInput,
    changedBy: string,
    isOwner: boolean,
  ): Promise<BusinessProfile> {
    const current = await this.repository.get();

    // Un solo diff, reusado para las dos cosas: el gate de abajo mira SOLO
    // los campos fiscales que de verdad CAMBIAN de valor (no que el patch
    // los incluya sin más -- el frontend reenvía el formulario entero en
    // cada submit, así que "está presente en el body" siempre sería true
    // y bloquearía guardar hasta un cambio de `pricesIncludeIva` solo).
    const changes = diffFields(current, input);
    const touchesFiscalFields = changes.some((c) => (FISCAL_FIELDS as readonly string[]).includes(c.field));
    const fiscalProfileConfirmed = current.taxId !== null;

    if (touchesFiscalFields && fiscalProfileConfirmed && !isOwner) {
      throw new FiscalProfileLockedError();
    }

    if (!this.repository.updateWithClient) {
      throw new Error('BusinessProfileRepository.updateWithClient no está implementado.');
    }
    const updateWithClient = this.repository.updateWithClient.bind(this.repository);

    return updateWithAudit(
      this.transactionManager,
      this.auditLogRepository,
      AUDIT_ENTITY,
      current.id,
      changedBy,
      changes,
      (client) => updateWithClient(client, input),
    );
  }
}
