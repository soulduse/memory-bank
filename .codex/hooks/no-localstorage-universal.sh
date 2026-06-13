#!/bin/bash
# no-localstorage-universal.sh
# localStorage 사용 감지. 웹 파일 (.ts/.tsx/.js/.jsx/.vue/.svelte) 에서만 발동.
set -euo pipefail

INPUT=$(cat 2>/dev/null || echo '{}')
FILE_PATH=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('tool_input', {}).get('file_path', ''))
except: print('')
")

[ -n "$FILE_PATH" ] || exit 0

# 웹 파일만
case "$FILE_PATH" in
  *.ts|*.tsx|*.js|*.jsx|*.vue|*.svelte|*.mjs|*.cjs) ;;
  *) exit 0 ;;
esac

# Write 후 파일 내용 검사
if [ -f "$FILE_PATH" ]; then
  if grep -nE "localStorage\.(setItem|getItem|removeItem)" "$FILE_PATH" 2>/dev/null | grep -vE "sb-.*-auth-token" >&2; then
    echo "❌ no-localstorage: localStorage 사용 금지 (Supabase Auth 내부 제외)" >&2
    echo "   사용자 데이터 → Supabase 서버 저장, 세션 → Supabase Auth 자동 관리" >&2
    exit 2
  fi
fi

exit 0
