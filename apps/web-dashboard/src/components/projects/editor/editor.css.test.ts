// The editor's stylesheet is the one part of the contract jsdom cannot see
// (focus rings, target sizes, motion, tokens), so it is pinned statically:
// these are the rules from the WS-2 brief that a future edit could quietly break.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

// Anchored to this file, the dashboard's idiom (src/__tests__/test-paths.guard.test.ts).
const read = (relative: string) => readFileSync(resolve(__dirname, relative), "utf8");
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const css = stripComments(read("./editor.css"));

/** `--name`s the Projects surface itself defines on `.pm-scope` (first block of projects.css). */
function scopeAliases(): Set<string> {
  const block = /\.pm-scope\s*\{([^}]*)\}/.exec(stripComments(read("../../../app/projects/projects.css")));
  if (!block) throw new Error("projects.css has no .pm-scope block");
  return new Set([...block[1].matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
}

/** `[selector, body]` for every rule, flattening @media blocks. */
function rules(source: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const flat = source.replace(/@media[^{]*\{([\s\S]*?\})\s*\}/g, "$1");
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push([m[1].trim(), m[2]]);
  return out;
}

describe("editor.css", () => {
  it("uses no hex or raw colour literals", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(/i);
  });

  it("introduces no tokens and reads only the .pm-scope aliases", () => {
    expect(css).not.toMatch(/(^|[;{\s])--[\w-]+\s*:/);
    const aliases = scopeAliases();
    const used = [...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((name) => !aliases.has(name))).toEqual([]);
  });

  it("scopes every rule under .pm-scope and prefixes its own classes with pm-rte-", () => {
    for (const [selector] of rules(css)) {
      for (const part of selector.split(",").map((s) => s.trim())) {
        expect(part, part).toMatch(/^\.pm-scope\b/);
      }
      const own = [...selector.matchAll(/\.(pm-[\w-]+)/g)].map((m) => m[1]).filter((c) => c !== "pm-scope");
      for (const name of own) expect(name, selector).toMatch(/^pm-rte(-|$)/);
    }
  });

  it("styles the mention chip once, for the editor and for rendered comments", () => {
    const chip = rules(css).filter(([selector]) => selector.split(",").some((s) => s.trim() === ".pm-scope span[data-mention-id]"));
    expect(chip).toHaveLength(1);
    const body = chip[0][1];
    expect(body).toMatch(/font-weight:\s*500/);
    expect(body).toMatch(/color:\s*var\(--text\)/);
    expect(body).toMatch(/background:\s*color-mix\(in srgb,\s*var\(--accent\)/);
    expect(body).toMatch(/border-radius:/);
    expect(body).not.toMatch(/underline/);
    // accent text on the accent tint fails AA at body size
    expect(body).not.toMatch(/(^|[;\s])color:\s*var\(--accent\)/);
  });

  it("gives every control a visible keyboard focus state that survives forced colours", () => {
    const focus = rules(css).filter(([s]) => /:focus-visible/.test(s));
    expect(focus.map(([s]) => s).join("\n")).toMatch(/pm-rte-btn/);
    for (const [, body] of focus) expect(body).toMatch(/outline:\s*2px solid transparent/);
    // the surface shows its ring on the whole widget while any part has focus
    expect(rules(css).some(([s, body]) => /pm-rte:focus-within/.test(s) && /box-shadow/.test(body))).toBe(true);
  });

  it("keeps every target at least 24px", () => {
    const btn = rules(css).find(([s]) => s.trim() === ".pm-scope .pm-rte-btn");
    expect(btn).toBeDefined();
    const size = (prop: string) => Number(new RegExp(`${prop}:\\s*(\\d+)px`).exec(btn![1])?.[1]);
    expect(size("width")).toBeGreaterThanOrEqual(24);
    expect(size("height")).toBeGreaterThanOrEqual(24);
    const row = rules(css).find(([s]) => s.trim() === ".pm-scope .pm-rte-opt");
    expect(Number(/min-height:\s*(\d+)px/.exec(row?.[1] ?? "")?.[1])).toBeGreaterThanOrEqual(24);
  });

  it("honours reduced motion", () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });

  it("matches the .pm-input look: sunken fill, border token and the accent focus ring", () => {
    const shell = rules(css).find(([s]) => s.trim() === ".pm-scope .pm-rte");
    expect(shell?.[1]).toMatch(/background:\s*var\(--bg-sunken\)/);
    expect(shell?.[1]).toMatch(/border:\s*1px solid var\(--border\)/);
    expect(shell?.[1]).toMatch(/border-radius:\s*8px/);
    const ring = rules(css).find(([s]) => /pm-rte:focus-within/.test(s));
    expect(ring?.[1]).toMatch(/color-mix\(in srgb,\s*var\(--accent\)\s*24%/);
  });
});
