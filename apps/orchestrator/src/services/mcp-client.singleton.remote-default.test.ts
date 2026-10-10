/**
 * WARP-3703 (ADR-043 TC-1.2) / WARP-3960 — a box nobody has signed in on dials nothing.
 *
 * Since WARP-3960 there is no env allowlist, no `remote_mcp` owner switch and no compose
 * profile, so the safety property is no longer "refused at the allowlist". It is: the
 * boot attach is a loop over every registered MCP server, and with NO connection row and
 * NO sign-in every iteration is refused at the connection gate — one row read, no client
 * constructed, no byte on the wire — and the server is registered as `detached` /
 * `gate_refused`, which is what lets the reconciler attach it the moment a sign-in
 * connects (no restart, no env).
 *
 * This file imports the REAL singleton under the REAL default config (no mock of
 * `../config.js`), so the config here is the one a fresh box has. The stdio child is
 * never started and nothing is listened to.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ensureRemoteMcpAttached, isRemoteServerAllowed } from "./mcp-client.singleton.js";
import { remoteMcpLifecycle } from "./remote-mcp-lifecycle.service.js";

vi.mock("./activity.singleton.js", () => ({
  recordActivity: vi.fn(async () => null),
  getActivitySigner: () => null,
}));

const fetchSpy = vi.fn(async () => {
  throw new Error("nothing may dial before a sign-in exists");
});
const findFirst = vi.fn(async () => null);
// No `offLanAllowlistChannel` and no env: neither exists any more.
// Nobody has signed in (WARP-3961: a CONNECTED sign-in is the only credential).
const prisma = { integrationConnection: { findFirst }, mcpOAuthConnection: { count: vi.fn(async () => 0), findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchSpy);
  for (const reg of remoteMcpLifecycle.list()) remoteMcpLifecycle.unregister(reg.serverId);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a registered server needs no env and no switch (WARP-3960)", () => {
  it("every registered MCP server is allowed to attach, with default config", () => {
    expect(isRemoteServerAllowed("atlassian")).toBe(true);
  });

  it("an unregistered id is still refused, and so is an ext-* id nobody installed", () => {
    expect(isRemoteServerAllowed("not-a-registered-server")).toBe(false);
    expect(isRemoteServerAllowed("ext-sneaky")).toBe(false);
  });
});

describe("nothing connected attaches nothing and dials nothing", () => {
  it("answers gate_refused for the registered server after reading one row, with no request", async () => {
    const results = await ensureRemoteMcpAttached(prisma);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      attached: false,
      serverId: "atlassian",
      reason: "gate_refused",
    });
    expect(findFirst).toHaveBeenCalledTimes(1);
    // The assertion that matters: ZERO requests, not "no tools came back".
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("registers the server detached, so the reconciler can attach it once a sign-in connects", async () => {
    await ensureRemoteMcpAttached(prisma);
    expect(remoteMcpLifecycle.get("atlassian")).toMatchObject({ state: "detached", reason: "gate_refused" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
