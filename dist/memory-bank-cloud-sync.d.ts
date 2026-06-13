import { AsyncMemoryBankCloudHost, MemoryBankCloudHost } from './memory-bank-cloud.js';
import { MemoryBankCloudSpool, MemoryBankCloudSpoolEvent } from './memory-bank-cloud-spool.js';
export interface MemoryBankCloudSyncResult {
    processed: number;
    failed: Array<{
        event: MemoryBankCloudSpoolEvent;
        error: string;
    }>;
}
export declare function syncMemoryBankCloudSpool(host: MemoryBankCloudHost, sessionToken: string, spool: MemoryBankCloudSpool): MemoryBankCloudSyncResult;
/**
 * Async variant for remote (Supabase-backed) hosts. Idempotent: acked events are
 * skipped by the spool, so repeated runs do not duplicate rows. A failed event is
 * left unacked so a later retry can reprocess it.
 */
export declare function syncMemoryBankCloudSpoolAsync(host: AsyncMemoryBankCloudHost, sessionToken: string, spool: MemoryBankCloudSpool): Promise<MemoryBankCloudSyncResult>;
