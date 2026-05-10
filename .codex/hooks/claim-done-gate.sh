#!/bin/bash
# claim-done-gate.sh
# SubagentStop / TaskCompleted 이벤트에서 "완료 선언"을 검증.
# 코드 변경이 있었는데 .qa-cycle-passed가 없으면 차단 (exit 2).
#
# HARD 강제: 서브에이전트가 QA 없이 "완료" 보고하는 걸 exit code로 막음.

set -euo pipefail

# stdin에서 hook event JSON 읽기
INPUT=$(cat 2>/dev/null || echo '{}')

# jq 없으면 python3
if ! command -v jq &>/dev/null; then
  jq() {
    python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    path = sys.argv[1].lstrip('.').split('.')
    for key in path:
        key = key.split('//')[0].strip()
        data = data.get(key, '') if isinstance(data, dict) else ''
    print(data if data else '')
except Exception:
    print('')
" "$@"
  }
fi

# 프로젝트 루트 찾기
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$PROJECT_ROOT"

# 코드 변경 여부 체크 (staged + unstaged)
CHANGED_FILES=$(git status --porcelain 2>/dev/null | awk '{print $2}' || true)

if [ -z "$CHANGED_FILES" ]; then
  # 변경 없음 → 통과
  exit 0
fi

# 코드 파일만 필터 (ts/tsx/js/jsx/py/dart/kt/java/go/rs/vue/svelte)
CODE_CHANGES=$(echo "$CHANGED_FILES" | grep -E '\.(ts|tsx|js|jsx|py|dart|kt|java|go|rs|vue|svelte|mjs|cjs)$' || true)

if [ -z "$CODE_CHANGES" ]; then
  # 문서/설정만 변경 → 통과
  exit 0
fi

# 코드 변경이 있는데 .qa-cycle-passed가 없거나 오래됨 → 차단
if [ ! -f ".qa-cycle-passed" ]; then
  echo "❌ claim-done-gate: 코드 변경이 있는데 .qa-cycle-passed 파일이 없습니다." >&2
  echo "   변경된 코드 파일:" >&2
  echo "$CODE_CHANGES" | head -5 | sed 's/^/     /' >&2
  echo "" >&2
  echo "   QA 실행 필수: Skill(\"qa-cycle\")" >&2
  exit 2
fi

# .qa-cycle-passed가 있어도 최근 1시간 이내여야 유효
QA_AGE=$(( $(date +%s) - $(stat -f %m ".qa-cycle-passed" 2>/dev/null || stat -c %Y ".qa-cycle-passed" 2>/dev/null || echo 0) ))
if [ "$QA_AGE" -gt 3600 ]; then
  echo "❌ claim-done-gate: .qa-cycle-passed 파일이 1시간 이상 지났습니다. ($((QA_AGE/60))분 전)" >&2
  echo "   코드 변경 후 QA 재실행 필요." >&2
  exit 2
fi

exit 0
