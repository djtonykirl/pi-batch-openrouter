import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, projectConfigPath, readPrivacyConfig, type BatchConfig } from "../src/config.js";
import { rm, tempWorkspace } from "./helpers.js";

/** A workspace with its own global file, so the per-workspace "last good" memory starts empty in each test. */
function workspace(fn: (w: { root: string; globalFile: string; project: (privacy: unknown) => void; projectRaw: (text: string) => void }) => void): () => void {
  return () => {
    const root = tempWorkspace("pi batch privacy-fallback-");
    try {
      const globalFile = path.join(root, "global-config.json");
      const write = (text: string) => {
        fs.mkdirSync(path.dirname(projectConfigPath(root)), { recursive: true });
        fs.writeFileSync(projectConfigPath(root), text);
      };
      fn({ root, globalFile, project: (privacy) => write(JSON.stringify({ schemaVersion: 1, privacy })), projectRaw: write });
    } finally {
      rm(root);
    }
  };
}

const privacy = (p: Partial<BatchConfig["privacy"]>): BatchConfig["privacy"] => ({ ...DEFAULT_CONFIG.privacy, ...p });

test(
  "a mistyped level never relaxes a level read cleanly before",
  workspace(({ root, globalFile, project }) => {
    project({ level: "zdr" });
    assert.equal(readPrivacyConfig(root, globalFile).level, "zdr");
    project({ level: "ZDR" });
    assert.equal(readPrivacyConfig(root, globalFile).level, "zdr");
  }),
);

test(
  "a broken file at the first read falls back to the process snapshot, never to the default",
  workspace(({ root, globalFile, projectRaw }) => {
    projectRaw('{ "privacy": { "level": "zdr", ');
    assert.equal(readPrivacyConfig(root, globalFile, privacy({ level: "zdr" })).level, "zdr");
  }),
);

test(
  "a mistyped level at the first read falls back to the process snapshot",
  workspace(({ root, globalFile, project }) => {
    project({ level: "Zero-retention" });
    assert.equal(readPrivacyConfig(root, globalFile, privacy({ level: "no-training", accountNoTraining: true })).level, "no-training");
  }),
);

test(
  "with a problem, every field takes its more private value",
  workspace(({ root, globalFile, project }) => {
    project({ level: "standard", accountNoTraining: true, deleteRemoteBatches: false, attestedAt: new Date().toISOString() });
    assert.equal(readPrivacyConfig(root, globalFile).accountNoTraining, true);
    project({ level: "bogus", accountNoTraining: false, deleteRemoteBatches: false });
    const p = readPrivacyConfig(root, globalFile, privacy({ level: "zdr", deleteRemoteBatches: true }));
    assert.equal(p.level, "zdr"); // the process snapshot is stricter than the last clean read
    assert.equal(p.accountNoTraining, false);
    assert.equal(p.attestedAt, undefined);
    assert.equal(p.deleteRemoteBatches, true);
  }),
);

test(
  "a valid change, including lowering the level on purpose, still takes effect",
  workspace(({ root, globalFile, project }) => {
    project({ level: "zdr" });
    assert.equal(readPrivacyConfig(root, globalFile).level, "zdr");
    project({ level: "standard" });
    assert.equal(readPrivacyConfig(root, globalFile, privacy({ level: "zdr" })).level, "standard");
  }),
);
