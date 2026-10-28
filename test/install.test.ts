import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Package name of a bare specifier ("pdf-lib", "@scope/pkg/sub" -> "@scope/pkg"), or undefined for node:/relative. */
function packageOf(spec: string): string | undefined {
  if (spec.startsWith(".") || spec.startsWith("node:")) return undefined;
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

test("U-C1: every runtime import resolves to a dependency or peer dependency, not a devDependency", () => {
  const runtime = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
  const missing: string[] = [];
  for (const file of [join(root, "index.ts"), ...sourceFiles(join(root, "src"))]) {
    const text = readFileSync(file, "utf8");
    // Value imports only: `import type` and `import { type X }`-only lines are erased at runtime.
    const specs = [
      ...[...text.matchAll(/^import\s+(?!type\s)[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]!),
      ...[...text.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]!),
    ];
    for (const spec of specs) {
      const name = packageOf(spec);
      if (name && !runtime.has(name)) missing.push(`${file.slice(root.length + 1)}: ${name}`);
    }
  }
  assert.deepEqual(missing, []);
  assert.equal(pkg.dependencies?.["pdf-lib"], "1.17.1");
  assert.equal(pkg.devDependencies?.["pdf-lib"], undefined);
});

test("U-C1: pdf-lib is loaded lazily, so a missing package degrades only PDF handling", () => {
  const text = readFileSync(join(root, "src", "attachments.ts"), "utf8");
  assert.doesNotMatch(text, /^import[^;]*from\s+"pdf-lib"/m);
  // Loaded on first use, inside the PDF worker (U-I3).
  assert.ok(text.includes("require(workerData.pdfLibPath)"));
  assert.ok(text.includes('resolve("pdf-lib")'));
});
