/**
 * Argument parsing for `/batch` subcommands. Pi passes the raw text after the
 * command name; there is no Pi-provided flag parser for commands.
 *
 * Quoting: "double" or 'single' quotes group words. Backslash is NOT an escape
 * character, so Windows paths (`src\auth.ts`, `"C:\My Repo\x.ts"`) survive.
 * `--` ends flag parsing; everything after it is positional.
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) tokens.push(current);
      current = "";
      inToken = false;
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (inToken) tokens.push(current);
  return tokens;
}

export interface FlagSpec {
  /** Flags taking a value; repeatable ones collect into arrays. */
  values?: readonly string[];
  repeatable?: readonly string[];
  booleans?: readonly string[];
}

export interface ParsedArgs {
  values: Record<string, string>;
  lists: Record<string, string[]>;
  booleans: Set<string>;
  positionals: string[];
  errors: string[];
}

export function parseArgs(tokens: readonly string[], spec: FlagSpec): ParsedArgs {
  const out: ParsedArgs = { values: {}, lists: {}, booleans: new Set(), positionals: [], errors: [] };
  const values = new Set(spec.values ?? []);
  const repeatable = new Set(spec.repeatable ?? []);
  const booleans = new Set(spec.booleans ?? []);
  let flagsDone = false;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (flagsDone || !tok.startsWith("--") || tok === "--") {
      if (tok === "--" && !flagsDone) {
        flagsDone = true;
        continue;
      }
      out.positionals.push(tok);
      continue;
    }
    const eq = tok.indexOf("=");
    const name = (eq === -1 ? tok.slice(2) : tok.slice(2, eq)).toLowerCase();
    const inline = eq === -1 ? undefined : tok.slice(eq + 1);
    if (booleans.has(name)) {
      if (inline !== undefined) out.errors.push(`--${name} does not take a value`);
      out.booleans.add(name);
    } else if (values.has(name) || repeatable.has(name)) {
      const value = inline ?? tokens[++i];
      if (value === undefined || (inline === undefined && value.startsWith("--"))) {
        out.errors.push(`--${name} requires a value`);
        if (value !== undefined) i--;
        continue;
      }
      if (repeatable.has(name)) (out.lists[name] ??= []).push(value);
      else if (out.values[name] !== undefined) out.errors.push(`--${name} given more than once`);
      else out.values[name] = value;
    } else {
      out.errors.push(`unknown option --${name} (quote the objective, or put it after --)`);
    }
  }
  return out;
}
