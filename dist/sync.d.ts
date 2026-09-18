export interface SyncResult {
    copied: number;
    skipped: number;
    indexed: number;
    summarized: number;
    errors: Array<{
        file: string;
        error: string;
    }>;
}
export interface SyncOptions {
    skipIndex?: boolean;
    skipSummaries?: boolean;
    summaryLimit?: number;
    codingAgent?: string;
}
export interface ConversationFileToIndex {
    path: string;
    project?: string;
}
export interface IndexFilesResult {
    indexed: number;
    errors: Array<{
        file: string;
        error: string;
    }>;
}
/**
 * Index already-archived conversations through one shared pipeline. Agent
 * adapters only need to normalize/copy their transcript format, then hand the
 * resulting files here.
 */
export declare function indexConversationFiles(files: ConversationFileToIndex[], codingAgent: string): Promise<IndexFilesResult>;
export declare function syncConversations(sourceDir: string, destDir: string, options?: SyncOptions): Promise<SyncResult>;
