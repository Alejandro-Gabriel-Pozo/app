/**
 * @file common.schemas.ts
 * @description Piezas de validación genuinamente transversales, reusadas por
 * más de un módulo de negocio (Fase 2, docs/auditoria-modularidad.md,
 * hallazgo DRY-1: el mismo regex de hora vivía repetido 7 veces en 4
 * archivos, incluidas dos copias dentro del propio request.schemas.ts).
 *
 * Si un valor acá empieza a necesitar variantes por módulo, sacarlo de este
 * archivo — esto es solo para lo que de verdad es un único concepto en todo
 * el dominio, mismo criterio que ya regía `domain/audit.ts::diffFields()`.
 */

import { z } from 'zod';

/** Hora de pared HH:MM o HH:MM:SS (A4.3, criterios-negocio.md). */
export const TIME_ONLY_REGEX = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/** Zod schema listo para usar cuando no hace falta un mensaje con el nombre del campo. */
export const timeOnlySchema = z.string().regex(TIME_ONLY_REGEX, {
  message: 'debe tener formato HH:MM o HH:MM:SS',
});

/**
 * CUIT (Clave Única de Identificación Tributaria, AFIP) — 18/08/2026,
 * Facturación Electrónica AFIP Fase 1. Genuinamente transversal desde el
 * arranque: lo va a usar tanto el perfil fiscal del negocio EMISOR
 * (`business_profile`) como, más adelante, `customer_tax_profiles` (el
 * lado comprador) — misma regla de negocio en los dos lugares, no un
 * caso de "esperar a la segunda copia" como con el regex de hora.
 *
 * Valida formato (11 dígitos, con o sin guiones XX-XXXXXXXX-X) Y el
 * dígito verificador (módulo 11) — un CUIT con el formato correcto pero
 * el dígito verificador mal es indistinguible de uno bien tipeado hasta
 * que AFIP lo rechaza; mejor detectarlo acá, en el formulario.
 */
function isValidCuitChecksum(digits: string): boolean {
  const multipliers = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = multipliers.reduce((acc, m, i) => acc + m * Number(digits[i]), 0);
  const remainder = 11 - (sum % 11);
  const expectedCheckDigit = remainder === 11 ? 0 : remainder === 10 ? 9 : remainder;
  return expectedCheckDigit === Number(digits[10]);
}

export const cuitSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/-/g, ''))
  .refine((v) => /^\d{11}$/.test(v), { message: 'CUIT debe tener 11 dígitos (con o sin guiones)' })
  .refine((v) => isValidCuitChecksum(v), { message: 'CUIT inválido — el dígito verificador no coincide' });
