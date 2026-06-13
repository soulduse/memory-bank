import { MemoryBankCloudHost, AsyncMemoryBankCloudHost } from './memory-bank-cloud.js';
export interface MemoryBankCloudMcpTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations: {
        title: string;
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
}
export interface ListMemoryBankCloudMcpToolsOptions {
    includeAdminTools?: boolean;
}
export declare function listMemoryBankCloudMcpTools(options?: ListMemoryBankCloudMcpToolsOptions): MemoryBankCloudMcpTool[];
export declare function callMemoryBankCloudMcpTool(host: MemoryBankCloudHost | AsyncMemoryBankCloudHost, name: string, args: unknown): Promise<string>;
