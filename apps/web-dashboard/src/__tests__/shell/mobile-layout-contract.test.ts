/**
 * WARP-1785/1788/1789/1791 — guards on the phone layout layer in
 * `droplet-shell.css`.
 *
 * Why a CSS-source test instead of a rendering test: jsdom has no layout
 * engine, so `scrollWidth`/`getBoundingClientRect()` are always 0 there and a
 * component test physically cannot observe the overflow these rules fix. The
 * defects were measured in a real browser at 375px; what this file guards is
 * the part a future refactor can silently break without any test going red.
 *
 * The load-bearing invariant is SOURCE ORDER. The phone rules are
 * same-specificity overrides of `.pills` and `.tabstrip`, so they only win by
 * appearing later in the file. Someone tidying this stylesheet by grouping the
 * media query next to the other `max-width: 720px` block near the top would
 * disable every rule in it and leave no other trace.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const CSS = readFileSync(
  path.resolve(__dirname, "../../components/shell/droplet-shell.css"),
  "utf8",
);

/** Index of the base (desktop) definition of a primitive. */
function baseRuleIndex(selector: string): number {
  const i = CSS.indexOf(`.droplet-shell ${selector} { display:`);
  expect(i, `base rule for ${selector} not found`).toBeGreaterThan(-1);
  return i;
}

/** The phone layer added for Sam's QA sweep. */
function phoneLayer(): { start: number; body: string } {
  const marker = "/* ══ Phone layout layer";
  const start = CSS.indexOf(marker);
  expect(start, "phone layout layer is missing").toBeGreaterThan(-1);
  const open = CSS.indexOf("@media (max-width: 720px) {", start);
  expect(open).toBeGreaterThan(-1);
  // Walk braces so the whole media block is captured, comments included.
  let depth = 0;
  let i = CSS.indexOf("{", open);
  const from = i;
  for (; i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return { start, body: CSS.slice(from, i + 1) };
}

describe("droplet-shell phone layout layer", () => {
  it("is declared AFTER the primitives it overrides, or the cascade silently drops it", () => {
    const { start } = phoneLayer();
    // Same specificity (0,2,0) on both sides — later source wins, nothing else.
    expect(start).toBeGreaterThan(baseRuleIndex(".pills"));
    expect(start).toBeGreaterThan(baseRuleIndex(".tabstrip"));
  });

  it("stacks the page header so the text column cannot be starved", () => {
    const { body } = phoneLayer();
    // `.ph-tx` has min-width:0 and `.phead-actions` has flex-shrink:0, so in a
    // row the buttons win and the text collapsed to ~53px on a 375px screen.
    expect(body).toMatch(/\.phead\s*\{[^}]*flex-direction:\s*column/);
  });

  it("contains tab-strip overflow instead of letting it widen the page", () => {
    const { body } = phoneLayer();
    expect(body).toMatch(/\.tabstrip\s*\{[^}]*overflow-x:\s*auto/);
    // Without this the strip's items shrink and the tabs squash together
    // rather than scrolling.
    expect(body).toMatch(/\.tabstrip\s*>\s*\*\s*\{[^}]*flex:\s*0 0 auto/);
  });

  it("contains segmented `.pills` overflow the same way", () => {
    const { body } = phoneLayer();
    expect(body).toMatch(/\.pills\s*\{[^}]*overflow-x:\s*auto/);
    expect(body).toMatch(/\.pills\s*\{[^}]*max-width:\s*100%/);
  });

  it("does not hide the scrollbar, which is the only scroll affordance left", () => {
    // Sam's report calls out that the clipped row gave "no visual hint that
    // the row scrolls". Overlay scrollbars are that hint.
    const { body } = phoneLayer();
    expect(body).not.toMatch(/scrollbar-width:\s*none/);
    expect(body).not.toMatch(/::-webkit-scrollbar\s*\{\s*display:\s*none/);
  });

  it("keeps every phone rule inside the 720px query so desktop is untouched", () => {
    const { body } = phoneLayer();
    // Measured at 1280px after the change: .phead stays row/flex-end with a
    // 30px h1, and .tabstrip/.pills return to overflow-x: visible.
    expect(body.startsWith("{")).toBe(true);
    expect(body).not.toMatch(/@media/);
  });
});
