/**
 * Read every `className` a TSX source file authors, as class tokens.
 *
 * Source-level on purpose: jsdom never applies Tailwind or the authored
 * stylesheets, so a guard about which classes share an element has to read
 * what the JSX asks for. A className value is taken in all the shapes this
 * dashboard writes it:
 *
 *   className="a b"                      a plain string
 *   className={"a b"} / {'a b'}          a braced string
 *   className={`a ${on ? "b" : ""} c`}   a template literal, including the
 *                                        string literals inside `${…}`
 *   className={cn("a", on && "b")}       any call — every string argument
 *
 * across as many lines as the value spans. What it cannot see — a class
 * assembled from a variable declared elsewhere — is a documented blind spot,
 * not a promise: the guards built on this pin the call sites that exist.
 */

export interface ClassNameSite {
  /** 1-based line of the `className=` attribute. */
  line: number;
  /** Every whitespace-separated token the value can produce. */
  tokens: string[];
}

/** Index just past the string literal that opens at `i` (quote char at i). */
function skipQuoted(src: string, i: number): number {
  const q = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== q) {
    if (src[j] === "\\") j++;
    j++;
  }
  return j + 1;
}

/**
 * Every string-literal piece inside a JS expression: quoted strings, the
 * static text of template literals, and — recursively — the strings inside
 * each `${…}`.
 */
function collectStrings(expr: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === '"' || ch === "'") {
      const end = skipQuoted(expr, i);
      out.push(expr.slice(i + 1, end - 1));
      i = end;
    } else if (ch === "`") {
      let text = "";
      let j = i + 1;
      while (j < expr.length && expr[j] !== "`") {
        if (expr[j] === "\\") {
          text += expr[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (expr[j] === "$" && expr[j + 1] === "{") {
          out.push(text);
          text = " ";
          const close = matchBrace(expr, j + 1);
          out.push(...collectStrings(expr.slice(j + 2, close)));
          j = close + 1;
          continue;
        }
        text += expr[j];
        j++;
      }
      out.push(text);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out;
}

/** Index of the `}` that closes the `{` at `open`, skipping strings. */
function matchBrace(src: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      i = skipQuoted(src, i);
      continue;
    }
    if (ch === "`") {
      // Template literal: skip it whole, nested `${}` included.
      let j = i + 1;
      while (j < src.length && src[j] !== "`") {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === "$" && src[j + 1] === "{") {
          j = matchBrace(src, j + 1) + 1;
          continue;
        }
        j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return src.length - 1;
}

export function classNameSites(src: string): ClassNameSite[] {
  const sites: ClassNameSite[] = [];
  const re = /\bclassName\s*=\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const at = m.index + m[0].length;
    const ch = src[at];
    let pieces: string[] = [];
    if (ch === '"' || ch === "'") {
      const end = skipQuoted(src, at);
      pieces = [src.slice(at + 1, end - 1)];
    } else if (ch === "{") {
      const close = matchBrace(src, at);
      pieces = collectStrings(src.slice(at + 1, close));
    } else {
      continue;
    }
    const line = src.slice(0, m.index).split("\n").length;
    const tokens = pieces.join(" ").split(/\s+/).filter(Boolean);
    sites.push({ line, tokens });
  }
  return sites;
}

/** A Tailwind utility that sets `display`, under any variant prefix. */
export const TAILWIND_DISPLAY_RE =
  /^(?:[^:\s]+:)*!?(?:hidden|block|inline-block|inline|flex|inline-flex|grid|inline-grid|contents|flow-root|list-item|table|inline-table|table-[a-z-]+)$/;
