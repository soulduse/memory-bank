#!/bin/bash
# premature-completion-reminder.sh — UserPromptSubmit hook
# detector의 state 파일 감지 시 self-challenge 강제

set -o pipefail

PROJECT_HASH=$(printf '%s' "$PWD" | shasum -a 256 | cut -c1-12)
STATE_FILE="$HOME/.codex/state/premature-completion/detected-$PROJECT_HASH"

[ ! -f "$STATE_FILE" ] && exit 0

# Iter 31: 24h 이상 오래된 state는 stale로 간주하고 삭제
FILE_AGE=$(( $(date +%s) - $(stat -f %m "$STATE_FILE" 2>/dev/null || stat -c %Y "$STATE_FILE" 2>/dev/null || echo 0) ))
if [ "$FILE_AGE" -gt 86400 ]; then
  rm -f "$STATE_FILE" 2>/dev/null
  exit 0
fi
if [ -L "$STATE_FILE" ]; then rm -f "$STATE_FILE" 2>/dev/null; exit 0; fi
FILE_UID=$(stat -f %u "$STATE_FILE" 2>/dev/null || stat -c %u "$STATE_FILE" 2>/dev/null || echo 0)
[ "$FILE_UID" != "$(id -u)" ] && { rm -f "$STATE_FILE" 2>/dev/null; exit 0; }

PATTERNS=$(python3 -I - "$STATE_FILE" <<'PYEOF' 2>/dev/null
import sys, json, os
try:
    fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as f:
        d = json.load(f)
    print(d.get("patterns","(unknown)"))
except Exception:
    sys.exit(0)
PYEOF
)

python3 -I - "$PATTERNS" <<'PYEOF'
import sys, json
patterns = sys.argv[1] if len(sys.argv) > 1 else "(unknown)"
msg = f"""🛑 이전 응답에서 조기 완료 선언 감지: {patterns}

**completion-verification.md 규칙 위반**:
자가 검증 없이 "완료/수렴 달성/더 이상 개선할 것 없음" 선언 금지.

이번 턴 필수 수행:
1. **다각도 자가 질문** (최소 3개 관점):
   - scope: 다른 scope(user/project/plugin)는 확인했나?
   - lifecycle: 차단만 봤나? 주입/수정/감지 다른 경로는?
   - 연계: 개별 요소가 아니라 파이프라인 전체에서 끊긴 구간은?
2. **가용 실험 공간 재확인**: autoresearch NEVER STOP 원칙, 남은 Iter 제안
3. **하나라도 '확인 안 함'이면 수렴 선언 금지** — 즉시 다음 실험 진행

완료 선언 대신 **구체적 다음 Iter 제시**."""
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "UserPromptSubmit",
        "additionalContext": msg
    }
}))
PYEOF

rm -f "$STATE_FILE" 2>/dev/null
exit 0
