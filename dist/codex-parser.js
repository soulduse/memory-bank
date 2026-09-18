import crypto from 'node:crypto';
import readline from 'node:readline';
import { createArchiveReadStream } from './archive-io.js';
import { slugifyPath } from './project-canon.js';
export const CODEX_NORMALIZATION_VERSION = 1;
const INJECTED_CONTEXT_PREFIXES = [
    '<recommended_plugins>',
    '# AGENTS.md instructions for ',
    '<environment_context>',
    '<permissions instructions>',
    '<skills_instructions>',
    '<apps_instructions>',
    '<plugins_instructions>',
    '<collaboration_mode>',
];
export function isInjectedCodexContext(text) {
    const normalized = text.trimStart();
    return INJECTED_CONTEXT_PREFIXES.some(prefix => normalized.startsWith(prefix));
}
/**
 * Best-effort redaction before Codex text is copied into Memory Bank's archive.
 * Tool inputs and outputs are omitted entirely; this covers common secrets that
 * can still appear in user or assistant prose.
 */
export function redactCodexSecrets(text) {
    return text
        .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]')
        .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
        .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
        .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}/gi, '$1[REDACTED]')
        .replace(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|private[_-]?key|client[_-]?secret)\b(\s*[:=]\s*)("[^"\n]+"|'[^'\n]+'|[^\s,;]+)/gi, '$1$2[REDACTED]');
}
function textFromContent(content, role) {
    if (!Array.isArray(content))
        return '';
    const acceptedType = role === 'user' ? 'input_text' : 'output_text';
    return content
        .filter(block => block.type === acceptedType && typeof block.text === 'string')
        .map(block => block.text)
        .filter(text => role !== 'user' || !isInjectedCodexContext(text))
        .map(redactCodexSecrets)
        .filter(text => text.trim().length > 0)
        .join('\n\n');
}
function sessionIdFromFile(filePath) {
    const match = filePath.match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i);
    return match?.[1] ?? crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 32);
}
function toolName(payload) {
    const name = payload.name || 'unknown';
    return payload.namespace ? `${payload.namespace}.${name}` : name;
}
/**
 * Convert a Codex rollout into the Claude-compatible, sanitized JSONL shape
 * consumed by the existing Memory Bank parser. Developer/system context,
 * reasoning, tool inputs, and tool outputs are intentionally excluded.
 */
export async function normalizeCodexRollout(filePath) {
    const stream = createArchiveReadStream(filePath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let sessionId = '';
    let cwd = '';
    let cliVersion;
    let gitBranch;
    let source;
    let thinkingLevel;
    const messages = [];
    for await (const line of rl) {
        try {
            const record = JSON.parse(line);
            const payload = record.payload;
            if (!payload)
                continue;
            if (record.type === 'session_meta') {
                sessionId = payload.id || sessionId;
                cwd = payload.cwd || cwd;
                cliVersion = payload.cli_version || cliVersion;
                gitBranch = payload.git?.branch || gitBranch;
                source = payload.source || source;
                continue;
            }
            if (record.type === 'turn_context') {
                cwd = payload.cwd || cwd;
                thinkingLevel = payload.effort || thinkingLevel;
                continue;
            }
            if (record.type !== 'response_item')
                continue;
            if (payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
                const role = payload.role;
                const text = textFromContent(payload.content, role);
                if (!text)
                    continue;
                messages.push({
                    role,
                    timestamp: record.timestamp || new Date(0).toISOString(),
                    text,
                    thinkingLevel,
                });
                continue;
            }
            if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
                const callId = payload.call_id || payload.id || crypto.randomUUID();
                messages.push({
                    role: 'assistant',
                    timestamp: record.timestamp || new Date(0).toISOString(),
                    tool: { id: callId, name: toolName(payload) },
                    thinkingLevel,
                });
            }
        }
        catch {
            // Rollouts can be actively appended; ignore malformed or partial lines.
        }
    }
    sessionId ||= sessionIdFromFile(filePath);
    const project = cwd ? slugifyPath(cwd) : '-unknown-codex-project';
    const header = JSON.stringify({
        type: 'codex-normalization',
        version: CODEX_NORMALIZATION_VERSION,
        sessionId,
        source: source || 'codex',
    });
    const normalized = messages.map(message => {
        const content = message.tool
            ? [{ type: 'tool_use', id: message.tool.id, name: message.tool.name, input: {} }]
            : message.text || '';
        return JSON.stringify({
            type: message.role,
            timestamp: message.timestamp,
            sessionId,
            cwd: cwd || undefined,
            gitBranch,
            version: cliVersion,
            thinkingMetadata: message.thinkingLevel ? { level: message.thinkingLevel } : undefined,
            message: {
                role: message.role,
                content,
            },
        });
    });
    return {
        sessionId,
        cwd,
        project,
        cliVersion,
        gitBranch,
        source,
        jsonl: [header, ...normalized].join('\n') + '\n',
        messageCount: messages.length,
    };
}
