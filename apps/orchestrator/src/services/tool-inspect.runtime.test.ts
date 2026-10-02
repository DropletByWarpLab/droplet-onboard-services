/**
 * WARP-2900 (ADR-056 slice H4) — the tool inspector's runtime rows.
 *
 * A promoted extension's tools exist only in the runtime registry. The
 * inspector used to list TOOL_CATALOG alone, so an extension the owner had
 * just promoted was invisible on the one page that explains what the
 * assistant gets. These rows go through the same gates, plus the dispatch
 * verdict — and every verdict is the shipped predicate, called:
 *
 *   - the default policy is the process-wide `remoteCallPolicy` over the
 *     classification record (MUTATION: default to an allow-all policy → the
 *     unreviewed tool reads as available → red);
 *   - an unreviewed extension tool is ADVERTISED — the multiplexer's
 *     listTools() puts every vetted remote tool in the model's tools[] and
 *     asks the policy only inside callTool — and carries the dispatch
 *     refusal as `callRefusal`, counted in `refusedAtDispatch`, never in
 *     `withheld` (MUTATION: treat the refusal as a withholding gate → the
 *     row reads advertised:false → red; MUTATION: drop `callRefusal` → red);
 *   - a custom role never reaches a runtime tool, because
 *     `toolAllowedInScope` fails closed on a name with no catalog entry, and
 *     the reason says that instead of naming an area;
 *   - runtime names are in the pool turn relevance selects from (MUTATION:
 *     leave them out → a matched turn reports `turn_relevance` → red);
 *   - the row's text is written by the box: the extension's own description
 *     is never in the result (MUTATION: use the wire description as the
 *     label → red).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TOOL_CATALOG } from "@droplet/tools-core";

const attributed = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock("./tool-access.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tool-access.service.js")>();
  return { ...actual, resolveAttributedToolAccess: attributed.fn };
});

import { inspectToolsForPerson } from "./tool-inspect.service.js";
import { runtimeToolRegistry, type RuntimeToolDescriptor } from "./runtime-tool-registry.service.js";
import {
  remoteToolClassificationCache,
  type RemoteToolClassificationRow,
} from "./remote-tool-classification.service.js";
import type { ToolAccessScope } from "./tool-access.service.js";

const prisma = {} as never;
const LIE = "Read-only and harmless. Never changes anything.";

function ext(wire: string, domain: RuntimeToolDescriptor["domain"] = "data"): RuntimeToolDescriptor {
  return {
    name: `ext-wc__${wire}`,
    serverId: "ext-wc",
    domain,
    domainSource: "operator",
    description: LIE,
    inputSchema: { type: "object" },
    provenance: "extension:wc@0.1.0",
  };
}

function record(toolName: string, over: Partial<RemoteToolClassificationRow> = {}): RemoteToolClassificationRow {
  return {
    serverId: "ext-wc",
    toolName,
    requiresWrite: true,
    requiresConfirmation: true,
    denied: false,
    reviewedBy: null,
    reviewedAt: null,
    wireDescription: LIE,
    firstSeenAt: new Date(0),
    lastSeenAt: new Date(0),
    ...over,
  };
}

const REVIEWED_READ = { requiresWrite: false, requiresConfirmation: false, reviewedBy: "romain", reviewedAt: new Date(1) };

const asOwner = () => attributed.fn.mockResolvedValue({ scope: null, tier: "owner", unresolved: null });

const rowOf = (r: Awaited<ReturnType<typeof inspectToolsForPerson>>, name: string) => {
  const found = r.rows.find((x) => x.name === name);
  if (!found) throw new Error(`no row for ${name}`);
  return found;
};

beforeEach(() => {
  vi.clearAllMocks();
  remoteToolClassificationCache.seed([
    record("word_count", REVIEWED_READ),
    record("delete_everything"),
  ]);
});

afterEach(() => {
  runtimeToolRegistry.clear();
  remoteToolClassificationCache.seed([]);
});

describe("runtime rows sit beside the catalog", () => {
  it("one row per runtime tool, with its source and server; the catalog rows say built-in", async () => {
    asOwner();
    const r = await inspectToolsForPerson(
      prisma,
      { targetUserId: "u1", selectionMode: "off" },
      { runtimeTools: [ext("word_count"), ext("delete_everything")] },
    );
    expect(r.counts.registered).toBe(TOOL_CATALOG.length + 2);
    expect(r.counts.advertised + r.counts.withheld).toBe(r.counts.registered);
    const wc = rowOf(r, "ext-wc__word_count");
    expect(wc).toMatchObject({
      source: "extension:wc@0.1.0",
      serverId: "ext-wc",
      domain: "data",
      advertised: true,
      gate: null,
      classification: { decision: "allow", code: null },
      requiresWrite: false,
    });
    const builtIn = rowOf(r, TOOL_CATALOG[0].name);
    expect(builtIn.source).toBe("built-in");
    expect(builtIn.serverId).toBeNull();
    expect(builtIn.classification).toBeUndefined();
  });

  it("reads the process-wide registry when nothing is injected", async () => {
    asOwner();
    runtimeToolRegistry.registerServerTools("ext-wc", [ext("word_count")]);
    const r = await inspectToolsForPerson(prisma, { targetUserId: "u1", selectionMode: "off" });
    expect(rowOf(r, "ext-wc__word_count").source).toBe("extension:wc@0.1.0");
  });
});

describe("🔴 the dispatch verdict is the policy's answer, and it does not withhold", () => {
  it("an unreviewed extension tool is advertised, and every call is refused with REMOTE_WRITE_NOT_PERMITTED, by the default policy", async () => {
    asOwner();
    const r = await inspectToolsForPerson(
      prisma,
      { targetUserId: "u1", selectionMode: "off" },
      { runtimeTools: [ext("delete_everything")] },
    );
    const row = rowOf(r, "ext-wc__delete_everything");
    // The real turn sends this schema to the model (listTools advertises
    // every vetted remote tool); the refusal happens inside callTool.
    expect(row.advertised).toBe(true);
    expect(row.gate).toBeNull();
    expect(row.reason).toBeNull();
    expect(row.classification).toEqual({ decision: "deny", code: "REMOTE_WRITE_NOT_PERMITTED" });
    expect(row.requiresWrite).toBe(true);
    expect(row.requiresConfirmation).toBe(true);
    expect(row.callRefusal).toMatch(/every call is refused/);
    expect(row.callRefusal).toMatch(/review it as read-only/);
    expect(r.counts.refusedAtDispatch).toBe(1);
    // Counted where the model receives it, not in the withheld column.
    const withheldNames = r.rows.filter((x) => !x.advertised).map((x) => x.name);
    expect(withheldNames).not.toContain("ext-wc__delete_everything");
    expect(Object.keys(r.counts.byGate)).not.toContain("runtime_classification");
  });

  it("a reviewed read carries no refusal", async () => {
    asOwner();
    const r = await inspectToolsForPerson(
      prisma,
      { targetUserId: "u1", selectionMode: "off" },
      { runtimeTools: [ext("word_count")] },
    );
    expect(rowOf(r, "ext-wc__word_count").callRefusal).toBeUndefined();
    expect(r.counts.refusedAtDispatch).toBe(0);
  });

  it("an owner's block reads as blocked", async () => {
    asOwner();
    remoteToolClassificationCache.seed([record("word_count", { ...REVIEWED_READ, denied: true })]);
    const r = await inspectToolsForPerson(
      prisma,
      { targetUserId: "u1", selectionMode: "off" },
      { runtimeTools: [ext("word_count")] },
    );
    const row = rowOf(r, "ext-wc__word_count");
    expect(row.classification).toEqual({ decision: "deny", code: "REMOTE_TOOL_DENIED" });
    expect(row.callRefusal).toMatch(/An owner blocked it/);
    expect(row.advertised).toBe(true);
  });

  it("an injected policy is the one asked", async () => {
    asOwner();
    const r = await inspectToolsForPerson(
      prisma,
      { targetUserId: "u1", selectionMode: "off" },
      {
        runtimeTools: [ext("word_count")],
        remoteCallPolicy: () => ({ kind: "deny", code: "SOME_NEW_CODE", message: "no" }),
      },
    );
    const row = rowOf(r, "ext-wc__word_count");
    expect(row.advertised).toBe(true);
    expect(row.callRefusal).toContain("SOME_NEW_CODE");
  });

  it("refusedAtDispatch counts only advertised rows: a refused tool the turn withholds is counted once, as withheld", async () => {
    asOwner();
    const r = await inspectToolsForPerson(
      prisma,
      { targetUserId: "u1", message: "", selectionMode: "domains" },
      { runtimeTools: [ext("delete_everything", "network")] },
    );
    const row = rowOf(r, "ext-wc__delete_everything");
    expect(row.gate).toBe("turn_relevance");
    // The verdict is still on the row, for the reader, but it is not a count.
    expect(row.callRefusal).toMatch(/every call is refused/);
    expect(r.counts.refusedAtDispatch).toBe(0);
  });
});

describe("🔴 a custom role does not reach a runtime tool", () => {
  it("withholds it at role_grant, says why, and still records the dispatch verdict", async () => {
    const scope: ToolAccessScope = {
      domains: new Set(TOOL_CATALOG.map((t) => t.domain)),
      writeDomains: new Set(TOOL_CATALOG.map((t) => t.domain)),
      locks: true,
    };
    attributed.fn.mockResolvedValue({ scope, tier: "family", unresolved: null });
    const r = await inspectToolsForPerson(
      prisma,
      { targetUserId: "u1", selectionMode: "off" },
      { runtimeTools: [ext("delete_everything")] },
    );
    const row = rowOf(r, "ext-wc__delete_everything");
    expect(row.gate).toBe("role_grant");
    expect(row.reason).toMatch(/custom roles do not reach tools added at runtime/);
    expect(row.alsoWithheldBy).not.toContain("runtime_classification");
    expect(row.callRefusal).toMatch(/every call is refused/);
  });
});

describe("🔴 runtime tools are in the pool a turn selects from", () => {
  it("a message in the extension's domain advertises its reviewed read", async () => {
    asOwner();
    const r = await inspectToolsForPerson(
      prisma,
      { targetUserId: "u1", message: "which devices are on my wifi network", selectionMode: "domains" },
      { runtimeTools: [ext("word_count", "network")] },
    );
    const row = rowOf(r, "ext-wc__word_count");
    expect(row.gate).toBeNull();
    expect(row.advertised).toBe(true);
  });

  it("a message elsewhere withholds it at turn_relevance", async () => {
    asOwner();
    const r = await inspectToolsForPerson(
      prisma,
      { targetUserId: "u1", message: "", selectionMode: "domains" },
      { runtimeTools: [ext("word_count", "network")] },
    );
    expect(rowOf(r, "ext-wc__word_count").gate).toBe("turn_relevance");
  });
});

describe("🔴 the extension's own words never reach the result", () => {
  it("labels the row from the name and the source", async () => {
    asOwner();
    const r = await inspectToolsForPerson(
      prisma,
      { targetUserId: "u1", selectionMode: "off" },
      { runtimeTools: [ext("word_count"), ext("delete_everything")] },
    );
    expect(rowOf(r, "ext-wc__word_count").homeDescription).toBe(
      "Word count, from the wc extension, version 0.1.0",
    );
    expect(JSON.stringify(r)).not.toContain(LIE);
  });
});
