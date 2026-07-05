import Database from 'better-sqlite3';
import type { Fact, ConsolidationResult } from './types.js';
import { callHaiku, parseJsonResponse } from './llm.js';
import {
  getNewFactsSince,
  getAllNewFactsSince,
  searchSimilarFacts,
  updateFact,
  deactivateFact,
  insertRevision,
} from './fact-db.js';
import { initEmbeddings } from './embeddings.js';

const CONSOLIDATION_SYSTEM_PROMPT = `Compare two facts and determine their relationship.

## Relationship types (choose one)
- DUPLICATE: same content - merge
- CONTRADICTION: conflicting - new fact replaces old
- EVOLUTION: old fact evolved - update
- INDEPENDENT: separate - keep both

## Output format
{
  "relation": "DUPLICATE|CONTRADICTION|EVOLUTION|INDEPENDENT",
  "merged_fact": "final sentence for merge/replace",
  "reason": "one-line justification"
}`;

const MAX_HAIKU_CALLS = 10;
// e5 passage-passage scale (measured): near-dup 0.99, paraphrase 0.97,
// related-but-distinct ~0.91, unrelated <=0.86. 0.95 selects dup candidates.
const SIMILARITY_THRESHOLD = 0.95;

export function buildConsolidationPrompt(existingFact: string, newFact: string): string {
  return `Existing fact: "${existingFact}"\nNew fact: "${newFact}"`;
}

export async function consolidateFacts(
  db: Database.Database,
  project: string,
  lastConsolidatedAt: string,
): Promise<{ processed: number; merged: number; contradictions: number; evolutions: number }> {
  await initEmbeddings();

  const newFacts = getNewFactsSince(db, project, lastConsolidatedAt);
  if (newFacts.length === 0) {
    return { processed: 0, merged: 0, contradictions: 0, evolutions: 0 };
  }

  let haikuCalls = 0;
  let merged = 0;
  let contradictions = 0;
  let evolutions = 0;

  for (const newFact of newFacts) {
    if (haikuCalls >= MAX_HAIKU_CALLS) break;
    if (!newFact.embedding) continue;

    // Convert Float32Array back to number[] for searchSimilarFacts
    const embeddingArray = Array.from(newFact.embedding);
    const similar = searchSimilarFacts(db, embeddingArray, project, 5, SIMILARITY_THRESHOLD);
    const candidates = similar.filter(s => s.fact.id !== newFact.id);
    if (candidates.length === 0) continue;

    const closest = candidates[0];
    const prompt = buildConsolidationPrompt(closest.fact.fact, newFact.fact);

    try {
      const response = await callHaiku(CONSOLIDATION_SYSTEM_PROMPT, prompt);
      haikuCalls++;

      const result = parseJsonResponse<ConsolidationResult>(response);
      if (!result) continue;

      applyConsolidationResult(db, closest.fact, newFact, result);

      switch (result.relation) {
        case 'DUPLICATE': merged++; break;
        case 'CONTRADICTION': contradictions++; break;
        case 'EVOLUTION': evolutions++; break;
      }
    } catch (error) {
      console.error(`Consolidation failed for fact ${newFact.id}:`, error);
    }
  }

  return { processed: newFacts.length, merged, contradictions, evolutions };
}

/**
 * Consolidate the ENTIRE backlog in one pass: every new fact (any scope, any
 * project) processed exactly once, under a single shared Haiku budget. The
 * consolidate worker calls this once while holding the global lock, instead of
 * looping consolidateFacts per project — which reprocessed shared global facts
 * once per project (up to `MAX_HAIKU_CALLS × projectCount` calls) and, for
 * INDEPENDENT/CONTRADICTION verdicts (new fact stays active), kept re-comparing
 * the same global fact every pass.
 *
 * Each fact is compared within its own scope: a project fact against its
 * project + global (via its scope_project), a global fact against the whole
 * store (scope_project is null → no scope filter). Because a fact merged away
 * by an earlier comparison is deactivated, it neither reappears in this list
 * nor as a later candidate.
 */
export async function consolidateAllPending(
  db: Database.Database,
  since: string,
): Promise<{ processed: number; merged: number; contradictions: number; evolutions: number; haikuCalls: number }> {
  await initEmbeddings();

  const newFacts = getAllNewFactsSince(db, since);
  let haikuCalls = 0;
  let merged = 0;
  let contradictions = 0;
  let evolutions = 0;

  for (const newFact of newFacts) {
    if (haikuCalls >= MAX_HAIKU_CALLS) break; // single budget across all scopes
    if (!newFact.embedding) continue;

    // Re-read: an earlier comparison this run may have deactivated this fact.
    const stillActive = db.prepare('SELECT 1 FROM facts WHERE id = ? AND is_active = 1').get(newFact.id);
    if (!stillActive) continue;

    const embeddingArray = Array.from(newFact.embedding);
    // scope_project null (global fact) → searchSimilarFacts applies no scope
    // filter; a project fact → its project + global.
    const similar = searchSimilarFacts(db, embeddingArray, newFact.scope_project, 5, SIMILARITY_THRESHOLD);
    const candidates = similar.filter((s) => s.fact.id !== newFact.id);
    if (candidates.length === 0) continue;

    const closest = candidates[0];
    const prompt = buildConsolidationPrompt(closest.fact.fact, newFact.fact);

    try {
      const response = await callHaiku(CONSOLIDATION_SYSTEM_PROMPT, prompt);
      haikuCalls++;

      const result = parseJsonResponse<ConsolidationResult>(response);
      if (!result) continue;

      applyConsolidationResult(db, closest.fact, newFact, result);

      switch (result.relation) {
        case 'DUPLICATE': merged++; break;
        case 'CONTRADICTION': contradictions++; break;
        case 'EVOLUTION': evolutions++; break;
      }
    } catch (error) {
      console.error(`Consolidation failed for fact ${newFact.id}:`, error);
    }
  }

  return { processed: newFacts.length, merged, contradictions, evolutions, haikuCalls };
}

export function applyConsolidationResult(
  db: Database.Database,
  existingFact: Fact,
  newFact: Fact,
  result: ConsolidationResult,
): void {
  // Normalize merged_fact: treat empty/whitespace-only as absent
  const mergedFact = result.merged_fact?.trim() || null;

  switch (result.relation) {
    case 'DUPLICATE':
      updateFact(db, existingFact.id, { consolidated_count_increment: true });
      deactivateFact(db, newFact.id);
      break;

    case 'CONTRADICTION':
      deactivateFact(db, existingFact.id);
      insertRevision(db, {
        fact_id: existingFact.id,
        previous_fact: existingFact.fact,
        new_fact: mergedFact || newFact.fact,
        reason: result.reason,
        source_exchange_id: null,
      });
      if (mergedFact) {
        updateFact(db, newFact.id, { fact: mergedFact });
      }
      break;

    case 'EVOLUTION':
      insertRevision(db, {
        fact_id: existingFact.id,
        previous_fact: existingFact.fact,
        new_fact: mergedFact || newFact.fact,
        reason: result.reason,
        source_exchange_id: null,
      });
      updateFact(db, existingFact.id, {
        fact: mergedFact || newFact.fact,
        consolidated_count_increment: true,
      });
      deactivateFact(db, newFact.id);
      break;

    case 'INDEPENDENT':
      // Keep both, do nothing
      break;
  }
}
