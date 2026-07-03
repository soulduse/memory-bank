import fs from 'fs';
import { Readable, pipeline } from 'stream';
import * as zlib from 'node:zlib';
/**
 * Transparent access to archived conversation files.
 *
 * The conversation archive may be compressed out-of-band (an external job
 * rewrites `*.jsonl` → `*.jsonl.zst` to save disk). The database keeps the
 * canonical `.jsonl` paths, so every read path must resolve either variant.
 * Node >= 22.15 ships zstd support in node:zlib — no extra dependency.
 */
const ZST_SUFFIX = '.zst';
/**
 * Cap for in-memory decompression — a hostile high-ratio `.zst` file
 * ("compression bomb") must not be able to exhaust process memory. Real
 * conversation files decompress to a few MB. Node throws when exceeded.
 */
const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024; // 256 MiB
// Optional access: older Node runtimes don't ship zstd in node:zlib.
const zstd = zlib;
/** Strip a trailing `.zst` so archive filenames compare in canonical form. */
export function canonicalArchiveName(fileName) {
    return fileName.endsWith(ZST_SUFFIX) ? fileName.slice(0, -ZST_SUFFIX.length) : fileName;
}
/**
 * Resolve the on-disk file for an archive path, trying both the plain and
 * `.zst`-compressed variants. When both exist the NEWER one wins (an active
 * session may have re-synced a plain copy after compression, or the
 * compressor may have refreshed the `.zst` after a stale plain copy).
 * Returns null when neither exists.
 */
export function resolveArchiveFile(filePath) {
    const variant = filePath.endsWith(ZST_SUFFIX)
        ? filePath.slice(0, -ZST_SUFFIX.length)
        : filePath + ZST_SUFFIX;
    const statOrNull = (p) => {
        try {
            return fs.statSync(p);
        }
        catch {
            return null;
        }
    };
    const primary = statOrNull(filePath);
    const secondary = statOrNull(variant);
    if (primary && secondary) {
        return secondary.mtimeMs > primary.mtimeMs ? variant : filePath;
    }
    if (primary)
        return filePath;
    if (secondary)
        return variant;
    return null;
}
/** Whether an archive file exists in either plain or compressed form. */
export function archiveFileExists(filePath) {
    return resolveArchiveFile(filePath) !== null;
}
function requireZstdSync() {
    const decompress = zstd.zstdDecompressSync;
    if (!decompress) {
        throw new Error('Archive file is zstd-compressed but this Node runtime has no zstd support (need Node >= 22.15)');
    }
    return (buf) => decompress(buf, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
}
/** Read an archive file as UTF-8, transparently decompressing `.zst`. */
export function readArchiveFile(filePath) {
    const resolved = resolveArchiveFile(filePath);
    if (!resolved) {
        throw Object.assign(new Error(`ENOENT: no such file, open '${filePath}'`), { code: 'ENOENT' });
    }
    const buf = fs.readFileSync(resolved);
    if (resolved.endsWith(ZST_SUFFIX)) {
        return requireZstdSync()(buf).toString('utf-8');
    }
    return buf.toString('utf-8');
}
/**
 * Create a readable stream over an archive file, transparently decompressing
 * `.zst`. Suitable as input for readline.createInterface.
 */
export function createArchiveReadStream(filePath) {
    const resolved = resolveArchiveFile(filePath);
    if (!resolved) {
        // Match fs.createReadStream semantics: surface ENOENT to stream consumers.
        return fs.createReadStream(filePath);
    }
    if (resolved.endsWith(ZST_SUFFIX)) {
        if (zstd.createZstdDecompress) {
            // pipeline() propagates source errors (e.g. the file being swapped by
            // the external compressor between resolve and open) to the returned
            // stream — bare .pipe() would leave them unhandled and crash.
            const source = fs.createReadStream(resolved);
            const decompress = zstd.createZstdDecompress();
            pipeline(source, decompress, () => { });
            return decompress;
        }
        // Fallback: decompress in memory
        const content = requireZstdSync()(fs.readFileSync(resolved));
        return Readable.from([content]);
    }
    return fs.createReadStream(resolved);
}
/** stat() the resolved archive file (plain or compressed), null if missing. */
export function statArchiveFile(filePath) {
    const resolved = resolveArchiveFile(filePath);
    if (!resolved)
        return null;
    try {
        return fs.statSync(resolved);
    }
    catch {
        return null;
    }
}
