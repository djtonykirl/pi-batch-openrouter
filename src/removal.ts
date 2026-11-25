import * as fs from "node:fs";
import * as path from "node:path";

const RETRYABLE = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

/** Removes a directory tree, retrying briefly when Windows still holds a file handle. */
export async function removeDirRobust(dir: string, attempts = 5, delayMs = 100): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i >= attempts || !RETRYABLE.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/** Total size in bytes of every file under `dir` (0 when it does not exist). */
export function dirSizeBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      total += e.isDirectory() ? dirSizeBytes(p) : fs.statSync(p).size;
    } catch {
      /* vanished while counting */
    }
  }
  return total;
}

/** Name of the folder an item is renamed to before it is removed; listings never match it. */
export const DELETING_PREFIX = ".deleting-";
