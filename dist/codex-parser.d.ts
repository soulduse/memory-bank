export declare const CODEX_NORMALIZATION_VERSION = 1;
export interface CodexNormalizationResult {
    sessionId: string;
    cwd: string;
    project: string;
    cliVersion?: string;
    gitBranch?: string;
    source?: string;
    jsonl: string;
    messageCount: number;
}
export declare function isInjectedCodexContext(text: string): boolean;
/**
 * Best-effort redaction before Codex text is copied into Memory Bank's archive.
 * Tool inputs and outputs are omitted entirely; this covers common secrets that
 * can still appear in user or assistant prose.
 */
export declare function redactCodexSecrets(text: string): string;
/**
 * Convert a Codex rollout into the Claude-compatible, sanitized JSONL shape
 * consumed by the existing Memory Bank parser. Developer/system context,
 * reasoning, tool inputs, and tool outputs are intentionally excluded.
 */
export declare function normalizeCodexRollout(filePath: string): Promise<CodexNormalizationResult>;
