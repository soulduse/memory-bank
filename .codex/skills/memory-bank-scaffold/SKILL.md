---
name: memory-bank-scaffold
description: "Project-local memory-bank scaffold: ESM, SQLite/vector, MCP, UI, and QA rules."
---

# Memory Bank Scaffold

## ESM module rules

- Root package uses `"type": "module"`.
- Local TypeScript imports require `.js` extensions.
- `require()` is forbidden in `src/**/*.ts`; CommonJS belongs in `.cjs` files only.
- Prefer `import type` for type-only imports.

## DB/vector rules

- Use `initDatabase()` from `src/db.ts` for runtime DB access.
- Close DB handles in `finally` unless a caller explicitly owns the handle.
- Keep `db.pragma('busy_timeout = 5000')`.
- Migrations are idempotent: check `pragma_table_info` before `ALTER TABLE`.
- `sqlite-vec` update pattern is DELETE then INSERT, ideally in a transaction.
- Escape LIKE metacharacters and include `ESCAPE '\'`.
- Never interpolate user input into SQL.

## MCP/API rules

- New MCP tools require Zod schema, tool listing, call handler branch, README/CODEX update, and tests.
- MCP responses should be stable content blocks; avoid throwing raw unknown errors.
- UI API handlers in `ui/server.cjs` must return JSON and explicit error fields for missing params.

## Fact/search rules

- Embeddings are 384-dimensional.
- Truncate long text before embedding as current code does.
- Preserve project/global fact scope isolation.
- Consolidation relation values are uppercase: DUPLICATE, CONTRADICTION, EVOLUTION, INDEPENDENT.

## Test rules

- Use `TEST_DB_PATH`, `MEMORY_BANK_DB_PATH`, and `TEST_ARCHIVE_DIR` for isolation.
- Use temp dirs and cleanup in `afterEach`/`finally`.
- Suppress noisy console output with `suppressConsole()` when tests intentionally trigger warnings.
- Run `npm run build` and `npm test` before completion claims.

## Hard UI QA

- UI completion claims require hard interaction evidence.
- Current missing hard evidence is tracked by `.codex/scripts/validate_hard_qa.py`; do not replace it with smoke-only checks.

## NEVER DO

- Do not use `require()` in TypeScript source.
- Do not omit `.js` on local ESM imports.
- Do not leave DB connections open.
- Do not use `INSERT OR REPLACE` against sqlite-vec virtual tables.
- Do not claim PASS from `.qa-cycle-passed` when it contains `BLOCKED`.
- Do not bypass hooks with `--no-verify`.
