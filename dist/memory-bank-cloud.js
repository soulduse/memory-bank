import { createHash, randomBytes, randomUUID } from 'crypto';
export class InMemoryMemoryBankCloudStore {
    tokensByHash = new Map();
    sessionsByToken = new Map();
    contextEntries = [];
    exchanges = [];
    facts = [];
    auditEvents = [];
    saveToken(record) {
        this.tokensByHash.set(record.tokenHash, record);
    }
    findTokenByHash(tokenHash) {
        return this.tokensByHash.get(tokenHash) ?? null;
    }
    saveSession(session) {
        this.sessionsByToken.set(session.sessionToken, session);
    }
    findSession(sessionToken) {
        return this.sessionsByToken.get(sessionToken) ?? null;
    }
    saveContext(entry) {
        const index = this.contextEntries.findIndex((existing) => existing.id === entry.id);
        if (index >= 0) {
            this.contextEntries[index] = entry;
            return;
        }
        this.contextEntries.push(entry);
    }
    listContextByTenant(tenantId) {
        return this.contextEntries.filter((entry) => entry.tenantId === tenantId);
    }
    saveExchange(record) {
        const index = this.exchanges.findIndex((existing) => existing.id === record.id);
        if (index >= 0) {
            this.exchanges[index] = record;
            return;
        }
        this.exchanges.push(record);
    }
    findExchangeById(tenantId, id) {
        return this.exchanges.find((exchange) => exchange.tenantId === tenantId && exchange.id === id) ?? null;
    }
    listExchangesByTenant(tenantId) {
        return this.exchanges.filter((exchange) => exchange.tenantId === tenantId);
    }
    saveFact(record) {
        const index = this.facts.findIndex((existing) => existing.id === record.id);
        if (index >= 0) {
            this.facts[index] = record;
            return;
        }
        this.facts.push(record);
    }
    listFactsByTenant(tenantId) {
        return this.facts.filter((fact) => fact.tenantId === tenantId);
    }
    saveAudit(event) {
        this.auditEvents.push(event);
    }
    listAuditEvents(tenantId) {
        return this.auditEvents.filter((event) => event.tenantId === tenantId);
    }
}
export class MemoryBankCloudAuthError extends Error {
}
export class MemoryBankCloudAuthorizationError extends Error {
}
export class MemoryBankCloudStoreModeError extends Error {
}
export class MemoryBankCloudHost {
    store;
    now;
    tokenFactory;
    constructor(options = {}) {
        this.store = options.store ?? new InMemoryMemoryBankCloudStore();
        this.now = options.now ?? (() => new Date());
        this.tokenFactory = options.tokenFactory ?? (() => `mbc_${randomBytes(32).toString('base64url')}`);
    }
    issueLoginToken(input) {
        const createdAt = this.now().toISOString();
        const expiresAt = new Date(this.now().getTime() + (input.expiresInSeconds ?? 3600) * 1000).toISOString();
        const token = this.tokenFactory();
        assertIssuerCanIssue(input.issuer, input.account, input.memberships ?? []);
        const memberships = normalizeMemberships(input.account, input.issuer, input.memberships ?? []);
        const record = {
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
    loginWithToken(token, overrides = {}) {
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
        const account = {
            ...record.account,
            terminalId: overrides.terminalId ?? record.account.terminalId,
            sessionId: overrides.sessionId ?? record.account.sessionId ?? randomUUID(),
            sourceAgent: overrides.sourceAgent ?? record.account.sourceAgent,
        };
        const session = {
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
    putContext(sessionToken, input) {
        const session = this.requireSession(sessionToken);
        const scopeId = input.scopeId ?? defaultScopeId(session.account, input.scopeType);
        this.assertCanWriteScope(session, input.scopeType, scopeId);
        const now = this.now().toISOString();
        const entry = {
            id: input.id ?? randomUUID(),
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
    getContextBundle(sessionToken, query = {}) {
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
            if (!queryText)
                return true;
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
    ingestExchange(sessionToken, input) {
        const session = this.requireSession(sessionToken);
        const scopeId = input.scopeId ?? defaultScopeId(session.account, input.scopeType);
        this.assertCanWriteScope(session, input.scopeType, scopeId);
        const createdAt = input.createdAt ?? this.now().toISOString();
        const exchange = {
            id: input.id ?? randomUUID(),
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
    searchExchanges(sessionToken, query) {
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
    readExchange(sessionToken, exchangeId) {
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
    putFact(sessionToken, input) {
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
        const fact = {
            id: input.id ?? randomUUID(),
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
    searchFacts(sessionToken, query) {
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
    getSessionContext(sessionToken) {
        const session = this.requireSession(sessionToken);
        return { session, visibleScopes: visibleScopesFor(session.account, session.memberships) };
    }
    requireSession(sessionToken) {
        const session = this.resolveSync(this.store.findSession(sessionToken), 'findSession');
        if (!session) {
            throw new MemoryBankCloudAuthError('Invalid memory-bank-cloud session');
        }
        if (Date.parse(session.expiresAt) <= this.now().getTime()) {
            throw new MemoryBankCloudAuthError('Memory-bank-cloud session is expired');
        }
        return session;
    }
    assertCanWriteScope(session, scopeType, scopeId) {
        const allowed = this.canReadScope(session, scopeType, scopeId);
        if (!allowed) {
            throw new MemoryBankCloudAuthorizationError(`Cannot write ${scopeType}:${scopeId}`);
        }
    }
    canReadScope(session, scopeType, scopeId) {
        return visibleScopesFor(session.account, session.memberships).some((scope) => scope.scopeType === scopeType && scope.scopeId === scopeId);
    }
    allowedScopeSet(session) {
        return new Set(visibleScopesFor(session.account, session.memberships).map((scope) => `${scope.scopeType}:${scope.scopeId}`));
    }
    audit(account, action, targetType, targetId, metadata) {
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
    auditTokenIssue(issuer, account, record) {
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
    resolveSync(value, operation) {
        if (isPromiseLike(value)) {
            throw new MemoryBankCloudStoreModeError(`${operation} returned a Promise. Use an async host adapter for remote stores.`);
        }
        return value;
    }
}
export class AsyncMemoryBankCloudHost {
    store;
    now;
    tokenFactory;
    constructor(options = {}) {
        this.store = options.store ?? new InMemoryMemoryBankCloudStore();
        this.now = options.now ?? (() => new Date());
        this.tokenFactory = options.tokenFactory ?? (() => `mbc_${randomBytes(32).toString('base64url')}`);
    }
    async issueLoginToken(input) {
        const createdAt = this.now().toISOString();
        const expiresAt = new Date(this.now().getTime() + (input.expiresInSeconds ?? 3600) * 1000).toISOString();
        const token = this.tokenFactory();
        assertIssuerCanIssue(input.issuer, input.account, input.memberships ?? []);
        const memberships = normalizeMemberships(input.account, input.issuer, input.memberships ?? []);
        const record = {
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
    async loginWithToken(token, overrides = {}) {
        const record = await this.store.findTokenByHash(hashToken(token));
        if (!record)
            throw new MemoryBankCloudAuthError('Invalid memory-bank-cloud token');
        const now = this.now().getTime();
        if (record.revokedAt)
            throw new MemoryBankCloudAuthError('Memory-bank-cloud token is revoked');
        if (Date.parse(record.expiresAt) <= now)
            throw new MemoryBankCloudAuthError('Memory-bank-cloud token is expired');
        const account = {
            ...record.account,
            terminalId: overrides.terminalId ?? record.account.terminalId,
            sessionId: overrides.sessionId ?? record.account.sessionId ?? randomUUID(),
            sourceAgent: overrides.sourceAgent ?? record.account.sourceAgent,
        };
        const session = {
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
    async putContext(sessionToken, input) {
        const session = await this.requireSession(sessionToken);
        const scopeId = input.scopeId ?? defaultScopeId(session.account, input.scopeType);
        this.assertCanWriteScope(session, input.scopeType, scopeId);
        const now = this.now().toISOString();
        const entry = {
            id: input.id ?? randomUUID(),
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
    async getContextBundle(sessionToken, query = {}) {
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
            if (!queryText)
                return true;
            const haystack = `${entry.title}\n${entry.body}\n${entry.tags.join(' ')}`.toLowerCase();
            return haystack.includes(queryText);
        })
            .sort((a, b) => scopeRank(a.scopeType) - scopeRank(b.scopeType) || b.updatedAt.localeCompare(a.updatedAt))
            .slice(0, limit);
        await this.audit(session.account, 'context.bundle', 'session', session.loginId, { count: String(entries.length) });
        return { account: session.account, visibleScopes, entries, generatedAt: this.now().toISOString() };
    }
    async ingestExchange(sessionToken, input) {
        const session = await this.requireSession(sessionToken);
        const scopeId = input.scopeId ?? defaultScopeId(session.account, input.scopeType);
        this.assertCanWriteScope(session, input.scopeType, scopeId);
        const createdAt = input.createdAt ?? this.now().toISOString();
        const exchange = {
            id: input.id ?? randomUUID(),
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
    async searchExchanges(sessionToken, query) {
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
    async readExchange(sessionToken, exchangeId) {
        const session = await this.requireSession(sessionToken);
        const exchange = await this.store.findExchangeById(session.account.tenantId, exchangeId);
        if (!exchange || !this.canReadScope(session, exchange.scopeType, exchange.scopeId)) {
            throw new MemoryBankCloudAuthorizationError('Conversation is not visible to this memory-bank-cloud session');
        }
        await this.audit(session.account, 'exchange.read', 'exchange', exchange.id, { scopeType: exchange.scopeType, scopeId: exchange.scopeId });
        return { exchange, context: await this.getContextBundle(sessionToken, { includeScopes: [exchange.scopeType], limit: 20 }) };
    }
    async putFact(sessionToken, input) {
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
        const fact = {
            id: input.id ?? randomUUID(),
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
    async searchFacts(sessionToken, query) {
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
    async getSessionContext(sessionToken) {
        const session = await this.requireSession(sessionToken);
        return { session, visibleScopes: visibleScopesFor(session.account, session.memberships) };
    }
    async requireSession(sessionToken) {
        const session = await this.store.findSession(sessionToken);
        if (!session)
            throw new MemoryBankCloudAuthError('Invalid memory-bank-cloud session');
        if (Date.parse(session.expiresAt) <= this.now().getTime())
            throw new MemoryBankCloudAuthError('Memory-bank-cloud session is expired');
        return session;
    }
    assertCanWriteScope(session, scopeType, scopeId) {
        if (!this.canReadScope(session, scopeType, scopeId))
            throw new MemoryBankCloudAuthorizationError(`Cannot write ${scopeType}:${scopeId}`);
    }
    canReadScope(session, scopeType, scopeId) {
        return visibleScopesFor(session.account, session.memberships).some((scope) => scope.scopeType === scopeType && scope.scopeId === scopeId);
    }
    allowedScopeSet(session) {
        return new Set(visibleScopesFor(session.account, session.memberships).map((scope) => `${scope.scopeType}:${scope.scopeId}`));
    }
    async audit(account, action, targetType, targetId, metadata) {
        await this.store.saveAudit({ id: randomUUID(), tenantId: account.tenantId, actorUserId: account.userId, action, targetType, targetId, createdAt: this.now().toISOString(), metadata });
    }
    async auditTokenIssue(issuer, account, record) {
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
export function hashToken(token) {
    return createHash('sha256').update(token).digest('hex');
}
export function visibleScopesFor(account, memberships) {
    const scopes = new Map();
    const add = (scopeType, scopeId) => {
        scopes.set(`${scopeType}:${scopeId}`, { scopeType, scopeId });
    };
    for (const membership of memberships) {
        if (membership.tenantId !== account.tenantId || membership.userId !== account.userId)
            continue;
        add(membership.scopeType, membership.scopeId);
    }
    return [...scopes.values()].sort((a, b) => scopeRank(a.scopeType) - scopeRank(b.scopeType));
}
function normalizeMemberships(account, issuer, memberships) {
    const defaults = [
        { tenantId: account.tenantId, userId: account.userId, scopeType: 'company', scopeId: account.tenantId, role: 'member' },
        { tenantId: account.tenantId, userId: account.userId, scopeType: 'org', scopeId: account.orgId, role: 'member' },
        { tenantId: account.tenantId, userId: account.userId, scopeType: 'team', scopeId: account.teamId, role: 'member' },
        { tenantId: account.tenantId, userId: account.userId, scopeType: 'project', scopeId: account.projectId, role: 'member' },
        { tenantId: account.tenantId, userId: account.userId, scopeType: 'personal', scopeId: account.userId, role: 'owner' },
    ];
    const byKey = new Map();
    for (const membership of defaults) {
        if (!isScopeInsideIssuerBoundary(issuer, account, membership.scopeType, membership.scopeId))
            continue;
        byKey.set(`${membership.scopeType}:${membership.scopeId}`, membership);
    }
    for (const membership of memberships) {
        assertMembershipBelongsToIssuedSubject(issuer, account, membership);
        byKey.set(`${membership.scopeType}:${membership.scopeId}`, membership);
    }
    return [...byKey.values()];
}
function assertIssuerCanIssue(issuer, account, memberships) {
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
function assertMembershipBelongsToIssuedSubject(issuer, account, membership) {
    if (membership.tenantId !== account.tenantId || membership.userId !== account.userId) {
        throw new MemoryBankCloudAuthorizationError('Token membership must belong to the issued account tenant/user');
    }
    if (!isScopeInsideIssuerBoundary(issuer, account, membership.scopeType, membership.scopeId)) {
        throw new MemoryBankCloudAuthorizationError(`Token membership exceeds issuer scope: ${membership.scopeType}:${membership.scopeId}`);
    }
}
function isScopeInsideIssuerBoundary(issuer, account, scopeType, scopeId) {
    if (issuer.tenantId !== account.tenantId)
        return false;
    if (issuer.scopeId !== defaultScopeId(account, issuer.scopeType))
        return false;
    if (scopeId !== defaultScopeId(account, scopeType))
        return false;
    return scopeRank(scopeType) >= scopeRank(issuer.scopeType);
}
function defaultScopeId(account, scopeType) {
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
function scopeRank(scopeType) {
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
function normalizeSearchText(query) {
    return query
        .toLowerCase()
        .split(/\s+/)
        .map((part) => part.trim())
        .filter(Boolean);
}
function scoreText(haystack, queryTerms) {
    const normalized = haystack.toLowerCase();
    if (queryTerms.length === 0)
        return 1;
    let score = 0;
    for (const term of queryTerms) {
        const count = normalized.split(term).length - 1;
        if (count > 0)
            score += count;
    }
    return score;
}
function makeSnippet(haystack, queryTerms) {
    const normalized = haystack.toLowerCase();
    const firstTerm = queryTerms.find((term) => normalized.includes(term));
    if (!firstTerm)
        return haystack.slice(0, 240);
    const index = normalized.indexOf(firstTerm);
    const start = Math.max(index - 80, 0);
    const end = Math.min(index + 160, haystack.length);
    return `${start > 0 ? '…' : ''}${haystack.slice(start, end)}${end < haystack.length ? '…' : ''}`;
}
function isPromiseLike(value) {
    return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function';
}
