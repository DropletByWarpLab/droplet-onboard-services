/**
 * WARP-3161 — the chat composer's "Cloud models on" pill paints
 * `text-system-orange bg-system-orange/10` on the composer (`--surface-2`).
 * Its text must clear WCAG AA (4.5:1) in both themes. jsdom applies no
 * stylesheet, so like files-rail.contrast.test.ts this reads the real token
 * values out of the real sheets.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(__dirname, "..");
const globalsCss = readFileSync(resolve(SRC, "app", "globals.css"), "utf8");
const shellCss = readFileSync(resolve(SRC, "components", "shell", "indigo-tokens.css"), "utf8");

type Rgb = { r: number; g: number; b: number };
const hex = (v: string): Rgb => {
  const m = /^#([0-9a-f]{6})$/i.exec(v.trim());
  if (!m) throw new Error(`not a 6-digit hex: ${v}`);
  const n = parseInt(m[1], 16);
  return { r: n >> 16, g: (n >> 8) & 255, b: n & 255 };
};
const over = (fg: Rgb, a: number, bg: Rgb): Rgb => ({
  r: a * fg.r + (1 - a) * bg.r,
  g: a * fg.g + (1 - a) * bg.g,
  b: a * fg.b + (1 - a) * bg.b,
});
const lum = ({ r, g, b }: Rgb) => {
  const l = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * l(r) + 0.7152 * l(g) + 0.0722 * l(b);
};
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** First `prop` declared in the first block whose selector list starts with `selector`. */
function decl(css: string, selector: string, prop: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const block = new RegExp(`(^|[}\\s])${esc}\\s*(,[^{}]*)?\\{([^}]*)\\}`, "m").exec(css);
  const v = block && new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "m").exec(block[3]);
  if (!v) throw new Error(`${selector} has no ${prop}`);
  return v[1].replace(/\/\*.*?\*\//g, "").trim();
}

describe("WARP-3161 — Cloud models pill text clears AA on its tint", () => {
  const cases = [
    {
      theme: "light",
      orange: decl(globalsCss, ":root", "--color-system-orange"),
      // The WARP-1475 compound rule darkens the text in light mode.
      text: decl(globalsCss, ".files-rail-state-provisioning", "--color-system-orange-text"),
      surface: decl(shellCss, ".droplet-shell", "--surface-2"),
    },
    {
      theme: "dark",
      orange: decl(globalsCss, ".dark", "--color-system-orange"),
      // Dark pins the text to the vivid fill token.
      text: decl(globalsCss, ".dark", "--color-system-orange"),
      surface: decl(shellCss, ".dark .droplet-shell", "--surface-2"),
    },
  ];

  it.each(cases)("$theme", ({ orange, text, surface }) => {
    const tint = over(hex(orange), 0.1, hex(surface));
    expect(contrast(hex(text), tint)).toBeGreaterThanOrEqual(4.5);
  });
});
