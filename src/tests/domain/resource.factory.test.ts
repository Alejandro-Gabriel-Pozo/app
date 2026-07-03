/**
 * @file resource.factory.test.ts
 * @deprecated El factory `createBookableResource` fue eliminado junto con la
 * jerarquía de subclases (CabinResource, TableResource, etc.).
 * Los casos de creación de recursos migran a `entities.test.ts`.
 *
 * Este archivo se mantiene para preservar el historial de git.
 */

import { describe, it } from 'vitest';

describe('ResourceFactory (deprecated — migrado a entities.test.ts)', () => {
  it.todo('migrado a src/tests/domain/entities.test.ts');
});
