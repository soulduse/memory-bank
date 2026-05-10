#!/bin/bash
# PreToolUse (Bash): npm run dev, next dev, vite dev를 portless 없이 실행하면 경고
INPUT=$(cat)
CMD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null)

# portless가 이미 포함되어 있으면 통과
echo "$CMD" | grep -q "portless" && exit 0

# dev 서버 명령 감지
if echo "$CMD" | grep -qE "npm run dev|npx vite|next dev|vite dev"; then
  echo "HARD BLOCK: dev 서버를 portless 없이 실행할 수 없습니다. 'portless run $CMD' 형태로 실행하세요."
  exit 2
fi
exit 0
