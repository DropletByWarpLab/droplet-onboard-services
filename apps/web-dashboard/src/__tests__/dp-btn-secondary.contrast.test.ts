/**
 * WARP-1581 — `.dp-btn-secondary`'s label must clear WCAG 2.1 AA (1.4.3).
 *
 * The token shipped `text-accent` on `bg-accent-subtle`. That tint is a 10 %
 * (light) / 15 % (dark) wash of the accent over whatever surface the button
 * sits on, so the label was effectively the accent on a near-accent-tinted
 * background:
 *
 *   light  #6366f1 on the tint over #ffffff → 3.94:1   ← the reported figure
 *          #6366f1 on the tint over #f2f2f7 → 3.56:1   ← the page background
 *   dark   #818cf8 on the tint over #2c2c2e → 3.72:1   ← cards / grouped rows
 *
 * All under the 4.5:1 floor for normal text, on a token used by ~70 call
 * sites across the dashboard — so this is a dashboard-wide defect, not an
 * access-panel one, and dark mode failed too.
 *
 * jsdom does not apply the stylesheet, so this is a source-level guard on
 * globals.css that reads the real token values and computes the real ratio —
 * the same approach as `remote-access.orange-contrast.test.ts` and the
 * WARP-1277 drift gate, one step stronger (measured, not matched).
 *
 * Path resolution uses `__dirname`, the one anchoring idiom this package uses
 * (WARP-2654) — see `src/__tests__/helpers/test-paths.ts` for why it is
 * spelled this way here. It is NOT that `import.meta.url` is unsafe on
 * Windows: `fileURLToPath` converts it correctly, and only
 * `new URL(...).pathname` yields the `/C:/...` that `path.resolve` doubles.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const globalsCss = readFileSync(resolve(__dirname, "..", "app", "globals.css"), "utf8");

// ── WCAG 2.1 relative luminance + contrast ────────────────────────────────

type Rgb = readonly [number, number, number];

function parseHex(hex: string): Rgb {
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as unknown as Rgb;
}

/** `rgba(r, g, b, a)` → channels + alpha. */
function parseRgba(value: string): { rgb: Rgb; alpha: number } {
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)/.exec(value);
  if (!m) throw new Error(`not an rgb(a) value: ${value}`);
  return {
    rgb: [Number(m[1]), Number(m[2]), Number(m[3])] as unknown as Rgb,
    alpha: m[4] === undefined ? 1 : Number(m[4]),
  };
}

/** Simple source-over composite — what the browser paints for a tint. */
const composite = (fg: Rgb, alpha: number, bg: Rgb): Rgb =>
  fg.map((c, i) => alpha * c + (1 - alpha) * bg[i]) as unknown as Rgb;

function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ── Token extraction from globals.css ─────────────────────────────────────

