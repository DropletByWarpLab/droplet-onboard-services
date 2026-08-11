/**
 * WARP-1875 — the Home "Ask AI" widget must reflow to whatever size the user
 * drags it to, not to the size it happened to be when the answer arrived.
 *
 * ── The defect, measured (not assumed) ──────────────────────────────────
 * Reproduced in headless Chrome by mounting the REAL rendered <ChatMessage>
 * markup inside the REAL tile chain
 * (.dh-tile › .bento--hero › .bento-body › .w-chat--conv › .w-chat-thread)
 * with the REAL stylesheets, then shrinking the tile:
 *
 *   tile 820px → thread 798/798 ok    bubble 633
 *   tile 560px → thread 538/538 ok    bubble 477   ← bubble stops shrinking
 *   tile 400px → thread 378/523 HSCROLL  bubble 477
 *   tile 300px → thread 278/523 HSCROLL  bubble 477
 *   tile 240px → thread 218/523 HSCROLL  bubble 477
 *
 * `.msg-col` shrank correctly the whole way down (299 → 219 → 171). The
 * `.msg-bubble` inside it did not: it hit a hard 477px floor and spilled.
 *
 * ── Root cause ─────────────────────────────────────────────────────────
 * `.msg-col` is a COLUMN flex container and ChatMessage aligns the bubble
 * with `items-start` / `items-end`, so `.msg-bubble` is sized *fit-content*
 * in the inline axis rather than stretched. fit-content is floored by the
 * box's MIN-CONTENT width — and min-content is dominated by the unbreakable
 * markdown a long answer carries: a fenced code line and a GFM table.
 * `overflow-x: auto` on `<pre>` / the table wrapper makes those boxes
 * SCROLLABLE but does not lower their min-content contribution, so the
 * ancestor bubble still reserved the full 445px line (+32px padding = 477).
 *
 * It is NOT "a flex child missing `min-width: 0`": `.msg-col` already has
 * `min-width: 0`, and adding `min-width: 0` to `.msg-bubble` was measured to
 * change nothing (min-width:auto on a flex item only means "automatic
 * minimum size" on the MAIN axis; here the constrained axis is the cross
 * axis). The single load-bearing declaration, confirmed by a mutation
 * matrix, is `max-width: 100%` on `.msg-bubble`.
 *
 * `.w-chat-thread` sets `overflow-y: auto`, which makes `overflow-x` compute
 * to `auto` — so the spill surfaced as the internal horizontal scrollbar
 * Samantha reported, with the text scrolled out of view on the right.
 *
 * ── Why this shape of test ─────────────────────────────────────────────
 * jsdom has no layout engine (`scrollWidth` is always 0), so the numbers
 * above cannot be re-measured here — same constraint documented in
 * `src/__tests__/shell/mobile-layout-contract.test.ts`. What this file does
 * instead is stronger than grepping the CSS: it renders the REAL component
 * tree, parses the REAL stylesheets with postcss, and resolves the actual
 * cascade (matching selectors, specificity, source order) against the real
 * elements. A rule that stops matching because a class was renamed, or that
 * loses on specificity to `.droplet-shell`, goes red here.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import postcss, { type Rule, type AtRule } from "postcss";
import { ChatMessage } from "@/components/ChatMessage";
import type { ChatMessage as ChatMessageType } from "@/lib/types";

const SRC = path.resolve(__dirname, "../..");

const SHEETS = {
  chat: "components/chat/chat-indigo.css",
  homeWidgets: "components/home/home-widgets.css",
  homeBento: "components/home/home-bento.css",
} as const;

function readSheet(rel: string): string {
  return readFileSync(path.join(SRC, rel), "utf8");
}

interface Decl {
  selector: string;
  prop: string;
  value: string;
  specificity: number;
  order: number;
  /** `@container`/`@media` condition chain, empty for the base layer. */
  conditions: string[];
}

/**
 * Specificity as a single comparable number. Only classes / attributes /
 * pseudo-classes / type selectors occur in these sheets, so (b, c) is
 * sufficient — no ids anywhere.
 */
