/**
 * WARP-3703 (ADR-043 TC-1.2) — the SHIPPING DEFAULT is still nothing.
 *
 * `REMOTE_MCP_SERVER_ALLOWLIST` is empty on every box that has not been
 * configured, and the boot attach used to be one call that answered
 * `not_allowlisted` having touched nothing. It is now a loop over every
 * registered MCP server, so "dials nothing, ever" has to be restated as a
 * property of the loop: an empty allowlist means every iteration is refused at
 * the first gate — no row read, no client constructed, no byte on the wire — and
 * the lifecycle registry, which is the reconciler's whole work list, stays
 * empty so the reconciler dials nothing either.
 *
 * This file imports the REAL singleton under the REAL default config (no mock of
 * `../config.js`, which is what `mcp-client.singleton.remote-servers.test.ts`
 * does to opt two servers in), so the allowlist here is the one a fresh box
 * has. The stdio child is never started and nothing is listened to.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ensureRemoteMcpAttached, remoteMcpReconcilerDeps } from "./mcp-client.singleton.js";
import { reconcileRemoteMcpSessions } from "./remote-mcp-reconciler.service.js";
import { remoteMcpLifecycle } from "./remote-mcp-lifecycle.service.js";

vi.mock("./activity.singleton.js", () => ({
  recordActivity: vi.fn(async () => null),
  getActivitySigner: () => null,
}));

const fetchSpy = vi.fn(async () => {
  throw new Error("nothing may dial on the shipping default");
});
const findFirst = vi.fn(async () => null);
const prisma = { offLanAllowlistChannel: { findUnique: async () => ({ enabled: true }) }, integrationConnection: { findFirst } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchSpy);
  for (const reg of remoteMcpLifecycle.list()) remoteMcpLifecycle.unregister(reg.serverId);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("an empty allowlist attaches nothing and dials nothing (the shipping default)", () => {
  it("answers not_allowlisted for the one registered server, with no row read and no request", async () => {
    const results = await ensureRemoteMcpAttached(prisma);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      attached: false,
      serverId: "atlassian",
      reason: "not_allowlisted",
    });
    // The assertion that matters: ZERO calls, not "no tools came back".
    expect(findFirst).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("registers nothing, so the reconciler has no work list and dials nothing either", async () => {
    await ensureRemoteMcpAttached(prisma);
    expect(remoteMcpLifecycle.list()).toEqual([]);

    const result = await reconcileRemoteMcpSessions(remoteMcpReconcilerDeps(prisma));
    expect(result.skipped).toBe("nothing_registered");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
