/**
 * WARP-1443 — `get_bandwidth_usage` LLM tool.
 *
 * WAN bandwidth rollup via the orchestrator's `GET /api/network/summary`,
 * plus an optional time series from `GET /api/network/throughput?window`.
 * Tier-1 read — no writes, no confirmation.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import getBandwidthUsage from "../../../src/handlers/network/get-bandwidth-usage.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(orchestratorGet: Mock): ToolContext {
  return {
    http: {
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
      orchestrator: {
        get: orchestratorGet,
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      },
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

// GET /api/network/summary response (network-throughput.ts:62).
const SUMMARY = {
  wanDownBps: 12_500_000,
  wanUpBps: 3_200_000,
  clientCount: 14,
  dnsBlockedToday: 42,
  // BigInt overflow serializes as string on the wire — pass through as-is.
  offLanBytesThisMonth: "9007199254740995",
  lastSampleAt: "2026-07-20T11:59:00.000Z",
};

// GET /api/network/throughput?window response (network-throughput.ts:121).
const THROUGHPUT = {
  window: "1h",
  samples: [
    { ts: "2026-07-20T11:58:00.000Z", wanDownBps: 11_000_000, wanUpBps: 3_000_000 },
    { ts: "2026-07-20T11:59:00.000Z", wanDownBps: 12_500_000, wanUpBps: 3_200_000 },
  ],
};

/** Dispatches on path so one mock serves both routes. */
function routedGet(opts?: {
  summaryStatus?: number;
  throughputStatus?: number;
}): Mock {
  return vi.fn().mockImplementation(async (path: string) => {
    if (path === "/api/network/summary") {
      return new Response(JSON.stringify(SUMMARY), {
        status: opts?.summaryStatus ?? 200,
      });
    }
    return new Response(JSON.stringify(THROUGHPUT), {
      status: opts?.throughputStatus ?? 200,
    });
  });
}

function expectError(
  res: Awaited<ReturnType<typeof getBandwidthUsage.handler>>,
  code: string,
): void {
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe("error");
    expect(res.error.code).toBe(code);
  }
}

describe("get_bandwidth_usage", () => {
  it("returns the summary rollup only when window is omitted", async () => {
    const get = routedGet();
    const res = await getBandwidthUsage.handler({}, ctxWith(get));

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/network/summary", {
      headers: { Accept: "application/json" },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        type: "get_bandwidth_usage",
        current: {
          wanDownBps: SUMMARY.wanDownBps,
          wanUpBps: SUMMARY.wanUpBps,
          lastSampleAt: SUMMARY.lastSampleAt,
        },
        today: { dnsBlocked: SUMMARY.dnsBlockedToday },
        month: { offLanBytes: SUMMARY.offLanBytesThisMonth },
        clientCount: SUMMARY.clientCount,
      });
      // series must be ABSENT (not just undefined-valued) without a window.
      expect(Object.keys(res.data as object)).not.toContain("series");
    }
  });

  it("adds the throughput series when a window is given", async () => {
    const get = routedGet();
    const res = await getBandwidthUsage.handler({ window: "1h" }, ctxWith(get));

    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenNthCalledWith(1, "/api/network/summary", {
      headers: { Accept: "application/json" },
    });
    expect(get).toHaveBeenNthCalledWith(2, "/api/network/throughput", {
      params: { window: "1h" },
      headers: { Accept: "application/json" },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { series?: unknown };
      expect(data.series).toEqual(THROUGHPUT.samples);
    }
  });

  it.each(["1h", "6h", "24h", "7d"] as const)(
    "accepts window %s (the throughput route's enum)",
    async (window) => {
      const get = routedGet();
      const res = await getBandwidthUsage.handler({ window }, ctxWith(get));
      expect(res.ok).toBe(true);
      expect(get).toHaveBeenNthCalledWith(2, "/api/network/throughput", {
        params: { window },
        headers: { Accept: "application/json" },
      });
    },
  );

  it("maps a non-OK summary response to BANDWIDTH_UNAVAILABLE", async () => {
    const get = routedGet({ summaryStatus: 502 });
    const res = await getBandwidthUsage.handler({}, ctxWith(get));
    expectError(res, "BANDWIDTH_UNAVAILABLE");
  });

  it("maps a non-OK throughput response to BANDWIDTH_UNAVAILABLE", async () => {
    const get = routedGet({ throughputStatus: 500 });
    const res = await getBandwidthUsage.handler({ window: "24h" }, ctxWith(get));
    expectError(res, "BANDWIDTH_UNAVAILABLE");
  });

  it("maps a thrown fetch error to BANDWIDTH_UNAVAILABLE", async () => {
    const get = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await getBandwidthUsage.handler({}, ctxWith(get));
    expectError(res, "BANDWIDTH_UNAVAILABLE");
  });

  it("rejects an unknown window with INVALID_ARGS (no HTTP call)", async () => {
    const get = vi.fn();
    const res = await getBandwidthUsage.handler({ window: "3d" }, ctxWith(get));
    expectError(res, "INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects a non-string window with INVALID_ARGS (no HTTP call)", async () => {
    const get = vi.fn();
    const res = await getBandwidthUsage.handler({ window: 24 }, ctxWith(get));
    expectError(res, "INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });
});

describe("get_bandwidth_usage — tool metadata", () => {
  it("is named get_bandwidth_usage and is Tier-1 (no write, no confirm)", () => {
    expect(getBandwidthUsage.name).toBe("get_bandwidth_usage");
    expect(getBandwidthUsage.requiresWrite).toBe(false);
    expect(getBandwidthUsage.requiresConfirmation).toBe(false);
  });

  it("has an additionalProperties:false schema with only the optional window", () => {
    const schema = getBandwidthUsage.inputSchema as {
      additionalProperties?: boolean;
      required?: readonly string[];
      properties?: Record<string, { enum?: readonly string[] }>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toBeUndefined();
    expect(Object.keys(schema.properties ?? {})).toEqual(["window"]);
    expect(schema.properties?.window?.enum).toEqual(["1h", "6h", "24h", "7d"]);
  });

  it("tells the model the accounting is WAN-aggregate only", () => {
    expect(getBandwidthUsage.description).toMatch(/per-device/i);
  });
});
