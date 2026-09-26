/**
 * `.dp-btn-primary`'s label must clear WCAG 2.1 AA (1.4.3) in BOTH themes,
 * at rest AND while hovered / pressed.
 *
 * The tokenised primary button shipped `bg-accent` + `text-accent-foreground`.
 * In light mode that is white on the vivid accent (indigo-500 #6366f1), which
 * measures 4.47:1 — under the 4.5:1 floor for normal text. `.dp-btn-primary`
 * itself ships in ~22 files; the sign-in, setup-retry and tour call sites
 * repeat its pair. (The dashboard's most-used primary is the page shell's
 * `.btn.primary`, droplet-shell.css — it carried the same 4.47:1 through
 * `--brand` / `--on-brand` and is guarded by shell.on-brand-ink.test.ts.)
 *
 *   light  #ffffff on #6366f1  → 4.47:1   ← the shipped defect
 *   light  #ffffff on #4f46e5  → 6.29:1   ← rest   (--color-accent-fill)
 *   light  #ffffff on #4338ca  → 7.90:1   ← hover/pressed (--color-accent-fill-hover)
 *   dark   #1d1d1f on #818cf8  → 5.64:1   ← rest, the dark accent unchanged
 *   dark   #1d1d1f on #a5b4fc  → 8.44:1   ← hover/pressed
 *
 * Dark rest is deliberately NOT changed: that ramp flips (light accent,
 * near-black ink), so stepping the fill down would move it the wrong way.
 * Hover/press used to fade the button (`hover:opacity-85`,
 * `active:opacity-70`), which blends ink and fill toward the page and took
 * the label under AA while pressed; it now steps to its own fill token.
 *
 * The dark values are declared on `html.dark, html .dark` so the fill flips
 * wherever its ink (`--color-on-accent`, flipped by any `.dark` ancestor)
 * does — including forced-dark subtrees inside a light page.
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

/** `html.dark,\n html .dark` → `html.dark, html .dark`, for exact comparison. */
const normalizeSelectorList = (s: string): string =>
  s
    .split(",")
    .map((part) => part.trim().replace(/\s+/g, " "))
    .join(", ");

/**
 * Value of `prop` in the LAST flat block whose selector list is exactly
 * `selector` (whitespace-insensitive, so the sheet may wrap a list across
 * lines). Last-wins mirrors the cascade, and matters here because `html` is
 * declared twice in this sheet (`--sidebar-w`, then the accent-fill tokens).
 * `.dark` never matches `html.dark, html .dark` — exact list, not a subset.
 */
function tokenIn(selector: string, prop: string): string | null {
  const want = normalizeSelectorList(selector);
  const blocks = /(?:^|[};])\s*([^{};]+?)\s*\{([^{}]*)\}/gm;
  const decl = new RegExp(`(?<![\\w-])${escapeRe(prop)}\\s*:\\s*([^;]+);`);
  let value: string | null = null;
  for (let m = blocks.exec(css); m !== null; m = blocks.exec(css)) {
    if (normalizeSelectorList(m[1]) !== want) continue;
    const d = decl.exec(m[2]);
    if (d) value = d[1].trim();
  }
  return value;
}

const must = (selector: string, prop: string): string => {
  const v = tokenIn(selector, prop);
  if (!v) throw new Error(`${selector} is missing ${prop}`);
  return v;
};

const primaryRule = (): string => {
  const rule = /\.dp-btn-primary\s*\{([^}]*)\}/.exec(css);
  expect(rule, ".dp-btn-primary rule must exist").not.toBeNull();
  return rule![1];
};

const AA_NORMAL_TEXT = 4.5;

/** Where the fill tokens live (not the contract blocks — see the last test). */
const FILL_LIGHT = "html";
const FILL_DARK = "html.dark, html .dark";

const THEMES = [
  { name: "light", fillSel: FILL_LIGHT, inkSel: ":root" },
  { name: "dark", fillSel: FILL_DARK, inkSel: ".dark" },
] as const;

const STATES = [
  { state: "rest", prop: "--color-accent-fill" },
  { state: "hover/pressed", prop: "--color-accent-fill-hover" },
] as const;

