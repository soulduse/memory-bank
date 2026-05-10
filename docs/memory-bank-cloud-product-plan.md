# Memory Bank Cloud 제품화 구현 계획

> 목적: 현재 `feature/memory-bank-cloud-context-sharing`의 P0 prototype을 **기존 memory-bank 기능 + 조직/팀/개인 context sharing이 되는 cloud 제품**으로 확장한다.

## 0. 현재 판정

현재 구현은 아직 제품이 아니다.

- 구현됨: token/login/account context, `personal/project/team/org/company` scoped context sharing prototype, MCP-shaped wrapper, Supabase schema skeleton.
- 미구현: 실제 MCP server 등록, Supabase runtime adapter, cloud search/read/facts/ontology/sync, deployment pipeline.

따라서 제품화 목표는 다음으로 정의한다.

> **Memory Bank Cloud = 기존 local memory-bank의 search/read/facts/ontology/sync 기능을 Supabase-backed multi-tenant cloud store로 제공하고, private MCP login을 통해 인증토큰 발급 주체 범위 안의 company/org/team/project/personal context를 Claude/Codex에 자동 공유하는 제품.**

## 0.1 절대 보안 전제

이 MCP는 모두에게 제공되는 공개 MCP가 아니다.

- **Private MCP:** 외부 사용자가 MCP endpoint만 알아서 접속하는 구조가 아니다. token login 전에는 context tool을 사용할 수 없다.
- **Issuer-bound token:** 인증토큰은 반드시 발급 주체(`issuer`)를 가진다. issuer는 `tenantId`, `userId`, `scopeType`, `scopeId`, `role`로 표현한다.
- **Issuer scope clipping:** token으로 생성되는 session membership은 issuer 범위보다 넓어질 수 없다.
  - company issuer → 해당 company/tenant 이하만.
  - org issuer → 해당 org 이하만.
  - team issuer → 해당 team 이하만.
  - project issuer → 해당 project 이하만.
  - personal issuer → 해당 user 개인 context만.
- **No cross-company/org access:** 다른 회사/조직 context는 UI/API에서 숨기는 수준이 아니라 DB/RLS/store layer에서 접근 자체가 실패해야 한다.
- **Admin/control-plane issuance:** `issue_token`은 일반 사용자용 공개 MCP tool이 아니다. admin/service control-plane에서만 호출된다.


## 실행 계획 문서

수정된 private issuer-bound MCP 기준의 실행 계획은 아래 문서를 canonical execution plan으로 사용한다.

- `docs/plans/2026-05-10-memory-bank-cloud-private-mcp-productization.md`

이 문서는 `$team-hue` Phase 0~5 기준으로 runtime registration, Supabase/RLS, cloud MVP parity, sidecar sync, QA, deployment/rollback까지 포함한다.

## 1. 제품 아키텍처

```text
Claude / Codex / Worker
  ├─ local MCP: memory-bank-cloud stdio server
  └─ remote MCP: HTTPS Custom Connector
        ↓ private token login / session
Memory Bank Cloud MCP/API layer
        ↓ issuer-bound authz + RLS claims
Supabase
  ├─ Postgres: tenants/orgs/teams/projects/users/memberships
  ├─ Postgres: exchanges/tool_calls/facts/ontology/context_entries/audit
  ├─ Edge Functions: token, login, ingest, context bundle, admin operations
  ├─ Storage: raw JSONL archive / large tool payloads
  └─ optional pgvector/search index for semantic retrieval
        ↑
Local memory-bank sidecar / hooks
  ├─ current SQLite remains offline cache
  ├─ cloud spool for accepted events
  └─ idempotent upload to Supabase
```

핵심 원칙:

1. **기존 기능 보존:** local `memory-bank-mcp-server`는 깨지지 않는다.
2. **cloud mode 추가:** cloud MCP server는 기존 도구와 동일한 의미의 cloud-backed 도구를 제공한다.
3. **scope-first:** 모든 cloud row는 `tenant_id`, `org_id`, `team_id`, `project_id`, `user_id`, `scope_type`, `scope_id`를 가진다.
4. **RLS/data-layer gate:** API handler만 믿지 않고 Supabase RLS와 store layer에서 tenant/scope를 검증한다.
5. **manual relay 제거:** agent끼리 context를 전달하지 않고 `get_context_bundle`이 자동으로 visible scopes를 반환한다.
6. **issuer-bound sharing:** context sharing 범위는 로그인한 토큰의 issuer scope를 절대 넘지 않는다.

