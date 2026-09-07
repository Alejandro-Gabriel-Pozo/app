import { describe, it, expect } from 'vitest';
import { describeDeadLetter } from './dead-letter-describe.js';

describe('describeDeadLetter (ORDER-13 / O5)', () => {
  it('ChargeNeverCreatedError -> acción manual, frase de negocio sin jerga', () => {
    const d = describeDeadLetter({ eventType: 'order.completed', lastError: 'ChargeNeverCreatedError' });
    expect(d.kind).toBe('needs_manual_action');
    expect(d.summary).toContain('no se le generó el cargo');
    expect(d.summary).not.toContain('ChargeNeverCreatedError');
  });

  it('UnsupportedEventVersionError -> acción manual (actualización, no reintento)', () => {
    const d = describeDeadLetter({ eventType: 'reservation.confirmed', lastError: 'UnsupportedEventVersionError' });
    expect(d.kind).toBe('needs_manual_action');
    expect(d.summary).toContain('actualización');
  });

  it('PG_23xxx (violación de constraint) -> acción manual, "conflicto de datos"', () => {
    const d = describeDeadLetter({ eventType: 'order.completed', lastError: 'PG_23505' });
    expect(d.kind).toBe('needs_manual_action');
    expect(d.summary).toContain('Conflicto de datos');
  });

  it('PG_ transitorio (deadlock) -> reintentable, "falla temporal"', () => {
    const d = describeDeadLetter({ eventType: 'reservation.completed', lastError: 'PG_40P01' });
    expect(d.kind).toBe('retryable');
    expect(d.summary).toContain('Falla temporal de base de datos');
  });

  it('PG_ "other" (42P01 relación inexistente) -> NO dice "falla temporal", pide revisión', () => {
    const d = describeDeadLetter({ eventType: 'order.completed', lastError: 'PG_42P01' });
    expect(d.kind).toBe('needs_manual_action');
    expect(d.summary).not.toContain('temporal');
    expect(d.summary).toContain('revisión');
  });

  it('categoría desconocida -> revisión manual, incluye la categoría cruda entre paréntesis', () => {
    const d = describeDeadLetter({ eventType: 'customer.created', lastError: 'UNKNOWN_ERROR' });
    expect(d.kind).toBe('needs_manual_action');
    expect(d.summary).toContain('UNKNOWN_ERROR');
  });

  it('lastError null -> revisión manual, sin categoría entre paréntesis', () => {
    const d = describeDeadLetter({ eventType: 'order.completed', lastError: null });
    expect(d.summary).not.toContain('()');
  });

  it('usa el nombre legible del evento, no el tipo pelado', () => {
    const d = describeDeadLetter({ eventType: 'order.completed', lastError: 'PG_08006' });
    expect(d.summary).toContain('el cobro de una orden completada');
  });

  it('tipo de evento no mapeado -> lo muestra entre comillas, sin romper', () => {
    const d = describeDeadLetter({ eventType: 'stock.recount.requested', lastError: 'PG_08006' });
    expect(d.summary).toContain('«stock.recount.requested»');
  });
});
