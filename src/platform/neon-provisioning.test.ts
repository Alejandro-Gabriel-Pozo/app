import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { provisionTenantDatabase, NeonProvisioningError } from './neon-provisioning.js';

const ORIGINAL_ENV = { ...process.env };

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('provisionTenantDatabase', () => {
  beforeEach(() => {
    process.env.NEON_API_KEY = 'fake-api-key';
    process.env.NEON_PROJECT_ID = 'proj-1';
    process.env.NEON_TEMPLATE_BRANCH_ID = 'branch-template';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it('sin NEON_API_KEY definida, falla explícito antes de llamar a fetch', async () => {
    delete process.env.NEON_API_KEY;
    const fetchSpy = vi.spyOn(global, 'fetch');

    await expect(provisionTenantDatabase('negocio-nuevo')).rejects.toThrow(NeonProvisioningError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sin NEON_PROJECT_ID definida, falla explícito', async () => {
    delete process.env.NEON_PROJECT_ID;
    await expect(provisionTenantDatabase('negocio-nuevo')).rejects.toThrow(/NEON_PROJECT_ID/);
  });

  it('sin NEON_TEMPLATE_BRANCH_ID definida, falla explícito', async () => {
    delete process.env.NEON_TEMPLATE_BRANCH_ID;
    await expect(provisionTenantDatabase('negocio-nuevo')).rejects.toThrow(/NEON_TEMPLATE_BRANCH_ID/);
  });

  it('camino feliz: crea el branch ramificado de la plantilla y devuelve el connection string (campo uri)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ branch: { id: 'branch-nuevo' } }))
      .mockResolvedValueOnce(jsonResponse({ uri: 'postgresql://neondb_owner:pass@ep-pooler/neondb' }));

    const result = await provisionTenantDatabase('negocio-nuevo');

    expect(result.connectionString).toBe('postgresql://neondb_owner:pass@ep-pooler/neondb');

    const [createUrl, createInit] = fetchSpy.mock.calls[0]!;
    expect(createUrl).toContain('/projects/proj-1/branches');
    const createBody = JSON.parse((createInit as RequestInit).body as string);
    expect(createBody.branch.parent_id).toBe('branch-template'); // rama del template, nunca de producción
    expect(createBody.branch.name).toBe('tenant-negocio-nuevo');

    const [connUrl] = fetchSpy.mock.calls[1]!;
    expect(connUrl).toContain('/projects/proj-1/connection_uri?');
    expect(connUrl).toContain('branch_id=branch-nuevo');
    expect(connUrl).toContain('pooled=true'); // sin pooler, Render no sostiene la conexión
  });

  it('acepta el campo connection_uri como fallback si uri no viene (shape de respuesta no 100% confirmado)', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ branch: { id: 'branch-nuevo' } }))
      .mockResolvedValueOnce(jsonResponse({ connection_uri: 'postgresql://fallback' }));

    const result = await provisionTenantDatabase('negocio-nuevo');

    expect(result.connectionString).toBe('postgresql://fallback');
  });

  it('si ninguno de los dos campos viene en la respuesta, falla explícito con el body crudo', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ branch: { id: 'branch-nuevo' } }))
      .mockResolvedValueOnce(jsonResponse({ algo_inesperado: true }));

    await expect(provisionTenantDatabase('negocio-nuevo')).rejects.toThrow(/no se pudo extraer el connection string/);
  });

  it('un 404 (endpoint plural viejo, ya no existe) se mapea a NeonProvisioningError con el status y el body', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'this route does not exist',
    } as Response);

    await expect(provisionTenantDatabase('negocio-nuevo')).rejects.toThrow(/404/);
  });

  it('manda el Authorization Bearer con la API key en cada llamada', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ branch: { id: 'branch-nuevo' } }))
      .mockResolvedValueOnce(jsonResponse({ uri: 'postgresql://algo' }));

    await provisionTenantDatabase('negocio-nuevo');

    for (const call of fetchSpy.mock.calls) {
      const init = call[1] as RequestInit;
      expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer fake-api-key');
    }
  });
});
