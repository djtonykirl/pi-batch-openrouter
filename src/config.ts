import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteJson } from "./fsutil.js";
import { isPrivacyLevel, type PrivacyLevel } from "./privacy/policy.js";

/**
 * Application defaults — NOT claims about OpenRouter limits.
 *
 * Cascade (later wins):
 *   defaults
 *   <- ~/.pi/agent/pi-batch-openrouter/config.json      (global; `/batch --global model ...`)
 *   <- <cwd>/.pi/pi-batch-openrouter.json               (legacy project file, read-only)
 *   <- <cwd>/.pi/batch.config.json                      (project; `/batch model ...`)
 */
export interface BatchConfig {
  schemaVersion: 1;
  defaultModel: string;
  /** Pi provider/account alias whose API key is used (e.g. "openrouter", "openrouter-work"). */
  defaultAccount: string;
  endpoint: "/v1/chat/completions";
  storagePath: string;
  notifyOnComplete: boolean;
  request: { maxTokens: number };
  polling: { enabled: boolean; intervalSeconds: number; maxBackoffSeconds: number; requestTimeoutSeconds: number };
  context: {
    respectGitignore: boolean;
    batchIgnoreFile: string;
    maxFileBytes: number;
    maxContextCharacters: number;
    excludePatterns: string[];
  };
  security: { scanSecrets: boolean; blockOnSecret: boolean; allowOutsideWorkspace: boolean };
  injection: { maxCharacters: number; includeObjective: boolean; includeArtefactPaths: boolean };
  submission: { showPreview: boolean; requireConfirmation: boolean };
  /** Local policy for multi-request workflows and synthesis (not OpenRouter limits). */
  workflows: {
    maxRequestsPerBatch: number;
    maxCharactersPerItem: number;
    maxTotalCharacters: number;
    maxSynthesisCharacters: number;
    /** Dataset workflows: most rows one run may select (each selected row is one request). */
    maxRowsPerRun: number;
    /** Dataset workflows: largest dataset file read. */
    maxDatasetBytes: number;
  };
  /** Batch chat: persistent named threads. */
  chat: { autoCompact: boolean; autoCompactTokens: number; keepRecentExchanges: number; retitleAtTurn: number; systemPrompt: string };
  /** Per-project privacy level and the account-level attestations behind it. */
  privacy: { level: PrivacyLevel; accountNoTraining: boolean; deleteRemoteBatches: boolean; noticeShown: boolean };
}

export const DEFAULT_CONFIG: BatchConfig = {
  schemaVersion: 1,
  defaultModel: "anthropic/claude-opus-5.5",
  defaultAccount: "openrouter",
  endpoint: "/v1/chat/completions",
  storagePath: ".pi/batches",
  notifyOnComplete: true,
  request: { maxTokens: 16000 },
  polling: { enabled: true, intervalSeconds: 60, maxBackoffSeconds: 900, requestTimeoutSeconds: 60 },
  context: {
    respectGitignore: true,
    batchIgnoreFile: ".pi/batchignore",
    maxFileBytes: 1_000_000,
    maxContextCharacters: 1_000_000,
    // Generated/vendored trees, plus prior batch artefacts (raw provider output).
    // Setting this key replaces the whole list. Hard-deny rules are separate and not configurable.
    excludePatterns: ["node_modules/", ".venv/", "venv/", "dist/", "build/", "__pycache__/", ".pi/batches/"],
  },
  security: { scanSecrets: true, blockOnSecret: true, allowOutsideWorkspace: false },
  injection: { maxCharacters: 30000, includeObjective: true, includeArtefactPaths: true },
  submission: { showPreview: true, requireConfirmation: false },
  workflows: {
    maxRequestsPerBatch: 100,
    maxCharactersPerItem: 500_000,
    maxTotalCharacters: 5_000_000,
    maxSynthesisCharacters: 1_000_000,
    maxRowsPerRun: 1_000,
    maxDatasetBytes: 20_000_000,
  },
  chat: {
    autoCompact: true,
    autoCompactTokens: 60000,
    keepRecentExchanges: 4,
    retitleAtTurn: 3,
    systemPrompt:
      "You are a helpful, knowledgeable assistant in an ongoing conversation. Answer clearly and directly. Use Markdown where it helps.",
  },
  privacy: { level: "standard", accountNoTraining: false, deleteRemoteBatches: true, noticeShown: false },
};

export const GLOBAL_CONFIG_DIR = path.join(os.homedir(), ".pi", "agent", "pi-batch-openrouter");
export const GLOBAL_CONFIG_FILE = path.join(GLOBAL_CONFIG_DIR, "config.json");

export function legacyProjectConfigPath(cwd: string): string {
  return path.join(cwd, ".pi", "pi-batch-openrouter.json");
}

export function projectConfigPath(cwd: string): string {
  return path.join(cwd, ".pi", "batch.config.json");
}

export interface LoadedConfig {
  config: BatchConfig;
  /** Human-readable problems; invalid values fall back to defaults and are reported here. */
  errors: string[];
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Maps pre-Release-1 flat keys onto the current schema. */
function migrateLegacyKeys(layer: Json): Json {
  const out: Json = { ...layer };
  if (typeof layer.defaultProvider === "string" && out.defaultAccount === undefined) {
    out.defaultAccount = layer.defaultProvider;
  }
  if (typeof layer.pollIntervalMs === "number") {
    const polling = isObject(out.polling) ? { ...out.polling } : {};
    if (polling.intervalSeconds === undefined) polling.intervalSeconds = Math.round(layer.pollIntervalMs / 1000);
    out.polling = polling;
  }
  // `outputBaseDir` (docs/batches) and `autoSaveResults` are retired: results are always
  // persisted under storagePath. They are ignored rather than rejected.
  delete out.defaultProvider;
  delete out.pollIntervalMs;
  delete out.outputBaseDir;
  delete out.autoSaveResults;
  return out;
}

function deepMerge(base: Json, over: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObject(v) && isObject(base[k]) ? deepMerge(base[k] as Json, v) : v;
  }
  return out;
}

