/**
 * WARP-2897 (ADR-056 slice I-0) — the two-layer tool model.
 *
 * Reachability, grantability and dead-grant marking all read the SAME two
 * layers: the compiled catalog (tools-core) and the runtime layer (the
 * runtime registry, classified by the operator-owned RemoteToolClassification
 * record). These specs pin the three rules the layers exist to hold:
 *
 *   1. a runtime tool with no classification row is a WRITE;
 *   2. a `denied` row removes the tool from every derived set;
 *   3. the wire's own hints (readOnlyHint, the name, the description) are
 *      never read — a server cannot choose its own privilege level.
 */
import { describe, it, expect } from "vitest";
import { TOOL_CATALOG, TOOL_DOMAINS, type ToolDomain } from "@droplet/tools-core";
import {
  catalogLayer,
  runtimeLayer,
  toolLayers,
  populatedDomains,
  readableDomains,
  runtimeOnlyDomains,
  toolDomainUniverse,
  loadToolLayers,
  runtimeToolLookupFrom,
} from "./tool-layers.service.js";
import {
  RuntimeToolRegistry,
  type RuntimeToolDescriptor,
} from "./runtime-tool-registry.service.js";
import type { RemoteToolClassificationRow } from "./remote-tool-classification.service.js";

/** A runtime descriptor in an arbitrary domain. The closed ToolDomain union is
 *  the extension-domain decision slice H has not made yet (see the PR), so a
 *  fixture outside it is cast — the layer model itself reads `string`. */
function descriptor(
  serverId: string,
  wireName: string,
  domain: string,
  extra: Record<string, unknown> = {},
): RuntimeToolDescriptor {
  return {
    name: `${serverId}__${wireName}`,
    serverId,
    domain: domain as ToolDomain,
    domainSource: "server",
    description: `fixture ${wireName}`,
    inputSchema: { type: "object", properties: {} },
    ...extra,
  };
}

function row(
  serverId: string,
  toolName: string,
  over: Partial<RemoteToolClassificationRow> = {},
): RemoteToolClassificationRow {
  const now = new Date("2026-09-22T00:00:00Z");
  return {
    serverId,
    toolName,
    requiresWrite: true,
    requiresConfirmation: true,
    denied: false,
    reviewedBy: null,
    reviewedAt: null,
    wireDescription: null,
    firstSeenAt: now,
    lastSeenAt: now,
    ...over,
  };
}

const lookupOf = (rows: RemoteToolClassificationRow[]) => (serverId: string, toolName: string) =>
  rows.find((r) => r.serverId === serverId && r.toolName === toolName);

describe("tool-layers — the catalog layer", () => {
  it("is TOOL_CATALOG verbatim: same names, domains and write flags", () => {
    const layer = catalogLayer();
    expect(layer).toHaveLength(TOOL_CATALOG.length);
    for (const entry of TOOL_CATALOG) {
      const t = layer.find((l) => l.name === entry.name);
      expect(t, entry.name).toBeDefined();
      expect(t!.domain).toBe(entry.domain);
      expect(t!.requiresWrite).toBe(entry.requiresWrite);
      expect(t!.source).toBe("catalog");
    }
  });

  it("populated = domains holding a tool; crm/pm are declared but empty (ADR-045)", () => {
    const populated = populatedDomains(toolLayers());
    expect(populated.has("crm")).toBe(false);
    expect(populated.has("pm")).toBe(false);
    expect(populated.has("business")).toBe(true);
    for (const d of populated) expect(TOOL_DOMAINS).toContain(d);
  });
});

