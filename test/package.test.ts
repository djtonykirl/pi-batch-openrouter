import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { IgnoreMatcher, hardDenyMatcher } from "../src/context/ignore.js";
import { buildContextPackage, isProbablyBinary, renderContextText, type PackageInput } from "../src/context/package.js";
import { config, rm, tempWorkspace, writeFiles } from "./helpers.js";

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

test("gitignore-syntax matcher: anchoring, dir-only, globstar, negation", () => {
  const m = new IgnoreMatcher(["/root-only.txt", "logs/", "**/tmp/*.log", "*.bak", "!keep.bak", "docs/**/draft-*"], false);
  assert.ok(m.match("root-only.txt"));
  assert.equal(m.match("sub/root-only.txt"), null);
  assert.ok(m.match("logs/a.txt"));
  assert.ok(m.match("deep/logs/a.txt"));
  assert.equal(m.match("logs"), null); // dir-only rule does not match a file named "logs"
  assert.ok(m.match("a/b/tmp/x.log"));
  assert.ok(m.match("x.bak"));
  assert.equal(m.match("keep.bak"), null);
  assert.ok(m.match("docs/a/b/draft-1.md"));
});

test("hard-deny list covers secret material case-insensitively", () => {
  for (const p of [".env", ".ENV.local", "config/.env.production", "certs/server.PEM", "k.key", "x.pfx", "x.p12", "home/id_rsa", "id_ed25519", "credentials.json", "secrets/a.txt", "app/secrets/deep/b.yml", ".git/config"]) {
    assert.ok(hardDenyMatcher.match(p), p);
  }
  for (const p of ["src/env.ts", "keyboard.ts", "docs/secrets.md", "id_rsa.pub.txt.md"]) {
    assert.equal(hardDenyMatcher.match(p), null, p);
  }
});

test("deterministic package format with manifest, files and requirements; CRLF normalised", () => {
  const root = tempWorkspace();
  try {
    writeFiles(root, { "docs/architecture.md": "# Arch\r\nline2\r\n", "src/auth.ts": "export const x = 1;\n" });
    const p = pkg(root, { files: ["docs/architecture.md", "src\\auth.ts"] });
    assert.deepEqual(p.problems, []);
    assert.deepEqual(p.files.map((f) => f.relPath), ["docs/architecture.md", "src/auth.ts"]);
    assert.equal(p.files[0]!.lineEndings, "crlf");
    assert.ok(!p.contextText.includes("\r"));
    assert.equal(
      p.contextText,
      [
        "OBJECTIVE", "=========", "", "Review this", "",
        "CONTEXT MANIFEST", "================", "", "1. docs/architecture.md", "2. src/auth.ts", "",
        "FILE: docs/architecture.md", "==========================", "", "# Arch\nline2", "", "END FILE", "",
        "FILE: src/auth.ts", "=================", "", "export const x = 1;", "", "END FILE", "",
        "RESPONSE REQUIREMENTS", "=====================", "",
        "- Separate evidence from interpretation.",
        "- Identify unsupported assumptions.",
        "- Reference relevant file paths.",
        "- State uncertainty explicitly.",
        "- Do not claim defects are confirmed without direct evidence.",
        "",
      ].join("\n"),
    );
    assert.equal(p.characters, p.contextText.length);
  } finally {
    rm(root);
  }
});

test("--no-instructions omits requirements; json format adds a JSON instruction", () => {
  assert.ok(!renderContextText("o", [], false, "markdown").includes("RESPONSE REQUIREMENTS"));
  assert.match(renderContextText("o", [], true, "json"), /single valid JSON object/);
});

test("precedence: explicit selection cannot bypass hard-deny, batchignore, gitignore or config", () => {
  const root = tempWorkspace();
  try {
    writeFiles(root, {
      ".env": "X=1\n",
      ".pi/batchignore": "private/\n",
      ".gitignore": "*.local.md\n",
      "private/notes.md": "n\n",
      "draft.local.md": "d\n",
      "dist/out.js": "o\n",
      "ok.md": "fine\n",
    });
    const p = pkg(root, { files: [".env", "private/notes.md", "draft.local.md", "dist/out.js", "ok.md"], gitIgnored: () => null });
    assert.deepEqual(p.files.map((f) => f.relPath), ["ok.md"]);
    const byPath = Object.fromEntries(p.problems.map((x) => [x.path, x.message]));
    assert.match(byPath[".env"]!, /hard-deny.*cannot be overridden/);
    assert.match(byPath["private/notes.md"]!, /batchignore/);
    assert.match(byPath["draft.local.md"]!, /gitignore/);
    assert.match(byPath["dist/out.js"]!, /config/);
    assert.ok(p.warnings.some((w) => w.includes("root .gitignore only")));
  } finally {
    rm(root);
  }
});

test("hard-deny wins even when batchignore re-includes with negation", () => {
  const root = tempWorkspace();
  try {
    writeFiles(root, { ".env": "X=1\n", ".pi/batchignore": "!.env\n" });
    const p = pkg(root, { files: [".env"] });
    assert.equal(p.problems[0]?.kind, "excluded");
    assert.match(p.problems[0]!.message, /hard-deny/);
  } finally {
    rm(root);
  }
});

