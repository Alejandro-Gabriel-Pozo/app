/**
 * @file cancellation-policy.repository.ts
 * @description Tramos de % de reembolso según anticipación (C2,
 * docs/diseno-cancelacion-notas-credito-c2-2026-08-23.md). A diferencia de
 * `deposit_policies` (scope por ítem/categoría/bucket), acá el scope es un
 * solo eje: días de anticipación antes del check-in. Sin scope por
 * recurso/servicio -- el dueño pidió tramos por anticipación, no por ítem.
 */

import type { SqlClient } from '../repositories/sql.client.js';

/**
 * CANCEL-POLICY-SCOPE-BASE-001 (14/09/2026) -- decide, para el tramo, si el
 * % de reembolso se resuelve contra la política vigente al momento de
 * RESERVAR (`SNAPSHOT_AT_BOOKING`, default) o contra la tabla en vivo al
 * momento de CANCELAR (`LIVE_AT_CANCELLATION`, comportamiento previo a este
 * campo). Ver docblock en `src/db/schema.sql` para el razonamiento completo
 * -- incluye por qué el consumo real (congelar el ladder en `reservations`)
 * todavía NO existe: este campo hoy es de solo CRUD, sin efecto observable
 * en `CancellationRefundService` (Block 2, no implementado).
 *
 * (a) `LIVE_AT_CANCELLATION` es un opt-out deliberado, POR FILA, de la
 * regla R9 de `docs/criterios-datos.md` ("una transacción congela lo que
 * necesita del maestro que referencia"). El dueño lo pidió explícitamente
 * porque esto no es una decisión de sistema sino de la relación del
 * negocio con sus clientes -- algunos tramos/negocios prefieren que la
 * política de cancelación se resuelva siempre contra la regla vigente, no
 * contra una foto vieja, y R9 no debe forzar esa decisión de negocio.
 *
 * (b) Este Bloque 1 NO satisface R9 todavía para `SNAPSHOT_AT_BOOKING` --
 * el campo solo declara la intención. Nada congela nada hasta que exista
 * el Bloque 2 (`reservations.cancellation_policy_snapshot`, diseñado pero
 * sin implementar -- ver `docs/pendientes-2026-09-12.md`).
 *
 * (c) Hoy la API acepta y devuelve (echo) este campo sin que tenga ningún
 * efecto sobre una devolución real -- `CancellationRefundService` sigue
 * leyendo la tabla en vivo sin importar el valor guardado. La única razón
 * por la que esto es aceptable en este commit: verificado que ningún
 * frontend consume `/api/cancellation-policies` todavía (0 referencias en
 * `appfrontend/src`).
 */
export type PolicyResolutionTiming = 'SNAPSHOT_AT_BOOKING' | 'LIVE_AT_CANCELLATION';

export interface CancellationPolicy {
  id: string;
  businessId: string;
  minDaysBeforeCheckin: number;
  refundPercentage: number;
  active: boolean;
  policyResolutionTiming: PolicyResolutionTiming;
}

export interface CreateCancellationPolicyInput {
  businessId: string;
  minDaysBeforeCheckin: number;
  refundPercentage: number;
  /** Omitido -- default de la BD, `SNAPSHOT_AT_BOOKING` (ver schema.sql). */
  policyResolutionTiming?: PolicyResolutionTiming;
}

export interface UpdateCancellationPolicyInput {
  minDaysBeforeCheckin?: number;
  refundPercentage?: number;
  active?: boolean;
  policyResolutionTiming?: PolicyResolutionTiming;
}

export interface CancellationPolicyRepository {
  findAll(businessId: string): Promise<CancellationPolicy[]>;

  /** No filtra por active -- ver docs/criterios-datos.md R2. */
  findById(id: string): Promise<CancellationPolicy | null>;

  create(input: CreateCancellationPolicyInput): Promise<CancellationPolicy>;

  update(id: string, input: UpdateCancellationPolicyInput): Promise<CancellationPolicy>;

  /**
   * Igual que `update()`, pero contra un `client` explícito — para que el
   * UPDATE comparta transacción con el INSERT de auditoría
   * (`domain/audit.ts::updateWithAudit()`). Opcional en la interfaz.
   */
  updateWithClient?(client: SqlClient, id: string, input: UpdateCancellationPolicyInput): Promise<CancellationPolicy>;

  /** Soft-delete: active = false. */
  deactivate(id: string): Promise<void>;

  /**
   * El tramo aplicable para una anticipación real -- el `minDaysBeforeCheckin`
   * más alto que sea `<=` `daysBeforeCheckin` (ladder: cuanto antes se
   * cancela, mejor tramo). `null` si ningún tramo activo aplica (incluida
   * la anticipación negativa, cancelar después del check-in, sin tramo
   * `min_days_before_checkin = 0` configurado) -- sin política aplicable,
   * el caller no reembolsa nada (mismo criterio que `deposit_policies`).
   */
  findApplicableTier(businessId: string, daysBeforeCheckin: number): Promise<CancellationPolicy | null>;
}
