import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, type BatchConfig } from "../src/config.js";

/** Temp dir whose path contains a space (Windows "My Documents"-style paths). */
export function tempWorkspace(prefix = "pi batch ws-"): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function writeFiles(root: string, files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

export function config(overrides: Partial<BatchConfig> = {}): BatchConfig {
  return { ...structuredClone(DEFAULT_CONFIG), ...overrides };
}

export function rm(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
