/**
 * @file maintenance-window.service.ts
 * @description Caso de uso de ventanas de mantenimiento (24/08/2026,
 * docs/diseno-housekeeping-ventana-mantenimiento-2026-08-24.md). El
 * bloqueo de disponibilidad en sí vive en
 * `ReservationAvailabilityService.evaluateMaintenanceWindows()` — este
 * servicio es el CRUD (crear/cerrar/listar) que usan las rutas.
 */

import { DateTime } from 'luxon';
import { MaintenanceWindow } from './maintenance-window.js';
import type { MaintenanceWindowRepository } from './maintenance-window.repository.js';
import type { ResourceRepository } from '../reservas/resource.repository.js';
import type { ReservationRepository } from '../reservas/reservation.repository.js';
import type { Reservation } from '../reservas/Reservation.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { BusinessProfile } from '../domain/business-profile.entities.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';
import { ResourceNotFoundError, MaintenanceWindowConflictError, MaintenanceWindowNotFoundError } from '../domain/errors.js';
import { combineDateAndTime } from '../reservas/reservation-time.utils.js';

export interface CreateMaintenanceWindowInput {
  businessId: string;
  resourceId: string;
  /** 'YYYY-MM-DD'. */
  startDate: string;
  /** 'YYYY-MM-DD', opcional — sin esto, la ventana queda ABIERTA ("hasta nuevo aviso"). */
  endDate?: string | null;
  reason?: string | null;
  createdBy: string;
}

/**
 * D-03 (15/09/2026, docs/decisiones-auditoria-fase2-2026-09-15.md §6).
 */
export interface CreateMaintenanceWindowResult {
  window: MaintenanceWindow;
  /**
   * Reservas CONFIRMED/PENDING que caían en el tramo incierto (más allá
   * del horizonte configurado) de una ventana ABIERTA nueva — no
   * bloquearon el alta, pero quedaron `needsMaintenanceReview = true`.
   * Vacío en el caso normal (ventana con `endDate`, o sin ninguna reserva
   * más allá del horizonte).
   */
  needsReviewReservationIds: string[];
}

