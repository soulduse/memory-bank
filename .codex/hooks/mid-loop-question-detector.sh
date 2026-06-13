#!/bin/bash
# mid-loop-question-detector.sh — Stop hook
# convergence-loop-no-mid-question.md HARD enforcement
#
# Codex 응답 종료 시 transcript의 마지막 assistant 메시지를 검사.
# 금지 패턴(계속 진행할까요? A/B/C 중 선택? 이대로 진행? 등) 감지 시
# state 파일 생성 → 다음 UserPromptSubmit에서 리마인더 주입.
#
# 허용 예외: convergence-loop 허용된 5개 에스컬레이션 조건 관련 질문은 제외.

set -o pipefail

# stdin으로 JSON 받음: {"session_id":"...","transcript_path":"..."}
INPUT=$(cat)
TRANSCRIPT_PATH=$(echo "$INPUT" | python3 -I -c "import sys,json; d=json.load(sys.stdin); print(d.get('transcript_path',''))" 2>/dev/null)

[ -z "$TRANSCRIPT_PATH" ] && exit 0
[ ! -f "$TRANSCRIPT_PATH" ] && exit 0

# 마지막 assistant 메시지만 추출
LAST_ASSISTANT=$(python3 -I - "$TRANSCRIPT_PATH" <<'PYEOF'
import sys, json, os
try:
    fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
except OSError:
    sys.exit(0)
last_text = ""
with os.fdopen(fd, "r") as f:
    for line in f:
        try:
            msg = json.loads(line)
            if msg.get("type") == "assistant":
                content = msg.get("message", {}).get("content", [])
                if isinstance(content, list):
                    parts = [c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"]
                    text = "\n".join(parts)
                    if text.strip():
                        last_text = text
                elif isinstance(content, str):
                    last_text = content
        except Exception:
            pass
# 마지막 2000자만 (prompt 크기 절약)
print(last_text[-2000:])
PYEOF
)

[ -z "$LAST_ASSISTANT" ] && exit 0

# 금지 패턴 (반복 루프 중간 질문 + 대기 선언) — Iter 32 확장
FORBIDDEN_PATTERNS=(
  "계속 진행할까요"
  "계속 진행 할까요"
  "이대로 진행하시겠"
  "이대로 진행 할까요"
  "계속할까요\\?"
  "계속 할까요\\?"
  "진행할까요\\?"
  "A/B/C 중"
  "A1/A2/A3"
  "옵션 중 선택"
  "어느 쪽을 선택"
  "어떻게 할까요\\?"
  "다음 단계를 선택"
  "사용자 결정 필요"
  "결정 부탁"
  # Iter 32: "대기 선언" 패턴 — 실제 실행 없이 상태만 선언
  "준비 완료"
  "시작할 준비"
  "명시할 때까지"
  "명시하실 때까지"
  "다음 턴에"
  "다음 요청을"
  "사용자 확인.*필요"
  "사용자 입력.*대기"
  "요청 대기"
  "바로 이어집니다"
  "이어갈 수 있습니다"
  "stop.*까지"
  "stop.*명시"
  "계속 가도 되는지"
  "실행할 준비"
)

# 허용된 에스컬레이션 조건 (이것들은 제외)
ALLOWED_CONTEXTS=(
  "EXHAUSTED"
  "기술 스택 변경"
  "비용 발생"
  "데이터 삭제"
  "마이그레이션"
  "sandbox"
  "에스컬레이션"
)

DETECTED=""
for p in "${FORBIDDEN_PATTERNS[@]}"; do
  if echo "$LAST_ASSISTANT" | grep -qE "$p"; then
    DETECTED="$DETECTED $p"
  fi
done

# 허용 맥락이 함께 있으면 허용
if [ -n "$DETECTED" ]; then
  for a in "${ALLOWED_CONTEXTS[@]}"; do
    if echo "$LAST_ASSISTANT" | grep -qiE "$a"; then
      DETECTED=""
      break
    fi
  done
fi

if [ -n "$DETECTED" ]; then
  # 상태 파일 생성 (프로젝트별)
  PROJECT_HASH=$(printf '%s' "$PWD" | shasum -a 256 | cut -c1-12)
  STATE_DIR="$HOME/.codex/state/mid-question"
  mkdir -p "$STATE_DIR" 2>/dev/null
  chmod 700 "$STATE_DIR" 2>/dev/null
  STATE_FILE="$STATE_DIR/detected-$PROJECT_HASH"

  # Iter 29: 연속 감지 카운터 (3회+ 에스컬레이션)
  python3 -I - "$STATE_FILE" "$DETECTED" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" <<'PYEOF'
import sys, os, json
path, patterns, ts = sys.argv[1], sys.argv[2].strip(), sys.argv[3]
count = 0
prev = ""
if os.path.exists(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd) as f:
            d = json.load(f)
        count = int(d.get("count", 0))
        prev = d.get("patterns", "")
    except Exception:
        pass
count = count + 1 if prev == patterns else 1
try:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
except OSError:
    sys.exit(0)
with os.fdopen(fd, "w") as f:
    json.dump({"patterns": patterns, "timestamp": ts, "cwd": os.getcwd(), "count": count}, f)
PYEOF

  # 3회+ 반복 시 에스컬레이션
  CONSECUTIVE=$(python3 -I - "$STATE_FILE" <<'PYEOF' 2>/dev/null
import sys, json, os
try:
    fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as f:
        d = json.load(f)
    print(d.get("count", 0))
except Exception:
    print(0)
PYEOF
  )
  if [ "${CONSECUTIVE:-0}" -ge 3 ] 2>/dev/null; then
    TELEGRAM_NOTIFY="$HOME/.codex/hooks/telegram-notify.sh"
    [ -x "$HOME/.codex/scripts/telegram-notify.sh" ] && TELEGRAM_NOTIFY="$HOME/.codex/scripts/telegram-notify.sh"
    bash "$TELEGRAM_NOTIFY" custom       "🛑 mid-loop-question ${CONSECUTIVE}회 연속 감지 — Codex 규칙 무시 중 (project: $(basename "$PWD"))"       >/dev/null 2>&1 || true
  fi

  # 로그
  mkdir -p "$HOME/.codex/logs" 2>/dev/null
  echo "{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"patterns\":\"$(echo $DETECTED | tr -d '\n')\",\"cwd\":\"$PWD\"}" \
    >> "$HOME/.codex/logs/mid-loop-question.jsonl" >/dev/null 2>&1 || true
fi

exit 0
