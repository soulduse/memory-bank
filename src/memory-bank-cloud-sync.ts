import { MemoryBankCloudHost } from './memory-bank-cloud.js';
import { MemoryBankCloudSpool, MemoryBankCloudSpoolEvent } from './memory-bank-cloud-spool.js';

export interface MemoryBankCloudSyncResult {
  processed: number;
  failed: Array<{ event: MemoryBankCloudSpoolEvent; error: string }>;
}

export function syncMemoryBankCloudSpool(host: MemoryBankCloudHost, sessionToken: string, spool: MemoryBankCloudSpool): MemoryBankCloudSyncResult {
  const failed: MemoryBankCloudSyncResult['failed'] = [];
  let processed = 0;
  for (const event of spool.listPending()) {
    try {
      if (event.kind === 'context') host.putContext(sessionToken, event.payload);
      if (event.kind === 'exchange') host.ingestExchange(sessionToken, event.payload);
      if (event.kind === 'fact') host.putFact(sessionToken, event.payload);
      spool.ack(event.id);
      processed += 1;
    } catch (error) {
      failed.push({ event, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { processed, failed };
}
