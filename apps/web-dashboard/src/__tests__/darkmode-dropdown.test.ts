/**
 * WARP-946 — native `<select>` dropdown menus must follow dark-mode styling.
 *
 * Repro: in the Projects "New item" dialog, opening the State `<select>` in dark
 * mode showed a popup with a WHITE (light-mode) OS background, so the dark-text
 * options were barely legible. Root cause is shared, not field-specific:
 *
 *   1. The theme roots (`:root`, `.dark`) never declared `color-scheme`, so the
 *      browser painted the native `<select>` popup (and other native chrome) in
 *      LIGHT regardless of our dark surface tokens — the dark CSS only colours
 *      the *closed* control, not the OS-rendered popup list.
 *   2. The shared select classes (`.dp-input` app-wide, `.pm-input` in projects)
 *      styled the closed control with dark tokens but left their `<option>`
 *      children unstyled, so platforms that ignore `color-scheme` for the popup
 *      still fell back to white.
 *
 * Fix is at the SHARED layer (globals.css theme roots + the two shared select
 * classes), so every dropdown app-wide is correct — not just the State field.
 *
 * jsdom can't render a native popup, so (like the a11y/fluid-type suites) this
 * asserts the SOURCE CSS contract via `fs` from `process.cwd()` (the dashboard
 * package root) — NOT `new URL(import.meta.url)`, which yields `C:\C:\…` ENOENT
 * on Windows.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const globals = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
const projects = readFileSync(
  join(process.cwd(), "src/app/projects/projects.css"),
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
