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
 * tree, parses EVERY stylesheet the Home route loads (`HOME_SHEETS`) with
 * postcss, and resolves the cascade across all of them against the real
 * elements. A rule that stops matching because a class was renamed, or that
 * loses on specificity to a `.droplet-shell` rule in a different stylesheet,
 * goes red here.
 *
 * That machinery is shared — it lives in `helpers/css-cascade`, whose header
 * documents the two limits on what a resolution proves (Tailwind's generated
 * utilities are outside the corpus, so each element under test is separately
 * asserted to carry no utility and no inline style for the property in
 * question; and only the base layer is resolved, so the `@container bento`
 * layer is checked structurally by the two tests at the bottom instead).
 */
import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  HOME_SHEETS,
  SHEETS,
  collectSheets,
  rank,
  readSheet,
  resolve,
  specificity,
} from "../helpers/css-cascade";
import { ChatMessage } from "@/components/ChatMessage";
import { CitationCard } from "@/components/citations/CitationCard";
import type { ChatMessage as ChatMessageType } from "@/lib/types";

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
function renderInTile(children: ReactNode) {
  return render(
    <div className="droplet-home">
      <div className="bento bento--hero">
        <div className="bento-body">
          <div className="w-chat w-chat--conv">
            <div className="droplet-shell w-chat-thread">
              <div className="w-chat-thread-inner">{children}</div>
            </div>
          </div>
        </div>
      </div>
    </div>,
  ).container;
}

function renderAssistantAnswer() {
  const message = {
    id: "warp-1875",
    role: "assistant",
    content: LONG_ANSWER,
    createdAt: new Date("2026-08-11T09:00:00Z").toISOString(),
  } as unknown as ChatMessageType;
  return renderInTile(<ChatMessage message={message} />);
}

