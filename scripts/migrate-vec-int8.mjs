#!/usr/bin/env node
/**
 * Migrate vec_exchanges from float32 to int8 quantized vectors.
 *
 * Why: int8 uses 4× less storage and ~2× faster KNN with no measured recall@10
 * loss (50K-exchange benchmark: 73.6MB→18.4MB, KNN p50 19.1ms→8.7ms, recall
 * identical). Distances scale ×127 — all readers already normalize via
 * getVecDtype()/normalizeVecDistance() (search.ts / repeat-detector.ts).
 *
 * Safety:
 *  - pid lockfile ('wx' atomic) — no concurrent migration runs
 *  - scratch table built WITHOUT blocking writers, then the swap runs under
 *    BEGIN IMMEDIATE (write lock): a DELTA RECONCILIATION inside the lock
 *    copies rows inserted and removes rows deleted while the scratch build ran
 *    — normal writers do not take our lockfile, so without this pass any
 *    exchange synced mid-build would lose its vector permanently (its
 *    embedding_version is already current, so reembed-worker would never
 *    repair it).
 *  - counts are verified INSIDE the write lock before any destructive step
 *  - the swap (DROP old / CREATE int8 / copy) is the SAME transaction — crash
 *    at any point leaves either the old float32 table or the completed int8
 *    table. No mixed state is observable (dtype is derived from the actual
 *    schema in sqlite_master, not a flag).
 *  - reads during migration keep working (WAL); writers are blocked only for
 *    the duration of the swap transaction.
 *
 * Usage:
 *   node scripts/migrate-vec-int8.mjs [--db /path/to/db.sqlite] [--dry-run]
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

const dbArg = process.argv.indexOf('--db');
if (dbArg > -1) process.env.MEMORY_BANK_DB_PATH = path.resolve(process.argv[dbArg + 1]);
const DRY = process.argv.includes('--dry-run');

const { getDbPath, getIndexDir } = await import(path.join(REPO, 'dist/paths.js'));
const DB_PATH = getDbPath();
const LOCK = path.join(getIndexDir(), 'migrate-vec-int8.lock');

// --- lock ('wx' atomic acquire; stale-pid takeover) ---
function acquireLock() {
  try {
    fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
  } catch {
    const pid = parseInt(fs.readFileSync(LOCK, 'utf-8'), 10);
    try {
      process.kill(pid, 0);
      console.error(`another migration is running (pid ${pid}) — abort`);
      process.exit(1);
    } catch {
      fs.unlinkSync(LOCK); // stale
      fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
    }
  }
}
acquireLock();
process.on('exit', () => { try { fs.unlinkSync(LOCK); } catch { /* gone */ } });

const db = new Database(DB_PATH);
sqliteVec.load(db);
db.pragma('busy_timeout = 30000');

