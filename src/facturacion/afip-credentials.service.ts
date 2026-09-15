/**
 * @file afip-credentials.service.ts
 * @description Orquesta transacción + auditoría para guardar/borrar el
 * certificado y la clave privada de AFIP (F2-05 + F2-06,
 * `docs/decisiones-auditoria-fase2-2026-09-15.md` #1).
 *
 * Hasta esta sesión, `SqlAfipCredentialsRepository.save()`/`clear()` hacían
 * dos escrituras sueltas contra `this.db` (UPDATE de `business_profile` +
 * DELETE de `afip_tickets`), sin transacción compartida y sin auditar --
 * un fallo entre las dos dejaba el certificado guardado con tickets viejos
 * cacheados (o el certificado borrado con tickets todavía vivos), y ningún
 * cambio de credencial fiscal quedaba en `audit_log`.
 *
 * Este servicio es el molde de `domain/business-profile.service.ts`
 * aplicado acá: el repositorio queda como acceso a datos puro
 * (`saveWithClient()`/`clearWithClient()`, sin decidir nada de negocio) y
 * este servicio decide QUÉ se audita y envuelve la escritura + el rastro
 * en una sola transacción vía `domain/audit.ts::updateWithAudit()`.
 *
 * ## Qué se audita (y qué NO)
 * Nunca el valor real del certificado/clave -- ni siquiera cifrado. Se
 * audita el HECHO del cambio, como booleano/metadata:
 * - `afipCredentialsConfigured`: si había o no certificado configurado
 *   antes de esta llamada, contra el estado resultante (`true` en
 *   `save()`, `false` en `clear()`).
 * - `afipEnvironment`: el ambiente (`homologacion`/`produccion`) antes de
 *   esta llamada, contra el ambiente resultante (`null` en `clear()`).
 *
 * A diferencia de `diffFields()` (que solo registra un campo si el VALOR
 * cambia), acá las dos filas se graban SIEMPRE que `save()`/`clear()` se
 * llaman -- aunque el ambiente y el flag `configured` queden igual (ej.
 * rotar el certificado sin cambiar de ambiente). El contenido del
 * certificado SÍ cambió -- ese es el hecho relevante para un secreto
 * fiscal (A6.5: "una cancelación sin rastro no es aceptable", mismo
 * criterio acá para una rotación de credencial sin rastro) -- y no hay
 * forma de reflejarlo en el diff booleano/ambiente sin exponer el
 * contenido. Es una decisión deliberada, no un olvido de `diffFields()`.
 */

import type { AuditLogRepository } from '../repositories/audit-log.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { FieldChange } from '../domain/audit.js';
import { updateWithAudit } from '../domain/audit.js';
import type { AfipCredentialsRepository, AfipCredentialsStatus, AfipEnvironment } from './afip-credentials.repository.js';

/** Misma entidad/id que `BusinessProfileService` -- ambas tocan la fila singleton `business_profile`. */
const AUDIT_ENTITY = 'business_profile';
const AUDIT_ENTITY_ID = 'default';

export class AfipCredentialsService {
  constructor(
    private readonly repository: AfipCredentialsRepository,
    private readonly auditLogRepository: AuditLogRepository,
    private readonly transactionManager: TransactionManager,
  ) {}

  /** `changedBy` es el identity_id (JWT sub) de quien hace el cambio (R8). */
  async save(cert: string, key: string, environment: AfipEnvironment, changedBy: string): Promise<AfipCredentialsStatus> {
    const before = await this.repository.getStatus();
    const changes: FieldChange[] = [
      { field: 'afipCredentialsConfigured', oldValue: before.configured, newValue: true },
      { field: 'afipEnvironment', oldValue: before.environment, newValue: environment },
    ];

    if (!this.repository.saveWithClient) {
      throw new Error('AfipCredentialsRepository.saveWithClient no está implementado.');
    }
    const saveWithClient = this.repository.saveWithClient.bind(this.repository);

    await updateWithAudit(
      this.transactionManager,
      this.auditLogRepository,
      AUDIT_ENTITY,
      AUDIT_ENTITY_ID,
      changedBy,
      changes,
      (client) => saveWithClient(client, cert, key, environment),
    );

    return this.repository.getStatus();
  }

  async clear(changedBy: string): Promise<void> {
    const before = await this.repository.getStatus();
    const changes: FieldChange[] = [
      { field: 'afipCredentialsConfigured', oldValue: before.configured, newValue: false },
      { field: 'afipEnvironment', oldValue: before.environment, newValue: null },
    ];

    if (!this.repository.clearWithClient) {
      throw new Error('AfipCredentialsRepository.clearWithClient no está implementado.');
    }
    const clearWithClient = this.repository.clearWithClient.bind(this.repository);

    await updateWithAudit(
      this.transactionManager,
      this.auditLogRepository,
      AUDIT_ENTITY,
      AUDIT_ENTITY_ID,
      changedBy,
      changes,
      (client) => clearWithClient(client),
    );
  }
}
