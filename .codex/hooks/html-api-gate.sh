#!/bin/bash

# html-api-gate.sh
# PreToolUse Hook: public/*.html 커밋 시 Supabase API 호출을 실제 테스트
# 실패하면 exit 2로 커밋 차단 (경고가 아닌 BLOCK)

INPUT=$(cat)

if ! command -v jq &>/dev/null; then
  jq() {
    python3 -c "
import sys, json
data = json.load(sys.stdin)
path = sys.argv[1].lstrip('.').split('.')
for key in path:
    key = key.split('//')[0].strip()
    data = data.get(key, '') if isinstance(data, dict) else ''
print(data if data else '')
" "$@"
  }
fi

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Bash의 git commit만 감지
[ "$TOOL_NAME" != "Bash" ] && exit 0
echo "$COMMAND" | grep -q "git commit" || exit 0
echo "$COMMAND" | grep -qE "(--allow-empty|--amend|merge)" && exit 0

# staged된 HTML 파일 찾기
HTML_FILES=$(git diff --cached --name-only 2>/dev/null | grep -E "^public/.*\.html$")
[ -z "$HTML_FILES" ] && exit 0

FAILED=0
ERRORS=""

while IFS= read -r html_file; do
  [ ! -f "$html_file" ] && continue

  # 1. Supabase REST API 호출 추출 (/rest/v1/ 패턴)
  REST_URLS=$(grep -oE "rest/v1/[a-zA-Z_]+" "$html_file" 2>/dev/null | sort -u)

  # 2. Supabase RPC 호출 추출 (rpc/ 패턴)
  RPC_CALLS=$(grep -oE "rpc/[a-zA-Z_]+" "$html_file" 2>/dev/null | sort -u)

  # 3. Supabase URL + anon key 추출
  SB_URL=$(grep -oE "https://[a-z]+\.supabase\.co" "$html_file" 2>/dev/null | head -1)
  ANON_KEY=$(grep -oE "eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+" "$html_file" 2>/dev/null | head -1)

  if [ -z "$SB_URL" ] || [ -z "$ANON_KEY" ]; then
    # Supabase 호출이 없는 HTML은 스킵
    continue
  fi

  echo "  [API Gate] $html_file: Supabase API 테스트 중..." >&2

  # REST 테이블 조회 테스트
  if [ -n "$REST_URLS" ]; then
    while IFS= read -r endpoint; do
      table=$(echo "$endpoint" | sed 's|rest/v1/||')
      # combo_strategy_stats 등 테이블 직접 조회 (limit=1)
      HTTP_CODE=$(curl -s -o /tmp/html-gate-resp.txt -w "%{http_code}" \
        "${SB_URL}/rest/v1/${table}?select=*&limit=1" \
        -H "apikey: ${ANON_KEY}" \
        -H "Authorization: Bearer ${ANON_KEY}" \
        --max-time 10 2>/dev/null)

      if [ "$HTTP_CODE" = "200" ]; then
        echo "    o REST ${table}: ${HTTP_CODE} OK" >&2
      else
        FAILED=1
        RESP=$(cat /tmp/html-gate-resp.txt 2>/dev/null | head -c 200)
        ERRORS+="[API FAIL] ${html_file}: REST /${table} → HTTP ${HTTP_CODE}\n  ${RESP}\n\n"
        echo "    x REST ${table}: HTTP ${HTTP_CODE} FAIL" >&2
      fi
    done <<< "$REST_URLS"
  fi

  # RPC 함수: 함수 엔드포인트를 직접 호출하면(POST는 물론 GET도 STABLE/IMMUTABLE 함수 본문을
  # 실행) 부작용/데이터 변경 위험이 있다. 따라서 함수를 전혀 호출하지 않고, PostgREST 루트의
  # OpenAPI 스키마(노출된 함수 목록 메타데이터)만 조회해 존재 여부를 확인한다 (실행 0).
  #   스키마에 "/rpc/${func}" 경로가 있으면 존재, 없으면 FAIL(broken/renamed).
  #   스키마 조회 실패(권한/네트워크)는 판정 보류(스킵) — 거짓 FAIL 방지.
  if [ -n "$RPC_CALLS" ]; then
    # HTTP 상태까지 함께 받는다. 401/403/404/5xx/네트워크 오류는 본문이 비어있지 않아도
    # 유효한 스키마가 아니므로 'broken'으로 오판하면 안 된다(거짓 차단 방지).
    SCHEMA_RESP=$(curl -s -w $'\n%{http_code}' "${SB_URL}/rest/v1/" \
      -H "apikey: ${ANON_KEY}" \
      -H "Authorization: Bearer ${ANON_KEY}" \
      --max-time 10 2>/dev/null)
    SCHEMA_CODE=$(printf '%s' "$SCHEMA_RESP" | tail -n1)
    SCHEMA=$(printf '%s' "$SCHEMA_RESP" | sed '$d')

    # 신뢰할 수 있는 신호로만 FAIL을 낸다.
    #  - 200 + OpenAPI 마커: 유효 스키마 → 함수 존재 판정 가능(SCHEMA_OK). 함수 부재만 FAIL.
    #  - 그 외(401/403/5xx/네트워크/마커 없는 200): 보류(SKIP).
    #    스키마 루트(/rest/v1/)의 인증 실패는 게이트웨이/프록시 정책이나 주석 속 stale 토큰을
    #    먼저 집는 등으로 발생할 수 있어 '키 무효'로 단정할 수 없다 → 거짓 차단 방지를 위해 보류.
    SCHEMA_OK=0
    if [ "$SCHEMA_CODE" = "200" ] && printf '%s' "$SCHEMA" | grep -qE '"(swagger|openapi)"[[:space:]]*:|"paths"[[:space:]]*:'; then
      SCHEMA_OK=1
    fi

    while IFS= read -r endpoint; do
      func=$(echo "$endpoint" | sed 's|rpc/||')
      if [ "$SCHEMA_OK" != "1" ]; then
        echo "    - RPC ${func}: 스키마 조회 불가/무효 (HTTP ${SCHEMA_CODE}, 판정 보류)" >&2
      elif printf '%s' "$SCHEMA" | grep -q "\"/rpc/${func}\""; then
        echo "    o RPC ${func}: 스키마에 존재 (함수 미실행)" >&2
      else
        FAILED=1
        ERRORS+="[API FAIL] ${html_file}: RPC ${func}() 스키마에 없음 (broken/renamed)\n\n"
        echo "    x RPC ${func}: 스키마에 없음" >&2
      fi
    done <<< "$RPC_CALLS"
  fi

done <<< "$HTML_FILES"

rm -f /tmp/html-gate-resp.txt

if [ $FAILED -eq 1 ]; then
  echo "" >&2
  echo "--- HTML API Gate BLOCKED ---" >&2
  echo "Supabase API 호출이 anon key로 실패합니다." >&2
  echo "배포하면 사용자에게 에러가 보입니다." >&2
  echo "" >&2
  echo -e "$ERRORS" >&2
  echo "수정 후 다시 커밋하세요." >&2
  exit 2
fi

exit 0
