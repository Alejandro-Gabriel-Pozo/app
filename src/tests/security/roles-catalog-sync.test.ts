import { describe, it, expect } from 'vitest';
import { Roles } from '../../security/roles.js';

/**
 * ROLES-CATALOG-DRIFT-001 (09/09/2026, gate `architecture-governor`) --
 * agregar/sacar/RENOMBRAR un grupo de `Roles` (`src/security/roles.ts`) es
 * un cambio que tiene que propagarse a varias superficies, ninguna
 * verificada automáticamente hasta hoy. Nació del caso real de
 * `EMISOR_NOTA_CREDITO`: agregado al backend el 07/09/2026, propagado a los
 * presets y al ADR el mismo día, pero nunca propagado a
 * `appfrontend-main` -- descubierto recién el 09/09/2026 (bloque 5.1,
 * `docs/pendientes-2026-09-08.md`), y a esta hora **sigue sin propagarse a
 * uno de los tres catálogos del frontend** (ver "Lo que esta cerca NO
 * cubre" más abajo -- esto está VERDE con esa deuda todavía abierta).
 *
 * ## Por qué el conjunto CONGELADO, no un conteo
 * Un `Object.values(Roles).length === 9` es ciego a la mutación más cara
 * del catálogo: RENOMBRAR una clave. `roles.ts:55-57` declara que estas
 * claves viven en `role_permission_groups.permission_group` de cada
 * tenant -- cambiarlas es una migración de datos. Un rename deja el
 * conteo en 9, esta cerca en verde (si fuera un conteo), la BD de cada
 * tenant con la clave vieja, y los catálogos del frontend apuntando a un
 * grupo que ya no existe. Comparar contra el conjunto ORDENADO cierra ese
 * hueco: el diff de la aserción dice QUÉ clave cambió, no solo que el
 * tamaño se movió.
 *
 * ## Por qué `key === value` (mismo commit, no separado)
 * Si algún día `Roles.FOO = 'MANAGEMENT'` (identificador de código que no
 * coincide con el string persistido), `authorize(Roles.FOO)` compilaría
 * pero la comparación real contra `role_permission_groups.permission_group`
 * fallaría en silencio -- un 403 sin razón visible en el código que lo
 * dispara. Hoy las 9 cumplen `key === value`; queda como invariante, no
 * como coincidencia.
 *
 * ## SI ESTO ROMPE
 * Agregaste, sacaste o renombraste un grupo en `Roles`. Actualizá
 * `EXPECTED_PERMISSION_GROUPS` acá Y propagá el cambio a `appfrontend-main`
 * -- **los 3 catálogos a mano de grupos de permisos de ese repo, cada uno
 * con su propia regla de inclusión** (ver tabla abajo, verificada
 * 09-10/09/2026 -- no asumas que es "copiar la lista completa a los 3":
 * eso mete `CUSTOMER_ONLY` donde no va). Y revisá
 * `docs/pendientes-2026-09-08.md` bloque 5.1 para el precedente real de
 * qué pasa si no lo hacés en el mismo cambio.
 *
 * ### Los 3 catálogos de `appfrontend-main`, con su regla (verificado 09-10/09/2026)
 * - `src/app/dashboard/roles/page.tsx` (`PERMISSION_GROUPS`, `{value,label}`)
 *   -- catálogo de roles CUSTOM de un negocio. Excluye `CUSTOMER_ONLY` A
 *   PROPÓSITO (comentario propio: "nunca aplica a un rol de STAFF armado
 *   acá"). Pide label en español. Hoy: 8 de 9 (falta `CUSTOMER_ONLY` a
 *   propósito -- correcto, no es un hueco).
 * - `src/app/superadmin/planes/page.tsx` (`PERMISSION_GROUPS`, `string[]`)
 *   -- qué grupos puede incluir un rol custom por plan
 *   (`plan_limit_allowed_permission_groups`). Lista completa, sin
 *   exclusiones. Hoy: 9 de 9 -- al día.
 * - `src/app/superadmin/roles-de-fabrica/page.tsx` (`PERMISSION_GROUPS`,
 *   `string[]`) -- qué grupos tiene cada preset de fábrica. Lista completa,
 *   sin exclusiones. **Hoy: 8 de 9, sin `EMISOR_NOTA_CREDITO` -- hueco
 *   real, abierto a propósito** (agregar el checkbox exige corregir antes
 *   la copy falsa de esa misma pantalla sobre que editar ahí "no afecta a
 *   negocios existentes" -- SÍ afecta, por backfill; bloque cross-repo
 *   propio, ver `docs/pendientes-2026-09-08.md` bloque 5.1).
 *
 * ## Lo que esta cerca NO cubre
 * 1. NO verifica que `appfrontend-main` se haya actualizado -- es un
 *    recordatorio en el momento del cambio de ESTE repo, no un chequeo de
 *    sincronía real entre los dos. No hay CI compartida entre los dos
 *    repos que pueda hacer eso.
 * 2. **Está verde HOY con un catálogo del frontend todavía desincronizado**
 *    (`roles-de-fabrica/page.tsx`, 8 de 9). Verde acá no implica "los
 *    catálogos del frontend están en sync" -- implica solo "el catálogo de
 *    ESTE repo no cambió de forma inesperada".
 * 3. NO cubre las otras superficies same-repo que también hay que
 *    propagar a mano al agregar un grupo: `role_preset_permission_groups`
 *    (`src/db/platform.schema.sql:376-392`), `plan_limit_allowed_permission_groups`
 *    (`platform.schema.sql:855-859`), `CUSTOMER_PERMISSION_GROUPS`
 *    (`roles.ts:74-84`, sincronizado a mano por su propio docblock),
 *    `docs/rbac-matriz-endpoints.md` (columna de grupo por fila), y la
 *    prosa de `platform.schema.sql:228-231` (a la fecha de este commit,
 *    ya STALE -- dice "~7 claves fijas" y lista 7, sin
 *    `EMISOR_NOTA_CREDITO`; hallazgo nuevo, bloque de docs aparte, no
 *    corregido acá).
 */

