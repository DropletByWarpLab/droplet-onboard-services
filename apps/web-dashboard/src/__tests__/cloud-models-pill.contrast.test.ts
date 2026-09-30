/**
 * WARP-3161 — the chat composer's "Cloud models on" pill and its explainer
 * paint `--text` on an opaque `--card-bg` (shell tokens, indigo-tokens.css).
 * The text must clear WCAG AA (4.5:1) in both themes. jsdom applies no
 * stylesheet, so like files-rail.contrast.test.ts this reads the real token
 * values out of the real sheet.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(__dirname, "..");
const shellCss = readFileSync(resolve(SRC, "components", "shell", "indigo-tokens.css"), "utf8");

type Rgb = { r: number; g: number; b: number };
const hex = (v: string): Rgb => {
  const m = /^#([0-9a-f]{6})$/i.exec(v.trim());
  if (!m) throw new Error(`not a 6-digit hex: ${v}`);
  const n = parseInt(m[1], 16);
  return { r: n >> 16, g: (n >> 8) & 255, b: n & 255 };
};
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

describe("WARP-3161 — Cloud models pill text clears AA on its surface", () => {
  const cases = [
    {
      theme: "light",
      text: decl(shellCss, ".droplet-shell", "--text"),
      surface: decl(shellCss, ".droplet-shell", "--card-bg"),
    },
    {
      theme: "dark",
      text: decl(shellCss, ".dark .droplet-shell", "--text"),
      surface: decl(shellCss, ".dark .droplet-shell", "--card-bg"),
    },
  ];

  it.each(cases)("$theme", ({ text, surface }) => {
    expect(contrast(hex(text), hex(surface))).toBeGreaterThanOrEqual(4.5);
  });
});
