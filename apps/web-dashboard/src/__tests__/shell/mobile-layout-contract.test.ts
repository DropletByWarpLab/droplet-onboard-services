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

  /* ── The slim top bar (measured 2026-08-10) ───────────────────────────────
     `.pt-chip` is 282px of nowrap text with `flex-shrink: 0`; beside `.pt-id`
     it made the DOCUMENT 390-437px wide at a 375px viewport on every route
     built from ShellPage. Dropping the host is what buys the room back. */
  it("drops the chip's host + separator so the top bar cannot widen the page", () => {
    const { body } = phoneLayer();
    expect(body).toMatch(/\.pt-chip \.pt-host[\s\S]{0,40}\.pt-sep\s*\{[^}]*display:\s*none/);
  });

  it("leaves the chip's STATUS label visible — the dot alone is colour-only", () => {
    // WCAG 1.4.1: hiding the label too would leave the coloured dot as the
    // sole carrier of health, which is exactly what 1.4.1 forbids.
    const { body } = phoneLayer();
    expect(body).not.toMatch(/\.pt-status\s*\{[^}]*display:\s*none/);
  });

  it("makes both halves of the top bar shrinkable as a backstop", () => {
    const { body } = phoneLayer();
    expect(body).toMatch(/\.pt-id\s*\{[^}]*min-width:\s*0/);
    expect(body).toMatch(/\.pt-chip\s*\{[^}]*min-width:\s*0/);
    // The base rule pins flex-shrink: 0; this must undo it or the chip still
    // refuses to yield.
    expect(body).toMatch(/\.pt-chip\s*\{[^}]*flex-shrink:\s*1/);
  });

  /* ── Touch targets ─────────────────────────────────────────────────────── */
  it("raises the interactive primitives to the 44px touch minimum", () => {
    const { body } = phoneLayer();
    // Authored for a mouse: .btn 36, .btn.sm/.k-iconbtn 30, .chip 32,
    // .cal-leg 28, .icon-btn 36, .tab 42, .search 38. /calendar rendered 99
    // controls under 44px at 375px before this.
    for (const sel of [".btn", ".icon-btn", ".k-iconbtn", ".chip", ".cal-leg", ".search"]) {
      expect(body, `${sel} is not raised to 44px`).toMatch(
        new RegExp(`\\${sel}\\s*\\{[^}]*(height|min-height):\\s*44px`),
      );
    }
  });

  it("gives the toggle a hit area without resizing the switch itself", () => {
    const { body } = phoneLayer();
    expect(body).toMatch(/\.sw::after\s*\{[^}]*position:\s*absolute/);
    // `.sw` is also a 9px colour SWATCH inside the calendar/graph legends —
    // those must NOT gain a 44px phantom target in the middle of their row.
    expect(body).toMatch(/\.cal-leg \.sw::after[\s\S]{0,60}content:\s*none/);
  });
});

/* ══ The 16px input floor ══════════════════════════════════════════════════
   iOS Safari zooms on focus for any control under 16px and never zooms back;
   in that state the page genuinely overflows and pans. WARP-1701 fixed five
   controls at their call sites and they regressed — two are now set with an
   inline `style`, which no selector can beat. Hence one global floor. */
describe("phone input font floor", () => {
  const GLOBALS = readFileSync(
    path.resolve(__dirname, "../../app/globals.css"),
    "utf8",
  );

  it("declares a 16px floor for every control below 720px", () => {
    const i = GLOBALS.indexOf("@media (max-width: 720px)");
    expect(i, "phone input floor is missing from globals.css").toBeGreaterThan(-1);
    const block = GLOBALS.slice(i, GLOBALS.indexOf("}", GLOBALS.indexOf("{", i)) + 2);
    expect(block).toMatch(/input[\s\S]*select[\s\S]*textarea/);
    // `!important` is load-bearing: without it the rule loses to the inline
    // styles in RoleBuilderSheet/SelectionToolbar and to the deeper component
    // selectors (`.droplet-shell .search input` is (0,2,1)).
    expect(block).toMatch(/font-size:\s*16px\s*!important/);
  });
});