export class MaintenanceWindowService {
  constructor(
    private readonly maintenanceWindowRepository: MaintenanceWindowRepository,
    /**
     * MAINTENANCE-WINDOW-CERTAIN-SEGMENT-TOCTOU-001 (25/09/2026, gate
     * `architecture-governor`) — `lockByIds` pasa a ser parte del tipo
     * exigido acá: `createWindow()` ahora lockea el recurso (`SELECT ...
     * FOR UPDATE` sobre `resources`) como PRIMERA sentencia dentro de la
     * transacción, mismo mecanismo que `ReservationService.createReservation()`/
     * `updateReservation()` — un fake de test que no lo implemente tiene que
     * romper la compilación, no "pasar por accidente" sin lockear nada.
     */
    private readonly resourceRepository: Pick<ResourceRepository, 'getById' | 'lockByIds'>,
    /**
     * MAINTENANCE-WINDOW-STALE-SAVE-001 (25/09/2026, gate
     * `architecture-governor`) — `getActiveForResourceInRangeWithLock` pasa
     * de opcional a OBLIGATORIO acá (`Required<Pick<...>>`, no
     * `Pick<...> & { getActiveForResourceInRangeWithLock?: ... }`) a
     * propósito: en `ReservationRepository` sigue siendo opcional (otros
     * consumidores, p. ej. `ReservationAvailabilityService`, lo usan con
     * guard), pero acá el fix DEPENDE de que exista — un fake de test viejo
     * que no lo implemente tiene que romper la compilación, no "pasar por
     * accidente" leyendo el tramo incierto sin lock.
     *
     * MAINTENANCE-WINDOW-CERTAIN-SEGMENT-TOCTOU-001 (25/09/2026) —
     * `getActiveForResourceInRange` (SIN lock) sale de este tipo: las dos
     * ramas del chequeo del tramo cierto que antes la usaban ahora leen con
     * `getActiveForResourceInRangeWithLock` dentro de la transacción, así
     * que ya no queda ningún call site de la variante sin lock en este
     * servicio. Sacarla del tipo es protección estructural — una futura
     * vuelta a la lectura sin lock rompe la compilación en vez de colarse
     * en silencio.
     */
    private readonly reservationRepository: Required<Pick<
      ReservationRepository,
      'saveWithClient' | 'getActiveForResourceInRangeWithLock'
    >>,
    private readonly businessProfileRepository: Pick<BusinessProfileRepository, 'get'>,
    /**
     * D-03 (15/09/2026) — el INSERT de la ventana y el UPDATE de
     * `needs_maintenance_review` sobre N reservas del tramo incierto son
     * una sola operación atómica (atomic-state-mutation). Wireado desde
     * `app.ts` con `buildTenantTransactionManager(req)`, mismo criterio
     * que `StayService`/`AccountsReceivableService` (Bug 5, 11/09/2026).
     */
    private readonly transactionManager: TransactionManager,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * D-03 (15/09/2026, docs/decisiones-auditoria-fase2-2026-09-15.md §6,
   * grounding ERP — 5 de 6 sistemas de referencia coinciden) — reemplaza
   * el horizonte fijo de 10 años por `business_profile.maintenance_horizon_days`,
   * partiendo el rango evaluado de una ventana ABIERTA (`endDate == null`)
   * en dos tramos:
   *
   * - **Tramo cierto** — `[startDate, min(endDate, hoy + horizonte)]`
   *   (para una ventana con `endDate`, es el rango completo — el horizonte
   *   NO aplica ahí, ver comentario más abajo). Una reserva CONFIRMED/
   *   PENDING acá sigue bloqueando el alta (`MaintenanceWindowConflictError`),
   *   igual que antes de este cambio — fuerza a resolverla primero
   *   (reasignar o cancelar).
   * - **Tramo incierto** — solo existe para `endDate == null`, es todo lo
   *   que queda más allá de `hoy + horizonte`. Una reserva ahí YA NO
   *   bloquea: la ventana se crea igual, la reserva queda
   *   `needsMaintenanceReview = true` (`Reservation.markNeedsMaintenanceReview()`)
   *   y su id viaja en `needsReviewReservationIds` de la respuesta.
   *
   * El horizonte NUNCA se aplica a una ventana con `endDate` fijo —
   * aplicarlo ahí sería una regresión real: dejaría pasar sin bloquear ni
   * marcar una reserva DENTRO del rango acotado, contradiciendo a
   * `ReservationAvailabilityService.evaluateMaintenanceWindows()`
   * (reservation-availability.service.ts:90-98), que tampoco usa horizonte
   * para ventanas con fin fijo.
   */
  async createWindow(input: CreateMaintenanceWindowInput): Promise<CreateMaintenanceWindowResult> {
    const resource = await this.resourceRepository.getById(input.resourceId);
    if (!resource) throw new ResourceNotFoundError(input.resourceId);

    const profile = await this.businessProfileRepository.get();
    const rangeStart = combineDateAndTime(new Date(input.startDate), '00:00:00', profile.timezone);
    const isOpenEnded = input.endDate == null;

    // MAINTENANCE-WINDOW-CERTAIN-SEGMENT-TOCTOU-001 (25/09/2026, gate
    // `architecture-governor`) -- hasta este fix, el chequeo de conflicto
    // del tramo cierto (`MaintenanceWindowConflictError`) corría ACÁ, SIN
    // LOCK y AFUERA de la transacción (check-then-insert clásico, clase
    // A8.3): dos `createWindow()` concurrentes sobre el mismo recurso, o
    // una creación de reserva concurrente, podían pasar el chequeo antes
    // de que ninguna escritura hubiera comiteado todavía, y terminar con
    // una ventana de mantenimiento y una reserva activa solapadas.
    //
    // Fix: acá SOLO queda la ARITMÉTICA de rangos (sin tocar Postgres) --
    // `certainRange` (qué rango hay que chequear por conflicto, `null` si
    // no hay tramo cierto) y `uncertainRange` (qué rango hay que releer
    // para `needsMaintenanceReview`, sin cambios de comportamiento). El
    // chequeo real (lectura + `throw`) se movió DENTRO de
    // `transactionManager.run()`, DESPUÉS de lockear el recurso -- ver el
    // comentario junto a `transactionManager.run()` más abajo.
    let certainRange: { start: Date; end: Date } | null = null;
    let uncertainRange: { start: Date; end: Date } | null = null;

    if (!isOpenEnded) {
      // Ventana CON fecha de fin -- sin horizonte, rango completo tal cual
      // se evaluaba antes de este cambio. Sin tramo incierto: nada que
      // marcar para revisión.
      const rangeEnd = combineDateAndTime(new Date(input.endDate as string), '23:59:59', profile.timezone);
      certainRange = { start: rangeStart, end: rangeEnd };
    } else {
      // Techo práctico para la query del tramo incierto -- no hay un
      // límite de negocio real ("hasta nuevo aviso" es indefinido), pero
      // getActiveForResourceInRangeWithLock() necesita un Date concreto. Ya
      // NO decide bloqueo (eso lo hace el horizonte de abajo), solo acota
      // la búsqueda de reservas a marcar -- mismo valor "unbounded"
      // práctico que usaba este método completo antes de D-03.
      const practicalInfinity = DateTime.fromJSDate(rangeStart).plus({ years: 10 }).toJSDate();
      const horizonEnd = this.resolveHorizonEndInstant(profile);

      if (horizonEnd.getTime() >= rangeStart.getTime()) {
        // La ventana empieza dentro del horizonte -- hay tramo cierto real.
        certainRange = { start: rangeStart, end: horizonEnd };

        const uncertainStart = new Date(horizonEnd.getTime() + 1000);
        if (uncertainStart.getTime() <= practicalInfinity.getTime()) {
          uncertainRange = { start: uncertainStart, end: practicalInfinity };
        }
      } else {
        // La ventana arranca MÁS ALLÁ del horizonte ya de entrada -- todo
        // el rango pedido es tramo incierto, no hay tramo cierto que
        // bloquee nada.
        uncertainRange = { start: rangeStart, end: practicalInfinity };
      }
    }

    const window = MaintenanceWindow.create({
      businessId: input.businessId,
      resourceId: input.resourceId,
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      reason: input.reason ?? null,
      createdBy: input.createdBy,
    });

    // atomic-state-mutation: el lock del recurso, el chequeo de conflicto
    // del tramo cierto, el INSERT de la ventana y el UPDATE de
    // needs_maintenance_review de cada reserva del tramo incierto son una
    // sola operación lógica -- si cualquiera falla (incluido el throw de
    // conflicto), nada queda creado.
    //
    // MAINTENANCE-WINDOW-CERTAIN-SEGMENT-TOCTOU-001 (25/09/2026, gate
    // `architecture-governor`) -- primera sentencia del callback:
    // `lockByIds()` sobre el recurso (`SELECT ... FOR UPDATE` sobre
    // `resources`), mismo mecanismo que `ReservationService.createReservation()`/
    // `updateReservation()` usan antes de chequear disponibilidad (Bug 2,
    // 25/08/2026, ver `resource.repository.ts::lockByIds()`). Serializa
    // `createWindow()` contra cualquier otro escritor que TAMBIÉN lockee
    // este recurso primero -- los 5 sitios reales:
    // `ReservationService.createReservation()`/`updateReservation()`,
    // `assignDeferred()` (vía sus 3 callers `completeReservation()`/
    // `updateReservation()`/`StayService.checkIn()`) y `StayService.checkIn()`
    // directo.
    //
    // El chequeo de conflicto del tramo cierto (antes AFUERA de la
    // transacción, `MaintenanceWindowConflictError`) ahora corre ACÁ, con
    // `getActiveForResourceInRangeWithLock()`, DESPUÉS del lock del
    // recurso -- ya no es un check-then-insert sin protección: con el
    // recurso lockeado, ninguna reserva nueva puede insertarse sobre este
    // rango mientras esta transacción sigue abierta (los escritores que
    // lockean el recurso primero -- ver los 5 sitios de arriba -- quedan
    // esperando ESTE lock).
    // Si hay conflicto, el `throw` desde DENTRO del callback dispara
    // ROLLBACK limpio -- mismo mecanismo que `assertAllResourcesAvailable()`
    // usa en `ReservationService`.
    //
    // MAINTENANCE-WINDOW-STALE-SAVE-001 (25/09/2026, gate
    // `architecture-governor`, fix previo -- SIN CAMBIOS acá) -- el tramo
    // incierto se sigue releyendo DENTRO de la transacción, con
    // `getActiveForResourceInRangeWithLock()`, recién DESPUÉS de
    // `saveWithClient(client, window)`. Orden de locks: recurso primero
    // (arriba), ventana después, relock de reservas del tramo incierto al
    // final. Con el `lockByIds()` de arriba, el recurso ya queda lockeado
    // ANTES que cualquier reserva, así que el `FOR KEY SHARE` implícito
    // del INSERT (FK contra `resources`) cae sobre una fila que esta
    // misma transacción ya tiene: el orden INSERT→relock ya no es el que
    // evita el deadlock ABBA original -- se conserva por convención con
    // el resto del servicio. El motivo por el que este fix sigue siendo
    // necesario, incluso con el recurso lockeado, es
    // distinto: hay escritores que mutan una reserva SIN lockear el
    // recurso primero -- `cancelReservation`, `confirmReservation`,
    // `confirmPriceAdjustment`, `reservation-hold-expiry.worker`, cancelar
    // con Nota de Crédito, cambio de horario -- y el lock del recurso de
    // arriba no serializa contra esos. Para esos, el relock del tramo
    // incierto sigue siendo necesario, exactamente como ya estaba.
    //
    // Relock por RANGO (no por id de las `toFlag` calculadas arriba):
    // `getActiveForResourceInRangeWithLock()` re-filtra por
    // recurso/estado/rango en el momento mismo del lock, así que el set
    // que devuelve ya viene naturalmente correcto -- una reserva que salió
    // del rango o se canceló entre el cálculo de `uncertainRange` (arriba,
    // sin lock) y este punto simplemente no vuelve a aparecer. Relockear
    // por id en cambio seguiría trayendo esa reserva aunque ya no
    // corresponda marcarla. Por eso no hace falta ningún guard de
    // coherencia adicional acá ni lanzar
    // `ReservationConcurrentlyModifiedError` -- el set fresco se usa y se
    // devuelve en silencio (decisión del dueño, ver docs/resuelto.md).
    let toFlag: Reservation[] = [];
    await this.transactionManager.run(async (client: SqlClient) => {
      await this.resourceRepository.lockByIds(client, [input.resourceId]);

      if (certainRange) {
        const certainConflicts = await this.reservationRepository.getActiveForResourceInRangeWithLock(
          client, input.resourceId, certainRange.start, certainRange.end,
        );
        if (certainConflicts.length > 0) {
          throw new MaintenanceWindowConflictError(input.resourceId, certainConflicts.map((r) => r.id));
        }
      }

      await this.maintenanceWindowRepository.saveWithClient(client, window);

      if (uncertainRange) {
        toFlag = await this.reservationRepository.getActiveForResourceInRangeWithLock(
          client, input.resourceId, uncertainRange.start, uncertainRange.end,
        );
      }

      for (const reservation of toFlag) {
        reservation.markNeedsMaintenanceReview();
        await this.reservationRepository.saveWithClient(client, reservation);
      }
    });

    return { window, needsReviewReservationIds: toFlag.map((r) => r.id) };
  }

  /**
   * `hoy + maintenanceHorizonDays`, fin del día de negocio (23:59:59) en
   * el huso del negocio -- mismo cálculo que
   * `ReservationAvailabilityService.evaluateMaintenanceWindows()`. Usa
   * `this.now()` (inyectable, default `new Date()`) en vez de
   * `DateTime.now()` directo -- mismo patrón que `ReservationService.now`
   * -- para que los tests puedan fijar "hoy" y verificar el borde del
   * horizonte de forma determinística.
   */
  private resolveHorizonEndInstant(profile: BusinessProfile): Date {
    const today = DateTime.fromJSDate(this.now()).setZone(profile.timezone).toISODate()!;
    return combineDateAndTime(
      DateTime.fromISO(today, { zone: profile.timezone }).plus({ days: profile.maintenanceHorizonDays }).toJSDate(),
      '23:59:59',
      profile.timezone,
    );
  }

  /** Cierra la ventana — única forma de liberar el recurso. `closeDate` default: hoy (fecha de negocio). */
  async closeWindow(id: string, businessId: string, closedBy: string, closeDate?: string): Promise<MaintenanceWindow> {
    const window = await this.maintenanceWindowRepository.findById(id, businessId);
    if (!window) throw new MaintenanceWindowNotFoundError(id);

    const profile = await this.businessProfileRepository.get();
    const today = DateTime.now().setZone(profile.timezone).toISODate()!;

    window.close(closedBy, closeDate ?? today);
    await this.maintenanceWindowRepository.update(window);
    return window;
  }

  async listByResource(resourceId: string, businessId: string): Promise<MaintenanceWindow[]> {
    return this.maintenanceWindowRepository.findByResource(resourceId, businessId);
  }

  /** Ventanas todavía relevantes (abiertas o con fin futuro) del negocio — pantalla de gestión. */
  async listActive(businessId: string): Promise<MaintenanceWindow[]> {
    const profile = await this.businessProfileRepository.get();
    const today = DateTime.now().setZone(profile.timezone).toISODate()!;
    return this.maintenanceWindowRepository.findAllActive(businessId, today);
  }
}
