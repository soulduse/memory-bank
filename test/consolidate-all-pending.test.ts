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

    const all = getAllNewFactsSince(db, '2000-01-01T00:00:00Z');
    const scopes = all.map((f) => `${f.scope_type}:${f.scope_project ?? '-'}`).sort();
    expect(all).toHaveLength(3);
    expect(scopes).toEqual(['global:-', 'project:/projA', 'project:/projB']);
  });

  it('processes a global fact ONCE even with many projects (no 10×N reprocessing)', async () => {
    // One global fact + facts across 5 projects — the old per-project loop would
    // compare the global fact once per project (INDEPENDENT keeps it active).
    addFact(db, 'shared global decision', 'global', null);
    for (let i = 0; i < 5; i++) addFact(db, `proj ${i} decision`, 'project', `/proj${i}`);

    const result = await consolidateAllPending(db, '2000-01-01T00:00:00Z');

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

    const result = await consolidateAllPending(db, '2000-01-01T00:00:00Z');

    expect(result.haikuCalls).toBeLessThanOrEqual(10);
    expect((callHaiku as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(10);
  });

  it('returns zero work when nothing is newer than `since`', async () => {
    addFact(db, 'old fact', 'global', null);
    const future = new Date(Date.now() + 60_000).toISOString();

    const result = await consolidateAllPending(db, future);

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

    await consolidateAllPending(db, '2000-01-01T00:00:00Z');

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

    await consolidateAllPending(db, '2000-01-01T00:00:00Z');

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

  it('unparseable output counts budget AND holds the cursor for retry (not silently skipped)', async () => {
    // HIGH guard: a call returning garbage spent budget (must count) and its
    // comparison never resolved (must be retried, not advanced past).
    addFact(db, 'dup fact A', 'global', null);
    addFact(db, 'dup fact B', 'global', null);
    (callHaiku as ReturnType<typeof vi.fn>).mockResolvedValue('not json at all');
    (parseJsonResponse as ReturnType<typeof vi.fn>).mockReturnValue(null); // unparseable

    const result = await consolidateAllPending(db, '2000-01-01T00:00:00Z');

    expect(result.haikuCalls).toBe((callHaiku as ReturnType<typeof vi.fn>).mock.calls.length);
    expect(result.haikuCalls).toBeGreaterThanOrEqual(1);
    expect(result.cursor).toBe('2000-01-01T00:00:00Z'); // held → retried next run
  });

  it('back-compat consolidateFacts respects the budget even when every LLM call rejects', async () => {
    for (let i = 0; i < 100; i++) addFact(db, `bc dup ${i}`, 'project', '/bc');
    (callHaiku as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('LLM down'));

    await consolidateFacts(db, '/bc', '2000-01-01T00:00:00Z');

    // Attempts are capped at MAX_HAIKU_CALLS (10), not one per similar fact.
    expect((callHaiku as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(10);
  });

  it('does NOT advance the cursor past a fact whose comparison errored (retryable)', async () => {
    addFact(db, 'errdriver one', 'global', null);
    addFact(db, 'errdriver two', 'global', null); // similar → triggers a call

    (callHaiku as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('LLM down'));

    const run = await consolidateAllPending(db, '2000-01-01T00:00:00Z');

    // Cursor must stay at the start so the errored fact is retried next run.
    expect(run.cursor).toBe('2000-01-01T00:00:00Z');
    // The attempted (failed) call is still counted — returned budget is accurate.
    expect(run.haikuCalls).toBe((callHaiku as ReturnType<typeof vi.fn>).mock.calls.length);
    expect(run.haikuCalls).toBeGreaterThanOrEqual(1);
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

    const run1 = await consolidateAllPending(db, '2000-01-01T00:00:00Z');
    expect(run1.haikuCalls).toBeLessThanOrEqual(10);
    expect(run1.cursor > '2000-01-01T00:00:00Z').toBe(true); // advanced

    const run2 = await consolidateAllPending(db, run1.cursor);
    // run 2 starts strictly after run 1's cursor → reaches the remaining backlog
    expect(run2.processed).toBeGreaterThan(0);
    expect(run2.cursor >= run1.cursor).toBe(true);
  });
});
