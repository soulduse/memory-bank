import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listCodexRollouts, syncCodexConversations } from '../src/codex-sync.js';

describe('Codex conversation sync', () => {
  let tempDir: string;
  let sourceDir: string;
  let destDir: string;
  let statePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'memory-bank-codex-sync-'));
    sourceDir = path.join(tempDir, 'sessions');
    destDir = path.join(tempDir, 'archive');
    statePath = path.join(tempDir, 'codex-sync-state.json');
    mkdirSync(path.join(sourceDir, '2026', '08', '11'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeRollout(name: string, answer: string): string {
    const sessionId = name.replace('.jsonl', '');
    const file = path.join(sourceDir, '2026', '08', '11', name);
    const records = [
      {
        type: 'session_meta',
        timestamp: '2026-08-11T00:00:00Z',
        payload: { id: sessionId, cwd: '/workspace/app', cli_version: '1.0.0', source: 'cli' },
      },
      {
        type: 'response_item',
        timestamp: '2026-08-11T00:00:01Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Question' }] },
      },
      {
        type: 'response_item',
        timestamp: '2026-08-11T00:00:02Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] },
      },
    ];
    writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8');
    return file;
  }

  it('walks nested session directories', () => {
    const first = writeRollout('11111111-1111-4111-8111-111111111111.jsonl', 'Answer one');
    const second = writeRollout('22222222-2222-4222-8222-222222222222.jsonl', 'Answer two');
    expect(listCodexRollouts(sourceDir)).toEqual([first, second]);
  });

  it('archives changed rollouts atomically and skips unchanged sessions via state', async () => {
    const source = writeRollout('11111111-1111-4111-8111-111111111111.jsonl', 'Answer one');

    const first = await syncCodexConversations(sourceDir, destDir, { skipIndex: true, statePath });
    expect(first).toMatchObject({ copied: 1, skipped: 0, indexed: 0 });
    const destination = path.join(destDir, '-workspace-app', 'codex-11111111-1111-4111-8111-111111111111.jsonl');
    expect(existsSync(destination)).toBe(true);
    expect(readFileSync(destination, 'utf8')).toContain('Answer one');
    expect(statSync(destination).mode & 0o777).toBe(0o600);

    const second = await syncCodexConversations(sourceDir, destDir, { skipIndex: true, statePath });
    expect(second).toMatchObject({ copied: 0, skipped: 1, indexed: 0 });

    writeRollout('11111111-1111-4111-8111-111111111111.jsonl', 'Answer changed');
    const future = new Date(Date.now() + 5000);
    utimesSync(source, future, future);
    const third = await syncCodexConversations(sourceDir, destDir, { skipIndex: true, statePath });
    expect(third.copied).toBe(1);
    expect(readFileSync(destination, 'utf8')).toContain('Answer changed');
  });

  it('can target one SessionEnd transcript without scanning the rest', async () => {
    const first = writeRollout('11111111-1111-4111-8111-111111111111.jsonl', 'Answer one');
    writeRollout('22222222-2222-4222-8222-222222222222.jsonl', 'Answer two');

    const result = await syncCodexConversations(sourceDir, destDir, {
      sessionPath: first,
      skipIndex: true,
      statePath,
    });
    expect(result.copied).toBe(1);
    expect(existsSync(path.join(destDir, '-workspace-app', 'codex-11111111-1111-4111-8111-111111111111.jsonl'))).toBe(true);
    expect(existsSync(path.join(destDir, '-workspace-app', 'codex-22222222-2222-4222-8222-222222222222.jsonl'))).toBe(false);
  });
});
