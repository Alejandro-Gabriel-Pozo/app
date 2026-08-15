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
 *    Hereda el rol/base de datos del branch plantilla (copy-on-write), así
 *    que no hace falta pasar role_name/database_name.
 * 2. GET /branches/{id}/connection_uris?pooled=true — el connection string
 *    completo (con password) no viene en la respuesta de (1). `pooled=true`
 *    porque el resto del código (tenant.middleware.ts, INCIDENT_LOG del
 *    08/08) ya exige el endpoint con sufijo -pooler en producción — Render
 *    no mantiene conexiones persistentes, sin pooler la conexión falla.
 *
 * ## Variables de entorno requeridas
 * - NEON_API_KEY          — API key de cuenta/proyecto (Neon Console →
 *                            Account Settings → API Keys). Secreto.
 * - NEON_PROJECT_ID       — proyecto Neon donde viven todos los tenants
 *                            (hoy: DB-APP-PPMS). No es secreto.
 * - NEON_TEMPLATE_BRANCH_ID — branch vacío del que ramifican los tenants
 *                            nuevos. No es secreto.
 */

const NEON_API_BASE = 'https://console.neon.tech/api/v2';

export class NeonProvisioningError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'NeonProvisioningError';
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new NeonProvisioningError(`${name} no está definida — no se puede aprovisionar la BD del tenant.`);
  }
  return value;
}

interface CreateBranchResponse {
  branch: { id: string };
}

interface ConnectionUrisResponse {
  connection_uris: { connection_uri: string }[];
}

async function neonApiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const apiKey = requireEnv('NEON_API_KEY');
  const res = await fetch(`${NEON_API_BASE}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '<sin body>');
    throw new NeonProvisioningError(`Neon API ${init?.method ?? 'GET'} ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }

  return res.json() as Promise<T>;
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
  const projectId = requireEnv('NEON_PROJECT_ID');
  const templateBranchId = requireEnv('NEON_TEMPLATE_BRANCH_ID');

  const { branch } = await neonApiFetch<CreateBranchResponse>(`/projects/${projectId}/branches`, {
    method: 'POST',
    body: JSON.stringify({
      branch: {
        parent_id: templateBranchId,
        name: `tenant-${businessSlug}`,
      },
      endpoints: [{ type: 'read_write' }],
    }),
  });

  const { connection_uris } = await neonApiFetch<ConnectionUrisResponse>(
    `/projects/${projectId}/branches/${branch.id}/connection_uris?pooled=true`,
  );

  const connectionString = connection_uris[0]?.connection_uri;
  if (!connectionString) {
    throw new NeonProvisioningError(`Branch ${branch.id} creado pero la API no devolvió connection_uris.`);
  }

  return { connectionString };
}
