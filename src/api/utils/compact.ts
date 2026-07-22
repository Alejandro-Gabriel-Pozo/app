/**
 * compact.ts
 * ----------
 * Elimina las propiedades cuyo valor es `undefined` de un objeto.
 *
 * Necesario cuando tsconfig tiene exactOptionalPropertyTypes: true.
 * Con esa flag, { key: undefined } y la ausencia de la clave son tipos
 * distintos. compact() convierte el primero en el segundo.
 *
 * Uso:
 *   const filters = compact({ status, resourceId, from });
 *   // → solo incluye las claves cuyos valores NO son undefined
 */

// RequiredDefined<T> = T sin las claves que admiten undefined como valor.
// Esto le dice a TypeScript que el objeto resultante solo tiene las claves
// cuyo valor está efectivamente presente, satisfaciendo exactOptionalPropertyTypes.
export type RequiredDefined<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

export function compact<T extends object>(obj: T): RequiredDefined<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as RequiredDefined<T>;
}
