import { createHash, randomBytes, randomUUID } from 'crypto';

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
  /** Optional idempotency key (e.g. spool event id). The stored row id is derived
   * deterministically from the writer's tenant/user/scope + this key, so it cannot
   * target or overwrite a row in another scope. */
  idempotencyKey?: string;
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
  visibleScopes: Array<{ scopeType: CloudContextScopeType; scopeId: string }>;
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
  /** Optional idempotency key (e.g. spool event id). The stored row id is derived
   * deterministically from the writer's tenant/user/scope + this key, so it cannot
   * target or overwrite a row in another scope. */
  idempotencyKey?: string;
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
  /** Optional idempotency key (e.g. spool event id). The stored row id is derived
   * deterministically from the writer's tenant/user/scope + this key, so it cannot
   * target or overwrite a row in another scope. */
  idempotencyKey?: string;
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

export class InMemoryMemoryBankCloudStore implements MemoryBankCloudStore {
  private readonly tokensByHash = new Map<string, CloudLoginTokenRecord>();
  private readonly sessionsByToken = new Map<string, CloudLoginSession>();
  private readonly contextEntries: CloudContextEntry[] = [];
  private readonly exchanges: CloudExchangeRecord[] = [];
  private readonly facts: CloudFactRecord[] = [];
  private readonly auditEvents: CloudAuditEvent[] = [];

  saveToken(record: CloudLoginTokenRecord): void {
    this.tokensByHash.set(record.tokenHash, record);
  }

  findTokenByHash(tokenHash: string): CloudLoginTokenRecord | null {
    return this.tokensByHash.get(tokenHash) ?? null;
  }

  saveSession(session: CloudLoginSession): void {
    this.sessionsByToken.set(session.sessionToken, session);
  }

  findSession(sessionToken: string): CloudLoginSession | null {
    return this.sessionsByToken.get(sessionToken) ?? null;
  }

  saveContext(entry: CloudContextEntry): void {
    const index = this.contextEntries.findIndex((existing) => existing.id === entry.id);
    if (index >= 0) {
      this.contextEntries[index] = entry;
      return;
    }
    this.contextEntries.push(entry);
  }

  listContextByTenant(tenantId: string): CloudContextEntry[] {
    return this.contextEntries.filter((entry) => entry.tenantId === tenantId);
  }

  saveExchange(record: CloudExchangeRecord): void {
    const index = this.exchanges.findIndex((existing) => existing.id === record.id);
    if (index >= 0) {
      this.exchanges[index] = record;
      return;
    }
    this.exchanges.push(record);
  }

  findExchangeById(tenantId: string, id: string): CloudExchangeRecord | null {
    return this.exchanges.find((exchange) => exchange.tenantId === tenantId && exchange.id === id) ?? null;
  }

  listExchangesByTenant(tenantId: string): CloudExchangeRecord[] {
    return this.exchanges.filter((exchange) => exchange.tenantId === tenantId);
  }

  saveFact(record: CloudFactRecord): void {
    const index = this.facts.findIndex((existing) => existing.id === record.id);
    if (index >= 0) {
      this.facts[index] = record;
      return;
    }
    this.facts.push(record);
  }

  listFactsByTenant(tenantId: string): CloudFactRecord[] {
    return this.facts.filter((fact) => fact.tenantId === tenantId);
  }

  saveAudit(event: CloudAuditEvent): void {
    this.auditEvents.push(event);
  }

  listAuditEvents(tenantId: string): CloudAuditEvent[] {
    return this.auditEvents.filter((event) => event.tenantId === tenantId);
  }
}

export interface MemoryBankCloudHostOptions {
  store?: MemoryBankCloudStore;
  now?: () => Date;
  tokenFactory?: () => string;
}

export class MemoryBankCloudAuthError extends Error {}
export class MemoryBankCloudAuthorizationError extends Error {}
export class MemoryBankCloudStoreModeError extends Error {}

export class MemoryBankCloudHost {
  readonly store: MemoryBankCloudStore;
  private readonly now: () => Date;
  private readonly tokenFactory: () => string;

  constructor(options: MemoryBankCloudHostOptions = {}) {
    this.store = options.store ?? new InMemoryMemoryBankCloudStore();
    this.now = options.now ?? (() => new Date());
    this.tokenFactory = options.tokenFactory ?? (() => `mbc_${randomBytes(32).toString('base64url')}`);
  }

  issueLoginToken(input: {
    issuer: CloudTokenIssuerContext;
    account: CloudAccountContext;
    memberships?: CloudMembership[];
    purpose?: CloudTokenPurpose;
    expiresInSeconds?: number;
  }): CloudLoginTokenIssue {
    const createdAt = this.now().toISOString();
    const expiresAt = new Date(this.now().getTime() + (input.expiresInSeconds ?? 3600) * 1000).toISOString();
    const token = this.tokenFactory();
    assertIssuerCanIssue(input.issuer, input.account, input.memberships ?? []);
    const memberships = normalizeMemberships(input.account, input.issuer, input.memberships ?? []);
    const record: CloudLoginTokenRecord = {
      id: randomUUID(),
      tokenHash: hashToken(token),
      purpose: input.purpose ?? 'mcp_login',
      issuer: input.issuer,
      account: input.account,
      memberships,
      createdAt,
      expiresAt,
      revokedAt: null,
    };

    this.resolveSync(this.store.saveToken(record), 'saveToken');
    this.auditTokenIssue(input.issuer, input.account, record);

    return { token, tokenId: record.id, expiresAt, issuer: input.issuer, account: input.account };
  }

