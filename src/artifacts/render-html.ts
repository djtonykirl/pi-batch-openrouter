import { Marked, type Tokens } from "marked";

/**
 * Markdown -> self-contained HTML, treating the Markdown as untrusted text.
 *
 *   - Raw HTML in the Markdown (block or inline) is ESCAPED and shown as text,
 *     never passed through: no <script>, event handlers, <iframe>, <style>, forms.
 *   - Images are not loaded: each becomes its alt text, "[image: …]".
 *   - Links keep only http(s), mailto, in-page (#) and relative targets;
 *     anything else (javascript:, data:, vbscript:, file:, …) becomes plain text.
 *   - The document carries a Content-Security-Policy that blocks scripts and every
 *     external resource, as a second layer if a viewer ignores the rules above.
 *   - Styles are inline and fixed; no fonts, scripts or stylesheets are fetched.
 * Output is deterministic for a given input.
 */

export const HTML_RENDERER = { name: "markdown-to-html", library: "marked", version: "18.0.11" } as const;

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'";

const STYLE = [
  "body{font-family:Segoe UI,Helvetica,Arial,sans-serif;line-height:1.5;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1b1b1b}",
  "h1,h2,h3{line-height:1.25}h1{border-bottom:1px solid #ddd;padding-bottom:.3rem}",
  "code,pre{font-family:Consolas,Menlo,monospace;background:#f4f4f4}pre{padding:.75rem;overflow:auto}code{padding:0 .2rem}",
  "blockquote{border-left:4px solid #ccc;margin-left:0;padding-left:1rem;color:#444}",
  "table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:.3rem .6rem;text-align:left}",
  ".image-ref{color:#666;font-style:italic}",
].join("");

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** http(s), mailto, #fragment, or relative (no scheme, not protocol-relative). */
export function safeHref(href: string): string | undefined {
  const h = href.trim();
  if (/^(https?:\/\/|mailto:)/i.test(h)) return h;
  if (h.startsWith("//")) return undefined;
  if (h.includes(":")) return undefined;
  return h;
}

function makeMarked(): Marked {
  const m = new Marked({ gfm: true, breaks: false, async: false });
  m.use({
    renderer: {
      html(token: Tokens.HTML | Tokens.Tag): string {
        const text = escapeHtml(token.text);
        return token.type === "html" && (token as Tokens.HTML).block ? `<pre class="raw-html">${text}</pre>\n` : text;
      },
      image(token: Tokens.Image): string {
        return `<span class="image-ref">[image: ${escapeHtml(token.text || "no description")}]</span>`;
      },
      link(token: Tokens.Link): string {
        const inner = this.parser.parseInline(token.tokens);
        const href = safeHref(token.href);
        if (!href) return inner;
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
        return `<a href="${escapeHtml(href)}"${title} rel="noopener noreferrer">${inner}</a>`;
      },
    },
  });
  return m;
}

/** The first level-1 heading's text, if any (used as the document title). */
export function markdownTitle(md: string): string | undefined {
  const m = /^#\s+(.+?)\s*#*\s*$/m.exec(md);
  return m ? m[1]!.trim() : undefined;
}

export function renderHtml(markdown: string, opts: { title: string; generator: string }): string {
  const body = makeMarked().parse(markdown) as string;
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="generator" content="${escapeHtml(opts.generator)}">`,
    `<title>${escapeHtml(opts.title)}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    "<article>",
    body.trimEnd(),
    "</article>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
