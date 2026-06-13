import { describe, it, expect } from 'vitest';
import {
  MemoryBankCloudHost,
  MemoryBankCloudAuthorizationError,
  hashToken,
  type CloudAccountContext,
  type CloudTokenIssuerContext,
} from '../src/memory-bank-cloud.js';

function account(over: Partial<CloudAccountContext> = {}): CloudAccountContext {
  return {
    tenantId: 'tenantA',
    orgId: 'orgA',
    teamId: 'teamA',
    projectId: 'projA',
    userId: 'userA',
    sourceAgent: 'claude-code',
    ...over,
  };
}

const companyIssuer = (acc: CloudAccountContext): CloudTokenIssuerContext => ({
  tenantId: acc.tenantId,
  userId: acc.userId,
  scopeType: 'company',
  scopeId: acc.tenantId,
  role: 'owner',
});

const teamIssuer = (acc: CloudAccountContext): CloudTokenIssuerContext => ({
  tenantId: acc.tenantId,
  userId: acc.userId,
  scopeType: 'team',
  scopeId: acc.teamId,
  role: 'admin',
});

const projectIssuer = (acc: CloudAccountContext): CloudTokenIssuerContext => ({
  tenantId: acc.tenantId,
  userId: acc.userId,
  scopeType: 'project',
  scopeId: acc.projectId,
  role: 'admin',
});

function loginWith(host: MemoryBankCloudHost, issuer: CloudTokenIssuerContext, acc: CloudAccountContext) {
  const issued = host.issueLoginToken({ issuer, account: acc });
  return { issued, session: host.loginWithToken(issued.token) };
}

describe('memory-bank-cloud issuer-boundary domain invariants', () => {
  it('rejects cross-tenant token issuance', () => {
    const host = new MemoryBankCloudHost();
    const acc = account();
    const foreignIssuer: CloudTokenIssuerContext = { ...companyIssuer(acc), tenantId: 'tenantB', scopeId: 'tenantB' };
    expect(() => host.issueLoginToken({ issuer: foreignIssuer, account: acc })).toThrow(MemoryBankCloudAuthorizationError);
  });

  it('rejects a project issuer that tries to grant org-scope membership (issuer boundary)', () => {
    const host = new MemoryBankCloudHost();
    const acc = account();
    expect(() =>
      host.issueLoginToken({
        issuer: projectIssuer(acc),
        account: acc,
        memberships: [{ tenantId: acc.tenantId, userId: acc.userId, scopeType: 'org', scopeId: acc.orgId, role: 'member' }],
      })
    ).toThrow(MemoryBankCloudAuthorizationError);
  });

  it('persists only the token hash, never the raw token', () => {
    const host = new MemoryBankCloudHost();
    const acc = account();
    const issued = host.issueLoginToken({ issuer: companyIssuer(acc), account: acc });
    // The sync InMemory store returns synchronously; narrow the union return type.
    const byRaw = host.store.findTokenByHash(issued.token) as { tokenHash: string } | null;
    const byHash = host.store.findTokenByHash(hashToken(issued.token)) as { tokenHash: string } | null;
    // raw token must not resolve; its hash must.
    expect(byRaw).toBeNull();
    expect(byHash).not.toBeNull();
    expect(byHash!.tokenHash).toBe(hashToken(issued.token));
    expect(byHash!.tokenHash).not.toBe(issued.token);
  });

  it('clips a team-issued token so it cannot read org/company context written by a broader token', () => {
    const host = new MemoryBankCloudHost();
    const acc = account();

    // Company-issued session writes an org-scoped entry.
    const company = loginWith(host, companyIssuer(acc), acc);
    host.putContext(company.session.sessionToken, { scopeType: 'org', title: 'org secret', body: 'org-only context' });

    // Team-issued session for the same user must not see org scope.
    const team = loginWith(host, teamIssuer(acc), acc);
    const visible = host.getContextBundle(team.session.sessionToken).visibleScopes.map((s) => s.scopeType);
    expect(visible).not.toContain('org');
    expect(visible).not.toContain('company');
    expect(visible).toEqual(expect.arrayContaining(['team', 'project', 'personal']));

    const bundle = host.getContextBundle(team.session.sessionToken, { query: 'org secret' });
    expect(bundle.entries.find((e) => e.scopeType === 'org')).toBeUndefined();
  });

  it('blocks a team-issued token from writing org scope', () => {
    const host = new MemoryBankCloudHost();
    const acc = account();
    const team = loginWith(host, teamIssuer(acc), acc);
    expect(() =>
      host.putContext(team.session.sessionToken, { scopeType: 'org', title: 'x', body: 'y' })
    ).toThrow(MemoryBankCloudAuthorizationError);
  });

  it('isolates personal context to the owning user', () => {
    const host = new MemoryBankCloudHost();
    const accA = account({ userId: 'userA' });
    const accB = account({ userId: 'userB' });

    const a = loginWith(host, companyIssuer(accA), accA);
    host.putContext(a.session.sessionToken, { scopeType: 'personal', title: 'mine', body: 'userA private' });

    const b = loginWith(host, companyIssuer(accB), accB);
    const bundle = host.getContextBundle(b.session.sessionToken);
    expect(bundle.entries.find((e) => e.body.includes('userA private'))).toBeUndefined();
  });

  it('returns zero cross-tenant rows (tenant isolation)', () => {
    const host = new MemoryBankCloudHost();
    const accA = account({ tenantId: 'tenantA' });
    const accB = account({ tenantId: 'tenantB' });

    const a = loginWith(host, companyIssuer(accA), accA);
    host.ingestExchange(a.session.sessionToken, { scopeType: 'company', title: 'A doc', content: 'tenantA exchange body' });

    const b = loginWith(host, companyIssuer(accB), accB);
    const results = host.searchExchanges(b.session.sessionToken, { query: 'tenantA exchange body' });
    expect(results).toHaveLength(0);
  });

  it('clips team-issued search so org-scoped facts do not leak', () => {
    const host = new MemoryBankCloudHost();
    const acc = account();

    const company = loginWith(host, companyIssuer(acc), acc);
    host.putFact(company.session.sessionToken, { scopeType: 'org', category: 'decision', fact: 'org-level decision XYZ' });

    const team = loginWith(host, teamIssuer(acc), acc);
    const results = host.searchFacts(team.session.sessionToken, { query: 'org-level decision XYZ' });
    expect(results).toHaveLength(0);
  });
});