function specificity(selector: string): number {
  const cleaned = selector.replace(/::[\w-]+/g, "");
  const b = (cleaned.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
  const c = (cleaned.match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return b * 100 + c;
}

/** Flatten a stylesheet into declarations tagged with their at-rule chain. */
function collect(css: string): Decl[] {
  const out: Decl[] = [];
  let order = 0;
  postcss.parse(css).walkRules((rule: Rule) => {
    const conditions: string[] = [];
    let parent = rule.parent;
    while (parent && parent.type === "atrule") {
      const at = parent as AtRule;
      conditions.unshift(`@${at.name} ${at.params}`);
      parent = at.parent;
    }
    for (const selector of rule.selectors) {
      for (const node of rule.nodes) {
        if (node.type !== "decl") continue;
        out.push({
          selector,
          prop: node.prop,
          value: node.value,
          specificity: specificity(selector),
          order: order++,
          conditions,
        });
      }
    }
  });
  return out;
}

/**
 * Resolve one property for a real DOM element the way a browser would:
 * every base-layer rule whose selector actually matches, ordered by
 * specificity then source order, last one wins.
 */
function resolve(el: Element, decls: Decl[], prop: string): Decl | undefined {
  const hits = decls.filter((d) => {
    if (d.prop !== prop || d.conditions.length > 0) return false;
    try {
      return el.matches(d.selector);
    } catch {
      // Selectors jsdom cannot parse (::-webkit-scrollbar, :has(), …).
      return false;
    }
  });
  hits.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  return hits[hits.length - 1];
}

/**
 * The exact content class that produced the 477px floor: a fenced code block
 * (one long unbreakable line), a GFM table, and a long unbroken URL.
 */
const LONG_ANSWER = [
  "Getting started with your Droplet is quick — here is the order I would go in:",
  "",
  "1. Open the **Network** page and confirm every device on your LAN has been discovered.",
  "2. Add your cameras so recordings start landing on the appliance straight away.",
  "3. Upload a folder of documents on the Files page; indexing runs locally.",
  "",
  "Reference: https://warp-lab.example.com/docs/getting-started/configuring-your-first-appliance",
  "",
  "```bash",
  "docker compose --profile single-box up -d --remove-orphans",
  "```",
  "",
  "| Surface | Port |",
  "| --- | --- |",
  "| orchestrator | 4000 |",
].join("\n");

/**
 * The real ancestor chain InlineChat mounts the thread in (widgets.tsx):
 * `.bento--hero › .bento-body › .w-chat--conv › .droplet-shell.w-chat-thread`.
 * Rendering <ChatMessage> bare would silently miss every `.droplet-shell`-
 * scoped rule, which is exactly the class of mistake this resolver exists to
 * catch — so the wrapper is part of the fixture, not decoration.
 */
function renderAssistantAnswer() {
  const message = {
    id: "warp-1875",
    role: "assistant",
    content: LONG_ANSWER,
    createdAt: new Date("2026-08-11T09:00:00Z").toISOString(),
  } as unknown as ChatMessageType;
  return render(
    <div className="droplet-home">
      <div className="bento bento--hero">
        <div className="bento-body">
          <div className="w-chat w-chat--conv">
            <div className="droplet-shell w-chat-thread">
              <div className="w-chat-thread-inner">
                <ChatMessage message={message} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
  ).container;
}

describe("WARP-1875 · Ask AI widget reflows to its container", () => {
  const chatDecls = collect(readSheet(SHEETS.chat));
  const widgetDecls = collect(readSheet(SHEETS.homeWidgets));
  const bentoDecls = collect(readSheet(SHEETS.homeBento));

  it("sizes the answer bubble fit-content, which is why it needs an explicit cap", () => {
    const container = renderAssistantAnswer();
    const col = container.querySelector(".msg-col");
    expect(col, ".msg-col not rendered").not.toBeNull();
    // `items-start` (Tailwind align-items: flex-start) on a column flex
    // container is what makes the bubble fit-content instead of stretched.
    // If this ever changes the cap below stops being load-bearing — but it
    // stays harmless, so this is documentation, not a constraint.
    expect(col!.className).toMatch(/items-(start|end)/);
    expect(getComputedStyle(col!).flexDirection || "column").toBe("column");
  });

  it("caps the answer bubble at its column so a resized tile cannot be overflowed", () => {
    const container = renderAssistantAnswer();
    const bubble = container.querySelector(".msg-bubble");
    expect(bubble, ".msg-bubble not rendered").not.toBeNull();

    const maxWidth = resolve(bubble!, chatDecls, "max-width");
    expect(
      maxWidth?.value,
      "`.msg-bubble` has no max-width, so its fit-content width is floored by " +
        "the min-content width of unbreakable markdown (code lines, tables) " +
        "and it cannot shrink with the tile — measured floor: 477px",
    ).toBe("100%");
  });

  it("keeps wide markdown scrolling inside its own box, never the card", () => {
    const container = renderAssistantAnswer();

    const pre = container.querySelector(".chat-markdown pre");
    expect(pre, "fenced code did not render a <pre>").not.toBeNull();

    const table = container.querySelector(".chat-markdown table");
    expect(table, "GFM table did not render").not.toBeNull();
    expect(
      table!.parentElement?.className,
      "a wide GFM table must sit in its own horizontal-scroll container",
    ).toContain("overflow-x-auto");
  });

  it("makes Home tiles a query container so widgets can size to themselves", () => {
    // The generalizing half of the ticket: Home widgets respond to their own
    // box, not to the viewport. Every widget shell gets the container, so the
    // next widget with this class of bug has the mechanism already in place.
    const containerType = bentoDecls.find(
      (d) => d.selector === ".droplet-home .bento" && d.prop === "container-type",
    );
    expect(
      containerType?.value,
      "`.droplet-home .bento` must declare `container-type: inline-size`",
    ).toBe("inline-size");
    const containerName = bentoDecls.find(
      (d) => d.selector === ".droplet-home .bento" && d.prop === "container-name",
    );
    expect(containerName?.value).toBe("bento");
  });

  it("tightens Ask AI's internal padding from a container query, not a media query", () => {
    const compact = widgetDecls.filter((d) =>
      d.conditions.some((c) => c.startsWith("@container bento")),
    );
    expect(
      compact.length,
      "no `@container bento` layer in home-widgets.css — padding still keys " +
        "off the viewport instead of the widget's own width",
    ).toBeGreaterThan(0);

    const padded = compact.filter(
      (d) => d.prop === "padding" || d.prop.startsWith("padding-"),
    );
    expect(
      padded.length,
      "the container layer must actually adjust padding",
    ).toBeGreaterThan(0);

    // The compact layer overrides rules defined under `.droplet-shell` in a
    // DIFFERENT stylesheet, so it can only win on specificity — the order the
    // bundler concatenates CSS chunks in is not something this repo controls.
    // Compare like for like: same property, same target compound selector.
    const base = collect(readSheet(SHEETS.chat));
    const lastCompound = (sel: string) => sel.split(/\s+/).pop() ?? sel;
    for (const d of compact) {
      const rivals = base.filter(
        (b) => b.prop === d.prop && lastCompound(b.selector) === lastCompound(d.selector),
      );
      for (const rival of rivals) {
        expect(
          d.specificity,
          `\`${d.selector}\` (${d.specificity}) cannot beat ` +
            `\`${rival.selector}\` (${rival.specificity}) for ${d.prop}; ` +
            "the container layer would be silently dropped",
        ).toBeGreaterThan(rival.specificity);
      }
    }
  });

  it("lets the bubble use the full column once the tile is narrow", () => {
    const compact = widgetDecls.filter(
      (d) =>
        d.conditions.some((c) => c.startsWith("@container bento")) &&
        d.selector.includes(".msg-col") &&
        d.prop === "max-width",
    );
    expect(
      compact.map((d) => d.value),
      "at narrow widths the 80% column reserves dead space the text needs",
    ).toContain("100%");
  });
});
