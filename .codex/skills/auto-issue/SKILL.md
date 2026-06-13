---
name: auto-issue
description: Project-specific auto-issue settings for memory-bank.
---

# Auto Issue — memory-bank

Repository metadata exists: `jung-wan-kim/memory-bank`.

## Settings

- repo: `jung-wan-kim/memory-bank`
- assignee: `@me`
- labels: none configured by default
- exclude_labels: `manual, discussion`
- status_filter: not configured
- start_status: not configured
- pr_base: configure explicitly before mutation; do not assume `staging` exists
- test_command: `npm run build && npm test && python3 .codex/scripts/validate-hard-process-contract.py --project-root . --require-project-contract --json`

Do not mutate GitHub Project V2 status, push, close, or open PRs unless project/branch settings are configured and QA gates pass.
