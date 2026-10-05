/**
 * WARP-3509 — what the Events surface and its toasts paint must be readable:
 * every ink on its own fill clears WCAG 1.4.3 (4.5:1 for normal text), in BOTH
 * themes.
 *
 * Why this is measured rather than eyeballed: the fills used to be
 * `bg-system-red/90`, `bg-system-yellow/90` and `bg-system-red/10` — utilities
 * Tailwind cannot generate for a colour that is a CSS variable (see
 * tailwind-var-alpha.guard.test.ts) — so the badges and toasts had NO fill, and
 * a white label sat on the light thumbnail placeholder at ~1.08:1. The fix is
 * opaque fills, and an opaque fill is only as good as the ink chosen for it:
 * white on the vivid system red/orange is 3.55:1 / 2.2:1, under the floor, which
 * is why the severity badges take `--danger` and black ink instead.
 *
 * Like danger-ink.contrast.test.ts and dp-btn-primary.contrast.test.ts, this
 * reads the real token values out of the stylesheets and the real classes out of
 * the components — jsdom applies no stylesheet, so a rendered check cannot see
 * a colour — and computes the real ratio. A class it has not been taught throws,
 * so changing a badge to a new fill means extending this test, not skipping it.
 */
import { describe, it, expect } from "vitest";
import { readPackageFile } from "./helpers/test-paths";

type Theme = "light" | "dark";
type RGB = [number, number, number];

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const globals = stripComments(readPackageFile("src/app/globals.css"));
const shell = stripComments(readPackageFile("src/components/shell/indigo-tokens.css"));

function firstBlock(css: string, selector: RegExp, what: string): string {
  const m = selector.exec(css);
  if (!m) throw new Error(`no ${what} block found`);
  return m[1]!;
}

/** The app-wide tokens: globals.css's top-level `:root` (light) and `.dark` blocks. */
const GLOBAL: Record<Theme, string> = {
  light: firstBlock(globals, /(?:^|\n):root\s*\{([^{}]*)\}/, "globals.css :root"),
  dark: firstBlock(globals, /(?:^|\n)\.dark\s*\{([^{}]*)\}/, "globals.css .dark"),
};
/** The shell's tokens (`--danger`, `--card-bg`, `--inset`…), which the page and the dialogs both carry. */
const SHELL: Record<Theme, string> = {
  light: firstBlock(shell, /(?:^|[{};])\s*\.droplet-shell,[^{}]*\{([^{}]*)\}/, "indigo-tokens light"),
  dark: firstBlock(shell, /(?:^|[{};])\s*\.dark \.droplet-shell,[^{}]*\{([^{}]*)\}/, "indigo-tokens dark"),
};

const hexToRgb = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;

