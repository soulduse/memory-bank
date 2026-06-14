# memory-bank 성능 측정 리포트 — 검색 · 저장 · 온톨로지 구성

측정일: 2026-06-14 · DB 4.4GB · exchanges 239,037 · active facts 6,384 · 측정: read-only (`bench-perf.mjs`)

> 범위: 성능 측정 + 개선점 식별만. **코드 변경 없음.**

---

## 0. 한 줄 요약

| 경로 | 실측 | 판정 |
|------|------|------|
| **대화 벡터 검색** | **결과 0건 (기능 死)** — embedding_version 불일치 | 🔴 CRITICAL |
| **대화 텍스트 검색(LIKE)** | p50 **3,178ms** / p95 **14,459ms** | 🔴 CRITICAL (FTS 부재) |
| fact 벡터 검색 | p50 4ms / p95 36ms | 🟢 우수 |
| 임베딩 생성 | p50 2.9ms | 🟢 우수 |
| **온톨로지 classify 프롬프트** | **95,247 토큰/fact** (1,612 카테고리 전량 주입) | 🔴 CRITICAL |
| 온톨로지 카테고리 과분할 | 1,612개 중 **750개(47%)가 fact 1개뿐** | 🟠 HIGH |
| fact당 LLM 호출 | classify×1 + relation×(0~5) = **최대 6회** | 🟠 HIGH |

---

## 1. 🔴 대화 벡터 검색이 죽어 있음 (embedding_version 불일치)

```
현재 EMBEDDING_VERSION = 3   (모델: Xenova/multilingual-e5-small)
exchanges embedding_version: v0=63,995 / v1=175,042 / v3=0
→ search.ts 의 `WHERE e.embedding_version = ?(3)` 필터가 전 행 제외
→ vec_exchanges MATCH 는 돌지만 JOIN 후 결과 0건
```

- `search` MCP 도구의 `vector`/`both`(기본) 모드는 **대화에 대해 항상 0건 벡터 결과**를 반환하고 조용히 LIKE 텍스트 검색으로만 동작.
- 원인: 임베딩 모델이 `all-MiniLM-L6-v2` → `multilingual-e5-small`(v3)로 교체됐는데, **facts는 v3 재임베딩 완료(6,384 전량)** 됐으나 **exchanges 239,037건은 재임베딩이 한 번도 완료되지 않음**(여전히 v0/v1).
- 영향: 의미 기반 대화 검색이 전면 무력화. 모든 대화 검색이 아래 느린 LIKE 경로로 강등됨.

## 2. 🔴 대화 텍스트 검색 = FTS 없는 LIKE 풀스캔

```
text_like_search_exchanges_ms: p50 3,178 · p95 14,459 · max 14,459
```

- FTS5 테이블 **부재**. `user_message LIKE '%q%' OR assistant_message LIKE '%q%'` 로 239K행 × 2개 TEXT 컬럼 풀스캔(인덱스 불가).
- `mode='both'`(기본)는 **항상** LIKE를 실행 → §1로 벡터가 죽은 지금, 모든 대화 검색이 3~14초.
- 4.4GB DB에서 디스크 I/O까지 겹쳐 p95가 14초까지 튐.

## 3. 🔴 온톨로지 classify: fact당 95K 토큰 프롬프트

```
ontology_classify_prompt: 1,612 categories → 333,364 chars ≈ 95,247 tokens / fact
```

- `classifyFactToOntology()`가 **매 fact마다 전체 도메인(25) + 전체 카테고리(1,612)를 프롬프트에 그대로 주입**(`listCategories(db)` 전량). 프롬프트가 카테고리 수에 비례(O(N))해 무한 증가.
- fact 1건 분류에 Haiku 입력 95K 토큰 — 비용·지연·컨텍스트 한계 3중 부담. 백필 시 워커가 자주 죽던 주원인 후보.
- 역설: 95K 토큰 목록을 줘도 LLM이 의미 있게 재사용 못 해 **카테고리 폭증**(아래 §4).

## 4. 🟠 카테고리 과분할 (ontology 품질)

```
1,612 categories / 25 domains = 평균 64.5 cats/domain
사용 카테고리 1,598개 중: fact 1개 750(47%) · 2~3개 459 · 4+ 389
top domain "Development Workflow" 혼자 192 카테고리
```

- "prefer reuse" 지시만으로는 재사용 실패 — 절반이 fact 1개짜리 단발 카테고리. 온톨로지가 그래프가 아니라 거의 1:1 태그로 퇴화.
- 95K 토큰 평면 목록(도메인 내 그룹핑·임베딩 후보 선별 없음)이 근본 원인.

## 5. 🟠 fact당 최대 6회 LLM 호출

- `classifyAndLinkFact` = `classifyFactToOntology`(95K토큰 ×1) + `detectRelations`(상위 5개 후보마다 Haiku ×1, 최대 5).
- fact 1건 저장에 LLM 왕복 최대 6회. 6,384 facts × (분류+관계) = 온톨로지 구성 시간/비용의 지배적 요인.

## 6. 🟢 정상 경로 (참고)

- **fact 벡터 검색** p50 4ms / p95 36ms — dual-index(영문+한글) 머지 + 버전 필터까지 포함해도 빠름. facts가 v3로 정합되어 있어 건강.
- **임베딩 생성** p50 2.9ms (로컬 모델, warm) — 저장 경로의 임베딩 비용은 병목 아님. 저장 병목은 LLM(추출+분류) 쪽.
- **insert/upsert** — vec 인덱스 DELETE+INSERT 트랜잭션, embedding_version 결합, 원자적 락 모두 적용됨(건강).

---

## 개선점 (우선순위순, 구현은 별도)

