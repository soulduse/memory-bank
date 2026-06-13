#!/bin/bash

# require-isPWA-check.sh
# PreToolUse Hook: 레이아웃 변경 시 isPWA 체크 강제 (StockPicks AI 프로젝트 전용)
# Write, Edit 도구 사용 시 flex-col 또는 grid 변경 감지

TOOL_NAME="$1"
FILE_PATH="$2"

# Write 또는 Edit 도구만 검사
if [ "$TOOL_NAME" != "Write" ] && [ "$TOOL_NAME" != "Edit" ]; then
  exit 0
fi

# StockPicks AI 프로젝트만 검사
if [[ "$PWD" != *"stockpicks-ai"* ]]; then
  exit 0
fi

# TypeScript/React 파일만 검사
if ! echo "$FILE_PATH" | grep -qE '\.(tsx|jsx)$'; then
  exit 0
fi

# 파일 내용 읽기
FILE_CONTENT=""
if [ -f "$FILE_PATH" ]; then
  FILE_CONTENT=$(cat "$FILE_PATH")
elif [ ! -t 0 ]; then
  FILE_CONTENT=$(cat)
fi

# flex-col 또는 grid grid-cols 변경 감지
if echo "$FILE_CONTENT" | grep -qE "(flex-col|grid grid-cols)"; then
  # isPWA 변수 존재 여부 확인
  if ! echo "$FILE_CONTENT" | grep -q "isPWA"; then
    echo "❌ ERROR: Layout change detected without isPWA check in $FILE_PATH"
    echo ""
    echo "🚨 웹/모바일 버전 분리 정책 위반!"
    echo ""
    echo "감지된 레이아웃 변경:"
    echo "$FILE_CONTENT" | grep -nE "(flex-col|grid grid-cols)" | head -5
    echo ""
    echo "📖 규칙: 모바일 레이아웃은 PWA 모드에서만 적용"
    echo ""
    echo "✅ 수정 방법:"
    echo "  1. isPWA 변수 선언:"
    echo "     const { isPWA } = usePWA();"
    echo ""
    echo "  2. 조건부 렌더링 사용:"
    echo "     className={isPWA ? 'flex flex-col' : 'grid grid-cols-[280px_1fr]'}"
    echo ""
    echo "예시:"
    echo "  ❌ <div className=\"flex flex-col\">"
    echo "  ✅ <div className={isPWA ? \"flex flex-col\" : \"grid grid-cols-[280px_1fr]\"}>"
    echo ""
    exit 2  # 차단
  fi
fi

exit 0
