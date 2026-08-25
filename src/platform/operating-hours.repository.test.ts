import { describe, it, expect } from 'vitest';
import { windowsOverlap } from './operating-hours.repository.js';

describe('windowsOverlap', () => {
  it('dos ventanas idénticas se superponen', () => {
    expect(windowsOverlap({ startTime: '09:00', endTime: '18:00' }, { startTime: '09:00', endTime: '18:00' })).toBe(true);
  });

  it('un solapamiento parcial cuenta como superposición', () => {
    expect(windowsOverlap({ startTime: '09:00', endTime: '13:00' }, { startTime: '12:00', endTime: '15:00' })).toBe(true);
  });

  it('ventanas contiguas (una termina cuando arranca la otra) NO se superponen', () => {
    expect(windowsOverlap({ startTime: '09:00', endTime: '13:00' }, { startTime: '13:00', endTime: '18:00' })).toBe(false);
  });

  it('ventanas separadas en el tiempo no se superponen', () => {
    expect(windowsOverlap({ startTime: '09:00', endTime: '12:00' }, { startTime: '14:00', endTime: '18:00' })).toBe(false);
  });

  it('una ventana totalmente contenida dentro de otra se superpone', () => {
    expect(windowsOverlap({ startTime: '09:00', endTime: '18:00' }, { startTime: '10:00', endTime: '11:00' })).toBe(true);
  });

  it('funciona con formato HH:MM:SS, no solo HH:MM', () => {
    expect(windowsOverlap({ startTime: '09:00:00', endTime: '13:00:00' }, { startTime: '12:00:00', endTime: '15:00:00' })).toBe(true);
  });
});
