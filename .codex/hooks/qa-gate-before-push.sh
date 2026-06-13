#!/bin/bash

# qa-gate-before-push.sh
# PreToolUse Hook (Bash matcher): git push 전 품질 게이트
# 모든 코드 변경 프로젝트에서 QA 증거 요구 (user-proxy 연동)
# 모든 출력을 stderr로 보냄 (Codex가 stderr를 요구)
exec 1>&2

INPUT=$(cat /dev/stdin)
CMD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || echo "")

# git push 명령이 아니면 통과
if ! echo "$CMD" | grep -q "git push"; then
  echo "" >&2
  exit 0
fi

PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
[ -z "$PROJECT_ROOT" ] && exit 0

# QA gate 예외 프로젝트 (설정/메타 동기화 등 코드 프로젝트 아님)
QA_GATE_EXEMPT_PROJECTS=(
  "$HOME/Project/Codex/cc-sync"
)
for exempt in "${QA_GATE_EXEMPT_PROJECTS[@]}"; do
  if [ "$PROJECT_ROOT" = "$exempt" ]; then
    exit 0
  fi
done

EVIDENCE="$PROJECT_ROOT/.qa-cycle-passed"
BROWSER_EVIDENCE="$PROJECT_ROOT/.qa-evidence.json"

# --- 코드 변경 여부 확인 ---
# HEAD~1만 보면 'docs-only 커밋을 마지막에 끼워 우회'가 가능하므로,
# push될 전체 범위(upstream..HEAD)를 검사한다. upstream이 없으면 HEAD~1로 폴백.
DIFF_BASE=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)
[ -z "$DIFF_BASE" ] && DIFF_BASE="HEAD~1"
CODE_CHANGES=$(git diff --name-only "${DIFF_BASE}...HEAD" 2>/dev/null | grep -E '\.(ts|tsx|vue|js|jsx|dart|py|kt|java|rs|go|rb|css|scss|html)$' | head -1)
UI_CHANGES=$(git diff --name-only "${DIFF_BASE}...HEAD" 2>/dev/null | grep -E '\.(tsx|jsx|vue|svelte|css|scss|html)$' | head -1)

# 코드 변경이 없어도 qa-test-plan.md가 있으면 TC 메타 필수 (2026-04-06 HARD 승격)
# "코드 변경 없음"을 이유로 QA 전체 스킵 절대 금지
if [ -z "$CODE_CHANGES" ]; then
  QA_PLAN="$PROJECT_ROOT/docs/qa-test-plan.md"
  if [ -f "$QA_PLAN" ]; then
    # qa-test-plan.md가 있는 프로젝트: .qa-cycle-passed + TC 메타 필수
    if [ ! -f "$EVIDENCE" ]; then
      echo "HARD BLOCK: 문서만 변경해도 qa-test-plan.md가 있는 프로젝트는 .qa-cycle-passed 필수."
      exit 2
    fi
    CONTENT=$(cat "$EVIDENCE" 2>/dev/null)
    if ! echo "$CONTENT" | grep -q "CRITICAL:"; then
      echo "HARD BLOCK: .qa-cycle-passed에 TC 실행 메타데이터 없음. 문서만 변경해도 인터랙션 QA 필수."
      exit 2
    fi
    # TC 메타 있으면 통과
    exit 0
  fi
  # qa-test-plan.md 없는 프로젝트만 바이패스
  exit 0
fi

# --- .qa-cycle-passed 검증 ---

# 1. 파일 존재
if [ ! -f "$EVIDENCE" ]; then
  echo "HARD BLOCK: QA 미실행. 코드 변경이 감지되었으나 .qa-cycle-passed 파일이 없습니다. user-proxy QA 또는 $qa-cycle을 먼저 수행하세요."
  exit 2
fi

# 2. 파일 나이 (1시간 이내)
NOW=$(date +%s)
FILE_TIME=$(stat -f %m "$EVIDENCE" 2>/dev/null || stat -c %Y "$EVIDENCE" 2>/dev/null || echo 0)
AGE=$((NOW - FILE_TIME))

if [ "$AGE" -gt 3600 ]; then
  echo "HARD BLOCK: QA 결과가 1시간 이상 경과. 다시 수행하세요."
  exit 2
fi

