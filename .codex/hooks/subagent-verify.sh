#!/bin/bash

# subagent-verify.sh
# SubagentStop Hook: 서브에이전트 종료 시 NEVER DO 위반 감지
# agent_type별 변경 파일 패턴 검사, 위반 시 exit 2 차단

# jq 없으면 python3 폴백
if ! command -v jq &>/dev/null; then
  jq() {
    python3 -c "
import sys, json
data = json.load(sys.stdin)
path = sys.argv[1].lstrip('.').split('.')
for key in path:
    key = key.split('//')[0].strip()
    data = data.get(key, '') if isinstance(data, dict) else ''
print(data if data else '')
" "$@"
  }
fi

INPUT=$(cat)

AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // empty')
STATUS=$(echo "$INPUT" | jq -r '.status // empty')

# 에러 종료 로그
if [ "$STATUS" = "error" ] || [ "$STATUS" = "failed" ]; then
  echo "[SubagentStop] $AGENT_TYPE 에러 종료: $STATUS" >&2
fi

# git 저장소인지 확인
if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  exit 0
fi

# 서브에이전트의 변경분만 추출 (stdin JSON의 changed_files 또는 git diff 폴백)
CHANGED_FROM_INPUT=$(echo "$INPUT" | jq -r '.changed_files[]? // empty' 2>/dev/null)
if [ -n "$CHANGED_FROM_INPUT" ]; then
  CHANGED="$CHANGED_FROM_INPUT"
else
  # 폴백: 스냅샷 기반 비교 (스냅샷 없으면 전체 diff 사용)
  SNAPSHOT_DIR="/tmp/claude-subagent-snapshots"
  SNAPSHOT_FILE="$SNAPSHOT_DIR/${AGENT_TYPE:-unknown}-files.txt"
  if [ -f "$SNAPSHOT_FILE" ]; then
    # 스냅샷 시점과 현재 diff 비교로 서브에이전트 변경분 추출
    CURRENT_FILES=$(git diff --name-only 2>/dev/null; git diff --cached --name-only 2>/dev/null)
    PREV_FILES=$(cat "$SNAPSHOT_FILE" 2>/dev/null)
    # 현재 변경 파일에서 이전 스냅샷에 있던 파일 제외
    CHANGED=$(comm -23 <(echo "$CURRENT_FILES" | sort -u) <(echo "$PREV_FILES" | sort -u) 2>/dev/null)
    rm -f "$SNAPSHOT_FILE"
  else
    CHANGED=$(git diff --name-only 2>/dev/null; git diff --cached --name-only 2>/dev/null)
  fi
fi

if [ -z "$CHANGED" ]; then
  exit 0
fi

VIOLATION=""

# 에이전트별 NEVER DO 위반 체크
case "$AGENT_TYPE" in
  frontend-specialist)
    if echo "$CHANGED" | grep -qiE "(route|controller|service|migration|schema|\.env)"; then
      VIOLATION="frontend-specialist가 백엔드/DB 파일 수정"
    fi
    ;;
  backend-specialist)
    if echo "$CHANGED" | grep -qiE "\.(tsx|jsx|css|scss|tailwind)"; then
      VIOLATION="backend-specialist가 프론트엔드 파일 수정"
    fi
    ;;
  code-reviewer)
    # code-reviewer는 파일 수정 자체가 위반
    MODIFIED_COUNT=$(echo "$CHANGED" | grep -c '.' || true)
    if [ "$MODIFIED_COUNT" -gt 0 ]; then
      VIOLATION="code-reviewer가 파일을 수정함 (리뷰만 가능)"
    fi
    ;;
  telegram-notifier)
    MODIFIED_COUNT=$(echo "$CHANGED" | grep -c '.' || true)
    if [ "$MODIFIED_COUNT" -gt 0 ]; then
      VIOLATION="telegram-notifier가 파일을 수정함 (알림만 가능)"
    fi
    ;;
  architect-designer)
    if echo "$CHANGED" | grep -qiE "\.(ts|tsx|js|jsx|dart|py)$"; then
      VIOLATION="architect-designer가 프로덕션 코드 수정"
    fi
    ;;
  bug-fixer)
    # 버그 수정 범위를 넘는 새 기능 파일 생성은 git diff로 감지 불가
    # any 타입 회피만 체크 (staged 파일에서)
    if git diff --cached -U0 2>/dev/null | grep -E '^\+' | grep -qE ':\s*any\b'; then
      VIOLATION="bug-fixer가 any 타입으로 에러 회피"
    fi
    ;;
  supabase-specialist)
    if echo "$CHANGED" | grep -qiE "\.(tsx|jsx|css|scss)$"; then
      VIOLATION="supabase-specialist가 프론트엔드 UI 코드 수정"
    fi
    ;;
  web-qa-tester)
    # 소스 코드 수정은 위반 (테스트 코드/설정만 허용)
    # 코드 파일 중 테스트가 아닌 파일이 있는지 확인
    NON_TEST_CODE=$(echo "$CHANGED" | grep -iE "\.(ts|tsx|js|jsx|dart|py)$" | grep -ivE "(test|spec|__tests__|\.test\.|\.spec\.|e2e|cypress|playwright)" || true)
    if [ -n "$NON_TEST_CODE" ]; then
      VIOLATION="web-qa-tester가 소스 코드 직접 수정 (테스트만 가능)"
    fi
    ;;
  flutter-developer)
    if echo "$CHANGED" | grep -qiE "\.(tsx|jsx|vue)$"; then
      VIOLATION="flutter-developer가 웹 프론트엔드 코드 수정"
    fi
    if echo "$CHANGED" | grep -qiE "(route|controller|service)\.(ts|js|py|java)$"; then
      VIOLATION="flutter-developer가 서버사이드/백엔드 코드 수정"
    fi
    ;;
  figma-designer)
    # 비즈니스 로직 수정은 위반 (UI 컴포넌트/스타일만 허용)
    if echo "$CHANGED" | grep -qiE "(service|repository|controller|api|middleware)\.(ts|js|dart)$"; then
      VIOLATION="figma-designer가 비즈니스 로직 파일 수정"
    fi
    ;;
  team-orchestrator|manager-orchestrator)
    # 코드 직접 작성/수정은 위반
    if echo "$CHANGED" | grep -qiE "\.(ts|tsx|js|jsx|dart|py|java|go|rs)$"; then
      VIOLATION="${AGENT_TYPE}가 프로덕션 코드 직접 수정 (위임만 가능)"
    fi
    ;;
esac

if [ -n "$VIOLATION" ]; then
  echo "" >&2
  echo "--- NEVER DO 위반 감지 ---" >&2
  echo "에이전트: $AGENT_TYPE" >&2
  echo "위반: $VIOLATION" >&2
  echo "변경 파일:" >&2
  echo "$CHANGED" | head -10 >&2
  exit 2
fi

exit 0
