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

// Optional access: older Node runtimes don't ship zstd in node:zlib.
const zstd: {
  zstdDecompressSync?: (buf: Buffer) => Buffer;
  createZstdDecompress?: () => import('node:stream').Transform;
} = zlib;

/** Strip a trailing `.zst` so archive filenames compare in canonical form. */
export function canonicalArchiveName(fileName: string): string {
  return fileName.endsWith(ZST_SUFFIX) ? fileName.slice(0, -ZST_SUFFIX.length) : fileName;
}

/**
 * Resolve the on-disk file for an archive path, trying both the plain and
 * `.zst`-compressed variants. Returns null when neither exists.
 */
export function resolveArchiveFile(filePath: string): string | null {
  try {
    fs.accessSync(filePath);
    return filePath;
  } catch {
    // fall through to variant checks
  }

  const variant = filePath.endsWith(ZST_SUFFIX)
    ? filePath.slice(0, -ZST_SUFFIX.length)
    : filePath + ZST_SUFFIX;
  try {
    fs.accessSync(variant);
    return variant;
  } catch {
    return null;
  }
}

/** Whether an archive file exists in either plain or compressed form. */
export function archiveFileExists(filePath: string): boolean {
  return resolveArchiveFile(filePath) !== null;
}

function requireZstdSync(): (buf: Buffer) => Buffer {
  if (!zstd.zstdDecompressSync) {
    throw new Error(
      'Archive file is zstd-compressed but this Node runtime has no zstd support (need Node >= 22.15)',
    );
  }
  return zstd.zstdDecompressSync;
}

/** Read an archive file as UTF-8, transparently decompressing `.zst`. */
export function readArchiveFile(filePath: string): string {
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
export function createArchiveReadStream(filePath: string): Readable {
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
      pipeline(source, decompress, () => { /* error surfaces on the returned stream */ });
      return decompress;
    }
    // Fallback: decompress in memory
    const content = requireZstdSync()(fs.readFileSync(resolved));
    return Readable.from([content]);
  }
  return fs.createReadStream(resolved);
}

/** stat() the resolved archive file (plain or compressed), null if missing. */
export function statArchiveFile(filePath: string): fs.Stats | null {
  const resolved = resolveArchiveFile(filePath);
  if (!resolved) return null;
  try {
    return fs.statSync(resolved);
  } catch {
    return null;
  }
}