describe("tool-layers — the runtime layer reads the RECORD, never the wire", () => {
  it("a runtime tool with NO classification row is a write (the import default)", () => {
    const layer = runtimeLayer([descriptor("bookings", "list_slots", "ext-bookings")], lookupOf([]));
    expect(layer).toEqual([
      {
        name: "bookings__list_slots",
        domain: "ext-bookings",
        requiresWrite: true,
        source: "runtime:bookings",
      },
    ]);
    const layers = toolLayers(layer);
    expect(populatedDomains(layers).has("ext-bookings")).toBe(true);
    expect(readableDomains(layers).has("ext-bookings")).toBe(false);
  });

  it("a descriptor claiming readOnlyHint is STILL a write without a reviewed row", () => {
    const layer = runtimeLayer(
      [
        descriptor("bookings", "list_slots", "ext-bookings", {
          annotations: { readOnlyHint: true },
          readOnlyHint: true,
          requiresWrite: false,
        }),
      ],
      lookupOf([]),
    );
    expect(layer[0]!.requiresWrite).toBe(true);
    expect(readableDomains(toolLayers(layer)).has("ext-bookings")).toBe(false);
  });

  it("a row the operator classified read makes the domain readable", () => {
    const layer = runtimeLayer(
      [descriptor("bookings", "list_slots", "ext-bookings")],
      lookupOf([row("bookings", "list_slots", { requiresWrite: false, requiresConfirmation: false })]),
    );
    expect(layer[0]!.requiresWrite).toBe(false);
    expect(readableDomains(toolLayers(layer)).has("ext-bookings")).toBe(true);
  });

  it("a DENIED row removes the tool from populated AND readable", () => {
    const layer = runtimeLayer(
      [descriptor("bookings", "list_slots", "ext-bookings")],
      lookupOf([
        row("bookings", "list_slots", {
          requiresWrite: false,
          requiresConfirmation: false,
          denied: true,
        }),
      ]),
    );
    expect(layer).toEqual([]);
    const layers = toolLayers(layer);
    expect(populatedDomains(layers).has("ext-bookings")).toBe(false);
    expect(readableDomains(layers).has("ext-bookings")).toBe(false);
  });

  it("the row is keyed on (serverId, WIRE name) — the namespaced name is split first", () => {
    // A row for a different server's tool of the same wire name must not leak.
    const layer = runtimeLayer(
      [descriptor("bookings", "list_slots", "ext-bookings")],
      lookupOf([row("other", "list_slots", { requiresWrite: false, requiresConfirmation: false })]),
    );
    expect(layer[0]!.requiresWrite).toBe(true);
  });

  it("a runtime tool in a COMPILED domain populates that domain (Atlassian into pm)", () => {
    const layers = toolLayers(runtimeLayer([descriptor("atlassian", "jira_get_issue", "pm")], lookupOf([])));
    expect(populatedDomains(layers).has("pm")).toBe(true);
    // …and pm is not a runtime-ONLY domain: it is compiled vocabulary.
    expect(runtimeOnlyDomains(layers).has("pm")).toBe(false);
  });
});

describe("tool-layers — the domain universe", () => {
  it("is TOOL_DOMAINS plus every runtime-only domain, each once, compiled first", () => {
    const layers = toolLayers(
      runtimeLayer(
        [
          descriptor("bookings", "list_slots", "ext-bookings"),
          descriptor("bookings", "book_slot", "ext-bookings"),
          descriptor("atlassian", "jira_get_issue", "pm"),
        ],
        lookupOf([]),
      ),
    );
    const universe = toolDomainUniverse(layers);
    expect(universe.slice(0, TOOL_DOMAINS.length)).toEqual([...TOOL_DOMAINS]);
    expect(universe.slice(TOOL_DOMAINS.length)).toEqual(["ext-bookings"]);
    expect([...runtimeOnlyDomains(layers)]).toEqual(["ext-bookings"]);
  });

  it("with no runtime tools the universe is exactly TOOL_DOMAINS", () => {
    expect(toolDomainUniverse(toolLayers())).toEqual([...TOOL_DOMAINS]);
  });
});

describe("tool-layers — loadToolLayers", () => {
  it("reads classification rows only when a runtime tool is registered", async () => {
    const registry = new RuntimeToolRegistry();
    let reads = 0;
    const prisma = {
      remoteToolClassification: {
        findMany: async () => {
          reads += 1;
          return [row("bookings", "list_slots", { requiresWrite: false, requiresConfirmation: false })];
        },
      },
    };
    const empty = await loadToolLayers(prisma as never, registry);
    expect(reads).toBe(0);
    expect(empty.runtime).toEqual([]);

    registry.registerServerTools("bookings", [descriptor("bookings", "list_slots", "ext-bookings")]);
    const loaded = await loadToolLayers(prisma as never, registry);
    expect(reads).toBe(1);
    expect(loaded.runtime).toEqual([
      {
        name: "bookings__list_slots",
        domain: "ext-bookings",
        requiresWrite: false,
        source: "runtime:bookings",
      },
    ]);
  });
});

describe("tool-layers — the synchronous runtime lookup the dispatch sites share", () => {
  it("answers domain + write for a registered, non-denied runtime tool and nothing else", () => {
    const registry = new RuntimeToolRegistry();
    registry.registerServerTools("bookings", [
      descriptor("bookings", "list_slots", "ext-bookings"),
      descriptor("bookings", "cancel_slot", "ext-bookings"),
    ]);
    const lookup = runtimeToolLookupFrom(
      registry,
      lookupOf([
        row("bookings", "list_slots", { requiresWrite: false, requiresConfirmation: false }),
        row("bookings", "cancel_slot", { denied: true }),
      ]),
    );
    expect(lookup("bookings__list_slots")).toEqual({ domain: "ext-bookings", requiresWrite: false });
    expect(lookup("bookings__cancel_slot")).toBeUndefined();
    expect(lookup("bookings__never_registered")).toBeUndefined();
    // A compiled tool is not the runtime lookup's business.
    expect(lookup(TOOL_CATALOG[0]!.name)).toBeUndefined();
  });
});
