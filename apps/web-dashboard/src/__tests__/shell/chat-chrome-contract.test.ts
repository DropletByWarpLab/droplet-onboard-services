/**
 * WARP-3043 — /chat wears the Mac app's chrome (DropletAgent spec §5).
 *
 * Borderless and fluid: surfaces are separated by tone, never by a stroke;
 * replies are unboxed text with no avatar; the composer is a pill. The
 * Workshop proved the look under `.workshop-app` overrides (WARP-2974); this
 * pins it where it now lives — chat-indigo.css itself — so a border, a
 * `--lift` ring (it carries a 1px brand ring, a stroke) or an avatar cannot
 * creep back in one rule at a time.
 *
 * The shared message classes are restyled ONLY under `.droplet-shell.chat-app`:
 * the Home "Ask AI" tile renders the same ChatMessage inside
 * `.droplet-shell.w-chat-thread` and keeps its bordered bubble.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import postcss, { type Rule, type AtRule, type Declaration } from "postcss";
import { classNameSites } from "../helpers/class-names";

const SRC = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");

const CHAT_CSS = read("components/chat/chat-indigo.css");
const WORKSHOP_CSS = read("components/workshop/workshop.css");

/** The chat chrome: every class a rule on it may never give a stroke. */
const CHROME_CLASSES = [
  "chat-head",
  "chat-model",
  "chat-model-link",
  "chat-new",
  "chat-iconbtn",
  "conv-rail",
  "conv-head",
  "conv-new-btn",
  "conv-new-row",
  "conv-search",
  "conv-item",
  "chat-sugg",
  "chat-composer",
  "chat-composer-inner",
  "chat-send",
  "chat-stop",
  "chat-subpanel",
  "file-rail",
  "file-rail-head",
  "chat-jump",
  "chat-empty",
  "chat-tone",
];

interface Found {
  selector: string;
  media: string;
  decls: Declaration[];
}

function rules(css: string): Found[] {
  const out: Found[] = [];
  postcss.parse(css).walkRules((rule: Rule) => {
    const media: string[] = [];
    for (let p = rule.parent; p && p.type !== "root"; p = p.parent as typeof p) {
      if (p.type === "atrule") media.push(`${(p as AtRule).name} ${(p as AtRule).params}`);
    }
    const decls = rule.nodes.filter((n): n is Declaration => n.type === "decl");
    for (const selector of rule.selectors) out.push({ selector, media: media.join(" / "), decls });
  });
  return out;
}

const CHAT_RULES = rules(CHAT_CSS);

const hasClass = (selector: string, cls: string) =>
  new RegExp(`\\.${cls}(?![\\w-])`).test(selector);

/** A declaration that draws a stroke: a border with a non-zero width. */
function isStroke(d: Declaration): boolean {
  if (!/^border(-(top|right|bottom|left))?(-width)?$/.test(d.prop)) return false;
  const v = d.value.trim();
  return !/^(0|none)(\s|$)/.test(v) && !/^0(px)?(\s|$)/.test(v);
}

const find = (selector: string, media = "") =>
  CHAT_RULES.filter((r) => r.selector === selector && r.media === media);

const declValue = (selector: string, prop: string, media = "") =>
  find(selector, media)
    .flatMap((r) => r.decls)
    .filter((d) => d.prop === prop)
    .map((d) => d.value.trim())
    .at(-1);

