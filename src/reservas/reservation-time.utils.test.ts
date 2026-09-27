import { describe, it, expect } from 'vitest';
import {
  combineDateAndTime, isCalendarDateMarker, deriveCalendarDate,
  todayInBusinessTimezone, qualifiesForDateComparison, isPastStart,
} from './reservation-time.utils.js';

/**
 * Regresión directa de la política A4.7 en `combineDateAndTime` — hora
 * ambigua (vuelta de otoño) y hora inexistente (salto de primavera).
 * Los tests que van por `getAvailableSlots` viven en
 * `reservation.service.test.ts` (describe "combineDateAndTime — DST"); estos
 * ejercitan la función pura, sobre todo los bordes del algoritmo de
 * desambiguación (TEST-DST-001, 06/09/2026).
 *
 * `date` se lee siempre en UTC (`getUTCFullYear/Month/Date`), así que basta
 * un `new Date('YYYY-MM-DDT00:00:00Z')` para fijar el día calendario.
 */
describe('combineDateAndTime — política A4.7', () => {
  const cal = (d: string) => new Date(`${d}T00:00:00.000Z`);

  describe('hora ambigua (vuelta de otoño): toma el offset estándar, la ocurrencia más tardía', () => {
    it('America/Santiago 2024-04-06 23:00 -> 03:00Z (estándar), no 02:00Z (verano)', () => {
      expect(combineDateAndTime(cal('2024-04-06'), '23:00:00', 'America/Santiago').toISOString())
        .toBe('2024-04-07T03:00:00.000Z');
    });

    it('America/New_York 2024-11-03 01:00 -> 06:00Z (EST), no 05:00Z (EDT)', () => {
      // Reglas de DST de EE.UU. estables desde 2007 -> golden value que no driftea.
      expect(combineDateAndTime(cal('2024-11-03'), '01:00:00', 'America/New_York').toISOString())
        .toBe('2024-11-03T06:00:00.000Z');
    });
  });

  describe('salto sub-horario (Australia/Lord_Howe, 30′): la sonda de 1h sobre-detecta, la guarda de hora de pared lo corrige', () => {
    // Vuelta de otoño 2024-04-07: 02:00 +11:00 -> 01:30 +10:30. Solo
    // 01:30-01:59 ocurre dos veces; 01:00-01:29 NO es ambigua.
    it('01:00 NO es ambigua -> no se corre (queda 14:00Z, no 14:30Z)', () => {
      expect(combineDateAndTime(cal('2024-04-07'), '01:00:00', 'Australia/Lord_Howe').toISOString())
        .toBe('2024-04-06T14:00:00.000Z');
    });

    it('01:15 NO es ambigua -> no se corre', () => {
      expect(combineDateAndTime(cal('2024-04-07'), '01:15:00', 'Australia/Lord_Howe').toISOString())
        .toBe('2024-04-06T14:15:00.000Z');
    });

    it('01:30 SÍ es ambigua -> ocurrencia estándar (15:00Z, no 14:30Z)', () => {
      expect(combineDateAndTime(cal('2024-04-07'), '01:30:00', 'Australia/Lord_Howe').toISOString())
        .toBe('2024-04-06T15:00:00.000Z');
    });

    it('01:45 SÍ es ambigua -> ocurrencia estándar', () => {
      expect(combineDateAndTime(cal('2024-04-07'), '01:45:00', 'Australia/Lord_Howe').toISOString())
        .toBe('2024-04-06T15:15:00.000Z');
    });
  });

  describe('hora inexistente (salto de primavera): la desambiguación NO la toca', () => {
    it('America/Santiago 2024-09-08 00:00 -> avanza al instante real (04:00Z)', () => {
      expect(combineDateAndTime(cal('2024-09-08'), '00:00:00', 'America/Santiago').toISOString())
        .toBe('2024-09-08T04:00:00.000Z');
    });
  });

  describe('fuera de una transición: no-op', () => {
    it('America/Santiago invierno (junio): -04', () => {
      expect(combineDateAndTime(cal('2024-06-15'), '09:00:00', 'America/Santiago').toISOString())
        .toBe('2024-06-15T13:00:00.000Z');
    });

    it('America/Santiago verano (diciembre): -03', () => {
      expect(combineDateAndTime(cal('2024-12-20'), '09:00:00', 'America/Santiago').toISOString())
        .toBe('2024-12-20T12:00:00.000Z');
    });

    it('America/Argentina/Buenos_Aires (sin DST): -03 todo el año', () => {
      expect(combineDateAndTime(cal('2024-06-15'), '09:00:00', 'America/Argentina/Buenos_Aires').toISOString())
        .toBe('2024-06-15T12:00:00.000Z');
    });
  });
});

/**
 * J1-TZ (27/09/2026, docs/diseno-j1-fecha-alojamiento-huso-negocio-2026-09-27.md)
 * — helpers en aislamiento, sin pasar por ReservationService. Los casos de
 * integración completos (categoría/servicio/precedencia de errores) viven en
 * reservation.service.test.ts, describe "J1-TZ — comparar fecha calendario
 * para alojamiento/block con marca".
 */
