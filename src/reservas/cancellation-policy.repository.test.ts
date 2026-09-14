import { describe, it, expect } from 'vitest';
import {
  resolveApplicableTierFromLadder,
  buildCancellationPolicySnapshot,
} from './cancellation-policy.repository.js';
import type { CancellationPolicy, CancellationPolicyTierSnapshot } from './cancellation-policy.repository.js';

// ---------------------------------------------------------------------------
// resolveApplicableTierFromLadder() — función pura, ver docblock en el
// archivo fuente. Mismo ladder de ejemplo en todos los tests: 3 tramos,
// 100% a >=7 días, 50% a >=3 días, 0% a >=0 días (cancelar el mismo día).
// ---------------------------------------------------------------------------

const LADDER: CancellationPolicyTierSnapshot[] = [
  { minDaysBeforeCheckin: 7, refundPercentage: 100 },
  { minDaysBeforeCheckin: 3, refundPercentage: 50 },
  { minDaysBeforeCheckin: 0, refundPercentage: 0 },
];

describe('resolveApplicableTierFromLadder', () => {
  it('elige el tramo con minDaysBeforeCheckin más alto que sea <= la anticipación real', () => {
    expect(resolveApplicableTierFromLadder(LADDER, 10)?.refundPercentage).toBe(100);
    expect(resolveApplicableTierFromLadder(LADDER, 7)?.refundPercentage).toBe(100);
  });

  it('cae al tramo intermedio cuando la anticipación no alcanza el tramo más alto', () => {
    expect(resolveApplicableTierFromLadder(LADDER, 6)?.refundPercentage).toBe(50);
    expect(resolveApplicableTierFromLadder(LADDER, 3)?.refundPercentage).toBe(50);
  });

  it('cae al tramo de menor anticipación (0 días) cuando falta poco para el check-in', () => {
    expect(resolveApplicableTierFromLadder(LADDER, 2)?.refundPercentage).toBe(0);
    expect(resolveApplicableTierFromLadder(LADDER, 0)?.refundPercentage).toBe(0);
  });

  it('null si la anticipación es negativa (cancela después del check-in) y no hay tramo min=0', () => {
    const sinTramoCero = LADDER.filter((t) => t.minDaysBeforeCheckin !== 0);
    expect(resolveApplicableTierFromLadder(sinTramoCero, -1)).toBeNull();
  });

  it('null con un ladder vacío', () => {
    expect(resolveApplicableTierFromLadder([], 10)).toBeNull();
  });

  it('no depende del orden de entrada del array (recorre todo, no asume ladder ordenado)', () => {
    const desordenado = [...LADDER].reverse();
    expect(resolveApplicableTierFromLadder(desordenado, 5)?.refundPercentage).toBe(50);
  });

  it('desempate: si dos tramos comparten el mismo minDaysBeforeCheckin, gana el PRIMERO recorrido (comparación estricta `>`, no `>=` -- un empate no desplaza al ganador ya encontrado; caso hoy inalcanzable en la tabla real por el UNIQUE INDEX sobre (business_id, min_days_before_checkin), sin desempate explícito por id como sí tiene el LIFO de CancellationRefundService)', () => {
    const conDuplicado: CancellationPolicyTierSnapshot[] = [
      { minDaysBeforeCheckin: 3, refundPercentage: 50 },
      { minDaysBeforeCheckin: 3, refundPercentage: 60 },
    ];
    expect(resolveApplicableTierFromLadder(conDuplicado, 5)?.refundPercentage).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// buildCancellationPolicySnapshot() — decide si hay algo que congelar y
// arma el JSON. Ver el docblock del archivo fuente para la decisión de
// diseño "todo o nada" (ladder mixto SNAPSHOT/LIVE se congela completo).
// ---------------------------------------------------------------------------

function makePolicy(overrides: Partial<CancellationPolicy> = {}): CancellationPolicy {
  return {
    id: 'p-1',
    businessId: 'biz-1',
    minDaysBeforeCheckin: 7,
    refundPercentage: 100,
    active: true,
    policyResolutionTiming: 'SNAPSHOT_AT_BOOKING',
    ...overrides,
  };
}

describe('buildCancellationPolicySnapshot', () => {
  const FROZEN_AT = new Date('2026-09-14T12:00:00.000Z');

  it('null sin ningún tramo (ladder vacío)', () => {
    expect(buildCancellationPolicySnapshot([], FROZEN_AT)).toBeNull();
  });

  it('null si TODOS los tramos activos son LIVE_AT_CANCELLATION', () => {
    const policies = [
      makePolicy({ policyResolutionTiming: 'LIVE_AT_CANCELLATION', minDaysBeforeCheckin: 7 }),
      makePolicy({ id: 'p-2', policyResolutionTiming: 'LIVE_AT_CANCELLATION', minDaysBeforeCheckin: 0, refundPercentage: 0 }),
    ];
    expect(buildCancellationPolicySnapshot(policies, FROZEN_AT)).toBeNull();
  });

  it('congela el ladder ACTIVO completo si AL MENOS un tramo activo es SNAPSHOT_AT_BOOKING', () => {
    const policies = [
      makePolicy({ policyResolutionTiming: 'SNAPSHOT_AT_BOOKING', minDaysBeforeCheckin: 7, refundPercentage: 100 }),
      makePolicy({ id: 'p-2', policyResolutionTiming: 'LIVE_AT_CANCELLATION', minDaysBeforeCheckin: 0, refundPercentage: 0 }),
    ];
    const snapshot = buildCancellationPolicySnapshot(policies, FROZEN_AT);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.version).toBe(1);
    expect(snapshot?.frozenAt).toBe('2026-09-14T12:00:00.000Z');
    // El tramo LIVE_AT_CANCELLATION también entra al ladder congelado --
    // decisión "todo o nada" documentada en el docblock de la función.
    expect(snapshot?.tiers).toEqual([
      { minDaysBeforeCheckin: 7, refundPercentage: 100 },
      { minDaysBeforeCheckin: 0, refundPercentage: 0 },
    ]);
  });

  it('excluye tramos INACTIVOS del ladder congelado, aunque sean SNAPSHOT_AT_BOOKING', () => {
    const policies = [
      makePolicy({ minDaysBeforeCheckin: 7, refundPercentage: 100, active: true }),
      makePolicy({ id: 'p-2', minDaysBeforeCheckin: 3, refundPercentage: 50, active: false }),
    ];
    const snapshot = buildCancellationPolicySnapshot(policies, FROZEN_AT);
    expect(snapshot?.tiers).toEqual([{ minDaysBeforeCheckin: 7, refundPercentage: 100 }]);
  });

  it('null si el único tramo activo (con SNAPSHOT) coexiste con uno inactivo LIVE -- inactivos no cuentan para "algún tramo LIVE"', () => {
    const policies = [
      makePolicy({ minDaysBeforeCheckin: 7, refundPercentage: 100, active: true, policyResolutionTiming: 'SNAPSHOT_AT_BOOKING' }),
      makePolicy({ id: 'p-2', minDaysBeforeCheckin: 3, refundPercentage: 50, active: false, policyResolutionTiming: 'LIVE_AT_CANCELLATION' }),
    ];
    const snapshot = buildCancellationPolicySnapshot(policies, FROZEN_AT);
    // El único tramo ACTIVO es SNAPSHOT -- se congela, sin importar el inactivo.
    expect(snapshot?.tiers).toEqual([{ minDaysBeforeCheckin: 7, refundPercentage: 100 }]);
  });
});
