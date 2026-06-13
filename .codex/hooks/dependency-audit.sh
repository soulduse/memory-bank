#!/bin/bash
# Dependency audit hook
# PreToolUse[Bash]: npm install / pip install 실행 시 취약점 검사
# 설치 명령 감지 시에만 동작

# Claude Code hook 입력은 stdin JSON으로 전달됨 (환경변수 아님).
# tool_input.command 경로에서 명령 추출. 파이프라인 subshell 할당은 값이 유실되므로 명령치환 사용.
INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | python3 -c "import sys,json
try: d=json.load(sys.stdin)
except Exception: d={}
print(d.get('tool_input',{}).get('command',''))" 2>/dev/null)

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
