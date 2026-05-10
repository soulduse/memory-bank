import { MemoryBankCloudHost } from './memory-bank-cloud.js';
import { MemoryBankCloudSpool, MemoryBankCloudSpoolEvent } from './memory-bank-cloud-spool.js';
export interface MemoryBankCloudSyncResult {
    processed: number;
    failed: Array<{
        event: MemoryBankCloudSpoolEvent;
        error: string;
    }>;
}
export declare function syncMemoryBankCloudSpool(host: MemoryBankCloudHost, sessionToken: string, spool: MemoryBankCloudSpool): MemoryBankCloudSyncResult;
