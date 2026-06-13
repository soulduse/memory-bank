#!/bin/bash
# Formatter enforcement hook
# PostToolUse: Edit|Write 후 코드 포매팅 위반 감지
# 실제 prettier/eslint가 설치된 프로젝트에서만 동작

# 변경된 파일 경로 추출
FILE_PATH=""
if echo "$CLAUDE_TOOL_USE_INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('file_path',''))" 2>/dev/null | read -r fp; then
  FILE_PATH="$fp"
fi

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
