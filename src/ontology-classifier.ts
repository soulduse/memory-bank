import Database from 'better-sqlite3';
import type { Fact, RelationType } from './types.js';
import { callHaiku, parseJsonResponse } from './llm.js';
import { generateEmbedding } from './embeddings.js';
import { searchSimilarFacts } from './fact-db.js';
import {
  listDomains,
  listCategories,
  getDomainByName,
  getCategoryByName,
  createDomain,
  createCategory,
  classifyFact,
  createRelation,
  searchSimilarCategories,
  upsertCategoryEmbedding,
} from './ontology-db.js';

// Number of nearest existing categories to present to the classifier LLM as
// reuse candidates. Replaces dumping ALL categories (measured 1,612 ≈ 95K
// tokens) with an embedding top-K (≈ a few hundred tokens). The full domain
// list (small) is always included so the LLM can still place a genuinely new
// topic under the right domain.
const CATEGORY_CANDIDATES = 20;

// Candidates per fact in BATCH classification prompts — smaller than the
// single-fact list so a 20-fact batch stays a few KB instead of 20×20 lines.
const BATCH_CATEGORY_CANDIDATES = 8;

// Max classification attempts before a fact is permanently parked in the
// General/Misc fallback. Without this cap, a fact that deterministically
// fails (unparseable output, degenerate content) is re-selected by every
// backfill run forever — one wasted LLM call per run per stuck fact.
export const MAX_CLASSIFY_ATTEMPTS = 3;

// Deterministic reuse gate: when the nearest existing category is at least
// this cosine-similar to the fact embedding, assign it WITHOUT an LLM call.
//
// DISABLED BY DEFAULT — live measurement rejected it (scripts/measure-det-gate.mjs,
// 2026-07-05, n=800): top-1-category agreement with the actual LLM assignment
// was only 72% at sim≥0.93 (2.3% of facts) and 89% at ≥0.94 (n=9, 1.1%).
// Too little volume to matter and too much misfile risk to auto-assign.
// Batching delivers the spawn reduction instead. Set
// MEMORY_BANK_ONTOLOGY_DET_GATE to a value in (0,1) to opt in after
// re-measuring (e.g. once the taxonomy is consolidated).
function detGate(): number {
  const raw = process.env.MEMORY_BANK_ONTOLOGY_DET_GATE;
  const v = raw ? Number(raw) : NaN;
  return Number.isFinite(v) && v > 0 && v < 1 ? v : Number.POSITIVE_INFINITY;
}

/** vec0 L2 distance on normalized embeddings → cosine similarity. */
function l2ToCosine(distance: number): number {
  return 1 - (distance * distance) / 2;
}

interface ClassifyResponse {
  domain: string;
  category: string;
  is_new_domain: boolean;
  is_new_category: boolean;
  domain_description?: string;
  category_description?: string;
}

interface DetectRelationResponse {
  has_relation: boolean;
  relation_type: RelationType | null;
  reasoning: string;
}

const CLASSIFY_SYSTEM_PROMPT = `You are an ontology classifier for technical decision facts.
Given a fact and a list of existing domains/categories, classify the fact.

## Domains represent broad areas (e.g., "Architecture", "Frontend", "Backend", "DevOps", "Testing", "Database")
## Categories are specific topics within a domain (e.g., "State Management", "API Design", "Authentication")

## Rules
- Reuse existing domains/categories when appropriate (prefer reuse over creation)
- Create new domain/category only when no existing one fits
- domain and category names must be in English, concise (1-3 words)

## Output format (JSON only, no markdown)
{
  "domain": "existing or new domain name",
  "category": "existing or new category name",
  "is_new_domain": false,
  "is_new_category": false,
  "domain_description": "only if is_new_domain is true",
  "category_description": "only if is_new_category is true"
}`;

const BATCH_CLASSIFY_SYSTEM_PROMPT = `You are an ontology classifier for technical decision facts.
You will receive SEVERAL facts. Classify EACH fact independently against the shared domain list and that fact's own candidate categories.

## Domains represent broad areas (e.g., "Architecture", "Frontend", "Backend", "DevOps", "Testing", "Database")
## Categories are specific topics within a domain (e.g., "State Management", "API Design", "Authentication")

## Rules
- Reuse existing domains/categories when appropriate (prefer reuse over creation)
- Create new domain/category only when no existing one fits
- domain and category names must be in English, concise (1-3 words)
- Return EXACTLY one result object per fact, copying that fact's "index" verbatim
- Do not skip any fact

## Output format (JSON array only, no markdown)
[
  {
    "index": 0,
    "domain": "existing or new domain name",
    "category": "existing or new category name",
    "is_new_domain": false,
    "is_new_category": false,
    "domain_description": "only if is_new_domain is true",
    "category_description": "only if is_new_category is true"
  }
]`;

