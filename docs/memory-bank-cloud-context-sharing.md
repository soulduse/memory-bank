# Memory Bank Cloud Context Sharing Slice

> 기준: `/Users/jung-wankim/Project/Claude/claude-code-site/enterprise-harness-complexity.html` + `docs/cloud-enterprise-architecture.html` / `docs/cloud-enterprise-architecture.md`.
> `enterprise-harness-complexity.html`는 현재 repo 밖의 `claude-code-site`에 있으므로 원본 파일은 복사하지 않고, 핵심 제약만 이 설계에 반영한다.


## Enterprise harness complexity에서 반영한 제약

`enterprise-harness-complexity.html`의 결론은 “개인 하네스를 조직으로 그대로 분산하면 복잡도가 폭발한다”는 것이다. 이 branch의 설계는 그 문제를 다음처럼 줄인다.

| 복잡도 원인 | memory-bank-cloud 대응 |
| --- | --- |
| 암묵적 지식 전파 비용 | 조직/팀/project context를 MCP 로그인 시 자동 bundle로 제공한다. |
| Worker별 독립 진화와 노이즈 | context row마다 scope, sourceAgent, audit/provenance를 남긴다. |
| N² 커뮤니케이션 비용 | Claude/Codex/worker가 서로 메시지를 주고받는 대신 같은 scoped context plane을 읽는다. |
| M2 scope classifier 정체 | `personal/project/team/org/company`를 명시 필드로 만들고 write/read policy를 scope 단위로 검증한다. |
| 조직 정치/품질 기준 불일치 | org/company context는 별도 approval/promotion policy로 확장할 수 있게 schema를 분리한다. |

즉, 이 기능의 핵심은 “분산 agent끼리 더 많이 통신하게 만드는 것”이 아니라, **공유 context plane을 통해 통신 필요 자체를 줄이는 것**이다.

## 목표

Memory Bank Cloud는 Claude/Codex가 각자 작업 내용을 일일이 주고받지 않아도, MCP 로그인 시점에 회사·조직·팀·프로젝트·개인 context를 자동으로 가져오는 공유 context plane이다.

단, 이 MCP는 공개 마켓/공용 MCP가 아니다. **발급된 인증토큰이 곧 접근 가능한 회사/조직/팀/프로젝트/개인 경계다.** 토큰 발급 주체가 company이면 company 이하, org이면 해당 org 이하, team이면 해당 team 이하만 공유된다. 다른 회사/조직 context는 “필터링해서 숨기는 것”이 아니라 **권한 모델상 접근 불가능해야 한다.**

핵심 흐름:

```text
Private MCP control-plane validates issuer
  → MCP host(Supabase-backed) issues scope-bound login token
  → Claude/Codex MCP client logs in with token
  → token resolves tenant/org/team/project/user account context and issuer boundary
  → context writes are stored by scope
  → logged-in client receives only context visible inside that token issuer boundary
```

## Scope hierarchy

```text
company / tenant
  └─ organization
      └─ team
          └─ project
              └─ user personal memory
```

Every context row must carry:

- `tenant_id`
- `org_id`
- `team_id`
- `project_id`
- `user_id`
- `scope_type`: `personal | project | team | org | company`
- `scope_id`
- `source_agent`: `claude-code | codex | opencode | custom-agent`

## Auth/token contract

Token issuance is a private control-plane operation exposed by the MCP host/admin API. Production deployment stores only `token_hash`, never the raw token. `memory_bank_cloud_issue_token` is **not** a public user-facing MCP capability.

1. `memory_bank_cloud_issue_token`
   - Input: issuer envelope (`tenantId`, `userId`, `scopeType`, `scopeId`, `role`) + account envelope (`tenantId`, `orgId`, `teamId`, `projectId`, `userId`, `sourceAgent`).
   - Issuer role must be `owner | admin | service`.
   - Issuer tenant must equal account tenant.
   - Issuer scope must contain the issued account scope:
     - `company:{tenantId}` can issue company/org/team/project/personal-bound tokens inside that tenant.
     - `org:{orgId}` can issue org/team/project/personal-bound tokens inside that org only.
     - `team:{teamId}` can issue team/project/personal-bound tokens inside that team only.
     - `project:{projectId}` can issue project/personal-bound tokens inside that project only.
     - `personal:{userId}` can issue personal-bound tokens for that same user only.
   - Output: one-time bearer token and expiry.
2. `memory_bank_cloud_login`
   - Input: token plus optional terminal/session/source-agent override.
   - Output: `sessionToken`, account context, memberships clipped to the token issuer boundary.
3. `memory_bank_cloud_put_context`
   - Stores scoped context.
   - Write is allowed only if the session can see/write that scope.
4. `memory_bank_cloud_get_context`
   - Returns the automatic context bundle for Claude/Codex.
   - This is the important part: org/team/company context is shared by scope membership, not by manually passing messages between agents.

## Supabase MCP host responsibility

Supabase acts as the memory-bank-cloud host for this feature branch:

- Postgres tables store tenants, orgs, teams, projects, users, memberships, token hashes, context entries, and audit events.
- RLS/policies enforce tenant boundary and scope visibility.
- MCP server/tool layer validates tokens, resolves account context, and performs scoped reads/writes.
- Token issuance is control-plane only. 일반 사용자/외부 connector는 raw account envelope로 임의 tenant/org/team token을 만들 수 없다.
- Future edge functions can wrap token issuance/login when external clients cannot call MCP directly.

## Local implementation in this branch

Implemented source files:

- `src/memory-bank-cloud.ts`
  - `MemoryBankCloudHost`
  - token hash issuance/login
  - session creation
  - scoped context writes
  - automatic context bundle lookup
  - in-memory store for tests and contract development
- `src/memory-bank-cloud-mcp.ts`
  - MCP-facing tool descriptors
  - Zod-validated tool handler wrapper
- `docs/memory-bank-cloud-supabase-schema.sql`
  - Supabase/Postgres schema and RLS policy skeleton
- `test/memory-bank-cloud.test.ts`
  - token/login, organization sharing, team/personal isolation, MCP wrapper tests

## Non-negotiable invariants

- Raw tokens are not stored; only SHA-256 hashes are persisted.
- Tenant boundary is the hard isolation boundary.
- Token issuer identity and issuer scope are mandatory.
- Token issuance cannot cross tenant/company boundary.
- A token cannot widen beyond its issuer scope. Team-issued token은 org/company context에 접근할 수 없다.
- Personal context is visible only to the same `user_id` unless a future explicit promotion policy creates a new scoped entry.
- Org/team/company context is available automatically to matching logged-in sessions.
- Cross-tenant reads must return zero entries.
- Every token issue, login, put, and bundle read emits an audit event.

## Next implementation steps

1. Wire `MemoryBankCloudHost` into a dedicated cloud MCP server entrypoint.
2. Replace the in-memory store with a Supabase adapter using the SQL schema.
3. Add Supabase RLS tests with seeded tenants/users.
4. Add sidecar upload flow that mirrors local memory-bank events into cloud context entries.
5. Add cloud/local fallback behavior in existing `search_facts`/context injection paths.