  loginWithToken(token: string, overrides: Partial<Pick<CloudAccountContext, 'terminalId' | 'sessionId' | 'sourceAgent'>> = {}): CloudLoginSession {
    const record = this.resolveSync(this.store.findTokenByHash(hashToken(token)), 'findTokenByHash');
    if (!record) {
      throw new MemoryBankCloudAuthError('Invalid memory-bank-cloud token');
    }
    const now = this.now().getTime();
    if (record.revokedAt) {
      throw new MemoryBankCloudAuthError('Memory-bank-cloud token is revoked');
    }
    if (Date.parse(record.expiresAt) <= now) {
      throw new MemoryBankCloudAuthError('Memory-bank-cloud token is expired');
    }

    const account: CloudAccountContext = {
      ...record.account,
      terminalId: overrides.terminalId ?? record.account.terminalId,
      sessionId: overrides.sessionId ?? record.account.sessionId ?? randomUUID(),
      sourceAgent: overrides.sourceAgent ?? record.account.sourceAgent,
    };
    const session: CloudLoginSession = {
      sessionToken: `mbcs_${randomBytes(32).toString('base64url')}`,
      loginId: randomUUID(),
      account,
      memberships: record.memberships,
      createdAt: this.now().toISOString(),
      expiresAt: record.expiresAt,
    };
    this.resolveSync(this.store.saveSession(session), 'saveSession');
    this.audit(account, 'token.login', 'token', record.id, { sourceAgent: account.sourceAgent });
    return session;
  }

  putContext(sessionToken: string, input: CloudContextInput): CloudContextEntry {
    const session = this.requireSession(sessionToken);
    const scopeId = input.scopeId ?? defaultScopeId(session.account, input.scopeType);
    this.assertCanWriteScope(session, input.scopeType, scopeId);
    const now = this.now().toISOString();
    const entry: CloudContextEntry = {
      id: deriveRowId(session.account, input.scopeType, scopeId, input.idempotencyKey),
      tenantId: session.account.tenantId,
      scopeType: input.scopeType,
      scopeId,
      orgId: session.account.orgId,
      teamId: session.account.teamId,
      projectId: session.account.projectId,
      userId: session.account.userId,
      sourceAgent: session.account.sourceAgent,
      title: input.title,
      body: input.body,
      tags: input.tags ?? [],
      sensitivity: input.sensitivity ?? 'internal',
      createdAt: now,
      updatedAt: now,
    };
    this.resolveSync(this.store.saveContext(entry), 'saveContext');
    this.audit(session.account, 'context.put', 'context_entry', entry.id, {
      scopeType: entry.scopeType,
      scopeId: entry.scopeId,
    });
    return entry;
  }

  getContextBundle(sessionToken: string, query: CloudContextQuery = {}): CloudContextBundle {
    const session = this.requireSession(sessionToken);
    const visibleScopes = visibleScopesFor(session.account, session.memberships);
    const allowed = new Set(visibleScopes.map((scope) => `${scope.scopeType}:${scope.scopeId}`));
    const queryText = query.query?.trim().toLowerCase();
    const includeScopes = query.includeScopes ? new Set(query.includeScopes) : null;
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);

    const entries = this.resolveSync(this.store.listContextByTenant(session.account.tenantId), 'listContextByTenant')
      .filter((entry) => allowed.has(`${entry.scopeType}:${entry.scopeId}`))
      .filter((entry) => (includeScopes ? includeScopes.has(entry.scopeType) : true))
      .filter((entry) => {
        if (!queryText) return true;
        const haystack = `${entry.title}\n${entry.body}\n${entry.tags.join(' ')}`.toLowerCase();
        return haystack.includes(queryText);
      })
      .sort((a, b) => scopeRank(a.scopeType) - scopeRank(b.scopeType) || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);

    this.audit(session.account, 'context.bundle', 'session', session.loginId, { count: String(entries.length) });

