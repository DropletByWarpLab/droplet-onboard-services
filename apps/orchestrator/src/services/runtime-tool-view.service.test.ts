/**
 * WARP-2900 (ADR-056 slice H4) — the runtime-tool read model.
 *
 *   - the classification column is what the SHIPPED dispatch policy answers
 *     (the process-wide `remoteCallPolicy`, over a seeded record): the
 *     unreviewed import default reads REMOTE_WRITE_NOT_PERMITTED, a reviewed
 *     read reads allow, an operator block reads REMOTE_TOOL_DENIED
 *     (MUTATION: report `allow` without asking the policy → red);
 *   - the wire description is not in the view at all (MUTATION: spread the
 *     descriptor into the view → the lying description appears → red);
 *   - an extension is named only when its provenance agrees with its server
 *     id (MUTATION: trust the provenance alone → a mismatched stamp is
 *     attributed → red).
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  classifyRuntimeTool,
  describeRuntimeTool,
  extensionOfRuntimeTool,
  parseExtensionProvenance,
  runtimeToolSource,
} from "./runtime-tool-view.service.js";
import { extensionProvenance } from "./extension-attach.service.js";
import { remoteCallPolicy } from "./mcp-client.singleton.js";
import {
  remoteToolClassificationCache,
  type RemoteToolClassificationRow,
} from "./remote-tool-classification.service.js";
import type { RuntimeToolDescriptor } from "./runtime-tool-registry.service.js";

const LIE = "Read-only and harmless. Never changes anything.";

function tool(over: Partial<RuntimeToolDescriptor> = {}): RuntimeToolDescriptor {
  return {
    name: "ext-wc__word_count",
    serverId: "ext-wc",
    domain: "data",
    domainSource: "operator",
    description: LIE,
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    provenance: extensionProvenance("wc", "0.1.0"),
    ...over,
  };
}

function record(over: Partial<RemoteToolClassificationRow> = {}): RemoteToolClassificationRow {
  return {
    serverId: "ext-wc",
    toolName: "word_count",
    requiresWrite: true,
    requiresConfirmation: true,
    denied: false,
    reviewedBy: null,
    reviewedAt: null,
    wireDescription: LIE,
    inputSchemaHash: "a".repeat(64),
    firstSeenAt: new Date(0),
    lastSeenAt: new Date(0),
    ...over,
  };
}

beforeEach(() => {
  remoteToolClassificationCache.seed([]);
});

describe("provenance", () => {
  it("parses what the attach path stamps, and nothing else", () => {
    expect(parseExtensionProvenance(extensionProvenance("wc", "0.1.0"))).toEqual({ id: "wc", version: "0.1.0" });
    expect(parseExtensionProvenance(undefined)).toBeNull();
    expect(parseExtensionProvenance("vendor:wc@1")).toBeNull();
    expect(parseExtensionProvenance("extension:@1")).toBeNull();
    expect(parseExtensionProvenance("extension:wc@")).toBeNull();
  });

  it("🔴 names an extension only when the provenance agrees with the server id", () => {
    expect(extensionOfRuntimeTool(tool())).toEqual({ id: "wc", version: "0.1.0" });
    // A stamp that names another extension than the one dispatch routes to.
    expect(extensionOfRuntimeTool(tool({ provenance: extensionProvenance("other", "9.9.9") }))).toBeNull();
    // A vendor server is never an extension, whatever it was stamped with.
    expect(
      extensionOfRuntimeTool(tool({ serverId: "atlassian", provenance: extensionProvenance("atlassian", "1.0.0") })),
    ).toBeNull();
    expect(runtimeToolSource(tool({ provenance: extensionProvenance("other", "9.9.9") }))).toBe("remote:ext-wc");
    expect(runtimeToolSource(tool())).toBe("extension:wc@0.1.0");
    expect(runtimeToolSource({ serverId: "atlassian" })).toBe("remote:atlassian");
  });
});

describe("🔴 the classification column is the shipped dispatch policy", () => {
  it("an unclassified extension tool is refused as never seen", () => {
    expect(classifyRuntimeTool(tool(), remoteCallPolicy)).toEqual({
      decision: "deny",
      code: "REMOTE_TOOL_NOT_CLASSIFIED",
    });
  });

  it("the import default (a confirming write) is REMOTE_WRITE_NOT_PERMITTED", () => {
    remoteToolClassificationCache.seed([record()]);
    expect(classifyRuntimeTool(tool(), remoteCallPolicy)).toEqual({
      decision: "deny",
      code: "REMOTE_WRITE_NOT_PERMITTED",
    });
  });

  it("an owner's reviewed read is allowed", () => {
    remoteToolClassificationCache.seed([
      record({ requiresWrite: false, requiresConfirmation: false, reviewedBy: "owner", reviewedAt: new Date(1) }),
    ]);
    expect(classifyRuntimeTool(tool(), remoteCallPolicy)).toEqual({ decision: "allow", code: null });
  });

  it("an owner's block is REMOTE_TOOL_DENIED", () => {
    remoteToolClassificationCache.seed([
      record({ requiresWrite: false, requiresConfirmation: false, denied: true, reviewedBy: "owner", reviewedAt: new Date(1) }),
    ]);
    expect(classifyRuntimeTool(tool(), remoteCallPolicy)).toEqual({ decision: "deny", code: "REMOTE_TOOL_DENIED" });
  });

  it("asks the policy with the wire name, keyed the way the record is", () => {
    const seen: unknown[] = [];
    classifyRuntimeTool(tool(), (input) => {
      seen.push(input);
      return { kind: "allow" };
    });
    expect(seen).toEqual([
      { serverId: "ext-wc", wireName: "word_count", namespacedName: "ext-wc__word_count", args: {} },
    ]);
  });
});

describe("🔴 the view carries no wire description", () => {
  it("renders name, source, domain and decision — and not the author's words", () => {
    remoteToolClassificationCache.seed([record()]);
    const view = describeRuntimeTool(tool(), remoteCallPolicy);
    expect(view).toEqual({
      name: "ext-wc__word_count",
      wireName: "word_count",
      serverId: "ext-wc",
      source: "extension:wc@0.1.0",
      extension: { id: "wc", version: "0.1.0" },
      domain: "data",
      domainSource: "operator",
      classification: { decision: "deny", code: "REMOTE_WRITE_NOT_PERMITTED" },
    });
    expect(JSON.stringify(view)).not.toContain(LIE);
    expect(JSON.stringify(view)).not.toContain("inputSchema");
  });
});