## 2. 구현 계획

### Phase 0 — P0 contract 정리와 runtime 등록

목표: 지금 prototype을 실제 MCP runtime에서 볼 수 있게 만든다.

작업:

- `src/memory-bank-cloud.ts`
  - 현재 domain model 유지.
  - `MemoryBankCloudStore` interface를 Supabase 구현이 필요한 수준으로 확장.
  - `CloudTokenIssuerContext`를 필수화하고 issuer tenant/scope 검증을 domain layer에서 수행.
- `src/memory-bank-cloud-mcp.ts`
  - 현재 MCP-shaped descriptor를 실제 `Server` registration helper로 분리.
  - `memory_bank_cloud_issue_token`은 admin/control-plane path에서만 노출. 일반 remote MCP client에는 login/context/search/read 계열만 노출.
- `src/mcp-server.ts`
  - feature flag `MEMORY_BANK_CLOUD_ENABLED=1`이면 cloud tools 등록.
  - 또는 dedicated entrypoint `src/memory-bank-cloud-server.ts` 추가.
- `package.json`
  - `memory-bank-cloud-mcp-server` bin 추가.
  - `bundle:cloud` script 추가.
- `cli/memory-bank-cloud-mcp-server` 추가.

완료 기준:

- `memory-bank-cloud-mcp-server` 실행 시 MCP tool list에 아래가 보인다.
  - `memory_bank_cloud_issue_token` — admin/control-plane profile에서만.
  - `memory_bank_cloud_login`
  - `memory_bank_cloud_put_context`
  - `memory_bank_cloud_get_context`
- 기존 `memory-bank-mcp-server`는 기존 9개 도구를 유지한다.
- issuer 없는 token 발급은 테스트/개발에서도 실패한다.

### Phase 1 — Supabase runtime adapter

목표: in-memory store를 실제 Supabase/Postgres로 교체한다.

작업 파일:

- `supabase/migrations/0001_memory_bank_cloud.sql`
  - 현재 `docs/memory-bank-cloud-supabase-schema.sql`를 migration으로 승격.
- `src/memory-bank-cloud-supabase-store.ts`
  - `MemoryBankCloudStore` 구현.
  - token hash + issuer subject 저장/조회.
  - session 저장/조회.
  - context entry 저장/조회.
  - audit write/read.
- `src/memory-bank-cloud-config.ts`
  - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, anon key, project ref 로딩.
  - browser/customer exposed key와 service key 분리.
- `test/memory-bank-cloud-supabase-store.test.ts`
  - local Supabase 또는 test Postgres에서 tenant isolation 검증.

Supabase 기준:

- RLS는 Postgres primitive이며 Auth와 결합 가능하다.
- `SELECT` policy는 `using`, `INSERT` policy는 `with check`로 검증한다.
- service key는 RLS를 bypass할 수 있으므로 고객/브라우저에 절대 노출하지 않는다.

완료 기준:

- `InMemoryMemoryBankCloudStore` 테스트 + `SupabaseMemoryBankCloudStore` 테스트 모두 통과.
- RLS 테스트에서 cross-tenant read/write가 실패한다.
- issuer가 다른 tenant/org/team에 token을 발급하려 하면 실패한다.
- team-issued token으로 org/company context read/write가 실패한다.

### Phase 2 — 기존 memory-bank 기능 cloud parity

목표: 기존 MCP 기능을 cloud store 위에서 제공한다.

Cloud equivalent tools:

| Local tool | Cloud tool | Required data path |
| --- | --- | --- |
| `search` | `memory_bank_cloud_search` | cloud exchanges + text/vector index |
| `read` | `memory_bank_cloud_read` | raw archive object or stored exchange payload |
| `search_facts` | `memory_bank_cloud_search_facts` | cloud facts + embeddings |
| `search_ontology` | `memory_bank_cloud_search_ontology` | cloud ontology tables |
| `trace_fact` | `memory_bank_cloud_trace_fact` | fact source exchange refs |
| `graph_stats` | `memory_bank_cloud_graph_stats` | aggregate facts/relations by scope |
| `cross_project_insights` | `memory_bank_cloud_cross_project_insights` | same tenant visible project scopes |
| `ask_avatar` | later | cloud facts + LLM-free/rule-first answer path |

작업 파일:

- `src/memory-bank-cloud-search.ts`
- `src/memory-bank-cloud-facts.ts`
- `src/memory-bank-cloud-ontology.ts`
- `src/memory-bank-cloud-ingest.ts`
- `src/memory-bank-cloud-raw-archive.ts`

데이터 모델 추가:

- `mbc_exchanges`
- `mbc_tool_calls`
- `mbc_facts`
- `mbc_fact_revisions`
- `mbc_ontology_domains`
- `mbc_ontology_categories`
- `mbc_ontology_relations`
- optional `mbc_embeddings`

완료 기준:

- local fixture를 cloud ingest한 뒤 cloud `search/read/search_facts`가 local 결과와 의미상 동일한 결과를 반환한다.
- 모든 cloud query는 tenant/scope filter를 포함한다.

### Phase 3 — local sidecar/sync bridge

목표: 지금 local memory-bank에 저장되는 대화/fact를 memory-bank-cloud로 mirror한다.

작업:

- `src/memory-bank-cloud-sync.ts`
  - local exchanges/facts export → cloud ingest envelope.
- `src/memory-bank-cloud-spool.ts`
  - offline spool JSONL.
  - ack stage: `received`, `archived`, `indexed`.
- `scripts/memory-bank-cloud-sync-hook.js`
  - Claude/Codex session end 또는 periodic sync.
- `cli/memory-bank.js`
  - `memory-bank cloud login`
  - `memory-bank cloud sync`
  - `memory-bank cloud status`

완료 기준:

- 네트워크 실패 시 local spool에 남는다.
- 재실행 시 idempotency key로 중복 ingest가 없다.
- cloud unavailable이어도 local memory-bank 기능은 유지된다.

### Phase 4 — context bundle product behavior

목표: 조직/팀 context sharing을 제품 기능으로 완성한다.

작업:

- `memory_bank_cloud_get_context`를 MCP Resource로도 제공.
  - 예: `memory-bank-cloud://context/current`
  - 예: `memory-bank-cloud://context/team/{teamId}`
- context ranking:
  - company/org/team/project/personal 우선순위.
  - recency, confidence, source count.
- promotion workflow:
  - personal → project/team/org/company 승격은 explicit event + audit 필요.
  - org/company 승격은 approval 상태를 가진다.
- admin API/UI plan:
  - team memberships
  - project mapping
  - context promotion approvals
  - audit explorer

완료 기준:

- 같은 org의 Claude/Codex가 별도 전달 없이 org context를 본다.
- 다른 tenant/team/user는 보지 못한다.
- private personal facts는 자동 승격되지 않는다.

### Phase 5 — remote MCP / deployment

목표: local MCP뿐 아니라 remote connector로도 접근 가능하게 한다.

작업:

- Supabase Edge Functions:
  - `token-issue`
    - private admin/service route only.
    - validates issuer membership before issuing a scoped token.
  - `token-login`
  - `context-bundle`
  - `ingest-event`
- Remote MCP server:
  - HTTPS endpoint + auth flow.
  - tool permissions and rate limits.
  - unauthenticated clients receive service-unavailable/unauthorized state, not tool data.
- local MCP server:
  - STDIO mode에서 stdout logging 금지. MCP docs 기준 stdout logging은 JSON-RPC를 깨뜨릴 수 있으므로 stderr/log file만 사용.

완료 기준:

- Claude remote connector URL로 cloud MCP server 연결 가능.
- local Claude/Codex는 stdio MCP로 연결 가능.
- staging Supabase project에서 end-to-end smoke 통과.

## 3. 실행 계획 / Milestones

### M0 — Baseline freeze (0.5d)

- 현재 branch 상태 기록.
- prototype 테스트 고정.
- `docs/memory-bank-cloud-product-plan.md` 승인.

Commands:

```bash
git branch --show-current
npm test
npx tsc --noEmit
```

### M1 — Runtime MCP registration (1-2d)

- cloud tool registration helper 작성.
- dedicated cloud MCP binary 추가.
- MCP inspector/manual JSON-RPC smoke.

Deliverables:

- `src/memory-bank-cloud-server.ts`
- `cli/memory-bank-cloud-mcp-server`
- `test/memory-bank-cloud-mcp-server.test.ts`

### M2 — Supabase adapter + migrations (2-4d)

- schema migration 이동.
- Supabase store 구현.
- local Supabase test harness.

Commands:

