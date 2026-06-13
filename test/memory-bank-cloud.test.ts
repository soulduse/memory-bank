import { describe, it, expect } from 'vitest';
import {
  InMemoryMemoryBankCloudStore,
  MemoryBankCloudAuthorizationError,
  MemoryBankCloudHost,
  type CloudAccountContext,
  type CloudTokenIssuerContext,
} from '../src/memory-bank-cloud.js';
import { callMemoryBankCloudMcpTool, listMemoryBankCloudMcpTools } from '../src/memory-bank-cloud-mcp.js';

function account(overrides: Partial<CloudAccountContext> = {}): CloudAccountContext {
  return {
    tenantId: 'tenant-acme',
    orgId: 'org-platform',
    teamId: 'team-ai',
    projectId: 'project-memory-bank',
    userId: 'user-a',
    sourceAgent: 'claude-code',
    ...overrides,
  };
}

function host(): MemoryBankCloudHost {
  let tokenSeq = 0;
  return new MemoryBankCloudHost({
    store: new InMemoryMemoryBankCloudStore(),
    now: () => new Date('2026-05-10T00:00:00.000Z'),
    tokenFactory: () => `test-token-${++tokenSeq}`,
  });
}

function issuerFor(ctx: CloudAccountContext = account(), overrides: Partial<CloudTokenIssuerContext> = {}): CloudTokenIssuerContext {
  return {
    tenantId: ctx.tenantId,
    userId: 'issuer-admin',
    scopeType: 'company',
    scopeId: ctx.tenantId,
    role: 'admin',
    ...overrides,
  };
}

function login(cloud: MemoryBankCloudHost, ctx: CloudAccountContext = account(), issuer: CloudTokenIssuerContext = issuerFor(ctx)) {
  const issued = cloud.issueLoginToken({ issuer, account: ctx, expiresInSeconds: 3600 });
  return cloud.loginWithToken(issued.token, { sessionId: `session-${ctx.userId}`, sourceAgent: ctx.sourceAgent });
}