    return {
      account: session.account,
      visibleScopes,
      entries,
      generatedAt: this.now().toISOString(),
    };
  }

  ingestExchange(sessionToken: string, input: CloudExchangeInput): CloudExchangeRecord {
    const session = this.requireSession(sessionToken);
    const scopeId = input.scopeId ?? defaultScopeId(session.account, input.scopeType);
    this.assertCanWriteScope(session, input.scopeType, scopeId);
    const createdAt = input.createdAt ?? this.now().toISOString();
    const exchange: CloudExchangeRecord = {
      id: deriveRowId(session.account, input.scopeType, scopeId, input.idempotencyKey),
      tenantId: session.account.tenantId,
      scopeType: input.scopeType,
      scopeId,
      orgId: session.account.orgId,
      teamId: session.account.teamId,
      projectId: session.account.projectId,
      userId: session.account.userId,
      sourceAgent: session.account.sourceAgent,
      sourceId: input.sourceId ?? randomUUID(),
      projectPath: input.projectPath,
      title: input.title,
      content: input.content,
      tags: input.tags ?? [],
      createdAt,
      updatedAt: this.now().toISOString(),
    };
    this.resolveSync(this.store.saveExchange(exchange), 'saveExchange');
    this.audit(session.account, 'exchange.ingest', 'exchange', exchange.id, {
      scopeType: exchange.scopeType,
      scopeId: exchange.scopeId,
      sourceAgent: exchange.sourceAgent,
    });
    return exchange;
  }

  searchExchanges(sessionToken: string, query: CloudSearchQuery): CloudSearchResult[] {
    const session = this.requireSession(sessionToken);
    const allowed = this.allowedScopeSet(session);
    const includeScopes = query.includeScopes ? new Set(query.includeScopes) : null;
    const queryText = normalizeSearchText(query.query);
    const limit = Math.min(Math.max(query.limit ?? 10, 1), 50);

    const results = this.resolveSync(this.store.listExchangesByTenant(session.account.tenantId), 'listExchangesByTenant')
      .filter((exchange) => allowed.has(`${exchange.scopeType}:${exchange.scopeId}`))
      .filter((exchange) => (includeScopes ? includeScopes.has(exchange.scopeType) : true))
      .filter((exchange) => (query.projectId ? exchange.projectId === query.projectId : true))
      .filter((exchange) => (query.projectPath ? exchange.projectPath === query.projectPath : true))
      .filter((exchange) => (query.sourceAgent ? exchange.sourceAgent === query.sourceAgent : true))
      .map((exchange) => {
        const haystack = `${exchange.title}\n${exchange.content}\n${exchange.tags.join(' ')}`;
        return {
          exchange,
          score: scoreText(haystack, queryText),
          snippet: makeSnippet(haystack, queryText),
        };
      })
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || b.exchange.updatedAt.localeCompare(a.exchange.updatedAt))
      .slice(0, limit);

    this.audit(session.account, 'exchange.search', 'session', session.loginId, { count: String(results.length) });
    return results;
  }

  readExchange(sessionToken: string, exchangeId: string): CloudReadResult {
    const session = this.requireSession(sessionToken);
    const exchange = this.resolveSync(this.store.findExchangeById(session.account.tenantId, exchangeId), 'findExchangeById');
    if (!exchange || !this.canReadScope(session, exchange.scopeType, exchange.scopeId)) {
      throw new MemoryBankCloudAuthorizationError('Conversation is not visible to this memory-bank-cloud session');
    }
    this.audit(session.account, 'exchange.read', 'exchange', exchange.id, {
      scopeType: exchange.scopeType,
      scopeId: exchange.scopeId,
    });
    return {
      exchange,
      context: this.getContextBundle(sessionToken, { includeScopes: [exchange.scopeType], limit: 20 }),
    };
  }

  putFact(sessionToken: string, input: CloudFactInput): CloudFactRecord {
    const session = this.requireSession(sessionToken);
    const scopeId = input.scopeId ?? defaultScopeId(session.account, input.scopeType);
    this.assertCanWriteScope(session, input.scopeType, scopeId);
    if (input.sourceExchangeId) {
      const exchange = this.resolveSync(this.store.findExchangeById(session.account.tenantId, input.sourceExchangeId), 'findExchangeById');
      if (!exchange || !this.canReadScope(session, exchange.scopeType, exchange.scopeId)) {
        throw new MemoryBankCloudAuthorizationError('Fact source exchange is not visible to this memory-bank-cloud session');
      }
    }
    const now = this.now().toISOString();
    const fact: CloudFactRecord = {
      id: deriveRowId(session.account, input.scopeType, scopeId, input.idempotencyKey),
      tenantId: session.account.tenantId,
      scopeType: input.scopeType,
      scopeId,
      orgId: session.account.orgId,
      teamId: session.account.teamId,
      projectId: session.account.projectId,
      userId: session.account.userId,
      sourceAgent: session.account.sourceAgent,
      category: input.category,
      fact: input.fact,
      confidence: Math.min(Math.max(input.confidence ?? 0.8, 0), 1),
      sourceExchangeId: input.sourceExchangeId,
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.resolveSync(this.store.saveFact(fact), 'saveFact');
    this.audit(session.account, 'fact.put', 'fact', fact.id, {
      scopeType: fact.scopeType,
      scopeId: fact.scopeId,
      category: fact.category,
    });
    return fact;
  }

  searchFacts(sessionToken: string, query: CloudFactSearchQuery): CloudFactSearchResult[] {
    const session = this.requireSession(sessionToken);
    const allowed = this.allowedScopeSet(session);
    const includeScopes = query.includeScopes ? new Set(query.includeScopes) : null;
    const queryText = normalizeSearchText(query.query);
    const limit = Math.min(Math.max(query.limit ?? 10, 1), 50);
    const results = this.resolveSync(this.store.listFactsByTenant(session.account.tenantId), 'listFactsByTenant')
      .filter((fact) => allowed.has(`${fact.scopeType}:${fact.scopeId}`))
      .filter((fact) => (includeScopes ? includeScopes.has(fact.scopeType) : true))
      .filter((fact) => (query.category ? fact.category === query.category : true))
      .filter((fact) => (query.projectId ? fact.projectId === query.projectId : true))
      .filter((fact) => (query.sourceAgent ? fact.sourceAgent === query.sourceAgent : true))
      .map((fact) => {
        const haystack = `${fact.category}\n${fact.fact}\n${fact.tags.join(' ')}`;
        return {
          fact,
          score: scoreText(haystack, queryText) + fact.confidence,
          snippet: makeSnippet(haystack, queryText),
        };
      })
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || b.fact.updatedAt.localeCompare(a.fact.updatedAt))
      .slice(0, limit);

    this.audit(session.account, 'fact.search', 'session', session.loginId, { count: String(results.length) });
    return results;
  }

  getSessionContext(sessionToken: string): { session: CloudLoginSession; visibleScopes: Array<{ scopeType: CloudContextScopeType; scopeId: string }> } {
    const session = this.requireSession(sessionToken);
    return { session, visibleScopes: visibleScopesFor(session.account, session.memberships) };
  }

  private requireSession(sessionToken: string): CloudLoginSession {
    const session = this.resolveSync(this.store.findSession(sessionToken), 'findSession');
    if (!session) {
      throw new MemoryBankCloudAuthError('Invalid memory-bank-cloud session');
    }
    if (Date.parse(session.expiresAt) <= this.now().getTime()) {
      throw new MemoryBankCloudAuthError('Memory-bank-cloud session is expired');
    }
    return session;
  }

  private assertCanWriteScope(session: CloudLoginSession, scopeType: CloudContextScopeType, scopeId: string): void {
    const allowed = this.canReadScope(session, scopeType, scopeId);
    if (!allowed) {
      throw new MemoryBankCloudAuthorizationError(`Cannot write ${scopeType}:${scopeId}`);
    }
  }

  private canReadScope(session: CloudLoginSession, scopeType: CloudContextScopeType, scopeId: string): boolean {
    return visibleScopesFor(session.account, session.memberships).some(
      (scope) => scope.scopeType === scopeType && scope.scopeId === scopeId
    );
  }

  private allowedScopeSet(session: CloudLoginSession): Set<string> {
    return new Set(visibleScopesFor(session.account, session.memberships).map((scope) => `${scope.scopeType}:${scope.scopeId}`));
  }

  private audit(account: CloudAccountContext, action: string, targetType: string, targetId: string, metadata: Record<string, string>): void {
    this.resolveSync(this.store.saveAudit({
      id: randomUUID(),
      tenantId: account.tenantId,
      actorUserId: account.userId,
      action,
      targetType,
      targetId,
      createdAt: this.now().toISOString(),
      metadata,
    }), 'saveAudit');
  }

  private auditTokenIssue(issuer: CloudTokenIssuerContext, account: CloudAccountContext, record: CloudLoginTokenRecord): void {
    this.resolveSync(this.store.saveAudit({
      id: randomUUID(),
      tenantId: issuer.tenantId,
      actorUserId: issuer.userId,
      action: 'token.issue',
      targetType: 'token',
      targetId: record.id,
      createdAt: this.now().toISOString(),
      metadata: {
        purpose: record.purpose,
        targetUserId: account.userId,
        issuerScopeType: issuer.scopeType,
        issuerScopeId: issuer.scopeId,
      },
    }), 'saveAudit');
  }

  private resolveSync<T>(value: T | Promise<T>, operation: string): T {
    if (isPromiseLike(value)) {
      throw new MemoryBankCloudStoreModeError(`${operation} returned a Promise. Use an async host adapter for remote stores.`);
    }
    return value;
  }
}


