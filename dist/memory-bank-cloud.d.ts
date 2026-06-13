export type CloudContextScopeType = 'personal' | 'project' | 'team' | 'org' | 'company';
export type CloudContextRole = 'owner' | 'admin' | 'member' | 'viewer' | 'service';
export type CloudTokenIssuerRole = Extract<CloudContextRole, 'owner' | 'admin' | 'service'>;
export type CloudTokenPurpose = 'mcp_login' | 'sidecar_enrollment';
export type CloudSourceAgent = 'claude-code' | 'codex' | 'opencode' | 'custom-agent';
export type CloudFactCategory = 'decision' | 'preference' | 'pattern' | 'knowledge' | 'constraint';
export interface CloudAccountContext {
    tenantId: string;
    orgId: string;
    teamId: string;
    projectId: string;
    userId: string;
    terminalId?: string;
    sessionId?: string;
    sourceAgent: CloudSourceAgent;
}
export interface CloudMembership {
    tenantId: string;
    userId: string;
    scopeType: CloudContextScopeType;
    scopeId: string;
    role: CloudContextRole;
}
export interface CloudTokenIssuerContext {
    tenantId: string;
    userId: string;
    scopeType: CloudContextScopeType;
    scopeId: string;
    role: CloudTokenIssuerRole;
}
export interface CloudLoginTokenRecord {
    id: string;
    tokenHash: string;
    purpose: CloudTokenPurpose;
    issuer: CloudTokenIssuerContext;
    account: CloudAccountContext;
    memberships: CloudMembership[];
    createdAt: string;
    expiresAt: string;
    revokedAt: string | null;
}
export interface CloudLoginTokenIssue {
    token: string;
    tokenId: string;
    expiresAt: string;
    issuer: CloudTokenIssuerContext;
    account: CloudAccountContext;
}
export interface CloudLoginSession {
    sessionToken: string;
    loginId: string;
    account: CloudAccountContext;
    memberships: CloudMembership[];
    createdAt: string;
    expiresAt: string;
}
export interface CloudContextEntry {
    id: string;
    tenantId: string;
    scopeType: CloudContextScopeType;
    scopeId: string;
    orgId: string;
    teamId: string;
    projectId: string;
    userId: string;
    sourceAgent: CloudSourceAgent;
    title: string;
    body: string;
    tags: string[];
    sensitivity: 'public' | 'internal' | 'confidential' | 'restricted';
    createdAt: string;
    updatedAt: string;
}
export interface CloudContextInput {
    /** Optional stable row id for idempotent retries (e.g. spool event id). Defaults to a random UUID. */
    id?: string;
    scopeType: CloudContextScopeType;
    scopeId?: string;
    title: string;
    body: string;
    tags?: string[];
    sensitivity?: CloudContextEntry['sensitivity'];
}
export interface CloudContextQuery {
    query?: string;
    limit?: number;
    includeScopes?: CloudContextScopeType[];
}
export interface CloudContextBundle {
    account: CloudAccountContext;
    visibleScopes: Array<{
        scopeType: CloudContextScopeType;
        scopeId: string;
    }>;
    entries: CloudContextEntry[];
    generatedAt: string;
}
export interface CloudExchangeRecord {
    id: string;
    tenantId: string;
    scopeType: CloudContextScopeType;
    scopeId: string;
    orgId: string;
    teamId: string;
    projectId: string;
    userId: string;
    sourceAgent: CloudSourceAgent;
    sourceId: string;
    projectPath?: string;
    title: string;
    content: string;
    tags: string[];
    createdAt: string;
    updatedAt: string;
}
export interface CloudExchangeInput {
    /** Optional stable row id for idempotent retries (e.g. spool event id). Defaults to a random UUID. */
    id?: string;
    scopeType: CloudContextScopeType;
    scopeId?: string;
    sourceId?: string;
    projectPath?: string;
    title: string;
    content: string;
    tags?: string[];
    createdAt?: string;
}
export interface CloudSearchQuery {
    query: string;
    limit?: number;
    includeScopes?: CloudContextScopeType[];
    projectId?: string;
    projectPath?: string;
    sourceAgent?: CloudSourceAgent;
}
export interface CloudSearchResult {
    exchange: CloudExchangeRecord;
    score: number;
    snippet: string;
}
export interface CloudReadResult {
    exchange: CloudExchangeRecord;
    context: CloudContextBundle;
}
export interface CloudFactRecord {
    id: string;
    tenantId: string;
    scopeType: CloudContextScopeType;
    scopeId: string;
    orgId: string;
    teamId: string;
    projectId: string;
    userId: string;
    sourceAgent: CloudSourceAgent;
    category: CloudFactCategory;
    fact: string;
    confidence: number;
    sourceExchangeId?: string;
    tags: string[];
    createdAt: string;
    updatedAt: string;
}
export interface CloudFactInput {
    /** Optional stable row id for idempotent retries (e.g. spool event id). Defaults to a random UUID. */
    id?: string;
    scopeType: CloudContextScopeType;
    scopeId?: string;
    category: CloudFactCategory;
    fact: string;
    confidence?: number;
    sourceExchangeId?: string;
    tags?: string[];
}
export interface CloudFactSearchQuery {
    query: string;
    category?: CloudFactCategory;
    limit?: number;
    includeScopes?: CloudContextScopeType[];
    projectId?: string;
    sourceAgent?: CloudSourceAgent;
}
export interface CloudFactSearchResult {
    fact: CloudFactRecord;
    score: number;
    snippet: string;
}
export interface CloudAuditEvent {
    id: string;
    tenantId: string;
    actorUserId: string;
    action: string;
    targetType: string;
    targetId: string;
    createdAt: string;
    metadata: Record<string, string>;
}
export interface MemoryBankCloudStore {
    saveToken(record: CloudLoginTokenRecord): void | Promise<void>;
    findTokenByHash(tokenHash: string): CloudLoginTokenRecord | null | Promise<CloudLoginTokenRecord | null>;
    saveSession(session: CloudLoginSession): void | Promise<void>;
    findSession(sessionToken: string): CloudLoginSession | null | Promise<CloudLoginSession | null>;
    saveContext(entry: CloudContextEntry): void | Promise<void>;
    listContextByTenant(tenantId: string): CloudContextEntry[] | Promise<CloudContextEntry[]>;
    saveExchange(record: CloudExchangeRecord): void | Promise<void>;
    findExchangeById(tenantId: string, id: string): CloudExchangeRecord | null | Promise<CloudExchangeRecord | null>;
    listExchangesByTenant(tenantId: string): CloudExchangeRecord[] | Promise<CloudExchangeRecord[]>;
    saveFact(record: CloudFactRecord): void | Promise<void>;
    listFactsByTenant(tenantId: string): CloudFactRecord[] | Promise<CloudFactRecord[]>;
    saveAudit(event: CloudAuditEvent): void | Promise<void>;
    listAuditEvents(tenantId: string): CloudAuditEvent[] | Promise<CloudAuditEvent[]>;
}
export declare class InMemoryMemoryBankCloudStore implements MemoryBankCloudStore {
    private readonly tokensByHash;
    private readonly sessionsByToken;
    private readonly contextEntries;
    private readonly exchanges;
    private readonly facts;
    private readonly auditEvents;
    saveToken(record: CloudLoginTokenRecord): void;
    findTokenByHash(tokenHash: string): CloudLoginTokenRecord | null;
    saveSession(session: CloudLoginSession): void;
    findSession(sessionToken: string): CloudLoginSession | null;
    saveContext(entry: CloudContextEntry): void;
    listContextByTenant(tenantId: string): CloudContextEntry[];
    saveExchange(record: CloudExchangeRecord): void;
    findExchangeById(tenantId: string, id: string): CloudExchangeRecord | null;
    listExchangesByTenant(tenantId: string): CloudExchangeRecord[];
    saveFact(record: CloudFactRecord): void;
    listFactsByTenant(tenantId: string): CloudFactRecord[];
    saveAudit(event: CloudAuditEvent): void;
    listAuditEvents(tenantId: string): CloudAuditEvent[];
}
export interface MemoryBankCloudHostOptions {
    store?: MemoryBankCloudStore;
    now?: () => Date;
    tokenFactory?: () => string;
}
export declare class MemoryBankCloudAuthError extends Error {
}
export declare class MemoryBankCloudAuthorizationError extends Error {
}
export declare class MemoryBankCloudStoreModeError extends Error {
}
export declare class MemoryBankCloudHost {
    readonly store: MemoryBankCloudStore;
    private readonly now;
    private readonly tokenFactory;
    constructor(options?: MemoryBankCloudHostOptions);
    issueLoginToken(input: {
        issuer: CloudTokenIssuerContext;
        account: CloudAccountContext;
        memberships?: CloudMembership[];
        purpose?: CloudTokenPurpose;
        expiresInSeconds?: number;
    }): CloudLoginTokenIssue;
    loginWithToken(token: string, overrides?: Partial<Pick<CloudAccountContext, 'terminalId' | 'sessionId' | 'sourceAgent'>>): CloudLoginSession;
    putContext(sessionToken: string, input: CloudContextInput): CloudContextEntry;
    getContextBundle(sessionToken: string, query?: CloudContextQuery): CloudContextBundle;
    ingestExchange(sessionToken: string, input: CloudExchangeInput): CloudExchangeRecord;
    searchExchanges(sessionToken: string, query: CloudSearchQuery): CloudSearchResult[];
    readExchange(sessionToken: string, exchangeId: string): CloudReadResult;
    putFact(sessionToken: string, input: CloudFactInput): CloudFactRecord;
    searchFacts(sessionToken: string, query: CloudFactSearchQuery): CloudFactSearchResult[];
    getSessionContext(sessionToken: string): {
        session: CloudLoginSession;
        visibleScopes: Array<{
            scopeType: CloudContextScopeType;
            scopeId: string;
        }>;
    };
    private requireSession;
    private assertCanWriteScope;
    private canReadScope;
    private allowedScopeSet;
    private audit;
    private auditTokenIssue;
    private resolveSync;
}
export declare class AsyncMemoryBankCloudHost {
    readonly store: MemoryBankCloudStore;
    private readonly now;
    private readonly tokenFactory;
    constructor(options?: MemoryBankCloudHostOptions);
    issueLoginToken(input: {
        issuer: CloudTokenIssuerContext;
        account: CloudAccountContext;
        memberships?: CloudMembership[];
        purpose?: CloudTokenPurpose;
        expiresInSeconds?: number;
    }): Promise<CloudLoginTokenIssue>;
    loginWithToken(token: string, overrides?: Partial<Pick<CloudAccountContext, 'terminalId' | 'sessionId' | 'sourceAgent'>>): Promise<CloudLoginSession>;
    putContext(sessionToken: string, input: CloudContextInput): Promise<CloudContextEntry>;
    getContextBundle(sessionToken: string, query?: CloudContextQuery): Promise<CloudContextBundle>;
    ingestExchange(sessionToken: string, input: CloudExchangeInput): Promise<CloudExchangeRecord>;
    searchExchanges(sessionToken: string, query: CloudSearchQuery): Promise<CloudSearchResult[]>;
    readExchange(sessionToken: string, exchangeId: string): Promise<CloudReadResult>;
    putFact(sessionToken: string, input: CloudFactInput): Promise<CloudFactRecord>;
    searchFacts(sessionToken: string, query: CloudFactSearchQuery): Promise<CloudFactSearchResult[]>;
    getSessionContext(sessionToken: string): Promise<{
        session: CloudLoginSession;
        visibleScopes: Array<{
            scopeType: CloudContextScopeType;
            scopeId: string;
        }>;
    }>;
    private requireSession;
    private assertCanWriteScope;
    private canReadScope;
    private allowedScopeSet;
    private audit;
    private auditTokenIssue;
}
export declare function hashToken(token: string): string;
export declare function visibleScopesFor(account: CloudAccountContext, memberships: CloudMembership[]): Array<{
    scopeType: CloudContextScopeType;
    scopeId: string;
}>;
