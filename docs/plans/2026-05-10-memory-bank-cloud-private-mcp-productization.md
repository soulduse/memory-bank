# Memory Bank Cloud Private MCP 제품화 실행 계획

> 생성일: 2026-05-10 KST  
> Branch: `feature/memory-bank-cloud-context-sharing`  
> 목적: 기존 local memory-bank 기능을 보존하면서, Supabase-backed cloud memory-bank와 **private issuer-bound MCP context sharing**을 제품 수준으로 완성한다.

## 1. 최종 제품 정의

Memory Bank Cloud는 공개 MCP가 아니다. 회사/조직/팀/프로젝트/개인 context를 아무나 조회하는 도구가 아니라, **인증토큰 발급 주체가 허용한 scope 안에서만 context가 자동 공유되는 private MCP 제품**이다.

### Product contract

- Local memory-bank는 기본값으로 그대로 동작한다.
- Cloud mode는 별도 MCP/server/config로 추가된다.
- Claude, Codex, worker는 token login 후 context bundle을 받는다.
- Context bundle은 issuer boundary로 clip된 company/org/team/project/personal scope만 포함한다.
- Supabase는 MCP host의 cloud persistence/RLS/audit plane이다.
- 기존 memory-bank 핵심 기능 중 MVP는 cloud에서도 제공한다.
  - `search`
  - `read`
  - `search_facts`

## 2. 절대 불변 조건

### 2.1 Private MCP

- Cloud MCP endpoint는 공개 MCP로 운영하지 않는다.
- 기본 client-facing tool list에는 `memory_bank_cloud_issue_token`을 노출하지 않는다.
- `issue_token`은 admin/service control-plane profile에서만 노출한다.
- token 없이 context/search/read/facts tool 호출은 실패해야 한다.

### 2.2 Issuer-bound token

모든 login token은 반드시 issuer를 가진다.

```ts
interface CloudTokenIssuerContext {
  tenantId: string;
  userId: string;
  scopeType: 'company' | 'org' | 'team' | 'project' | 'personal';
  scopeId: string;
  role: 'owner' | 'admin' | 'service';
}
```

허용 범위:

| Issuer scope | 발급 가능한 token/session 범위 |
| --- | --- |
| `company:{tenantId}` | 해당 tenant의 company/org/team/project/personal |
| `org:{orgId}` | 해당 org 이하의 org/team/project/personal |
| `team:{teamId}` | 해당 team 이하의 team/project/personal |
| `project:{projectId}` | 해당 project/personal |
| `personal:{userId}` | 해당 user 개인 context only |

금지:

- 다른 tenant/company token 발급.
- team issuer가 org/company context 접근.
- project issuer가 team/org/company context 접근.
- personal issuer가 다른 user 또는 shared scope 접근.
- server-only privileged credential을 browser/customer config에 노출.

## 3. 구현 범위

### In scope

- Cloud MCP runtime registration.
- Supabase migrations + store adapter.
- Cloud MVP parity: `search`, `read`, `search_facts`.
- Local-to-cloud sidecar sync.
- Context bundle resource/tool.
- RLS + domain/store double gate.
- Audit/provenance.
- Staging deployment plan and smoke path.

### Out of scope for MVP

- Public marketplace MCP.
- Server-side LLM extraction at request time.
- Enterprise SSO beyond token/control-plane contract.
- Full web admin dashboard.
- Cross-tenant analytics.

## 4. Phase 0 — Baseline / gates

### Tasks

- [x] Hard process contract 확인.
- [x] Current branch 확인.
- [x] Existing prototype files 확인.
- [x] Private issuer-bound invariant 반영 확인.
- [ ] 변경 전 baseline snapshot 저장.

### Commands

```bash
git branch --show-current
git status --short
python3 .codex/scripts/validate-hard-process-contract.py --project-root . --require-project-contract --json
npx vitest run test/memory-bank-cloud.test.ts
npx tsc --noEmit
npm test
```

### Commit point

- `plan: freeze private memory-bank-cloud productization roadmap`

## 5. Phase 1 — MCP runtime registration

목표: prototype wrapper가 아니라 실제 Claude/Codex MCP runtime에서 cloud tools가 보이게 한다.

### Files

- `src/memory-bank-cloud-mcp.ts`
- `src/memory-bank-cloud-server.ts`
- `cli/memory-bank-cloud-mcp-server`
- `package.json`
- `test/memory-bank-cloud-mcp-server.test.ts`
- `README.md`, `README-KR.md`, `CODEX.md`

### Tasks

1. `registerMemoryBankCloudTools(server, host, options)` 추가.
2. `options.includeAdminTools` 기본값 `false`로 고정.
3. client-facing server profile과 admin/control-plane profile 분리.
4. dedicated stdio entrypoint 작성.
5. stdout logging 금지, stderr/file logging만 허용.
6. JSON-RPC/MCP tool list smoke test 작성.
7. login/context tool call smoke test 작성.
8. README에 local MCP 연결 예시 추가.