# 3. PASS 포함 확인
CONTENT=$(cat "$EVIDENCE" 2>/dev/null)
if ! echo "$CONTENT" | grep -q "PASS"; then
  echo "HARD BLOCK: QA 결과가 PASS가 아닙니다."
  exit 2
fi

# 3.1 Hash 검증 강제 — 단순 "PASS" 위조 방지
# 형식: PASS|commit_hash|timestamp (mark-qa-pass.sh가 생성하는 포맷)
FIRST_LINE=$(echo "$CONTENT" | head -1)
if ! echo "$FIRST_LINE" | grep -qE '^PASS\|[a-f0-9]+\|'; then
  echo "HARD BLOCK: .qa-cycle-passed 포맷 위반. 'PASS|commit_hash|timestamp' 형식 필수."
  echo "  현재: $(printf '%.60s' "$FIRST_LINE")"
  echo "  mark-qa-pass.sh로 생성하세요: bash ~/.codex/scripts/mark-qa-pass.sh manual '설명'"
  exit 2
fi

# 3.2 Commit hash 일치 확인 (이전의 선택적 검증을 강제로 승격)
STORED_HASH=$(echo "$FIRST_LINE" | cut -d'|' -f2)
CURRENT_HASH=$(git rev-parse --short HEAD 2>/dev/null)
if [ -n "$STORED_HASH" ] && [ -n "$CURRENT_HASH" ] && [ "$STORED_HASH" != "$CURRENT_HASH" ]; then
  echo "HARD BLOCK: QA 이후 새 커밋 발생. hash($STORED_HASH) != HEAD($CURRENT_HASH). QA 재수행 필수."
  exit 2
fi

# 3.5. TC 실행 메타데이터 검증 (qa-test-plan.md가 있는 프로젝트)
QA_PLAN="$PROJECT_ROOT/docs/qa-test-plan.md"
if [ -f "$QA_PLAN" ]; then
  # qa-test-plan.md의 CRITICAL/HIGH/MEDIUM TC 수 추출
  PLAN_CRITICAL=$(grep -c "심각도.*CRITICAL" "$QA_PLAN" 2>/dev/null || echo 0)
  PLAN_HIGH=$(grep -c "심각도.*HIGH" "$QA_PLAN" 2>/dev/null || echo 0)
  PLAN_MEDIUM=$(grep -c "심각도.*MEDIUM" "$QA_PLAN" 2>/dev/null || echo 0)

  # .qa-cycle-passed에 TC 메타데이터가 있는지 확인 — HARD BLOCK (WARNING 아님)
  if ! echo "$CONTENT" | grep -q "CRITICAL:"; then
    echo "HARD BLOCK: .qa-cycle-passed에 TC 실행 메타데이터 없음."
    echo "  qa-test-plan.md에 ${PLAN_CRITICAL}건 CRITICAL, ${PLAN_HIGH}건 HIGH, ${PLAN_MEDIUM}건 MEDIUM TC 존재."
    echo "  .qa-cycle-passed에 'CRITICAL: N/M PASS' 형식이 필요합니다."
    echo "  qa-cycle이 TC를 실제로 실행했는지 확인하세요."
    exit 2
  fi

  # CRITICAL TC 검증: 전수 실행 + plan과 total 교차 비교
  EXEC_CRITICAL=$(echo "$CONTENT" | grep "CRITICAL:" | grep -o "[0-9]*/[0-9]*" | head -1)
  if [ -n "$EXEC_CRITICAL" ]; then
    EXEC_NUM=$(echo "$EXEC_CRITICAL" | cut -d'/' -f1)
    EXEC_TOTAL=$(echo "$EXEC_CRITICAL" | cut -d'/' -f2)
    if [ "$EXEC_NUM" -lt "$EXEC_TOTAL" ]; then
      echo "HARD BLOCK: CRITICAL TC 미전수 실행. ${EXEC_NUM}/${EXEC_TOTAL}"
      exit 2
    fi
    # plan과 교차 비교: .qa-cycle-passed의 total과 qa-test-plan.md의 count가 다르면 경고
    if [ "$EXEC_TOTAL" -lt "$PLAN_CRITICAL" ]; then
      echo "HARD BLOCK: CRITICAL TC 수 불일치. .qa-cycle-passed: ${EXEC_TOTAL}건, qa-test-plan.md: ${PLAN_CRITICAL}건"
      exit 2
    fi
  fi

  # HIGH TC 검증: 전수 실행
  EXEC_HIGH=$(echo "$CONTENT" | grep "HIGH:" | grep -o "[0-9]*/[0-9]*" | head -1)
  if [ -n "$EXEC_HIGH" ]; then
    HIGH_NUM=$(echo "$EXEC_HIGH" | cut -d'/' -f1)
    HIGH_TOTAL=$(echo "$EXEC_HIGH" | cut -d'/' -f2)
    if [ "$HIGH_NUM" -lt "$HIGH_TOTAL" ]; then
      echo "HARD BLOCK: HIGH TC 미전수 실행. ${HIGH_NUM}/${HIGH_TOTAL}"
      exit 2
    fi
  fi

  # MEDIUM TC 검증: 전수 실행
  EXEC_MEDIUM=$(echo "$CONTENT" | grep "MEDIUM:" | grep -o "[0-9]*/[0-9]*" | head -1)
  if [ -n "$EXEC_MEDIUM" ]; then
    MED_NUM=$(echo "$EXEC_MEDIUM" | cut -d'/' -f1)
    MED_TOTAL=$(echo "$EXEC_MEDIUM" | cut -d'/' -f2)
    if [ "$MED_NUM" -lt "$MED_TOTAL" ]; then
      echo "HARD BLOCK: MEDIUM TC 미전수 실행. ${MED_NUM}/${MED_TOTAL}"
      exit 2
    fi
  fi
