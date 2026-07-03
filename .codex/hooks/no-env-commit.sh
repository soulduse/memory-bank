#!/bin/bash
# STACK: universal
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
# PreToolUse (Bash): git add로 민감 파일(.env/.pem/.key) 직접 추가 차단
INPUT=$(cat)
CMD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null)

set -f  # 토큰 루프에서 '*' 등이 경로 확장(globbing)되지 않도록 비활성화

# git add 명령이 아니면 통과
echo "$CMD" | grep -qE '\bgit\b' || exit 0
echo "$CMD" | grep -qE '\badd\b' || exit 0

# (1) 토큰별 검사: 민감 파일을 직접 add. 안전 variant(.env.example/.sample/.template)는 예외.
#     여러 인자 중 안전 variant가 같이 있어도 '진짜 민감 파일'을 가리지 못하도록 토큰 단위로 판정
#     (예: git add .env.local .env.example → .env.local에서 차단).
CLEAN=$(printf '%s' "$CMD" | tr -d "\"'")
for tok in $CLEAN; do
  case "$tok" in
    *.env.example|*.env.sample|*.env.template) continue ;;  # 안전 variant
  esac
  case "$tok" in
    *.env|*.env.*|*.pem|*.key|*.p12|*.pfx|*credentials|*credentials.*)
      echo "HARD BLOCK: 민감 파일($tok)을 git에 추가할 수 없습니다 (.gitignore 또는 안전 variant 사용)." >&2
      exit 2 ;;
  esac
done

# (2) 정적으로 스테이징 대상을 알 수 없는 add 형태는 워킹트리를 직접 스캔한다.
#     명령 텍스트에 파일명이 없어도(broad add `.`/`-A`/`-u`/`*`, 또는 파일에서 경로를 읽는
#     `--pathspec-from-file`, 또는 ignored 강제 `-f`) 실제 스테이징될 민감 파일을 잡아낸다.
BROAD=0; INCLUDE_IGNORED=0
echo "$CMD" | grep -qE '\badd\b[^|;&]*([[:space:]](\.|-A|--all|-u|\*)([[:space:]]|/|$))' && BROAD=1
echo "$CMD" | grep -qE '(^|[[:space:]])(-[A-Za-z]*f[A-Za-z]*|--force)([[:space:]]|=|$)' && { BROAD=1; INCLUDE_IGNORED=1; }
echo "$CMD" | grep -qE '\-\-pathspec-from-file' && { BROAD=1; INCLUDE_IGNORED=1; }

if [ "$BROAD" = 1 ]; then
  # -f/--force 또는 pathspec-from-file: .gitignore된 파일도 스테이징될 수 있으므로 ignored 포함.
  if [ "$INCLUDE_IGNORED" = 1 ]; then
    LSARGS="-o -m"                    # --exclude-standard 없음 → ignored 파일까지 포함
  else
    LSARGS="-o -m --exclude-standard" # 기본 무시 규칙 적용분만
  fi
  STAGEABLE=$(git ls-files $LSARGS 2>/dev/null \
    | grep -E '(^|/)\.env($|\.)|\.(env|pem|key|p12|pfx)$|(^|/)credentials' \
    | grep -vE '\.env\.(example|sample|template)$')
  if [ -n "$STAGEABLE" ]; then
    echo "HARD BLOCK: 'git add'가 다음 민감 파일을 스테이징합니다 (.gitignore에 추가하세요):" >&2
    echo "$STAGEABLE" | sed 's/^/  - /' >&2
    exit 2
  fi
fi

exit 0
