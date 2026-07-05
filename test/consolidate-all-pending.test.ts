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

import { callHaiku } from '../src/llm.js';
import { initDatabase } from '../src/db.js';
import { insertFact, getAllNewFactsSince } from '../src/fact-db.js';
import { consolidateAllPending } from '../src/consolidator.js';

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
});
