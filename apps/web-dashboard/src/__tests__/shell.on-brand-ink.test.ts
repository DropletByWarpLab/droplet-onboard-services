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
 * The light pair was never AA either: white on --brand #6366f1 is 4.47:1,
 * under 4.5:1 for the 13.5px label. `.btn.primary` — the most-used primary
 * button in the dashboard — therefore fills with `--brand-fill` (indigo-600
 * #4f46e5 in light, 6.29:1; the unchanged #818cf8 in dark, 5.64:1) and
 * hovers to `--brand-deep` in light (indigo-700 #4338ca, 7.90:1) and
 * `--brand-soft` in dark (8.44:1), so every state clears AA text.
 *
 * This guard does not pin the hex values by eye: it parses them out of the
 * CSS and recomputes the WCAG 2.x relative-luminance ratio, so a future
 * ramp tweak that quietly breaks contrast fails here rather than in review.
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
    "%s: --on-brand on the primary button's rest fill (--brand-fill) clears AA",
    (theme, floor) => {
      // light #ffffff on #4f46e5 → 6.29:1; dark #1d1d1f on #818cf8 → 5.64:1
      expect(
        contrast(token("--on-brand", theme), token("--brand-fill", theme)),
      ).toBeGreaterThanOrEqual(floor);
    },
  );

  it.each([
    ["light", AA_TEXT],
    ["dark", AA_TEXT],
  ] as const)(
    "%s: --on-brand on the primary button's hover fill clears AA",
    (theme, floor) => {
      // The hover fill differs per theme: light darkens one rung past the
      // rest fill to --brand-deep (7.90:1), dark brightens to --brand-soft
      // (8.44:1) — see the scoped rules in droplet-shell.css, pinned below.
      const fill =
        theme === "light"
          ? token("--brand-deep", "light")
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
    // Dark keeps --brand as the button fill: that pair already passes.
    expect(token("--brand-fill", "dark")).toBe(brand);
  });

  it("light: --brand itself is NOT a text-safe fill — why --brand-fill exists", () => {
    // White on indigo-500 is 4.47:1, a hair under AA text, so the primary
    // button cannot simply paint --brand. Pinned so the record of WHY the
    // two tokens differ survives a future "they should be the same" cleanup.
    const ratio = contrast(token("--on-brand", "light"), token("--brand", "light"));
    expect(ratio).toBeLessThan(AA_TEXT);
    expect(ratio).toBeGreaterThan(4.4);
    expect(token("--brand-fill", "light")).not.toBe(token("--brand", "light"));
  });

  it("light: --on-brand on --brand clears the non-text floor (the .sw.on knob)", () => {
    // The switch still fills its track with --brand and draws the knob in
    // --on-brand — a graphic, not text, so WCAG 1.4.11's 3:1 is its floor.
    expect(
      contrast(token("--on-brand", "light"), token("--brand", "light")),
    ).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });
});

describe(".btn.primary paints the text-safe fills", () => {
  const rule = (re: RegExp): string => {
    const m = shellCss.match(re);
    expect(m, `${re} must match a rule in droplet-shell.css`).not.toBeNull();
    return m![1];
  };

  it("rest fills with --brand-fill, not --brand", () => {
    const body = rule(/^\.droplet-shell \.btn\.primary\s*\{([^}]*)\}/m);
    expect(body).toMatch(/background:\s*var\(--brand-fill\)/);
    expect(body).toMatch(/border-color:\s*var\(--brand-fill\)/);
    expect(body).not.toMatch(/var\(--brand\)/);
  });

  it("light hover fills with --brand-deep, one rung below the rest fill", () => {
    const body = rule(/^\.droplet-shell \.btn\.primary:hover\s*\{([^}]*)\}/m);
    expect(body).toMatch(/background:\s*var\(--brand-deep\)/);
    expect(body).toMatch(/border-color:\s*var\(--brand-deep\)/);
    expect(token("--brand-deep", "light")).not.toBe(token("--brand-fill", "light"));
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
        if (!/background:\s*var\(--brand(?:-fill)?\)/.test(body)) continue;
        expect(
          body,
          `${file}: \`${selector.trim()}\` fills with --brand — use var(--on-brand), not literal white`,
        ).not.toMatch(/(?:^|[^-])color:\s*(?:#fff\b|#ffffff\b|white\b)/i);
      }
    }
  });
});
