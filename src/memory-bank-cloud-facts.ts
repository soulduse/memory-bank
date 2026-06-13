import { CloudFactInput, CloudFactRecord, CloudFactSearchQuery, CloudFactSearchResult, MemoryBankCloudHost } from './memory-bank-cloud.js';

export function putCloudFact(host: MemoryBankCloudHost, sessionToken: string, input: CloudFactInput): CloudFactRecord {
  return host.putFact(sessionToken, input);
}

export function searchCloudFacts(host: MemoryBankCloudHost, sessionToken: string, query: CloudFactSearchQuery): CloudFactSearchResult[] {
  return host.searchFacts(sessionToken, query);
}
