/**
 * WARP-2900 (ADR-056 slice H3) — the process-wide multiplexer and
 * extensions.
 *
 *   - an `ext-*` server may attach only while the lifecycle lists it in
 *     installedExtensionIds; the env allowlist cannot reach that namespace
 *     (MUTATION: `allowlist.has(id) || installed.has(id)` → the env-listed
 *     ext id attaches → red);
 *   - every other id is still the operator allowlist;
 *   - for `ext-*` the classification record is the whole authority: the
 *     import default is REMOTE_WRITE_NOT_PERMITTED, a reviewed read runs, a
 *     block is final (MUTATION: route ext ids through the composed vendor
 *     policy → the default reads REMOTE_TOOL_NOT_CLASSIFIED → red).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// The allowlist is read once, when the singleton loads: an operator who listed
// an ext id by hand, next to a vendor server.
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, config: { ...actual.config, REMOTE_MCP_SERVER_ALLOWLIST: "atlassian,ext-sneaky" } };
});

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

  it("the env allowlist does not reach the ext namespace", () => {
    expect(isRemoteServerAllowed("ext-sneaky")).toBe(false);
    expect(mcpClient.attachRemote("ext-sneaky", PORT)).toMatchObject({ code: "SERVER_NOT_ALLOWLISTED" });
  });

  it("every other id is still the operator allowlist", () => {
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
    remoteToolClassificationCache.seed([row({ serverId: "vendor", toolName: "x" })]);
    expect(decide("vendor", "x")).toMatchObject({ kind: "deny", code: "REMOTE_TOOL_NOT_CLASSIFIED" });
  });
});