describe('MemoryBankCloudHost', () => {
  it('issues a token and resolves tenant/org/team/project/user context on login', () => {
    const cloud = host();
    const ctx = account({ userId: 'user-token' });
    const issued = cloud.issueLoginToken({ issuer: issuerFor(ctx), account: ctx });

    expect(issued.token).toBe('test-token-1');
    expect(issued.issuer).toMatchObject({ tenantId: 'tenant-acme', scopeType: 'company', scopeId: 'tenant-acme' });
    expect(issued.account.tenantId).toBe('tenant-acme');

    const session = cloud.loginWithToken(issued.token, { terminalId: 'term-1', sessionId: 'codex-session', sourceAgent: 'codex' });

    expect(session.account).toMatchObject({
      tenantId: 'tenant-acme',
      orgId: 'org-platform',
      teamId: 'team-ai',
      projectId: 'project-memory-bank',
      userId: 'user-token',
      terminalId: 'term-1',
      sessionId: 'codex-session',
      sourceAgent: 'codex',
    });
    expect(session.memberships.map((membership) => `${membership.scopeType}:${membership.scopeId}`)).toEqual([
      'company:tenant-acme',
      'org:org-platform',
      'team:team-ai',
      'project:project-memory-bank',
      'personal:user-token',
    ]);
  });

  it('requires the token issuer to stay inside its own tenant and scope boundary', () => {
    const cloud = host();
    const globex = account({ tenantId: 'tenant-globex', orgId: 'org-g', teamId: 'team-g', projectId: 'project-g', userId: 'user-g' });

    expect(() =>
      cloud.issueLoginToken({
        issuer: issuerFor(account({ tenantId: 'tenant-acme' })),
        account: globex,
      })
    ).toThrow(MemoryBankCloudAuthorizationError);

    expect(() =>
      cloud.issueLoginToken({
        issuer: issuerFor(account(), { scopeType: 'team', scopeId: 'team-ai' }),
        account: account({ teamId: 'team-other' }),
      })
    ).toThrow(MemoryBankCloudAuthorizationError);
  });

  it('limits context sharing to the token issuer subject boundary', () => {
    const cloud = host();
    const ctx = account({ userId: 'user-team-issued', teamId: 'team-ai' });
    const session = login(cloud, ctx, issuerFor(ctx, { scopeType: 'team', scopeId: 'team-ai' }));

    expect(session.memberships.map((membership) => `${membership.scopeType}:${membership.scopeId}`)).toEqual([
      'team:team-ai',
      'project:project-memory-bank',
      'personal:user-team-issued',
    ]);
    expect(() =>
      cloud.putContext(session.sessionToken, {
        scopeType: 'org',
        title: 'Out-of-bound org context',
        body: 'A team-issued token cannot write org-wide context.',
      })
    ).toThrow(MemoryBankCloudAuthorizationError);

    cloud.putContext(session.sessionToken, {
      scopeType: 'team',
      title: 'Team-issued rule',
      body: 'This context is shared only inside the issuing team boundary.',
    });

    expect(cloud.getContextBundle(session.sessionToken, { query: 'issuing team' }).entries).toHaveLength(1);
  });

  it('shares organization context automatically across Claude and Codex sessions in the same org', () => {
    const cloud = host();
    const claude = login(cloud, account({ userId: 'user-claude', sourceAgent: 'claude-code' }));
    const codex = login(cloud, account({ userId: 'user-codex', sourceAgent: 'codex' }));

    cloud.putContext(claude.sessionToken, {
      scopeType: 'org',
      title: 'Org deployment rule',
      body: 'All production deploys require a QA evidence artifact before merge.',
      tags: ['qa', 'release'],
    });

    const bundle = cloud.getContextBundle(codex.sessionToken, { query: 'production deploys' });

    expect(bundle.account.sourceAgent).toBe('codex');
    expect(bundle.entries).toHaveLength(1);
    expect(bundle.entries[0].scopeType).toBe('org');
    expect(bundle.entries[0].body).toContain('QA evidence');
  });

  it('keeps personal context private while team context is shared only inside the team', () => {
    const cloud = host();
    const userA = login(cloud, account({ userId: 'user-a', teamId: 'team-ai' }));
    const sameTeam = login(cloud, account({ userId: 'user-b', teamId: 'team-ai' }));
    const otherTeam = login(cloud, account({ userId: 'user-c', teamId: 'team-design', projectId: 'project-design' }));

    cloud.putContext(userA.sessionToken, {
      scopeType: 'personal',
      title: 'Private tone preference',
      body: 'User A prefers short Korean replies.',
    });
    cloud.putContext(userA.sessionToken, {
      scopeType: 'team',
      title: 'Team MCP convention',
      body: 'Team AI uses MCP context bundles before coding tasks.',
    });

    const sameTeamBundle = cloud.getContextBundle(sameTeam.sessionToken, { query: 'MCP context' });
    const otherTeamBundle = cloud.getContextBundle(otherTeam.sessionToken, { query: 'MCP context' });
    const privateBundle = cloud.getContextBundle(sameTeam.sessionToken, { query: 'short Korean' });

    expect(sameTeamBundle.entries.map((entry) => entry.title)).toEqual(['Team MCP convention']);
    expect(otherTeamBundle.entries).toHaveLength(0);
    expect(privateBundle.entries).toHaveLength(0);
  });

  it('blocks writes to scopes outside the logged-in account context', () => {
    const cloud = host();
    const session = login(cloud, account({ userId: 'user-a', teamId: 'team-ai' }));

    expect(() =>
      cloud.putContext(session.sessionToken, {
        scopeType: 'team',
        scopeId: 'team-other',
        title: 'Wrong team write',
        body: 'This should not be accepted.',
      })
    ).toThrow(MemoryBankCloudAuthorizationError);
  });

  it('does not leak context across tenants', () => {
    const cloud = host();
    const acme = login(cloud, account({ tenantId: 'tenant-acme', orgId: 'org-a', teamId: 'team-a', projectId: 'project-a', userId: 'user-a' }));
    const globex = login(cloud, account({ tenantId: 'tenant-globex', orgId: 'org-a', teamId: 'team-a', projectId: 'project-a', userId: 'user-b' }));

    cloud.putContext(acme.sessionToken, {
      scopeType: 'company',
      title: 'Acme company rule',
      body: 'Acme context must not cross tenant boundaries.',
    });

    expect(cloud.getContextBundle(globex.sessionToken, { query: 'Acme' }).entries).toHaveLength(0);
  });

  it('records audit events for token, login, write, and bundle reads', () => {
    const cloud = host();
    const session = login(cloud);
    cloud.putContext(session.sessionToken, { scopeType: 'project', title: 'Project rule', body: 'Keep tests close to changed code.' });
    cloud.getContextBundle(session.sessionToken, { query: 'tests' });

    const actions = cloud.store.listAuditEvents('tenant-acme').map((event) => event.action);
    expect(actions).toEqual(['token.issue', 'token.login', 'context.put', 'context.bundle']);
  });
});

