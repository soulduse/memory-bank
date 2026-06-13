import { CloudReadResult, MemoryBankCloudHost } from './memory-bank-cloud.js';

export function readCloudMemory(host: MemoryBankCloudHost, sessionToken: string, exchangeId: string): CloudReadResult {
  return host.readExchange(sessionToken, exchangeId);
}
