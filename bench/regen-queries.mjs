#!/usr/bin/env node
// Regenerate the self-retrieval query set for bench.mjs.
//
// The recent-50K corpus is dominated by automated-worker template messages, so
// exact-id self-retrieval is ill-posed. Instead: one representative per DISTINCT
// 80-char prefix, and a hit = any top-10 result sharing that prefix (content-
// level recall — robust to duplicate template rows).

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new Database(path.join(REPO, '.autoresearch/bench-db.sqlite'), { readonly: true });
sqliteVec.load(db);

// One representative row per distinct 80-char prefix (deterministic: MIN(id)).
const rows = db.prepare(`
  SELECT MIN(id) id, substr(user_message,1,300) um, substr(user_message,1,80) pfx, COUNT(*) dup
  FROM exchanges
  WHERE LENGTH(user_message) BETWEEN 80 AND 4000
    AND user_message NOT LIKE '<%'
    AND user_message NOT LIKE 'Caveat:%'
    AND user_message NOT LIKE '[Request interrupted%'
    AND user_message NOT LIKE '%<system-reminder>%'
  GROUP BY pfx
  ORDER BY MIN(id)
`).all();
console.log('distinct-prefix templates:', rows.length);

const N = 120;
const step = Math.max(1, Math.floor(rows.length / N));
const queries = [];
for (let i = 0; i < rows.length && queries.length < N; i += step) {
  const q = rows[i].um.replace(/\s+/g, ' ').trim().slice(0, 150);
  if (q.length >= 40) queries.push({ id: rows[i].id, pfx: rows[i].pfx, dup: rows[i].dup, query: q });
}
fs.writeFileSync(path.join(REPO, '.autoresearch/queries.json'), JSON.stringify(queries, null, 1));
console.log('queries written:', queries.length);
console.log('sample:', JSON.stringify(queries[10] ?? queries[0]));
db.close();
