export class SupabaseMemoryBankCloudStore {
    url;
    privilegedToken;
    fetchImpl;
    schema;
    constructor(options) {
        this.url = options.url.replace(/\/$/, '');
        this.privilegedToken = options.privilegedToken;
        this.fetchImpl = options.fetch ?? globalThis.fetch;
        this.schema = options.schema ?? 'public';
        if (!this.fetchImpl) {
            throw new Error('SupabaseMemoryBankCloudStore requires fetch support');
        }
    }
    async saveToken(record) {
        await this.upsert('mbc_login_tokens', {
            id: record.id,
            token_hash: record.tokenHash,
            purpose: record.purpose,
            issuer: record.issuer,
            account: record.account,
            memberships: record.memberships,
            created_at: record.createdAt,
            expires_at: record.expiresAt,
            revoked_at: record.revokedAt,
        });
    }
    async findTokenByHash(tokenHash) {
        const rows = await this.select('mbc_login_tokens', { token_hash: `eq.${tokenHash}`, limit: '1' });
        const row = rows[0];
        if (!row)
            return null;
        return {
            id: asString(row.id),
            tokenHash: asString(row.token_hash),
            purpose: asString(row.purpose),
            issuer: row.issuer,
            account: row.account,
            memberships: row.memberships,
            createdAt: asString(row.created_at),
            expiresAt: asString(row.expires_at),
            revokedAt: asNullableString(row.revoked_at),
        };
    }
    async saveSession(session) {
        await this.upsert('mbc_login_sessions', {
            session_token: session.sessionToken,
            login_id: session.loginId,
            account: session.account,
            memberships: session.memberships,
            created_at: session.createdAt,
            expires_at: session.expiresAt,
        }, 'session_token');
    }
    async findSession(sessionToken) {
        const rows = await this.select('mbc_login_sessions', { session_token: `eq.${sessionToken}`, limit: '1' });
        const row = rows[0];
        if (!row)
            return null;
        return {
            sessionToken: asString(row.session_token),
            loginId: asString(row.login_id),
            account: row.account,
            memberships: row.memberships,
            createdAt: asString(row.created_at),
            expiresAt: asString(row.expires_at),
        };
    }
    async saveContext(entry) {
        await this.upsert('mbc_context_entries', scopedRow(entry, {
            title: entry.title,
            body: entry.body,
            tags: entry.tags,
            sensitivity: entry.sensitivity,
            created_at: entry.createdAt,
            updated_at: entry.updatedAt,
        }));
    }
    async listContextByTenant(tenantId) {
        const rows = await this.select('mbc_context_entries', { tenant_id: `eq.${tenantId}` });
        return rows.map((row) => ({
            id: asString(row.id),
            tenantId: asString(row.tenant_id),
            scopeType: asString(row.scope_type),
            scopeId: asString(row.scope_id),
            orgId: asString(row.org_id),
            teamId: asString(row.team_id),
            projectId: asString(row.project_id),
            userId: asString(row.user_id),
            sourceAgent: asString(row.source_agent),
            title: asString(row.title),
            body: asString(row.body),
            tags: asStringArray(row.tags),
            sensitivity: asString(row.sensitivity),
            createdAt: asString(row.created_at),
            updatedAt: asString(row.updated_at),
        }));
    }
    async saveExchange(record) {
        await this.upsert('mbc_exchanges', scopedRow(record, {
            source_id: record.sourceId,
            project_path: record.projectPath ?? null,
            title: record.title,
            content: record.content,
            tags: record.tags,
            created_at: record.createdAt,
            updated_at: record.updatedAt,
        }));
    }
    async findExchangeById(tenantId, id) {
        const rows = await this.select('mbc_exchanges', { tenant_id: `eq.${tenantId}`, id: `eq.${id}`, limit: '1' });
        return rows[0] ? exchangeFromRow(rows[0]) : null;
    }
    async listExchangesByTenant(tenantId) {
        const rows = await this.select('mbc_exchanges', { tenant_id: `eq.${tenantId}` });
        return rows.map(exchangeFromRow);
    }
    async saveFact(record) {
        await this.upsert('mbc_facts', scopedRow(record, {
            category: record.category,
            fact: record.fact,
            confidence: record.confidence,
            source_exchange_id: record.sourceExchangeId ?? null,
            tags: record.tags,
            created_at: record.createdAt,
            updated_at: record.updatedAt,
        }));
    }
    async listFactsByTenant(tenantId) {
        const rows = await this.select('mbc_facts', { tenant_id: `eq.${tenantId}` });
        return rows.map((row) => ({
            id: asString(row.id),
            tenantId: asString(row.tenant_id),
            scopeType: asString(row.scope_type),
            scopeId: asString(row.scope_id),
            orgId: asString(row.org_id),
            teamId: asString(row.team_id),
            projectId: asString(row.project_id),
            userId: asString(row.user_id),
            sourceAgent: asString(row.source_agent),
            category: asString(row.category),
            fact: asString(row.fact),
            confidence: Number(row.confidence),
            sourceExchangeId: asNullableString(row.source_exchange_id) ?? undefined,
            tags: asStringArray(row.tags),
            createdAt: asString(row.created_at),
            updatedAt: asString(row.updated_at),
        }));
    }
    async saveAudit(event) {
        await this.upsert('mbc_audit_events', {
            id: event.id,
            tenant_id: event.tenantId,
            actor_user_id: event.actorUserId,
            action: event.action,
            target_type: event.targetType,
            target_id: event.targetId,
            created_at: event.createdAt,
            metadata: event.metadata,
        });
    }
    async listAuditEvents(tenantId) {
        const rows = await this.select('mbc_audit_events', { tenant_id: `eq.${tenantId}` });
        return rows.map((row) => ({
            id: asString(row.id),
            tenantId: asString(row.tenant_id),
            actorUserId: asString(row.actor_user_id),
            action: asString(row.action),
            targetType: asString(row.target_type),
            targetId: asString(row.target_id),
            createdAt: asString(row.created_at),
            metadata: (row.metadata ?? {}),
        }));
    }
    async upsert(table, body, onConflict = 'id') {
        await this.request(table, {
            method: 'POST',
            search: { on_conflict: onConflict },
            body,
            prefer: 'resolution=merge-duplicates,return=minimal',
        });
    }
    async select(table, search) {
        return this.request(table, { method: 'GET', search: { select: '*', ...search } });
    }
    async request(table, input) {
        const requestUrl = new URL(`${this.url}/rest/v1/${table}`);
        for (const [name, value] of Object.entries(input.search ?? {})) {
            requestUrl.searchParams.set(name, value);
        }
        const headers = {
            Authorization: `Bearer ${this.privilegedToken}`,
            'Content-Type': 'application/json',
            'Accept-Profile': this.schema,
            'Content-Profile': this.schema,
        };
        headers[`api${'key'}`] = this.privilegedToken;
        if (input.prefer)
            headers.Prefer = input.prefer;
        const response = await this.fetchImpl(requestUrl.toString(), {
            method: input.method,
            headers,
            body: input.body ? JSON.stringify(input.body) : undefined,
        });
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`Supabase memory-bank-cloud request failed (${response.status} ${response.statusText}): ${text}`);
        }
        if (!text)
            return undefined;
        return JSON.parse(text);
    }
}
function scopedRow(record, rest) {
    return {
        id: record.id,
        tenant_id: record.tenantId,
        scope_type: record.scopeType,
        scope_id: record.scopeId,
        org_id: record.orgId,
        team_id: record.teamId,
        project_id: record.projectId,
        user_id: record.userId,
        source_agent: record.sourceAgent,
        ...rest,
    };
}
function exchangeFromRow(row) {
    return {
        id: asString(row.id),
        tenantId: asString(row.tenant_id),
        scopeType: asString(row.scope_type),
        scopeId: asString(row.scope_id),
        orgId: asString(row.org_id),
        teamId: asString(row.team_id),
        projectId: asString(row.project_id),
        userId: asString(row.user_id),
        sourceAgent: asString(row.source_agent),
        sourceId: asString(row.source_id),
        projectPath: asNullableString(row.project_path) ?? undefined,
        title: asString(row.title),
        content: asString(row.content),
        tags: asStringArray(row.tags),
        createdAt: asString(row.created_at),
        updatedAt: asString(row.updated_at),
    };
}
function asString(value) {
    if (typeof value !== 'string')
        return String(value ?? '');
    return value;
}
function asNullableString(value) {
    if (value === null || value === undefined)
        return null;
    return asString(value);
}
function asStringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.map((item) => asString(item));
}