const DETECT_RELATION_SYSTEM_PROMPT = `You are analyzing relationships between technical decision facts.
Given a new fact and an existing fact, determine if there is a meaningful relationship.

## Relation types
- INFLUENCES: new fact affects or shapes the existing fact's domain
- SUPERSEDES: new fact replaces or overrides the existing fact
- SUPPORTS: new fact provides evidence or reinforcement for the existing fact
- CONTRADICTS: new fact conflicts with the existing fact

## Rules
- Only report a relation if it is clear and meaningful
- If no meaningful relation exists, set has_relation to false

## Output format (JSON only, no markdown)
{
  "has_relation": true,
  "relation_type": "INFLUENCES|SUPERSEDES|SUPPORTS|CONTRADICTS",
  "reasoning": "one-line explanation"
}`;

/** Embed "name: description" in passage mode so the candidate index matches facts. */
function categoryEmbeddingText(name: string, description?: string | null): string {
  return description ? `${name}: ${description}` : name;
}

/** Top-K category hits for a fact embedding (empty when no embedding/index). */
function categoryHits(
  db: Database.Database,
  fact: Fact,
  k: number,
): Array<{ category: { id: string; domain_id: string; name: string; description: string | null }; domainName: string; distance: number }> {
  if (!fact.embedding) return [];
  return searchSimilarCategories(db, Array.from(fact.embedding), k);
}

/**
 * Deterministic reuse gate: if the nearest existing category clears the
 * measured similarity threshold, persist it directly — no LLM call. Returns
 * the assignment or null when the gate doesn't fire.
 */
function tryDeterministicAssign(
  db: Database.Database,
  fact: Fact,
  hits: ReturnType<typeof categoryHits>,
): { domainId: string; categoryId: string } | null {
  const top = hits[0];
  if (!top) return null;
  if (l2ToCosine(top.distance) < detGate()) return null;
  classifyFact(db, fact.id, top.category.id);
  return { domainId: top.category.domain_id, categoryId: top.category.id };
}

/**
 * Resolve a parsed LLM classification into (domain, category) rows — creating
 * and embedding-indexing new ones — and persist the fact's assignment.
 * Shared by the single and batch classification paths.
 */
async function applyClassification(
  db: Database.Database,
  factId: string,
  parsed: ClassifyResponse,
): Promise<{ domainId: string; categoryId: string }> {
  // Resolve or create domain
  let domain = getDomainByName(db, parsed.domain);
  if (!domain) {
    domain = createDomain(db, parsed.domain, parsed.domain_description);
  }

  // Resolve or create category
  let category = getCategoryByName(db, parsed.category, domain.id);
  if (!category) {
    category = createCategory(db, domain.id, parsed.category, parsed.category_description);
    // Index the new category so future facts can retrieve it as a candidate
    // (without this the candidate list could never grow → category sprawl).
    try {
      const emb = await generateEmbedding(categoryEmbeddingText(category.name, category.description), 'passage');
      upsertCategoryEmbedding(db, category.id, emb);
    } catch (error) {
      console.error(`Category embedding failed for ${category.id}:`, error);
    }
  }

  classifyFact(db, factId, category.id);
  return { domainId: domain.id, categoryId: category.id };
}

/**
 * Record one failed classification attempt; returns the new attempt count.
 * When the count reaches MAX_CLASSIFY_ATTEMPTS the caller should persist the
 * fallback so the fact permanently leaves the backfill queue.
 */
