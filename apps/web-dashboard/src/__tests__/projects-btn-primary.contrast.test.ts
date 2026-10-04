/**
 * WARP-3181 — `.pm-btn.primary`, the Projects surface's primary button, must
 * clear WCAG 2.1 AA (1.4.3, 4.5:1 for normal text) in BOTH themes, at rest AND
 * while hovered.
 *
 * It painted the raw accent with literal white ink:
 *
 *   light  #ffffff on #6366f1 (--color-accent)  → 4.47:1  ✗
 *   dark   #ffffff on #818cf8 (--color-accent)  → 2.98:1  ✗   (the dark ramp flips)
 *
 * It now paints the accent as a SOLID FILL, with the fill/ink pair globals.css
 * already measures for that (dp-btn-primary.contrast.test.ts owns those numbers):
 *
 *   light  --color-on-accent #ffffff on --color-accent-fill       #4f46e5 → 6.29:1
 *   light  …on --color-accent-fill-hover                          #4338ca → 7.90:1
 *   dark   --color-on-accent #1d1d1f on --color-accent-fill       #818cf8 → 5.64:1
 *   dark   …on --color-accent-fill-hover                          #a5b4fc → 8.44:1
 *
 * No new token and no new hex literal: every value is resolved out of
 * globals.css by name, and the ratio is recomputed here rather than pinned by
 * eye. jsdom does not apply a stylesheet, so this is a source-level guard in the
 * dp-btn-primary / shell.on-brand-ink mould.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { packagePath } from "./helpers/test-paths";

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

const globalsCss = stripComments(readFileSync(packagePath("src/app/globals.css"), "utf8"));
const projectsCss = stripComments(readFileSync(packagePath("src/app/projects/projects.css"), "utf8"));

// ── WCAG 2.1 relative luminance + contrast ────────────────────────────────

type Rgb = readonly [number, number, number];

function parseHex(hex: string): Rgb {
  const h = hex.replace("#", "").trim();
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`not a 6-digit hex colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as unknown as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ── token + rule extraction ────────────────────────────────────────────────

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalizeSelectorList = (s: string): string =>
  s
    .split(",")
    .map((part) => part.trim().replace(/\s+/g, " "))
    .join(", ");

/** Value of `prop` in the LAST flat block of `css` whose selector list is exactly `selector`. */
function tokenIn(css: string, selector: string, prop: string): string | null {
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

const token = (selector: string, prop: string): Rgb => {
  const v = tokenIn(globalsCss, selector, prop);
  if (!v) throw new Error(`globals.css: ${selector} is missing ${prop}`);
  return parseHex(v);
};

/** The declaration body of the one rule `selector` in projects.css. */
function ruleBody(selector: string): string {
  const m = new RegExp(`(?:^|\\})\\s*${escapeRe(selector)}\\s*\\{([^}]*)\\}`, "m").exec(projectsCss);
  if (!m) throw new Error(`projects.css has no rule for ${selector}`);
  return m[1];
}

const AA_NORMAL_TEXT = 4.5;

/** Where globals.css declares the fill tokens, and the ink they pair with. */
const THEMES = [
  { name: "light", fillSel: "html", inkSel: ":root" },
  { name: "dark", fillSel: "html.dark, html .dark", inkSel: ".dark" },
] as const;

const PRIMARY = ".pm-scope .pm-btn.primary";
const PRIMARY_HOVER = ".pm-scope .pm-btn.primary:hover";

describe(".pm-btn.primary paints the accent FILL tokens with the theme's own ink (WARP-3181)", () => {
  it("rest: background and border are the fill token, ink is --color-on-accent, no literal colour", () => {
    const body = ruleBody(PRIMARY);
    expect(body).toMatch(/background:\s*var\(--color-accent-fill\)/);
    expect(body).toMatch(/border-color:\s*var\(--color-accent-fill\)/);
    expect(body).toMatch(/(?<![\w-])color:\s*var\(--color-on-accent\)/);
    // The raw accent is what failed; literal white is why dark failed.
    expect(body).not.toMatch(/var\(--accent\)|var\(--color-accent\)/);
    expect(body).not.toMatch(/#fff\b|#ffffff\b|\bwhite\b/i);
  });

  it("hover: steps to the hover fill token, and does not restate the ink", () => {
    const body = ruleBody(PRIMARY_HOVER);
    expect(body).toMatch(/background:\s*var\(--color-accent-fill-hover\)/);
    expect(body).toMatch(/border-color:\s*var\(--color-accent-fill-hover\)/);
    // The hover fill is only AA with the SAME ink the rest state paints.
    expect(body).not.toMatch(/(?<![\w-])color:/);
  });

  for (const theme of THEMES) {
    for (const [state, fillProp] of [
      ["rest", "--color-accent-fill"],
      ["hover", "--color-accent-fill-hover"],
    ] as const) {
      it(`${theme.name} ${state}: --color-on-accent on ${fillProp} is at least ${AA_NORMAL_TEXT}:1`, () => {
        const ink = token(theme.inkSel, "--color-on-accent");
        const fill = token(theme.fillSel, fillProp);
        const ratio = contrast(ink, fill);
        expect(ratio, `${theme.name} ${state}: measured ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      });
    }
  }

  it("pins the defect: literal white on the raw accent failed in BOTH themes", () => {
    // If this stops holding, someone changed the brand ramp and the whole
    // fill/ink split should be re-read, not silently "simplified".
    const white = parseHex("#ffffff");
    expect(contrast(white, token(":root", "--color-accent"))).toBeLessThan(AA_NORMAL_TEXT);
    expect(contrast(white, token(".dark", "--color-accent"))).toBeLessThan(AA_NORMAL_TEXT);
  });
});

describe("no PM control pairs literal white with the raw brand accent", () => {
  it("every projects.css rule filled with the accent takes its ink from --color-on-accent", () => {
    // The class of defect, not the one button: any rule that fills with the raw
    // accent (or the accent fill) and then names its own white ink.
    let checked = 0;
    for (const [, selector, body] of projectsCss.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (!/(?:^|[;\s])background(?:-color)?:\s*var\(--(?:accent|color-accent|color-accent-fill)\b/.test(body)) continue;
      checked += 1;
      expect(
        body,
        `\`${selector.trim()}\` fills with the brand accent: use var(--color-on-accent), not literal white`,
      ).not.toMatch(/(?<![\w-])color:\s*(?:#fff\b|#ffffff\b|white\b)/i);
    }
    // Not vacuous: the primary button (rest) and the drop indicator at least.
    expect(checked).toBeGreaterThanOrEqual(2);
  });
});
