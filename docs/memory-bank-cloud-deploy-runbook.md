# Memory Bank Cloud — Deploy Runbook (private alpha)

> 상태 요약 (2026-06-14)
>
> - **구현(Phase 1~4) 완료**: 12개 src 모듈 + 28개 cloud 테스트 통과(issuer-boundary 보안 테스트 포함), 빌드/타입체크 통과, main 병합 완료.
> - **로컬 완성분 추가**: `cli/memory-bank-cloud-sync`(status/push/retry/doctor), `syncMemoryBankCloudSpoolAsync`, issuer-boundary 도메인 테스트, `supabase/config.toml`.
> - **배포(Phase 5) 미완**: 신규 Supabase 프로젝트 생성이 **`hugh studio` org 미납 인보이스로 차단**됨. 인보이스 정산 후 아래 절차로 배포.

## 0. 선결 조건 (사람 작업 — 결제)

Supabase 대시보드 → Organization `hugh studio` → **Invoices** 에서 미납 인보이스를 정산한다.
정산 전에는 신규 프로젝트 생성이 거부된다(검증된 차단 사유):

```
There are overdue invoices in the organization(s) hugh studio.
Head to the organization's invoices page to settle the invoices before creating a new project.
```

## 1. 프로젝트 생성

```bash
DBPW=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 28)   # 안전 보관
supabase projects create memory-bank-cloud \
  --org-id mjnxmpcguljvstkxrxun \
  --db-password "$DBPW" \
  --region ap-northeast-2 \
  --yes
# 출력의 project ref(REF) 기록
```

## 2. 링크 + 마이그레이션 적용 (DB + RLS)

```bash
supabase link --project-ref <REF>
supabase db push        # supabase/migrations/0001_memory_bank_cloud.sql 적용 (mbc_* 테이블 + RLS)
```

## 3. stdio Cloud MCP 서버 연결 (핵심 제품 경로 — Edge Function 불필요)

운영자 환경에 service role 토큰을 두고 stdio MCP 서버를 띄운다. 클라이언트에는 토큰을 배포하지 않는다.

```bash
export MEMORY_BANK_CLOUD_SUPABASE_URL="https://<REF>.supabase.co"
export SUPABASE_SERVICE_ROLE_TOKEN="<service_role_key>"   # 서버 전용. 브라우저/클라이언트 노출 금지
export MEMORY_BANK_CLOUD_ADMIN_TOOLS=1                     # issue_token 노출(admin/control-plane 전용)
memory-bank-cloud-mcp-server --admin
```

- 기본 client-facing 프로필에는 `memory_bank_cloud_issue_token`이 없어야 한다(admin/`--admin`에서만 노출). 이는 `test/memory-bank-cloud-mcp-server.test.ts`로 검증됨.
- 로컬 memory-bank(기본값)는 영향 없음. cloud는 별도 서버/env로만 활성화되는 opt-in.

## 4. Smoke (정산·배포 후 실행 — 현재는 billing 차단으로 미실행)

플랜 §9 기준:

- scoped token으로 login 성공
- context bundle이 기대 scope만 반환
- cross-tenant token 실패
- team-issued token이 org/company context를 못 봄
- search/read/search_facts가 scope 클리핑된 데이터만 반환

> 도메인 레벨(issuer 경계/scope 클리핑)은 이미 `test/memory-bank-cloud-issuer-boundary.test.ts`(8개)로 단위 검증됨.
> DB 레벨 RLS 런타임 검증은 `supabase db reset` + RLS 통합 테스트로 배포 후 수행.

## 5. (Phase 5 옵션) Remote MCP / Edge Functions

플랜의 `token-login` / `context-bundle` / `ingest-event` Edge Function은 **원격 HTTPS 제어 평면**용이며 MVP 필수가 아니다(3절의 stdio 서버가 전체 기능 제공). 배포 환경에서 실제 프로젝트에 대해 반복 검증(deno deploy + smoke)하며 작성한다. 검증 피드백 루프 없이 미리 작성하지 않는다(거짓 완료 방지).

요구사항(작성 시): HTTPS endpoint · Auth 필수 · Rate limit · `issue_token` 공개 매니페스트 제외 · 별도 server-side auth + audit.

## 6. Rollback

- `MEMORY_BANK_CLOUD_ENABLED=0` (또는 cloud env 미설정) → 로컬 memory-bank 기본값으로 폴백.
- 마이그레이션은 additive 유지(프로덕션 승인 전).
- 원격 MCP 라우트 비활성화 / 이전 Edge Function 버전 재배포.

## 남은 체크리스트 (정산 후)

- [ ] org 인보이스 정산
- [ ] 프로젝트 생성 + ref 기록
- [ ] `supabase db push` (RLS 적용 확인)
- [ ] service token으로 stdio MCP 서버 기동 + login/search/read/facts smoke
- [ ] (옵션) Edge Functions 작성 + deploy + smoke
- [ ] `.env`/토큰은 커밋 금지(no-env hook), service token은 서버 전용
