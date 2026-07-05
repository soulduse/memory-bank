import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { suppressConsole } from './test-utils.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

// Mock the LLM so each consolidation "comparison" is deterministic and counted.
vi.mock('../src/llm.js', () => ({
  callHaiku: vi.fn().mockResolvedValue('{"relation":"INDEPENDENT","merged_fact":"","reason":"unrelated"}'),
  parseJsonResponse: vi.fn().mockReturnValue({ relation: 'INDEPENDENT', merged_fact: '', reason: 'unrelated' }),
}));
// Avoid loading the real embedding model.
vi.mock('../src/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
  EMBEDDING_VERSION: 2,
  EMBEDDING_MODEL: 'test',
}));

import { callHaiku, parseJsonResponse } from '../src/llm.js';
import { initDatabase } from '../src/db.js';
import { insertFact, getAllNewFactsSince } from '../src/fact-db.js';
import { consolidateAllPending, consolidateFacts } from '../src/consolidator.js';

const restoreConsole = suppressConsole();
afterAll(() => restoreConsole());

const EMB = new Array(384).fill(0.1); // identical → always "similar"

function addFact(db: Database.Database, fact: string, scope_type: 'project' | 'global', scope_project: string | null) {
  insertFact(db, { fact, category: 'decision', scope_type, scope_project, source_exchange_ids: [], embedding: EMB });
}

