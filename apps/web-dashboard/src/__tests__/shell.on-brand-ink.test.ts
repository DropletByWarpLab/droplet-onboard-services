/**
 * WARP-1358 — ink on `--brand` fills must be tokenised, and must MEASURE
 * as accessible in both themes.
 *
 * `droplet-shell.css` used to hardcode `color: #fff` on `.btn.primary`.
 * That is right for the light ramp (--brand = indigo-500 #6366f1) and wrong
 * for the dark one (--brand = indigo-400 #818cf8), where white lands at
 * 2.98:1 — a WCAG 1.4.3 failure on the primary button of every converted
 * shell page. The fix is a themed `--on-brand` token in `indigo-tokens.css`.
 *
 * This guard does not pin the hex values by eye: it parses them out of the
 * CSS and recomputes the WCAG 2.x relative-luminance ratio, so a future
 * ramp tweak that quietly breaks contrast fails here rather than in review.
 *
 * Path resolution uses CommonJS `__dirname` (NOT `import.meta.url`) — the
 * Windows-safe pattern the other source-reading guards in this suite use.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC_ROOT = resolve(__dirname, "..");
const read = (...p: string[]) => readFileSync(resolve(SRC_ROOT, ...p), "utf8");

const tokensCss = read("components", "shell", "indigo-tokens.css");
const shellCss = read("components", "shell", "droplet-shell.css");
const chatCss = read("components", "chat", "chat-indigo.css");

/* ── WCAG 2.x contrast math ─────────────────────────────── */

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Text ink must clear WCAG AA 1.4.3 for normal-size text. */
const AA_TEXT = 4.5;
/** Meaningful non-text graphics must clear WCAG AA 1.4.11. */
const AA_NON_TEXT = 3;

it("contrast helper matches the published WCAG reference values", () => {
  // black on white is exactly 21:1; the mid grey #767676 on white is the
  // canonical 4.54:1 AA boundary example from the WCAG techniques.
  expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
  expect(contrast("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
});

/* ── token extraction ───────────────────────────────────── */

/**
 * Pull a custom property out of one of the two theme blocks in
 * indigo-tokens.css. `.droplet-shell` is the light base and
 * `.dark .droplet-shell` is the dark override, so the dark value is simply
 * the last declaration in the file and the light value the first.
 */
function token(prop: string, theme: "light" | "dark"): string {
  const hits = [
    ...tokensCss.matchAll(
      new RegExp(`^\\s*${prop.replace(/[-]/g, "\\-")}:\\s*([^;]+);`, "gm"),
    ),
  ].map((m) => m[1].trim());
  expect(hits.length, `${prop} must be declared in both theme blocks`).toBe(2);
  return theme === "light" ? hits[0] : hits[1];
}

describe("--on-brand token (WARP-1358)", () => {
  it("is declared for both themes and flips ink polarity", () => {
    expect(token("--on-brand", "light")).toBe("#ffffff");
    expect(token("--on-brand", "dark")).toBe("#1d1d1f");
  });

  it.each([
    ["light", AA_TEXT],
    ["dark", AA_TEXT],
  ] as const)(
    "%s: --on-brand on --brand-hover clears AA for the primary button label",
    (theme, floor) => {
      // The hover fill differs per theme: light darkens to --brand-hover,
      // dark brightens to --brand-soft (see the scoped rule in
      // droplet-shell.css — indigo-500 pairs with NEITHER ink at 4.5:1).
      const fill =
        theme === "light"
          ? token("--brand-hover", "light")
          : token("--brand-soft", "dark");
      expect(contrast(token("--on-brand", theme), fill)).toBeGreaterThanOrEqual(
        floor,
      );
    },
  );

  it("dark: --on-brand on --brand clears AA text contrast (the reported bug)", () => {
    const brand = token("--brand", "dark");
    // the regression itself — white here is 2.98:1
    expect(contrast("#ffffff", brand)).toBeLessThan(AA_TEXT);
    expect(
      contrast(token("--on-brand", "dark"), brand),
    ).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("light: --on-brand on --brand clears the non-text floor", () => {
    // Light --brand is indigo-500 and white ink measures 4.47:1 — a hair
    // under AA text. That is inherited from the shared brand ramp
    // (globals.css pairs --color-accent #6366f1 with --color-on-accent
    // #ffffff for exactly the same number), NOT introduced by the token, so
    // it is pinned at the non-text floor here and left to the canon repo.
    expect(
      contrast(token("--on-brand", "light"), token("--brand", "light")),
    ).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });
});

describe("no hardcoded white on a --brand fill", () => {
  it.each([
    [".btn.primary", shellCss, /\.droplet-shell \.btn\.primary\s*\{([^}]*)\}/],
    [".sw.on .ball", shellCss, /\.droplet-shell \.sw\.on \.ball\s*\{([^}]*)\}/],
    [".chat-send", chatCss, /\.droplet-shell \.chat-send\s*\{([^}]*)\}/],
  ])("%s references var(--on-brand)", (name, css, re) => {
    const rule = css.match(re);
    expect(rule, `${name} rule must exist`).not.toBeNull();
    expect(rule![1]).toMatch(/var\(--on-brand\)/);
    expect(rule![1]).not.toMatch(/#fff\b|#ffffff\b/i);
  });

  it("dark primary hover brightens up the ramp so --on-brand stays valid", () => {
    const rule = shellCss.match(
      /\.dark \.droplet-shell \.btn\.primary:hover\s*\{([^}]*)\}/,
    );
    expect(
      rule,
      "droplet-shell.css must dark-scope the primary hover fill",
    ).not.toBeNull();
    expect(rule![1]).toMatch(/background:\s*var\(--brand-soft\)/);
  });

  it("no `.droplet-shell`-scoped rule pairs literal white with a --brand fill", () => {
    for (const [file, css] of [
      ["droplet-shell.css", shellCss],
      ["chat-indigo.css", chatCss],
    ] as const) {
      for (const [, selector, body] of css.matchAll(
        /([^{}]*\.droplet-shell[^{}]*)\{([^}]*)\}/g,
      )) {
        if (!/background:\s*var\(--brand\)/.test(body)) continue;
        expect(
          body,
          `${file}: \`${selector.trim()}\` fills with --brand — use var(--on-brand), not literal white`,
        ).not.toMatch(/(?:^|[^-])color:\s*(?:#fff\b|#ffffff\b|white\b)/i);
      }
    }
  });
});