export class AsyncMemoryBankCloudHost {
  readonly store: MemoryBankCloudStore;
  private readonly now: () => Date;
  private readonly tokenFactory: () => string;

  constructor(options: MemoryBankCloudHostOptions = {}) {
    this.store = options.store ?? new InMemoryMemoryBankCloudStore();
    this.now = options.now ?? (() => new Date());
    this.tokenFactory = options.tokenFactory ?? (() => `mbc_${randomBytes(32).toString('base64url')}`);
  }

  async issueLoginToken(input: {
    issuer: CloudTokenIssuerContext;
    account: CloudAccountContext;
    memberships?: CloudMembership[];
    purpose?: CloudTokenPurpose;
    expiresInSeconds?: number;
  }): Promise<CloudLoginTokenIssue> {
    const createdAt = this.now().toISOString();
    const expiresAt = new Date(this.now().getTime() + (input.expiresInSeconds ?? 3600) * 1000).toISOString();
    const token = this.tokenFactory();
    assertIssuerCanIssue(input.issuer, input.account, input.memberships ?? []);
    const memberships = normalizeMemberships(input.account, input.issuer, input.memberships ?? []);
    const record: CloudLoginTokenRecord = {
      id: randomUUID(),
      tokenHash: hashToken(token),
      purpose: input.purpose ?? 'mcp_login',
      issuer: input.issuer,
      account: input.account,
      memberships,
      createdAt,
      expiresAt,
      revokedAt: null,
    };
    await this.store.saveToken(record);
    await this.auditTokenIssue(input.issuer, input.account, record);
    return { token, tokenId: record.id, expiresAt, issuer: input.issuer, account: input.account };
  }

