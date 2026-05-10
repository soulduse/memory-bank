#!/bin/bash
# STACK: universal
# no-verify-ban.sh — HARD gate for --no-verify
# git commit/push --no-verify 명령을 PreToolUse에서 차단.
# 사용자가 명시적으로 우회하려 해도 exit 2.
set -euo pipefail

INPUT=$(cat 2>/dev/null || echo '{}')

if ! command -v jq &>/dev/null; then
  jq() {
    python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    path = sys.argv[1].lstrip('.').split('.')
    for key in path:
        key = key.split('//')[0].strip()
        d = d.get(key, '') if isinstance(d, dict) else ''
    print(d if d else '')
except Exception:
    print('')
" "$@"
  }
fi

TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
[ "$TOOL" = "Bash" ] || exit 0

CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Bypass-resistant detection: git + forbidden flag 어디든 공존하면 차단.
# eval, 변수 치환, backtick, heredoc 안이든 밖이든 — 텍스트 수준에서 잡음.
# Over-catch 방지: -m '...' / -m "..." 안의 메시지 본문은 먼저 제거.
STRIPPED=$(printf '%s' "$CMD" | python3 -c "
import sys, re
c = sys.stdin.read()
c = re.sub(r\"-m\s+'[^']*'\", '-m MSG', c, flags=re.DOTALL)
c = re.sub(r'-m\s+\"[^\"]*\"', '-m MSG', c, flags=re.DOTALL)
# heredoc 내용도 strip: << 'EOF' ... EOF → <<HEREDOC
c = re.sub(r\"<<-?\s*['\\\"]?(\w+)['\\\"]?.*?^\\1\", '<<HEREDOC', c, flags=re.MULTILINE|re.DOTALL)
print(c)
" 2>/dev/null || printf '%s' "$CMD")

# condition: command에 git이 있고 + forbidden flag도 있으면 → 차단
if echo "$STRIPPED" | grep -qE '\bgit\b'; then
  if echo "$STRIPPED" | grep -qE '(^|[[:space:]]|=|")-\-no-verify([[:space:]]|"|$)|(^|[[:space:]]|=|")-\-no-gpg-sign([[:space:]]|"|$)'; then
    echo "❌ no-verify-ban: bypass flag 감지 (eval/변수/heredoc 포함 탐지)" >&2
    echo "   hook을 우회하지 말 것. 실패 원인을 해결하세요." >&2
    exit 2
  fi
fi

exit 0