/** Conjunto ORDENADO congelado -- ver el docblock de arriba para por qué
 *  no es un conteo. */
const EXPECTED_PERMISSION_GROUPS = [
  'BOOKING',
  'CUSTOMER_ONLY',
  'EMISOR_NOTA_CREDITO',
  'FRONT_DESK',
  'HOUSEKEEPING_AND_MANAGEMENT',
  'MANAGEMENT',
  'ORDERS',
  'OWNER_ONLY',
  'STAFF',
].sort();

describe('ROLES-CATALOG-DRIFT-001 -- el catálogo Roles no cambia sin que se note', () => {
  it('el conjunto de grupos de Roles es exactamente el esperado (agregar/sacar/renombrar rompe acá)', () => {
    const actual = Object.values(Roles).sort();
    expect(
      actual,
      'Roles (src/security/roles.ts) cambió de forma. Actualizá EXPECTED_PERMISSION_GROUPS acá Y propagá el cambio a appfrontend-main -- ver el docblock de este archivo para los 3 catálogos y sus reglas de inclusión, y docs/pendientes-2026-09-08.md bloque 5.1 para el precedente real de qué pasa si no lo hacés en el mismo commit.',
    ).toEqual(EXPECTED_PERMISSION_GROUPS);
  });

  it('cada clave de Roles es igual a su valor (la clave persiste tal cual en role_permission_groups)', () => {
    const mismatches = Object.entries(Roles).filter(([key, value]) => key !== value);
    expect(
      mismatches,
      `Roles.<clave> !== '<valor>' en: ${mismatches.map(([k, v]) => `${k}='${v}'`).join(', ')} -- la clave de TypeScript tiene que ser idéntica al string que se persiste en role_permission_groups.permission_group, si no authorize() compara contra un valor que nadie otorgó nunca.`,
    ).toEqual([]);
  });
});
