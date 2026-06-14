#!/usr/bin/env node
/**
 * One-time backfill: embed existing ontology categories into vec_categories so
 * the classifier can retrieve top-K candidates (instead of dumping all
 * categories into the prompt). New categories are embedded on creation
 * (ontology-classifier.ts); this covers the rows that predate that index.
 *
 * Idempotent and resumable: only embeds categories missing a vec_categories row.
 * Usage: node scripts/backfill-category-embeddings.mjs
 */
import { initDatabase } from '../dist/db.js';
import { initEmbeddings, generateEmbedding } from '../dist/embeddings.js';
import { upsertCategoryEmbedding } from '../dist/ontology-db.js';

const db = initDatabase();
try {
  await initEmbeddings();
  let existing = new Set();
  try { existing = new Set(db.prepare('SELECT id FROM vec_categories').all().map((r) => r.id)); }
  catch { /* table scan unsupported → treat all as missing */ }

  const cats = db.prepare('SELECT id, name, description FROM ontology_categories')
    .all().filter((c) => !existing.has(c.id));
  console.log(`category embeddings: ${cats.length} to build (${existing.size} already indexed)`);

  let done = 0;
  for (const c of cats) {
    const text = c.description ? `${c.name}: ${c.description}` : c.name;
    const emb = await generateEmbedding(text, 'passage');
    upsertCategoryEmbedding(db, c.id, emb);
    if (++done % 200 === 0) console.log(`category embeddings: ${done}/${cats.length}`);
  }
  const total = db.prepare('SELECT count(*) c FROM vec_categories').get().c;
  console.log(`category embeddings: done (${done} built, ${total} total indexed)`);
} catch (e) {
  console.error('category-embeddings backfill failed:', e instanceof Error ? e.message : e);
  process.exit(1);
} finally {
  db.close();
}
