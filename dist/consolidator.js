import { callHaiku, parseJsonResponse } from './llm.js';
import { getNewFactsSince, getAllNewFactsSince, searchSimilarFacts, updateFact, deactivateFact, insertRevision, } from './fact-db.js';
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
export function buildConsolidationPrompt(existingFact, newFact) {
    return `Existing fact: "${existingFact}"\nNew fact: "${newFact}"`;
}
export async function consolidateFacts(db, project, lastConsolidatedAt) {
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
        if (haikuCalls >= MAX_HAIKU_CALLS)
            break;
        if (!newFact.embedding)
            continue;
        // Convert Float32Array back to number[] for searchSimilarFacts
        const embeddingArray = Array.from(newFact.embedding);
        const similar = searchSimilarFacts(db, embeddingArray, project, 5, SIMILARITY_THRESHOLD);
        const candidates = similar.filter(s => s.fact.id !== newFact.id);
        if (candidates.length === 0)
            continue;
        const closest = candidates[0];
        const prompt = buildConsolidationPrompt(closest.fact.fact, newFact.fact);
        try {
            const response = await callHaiku(CONSOLIDATION_SYSTEM_PROMPT, prompt);
            haikuCalls++;
            const result = parseJsonResponse(response);
            if (!result)
                continue;
            applyConsolidationResult(db, closest.fact, newFact, result);
            switch (result.relation) {
                case 'DUPLICATE':
                    merged++;
                    break;
                case 'CONTRADICTION':
                    contradictions++;
                    break;
                case 'EVOLUTION':
                    evolutions++;
                    break;
            }
        }
        catch (error) {
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
export async function consolidateAllPending(db, since) {
    await initEmbeddings();
    const newFacts = getAllNewFactsSince(db, since);
    let haikuCalls = 0;
    let merged = 0;
    let contradictions = 0;
    let evolutions = 0;
    let processed = 0;
    // Progress cursor (created_at ASC): the timestamp up to which this run has
    // FULLY examined the backlog. Persisted by the caller so the next run starts
    // after it (`created_at > cursor`) — otherwise INDEPENDENT facts (which stay
    // active) would re-consume the whole Haiku budget on the same oldest rows
    // every run and never reach newer/project-specific backlog.
    let lastExaminedAt = null; // created_at of the last fact SAFE to advance past
    let brokeAt = null; // created_at of the first fact we must NOT advance past
    for (let i = 0; i < newFacts.length; i++) {
        const newFact = newFacts[i];
        if (haikuCalls >= MAX_HAIKU_CALLS) {
            brokeAt = newFact.created_at;
            break;
        }
        // Re-read: an earlier comparison this run may have deactivated this fact.
        const stillActive = db.prepare('SELECT 1 FROM facts WHERE id = ? AND is_active = 1').get(newFact.id);
        if (stillActive && newFact.embedding) {
            const embeddingArray = Array.from(newFact.embedding);
            // SAME-SCOPE consolidation only — a project-private fact and a global
            // fact must never merge across the boundary: an EVOLUTION would rewrite
            // the global row with project-private text (leaking it to every project),
            // and a CONTRADICTION would let one project deactivate shared global
            // memory. So a project fact is compared ONLY against its own project's
            // facts, and a global fact only against other global facts.
            const canonProject = newFact.scope_project;
            const candidates = searchSimilarFacts(db, embeddingArray, canonProject, 20, SIMILARITY_THRESHOLD)
                .filter((s) => {
                if (s.fact.id === newFact.id)
                    return false;
                if (newFact.scope_type === 'global')
                    return s.fact.scope_type === 'global';
                return s.fact.scope_type === 'project' && s.fact.scope_project === newFact.scope_project;
            })
                .slice(0, 5);
            if (candidates.length > 0) {
                const closest = candidates[0];
                const prompt = buildConsolidationPrompt(closest.fact.fact, newFact.fact);
                try {
                    const response = await callHaiku(CONSOLIDATION_SYSTEM_PROMPT, prompt);
                    haikuCalls++;
                    const result = parseJsonResponse(response);
                    if (result) {
                        applyConsolidationResult(db, closest.fact, newFact, result);
                        switch (result.relation) {
                            case 'DUPLICATE':
                                merged++;
                                break;
                            case 'CONTRADICTION':
                                contradictions++;
                                break;
                            case 'EVOLUTION':
                                evolutions++;
                                break;
                        }
                    }
                }
                catch (error) {
                    // Transient LLM failure: do NOT advance the cursor past this fact, or
                    // the comparison is lost forever (created_at > cursor skips it). Stop
                    // the run here (like the budget wall); the next run retries from here.
                    console.error(`Consolidation failed for fact ${newFact.id}:`, error);
                    brokeAt = newFact.created_at;
                    break;
                }
            }
        }
        // Note: a fact with NO embedding cannot be a consolidation driver (no
        // similarity search). Advancing past it is intentional — if its embedding
        // is backfilled later, a newer similar fact still picks it up as a
        // candidate. Only unexamined/errored facts hold the cursor back.
        processed++;
        lastExaminedAt = newFact.created_at;
    }
    // Safe cursor: advance ONLY to a timestamp strictly less than the first
    // unexamined fact's created_at. Same-millisecond facts straddling the budget
    // wall must not be skipped (`created_at > cursor` is strict), so if the last
    // examined fact shares the breaking fact's timestamp, don't advance into that
    // shared timestamp — keep the run's starting `since`.
    let cursor = since;
    if (brokeAt === null) {
        // Finished the whole backlog → advance to the newest examined row (or keep since if none).
        cursor = lastExaminedAt ?? since;
    }
    else if (lastExaminedAt !== null && lastExaminedAt < brokeAt) {
        cursor = lastExaminedAt;
    } // else: last examined shares brokeAt's timestamp → stay at `since` (re-examine next run)
    return { processed, merged, contradictions, evolutions, haikuCalls, cursor };
}
export function applyConsolidationResult(db, existingFact, newFact, result) {
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
