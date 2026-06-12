/**
 * Multilingual retrieval model (Korean/English/100 langs), 384-dim — same
 * dimension as the original all-MiniLM-L6-v2 so vec tables are unchanged.
 *
 * Model selection (2026-06-12, measured on real-DB Korean/English pairs):
 *   - all-MiniLM-L6-v2: English-only — Korean queries score ~0 vs English facts
 *   - paraphrase-multilingual-MiniLM-L12-v2: top-1 ranking broke on real data
 *     (unrelated Korean pairs up to 0.82 — strong anisotropy)
 *   - multilingual-e5-small: perfect top-1 ranking on the hard set; absolute
 *     scores are compressed (~0.72-0.99) so consumers use either retuned
 *     thresholds (passage↔passage) or probe-baseline normalization (queries).
 *
 * e5 protocol: queries are embedded with a "query: " prefix, stored content
 * with "passage: ". Pass the mode explicitly at call sites.
 *
 * Vectors from different models are NOT comparable; EMBEDDING_VERSION tracks
 * which model produced a stored vector and the re-embed worker upgrades rows.
 */
export declare const EMBEDDING_MODEL: string;
/**
 * 1 = all-MiniLM-L6-v2 (English-only)
 * 2 = paraphrase-multilingual-MiniLM-L12-v2 (rejected — anisotropy)
 * 3 = multilingual-e5-small (query/passage prefixes)
 */
export declare const EMBEDDING_VERSION = 3;
export type EmbeddingMode = 'query' | 'passage';
export declare function initEmbeddings(): Promise<void>;
/**
 * @param mode 'passage' for stored/indexed content (facts, exchanges),
 *             'query' for search queries. Defaults to 'passage' because most
 *             call sites embed content; search paths must pass 'query'.
 */
export declare function generateEmbedding(text: string, mode?: EmbeddingMode): Promise<number[]>;
export declare function generateExchangeEmbedding(userMessage: string, assistantMessage: string, toolNames?: string[]): Promise<number[]>;
/**
 * Query-side anisotropy normalization (probe baseline).
 *
 * e5 similarity scores sit in a compressed band (~0.72-0.9 even for unrelated
 * pairs), so a fixed absolute threshold cannot separate relevant from
 * irrelevant. Instead, compare each query↔fact score against the query's own
 * baseline: its best similarity to a fixed set of neutral "background probe"
 * sentences. A fact is relevant only if it beats that baseline by a margin
 * (measured: related pairs +0.047~+0.123, unrelated pairs -0.028~-0.091).
 */
export declare const BACKGROUND_PROBES: string[];
/** Max cosine similarity between the query embedding and the background probes. */
export declare function queryBaseline(queryEmbedding: number[]): Promise<number>;
