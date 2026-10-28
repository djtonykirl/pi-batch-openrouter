import assert from "node:assert/strict";
import test from "node:test";
import { prepareAttachments } from "../src/attachments.js";
import { MAX_NOTEBOOK_RAW_BYTES, cleanNotebook } from "../src/context/notebook.js";
import { buildContextPackage, type PackageInput } from "../src/context/package.js";
import { config, rm, tempWorkspace, writeFiles } from "./helpers.js";

const AWS = "AKIAABCDEFGHIJKLMNOP";

function fixture(extraPng = ""): string {
  return JSON.stringify({
    metadata: { kernelspec: { name: "python3" } },
    cells: [
      { cell_type: "markdown", metadata: {}, source: ["# Title\n", "\n", "text"] },
      {
        cell_type: "code",
        execution_count: 3,
        metadata: {},
        source: "x = 1",
        outputs: [
          { output_type: "display_data", data: { "image/png": "iVBORw0KGgo" + extraPng } },
          { output_type: "stream", name: "stdout", text: [`key ${AWS}\n`] },
        ],
      },
      { cell_type: "raw", metadata: {}, source: "raw stuff" },
    ],
  });
}

const noGit = () => new Set<string>();
function pkg(root: string, over: Partial<PackageInput> = {}) {
  return buildContextPackage({
    workspaceRoot: root,
    objective: "Review this",
    files: [],
    contexts: [],
    includeInstructions: true,
    format: "markdown",
    config: config(),
    knownSecrets: [],
    gitIgnored: noGit,
    ...over,
  });
}

test("cleanNotebook keeps only markdown and code sources in Databricks text format", () => {
  const r = cleanNotebook(fixture());
  assert.ok(r.ok);
  assert.equal(r.text, "# Databricks notebook source\n# MAGIC %md\n# MAGIC # Title\n# MAGIC\n# MAGIC text\n\n# COMMAND ----------\n\nx = 1");
  assert.equal(r.cells, 2);
  assert.equal(r.droppedOutputs, 2);
});

test("cleanNotebook rejects unparseable notebooks", () => {
  assert.equal(cleanNotebook("{not json").ok, false);
  assert.equal(cleanNotebook('{"cells": 5}').ok, false);
  assert.equal(MAX_NOTEBOOK_RAW_BYTES, 32 * 1024 * 1024);
});

test("explicit 2 MB notebook is cleaned, accepted under maxFileBytes, and its outputs are never sent", () => {
  const root = tempWorkspace();
  try {
    writeFiles(root, { "n.ipynb": fixture("A".repeat(2 * 1024 * 1024)) });
    const p = pkg(root, { files: ["n.ipynb"], config: config({ context: { ...config().context, maxFileBytes: 1_000_000 } }) });
    assert.deepEqual(p.problems, []);
    assert.equal(p.files.length, 1);
    const f = p.files[0]!;
    assert.equal(f.transform, "ipynb-cleaned");
    assert.ok(f.bytes > 2 * 1024 * 1024);
    assert.ok(f.characters < 1024);
    assert.ok(!f.content.includes("AKIA") && !f.content.includes("base64") && !f.content.includes("iVBOR"));
    assert.deepEqual(p.secretFindings, []);
    assert.ok(p.warnings.some((w) => /n\.ipynb.*notebook outputs stripped/.test(w)));
  } finally {
    rm(root);
  }
});

test("an explicit invalid notebook blocks and its raw text is never packaged", () => {
  const root = tempWorkspace();
  try {
    writeFiles(root, { "bad.IPYNB": `{broken ${AWS}` });
    const p = pkg(root, { files: ["bad.IPYNB"] });
    assert.ok(p.problems.some((x) => x.kind === "invalid_notebook"));
    assert.equal(p.files.length, 0);
    assert.ok(!p.contextText.includes(AWS));
    assert.deepEqual(p.secretFindings, []);
  } finally {
    rm(root);
  }
});

test("a context-expanded invalid notebook is excluded with the invalid-notebook layer", () => {
  const root = tempWorkspace();
  try {
    writeFiles(root, { "d/bad.ipynb": "{nope", "d/ok.md": "hello" });
    const p = pkg(root, { contexts: ["d"] });
    assert.deepEqual(p.problems, []);
    assert.ok(p.excluded.some((e) => e.relPath === "d/bad.ipynb" && e.layer === "invalid-notebook"));
    assert.deepEqual(p.files.map((f) => f.relPath), ["d/ok.md"]);
  } finally {
    rm(root);
  }
});

test("an upload named N.IPYNB is cleaned before the secret scan", async () => {
  const root = tempWorkspace();
  try {
    const r = await prepareAttachments({
      workspaceRoot: root,
      config: config(),
      knownSecrets: [],
      input: { uploads: [{ name: "N.IPYNB", contentBase64: Buffer.from(fixture()).toString("base64") }] },
    });
    assert.deepEqual(r.blockers, []);
    assert.deepEqual(r.secretFindings, []);
    assert.ok(r.inlinedText.includes("x = 1"));
    assert.ok(!r.inlinedText.includes("AKIA") && !r.inlinedText.includes("iVBOR"));
    const bad = await prepareAttachments({
      workspaceRoot: root,
      config: config(),
      knownSecrets: [],
      input: { uploads: [{ name: "b.ipynb", text: "{x " + AWS }] },
    });
    assert.ok(bad.blockers.some((b) => /b\.ipynb/.test(b)));
    assert.ok(!bad.inlinedText.includes(AWS));
  } finally {
    rm(root);
  }
});
