#!/bin/bash
# STACK: universal
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH

# scaffold-violation-check.sh
# PostToolUse Hook (Write|Edit matcher): scaffold NEVER DO 규칙 위반 감지
# 프로젝트별 scaffold가 있으면 금지 패턴을 체크

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(d.get('tool_response',{}).get('filePath','') or d.get('tool_input',{}).get('file_path',''))
" 2>/dev/null)

# 파일 경로 없으면 통과
[ -z "$FILE_PATH" ] && exit 0

# 언어 불문 source 파일 체크 (project-scope 전환 대비)
echo "$FILE_PATH" | grep -qE '\.(vue|ts|tsx|jsx|js|mjs|cjs|svelte|java|kt|kts|py|dart|go|rs|rb|cs|scala|swift|php)$' || exit 0

# scaffold 찾기 — project scope 우선, user scope fallback, git 밖이어도 cwd 기준
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
PROJECT_NAME=$(basename "$PROJECT_ROOT")

SCAFFOLD=""
# 1) Project scope: init-project가 생성하는 경로 (단일 .md 또는 디렉토리+SKILL.md)
for S in \
  "$PROJECT_ROOT/.codex/skills/${PROJECT_NAME}-scaffold.md" \
  "$PROJECT_ROOT/.codex/skills/${PROJECT_NAME}-scaffold/SKILL.md" \
  "$PROJECT_ROOT/.codex/skills/scaffold.md" \
  "$PROJECT_ROOT/.codex/skills/scaffold/SKILL.md"; do
  [ -f "$S" ] && SCAFFOLD="$S" && break
done
# 2) User scope fallback (legacy)
if [ -z "$SCAFFOLD" ]; then
  for S in \
    "$HOME/.codex/skills/${PROJECT_NAME}-scaffold/SKILL.md" \
    "$HOME/.codex/skills/${PROJECT_NAME}-page-scaffold/SKILL.md" \
    "$HOME/.codex/skills/${PROJECT_NAME}-scaffold.md"; do
    [ -f "$S" ] && SCAFFOLD="$S" && break
  done
fi
[ -z "$SCAFFOLD" ] && exit 0

# NEVER DO 섹션에서 금지 패턴 추출 + 파일 체크
VIOLATIONS=$(python3 << PYEOF
import re

scaffold_path = "$SCAFFOLD"
file_path = "$FILE_PATH"

# scaffold에서 NEVER DO 규칙 읽기
rules = []
in_never_do = False
with open(scaffold_path) as f:
    for line in f:
        if '## NEVER DO' in line:
            in_never_do = True
            continue
        if in_never_do:
            if line.startswith('## ') and 'NEVER DO' not in line:
                break
            if line.startswith('- '):
                # 백틱 안의 패턴 추출
                patterns = re.findall(r'\x60([^\x60]+)\x60', line)
                for p in patterns:
                    if len(p) > 2 and not p.startswith('flex-') and not p.startswith(':'):
                        rules.append((p, line.strip()))

# 파일에서 위반 체크
violations = []
try:
    with open(file_path) as f:
        content = f.read()
    for pattern, rule in rules:
        if pattern in content:
            # 예외: localStorage는 sessionStorage 내부에서 허용
            if pattern == 'localStorage' and 'sessionStorage' in content:
                continue
            # 예외: LoginView에서 accountPwd 허용
            if pattern == 'accountPwd' and 'Login' in file_path:
                continue
            violations.append(f"  - '{pattern}' 감지 → {rule}")
except:
    pass

if violations:
    print("\\n".join(violations))
PYEOF
)

if [ -n "$VIOLATIONS" ]; then
  MSG="scaffold NEVER DO 위반 감지:\\n$VIOLATIONS\\n\\n파일: $FILE_PATH"
  MSG_ESCAPED=$(echo "$MSG" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read().strip()))" 2>/dev/null)
  echo "SCAFFOLD VIOLATION (HARD BLOCK) — 즉시 수정 필수:"
  echo "$VIOLATIONS"
  echo ""
  echo "파일: $FILE_PATH"
  echo "이 위반은 프로젝트 컨벤션에 의해 금지됩니다. 해당 패턴을 제거하고 올바른 방식으로 교체하세요."
  # HARD: exit 2 → 위반 시 차단
  exit 2
fi

exit 0
