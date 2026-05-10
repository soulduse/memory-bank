#!/usr/bin/env node
import { pathToFileURL } from 'url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AsyncMemoryBankCloudHost, MemoryBankCloudHost } from './memory-bank-cloud.js';
import { callMemoryBankCloudMcpTool, listMemoryBankCloudMcpTools, ListMemoryBankCloudMcpToolsOptions } from './memory-bank-cloud-mcp.js';
import { loadMemoryBankCloudConfig } from './memory-bank-cloud-config.js';
import { SupabaseMemoryBankCloudStore } from './memory-bank-cloud-supabase-store.js';

export type MemoryBankCloudRuntimeHost = MemoryBankCloudHost | AsyncMemoryBankCloudHost;

export interface CreateMemoryBankCloudServerOptions extends ListMemoryBankCloudMcpToolsOptions {
  host?: MemoryBankCloudRuntimeHost;
  name?: string;
  version?: string;
}

export function createMemoryBankCloudHostFromEnv(): MemoryBankCloudRuntimeHost {
  const config = loadMemoryBankCloudConfig();
  if (config.mode === 'supabase') {
    return new AsyncMemoryBankCloudHost({
      store: new SupabaseMemoryBankCloudStore({
        url: config.supabaseUrl ?? '',
        privilegedToken: config.supabasePrivilegedToken ?? '',
      }),
    });
  }
  return new MemoryBankCloudHost();
}

export function createMemoryBankCloudServer(options: CreateMemoryBankCloudServerOptions = {}): Server {
  const server = new Server(
    { name: options.name ?? 'memory-bank-cloud', version: options.version ?? '1.0.0' },
    { capabilities: { tools: {} } }
  );
  registerMemoryBankCloudTools(server, options.host ?? createMemoryBankCloudHostFromEnv(), options);
  return server;
}

export function registerMemoryBankCloudTools(
  server: Server,
  host: MemoryBankCloudRuntimeHost,
  options: ListMemoryBankCloudMcpToolsOptions = {}
): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listMemoryBankCloudMcpTools(options),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const text = await callMemoryBankCloudMcpTool(host, request.params.name, request.params.arguments ?? {});
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      };
    }
  });
}

async function main(): Promise<void> {
  const config = loadMemoryBankCloudConfig();
  const includeAdminTools = config.includeAdminTools || process.argv.includes('--admin');
  const server = createMemoryBankCloudServer({ includeAdminTools });
  await server.connect(new StdioServerTransport());
  console.error(`memory-bank-cloud MCP server started (${config.mode})`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
