import type { SyncResult } from './sync.js';
export interface CodexSyncOptions {
    sessionPath?: string;
    skipIndex?: boolean;
    statePath?: string;
}
export declare function getCodexSessionsDir(): string;
export declare function listCodexRollouts(rootDir: string): string[];
/**
 * Normalize Codex rollout JSONL into Memory Bank's archive format and index
 * only new or changed sessions. A compact state file avoids re-reading large
 * historical rollouts (especially tool outputs) on every startup.
 */
export declare function syncCodexConversations(sourceDir?: string, destDir?: string, options?: CodexSyncOptions): Promise<SyncResult>;
