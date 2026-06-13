---
name: frontend-patterns
description: Project-specific UI/web dashboard patterns for memory-bank.
---

# Frontend Patterns — memory-bank

The current UI is not a React/Next app. It is a CommonJS Node HTTP server in `ui/server.cjs` that returns HTML/CSS/JS strings and JSON API responses from readonly SQLite.

## UI surfaces

- `node ui/server.cjs` starts the dashboard server (default `PORT=3847`).
- `/dashboard` serves the tabbed dashboard (`Projects`, `Search`, `User Prompts`).
- `/` and `/graph` serve `docs/graph-3d.html` with live graph data injected.
- JSON APIs: `/api/stats`, `/api/projects`, `/api/search`, `/api/exchange`, `/api/user-prompts`, `/api/project-detail`, `/api/translate`, `/api/graph-data`.

## Hard QA rule

Build/server/page-load evidence is not UI completion evidence. UI PASS requires interaction evidence for tabs/menu navigation, search button, searchable-select dropdown, project-card detail navigation, exchange detail/back, API request/response assertions, clean console/page errors, and screenshot/human-review artifacts when visual claims are made.

This repo currently has no Playwright/Cypress dependency. Use:

```bash
python3 .codex/scripts/validate_hard_qa.py --scope feature --json
```

Expected current status is BLOCKED/FAIL until browser automation and missing interaction flows are implemented or explicitly scoped out with hard evidence.

## UI implementation rules

- Escape user-controlled text with the existing `esc()` helper before injecting into HTML.
- Keep `ui/server.cjs` as `.cjs`; do not use `require()` in TypeScript `src/` files.
- API handlers should return JSON and handle missing params with explicit error fields.
- Do not add a frontend framework unless the user explicitly asks.