```bash
supabase start
supabase migration up
supabase db reset
npm run test -- test/memory-bank-cloud-supabase-store.test.ts
```

### M3 — Cloud ingest/read/search MVP (4-7d)

- cloud exchange/fact tables.
- fixture ingest.
- cloud search/read/search_facts.
- local vs cloud parity tests.

MVP acceptance:

- `memory_bank_cloud_search` returns indexed cloud exchange snippets.
- `memory_bank_cloud_search_facts` returns scoped facts.
- `memory_bank_cloud_read` returns source exchange by cloud object id, not arbitrary filesystem path.

### M4 — Sidecar sync bridge (3-5d)

- local export → cloud ingest.
- spool/ack/idempotency.
- `memory-bank cloud sync/status` CLI.

### M5 — Context bundle + promotion workflow (3-5d)

- automatic resource/tool context bundle.
- team/org/personal ranking.
- promotion records and audit events.

### M6 — Staging deployment (2-3d)

- Supabase staging project.
- migrations via CLI.
- Edge Functions deploy.
- cloud MCP server deploy target 결정.

Commands:

```bash
supabase login
supabase link --project-ref <staging-ref>
supabase db push
supabase functions deploy token-login
supabase functions deploy context-bundle
supabase functions deploy ingest-event
```

### M7 — Production release gate (2-4d)

- security review.
- RLS tenant isolation proof.
- load smoke.
- rollback plan.
- docs and connector setup guide.

## 4. 검수 / 검증 계획

### Required gates

| Gate | Required evidence | Command shape |
| --- | --- | --- |
| TypeScript | no type errors | `npx tsc --noEmit` |
| Local regression | existing local memory-bank not broken | `npm test` |
| Cloud unit | token/context logic | `npx vitest run test/memory-bank-cloud.test.ts` |
| Supabase adapter | persistence works | `npx vitest run test/memory-bank-cloud-supabase-store.test.ts` |
| RLS isolation | cross-tenant blocked | `npx vitest run test/memory-bank-cloud-rls.test.ts` |
| Issuer boundary | token cannot exceed issuer company/org/team/project/personal scope | `test/memory-bank-cloud.test.ts` + RLS claims tests |
| MCP runtime | tools visible and callable | JSON-RPC/MCP inspector smoke |
| Local/cloud parity | local fixture search equals cloud search | `test/memory-bank-cloud-parity.test.ts` |
| Sync idempotency | repeated sync no duplicates | `test/memory-bank-cloud-sync.test.ts` |
| Deployment smoke | staging remote connector works | scripted connector smoke |

### Acceptance criteria for “cloud memory-bank 제품”

아래가 모두 통과해야 제품이라고 부른다.

1. `memory-bank-cloud-mcp-server`에서 cloud tools가 실제로 노출된다.
2. Supabase-backed store가 token/session/context/exchanges/facts/audit를 저장한다.
3. 기존 기능 중 최소 MVP인 `search`, `read`, `search_facts`가 cloud에서 동작한다.
4. local fixture를 cloud에 ingest하고 검색할 수 있다.
5. 같은 org/team context는 공유되고, 다른 tenant/team/personal context는 차단된다.
6. token은 issuer 없이 발급되지 않고, issuer 범위를 넘어서는 membership을 만들 수 없다.
7. team-issued token은 org/company context를 읽거나 쓸 수 없다.
8. local memory-bank 기존 tests가 계속 통과한다.
9. staging Supabase 배포 smoke가 통과한다.
10. service role key가 고객/브라우저/client config에 노출되지 않는다.

## 5. 테스트 전략

### Unit tests

- token hash / expiry / revoked token.
- token issuer required.
- issuer scope clipping.
- visible scopes calculation.
- context ranking.
- personal privacy.
- team/org sharing.

### Integration tests

- Supabase local with migrations.
- RLS with simulated JWT claims.
- cloud MCP server list/call tools.
- Edge Functions local serve.

### Parity tests

- Existing fixture conversations.
- Local SQLite index result vs cloud ingest result.
- Local fact extraction result vs cloud fact search.

### Security tests

- cross-tenant query returns zero.
- cross-tenant token issuance denied.
- cross-org/team token issuance denied when issuer scope is narrower.
- team-issued token cannot read/write org/company context.
- scope outside membership write denied.
- service role not accepted in browser/client code.
- token hash only; raw token never persisted.
- MCP tool inputs are Zod validated.
- arbitrary file path read forbidden in cloud read.

