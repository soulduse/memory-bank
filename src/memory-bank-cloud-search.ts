import { CloudSearchQuery, CloudSearchResult, MemoryBankCloudHost } from './memory-bank-cloud.js';

export function searchCloudMemory(host: MemoryBankCloudHost, sessionToken: string, query: Omit<CloudSearchQuery, 'sessionToken'>): CloudSearchResult[] {
  return host.searchExchanges(sessionToken, query);
}
