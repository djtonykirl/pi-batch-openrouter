import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Atomic replace: write temp file -> fsync -> close -> rename.
 * A crash leaves either the old file or the new file, never a valid-looking
 * partial one. On Windows `rename` over an existing file can transiently fail
 * with EPERM/EBUSY when AV or indexers hold a handle, so it is retried briefly.
 */
export function atomicWriteFile(filePath: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  renameWithRetry(tmp, filePath);
}

function renameWithRetry(from: string, to: string): void {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") break;
      lastErr = err;
      sleepSync(25 * (attempt + 1));
    }
  }
  try {
    fs.unlinkSync(from);
  } catch {
    // temp file cleanup is best-effort; the real error is rethrown below
  }
  throw lastErr ?? new Error(`rename failed: ${from} -> ${to}`);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function atomicWriteJson(filePath: string, data: unknown): void {
  atomicWriteFile(filePath, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Write a historical artefact exactly once. If the path already exists a
 * numbered sibling is written instead (`final-response.2.json`), so raw
 * provider evidence is never mutated. Returns the path actually written.
 */
export function writeOnce(filePath: string, data: string | Buffer): string {
  const ext = path.extname(filePath);
  const base = filePath.slice(0, filePath.length - ext.length);
  let target = filePath;
  for (let n = 2; fs.existsSync(target); n++) target = `${base}.${n}${ext}`;
  atomicWriteFile(target, data);
  return target;
}

/**
 * Like writeOnce, but if the target already holds exactly these bytes nothing is
 * written. Used for evidence derived deterministically from a saved raw response,
 * so re-running an interrupted retrieval is idempotent without overwriting anything.
 */
export function writeOnceUnlessIdentical(filePath: string, data: string): string {
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === data) return filePath;
  return writeOnce(filePath, data);
}

export function appendJsonl(filePath: string, record: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");
}

/** Reads JSONL; a torn final line (crash mid-append) is skipped and reported. */
export function readJsonl<T>(filePath: string): { records: T[]; malformedLines: number } {
  if (!fs.existsSync(filePath)) return { records: [], malformedLines: 0 };
  const records: T[] = [];
  let malformedLines = 0;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      malformedLines++;
    }
  }
  return { records, malformedLines };
}

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** Deterministic JSON: object keys sorted recursively. Used for content hashing only. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export interface FileLock {
  release(): void;
}

/** A takeover marker older than this was left by a process that died mid-takeover (which takes milliseconds). */
const BREAK_STALE_MS = 10_000;

/** Test seam: runs after a lock is judged stale and before it is removed. */
export interface LockTestHooks {
  beforeStaleRemoval?: () => void;
}

/**
 * Cross-process advisory lock via exclusive file creation. Prevents two Pi
 * processes (or two overlapping polls) from reconciling the same job at once.
 * A lock older than `staleMs` is assumed abandoned (crash) and taken over.
 *
 * Takeover is serialised through an exclusive `<lock>.break` marker, and the
 * lock is re-read before removal: otherwise two processes that both judged the
 * same lock stale could each remove it, the second deleting the first's fresh
 * lock, leaving two owners.
 *
 * Owner liveness (PID checks) is deliberately not used: a workspace may be shared
 * across PID spaces (WSL and Windows, containers, synced or network folders), where
 * a live owner's PID can look dead. The age timeout is the only takeover rule.
 */
export function tryAcquireLock(lockPath: string, staleMs = 120_000, hooks: LockTestHooks = {}): FileLock | null {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: crypto.randomBytes(8).toString("hex") }));
      fs.closeSync(fd);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // already removed (e.g. stale takeover by another process)
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let judged: string;
      try {
        judged = fs.readFileSync(lockPath, "utf8");
        if (Date.now() - fs.statSync(lockPath).mtimeMs <= staleMs) return null;
      } catch {
        continue; // released between our create attempt and the read: try again
      }
      if (!removeStaleLock(lockPath, judged, hooks)) return null;
    }
  }
  return null;
}

/** Removes `lockPath` only if it still holds exactly the stale content judged, with takeovers serialised. */
function removeStaleLock(lockPath: string, judged: string, hooks: LockTestHooks): boolean {
  const breakPath = `${lockPath}.break`;
  let fd: number;
  try {
    fd = fs.openSync(breakPath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // Another process is taking over right now. A marker this old was orphaned by a crash mid-takeover.
    try {
      if (Date.now() - fs.statSync(breakPath).mtimeMs > BREAK_STALE_MS) fs.unlinkSync(breakPath);
    } catch {
      // gone already
    }
    return false;
  }
  try {
    fs.closeSync(fd);
    hooks.beforeStaleRemoval?.();
    let current: string;
    try {
      current = fs.readFileSync(lockPath, "utf8");
    } catch {
      return true; // already released: the caller retries the exclusive create
    }
    // Replaced since it was judged (e.g. another takeover completed): it is a live lock now.
    if (current !== judged) return false;
    fs.unlinkSync(lockPath);
    return true;
  } finally {
    try {
      fs.unlinkSync(breakPath);
    } catch {
      // Already removed by an orphan sweep (only possible if this takeover stalled > BREAK_STALE_MS).
      // Even then the re-read above keeps a replaced (live) lock from being deleted.
    }
  }
}

export class LockTimeoutError extends Error {
  constructor(public readonly lockPath: string) {
    super(`Job is busy (lock held: ${lockPath}). Try again shortly.`);
    this.name = "LockTimeoutError";
  }
}

/** Acquire with short synchronous retries; for user commands that must not silently skip. */
export function acquireLock(lockPath: string, waitMs = 3000): FileLock {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const lock = tryAcquireLock(lockPath);
    if (lock) return lock;
    if (Date.now() > deadline) {
      throw new LockTimeoutError(lockPath);
    }
    sleepSync(50);
  }
}

/** Case-insensitive on Windows/macOS-default filesystems; exact elsewhere. */
export function pathsEqual(a: string, b: string): boolean {
  if (process.platform === "win32") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/** True if `child` is `parent` or inside it (after resolution). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false; // different drive on Windows
  return !/^\.\.([\\/]|$)/.test(rel);
}

/**
 * Atomic write. Without `overwrite` the destination is created exclusively: the
 * complete temp file is hard-linked into place (fails if anything exists there),
 * so an existing file is never replaced and a crash never leaves a partial file.
 */
export function writeFileAtomicExclusive(absPath: string, data: string | Buffer, overwrite: boolean): void {
  if (overwrite) {
    atomicWriteFile(absPath, data);
    return;
  }
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  const fd = fs.openSync(tmp, "wx");
  try {
    fs.writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    try {
      fs.linkSync(tmp, absPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw new Error(`${absPath} already exists; nothing was overwritten (use --overwrite to replace it, or --out <path>)`);
      // File systems without hard links: exclusive copy (still never overwrites).
      fs.copyFileSync(tmp, absPath, fs.constants.COPYFILE_EXCL);
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best-effort temp cleanup
    }
  }
}
