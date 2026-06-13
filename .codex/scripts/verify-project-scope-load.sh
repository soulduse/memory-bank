#!/bin/bash
set -euo pipefail
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
if [ -x "$PROJECT_ROOT/.codex/scripts/validate-hard-process-contract.py" ]; then
  python3 "$PROJECT_ROOT/.codex/scripts/validate-hard-process-contract.py" --project-root "$PROJECT_ROOT" --require-project-contract --json >/tmp/memory-bank-hard-contract-verify.json
fi
bash ~/.codex/scripts/verify-project-scope-load.sh
