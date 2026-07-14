# Memory Bank — Knowledge Galaxy

memory-bank 온톨로지(도메인 · 카테고리 · fact · 타입 관계)를 3D 관계도 galaxy 로
시각화하는 정적 웹앱. `claude-code-site` 의 ERP 관계도 galaxy 디자인 언어(다크 테마,
Three.js 포인트클라우드, 좌측 레일, 우측 슬라이드 상세 패널)를 memory-bank 구조로 재구성했다.

## 매핑

| 시각 요소 | memory-bank 데이터 |
|-----------|-------------------|
| 색상 클러스터 | `ontology_domains` (31 + Uncategorized) |
| 서브클러스터 · 라벨 | `ontology_categories` |
| 파티클 노드 (크기 = 관계 수) | `facts` (active) |
| 타입별 관계 엣지 | `ontology_relations` — SUPPORTS(green) · INFLUENCES(teal) · SUPERSEDES(amber) · CONTRADICTS(rose) |

## 구성

```
generate-data.mjs   DB(read-only) → data.json 생성기
data.json           생성된 그래프 데이터 (gitignore — 개인 fact 포함, 로컬 생성)
index.html          UI (디자인/레이아웃)
app.js              Three.js galaxy 렌더 엔진
three.min.js        Three.js (vendored)
orbit-controls.js   OrbitControls (vendored)
```

## 실행

```bash
# 1) 데이터 생성 (memory-bank DB 에서 — 개인 데이터라 커밋되지 않음)
node ui/relations/generate-data.mjs

# 2) 정적 서빙 후 브라우저에서 열기
cd ui/relations && python3 -m http.server 8899 --bind 127.0.0.1
# → http://127.0.0.1:8899/index.html
```

`MEMORY_BANK_DB_PATH` 로 DB 경로를 재지정할 수 있다 (기본:
`~/.config/superpowers/conversation-index/db.sqlite`).

## 인터랙션

- **드래그** 회전 · **스크롤** 줌 · 유휴 시 자동 회전
- 노드 **hover** → 카드(도메인 · 카테고리 · preview · 관계 수)
- 노드 **click** → 우측 패널(전체 fact · 타입별 관계 목록) + 선택 노드 관계 엣지 하이라이트
- 상단 **fact 검색** (⌘K) · 좌측 레일 **도메인 브라우저**
- 컨트롤 바에서 **관계 타입 엣지 토글** (기본: SUPERSEDES · CONTRADICTS)

## 개인정보

`data.json` 은 사용자의 개인 지식(Personal Mirror 등)을 포함하므로 **git 에 커밋하지 않는다**
(`.gitignore` 처리). 코드만 커밋되고, 각자 로컬에서 자신의 DB 로 생성한다.
