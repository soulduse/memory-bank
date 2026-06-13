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

  it('does not duplicate rows when a write succeeds but ack fails, then retries (crash-window idempotency)', async () => {
    const cloud = new AsyncMemoryBankCloudHost({ store: new InMemoryMemoryBankCloudStore(), now: () => new Date('2026-05-10T00:00:00.000Z'), tokenFactory: () => 'idem-token' });
    const ctx = account();
    const issued = await cloud.issueLoginToken({ issuer: issuerFor(ctx), account: ctx });
    const session = await cloud.loginWithToken(issued.token);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bank-cloud-spool-idem-'));
    const spool = new MemoryBankCloudSpool(dir);
    spool.enqueue('context', { scopeType: 'team', title: 'Idem context', body: 'Written once even across retries.' });

    // Simulate process death after the remote write but before ack: first ack throws.
    const originalAck = spool.ack.bind(spool);
    let throwOnce = true;
    (spool as unknown as { ack: (id: string) => void }).ack = (id: string) => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error('simulated ack failure');
      }
      return originalAck(id);
    };

    const first = await syncMemoryBankCloudSpoolAsync(cloud, session.sessionToken, spool);
    expect(first.processed).toBe(0);
    expect(first.failed).toHaveLength(1); // write happened, ack failed → event still pending
    const second = await syncMemoryBankCloudSpoolAsync(cloud, session.sessionToken, spool);
    expect(second.processed).toBe(1);

    // Despite two writes, the stable event-id keyed row means exactly one entry exists.
    const bundle = await cloud.getContextBundle(session.sessionToken, { query: 'Written once' });
    expect(bundle.entries).toHaveLength(1);
  });

  it('skips malformed spool lines instead of throwing (one torn line cannot strand the queue)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bank-cloud-spool-torn-'));
    const file = path.join(dir, 'memory-bank-cloud-spool.jsonl');
    const valid1 = JSON.stringify({ id: 'evt-1', kind: 'context', createdAt: '2026-05-10T00:00:00.000Z', payload: { scopeType: 'team', title: 'A', body: 'a' } });
    const valid2 = JSON.stringify({ id: 'evt-2', kind: 'fact', createdAt: '2026-05-10T00:00:00.000Z', payload: { scopeType: 'team', category: 'knowledge', fact: 'b' } });
    fs.writeFileSync(file, `${valid1}\n{bad json\n${valid2}\n`, 'utf8');

    const spool = new MemoryBankCloudSpool(dir);
    const pending = spool.listPending();
    expect(pending.map((e) => e.id)).toEqual(['evt-1', 'evt-2']);
  });
});