function hexToken(block: string, name: string): RGB {
  const m = new RegExp(`${escapeRe(name)}\\s*:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(block);
  if (!m) throw new Error(`${name} is not a 6-digit hex in that block`);
  return hexToRgb(m[1]!);
}

/** `rgba(r, g, b, a)` token → its colour and alpha. */
function rgbaToken(block: string, name: string): { rgb: RGB; alpha: number } {
  const m = new RegExp(`${escapeRe(name)}\\s*:\\s*rgba\\(\\s*(\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([\\d.]+)\\s*\\)`).exec(block);
  if (!m) throw new Error(`${name} is not an rgba() in that block`);
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: Number(m[4]) };
}

/** `color-mix(in srgb, A p%, B)`: per-channel interpolation in sRGB, which is what the browser does. */
const mix = (a: RGB, pct: number, b: RGB): RGB =>
  a.map((c, i) => (c * pct) / 100 + b[i]! * (1 - pct / 100)) as RGB;

const luminance = ([r, g, b]: RGB): number => {
  const [lr, lg, lb] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!;
};

const contrast = (a: RGB, b: RGB): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];
const AA_NORMAL_TEXT = 4.5;
const THEMES: Theme[] = ["light", "dark"];

/** The colour a `bg-*` class paints, in a theme. Anything it has not been taught is an error. */
function fillOf(cls: string, theme: Theme): RGB {
  const name = cls.replace(/^!/, "");
  let m: RegExpExecArray | null;
  if ((m = /^bg-\[var\((--[\w-]+)\)\]$/.exec(name))) return hexToken(SHELL[theme], m[1]!);
  if ((m = /^bg-system-(red|orange|yellow|green|blue)$/.exec(name))) {
    return hexToken(GLOBAL[theme], `--color-system-${m[1]}`);
  }
  // A black scrim over a thumbnail: judged over the worst backdrop there is, a white one.
  if ((m = /^bg-black\/(\d+)$/.exec(name))) return mix(BLACK, Number(m[1]), WHITE);
  throw new Error(`events-surfaces.contrast.test.ts does not know the fill \`${cls}\` — teach it, do not skip it`);
}

/** The colour a `text-*` class paints. */
function inkOf(cls: string, theme: Theme): RGB {
  const name = cls.replace(/^!/, "");
  if (name === "text-white") return WHITE;
  if (name === "text-black") return BLACK;
  if (name === "text-label-primary") return hexToken(GLOBAL[theme], "--color-label-primary");
  let m: RegExpExecArray | null;
  if ((m = /^text-\[color:var\((--[\w-]+)\)\]$/.exec(name))) {
    const token = m[1]!;
    return token.startsWith("--color-") ? hexToken(GLOBAL[theme], token) : hexToken(SHELL[theme], token);
  }
  throw new Error(`events-surfaces.contrast.test.ts does not know the ink \`${cls}\` — teach it, do not skip it`);
}

const report = (what: string, theme: Theme, ratio: number) => `${what} (${theme}): measured ${ratio.toFixed(2)}:1`;

// ── The severity badges on a review card ──────────────────────────────────

describe("review severity badges read on their own fill", () => {
  const source = readPackageFile("src/components/events/ReviewCard.tsx");
  const badges = [...source.matchAll(/(\w+):\s*\{\s*label:\s*"(\w+)",\s*bg:\s*"([^"]+)",\s*text:\s*"([^"]+)"/g)].map(
    (m) => ({ severity: m[1]!, label: m[2]!, bg: m[3]!, text: m[4]! }),
  );

  it("finds all three severities in the component", () => {
    expect(badges.map((b) => b.severity)).toEqual(["alert", "detection", "significant_motion"]);
  });

  for (const theme of THEMES) {
    it.each(badges.map((b) => [b.label, b.bg, b.text] as const))(
      `${theme}: the %s badge's label clears 4.5:1 on its fill (%s, %s)`,
      (label, bg, text) => {
        const ratio = contrast(inkOf(text, theme), fillOf(bg, theme));
        expect(ratio, report(`${label} badge`, theme, ratio)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      },
    );
  }
});

// ── The "Saved" marks on an event ─────────────────────────────────────────

describe("the Saved marks read on their own fill", () => {
  const card = readPackageFile("src/components/events/EventCard.tsx");
  const modal = readPackageFile("src/components/events/EventClipModal.tsx");

  const savedBadge = /(bg-system-\w+)[^"]*?(text-(?:black|white))[^"]*"[^>]*>\s*<Bookmark/.exec(card);
  const savedButton = /(!bg-system-\w+)\s+(!text-(?:black|white))/.exec(modal);

  it("finds both in the components", () => {
    expect(savedBadge, "the card's Saved badge").not.toBeNull();
    expect(savedButton, "the modal's Saved button").not.toBeNull();
  });

  for (const theme of THEMES) {
    it(`${theme}: the card's Saved badge clears 4.5:1`, () => {
      const ratio = contrast(inkOf(savedBadge![2]!, theme), fillOf(savedBadge![1]!, theme));
      expect(ratio, report("Saved badge", theme, ratio)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    });

    it(`${theme}: the modal's Saved button clears 4.5:1`, () => {
      const ratio = contrast(inkOf(savedButton![2]!, theme), fillOf(savedButton![1]!, theme));
      expect(ratio, report("Saved button", theme, ratio)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    });
  }
});

// ── The failure notices in the modals ─────────────────────────────────────

describe("the clip failure notices read on the inset they sit in", () => {
  // `--danger-ink` is danger-ink.contrast.test.ts's subject on the card and the
  // surface. The notices sit on `--inset` (a faint wash) laid over the card.
  for (const theme of THEMES) {
    it(`${theme}: --danger-ink clears 4.5:1 on --inset over --card-bg`, () => {
      const card = hexToken(SHELL[theme], "--card-bg");
      const { rgb, alpha } = rgbaToken(SHELL[theme], "--inset");
      const inset = mix(rgb, alpha * 100, card);
      const ratio = contrast(hexToken(SHELL[theme], "--danger-ink"), inset);
      expect(ratio, report("--danger-ink on --inset", theme, ratio)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    });
  }
});

// ── The toasts ────────────────────────────────────────────────────────────

describe("toasts read on their own tint", () => {
  const source = readPackageFile("src/components/Toast.tsx");
  const colorsLiteral = /const colors = \{([\s\S]*?)\n  \};/.exec(source)?.[1] ?? "";
  const variantClasses = (name: string): string => {
    const m = new RegExp(`${name}:\\s*"([^"]+)"`).exec(colorsLiteral);
    if (!m) throw new Error(`no "${name}" toast variant found in Toast.tsx`);
    return m[1]!;
  };

  /** The opaque tint the toast paints: a status colour mixed into the elevated surface. */
  function tintOf(classes: string, theme: Theme): RGB {
    const m = /bg-\[color:color-mix\(in_srgb,var\((--[\w-]+)\)_(\d+)%,var\((--[\w-]+)\)\)\]/.exec(classes);
    if (!m) throw new Error(`no opaque color-mix tint in: ${classes}`);
    return mix(hexToken(GLOBAL[theme], m[1]!), Number(m[2]), hexToken(GLOBAL[theme], m[3]!));
  }

  function toastInk(classes: string, theme: Theme): RGB {
    const m = /(?:^|\s)(text-label-primary|text-\[color:var\(--[\w-]+\)\])(?:\s|$)/.exec(classes);
    if (!m) throw new Error(`no text colour in: ${classes}`);
    return inkOf(m[1]!, theme);
  }

  it("has an error, a success and an info variant", () => {
    expect(() => ["error", "success", "info"].forEach(variantClasses)).not.toThrow();
  });

  for (const theme of THEMES) {
    it.each(["error", "success", "info"])(`${theme}: the %s toast's text clears 4.5:1 on its tint`, (variant) => {
      const classes = variantClasses(variant);
      const ratio = contrast(toastInk(classes, theme), tintOf(classes, theme));
      expect(ratio, report(`${variant} toast`, theme, ratio)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    });
  }
});
