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
 *  - pid lockfile ('wx' atomic) — no concurrent writers (vector-index-version-integrity)
 *  - scratch table built + count-verified BEFORE any destructive step
 *  - the swap (DROP old / CREATE int8 / copy / flag) is ONE transaction — crash
 *    at any point leaves either the old float32 table (flag unchanged) or the
 *    completed int8 table (flag set). No mixed state is observable.
 *  - reads during migration keep working (WAL); writers are blocked briefly
 *    during the swap transaction only.
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

const dtype = (db.prepare(`SELECT value FROM fts_meta WHERE key='vec_exchanges_dtype'`)
  .get())?.value;
if (dtype === 'int8') { console.log('already int8 — nothing to do'); process.exit(0); }

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

// --- 2) verify counts before any destructive step ---
const migrCount = db.prepare('SELECT COUNT(*) c FROM vec_exchanges_migr').get().c;
if (migrCount !== srcCount) {
  console.error(`🛑 count mismatch: src ${srcCount} vs migr ${migrCount} — aborting, nothing destroyed`);
  process.exit(2);
}

// --- 3) atomic swap in ONE transaction ---
db.exec('BEGIN');
try {
  db.exec('DROP TABLE vec_exchanges');
  db.exec('CREATE VIRTUAL TABLE vec_exchanges USING vec0(id TEXT PRIMARY KEY, embedding int8[384])');
  db.exec('INSERT INTO vec_exchanges (id, embedding) SELECT id, vec_int8(embedding) FROM vec_exchanges_migr');
  db.exec('DROP TABLE vec_exchanges_migr');
  db.prepare(`INSERT OR REPLACE INTO fts_meta(key, value) VALUES('vec_exchanges_dtype', 'int8')`).run();
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('🛑 swap failed, rolled back:', e.message);
  process.exit(2);
}

// --- 4) post-verify ---
const finalCount = db.prepare('SELECT COUNT(*) c FROM vec_exchanges').get().c;
const finalDtype = db.prepare(`SELECT value FROM fts_meta WHERE key='vec_exchanges_dtype'`).get().value;
console.log(`final: ${finalCount} rows, dtype=${finalDtype}`);
if (finalCount !== srcCount || finalDtype !== 'int8') {
  console.error('🛑 post-verify failed');
  process.exit(2);
}
console.log('✅ migration complete. Run VACUUM to reclaim disk space (optional, requires free space).');
db.close();