describe("dp-btn-primary clears WCAG AA 1.4.3 in both themes", () => {
  for (const theme of THEMES) {
    for (const { state, prop } of STATES) {
      it(`${theme.name} ${state}: on-accent ink on ${prop} is at least ${AA_NORMAL_TEXT}:1`, () => {
        const fill = parseHex(must(theme.fillSel, prop));
        const ink = parseHex(must(theme.inkSel, "--color-on-accent"));
        const ratio = contrastRatio(ink, fill);
        expect(ratio, `${theme.name} ${state}: measured ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
          AA_NORMAL_TEXT,
        );
      });
    }

    it(`${theme.name}: hover is a visibly different fill from rest`, () => {
      expect(must(theme.fillSel, "--color-accent-fill-hover")).not.toBe(
        must(theme.fillSel, "--color-accent-fill"),
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

  it("dark keeps the accent as its rest fill — the dark ramp already passes", () => {
    expect(must(FILL_DARK, "--color-accent-fill")).toBe(must(".dark", "--color-accent"));
  });

  it("every fill is a rung of the existing indigo ramp, not a new brand colour", () => {
    // Same argument as WARP-1581. Light rest #4f46e5 is indigo-600, already
    // the sheet's --color-accent-hover; dark hover #a5b4fc is indigo-300,
    // already the dark --color-accent-hover. Light hover #4338ca is
    // indigo-700 (droplet-700 in tailwind.config.ts).
    expect(must(FILL_LIGHT, "--color-accent-fill")).toBe(must(":root", "--color-accent-hover"));
    expect(must(FILL_DARK, "--color-accent-fill-hover")).toBe(must(".dark", "--color-accent-hover"));
    expect(must(FILL_LIGHT, "--color-accent-fill-hover")).toBe("#4338ca");
  });

  it("the primary button paints the fill token, not the raw accent", () => {
    const body = primaryRule();
    expect(body).toMatch(/(?<![\w:-])bg-accent-fill(?![\w-])/);
    expect(body).not.toMatch(/bg-accent(?![\w-])/);
    expect(body).toMatch(/text-accent-foreground/);
    // The states every call site relies on are untouched.
    expect(body).toMatch(/active:scale-\[0\.97\]/);
    expect(body).toMatch(/min-h-\[44px\]/);
    expect(body).toMatch(/transition-all duration-200 ease-smooth/);
    expect(body).toMatch(/disabled:opacity-60/);
  });

  it("hover and press step to the hover fill instead of fading the button", () => {
    // An opacity fade blends ink AND fill toward the page: the old
    // hover:opacity-85 / active:opacity-70 measured 4.39:1 (dark, over #000)
    // and 3.41:1 (light, over a white card). The hover token is measured
    // above; this pins that both states actually use it.
    const body = primaryRule();
    expect(body).toMatch(/(?<![\w-])hover:bg-accent-fill-hover(?![\w-])/);
    expect(body).toMatch(/(?<![\w-])active:bg-accent-fill-hover(?![\w-])/);
    expect(body).not.toMatch(/hover:opacity-/);
    expect(body).not.toMatch(/active:opacity-/);
  });

  it("the dark fills follow the ink into nested .dark subtrees", () => {
    // --color-on-accent flips under ANY `.dark` ancestor (the `.dark`
    // contract block), and forced-dark subtrees render inside a light page
    // (SecurityWall, WallNotice). Declared on `html.dark` alone, a primary
    // button there would pair #1d1d1f ink with the light #4f46e5 fill:
    // 2.68:1.
    const ink = parseHex(must(".dark", "--color-on-accent"));
    const lightFill = parseHex(must(FILL_LIGHT, "--color-accent-fill"));
    expect(contrastRatio(ink, lightFill)).toBeLessThan(AA_NORMAL_TEXT);
    expect(FILL_DARK.split(", ")).toContain("html .dark");
    expect(tokenIn(FILL_DARK, "--color-accent-fill")).not.toBeNull();
    expect(tokenIn(FILL_DARK, "--color-accent-fill-hover")).not.toBeNull();
  });

  it("keeps the new tokens out of the design-and-style contract blocks", () => {
    // :root / .dark are locked byte-for-byte to the canon (WARP-1277) and the
    // gate fails on an EXTRA property as well as a drifted one, so the tokens
    // are scoped to `html` / `html.dark, html .dark` until they land
    // upstream. The drift gate matches each selector in a list EXACTLY
    // against `.dark`, so `html .dark` is not read as a contract block.
    for (const prop of ["--color-accent-fill", "--color-accent-fill-hover"]) {
      expect(tokenIn(":root", prop)).toBeNull();
      expect(tokenIn(".dark", prop)).toBeNull();
      expect(tokenIn(FILL_LIGHT, prop)).not.toBeNull();
      expect(tokenIn(FILL_DARK, prop)).not.toBeNull();
    }
  });
});
