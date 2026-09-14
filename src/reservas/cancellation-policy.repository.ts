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

/**
 * CANCEL-POLICY-SCOPE-BASE-001 Bloque 2 (14/09/2026) -- un tramo, tal como
 * queda CONGELADO dentro de `reservations.cancellation_policy_snapshot`.
 * Deliberadamente más angosto que `CancellationPolicy`: solo los dos campos
 * que la resolución de tramo necesita (`resolveApplicableTierFromLadder()`
 * de abajo) -- ni `id`/`businessId` (la fila de `reservations` ya sabe a
 * qué negocio pertenece) ni `active`/`policyResolutionTiming` (por
 * construcción, solo tramos ACTIVOS entran acá -- ver
 * `buildCancellationPolicySnapshot()`, y la resolución en sí ya no
 * necesita saber el timing: la sola presencia de un snapshot no-nulo en la
 * reserva ES la señal de "resolver contra esto, no contra la tabla en
 * vivo"). Ver el docblock de la columna en `src/db/schema.sql` para el
 * razonamiento completo.
 */
export interface CancellationPolicyTierSnapshot {
  minDaysBeforeCheckin: number;
  refundPercentage: number;
}

/**
 * Forma persistida en `reservations.cancellation_policy_snapshot` (JSONB).
 * `version` -- versioned-schema-evolution: este JSON sobrevive al código
 * que lo escribió (una reserva confirmada hoy se sigue leyendo con
 * código de dentro de meses); un cambio de forma futuro arranca en
 * `version: 2` y el lector decide qué hacer con cada una, en vez de
 * adivinar la forma por los campos presentes.
 */
export interface CancellationPolicySnapshot {
  version: 1;
  /** Instante (UTC, ISO 8601) en el que se congeló -- trazabilidad/debug, no participa de ningún cálculo. */
  frozenAt: string;
  tiers: CancellationPolicyTierSnapshot[];
}

/**
 * Función pura: dado un ladder de tramos (vengan de `reservations.
 * cancellation_policy_snapshot.tiers` congelado, o de un `findAll()` en
 * vivo ya filtrado por `active`), devuelve el tramo GANADOR para una
 * anticipación real -- el `minDaysBeforeCheckin` más alto que sea `<=`
 * `daysBeforeCheckin` (mismo ladder que
 * `SqlCancellationPolicyRepository.findApplicableTier()` resuelve con SQL
 * -- `WHERE min_days_before_checkin <= $2 ORDER BY min_days_before_checkin
 * DESC LIMIT 1` -- es la MISMA regla de negocio, expresada en JS para un
 * array en memoria en vez de una query). `null` si ningún tramo aplica,
 * mismo criterio que `findApplicableTier()`: sin tramo aplicable, no se
 * reembolsa nada.
 *
 * Nota de diseño (Bloque 2, 14/09/2026): esto NO reemplaza la query SQL de
 * `findApplicableTier()` -- son dos implementaciones de la misma regla,
 * una contra una tabla (camino LIVE_AT_CANCELLATION, sin cambios en este
 * bloque) y otra contra un array ya en memoria (camino SNAPSHOT_AT_BOOKING,
 * nuevo). Unificarlas exigiría que el camino LIVE hiciera `findAll()` +
 * esta función en vez de una query con LIMIT 1 -- un round-trip más ancho
 * (trae TODOS los tramos en vez de 1) a cambio de no duplicar la regla en
 * dos formas. Fuera de alcance de este bloque (no se toca
 * `cancellation-refund.service.ts` del lado LIVE) -- señalado acá para que
 * quien lo revise sepa que la duplicación es conocida, no un descuido.
 */
export function resolveApplicableTierFromLadder(
  tiers: readonly CancellationPolicyTierSnapshot[],
  daysBeforeCheckin: number,
): CancellationPolicyTierSnapshot | null {
  let winner: CancellationPolicyTierSnapshot | null = null;
  for (const tier of tiers) {
    if (tier.minDaysBeforeCheckin <= daysBeforeCheckin) {
      if (!winner || tier.minDaysBeforeCheckin > winner.minDaysBeforeCheckin) {
        winner = tier;
      }
    }
  }
  return winner;
}

/**
 * Construye el snapshot a congelar en `reservations.
 * cancellation_policy_snapshot` a partir del `findAll()` (SIN filtrar) de
 * `CancellationPolicyRepository` para el negocio -- llamado por
 * `ReservationService.confirmReservation()`. `null` (nada que congelar) en
 * dos casos, ver el docblock de la columna en `src/db/schema.sql` para el
 * razonamiento de negocio completo:
 *   - sin ningún tramo ACTIVO para el negocio.
 *   - ningún tramo ACTIVO tiene `policyResolutionTiming ===
 *     'SNAPSHOT_AT_BOOKING'` (todos `LIVE_AT_CANCELLATION`).
 *
 * DECISIÓN DEL DUEÑO (14/09/2026, vía `AskUserQuestion` -- esta sesión
 * había implementado esto como decisión propia primero, sin preguntarla,
 * y se corrigió preguntándola antes de dar el bloque por cerrado, mismo
 * criterio que el caso D5 de `app-main/CLAUDE.md`) -- `policy_resolution_timing`
 * vive POR TRAMO/FILA (docblock de esa columna en `src/db/schema.sql`), no
 * por negocio, así que en teoría un mismo ladder puede mezclar tramos
 * SNAPSHOT y LIVE. Confirmado: NO se resuelve esa mezcla tramo por tramo
 * -- el ladder se trata como TODO O NADA: si ALGÚN tramo activo pide
 * SNAPSHOT, se congela el ladder ACTIVO COMPLETO (incluidos los tramos que
 * a su vez dicen LIVE_AT_CANCELLATION), y esa reserva resuelve SIEMPRE
 * contra el snapshot de ahí en más -- nunca vuelve a la tabla en vivo, ni
 * para los tramos que pedían LIVE. Motivo que el dueño confirmó: resolver
 * mixto (tramo por tramo, según su propio timing) exige saber, en el
 * momento de CANCELAR, qué tramo específico va a ganar ANTES de decidir si
 * mirar el snapshot o la tabla viva -- problema circular (el tramo ganador
 * depende de la anticipación real al cancelar, no se puede saber al
 * confirmar). Con el default real de hoy (todo tramo nuevo nace
 * `SNAPSHOT_AT_BOOKING` salvo que alguien lo cambie a mano) el caso mixto
 * es hoy infrecuente, pero no imposible.
 */
export function buildCancellationPolicySnapshot(
  policies: readonly CancellationPolicy[],
  frozenAt: Date,
): CancellationPolicySnapshot | null {
  const activeTiers = policies.filter((p) => p.active);
  if (activeTiers.length === 0) return null;
  if (!activeTiers.some((p) => p.policyResolutionTiming === 'SNAPSHOT_AT_BOOKING')) return null;

  return {
    version: 1,
    frozenAt: frozenAt.toISOString(),
    tiers: activeTiers.map((p) => ({
      minDaysBeforeCheckin: p.minDaysBeforeCheckin,
      refundPercentage: p.refundPercentage,
    })),
  };
}
