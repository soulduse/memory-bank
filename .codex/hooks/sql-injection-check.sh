#!/bin/bash

# sql-injection-check.sh
# PostToolUse Hook: SQL injection 방지 (모든 에이전트 대상)
# Supabase MCP 사용 시 raw SQL 패턴 검증

TOOL_NAME="$1"
AGENT_NAME="${CLAUDE_CURRENT_AGENT:-unknown}"

# 모든 에이전트가 Supabase MCP 도구 사용 시 체크
if [[ "$TOOL_NAME" =~ mcp__supabase__ ]]; then
  PARAMS="$2"

  # Raw SQL 인젝션 위험 패턴 검사
  # 1. 문자열 연결로 SQL 생성 (+ 또는 ${} 사용)
  # 2. 따옴표로 감싸지 않은 변수 삽입
  # 3. WHERE 절에 직접 변수 삽입

  if echo "$PARAMS" | grep -qE "(WHERE.*\$\{|WHERE.*\+|query.*\$\{|query.*concat)"; then
    echo ""
    echo "⚠️⚠️⚠️ SQL INJECTION WARNING ⚠️⚠️⚠️"
    echo ""
    echo "Agent: $AGENT_NAME"
    echo "Tool: $TOOL_NAME"
    echo "Issue: Potential SQL injection detected"
    echo ""
    echo "🚨 Raw SQL with string interpolation detected!"
    echo "🚨 This can lead to SQL injection vulnerabilities"
    echo ""
    echo "✅ 안전한 패턴 (Supabase Query Builder):"
    echo "  await supabase"
    echo "    .from('table_name')"
    echo "    .select('*')"
    echo "    .eq('column', value)  // ✅ Safe - auto parameterized"
    echo ""
    echo "✅ 안전한 패턴 (Parameterized RPC):"
    echo "  await supabase.rpc('function_name', { param: value })  // ✅ Safe"
    echo ""
    echo "❌ 위험한 패턴:"
    echo "  const query = \`SELECT * FROM table WHERE col = '\${val}'\`;  // ❌ Dangerous"
    echo "  await supabase.rpc('raw_sql', { sql: query });"
    echo ""
    echo "📖 규칙: 항상 Supabase Query Builder (.eq, .select, .gte) 또는 Parameterized RPC 사용"
    echo ""

    # 위반 로그 기록
    TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")
    LOG_DIR="$HOME/.codex/logs"
    mkdir -p "$LOG_DIR"
    LOG_FILE="$LOG_DIR/violations.log"
    echo "[$TIMESTAMP] SQL_WARNING | Agent: $AGENT_NAME | Tool: $TOOL_NAME | Issue: SQL injection risk | Params: ${PARAMS:0:50}..." >> "$LOG_FILE"

    echo "📊 위반 기록: $LOG_FILE"
    echo ""
  fi
fi

exit 0