fi

# 4. 무결성: 빌드 해시 검증 (형식: PASS|commit_hash|timestamp)
if echo "$CONTENT" | head -1 | grep -q "|"; then
  STORED_HASH=$(echo "$CONTENT" | head -1 | cut -d'|' -f2)
  CURRENT_HASH=$(git rev-parse --short HEAD 2>/dev/null)
  if [ -n "$STORED_HASH" ] && [ "$STORED_HASH" != "$CURRENT_HASH" ]; then
    echo "HARD BLOCK: QA 이후 새 커밋이 발생. .qa-cycle-passed 해시($STORED_HASH)와 HEAD($CURRENT_HASH) 불일치. QA를 다시 수행하세요."
    exit 2
  fi
fi

# === CODEX REVIEW GATE (HARD) ===
# .codex-review-passed 파일 없으면 push 차단. exit 2.
# 이 파일은 codex review 완료 시 생성됨.
# 생성 주체: codex-review-gate.sh (SubagentStop/TaskCompleted) 또는 /codex:review
CODEX_EVIDENCE="$PROJECT_ROOT/.codex-review-passed"

if command -v codex &>/dev/null && [ -f "$HOME/.codex/auth.json" ]; then
  if [ ! -f "$CODEX_EVIDENCE" ]; then
    echo "HARD BLOCK: Codex 크로스 리뷰 미실행. .codex-review-passed 파일이 없습니다. /codex:review 를 먼저 수행하세요."
    exit 2
  fi

  CODEX_CONTENT=$(cat "$CODEX_EVIDENCE" 2>/dev/null)
  if ! echo "$CODEX_CONTENT" | grep -q "PASS"; then
    echo "HARD BLOCK: Codex 리뷰 PASS가 아닙니다. CRITICAL 이슈를 수정하세요."
    exit 2
  fi

  CODEX_TIME=$(stat -f %m "$CODEX_EVIDENCE" 2>/dev/null || stat -c %Y "$CODEX_EVIDENCE" 2>/dev/null || echo 0)
  CODEX_AGE=$((NOW - CODEX_TIME))
  if [ "$CODEX_AGE" -gt 3600 ]; then
    echo "HARD BLOCK: Codex 리뷰가 1시간 이상 경과. 다시 수행하세요."
    exit 2
  fi
fi

