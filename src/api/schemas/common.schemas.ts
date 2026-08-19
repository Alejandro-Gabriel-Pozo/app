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
