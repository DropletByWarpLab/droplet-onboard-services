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
 *      never read — a server cannot choose its own privilege level;
 *   4. only an OPERATOR-mapped domain puts a runtime tool in the layer — a
 *      server-declared or defaulted one would let the vendor choose which
 *      role grants admit its tools.
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
  DEFAULT_RUNTIME_TOOL_DOMAIN,
  RuntimeToolRegistry,
  type RuntimeToolDescriptor,
} from "./runtime-tool-registry.service.js";
import type { RemoteToolClassificationRow } from "./remote-tool-classification.service.js";
import {
  narrowToolsToScope,
  toolAllowedInScope,
  type ToolAccessScope,
} from "./tool-access.service.js";

/** A runtime descriptor in an arbitrary domain. The closed ToolDomain union is
 *  the extension-domain decision slice H has not made yet (see the PR), so a
 *  fixture outside it is cast — the layer model itself reads `string`.
 *  Operator-mapped by default, because rules 1–3 are about the classification
 *  record; rule 4's specs override `domainSource` explicitly. */
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
    domainSource: "operator",
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

// PR #2314 review, item 1. A runtime tool's domain now AUTHORIZES it: it picks
// which role grants admit the tool. `resolveRuntimeToolDomain` can produce
// that domain from the operator, from the SERVER's own registration (a hint
// from outside the trust boundary) or from the `data` default (which is
// feature-ungated). Only the first may reach a scoped person. Owners, service
// principals and role-less people carry no scope, so the lookup is never
// consulted for them and they keep every registered runtime tool.
//
// MUTATION: drop the `domainSource !== "operator"` check in `runtimeLayer` →
// the server- and default-sourced specs go red.
describe("tool-layers — only an OPERATOR-mapped domain admits a runtime tool to a scoped role", () => {
  const readRow = (wireName: string) =>
    row("vendor", wireName, { requiresWrite: false, requiresConfirmation: false });
  const rows = [readRow("op_read"), readRow("srv_read"), readRow("def_read")];
  const opTool = descriptor("vendor", "op_read", "pm", { domainSource: "operator" });
  const srvTool = descriptor("vendor", "srv_read", "pm", { domainSource: "server" });
  const defTool = descriptor("vendor", "def_read", DEFAULT_RUNTIME_TOOL_DOMAIN, {
    domainSource: "default",
  });

  /** A scoped role whose grants admit every domain in play, as read AND use:
   *  if a tool is refused below, the grant is not the reason. */
  const scoped: ToolAccessScope = {
    domains: new Set(["pm", DEFAULT_RUNTIME_TOOL_DOMAIN]),
    writeDomains: new Set(["pm", DEFAULT_RUNTIME_TOOL_DOMAIN]),
    locks: false,
  };

  function lookupOver(...tools: RuntimeToolDescriptor[]) {
    const registry = new RuntimeToolRegistry();
    registry.registerServerTools("vendor", tools);
    return runtimeToolLookupFrom(registry, lookupOf(rows));
  }

  it("operator-sourced: reachable for a scoped role whose grant admits its domain", () => {
    const lookup = lookupOver(opTool);
    expect(lookup(opTool.name)).toEqual({ domain: "pm", requiresWrite: false });
    expect(toolAllowedInScope(opTool.name, scoped, lookup)).toBe(true);
    expect(populatedDomains(toolLayers(runtimeLayer([opTool], lookupOf(rows)))).has("pm")).toBe(true);
  });

  it("server-sourced: UNREACHABLE for a scoped role, even with its domain granted and a read row", () => {
    const lookup = lookupOver(srvTool);
    expect(lookup(srvTool.name)).toBeUndefined();
    expect(toolAllowedInScope(srvTool.name, scoped, lookup)).toBe(false);
    // …and it does not populate the domain it claimed, so a grant on `pm`
    // is not kept alive (or made grantable) by a vendor's say-so.
    const layer = runtimeLayer([srvTool], lookupOf(rows));
    expect(layer).toEqual([]);
    expect(populatedDomains(toolLayers(layer)).has("pm")).toBe(false);
  });

  it("default-sourced: UNREACHABLE for a scoped role — the feature-ungated fallback is never a grant", () => {
    const lookup = lookupOver(defTool);
    expect(lookup(defTool.name)).toBeUndefined();
    expect(toolAllowedInScope(defTool.name, scoped, lookup)).toBe(false);
    expect(runtimeLayer([defTool], lookupOf(rows))).toEqual([]);
  });

  it("the layer keeps the operator-sourced tool when all three are registered together", () => {
    const layer = runtimeLayer([opTool, srvTool, defTool], lookupOf(rows));
    expect(layer.map((t) => t.name)).toEqual([opTool.name]);
    const lookup = lookupOver(opTool, srvTool, defTool);
    expect(
      narrowToolsToScope([opTool, srvTool, defTool], scoped, lookup).map((t) => t.name),
    ).toEqual([opTool.name]);
  });

  it("no scope (owner, service, role-less) narrows nothing: every runtime tool stays, whatever its source", () => {
    const lookup = lookupOver(opTool, srvTool, defTool);
    expect(narrowToolsToScope([opTool, srvTool, defTool], null, lookup)).toEqual([
      opTool,
      srvTool,
      defTool,
    ]);
  });
});
