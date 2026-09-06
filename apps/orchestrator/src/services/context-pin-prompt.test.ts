/**
 * WARP-2582 - the pin block's format is a CONTRACT, not prose.
 *
 * `renderContextPinBlock` writes it and `pinnedToolDomainsFromMessages` reads
 * it back to decide which tool domains the turn advertises. If the two ever
 * disagree, a pinned customer silently stops selecting `business` and the
 * model is handed an id with no tool to spend it on - a failure that is
 * invisible in every other test because nothing errors. These assertions are
 * what make the coupling load-bearing rather than incidental.
 *
 * WARP-2583 added the third leg. Renderer and reader agreeing is worthless if
 * the domain they agree on has no tools in it - which is what happened when
 * ADR-045 emptied `crm`/`pm` and this map lagged the catalog. The last block
 * therefore runs the REAL selection path and asserts a `business_*` tool
 * reaches the advertised set, not just that a domain string comes back.
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
import { effectiveAdvertisedToolNames } from "./tool-selection.service.js";

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
    // The whole point: the id is presented AS an argument, not as decoration -
    // and the tool it is an argument TO must be one the registry still has.
    expect(block).toContain("business_find");
    expect(block).not.toContain("crm_get_customer");
  });

  it("leaves folder/file pins byte-identical to what WARP-460 shipped", () => {
    const block = renderContextPinBlock(
      [{ id: "p1", kind: "camera_window", ref: "front_door", meta: { from: "a", to: "b" } }],
      new Map(),
    );
    expect(block).toContain('- camera_window: front_door {"from":"a","to":"b"}');
    // No business pin => no business guidance paragraph, so a box that never
    // touches the CRM pays nothing for this ticket.
    expect(block).not.toContain("business_find");
  });

  it("hands a project pin to business_find too - the tracker read is in chat now", () => {
    const block = renderContextPinBlock(
      [pin("p1", "project", "pr-uuid")],
      new Map([["p1", active("Surgery fit-out", "FIT")]]),
    );
    // WARP-2582 told the model a project pin had "no read tool in chat",
    // because pm_get_work_item / pm_list_projects were excluded. ADR-045
    // replaced them with business_find, which is in the pool - so the
    // guidance must promise the tool that exists and stop disclaiming the
    // one that does not.
    expect(block).toContain("business_find");
    expect(block).not.toContain("no read tool");
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
    // ONE domain for a CRM pin and a tracker pin alike: ADR-045 put both
    // halves of the graph behind `business`. `crm` / `pm` would each be an
    // empty set on the wire, so asserting them here would pin a lie.
    expect(domains).toEqual(["business"]);
  });

  it("a missing target still selects its domain", () => {
    // The record is gone but the conversation is still about the CRM, and the
    // model needs business_find to offer the obvious next move.
    const block = renderContextPinBlock(
      [pin("p1", "customer", "c")],
      new Map([["p1", { state: "missing", label: null, sublabel: null }]]),
    )!;
    expect(pinnedToolDomainsFromMessages([{ role: "system", content: block }])).toEqual([
      "business",
    ]);
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

describe("a pinned record reaches the WIRE, not just a domain string (WARP-2583)", () => {
  // The two blocks above prove renderer and reader agree. This one proves the
  // thing they agree on still has tools in it: `effectiveAdvertisedToolNames`
  // is the ONE derivation both routes/llm.ts and the agent loop call, so what
  // it returns is what goes on the wire. MUTATION: point
  // PIN_KIND_TOOL_DOMAIN.customer back at "crm" (an empty domain since
  // ADR-045) -> `business_find` drops out of the set below and this goes red,
  // while every string-level test in this file stays green. That is the gap
  // the #2005 review found, closed.
  const POOL = [
    "search_content",
    "read_file",
    "memory_recall",
    "list_cameras",
    "business_find",
    "business_timeline",
    "business_create",
  ];
  // A sentence NO DOMAIN_RULES entry matches - the header's own example. The
  // control case below asserts that, so a rule growing to claim it would
  // fail loudly here rather than quietly make the pin assertion vacuous.
  const sentence = "summarise the last month";

  it("a pinned customer admits business_find on a sentence no rule matches", () => {
    const block = renderContextPinBlock(
      [pin("p1", "customer", "c-uuid")],
      new Map([["p1", active("Northwind Dental")]]),
    )!;
    const withPin = effectiveAdvertisedToolNames({
      mode: "domains",
      messages: [
        { role: "system", content: block },
        { role: "user", content: sentence },
      ],
      pool: POOL,
    });
    expect(withPin.has("business_find")).toBe(true);
    expect(withPin.has("business_timeline")).toBe(true);

    // Control: the sentence alone opens nothing, so the pin did it.
    const withoutPin = effectiveAdvertisedToolNames({
      mode: "domains",
      messages: [{ role: "user", content: sentence }],
      pool: POOL,
    });
    expect(withoutPin.has("business_find")).toBe(false);

    // A pin admits its OWN domain and never widens past the pool's other
    // domains: the RBAC / chat-scope ceiling is untouched.
    expect(withPin.has("list_cameras")).toBe(false);
  });

  it("a pinned work item admits the same tools - the tracker is the same graph", () => {
    const block = renderContextPinBlock(
      [pin("p1", "work_item", "w-uuid")],
      new Map([["p1", active("Order chairs", "NW-14")]]),
    )!;
    const advertised = effectiveAdvertisedToolNames({
      mode: "domains",
      messages: [
        { role: "system", content: block },
        { role: "user", content: sentence },
      ],
      pool: POOL,
    });
    expect(advertised.has("business_find")).toBe(true);
  });

  it("a pin cannot re-admit a tool the pool has already removed", () => {
    // `business_create` is in POOL above; take it out and the pin must not
    // put it back. Selection only ever narrows.
    const block = renderContextPinBlock(
      [pin("p1", "deal", "d-uuid")],
      new Map([["p1", active("Annual contract", "Northwind Dental")]]),
    )!;
    const advertised = effectiveAdvertisedToolNames({
      mode: "domains",
      messages: [
        { role: "system", content: block },
        { role: "user", content: sentence },
      ],
      pool: POOL.filter((n) => n !== "business_create"),
    });
    expect(advertised.has("business_find")).toBe(true);
    expect(advertised.has("business_create")).toBe(false);
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
