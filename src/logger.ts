import * as fs from "node:fs";
import * as path from "node:path";
import { redactSecretValue } from "./openrouter/client.js";

/**
 * Structured JSONL diagnostics written to `<storage>/extension.log`.
 *
 * Never logs: API keys, Authorization headers, secret values, request
 * payloads or provider responses (those live in the job's artefact folders).
 * Console output is avoided entirely because it would corrupt Pi's TUI.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  localId?: string;
  providerBatchId?: string;
  [key: string]: unknown;
}

export interface Logger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
}

const MAX_BYTES = 5 * 1024 * 1024;

export class FileLogger implements Logger {
  constructor(
    private readonly filePath: string,
    private readonly secrets: () => string[] = () => [],
  ) {}

  public log(level: LogLevel, event: string, fields: LogFields = {}): void {
    try {
      let line = JSON.stringify({ at: new Date().toISOString(), level, event, ...fields });
      for (const s of this.secrets()) line = redactSecretValue(line, s);
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      try {
        if (fs.statSync(this.filePath).size > MAX_BYTES) fs.renameSync(this.filePath, `${this.filePath}.1`);
      } catch {
        // log file does not exist yet
      }
      fs.appendFileSync(this.filePath, line + "\n", "utf8");
    } catch {
      // Diagnostics must never break job processing.
    }
  }
}

export const nullLogger: Logger = { log() {} };