export function recordOntologyAttempt(db: Database.Database, factId: string): number {
  db.prepare(
    `UPDATE facts SET ontology_attempts = COALESCE(ontology_attempts, 0) + 1, ontology_last_attempt_at = ? WHERE id = ?`,
  ).run(new Date().toISOString(), factId);
  const row = db.prepare(`SELECT COALESCE(ontology_attempts, 0) AS n FROM facts WHERE id = ?`).get(factId) as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

/**
 * Park a fact in General/Misc. Unlike the pre-2026-07 behaviour (which built
 * the fallback rows but never wrote the fact's ontology_category_id — leaving
 * it NULL and eternally re-selected), this PERSISTS the assignment. The fact
 * stays fully searchable via vector/FTS; ontology is an overlay.
 */
export function persistFallbackClassification(db: Database.Database, factId: string): { domainId: string; categoryId: string } {
  const fallback = ensureFallbackCategory(db);
  classifyFact(db, factId, fallback.categoryId);
  return fallback;
}

export async function classifyFactToOntology(
  db: Database.Database,
  fact: Fact,
): Promise<{ domainId: string; categoryId: string }> {
  // Candidate retrieval: present only the top-K nearest existing categories
  // (by fact embedding) instead of all categories. Falls back to the full list
  // when there is no fact embedding or the category index is still empty
  // (e.g. before the one-time backfill), so behaviour degrades gracefully.
  const hits = categoryHits(db, fact, CATEGORY_CANDIDATES);

  // Deterministic reuse gate — obvious matches never reach the LLM.
  const deterministic = tryDeterministicAssign(db, fact, hits);
  if (deterministic) return deterministic;

  const domains = listDomains(db);
  const domainList = domains.map((d) => `- ${d.name}: ${d.description ?? '(no description)'}`).join('\n');

  let candidates: Array<{ name: string; domainName: string; description?: string | null }> = hits.map((h) => ({
    name: h.category.name,
    domainName: h.domainName,
    description: h.category.description,
  }));
  if (candidates.length === 0) {
    const all = listCategories(db);
    candidates = all.map((c) => ({
      name: c.name,
      domainName: domains.find((d) => d.id === c.domain_id)?.name ?? '?',
      description: c.description,
    }));
  }

  const categoryList = candidates
    .map((c) => `- ${c.domainName} / ${c.name}: ${c.description ?? '(no description)'}`)
    .join('\n');

  const prompt = [
    `Fact: "${fact.fact}"`,
    `Fact category: ${fact.category}`,
    '',
    'Existing domains:',
    domainList || '(none)',
    '',
    'Candidate categories (most similar existing — reuse one of these if it fits):',
    categoryList || '(none)',
  ].join('\n');

  const response = await callHaiku(CLASSIFY_SYSTEM_PROMPT, prompt, 512);
  const parsed = parseJsonResponse<ClassifyResponse>(response);

  if (!parsed) {
    // Unparseable output is a FAILED attempt, not a fallback: silently
    // parking on first failure would misfile transient noise, and the old
    // behaviour (returning fallback ids WITHOUT persisting) left the fact
    // NULL forever. Callers count the attempt via recordOntologyAttempt and
    // persist the fallback only at MAX_CLASSIFY_ATTEMPTS.
    throw new Error('ontology classify: unparseable LLM response');
  }

  return applyClassification(db, fact.id, parsed);
}

interface BatchClassifyItem extends ClassifyResponse {
  index: number;
}

/**
 * Classify a batch of facts with ONE LLM call (plus zero-cost deterministic
 * assignments). Each callHaiku() spawns a full headless Claude session
 * (~10-14s + a transcript + auxiliary calls), so per-fact single calls made
 * the backfill drain both slow and noisy on the proxy; batching divides the
 * spawn count by the batch size.
 *
 * Returns fact-id lists per outcome. `failed` facts have NOT had their
 * attempt recorded — that's the caller's job (backfillClassifyBatch), so the
 * ledger stays in one place.
 */
export async function classifyFactsBatch(
  db: Database.Database,
  facts: Fact[],
): Promise<{ classified: string[]; deterministic: string[]; failed: string[] }> {
  const deterministic: string[] = [];
  const remaining: Fact[] = [];
  const hitsByFact = new Map<string, ReturnType<typeof categoryHits>>();

  for (const fact of facts) {
    const hits = categoryHits(db, fact, BATCH_CATEGORY_CANDIDATES);
    if (tryDeterministicAssign(db, fact, hits)) {
      deterministic.push(fact.id);
      continue;
    }
    hitsByFact.set(fact.id, hits);
    remaining.push(fact);
  }

  if (remaining.length === 0) {
    return { classified: [], deterministic, failed: [] };
  }

  const domains = listDomains(db);
  const domainList = domains.map((d) => `- ${d.name}: ${d.description ?? '(no description)'}`).join('\n');

  const sections = remaining.map((fact, i) => {
    const hits = hitsByFact.get(fact.id) ?? [];
    const candidateList = hits
      .map((h) => `- ${h.domainName} / ${h.category.name}: ${h.category.description ?? '(no description)'}`)
      .join('\n');
    return [
      `### Fact ${i}`,
      // Bound each fact's contribution so a 20-fact batch stays a few KB.
      `Fact: "${fact.fact.length > 400 ? `${fact.fact.slice(0, 400)}…` : fact.fact}"`,
      `Fact category: ${fact.category}`,
      'Candidate categories (most similar existing — reuse one of these if it fits):',
      candidateList || '(none)',
    ].join('\n');
  });

  const prompt = ['Existing domains:', domainList || '(none)', '', ...sections].join('\n\n');
  const response = await callHaiku(BATCH_CLASSIFY_SYSTEM_PROMPT, prompt, 256 * remaining.length + 512);
  const parsed = parseJsonResponse<BatchClassifyItem[]>(response);

  // Index the response items; tolerate partial/malformed arrays — every fact
  // without a usable item is reported as failed (attempt counting is the
  // caller's responsibility, and honest failure counts matter: the previous
  // pipeline swallowed errors and logged "failed 0" regardless).
  const byIndex = new Map<number, BatchClassifyItem>();
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (
        item &&
        typeof item.index === 'number' &&
        typeof item.domain === 'string' &&
        item.domain.trim() !== '' &&
        typeof item.category === 'string' &&
        item.category.trim() !== ''
      ) {
        byIndex.set(item.index, item);
      }
    }
  }

  const classified: string[] = [];
  const failed: string[] = [];
  for (let i = 0; i < remaining.length; i++) {
    const fact = remaining[i];
    const item = byIndex.get(i);
    if (!item) {
      failed.push(fact.id);
      continue;
    }
    try {
      await applyClassification(db, fact.id, item);
      classified.push(fact.id);
    } catch (error) {
      console.error(`Batch classification apply failed for fact ${fact.id}:`, error);
      failed.push(fact.id);
    }
  }

  return { classified, deterministic, failed };
}