// dtype from the ACTUAL schema (single source of truth — no flag divergence)
const schemaSql = db.prepare(
  `SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_exchanges'`
).get()?.sql;
if (!schemaSql) { console.error('vec_exchanges table missing'); process.exit(2); }
if (/int8\s*\[/i.test(schemaSql)) { console.log('already int8 — nothing to do'); process.exit(0); }

const srcCount = db.prepare('SELECT COUNT(*) c FROM vec_exchanges').get().c;
console.log(`db: ${DB_PATH}`);
console.log(`vec_exchanges rows: ${srcCount} (float32)`);
if (DRY) { console.log('dry-run — no changes'); process.exit(0); }

// --- 1) build scratch int8 table (non-destructive, resumable by drop+rebuild) ---
db.exec('DROP TABLE IF EXISTS vec_exchanges_migr');
db.exec('CREATE VIRTUAL TABLE vec_exchanges_migr USING vec0(id TEXT PRIMARY KEY, embedding int8[384])');

const rdb = new Database(DB_PATH, { readonly: true });
sqliteVec.load(rdb);
const ins = db.prepare('INSERT INTO vec_exchanges_migr (id, embedding) VALUES (?, vec_int8(?))');
const tx = db.transaction((rows) => { for (const [id, buf] of rows) ins.run(id, buf); });
const quant = (f32) => {
  const q = new Int8Array(384);
  for (let i = 0; i < 384; i++) q[i] = Math.max(-127, Math.min(127, Math.round(f32[i] * 127)));
  return Buffer.from(q.buffer);
};
let n = 0, batch = [];
for (const r of rdb.prepare('SELECT id, embedding FROM vec_exchanges').iterate()) {
  batch.push([r.id, quant(new Float32Array(r.embedding.buffer, r.embedding.byteOffset, 384))]);
  if (batch.length >= 2000) { tx(batch); n += batch.length; batch = []; if (n % 20000 === 0) console.log(`  quantized ${n}/${srcCount}`); }
}
if (batch.length) { tx(batch); n += batch.length; }
rdb.close();
console.log(`quantized: ${n}`);

// Test hook: simulate a concurrent writer landing between the scratch build
// and the swap (the exact race window the delta reconciliation exists for).
// Used by the migration race repro test only.
if (process.env.MIGRATE_TEST_INJECT_SQL) {
  db.exec(process.env.MIGRATE_TEST_INJECT_SQL);
  console.log('test-inject applied');
}

// --- 2) atomic swap under a WRITE LOCK with delta reconciliation ---
// BEGIN IMMEDIATE acquires the write lock up front: no other writer can
// insert/delete vectors from here to COMMIT (they block on busy_timeout).
// Rows written/deleted during the scratch build are reconciled INSIDE the
// lock, so nothing synced mid-migration is lost.
let finalExpected = 0;
db.exec('BEGIN IMMEDIATE');
try {
  // materialize scratch ids into a regular temp b-tree (cross-virtual-table
  // subqueries on vec0 are unreliable)
  db.exec('CREATE TEMP TABLE migr_ids AS SELECT id FROM vec_exchanges_migr');
  db.exec('CREATE TEMP TABLE live_ids AS SELECT id FROM vec_exchanges');

  // (a) rows inserted after the scratch scan → quantize + add
  const newRows = db.prepare(`
    SELECT v.id, v.embedding FROM vec_exchanges v
    WHERE v.id IN (SELECT id FROM live_ids WHERE id NOT IN (SELECT id FROM migr_ids))
  `).all();
  for (const r of newRows) {
    ins.run(r.id, quant(new Float32Array(r.embedding.buffer, r.embedding.byteOffset, 384)));
  }
  // (b) rows deleted after the scratch scan → remove from scratch
  const goneIds = db.prepare(
    'SELECT id FROM migr_ids WHERE id NOT IN (SELECT id FROM live_ids)'
  ).all();
  const delMigr = db.prepare('DELETE FROM vec_exchanges_migr WHERE id = ?');
  for (const r of goneIds) delMigr.run(r.id);
  if (newRows.length || goneIds.length) {
    console.log(`delta reconciled inside write lock: +${newRows.length} / -${goneIds.length}`);
  }

  // (c) authoritative count verify INSIDE the lock, before anything destructive
  const liveCount = db.prepare('SELECT COUNT(*) c FROM vec_exchanges').get().c;
  const migrCount = db.prepare('SELECT COUNT(*) c FROM vec_exchanges_migr').get().c;
  if (liveCount !== migrCount) {
    throw new Error(`count mismatch inside lock: live ${liveCount} vs migr ${migrCount}`);
  }
  finalExpected = liveCount;

  db.exec('DROP TABLE vec_exchanges');
  db.exec('CREATE VIRTUAL TABLE vec_exchanges USING vec0(id TEXT PRIMARY KEY, embedding int8[384])');
  db.exec('INSERT INTO vec_exchanges (id, embedding) SELECT id, vec_int8(embedding) FROM vec_exchanges_migr');
  db.exec('DROP TABLE vec_exchanges_migr');
  db.exec('DROP TABLE migr_ids');
  db.exec('DROP TABLE live_ids');
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('🛑 swap failed, rolled back (float32 table intact):', e.message);
  process.exit(2);
}

// --- 3) post-verify (dtype from actual schema) ---
const finalCount = db.prepare('SELECT COUNT(*) c FROM vec_exchanges').get().c;
const finalSql = db.prepare(
  `SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_exchanges'`
).get().sql;
const finalDtype = /int8\s*\[/i.test(finalSql) ? 'int8' : 'float32';
console.log(`final: ${finalCount} rows, dtype=${finalDtype}`);
if (finalCount !== finalExpected || finalDtype !== 'int8') {
  console.error('🛑 post-verify failed');
  process.exit(2);
}
console.log('✅ migration complete. Run VACUUM to reclaim disk space (optional, requires free space).');
db.close();
