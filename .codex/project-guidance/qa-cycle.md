---
name: qa-cycle
description: Project-local qa-cycle policy for memory-bank with feature/full-regression scope split.
---

# QA Cycle — memory-bank

Use the user-scope runtime with project-local profile and scenarios:

```bash
python3 ~/.codex/scripts/qa-cycle-runtime.py --project-root . --scope feature --max-rounds 1
python3 ~/.codex/scripts/qa-cycle-runtime.py --project-root . --scope full-regression --max-rounds 1
```

Feature scope uses `.codex/loopy-era/qa-scenarios.json` as the denominator. Full regression uses `docs/qa-test-plan.md` CRITICAL/HIGH/MEDIUM coverage plus the same hard evidence requirements.

Do not claim PASS from `.qa-cycle-passed` unless it begins with `PASS`. A `BLOCKED` marker is evidence of a failing hard gate.
