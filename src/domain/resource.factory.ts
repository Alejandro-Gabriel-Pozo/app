/**
 * @file resource.factory.ts
 * @deprecated Eliminado en feat/domain-cleanup.
 *
 * `createBookableResource()` mapeaba un `type: ResourceType` a la subclase
 * concreta correspondiente (CabinResource, TableResource, etc.).
 * Esa jerarquía de subclases ya no existe — hay una sola clase `BookableResource`
 * con `categoryId: string`.
 *
 * Este archivo se mantiene vacío para no romper imports residuales.
 * Eliminar en el próximo PR de limpieza final.
 */

export {};