describe('memory-bank-cloud MCP contract wrapper', () => {
  it('hides token issuance from the default client-facing MCP tool list', () => {
    const names = listMemoryBankCloudMcpTools().map((tool) => tool.name);
    expect(names).toEqual([
      'memory_bank_cloud_login',
      'memory_bank_cloud_put_context',
      'memory_bank_cloud_get_context',
      'memory_bank_cloud_ingest_exchange',
      'memory_bank_cloud_search',
      'memory_bank_cloud_read',
      'memory_bank_cloud_put_fact',
      'memory_bank_cloud_search_facts',
    ]);
  });

  it('lists token issuance only for admin/control-plane MCP registration', () => {
    const names = listMemoryBankCloudMcpTools({ includeAdminTools: true }).map((tool) => tool.name);
    expect(names).toEqual([
      'memory_bank_cloud_issue_token',
      'memory_bank_cloud_login',
      'memory_bank_cloud_put_context',
      'memory_bank_cloud_get_context',
      'memory_bank_cloud_ingest_exchange',
      'memory_bank_cloud_search',
      'memory_bank_cloud_read',
      'memory_bank_cloud_put_fact',
      'memory_bank_cloud_search_facts',
    ]);
  });

  it('runs token/login/put/get through MCP-shaped calls', async () => {
    const cloud = host();
    const issued = JSON.parse(
      await callMemoryBankCloudMcpTool(cloud, 'memory_bank_cloud_issue_token', {
        issuer: issuerFor(account({ userId: 'user-mcp', sourceAgent: 'codex' })),
        account: account({ userId: 'user-mcp', sourceAgent: 'codex' }),
      })
    ) as { token: string };
    const session = JSON.parse(
      await callMemoryBankCloudMcpTool(cloud, 'memory_bank_cloud_login', {
        token: issued.token,
        terminalId: 'terminal-codex',
        sessionId: 'session-codex',
        sourceAgent: 'codex',
      })
    ) as { sessionToken: string };

    await callMemoryBankCloudMcpTool(cloud, 'memory_bank_cloud_put_context', {
      sessionToken: session.sessionToken,
      scopeType: 'org',
      title: 'Shared architecture context',
      body: 'Memory Bank Cloud shares organization context automatically through MCP login.',
      tags: ['mcp', 'context'],
    });

    const bundle = JSON.parse(
      await callMemoryBankCloudMcpTool(cloud, 'memory_bank_cloud_get_context', {
        sessionToken: session.sessionToken,
        query: 'organization context',
      })
    ) as { entries: Array<{ title: string; scopeType: string }> };

    expect(bundle.entries).toEqual([{ title: 'Shared architecture context', scopeType: 'org', id: expect.any(String), tenantId: 'tenant-acme', orgId: 'org-platform', teamId: 'team-ai', projectId: 'project-memory-bank', userId: 'user-mcp', sourceAgent: 'codex', body: 'Memory Bank Cloud shares organization context automatically through MCP login.', tags: ['mcp', 'context'], sensitivity: 'internal', scopeId: 'org-platform', createdAt: expect.any(String), updatedAt: expect.any(String) }]);
  });
});