/* ══ Home widget touch targets ═════════════════════════════════════════════
   WARP-1875. The WARP-1848 census that produced the `@media (max-width:
   1023px)` block in home-widgets.css was measured by walking Home at 375px
   and listing every control under 44px. That is only as complete as the
   STATE the page happened to be in: it was measured with the Ask AI widget
   in its EMPTY state, where the conversation head does not render, so the
   two 28px pills in it ("Open full chat" / "New chat") were never in the
   41-control count and never got raised.

   So this guard does not restate the list — it DERIVES it. A `.w-*` control
   that declares a `:hover` / `:active` / `:focus` / `:disabled` state is an
   interactive control by construction, and every one of them has to be in
   the 44px block. Adding a widget button with a hover state and forgetting
   the phone layer now goes red here instead of shipping. */
describe("home widget touch targets", () => {
  const HOME = readFileSync(
    path.resolve(__dirname, "../../components/home/home-widgets.css"),
    "utf8",
  );

  /** Drop every at-rule block, leaving the base (desktop) layer. */
  function baseLayer(src: string): string {
    let out = "";
    let i = 0;
    while (i < src.length) {
      const at = src.indexOf("@", i);
      if (at === -1) {
        out += src.slice(i);
        break;
      }
      const open = src.indexOf("{", at);
      if (open === -1) {
        out += src.slice(i);
        break;
      }
      out += src.slice(i, at);
      let depth = 0;
      let j = open;
      for (; j < src.length; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}" && --depth === 0) break;
      }
      i = j + 1;
    }
    return out;
  }

  /** Body of the `max-width: 1023px` layer, braces walked so it is whole. */
  function touchLayer(): string {
    const open = HOME.indexOf("@media (max-width: 1023px)");
    expect(open, "the 44px touch layer is missing from home-widgets.css").toBeGreaterThan(-1);
    const from = HOME.indexOf("{", open);
    let depth = 0;
    let i = from;
    for (; i < HOME.length; i++) {
      if (HOME[i] === "{") depth++;
      else if (HOME[i] === "}" && --depth === 0) break;
    }
    return HOME.slice(from, i + 1);
  }

  /** Every `.w-*` class the base layer gives an interactive state to. */
  function interactiveControls(): string[] {
    const found = new Set<string>();
    for (const [, selectors] of baseLayer(HOME).matchAll(/([^{}]+)\{[^{}]*\}/g)) {
      for (const selector of selectors.split(",")) {
        const m = selector
          .trim()
          .match(/\.(w-[\w-]+)(?::hover|:active|:focus|:focus-visible|:disabled)/);
        if (m) found.add(m[1]);
      }
    }
    return [...found].sort();
  }

  it("derives a non-trivial census, or the guard below asserts nothing", () => {
    // A refactor that renames the hover rules would empty the census and turn
    // every assertion under it into a vacuous pass.
    const controls = interactiveControls();
    expect(controls.length).toBeGreaterThanOrEqual(8);
    expect(controls).toContain("w-chat-conv-btn");
  });

  it("raises every interactive Home control to 44px below 1023px", () => {
    const layer = touchLayer();
    for (const control of interactiveControls()) {
      expect(
        layer,
        `\`.${control}\` has a hover/disabled state — it is a touch target, ` +
          "and it is not raised to 44px in the phone layer " +
          "(04-coding-standards/mobile-web-layout.md)",
      ).toMatch(new RegExp(`\\.${control}\\s*\\{[^}]*(height|min-height):\\s*44px`));
    }
  });

  it("keeps the phone layer scoped so desktop keeps its compact controls", () => {
    // The pills are 28px by design on a wide tile; the 44px floor is a TOUCH
    // affordance, not a new base size.
    const base = baseLayer(HOME);
    expect(base).toMatch(/\.w-chat-conv-btn\s*\{[^}]*height:\s*28px/);
    expect(base).not.toMatch(/\.w-chat-conv-btn\s*\{[^}]*44px/);
  });
});