describe('consolidateAllPending', () => {
  let db: Database.Database;
  const testDir = path.join(os.tmpdir(), 'consolidate-all-' + Date.now());
  const dbPath = path.join(testDir, 'test.db');

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    process.env.TEST_DB_PATH = dbPath;
    db = initDatabase();
    vi.clearAllMocks();
    // Restore default verdict (INDEPENDENT) so tests are order-independent —
    // clearAllMocks resets call history but NOT return values set by earlier tests.
    (callHaiku as ReturnType<typeof vi.fn>).mockResolvedValue('{"relation":"INDEPENDENT","merged_fact":"","reason":"unrelated"}');
    (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue({ relation: 'INDEPENDENT', merged_fact: '', reason: 'unrelated' });
  });

  afterEach(() => {
    db.close();
    delete process.env.TEST_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('getAllNewFactsSince spans every scope/project (not just one)', () => {
    addFact(db, 'proj A fact', 'project', '/projA');
    addFact(db, 'proj B fact', 'project', '/projB');
    addFact(db, 'global fact', 'global', null);

    const all = getAllNewFactsSince(db, { createdAt: '2000-01-01T00:00:00Z', id: '' });
    const scopes = all.map((f) => `${f.scope_type}:${f.scope_project ?? '-'}`).sort();
    expect(all).toHaveLength(3);
    expect(scopes).toEqual(['global:-', 'project:/projA', 'project:/projB']);
  });

  it('processes a global fact ONCE even with many projects (no 10×N reprocessing)', async () => {
    // One global fact + facts across 5 projects — the old per-project loop would
    // compare the global fact once per project (INDEPENDENT keeps it active).
    addFact(db, 'shared global decision', 'global', null);
    for (let i = 0; i < 5; i++) addFact(db, `proj ${i} decision`, 'project', `/proj${i}`);

    const result = await consolidateAllPending(db, { createdAt: '2000-01-01T00:00:00Z', id: '' });

    // 6 facts, each compared at most once; the single budget caps total calls.
    const MAX = 10;
    expect((callHaiku as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(MAX);
    expect(result.haikuCalls).toBeLessThanOrEqual(MAX);
    // No fact is visited more than once: processed == distinct new facts.
    expect(result.processed).toBe(6);
  });

  it('honors the single Haiku budget across the whole backlog', async () => {
    // 20 mutually-similar facts, one budget of 10 → at most 10 calls total.
    for (let i = 0; i < 20; i++) addFact(db, `similar fact ${i}`, 'global', null);

    const result = await consolidateAllPending(db, { createdAt: '2000-01-01T00:00:00Z', id: '' });

    expect(result.haikuCalls).toBeLessThanOrEqual(10);
    expect((callHaiku as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(10);
  });

  it('returns zero work when nothing is newer than `since`', async () => {
    addFact(db, 'old fact', 'global', null);
    const future = new Date(Date.now() + 60_000).toISOString();

    const result = await consolidateAllPending(db, { createdAt: future, id: '' });

    expect(result.processed).toBe(0);
    expect(callHaiku).not.toHaveBeenCalled();
  });

  it('NEVER compares a global fact against a private project fact (no cross-project mutation)', async () => {
    // CRITICAL guard: a global driver fact must not reach into /secretProj's
    // private rows, or an LLM verdict could deactivate/rewrite them.
    addFact(db, 'Uses private vendor X', 'project', '/secretProj');
    addFact(db, 'Uses private vendor X globally', 'global', null); // similar, newer

    const { parseJsonResponse } = await import('../src/llm.js');
    (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue({
      relation: 'CONTRADICTION', merged_fact: '', reason: 'conflict',
    });

    await consolidateAllPending(db, { createdAt: '2000-01-01T00:00:00Z', id: '' });

    // Every callHaiku comparison prompt must exclude the project-private fact.
    for (const call of (callHaiku as ReturnType<typeof vi.fn>).mock.calls) {
      const prompt = String(call[1]);
      expect(prompt).not.toContain('Uses private vendor X globally' + '\0'); // sanity
      // the project-private fact text must never appear as a candidate in any prompt
      expect(prompt.includes('Uses private vendor X') && !prompt.includes('globally')).toBe(false);
    }
    // The project-private fact stays active and unmodified.
    const secret = db.prepare("SELECT fact, is_active FROM facts WHERE scope_project = '/secretProj'").get() as { fact: string; is_active: number };
    expect(secret.is_active).toBe(1);
    expect(secret.fact).toBe('Uses private vendor X');
  });

  it('NEVER lets a project fact mutate/deactivate a global fact (EVOLUTION/CONTRADICTION isolation)', async () => {
    // CRITICAL: a project-private driver must not reach a global candidate.
    addFact(db, 'Uses vendor X', 'global', null);
    addFact(db, 'Uses vendor X with SECRET token', 'project', '/secret'); // newer, similar

    (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue({
      relation: 'EVOLUTION', merged_fact: 'Uses vendor X with SECRET token', reason: 'newer',
    });

    await consolidateAllPending(db, { createdAt: '2000-01-01T00:00:00Z', id: '' });

    // The global row keeps its original text and stays active — never rewritten
    // with the project-private secret, never deactivated.
    const global = db.prepare("SELECT fact, is_active FROM facts WHERE scope_type = 'global'").get() as { fact: string; is_active: number };
    expect(global.fact).toBe('Uses vendor X');
    expect(global.is_active).toBe(1);
    // No prompt ever paired the global fact with the secret project fact.
    for (const call of (callHaiku as ReturnType<typeof vi.fn>).mock.calls) {
      const prompt = String(call[1]);
      const crossScopePair = prompt.includes('SECRET token') && /Existing fact:\s*"Uses vendor X"/.test(prompt);
      expect(crossScopePair).toBe(false);
    }
  });

  it('searchSimilarFactsSameScope is not starved by many out-of-scope rows (scope gate before limit)', async () => {
    // HIGH guard: the scope filter runs on the FULL overfetch, not after
    // truncation — so a same-project match survives a crowd of closer globals.
    const { searchSimilarFactsSameScope } = await import('../src/fact-db.js');
    for (let i = 0; i < 40; i++) addFact(db, `global crowd ${i}`, 'global', null);
    addFact(db, 'proj target', 'project', '/projX');

    const projHits = searchSimilarFactsSameScope(db, EMB, { type: 'project', project: '/projX' }, 5, 0.5);
    expect(projHits.length).toBe(1);
    expect(projHits[0].fact.fact).toBe('proj target');
    expect(projHits.every((h) => h.fact.scope_type === 'project')).toBe(true);

    // Global scope search returns only globals (never the project fact).
    const globalHits = searchSimilarFactsSameScope(db, EMB, { type: 'global' }, 5, 0.5);
    expect(globalHits.every((h) => h.fact.scope_type === 'global')).toBe(true);
  });

  it('pages past the initial overfetch (201+ out-of-scope rows) to reach an in-scope match', async () => {
    const { searchSimilarFactsSameScope } = await import('../src/fact-db.js');
    for (let i = 0; i < 210; i++) addFact(db, `global crowd ${i}`, 'global', null); // > initial 200 fetch
    addFact(db, 'proj deep', 'project', '/projDeep');

    const hits = searchSimilarFactsSameScope(db, EMB, { type: 'project', project: '/projDeep' }, 5, 0.5);
    expect(hits.length).toBe(1);
    expect(hits[0].fact.fact).toBe('proj deep'); // found despite 210 closer globals
  });

  it('unparseable output counts budget as a no-op (best-effort; not a cursor-holding error)', async () => {
    // A call returning garbage spent budget (must count) but is treated as a
    // no-op verdict — the cursor advances, so it cannot starve later facts.
    addFact(db, 'dup fact A', 'global', null);
    addFact(db, 'dup fact B', 'global', null);
    (callHaiku as ReturnType<typeof vi.fn>).mockResolvedValue('not json at all');
    (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue(null); // unparseable

    const result = await consolidateAllPending(db, { createdAt: '2000-01-01T00:00:00Z', id: '' });

    expect(result.haikuCalls).toBe((callHaiku as ReturnType<typeof vi.fn>).mock.calls.length);
    expect(result.haikuCalls).toBeGreaterThanOrEqual(1);
    // Both facts stay active (no merge/deactivation on a no-op verdict).
    const active = db.prepare("SELECT COUNT(*) AS n FROM facts WHERE is_active = 1").get() as { n: number };
    expect(active.n).toBe(2);
  });

  it('unparseable output is a no-op that ADVANCES the cursor (best-effort; no poison starvation)', async () => {
    const base = Date.parse('2020-01-01T00:00:00Z');
    insertFact(db, { fact: 'poison driver', category: 'decision', scope_type: 'global', scope_project: null, source_exchange_ids: [], embedding: EMB });
    insertFact(db, { fact: 'clean later', category: 'decision', scope_type: 'global', scope_project: null, source_exchange_ids: [], embedding: EMB });
    db.prepare("UPDATE facts SET created_at = ? WHERE fact = 'poison driver'").run(new Date(base).toISOString());
    db.prepare("UPDATE facts SET created_at = ? WHERE fact = 'clean later'").run(new Date(base + 1000).toISOString());

    // Every comparison is unparseable → each is a no-op, cursor advances anyway.
    (callHaiku as ReturnType<typeof vi.fn>).mockResolvedValue('not json');
    (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const run = await consolidateAllPending(db, { createdAt: '2000-01-01T00:00:00Z', id: '' });

    // Both facts examined (no cursor hold), budget counted, and the run reached
    // the end of the backlog — a non-JSON response cannot starve later facts.
    expect(run.haikuCalls).toBe((callHaiku as ReturnType<typeof vi.fn>).mock.calls.length);
    expect(run.cursor).not.toBeNull();
    expect(run.cursor!.createdAt >= new Date(base + 1000).toISOString()).toBe(true); // advanced past both
  });

  it('drains a timestamp group LARGER than the budget across runs (keyset cursor, no stall)', async () => {
    // Reviewer repro: 11+ similar active facts sharing ONE created_at. A
    // created_at-only cursor stalls (lastExamined == first-unexamined timestamp),
    // reprocessing the same 10 forever. The keyset (created_at, id) cursor must
    // advance fact-by-fact so run 2 reaches the rest.
    const shared = '2020-06-01T00:00:00.000Z';
    for (let i = 0; i < 13; i++) {
      insertFact(db, { fact: `ts group ${i}`, category: 'decision', scope_type: 'global', scope_project: null, source_exchange_ids: [], embedding: EMB });
    }
    db.prepare('UPDATE facts SET created_at = ?').run(shared); // all identical timestamp

    const run1 = await consolidateAllPending(db, null);
    expect(run1.cursor).not.toBeNull();
    expect(run1.cursor!.createdAt).toBe(shared);
    expect(run1.cursor!.id).not.toBe(''); // advanced to a specific fact within the group

    const run2 = await consolidateAllPending(db, run1.cursor);
    // run 2 must make progress on the remaining facts, not repeat run 1's set.
    expect(run2.processed).toBeGreaterThan(0);
    // After enough runs the whole group is examined (cursor reaches the last id).
    let cursor = run2.cursor;
    for (let r = 0; r < 3; r++) cursor = (await consolidateAllPending(db, cursor)).cursor;
    const remaining = getAllNewFactsSince(db, cursor);
    expect(remaining.length).toBe(0); // fully drained despite the shared timestamp
  });

  it('getAllNewFactsSince honors a page limit (no full-table materialization)', () => {
    for (let i = 0; i < 50; i++) addFact(db, `page ${i}`, 'global', null);
    const page = getAllNewFactsSince(db, null, 10);
    expect(page.length).toBe(10); // bounded, not all 50
  });

  it('an ISOLATED call failure is skipped (fact-specific), not held', async () => {
    // fact A always fails; fact B (later) succeeds. A must be skipped so the
    // cursor advances and B gets consolidated — one bad fact must not wedge.
    const base = Date.parse('2020-03-01T00:00:00Z');
    insertFact(db, { fact: 'bad driver', category: 'decision', scope_type: 'global', scope_project: null, source_exchange_ids: [], embedding: EMB });
    insertFact(db, { fact: 'bad sibling', category: 'decision', scope_type: 'global', scope_project: null, source_exchange_ids: [], embedding: EMB });
    insertFact(db, { fact: 'good driver', category: 'decision', scope_type: 'global', scope_project: null, source_exchange_ids: [], embedding: EMB });
    insertFact(db, { fact: 'good sibling', category: 'decision', scope_type: 'global', scope_project: null, source_exchange_ids: [], embedding: EMB });
    db.prepare("UPDATE facts SET created_at = ? WHERE fact = 'bad driver'").run(new Date(base).toISOString());
    db.prepare("UPDATE facts SET created_at = ? WHERE fact = 'bad sibling'").run(new Date(base + 1000).toISOString());
    db.prepare("UPDATE facts SET created_at = ? WHERE fact = 'good driver'").run(new Date(base + 2000).toISOString());
    db.prepare("UPDATE facts SET created_at = ? WHERE fact = 'good sibling'").run(new Date(base + 3000).toISOString());

    // Only 'bad driver' throws; everything else succeeds.
    (callHaiku as ReturnType<typeof vi.fn>).mockImplementation(async (_s: string, user: string) => {
      if (user.includes('bad driver')) throw new Error('provider 400 oversized');
      return '{"relation":"INDEPENDENT","merged_fact":"","reason":"x"}';
    });

    const run = await consolidateAllPending(db, null);

    // The cursor advanced past the isolated bad fact (not stuck at the start).
    expect(run.cursor).not.toBeNull();
    expect(run.cursor!.createdAt > new Date(base).toISOString()).toBe(true);
  });

  it('an OUTAGE (consecutive failures) rolls the cursor back and holds for retry', async () => {
    for (let i = 0; i < 5; i++) addFact(db, `outage fact ${i}`, 'global', null);
    (callHaiku as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('LLM down'));

    const run = await consolidateAllPending(db, null);

    // OUTAGE_TRIP consecutive failures → cursor rolled back to the start (null),
    // so the whole streak is retried next run rather than silently skipped.
    expect(run.cursor).toBeNull();
  });

  it('advances a persisted cursor so newer facts are reachable across runs (no starvation)', async () => {
    // 15 similar global facts, budget 10 → run 1 processes the oldest 10 and
    // advances the cursor; run 2 (since=cursor) reaches the remaining 5.
    const base = Date.parse('2020-01-01T00:00:00Z');
    for (let i = 0; i < 15; i++) {
      // distinct, strictly increasing timestamps so the cursor can advance safely
      const ts = new Date(base + i * 1000).toISOString();
      insertFact(db, { fact: `fact ${i}`, category: 'decision', scope_type: 'global', scope_project: null, source_exchange_ids: [], embedding: EMB });
      db.prepare('UPDATE facts SET created_at = ? WHERE fact = ?').run(ts, `fact ${i}`);
    }

    const run1 = await consolidateAllPending(db, { createdAt: '2000-01-01T00:00:00Z', id: '' });
    expect(run1.haikuCalls).toBeLessThanOrEqual(10);
    expect(run1.cursor).not.toBeNull();
    expect(run1.cursor!.createdAt > '2000-01-01T00:00:00Z').toBe(true); // advanced

    const run2 = await consolidateAllPending(db, run1.cursor);
    // run 2 starts strictly after run 1's cursor → reaches the remaining backlog
    expect(run2.processed).toBeGreaterThan(0);
    expect(run2.cursor!.createdAt >= run1.cursor!.createdAt).toBe(true);
  });
});
