// No chart introduces a colour (WARP-3524 AC; brief §2: bind to existing tokens,
// "do not invent new ones"). Enforced rather than remembered: every colour in the
// Insights sources is a `var(--x)` that projects.css already defines, and none is
// a literal.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const DIR = __dirname;
const sources = readdirSync(DIR)
  .filter((f) => /\.(tsx?|css)$/.test(f) && !/\.test\.tsx?$/.test(f))
  .map((f) => ({ file: f, text: readFileSync(path.join(DIR, f), "utf8") }));
const projectsCss = readFileSync(path.join(DIR, "../../../app/projects/projects.css"), "utf8");
const declared = new Set([...projectsCss.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

describe("Insights uses the surface's tokens and nothing else", () => {
  it("finds the sources it is meant to police", () => {
    expect(sources.map((s) => s.file)).toEqual(
      expect.arrayContaining(["InsightsView.tsx", "charts.tsx", "ChartCard.tsx", "insights.css"]),
    );
  });

  it("has no hex colour literal", () => {
    for (const { file, text } of sources) {
      expect(text.match(/#[0-9a-fA-F]{3,8}\b/g), file).toBeNull();
    }
  });

  it("has no rgb() or hsl() colour literal", () => {
    for (const { file, text } of sources) {
      expect(text.match(/\b(?:rgba?|hsla?)\(/g), file).toBeNull();
    }
  });

  it("only references custom properties projects.css defines", () => {
    const used = new Set<string>();
    for (const { text } of sources) for (const m of text.matchAll(/var\((--[a-z0-9-]+)/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(8);
    expect([...used].filter((t) => !declared.has(t))).toEqual([]);
  });
});
