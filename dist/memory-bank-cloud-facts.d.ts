import { CloudFactInput, CloudFactRecord, CloudFactSearchQuery, CloudFactSearchResult, MemoryBankCloudHost } from './memory-bank-cloud.js';
export declare function putCloudFact(host: MemoryBankCloudHost, sessionToken: string, input: CloudFactInput): CloudFactRecord;
export declare function searchCloudFacts(host: MemoryBankCloudHost, sessionToken: string, query: CloudFactSearchQuery): CloudFactSearchResult[];
