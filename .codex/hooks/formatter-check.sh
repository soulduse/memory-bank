#!/bin/bash
# Formatter enforcement hook
# PostToolUse: Edit|Write 후 코드 포매팅 위반 감지
# 실제 prettier/eslint가 설치된 프로젝트에서만 동작

# 변경된 파일 경로 추출
# Claude Code hook 입력은 stdin JSON으로 전달됨 (환경변수 아님).
# tool_input.file_path 경로에서 추출. 파이프라인 subshell 할당은 값이 유실되므로 명령치환 사용.
INPUT=$(cat)
FILE_PATH=$(printf '%s' "$INPUT" | python3 -c "import sys,json
try: d=json.load(sys.stdin)
except Exception: d={}
print(d.get('tool_input',{}).get('file_path',''))" 2>/dev/null)

[ -z "$FILE_PATH" ] && exit 0

# 코드 파일만 체크 (md, json, txt 제외)
case "$FILE_PATH" in
  *.ts|*.tsx|*.js|*.jsx|*.vue|*.css|*.scss)
    ;;
  *)
    exit 0
    ;;
esac

# 프로젝트 루트 탐색 (package.json 위치)
DIR=$(dirname "$FILE_PATH")
PROJECT_ROOT=""
while [ "$DIR" != "/" ] && [ "$DIR" != "." ]; do
  if [ -f "$DIR/package.json" ]; then
    PROJECT_ROOT="$DIR"
    break
  fi
  DIR=$(dirname "$DIR")
done

[ -z "$PROJECT_ROOT" ] && exit 0

# prettier 설치 여부 확인
if [ -f "$PROJECT_ROOT/node_modules/.bin/prettier" ]; then
  RESULT=$("$PROJECT_ROOT/node_modules/.bin/prettier" --check "$FILE_PATH" 2>&1)
  if [ $? -ne 0 ]; then
    echo "⚠️ [formatter-check] 포맷 위반: $FILE_PATH"
    echo "  → npx prettier --write \"$FILE_PATH\" 로 수정 가능"
    # 경고만 (exit 0) — 차단하려면 exit 2
    exit 0
  fi
fi

exit 0
