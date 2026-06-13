#!/bin/bash
# STACK: universal
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
# PreToolUse (Bash): git add로 민감 파일(.env/.pem/.key) 직접 추가 차단
INPUT=$(cat)
CMD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null)

# git add 명령이 아니면 통과
echo "$CMD" | grep -qE '\bgit\b' || exit 0
echo "$CMD" | grep -qE '\badd\b' || exit 0

# 안전 variant(.env.example/.sample/.template)만 추가하는 경우를 위한 패턴
SAFE_RE='\.env\.(example|sample|template)\b'

# (1) command 텍스트에 민감 파일명이 직접 등장 (eval/변수 내부 포함)
if echo "$CMD" | grep -qE '\.(env|pem|key)\b|credentials\b'; then
  # .env.example 등 안전 variant만 있고 진짜 .env가 없으면 예외
  if echo "$CMD" | grep -qE "$SAFE_RE" && \
     ! echo "$CMD" | grep -qE '(^|[[:space:]])\.env([[:space:]]|"|$)'; then
    : # 안전 variant — 아래 broad-add 검사로 진행
  else
    echo "HARD BLOCK: 민감 파일(.env/.pem/.key/credentials)을 git에 추가할 수 없습니다." >&2
    exit 2
  fi
fi

# (2) broad add (git add . / -A / --all / -u / *) — 파일명이 command에 없어도
#     워킹트리에서 실제로 스테이징될 민감 파일을 검사 (git add . 우회 차단).
#     --exclude-standard로 .gitignore된 파일은 제외 (어차피 스테이징 안 됨).
if echo "$CMD" | grep -qE '\badd\b[^|;&]*([[:space:]](\.|-A|--all|-u|\*)([[:space:]]|/|$))'; then
  STAGEABLE=$(git ls-files -o -m --exclude-standard 2>/dev/null \
    | grep -E '(^|/)\.env($|\.)|\.(env|pem|key|p12|pfx)$|(^|/)credentials' \
    | grep -vE '\.env\.(example|sample|template)$')
  if [ -n "$STAGEABLE" ]; then
    echo "HARD BLOCK: 'git add'가 다음 민감 파일을 스테이징합니다 (.gitignore에 추가하세요):" >&2
    echo "$STAGEABLE" | sed 's/^/  - /' >&2
    exit 2
  fi
fi

exit 0
