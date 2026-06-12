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

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  try {
    fs.appendFileSync(path.join(getIndexDir(), 'fact-consolidate.log'), msg + '\n');
  } catch {
    // best-effort logging
  }
  console.log(msg);
}

async function main() {
  const project = process.env.CWD || process.cwd();
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
