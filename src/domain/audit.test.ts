import { describe, it, expect } from 'vitest';
import { diffFields } from './audit.js';

describe('diffFields', () => {
  it('detecta un campo primitivo cambiado', () => {
    const changes = diffFields({ name: 'Salon', active: true }, { name: 'Salon VIP' });
    expect(changes).toEqual([{ field: 'name', oldValue: 'Salon', newValue: 'Salon VIP' }]);
  });

  it('ignora campos del patch que no cambiaron de valor', () => {
    const changes = diffFields({ name: 'Salon', basePrice: 100 }, { name: 'Salon', basePrice: 100 });
    expect(changes).toEqual([]);
  });

  it('ignora claves del patch con valor undefined (no tocadas)', () => {
    const changes = diffFields({ name: 'Salon', description: 'x' }, { name: undefined, description: 'y' });
    expect(changes).toEqual([{ field: 'description', oldValue: 'x', newValue: 'y' }]);
  });

  it('detecta varios campos cambiados a la vez', () => {
    const changes = diffFields(
      { name: 'Salon', basePrice: 100, active: true },
      { name: 'Salon VIP', basePrice: 150 },
    );
    expect(changes).toEqual([
      { field: 'name', oldValue: 'Salon', newValue: 'Salon VIP' },
      { field: 'basePrice', oldValue: 100, newValue: 150 },
    ]);
  });

  it('compara objetos/arrays por valor, no por referencia', () => {
    const current = { fields: [{ name: 'talle', type: 'select' }] };
    const sameByValue = diffFields(current, { fields: [{ name: 'talle', type: 'select' }] });
    expect(sameByValue).toEqual([]);

    const changedByValue = diffFields(current, { fields: [{ name: 'talle', type: 'text' }] });
    expect(changedByValue).toEqual([
      {
        field: 'fields',
        oldValue: [{ name: 'talle', type: 'select' }],
        newValue: [{ name: 'talle', type: 'text' }],
      },
    ]);
  });

  it('trata null y undefined como valores distintos entre sí y de un string vacío', () => {
    const changes = diffFields({ description: null }, { description: '' });
    expect(changes).toEqual([{ field: 'description', oldValue: null, newValue: '' }]);
  });
});
