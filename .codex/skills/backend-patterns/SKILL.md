---
name: backend-patterns
description: Project-specific backend/MCP/SQLite patterns for memory-bank.
---

# Backend Patterns — memory-bank

Use for changes under `src/`, `scripts/`, `cli/`, `hooks/`, and database/search/fact modules.

## Commands

- Build: `npm run build`
- Typecheck: `npx tsc --noEmit`
- Tests: `npm test`
- Targeted integration: `npx vitest run test/integration.test.ts test/sync.test.ts test/fact-integration.test.ts test/mcp-facts.test.ts test/sync-export-import.test.ts`

## MCP/tool rules

- `src/mcp-server.ts` is the MCP boundary. New tools need Zod input schemas, handler routing, tests, and README/CODEX updates.
- Tool input failures should be structured and user-readable; do not expose raw unknown objects without conversion.
- Close DB handles in `finally` in every tool handler that opens `initDatabase()`.

## SQLite/search rules

- Runtime DB path comes from `src/paths.ts`: `MEMORY_BANK_CONFIG_DIR`, `PERSONAL_SUPERPOWERS_DIR`, XDG config, `MEMORY_BANK_DB_PATH`, `TEST_DB_PATH`.
- Keep schema migrations idempotent (`pragma_table_info` before `ALTER TABLE`).
- `sqlite-vec` virtual tables require DELETE then INSERT; do not use REPLACE for vector rows.
- LIKE text search must escape `%`, `_`, and `\` and include `ESCAPE '\'`.
- Preserve `busy_timeout = 5000` for concurrent Claude/plugin access.

## Fact/ontology rules

- Fact categories are `decision`, `preference`, `pattern`, `knowledge`, `constraint`.
- Fact scopes are `global` and `project`; never leak project-scoped facts across projects except through explicit cross-project insight flows.
- Consolidation relations are `DUPLICATE`, `CONTRADICTION`, `EVOLUTION`, `INDEPENDENT`.
- LLM extraction/consolidation failures should log and continue without corrupting existing facts.

## Tests to update

- Parser/sync changes: `test/parser.test.ts`, `test/sync.test.ts`, `test/indexer.test.ts`.
- DB/fact schema changes: `test/db.test.ts`, `test/fact-db.test.ts`, `test/fact-integration.test.ts`, `test/knowledge-graph.test.ts`.
- MCP tools: `test/mcp-facts.test.ts` and a behavior test when possible.
- Search formatting: `test/search-format.test.ts`, `test/multi-concept.test.ts`, `test/integration.test.ts`.
