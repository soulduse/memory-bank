#!/bin/bash
# react-grab auto-inject: React 프로젝트 감지 시 자동으로 react-grab 초기화
# SessionStart 또는 UserPromptSubmit(세션당 1회)에서 실행

PROJECT_DIR="${PWD}"
LOCK_FILE="/tmp/react-grab-injected-$(echo "$PROJECT_DIR" | md5 -q 2>/dev/null || echo "$PROJECT_DIR" | md5sum | cut -d' ' -f1)"

# 이미 이 세션에서 체크했으면 스킵
if [ -f "$LOCK_FILE" ]; then
  exit 0
fi

# 락 파일 생성 (세션당 1회만 실행)
touch "$LOCK_FILE"
# 1시간 후 자동 만료 (백그라운드)
(sleep 3600 && rm -f "$LOCK_FILE") &>/dev/null &

# package.json 존재 확인
if [ ! -f "$PROJECT_DIR/package.json" ]; then
  exit 0
fi

# React 프로젝트인지 확인 (react dependency 있는지)
if ! grep -q '"react"' "$PROJECT_DIR/package.json" 2>/dev/null; then
  exit 0
fi

# 이미 react-grab 설정되어 있는지 확인
# Vite: index.html에 react-grab 포함
# Next.js: layout.tsx에 react-grab 포함
# 또는 package.json에 react-grab dependency 존재
ALREADY_SETUP=false

if grep -rq "react-grab" "$PROJECT_DIR/index.html" 2>/dev/null; then
  ALREADY_SETUP=true
fi

if grep -rq "react-grab" "$PROJECT_DIR/src/index.html" 2>/dev/null; then
  ALREADY_SETUP=true
fi

if grep -rq "react-grab" "$PROJECT_DIR/app/layout.tsx" "$PROJECT_DIR/app/layout.jsx" "$PROJECT_DIR/src/app/layout.tsx" "$PROJECT_DIR/src/app/layout.jsx" 2>/dev/null; then
  ALREADY_SETUP=true
fi

if grep -rq "react-grab" "$PROJECT_DIR/pages/_document.tsx" "$PROJECT_DIR/pages/_document.jsx" "$PROJECT_DIR/src/pages/_document.tsx" 2>/dev/null; then
  ALREADY_SETUP=true
fi

if grep -q '"react-grab"' "$PROJECT_DIR/package.json" 2>/dev/null; then
  ALREADY_SETUP=true
fi

if [ "$ALREADY_SETUP" = true ]; then
  exit 0
fi

# grab CLI 존재 확인
if ! command -v react-grab &>/dev/null && ! command -v grab &>/dev/null; then
  exit 0
fi

# React 프로젝트에 react-grab 자동 주입
cd "$PROJECT_DIR"
npx -y grab@latest init -y 2>/dev/null
npx -y grab@latest add claude-code -y 2>/dev/null

exit 0
