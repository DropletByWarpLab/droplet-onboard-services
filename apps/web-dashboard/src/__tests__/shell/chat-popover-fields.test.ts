/**
 * WARP-3202 — the /chat header popovers (Memory, Context pins).
 *
 * Three things live in chat-indigo.css and nowhere a component test can see
 * them, so they are pinned here:
 *  - `.chat-head` is positioned, so below `lg` the popovers anchor to the bar
 *    (right-3 inside the screen) instead of to their own mid-header buttons;
 *  - `.chat-field` is the text box's inset, with no stroke (the chat chrome is
 *    borderless — WARP-3043 — and the `MenuSelect` triggers beside it have none);
 *  - at phone width every control in a `.chat-field-row` is 44px: the text box,
 *    the picker and the Add button share one row, so they share one height.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import postcss, { type Rule, type AtRule, type Declaration } from "postcss";

const CSS = readFileSync(
  path.resolve(__dirname, "../../components/chat/chat-indigo.css"),
  "utf8",
);

interface Found {
  selector: string;
  media: string;
  decls: Declaration[];
}

const RULES: Found[] = [];
postcss.parse(CSS).walkRules((rule: Rule) => {
  const media: string[] = [];
  for (let p = rule.parent; p && p.type !== "root"; p = p.parent as typeof p) {
    if (p.type === "atrule") media.push(`${(p as AtRule).name} ${(p as AtRule).params}`);
  }
  const decls = rule.nodes.filter((n): n is Declaration => n.type === "decl");
  for (const selector of rule.selectors) RULES.push({ selector, media: media.join(" / "), decls });
});

const PHONE = "media (max-width: 760px)";

const declValue = (selector: string, prop: string, media = "") =>
  RULES.filter((r) => r.selector === selector && r.media === media)
    .flatMap((r) => r.decls)
    .filter((d) => d.prop === prop)
    .map((d) => d.value.trim())
    .at(-1);

describe("header popover anchoring (WARP-3202)", () => {
  it("`.chat-head` is positioned, so a popover below lg anchors to the bar", () => {
    expect(declValue(".droplet-shell .chat-head", "position")).toBe("relative");
  });

  it("the header paints no glass layer of its own (it is a transparent row)", () => {
    const glass = RULES.filter((r) => /\.chat-head::(before|after)/.test(r.selector));
    expect(glass.map((r) => r.selector)).toEqual([]);
    expect(declValue(".droplet-shell .chat-head", "background")).toBe("transparent");
  });
});

describe("header popover fields (WARP-3202)", () => {
  it("`.chat-field` insets its text and draws no stroke", () => {
    expect(declValue(".droplet-shell .chat-field", "padding")).toBe("0 10px");
    expect(declValue(".droplet-shell .chat-field", "border")).toBe("0");
  });

  it("only text boxes wear `.chat-field` now — the pickers are MenuSelect's", () => {
    expect(RULES.filter((r) => /\.chat-field\.sm/.test(r.selector))).toEqual([]);
  });

  it("a text box is 44px with 16px text at phone width (no iOS zoom)", () => {
    expect(declValue(".droplet-shell .chat-field", "height", PHONE)).toBe("44px");
    expect(declValue(".droplet-shell .chat-field", "font-size", PHONE)).toBe("16px");
  });

  it("the Add button and the picker beside a text box are 44px at phone width", () => {
    expect(declValue(".droplet-shell .chat-field-row > button", "height", PHONE)).toBe("44px");
    expect(declValue(".droplet-shell .chat-field-row .pick-select", "height", PHONE)).toBe(
      "44px",
    );
  });

  it("the row raises nothing on a desktop-width screen", () => {
    const outsidePhone = RULES.filter(
      (r) => /\.chat-field-row/.test(r.selector) && r.media !== PHONE,
    );
    expect(outsidePhone.map((r) => `${r.media} ${r.selector}`)).toEqual([]);
  });
});
