#!/usr/bin/env node

/**
 * Ontology classification backfill (detached, resumable).
 *
 * classifyAndLinkFact normally runs at insert time, but historic facts
 * (batch-extracted or imported) were saved without classification. This
 * worker classifies every active fact whose ontology_category_id is NULL.
 * The NULL column doubles as the resume marker, so the worker can be killed
 * and relaunched at any time.
 *
 * Usage: node scripts/backfill-ontology-worker.js [--max N]
 */

import fs from 'node:fs';
import path from 'node:path';
import { initDatabase } from '../dist/db.js';
import { classifyAndLinkFact } from '../dist/ontology-classifier.js';
import { getIndexDir } from '../dist/paths.js';

const maxArg = process.argv.indexOf('--max');
const MAX_FACTS = maxArg > -1 ? parseInt(process.argv[maxArg + 1], 10) : Infinity;
const CONCURRENCY = parseInt(process.env.BACKFILL_CONCURRENCY || '4', 10);

const LOCK = path.join(getIndexDir(), 'backfill-ontology.lock');
const LOG = path.join(getIndexDir(), 'backfill-ontology.log');

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

function toEmbeddingArray(blob) {
  if (!(blob instanceof Buffer)) return undefined;
  return Array.from(new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4));
}

async function main() {
  if (!acquireLock()) {
    console.log('backfill-ontology: another worker is running, exiting');
    process.exit(0);
  }
  process.on('exit', releaseLock);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  let db;
  try {
    db = initDatabase();
    const pending = db.prepare(`
      SELECT id, embedding FROM facts
      WHERE is_active = 1 AND ontology_category_id IS NULL
      ORDER BY consolidated_count DESC, created_at DESC
      LIMIT ?
    `).all(Number.isFinite(MAX_FACTS) ? MAX_FACTS : 1000000);
    log(`backfill-ontology: ${pending.length} facts this run (concurrency ${CONCURRENCY})`);

    let done = 0, failed = 0;
    const queue = [...pending];
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length > 0) {
        const row = queue.shift();
        if (!row) break;
        try {
          await classifyAndLinkFact(db, row.id, toEmbeddingArray(row.embedding));
          done++;
        } catch (error) {
          failed++;
          log(`fact ${row.id}: ERROR ${error instanceof Error ? error.message : error}`);
        }
        if ((done + failed) % 50 === 0) log(`progress: ${done + failed}/${pending.length} (classified ${done}, failed ${failed})`);
      }
    });
    await Promise.all(workers);
    log(`backfill-ontology: done this run (classified ${done}, failed ${failed})`);
  } catch (error) {
    log(`backfill-ontology: FATAL ${error instanceof Error ? error.message : error}`);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

main();
