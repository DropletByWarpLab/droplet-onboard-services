// WARP-946: dark-mode native <select> popup styling — CSS contract tests.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const globals = readFileSync(resolve(__dirname, "../app/globals.css"), "utf8");
const projects = readFileSync(
  resolve(__dirname, "../app/projects/projects.css"),
  "utf8",
);

/** Body of the FIRST CSS rule whose selector exactly matches `selector`. */
function ruleBody(css: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, "m");
  const m = css.match(re);
  if (!m) throw new Error(`no rule found for selector: ${selector}`);
  return m[1];
}

/** Body of the first rule whose selector contains `fragment` (regex-escaped). */
function ruleBodyContaining(css: string, fragment: string): string {
  const esc = fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${esc}[^{}]*\\{([^}]*)\\}`, "m");
  const m = css.match(re);
  if (!m) throw new Error(`no rule found containing: ${fragment}`);
  return m[1];
}

describe("WARP-946 — dark-mode dropdown / native select chrome", () => {
  it("declares color-scheme: dark on the .dark theme root (native popups render dark app-wide)", () => {
    const dark = ruleBody(globals, ".dark");
    expect(dark).toMatch(/color-scheme:\s*dark/);
  });

  it("declares color-scheme: light on :root so light mode is explicit too", () => {
    const root = ruleBody(globals, ":root");
    expect(root).toMatch(/color-scheme:\s*light/);
  });

  it("styles the shared .dp-input <option> popup with surface + label tokens", () => {
    // Belt-and-suspenders for platforms that ignore color-scheme on the popup.
    const optionRule = ruleBodyContaining(globals, ".dp-input option");
    expect(optionRule).toMatch(/var\(--color-surface-/);
    expect(optionRule).toMatch(/var\(--color-label-/);
    // Never hardcode a light/white background — that's the bug.
    expect(optionRule).not.toMatch(/#fff\b|#ffffff\b|\bwhite\b/i);
  });

  it("styles the shared .pm-input <option> popup with the scope's surface + text tokens", () => {
    const optionRule = ruleBodyContaining(projects, ".pm-input option");
    expect(optionRule).toMatch(/var\(--bg-|var\(--text/);
    expect(optionRule).not.toMatch(/#fff\b|#ffffff\b|\bwhite\b/i);
  });
});
