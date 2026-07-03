#!/usr/bin/env node
/**
 * One-time backfill: populate the exchanges_fts (FTS5 external-content) index
 * for all existing exchanges. New rows are kept in sync by triggers (see db.ts);
 * this only indexes rows that predate the FTS table. Idempotent — 'rebuild'
 * discards and re-derives the whole index from the exchanges content table, so
 * it is safe to re-run.
 *
 * Usage: node scripts/backfill-fts.mjs
 */
import { initDatabase } from '../dist/db.js';

const db = initDatabase();
try {
  const t0 = Date.now();
  // 'rebuild' is the FTS5 command to (re)build an external-content index.
  db.exec(`INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild')`);
  // Mark the index ready so search.ts uses FTS instead of the LIKE fallback.
  db.exec(`CREATE TABLE IF NOT EXISTS fts_meta (key TEXT PRIMARY KEY, value TEXT)`);
  db.prepare(`INSERT OR REPLACE INTO fts_meta(key, value) VALUES('exchanges_fts_built', '1')`).run();
  const rows = db.prepare('SELECT count(*) c FROM exchanges').get().c;
  // Sanity probe: a MATCH should now return quickly.
  const probe = db.prepare(
    `SELECT count(*) c FROM exchanges_fts WHERE exchanges_fts MATCH ?`
  ).get('"the"').c;
  console.log(`FTS rebuild done: indexed ${rows} exchanges in ${((Date.now() - t0) / 1000).toFixed(1)}s (probe "the" → ${probe} hits)`);
} catch (e) {
  console.error('FTS backfill failed:', e instanceof Error ? e.message : e);
  process.exit(1);
} finally {
  db.close();
}
