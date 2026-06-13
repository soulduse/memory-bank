import { CloudAuditEvent, CloudContextEntry, CloudExchangeRecord, CloudFactRecord, CloudLoginSession, CloudLoginTokenRecord, MemoryBankCloudStore } from './memory-bank-cloud.js';
export type MemoryBankCloudFetch = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
}) => Promise<{
    ok: boolean;
    status: number;
    statusText: string;
    text(): Promise<string>;
}>;
export interface SupabaseMemoryBankCloudStoreOptions {
    url: string;
    privilegedToken: string;
    fetch?: MemoryBankCloudFetch;
    schema?: string;
}
export declare class SupabaseMemoryBankCloudStore implements MemoryBankCloudStore {
    private readonly url;
    private readonly privilegedToken;
    private readonly fetchImpl;
    private readonly schema;
    constructor(options: SupabaseMemoryBankCloudStoreOptions);
    saveToken(record: CloudLoginTokenRecord): Promise<void>;
    findTokenByHash(tokenHash: string): Promise<CloudLoginTokenRecord | null>;
    saveSession(session: CloudLoginSession): Promise<void>;
    findSession(sessionToken: string): Promise<CloudLoginSession | null>;
    saveContext(entry: CloudContextEntry): Promise<void>;
    listContextByTenant(tenantId: string): Promise<CloudContextEntry[]>;
    saveExchange(record: CloudExchangeRecord): Promise<void>;
    findExchangeById(tenantId: string, id: string): Promise<CloudExchangeRecord | null>;
    listExchangesByTenant(tenantId: string): Promise<CloudExchangeRecord[]>;
    saveFact(record: CloudFactRecord): Promise<void>;
    listFactsByTenant(tenantId: string): Promise<CloudFactRecord[]>;
    saveAudit(event: CloudAuditEvent): Promise<void>;
    listAuditEvents(tenantId: string): Promise<CloudAuditEvent[]>;
    private upsert;
    private select;
    private request;
}
