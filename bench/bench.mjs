#!/usr/bin/env node
// Per-experiment benchmark for the autoresearch loop.
//
// Metrics (against the fixed bench DB — production DB is never touched):
//   recall@10 — self-retrieval: for each query built from an exchange's own
//               user_message snippet, is that exchange in the top-10 (mode both)?
//   p50_ms    — median searchConversations() latency over the query set
//   idx_db_kb — DB bytes after indexing the test fixtures into a fresh temp DB
//               via parseConversationFile + insertExchange (deterministic fake
//               embeddings — storage shape only, no model dependency)
//
// Composite (baseline = 100, higher is better):
//   score = 50*(recall/recall0) + 30*(p50_0/p50) + 20*(size0/size)
//
// Usage: node bench/bench.mjs [--baseline]   (--baseline rewrites baseline.json)

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { performance } from 'perf_hooks';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const BENCH_DIR = path.join(REPO, '.autoresearch');
const BENCH_DB = path.join(BENCH_DIR, 'bench-db.sqlite');
const QUERIES_PATH = path.join(BENCH_DIR, 'queries.json');
const BASELINE_PATH = path.join(BENCH_DIR, 'baseline.json');
const N_QUERIES = 100;

if (!fs.existsSync(BENCH_DB)) { console.error('bench DB missing — run bench/setup-bench-db.mjs'); process.exit(2); }

// ---- Part 1: search latency + recall on the bench DB ----
process.env.MEMORY_BANK_DB_PATH = BENCH_DB;
const { searchConversations } = await import(path.join(REPO, 'dist/search.js'));

const queries = JSON.parse(fs.readFileSync(QUERIES_PATH, 'utf-8')).slice(0, N_QUERIES);

// Warmup (model load, sqlite page cache)
for (const w of queries.slice(0, 3)) await searchConversations(w.query, { limit: 10, mode: 'both' });

// Two passes; per-query latency = min across passes (removes one-off system
// hiccups — we are measuring code speed, not machine weather). Recall from pass 1.
const lats = [];
let hits = 0;
for (const { id, pfx, query } of queries) {
  const t0 = performance.now();
  const res = await searchConversations(query, { limit: 10, mode: 'both' });
  lats.push(performance.now() - t0);
  // Content-level hit: same exchange OR any result sharing the source's 80-char
  // prefix (duplicate template rows make exact-id matching ill-posed).
  if (res.some((r) => r.exchange.id === id || (pfx && r.exchange.userMessage.startsWith(pfx)))) hits++;
}
for (let i = 0; i < queries.length; i++) {
  const t0 = performance.now();
  await searchConversations(queries[i].query, { limit: 10, mode: 'both' });
  lats[i] = Math.min(lats[i], performance.now() - t0);
}
lats.sort((a, b) => a - b);
const p50 = lats[Math.floor(lats.length / 2)];
const p95 = lats[Math.floor(lats.length * 0.95)];
const recall = hits / queries.length;

// ---- Part 2: storage shape — index fixtures into a fresh temp DB ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-bench-'));
const tmpDb = path.join(tmp, 'db.sqlite');
process.env.MEMORY_BANK_DB_PATH = tmpDb;
const { initDatabase, insertExchange } = await import(path.join(REPO, 'dist/db.js'));
const { parseConversationFile } = await import(path.join(REPO, 'dist/parser.js'));

// Deterministic pseudo-embedding (mulberry32) — storage size only, not semantics.
function fakeEmbedding(seed) {
  let a = seed >>> 0;
  const v = new Array(384);
  for (let i = 0; i < 384; i++) {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    v[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) - 0.5;
  }
  return v;
}

const db2 = initDatabase();
const fixtures = fs.readdirSync(path.join(REPO, 'test/fixtures')).filter((f) => f.endsWith('.jsonl'));
let seed = 42;
for (const f of fixtures) {
  const { exchanges } = await parseConversationFile(path.join(REPO, 'test/fixtures', f));
  for (const ex of exchanges) insertExchange(db2, ex, fakeEmbedding(seed++));
}
db2.pragma('wal_checkpoint(TRUNCATE)');
db2.close();
const sizeKb = Math.round(fs.statSync(tmpDb).size / 1024);
fs.rmSync(tmp, { recursive: true, force: true });

// ---- Score ----
const cur = { recall, p50: +p50.toFixed(2), p95: +p95.toFixed(2), idx_db_kb: sizeKb };
let base;
if (process.argv.includes('--baseline') || !fs.existsSync(BASELINE_PATH)) {
  base = cur;
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(base, null, 1));
}
base = base || JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));

const score = 50 * (cur.recall / base.recall) + 30 * (base.p50 / cur.p50) + 20 * (base.idx_db_kb / cur.idx_db_kb);

console.log(`recall@10: ${cur.recall.toFixed(3)}`);
console.log(`p50_ms: ${cur.p50}`);
console.log(`p95_ms: ${cur.p95}`);
console.log(`idx_db_kb: ${cur.idx_db_kb}`);
console.log(`bench_score: ${score.toFixed(2)}`);