  async loginWithToken(token: string, overrides: Partial<Pick<CloudAccountContext, 'terminalId' | 'sessionId' | 'sourceAgent'>> = {}): Promise<CloudLoginSession> {
    const record = await this.store.findTokenByHash(hashToken(token));
    if (!record) throw new MemoryBankCloudAuthError('Invalid memory-bank-cloud token');
    const now = this.now().getTime();
    if (record.revokedAt) throw new MemoryBankCloudAuthError('Memory-bank-cloud token is revoked');
    if (Date.parse(record.expiresAt) <= now) throw new MemoryBankCloudAuthError('Memory-bank-cloud token is expired');
    const account: CloudAccountContext = {
      ...record.account,
      terminalId: overrides.terminalId ?? record.account.terminalId,
      sessionId: overrides.sessionId ?? record.account.sessionId ?? randomUUID(),
      sourceAgent: overrides.sourceAgent ?? record.account.sourceAgent,
    };
    const session: CloudLoginSession = {
      sessionToken: `mbcs_${randomBytes(32).toString('base64url')}`,
      loginId: randomUUID(),
      account,
      memberships: record.memberships,
      createdAt: this.now().toISOString(),
      expiresAt: record.expiresAt,
    };
    await this.store.saveSession(session);
    await this.audit(account, 'token.login', 'token', record.id, { sourceAgent: account.sourceAgent });
    return session;
  }

  async putContext(sessionToken: string, input: CloudContextInput): Promise<CloudContextEntry> {
    const session = await this.requireSession(sessionToken);
    const scopeId = input.scopeId ?? defaultScopeId(session.account, input.scopeType);
    this.assertCanWriteScope(session, input.scopeType, scopeId);
    const now = this.now().toISOString();
    const entry: CloudContextEntry = {
      id: deriveRowId(session.account, input.scopeType, scopeId, input.idempotencyKey),
      tenantId: session.account.tenantId,
      scopeType: input.scopeType,
      scopeId,
      orgId: session.account.orgId,
      teamId: session.account.teamId,
      projectId: session.account.projectId,
      userId: session.account.userId,
      sourceAgent: session.account.sourceAgent,
      title: input.title,
      body: input.body,
      tags: input.tags ?? [],
      sensitivity: input.sensitivity ?? 'internal',
      createdAt: now,
      updatedAt: now,
    };
    await this.store.saveContext(entry);
    await this.audit(session.account, 'context.put', 'context_entry', entry.id, { scopeType: entry.scopeType, scopeId: entry.scopeId });
    return entry;
  }

