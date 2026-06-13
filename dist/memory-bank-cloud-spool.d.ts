import { CloudContextInput, CloudExchangeInput, CloudFactInput } from './memory-bank-cloud.js';
export type MemoryBankCloudSpoolEvent = {
    id: string;
    kind: 'context';
    createdAt: string;
    payload: CloudContextInput;
} | {
    id: string;
    kind: 'exchange';
    createdAt: string;
    payload: CloudExchangeInput;
} | {
    id: string;
    kind: 'fact';
    createdAt: string;
    payload: CloudFactInput;
};
export declare class MemoryBankCloudSpool {
    readonly filePath: string;
    private readonly ackPath;
    constructor(spoolDir: string);
    enqueue(kind: MemoryBankCloudSpoolEvent['kind'], payload: CloudContextInput | CloudExchangeInput | CloudFactInput): MemoryBankCloudSpoolEvent;
    listPending(): MemoryBankCloudSpoolEvent[];
    ack(eventId: string): void;
    private readAckedIds;
}
