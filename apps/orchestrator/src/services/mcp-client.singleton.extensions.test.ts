/**
 * WARP-2900 (ADR-056 slice H3) — the process-wide multiplexer and
 * extensions.
 *
 *   - an `ext-*` server may attach only while the lifecycle lists it in
 *     installedExtensionIds; nothing else can reach that namespace (WARP-3960:
 *     the env allowlist is gone; the registry never lists an `ext-*` id)
 *     (MUTATION: `installed.has(id)` → `true` → the uninstalled ext id
 *     attaches → red);
 *   - every other id must be one the provider registry declares;
 *   - for `ext-*` the classification record is the whole authority: the
 *     import default is REMOTE_WRITE_NOT_PERMITTED, a reviewed read runs, a
 *     block is final (MUTATION: route ext ids through the composed vendor
 *     policy → the default reads REMOTE_TOOL_NOT_CLASSIFIED → red).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  isRemoteServerAllowed,
  mcpClient,
  remoteCallPolicy,
} from "./mcp-client.singleton.js";
import { installedExtensionIds } from "./extension-lifecycle.service.js";
import {
  remoteToolClassificationCache,
  type RemoteToolClassificationRow,
} from "./remote-tool-classification.service.js";
import type { McpClientPort } from "./mcp-client.port.js";

const PORT: McpClientPort = {
  isStarted: true,
  listTools: async () => [],
  callTool: async () => ({ isError: false, content: [] }),
};

const row = (over: Partial<RemoteToolClassificationRow>): RemoteToolClassificationRow => ({
  serverId: "ext-wc",
  toolName: "word_count",
  requiresWrite: true,
  requiresConfirmation: true,
  denied: false,
  reviewedBy: null,
  reviewedAt: null,
  wireDescription: null,
  firstSeenAt: new Date(),
  lastSeenAt: new Date(),
  ...over,
});

const decide = (serverId: string, wireName: string) =>
  remoteCallPolicy({ serverId, wireName, namespacedName: `${serverId}__${wireName}`, args: {} });

beforeEach(() => {
  installedExtensionIds.clear();
  for (const id of mcpClient.remoteServerIds()) mcpClient.detachRemote(id);
  remoteToolClassificationCache.seed([]);
});

describe("which servers may attach", () => {
  it("an ext id attaches only while the lifecycle has it installed", () => {
    expect(isRemoteServerAllowed("ext-wc")).toBe(false);
    expect(mcpClient.attachRemote("ext-wc", PORT)).toMatchObject({ code: "SERVER_NOT_ALLOWLISTED" });
    installedExtensionIds.add("ext-wc");
    expect(mcpClient.attachRemote("ext-wc", PORT)).toBeNull();
    installedExtensionIds.delete("ext-wc");
    expect(isRemoteServerAllowed("ext-wc")).toBe(false);
  });

  it("an ext id nobody installed is refused, whatever else is registered", () => {
    expect(isRemoteServerAllowed("ext-sneaky")).toBe(false);
    expect(mcpClient.attachRemote("ext-sneaky", PORT)).toMatchObject({ code: "SERVER_NOT_ALLOWLISTED" });
  });

  it("every other id must be a registered server", () => {
    expect(isRemoteServerAllowed("atlassian")).toBe(true);
    expect(isRemoteServerAllowed("vendor")).toBe(false);
  });
});

describe("the call policy for an extension", () => {
  it("never seen → NOT_CLASSIFIED; the import default → WRITE_NOT_PERMITTED; a reviewed read runs; a block is final", () => {
    expect(decide("ext-wc", "word_count")).toMatchObject({ kind: "deny", code: "REMOTE_TOOL_NOT_CLASSIFIED" });
    remoteToolClassificationCache.seed([row({})]);
    expect(decide("ext-wc", "word_count")).toMatchObject({ kind: "deny", code: "REMOTE_WRITE_NOT_PERMITTED" });
    remoteToolClassificationCache.seed([
      row({ requiresWrite: false, requiresConfirmation: false, reviewedBy: "owner", reviewedAt: new Date() }),
    ]);
    expect(decide("ext-wc", "word_count")).toEqual({ kind: "allow" });
    remoteToolClassificationCache.seed([row({ denied: true, reviewedBy: "owner", reviewedAt: new Date() })]);
    expect(decide("ext-wc", "word_count")).toMatchObject({ kind: "deny", code: "REMOTE_TOOL_DENIED" });
  });

  it("a vendor server keeps the composed policy (the table's own refusal stands)", () => {
    remoteToolClassificationCache.seed([row({ serverId: "vendor", toolName: "x", allowlisted: true })]);
    expect(decide("vendor", "x")).toMatchObject({ kind: "deny", code: "REMOTE_TOOL_NOT_CLASSIFIED" });
  });
});
