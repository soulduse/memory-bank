import Database from 'better-sqlite3';
import type { Fact, ConsolidationResult } from './types.js';
import { callHaiku, parseJsonResponse } from './llm.js';
import {
  getNewFactsSince,
  getAllNewFactsSince,
  searchSimilarFactsSameScope,
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
// A driver fact whose comparison CALL keeps throwing (deterministic provider
// rejection — e.g. oversized text) is quarantined after this many run-level
// failures so it can't wedge the cursor and starve the rest of the backlog.
const MAX_CONSOLIDATION_ATTEMPTS = 3;
// e5 passage-passage scale (measured): near-dup 0.99, paraphrase 0.97,
// related-but-distinct ~0.91, unrelated <=0.86. 0.95 selects dup candidates.
const SIMILARITY_THRESHOLD = 0.95;

export function buildConsolidationPrompt(existingFact: string, newFact: string): string {
  return `Existing fact: "${existingFact}"\nNew fact: "${newFact}"`;
}

/**
 * Consolidate ONE driver fact against a same-scope neighbour (if any).
 * Shared by consolidateAllPending and the back-compat consolidateFacts wrapper.
 *
 * `called` reports whether an LLM call was actually made — the caller MUST use
 * this (not the verdict) for budget accounting, because a call that returns
 * malformed/unparseable text still consumed the budget even though its verdict
 * is 'none'. Throws only on a transient LLM failure the caller should retry.
 */
async function consolidateOne(
  db: Database.Database,
  newFact: Fact,
): Promise<{ called: boolean; verdict: 'DUPLICATE' | 'CONTRADICTION' | 'EVOLUTION' | 'INDEPENDENT' | 'none' }> {
  if (!newFact.embedding) return { called: false, verdict: 'none' };
  const embeddingArray = Array.from(newFact.embedding);
  // SAME-SCOPE only (no cross-scope leak): project fact → its own project,
  // global fact → global. The scope gate is inside the search, before its
  // limit, so an in-scope match isn't starved by closer out-of-scope rows.
  const scope = newFact.scope_type === 'global'
    ? ({ type: 'global' } as const)
    : newFact.scope_project
      ? ({ type: 'project', project: newFact.scope_project } as const)
      : null;
  if (!scope) return { called: false, verdict: 'none' };
  const candidates = searchSimilarFactsSameScope(db, embeddingArray, scope, 5, SIMILARITY_THRESHOLD)
    .filter((s) => s.fact.id !== newFact.id);
  if (candidates.length === 0) return { called: false, verdict: 'none' };

  const closest = candidates[0];
  const response = await callHaiku(CONSOLIDATION_SYSTEM_PROMPT, buildConsolidationPrompt(closest.fact.fact, newFact.fact));
  const result = parseJsonResponse<ConsolidationResult>(response);
  // Unparseable output = the call happened (budget spent) but produced no usable
  // verdict. Treated as a no-op ('none'), NOT an error: consolidation is a
  // best-effort background dedup, so we advance past this comparison rather than
  // hold the cursor. The pair is not lost — both facts stay active, and the
  // comparison re-triggers whenever either is a driver/candidate for a future
  // fact. This also means no single fact (a transiently non-JSON response, or a
  // deliberately "poison" candidate) can hold the cursor and starve the backlog.
  if (!result) return { called: true, verdict: 'none' };
  applyConsolidationResult(db, closest.fact, newFact, result);
  return { called: true, verdict: result.relation };
}

/**
 * @deprecated Back-compat wrapper for the removed per-project consolidator.
 * Prefer `consolidateAllPending`. Now scope-isolated (via consolidateOne), so
 * it can no longer leak project-private text into global facts. Kept as a
 * public export so existing importers don't crash at module load.
 */
export async function consolidateFacts(
  db: Database.Database,
  project: string,
  lastConsolidatedAt: string,
): Promise<{ processed: number; merged: number; contradictions: number; evolutions: number }> {
  await initEmbeddings();
  const newFacts = getNewFactsSince(db, project, lastConsolidatedAt);
  let haikuCalls = 0, merged = 0, contradictions = 0, evolutions = 0;
  for (const newFact of newFacts) {
    if (haikuCalls >= MAX_HAIKU_CALLS) break;
    const stillActive = db.prepare('SELECT 1 FROM facts WHERE id = ? AND is_active = 1').get(newFact.id);
    if (!stillActive) continue;
    try {
      const { called, verdict } = await consolidateOne(db, newFact);
      if (called) haikuCalls++; // count the CALL, not the verdict (malformed output still spent budget)
      if (verdict === 'DUPLICATE') merged++;
      else if (verdict === 'CONTRADICTION') contradictions++;
      else if (verdict === 'EVOLUTION') evolutions++;
    } catch (error) {
      // A throw means callHaiku was reached and failed — that attempt still
      // counts against the budget, otherwise a persistently-failing LLM would
      // let this loop attempt a call for every one of N similar facts.
      haikuCalls++;
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
  since: { createdAt: string; id: string } | null,
): Promise<{ processed: number; merged: number; contradictions: number; evolutions: number; haikuCalls: number; cursor: { createdAt: string; id: string } | null }> {
  await initEmbeddings();

  const newFacts = getAllNewFactsSince(db, since);
  let haikuCalls = 0;
  let merged = 0;
  let contradictions = 0;
  let evolutions = 0;
  let processed = 0;
  // KEYSET progress cursor `(created_at, id)`: the last fact FULLY examined this
  // run. Persisted by the caller so the next run resumes strictly after it.
  // Because (created_at, id) is unique, we can always advance to the last
  // examined fact without risking a skip — even when a whole timestamp group is
  // larger than the per-run budget (the pre-keyset created_at-only cursor
  // stalled forever in that case and starved the rest of the backlog).
  let cursor = since;

  for (let i = 0; i < newFacts.length; i++) {
    const newFact = newFacts[i];
    if (haikuCalls >= MAX_HAIKU_CALLS) break; // budget wall — cursor stays at the last examined fact

    // Re-read: an earlier comparison this run may have deactivated this fact.
    const stillActive = db.prepare('SELECT 1 FROM facts WHERE id = ? AND is_active = 1').get(newFact.id);
    if (stillActive) {
      try {
        // Same-scope isolation + budget accounting via the shared helper.
        const { called, verdict } = await consolidateOne(db, newFact);
        if (called) haikuCalls++; // count the CALL, not the verdict
        if (verdict === 'DUPLICATE') merged++;
        else if (verdict === 'CONTRADICTION') contradictions++;
        else if (verdict === 'EVOLUTION') evolutions++;
      } catch (error) {
        // A throw is a CALL failure (callHaiku rejected). Usually transient
        // (infra down) → hold the cursor and retry next run. But a DETERMINISTIC
        // rejection (oversized text, content the provider always 400s) would
        // wedge the cursor forever, so ledger the failure and quarantine the
        // fact after MAX attempts (advance past it). During a real outage every
        // fact fails, so nothing is prematurely quarantined before recovery
        // unless the SAME fact fails across MAX separate runs.
        haikuCalls++;
        console.error(`Consolidation call failed for fact ${newFact.id}:`, error);
        const attempts = (db.prepare(
          'UPDATE facts SET consolidation_attempts = COALESCE(consolidation_attempts, 0) + 1 WHERE id = ? RETURNING consolidation_attempts'
        ).get(newFact.id) as { consolidation_attempts: number } | undefined)?.consolidation_attempts ?? 0;
        if (attempts >= MAX_CONSOLIDATION_ATTEMPTS) {
          console.error(`Consolidation quarantine fact ${newFact.id} after ${attempts} call failures — skipping`);
          processed++;
          cursor = { createdAt: newFact.created_at, id: newFact.id }; // advance past the wedge
          continue;
        }
        break; // hold the cursor — retry this fact next run
      }
    }
    // Fully examined (including a no-op / no-candidate / no-embedding fact — none
    // of which need reprocessing as a driver): advance the keyset cursor past it.
    processed++;
    cursor = { createdAt: newFact.created_at, id: newFact.id };
  }

  return { processed, merged, contradictions, evolutions, haikuCalls, cursor };
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
