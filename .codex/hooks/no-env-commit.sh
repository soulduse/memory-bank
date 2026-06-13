#!/bin/bash
# STACK: universal
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
# PreToolUse (Bash): git add로 민감 파일(.env/.pem/.key) 직접 추가 차단
INPUT=$(cat)
CMD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null)

# Eval-resistant: git + add + 민감파일이 command에 공존하면 차단 (eval/변수 내부 포함).
# .env.example / .env.sample / .env.template 안전 variant는 예외.
if echo "$CMD" | grep -qE '\bgit\b' && echo "$CMD" | grep -qE '\badd\b' && \
   echo "$CMD" | grep -qE '\.(env|pem|key)\b|credentials\b'; then
  if echo "$CMD" | grep -qE '\.env\.(example|sample|template)\b' && \
     ! echo "$CMD" | grep -qE '(^|[[:space:]])\.env([[:space:]]|"|$)'; then
    exit 0
  fi
  echo "HARD BLOCK: 민감 파일(.env/.pem/.key/credentials)을 git에 추가할 수 없습니다." >&2
  exit 2
fi

exit 0
