import Database from 'better-sqlite3';
import type { Fact, ConsolidationResult } from './types.js';
export declare function buildConsolidationPrompt(existingFact: string, newFact: string): string;
/**
 * Classify a callHaiku rejection: is it a TRANSIENT provider problem (retry
 * forever until it recovers) or a DETERMINISTIC per-fact rejection (skip after
 * MAX attempts so it can't wedge the cursor)?
 *
 * This is the ONLY way to satisfy both "an outage must never silently skip the
 * backlog" and "one un-processable fact must never wedge the cursor" — a plain
 * failure count can't tell them apart. UNKNOWN errors are treated as transient
 * (hold/retry), so an unrecognized error never silently drains the backlog.
 */
export declare function isTransientLlmError(err: unknown): boolean;
/**
 * @deprecated Back-compat wrapper for the removed per-project consolidator.
 * Prefer `consolidateAllPending`. Now scope-isolated (via consolidateOne), so
 * it can no longer leak project-private text into global facts. Kept as a
 * public export so existing importers don't crash at module load.
 */
export declare function consolidateFacts(db: Database.Database, project: string, lastConsolidatedAt: string): Promise<{
    processed: number;
    merged: number;
    contradictions: number;
    evolutions: number;
}>;
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
export declare function consolidateAllPending(db: Database.Database, since: {
    createdAt: string;
    id: string;
} | null): Promise<{
    processed: number;
    merged: number;
    contradictions: number;
    evolutions: number;
    haikuCalls: number;
    cursor: {
        createdAt: string;
        id: string;
    } | null;
}>;
export declare function applyConsolidationResult(db: Database.Database, existingFact: Fact, newFact: Fact, result: ConsolidationResult): void;
