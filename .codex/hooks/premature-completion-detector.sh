#!/bin/bash
# premature-completion-detector.sh — Stop hook
# completion-verification.md HARD enforcement
#
# Codex가 "완료", "수렴 달성", "더 이상 개선 여지 없음" 류 종료 선언 시
# self-challenge 수행 여부를 transcript에서 검증.
# 자가 검증 없이 종료 선언하면 state 파일 생성 → 다음 턴에 재검증 강제.

set -o pipefail

INPUT=$(cat)
TRANSCRIPT_PATH=$(echo "$INPUT" | python3 -I -c "import sys,json; d=json.load(sys.stdin); print(d.get('transcript_path',''))" 2>/dev/null)

[ -z "$TRANSCRIPT_PATH" ] && exit 0
[ ! -f "$TRANSCRIPT_PATH" ] && exit 0

# 마지막 assistant 메시지 + 이전 1개
LAST_TWO=$(python3 -I - "$TRANSCRIPT_PATH" <<'PYEOF'
import sys, json, os
try:
    fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
except OSError:
    sys.exit(0)
msgs = []
with os.fdopen(fd, "r") as f:
    for line in f:
        try:
            m = json.loads(line)
            if m.get("type") == "assistant":
                content = m.get("message", {}).get("content", [])
                if isinstance(content, list):
                    parts = [c.get("text","") for c in content if isinstance(c,dict) and c.get("type")=="text"]
                    text = "\n".join(parts)
                    if text.strip():
                        msgs.append(text)
        except Exception:
            pass
# 마지막 2개를 합쳐서 검사
combined = "\n---MSG_SEP---\n".join(msgs[-2:])
print(combined[-4000:])
PYEOF
)

[ -z "$LAST_TWO" ] && exit 0

# 완료 선언 패턴 (Iter 19 확장 + Iter 32 대기-as-완료 패턴)
COMPLETION_PATTERNS=(
  "더 이상 개선할"
  "더는 개선할"
  "완전 수렴"
  "최종 수렴"
  "수렴 달성"
  "완료 확정"
  "HARD LIMIT"
  "상한에 도달"
  "최적화 끝"
  "완성되었습니다"
  "종료합니다"
  "마무리합니다"
  "## 완료 요약"
  "## 최종 요약"
  "## 최종 결론"
  "^## 완료$"
  "실질 이득"
  "autoresearch.*완료"
  "iteration.*결과"
  "Telegram.*전송 완료"
  "keep 1.*discard"
  "이번 세션 완료"
  # Iter 32: "대기 = 완료"로 가장한 종료 패턴
  "준비 완료"
  "시작할 준비 완료"
  "실행할 준비 완료"
  "명시할 때까지"
  "바로 이어집니다"
  "중간 상태"
  "Iter \d+\+ 가능"
  "종료 아님"
  "stop.*명시할 때"
  "다음 Bash.*호출로"
)

# 자가 검증 흔적 (이것들이 마지막 응답에 있으면 OK) — Iter 34 강화
# 이전 "Iter [0-9]+" 는 너무 느슨했음 (단순 언급만으로 허용)
# 이제 명확한 섹션 헤더나 실제 실행 마커만 인정
VERIFICATION_MARKERS=(
  "자가 검증"
  "self-challenge"
  "Self-Challenge"
  "체크리스트"
  "재확인"
  "교차 검토"
  "## Iter [0-9]+"
  "^Iter [0-9]+ 실행 중"
  "^Iter [0-9]+:.*실행"
  "실행 중\.\.\."
  "진행 중\\.\\.\\."
  "실제 Bash"
)

FOUND_COMPLETION=""
for p in "${COMPLETION_PATTERNS[@]}"; do
  if echo "$LAST_TWO" | grep -qE "$p"; then
    FOUND_COMPLETION="$FOUND_COMPLETION '$p'"
  fi
done

if [ -z "$FOUND_COMPLETION" ]; then
  exit 0
fi

# 검증 마커 있는지
HAS_VERIFICATION=0
for m in "${VERIFICATION_MARKERS[@]}"; do
  if echo "$LAST_TWO" | grep -qE "$m"; then
    HAS_VERIFICATION=1
    break
  fi
done

if [ "$HAS_VERIFICATION" = "1" ]; then
  exit 0
fi

# 완료 선언 있는데 검증 마커 없음 → premature completion
PROJECT_HASH=$(printf '%s' "$PWD" | shasum -a 256 | cut -c1-12)
STATE_DIR="$HOME/.codex/state/premature-completion"
mkdir -p "$STATE_DIR" 2>/dev/null
chmod 700 "$STATE_DIR" 2>/dev/null
STATE_FILE="$STATE_DIR/detected-$PROJECT_HASH"

# Iter 29: 연속 감지 카운터 — 3회+ 반복 시 텔레그램 에스컬레이션
# Stop hooks must not emit arbitrary stdout. The Python helper used to print
# the repetition count when count>=3, which Codex interpreted as invalid Stop
# hook JSON. Keep all detector side effects in files/logs and silence stdout.
python3 -I - "$STATE_FILE" "$FOUND_COMPLETION" <<'PYEOF' >/dev/null
import sys, os, json, datetime
# 기존 카운터 읽기
count = 0
prev_patterns = ""
if os.path.exists(sys.argv[1]):
    try:
        fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd) as f:
            d = json.load(f)
        count = int(d.get("count", 0))
        prev_patterns = d.get("patterns", "")
    except Exception:
        pass

# 같은 패턴 연속이면 카운터 증가, 다르면 리셋
new_patterns = sys.argv[2].strip()
if prev_patterns == new_patterns:
    count += 1
else:
    count = 1

try:
    fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
except OSError:
    sys.exit(0)
with os.fdopen(fd, "w") as f:
    json.dump({
        "patterns": new_patterns,
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "cwd": os.getcwd(),
        "count": count,
    }, f)
PYEOF

# 3회+ 연속 감지 시 텔레그램 에스컬레이션
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
if [ "$CONSECUTIVE" -ge 3 ] 2>/dev/null; then
  TELEGRAM_NOTIFY="$HOME/.codex/hooks/telegram-notify.sh"
  [ -x "$HOME/.codex/scripts/telegram-notify.sh" ] && TELEGRAM_NOTIFY="$HOME/.codex/scripts/telegram-notify.sh"
  bash "$TELEGRAM_NOTIFY" custom     "🛑 premature-completion ${CONSECUTIVE}회 연속 감지 — Codex가 규칙 무시 중 (project: $(basename "$PWD"))"     >/dev/null 2>&1 || true
fi

mkdir -p "$HOME/.codex/logs" 2>/dev/null
echo "{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"patterns\":\"$(echo $FOUND_COMPLETION | tr -d '\n')\",\"cwd\":\"$PWD\"}" \
  >> "$HOME/.codex/logs/premature-completion.jsonl" >/dev/null 2>&1 || true

exit 0