### TDD checklist

- 기본 tool list에 `memory_bank_cloud_issue_token` 없음.
- admin profile에만 `memory_bank_cloud_issue_token` 있음.
- token 없이 context/search/read/facts 호출 실패.
- invalid args는 Zod error를 user-readable MCP content로 반환.

### Verification

```bash
npx vitest run test/memory-bank-cloud.test.ts test/memory-bank-cloud-mcp-server.test.ts
npx tsc --noEmit
npm run build
```

### Commit point

- `runtime: expose private memory-bank-cloud mcp server`

## 6. Phase 2 — Supabase DB/RLS 설계 및 adapter

목표: in-memory store를 Supabase-backed persistent store로 교체 가능하게 한다.

### Tables

- `mbc_tenants`
- `mbc_orgs`
- `mbc_teams`
- `mbc_projects`
- `mbc_users`
- `mbc_memberships`
- `mbc_login_tokens`
- `mbc_login_sessions`
- `mbc_context_entries`
- `mbc_exchanges`
- `mbc_exchange_payloads`
- `mbc_facts`
- `mbc_fact_sources`
- `mbc_audit_events`
- optional `mbc_embeddings`

### RLS policies

Every selectable/mutable table must include:

- `tenant_id = mbc_current_tenant_id()`
- membership visibility check for scoped rows.
- insert/update `WITH CHECK` matching current tenant/user/session.
- no broad policy for `mbc_login_tokens` client access.

### Files

- `supabase/migrations/0001_memory_bank_cloud.sql`
- `src/memory-bank-cloud-supabase-store.ts`
- `src/memory-bank-cloud-config.ts`
- `test/memory-bank-cloud-supabase-store.test.ts`
- `test/memory-bank-cloud-rls.test.ts`

### Tasks

1. Move schema skeleton from docs into additive migration.
2. Add `mbc_login_sessions` table.
3. Add cloud exchange/fact tables for MVP parity.
4. Implement Supabase config loader with server-only privileged credential access.
5. Implement token/session/context/audit store methods.
6. Add transaction/idempotency identifiers for ingest.
7. Add RLS tests with two tenants, two orgs, two teams.
8. Add server-only privileged credential exposure guard test.

### TDD checklist

- cross-tenant read returns zero.
- cross-tenant write fails.
- team-issued token cannot read org/company rows.
- personal context visible only to same user.
- raw token is never persisted.
- token hash is persisted.

### Verification

```bash
supabase start
supabase db reset
npx vitest run test/memory-bank-cloud-supabase-store.test.ts test/memory-bank-cloud-rls.test.ts
npx tsc --noEmit
```

### Commit point

- `storage: persist memory-bank-cloud in supabase with rls`

## 7. Phase 3 — Cloud MVP parity

목표: 기존 local memory-bank 사용자가 cloud mode에서도 최소 검색/읽기/fact 검색을 사용할 수 있게 한다.

### Tools

| Local | Cloud MVP | Notes |
| --- | --- | --- |
| `search` | `memory_bank_cloud_search` | scoped exchange snippets |
| `read` | `memory_bank_cloud_read` | cloud exchange/object id only |
| `search_facts` | `memory_bank_cloud_search_facts` | scoped facts |
| `search_ontology` | post-MVP | not release blocker |
| `trace_fact` | post-MVP | not release blocker |

### Files

- `src/memory-bank-cloud-ingest.ts`
- `src/memory-bank-cloud-search.ts`
- `src/memory-bank-cloud-facts.ts`
- `src/memory-bank-cloud-read.ts`
- `test/memory-bank-cloud-parity.test.ts`
- `test/fixtures/memory-bank-cloud/*.jsonl`

### Tasks

1. Define cloud exchange object id format.
2. Add fixture ingest path from local JSONL/parsed conversation.
3. Add text search with escaped LIKE/FTS equivalent.
4. Add fact ingest/search MVP.
5. Add read by cloud object id.
6. Block arbitrary filesystem path reads in cloud read.
7. Add local/cloud fixture parity tests.

### TDD checklist

- cloud search returns only issuer-visible entries.
- cloud read cannot read local filesystem paths.
- local fixture expected hit appears in cloud search.
- project scoped fact does not leak to other project/team/tenant.

### Verification

```bash
npx vitest run test/memory-bank-cloud-parity.test.ts test/memory-bank-cloud.test.ts
npx tsc --noEmit
npm test
```

### Commit point

- `search: add cloud memory-bank mvp parity`

## 8. Phase 4 — Local sidecar sync / context bundle

목표: Claude/Codex가 서로 작업 내용을 직접 전달하지 않아도 cloud context plane에 자동 반영되게 한다.

### Files

- `src/memory-bank-cloud-sync.ts`
- `src/memory-bank-cloud-spool.ts`
- `src/memory-bank-cloud-resource.ts`
- `cli/memory-bank-cloud-sync`
- `test/memory-bank-cloud-sync.test.ts`

