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
    readonly corruptPath: string;
    /**
     * Read the spool, separating valid pending events from malformed lines.
     * Malformed lines are NOT dropped from disk — they are returned so callers can
     * report/quarantine them, ensuring one torn line cannot silently strand the queue.
     */
    scan(): {
        events: MemoryBankCloudSpoolEvent[];
        malformed: string[];
    };
    listPending(): MemoryBankCloudSpoolEvent[];
    /**
     * Copy malformed lines to a sibling quarantine file for inspection. Non-destructive:
     * the spool file is left intact (append-only), so nothing is lost; this surfaces
     * corruption durably instead of silently skipping it.
     */
    quarantineMalformed(): {
        quarantined: number;
        corruptPath: string;
    };
    ack(eventId: string): void;
    private readAckedIds;
}
