import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isInjectedCodexContext,
  normalizeCodexRollout,
  redactCodexSecrets,
} from '../src/codex-parser.js';
import { parseConversation } from '../src/parser.js';

const tempDirs: string[] = [];

function tempFile(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'memory-bank-codex-parser-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'rollout-2026-08-11T00-00-00-11111111-1111-4111-8111-111111111111.jsonl');
  writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n{malformed', 'utf8');
  return file;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

describe('Codex rollout normalization', () => {
  it('filters injected context, strips tool payloads, and preserves a searchable exchange', async () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const file = tempFile([
      {
        type: 'session_meta',
        timestamp: '2026-08-11T00:00:00Z',
        payload: {
          id: sessionId,
          cwd: '/Users/test/app-factory',
          cli_version: '0.146.1',
          source: 'cli',
          git: { branch: 'feature/memory' },
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-08-11T00:00:01Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '<recommended_plugins>generated context</recommended_plugins>' },
            { type: 'input_text', text: '# AGENTS.md instructions for /Users/test\nGenerated rules' },
          ],
        },
      },
      {
        type: 'turn_context',
        timestamp: '2026-08-11T00:00:02Z',
        payload: { cwd: '/Users/test/app-factory', effort: 'high', model: 'gpt-test' },
      },
      {
        type: 'response_item',
        timestamp: '2026-08-11T00:00:03Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Implement shared memory. api_key=abcdefghijklmnopqrstuvwxyz123456' }],
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-08-11T00:00:04Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'I will inspect the sync pipeline.' }],
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-08-11T00:00:05Z',
        payload: {
          type: 'function_call',
          call_id: 'call-stable-1',
          name: 'exec_command',
          arguments: '{"cmd":"echo secret-value"}',
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-08-11T00:00:06Z',
        payload: {
          type: 'function_call_output',
          call_id: 'call-stable-1',
          output: 'private tool output must not be archived',
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-08-11T00:00:07Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'The adapter is complete.' }],
        },
      },
    ]);

    const normalized = await normalizeCodexRollout(file);
    expect(normalized.sessionId).toBe(sessionId);
    expect(normalized.project).toBe('-Users-test-app-factory');
    expect(normalized.messageCount).toBe(4);
    expect(normalized.jsonl).not.toContain('recommended_plugins');
    expect(normalized.jsonl).not.toContain('AGENTS.md instructions');
    expect(normalized.jsonl).not.toContain('private tool output');
    expect(normalized.jsonl).not.toContain('echo secret-value');
    expect(normalized.jsonl).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(normalized.jsonl).toContain('[REDACTED]');

    const archive = path.join(path.dirname(file), 'normalized.jsonl');
    writeFileSync(archive, normalized.jsonl, 'utf8');
    const exchanges = await parseConversation(archive, normalized.project, archive);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].userMessage).toContain('Implement shared memory');
    expect(exchanges[0].assistantMessage).toContain('inspect the sync pipeline');
    expect(exchanges[0].assistantMessage).toContain('adapter is complete');
    expect(exchanges[0].toolCalls).toHaveLength(1);
    expect(exchanges[0].toolCalls?.[0]).toMatchObject({
      id: 'call-stable-1',
      toolName: 'exec_command',
      toolInput: {},
    });
    expect(exchanges[0].thinkingLevel).toBe('high');
    expect(exchanges[0].codingAgent).toBeUndefined();
  });

  it('recognizes generated context and redacts common credentials', () => {
    expect(isInjectedCodexContext('<environment_context>cwd</environment_context>')).toBe(true);
    expect(isInjectedCodexContext('Please inspect the environment context parser')).toBe(false);
    expect(redactCodexSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
    expect(redactCodexSecrets('password="very-secret-password"')).toBe('password=[REDACTED]');
  });
});
