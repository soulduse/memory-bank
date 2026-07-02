#!/usr/bin/env node

/**
 * Resumable re-embedding worker (detached background job).
 *
 * Upgrades stored vectors to the current embedding model (EMBEDDING_VERSION):
 *   1. facts:     rows with embedding_version != current → re-embed `fact`
 *                 (facts.embedding + vec_facts), set version.
 *   2. facts KR:  rows with fact_kr but no vec_facts_kr row → embed fact_kr.
 *   3. exchanges: rows with embedding_version != current → re-embed
 *                 (exchanges.embedding + vec_exchanges), newest first.
 *
 * Idempotent and resumable — progress is tracked by embedding_version /
 * vector-row existence, so it can be killed and relaunched at any time.
 * A pid lockfile prevents concurrent runs. Progress goes to reembed.log.
 *
 * Usage: node scripts/reembed-worker.js [--facts-only] [--max-exchanges N]
 */

import fs from 'node:fs';
import path from 'node:path';
import { initDatabase, getVecDtype, embeddingToVecBlob, vecParamSql } from '../dist/db.js';
import { generateEmbedding, generateExchangeEmbedding, initEmbeddings, EMBEDDING_VERSION, EMBEDDING_MODEL } from '../dist/embeddings.js';
import { getIndexDir } from '../dist/paths.js';

const FACTS_ONLY = process.argv.includes('--facts-only');
const maxExArg = process.argv.indexOf('--max-exchanges');
const MAX_EXCHANGES = maxExArg > -1 ? parseInt(process.argv[maxExArg + 1], 10) : Infinity;
const BATCH = 200;

const LOCK = path.join(getIndexDir(), 'reembed.lock');
const MIGRATE_LOCK = path.join(getIndexDir(), 'migrate-vec-int8.lock');

/** int8 migration mutual exclusion — checked at start AND before every batch
 * (the migration only checks our lock once at ITS start, so we must yield if
 * it began after us; TOCTOU is closed from this side by the per-batch check +
 * dtype-in-transaction serialization above). */
function migrationActive() {
  try {
    const pid = parseInt(fs.readFileSync(MIGRATE_LOCK, 'utf-8'), 10);
    if (!Number.isFinite(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}
const LOG = path.join(getIndexDir(), 'reembed.log');

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  try { fs.appendFileSync(LOG, msg + '\n'); } catch { /* best-effort */ }
  console.log(msg);
}

function acquireLock() {
  // Atomic exclusive create ('wx') — a read-then-write check is racy when two
  // SessionStart hooks spawn workers simultaneously.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      try {
        const pid = parseInt(fs.readFileSync(LOCK, 'utf8'), 10);
        if (pid && !Number.isNaN(pid)) {
          try { process.kill(pid, 0); return false; } // alive → don't run
          catch { /* stale lock */ }
        }
        fs.unlinkSync(LOCK); // stale — remove and retry the exclusive create
      } catch {
        return false;
      }
    }
  }
  return false;
}

function releaseLock() {
  try {
    if (parseInt(fs.readFileSync(LOCK, 'utf8'), 10) === process.pid) fs.unlinkSync(LOCK);
  } catch { /* ignore */ }
}

async function reembedFacts(db) {
  const pending = db.prepare(
    'SELECT id, fact, fact_kr FROM facts WHERE is_active = 1 AND embedding_version != ?'
  ).all(EMBEDDING_VERSION);
  if (pending.length) log(`facts: ${pending.length} rows to re-embed`);

  let done = 0;
  for (const row of pending) {
    const emb = await generateEmbedding(row.fact);
    const buf = Buffer.from(new Float32Array(emb).buffer);
    // KR vector must be rebuilt together with the EN vector — a model change
    // invalidates both, and vec_facts_kr rows are not version-tracked.
    const krEmb = row.fact_kr ? await generateEmbedding(row.fact_kr) : null;
    const krBuf = krEmb ? Buffer.from(new Float32Array(krEmb).buffer) : null;
    const tx = db.transaction(() => {
      db.prepare('UPDATE facts SET embedding = ?, embedding_version = ? WHERE id = ?')
        .run(buf, EMBEDDING_VERSION, row.id);
      db.prepare('DELETE FROM vec_facts WHERE id = ?').run(row.id);
      db.prepare('INSERT INTO vec_facts (id, embedding) VALUES (?, ?)').run(row.id, buf);
      db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(row.id);
      if (krBuf) {
        db.prepare('INSERT INTO vec_facts_kr (id, embedding) VALUES (?, ?)').run(row.id, krBuf);
      }
    });
    tx();
    if (++done % 500 === 0) log(`facts: ${done}/${pending.length}`);
  }
  if (pending.length) log(`facts: done (${done})`);
  return done;
}