# === UI 변경 시 BROWSER EVIDENCE HARD GATE (2026-04-21 NEW) ===
# UI 파일 변경 감지 시 .qa-evidence.json 전체 HARD 체크
# task-quality-gate.sh가 우회되는 경로(직접 push)에 대한 안전망
if [ -n "$UI_CHANGES" ]; then
  if [ ! -f "$BROWSER_EVIDENCE" ]; then
    echo "HARD BLOCK: UI 파일 변경 감지. .qa-evidence.json이 없습니다. web-qa-tester 실행 필수."
    exit 2
  fi
  BEV_TIME=$(stat -f %m "$BROWSER_EVIDENCE" 2>/dev/null || stat -c %Y "$BROWSER_EVIDENCE" 2>/dev/null || echo 0)
  BEV_AGE=$((NOW - BEV_TIME))
  if [ "$BEV_AGE" -gt 3600 ]; then
    echo "HARD BLOCK: .qa-evidence.json이 1시간 이상 경과. web-qa-tester 재실행 필수."
    exit 2
  fi

  # task-quality-gate.sh와 동일한 필드 체크 (HARD BLOCK 항목 전체 — 2026-04-22 parity)
  BEV_CHECK=$(python3 -c "
import json, os
try:
    d = json.load(open('$BROWSER_EVIDENCE'))
    issues = []
    bt = d.get('browser_test', {})
    if not bt.get('executed'):
        issues.append('browser_test.executed=false')
    ce = bt.get('console_errors', 0)
    if ce and int(ce) > 0:
        issues.append('console_errors=' + str(ce))
    if not bt.get('mobile_tested'):
        issues.append('mobile_tested=false')

    # checks 필드 4종 전수 (ui_render 포함)
    checks = d.get('checks', bt.get('checks', {}))
    if not checks:
        issues.append('checks 필드 누락')
    else:
        for key in ['ui_render', 'text_content', 'api_response_codes', 'roundtrip_crud']:
            val = checks.get(key, '')
            if val == 'FAIL':
                issues.append('checks.' + key + '=FAIL')
            elif not val or val == 'SKIP':
                issues.append('checks.' + key + ' 미실행')

    # interaction_test 전체 (buttons + popups + forms)
    interaction = d.get('interaction_test', {})
    if not interaction:
        issues.append('interaction_test 누락')
    else:
        btn_total = interaction.get('buttons_total', 0)
        btn_tested = interaction.get('buttons_tested', 0)
        if btn_total > 0 and btn_tested < btn_total:
            issues.append('버튼 미전수: ' + str(btn_tested) + '/' + str(btn_total))
        elif btn_total == 0:
            issues.append('interaction_test.buttons_total 누락')
        if interaction.get('popups_tested') is None:
            issues.append('interaction_test.popups_tested 미기록')
        if 'forms_submitted' not in interaction:
            issues.append('interaction_test.forms_submitted 미기록')

    # screenshot_evidence 파일 존재
    screenshots = d.get('screenshot_evidence', [])
    if not screenshots:
        issues.append('screenshot_evidence 비어있음')
    else:
        missing = [s for s in screenshots if not os.path.exists(s)]
        if missing:
            issues.append('스크린샷 파일 없음 ' + str(len(missing)))

    # api_logs 전체 (error_count 포함)
    api_logs = d.get('api_logs', {})
    if not api_logs.get('captured'):
        issues.append('api_logs.captured=false')
    api_err = api_logs.get('error_count', 0)
    if api_err and int(api_err) > 0:
        issues.append('api_logs.error_count=' + str(api_err))

    # db_verification 전체 (crud_roundtrip 포함)
    db_v = d.get('db_verification', {})
    if not db_v.get('queries_executed'):
        issues.append('db_verification.queries_executed=false')
    crud = db_v.get('crud_roundtrip', 'MISSING')
    if crud not in ('PASS', 'N/A'):
        issues.append('db_verification.crud_roundtrip=' + str(crud))

    vdt = d.get('verdict', 'MISSING')
    if vdt != 'PASS':
        issues.append('verdict=' + str(vdt))
    print('BLOCK:' + '; '.join(issues) if issues else 'PASS')
except Exception as e:
    print('BLOCK:파싱 오류 ' + str(e))
" 2>/dev/null)

  if echo "$BEV_CHECK" | grep -q "^BLOCK:"; then
    REASON=$(echo "$BEV_CHECK" | sed 's/^BLOCK://')
    echo "HARD BLOCK: .qa-evidence.json 검증 실패"
    echo "  $REASON"
    exit 2
  fi
fi

exit 0
