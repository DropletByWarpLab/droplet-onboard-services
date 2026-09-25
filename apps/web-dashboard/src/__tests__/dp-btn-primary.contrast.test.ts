/**
 * `.dp-btn-primary`'s label must clear WCAG 2.1 AA (1.4.3) in BOTH themes.
 *
 * The canonical primary button shipped `bg-accent` + `text-accent-foreground`.
 * In light mode that is white on the vivid accent (indigo-500 #6366f1), which
 * measures 4.47:1 — under the 4.5:1 floor for normal text. It is the button
 * the whole dashboard renders, and the Windows shell deliberately mirrors the
 * same pair (`--brand` / `--on-brand`, see shell.on-brand-ink.test.ts, which
 * records the identical 4.47:1 and pins it at the non-text floor).
 *
 *   light  #ffffff on #6366f1  → 4.47:1   ← the shipped defect
 *   light  #ffffff on #4f46e5  → 6.29:1   ← the fix (--color-accent-fill)
 *   dark   #1d1d1f on #818cf8  → 5.64:1   ← already passing, untouched
 *
 * Dark is deliberately NOT changed: that ramp flips (light accent, near-black
 * ink), so stepping the fill down would move it the wrong way.
 *
 * There is no open ticket for this pair — the contrast tickets in WARP
 * (608, 610, 633, 652, 1374) are all closed and all about different pairs.
 * The precedent this follows is WARP-1581, which stepped the same indigo ramp
 * one rung (500 → 600) to make the accent legible AS TEXT on its own tint;
 * this applies that step to the accent AS A FILL.
 *
 * jsdom does not apply the stylesheet, so this is a source-level guard that
 * reads the real token values out of globals.css and computes the real ratio
 * — the same approach as `dp-btn-secondary.contrast.test.ts` and the WARP-1277
 * drift gate.
 *
 * Path resolution uses `__dirname`, the one anchoring idiom this package uses
 * (WARP-2654) — see `src/__tests__/helpers/test-paths.ts`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const globalsCss = readFileSync(resolve(__dirname, "..", "app", "globals.css"), "utf8");

/** Comments stripped, so prose that names a token is never read as a decl. */
const css = globalsCss.replace(/\/\*[\s\S]*?\*\//g, "");

// ── WCAG 2.1 relative luminance + contrast ────────────────────────────────

type Rgb = readonly [number, number, number];

function parseHex(hex: string): Rgb {
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`not a hex colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as unknown as Rgb;
}

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

// ── Token extraction ──────────────────────────────────────────────────────

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Value of `prop` in the LAST block whose selector is exactly `selector`.
 * Last-wins mirrors the cascade, and matters here because `html` is declared
 * twice in this sheet (`--sidebar-w`, then the accent-fill token).
 */
function tokenIn(selector: string, prop: string): string | null {
  const blocks = new RegExp(
    `(?:^|[};])\\s*${escapeRe(selector)}\\s*\\{([^}]*)\\}`,
    "gm",
  );
  let value: string | null = null;
  for (let m = blocks.exec(css); m !== null; m = blocks.exec(css)) {
    const decl = new RegExp(`${escapeRe(prop)}\\s*:\\s*([^;]+);`).exec(m[1]);
    if (decl) value = decl[1].trim();
  }
  return value;
}

const must = (selector: string, prop: string): string => {
  const v = tokenIn(selector, prop);
  if (!v) throw new Error(`${selector} is missing ${prop}`);
  return v;
};

const AA_NORMAL_TEXT = 4.5;

const THEMES = [
  { name: "light", fillSel: "html", inkSel: ":root", accentSel: ":root" },
  { name: "dark", fillSel: "html.dark", inkSel: ".dark", accentSel: ".dark" },
] as const;

describe("dp-btn-primary clears WCAG AA 1.4.3 in both themes", () => {
  for (const theme of THEMES) {
    it(`${theme.name}: on-accent ink on the primary fill is at least ${AA_NORMAL_TEXT}:1`, () => {
      const fill = parseHex(must(theme.fillSel, "--color-accent-fill"));
      const ink = parseHex(must(theme.inkSel, "--color-on-accent"));
      const ratio = contrastRatio(ink, fill);
      expect(ratio, `${theme.name}: measured ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        AA_NORMAL_TEXT,
      );
    });
  }

  it("pins the defect: the vivid accent still fails as a light-mode fill", () => {
    // Not decoration. If someone "simplifies" --color-accent-fill back to
    // --color-accent, the test above starts passing for the wrong reason
    // unless this one holds the original measurement in place.
    const accent = parseHex(must(":root", "--color-accent"));
    const ink = parseHex(must(":root", "--color-on-accent"));
    const ratio = contrastRatio(ink, accent);
    expect(ratio, `measured ${ratio.toFixed(2)}:1`).toBeLessThan(AA_NORMAL_TEXT);
    expect(ratio).toBeGreaterThan(4.4); // 4.47:1 — a hair under, not a chasm
  });

  it("leaves the brand accent itself alone", () => {
    // The accent paints active nav, links, focus rings, chips, tints and the
    // aurora. Repainting it to fix one button would repaint the product.
    expect(must(":root", "--color-accent")).toBe("#6366f1");
    expect(must(".dark", "--color-accent")).toBe("#818cf8");
  });

  it("dark keeps the accent as its fill — the dark ramp already passes", () => {
    expect(must("html.dark", "--color-accent-fill")).toBe(must(".dark", "--color-accent"));
  });

  it("light steps a rung of the existing indigo ramp, not a new brand colour", () => {
    // Same argument as WARP-1581: #4f46e5 is indigo-600, already carried by
    // the sheet as --color-accent-hover.
    expect(must("html", "--color-accent-fill")).toBe(must(":root", "--color-accent-hover"));
  });

  it("the primary button paints the fill token, not the raw accent", () => {
    const rule = /\.dp-btn-primary\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    const body = rule![1];
    expect(body).toMatch(/bg-accent-fill/);
    expect(body).not.toMatch(/bg-accent(?![\w-])/);
    expect(body).toMatch(/text-accent-foreground/);
    // The states every call site relies on are untouched.
    expect(body).toMatch(/active:scale-\[0\.97\]/);
    expect(body).toMatch(/min-h-\[44px\]/);
    expect(body).toMatch(/transition-all duration-200 ease-smooth/);
    expect(body).toMatch(/disabled:opacity-60/);
  });

  it("hover stays opacity-based, so the new fill cannot kill press feedback", () => {
    // In light the new fill IS --color-accent-hover, so a colour-swap hover
    // would be invisible. This is why the rule uses hover:opacity-85.
    const rule = /\.dp-btn-primary\s*\{([^}]*)\}/.exec(css);
    expect(rule![1]).toMatch(/hover:opacity-85/);
    expect(must("html", "--color-accent-fill")).toBe(must(":root", "--color-accent-hover"));
  });

  it("keeps the new token out of the design-and-style contract blocks", () => {
    // :root / .dark are locked byte-for-byte to the canon (WARP-1277) and the
    // gate fails on an EXTRA property as well as a drifted one, so the token
    // is scoped to html/html.dark until it lands upstream.
    expect(tokenIn(":root", "--color-accent-fill")).toBeNull();
    expect(tokenIn(".dark", "--color-accent-fill")).toBeNull();
    expect(tokenIn("html", "--color-accent-fill")).not.toBeNull();
    expect(tokenIn("html.dark", "--color-accent-fill")).not.toBeNull();
  });
});
