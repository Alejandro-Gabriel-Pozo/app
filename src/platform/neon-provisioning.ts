/**
 * @file neon-provisioning.ts
 * @description Crea la base de datos real de un tenant nuevo como un branch
 * de Neon, en el momento del registro — reemplaza el paso manual ("alguien
 * crea el branch a mano en la consola de Neon") que hasta el 15/08/2026 era
 * obligatorio antes de poder llamar a POST /api/admin/set-tenant-url.
 *
 * ## Por qué un branch "plantilla" y no el branch de producción
 * Los branches de Neon son copy-on-write del padre — ramificar desde el
 * branch que ya tiene datos reales de OTRO tenant copiaría esos datos
 * (reservas, clientes) al negocio nuevo. Por eso todos los tenants nuevos
 * ramifican de un branch dedicado, `NEON_TEMPLATE_BRANCH_ID`, que se
 * mantiene siempre vacío (nunca se le aplica schema.sql ni se le escribe
 * nada) — ver docs/pendientes-2026-08-14.md sección D para el detalle de
 * cómo se creó.
 *
 * ## Dos llamadas a la API de Neon, no una
 * 1. POST /branches — crea el branch + un compute endpoint read_write.
 *    Hereda el rol/base de datos del branch plantilla (copy-on-write).
 * 2. GET /projects/{id}/connection_uri?branch_id=...&pooled=true — el
 *    connection string completo (con password) no viene en la respuesta
 *    de (1). Es un endpoint a nivel de PROYECTO, no anidado bajo
 *    /branches/{id}/ — versión anterior de este archivo (15/08/2026,
 *    verificada rota en producción registrando un negocio real) usaba
 *    `GET /branches/{id}/connection_uris` (plural, anidado), que no existe
 *    — la API devolvía 404 "this route does not exist" y el negocio
 *    quedaba PENDING vía el fail-open. `pooled=true` porque el resto del
 *    código (tenant.middleware.ts, INCIDENT_LOG del 08/08) ya exige el
 *    endpoint con sufijo -pooler en producción — Render no mantiene
 *    conexiones persistentes, sin pooler la conexión falla.
 *    `role_name`/`database_name` hardcodeados a `neondb_owner`/`neondb` —
 *    son los que trae por defecto cualquier proyecto Neon creado desde la
 *    consola (confirmado en este proyecto, DB-APP-PPMS, vía
 *    get_connection_string del MCP), y el branch plantilla nunca se tocó
 *    para tener otros.
 *
 * ## Variables de entorno requeridas
 * - NEON_API_KEY          — API key de cuenta/proyecto (Neon Console →
 *                            Account Settings → API Keys). Secreto.
 * - NEON_PROJECT_ID       — proyecto Neon donde viven todos los tenants
 *                            (hoy: DB-APP-PPMS). No es secreto.
 * - NEON_TEMPLATE_BRANCH_ID — branch vacío del que ramifican los tenants
 *                            nuevos. No es secreto.
 */

import { getNeonApiKey, getNeonProjectId, getNeonTemplateBranchId } from '../config/env.js';

const NEON_API_BASE = 'https://console.neon.tech/api/v2';

export class NeonProvisioningError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'NeonProvisioningError';
  }
}

/**
 * Wave 7 (17/09/2026) -- antes leía `process.env[name]` con clave dinámica,
 * uno de los 2 blind spots que la cerca de conteo
 * (`process-env-usage-count.test.ts`) dejó documentados al no cubrir esa
 * forma. Ahora recibe el VALOR ya resuelto por `config/env.ts` -- cierra el
 * blind spot sin que este archivo, de dominio ajeno, tenga que saber cómo
 * se lee `process.env`.
 */
function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new NeonProvisioningError(`${name} no está definida — no se puede aprovisionar la BD del tenant.`);
  }
  return value;
}

interface CreateBranchResponse {
  branch: { id: string };
}

// Nombre de la respuesta no 100% confirmado contra la doc (la doc oficial
// de Neon dio resultados contradictorios entre sí al consultarla) — por
// eso neonApiFetch() más abajo devuelve el body crudo además de parseado,
// para poder loguear el shape real la primera vez que esto corra contra
// producción si `uri`/`connection_uri` no están donde se espera.
interface ConnectionUriResponse {
  uri?: string;
  connection_uri?: string;
}

async function neonApiFetch<T>(path: string, init?: RequestInit): Promise<{ data: T; raw: string }> {
  const apiKey = requireEnv('NEON_API_KEY', getNeonApiKey());
  const res = await fetch(`${NEON_API_BASE}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(init?.headers ?? {}),
    },
  });

  const raw = await res.text();

  if (!res.ok) {
    throw new NeonProvisioningError(`Neon API ${init?.method ?? 'GET'} ${path} → ${res.status}: ${raw.slice(0, 300)}`);
  }

  return { data: JSON.parse(raw) as T, raw };
}

/**
 * Crea un branch de Neon nuevo (ramificado de NEON_TEMPLATE_BRANCH_ID, con
 * compute endpoint propio) para un tenant y devuelve su connection string
 * lista para usar con applyTenantSchema()/encryptConnectionString().
 *
 * No aplica schema.sql ni activa el negocio — eso lo hace el caller
 * (business.routes.ts / platform.routes.ts), igual que ya hacía
 * admin.routes.ts con una connection string provista a mano.
 */
export async function provisionTenantDatabase(businessSlug: string): Promise<{ connectionString: string }> {
  const projectId = requireEnv('NEON_PROJECT_ID', getNeonProjectId());
  const templateBranchId = requireEnv('NEON_TEMPLATE_BRANCH_ID', getNeonTemplateBranchId());

  const { data: created } = await neonApiFetch<CreateBranchResponse>(`/projects/${projectId}/branches`, {
    method: 'POST',
    body: JSON.stringify({
      branch: {
        parent_id: templateBranchId,
        name: `tenant-${businessSlug}`,
      },
      endpoints: [{ type: 'read_write' }],
    }),
  });
  const branchId = created.branch.id;

  const qs = new URLSearchParams({
    branch_id: branchId,
    database_name: 'neondb',
    role_name: 'neondb_owner',
    pooled: 'true',
  });
  const { data: conn, raw } = await neonApiFetch<ConnectionUriResponse>(
    `/projects/${projectId}/connection_uri?${qs.toString()}`,
  );

  const connectionString = conn.uri ?? conn.connection_uri;
  if (!connectionString) {
    throw new NeonProvisioningError(
      `Branch ${branchId} creado pero no se pudo extraer el connection string de la respuesta. Body crudo: ${raw.slice(0, 300)}`,
    );
  }

  return { connectionString };
}
