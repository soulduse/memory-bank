import { MemoryBankCloudHost, CloudExchangeInput, CloudExchangeRecord } from './memory-bank-cloud.js';
export interface CloudJsonlIngestResult {
    exchanges: CloudExchangeRecord[];
    skipped: number;
}
export declare function ingestCloudExchange(host: MemoryBankCloudHost, sessionToken: string, input: CloudExchangeInput): CloudExchangeRecord;
export declare function ingestCloudExchangeJsonl(host: MemoryBankCloudHost, sessionToken: string, jsonl: string, defaults: Pick<CloudExchangeInput, 'scopeType' | 'scopeId' | 'projectPath' | 'tags'>): CloudJsonlIngestResult;
