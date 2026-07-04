import Database from 'better-sqlite3';
import type { Fact } from './types.js';
import { generateEmbedding } from './embeddings.js';
export declare const MAX_CLASSIFY_ATTEMPTS = 3;
/**
 * Record one failed classification attempt; returns the new attempt count.
 * When the count reaches MAX_CLASSIFY_ATTEMPTS the caller should persist the
 * fallback so the fact permanently leaves the backfill queue.
 */
export declare function recordOntologyAttempt(db: Database.Database, factId: string): number;
/**
 * Park a fact in General/Misc. Unlike the pre-2026-07 behaviour (which built
 * the fallback rows but never wrote the fact's ontology_category_id — leaving
 * it NULL and eternally re-selected), this PERSISTS the assignment. The fact
 * stays fully searchable via vector/FTS; ontology is an overlay.
 */
export declare function persistFallbackClassification(db: Database.Database, factId: string): {
    domainId: string;
    categoryId: string;
};
export declare function classifyFactToOntology(db: Database.Database, fact: Fact): Promise<{
    domainId: string;
    categoryId: string;
}>;
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
export declare function classifyFactsBatch(db: Database.Database, facts: Fact[]): Promise<{
    classified: string[];
    deterministic: string[];
    failed: string[];
}>;
/**
 * Backfill-facing wrapper: load facts by id, classify them as one batch,
 * record attempts for failures, and park facts that exhausted their attempts
 * in General/Misc. Relations are OFF by default for backfill (each relation
 * probe costs another LLM call; the historic corpus already has ~29K
 * relations — new-fact inserts keep detecting them).
 */
export declare function backfillClassifyBatch(db: Database.Database, factIds: string[], opts?: {
    detectRelationsToo?: boolean;
}): Promise<{
    classified: number;
    deterministic: number;
    fallback: number;
    failed: number;
}>;
export declare function detectRelations(db: Database.Database, newFact: Fact, topK?: number): Promise<void>;
export declare function classifyAndLinkFact(db: Database.Database, factId: string, embedding?: number[]): Promise<void>;
export { generateEmbedding };
