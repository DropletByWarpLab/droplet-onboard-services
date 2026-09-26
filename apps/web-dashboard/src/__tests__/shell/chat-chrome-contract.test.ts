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
import { readFileSync, readdirSync } from "node:fs";
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
  "chat-model-wrap",
  "chat-model-provider",
  "help-slot",
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

/**
 * Specificity [ids, classes/attributes/pseudo-classes, types] of the flat
 * selectors in chat-indigo.css. `:not(x)` counts as its argument.
 */
function specificity(selector: string): [number, number, number] {
  const s = selector.replace(/:not\(([^)]*)\)/g, " $1");
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):(?!:)[\w-]+/g) ?? []).length;
  const types = (s.replace(/\[[^\]]*\]/g, "").match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return [ids, classes, types];
}

function compareSpecificity(a: string, b: string): number {
  const [x, y] = [specificity(a), specificity(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** A box-shadow value split into its comma-separated layers. */
const shadowLayers = (value: string) => value.split(/,(?![^(]*\))/).map((l) => l.trim());

/** The colour of one box-shadow layer (a token or a literal). */
const layerColour = (layer: string) =>
  /var\(--[\w-]+\)|#[0-9a-f]{3,8}\b|(?:rgb|hsl|color-mix)a?\([^)]*\)+|\b(?:transparent|currentColor)\b/i.exec(
    layer,
  )?.[0];

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

  it("send's focus ring is not painted in send's own fill", () => {
    // The generic pill ring is inset --brand; send is FILLED --brand, so that
    // ring is brand on brand — invisible. Resolve the ring a focused send
    // actually gets (specificity, then source order) and check the colour
    // that touches the fill is not the fill, and that an outset ring's outer
    // colour is not the pill it sits on.
    // Meta: a bare `.chat-send:focus-visible` LOSES to the generic ring, which
    // carries a type selector — the resolution below must see that.
    expect(
      compareSpecificity(
        '.droplet-shell .chat-composer-inner button:not([role^="menuitem"]):focus-visible',
        ".droplet-shell .chat-composer-inner .chat-send:focus-visible",
      ),
    ).toBeGreaterThan(0);
    const FOCUSED_SEND =
      /^\.droplet-shell \.chat-composer-inner (button)?(\.chat-send)?(:not\(\[role\^="menuitem"\]\))?:focus-visible$/;
    const winner = CHAT_RULES.map((r, order) => ({ r, order }))
      .filter(
        ({ r }) =>
          r.media === "" &&
          FOCUSED_SEND.test(r.selector) &&
          r.decls.some((d) => d.prop === "box-shadow"),
      )
      .sort((a, b) => compareSpecificity(a.r.selector, b.r.selector) || a.order - b.order)
      .at(-1);
    expect(winner, "no box-shadow ring reaches a focused send").toBeTruthy();
    const shadow = winner!.r.decls.filter((d) => d.prop === "box-shadow").at(-1)!.value;
    const layers = shadowLayers(shadow);
    const inner = layerColour(layers[0]);
    const outer = layerColour(layers[layers.length - 1]);
    const pill = declValue(".droplet-shell .chat-composer-inner", "background");

    for (const fillSelector of [".droplet-shell .chat-send", ".droplet-shell .chat-send.chat-stop"]) {
      const fill = declValue(fillSelector, "background");
      expect(fill, `${fillSelector} has no fill`).toBeTruthy();
      expect(inner, `${winner!.r.selector}: ring touching ${fillSelector} is its fill`).not.toBe(fill);
    }
    if (!/\binset\b/.test(layers[layers.length - 1])) {
      expect(outer, `${winner!.r.selector}: outset ring is the pill's own tone`).not.toBe(pill);
    }
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

// ── WARP-3043b: menus, secondary surfaces, help ─────────────────────────
describe("/chat's menus and secondary surfaces take tone, not strokes (WARP-3043)", () => {
  const PICK_CSS = read("components/ui/pick-menu.css");
  const BORDER_WIDTH = /^border(-[xytrbl])?(-(2|4|8|\[[^\]]+\]))?$/;
  const RING = /^ring(-|$)/;
  function offending(token: string): boolean {
    const parts = token.replace(/^!/, "").split(":");
    const base = parts.pop()!.replace(/^!/, "");
    const focus = parts.some((v) => v === "focus" || v === "focus-visible");
    if (BORDER_WIDTH.test(base)) return true;
    return RING.test(base) && !focus;
  }
  /** An inline `border…:` style with a width — `borderLeft: "1px solid …"`. */
  const INLINE_STROKE = /\bborder(Top|Right|Bottom|Left)?\s*:\s*["'`]\s*[1-9]/;

  it("no --lift ring on the themed menu or the surfaces that reuse it", () => {
    for (const rel of ["components/ui/pick-menu.css", "components/chat/ChatHistoryRow.tsx", "components/ChatInput.tsx"]) {
      expect(read(rel), rel).not.toMatch(/var\(\s*--lift\s*\)/);
    }
    // No stroke on the menu surface either.
    const strokes = rules(PICK_CSS).flatMap((r) => r.decls.filter(isStroke).map((d) => `${r.selector} ${d.prop}`));
    expect(strokes).toEqual([]);
  });

  it("the chat-only surfaces draw no stroke: no border utility, no inline border", () => {
    const FILES = [
      "components/chat/ChatHistoryRow.tsx",
      "components/chat/SessionHeader.tsx",
      "components/chat/InterviewSurfaces.tsx",
      "components/chat/ReviewCard.tsx",
      "components/chat/MemoryPanel.tsx",
      "components/chat/ContextPinsPopover.tsx",
      "components/help/HelpLauncher.tsx",
    ];
    const hits = FILES.flatMap((rel) => {
      const src = read(rel);
      const utilities = classNameSites(src).flatMap((site) =>
        site.tokens.filter(offending).map((t) => `${rel}:${site.line} ${t}`),
      );
      const inline = src
        .split("\n")
        .flatMap((l, i) => (INLINE_STROKE.test(l) ? [`${rel}:${i + 1} ${l.trim()}`] : []));
      return [...utilities, ...inline];
    });
    expect(INLINE_STROKE.test(`borderLeft: "1px solid var(--border)"`)).toBe(true);
    expect(hits).toEqual([]);
  });

  it("the slash menu keeps no legacy card material", () => {
    const slash = classNameSites(read("components/ChatInput.tsx")).find((site) =>
      site.tokens.includes("max-h-64"),
    )!;
    expect(slash.tokens).toContain("pick-surface");
    expect(slash.tokens.filter((t) => /^(border|shadow-lg|dp-material)/.test(t))).toEqual([]);
  });

  it("no native <select> in the model picker, the menu primitive or /chat's page", () => {
    for (const rel of ["components/ModelSelector.tsx", "components/ui/useMenuButton.ts", "components/ui/MenuSelect.tsx", "app/chat/page.tsx", "components/ChatInput.tsx"]) {
      expect(read(rel), rel).not.toMatch(/<select\s/);
    }
  });

  // /chat's popovers and cards (Memory, Context pins, the review card) pick
  // through components/ui/MenuSelect, not the OS-painted list.
  it("no native select is left in components/chat", () => {
    const dir = path.join(SRC, "components/chat");
    const found = readdirSync(dir)
      .filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f))
      .flatMap((f) => (read(`components/chat/${f}`).match(/<select\s/g) ?? []).map(() => f))
      .sort();
    expect(found).toEqual([]);
  });

  it("the reply's secondary surfaces are toned only under .droplet-shell.chat-app", () => {
    for (const sel of [
      ".droplet-shell.chat-app .ds-process-card",
      ".droplet-shell.chat-app .ds-reasoning-step",
      ".droplet-shell.chat-app .msg-missing-chip",
      ".droplet-shell.chat-app .att-chip",
      ".droplet-shell.chat-app .tool-approval",
    ]) {
      expect(declValue(sel, "border"), sel).toBe("0");
    }
    expect(declValue(".droplet-shell.chat-app .tool-approval", "background")).toMatch(/color-mix/);
    expect(declValue(".droplet-shell.chat-app .tool-approval-title", "color")).toBe("var(--text)");
    expect(declValue(".droplet-shell.chat-app .tool-approval-detail", "color")).toBe("var(--nav-link)");
    // No unscoped rule restyles the shared hooks.
    const hooks = ["ds-process-card", "ds-reasoning-step", "msg-missing-chip", "att-chip", "msg-tool-chip", "tool-approval"];
    const unscoped = CHAT_RULES.filter(
      (r) => hooks.some((h) => hasClass(r.selector, h)) && !r.selector.includes(".droplet-shell.chat-app "),
    ).map((r) => r.selector);
    expect(unscoped).toEqual([]);
  });

  it("the shared components keep their Tailwind (the Home tile and setup AI step are unchanged)", () => {
    const thinking = read("components/chat/ThinkingMessage.tsx");
    for (const t of ["rounded-2xl", "border", "border-dashed", "border-separator", "bg-surface-secondary/40", "px-3", "py-2"]) {
      expect(thinking, t).toMatch(new RegExp(`(^|\\s)${t.replace(/[/.]/g, "\\$&")}(\\s|$)`, "m"));
    }
    expect(read("components/chat/ReasoningDisclosure.tsx")).toContain(
      'className="ds-reasoning-step pl-3 border-l-2 border-separator"',
    );
  });

  it("names no trust copy on /chat's surfaces", () => {
    for (const rel of ["app/chat/page.tsx", "components/ModelSelector.tsx", "components/ChatInput.tsx", "components/help/HelpLauncher.tsx"]) {
      expect(read(rel), rel).not.toMatch(/on-device|stays on your Droplet|nothing leaves/i);
    }
    expect(CHAT_CSS).not.toMatch(/\.chat-tag\b/);
  });
});
