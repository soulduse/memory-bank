#!/bin/bash
# Dependency audit hook
# PreToolUse[Bash]: npm install / pip install 실행 시 취약점 검사
# 설치 명령 감지 시에만 동작

COMMAND=""
if echo "$CLAUDE_TOOL_USE_INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('command',''))" 2>/dev/null | read -r cmd; then
  COMMAND="$cmd"
fi

[ -z "$COMMAND" ] && exit 0

# npm install 감지
if echo "$COMMAND" | grep -qE "npm\s+install|npm\s+i\s|pnpm\s+add|yarn\s+add"; then
  # 현재 디렉토리에 package.json이 있는지
  if [ -f "package.json" ]; then
    # npm audit 실행 (high 이상만 차단)
    AUDIT_RESULT=$(npm audit --audit-level=high 2>&1)
    AUDIT_EXIT=$?
    if [ $AUDIT_EXIT -ne 0 ]; then
      HIGH_COUNT=$(echo "$AUDIT_RESULT" | grep -c "high\|critical" 2>/dev/null)
      if [ "$HIGH_COUNT" -gt 0 ]; then
        echo "⚠️ [dependency-audit] ${HIGH_COUNT}개 high/critical 취약점 발견"
        echo "  → npm audit fix 로 해결 시도"
        # 경고만 (차단하려면 exit 2)
      fi
    fi
  fi
fi

# pip install 감지
if echo "$COMMAND" | grep -qE "pip\s+install|pip3\s+install"; then
  if command -v pip-audit &>/dev/null; then
    PIP_RESULT=$(pip-audit 2>&1)
    if [ $? -ne 0 ]; then
      echo "⚠️ [dependency-audit] pip 취약점 발견"
    fi
  fi
fi

exit 0
