/**
 * @file in-memory.processed-event.repository.ts
 * @description Implementación en memoria de `ProcessedEventRepository`.
 * Mismo par de archivos que `audit-log.repository.ts` /
 * `in-memory.audit-log.repository.ts` (puerto + SQL juntos, in-memory
 * aparte). Ver `processed-event.repository.ts` para el contrato.
 *
 * `claim()` acá también es "chequear y tomar" en un solo paso — el Set es
 * sincrónico, así que no hay ventana entre el `has` y el `add`. Es la misma
 * garantía que da el `ON CONFLICT DO NOTHING` en la versión SQL, no una
 * aproximación más laxa.
 */

import type { ProcessedEventRepository } from './processed-event.repository.js';

export class InMemoryProcessedEventRepository implements ProcessedEventRepository {
  private readonly claimed = new Set<string>();

  private static key(domainEventId: number, handlerName: string): string {
    return `${domainEventId}::${handlerName}`;
  }

  claim(domainEventId: number, handlerName: string): Promise<boolean> {
    const key = InMemoryProcessedEventRepository.key(domainEventId, handlerName);
    if (this.claimed.has(key)) return Promise.resolve(false);
    this.claimed.add(key);
    return Promise.resolve(true);
  }

  release(domainEventId: number, handlerName: string): Promise<void> {
    this.claimed.delete(InMemoryProcessedEventRepository.key(domainEventId, handlerName));
    return Promise.resolve();
  }
}
