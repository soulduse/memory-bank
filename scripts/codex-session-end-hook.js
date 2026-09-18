#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

function readStdin(timeoutMs = 2000) {
  return new Promise(resolve => {
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
}

async function main() {
  // Codex sets PLUGIN_ROOT (and CLAUDE_PLUGIN_ROOT for compatibility). Claude
  // Code sets only CLAUDE_PLUGIN_ROOT, so the shared hook file stays safe.
  if (!process.env.PLUGIN_ROOT) return;

  const raw = await readStdin();
  let input = {};
  try { input = JSON.parse(raw); } catch { /* invalid hook input: skip */ }

  const transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : '';
  const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  if (!transcriptPath || !sessionId) return;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const worker = path.join(here, 'codex-session-end-worker.js');
  const child = spawn(process.execPath, [worker, JSON.stringify({ transcriptPath, sessionId, cwd })], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env },
  });
  child.unref();

  console.log(`memory-bank: queued Codex session ${sessionId}`);
}

main().catch(() => process.exit(0));
