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
import { initDatabase } from '../dist/db.js';
import { consolidateFacts } from '../dist/consolidator.js';
import { getIndexDir } from '../dist/paths.js';

// GLOBAL single-instance lock (NOT per-project): consolidateFacts pulls global
// facts for EVERY project (getNewFactsSince includes scope_type='global'), so
// two per-project workers would race on the same shared rows (conflicting
// merges / deactivations / count increments in one SQLite DB). A global lock
// serializes all consolidation; to avoid starving the projects that lose the
// lock, the single lock-holder DRAINS every project with pending facts in one
// run (see main). This kills the flood (the SessionStart hook re-spawns a
// worker every session with no lock — measured 14 orphaned ppid=1 workers at
// once, each spawning a headless Claude session per LLM call) without dropping
// any project's background work.
const CWD_PROJECT = process.env.CWD || process.cwd();
const LOCK = path.join(getIndexDir(), 'fact-consolidate.lock');

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  try {
    fs.appendFileSync(path.join(getIndexDir(), 'fact-consolidate.log'), msg + '\n');
  } catch {
    // best-effort logging
  }
  console.log(msg);
}

// Atomic exclusive create ('wx') + pid-liveness check so a stale lock from a
// killed worker is cleared and re-acquired.
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

/**
 * Every project (canonical scope_project) with facts created since `since`,
 * plus the current CWD project so brand-new global-only facts still get a
 * pass. Draining all of them under ONE lock keeps global-fact consolidation
 * race-free while no project is starved.
 */
function pendingProjects(db, since) {
  const rows = db.prepare(`
    SELECT DISTINCT scope_project AS p FROM facts
    WHERE is_active = 1 AND created_at > ?
      AND scope_type = 'project' AND scope_project IS NOT NULL
  `).all(since);
  const set = new Set(rows.map((r) => r.p));
  set.add(CWD_PROJECT); // ensures global-scoped new facts are consolidated once
  return [...set];
}

async function main() {
  if (!acquireLock()) {
    // Another consolidate worker already holds the GLOBAL lock — exit cleanly.
    // It drains every pending project (incl. this one), so nothing is lost;
    // this session's spawn simply steps aside instead of piling up.
    process.exit(0);
  }
  process.on('exit', releaseLock);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  const lastConsolidated = process.env.LAST_CONSOLIDATED_AT
    || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  let db;
  try {
    db = initDatabase();
    // Drain all pending projects serially under the single lock. consolidateFacts
    // includes global facts in each pass, but merged/updated rows are
    // deactivated so a later project's pass won't re-act on them; running
    // serially (never concurrently) is what keeps shared global rows safe.
    const projects = pendingProjects(db, lastConsolidated);
    for (const project of projects) {
      try {
        const result = await consolidateFacts(db, project, lastConsolidated);
        if (result.processed > 0) {
          log(`worker: project=${project} processed=${result.processed} merged=${result.merged} contradictions=${result.contradictions} evolutions=${result.evolutions}`);
        }
      } catch (error) {
        log(`worker: ERROR project=${project}: ${error instanceof Error ? error.message : error}`);
      }
    }
  } catch (error) {
    log(`worker: FATAL ${error instanceof Error ? error.message : error}`);
    process.exitCode = 0;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

main();