  async getContextBundle(sessionToken: string, query: CloudContextQuery = {}): Promise<CloudContextBundle> {
    const session = await this.requireSession(sessionToken);
    const visibleScopes = visibleScopesFor(session.account, session.memberships);
    const allowed = new Set(visibleScopes.map((scope) => `${scope.scopeType}:${scope.scopeId}`));
    const queryText = query.query?.trim().toLowerCase();
    const includeScopes = query.includeScopes ? new Set(query.includeScopes) : null;
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const entries = (await this.store.listContextByTenant(session.account.tenantId))
      .filter((entry) => allowed.has(`${entry.scopeType}:${entry.scopeId}`))
      .filter((entry) => (includeScopes ? includeScopes.has(entry.scopeType) : true))
      .filter((entry) => {
        if (!queryText) return true;
        const haystack = `${entry.title}\n${entry.body}\n${entry.tags.join(' ')}`.toLowerCase();
        return haystack.includes(queryText);
      })
      .sort((a, b) => scopeRank(a.scopeType) - scopeRank(b.scopeType) || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
    await this.audit(session.account, 'context.bundle', 'session', session.loginId, { count: String(entries.length) });
    return { account: session.account, visibleScopes, entries, generatedAt: this.now().toISOString() };
  }

  async ingestExchange(sessionToken: string, input: CloudExchangeInput): Promise<CloudExchangeRecord> {
    const session = await this.requireSession(sessionToken);
    const scopeId = input.scopeId ?? defaultScopeId(session.account, input.scopeType);
    this.assertCanWriteScope(session, input.scopeType, scopeId);
    const createdAt = input.createdAt ?? this.now().toISOString();
    const exchange: CloudExchangeRecord = {
      id: deriveRowId(session.account, input.scopeType, scopeId, input.idempotencyKey),
      tenantId: session.account.tenantId,
      scopeType: input.scopeType,
      scopeId,
      orgId: session.account.orgId,
      teamId: session.account.teamId,
      projectId: session.account.projectId,
      userId: session.account.userId,
      sourceAgent: session.account.sourceAgent,
      sourceId: input.sourceId ?? randomUUID(),
      projectPath: input.projectPath,
      title: input.title,
      content: input.content,
      tags: input.tags ?? [],
      createdAt,
      updatedAt: this.now().toISOString(),
    };
    await this.store.saveExchange(exchange);
    await this.audit(session.account, 'exchange.ingest', 'exchange', exchange.id, { scopeType: exchange.scopeType, scopeId: exchange.scopeId, sourceAgent: exchange.sourceAgent });
    return exchange;
  }

  async searchExchanges(sessionToken: string, query: CloudSearchQuery): Promise<CloudSearchResult[]> {
    const session = await this.requireSession(sessionToken);
    const allowed = this.allowedScopeSet(session);
    const includeScopes = query.includeScopes ? new Set(query.includeScopes) : null;
    const queryText = normalizeSearchText(query.query);
    const limit = Math.min(Math.max(query.limit ?? 10, 1), 50);
    const results = (await this.store.listExchangesByTenant(session.account.tenantId))
      .filter((exchange) => allowed.has(`${exchange.scopeType}:${exchange.scopeId}`))
      .filter((exchange) => (includeScopes ? includeScopes.has(exchange.scopeType) : true))
      .filter((exchange) => (query.projectId ? exchange.projectId === query.projectId : true))
      .filter((exchange) => (query.projectPath ? exchange.projectPath === query.projectPath : true))
      .filter((exchange) => (query.sourceAgent ? exchange.sourceAgent === query.sourceAgent : true))
      .map((exchange) => {
        const haystack = `${exchange.title}\n${exchange.content}\n${exchange.tags.join(' ')}`;
        return { exchange, score: scoreText(haystack, queryText), snippet: makeSnippet(haystack, queryText) };
      })
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || b.exchange.updatedAt.localeCompare(a.exchange.updatedAt))
      .slice(0, limit);
    await this.audit(session.account, 'exchange.search', 'session', session.loginId, { count: String(results.length) });
    return results;
  }

  async readExchange(sessionToken: string, exchangeId: string): Promise<CloudReadResult> {
    const session = await this.requireSession(sessionToken);
    const exchange = await this.store.findExchangeById(session.account.tenantId, exchangeId);
    if (!exchange || !this.canReadScope(session, exchange.scopeType, exchange.scopeId)) {
      throw new MemoryBankCloudAuthorizationError('Conversation is not visible to this memory-bank-cloud session');
    }
    await this.audit(session.account, 'exchange.read', 'exchange', exchange.id, { scopeType: exchange.scopeType, scopeId: exchange.scopeId });
    return { exchange, context: await this.getContextBundle(sessionToken, { includeScopes: [exchange.scopeType], limit: 20 }) };
  }

  async putFact(sessionToken: string, input: CloudFactInput): Promise<CloudFactRecord> {
    const session = await this.requireSession(sessionToken);
    const scopeId = input.scopeId ?? defaultScopeId(session.account, input.scopeType);
    this.assertCanWriteScope(session, input.scopeType, scopeId);
    if (input.sourceExchangeId) {
      const exchange = await this.store.findExchangeById(session.account.tenantId, input.sourceExchangeId);
      if (!exchange || !this.canReadScope(session, exchange.scopeType, exchange.scopeId)) {
        throw new MemoryBankCloudAuthorizationError('Fact source exchange is not visible to this memory-bank-cloud session');
      }
    }
    const now = this.now().toISOString();
    const fact: CloudFactRecord = {
      id: deriveRowId(session.account, input.scopeType, scopeId, input.idempotencyKey),
      tenantId: session.account.tenantId,
      scopeType: input.scopeType,
      scopeId,
      orgId: session.account.orgId,
      teamId: session.account.teamId,
      projectId: session.account.projectId,
      userId: session.account.userId,
      sourceAgent: session.account.sourceAgent,
      category: input.category,
      fact: input.fact,
      confidence: Math.min(Math.max(input.confidence ?? 0.8, 0), 1),
      sourceExchangeId: input.sourceExchangeId,
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
    };
    await this.store.saveFact(fact);
    await this.audit(session.account, 'fact.put', 'fact', fact.id, { scopeType: fact.scopeType, scopeId: fact.scopeId, category: fact.category });
    return fact;
  }