/** Value of `prop` inside the first block whose selector matches `selector`. */
function tokenIn(selector: string, prop: string): string | null {
  const block = new RegExp(
    `(^|[},;/*\\s])${selector.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
    "m",
  ).exec(globalsCss);
  if (!block) return null;
  const decl = new RegExp(`${prop}\\s*:\\s*([^;]+);`).exec(block[2]);
  return decl ? decl[1].trim() : null;
}

const rootToken = (prop: string): string => {
  const v = tokenIn(":root", prop);
  if (!v) throw new Error(`:root is missing ${prop}`);
  return v;
};
const darkToken = (prop: string): string => {
  const v = tokenIn("\\.dark", prop);
  if (!v) throw new Error(`.dark is missing ${prop}`);
  return v;
};

/**
 * The colour the button's label actually paints. Prefer the AA-safe
 * `--color-accent-text` scoped to the rule; fall back to the raw accent,
 * which is what `@apply text-accent` resolved to before this ticket — so the
 * assertions below measure the real shipped defect when the fix is absent.
 */
const labelColor = (scoped: string | null, accent: string): Rgb =>
  parseHex(scoped ?? accent);

const THEMES = [
  {
    name: "light",
    accent: () => rootToken("--color-accent"),
    subtle: () => rootToken("--color-accent-subtle"),
    label: () => tokenIn("\\.dp-btn-secondary", "--color-accent-text"),
    // Every surface a dp-btn-secondary can sit on: cards, grouped rows,
    // elevated sheets, and the page background itself.
    surfaces: [
      "--color-surface-primary",
      "--color-surface-secondary",
      "--color-surface-tertiary",
      "--color-surface-elevated",
      "--color-surface-raised",
    ].map((p) => [p, rootToken(p)] as const),
  },
  {
    name: "dark",
    accent: () => darkToken("--color-accent"),
    subtle: () => darkToken("--color-accent-subtle"),
    label: () => tokenIn("\\.dark \\.dp-btn-secondary", "--color-accent-text"),
    surfaces: [
      "--color-surface-primary",
      "--color-surface-secondary",
      "--color-surface-tertiary",
      "--color-surface-elevated",
      "--color-surface-raised",
    ].map((p) => [p, darkToken(p)] as const),
  },
] as const;

const AA_NORMAL_TEXT = 4.5;

describe("WARP-1581 — dp-btn-secondary clears WCAG AA in both themes", () => {
  for (const theme of THEMES) {
    const { rgb: tintRgb, alpha } = parseRgba(theme.subtle());
    const label = labelColor(theme.label(), theme.accent());

    for (const [prop, surfaceHex] of theme.surfaces) {
      it(`${theme.name}: label on the accent tint over ${prop} is at least ${AA_NORMAL_TEXT}:1`, () => {
        const painted = composite(tintRgb, alpha, parseHex(surfaceHex));
        const ratio = contrastRatio(label, painted);
        // Reported in the message so a regression states its own number.
        expect(
          ratio,
          `${theme.name} ${prop}: measured ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      });
    }
  }

  it("keeps the label on the accent ramp rather than a foreign hue", () => {
    // Both fixes are steps of the same indigo ramp already in the sheet
    // (light = --color-accent-hover's value, dark likewise), so the button
    // still reads as the accent — this is not a new brand colour.
    expect(tokenIn("\\.dp-btn-secondary", "--color-accent-text")).toBe(
      rootToken("--color-accent-hover"),
    );
    expect(tokenIn("\\.dark \\.dp-btn-secondary", "--color-accent-text")).toBe(
      darkToken("--color-accent-hover"),
    );
  });

  it("leaves the vivid accent in place for fills, rings and borders", () => {
    // The fix must not darken the brand token itself — the primary button,
    // focus rings and active-nav state all key off it.
    expect(rootToken("--color-accent")).toBe("#6366f1");
    expect(darkToken("--color-accent")).toBe("#818cf8");
  });

  it("keeps the button's other states intact", () => {
    const rule = /\.dp-btn-secondary\s*\{([^}]*)\}/.exec(globalsCss);
    expect(rule).not.toBeNull();
    const body = rule![1];
    // The label is repointed; the press feedback, tap target and easing that
    // every call site relies on are untouched.
    expect(body).toMatch(/active:scale-\[0\.97\]/);
    expect(body).toMatch(/min-h-\[44px\]/);
    expect(body).toMatch(/transition-all duration-200 ease-smooth/);
    expect(body).toMatch(/bg-accent-subtle/);
    // …and the label no longer comes from the raw accent utility.
    expect(body).not.toMatch(/text-accent\b/);
  });

  it("scopes the new token outside the design-and-style contract blocks", () => {
    // :root / .dark are locked byte-for-byte to the canon (WARP-1277). A new
    // global token has to land upstream first, so this one is rule-scoped —
    // same pattern as --color-system-orange-text (WARP-1475).
    expect(tokenIn(":root", "--color-accent-text")).toBeNull();
    expect(tokenIn("\\.dark", "--color-accent-text")).toBeNull();
  });
});
