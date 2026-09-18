#!/usr/bin/env node
/**
 * Cross-platform wrapper script for MCP server that ensures dependencies are installed
 * This runs before the MCP server starts and works on Windows, macOS, and Linux
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { delimiter, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

// Determine plugin root directory
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(__dirname, '..');

function dependenciesAreUsable() {
  if (!existsSync(join(PLUGIN_ROOT, 'node_modules'))) return false;

  try {
    const Database = require('better-sqlite3');
    const database = new Database(':memory:');
    database.close();
    return true;
  } catch (error) {
    console.error(`Memory Bank dependencies need repair: ${error.message}`);
    return false;
  }
}

// Run npm under the same Node executable as the MCP server. This prevents a
// native-module ABI mismatch when the user's interactive shell selects a
// different Node version than Codex or Claude Code.
function runNpmInstall(rebuildOnly) {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const npmCli = join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const useNpmCli = existsSync(npmCli);
    const npmCommand = useNpmCli ? process.execPath : (isWindows ? 'npm.cmd' : 'npm');
    const npmArgs = useNpmCli ? [npmCli] : [];
    npmArgs.push(rebuildOnly ? 'rebuild' : 'install');
    if (rebuildOnly) npmArgs.push('better-sqlite3');
    npmArgs.push('--prefer-offline', '--no-audit', '--no-fund');

    console.error(`${rebuildOnly ? 'Repairing' : 'Installing'} memory-bank dependencies...`);
    console.error('This may take 30-60 seconds...');

    // Install dependencies - npm will auto-install optionalDependencies for current platform
    const child = spawn(npmCommand, npmArgs, {
      cwd: PLUGIN_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows && !useNpmCli,
      env: {
        ...process.env,
        PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
      },
    });

    child.stdout.on('data', (data) => {
      // Suppress npm install output to stderr to avoid cluttering MCP logs
      process.stderr.write(data);
    });

    child.stderr.on('data', (data) => {
      process.stderr.write(data);
    });

    child.on('exit', (code) => {
      if (code === 0) {
        console.error('Dependencies installed successfully.');
        resolve();
      } else {
        console.error('ERROR: Failed to install dependencies.');
        console.error(`Please run manually: cd "${PLUGIN_ROOT}" && npm install`);
        reject(new Error(`npm install failed with exit code ${code}`));
      }
    });

    child.on('error', (err) => {
      console.error(`ERROR: Failed to run npm install: ${err.message}`);
      reject(err);
    });
  });
}

async function main() {
  try {
    // Check if node_modules exists
    const nodeModulesPath = join(PLUGIN_ROOT, 'node_modules');
    if (!existsSync(nodeModulesPath)) {
      await runNpmInstall(false);
    } else if (!dependenciesAreUsable()) {
      await runNpmInstall(true);
    }

    if (!dependenciesAreUsable()) {
      console.error('ERROR: Memory Bank dependencies are not compatible with the active Node runtime.');
      process.exit(1);
    }

    // Start the MCP server
    const mcpServerPath = join(PLUGIN_ROOT, 'dist', 'mcp-server.js');

    if (!existsSync(mcpServerPath)) {
      console.error(`ERROR: MCP server not found at ${mcpServerPath}`);
      console.error('Please run: npm run build');
      process.exit(1);
    }

    // Use spawn with shell: false for better cross-platform compatibility
    const child = spawn(process.execPath, [mcpServerPath], {
      stdio: 'inherit',
      shell: false
    });

    // Forward signals to the child process
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    process.on('SIGINT', () => child.kill('SIGINT'));

    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
      } else {
        process.exit(code || 0);
      }
    });

    child.on('error', (err) => {
      console.error(`ERROR: Failed to start MCP server: ${err.message}`);
      process.exit(1);
    });

  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Unexpected error: ${error.message}`);
  process.exit(1);
});
