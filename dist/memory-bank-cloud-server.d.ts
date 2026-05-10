#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { AsyncMemoryBankCloudHost, MemoryBankCloudHost } from './memory-bank-cloud.js';
import { ListMemoryBankCloudMcpToolsOptions } from './memory-bank-cloud-mcp.js';
export type MemoryBankCloudRuntimeHost = MemoryBankCloudHost | AsyncMemoryBankCloudHost;
export interface CreateMemoryBankCloudServerOptions extends ListMemoryBankCloudMcpToolsOptions {
    host?: MemoryBankCloudRuntimeHost;
    name?: string;
    version?: string;
}
export declare function createMemoryBankCloudHostFromEnv(): MemoryBankCloudRuntimeHost;
export declare function createMemoryBankCloudServer(options?: CreateMemoryBankCloudServerOptions): Server;
export declare function registerMemoryBankCloudTools(server: Server, host: MemoryBankCloudRuntimeHost, options?: ListMemoryBankCloudMcpToolsOptions): void;
