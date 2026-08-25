/**
 * @file audit-log.routes.test.ts
 * @description I3 (pendientes-2026-08-24.md) — GET /api/audit-log ahora
 * resuelve `changed_by` a un nombre vía `platformRepo.findIdentitiesByIds`,
 * porque audit_log (BD del tenant) e identities (BD de plataforma) no se
 * pueden JOINear directo.
 */

import { describe, it, expect, vi } from 'vitest';
import { createAuditLogRouter } from './audit-log.routes.js';
import type { PlatformRepository, Identity } from '../../platform/platform.repository.js';
import type { Request, Response } from 'express';

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  return res as Response & { statusCode?: number; body?: unknown };
}

function makeIdentity(overrides: Partial<Identity> = {}): Identity {
  return {
    id: 'identity-1',
    email: 'admin@demo.com',
    passwordHash: 'hash',
    googleSub: null,
    fullName: null,
    dni: null,
    phone: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function getHandler(router: ReturnType<typeof createAuditLogRouter>) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === '/' && l.route.methods.get);
  if (!layer?.route) throw new Error('GET / no está montado');
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
}

function fakeDbWithEntries(rows: Array<{ changed_by: string; field: string }>) {
  return {
    query: vi.fn(async () => ({
      rows: rows.map((r, i) => ({
        id: `audit-${i}`,
        entity: 'products',
        entity_id: 'p1',
        field: r.field,
        old_value: 'a',
        new_value: 'b',
        changed_by: r.changed_by,
        changed_at: new Date().toISOString(),
      })),
    })),
  };
}

describe('GET /api/audit-log', () => {
  it('agrega changedByName resolviendo el lote de ids únicos', async () => {
    const findIdentitiesByIds = vi.fn(async () => [
      makeIdentity({ id: 'identity-1', fullName: 'Ana Admin', email: 'ana@demo.com' }),
      makeIdentity({ id: 'identity-2', fullName: null, email: 'sin-nombre@demo.com' }),
    ]);
    const platformRepo = { findIdentitiesByIds } as unknown as PlatformRepository;
    const router = createAuditLogRouter(platformRepo);
    const handler = getHandler(router);

    const req = {
      db: fakeDbWithEntries([
        { changed_by: 'identity-1', field: 'name' },
        { changed_by: 'identity-2', field: 'active' },
        { changed_by: 'identity-1', field: 'price' },
      ]),
      query: { entity: 'products', entityId: 'p1' },
    } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(findIdentitiesByIds).toHaveBeenCalledWith(['identity-1', 'identity-2']);
    const body = res.body as Array<{ changedBy: string; changedByName: string }>;
    expect(body[0]).toMatchObject({ changedBy: 'identity-1', changedByName: 'Ana Admin' });
    expect(body[1]).toMatchObject({ changedBy: 'identity-2', changedByName: 'sin-nombre@demo.com' });
    expect(body[2]).toMatchObject({ changedBy: 'identity-1', changedByName: 'Ana Admin' });
  });

  it('cae a "Usuario desconocido" si la identity no aparece en el lote', async () => {
    const findIdentitiesByIds = vi.fn(async () => []);
    const platformRepo = { findIdentitiesByIds } as unknown as PlatformRepository;
    const router = createAuditLogRouter(platformRepo);
    const handler = getHandler(router);

    const req = {
      db: fakeDbWithEntries([{ changed_by: 'identity-huerfana', field: 'name' }]),
      query: { entity: 'products', entityId: 'p1' },
    } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    const body = res.body as Array<{ changedByName: string }>;
    expect(body[0]?.changedByName).toBe('Usuario desconocido');
  });

  it('rechaza con 400 si faltan entity/entityId', async () => {
    const platformRepo = { findIdentitiesByIds: vi.fn() } as unknown as PlatformRepository;
    const router = createAuditLogRouter(platformRepo);
    const handler = getHandler(router);

    const req = { db: fakeDbWithEntries([]), query: {} } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(400);
  });
});
