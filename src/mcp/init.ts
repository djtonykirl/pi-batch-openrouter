import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type InitClient = "vscode" | "claude" | "antigravity" | "all";

export interface InitOptions {
  workspaceRoot: string;
  client?: InitClient;
  overwrite?: boolean;
}

export interface InitResult {
  written: string[];
  /** Files left as they were because they already exist (includes every `outdated` file). */
  skipped: string[];
  /** Skipped files whose content differs from the packaged version: an older install, or one edited locally. */
  outdated: string[];
}

function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Works from both `src/mcp/init.ts` (2 levels up) and `dist/src/mcp/init.js` or `.test-build/src/mcp/init.js` (3 levels up).
  for (const rel of ["../..", "../../.."]) {
    const candidate = path.resolve(here, rel);
    if (fs.existsSync(path.join(candidate, "integrations", "vscode", "pi-batch.instructions.md"))) {
      return candidate;
    }
  }
  throw new Error("Could not locate packaged integrations/ directory.");
}

function copyTemplate(pkgRoot: string, templateRel: string, destAbs: string, workspaceRoot: string, overwrite: boolean, result: InitResult): void {
  const relOut = path.relative(workspaceRoot, destAbs).replace(/\\/g, "/");
  const srcAbs = path.join(pkgRoot, templateRel);
  if (fs.existsSync(destAbs) && !overwrite) {
    result.skipped.push(relOut);
    // Line endings are ignored: a checkout may have converted them.
    const norm = (file: string) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    try {
      if (norm(destAbs) !== norm(srcAbs)) result.outdated.push(relOut);
    } catch {
      // unreadable: reported as skipped only
    }
    return;
  }
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(srcAbs, destAbs);
  result.written.push(relOut);
}

/**
 * Copies the packaged natural-language agent instructions (and Antigravity plugin bundle) into a workspace so
 * VS Code Copilot, Claude Code, and Google Antigravity know when and how to use `pi-batch` conversationally.
 */
export function initAgentInstructions(opts: InitOptions): InitResult {
  const root = path.resolve(opts.workspaceRoot);
  const client = opts.client ?? "all";
  const overwrite = Boolean(opts.overwrite);
  const pkgRoot = packageRoot();
  const result: InitResult = { written: [], skipped: [], outdated: [] };

  if (client === "vscode" || client === "all") {
    copyTemplate(
      pkgRoot,
      "integrations/vscode/pi-batch.instructions.md",
      path.join(root, ".github", "instructions", "pi-batch.instructions.md"),
      root,
      overwrite,
      result,
    );
    copyTemplate(
      pkgRoot,
      "integrations/vscode/skills/pi-batch/SKILL.md",
      path.join(root, ".github", "skills", "pi-batch", "SKILL.md"),
      root,
      overwrite,
      result,
    );
    copyTemplate(
      pkgRoot,
      "integrations/vscode/prompts/batch.prompt.md",
      path.join(root, ".github", "prompts", "batch.prompt.md"),
      root,
      overwrite,
      result,
    );
  }

  if (client === "claude" || client === "all") {
    copyTemplate(
      pkgRoot,
      "integrations/claude/SKILL.md",
      path.join(root, ".claude", "skills", "pi-batch", "SKILL.md"),
      root,
      overwrite,
      result,
    );
  }

  if (client === "antigravity" || client === "all") {
    for (const rel of ["plugin.json", "mcp_config.json", "rules/AGENTS.md", "skills/pi-batch/SKILL.md"]) {
      copyTemplate(
        pkgRoot,
        `integrations/antigravity/pibatch/${rel}`,
        path.join(root, ".agents", "plugins", "pibatch", ...rel.split("/")),
        root,
        overwrite,
        result,
      );
    }
  }

  return result;
}
