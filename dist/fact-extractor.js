import { callHaiku, parseJsonResponse } from './llm.js';
import { insertFact } from './fact-db.js';
import { generateEmbedding, initEmbeddings } from './embeddings.js';
import { classifyAndLinkFact } from './ontology-classifier.js';
const EXTRACTION_SYSTEM_PROMPT = `You are an expert at extracting long-term facts from conversations.

## Rules
- 1 fact = 1 sentence (concise)
- Ignore trivial exchanges (greetings, "yes", "thanks")
- Code snippets are NOT facts - extract only decisions/patterns
- No duplicate facts within the same batch

## scope determination
- project: specific files/paths/DB/API/framework/business logic
- global: coding style, language/response format, common tool usage

## Output format (JSON array)
[
  {
    "fact": "User uses Riverpod for state management",
    "fact_kr": "사용자는 상태 관리에 Riverpod을 사용한다",
    "category": "decision",
    "scope_type": "project",
    "confidence": 0.9
  }
]

## fact_kr rules
- Natural Korean translation of "fact"
- Keep technical terms (API/tool/framework names, file paths, commands) in English

## category choices
- decision: architecture/technology decisions
- preference: user preferences
- pattern: repeated patterns
- knowledge: project knowledge
- constraint: constraints

## confidence criteria
- 0.9+: explicit decision/declaration
- 0.7-0.9: inferred from behavior
- Below 0.7: do not extract`;
const BATCH_SIZE = 5; // configurable-ok
const MAX_FACTS_PER_SESSION = 20; // configurable-ok
const CONFIDENCE_THRESHOLD = 0.7; // configurable-ok
// Self-referential repos whose conversations must NOT be extracted (e.g.
// memory-bank's own monitoring/cron sessions — extracting them creates noise
// facts and an endless feedback loop). Comma-separated cwd paths, env-overridable.
const EXCLUDE_PROJECTS = (process.env.BACKFILL_EXCLUDE_PROJECTS ||
    '/Users/jung-wankim/Project/Claude/memory-bank')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
function isExcludedProject(project) {
    if (!project)
        return false;
    return EXCLUDE_PROJECTS.some((p) => project === p || project.startsWith(p));
}
export function buildExtractionPrompt(exchanges) {
    return exchanges.map((ex, i) => {
        const userSnippet = ex.user_message.slice(0, 1000);
        const assistantSnippet = ex.assistant_message.slice(0, 1000);
        return `### Exchange ${i + 1}\nUser: ${userSnippet}\nAssistant: ${assistantSnippet}`;
    }).join('\n\n');
}
export async function extractFactsFromExchanges(db, sessionId) {
    const exchanges = db.prepare(`
    SELECT id, user_message, assistant_message
    FROM exchanges
    WHERE session_id = ?
    ORDER BY timestamp ASC
  `).all(sessionId);
    if (exchanges.length === 0)
        return [];
    const allFacts = [];
    for (let i = 0; i < exchanges.length; i += BATCH_SIZE) {
        if (allFacts.length >= MAX_FACTS_PER_SESSION)
            break;
        const batch = exchanges.slice(i, i + BATCH_SIZE);
        const prompt = buildExtractionPrompt(batch);
        try {
            const response = await callHaiku(EXTRACTION_SYSTEM_PROMPT, prompt);
            const extracted = parseJsonResponse(response);
            if (extracted && Array.isArray(extracted)) {
                for (const fact of extracted) {
                    if (fact.confidence >= CONFIDENCE_THRESHOLD && allFacts.length < MAX_FACTS_PER_SESSION) {
                        allFacts.push(fact);
                    }
                }
            }
        }
        catch (error) {
            console.error(`Batch ${Math.floor(i / BATCH_SIZE)} extraction failed:`, error);
        }
    }
    return allFacts;
}
export async function saveExtractedFacts(db, facts, project, sourceExchangeIds, codingAgent) {
    await initEmbeddings();
    const savedIds = [];
    for (const fact of facts) {
        const embedding = await generateEmbedding(fact.fact);
        const embeddingKr = fact.fact_kr ? await generateEmbedding(fact.fact_kr) : null;
        const id = insertFact(db, {
            fact: fact.fact,
            category: fact.category,
            scope_type: fact.scope_type,
            scope_project: fact.scope_type === 'project' ? project : null,
            source_exchange_ids: sourceExchangeIds,
            embedding,
            coding_agent: codingAgent,
            fact_kr: fact.fact_kr ?? null,
            embedding_kr: embeddingKr,
        });
        savedIds.push(id);
        // Ontology classification + relation detection (must await to prevent DB close race)
        try {
            await classifyAndLinkFact(db, id, embedding);
        }
        catch (err) {
            console.error(`Ontology pipeline failed for fact ${id}:`, err);
        }
    }
    return savedIds;
}
export async function runFactExtraction(db, sessionId, project, codingAgent) {
    // Skip self-referential repos (memory-bank's own monitoring sessions) — mark
    // as processed with zero facts so they are never re-attempted, no LLM calls.
    if (isExcludedProject(project)) {
        try {
            db.prepare(`
        INSERT INTO extraction_log (session_id, processed_at, extracted, saved)
        VALUES (?, ?, 0, 0)
        ON CONFLICT(session_id) DO UPDATE SET processed_at = excluded.processed_at,
          extracted = 0, saved = 0
      `).run(sessionId, new Date().toISOString());
        }
        catch { /* log table may not exist on very old DBs */ }
        return { extracted: 0, saved: 0 };
    }
    const facts = await extractFactsFromExchanges(db, sessionId);
    let saved = 0;
    if (facts.length > 0) {
        // Detect coding agent from session's exchanges if not provided
        const agent = codingAgent || detectAgentFromSession(db, sessionId);
        const exchangeIds = db.prepare('SELECT id FROM exchanges WHERE session_id = ?').all(sessionId).map((r) => r.id);
        saved = (await saveExtractedFacts(db, facts, project, exchangeIds, agent)).length;
    }
    // Record the session as processed (idempotency marker shared by the
    // SessionEnd hook and the cross-project backfill worker).
    try {
        db.prepare(`
      INSERT INTO extraction_log (session_id, processed_at, extracted, saved)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET processed_at = excluded.processed_at,
        extracted = excluded.extracted, saved = excluded.saved
    `).run(sessionId, new Date().toISOString(), facts.length, saved);
    }
    catch {
        // log table may not exist on very old DBs — extraction result still stands
    }
    return { extracted: facts.length, saved };
}
/**
 * Detect the coding agent from a session's exchanges.
 * Returns the coding_agent of the first exchange in the session, or 'claude-code' as default.
 */
function detectAgentFromSession(db, sessionId) {
    const row = db.prepare('SELECT coding_agent FROM exchanges WHERE session_id = ? LIMIT 1').get(sessionId);
    return row?.coding_agent || 'claude-code';
}