### Tasks

1. Local event envelope 정의.
2. Spool directory + ack state 구현.
3. Idempotency identifier: tenant/project/session/exchange hash.
4. Sync command: `status`, `push`, `retry`, `doctor`.
5. MCP Resource: `memory-bank-cloud://context/current`.
6. Context ranking: company → org → team → project → personal.
7. Promotion workflow placeholder: personal → team/org/company explicit promotion only.

### TDD checklist

- repeated sync does not duplicate rows.
- offline spool preserves events.
- sync failure redacts tokens and privileged values in logs.
- context bundle includes only clipped scopes.

### Verification

```bash
npx vitest run test/memory-bank-cloud-sync.test.ts test/memory-bank-cloud.test.ts
npx tsc --noEmit
npm test
```

### Commit point

- `sync: mirror local memory-bank context to cloud plane`

## 9. Phase 5 — Deployment / operations

목표: private alpha 수준으로 local MCP + staging remote MCP를 검증한다.

### Local deployment

```bash
npm run build
memory-bank-cloud-mcp-server
```

### Supabase staging

```bash
supabase login
supabase link --project-ref <staging-ref>
supabase db push
supabase functions deploy token-login
supabase functions deploy context-bundle
supabase functions deploy ingest-event
```

### Remote MCP

- HTTPS endpoint.
- Auth required.
- Rate limit required.
- `issue_token` route excluded from public connector manifest.
- Admin/control-plane route uses separate server-side auth and audit.

### Smoke tests

- login with scoped token.
- context bundle returns expected scopes.
- cross-tenant token fails.
- team-issued token cannot see org/company context.
- search/read/search_facts return scoped data.

### Rollback

- `MEMORY_BANK_CLOUD_ENABLED=0`.
- Disable remote MCP route.
- Re-deploy previous Edge Function version.
- Keep migrations additive until production approval.
- Local memory-bank remains default fallback.

### Commit point

- `deploy: document private memory-bank-cloud alpha rollout`

## 10. QA / 검수 계획

### Required gates per PR

```bash
python3 .codex/scripts/validate-hard-process-contract.py --project-root . --require-project-contract --json
npm run build
npx tsc --noEmit
npm test
python3 ~/.codex/scripts/qa-cycle-runtime.py --project-root . --scope feature --max-rounds 1
```

### Required gates before private alpha

```bash
python3 ~/.codex/scripts/qa-cycle-runtime.py --project-root . --scope full-regression --max-rounds 1
supabase db reset
npx vitest run test/memory-bank-cloud-supabase-store.test.ts test/memory-bank-cloud-rls.test.ts test/memory-bank-cloud-parity.test.ts test/memory-bank-cloud-sync.test.ts
```

### Manual/security review checklist

- [ ] `issue_token` hidden from client-facing MCP manifest.
- [ ] issuer-bound clipping in domain tests.
- [ ] RLS denies cross-tenant access.
- [ ] server-only privileged credential never reaches browser/client config.
- [ ] raw token not stored or logged.
- [ ] cloud read cannot access arbitrary filesystem paths.
- [ ] audit event emitted for token issue/login/context/search/read.

## 11. Definition of Done

### M1 runtime done

- Dedicated MCP server exists.
- Client-facing tools exclude `issue_token`.
- Admin profile includes `issue_token`.
- MCP smoke tests pass.

### MVP private alpha done

- Supabase-backed token/session/context/exchange/fact/audit store works.
- Cloud MCP exposes login/context/search/read/search_facts to authenticated clients.
- Local-to-cloud sync uploads fixtures and real local events.
- RLS + issuer-boundary tests pass.
- Staging remote MCP smoke passes.
- Local memory-bank default behavior remains unchanged.

## 12. Immediate next implementation batch

Batch A — runtime registration:

1. Add `registerMemoryBankCloudTools`.
2. Add `src/memory-bank-cloud-server.ts`.
3. Add `cli/memory-bank-cloud-mcp-server`.
4. Add package bin/build wiring.
5. Add MCP tool-list smoke test.
6. Update README/CODEX connection notes.
7. Run targeted + typecheck + build.

Batch A is the smallest useful next slice because product validation is impossible until Claude/Codex can see the private cloud MCP runtime.

## 13. Current validation evidence

This plan artifact has been validated locally. Full project `qa-cycle` is currently BLOCKED by the repository's pre-existing hard UI QA contract, not by this plan artifact. See:

- `docs/qa-report-2026-05-10-memory-bank-cloud-plan.md`
- `.omx/specs/team-hue-memory-bank-cloud-plan/result.json`

Validated checks:

- hard process contract: PASS
- `npm run build`: PASS
- `npx tsc --noEmit`: PASS
- `npx vitest run test/memory-bank-cloud.test.ts`: 11 passed
- `npm test`: 30 files / 242 tests passed
- plan validator: PASS
- `qa-cycle`: BLOCKED by existing hard UI E2E/interaction contract

