import { ResourceType } from '../types/enums.js';
import { PreferenceDetailsByResource } from '../types/preferences.types.js';
import { ValidationError, UnsupportedResourceTypeError } from '../domain/errors.js';
import { preferenceSchemaRegistry } from './validation.registry.js';

export function validatePreferences<T extends ResourceType>(
  type: T,
  data: unknown,
): PreferenceDetailsByResource[T] {
  const schema = preferenceSchemaRegistry[type];

  if (!schema) {
    throw new UnsupportedResourceTypeError(type);
  }

  const result = schema.safeParse(data);

  if (!result.success) {
    throw new ValidationError(result.error);
  }

  return result.data as PreferenceDetailsByResource[T];
}