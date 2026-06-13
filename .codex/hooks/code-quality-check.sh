#!/bin/bash
# PostToolUse (Write|Edit): as any, @ts-ignore, console.log 감지
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(d.get('tool_response',{}).get('filePath','') or d.get('tool_input',{}).get('file_path',''))
" 2>/dev/null)

[ -z "$FILE_PATH" ] && exit 0
echo "$FILE_PATH" | grep -qE '\.(ts|tsx|vue|js|jsx)$' || exit 0

VIOLATIONS=""
[ -f "$FILE_PATH" ] || exit 0

# as any
if grep -n "as any" "$FILE_PATH" 2>/dev/null | grep -v "//.*as any\|test\|spec\|\.d\.ts" | head -1 | grep -q .; then
  VIOLATIONS="${VIOLATIONS}as any 사용 감지. "
fi

# @ts-ignore
if grep -n "@ts-ignore" "$FILE_PATH" 2>/dev/null | head -1 | grep -q .; then
  VIOLATIONS="${VIOLATIONS}@ts-ignore 사용 감지. "
fi

if [ -n "$VIOLATIONS" ]; then
  echo "CODE QUALITY VIOLATION (HARD BLOCK): $FILE_PATH"
  echo "$VIOLATIONS"
  echo "정확한 타입 정의를 사용하세요. as any, @ts-ignore 금지."
  # HARD: exit 2 → 차단
  exit 2
fi
exit 0
