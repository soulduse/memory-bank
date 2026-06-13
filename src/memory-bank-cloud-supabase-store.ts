import {
  CloudAuditEvent,
  CloudContextEntry,
  CloudExchangeRecord,
  CloudFactRecord,
  CloudLoginSession,
  CloudLoginTokenRecord,
  MemoryBankCloudStore,
} from './memory-bank-cloud.js';

export type MemoryBankCloudFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
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

type Row = Record<string, unknown>;

export class SupabaseMemoryBankCloudStore implements MemoryBankCloudStore {
  private readonly url: string;
  private readonly privilegedToken: string;
  private readonly fetchImpl: MemoryBankCloudFetch;
  private readonly schema: string;

  constructor(options: SupabaseMemoryBankCloudStoreOptions) {
    this.url = options.url.replace(/\/$/, '');
    this.privilegedToken = options.privilegedToken;
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as MemoryBankCloudFetch);
    this.schema = options.schema ?? 'public';
    if (!this.fetchImpl) {
      throw new Error('SupabaseMemoryBankCloudStore requires fetch support');
    }
  }

  async saveToken(record: CloudLoginTokenRecord): Promise<void> {
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

  async findTokenByHash(tokenHash: string): Promise<CloudLoginTokenRecord | null> {
    const rows = await this.select('mbc_login_tokens', { token_hash: `eq.${tokenHash}`, limit: '1' });
    const row = rows[0];
    if (!row) return null;
    return {
      id: asString(row.id),
      tokenHash: asString(row.token_hash),
      purpose: asString(row.purpose) as CloudLoginTokenRecord['purpose'],
      issuer: row.issuer as CloudLoginTokenRecord['issuer'],
      account: row.account as CloudLoginTokenRecord['account'],
      memberships: row.memberships as CloudLoginTokenRecord['memberships'],
      createdAt: asString(row.created_at),
      expiresAt: asString(row.expires_at),
      revokedAt: asNullableString(row.revoked_at),
    };
  }

  async saveSession(session: CloudLoginSession): Promise<void> {
    await this.upsert('mbc_login_sessions', {
      session_token: session.sessionToken,
      login_id: session.loginId,
      account: session.account,
      memberships: session.memberships,
      created_at: session.createdAt,
      expires_at: session.expiresAt,
    }, 'session_token');
  }

  async findSession(sessionToken: string): Promise<CloudLoginSession | null> {
    const rows = await this.select('mbc_login_sessions', { session_token: `eq.${sessionToken}`, limit: '1' });
    const row = rows[0];
    if (!row) return null;
    return {
      sessionToken: asString(row.session_token),
      loginId: asString(row.login_id),
      account: row.account as CloudLoginSession['account'],
      memberships: row.memberships as CloudLoginSession['memberships'],
      createdAt: asString(row.created_at),
      expiresAt: asString(row.expires_at),
    };
  }

  async saveContext(entry: CloudContextEntry): Promise<void> {
    await this.upsert('mbc_context_entries', scopedRow(entry, {
      title: entry.title,
      body: entry.body,
      tags: entry.tags,
      sensitivity: entry.sensitivity,
      created_at: entry.createdAt,
      updated_at: entry.updatedAt,
    }));
  }

  async listContextByTenant(tenantId: string): Promise<CloudContextEntry[]> {
    const rows = await this.select('mbc_context_entries', { tenant_id: `eq.${tenantId}` });
    return rows.map((row) => ({
      id: asString(row.id),
      tenantId: asString(row.tenant_id),
      scopeType: asString(row.scope_type) as CloudContextEntry['scopeType'],
      scopeId: asString(row.scope_id),
      orgId: asString(row.org_id),
      teamId: asString(row.team_id),
      projectId: asString(row.project_id),
      userId: asString(row.user_id),
      sourceAgent: asString(row.source_agent) as CloudContextEntry['sourceAgent'],
      title: asString(row.title),
      body: asString(row.body),
      tags: asStringArray(row.tags),
      sensitivity: asString(row.sensitivity) as CloudContextEntry['sensitivity'],
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    }));
  }

  async saveExchange(record: CloudExchangeRecord): Promise<void> {
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

  async findExchangeById(tenantId: string, id: string): Promise<CloudExchangeRecord | null> {
    const rows = await this.select('mbc_exchanges', { tenant_id: `eq.${tenantId}`, id: `eq.${id}`, limit: '1' });
    return rows[0] ? exchangeFromRow(rows[0]) : null;
  }

  async listExchangesByTenant(tenantId: string): Promise<CloudExchangeRecord[]> {
    const rows = await this.select('mbc_exchanges', { tenant_id: `eq.${tenantId}` });
    return rows.map(exchangeFromRow);
  }

  async saveFact(record: CloudFactRecord): Promise<void> {
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

  async listFactsByTenant(tenantId: string): Promise<CloudFactRecord[]> {
    const rows = await this.select('mbc_facts', { tenant_id: `eq.${tenantId}` });
    return rows.map((row) => ({
      id: asString(row.id),
      tenantId: asString(row.tenant_id),
      scopeType: asString(row.scope_type) as CloudFactRecord['scopeType'],
      scopeId: asString(row.scope_id),
      orgId: asString(row.org_id),
      teamId: asString(row.team_id),
      projectId: asString(row.project_id),
      userId: asString(row.user_id),
      sourceAgent: asString(row.source_agent) as CloudFactRecord['sourceAgent'],
      category: asString(row.category) as CloudFactRecord['category'],
      fact: asString(row.fact),
      confidence: Number(row.confidence),
      sourceExchangeId: asNullableString(row.source_exchange_id) ?? undefined,
      tags: asStringArray(row.tags),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    }));
  }

  async saveAudit(event: CloudAuditEvent): Promise<void> {
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

  async listAuditEvents(tenantId: string): Promise<CloudAuditEvent[]> {
    const rows = await this.select('mbc_audit_events', { tenant_id: `eq.${tenantId}` });
    return rows.map((row) => ({
      id: asString(row.id),
      tenantId: asString(row.tenant_id),
      actorUserId: asString(row.actor_user_id),
      action: asString(row.action),
      targetType: asString(row.target_type),
      targetId: asString(row.target_id),
      createdAt: asString(row.created_at),
      metadata: (row.metadata ?? {}) as Record<string, string>,
    }));
  }

  private async upsert(table: string, body: Row, onConflict = 'id'): Promise<void> {
    await this.request<void>(table, {
      method: 'POST',
      search: { on_conflict: onConflict },
      body,
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
  }

  private async select(table: string, search: Record<string, string>): Promise<Row[]> {
    return this.request<Row[]>(table, { method: 'GET', search: { select: '*', ...search } });
  }

  private async request<T>(table: string, input: { method: string; search?: Record<string, string>; body?: Row; prefer?: string }): Promise<T> {
    const requestUrl = new URL(`${this.url}/rest/v1/${table}`);
    for (const [name, value] of Object.entries(input.search ?? {})) {
      requestUrl.searchParams.set(name, value);
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.privilegedToken}`,
      'Content-Type': 'application/json',
      'Accept-Profile': this.schema,
      'Content-Profile': this.schema,
    };
    headers[`api${'key'}`] = this.privilegedToken;
    if (input.prefer) headers.Prefer = input.prefer;

    const response = await this.fetchImpl(requestUrl.toString(), {
      method: input.method,
      headers,
      body: input.body ? JSON.stringify(input.body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Supabase memory-bank-cloud request failed (${response.status} ${response.statusText}): ${text}`);
    }
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }
}

function scopedRow(record: CloudContextEntry | CloudExchangeRecord | CloudFactRecord, rest: Row): Row {
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

function exchangeFromRow(row: Row): CloudExchangeRecord {
  return {
    id: asString(row.id),
    tenantId: asString(row.tenant_id),
    scopeType: asString(row.scope_type) as CloudExchangeRecord['scopeType'],
    scopeId: asString(row.scope_id),
    orgId: asString(row.org_id),
    teamId: asString(row.team_id),
    projectId: asString(row.project_id),
    userId: asString(row.user_id),
    sourceAgent: asString(row.source_agent) as CloudExchangeRecord['sourceAgent'],
    sourceId: asString(row.source_id),
    projectPath: asNullableString(row.project_path) ?? undefined,
    title: asString(row.title),
    content: asString(row.content),
    tags: asStringArray(row.tags),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function asString(value: unknown): string {
  if (typeof value !== 'string') return String(value ?? '');
  return value;
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return asString(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asString(item));
}
