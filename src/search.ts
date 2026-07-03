import { initDatabase, getVecDtype, embeddingToVecBlob, vecParamSql, normalizeVecDistance } from './db.js';
import { getDbPath } from './paths.js';
import { initEmbeddings, generateEmbedding, EMBEDDING_VERSION } from './embeddings.js';
import { searchSimilarFacts } from './fact-db.js';
import { getRelatedFacts, listDomains, listCategories } from './ontology-db.js';
import { SearchResult, ConversationExchange, MultiConceptResult } from './types.js';
import type DatabaseType from 'better-sqlite3';
import fs from 'fs';
import readline from 'readline';

// Module-level cached connection for the search read path. searchConversations
// runs inside long-lived MCP server processes where re-running initDatabase()'s
// full DDL/migration pass and re-opening the file on EVERY search call is pure
// overhead (~3-4ms/call). Keyed by resolved DB path AND file identity
// (dev:inode) — a path-only key would keep serving a stale handle after the
// DB file is unlinked/recreated (rebuild/restore), returning deleted rows and
// missing new ones. Test overrides (TEST_DB_PATH / MEMORY_BANK_DB_PATH)
// switching mid-process also get a fresh handle. Short-lived CLI processes
// release the handle at exit.
let cachedSearchDb: DatabaseType.Database | null = null;
let cachedSearchDbPath: string | null = null;
let cachedSearchDbIdent: string | null = null;

function fileIdent(p: string): string | null {
  try {
    const st = fs.statSync(p);
    return `${st.dev}:${st.ino}`;
  } catch {
    return null; // file missing — force reopen (initDatabase recreates it)
  }
}

function getSearchDb(): DatabaseType.Database {
  const p = getDbPath();
  const ident = fileIdent(p);
  if (
    cachedSearchDb && cachedSearchDb.open &&
    cachedSearchDbPath === p &&
    ident !== null && cachedSearchDbIdent === ident
  ) {
    return cachedSearchDb;
  }
  try { cachedSearchDb?.close(); } catch { /* already closed */ }
  cachedSearchDb = initDatabase();
  cachedSearchDbPath = p;
  cachedSearchDbIdent = fileIdent(p);
  return cachedSearchDb;
}

export interface SearchOptions {
  limit?: number;
  mode?: 'vector' | 'text' | 'both';
  after?: string;  // ISO date string
  before?: string; // ISO date string
  coding_agent?: string; // Filter by coding agent (e.g., 'claude-code', 'codex', 'opencode')
}

interface ExchangeRow {
  id: string;
  project: string;
  timestamp: string;
  user_message: string;
  assistant_message: string;
  archive_path: string;
  line_start: number;
  line_end: number;
  distance: number;
  coding_agent: string | null;
}

