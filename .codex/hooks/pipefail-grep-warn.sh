#!/bin/bash
# pipefail-grep-warn.sh — pipefail 환경에서 | grep 미스매치가 스크립트 전체를 종료시키는 실수 차단
set -euo pipefail
INPUT=$(cat 2>/dev/null || echo '{}')

FILE_PATH=$(echo "$INPUT" | python3 -c "
import sys, json
try: print(json.load(sys.stdin).get('tool_input', {}).get('file_path', ''))
except: print('')
")
[ -n "$FILE_PATH" ] || exit 0

case "$FILE_PATH" in
  *.sh|*.bash) ;;
  *) exit 0 ;;
esac
[ -f "$FILE_PATH" ] || exit 0

# 우회 주석
if grep -qE "^[[:space:]]*#[[:space:]]*pipefail-grep-ok" "$FILE_PATH" 2>/dev/null; then
  exit 0
fi

# pipefail 사용 여부
if ! grep -qE "set[[:space:]]+(-[euo]*[[:space:]]+)*(-o[[:space:]]+pipefail|-[euo]*o[[:space:]]*pipefail|-e.*pipefail|pipefail)" "$FILE_PATH" 2>/dev/null; then
  # 간단 폴백: "pipefail" 단어만 포함해도 감지
  if ! grep -qE "pipefail" "$FILE_PATH" 2>/dev/null; then
    exit 0
  fi
fi

# | grep ... 패턴 (line by line) 검사
BAD_LINES=""
while IFS= read -r line_no_content; do
  [ -z "$line_no_content" ] && continue
  ln=$(echo "$line_no_content" | cut -d: -f1)
  content=$(echo "$line_no_content" | cut -d: -f2-)
  # 주석 라인 skip
  echo "$content" | grep -qE "^[[:space:]]*#" && continue
  # || true / || : / || [ / 2>/dev/null만으로는 exit 1 보호 못함 (pipefail은 파이프 전체 평가)
  # 안전 패턴: `|| true`, `|| :` 이 같은 라인에 존재해야 함
  if echo "$content" | grep -qE "\\|\\|[[:space:]]*(true|:|\\[)"; then
    continue
  fi
  # if / while / until 제어문 안에서는 exit code가 조건이므로 안전
  if echo "$content" | grep -qE "^[[:space:]]*(if|while|until|elif)[[:space:]]"; then
    continue
  fi
  BAD_LINES="${BAD_LINES}${ln}: ${content}
"
done < <(grep -nE "\\|[[:space:]]*grep([[:space:]]|$)" "$FILE_PATH" 2>/dev/null || true)

if [ -n "$BAD_LINES" ]; then
  echo "❌ pipefail-grep-empty-match: pipefail 스크립트에서 '| grep' 미스매치 시 스크립트 전체가 종료됩니다 (HARD)." >&2
  echo "   파일: $FILE_PATH" >&2
  echo "$BAD_LINES" | head -5 >&2
  echo "   해결: '| grep ... || true' 추가 또는 if/while 제어문 내부로 이동." >&2
  echo "   우회: 상단에 '# pipefail-grep-ok' 주석." >&2
  exit 2
fi
exit 0
