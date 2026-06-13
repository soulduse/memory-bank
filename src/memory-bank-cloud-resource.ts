import { MemoryBankCloudHost, CloudContextQuery } from './memory-bank-cloud.js';

export interface MemoryBankCloudContextResource {
  uri: string;
  name: string;
  mimeType: 'application/json';
  text: string;
}

export function getMemoryBankCloudContextResource(
  host: MemoryBankCloudHost,
  sessionToken: string,
  query: CloudContextQuery = {}
): MemoryBankCloudContextResource {
  const bundle = host.getContextBundle(sessionToken, query);
  return {
    uri: 'memory-bank-cloud://context/current',
    name: 'Memory Bank Cloud Context',
    mimeType: 'application/json',
    text: JSON.stringify(bundle, null, 2),
  };
}
