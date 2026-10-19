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

/**
 * Cross-process advisory lock via exclusive file creation. Prevents two Pi
 * processes (or two overlapping polls) from reconciling the same job at once.
 * A lock older than `staleMs` is assumed abandoned (crash) and taken over.
 */
export function tryAcquireLock(lockPath: string, staleMs = 120_000): FileLock | null {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
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
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age <= staleMs) return null;
        fs.unlinkSync(lockPath);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Acquire with short synchronous retries; for user commands that must not silently skip. */
export function acquireLock(lockPath: string, waitMs = 3000): FileLock {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const lock = tryAcquireLock(lockPath);
    if (lock) return lock;
    if (Date.now() > deadline) {
      throw new Error(`Job is busy (lock held: ${lockPath}). Try again shortly.`);
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