  async searchFacts(sessionToken: string, query: CloudFactSearchQuery): Promise<CloudFactSearchResult[]> {
    const session = await this.requireSession(sessionToken);
    const allowed = this.allowedScopeSet(session);
    const includeScopes = query.includeScopes ? new Set(query.includeScopes) : null;
    const queryText = normalizeSearchText(query.query);
    const limit = Math.min(Math.max(query.limit ?? 10, 1), 50);
    const results = (await this.store.listFactsByTenant(session.account.tenantId))
      .filter((fact) => allowed.has(`${fact.scopeType}:${fact.scopeId}`))
      .filter((fact) => (includeScopes ? includeScopes.has(fact.scopeType) : true))
      .filter((fact) => (query.category ? fact.category === query.category : true))
      .filter((fact) => (query.projectId ? fact.projectId === query.projectId : true))
      .filter((fact) => (query.sourceAgent ? fact.sourceAgent === query.sourceAgent : true))
      .map((fact) => {
        const haystack = `${fact.category}\n${fact.fact}\n${fact.tags.join(' ')}`;
        return { fact, score: scoreText(haystack, queryText) + fact.confidence, snippet: makeSnippet(haystack, queryText) };
      })
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || b.fact.updatedAt.localeCompare(a.fact.updatedAt))
      .slice(0, limit);
    await this.audit(session.account, 'fact.search', 'session', session.loginId, { count: String(results.length) });
    return results;
  }

  async getSessionContext(sessionToken: string): Promise<{ session: CloudLoginSession; visibleScopes: Array<{ scopeType: CloudContextScopeType; scopeId: string }> }> {
    const session = await this.requireSession(sessionToken);
    return { session, visibleScopes: visibleScopesFor(session.account, session.memberships) };
  }

  private async requireSession(sessionToken: string): Promise<CloudLoginSession> {
    const session = await this.store.findSession(sessionToken);
    if (!session) throw new MemoryBankCloudAuthError('Invalid memory-bank-cloud session');
    if (Date.parse(session.expiresAt) <= this.now().getTime()) throw new MemoryBankCloudAuthError('Memory-bank-cloud session is expired');
    return session;
  }

  private assertCanWriteScope(session: CloudLoginSession, scopeType: CloudContextScopeType, scopeId: string): void {
    if (!this.canReadScope(session, scopeType, scopeId)) throw new MemoryBankCloudAuthorizationError(`Cannot write ${scopeType}:${scopeId}`);
  }

  private canReadScope(session: CloudLoginSession, scopeType: CloudContextScopeType, scopeId: string): boolean {
    return visibleScopesFor(session.account, session.memberships).some((scope) => scope.scopeType === scopeType && scope.scopeId === scopeId);
  }

  private allowedScopeSet(session: CloudLoginSession): Set<string> {
    return new Set(visibleScopesFor(session.account, session.memberships).map((scope) => `${scope.scopeType}:${scope.scopeId}`));
  }

  private async audit(account: CloudAccountContext, action: string, targetType: string, targetId: string, metadata: Record<string, string>): Promise<void> {
    await this.store.saveAudit({ id: randomUUID(), tenantId: account.tenantId, actorUserId: account.userId, action, targetType, targetId, createdAt: this.now().toISOString(), metadata });
  }

  private async auditTokenIssue(issuer: CloudTokenIssuerContext, account: CloudAccountContext, record: CloudLoginTokenRecord): Promise<void> {
    await this.store.saveAudit({
      id: randomUUID(),
      tenantId: issuer.tenantId,
      actorUserId: issuer.userId,
      action: 'token.issue',
      targetType: 'token',
      targetId: record.id,
      createdAt: this.now().toISOString(),
      metadata: { purpose: record.purpose, targetUserId: account.userId, issuerScopeType: issuer.scopeType, issuerScopeId: issuer.scopeId },
    });
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Derive a deterministic row id from the writer's (tenant, user, scope) + an idempotency key.
 * Same inputs → same id (idempotent retries). Because the id is namespaced by the writer's
 * own tenant/user/scope, a caller cannot craft a key that maps onto a row id belonging to a
 * scope they are not authorized to write — preventing cross-scope row hijack/overwrite.
 * Falls back to a random UUID when no key is supplied.
 */
function deriveRowId(
  account: CloudAccountContext,
  scopeType: CloudContextScopeType,
  scopeId: string,
  idempotencyKey?: string
): string {
  if (!idempotencyKey) return randomUUID();
  const digest = createHash('sha1')
    .update([account.tenantId, account.userId, scopeType, scopeId, idempotencyKey].join(' '))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // UUID version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function visibleScopesFor(account: CloudAccountContext, memberships: CloudMembership[]): Array<{ scopeType: CloudContextScopeType; scopeId: string }> {
  const scopes = new Map<string, { scopeType: CloudContextScopeType; scopeId: string }>();
  const add = (scopeType: CloudContextScopeType, scopeId: string) => {
    scopes.set(`${scopeType}:${scopeId}`, { scopeType, scopeId });
  };

  for (const membership of memberships) {
    if (membership.tenantId !== account.tenantId || membership.userId !== account.userId) continue;
    add(membership.scopeType, membership.scopeId);
  }

  return [...scopes.values()].sort((a, b) => scopeRank(a.scopeType) - scopeRank(b.scopeType));
}

function normalizeMemberships(account: CloudAccountContext, issuer: CloudTokenIssuerContext, memberships: CloudMembership[]): CloudMembership[] {
  const defaults: CloudMembership[] = [
    { tenantId: account.tenantId, userId: account.userId, scopeType: 'company', scopeId: account.tenantId, role: 'member' },
    { tenantId: account.tenantId, userId: account.userId, scopeType: 'org', scopeId: account.orgId, role: 'member' },
    { tenantId: account.tenantId, userId: account.userId, scopeType: 'team', scopeId: account.teamId, role: 'member' },
    { tenantId: account.tenantId, userId: account.userId, scopeType: 'project', scopeId: account.projectId, role: 'member' },
    { tenantId: account.tenantId, userId: account.userId, scopeType: 'personal', scopeId: account.userId, role: 'owner' },
  ];
  const byKey = new Map<string, CloudMembership>();
  for (const membership of defaults) {
    if (!isScopeInsideIssuerBoundary(issuer, account, membership.scopeType, membership.scopeId)) continue;
    byKey.set(`${membership.scopeType}:${membership.scopeId}`, membership);
  }
  for (const membership of memberships) {
    assertMembershipBelongsToIssuedSubject(issuer, account, membership);
    byKey.set(`${membership.scopeType}:${membership.scopeId}`, membership);
  }
  return [...byKey.values()];
}

function assertIssuerCanIssue(issuer: CloudTokenIssuerContext, account: CloudAccountContext, memberships: CloudMembership[]): void {
  if (issuer.tenantId !== account.tenantId) {
    throw new MemoryBankCloudAuthorizationError('Token issuer cannot issue across tenant/company boundary');
  }
  if (!['owner', 'admin', 'service'].includes(issuer.role)) {
    throw new MemoryBankCloudAuthorizationError('Token issuer must be owner, admin, or service');
  }
  if (issuer.scopeId !== defaultScopeId(account, issuer.scopeType)) {
    throw new MemoryBankCloudAuthorizationError(`Token issuer cannot issue outside ${issuer.scopeType}:${issuer.scopeId}`);
  }
  for (const membership of memberships) {
    assertMembershipBelongsToIssuedSubject(issuer, account, membership);
  }
}

function assertMembershipBelongsToIssuedSubject(issuer: CloudTokenIssuerContext, account: CloudAccountContext, membership: CloudMembership): void {
  if (membership.tenantId !== account.tenantId || membership.userId !== account.userId) {
    throw new MemoryBankCloudAuthorizationError('Token membership must belong to the issued account tenant/user');
  }
  if (!isScopeInsideIssuerBoundary(issuer, account, membership.scopeType, membership.scopeId)) {
    throw new MemoryBankCloudAuthorizationError(`Token membership exceeds issuer scope: ${membership.scopeType}:${membership.scopeId}`);
  }
}

function isScopeInsideIssuerBoundary(
  issuer: CloudTokenIssuerContext,
  account: CloudAccountContext,
  scopeType: CloudContextScopeType,
  scopeId: string
): boolean {
  if (issuer.tenantId !== account.tenantId) return false;
  if (issuer.scopeId !== defaultScopeId(account, issuer.scopeType)) return false;
  if (scopeId !== defaultScopeId(account, scopeType)) return false;
  return scopeRank(scopeType) >= scopeRank(issuer.scopeType);
}

function defaultScopeId(account: CloudAccountContext, scopeType: CloudContextScopeType): string {
  switch (scopeType) {
    case 'company':
      return account.tenantId;
    case 'org':
      return account.orgId;
    case 'team':
      return account.teamId;
    case 'project':
      return account.projectId;
    case 'personal':
      return account.userId;
  }
}

function scopeRank(scopeType: CloudContextScopeType): number {
  switch (scopeType) {
    case 'company':
      return 0;
    case 'org':
      return 1;
    case 'team':
      return 2;
    case 'project':
      return 3;
    case 'personal':
      return 4;
  }
}

function normalizeSearchText(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function scoreText(haystack: string, queryTerms: string[]): number {
  const normalized = haystack.toLowerCase();
  if (queryTerms.length === 0) return 1;
  let score = 0;
  for (const term of queryTerms) {
    const count = normalized.split(term).length - 1;
    if (count > 0) score += count;
  }
  return score;
}

function makeSnippet(haystack: string, queryTerms: string[]): string {
  const normalized = haystack.toLowerCase();
  const firstTerm = queryTerms.find((term) => normalized.includes(term));
  if (!firstTerm) return haystack.slice(0, 240);
  const index = normalized.indexOf(firstTerm);
  const start = Math.max(index - 80, 0);
  const end = Math.min(index + 160, haystack.length);
  return `${start > 0 ? '…' : ''}${haystack.slice(start, end)}${end < haystack.length ? '…' : ''}`;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof (value as { then?: unknown }).then === 'function';
}
