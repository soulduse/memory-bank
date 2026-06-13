import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { AsyncMemoryBankCloudHost, InMemoryMemoryBankCloudStore, MemoryBankCloudHost, type CloudAccountContext, type CloudTokenIssuerContext } from '../src/memory-bank-cloud.js';
import { MemoryBankCloudSpool } from '../src/memory-bank-cloud-spool.js';
import { syncMemoryBankCloudSpool, syncMemoryBankCloudSpoolAsync } from '../src/memory-bank-cloud-sync.js';
import { getMemoryBankCloudContextResource } from '../src/memory-bank-cloud-resource.js';

function account(): CloudAccountContext {
  return { tenantId: 'tenant-acme', orgId: 'org-platform', teamId: 'team-ai', projectId: 'project-memory-bank', userId: 'user-a', sourceAgent: 'codex' };
}
function issuerFor(ctx: CloudAccountContext): CloudTokenIssuerContext {
  return { tenantId: ctx.tenantId, userId: 'issuer', scopeType: 'company', scopeId: ctx.tenantId, role: 'admin' };
}

describe('memory-bank-cloud sync, spool, and context resource', () => {
  it('syncs queued context/exchange/fact events once and exposes automatic context as MCP resource text', () => {
    const cloud = new MemoryBankCloudHost({ store: new InMemoryMemoryBankCloudStore(), now: () => new Date('2026-05-10T00:00:00.000Z'), tokenFactory: () => 'sync-token' });
    const ctx = account();
    const issued = cloud.issueLoginToken({ issuer: issuerFor(ctx), account: ctx });
    const session = cloud.loginWithToken(issued.token);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bank-cloud-spool-'));
    const spool = new MemoryBankCloudSpool(dir);

    spool.enqueue('context', { scopeType: 'team', title: 'Team context', body: 'Queued team context is shared.' });
    spool.enqueue('exchange', { scopeType: 'team', title: 'Queued exchange', content: 'Queued exchange is searchable after sync.' });
    spool.enqueue('fact', { scopeType: 'team', category: 'knowledge', fact: 'Queued facts sync into cloud memory-bank.' });

    expect(syncMemoryBankCloudSpool(cloud, session.sessionToken, spool)).toEqual({ processed: 3, failed: [] });
    expect(syncMemoryBankCloudSpool(cloud, session.sessionToken, spool)).toEqual({ processed: 0, failed: [] });
    expect(cloud.searchExchanges(session.sessionToken, { query: 'searchable after sync' })).toHaveLength(1);
    expect(cloud.searchFacts(session.sessionToken, { query: 'cloud memory-bank' })).toHaveLength(1);
    const resource = getMemoryBankCloudContextResource(cloud, session.sessionToken, { query: 'Queued team context' });
    expect(resource.uri).toBe('memory-bank-cloud://context/current');
    expect(JSON.parse(resource.text).entries[0].title).toBe('Team context');
  });

  it('async sync flushes queued events once and is idempotent on retry (remote-host path)', async () => {
    const cloud = new AsyncMemoryBankCloudHost({ store: new InMemoryMemoryBankCloudStore(), now: () => new Date('2026-05-10T00:00:00.000Z'), tokenFactory: () => 'async-sync-token' });
    const ctx = account();
    const issued = await cloud.issueLoginToken({ issuer: issuerFor(ctx), account: ctx });
    const session = await cloud.loginWithToken(issued.token);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bank-cloud-spool-async-'));
    const spool = new MemoryBankCloudSpool(dir);

    spool.enqueue('context', { scopeType: 'team', title: 'Async team context', body: 'Queued via async sync.' });
    spool.enqueue('exchange', { scopeType: 'team', title: 'Async exchange', content: 'Async exchange becomes searchable.' });
    spool.enqueue('fact', { scopeType: 'team', category: 'knowledge', fact: 'Async facts sync into cloud.' });

    expect(await syncMemoryBankCloudSpoolAsync(cloud, session.sessionToken, spool)).toEqual({ processed: 3, failed: [] });
    // Idempotent: acked events are not reprocessed → no duplicate rows.
    expect(await syncMemoryBankCloudSpoolAsync(cloud, session.sessionToken, spool)).toEqual({ processed: 0, failed: [] });
    expect(await cloud.searchExchanges(session.sessionToken, { query: 'becomes searchable' })).toHaveLength(1);
  });
});