test("directory expansion skips excluded/binary files and lists every skip", () => {
  const root = tempWorkspace();
  try {
    writeFiles(root, {
      "src/a.ts": "a\n",
      "src/b.ts": "b\n",
      "src/.env": "S=1\n",
      "src/img.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]),
      "src/node_modules/dep/index.js": "x\n",
    });
    const p = pkg(root, { contexts: ["src"] });
    assert.deepEqual(p.problems, []);
    assert.deepEqual(p.files.map((f) => f.relPath), ["src/a.ts", "src/b.ts"]);
    const ex = p.excluded.map((e) => `${e.relPath}|${e.layer}`).sort();
    assert.deepEqual(ex, ["src/.env|hard-deny", "src/img.png|binary", "src/node_modules/|config"]);
  } finally {
    rm(root);
  }
});

test("explicit binary, missing, directory-as-file and oversize files block", () => {
  const root = tempWorkspace();
  try {
    writeFiles(root, { "bin.dat": Buffer.from([1, 0, 2]), "big.txt": "x".repeat(50), "dir/x.ts": "x" });
    const cfg = config();
    cfg.context.maxFileBytes = 10;
    const p = pkg(root, { files: ["bin.dat", "nope.ts", "dir", "big.txt"], config: cfg });
    assert.deepEqual(p.problems.map((x) => x.kind).sort(), ["binary", "not_a_file", "not_found", "too_large"]);
    assert.equal(p.files.length, 0);
  } finally {
    rm(root);
  }
});

test("outside-workspace paths are rejected by default (relative escape and absolute)", () => {
  const root = tempWorkspace();
  const outside = tempWorkspace("pi batch outside-");
  try {
    writeFiles(outside, { "secret.txt": "nope\n" });
    const rel = path.relative(root, path.join(outside, "secret.txt"));
    const p = pkg(root, { files: [rel, path.join(outside, "secret.txt")] });
    assert.deepEqual(p.problems.map((x) => x.kind), ["outside_workspace", "outside_workspace"]);
    assert.equal(p.files.length, 0);
  } finally {
    rm(root);
    rm(outside);
  }
});

test("symlink inside the workspace pointing outside is rejected", (t) => {
  const root = tempWorkspace();
  const outside = tempWorkspace("pi batch outside-");
  try {
    writeFiles(outside, { "target.txt": "outside\n" });
    try {
      fs.symlinkSync(path.join(outside, "target.txt"), path.join(root, "link.txt"), "file");
    } catch (err) {
      t.skip(`cannot create symlinks here (${(err as NodeJS.ErrnoException).code}); Windows needs Developer Mode or admin`);
      return;
    }
    const p = pkg(root, { files: ["link.txt"] });
    assert.equal(p.problems[0]?.kind, "outside_workspace");
  } finally {
    rm(root);
    rm(outside);
  }
});

test("secrets in files and in the objective are found with locations", () => {
  const root = tempWorkspace();
  try {
    writeFiles(root, { "cfg.json": `{\n  "client_secret": "${"Zx9" + "-cl13nt-s3cr3t-value"}"\n}\n` });
    const key = "plain-" + "configured-key-0001";
    const p = pkg(root, { files: ["cfg.json"], objective: `use ${key}`, knownSecrets: [key] });
    assert.deepEqual(
      p.secretFindings.map((f) => [f.source, f.line, f.type]),
      [
        ["<objective>", 1, "configured API key value"],
        ["cfg.json", 2, "client secret assignment"],
      ],
    );
  } finally {
    rm(root);
  }
});

test("context character limit blocks", () => {
  const root = tempWorkspace();
  try {
    writeFiles(root, { "a.md": "x".repeat(500) });
    const cfg = config();
    cfg.context.maxContextCharacters = 100;
    assert.equal(pkg(root, { files: ["a.md"], config: cfg }).problems[0]?.kind, "context_too_large");
  } finally {
    rm(root);
  }
});

test("real git check-ignore is honoured when git is available", (t) => {
  const root = tempWorkspace();
  try {
    try {
      execFileSync("git", ["init", "-q", root], { stdio: "ignore" });
    } catch {
      t.skip("git not available");
      return;
    }
    writeFiles(root, { ".gitignore": "ignored/\n", "ignored/x.md": "x\n", "kept.md": "k\n" });
    const p = buildContextPackage({
      workspaceRoot: root, objective: "o", files: [], contexts: ["."], includeInstructions: false, format: "markdown",
      config: config(), knownSecrets: [],
    });
    assert.deepEqual(p.files.map((f) => f.relPath), [".gitignore", "kept.md"]);
    assert.ok(p.excluded.some((e) => e.relPath === "ignored/x.md" && e.layer === "gitignore"));
  } finally {
    rm(root);
  }
});

test("binary detection: NUL bytes and invalid UTF-8", () => {
  assert.equal(isProbablyBinary(Buffer.from("plain text ✓")), false);
  assert.equal(isProbablyBinary(Buffer.from([0x41, 0x00, 0x42])), true);
  assert.equal(isProbablyBinary(Buffer.from([0xff, 0xfe, 0x41])), true);
});