### P0 — 대화 벡터 검색 복구 (가장 큰 효과)
1. **exchanges 239K건 v3 재임베딩 백필** 완료 → 벡터 검색 부활. facts에 쓴 동일 패턴(recency-first, additive, watchdog cron)으로 워커화. 완료 시 §1·§2 동시 해소(대화 검색이 3~14초 LIKE → 60ms 벡터로).
2. 재임베딩 진행 중 graceful degrade: 버전 불일치로 0건일 때 사용자에게 "벡터 인덱스 재구축 N% 진행" 노출(조용한 LIKE 강등 대신).

### P1 — 텍스트 검색 FTS5 전환
3. exchanges에 **FTS5 가상테이블**(user_message, assistant_message) + content-sync 트리거 추가 → LIKE 풀스캔(3~14s)을 BM25 인덱스(수~수십 ms)로. 벡터가 복구돼도 `both` 모드의 텍스트 폴백이 빨라야 함.

### P1 — 온톨로지 classify 프롬프트 축소 (95K → ~2K 토큰)
4. **후보 선별(candidate retrieval)**: 전체 1,612 카테고리 주입 대신, fact 임베딩으로 **카테고리 임베딩 top-K(예: 15)만** 프롬프트에 제시. classify를 O(N)→O(K)로. 비용·지연 ~98% 절감 + 재사용률 상승.
5. **2단계 분류**: 먼저 도메인(25개) 선택 → 그 도메인의 카테고리만 제시. 프롬프트가 64개 평균으로 축소.

### P2 — 카테고리 정리 + 관계 호출 절감
6. **카테고리 병합 패스**: fact 1개짜리 750개를 임베딩 유사도로 인접 카테고리에 병합(1,612 → 목표 ~200). 온톨로지를 태그에서 그래프로 복원.
7. `detectRelations` 후보를 5→2~3으로 줄이거나, 유사도 상위 1쌍만 LLM 검증 → fact당 LLM 호출 최대 6→3.

### P2 — 검색 기본 모드 점검
8. 벡터 복구 후 `mode='both'`가 매번 LIKE까지 도는 비용 재검토 — 벡터 결과 충분 시 텍스트 스킵(early-exit).

---

## 측정 재현
```bash
node bench-perf.mjs   # read-only, 프로덕션 DB 미변경
```

---

## 구현 후 실측 (2026-06-14, P0~P2 적용)

| 항목 | Before | After | 개선 |
|------|--------|-------|------|
| 대화 텍스트 검색 | p50 2,971ms / p95 3,908ms (LIKE 풀스캔) | **p50 2.9ms / p95 72.9ms** (FTS5 BM25) | **~1,024×** |
| classify 프롬프트 | 92,587 토큰 (1,550 카테고리 전량) | **1,752 토큰** (top-20 후보) | **-98.1%** |
| fact당 LLM 호출 | 최대 6회 | **최대 3회** (relations 5→2) | -50% |
| 카테고리 수 | 1,612 | **1,550** | 62건 클린 병합(동일도메인·sim≥0.93) |
| 대화 벡터 검색 | 0건 (버전불일치 死) | 재임베딩 진행중 → v3 도달 시 부활 | P0 워치독 수렴 |

### 구현 내역
- **P0**: `reembed-worker.js`(기존, exchanges newest-first·resumable) 백그라운드 실행 + 4분 워치독 cron. 239K exchanges를 v3로 업그레이드 → 완료 시 대화 벡터검색 부활.
- **P1-FTS**: `db.ts`에 external-content FTS5 + 동기화 트리거, `search.ts` text 모드 FTS MATCH(LIKE fallback) + both 모드 early-exit, `scripts/backfill-fts.mjs`로 239K 1회 rebuild(34초).
- **P1-classify**: `db.ts` vec_categories 테이블, `ontology-db.ts` searchSimilarCategories/upsertCategoryEmbedding, `ontology-classifier.ts` 후보 top-20 선별 + 신규 카테고리 임베딩, `scripts/backfill-category-embeddings.mjs`(1,612개 13초).
- **P2-merge**: `scripts/merge-singleton-categories.mjs` 단발 카테고리를 동일 도메인 안정 카테고리로 sim≥0.93 병합(62건, fact 재할당·빈 카테고리 삭제, DRY_RUN 지원).
- **P2-relations**: `detectRelations` 후보 5→2.

### 남은 수렴(백그라운드)
- P0 재임베딩 239K건은 watchdog cron이 0까지 자동 수렴(완료 시 텔레그램 알림 + cron 자동 종료). 완료 전까지 대화 검색은 FTS(수ms)로 정상 동작.
- 카테고리 추가 축소(1,550→더↓)는 sim 0.91에서 일부 오병합 관측되어 보류 — 향후 sprawl은 새 candidate-retrieval classifier가 구조적으로 차단.

---

## P0 완료 (2026-06-15 01:49 KST) — 대화 벡터검색 부활

- **전체 exchanges 323,218건 모두 embedding_version=3 도달** (non-v3 = 0). reembed-worker가 newest-first·resumable로 전량 업그레이드 완료.
- **벡터검색 부활 검증**: `searchConversations(mode:"vector")` → 결과 5건 반환, top similarity 0.5537 (이전: 버전 불일치로 0건 死). 대화 의미검색이 정상 동작.
- 시작 시점(239,037건 전량 v0/v1) 대비, 세션 중 sync가 추가 import한 분(총 323,218)까지 포함해 100% v3 정합.
- 이로써 P0(대화 벡터검색 복구) + P1(FTS5·classify 후보선별) + P2(카테고리 병합·detectRelations 축소) 우선순위 개선 전부 완료.
