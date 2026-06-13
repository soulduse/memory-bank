import { AsyncMemoryBankCloudHost, MemoryBankCloudHost } from './memory-bank-cloud.js';
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
      // Pass the spool event id as the stable row id so a retry (e.g. write succeeded
      // but ack failed) upserts the same row instead of creating a duplicate.
      if (event.kind === 'context') host.putContext(sessionToken, { ...event.payload, id: event.id });
      if (event.kind === 'exchange') host.ingestExchange(sessionToken, { ...event.payload, id: event.id });
      if (event.kind === 'fact') host.putFact(sessionToken, { ...event.payload, id: event.id });
      spool.ack(event.id);
      processed += 1;
    } catch (error) {
      failed.push({ event, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { processed, failed };
}

/**
 * Async variant for remote (Supabase-backed) hosts. Idempotent: acked events are
 * skipped by the spool, so repeated runs do not duplicate rows. A failed event is
 * left unacked so a later retry can reprocess it.
 */
export async function syncMemoryBankCloudSpoolAsync(
  host: AsyncMemoryBankCloudHost,
  sessionToken: string,
  spool: MemoryBankCloudSpool
): Promise<MemoryBankCloudSyncResult> {
  const failed: MemoryBankCloudSyncResult['failed'] = [];
  let processed = 0;
  for (const event of spool.listPending()) {
    try {
      // Pass the spool event id as the stable row id so a retry (e.g. remote write
      // succeeded but ack failed) upserts the same row instead of duplicating it.
      if (event.kind === 'context') await host.putContext(sessionToken, { ...event.payload, id: event.id });
      if (event.kind === 'exchange') await host.ingestExchange(sessionToken, { ...event.payload, id: event.id });
      if (event.kind === 'fact') await host.putFact(sessionToken, { ...event.payload, id: event.id });
      spool.ack(event.id);
      processed += 1;
    } catch (error) {
      failed.push({ event, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { processed, failed };
}
