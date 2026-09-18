#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'ignore',
      windowsHide: true,
      ...options,
    });
    child.on('error', reject);
    child.on('exit', code => resolve(code ?? 1));
  });
}

async function main() {
  let input = {};
  try { input = JSON.parse(process.argv[2] || '{}'); } catch { return; }

  const transcriptPath = typeof input.transcriptPath === 'string' ? input.transcriptPath : '';
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  if (!transcriptPath || !sessionId) return;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const cli = path.join(here, '..', 'cli', 'memory-bank.js');
  const syncCode = await run(process.execPath, [
    cli,
    'sync',
    '--agent',
    'codex',
    '--session',
    transcriptPath,
    '--wait',
  ]);
  if (syncCode !== 0) return;

  const factWorker = path.join(here, 'fact-extract-worker.js');
  const child = spawn(process.execPath, [factWorker], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, SESSION_ID: sessionId, CWD: cwd },
  });
  child.unref();
}

main().catch(() => process.exit(0));
