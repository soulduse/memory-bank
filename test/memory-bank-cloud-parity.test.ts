import { describe, it, expect } from 'vitest';
import {
  InMemoryMemoryBankCloudStore,
  MemoryBankCloudAuthorizationError,
  MemoryBankCloudHost,
  type CloudAccountContext,
  type CloudTokenIssuerContext,
} from '../src/memory-bank-cloud.js';

function account(overrides: Partial<CloudAccountContext> = {}): CloudAccountContext {
  return {
    tenantId: 'tenant-acme',
    orgId: 'org-platform',
    teamId: 'team-ai',
    projectId: 'project-memory-bank',
    userId: 'user-a',
    sourceAgent: 'codex',
    ...overrides,
  };
}

function issuerFor(ctx: CloudAccountContext, overrides: Partial<CloudTokenIssuerContext> = {}): CloudTokenIssuerContext {
  return { tenantId: ctx.tenantId, userId: 'issuer', scopeType: 'company', scopeId: ctx.tenantId, role: 'admin', ...overrides };
}

function host(): MemoryBankCloudHost {
  let tokenSeq = 0;
  return new MemoryBankCloudHost({ store: new InMemoryMemoryBankCloudStore(), now: () => new Date('2026-05-10T00:00:00.000Z'), tokenFactory: () => `token-${++tokenSeq}` });
}

function login(cloud: MemoryBankCloudHost, ctx: CloudAccountContext, issuer = issuerFor(ctx)) {
  const issued = cloud.issueLoginToken({ issuer, account: ctx, expiresInSeconds: 3600 });
  return cloud.loginWithToken(issued.token, { sessionId: ctx.userId, sourceAgent: ctx.sourceAgent });
}

describe('memory-bank-cloud parity with local memory-bank semantics', () => {
  it('supports cloud search/read/search_facts while enforcing tenant and issuer scope isolation', () => {
    const cloud = host();
    const claudeOrg = login(cloud, account({ userId: 'claude', sourceAgent: 'claude-code' }));
    const codexOrg = login(cloud, account({ userId: 'codex', sourceAgent: 'codex' }));
    const teamOnly = login(
      cloud,
      account({ userId: 'team-only', sourceAgent: 'codex' }),
      issuerFor(account({ userId: 'team-only', sourceAgent: 'codex' }), { scopeType: 'team', scopeId: 'team-ai' })
    );
    const globex = login(cloud, account({ tenantId: 'tenant-globex', orgId: 'org-g', teamId: 'team-g', projectId: 'project-g', userId: 'globex' }));

    cloud.putContext(claudeOrg.sessionToken, { scopeType: 'org', title: 'Org context', body: 'Shared architecture decision context.' });
    const orgExchange = cloud.ingestExchange(claudeOrg.sessionToken, {
      scopeType: 'org',
      sourceId: 'conversation-1',
      projectPath: '/repo/memory-bank',
      title: 'Cloud memory-bank launch plan',
      content: 'Supabase MCP host shares organization and team context without manual copy paste.',
      tags: ['supabase', 'mcp'],
    });
    const teamExchange = cloud.ingestExchange(teamOnly.sessionToken, {
      scopeType: 'team',
      title: 'Team-only convention',
      content: 'Team AI stores tactical implementation notes at team scope.',
    });
    cloud.putFact(claudeOrg.sessionToken, {
      scopeType: 'org',
      category: 'decision',
      fact: 'Cloud memory-bank must never expose one company context to another company.',
      sourceExchangeId: orgExchange.id,
      tags: ['isolation'],
    });

    const orgSearch = cloud.searchExchanges(codexOrg.sessionToken, { query: 'Supabase organization context' });
    expect(orgSearch.map((result) => result.exchange.id)).toEqual([orgExchange.id]);
    expect(cloud.readExchange(codexOrg.sessionToken, orgExchange.id).exchange.content).toContain('organization and team context');
    expect(cloud.searchFacts(codexOrg.sessionToken, { query: 'company context isolation' })[0].fact.category).toBe('decision');

    expect(cloud.searchExchanges(teamOnly.sessionToken, { query: 'Supabase organization context' })).toHaveLength(0);
    expect(cloud.searchExchanges(teamOnly.sessionToken, { query: 'tactical implementation notes' })[0].exchange.id).toBe(teamExchange.id);
    expect(cloud.searchExchanges(globex.sessionToken, { query: 'Supabase organization context' })).toHaveLength(0);
    expect(() => cloud.readExchange(teamOnly.sessionToken, orgExchange.id)).toThrow(MemoryBankCloudAuthorizationError);
    expect(() => cloud.readExchange(codexOrg.sessionToken, '/Users/some/local/file.jsonl')).toThrow(MemoryBankCloudAuthorizationError);
  });
});
