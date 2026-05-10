import { MemoryBankCloudHost, CloudExchangeInput, CloudExchangeRecord } from './memory-bank-cloud.js';

export interface CloudJsonlIngestResult {
  exchanges: CloudExchangeRecord[];
  skipped: number;
}

export function ingestCloudExchange(host: MemoryBankCloudHost, sessionToken: string, input: CloudExchangeInput): CloudExchangeRecord {
  return host.ingestExchange(sessionToken, input);
}

export function ingestCloudExchangeJsonl(
  host: MemoryBankCloudHost,
  sessionToken: string,
  jsonl: string,
  defaults: Pick<CloudExchangeInput, 'scopeType' | 'scopeId' | 'projectPath' | 'tags'>
): CloudJsonlIngestResult {
  const exchanges: CloudExchangeRecord[] = [];
  let skipped = 0;
  for (const line of jsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<CloudExchangeInput> & { message?: string; text?: string };
      exchanges.push(host.ingestExchange(sessionToken, {
        ...defaults,
        scopeType: parsed.scopeType ?? defaults.scopeType,
        scopeId: parsed.scopeId ?? defaults.scopeId,
        title: parsed.title ?? parsed.sourceId ?? 'Cloud memory exchange',
        content: parsed.content ?? parsed.message ?? parsed.text ?? trimmed,
        sourceId: parsed.sourceId,
        projectPath: parsed.projectPath ?? defaults.projectPath,
        tags: parsed.tags ?? defaults.tags,
        createdAt: parsed.createdAt,
      }));
    } catch {
      skipped += 1;
    }
  }
  return { exchanges, skipped };
}
