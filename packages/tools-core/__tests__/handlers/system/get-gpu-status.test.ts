/**
 * WARP-1861 — `get_gpu_status` LLM tool.
 *
 * Role-gated (owner/admin only, WARP-845 ladder) read of the orchestrator's
 * GET /api/hardware/gpu, which proxies the host device-bridge's read-only
 * /gpu. Tier-1 read.
 *
 * The role gate is the security assertion here, not a formality: that route
 * is `requireRoleOrMcpService`, so on a tool call it only ever sees the
 * mcp-server's `_service:mcp` principal and its owner/admin arm never runs.
 * The handler is the only place the HUMAN's role is checked (WARP-1443
 * established the same for `list_threat_events`), and the payload it guards
 * is host process attribution — pids, comm, full argv, container ids.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import getGpuStatus from "../../../src/handlers/system/get-gpu-status.js";
import type { Role, ToolContext } from "../../../src/types.js";

function ctxWith(get: Mock, role?: Role): ToolContext {
  return {
    http: {
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
      orchestrator: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    ...(role !== undefined ? { role } : {}),
    signal: new AbortController().signal,
  };
}

/** A populated snapshot, as /api/hardware/gpu returns it. */
const SNAPSHOT = {
  available: true,
  card: "card1",
  reason: null,
  busyPercent: 97,
  vramTotalBytes: 17_163_091_968,
  vramUsedBytes: 14_245_395_251,
  vramUsedFraction: 0.83,
  powerWatts: 164,
  tempC: 62,
  processes: [
    { pid: 4242, comm: "ollama", cmdline: "ollama runner --model …", containerId: "a1b2c3d4e5f6" },
  ],
};

function expectError(
  res: Awaited<ReturnType<typeof getGpuStatus.handler>>,
  code: string,
): void {
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe("error");
    expect(res.error.code).toBe(code);
  }
}

describe("get_gpu_status", () => {
  describe("role gate (WARP-845 / WARP-1861)", () => {
    it.each([undefined, "guest", "family", "service"] as const)(
      "role %s → FORBIDDEN with NO HTTP call",
      async (role) => {
        const get = vi.fn();
        const res = await getGpuStatus.handler({}, ctxWith(get, role));
        expectError(res, "FORBIDDEN");
        if (!res.ok) {
          expect(res.error.message).toBe(
            "GPU status is visible to owners and admins only",
          );
        }
        // The process list never leaves the orchestrator for a non-admin.
        expect(get).not.toHaveBeenCalled();
      },
    );

    it.each(["owner", "admin"] as const)("role %s passes", async (role) => {
      const get = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(SNAPSHOT), { status: 200 }));
      const res = await getGpuStatus.handler({}, ctxWith(get, role));
      expect(res.ok).toBe(true);
      expect(get).toHaveBeenCalledWith("/api/hardware/gpu", expect.anything());
    });
  });

  it("returns the orchestrator's GPU snapshot, attribution included", async () => {
    const get = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(SNAPSHOT), { status: 200 }));
    const res = await getGpuStatus.handler({}, ctxWith(get, "owner"));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual(SNAPSHOT);
  });

  it("passes an unavailable snapshot through rather than erroring", async () => {
    // The bridge is profile-gated: absent is an ordinary state (WARP-645),
    // and available:false with a reason is a successful answer.
    const body = {
      available: false,
      reason: "device-bridge unreachable or no auth token configured",
      card: null,
      busyPercent: null,
      processes: [],
    };
    const get = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const res = await getGpuStatus.handler({}, ctxWith(get, "admin"));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual(body);
  });

  it("surfaces GPU_STATUS_FAILED on a non-2xx response", async () => {
    const get = vi.fn().mockResolvedValue(new Response("nope", { status: 503 }));
    const res = await getGpuStatus.handler({}, ctxWith(get, "owner"));
    expectError(res, "GPU_STATUS_FAILED");
    if (!res.ok) expect(res.error.message).toContain("503");
  });
});
