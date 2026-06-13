import { describe, it, expect } from 'vitest';
import { SupabaseMemoryBankCloudStore, type MemoryBankCloudFetch } from '../src/memory-bank-cloud-supabase-store.js';
import type { CloudLoginTokenRecord, CloudExchangeRecord } from '../src/memory-bank-cloud.js';

describe('SupabaseMemoryBankCloudStore', () => {
  it('persists login token records by token_hash and never sends the raw login token', async () => {
    const calls: Array<{ url: string; init: Parameters<MemoryBankCloudFetch>[1] }> = [];
    const fetchImpl: MemoryBankCloudFetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, statusText: 'OK', text: async () => '' };
    };
    const store = new SupabaseMemoryBankCloudStore({ url: 'https://example.supabase.co', privilegedToken: 'server-token', fetch: fetchImpl });
    const record: CloudLoginTokenRecord = {
      id: '00000000-0000-0000-0000-000000000001',
      tokenHash: 'sha256-only',
      purpose: 'mcp_login',
      issuer: { tenantId: 'tenant-a', userId: 'issuer', scopeType: 'company', scopeId: 'tenant-a', role: 'admin' },
      account: { tenantId: 'tenant-a', orgId: 'org-a', teamId: 'team-a', projectId: 'project-a', userId: 'user-a', sourceAgent: 'codex' },
      memberships: [],
      createdAt: '2026-05-10T00:00:00.000Z',
      expiresAt: '2026-05-10T01:00:00.000Z',
      revokedAt: null,
    };

    await store.saveToken(record);

    expect(calls[0].url).toContain('/rest/v1/mbc_login_tokens');
    expect(calls[0].url).toContain('on_conflict=id');
    expect(calls[0].init.headers.Authorization).toBe('Bearer server-token');
    expect(JSON.parse(calls[0].init.body ?? '{}')).toMatchObject({ token_hash: 'sha256-only', purpose: 'mcp_login' });
    expect(calls[0].init.body).not.toContain('test-token');
  });

  it('maps Supabase rows back to cloud exchange records', async () => {
    const exchange: CloudExchangeRecord = {
      id: '00000000-0000-0000-0000-000000000002',
      tenantId: 'tenant-a', scopeType: 'team', scopeId: 'team-a', orgId: 'org-a', teamId: 'team-a', projectId: 'project-a', userId: 'user-a', sourceAgent: 'codex',
      sourceId: 'source-1', projectPath: '/repo', title: 'Cloud exchange', content: 'Supabase row mapping', tags: ['cloud'], createdAt: '2026-05-10T00:00:00.000Z', updatedAt: '2026-05-10T00:00:00.000Z',
    };
    const fetchImpl: MemoryBankCloudFetch = async (url, init) => {
      if (init.method === 'GET') {
        expect(url).toContain('tenant_id=eq.tenant-a');
        return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify([{ id: exchange.id, tenant_id: exchange.tenantId, scope_type: exchange.scopeType, scope_id: exchange.scopeId, org_id: exchange.orgId, team_id: exchange.teamId, project_id: exchange.projectId, user_id: exchange.userId, source_agent: exchange.sourceAgent, source_id: exchange.sourceId, project_path: exchange.projectPath, title: exchange.title, content: exchange.content, tags: exchange.tags, created_at: exchange.createdAt, updated_at: exchange.updatedAt }]) };
      }
      return { ok: true, status: 200, statusText: 'OK', text: async () => '' };
    };
    const store = new SupabaseMemoryBankCloudStore({ url: 'https://example.supabase.co', privilegedToken: 'server-token', fetch: fetchImpl });
    await store.saveExchange(exchange);
    await expect(store.listExchangesByTenant('tenant-a')).resolves.toEqual([exchange]);
  });
});
