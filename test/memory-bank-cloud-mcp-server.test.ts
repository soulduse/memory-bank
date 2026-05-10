import { describe, it, expect } from 'vitest';
import { createMemoryBankCloudServer } from '../src/memory-bank-cloud-server.js';
import { InMemoryMemoryBankCloudStore, MemoryBankCloudHost, type CloudAccountContext, type CloudTokenIssuerContext } from '../src/memory-bank-cloud.js';
import { callMemoryBankCloudMcpTool, listMemoryBankCloudMcpTools } from '../src/memory-bank-cloud-mcp.js';

function account(overrides: Partial<CloudAccountContext> = {}): CloudAccountContext {
  return { tenantId: 'tenant-acme', orgId: 'org-platform', teamId: 'team-ai', projectId: 'project-memory-bank', userId: 'user-a', sourceAgent: 'codex', ...overrides };
}
function issuerFor(ctx: CloudAccountContext): CloudTokenIssuerContext {
  return { tenantId: ctx.tenantId, userId: 'issuer', scopeType: 'company', scopeId: ctx.tenantId, role: 'admin' };
}
function host(): MemoryBankCloudHost {
  return new MemoryBankCloudHost({ store: new InMemoryMemoryBankCloudStore(), now: () => new Date('2026-05-10T00:00:00.000Z'), tokenFactory: () => 'token-mcp' });
}

describe('memory-bank-cloud MCP server wiring', () => {
  it('constructs a dedicated cloud MCP server and keeps issue_token admin-only', () => {
    const cloud = host();
    expect(createMemoryBankCloudServer({ host: cloud })).toBeTruthy();
    expect(listMemoryBankCloudMcpTools().some((tool) => tool.name === 'memory_bank_cloud_issue_token')).toBe(false);
    expect(listMemoryBankCloudMcpTools({ includeAdminTools: true }).some((tool) => tool.name === 'memory_bank_cloud_issue_token')).toBe(true);
  });

  it('runs cloud ingest/search/read/search_facts through MCP-shaped calls', async () => {
    const cloud = host();
    const ctx = account({ userId: 'codex' });
    const issued = JSON.parse(await callMemoryBankCloudMcpTool(cloud, 'memory_bank_cloud_issue_token', { issuer: issuerFor(ctx), account: ctx })) as { token: string };
    const session = JSON.parse(await callMemoryBankCloudMcpTool(cloud, 'memory_bank_cloud_login', { token: issued.token, sourceAgent: 'codex' })) as { sessionToken: string };
    const exchange = JSON.parse(await callMemoryBankCloudMcpTool(cloud, 'memory_bank_cloud_ingest_exchange', {
      sessionToken: session.sessionToken,
      scopeType: 'project',
      title: 'MCP parity test',
      content: 'Cloud search and read behave like memory-bank search and read.',
    })) as { id: string };
    const search = JSON.parse(await callMemoryBankCloudMcpTool(cloud, 'memory_bank_cloud_search', { sessionToken: session.sessionToken, query: 'search read' })) as Array<{ exchange: { id: string } }>;
    expect(search[0].exchange.id).toBe(exchange.id);
    const read = JSON.parse(await callMemoryBankCloudMcpTool(cloud, 'memory_bank_cloud_read', { sessionToken: session.sessionToken, id: exchange.id })) as { exchange: { title: string } };
    expect(read.exchange.title).toBe('MCP parity test');
    await callMemoryBankCloudMcpTool(cloud, 'memory_bank_cloud_put_fact', { sessionToken: session.sessionToken, scopeType: 'project', category: 'knowledge', fact: 'MCP cloud facts are searchable.', sourceExchangeId: exchange.id });
    const facts = JSON.parse(await callMemoryBankCloudMcpTool(cloud, 'memory_bank_cloud_search_facts', { sessionToken: session.sessionToken, query: 'cloud facts' })) as Array<{ fact: { fact: string } }>;
    expect(facts[0].fact.fact).toContain('searchable');
  });
});
