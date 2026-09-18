import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CODEX_NORMALIZATION_VERSION, normalizeCodexRollout, } from './codex-parser.js';
import { getArchiveDir, getExcludedProjects, getIndexDir, isExcludedProject } from './paths.js';
import { indexConversationFiles } from './sync.js';
export function getCodexSessionsDir() {
    return process.env.TEST_CODEX_SESSIONS_DIR
        || process.env.CODEX_SESSIONS_DIR
        || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
}
function getCodexSyncStatePath() {
    return process.env.TEST_CODEX_SYNC_STATE_PATH
        || path.join(getIndexDir(), 'codex-sync-state.json');
}
function loadState(statePath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (parsed.version === 1 && parsed.sessions && typeof parsed.sessions === 'object')
            return parsed;
    }
    catch {
        // Missing or malformed state is rebuilt incrementally.
    }
    return { version: 1, sessions: {} };
}
function atomicWrite(filePath, content, mode = 0o600) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    try {
        fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode });
        fs.renameSync(tempPath, filePath);
    }
    catch (error) {
        try {
            fs.unlinkSync(tempPath);
        }
        catch { /* cleanup best effort */ }
        throw error;
    }
}
function saveState(statePath, state) {
    atomicWrite(statePath, JSON.stringify(state, null, 2) + '\n');
}
export function listCodexRollouts(rootDir) {
    if (!fs.existsSync(rootDir))
        return [];
    const files = [];
    const pending = [rootDir];
    while (pending.length > 0) {
        const current = pending.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const entryPath = path.join(current, entry.name);
            if (entry.isDirectory())
                pending.push(entryPath);
            else if (entry.isFile() && entry.name.endsWith('.jsonl'))
                files.push(entryPath);
        }
    }
    return files.sort();
}
function isCurrent(entry, stat) {
    return !!entry
        && entry.normalizationVersion === CODEX_NORMALIZATION_VERSION
        && entry.mtimeMs === stat.mtimeMs
        && entry.size === stat.size
        && fs.existsSync(entry.destination);
}
/**
 * Normalize Codex rollout JSONL into Memory Bank's archive format and index
 * only new or changed sessions. A compact state file avoids re-reading large
 * historical rollouts (especially tool outputs) on every startup.
 */
export async function syncCodexConversations(sourceDir = getCodexSessionsDir(), destDir = getArchiveDir(), options = {}) {
    const result = {
        copied: 0,
        skipped: 0,
        indexed: 0,
        summarized: 0,
        errors: [],
    };
    const requestedFiles = options.sessionPath
        ? [path.resolve(options.sessionPath)]
        : listCodexRollouts(sourceDir);
    const statePath = options.statePath || getCodexSyncStatePath();
    const state = loadState(statePath);
    const excludedProjects = getExcludedProjects();
    const filesToIndex = [];
    const pendingState = new Map();
    const sourceByDestination = new Map();
    for (const sourcePath of requestedFiles) {
        try {
            const stat = fs.statSync(sourcePath);
            if (!stat.isFile() || !sourcePath.endsWith('.jsonl')) {
                result.skipped++;
                continue;
            }
            const sourceKey = path.resolve(sourcePath);
            const previous = state.sessions[sourceKey];
            if (isCurrent(previous, stat)) {
                result.skipped++;
                continue;
            }
            const normalized = await normalizeCodexRollout(sourcePath);
            if (normalized.messageCount === 0 || isExcludedProject(normalized.project, excludedProjects)) {
                result.skipped++;
                continue;
            }
            const destination = previous?.destination
                || path.join(destDir, normalized.project, `codex-${normalized.sessionId}.jsonl`);
            atomicWrite(destination, normalized.jsonl);
            const nextState = {
                mtimeMs: stat.mtimeMs,
                size: stat.size,
                destination,
                project: normalized.project,
                normalizationVersion: CODEX_NORMALIZATION_VERSION,
            };
            pendingState.set(sourceKey, nextState);
            sourceByDestination.set(destination, sourceKey);
            filesToIndex.push({ path: destination, project: normalized.project });
            result.copied++;
        }
        catch (error) {
            result.errors.push({
                file: sourcePath,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    if (!options.skipIndex && filesToIndex.length > 0) {
        const indexed = await indexConversationFiles(filesToIndex, 'codex');
        result.indexed = indexed.indexed;
        result.errors.push(...indexed.errors);
        const failedDestinations = new Set(indexed.errors.map(error => error.file));
        for (const item of filesToIndex) {
            if (failedDestinations.has(item.path))
                continue;
            const sourceKey = sourceByDestination.get(item.path);
            if (sourceKey)
                state.sessions[sourceKey] = pendingState.get(sourceKey);
        }
    }
    else {
        for (const [sourceKey, entry] of pendingState)
            state.sessions[sourceKey] = entry;
    }
    saveState(statePath, state);
    return result;
}
