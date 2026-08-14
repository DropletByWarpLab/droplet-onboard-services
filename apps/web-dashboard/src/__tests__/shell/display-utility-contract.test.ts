/**
 * WARP-1792 — `.droplet-shell X { display: … }` silently defeats the
 * components' own display utilities.
 *
 * A `.droplet-shell <class>` selector is specificity (0,2,0). Tailwind's
 * `.hidden` / `.lg:flex` are (0,1,0), and the UA's `[hidden] { display: none }`
 * is an origin-level default that loses to ANY author declaration. So a
 * `display` in this stylesheet beats what the component asked for, and does it
 * silently — the JSX still reads `hidden lg:flex`, which is exactly why this
 * shipped: the source looks correct at every call site.
 *
 * Measured cost on /chat at 375px before the fix: the rail rendered at 277px
 * and left the conversation 98px, 26% of the viewport, with the WARP-331
 * mobile drawer ALSO live — two history UIs at once.
 *
 * jsdom has no cascade resolution across stylesheets and no layout, so this is
 * a source-level guard. It is narrow on purpose: it pins the two elements whose
 * display is owned by a utility, not the whole stylesheet.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SHELL_CSS = readFileSync(
  path.resolve(__dirname, "../../components/shell/droplet-shell.css"),
  "utf8",
);
const CHAT_CSS = readFileSync(
  path.resolve(__dirname, "../../components/chat/chat-indigo.css"),
  "utf8",
);

/** Body of the first rule whose selector matches, comments stripped. */
function ruleBody(css: string, selector: string): string {
  const i = css.indexOf(`${selector} {`);
  expect(i, `rule "${selector}" not found`).toBeGreaterThan(-1);
  const open = css.indexOf("{", i);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("display ownership vs. Tailwind utilities", () => {
  it("`.conv-rail` does not declare display — `hidden lg:flex` owns it", () => {
    // chat/page.tsx:618 renders `className="conv-rail hidden lg:flex"`. Any
    // `display` here outranks `.hidden` and puts the desktop rail back on
    // phones alongside the mobile drawer.
    const body = ruleBody(CHAT_CSS, ".droplet-shell .conv-rail");
    expect(body).not.toMatch(/(^|;)\s*display\s*:/);
    // The rest of the rule must still apply on desktop, where `lg:flex`
    // supplies the display.
    expect(body).toMatch(/width:\s*276px/);
    expect(body).toMatch(/flex-direction:\s*column/);
  });

  it("`.tabstrip[hidden]` restores the meaning of the hidden attribute", () => {
    // network/page.tsx:495 renders `hidden={mode === "simple"}` on a
    // `.tabstrip`, whose author `display: flex` beats the UA's
    // `[hidden] { display: none }`.
    expect(SHELL_CSS).toMatch(
      /\.droplet-shell \.tabstrip\[hidden\]\s*\{[^}]*display:\s*none/,
    );
    // ...and it must come after the base rule, or source order drops it.
    expect(SHELL_CSS.indexOf(".droplet-shell .tabstrip[hidden]")).toBeGreaterThan(
      SHELL_CSS.indexOf(".droplet-shell .tabstrip {"),
    );
  });
});
