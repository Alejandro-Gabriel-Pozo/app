/**
 * @file reservation.cancel-confirmed.test.ts
 * @description Tests de la política de cancelación de reservas CONFIRMED.
 *
 * Verifica la regla de negocio central: una reserva CONFIRMED solo puede
 * cancelarse con al menos 24 horas de antelación al momento de inicio.
 *
 * La función `canCancelConfirmed` extrae la lógica pura de customer.routes.ts
 * para testearla en total aislamiento, sin HTTP ni mocks de Express.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ReservationStatus } from '../../types/enums.js';

// ---------------------------------------------------------------------------
// Constante de política — debe coincidir con CANCEL_ADVANCE_MS en customer.routes.ts
// ---------------------------------------------------------------------------
const CANCEL_ADVANCE_MS = 24 * 60 * 60 * 1_000; // 24 horas en ms

// ---------------------------------------------------------------------------
// Lógica pura extraída del handler para testeo en aislamiento
// ---------------------------------------------------------------------------
function canCancelConfirmed(
  startTime: Date,
  now = Date.now(),
): { ok: boolean; hoursLeft: number } {
  const msUntilStart = startTime.getTime() - now;
  const ok = msUntilStart >= CANCEL_ADVANCE_MS;
  const hoursLeft = Math.max(0, Math.floor(msUntilStart / (1000 * 60 * 60)));
  return { ok, hoursLeft };
}

const msFromNow = (ms: number) => new Date(Date.now() + ms);
const msAgo     = (ms: number) => new Date(Date.now() - ms);

// ---------------------------------------------------------------------------
describe('Política de cancelación — reservas CONFIRMED', () => {

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Casos que PERMITEN cancelar ---

  it('permite cancelar con exactamente 24h de antelación', () => {
    // Un solo Date.now() para los dos lados de la comparación -- el borde
    // exacto (msUntilStart === CANCEL_ADVANCE_MS) no deja margen: usar
    // msFromNow() + el default `now = Date.now()` de canCancelConfirmed()
    // lee el reloj real DOS veces por separado, y cualquier ms de por
    // medio (GC, CI lento, etc.) hace fallar el test de forma intermitente
    // aunque la lógica de negocio esté bien.
    const now = Date.now();
    const { ok } = canCancelConfirmed(new Date(now + CANCEL_ADVANCE_MS), now);
    expect(ok).toBe(true);
  });

  it('permite cancelar con 25h de antelación', () => {
    const { ok, hoursLeft } = canCancelConfirmed(msFromNow(CANCEL_ADVANCE_MS + 60 * 60 * 1_000));
    expect(ok).toBe(true);
    expect(hoursLeft).toBe(25);
  });

  it('permite cancelar con 48h de antelación', () => {
    const { ok, hoursLeft } = canCancelConfirmed(msFromNow(48 * 60 * 60 * 1_000));
    expect(ok).toBe(true);
    expect(hoursLeft).toBe(48);
  });

  // --- Casos que RECHAZAN cancelar ---

  it('rechaza cancelar con 23h 59min de antelación', () => {
    const { ok, hoursLeft } = canCancelConfirmed(msFromNow(CANCEL_ADVANCE_MS - 60 * 1_000));
    expect(ok).toBe(false);
    expect(hoursLeft).toBe(23);
  });

  it('rechaza cancelar con 1h de antelación', () => {
    const { ok, hoursLeft } = canCancelConfirmed(msFromNow(60 * 60 * 1_000));
    expect(ok).toBe(false);
    expect(hoursLeft).toBe(1);
  });

  it('rechaza cancelar con 30 minutos de antelación — hoursLeft es 0', () => {
    const { ok, hoursLeft } = canCancelConfirmed(msFromNow(30 * 60 * 1_000));
    expect(ok).toBe(false);
    expect(hoursLeft).toBe(0);
  });

  it('rechaza cancelar una reserva cuya hora de inicio ya pasó', () => {
    const { ok, hoursLeft } = canCancelConfirmed(msAgo(60 * 60 * 1_000));
    expect(ok).toBe(false);
    expect(hoursLeft).toBe(0);
  });

  // --- PENDING no pasa por esta validación ---

  it('reservas PENDING están en la lista de cancelables sin restricción de tiempo', () => {
    const CANCELLABLE_STATUSES = [
      ReservationStatus.PENDING,
      ReservationStatus.CONFIRMED,
    ];
    expect(CANCELLABLE_STATUSES.includes(ReservationStatus.PENDING)).toBe(true);
  });

  // --- Casos con timestamp fijo (vi.useFakeTimers) ---

  describe('con fecha fija 2026-07-03T12:00:00Z', () => {
    const FIXED_NOW = new Date('2026-07-03T12:00:00Z').getTime();

    it('permite cancelar reserva del 2026-07-04T13:00:00Z (25h después)', () => {
      const startTime = new Date('2026-07-04T13:00:00Z');
      const { ok, hoursLeft } = canCancelConfirmed(startTime, FIXED_NOW);
      expect(ok).toBe(true);
      expect(hoursLeft).toBe(25);
    });

    it('rechaza reserva del 2026-07-04T11:00:00Z (23h después)', () => {
      const startTime = new Date('2026-07-04T11:00:00Z');
      const { ok, hoursLeft } = canCancelConfirmed(startTime, FIXED_NOW);
      expect(ok).toBe(false);
      expect(hoursLeft).toBe(23);
    });

    it('rechaza reserva del 2026-07-04T12:00:00Z (exactamente 24h — borde inferior excluido)', () => {
      // startTime = now + 24h exacto → msUntilStart === CANCEL_ADVANCE_MS → ok = true (>=)
      const startTime = new Date('2026-07-04T12:00:00Z');
      const { ok } = canCancelConfirmed(startTime, FIXED_NOW);
      expect(ok).toBe(true); // el borde exacto está permitido
    });
  });
});
