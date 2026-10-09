/**
 * WARP-3904 — the connect cards' stylesheet keeps to the house rules:
 * tokens only (no colour literal), dark mode through the repo's `.dark` class
 * (never a media query), no animation or transition, every control at least
 * 40px tall, and every token it names actually defined somewhere.
 *
 * A text check on purpose: jsdom does not compute layout, and a typo in a
 * custom property fails silently (the declaration is just dropped).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const here = __dirname;
const src = join(here, "..", "..", "..");
const css = readFileSync(join(here, "connect-card.css"), "utf8");
const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(code);
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1];
}

describe("connect-card.css", () => {
  it("uses no colour literal: every colour comes from a token", () => {
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(code).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/i);
  });

  it("themes through the .dark class and not a media query", () => {
    expect(code).toMatch(/\.dark \.cc /);
    expect(code).not.toMatch(/prefers-color-scheme/);
  });

  it("adds no animation or transition", () => {
    expect(code).not.toMatch(/@keyframes|animation|transition/);
  });

  it.each([".cc .cc-btn", ".cc .cc-input", ".cc .cc-pill", ".cc .cc-choice"])("keeps %s at least 40px tall", (selector) => {
    expect(rule(selector)).toMatch(/min-height:\s*40px/);
  });

  it("only names tokens that are defined", () => {
    const defined = [
      join(src, "components", "shell", "indigo-tokens.css"),
      join(src, "app", "globals.css"),
    ]
      .map((p) => readFileSync(p, "utf8"))
      .join("\n");
    const used = [...new Set([...code.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))];
    expect(used.length).toBeGreaterThan(10);
    // A token with a fallback (`var(--x, 8px)`) may legitimately be absent.
    const withFallback = new Set([...code.matchAll(/var\((--[a-z0-9-]+),/g)].map((m) => m[1]));
    const missing = used.filter((t) => !withFallback.has(t) && !new RegExp(`${t}\\s*:`).test(defined));
    expect(missing).toEqual([]);
  });
});
