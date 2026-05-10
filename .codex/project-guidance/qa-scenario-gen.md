---
name: qa-scenario-gen
description: Project-specific QA scenario generation policy for memory-bank.
---

# QA Scenario Generation — memory-bank

Scenario manifest: `.codex/loopy-era/qa-scenarios.json`.

Source scope:

- Backend/MCP: `src/mcp-server.ts`, `src/search.ts`, `src/db.ts`, `src/fact-db.ts`, `src/ontology-db.ts`, `src/sync.ts`, `src/parser.ts`.
- UI: `ui/server.cjs`, `docs/graph-3d.html`.
- Tests: `test/**/*.test.ts`.

Required commands must not be blank. Missing required commands must produce `status=fail` and `blocker_count>0`. The generated hard UI command is:

```bash
python3 .codex/scripts/validate_hard_qa.py --scope feature --json
```

Feature scope defaults to executable changed-scope scenarios. Full regression requires the whole `docs/qa-test-plan.md` CRITICAL/HIGH/MEDIUM corpus.
