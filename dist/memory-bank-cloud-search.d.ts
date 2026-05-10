import { CloudSearchQuery, CloudSearchResult, MemoryBankCloudHost } from './memory-bank-cloud.js';
export declare function searchCloudMemory(host: MemoryBankCloudHost, sessionToken: string, query: Omit<CloudSearchQuery, 'sessionToken'>): CloudSearchResult[];
