/**
 * WARP-293 — guard against Frigate branding leaking into the cameras
 * surface.
 *
 * CLAUDE.md and the 2026-05-08 UX audit
 * (`docs/superpowers/audits/2026-05-08-web-dashboard-ux-audit.md` §5.3)
 * require Frigate to be transparent to users. Home users don't edit
 * YAML and don't know what Frigate is — every user-facing mention is
 * a leak of an implementation detail.
 *
 * This test walks every `.ts`/`.tsx` source file under
 *   - `apps/web-dashboard/src/app/cameras/`
 *   - `apps/web-dashboard/src/components/cameras/`
 * strips comments and import lines (which legitimately reference
 * Frigate type names, API helpers like `restartFrigate`, doc paths,
 * etc.), and fails if any remaining text contains:
 *   - the case-insensitive word `frigate`
 *   - the substring `config.yml`
 *
 * Backend type names, route names, env vars, and API helpers
 * (e.g. `restartFrigate` from `@/lib/api`, identifier strings like
 * `"restart_frigate"` / `"frigate.system"` passed to confirmation
 * tokens) are out of scope for this ticket — they live in import
 * statements or behind opaque helper names and are not user-visible.
 * The comment + import stripping below carves that exception cleanly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC_ROOT = resolve(__dirname, "..");
const SCAN_DIRS: ReadonlyArray<string> = [
  resolve(SRC_ROOT, "app", "cameras"),
  resolve(SRC_ROOT, "components", "cameras"),
];
const INCLUDE_EXTENSIONS = new Set([".ts", ".tsx"]);

function walk(dir: string, files: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, files);
      continue;
    }
    const dot = entry.lastIndexOf(".");
    const ext = dot === -1 ? "" : entry.slice(dot);
    if (!INCLUDE_EXTENSIONS.has(ext)) continue;
    files.push(full);
  }
  return files;
}

/**
 * Strip JS/TS block comments (`/* … *\/`), line comments (`//`), JSX
 * comments (`{/* … *\/}`), and `import …` lines.
 *
 * The pattern is intentionally aggressive — we drop the entire line if
 * it starts with `import ` or `} from ` (multi-line imports) so that
 * legitimate identifier references like `restartFrigate` from
 * `@/lib/api` don't trip the guard. JSX text and string-literal copy
 * destined for the UI is what's left behind.
 */
function stripCommentsAndImports(source: string): string {
  let cleaned = source;

  // Block comments: /* … */ (including JSDoc /** … */) and JSX
  // {/* … */} comments. Non-greedy across newlines.
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, "");

  // Line comments: // … to end of line.
  cleaned = cleaned.replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  // Drop import lines (single- or multi-line). The simplest robust
  // approach: drop every line that contains `import ` or starts with
  // ` from "`/`} from "` (multi-line continuation), or is a bare
  // identifier between an `import {` opener and its `} from` closer.
  const lines = cleaned.split("\n");
  const out: string[] = [];
  let inImport = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (inImport) {
      if (/from\s+["']/.test(trimmed) || trimmed.endsWith(";")) {
        inImport = false;
      }
      continue;
    }
    if (/^import\b/.test(trimmed)) {
      // Single-line import (`import x from "y";`) or start of
      // multi-line (`import {`).
      if (/from\s+["']/.test(trimmed) && trimmed.endsWith(";")) {
        // single-line — drop just this line
      } else {
        inImport = true;
      }
      continue;
    }
    out.push(line);
  }

  return out.join("\n");
}

/**
 * True if the match at `idx` looks like an identifier reference
 * (e.g. `restartFrigate`, `"restart_frigate"`, `"frigate.system"`)
 * rather than a piece of user-facing copy. Identifier references are
 * out-of-scope per the ticket — backend type/route names stay.
 */
function isIdentifierLike(text: string, idx: number, len: number): boolean {
  const before = idx > 0 ? text[idx - 1] : "";
  const after = idx + len < text.length ? text[idx + len] : "";
  // camelCase: preceding char is a lowercase letter or digit
  if (/[a-z0-9]/.test(before)) return true;
  // snake_case or dotted identifier: bordering `_` or `.`
  if (before === "_" || before === "." || after === "_" || after === ".") {
    return true;
  }
  return false;
}

function findUserFacingHits(needle: RegExp, files: string[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    const cleaned = stripCommentsAndImports(raw);
    const lines = cleaned.split("\n");
    for (const line of lines) {
      const lineRe = new RegExp(needle.source, needle.flags);
      let m: RegExpExecArray | null;
      while ((m = lineRe.exec(line)) !== null) {
        if (!isIdentifierLike(line, m.index, m[0].length)) {
          hits.push(`${file}: ${line.trim()}`);
          break; // one hit per line is enough for diagnostics
        }
        if (m.index === lineRe.lastIndex) lineRe.lastIndex++;
      }
    }
  }
  return hits;
}

describe("cameras-branding guard (WARP-293)", () => {
  const files = SCAN_DIRS.flatMap((d) => walk(d));

  it("scan picks up camera surface files", () => {
    // Sanity check — if this fails, the directory layout drifted and
    // the rest of the test is meaningless.
    expect(files.length).toBeGreaterThan(5);
  });

  it("no user-facing `Frigate` string in cameras surface", () => {
    const hits = findUserFacingHits(/frigate/gi, files);
    if (hits.length > 0) {
      throw new Error(
        `Found ${hits.length} user-facing Frigate mention(s) in the cameras surface:\n` +
          hits.map((h) => `  ${h}`).join("\n") +
          `\n\nReplace with neutral copy (e.g. "camera service", "recognition engine"). ` +
          `If the hit is a legitimate identifier in an import or comment, the strip ` +
          `step missed it — extend stripCommentsAndImports() in this test.`,
      );
    }
    expect(hits).toEqual([]);
  });

  it("no user-facing `config.yml` instruction in cameras surface", () => {
    const hits = findUserFacingHits(/config\.yml/g, files);
    if (hits.length > 0) {
      throw new Error(
        `Found ${hits.length} user-facing config.yml mention(s) in the cameras surface:\n` +
          hits.map((h) => `  ${h}`).join("\n") +
          `\n\nHome users don't edit YAML. Replace with a friendly empty-state ` +
          `("Ask your admin to enable …") or link to a settings UI toggle.`,
      );
    }
    expect(hits).toEqual([]);
  });
});
