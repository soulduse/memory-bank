import { z } from 'zod';
const ScopeSchema = z.enum(['personal', 'project', 'team', 'org', 'company']);
const SourceAgentSchema = z.enum(['claude-code', 'codex', 'opencode', 'custom-agent']);
const TokenIssuerRoleSchema = z.enum(['owner', 'admin', 'service']);
const FactCategorySchema = z.enum(['decision', 'preference', 'pattern', 'knowledge', 'constraint']);
const AccountSchema = z.object({
    tenantId: z.string().min(1),
    orgId: z.string().min(1),
    teamId: z.string().min(1),
    projectId: z.string().min(1),
    userId: z.string().min(1),
    terminalId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    sourceAgent: SourceAgentSchema,
});
const IssuerSchema = z.object({
    tenantId: z.string().min(1),
    userId: z.string().min(1),
    scopeType: ScopeSchema,
    scopeId: z.string().min(1),
    role: TokenIssuerRoleSchema,
});
const IssueTokenInputSchema = z.object({
    issuer: IssuerSchema,
    account: AccountSchema,
    expiresInSeconds: z.number().int().min(60).max(60 * 60 * 24 * 30).default(3600),
});
const LoginInputSchema = z.object({
    token: z.string().min(8),
    terminalId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    sourceAgent: SourceAgentSchema.optional(),
});
const PutContextInputSchema = z.object({
    sessionToken: z.string().min(8),
    scopeType: ScopeSchema,
    scopeId: z.string().min(1).optional(),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(20000),
    tags: z.array(z.string().min(1).max(80)).max(20).default([]),
    sensitivity: z.enum(['public', 'internal', 'confidential', 'restricted']).default('internal'),
});
const GetContextInputSchema = z.object({
    sessionToken: z.string().min(8),
    query: z.string().min(1).max(2000).optional(),
    limit: z.number().int().min(1).max(100).default(20),
    includeScopes: z.array(ScopeSchema).max(5).optional(),
});
const IngestExchangeInputSchema = z.object({
    sessionToken: z.string().min(8),
    scopeType: ScopeSchema,
    scopeId: z.string().min(1).optional(),
    sourceId: z.string().min(1).optional(),
    projectPath: z.string().min(1).max(1000).optional(),
    title: z.string().min(1).max(300),
    content: z.string().min(1).max(200000),
    tags: z.array(z.string().min(1).max(80)).max(30).default([]),
    createdAt: z.string().datetime().optional(),
});
const SearchInputSchema = z.object({
    sessionToken: z.string().min(8),
    query: z.string().min(1).max(2000),
    limit: z.number().int().min(1).max(50).default(10),
    includeScopes: z.array(ScopeSchema).max(5).optional(),
    projectId: z.string().min(1).optional(),
    projectPath: z.string().min(1).max(1000).optional(),
    sourceAgent: SourceAgentSchema.optional(),
});
const ReadInputSchema = z.object({
    sessionToken: z.string().min(8),
    id: z.string().min(1),
});
const PutFactInputSchema = z.object({
    sessionToken: z.string().min(8),
    scopeType: ScopeSchema,
    scopeId: z.string().min(1).optional(),
    category: FactCategorySchema,
    fact: z.string().min(1).max(20000),
    confidence: z.number().min(0).max(1).default(0.8),
    sourceExchangeId: z.string().min(1).optional(),
    tags: z.array(z.string().min(1).max(80)).max(30).default([]),
});
const SearchFactsInputSchema = z.object({
    sessionToken: z.string().min(8),
    query: z.string().min(1).max(2000),
    category: FactCategorySchema.optional(),
    limit: z.number().int().min(1).max(50).default(10),
    includeScopes: z.array(ScopeSchema).max(5).optional(),
    projectId: z.string().min(1).optional(),
    sourceAgent: SourceAgentSchema.optional(),
});
export function listMemoryBankCloudMcpTools(options = {}) {
    const adminTools = [
        {
            name: 'memory_bank_cloud_issue_token',
            description: 'Control-plane only. Issue a private memory-bank-cloud MCP login token inside the issuer tenant/scope boundary. Public MCP clients must not expose this capability.',
            inputSchema: zodToJsonObject({
                issuer: {
                    type: 'object',
                    properties: {
                        tenantId: { type: 'string' },
                        userId: { type: 'string' },
                        scopeType: { type: 'string', enum: ['personal', 'project', 'team', 'org', 'company'] },
                        scopeId: { type: 'string' },
                        role: { type: 'string', enum: ['owner', 'admin', 'service'] },
                    },
                    required: ['tenantId', 'userId', 'scopeType', 'scopeId', 'role'],
                    additionalProperties: false,
                },
                account: accountJsonSchema(),
                expiresInSeconds: { type: 'number', minimum: 60, maximum: 2592000, default: 3600 },
            }, ['issuer', 'account']),
            annotations: { title: 'Issue Cloud Login Token', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        },
    ];
    const sessionTools = [
        {
            name: 'memory_bank_cloud_login',
            description: 'Login with a previously issued token and resolve the company/org/team/project/user context used by Claude or Codex MCP sessions.',
            inputSchema: zodToJsonObject({
                token: { type: 'string' },
                terminalId: { type: 'string' },
                sessionId: { type: 'string' },
                sourceAgent: { type: 'string', enum: ['claude-code', 'codex', 'opencode', 'custom-agent'] },
            }, ['token']),
            annotations: { title: 'Login to Memory Bank Cloud', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        },
        {
            name: 'memory_bank_cloud_put_context',
            description: 'Store context at personal/project/team/org/company scope. Org/team/company context becomes automatically visible to matching logged-in MCP clients.',
            inputSchema: zodToJsonObject({
                sessionToken: { type: 'string' },
                scopeType: scopeJsonSchema(),
                scopeId: { type: 'string' },
                title: { type: 'string', maxLength: 200 },
                body: { type: 'string', maxLength: 20000 },
                tags: { type: 'array', items: { type: 'string' }, default: [] },
                sensitivity: { type: 'string', enum: ['public', 'internal', 'confidential', 'restricted'], default: 'internal' },
            }, ['sessionToken', 'scopeType', 'title', 'body']),
            annotations: { title: 'Put Shared Context', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        },
        {
            name: 'memory_bank_cloud_get_context',
            description: 'Return the automatic context bundle for a logged-in Claude/Codex MCP session, including visible company/org/team/project/personal entries.',
            inputSchema: zodToJsonObject({
                sessionToken: { type: 'string' },
                query: { type: 'string' },
                limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
                includeScopes: { type: 'array', items: scopeJsonSchema() },
            }, ['sessionToken']),
            annotations: { title: 'Get Automatic Context Bundle', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        {
            name: 'memory_bank_cloud_ingest_exchange',
            description: 'Ingest a Claude/Codex exchange into memory-bank-cloud with tenant-bound org/team/project/personal visibility.',
            inputSchema: zodToJsonObject({
                sessionToken: { type: 'string' },
                scopeType: scopeJsonSchema(),
                scopeId: { type: 'string' },
                sourceId: { type: 'string' },
                projectPath: { type: 'string' },
                title: { type: 'string', maxLength: 300 },
                content: { type: 'string', maxLength: 200000 },
                tags: { type: 'array', items: { type: 'string' }, default: [] },
                createdAt: { type: 'string', format: 'date-time' },
            }, ['sessionToken', 'scopeType', 'title', 'content']),
            annotations: { title: 'Ingest Cloud Exchange', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        },
        {
            name: 'memory_bank_cloud_search',
            description: 'Search visible cloud exchanges. This is the cloud version of memory-bank search with tenant/scope boundaries enforced before ranking.',
            inputSchema: zodToJsonObject(searchProperties(), ['sessionToken', 'query']),
            annotations: { title: 'Search Cloud Memory', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        {
            name: 'memory_bank_cloud_read',
            description: 'Read one visible cloud exchange by id after search. Arbitrary local file paths are not accepted.',
            inputSchema: zodToJsonObject({ sessionToken: { type: 'string' }, id: { type: 'string' } }, ['sessionToken', 'id']),
            annotations: { title: 'Read Cloud Exchange', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        {
            name: 'memory_bank_cloud_put_fact',
            description: 'Store an extracted fact in cloud memory-bank with the same tenant/scope sharing boundary as context and exchanges.',
            inputSchema: zodToJsonObject({
                sessionToken: { type: 'string' },
                scopeType: scopeJsonSchema(),
                scopeId: { type: 'string' },
                category: factCategoryJsonSchema(),
                fact: { type: 'string', maxLength: 20000 },
                confidence: { type: 'number', minimum: 0, maximum: 1, default: 0.8 },
                sourceExchangeId: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' }, default: [] },
            }, ['sessionToken', 'scopeType', 'category', 'fact']),
            annotations: { title: 'Put Cloud Fact', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        },
        {
            name: 'memory_bank_cloud_search_facts',
            description: 'Search visible cloud facts. This is the cloud version of memory-bank search_facts with issuer-bound tenant isolation.',
            inputSchema: zodToJsonObject({
                ...searchProperties(),
                category: factCategoryJsonSchema(),
            }, ['sessionToken', 'query']),
            annotations: { title: 'Search Cloud Facts', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
    ];
    return options.includeAdminTools ? [...adminTools, ...sessionTools] : sessionTools;
}
export async function callMemoryBankCloudMcpTool(host, name, args) {
    if (name === 'memory_bank_cloud_issue_token') {
        const parsed = IssueTokenInputSchema.parse(args);
        const issued = await host.issueLoginToken({
            issuer: parsed.issuer,
            account: {
                ...parsed.account,
                sourceAgent: parsed.account.sourceAgent,
            },
            expiresInSeconds: parsed.expiresInSeconds,
        });
        return JSON.stringify(issued, null, 2);
    }
    if (name === 'memory_bank_cloud_login') {
        const parsed = LoginInputSchema.parse(args);
        const session = await host.loginWithToken(parsed.token, parsed);
        return JSON.stringify(session, null, 2);
    }
    if (name === 'memory_bank_cloud_put_context') {
        const parsed = PutContextInputSchema.parse(args);
        const entry = await host.putContext(parsed.sessionToken, {
            scopeType: parsed.scopeType,
            scopeId: parsed.scopeId,
            title: parsed.title,
            body: parsed.body,
            tags: parsed.tags,
            sensitivity: parsed.sensitivity,
        });
        return JSON.stringify(entry, null, 2);
    }
    if (name === 'memory_bank_cloud_get_context') {
        const parsed = GetContextInputSchema.parse(args);
        const bundle = await host.getContextBundle(parsed.sessionToken, {
            query: parsed.query,
            limit: parsed.limit,
            includeScopes: parsed.includeScopes,
        });
        return JSON.stringify(bundle, null, 2);
    }
    if (name === 'memory_bank_cloud_ingest_exchange') {
        const parsed = IngestExchangeInputSchema.parse(args);
        const exchange = await host.ingestExchange(parsed.sessionToken, {
            scopeType: parsed.scopeType,
            scopeId: parsed.scopeId,
            sourceId: parsed.sourceId,
            projectPath: parsed.projectPath,
            title: parsed.title,
            content: parsed.content,
            tags: parsed.tags,
            createdAt: parsed.createdAt,
        });
        return JSON.stringify(exchange, null, 2);
    }
    if (name === 'memory_bank_cloud_search') {
        const parsed = SearchInputSchema.parse(args);
        const results = await host.searchExchanges(parsed.sessionToken, {
            query: parsed.query,
            limit: parsed.limit,
            includeScopes: parsed.includeScopes,
            projectId: parsed.projectId,
            projectPath: parsed.projectPath,
            sourceAgent: parsed.sourceAgent,
        });
        return JSON.stringify(results, null, 2);
    }
    if (name === 'memory_bank_cloud_read') {
        const parsed = ReadInputSchema.parse(args);
        const result = await host.readExchange(parsed.sessionToken, parsed.id);
        return JSON.stringify(result, null, 2);
    }
    if (name === 'memory_bank_cloud_put_fact') {
        const parsed = PutFactInputSchema.parse(args);
        const fact = await host.putFact(parsed.sessionToken, {
            scopeType: parsed.scopeType,
            scopeId: parsed.scopeId,
            category: parsed.category,
            fact: parsed.fact,
            confidence: parsed.confidence,
            sourceExchangeId: parsed.sourceExchangeId,
            tags: parsed.tags,
        });
        return JSON.stringify(fact, null, 2);
    }
    if (name === 'memory_bank_cloud_search_facts') {
        const parsed = SearchFactsInputSchema.parse(args);
        const results = await host.searchFacts(parsed.sessionToken, {
            query: parsed.query,
            category: parsed.category,
            limit: parsed.limit,
            includeScopes: parsed.includeScopes,
            projectId: parsed.projectId,
            sourceAgent: parsed.sourceAgent,
        });
        return JSON.stringify(results, null, 2);
    }
    throw new Error(`Unknown memory-bank-cloud MCP tool: ${name}`);
}
function searchProperties() {
    return {
        sessionToken: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 50, default: 10 },
        includeScopes: { type: 'array', items: scopeJsonSchema() },
        projectId: { type: 'string' },
        projectPath: { type: 'string' },
        sourceAgent: { type: 'string', enum: ['claude-code', 'codex', 'opencode', 'custom-agent'] },
    };
}
function accountJsonSchema() {
    return {
        type: 'object',
        properties: {
            tenantId: { type: 'string' },
            orgId: { type: 'string' },
            teamId: { type: 'string' },
            projectId: { type: 'string' },
            userId: { type: 'string' },
            terminalId: { type: 'string' },
            sessionId: { type: 'string' },
            sourceAgent: { type: 'string', enum: ['claude-code', 'codex', 'opencode', 'custom-agent'] },
        },
        required: ['tenantId', 'orgId', 'teamId', 'projectId', 'userId', 'sourceAgent'],
        additionalProperties: false,
    };
}
function scopeJsonSchema() {
    return { type: 'string', enum: ['personal', 'project', 'team', 'org', 'company'] };
}
function factCategoryJsonSchema() {
    return { type: 'string', enum: ['decision', 'preference', 'pattern', 'knowledge', 'constraint'] };
}
function zodToJsonObject(properties, required) {
    return {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
    };
}