async function embedKoreanFacts(db) {
  let existing = new Set();
  try {
    existing = new Set(db.prepare('SELECT id FROM vec_facts_kr').all().map((r) => r.id));
  } catch { /* table scan unsupported → rebuild all */ }

  const rows = db.prepare(
    "SELECT id, fact_kr FROM facts WHERE is_active = 1 AND fact_kr IS NOT NULL AND fact_kr != ''"
  ).all().filter((r) => !existing.has(r.id));
  if (rows.length) log(`facts-kr: ${rows.length} Korean vectors to build`);

  let done = 0;
  for (const row of rows) {
    const emb = await generateEmbedding(row.fact_kr);
    const buf = Buffer.from(new Float32Array(emb).buffer);
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(row.id);
      db.prepare('INSERT INTO vec_facts_kr (id, embedding) VALUES (?, ?)').run(row.id, buf);
    });
    tx();
    if (++done % 500 === 0) log(`facts-kr: ${done}/${rows.length}`);
  }
  if (rows.length) log(`facts-kr: done (${done})`);
  return done;
}

async function reembedExchanges(db) {
  const total = db.prepare(
    'SELECT COUNT(*) AS n FROM exchanges WHERE embedding_version != ?'
  ).get(EMBEDDING_VERSION).n;
  if (!total) return 0;
  log(`exchanges: ${total} rows pending (processing newest first, max ${MAX_EXCHANGES})`);

  const toolStmt = db.prepare('SELECT tool_name FROM tool_calls WHERE exchange_id = ?');
  let done = 0;
  while (done < MAX_EXCHANGES) {
    if (migrationActive()) { log('int8 migration in progress — yielding (resume later)'); return; }
    const batch = db.prepare(`
      SELECT id, user_message, assistant_message FROM exchanges
      WHERE embedding_version != ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(EMBEDDING_VERSION, BATCH);
    if (batch.length === 0) break;

    for (const row of batch) {
      const toolNames = toolStmt.all(row.id).map((t) => t.tool_name);
      const emb = await generateExchangeEmbedding(row.user_message, row.assistant_message, toolNames);
      // dtype read INSIDE the write transaction: serializes against the int8
      // migration's BEGIN IMMEDIATE swap — we can never write a blob for a
      // schema that changed between read and write. exchanges.embedding is
      // legacy dead weight (no reader in src/) — NULL it instead of
      // duplicating ~1.5KB per row. last_indexed stamp: the migration's delta
      // reconciliation depends on every vector writer stamping it.
      const tx = db.transaction(() => {
        const vecDtype = getVecDtype(db);
        const buf = embeddingToVecBlob(emb, vecDtype);
        db.prepare('UPDATE exchanges SET embedding = NULL, embedding_version = ?, last_indexed = ? WHERE id = ?')
          .run(EMBEDDING_VERSION, Date.now(), row.id);
        db.prepare('DELETE FROM vec_exchanges WHERE id = ?').run(row.id);
        db.prepare(`INSERT INTO vec_exchanges (id, embedding) VALUES (?, ${vecParamSql(vecDtype)})`).run(row.id, buf);
      });
      // .immediate(): BEGIN IMMEDIATE — the write lock is acquired BEFORE the
      // dtype read (a deferred BEGIN would read first and let the migration
      // swap commit before our lock upgrade → stale-dtype write / busy-snapshot).
      tx.immediate();
      done++;
    }
    log(`exchanges: ${done}/${Math.min(total, MAX_EXCHANGES)}`);
  }
  log(`exchanges: done this run (${done}, remaining ${Math.max(0, total - done)})`);
  return done;
}

async function main() {
  if (!acquireLock()) {
    console.log('reembed: another worker is running, exiting');
    process.exit(0);
  }
  process.on('exit', releaseLock);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  log(`reembed: start (model=${EMBEDDING_MODEL}, version=${EMBEDDING_VERSION})`);
  let db;
  try {
    await initEmbeddings();
    db = initDatabase();
    await reembedFacts(db);
    await embedKoreanFacts(db);
    if (!FACTS_ONLY) await reembedExchanges(db);
    log('reembed: complete');
  } catch (error) {
    log(`reembed: ERROR ${error instanceof Error ? error.message : error}`);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

main();