describe('isCalendarDateMarker / deriveCalendarDate / todayInBusinessTimezone (J1-TZ)', () => {
  const ART = 'America/Argentina/Buenos_Aires';

  describe('isCalendarDateMarker', () => {
    it('medianoche UTC exacta → true', () => {
      expect(isCalendarDateMarker(new Date('2026-09-27T00:00:00.000Z'))).toBe(true);
    });

    it('con milisegundos → false', () => {
      expect(isCalendarDateMarker(new Date('2026-09-27T00:00:00.001Z'))).toBe(false);
    });

    it('cualquier otra hora → false', () => {
      expect(isCalendarDateMarker(new Date('2026-09-27T10:00:00.000Z'))).toBe(false);
    });
  });

  describe('deriveCalendarDate — startTime que puede ser marca o instante real', () => {
    it('marca → lee la fecha UTC tal cual (convención del panel)', () => {
      expect(deriveCalendarDate(new Date('2026-09-27T00:00:00.000Z'), ART)).toBe('2026-09-27');
    });

    it('instante real → convierte al huso de negocio antes de tomar la fecha', () => {
      // 22:00 ART del 27/09 = 2026-09-28T01:00Z -- NO es marca (no cae en
      // medianoche UTC) -- la fecha de negocio sigue siendo el 27/09, no el 28.
      expect(deriveCalendarDate(new Date('2026-09-28T01:00:00.000Z'), ART)).toBe('2026-09-27');
    });

    it('huso horario inválido, con un INSTANTE real (no marca, la única rama que usa el huso) → falla visible, no null en silencio', () => {
      expect(() => deriveCalendarDate(new Date('2026-09-27T15:00:00.000Z'), 'No/Existe')).toThrow();
    });
  });

  describe('todayInBusinessTimezone — separado de deriveCalendarDate a propósito (H2)', () => {
    it('reloj en medianoche UTC exacta → NO se lee como marca, se convierte al huso de negocio', () => {
      // 2026-09-27T00:00Z es -3h en ART = 2026-09-26T21:00 hora local --
      // "hoy" tiene que dar 2026-09-26, no 2026-09-27 (que daría
      // deriveCalendarDate si se usara por error para "ahora").
      expect(todayInBusinessTimezone(new Date('2026-09-27T00:00:00.000Z'), ART)).toBe('2026-09-26');
      expect(deriveCalendarDate(new Date('2026-09-27T00:00:00.000Z'), ART)).toBe('2026-09-27');
    });

    it('reloj a mitad de día → mismo resultado que convertir directo', () => {
      expect(todayInBusinessTimezone(new Date('2026-09-27T18:00:00.000Z'), ART)).toBe('2026-09-27');
    });

    it('huso horario inválido → falla visible', () => {
      expect(() => todayInBusinessTimezone(new Date(), 'No/Existe')).toThrow();
    });
  });

  describe('qualifiesForDateComparison', () => {
    const marker = new Date('2026-09-27T00:00:00.000Z');
    const instant = new Date('2026-09-27T15:00:00.000Z');

    it('slot excluye SIEMPRE, aunque sea alojamiento y el timestamp sea una marca', () => {
      expect(qualifiesForDateComparison(true, 'slot', marker)).toBe(false);
    });

    it('alojamiento + marca → true', () => {
      expect(qualifiesForDateComparison(true, 'block', marker)).toBe(true);
      expect(qualifiesForDateComparison(true, 'event', marker)).toBe(true);
      expect(qualifiesForDateComparison(true, undefined, marker)).toBe(true);
    });

    it('alojamiento + instante real (no marca) → false', () => {
      expect(qualifiesForDateComparison(true, 'event', instant)).toBe(false);
    });

    it('block no-alojamiento + marca → true (decisión del dueño, 27/09/2026)', () => {
      expect(qualifiesForDateComparison(false, 'block', marker)).toBe(true);
    });

    it('no-alojamiento sin block + marca → false', () => {
      expect(qualifiesForDateComparison(false, 'event', marker)).toBe(false);
      expect(qualifiesForDateComparison(false, undefined, marker)).toBe(false);
    });
  });

  describe('isPastStart', () => {
    const now = () => new Date('2020-01-01T00:00:00.000Z'); // "hoy" en ART: 2019-12-31
    const TOLERANCE = 5 * 60 * 1000;

    it('no califica → compara instante crudo con tolerancia', () => {
      expect(isPastStart(new Date(now().getTime() - 10 * 60 * 1000), false, ART, now, TOLERANCE)).toBe(true);
      expect(isPastStart(new Date(now().getTime() - 2 * 60 * 1000), false, ART, now, TOLERANCE)).toBe(false);
    });

    it('califica → compara fecha calendario en huso de negocio', () => {
      expect(isPastStart(new Date('2019-12-30T00:00:00.000Z'), true, ART, now, TOLERANCE)).toBe(true); // ayer
      expect(isPastStart(new Date('2019-12-31T00:00:00.000Z'), true, ART, now, TOLERANCE)).toBe(false); // hoy
    });
  });
});
