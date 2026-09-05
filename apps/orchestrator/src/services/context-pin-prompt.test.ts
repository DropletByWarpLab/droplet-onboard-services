/**
 * WARP-2582 - the pin block's format is a CONTRACT, not prose.
 *
 * `renderContextPinBlock` writes it and `pinnedToolDomainsFromMessages` reads
 * it back to decide which tool domains the turn advertises. If the two ever
 * disagree, a pinned customer silently stops selecting `crm` and the model is
 * handed an id with no tool to spend it on - a failure that is invisible in
 * every other test because nothing errors. These assertions are what make the
 * coupling load-bearing rather than incidental.
 */
import { describe, it, expect } from "vitest";
import {
  CONTEXT_PIN_BLOCK_MAX_CHARS,
  PIN_BLOCK_HEADER,
  pinnedToolDomainsFromMessages,
  renderContextPinBlock,
  type ContextPinTarget,
  type RenderablePin,
} from "./context-pin-prompt.js";

const active = (label: string, sublabel: string | null = null): ContextPinTarget => ({
  state: "active",
  label,
  sublabel,
});

function pin(id: string, kind: string, ref: string): RenderablePin {
  return { id, kind, ref };
}

describe("renderContextPinBlock", () => {
  it("names a customer and hands the model the id as an argument", () => {
    const block = renderContextPinBlock(
      [pin("p1", "customer", "c-uuid")],
      new Map([["p1", active("Northwind Dental")]]),
    );
    expect(block).toContain("- customer: Northwind Dental [id c-uuid]");
    // The whole point: the id is presented AS an argument, not as decoration.
    expect(block).toContain("crm_get_customer");
  });

  it("leaves folder/file pins byte-identical to what WARP-460 shipped", () => {
    const block = renderContextPinBlock(
      [{ id: "p1", kind: "camera_window", ref: "front_door", meta: { from: "a", to: "b" } }],
      new Map(),
    );
    expect(block).toContain('- camera_window: front_door {"from":"a","to":"b"}');
    // No business pin => no business guidance paragraph, so a box that never
    // touches the CRM pays nothing for this ticket.
    expect(block).not.toContain("crm_get_customer");
  });

  it("says a project has no read tool instead of implying one", () => {
    const block = renderContextPinBlock(
      [pin("p1", "project", "pr-uuid")],
      new Map([["p1", active("Surgery fit-out", "FIT")]]),
    );
    // pm_get_work_item / pm_list_projects are in EXCLUDED_FROM_CHAT_TOOLS, so
    // promising a tool here would be a lie the model acts on.
    expect(block).toContain("no read tool in chat");
    expect(block).toContain("- project: Surgery fit-out - FIT [id pr-uuid]");
  });

  it("marks an archived target rather than hiding it", () => {
    const block = renderContextPinBlock(
      [pin("p1", "customer", "c")],
      new Map([["p1", { state: "archived", label: "Old Co", sublabel: null }]]),
    );
    expect(block).toContain("- customer: Old Co (archived) [id c]");
  });

  it("tells the model a deleted target is gone instead of naming nothing", () => {
    const block = renderContextPinBlock(
      [pin("p1", "deal", "d")],
      new Map([["p1", { state: "missing", label: null, sublabel: null }]]),
    );
    expect(block).toContain("no longer exists");
    expect(block).not.toContain("undefined");
  });

  it("OMITS an unavailable target entirely - it never names it", () => {
    const block = renderContextPinBlock(
      [pin("p1", "customer", "c"), pin("p2", "folder", "/share/x")],
      new Map([["p1", { state: "unavailable", label: null, sublabel: null }]]),
    );
    expect(block).not.toContain("customer");
    expect(block).toContain("/share/x");
  });

  it("fails CLOSED for a business pin with no resolution at all", () => {
    // A missing map entry means the resolver could not run. Falling through to
    // the plain renderer would print the bare uuid this ticket exists to stop.
    expect(renderContextPinBlock([pin("p1", "customer", "c-uuid")], new Map())).toBeNull();
  });

  it("returns null rather than a header with nothing under it", () => {
    expect(renderContextPinBlock([], new Map())).toBeNull();
  });

  it("truncates over budget and COUNTS what it dropped", () => {
    const pins = Array.from({ length: 40 }, (_, i) => pin(`p${i}`, "customer", `id-${i}`));
    const targets = new Map(
      pins.map((p, i) => [p.id, active(`Customer number ${i} with a long-ish name`)] as const),
    );
    const block = renderContextPinBlock(pins, targets)!;
    expect(block.length).toBeLessThanOrEqual(CONTEXT_PIN_BLOCK_MAX_CHARS + 80);
    expect(block).toMatch(/- \(\d+ more pin\(s\) not shown/);
  });
});

describe("pinnedToolDomainsFromMessages", () => {
  it("round-trips: what the renderer wrote, the reader selects", () => {
    const block = renderContextPinBlock(
      [pin("p1", "customer", "c"), pin("p2", "work_item", "w")],
      new Map([
        ["p1", active("Northwind Dental")],
        ["p2", active("Order chairs", "NW-14")],
      ]),
    )!;
    const domains = pinnedToolDomainsFromMessages([{ role: "system", content: block }]);
    expect(domains.sort()).toEqual(["crm", "pm"]);
  });

  it("a missing target still selects its domain", () => {
    // The record is gone but the conversation is still about the CRM, and the
    // model needs crm_search_customers to offer the obvious next move.
    const block = renderContextPinBlock(
      [pin("p1", "customer", "c")],
      new Map([["p1", { state: "missing", label: null, sublabel: null }]]),
    )!;
    expect(pinnedToolDomainsFromMessages([{ role: "system", content: block }])).toEqual(["crm"]);
  });

  it("an unavailable target selects NOTHING - the gate is not routed around", () => {
    const block = renderContextPinBlock(
      [pin("p1", "customer", "c"), pin("p2", "folder", "/share/x")],
      new Map([["p1", { state: "unavailable", label: null, sublabel: null }]]),
    )!;
    expect(pinnedToolDomainsFromMessages([{ role: "system", content: block }])).toEqual([]);
  });

  it("ignores user messages and unrelated system messages", () => {
    // MUTATION: drop the `startsWith(PIN_BLOCK_HEADER)` guard and this goes
    // red - a user pasting '- customer: x' would start selecting domains.
    expect(
      pinnedToolDomainsFromMessages([
        { role: "user", content: "- customer: Acme [id x]" },
        { role: "system", content: "You are a helpful assistant.\n- deal: nope" },
      ]),
    ).toEqual([]);
  });

  it("survives a multimodal turn whose content is an array", () => {
    expect(
      pinnedToolDomainsFromMessages([{ role: "system", content: [{ type: "image" }] }]),
    ).toEqual([]);
  });

  it("the header the reader matches on is the one the renderer emits", () => {
    const block = renderContextPinBlock(
      [pin("p1", "customer", "c")],
      new Map([["p1", active("A")]]),
    )!;
    expect(block.startsWith(PIN_BLOCK_HEADER)).toBe(true);
  });
});

describe("PIN_BLOCK_HEADER is the WARP-460 literal, byte for byte", () => {
  it("still opens with the em-dash form anything grepping box logs was written against", () => {
    // b3d612a6 shipped "Context pins for this conversation \u2014 prefer these as …";
    // the review caught a hyphen creeping in under a comment that promised
    // byte-identity. `pinnedToolDomainsFromMessages` finds the block by this
    // prefix, so a drift here is a silent detection miss, not a typo.
    expect(PIN_BLOCK_HEADER).toBe(
      "Context pins for this conversation \u2014 prefer these as scope hints when calling retrieval tools:",
    );
  });
});