/**
 * Backfill-facing wrapper: load facts by id, classify them as one batch,
 * record attempts for failures, and park facts that exhausted their attempts
 * in General/Misc. Relations are OFF by default for backfill (each relation
 * probe costs another LLM call; the historic corpus already has ~29K
 * relations — new-fact inserts keep detecting them).
 */
export async function backfillClassifyBatch(
  db: Database.Database,
  factIds: string[],
  opts: { detectRelationsToo?: boolean } = {},
): Promise<{ classified: number; deterministic: number; fallback: number; failed: number }> {
  const rows = factIds
    .map((id) => db.prepare(`SELECT * FROM facts WHERE id = ? AND is_active = 1 AND ontology_category_id IS NULL`).get(id))
    .filter((r): r is Record<string, unknown> => Boolean(r));
  const facts = rows.map((r) => rowToFact(r));

  const result = facts.length > 0
    ? await classifyFactsBatch(db, facts)
    : { classified: [] as string[], deterministic: [] as string[], failed: [] as string[] };

  let fallback = 0;
  for (const id of result.failed) {
    const attempts = recordOntologyAttempt(db, id);
    if (attempts >= MAX_CLASSIFY_ATTEMPTS) {
      persistFallbackClassification(db, id);
      fallback++;
    }
  }

  if (opts.detectRelationsToo) {
    const succeeded = new Set([...result.classified, ...result.deterministic]);
    for (const fact of facts) {
      if (!succeeded.has(fact.id)) continue;
      try {
        await detectRelations(db, fact);
      } catch (error) {
        console.error(`Relation detection failed for fact ${fact.id}:`, error);
      }
    }
  }

  return {
    classified: result.classified.length,
    deterministic: result.deterministic.length,
    fallback,
    failed: result.failed.length - fallback,
  };
}

