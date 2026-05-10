import { MemoryBankCloudHost, CloudContextQuery } from './memory-bank-cloud.js';
export interface MemoryBankCloudContextResource {
    uri: string;
    name: string;
    mimeType: 'application/json';
    text: string;
}
export declare function getMemoryBankCloudContextResource(host: MemoryBankCloudHost, sessionToken: string, query?: CloudContextQuery): MemoryBankCloudContextResource;
