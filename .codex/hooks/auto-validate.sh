#!/bin/bash

# auto-validate.sh
# PostToolUse Hook (Edit|Write): 파일 변경 후 자동 검증
# 프로젝트 유형을 자동 감지하여 적절한 검증 실행

if [ "$CLAUDE_AUTO_VALIDATE" != "true" ]; then
  exit 0
fi

# stale git index.lock만 정리 (활성 git 프로세스 없고 120초 이상 경과한 경우)
# 무조건 삭제는 동시 git 작업의 동시성 가드를 제거해 인덱스 손상을 유발하므로 금지.
if [ -f ".git/index.lock" ]; then
  LOCK_MTIME=$(stat -f %m ".git/index.lock" 2>/dev/null || stat -c %Y ".git/index.lock" 2>/dev/null || echo 0)
  LOCK_AGE=$(( $(date +%s) - LOCK_MTIME ))
  if [ "$LOCK_AGE" -gt 120 ] && ! pgrep -x git >/dev/null 2>&1; then
    rm -f .git/index.lock 2>/dev/null
  fi
fi

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

# stdin에서 JSON 입력 읽기
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# 파일 경로가 없으면 스킵
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# 테스트 파일, 설정 파일, 문서 파일은 스킵
if echo "$FILE_PATH" | grep -qE '(\.test\.|\.spec\.|__tests__|\.md$|\.json$|\.yml$|\.yaml$|\.sh$)'; then
  exit 0
fi

VALIDATION_FAILED=0
ERROR_MESSAGES=""

# --- Node.js 프로젝트 ---
if [ -f "package.json" ]; then
  # TypeScript 파일이 변경된 경우 타입 체크
  if echo "$FILE_PATH" | grep -qE '\.(ts|tsx)$'; then
    if grep -q '"type-check"' package.json 2>/dev/null; then
      TYPE_OUTPUT=$(npm run type-check 2>&1)
      if [ $? -ne 0 ]; then
        VALIDATION_FAILED=1
        ERROR_MESSAGES+="[TYPE ERROR] $FILE_PATH\n$(echo "$TYPE_OUTPUT" | grep -E "error TS" | head -10)\n\n"
      fi
    elif command -v npx &>/dev/null && [ -f "tsconfig.json" ]; then
      # fallback: tsconfig.json이 있으면 tsc --noEmit 직접 실행
      TYPE_OUTPUT=$(npx tsc --noEmit 2>&1)
      if [ $? -ne 0 ]; then
        VALIDATION_FAILED=1
        ERROR_MESSAGES+="[TYPE ERROR] $FILE_PATH\n$(echo "$TYPE_OUTPUT" | grep -E "error TS" | head -10)\n\n"
      fi
    fi
  fi

  # JS/TS 파일이 변경된 경우 린트 체크
  if echo "$FILE_PATH" | grep -qE '\.(ts|tsx|js|jsx)$'; then
    if grep -q '"lint"' package.json 2>/dev/null; then
      LINT_OUTPUT=$(npx eslint "$FILE_PATH" 2>&1)
      if [ $? -ne 0 ]; then
        VALIDATION_FAILED=1
        ERROR_MESSAGES+="[LINT ERROR] $FILE_PATH\n$(echo "$LINT_OUTPUT" | head -10)\n\n"
      fi
    fi
  fi
fi

# --- Flutter 프로젝트 ---
if [ -f "pubspec.yaml" ]; then
  if echo "$FILE_PATH" | grep -qE '\.dart$'; then
    ANALYZE_OUTPUT=$(flutter analyze "$FILE_PATH" 2>&1)
    if [ $? -ne 0 ]; then
      VALIDATION_FAILED=1
      ERROR_MESSAGES+="[DART ANALYZE] $FILE_PATH\n$(echo "$ANALYZE_OUTPUT" | head -10)\n\n"
    fi
  fi
fi

# 검증 실패 시 — 에러 카운트 추적 + 강도별 대응
if [ $VALIDATION_FAILED -eq 1 ]; then
  # 에러 카운트 파일
  ERR_COUNT_FILE="/tmp/claude-validate-errors-$$"
  PROJECT_ERR="/tmp/claude-validate-$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo unknown)"
  COUNT=$(cat "$PROJECT_ERR" 2>/dev/null || echo 0)
  COUNT=$((COUNT + 1))
  echo "$COUNT" > "$PROJECT_ERR"

  if [ "$COUNT" -ge 3 ]; then
    # 3회 이상: HARD 차단 + 텔레그램 알림 + 에스컬레이션
    PROJECT_NAME=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")
    bash ~/.codex/scripts/telegram-notify.sh "🚨 [$PROJECT_NAME] 검증 3회 실패 — HARD 차단됨. 수동 개입 필요." 2>/dev/null &
    echo "3회 이상 검증 실패. 접근 방식을 변경하세요." >&2
    echo -e "$ERROR_MESSAGES" >&2
    echo "0" > "$PROJECT_ERR"
    exit 2
  fi

  # 1~2회: additionalContext로 수정 지시 (SOFT → 점점 강해짐)
  URGENCY="즉시 수정하세요 (실패 $COUNT/3 — 3회 시 HARD 차단)"
  echo -e "$ERROR_MESSAGES" | python3 -c "
import json, sys
errors = sys.stdin.read().strip()
msg = 'VALIDATION FAILED ($COUNT/3) — $URGENCY:\n' + errors + '\n수정 후 재저장하면 자동 재검증됩니다. 3회 실패 시 작업이 차단됩니다.'
out = {'hookSpecificOutput':{'hookEventName':'PostToolUse','additionalContext':msg}}
print(json.dumps(out, ensure_ascii=False))
" 2>/dev/null
  exit 0
fi

# 성공 시 에러 카운트 리셋
PROJECT_ERR="/tmp/claude-validate-$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo unknown)"
echo "0" > "$PROJECT_ERR" 2>/dev/null

exit 0
