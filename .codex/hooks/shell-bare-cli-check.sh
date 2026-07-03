#!/bin/bash
# shell-bare-cli-check.sh — hooks/scripts shell 파일의 bare CLI 호출 차단
# PostToolUse Edit|Write: file_path가 hooks/**/*.sh 또는 scripts/**/*.sh 이고
#   - 파일 내에 bare python3/jq/gh/uv/node 호출이 있고
#   - 상단 5줄에 PATH export가 없으면 exit 2
set -euo pipefail
INPUT=$(cat 2>/dev/null || echo '{}')

FILE_PATH=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('tool_response',{}).get('filePath','') or d.get('tool_input',{}).get('file_path',''))
except:
    print('')
" 2>/dev/null)

[ -n "$FILE_PATH" ] || exit 0
[ -f "$FILE_PATH" ] || exit 0

# hooks/ 또는 scripts/ 디렉토리의 .sh 파일만
case "$FILE_PATH" in
  */hooks/*.sh) ;;
  */scripts/*.sh) ;;
  */hooks/*/*.sh) ;;
  */scripts/*/*.sh) ;;
  *) exit 0 ;;
esac

# 우회 주석
if head -10 "$FILE_PATH" 2>/dev/null | grep -qE "^#[[:space:]]*bare-cli-ok"; then
  exit 0
fi

# 파일에 bare CLI 호출이 있는지 (주석/문자열 제외는 단순 grep 한계상 최대한 배제)
# 라인 시작(공백/세미콜론/파이프 뒤)에서 bare CLI 호출
HAS_BARE=$(grep -nE '(^|[[:space:]]|[;|&]|\$\()\s*(python3|jq|gh|uv|node|deno|bun|npx)[[:space:]]' "$FILE_PATH" 2>/dev/null | \
  grep -vE '^\s*#' | \
  grep -vE '/(python3|jq|gh|uv|node|deno|bun|npx)\b' | \
  grep -vE '(python3|jq|gh|uv|node|deno|bun|npx)="' || true)

[ -n "$HAS_BARE" ] || exit 0

# 상단 15줄에 PATH export 있는지
HAS_PATH_EXPORT=$(head -15 "$FILE_PATH" 2>/dev/null | grep -cE '^(\s*)(export\s+)?PATH=|source\s+.*profile|\.\s+.*profile' || true)

# Grandfathering: 파일이 이미 git에 커밋되어 있고 HEAD에도 동일한 bare CLI 패턴이 존재하면 기존 파일
# (이번 edit이 새로 추가한 위반이 아님) → 스킵
if [ "${HAS_PATH_EXPORT:-0}" -eq 0 ]; then
  GIT_ROOT=$(cd "$(dirname "$FILE_PATH")" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null || true)
  if [ -n "$GIT_ROOT" ]; then
    REL_PATH=${FILE_PATH#$GIT_ROOT/}
    if git -C "$GIT_ROOT" cat-file -e "HEAD:$REL_PATH" 2>/dev/null; then
      # HEAD에서도 동일 bare CLI 패턴이 있었으면 grandfathered
      HEAD_HAS_BARE=$(git -C "$GIT_ROOT" show "HEAD:$REL_PATH" 2>/dev/null | \
        grep -cE '(^|[[:space:]]|[;|&]|\$\()\s*(python3|jq|gh|uv|node|deno|bun|npx)[[:space:]]' || true)
      if [ "${HEAD_HAS_BARE:-0}" -gt 0 ]; then
        # 기존 파일 — 이번 edit이 추가한 위반이 아님
        exit 0
      fi
    fi
  fi
fi

if [ "${HAS_PATH_EXPORT:-0}" -eq 0 ]; then
  LINE=$(echo "$HAS_BARE" | head -1)
  echo "❌ shell-interpreter-pkg-missing-in-non-login: bare CLI 호출 + PATH export 부재 (HARD)." >&2
  echo "   파일: $FILE_PATH" >&2
  echo "   라인: $LINE" >&2
  echo "   해결 1: 절대경로 사용 (/opt/homebrew/bin/python3, /opt/homebrew/bin/jq 등)." >&2
  echo "   해결 2: 파일 상단 5줄 내에 'export PATH=/opt/homebrew/bin:/usr/local/bin:\$PATH' 추가." >&2
  echo "   우회: 파일 상단에 '# bare-cli-ok' 주석 추가." >&2
  exit 2
fi
exit 0
