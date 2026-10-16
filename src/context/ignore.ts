/**
 * Gitignore-syntax matcher used for hard-deny rules, `.pi/batchignore`,
 * configured exclusions, and the `.gitignore` fallback when `git` is unavailable.
 *
 * Supported: comments, blank lines, `!` negation (last match wins), leading `/`
 * anchoring, trailing `/` (directory-only), `*`, `?`, `**`, `[...]` classes.
 * A pattern matching a directory excludes everything beneath it.
 * Paths are workspace-relative with forward slashes.
 */

interface Rule {
  pattern: string;
  negate: boolean;
  dirOnly: boolean;
  regex: RegExp;
}

export interface IgnoreMatch {
  pattern: string;
}

function globToRegexSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const atSegmentStart = i === 0 || glob[i - 1] === "/";
        const nextIsSlash = glob[i + 2] === "/";
        if (atSegmentStart && nextIsSlash) {
          out += "(?:.*/)?"; // "**/" -> zero or more directories
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close === -1) {
        out += "\\[";
      } else {
        let cls = glob.slice(i + 1, close);
        if (cls.startsWith("!")) cls = "^" + cls.slice(1);
        out += `[${cls.replace(/\\/g, "\\\\")}]`;
        i = close;
      }
    } else if ("\\^$.|+(){}".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return out;
}

function compile(line: string, caseInsensitive: boolean): Rule | null {
  let pattern = line.replace(/\r$/, "");
  if (!pattern.trim() || pattern.startsWith("#")) return null;
  pattern = pattern.replace(/(?<!\\)\s+$/, "");
  let negate = false;
  if (pattern.startsWith("!")) {
    negate = true;
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith("\\#") || pattern.startsWith("\\!")) pattern = pattern.slice(1);
  let dirOnly = false;
  if (pattern.endsWith("/")) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }
  if (!pattern) return null;
  const anchored = pattern.includes("/");
  const body = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  const source = (anchored ? "^" : "^(?:.*/)?") + globToRegexSource(body) + "$";
  return { pattern: line.trim(), negate, dirOnly, regex: new RegExp(source, caseInsensitive ? "i" : "") };
}

export class IgnoreMatcher {
  private readonly rules: Rule[];

  constructor(patterns: readonly string[], caseInsensitive = process.platform === "win32") {
    this.rules = patterns.map((p) => compile(p, caseInsensitive)).filter((r): r is Rule => r !== null);
  }

  public static fromText(text: string, caseInsensitive?: boolean): IgnoreMatcher {
    return new IgnoreMatcher(text.split("\n"), caseInsensitive);
  }

  public get size(): number {
    return this.rules.length;
  }

  /**
   * Returns the deciding rule if `relPath` is excluded (by itself or via an
   * excluded ancestor directory), else null.
   */
  public match(relPath: string, isDirectory = false): IgnoreMatch | null {
    const clean = relPath.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
    const segments = clean.split("/");
    // Ancestors first: an excluded parent directory excludes the whole subtree.
    for (let depth = 1; depth < segments.length; depth++) {
      const verdict = this.evaluate(segments.slice(0, depth).join("/"), true);
      if (verdict) return verdict;
    }
    return this.evaluate(clean, isDirectory);
  }

  private evaluate(candidate: string, isDirectory: boolean): IgnoreMatch | null {
    let decided: Rule | null = null;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDirectory) continue;
      if (rule.regex.test(candidate)) decided = rule;
    }
    return decided && !decided.negate ? { pattern: decided.pattern } : null;
  }
}

/**
 * Never submitted, even when explicitly selected. Matched case-insensitively
 * on every platform. Not configurable.
 */
export const HARD_DENY_PATTERNS: readonly string[] = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.pfx",
  "*.p12",
  "*.jks",
  "*.keystore",
  "*.kdbx",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials.json",
  "credentials",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".pgpass",
  ".git-credentials",
  "secrets/",
  ".ssh/",
  ".aws/",
  ".azure/",
  ".gnupg/",
  ".git/",
];

export const hardDenyMatcher = new IgnoreMatcher(HARD_DENY_PATTERNS, true);
