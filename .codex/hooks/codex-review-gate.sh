#!/bin/bash
# STACK: universal
# pipefail-grep-ok
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
# codex-review-gate.sh — PreToolUse Bash hook
# git push 전 Codex 크로스 리뷰 증거 확인.
# .codex-review-passed 또는 .codex-review-output 파일이 1시간 이내 존재해야 통과.
# Codex CLI가 미설치인 프로젝트는 skip (gate 비활성).

set -uo pipefail

INPUT=$(cat 2>/dev/null || echo '{}')
CMD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || echo "")

echo "$CMD" | grep -q "git push" || exit 0

PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0

# Codex CLI가 설치 안 된 프로젝트는 skip
command -v codex >/dev/null 2>&1 || exit 0
# .codex/ 디렉토리 없으면 skip (Codex 미설정)
[ -d "$PROJECT_ROOT/.codex" ] || [ -d "$HOME/.codex" ] || exit 0

# 증거 파일 확인
REVIEW_PASSED="$PROJECT_ROOT/.codex-review-passed"
REVIEW_OUTPUT="$PROJECT_ROOT/.codex-review-output"

EVIDENCE=""
for f in "$REVIEW_PASSED" "$REVIEW_OUTPUT"; do
  if [ -f "$f" ]; then
    NOW=$(date +%s)
    FTIME=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)
    AGE=$((NOW - FTIME))
    if [ "$AGE" -lt 3600 ]; then
      EVIDENCE="$f"
      break
    fi
  fi
done

if [ -z "$EVIDENCE" ]; then
  echo "HARD BLOCK: Codex 크로스 리뷰 증거 없음." >&2
  echo "  .codex-review-passed 또는 .codex-review-output 파일이 1시간 이내 필요." >&2
  echo "  실행: /codex:review 또는 codex review" >&2
  exit 2
fi

exit 0
