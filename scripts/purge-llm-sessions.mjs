#!/usr/bin/env node

/**
 * One-time cleanup for exchanges indexed from LLM worker sessions BEFORE the
 * v1.3.3 exclusion (`isExcludedProject`) existed. v1.3.3 stops NEW pollution
 * (indexing/sync/verify all skip `*-memory-bank-llm` slugs) and keeps old rows
 * out of fact extraction — but rows indexed earlier remain in the exchanges
 * table, the FTS index, and the vec_exchanges vector index, actively polluting
 * both text and semantic search. This script removes them.
 *
 * Safety model:
 *   - DRY-RUN BY DEFAULT: prints what would be deleted. Pass --apply to mutate.
 *   - BACKUP FIRST: on --apply, the polluted exchanges + tool_calls rows are
 *     copied into a timestamped sqlite file next to the index DB before any
 *     delete runs. (Embeddings are not backed up — they are regenerable from
 *     the exchange text if a restore is ever needed.)
 *   - Discriminator matches v1.3.3 isExcludedProject exactly: project slug
 *     ENDING with `-memory-bank-llm` (current fixed workdir and legacy mkdtemp
 *     variants alike). Nothing else can match.
 *   - All deletes run in a single transaction; tool_calls are deleted
 *     explicitly (the FK is ON DELETE CASCADE but that only fires when
 *     PRAGMA foreign_keys is ON, which we don't assume).
 *
 * Usage:
 *   node scripts/purge-llm-sessions.mjs            # dry-run (counts only)
 *   node scripts/purge-llm-sessions.mjs --apply    # backup + delete
 */

import fs from 'node:fs';
import path from 'node:path';
import { initDatabase } from '../dist/db.js';
import { getIndexDir } from '../dist/paths.js';

// Same discriminator as paths.ts isExcludedProject's built-in exclusion:
// the slug must END with -memory-bank-llm.
const SLUG_SUFFIX = '-memory-bank-llm';
const LIKE = `%${SLUG_SUFFIX}`;

const apply = process.argv.includes('--apply');

function main() {
  const db = initDatabase();
  try {
    const counts = {
      exchanges: db.prepare('SELECT count(*) AS n FROM exchanges WHERE project LIKE ?').get(LIKE).n,
      toolCalls: db.prepare(
        'SELECT count(*) AS n FROM tool_calls WHERE exchange_id IN (SELECT id FROM exchanges WHERE project LIKE ?)'
      ).get(LIKE).n,
      vectors: db.prepare(
        'SELECT count(*) AS n FROM vec_exchanges_rowids WHERE id IN (SELECT id FROM exchanges WHERE project LIKE ?)'
      ).get(LIKE).n,
    };

    console.log(`polluted exchanges: ${counts.exchanges}`);
    console.log(`polluted tool_calls: ${counts.toolCalls}`);
    console.log(`polluted vectors:    ${counts.vectors}`);

    if (counts.exchanges === 0 && counts.vectors === 0) {
      console.log('nothing to purge — index is clean.');
      return;
    }
    if (!apply) {
      console.log('\nDRY-RUN (no changes made). Re-run with --apply to backup + delete.');
      return;
    }

    // --- Backup first (reversibility): copy full rows into a timestamped DB ---
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(getIndexDir(), `purge-llm-backup-${ts}.sqlite`);
    // Refuse to overwrite an existing backup file (should be impossible with the
    // timestamp, but never clobber).
    if (fs.existsSync(backupPath)) throw new Error(`backup already exists: ${backupPath}`);
    db.exec(`ATTACH DATABASE '${backupPath.replace(/'/g, "''")}' AS bak`);
    db.exec('BEGIN');
    try {
      db.prepare(`CREATE TABLE bak.exchanges AS SELECT * FROM exchanges WHERE project LIKE ?`).run(LIKE);
      db.prepare(
        `CREATE TABLE bak.tool_calls AS SELECT * FROM tool_calls WHERE exchange_id IN (SELECT id FROM exchanges WHERE project LIKE ?)`
      ).run(LIKE);
      // Verify the backup actually captured every row BEFORE deleting anything.
      const bakEx = db.prepare('SELECT count(*) AS n FROM bak.exchanges').get().n;
      const bakTc = db.prepare('SELECT count(*) AS n FROM bak.tool_calls').get().n;
      if (bakEx !== counts.exchanges || bakTc !== counts.toolCalls) {
        throw new Error(`backup row mismatch: exchanges ${bakEx}/${counts.exchanges}, tool_calls ${bakTc}/${counts.toolCalls}`);
      }

      // --- Delete: vectors (per-id — vec0 virtual tables don't take subqueries),
      // then tool_calls, then exchanges (FTS triggers sync exchanges_fts). ---
      const ids = db.prepare('SELECT id FROM exchanges WHERE project LIKE ?').all(LIKE).map((r) => r.id);
      const delVec = db.prepare('DELETE FROM vec_exchanges WHERE id = ?');
      for (const id of ids) delVec.run(id);
      db.prepare('DELETE FROM tool_calls WHERE exchange_id IN (SELECT id FROM exchanges WHERE project LIKE ?)').run(LIKE);
      db.prepare('DELETE FROM exchanges WHERE project LIKE ?').run(LIKE);

      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      // A failed run must not leave a half-written backup that a later retry
      // would refuse to overwrite — remove it (the main DB was rolled back).
      try { fs.unlinkSync(backupPath); } catch { /* best-effort */ }
      throw e;
    } finally {
      try { db.exec('DETACH DATABASE bak'); } catch { /* already detached on error paths */ }
    }

    // --- Post-verify: everything gone ---
    const left = {
      exchanges: db.prepare('SELECT count(*) AS n FROM exchanges WHERE project LIKE ?').get(LIKE).n,
      vectors: db.prepare(
        'SELECT count(*) AS n FROM vec_exchanges_rowids WHERE id IN (SELECT id FROM exchanges WHERE project LIKE ?)'
      ).get(LIKE).n,
    };
    console.log(`\npurged. remaining polluted exchanges: ${left.exchanges}, vectors: ${left.vectors}`);
    console.log(`backup: ${backupPath}`);
    if (left.exchanges !== 0 || left.vectors !== 0) {
      process.exitCode = 1;
      console.error('WARNING: purge incomplete — inspect manually.');
    }
  } finally {
    db.close();
  }
}

main();