function readLayer(file: string, errors: string[]): Json {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isObject(parsed)) {
      errors.push(`${file}: expected a JSON object; layer ignored`);
      return {};
    }
    return migrateLegacyKeys(parsed);
  } catch (err) {
    errors.push(`${file}: invalid JSON (${(err as Error).message}); layer ignored`);
    return {};
  }
}

type Check = (v: unknown) => boolean;
const str: Check = (v) => typeof v === "string" && v.trim().length > 0;
const bool: Check = (v) => typeof v === "boolean";
const posInt = (max = Number.MAX_SAFE_INTEGER): Check => (v) =>
  typeof v === "number" && Number.isInteger(v) && v > 0 && v <= max;
const strArray: Check = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

const SCHEMA: Record<string, Check | Record<string, Check>> = {
  schemaVersion: (v) => v === 1,
  defaultModel: str,
  defaultAccount: str,
  endpoint: (v) => v === "/v1/chat/completions",
  storagePath: str,
  notifyOnComplete: bool,
  request: { maxTokens: posInt(1_000_000) },
  polling: {
    enabled: bool,
    intervalSeconds: (v) => posInt(86_400)(v) && (v as number) >= 10,
    maxBackoffSeconds: posInt(86_400),
    requestTimeoutSeconds: posInt(600),
  },
  context: {
    respectGitignore: bool,
    batchIgnoreFile: str,
    maxFileBytes: posInt(),
    maxContextCharacters: posInt(),
    excludePatterns: strArray,
  },
  security: { scanSecrets: bool, blockOnSecret: bool, allowOutsideWorkspace: bool },
  injection: { maxCharacters: posInt(), includeObjective: bool, includeArtefactPaths: bool },
  submission: { showPreview: bool, requireConfirmation: bool },
  workflows: {
    maxRequestsPerBatch: posInt(10_000),
    maxCharactersPerItem: posInt(),
    maxTotalCharacters: posInt(),
    maxSynthesisCharacters: posInt(),
    maxRowsPerRun: posInt(100_000),
    maxDatasetBytes: posInt(),
  },
  chat: {
    autoCompact: bool,
    autoCompactTokens: posInt(),
    keepRecentExchanges: posInt(100),
    retitleAtTurn: posInt(1000),
    systemPrompt: str,
  },
  privacy: { level: isPrivacyLevel, accountNoTraining: bool, deleteRemoteBatches: bool, noticeShown: bool },
};

/** Validates field-by-field; invalid fields revert to defaults and are reported. Unknown keys are reported. */
export function validateConfig(candidate: Json): LoadedConfig {
  const errors: string[] = [];
  const result = structuredClone(DEFAULT_CONFIG) as unknown as Json;
  for (const key of Object.keys(candidate)) {
    if (!(key in SCHEMA)) errors.push(`unknown config key "${key}" ignored`);
  }
  for (const [key, check] of Object.entries(SCHEMA)) {
    const value = candidate[key];
    if (value === undefined) continue;
    if (typeof check === "function") {
      if (check(value)) result[key] = value;
      else errors.push(`invalid value for "${key}"; using default`);
      continue;
    }
    if (!isObject(value)) {
      errors.push(`"${key}" must be an object; using defaults`);
      continue;
    }
    const section = result[key] as Json;
    for (const sub of Object.keys(value)) {
      if (!(sub in check)) errors.push(`unknown config key "${key}.${sub}" ignored`);
    }
    for (const [sub, subCheck] of Object.entries(check)) {
      if (value[sub] === undefined) continue;
      if (subCheck(value[sub])) section[sub] = value[sub];
      else errors.push(`invalid value for "${key}.${sub}"; using default`);
    }
  }
  return { config: result as unknown as BatchConfig, errors };
}

export function loadConfig(cwd?: string, globalFile = GLOBAL_CONFIG_FILE): LoadedConfig {
  const errors: string[] = [];
  let merged: Json = {};
  merged = deepMerge(merged, readLayer(globalFile, errors));
  if (cwd) {
    merged = deepMerge(merged, readLayer(legacyProjectConfigPath(cwd), errors));
    merged = deepMerge(merged, readLayer(projectConfigPath(cwd), errors));
  }
  const validated = validateConfig(merged);
  return { config: validated.config, errors: [...errors, ...validated.errors] };
}

/**
 * Persist a partial update into one layer (global or project), preserving any
 * other keys already in that file. Top-level scalar settings are written, and `privacy` fields are merged into the existing section.
 */
export function saveConfigUpdate(
  update: Partial<Pick<BatchConfig, "defaultModel" | "defaultAccount">> & { privacy?: Partial<BatchConfig["privacy"]> },
  target: { cwd?: string; global: boolean },
  globalFile = GLOBAL_CONFIG_FILE,
): string {
  const file = target.global || !target.cwd ? globalFile : projectConfigPath(target.cwd);
  let existing: Json = {};
  if (fs.existsSync(file)) {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (isObject(parsed)) existing = parsed;
  }
  const next: Json = { ...existing, ...update };
  if (update.privacy) next.privacy = { ...(isObject(existing.privacy) ? existing.privacy : {}), ...update.privacy };
  if (update.defaultAccount !== undefined) delete next.defaultProvider; // legacy alias
  if (next.schemaVersion === undefined && !target.global) next.schemaVersion = 1;
  atomicWriteJson(file, next);
  return file;
}
