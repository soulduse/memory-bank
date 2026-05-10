---
name: qa-strategy
description: Project-specific QA strategy for memory-bank.
---

# QA Strategy — memory-bank

Generated per project by `$init-project`.

## Default scope

- Feature branch / normal implementation: `--scope feature`.
- Release/full regression: `--scope full-regression`.

## Commands

```bash
npm run build
npx tsc --noEmit
npm test
npx vitest run test/integration.test.ts test/sync.test.ts test/fact-integration.test.ts test/mcp-facts.test.ts test/sync-export-import.test.ts
python3 .codex/scripts/validate-hard-process-contract.py --project-root . --require-project-contract --json
python3 .codex/scripts/validate_hard_qa.py --scope feature --json
python3 ~/.codex/scripts/qa-cycle-runtime.py --project-root . --scope feature --max-rounds 1
```

## Evidence contract

- Backend/API/MCP claims need build/typecheck/tests and, for tools, input validation + response assertion evidence.
- DB/search/fact claims need tests proving schema migration, vector table update, scope isolation, and query behavior.
- UI claims need hard interaction evidence. Smoke-only server/page-load evidence is a blocker, not a pass.
- `.qa-cycle-passed` is valid only when it starts with `PASS` for the current head. `BLOCKED` is not a pass marker.

## Known hard blockers

- No root `lint` command is configured.
- No Playwright/Cypress/browser E2E dependency exists.
- Current UI does not implement create/update/delete CRUD, file upload, modal/layer/popup, confirm accept/cancel, or alert/toast flows; the hard validator reports these as blockers for UI completion claims.
