import Database from 'better-sqlite3';
import type { ExtractedFact } from './types.js';
/**
 * Whether an exchange is worth sending to the extraction LLM.
 * Filters harness artifacts (local command output), bare slash commands,
 * and trivial acknowledgements — they waste LLM calls and produce noise facts.
 */
export declare function isSubstantiveExchange(userMessage: string, assistantMessage: string): boolean;
/** Normalize fact text for cross-batch duplicate detection within a session. */
export declare function normalizeFactText(fact: string): string;
/**
 * Confidence gate for extracted facts. Rejects missing/NaN confidence —
 * `undefined < 0.7` is false, so a naive `<` check would accept unscored
 * facts from malformed LLM output.
 */
export declare function passesConfidenceGate(confidence: unknown): boolean;
/**
 * Cap LLM calls for long sessions by picking evenly spread batches, so the
 * beginning, middle, and end of a session are all represented instead of
 * only the head.
 */
export declare function selectSpreadBatches<T>(batches: T[], maxBatches: number): T[];
export declare function buildExtractionPrompt(exchanges: Array<{
    user_message: string;
    assistant_message: string;
}>): string;
export declare function extractFactsFromExchanges(db: Database.Database, sessionId: string): Promise<ExtractedFact[]>;
export declare function saveExtractedFacts(db: Database.Database, facts: ExtractedFact[], project: string, sourceExchangeIds: string[], codingAgent?: string): Promise<string[]>;
export declare function runFactExtraction(db: Database.Database, sessionId: string, project: string, codingAgent?: string): Promise<{
    extracted: number;
    saved: number;
}>;
