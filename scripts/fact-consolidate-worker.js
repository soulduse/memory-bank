#!/usr/bin/env node

/**
 * Detached worker spawned by fact-consolidate-hook.js.
 * Runs LLM-based fact consolidation without blocking SessionStart.
 *
 * Environment:
 *   CWD                  - project path (canonical: absolute path)
 *   LAST_CONSOLIDATED_AT - last consolidation time (default: 24h ago)
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { initDatabase } from '../dist/db.js';
import { consolidateFacts } from '../dist/consolidator.js';
import { getIndexDir } from '../dist/paths.js';

// PER-PROJECT lock: a global lock would let one project's long consolidation
// run starve every other project (each worker only consolidates its own CWD,
// so a losing project's facts stay unconsolidated until a later session).
// Keying the lock by project path caps the actual flood cause — the SAME
// project's SessionStart hook re-spawning on every session — to one worker,
// while letting distinct projects proceed in parallel.
const PROJECT = process.env.CWD || process.cwd();
const PROJECT_HASH = crypto.createHash('sha256').update(PROJECT).digest('hex').slice(0, 16);
const LOCK = path.join(getIndexDir(), `fact-consolidate-${PROJECT_HASH}.lock`);

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  try {
    fs.appendFileSync(path.join(getIndexDir(), 'fact-consolidate.log'), msg + '\n');
  } catch {
    // best-effort logging
  }
  console.log(msg);
}

// Single-instance-per-project lock: the SessionStart hook spawns this worker
// detached on EVERY session start with no lock, so without this guard orphaned
// workers (ppid=1) pile up — measured 14 running at once, each spawning a
// headless Claude session per LLM call, flooding the proxy. Atomic exclusive
// create ('wx') + pid-liveness check so a stale lock from a killed worker is
// cleared.
function acquireLock() {
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

async function main() {
  if (!acquireLock()) {
    // Another worker for THIS project is already running — exit cleanly (this
    // project's facts get consolidated on a later session; resumable). Other
    // projects have their own lock and are unaffected.
    process.exit(0);
  }
  process.on('exit', releaseLock);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  const project = PROJECT;
  const lastConsolidated = process.env.LAST_CONSOLIDATED_AT
    || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  let db;
  try {
    db = initDatabase();
    const result = await consolidateFacts(db, project, lastConsolidated);
    if (result.processed > 0) {
      log(`worker: project=${project} processed=${result.processed} merged=${result.merged} contradictions=${result.contradictions} evolutions=${result.evolutions}`);
    }
  } catch (error) {
    log(`worker: ERROR project=${project}: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 0;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

main();