describe("chat chrome is borderless (WARP-3043)", () => {
  it("no chat chrome rule draws a border", () => {
    const strokes = CHAT_RULES.filter((r) =>
      CHROME_CLASSES.some((c) => hasClass(r.selector, c)),
    ).flatMap((r) =>
      r.decls.filter(isStroke).map((d) => `${r.selector} { ${d.prop}: ${d.value} }`),
    );
    // Meta: the scan must actually cover the chrome, or it passes by construction.
    expect(CHAT_RULES.filter((r) => hasClass(r.selector, "conv-rail")).length).toBeGreaterThan(0);
    expect(strokes).toEqual([]);
  });

  it("no chat rule uses --lift (it carries a 1px brand ring)", () => {
    expect(CHAT_CSS).not.toMatch(/var\(\s*--lift\s*\)/);
  });

  it("assistant replies are unboxed text on /chat only", () => {
    const S = ".droplet-shell.chat-app .msg-bubble.is-assistant";
    expect(declValue(S, "background")).toBe("transparent");
    expect(declValue(S, "padding")).toBe("0");
    expect(declValue(S, "border")).toBe("0");
    expect(declValue(".droplet-shell.chat-app .msg-col.is-assistant", "max-width")).toBe("100%");
    // The Home tile's bubble keeps its box: the base rule is untouched.
    expect(declValue(".droplet-shell .msg-bubble.is-assistant", "border")).toBe(
      "1px solid var(--border)",
    );
  });

  it("no avatars on /chat", () => {
    expect(declValue(".droplet-shell.chat-app .msg-ava", "display")).toBe("none");
  });

  it("the composer is the pill, with no phone-only textarea floor", () => {
    const pill = ".droplet-shell .chat-composer-inner";
    expect(declValue(pill, "border-radius")).toBe("26px");
    expect(declValue(pill, "flex-direction")).toBe("row");
    const floors = CHAT_RULES.filter(
      (r) =>
        /max-width:\s*760px/.test(r.media) &&
        /textarea$/.test(r.selector) &&
        r.decls.some((d) => d.prop === "min-height" && d.value.trim() === "44px"),
    );
    expect(floors.map((r) => r.selector)).toEqual([]);
  });
});

describe("keyboard focus inside the pill (WCAG 2.4.7)", () => {
  it("pill buttons show an inset focus ring", () => {
    const ring = CHAT_RULES.find(
      (r) =>
        /\.chat-composer-inner button(:not\([^)]*\))?:focus-visible$/.test(r.selector) &&
        r.decls.some((d) => d.prop === "box-shadow" && /inset/.test(d.value)),
    );
    expect(ring, "no `.chat-composer-inner button:focus-visible` ring").toBeTruthy();
  });

  it("the focus kill only ever targets the textarea", () => {
    const kills = CHAT_RULES.filter((r) =>
      r.decls.some((d) => d.prop === "outline" && /none/.test(d.value) && d.important),
    );
    expect(kills.length).toBeGreaterThan(0);
    for (const r of kills) {
      const last = r.selector.split(/[\s>+~]+/).pop() ?? "";
      expect(last, `${r.selector} kills focus on more than the textarea`).toMatch(/^textarea:/);
    }
  });
});

describe("the Workshop overrides are gone", () => {
  it("workshop.css scopes nothing to .workshop-app", () => {
    expect(WORKSHOP_CSS).not.toMatch(/\.workshop-app\b/);
  });
});

describe("/chat's own markup draws no strokes", () => {
  const BORDER_WIDTH = /^border(-[xytrbl])?(-(2|4|8|\[[^\]]+\]))?$/;
  const RING = /^ring(-|$)/;
  /** Strip variants; a focus ring (the one stroke allowed) is not chrome. */
  function offending(token: string): boolean {
    const parts = token.replace(/^!/, "").split(":");
    const base = parts.pop()!.replace(/^!/, "");
    const focus = parts.some((v) => v === "focus" || v === "focus-visible");
    if (BORDER_WIDTH.test(base)) return true;
    return RING.test(base) && !focus;
  }

  it("no border width or ring utility in app/chat/page.tsx", () => {
    const hits = classNameSites(read("app/chat/page.tsx")).flatMap((s) =>
      s.tokens.filter(offending).map((t) => `:${s.line} ${t}`),
    );
    expect(offending("border")).toBe(true);
    expect(offending("ring-2")).toBe(true);
    expect(offending("focus-visible:ring-2")).toBe(false);
    expect(offending("border-separator")).toBe(false);
    expect(hits).toEqual([]);
  });
});
