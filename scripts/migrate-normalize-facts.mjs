#!/usr/bin/env node

/**
 * One-time (idempotent) migration:
 *
 *  1. Backup the facts table (facts_backup_YYYYMMDD).
 *  2. Normalize facts.scope_project from Claude-archive slug format
 *     (-Users-jung-wankim-Project-foo) to canonical absolute path format
 *     (/Users/jung-wankim/Project/foo), using exchanges(project, cwd) as
 *     ground truth. fact-db.ts matches scope_project by exact equality, so
 *     mixed formats make project facts invisible to lookups/consolidation.
 *  3. Deduplicate active facts by content (fact, scope_type, scope_project):
 *     keep the row with the highest consolidated_count (earliest created_at
 *     as tie-break), deactivate the rest and remove their vector rows.
 *
 * Usage:
 *   node scripts/migrate-normalize-facts.mjs --dry-run   # report only
 *   node scripts/migrate-normalize-facts.mjs             # apply
 */

import { initDatabase } from '../dist/db.js';

const DRY_RUN = process.argv.includes('--dry-run');

/** Claude Code archive dir slug: '/' and '.' replaced with '-' */
function slugify(p) {
  return p.replace(/[/.]/g, '-');
}

function main() {
  const db = initDatabase();
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const backupTable = `facts_backup_${today}`;

  try {
    // ── 1. Backup ────────────────────────────────────────────────
    const hasBackup = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
    ).get(backupTable);
    if (!hasBackup && !DRY_RUN) {
      db.exec(`CREATE TABLE ${backupTable} AS SELECT * FROM facts`);
      console.log(`backup: created ${backupTable}`);
    } else {
      console.log(`backup: ${hasBackup ? `${backupTable} already exists` : '(dry-run, skipped)'}`);
    }

    // ── 2. Normalize slug → path ─────────────────────────────────
    const slugs = db.prepare(`
      SELECT DISTINCT scope_project AS slug FROM facts
      WHERE scope_type = 'project' AND scope_project LIKE '-%'
    `).all();

    let normalized = 0;
    let unmapped = 0;
    for (const { slug } of slugs) {
      const candidates = db.prepare(`
        SELECT cwd, COUNT(*) AS n FROM exchanges
        WHERE project = ? AND cwd IS NOT NULL
        GROUP BY cwd ORDER BY n DESC
      `).all(slug);

      // Prefer the cwd whose slugification matches exactly; else most frequent.
      const exact = candidates.find((c) => slugify(c.cwd) === slug);
      const target = exact || candidates[0];

      if (!target) {
        console.log(`normalize: UNMAPPED ${slug} (no exchanges with cwd)`);
        unmapped++;
        continue;
      }

      const count = db.prepare(
        "SELECT COUNT(*) AS n FROM facts WHERE scope_type = 'project' AND scope_project = ?"
      ).get(slug).n;

      console.log(`normalize: ${slug} → ${target.cwd} (${count} facts${exact ? '' : ', frequency-based'})`);
      if (!DRY_RUN) {
        db.prepare(`
          UPDATE facts SET scope_project = ?, updated_at = ?
          WHERE scope_type = 'project' AND scope_project = ?
        `).run(target.cwd, new Date().toISOString(), slug);
      }
      normalized += count;
    }

    // ── 3. Content dedup ─────────────────────────────────────────
    const dupGroups = db.prepare(`
      SELECT fact, scope_type, COALESCE(scope_project, '') AS sp, COUNT(*) AS n
      FROM facts WHERE is_active = 1
      GROUP BY fact, scope_type, sp
      HAVING n > 1
    `).all();

    let deactivated = 0;
    for (const g of dupGroups) {
      const rows = db.prepare(`
        SELECT id FROM facts
        WHERE is_active = 1 AND fact = ? AND scope_type = ? AND COALESCE(scope_project, '') = ?
        ORDER BY consolidated_count DESC, created_at ASC
      `).all(g.fact, g.scope_type, g.sp);

      const losers = rows.slice(1); // keep rows[0]
      for (const { id } of losers) {
        if (!DRY_RUN) {
          db.prepare('UPDATE facts SET is_active = 0, updated_at = ? WHERE id = ?')
            .run(new Date().toISOString(), id);
          db.prepare('DELETE FROM vec_facts WHERE id = ?').run(id);
        }
        deactivated++;
      }
    }

    console.log('');
    console.log(`summary${DRY_RUN ? ' (DRY RUN)' : ''}:`);
    console.log(`  slug groups found:      ${slugs.length} (unmapped: ${unmapped})`);
    console.log(`  facts normalized:       ${normalized}`);
    console.log(`  duplicate groups:       ${dupGroups.length}`);
    console.log(`  duplicates deactivated: ${deactivated}`);
  } finally {
    db.close();
  }
}

main();
