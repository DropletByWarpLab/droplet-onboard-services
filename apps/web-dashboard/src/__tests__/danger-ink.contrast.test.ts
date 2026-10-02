/**
 * `--danger-ink` — the shell's red for TEXT — must clear WCAG 2.1 AA (1.4.3,
 * 4.5:1 for normal text) on the shell's own backgrounds, `--card-bg` and
 * `--surface`, in BOTH themes.
 *
 * `--danger` is the fill token, and its dark value (#7f1d1d) reads ~1.8:1 as
 * text on the dark card, so an inline problem line takes `--danger-ink`, the
 * ramp `.badge.danger` uses:
 *
 *   light  #b91c1c on #ffffff → 6.47:1   (--card-bg and --surface)
 *   dark   #fca5a5 on #14161d → 9.52:1   (--card-bg)
 *   dark   #fca5a5 on #1a1d27 → 8.86:1   (--surface)
 *
 * It is a SHARED token: declared once, in the shell's indigo-tokens.css, for
 * every surface under `.droplet-shell`. workshop.css paints `.ws-field-error`
 * with it and chat-indigo.css mixes it into the danger tone, so changing it
 * moves all of them.
 *
 * jsdom does not apply the stylesheet, so this is a source-level guard: it reads
 * the real token values out of indigo-tokens.css and computes the real ratio —
 * the same approach as `dp-btn-primary.contrast.test.ts`.
 *
 * Path resolution uses `packagePath` (WARP-2654) — see
 * `src/__tests__/helpers/test-paths.ts`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { packagePath } from "./helpers/test-paths";

/** Comments stripped, so prose that names a selector or a token is never read as one. */
const css = readFileSync(packagePath("src/components/shell/indigo-tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A custom property's value (a 6-digit hex) in the first rule whose selector
 * list starts with `selector`. "Starts with" means at the start of a rule — so
 * `.droplet-shell,` is never found inside `.dark .droplet-shell,`.
 */
const token = (selector: string, name: string): string => {
  const rule = new RegExp(`(?:^|[{};])\\s*${escapeRe(selector)}[^{}]*\\{([^{}]*)\\}`).exec(css);
  if (!rule) throw new Error(`no rule whose selector list starts with ${selector}`);
  const decl = new RegExp(`(?:^|[\\s;{])${escapeRe(name)}\\s*:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(rule[1]!);
  if (!decl) throw new Error(`${name} not found under ${selector}`);
  return decl[1]!;
};

// ── WCAG 2.1 relative luminance + contrast ────────────────────────────────

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

const AA_NORMAL_TEXT = 4.5;

describe("--danger-ink is readable text in both themes", () => {
  it.each([
    ["light", ".droplet-shell,"],
    ["dark", ".dark .droplet-shell,"],
  ])("--danger-ink clears 4.5:1 on the shell's card and surface in %s mode", (_theme, selector) => {
    const ink = token(selector, "--danger-ink");
    for (const background of ["--card-bg", "--surface"]) {
      const ratio = contrast(ink, token(selector, background));
      expect(ratio, `${ink} on ${background}: measured ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });
});
