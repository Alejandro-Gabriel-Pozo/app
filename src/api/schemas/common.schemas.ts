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

/** Fecha YYYY-MM-DD (sin hora). */
export const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Cobertura de Zod, nivel 2 (25/08/2026, docs/auditoria-tecnica-infra-reservas.md)
 * — `reports.routes.ts` (11 endpoints), `orders.routes.ts` y
 * `reservations.routes.ts` hacían `new Date(req.query.from as string)`
 * directo: sin `from`, o con un valor tipo "ayer", da `Invalid Date` en
 * silencio (no un 400) y el reporte/filtro sale con basura en vez de
 * fallar. `dateOnlySchema` valida el formato Y que la fecha exista de
 * verdad (rechaza "2026-02-30", que `new Date()` acepta corriéndose
 * solo al 2 de marzo) antes de convertir a `Date` (medianoche UTC —
 * mismo criterio que `startDate` de maintenance windows: la fecha es un
 * día de negocio, no un instante con huso propio, A4.1/A4.2 de
 * criterios-negocio.md).
 */
export const dateOnlySchema = z.string()
  .regex(DATE_ONLY_REGEX, { message: 'debe tener formato YYYY-MM-DD' })
  .transform((value, ctx) => {
    const [year, month, day] = value.split('-').map(Number) as [number, number, number];
    const date = new Date(Date.UTC(year, month - 1, day));
    // new Date(Date.UTC(2026, 1, 30)) da 2026-03-02 (Date "rueda" el mes
    // que no existe) en vez de fallar -- roundtrip contra los mismos
    // componentes es la única forma de detectar eso.
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${value}" no es una fecha válida` });
      return z.NEVER;
    }
    return date;
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
