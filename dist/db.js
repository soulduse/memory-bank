import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import * as sqliteVec from 'sqlite-vec';
import { getDbPath } from './paths.js';
import { autoHealScopeProjects } from './project-canon.js';
import { EMBEDDING_VERSION } from './embeddings.js';
export function migrateSchema(db) {
    const columns = db.prepare(`SELECT name FROM pragma_table_info('exchanges')`).all();
    const columnNames = new Set(columns.map(c => c.name));
    const migrations = [
        { name: 'last_indexed', sql: 'ALTER TABLE exchanges ADD COLUMN last_indexed INTEGER' },
        { name: 'parent_uuid', sql: 'ALTER TABLE exchanges ADD COLUMN parent_uuid TEXT' },
        { name: 'is_sidechain', sql: 'ALTER TABLE exchanges ADD COLUMN is_sidechain BOOLEAN DEFAULT 0' },
        { name: 'session_id', sql: 'ALTER TABLE exchanges ADD COLUMN session_id TEXT' },
        { name: 'cwd', sql: 'ALTER TABLE exchanges ADD COLUMN cwd TEXT' },
        { name: 'git_branch', sql: 'ALTER TABLE exchanges ADD COLUMN git_branch TEXT' },
        { name: 'claude_version', sql: 'ALTER TABLE exchanges ADD COLUMN claude_version TEXT' },
        { name: 'thinking_level', sql: 'ALTER TABLE exchanges ADD COLUMN thinking_level TEXT' },
        { name: 'thinking_disabled', sql: 'ALTER TABLE exchanges ADD COLUMN thinking_disabled BOOLEAN' },
        { name: 'thinking_triggers', sql: 'ALTER TABLE exchanges ADD COLUMN thinking_triggers TEXT' },
        { name: 'coding_agent', sql: "ALTER TABLE exchanges ADD COLUMN coding_agent TEXT DEFAULT 'claude-code'" },
    ];
    let migrated = false;
    for (const migration of migrations) {
        if (!columnNames.has(migration.name)) {
            console.error(`Migrating schema: adding ${migration.name} column...`);
            db.prepare(migration.sql).run();
            migrated = true;
        }
    }
    if (migrated) {
        console.error('Migration complete.');
    }
}
export function initDatabase() {
    const dbPath = getDbPath();
    // Ensure directory exists
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }
    const db = new Database(dbPath);
    // Load sqlite-vec extension
    sqliteVec.load(db);
    // Enable WAL mode for better concurrency
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    // Required so the exchanges_fts AFTER DELETE trigger fires when an exchange is
    // re-indexed via `INSERT OR REPLACE` (the REPLACE-induced delete does NOT fire
    // delete triggers unless recursive_triggers is on — verified: without it a
    // re-indexed exchange leaves a stale FTS row). Keeps the external-content FTS
    // index consistent with the source table on every write path.
    db.pragma('recursive_triggers = ON');
    // Create exchanges table
    db.exec(`
    CREATE TABLE IF NOT EXISTS exchanges (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      user_message TEXT NOT NULL,
      assistant_message TEXT NOT NULL,
      archive_path TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      embedding BLOB,
      last_indexed INTEGER,
      parent_uuid TEXT,
      is_sidechain BOOLEAN DEFAULT 0,
      session_id TEXT,
      cwd TEXT,
      git_branch TEXT,
      claude_version TEXT,
      thinking_level TEXT,
      thinking_disabled BOOLEAN,
      thinking_triggers TEXT,
      coding_agent TEXT DEFAULT 'claude-code'
    )
  `);
    // Create tool_calls table
    db.exec(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      exchange_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_input TEXT,
      tool_result TEXT,
      is_error BOOLEAN DEFAULT 0,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (exchange_id) REFERENCES exchanges(id)
    )
  `);
    // Create vector search index
    db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_exchanges USING vec0(
      id TEXT PRIMARY KEY,
      embedding FLOAT[384]
    )
  `);
    // Run migrations first
    migrateSchema(db);
    // Create indexes (after migrations ensure columns exist)
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_timestamp ON exchanges(timestamp DESC)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_id ON exchanges(session_id)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_project ON exchanges(project)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sidechain ON exchanges(is_sidechain)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_archive_path ON exchanges(archive_path)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_git_branch ON exchanges(git_branch)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_coding_agent ON exchanges(coding_agent)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tool_name ON tool_calls(tool_name)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tool_exchange ON tool_calls(exchange_id)
  `);
    // === Full-text search index (FTS5) for exchanges ===
    // External-content FTS5: stores only the inverted index (not a second copy of
    // the text), reading the source columns from `exchanges` via rowid. Replaces
    // the O(rows) `LIKE '%q%'` full scan (measured p50 3.2s / p95 14.5s on 239K
    // rows) with a BM25-ranked index lookup. Triggers keep it in sync on every
    // insert/update/delete (INSERT OR REPLACE fires AFTER DELETE then AFTER INSERT,
    // so re-indexed exchanges stay consistent). The one-time backfill of existing
    // rows is done by scripts/backfill-fts.mjs (`'rebuild'`), NOT here — keeping
    // initDatabase() cheap since it runs on every MCP/hook invocation.
    db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS exchanges_fts USING fts5(
      user_message, assistant_message,
      content='exchanges', content_rowid='rowid',
      tokenize='porter unicode61'
    )
  `);
    // Readiness flag (deterministic, not probed). For an external-content FTS5
    // table the index is EMPTY right after creation even though the content table
    // (exchanges) already has rows — so `SELECT rowid FROM exchanges_fts` would
    // falsely look "ready". Track readiness explicitly instead. We (re)initialize
    // the flag whenever it is MISSING — not only when the FTS table is newly
    // created — so a DB from an earlier build (FTS table present, flag absent) or
    // a crash between CREATE and the flag write is still handled correctly rather
    // than permanently falling back to LIKE. When the flag is absent we cannot
    // prove the index is populated, so be conservative: an empty exchanges set is
    // ready (triggers index every future insert); a non-empty set stays NOT ready
    // until scripts/backfill-fts.mjs rebuilds the index and sets the flag.
    db.exec(`CREATE TABLE IF NOT EXISTS fts_meta (key TEXT PRIMARY KEY, value TEXT)`);
    const hasFtsFlag = db.prepare(`SELECT 1 FROM fts_meta WHERE key='exchanges_fts_built'`).get() !== undefined;
    if (!hasFtsFlag) {
        const exchangesHaveRows = db.prepare('SELECT 1 FROM exchanges LIMIT 1').get() !== undefined;
        db.prepare(`INSERT INTO fts_meta(key, value) VALUES('exchanges_fts_built', ?)`)
            .run(exchangesHaveRows ? '0' : '1');
    }
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS exchanges_fts_ai AFTER INSERT ON exchanges BEGIN
      INSERT INTO exchanges_fts(rowid, user_message, assistant_message)
      VALUES (new.rowid, new.user_message, new.assistant_message);
    END
  `);
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS exchanges_fts_ad AFTER DELETE ON exchanges BEGIN
      INSERT INTO exchanges_fts(exchanges_fts, rowid, user_message, assistant_message)
      VALUES('delete', old.rowid, old.user_message, old.assistant_message);
    END
  `);
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS exchanges_fts_au AFTER UPDATE ON exchanges BEGIN
      INSERT INTO exchanges_fts(exchanges_fts, rowid, user_message, assistant_message)
      VALUES('delete', old.rowid, old.user_message, old.assistant_message);
      INSERT INTO exchanges_fts(rowid, user_message, assistant_message)
      VALUES (new.rowid, new.user_message, new.assistant_message);
    END
  `);
    // === Facts Schema ===
    db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      fact TEXT NOT NULL,
      category TEXT,
      scope_type TEXT NOT NULL DEFAULT 'project',
      scope_project TEXT,
      source_exchange_ids TEXT,
      embedding BLOB,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      consolidated_count INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1
    )
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope_type, scope_project)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_facts_active ON facts(is_active)
  `);
    db.exec(`
    CREATE TABLE IF NOT EXISTS fact_revisions (
      id TEXT PRIMARY KEY,
      fact_id TEXT NOT NULL,
      previous_fact TEXT NOT NULL,
      new_fact TEXT NOT NULL,
      reason TEXT,
      source_exchange_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (fact_id) REFERENCES facts(id)
    )
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_revisions_fact ON fact_revisions(fact_id)
  `);
    // vec_facts virtual table (sqlite-vec)
    db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts USING vec0(
      id TEXT PRIMARY KEY,
      embedding FLOAT[384]
    )
  `);
    // Korean-text vector index: facts are embedded twice (fact / fact_kr) because
    // multilingual models match same-language pairs far better than cross-language.
    // Queries search both tables and take the best score per fact id.
    db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts_kr USING vec0(
      id TEXT PRIMARY KEY,
      embedding FLOAT[384]
    )
  `);
    // Category embedding index: lets the ontology classifier retrieve the top-K
    // most-similar existing categories for a fact instead of dumping ALL
    // categories into the LLM prompt (measured 1,612 categories ≈ 95K tokens per
    // classify call). Embeddings (category name + description, 'passage' mode) are
    // written on createCategory; existing rows are backfilled by
    // scripts/backfill-category-embeddings.mjs.
    db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_categories USING vec0(
      id TEXT PRIMARY KEY,
      embedding FLOAT[384]
    )
  `);
    // === Ontology Schema ===
    db.exec(`
    CREATE TABLE IF NOT EXISTS ontology_domains (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
    db.exec(`
    CREATE TABLE IF NOT EXISTS ontology_categories (
      id TEXT PRIMARY KEY,
      domain_id TEXT NOT NULL REFERENCES ontology_domains(id),
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
    // Idempotent column addition for facts.ontology_category_id
    const factColumns = db.prepare(`SELECT name FROM pragma_table_info('facts')`).all();
    const factColumnNames = new Set(factColumns.map((c) => c.name));
    if (!factColumnNames.has('ontology_category_id')) {
        db.prepare('ALTER TABLE facts ADD COLUMN ontology_category_id TEXT').run();
    }
    if (!factColumnNames.has('fact_kr')) {
        db.prepare('ALTER TABLE facts ADD COLUMN fact_kr TEXT').run();
    }
    if (!factColumnNames.has('coding_agent')) {
        db.prepare("ALTER TABLE facts ADD COLUMN coding_agent TEXT DEFAULT 'claude-code'").run();
    }
    // Embedding model version (1 = all-MiniLM-L6-v2, 2 = multilingual L12-v2).
    // The re-embed worker upgrades rows where version < current.
    if (!factColumnNames.has('embedding_version')) {
        db.prepare('ALTER TABLE facts ADD COLUMN embedding_version INTEGER NOT NULL DEFAULT 1').run();
    }
    const exchangeColumns = db.prepare(`SELECT name FROM pragma_table_info('exchanges')`).all();
    if (!exchangeColumns.some((c) => c.name === 'embedding_version')) {
        db.prepare('ALTER TABLE exchanges ADD COLUMN embedding_version INTEGER NOT NULL DEFAULT 0').run();
    }
    db.exec(`
    CREATE TABLE IF NOT EXISTS ontology_relations (
      id TEXT PRIMARY KEY,
      source_fact_id TEXT NOT NULL REFERENCES facts(id),
      relation_type TEXT NOT NULL CHECK(relation_type IN ('INFLUENCES','SUPERSEDES','SUPPORTS','CONTRADICTS')),
      target_fact_id TEXT NOT NULL REFERENCES facts(id),
      reasoning TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_source ON ontology_relations(source_fact_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_target ON ontology_relations(target_fact_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_ontology ON facts(ontology_category_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_coding_agent ON facts(coding_agent)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ontology_categories_domain ON ontology_categories(domain_id)`);
    // Tracks which sessions have been through fact extraction (SessionEnd hook
    // or the backfill worker). Makes extraction idempotent and lets the backfill
    // find unprocessed sessions across ALL projects.
    db.exec(`
    CREATE TABLE IF NOT EXISTS extraction_log (
      session_id TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL,
      extracted INTEGER NOT NULL DEFAULT 0,
      saved INTEGER NOT NULL DEFAULT 0
    )
  `);
    // Self-heal slug-format scope_project rows (cheap probe; no-op when clean).
    // Keeps the canonical path format intact even when other devices sync in
    // facts written by older code.
    autoHealScopeProjects(db);
    return db;
}
export function insertExchange(db, exchange, embedding, _toolNames) {
    const now = Date.now();
    const stmt = db.prepare(`
    INSERT OR REPLACE INTO exchanges
    (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, last_indexed,
     parent_uuid, is_sidechain, session_id, cwd, git_branch, claude_version,
     thinking_level, thinking_disabled, thinking_triggers, coding_agent, embedding_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    stmt.run(exchange.id, exchange.project, exchange.timestamp, exchange.userMessage, exchange.assistantMessage, exchange.archivePath, exchange.lineStart, exchange.lineEnd, now, exchange.parentUuid || null, exchange.isSidechain ? 1 : 0, exchange.sessionId || null, exchange.cwd || null, exchange.gitBranch || null, exchange.claudeVersion || null, exchange.thinkingLevel || null, exchange.thinkingDisabled ? 1 : 0, exchange.thinkingTriggers || null, exchange.codingAgent || 'claude-code', 
    // The embedding parameter was just generated with the current model, so
    // stamp the current version — search filters on it and the re-embed
    // worker must not redo freshly indexed rows.
    EMBEDDING_VERSION);
    // Insert into vector table (atomic DELETE+INSERT via transaction, since virtual tables don't support REPLACE)
    const upsertVecExchange = db.transaction((vecId, buf) => {
        db.prepare('DELETE FROM vec_exchanges WHERE id = ?').run(vecId);
        db.prepare('INSERT INTO vec_exchanges (id, embedding) VALUES (?, ?)').run(vecId, buf);
    });
    upsertVecExchange(exchange.id, Buffer.from(new Float32Array(embedding).buffer));
    // Insert tool calls if present
    if (exchange.toolCalls && exchange.toolCalls.length > 0) {
        const toolStmt = db.prepare(`
      INSERT OR REPLACE INTO tool_calls
      (id, exchange_id, tool_name, tool_input, tool_result, is_error, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
        for (const toolCall of exchange.toolCalls) {
            toolStmt.run(toolCall.id, toolCall.exchangeId, toolCall.toolName, toolCall.toolInput ? JSON.stringify(toolCall.toolInput) : null, toolCall.toolResult || null, toolCall.isError ? 1 : 0, toolCall.timestamp);
        }
    }
}
export function getAllExchanges(db) {
    const stmt = db.prepare(`SELECT id, archive_path as archivePath FROM exchanges`);
    return stmt.all();
}
export function getFileLastIndexed(db, archivePath) {
    const stmt = db.prepare(`
    SELECT MAX(last_indexed) as lastIndexed
    FROM exchanges
    WHERE archive_path = ?
  `);
    const row = stmt.get(archivePath);
    return row.lastIndexed;
}
export function deleteExchange(db, id) {
    // Delete from vector table
    db.prepare(`DELETE FROM vec_exchanges WHERE id = ?`).run(id);
    // Delete from main table
    db.prepare(`DELETE FROM exchanges WHERE id = ?`).run(id);
}
