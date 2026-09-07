import { describe, it, expect } from 'vitest';
import { combineDateAndTime } from './reservation-time.utils.js';

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