function validateISODate(dateStr: string, paramName: string): void {
  const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!isoDateRegex.test(dateStr)) {
    throw new Error(`Invalid ${paramName} date: "${dateStr}". Expected YYYY-MM-DD format (e.g., 2025-10-01)`);
  }
  // Verify it's actually a valid date
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid ${paramName} date: "${dateStr}". Not a valid calendar date.`);
  }
}

export async function searchConversations(
  query: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const { limit = 10, mode = 'both', after, before, coding_agent } = options;

  // Validate date parameters
  if (after) validateISODate(after, '--after');
  if (before) validateISODate(before, '--before');

  const db = getSearchDb();
  let results: ExchangeRow[] = [];

  {
    // Build filter clauses with parameterized queries
    const filterParts: string[] = [];
    const filterParams: string[] = [];
    if (after) {
      filterParts.push(`e.timestamp >= ?`);
      filterParams.push(after);
    }
    if (before) {
      filterParts.push(`e.timestamp <= ?`);
      filterParams.push(before);
    }
    if (coding_agent) {
      filterParts.push(`e.coding_agent = ?`);
      filterParams.push(coding_agent);
    }
    const timeClause = filterParts.length > 0 ? `AND ${filterParts.join(' AND ')}` : '';
    const timeParams = filterParams;

    if (mode === 'vector' || mode === 'both') {
      // Vector similarity search
      await initEmbeddings();
      const queryEmbedding = await generateEmbedding(query, 'query');

      // dtype-aware: int8 tables need vec_int8()-wrapped quantized query blobs,
      // and their distances come back ×127-scaled (normalized below).
      const vecQuery = (vecDtype: 'float32' | 'int8'): ExchangeRow[] => {
        const stmt = db.prepare(`
          SELECT
            e.id,
            e.project,
            e.timestamp,
            e.user_message,
            e.assistant_message,
            e.archive_path,
            e.line_start,
            e.line_end,
            e.coding_agent,
            vec.distance
          FROM vec_exchanges AS vec
          JOIN exchanges AS e ON vec.id = e.id
          WHERE vec.embedding MATCH ${vecParamSql(vecDtype)}
            AND k = ?
            AND e.embedding_version = ?
            ${timeClause}
          ORDER BY vec.distance ASC
        `);

        // embedding_version filter: old-model vectors are incomparable with the
        // current-model query embedding — exclude rows the re-embed worker has
        // not upgraded yet (newest sessions are upgraded first).
        const rows = stmt.all(
          embeddingToVecBlob(queryEmbedding, vecDtype),
          limit,
          EMBEDDING_VERSION,
          ...timeParams
        ) as ExchangeRow[];
        for (const r of rows) r.distance = normalizeVecDistance(r.distance, vecDtype);
        return rows;
      };

      let vecDtype = getVecDtype(db);
      try {
        results = vecQuery(vecDtype);
      } catch (e) {
        // The int8 migration may have swapped the table dtype between our
        // dtype read and the query (read path is not serialized by the swap
        // lock). Retry once with a fresh dtype; rethrow anything else.
        const fresh = getVecDtype(db);
        if (fresh === vecDtype) throw e;
        vecDtype = fresh;
        results = vecQuery(vecDtype);
      }
    }

    // In 'both' mode always run the text pass and merge: vector (semantic) and
    // text (literal/keyword) are complementary, so skipping text when vector is
    // full would drop exact matches that vector ranks lower. The text pass is now
    // cheap (FTS5), so there is no reason to skip it.
    if (mode === 'text' || mode === 'both') {
      const cols = `
          e.id,
          e.project,
          e.timestamp,
          e.user_message,
          e.assistant_message,
          e.archive_path,
          e.line_start,
          e.line_end,
          e.coding_agent`;

      let textResults: ExchangeRow[] = [];

      // FTS5 (BM25-ranked) — replaces the O(rows) LIKE full scan. Build a safe
      // MATCH expression by quoting each whitespace token (neutralizes FTS5
      // operators like -, *, OR, ", :). Falls back to LIKE if the FTS table is
      // absent (older DB) or the query has no usable tokens.
      //
      // Two-stage matching: AND first (precision — every token must be
      // present, identical to the original behavior), then an OR fallback
      // ONLY when AND matches nothing. Long natural-language queries almost
      // never contain ALL tokens in one exchange (measured 16% AND match rate
      // on ~20-token queries), which silently killed the text pass and capped
      // bench recall@10 at 0.930; the OR fallback rescues those (recall
      // 1.000) without letting single-token hits displace exact matches on
      // queries AND can satisfy. The OR pass caps to the longest tokens —
      // longer tokens are rarer (cheaper posting unions) and more selective
      // (better BM25 top-k).
      // Split on ANY non-alphanumeric boundary (mirroring the unicode61
      // tokenizer), not just whitespace: a whitespace-split token like
      // "sqlite-vec" quoted becomes a multi-token PHRASE query after FTS
      // tokenization, and phrase queries are unsupported under detail=column
      // (they throw → silent LIKE fallback → seconds-long full scans).
      // Single-token quoted terms can never form phrases.
      const ftsTokens = query
        .split(/[^\p{L}\p{N}]+/u)
        .map((t) => t.trim())
        .filter(Boolean);
      const ftsExpr = ftsTokens.map((t) => `"${t}"`).join(' ');
      const MAX_FTS_TOKENS = 6;
      const MAX_OR_TOKENS = 10; // hard bound on posting-list unions (latency)
      let orTokens = ftsTokens;
      if (orTokens.length > MAX_FTS_TOKENS) {
        const uniq = [...new Set(orTokens)];
        // Longest tokens are rarer (cheaper unions, better BM25 selectivity) —
        // but short identifier-like tokens (id7, R8, C4, QA) are often the
        // real discriminators, so digit-bearing tokens and short ALL-CAPS
        // acronyms are always kept alongside the longest ones.
        const identifiers = uniq.filter((t) => /\d/.test(t) || /^[A-Z]{2,4}$/.test(t));
        const longest = uniq.sort((a, b) => b.length - a.length).slice(0, MAX_FTS_TOKENS);
        orTokens = [...new Set([...longest, ...identifiers])].slice(0, MAX_OR_TOKENS);
      }
      // OR expression is built LAZILY with a document-frequency gate: ORing a
      // very common token ("memory", "push") forces BM25 to score every one
      // of its hundreds of thousands of matches (measured 35s on 456K rows).
      // Tokens matching more than DF_CEILING docs are dropped from the OR set
      // — they carry no selectivity anyway; the AND pass and the vector pass
      // still cover them. Count probes are posting-length scans (no scoring),
      // a few ms each, and only run when the OR pass is actually needed.
      const DF_CEILING = 20000;
      const buildOrExpr = (): string => {
        let kept = orTokens;
        try {
          const dfStmt = db.prepare(
            `SELECT count(*) c FROM exchanges_fts WHERE exchanges_fts MATCH ?`
          );
          const withDf = orTokens.map((t) => ({
            t,
            df: (dfStmt.get(`"${t}"`) as { c: number }).c,
          }));
          kept = withDf.filter((x) => x.df <= DF_CEILING).map((x) => x.t);
          // All tokens too common → keep the 2 rarest so OR still runs cheaply.
          if (kept.length === 0) {
            kept = withDf.sort((a, b) => a.df - b.df).slice(0, 2).map((x) => x.t);
          }
        } catch { /* df probe failed → use unfiltered tokens */ }
        return kept.map((t) => `"${t}"`).join(' OR ');
      };

      let usedFts = false;
      if (ftsExpr) {
        try {
          // Readiness flag (set in db.ts / backfill-fts.mjs). On a fresh upgrade
          // the external-content FTS index is EMPTY until backfill-fts.mjs runs;
          // a row-probe would false-positive (it reads the content table), so we
          // use an explicit '1' flag and fall back to LIKE until it is set — never
          // silently hiding historical text matches.
          const built = db.prepare(`SELECT value FROM fts_meta WHERE key='exchanges_fts_built'`).get() as { value: string } | undefined;
          if (built?.value === '1') {
            const ftsStmt = db.prepare(`
              SELECT ${cols}, 0 as distance
              FROM exchanges_fts AS fts
              JOIN exchanges AS e ON e.rowid = fts.rowid
              WHERE exchanges_fts MATCH ?
                ${timeClause}
              ORDER BY rank
              LIMIT ?
            `);
            // Contract: the text pass returns AT MOST `limit` rows in every
            // mode, all-token (AND/exact) matches always first — identical
            // fetch depth to the original all-AND implementation.
            if (ftsTokens.length <= MAX_FTS_TOKENS) {
              // Short query: AND first (precision — identical to original
              // behavior), OR fallback only when AND matches nothing.
              textResults = ftsStmt.all(ftsExpr, ...timeParams, limit) as ExchangeRow[];
              if (textResults.length === 0 && ftsTokens.length > 1) {
                const orExpr = buildOrExpr();
                if (orExpr && orExpr !== ftsExpr) {
                  textResults = ftsStmt.all(orExpr, ...timeParams, limit) as ExchangeRow[];
                }
              }
            } else {
              // Long query: AND pass first (full limit — exact matches are
              // never capped below the caller's limit), then OR supplement
              // filling only the REMAINING slots. Two cheap passes beat one
              // combined "(AND) OR (OR)" query (measured ~20% faster). AND
              // results stay FIRST: an exact all-token match can never be
              // hidden by any-token hits, even when its discriminating tokens
              // are short ones the OR cap drops. The OR pass rescues the ~84%
              // of long queries AND cannot match.
              textResults = ftsStmt.all(ftsExpr, ...timeParams, limit) as ExchangeRow[];
              if (textResults.length < limit) {
                const orExpr = buildOrExpr();
                if (orExpr) {
                  const orResults = ftsStmt.all(orExpr, ...timeParams, limit) as ExchangeRow[];
                  const seenText = new Set(textResults.map((r) => r.id));
                  for (const r of orResults) {
                    if (!seenText.has(r.id) && textResults.length < limit) {
                      textResults.push(r);
                    }
                  }
                }
              }
            }
            usedFts = true;
          }
        } catch {
          usedFts = false; // FTS table missing/unsupported → LIKE fallback below
        }
      }

      if (!usedFts) {
        // Escape LIKE metacharacters
        const escapedQuery = query.replace(/%/g, '\\%').replace(/_/g, '\\_');
        const likePattern = `%${escapedQuery}%`;
        const textStmt = db.prepare(`
          SELECT ${cols}, 0 as distance
          FROM exchanges AS e
          WHERE (e.user_message LIKE ? ESCAPE '\\' OR e.assistant_message LIKE ? ESCAPE '\\')
            ${timeClause}
          ORDER BY e.timestamp DESC
          LIMIT ?
        `);
        textResults = textStmt.all(likePattern, likePattern, ...timeParams, limit) as ExchangeRow[];
      }

      if (mode === 'both') {
        // Merge and deduplicate by ID
        const seenIds = new Set(results.map(r => r.id));
        for (const textResult of textResults) {
          if (!seenIds.has(textResult.id)) {
            results.push(textResult);
          }
        }
      } else {
        results = textResults;
      }
    }
  }
  // NOTE: no db.close() — the cached connection is reused across calls (see
  // getSearchDb). CLI processes release it at exit; the MCP server keeps it.

  return results.map((row) => {
    const exchange: ConversationExchange = {
      id: row.id,
      project: row.project,
      timestamp: row.timestamp,
      userMessage: row.user_message,
      assistantMessage: row.assistant_message,
      archivePath: row.archive_path,
      lineStart: row.line_start,
      lineEnd: row.line_end,
      codingAgent: row.coding_agent || 'claude-code',
    };

    // Try to load summary if available
    const summaryPath = row.archive_path.replace('.jsonl', '-summary.txt');
    let summary: string | undefined;
    try { summary = fs.readFileSync(summaryPath, 'utf-8').trim(); } catch { /* absent */ }

    // Create snippet (first 200 chars, collapse newlines)
    const snippetText = exchange.userMessage.substring(0, 200).replace(/\s+/g, ' ').trim();
    const snippet = snippetText + (exchange.userMessage.length > 200 ? '...' : '');

    return {
      exchange,
      similarity: mode === 'text' ? undefined : 1 - row.distance,
      snippet,
      summary
    } as SearchResult & { summary?: string };
  });
}

// Helper function to count lines in a file efficiently
async function countLines(filePath: string): Promise<number> {
  try {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let count = 0;
    for await (const line of rl) {
      if (line.trim()) count++;
    }
    return count;
  } catch (error) {
    return 0; // Return 0 if file can't be read
  }
}

// Helper function to get file size in KB
function getFileSizeInKB(filePath: string): number {
  try {
    const stats = fs.statSync(filePath);
    return Math.round(stats.size / 1024 * 10) / 10; // Round to 1 decimal place
  } catch (error) {
    return 0;
  }
}

export async function formatResults(results: Array<SearchResult & { summary?: string }>): Promise<string> {
  if (results.length === 0) {
    return 'No results found.';
  }

  let output = `Found ${results.length} relevant conversation${results.length > 1 ? 's' : ''}:\n\n`;

  // Process results sequentially to get file metadata
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    const date = new Date(result.exchange.timestamp).toISOString().split('T')[0];
    const simPct = result.similarity !== undefined ? Math.round(result.similarity * 100) : null;

    // Header with match percentage and coding agent
    const agent = result.exchange.codingAgent || 'claude-code';
    const agentTag = agent !== 'claude-code' ? ` @${agent}` : '';
    output += `${index + 1}. [${result.exchange.project}, ${date}${agentTag}]`;
    if (simPct !== null) {
      output += ` - ${simPct}% match`;
    }
    output += '\n';

    // Show summary only if it's concise (< 300 chars)
    if (result.summary && result.summary.length < 300) {
      output += `   ${result.summary}\n`;
    }

    // Show snippet
    output += `   "${result.snippet}"\n`;

    // Show tool usage if available
    if (result.exchange.toolCalls && result.exchange.toolCalls.length > 0) {
      const toolCounts = new Map<string, number>();
      result.exchange.toolCalls.forEach(tc => {
        toolCounts.set(tc.toolName, (toolCounts.get(tc.toolName) || 0) + 1);
      });
      const toolSummary = Array.from(toolCounts.entries())
        .map(([name, count]) => `${name}(${count})`)
        .join(', ');
      output += `   Tools: ${toolSummary}\n`;
    }

    // Get file metadata
    const fileSizeKB = getFileSizeInKB(result.exchange.archivePath);
    const totalLines = await countLines(result.exchange.archivePath);
    const lineRange = `${result.exchange.lineStart}-${result.exchange.lineEnd}`;

    // File information with metadata (clean format for smart tool selection)
    output += `   Lines ${lineRange} in ${result.exchange.archivePath} (${fileSizeKB}KB, ${totalLines} lines)\n\n`;
  }

  return output;
}

export async function searchMultipleConcepts(
  concepts: string[],
  options: Omit<SearchOptions, 'mode'> = {}
): Promise<MultiConceptResult[]> {
  const { limit = 10 } = options;

  if (concepts.length === 0) {
    return [];
  }

  // Search for each concept independently
  const conceptResults = await Promise.all(
    concepts.map(concept => searchConversations(concept, { ...options, limit: limit * 5, mode: 'vector' }))
  );

  // Build map of conversation path -> array of results (one per concept)
  const conversationMap = new Map<string, Array<SearchResult & { conceptIndex: number }>>();

  conceptResults.forEach((results, conceptIndex) => {
    results.forEach(result => {
      const key = result.exchange.archivePath;
      if (!conversationMap.has(key)) {
        conversationMap.set(key, []);
      }
      conversationMap.get(key)!.push({ ...result, conceptIndex });
    });
  });

  // Find conversations that match ALL concepts
  const multiConceptResults: MultiConceptResult[] = [];

  for (const [, results] of conversationMap.entries()) {
    // Check if all concepts are represented
    const representedConcepts = new Set(results.map(r => r.conceptIndex));
    if (representedConcepts.size === concepts.length) {
      // All concepts found in this conversation
      const conceptSimilarities = concepts.map((_concept, index) => {
        const result = results.find(r => r.conceptIndex === index);
        return result?.similarity || 0;
      });

      const averageSimilarity = conceptSimilarities.reduce((sum, sim) => sum + sim, 0) / conceptSimilarities.length;

      // Use the first result's exchange data (they're all from the same conversation)
      const firstResult = results[0];

      multiConceptResults.push({
        exchange: firstResult.exchange,
        snippet: firstResult.snippet,
        conceptSimilarities,
        averageSimilarity
      });
    }
  }

  // Sort by average similarity (highest first)
  multiConceptResults.sort((a, b) => b.averageSimilarity - a.averageSimilarity);

  // Apply limit
  return multiConceptResults.slice(0, limit);
}

// === Knowledge Graph Enhanced Search ===

export interface KnowledgeContext {
  facts: Array<{
    fact: string;
    category: string;
    domain: string;
    categoryName: string;
    similarity: number;
    relatedFacts: Array<{
      fact: string;
      relationType: string;
    }>;
  }>;
}

/**
 * Enrich search results with knowledge graph context.
 * Finds related facts from the ontology and expands via graph traversal.
 */
export async function getKnowledgeContext(
  query: string,
  project?: string | null,
  limit: number = 5,
): Promise<KnowledgeContext> {
  await initEmbeddings();
  const db = initDatabase();

  try {
    const queryEmbedding = await generateEmbedding(query, 'query');
    const factResults = searchSimilarFacts(db, queryEmbedding, project ?? null, limit, 0.6);

    if (factResults.length === 0) {
      return { facts: [] };
    }

    // Build domain/category lookup
    const domains = listDomains(db);
    const categories = listCategories(db);
    const domainMap = new Map(domains.map(d => [d.id, d.name]));
    const categoryMap = new Map(categories.map(c => [c.id, { name: c.name, domainId: c.domain_id }]));

    const enrichedFacts: KnowledgeContext['facts'] = [];

    for (const { fact, distance } of factResults) {
      const similarity = parseFloat((1 - (distance * distance) / 2).toFixed(3));
      const catInfo = fact.ontology_category_id
        ? categoryMap.get(fact.ontology_category_id)
        : undefined;
      const domainName = catInfo ? (domainMap.get(catInfo.domainId) ?? 'Unclassified') : 'Unclassified';
      const catName = catInfo ? catInfo.name : 'Unclassified';

      // Expand via 1-hop graph traversal
      const related = getRelatedFacts(db, fact.id, 1);
      const relatedFacts = related.map(({ fact: relFact, relation }) => ({
        fact: relFact.fact,
        relationType: relation.relation_type,
      }));

      enrichedFacts.push({
        fact: fact.fact,
        category: fact.category,
        domain: domainName,
        categoryName: catName,
        similarity,
        relatedFacts,
      });
    }

    return { facts: enrichedFacts };
  } finally {
    db.close();
  }
}

/**
 * Format knowledge context as a readable section appended to search results.
 */
export function formatKnowledgeContext(context: KnowledgeContext): string {
  if (context.facts.length === 0) return '';

  let output = '\n---\n**Related Knowledge (from past decisions):**\n\n';

  for (const fact of context.facts) {
    output += `- **[${fact.domain}/${fact.categoryName}]** ${fact.fact} _(${fact.category}, ${Math.round(fact.similarity * 100)}% relevant)_\n`;
    for (const rel of fact.relatedFacts) {
      output += `  - ${rel.relationType}: ${rel.fact}\n`;
    }
  }

  return output;
}

export async function formatMultiConceptResults(
  results: MultiConceptResult[],
  concepts: string[]
): Promise<string> {
  if (results.length === 0) {
    return `No conversations found matching all concepts: ${concepts.join(', ')}`;
  }

  let output = `Found ${results.length} conversation${results.length > 1 ? 's' : ''} matching all concepts [${concepts.join(' + ')}]:\n\n`;

  // Process results sequentially to get file metadata
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    const date = new Date(result.exchange.timestamp).toISOString().split('T')[0];
    const avgPct = Math.round(result.averageSimilarity * 100);

    // Header with average match percentage
    output += `${index + 1}. [${result.exchange.project}, ${date}] - ${avgPct}% avg match\n`;

    // Show individual concept scores
    const scores = result.conceptSimilarities
      .map((sim, i) => `${concepts[i]}: ${Math.round(sim * 100)}%`)
      .join(', ');
    output += `   Concepts: ${scores}\n`;

    // Show snippet
    output += `   "${result.snippet}"\n`;

    // Show tool usage if available
    if (result.exchange.toolCalls && result.exchange.toolCalls.length > 0) {
      const toolCounts = new Map<string, number>();
      result.exchange.toolCalls.forEach(tc => {
        toolCounts.set(tc.toolName, (toolCounts.get(tc.toolName) || 0) + 1);
      });
      const toolSummary = Array.from(toolCounts.entries())
        .map(([name, count]) => `${name}(${count})`)
        .join(', ');
      output += `   Tools: ${toolSummary}\n`;
    }

    // Get file metadata
    const fileSizeKB = getFileSizeInKB(result.exchange.archivePath);
    const totalLines = await countLines(result.exchange.archivePath);
    const lineRange = `${result.exchange.lineStart}-${result.exchange.lineEnd}`;

    // File information with metadata (clean format for smart tool selection)
    output += `   Lines ${lineRange} in ${result.exchange.archivePath} (${fileSizeKB}KB, ${totalLines} lines)\n\n`;
  }

  return output;
}

