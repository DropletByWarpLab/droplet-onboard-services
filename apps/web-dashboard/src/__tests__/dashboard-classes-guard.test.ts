/**
 * WARP-288 — guard against silently-dropped Tailwind utility classes.
 *
 * Tailwind drops unknown classes without error. The UX audit
 * (`docs/superpowers/audits/2026-05-08-web-dashboard-ux-audit.md` §2.1)
 * found multiple bad classes used across the dashboard that don't exist
 * in `globals.css` or `tailwind.config.ts`, so those elements rendered
 * with no styling at all.
 *
 * This test scans every source file under `apps/web-dashboard/src/`
 * (excluding `__tests__/`) for any of the known bad class names and
 * fails if any are present. The companion `scripts/check-dashboard-classes.sh`
 * shell guard enforces the same invariant in CI.
 *
 * Keep this list in sync with `scripts/check-dashboard-classes.sh`.
 *
 * SCOPE: this file mirrors guard 1 (`BAD_CLASSES`) only. The shell
 * script also carries guards 3–5 — the DESIGN.md design-token ratchet
 * (legacy tokens, `-accent/NN`, white-on-accent). Those are deliberately
 * NOT mirrored here:
 *
 *   - They are allowlist-driven off a checked-in data file
 *     (`scripts/dashboard-token-allowlist.txt`, 130 grandfathered
 *     entries). A vitest copy would mean a second parser for that file
 *     and a second scope-exclusion list to keep in sync — two more
 *     things to drift, for zero extra signal, since the shell guard
 *     already runs in the same CI leg as this suite and locally via
 *     `npm run lint:dashboard-classes`.
 *   - Guard 1 is a fixed ten-name list that genuinely benefits from
 *     being asserted twice. A 130-entry ratchet does not.
 *
 * Guard 6 (WARP-1356, dead focus styling: a `focus:` utility defeated by
 * an inline style on the same element) is also script-only. It needs a
 * JSX-tag parser, and this suite already re-reads every source file once
 * per bad class (WARP-2711 tracks its timeout); a second copy here would
 * add cost for no extra signal.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Each bad class is matched as a whole token — preceded and followed by a
 * non-word boundary, so `type-caption` matches `type-caption` and
 * `type-caption/10` but not `type-caption-1` or `type-caption-2`. The
 * `system-yellow` token is intentionally allowed once added to the design
 * system (see WARP-288 token addition); it is NOT in this guard list.
 */
const BAD_CLASSES: ReadonlyArray<string> = [
  "dp-button-primary",
  "dp-button-secondary",
  "type-caption", // bare; type-caption-1 / type-caption-2 are fine
  "type-title", // bare; type-title-1 / type-title-2 / type-title-3 are fine
  "border-separator-primary",
  "border-warning",
  "text-positive",
  "text-warning",
  "bg-warning",
  // The on-accent ink token is wired as `accent.foreground` in
  // tailwind.config.ts, so the utility is `text-accent-foreground`. This
  // spelling generates nothing: the label falls through to body text, which
  // is #000 in light — 3.34:1 on the #4f46e5 primary fill.
  "text-on-accent",
];

const SRC_ROOT = resolve(__dirname, "..");
const EXCLUDE_DIR_NAMES = new Set(["__tests__", "node_modules", ".next"]);
const INCLUDE_EXTENSIONS = new Set([".ts", ".tsx", ".css"]);

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (EXCLUDE_DIR_NAMES.has(entry)) continue;
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

// WARP-2711: every bad class is checked against the same file contents, so
// read the tree ONCE and hand the texts to each case. This used to re-read
// every source file from disk once per bad class (nine full passes), which is
// what made individual cases time out at random on a saturated Windows box.
// The pattern is also built once per class and carries no `g` flag: a global
// regex's `.test()` keeps `lastIndex` between calls, so after one file hit it
// started the next file's search part-way in and under-reported the sites.
function findHits(badClass: string, sources: ReadonlyArray<[string, string]>): string[] {
  // Match the class as a whole token: not preceded or followed by a word
  // char or `-`. Class strings live inside `className="…"` or template
  // literals, separated by whitespace.
  const re = new RegExp(`(^|[^\\w-])${badClass.replace(/[-/\\^$*+?.()|[\\]{}]/g, "\\$&")}(?![\\w-])`);
  const hits: string[] = [];
  for (const [file, text] of sources) {
    if (!re.test(text)) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) hits.push(`${file}:${i + 1}: ${lines[i].trim()}`);
    }
  }
  return hits;
}

describe("dashboard-classes guard", () => {
  const sources: Array<[string, string]> = walk(SRC_ROOT).map((f) => [f, readFileSync(f, "utf8")]);

  for (const badClass of BAD_CLASSES) {
    it(`no source file contains the bad class \`${badClass}\``, () => {
      const hits = findHits(badClass, sources);
      if (hits.length > 0) {
        const msg =
          `Bad class \`${badClass}\` found in ${hits.length} site(s):\n` +
          hits.map((h) => `  ${h}`).join("\n");
        throw new Error(msg);
      }
      expect(hits).toEqual([]);
    });
  }
});