export async function detectRelations(
  db: Database.Database,
  newFact: Fact,
  // 2 (was 5): each candidate costs one Haiku call, so per-fact ontology cost
  // was classify ×1 + relations ×0..5 = up to 6 calls. Capping candidates at 2
  // drops that to up to 3 while still linking the strongest neighbours (the
  // 0.89 similarity floor already rejects weak pairs, so candidates 3-5 were
  // almost always borderline).
  topK: number = 2,
): Promise<void> {
  if (!newFact.embedding) return;

  const embeddingArray = Array.from(newFact.embedding);
  // e5 scale: related-but-distinct ~0.91, unrelated <=0.86 → 0.89 selects relation candidates
  const similar = searchSimilarFacts(db, embeddingArray, newFact.scope_project, topK, 0.89);
  const candidates = similar.filter((s) => s.fact.id !== newFact.id);

  for (const { fact: existingFact } of candidates) {
    const prompt = [
      `New fact: "${newFact.fact}"`,
      `Existing fact: "${existingFact.fact}"`,
      `New fact category: ${newFact.category}`,
      `Existing fact category: ${existingFact.category}`,
    ].join('\n');

    try {
      const response = await callHaiku(DETECT_RELATION_SYSTEM_PROMPT, prompt, 256);
      const result = parseJsonResponse<DetectRelationResponse>(response);

      if (result && result.has_relation && result.relation_type) {
        createRelation(db, newFact.id, result.relation_type, existingFact.id, result.reasoning);
      }
    } catch (error) {
      // Non-fatal: relation detection failure should not block fact saving
      console.error(`Relation detection failed for facts ${newFact.id} / ${existingFact.id}:`, error);
    }
  }
}

export async function classifyAndLinkFact(
  db: Database.Database,
  factId: string,
  embedding?: number[],
): Promise<void> {
  const row = db.prepare(`SELECT * FROM facts WHERE id = ? AND is_active = 1`).get(factId);
  if (!row) return;

  const fact = rowToFact(row as Record<string, unknown>);

  // Re-attach embedding if provided (in case the row doesn't have it yet)
  if (embedding && !fact.embedding) {
    fact.embedding = new Float32Array(embedding);
  }

  try {
    await classifyFactToOntology(db, fact);
  } catch (error) {
    console.error(`Ontology classification failed for fact ${factId}:`, error);
    // Non-fatal for the insert path, but every failure is LEDGERED so the
    // backfill can't re-burn LLM calls on a permanently failing fact; after
    // MAX attempts it is parked in General/Misc (still fully searchable).
    try {
      const attempts = recordOntologyAttempt(db, factId);
      if (attempts >= MAX_CLASSIFY_ATTEMPTS) {
        persistFallbackClassification(db, factId);
      }
    } catch (ledgerError) {
      console.error(`Ontology attempt ledger failed for fact ${factId}:`, ledgerError);
    }
  }

  try {
    await detectRelations(db, fact);
  } catch (error) {
    console.error(`Relation detection failed for fact ${factId}:`, error);
  }
}

function ensureFallbackCategory(db: Database.Database): { domainId: string; categoryId: string } {
  let domain = getDomainByName(db, 'General');
  if (!domain) {
    domain = createDomain(db, 'General', 'General purpose facts');
  }
  let category = getCategoryByName(db, 'Misc', domain.id);
  if (!category) {
    category = createCategory(db, domain.id, 'Misc', 'Miscellaneous facts');
  }
  return { domainId: domain.id, categoryId: category.id };
}

function rowToFact(row: Record<string, unknown>): Fact {
  const embeddingRaw = row['embedding'];
  let embedding: Float32Array | null = null;
  if (embeddingRaw instanceof Buffer) {
    embedding = new Float32Array(
      embeddingRaw.buffer,
      embeddingRaw.byteOffset,
      embeddingRaw.byteLength / 4,
    );
  } else if (embeddingRaw instanceof Uint8Array) {
    embedding = new Float32Array(
      embeddingRaw.buffer,
      embeddingRaw.byteOffset,
      embeddingRaw.byteLength / 4,
    );
  }

  return {
    id: row['id'] as string,
    fact: row['fact'] as string,
    category: row['category'] as Fact['category'],
    scope_type: row['scope_type'] as Fact['scope_type'],
    scope_project: (row['scope_project'] as string | null) ?? null,
    source_exchange_ids: row['source_exchange_ids']
      ? JSON.parse(row['source_exchange_ids'] as string)
      : [],
    embedding,
    created_at: row['created_at'] as string,
    updated_at: row['updated_at'] as string,
    consolidated_count: row['consolidated_count'] as number,
    is_active: Boolean(row['is_active']),
  };
}

export { generateEmbedding };