### Load smoke for MVP

- 100 users × 3 sessions synthetic ingest.
- repeated context bundle lookup p95 budget.
- queue/spool retry simulation.

Enterprise load gates like 1,000 users × 10 terminals are later, not MVP.

## 6. 배포 계획

### Environments

| Env | Purpose | Data |
| --- | --- | --- |
| local | CLI/Supabase local dev | fixture only |
| staging | remote MCP connector smoke | synthetic tenant data |
| production | real users | approval-gated |

### Supabase deployment

Official flow to use:

```bash
supabase login
supabase link --project-ref <project-ref>
supabase db push
supabase functions deploy <function_name>
```

Use Supabase secrets for credentials. Service role keys are only server-side.

### MCP deployment options

1. **Local STDIO MCP**
   - easiest for Claude/Codex local use.
   - binary: `memory-bank-cloud-mcp-server`.
   - logs to stderr/file, never stdout.

2. **Remote MCP connector**
   - HTTPS hosted server.
   - used by Claude remote connector flow.
   - requires authentication, tool permission review, rate limits.

### Rollback

- Feature flag off: `MEMORY_BANK_CLOUD_ENABLED=0`.
- Keep local memory-bank default path unchanged.
- DB migrations are additive for MVP; no destructive migration before production approval.
- Edge Function rollback by deploying previous version or disabling route.
- Context promotion policies versioned; bad org/company policy can be disabled.

## 7. Risks and controls

| Risk | Control |
| --- | --- |
| Cross-tenant leak | RLS + store-layer tenant filters + isolation tests |
| Public MCP misuse | private connector, token login before tools, admin-only token issuance |
| Issuer privilege escalation | issuer-bound membership clipping + token issuance tests |
| It remains prototype-only | runtime MCP registration and Supabase adapter are M1/M2 release blockers |
| Existing local memory-bank breaks | keep local default unchanged, run full `npm test` |
| Raw token leakage | store only hash, redact logs, no token in audit metadata |
| Service role exposure | server-only config, CI grep, never browser/customer config |
| Cloud read becomes arbitrary file read | cloud read uses object/exchange IDs only |
| Context quality/noise | provenance, scope, confidence, promotion workflow |
| Cost explosion | no server-side LLM in MVP; indexing/search first, async extraction later |

## 8. Definition of Done by release level

### MVP / private alpha

- Supabase-backed auth/context/exchange/fact store.
- Cloud MCP server exposes login/context/search/read/search_facts to authenticated clients.
- Token issuance is private admin/control-plane only.
- Local sync bridge can upload fixtures and real local events.
- RLS, tenant isolation, and issuer-boundary tests pass.
- Staging connector smoke pass.

### Beta

- Team/org admin membership management.
- Promotion workflow.
- Cloud ontology/trace/graph stats.
- Context ranking and stale metadata.
- Observability dashboard.

### Enterprise-ready

- Dedicated tenant isolation mode.
- Load tests for high concurrency.
- Audit export/legal hold/deletion DAG.
- DLP/secret scanning.
- Policy bundle rollback.
- SLO dashboards and incident runbooks.

## 9. Immediate next implementation task

Start with **M1 Runtime MCP registration**.

Reason: until cloud tools are visible through the actual MCP server, no user can use the prototype through Claude/Codex. This is the smallest step that converts the current source-only wrapper into a real integration point.

Concrete first patch:

1. Add `registerMemoryBankCloudTools(server, host)` helper.
2. Add `src/memory-bank-cloud-server.ts` dedicated stdio server.
3. Add `cli/memory-bank-cloud-mcp-server` bin.
4. Add MCP tool-list smoke test.
5. Run:

```bash
npx tsc --noEmit
npx vitest run test/memory-bank-cloud.test.ts test/memory-bank-cloud-mcp-server.test.ts
npm test
```

## 10. Sources

- Supabase Row Level Security: https://supabase.com/docs/guides/database/postgres/row-level-security
- Supabase Edge Functions: https://supabase.com/docs/guides/functions
- Supabase Local Development / CLI migrations: https://supabase.com/docs/guides/local-development/overview
- Model Context Protocol SDKs: https://modelcontextprotocol.io/docs/sdk
- Build an MCP server: https://modelcontextprotocol.io/docs/develop/build-server
- Connect to remote MCP servers: https://modelcontextprotocol.io/docs/develop/connect-remote-servers