describe("WARP-1875 · Ask AI widget reflows to its container", () => {
  const homeCascade = collectSheets(
    HOME_SHEETS.map((rel) => ({ css: readSheet(rel), name: rel })),
  );
  const fromSheet = (rel: string) => homeCascade.filter((d) => d.sheet === rel);
  const widgetDecls = fromSheet(SHEETS.homeWidgets);
  const bentoDecls = fromSheet(SHEETS.homeBento);

  it("sizes the answer bubble fit-content, which is why it needs an explicit cap", () => {
    const container = renderAssistantAnswer();
    const col = container.querySelector(".msg-col");
    expect(col, ".msg-col not rendered").not.toBeNull();
    // `items-start` (Tailwind align-items: flex-start) on a column flex
    // container is what makes the bubble fit-content instead of stretched.
    // If this ever changes the cap below stops being load-bearing — but it
    // stays harmless, so this is documentation, not a constraint.
    expect(col!.className).toMatch(/items-(start|end)/);
    // The column direction comes from the AUTHORED cascade, so read it the
    // way every other assertion in this file does. `getComputedStyle` cannot
    // answer it: jsdom never applies these stylesheets to the DOM, so it
    // returns "" for the property and any `|| "column"` fallback would make
    // the check pass unconditionally.
    expect(col!.className).not.toMatch(/(^|\s)flex-(row|col)(-reverse)?(\s|$)/);
    expect(col!.getAttribute("style")).toBeNull();
    const direction = resolve(col!, homeCascade, "flex-direction");
    expect(
      direction.contested.map((d) => `${d.sheet} \`${d.selector}\` (${d.value})`),
    ).toEqual([]);
    expect(direction.winner?.value).toBe("column");
  });

  it("caps the answer bubble at its column so a resized tile cannot be overflowed", () => {
    const container = renderAssistantAnswer();
    const bubble = container.querySelector(".msg-bubble");
    expect(bubble, ".msg-bubble not rendered").not.toBeNull();

    // Nothing outside the authored sheets can move this property here: the
    // bubble carries no Tailwind sizing utility and no inline style, so
    // `homeCascade` IS the whole cascade for `max-width` on this element.
    expect(bubble!.className).not.toMatch(/(^|\s)(max-)?w-/);
    expect(bubble!.getAttribute("style")).toBeNull();

    const maxWidth = resolve(bubble!, homeCascade, "max-width");
    expect(
      maxWidth.contested.map((d) => `${d.sheet} \`${d.selector}\` (${d.value})`),
      "another Home stylesheet sets `max-width` on the bubble at the same " +
        "specificity; which one paints is then CSS chunk order, which this " +
        "repo does not control",
    ).toEqual([]);
    expect(
      maxWidth.winner?.value,
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

  it("keeps a full-screen surface out of the containing block the tile just became", () => {
    // The cost of `container-type: inline-size`: `contain: layout` makes
    // `.bento` a containing block for FIXED descendants too, where before
    // only absolutely-positioned ones were caught by its `position:
    // relative`. `.bento` also clips (`overflow: hidden`), so a `fixed
    // inset-0` modal rendered INLINE inside a widget would resolve against
    // the tile and then be cut off by it — scrim over one tile, dialog
    // squeezed into a 240px box. Citations render inside the Ask AI answer,
    // so this is a live path: an email citation opens exactly such a modal.
    //
    // The viewer gets out by going through the <Dialog> primitive, so this
    // matches on `role="dialog"` rather than on any one implementation's
    // label: it stays red whether the escape hatch is removed from
    // EmailCitation or from the primitive underneath it.
    const container = renderInTile(
      <CitationCard
        hit={{
          fileId: "f-1",
          filename: "quote.eml",
          mimeType: "message/rfc822",
          chunkText: "snippet",
          score: 0.9,
          anchor: { kind: "email-part", messageId: "<m1@x>", partIndex: 1 },
        }}
      />,
    );
    fireEvent.click(container.querySelector('[data-testid="email-card"]')!);

    const modal = document.querySelector('[role="dialog"]');
    expect(modal, "clicking an email citation did not open its viewer").not.toBeNull();
    // The box that actually resolves `inset: 0` is the scrim, one level up
    // from the labelled dialog — assert on that where it exists.
    const scrim = modal!.closest(".fixed") ?? modal!;
    expect(
      container.querySelector(".bento")!.contains(scrim),
      "a `position: fixed` surface renders inside `.bento`, which is now its " +
        "containing block — it must portal out (the <Dialog> primitive's " +
        "documented reason for portalling to document.body)",
    ).toBe(false);
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
    // Compare like for like against the WHOLE Home cascade, not just the chat
    // sheet: a rival in droplet-shell.css or globals.css would drop the
    // container layer just as silently.
    const base = homeCascade.filter((d) => d.conditions.length === 0);
    const lastCompound = (sel: string) => sel.split(/\s+/).pop() ?? sel;
    for (const d of compact) {
      const rivals = base.filter(
        (b) => b.prop === d.prop && lastCompound(b.selector) === lastCompound(d.selector),
      );
      for (const rival of rivals) {
        expect(
          rank(d),
          `\`${d.selector}\` (${rank(d)}) cannot beat ` +
            `\`${rival.selector}\` in ${rival.sheet} (${rank(rival)}) for ` +
            `${d.prop}; the container layer would be silently dropped`,
        ).toBeGreaterThan(rank(rival));
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

/**
 * The resolver above is load-bearing — every assertion in this file is only
 * worth what it can actually detect — so it gets its own coverage. The cases
 * that matter are the two it exists for: a rival in ANOTHER stylesheet, and a
 * cross-sheet tie that no amount of reading one sheet could resolve.
 */
describe("Home cascade resolver", () => {
  const sheet = (css: string, name: string) => ({ css, name });

  /** The bubble in its real ancestor chain — descendant selectors need it. */
  const resolveBubble = (prop: string, sheets: { css: string; name: string }[]) => {
    const host = document.createElement("div");
    host.innerHTML = '<div class="droplet-home"><div class="msg-bubble"></div></div>';
    return resolve(host.querySelector(".msg-bubble")!, collectSheets(sheets), prop);
  };

  it("lets a higher-specificity rule in a LATER stylesheet win", () => {
    const r = resolveBubble("max-width", [
      sheet(".msg-bubble { max-width: 100%; }", "a.css"),
      sheet(".droplet-home .msg-bubble { max-width: 40ch; }", "b.css"),
    ]);
    expect(r.winner?.value).toBe("40ch");
    expect(r.contested).toEqual([]);
  });

  it("lets a higher-specificity rule in an EARLIER stylesheet win", () => {
    const r = resolveBubble("max-width", [
      sheet(".droplet-home .msg-bubble { max-width: 40ch; }", "a.css"),
      sheet(".msg-bubble { max-width: 100%; }", "b.css"),
    ]);
    expect(r.winner?.value).toBe("40ch");
  });

  it("reports a cross-sheet specificity tie as contested, not as a winner", () => {
    const r = resolveBubble("max-width", [
      sheet(".msg-bubble { max-width: 100%; }", "a.css"),
      sheet(".msg-bubble { max-width: 40ch; }", "b.css"),
    ]);
    // Both are 0,1,0. Which one paints depends on the order the bundler
    // concatenates the two chunks in — not something this repo controls.
    expect(r.contested.map((d) => d.sheet)).toEqual(["a.css"]);
  });

  it("resolves a tie WITHIN one stylesheet by source order, silently", () => {
    const r = resolveBubble("max-width", [
      sheet(".msg-bubble { max-width: 100%; } .msg-bubble { max-width: 40ch; }", "a.css"),
    ]);
    expect(r.winner?.value).toBe("40ch");
    expect(r.contested).toEqual([]);
  });

  it("lets `!important` beat a more specific normal rule, whatever the sheet", () => {
    // 20 `!important` declarations live in the Home corpus, so ignoring
    // importance would rank rules a browser does not.
    const r = resolveBubble("max-width", [
      sheet(".msg-bubble { max-width: 100% !important; }", "a.css"),
      sheet(".droplet-home .msg-bubble { max-width: 40ch; }", "b.css"),
    ]);
    expect(r.winner?.value).toBe("100%");
    expect(r.contested).toEqual([]);
  });

  it("scores `:not()` as its argument and `:where()` as nothing", () => {
    // `.a:not(.b)` is 0,2,0 — the pseudo-class itself contributes nothing.
    expect(specificity(".a:not(.b)")).toBe(specificity(".a.b"));
    expect(specificity(":where(.a) .b")).toBe(specificity(".b"));
    expect(specificity(".a:is(.b .c)")).toBe(specificity(".a.b.c"));
  });

  it("ignores at-rule layers, which cannot be evaluated without layout", () => {
    const r = resolveBubble("padding", [
      sheet(".msg-bubble { padding: 12px; }", "a.css"),
      sheet("@container bento (max-width: 460px) { .msg-bubble { padding: 4px; } }", "b.css"),
    ]);
    expect(r.winner?.value).toBe("12px");
  });
});
