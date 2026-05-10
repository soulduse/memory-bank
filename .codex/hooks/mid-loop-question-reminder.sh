#!/bin/bash
# mid-loop-question-reminder.sh — UserPromptSubmit hook
# detector가 기록한 state 파일 있으면 다음 턴에 규칙 재강조 주입

set -o pipefail

PROJECT_HASH=$(printf '%s' "$PWD" | shasum -a 256 | cut -c1-12)
STATE_FILE="$HOME/.codex/state/mid-question/detected-$PROJECT_HASH"

[ ! -f "$STATE_FILE" ] && exit 0

# Iter 31: 24h 이상 오래된 state는 stale로 간주하고 삭제
FILE_AGE=$(( $(date +%s) - $(stat -f %m "$STATE_FILE" 2>/dev/null || stat -c %Y "$STATE_FILE" 2>/dev/null || echo 0) ))
if [ "$FILE_AGE" -gt 86400 ]; then
  rm -f "$STATE_FILE" 2>/dev/null
  exit 0
fi

# symlink/UID 검증
if [ -L "$STATE_FILE" ]; then
  rm -f "$STATE_FILE" 2>/dev/null
  exit 0
fi
FILE_UID=$(stat -f %u "$STATE_FILE" 2>/dev/null || stat -c %u "$STATE_FILE" 2>/dev/null || echo 0)
[ "$FILE_UID" != "$(id -u)" ] && { rm -f "$STATE_FILE" 2>/dev/null; exit 0; }

PATTERNS=$(python3 -I - "$STATE_FILE" <<'PYEOF' 2>/dev/null
import sys, json, os
try:
    fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as f:
        d = json.load(f)
    print(d.get("patterns", "(unknown)"))
except Exception:
    sys.exit(0)
PYEOF
)

# additionalContext로 주입 (JSON 형식으로 stdout 반환)
python3 -I - "$PATTERNS" <<'PYEOF'
import sys, json
patterns = sys.argv[1] if len(sys.argv) > 1 else "(unknown)"
msg = f"""🛑 이전 응답에서 반복 루프 중간 질문/대기 선언 패턴 감지: {patterns}

**convergence-loop-no-mid-question.md 규칙 위반**:
- "계속 진행할까요?" 금지
- "준비 완료", "명시할 때까지", "다음 Bash 호출로" = 대기 선언 = 사실상 멈춤 → 금지
- 수렴(CRITICAL=0) 또는 EXHAUSTED까지 무정지 반복

**이번 턴 필수 행동** (말이 아니라 실행):
1. "다음 Iter 실행할 준비 완료" 대신 **지금 이 턴에서 실제로 Iter N+1 Bash 호출**
2. 사용자에게 "계속할까요?" 묻지 않고 즉시 다음 실험 진행
3. 더 이상 탐색 여지 없으면 `codex-convergence-loop.sh` 또는 `loopy-era-workflow.sh`로 위임

허용된 5개 에스컬레이션만 중간 질문 가능:
EXHAUSTED, 기술 스택 변경, 비용 발생, 데이터 삭제, sandbox 한계

이번 턴에서 실제 Bash 실행 없이 또 "준비 완료" 선언하면 재감지 → 3회+ 텔레그램 에스컬레이션."""
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "UserPromptSubmit",
        "additionalContext": msg
    }
}))
PYEOF

# 1회성 — 리마인더 후 삭제
rm -f "$STATE_FILE" 2>/dev/null
exit 0
