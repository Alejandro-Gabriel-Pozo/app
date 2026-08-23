/**
 * @file cancellation-policy.repository.ts
 * @description Tramos de % de reembolso según anticipación (C2,
 * docs/diseno-cancelacion-notas-credito-c2-2026-08-23.md). A diferencia de
 * `deposit_policies` (scope por ítem/categoría/bucket), acá el scope es un
 * solo eje: días de anticipación antes del check-in. Sin scope por
 * recurso/servicio -- el dueño pidió tramos por anticipación, no por ítem.
 */

export interface CancellationPolicy {
  id: string;
  businessId: string;
  minDaysBeforeCheckin: number;
  refundPercentage: number;
  active: boolean;
}

export interface CreateCancellationPolicyInput {
  businessId: string;
  minDaysBeforeCheckin: number;
  refundPercentage: number;
}

export interface UpdateCancellationPolicyInput {
  minDaysBeforeCheckin?: number;
  refundPercentage?: number;
  active?: boolean;
}

export interface CancellationPolicyRepository {
  findAll(businessId: string): Promise<CancellationPolicy[]>;

  /** No filtra por active -- ver docs/criterios-datos.md R2. */
  findById(id: string): Promise<CancellationPolicy | null>;

  create(input: CreateCancellationPolicyInput): Promise<CancellationPolicy>;

  update(id: string, input: UpdateCancellationPolicyInput): Promise<CancellationPolicy>;

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
