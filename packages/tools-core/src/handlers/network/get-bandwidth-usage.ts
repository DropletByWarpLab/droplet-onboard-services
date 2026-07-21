/**
 * WARP-1443 — `get_bandwidth_usage` LLM tool.
 *
 * WAN bandwidth rollup via the orchestrator's `GET /api/network/summary`
 * (routes/network-throughput.ts): current WAN down/up bps, DNS blocks
 * today, off-LAN bytes this month, active client count. An optional
 * `window` (the throughput route's own enum — 1h | 6h | 24h | 7d) adds
 * the `GET /api/network/throughput?window` time series so the model can
 * talk about trends, not just the latest sample.
 *
 * Accounting is WAN-aggregate only — the sampler records interface
 * totals, so there is no per-device attribution to surface (the
 * description says so to keep the model from promising one).
 *
 * Byte/bps values pass through as received: the routes serialize
 * BigInt-overflow values as decimal strings (`fromBigInt`), and
 * re-parsing them here would reintroduce the precision loss the routes
 * avoid. Tier-1 read — no writes, no confirmation.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

/** Mirrors throughputQuerySchema in routes/network-throughput.ts. */
const WINDOWS = ["1h", "6h", "24h", "7d"] as const;
type Window = (typeof WINDOWS)[number];

interface NetworkSummaryResponse {
  wanDownBps: number | string;
  wanUpBps: number | string;
  clientCount: number;
  dnsBlockedToday: number;
  offLanBytesThisMonth: number | string;
  lastSampleAt: string | null;
}

const inputSchema = {
  type: "object",
  properties: {
    window: {
      type: "string",
      enum: WINDOWS,
      description:
        "Optional time-series window (1h, 6h, 24h, or 7d). Omit for the current rollup only.",
    },
  },
  additionalProperties: false,
} as const;

function bandwidthUnavailable(detail: string): ToolResult {
  return {
    ok: false,
    status: "error",
    error: {
      code: "BANDWIDTH_UNAVAILABLE",
      message: `bandwidth usage is not available — ${detail}`,
    },
  };
}

async function handler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  let window: Window | undefined;
  if (args.window !== undefined) {
    if (
      typeof args.window !== "string" ||
      !(WINDOWS as readonly string[]).includes(args.window)
    ) {
      return {
        ok: false,
        status: "error",
        error: {
          code: "INVALID_ARGS",
          message: `window must be one of ${WINDOWS.join(", ")}`,
        },
      };
    }
    window = args.window as Window;
  }

  let summary: NetworkSummaryResponse;
  let series: unknown[] | undefined;
  try {
    const res = await ctx.http.orchestrator.get("/api/network/summary", {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      return bandwidthUnavailable(`orchestrator returned ${res.status}`);
    }
    summary = (await res.json()) as NetworkSummaryResponse;

    if (window !== undefined) {
      const tRes = await ctx.http.orchestrator.get("/api/network/throughput", {
        params: { window },
        headers: { Accept: "application/json" },
      });
      if (!tRes.ok) {
        return bandwidthUnavailable(
          `orchestrator returned ${tRes.status} for the ${window} series`,
        );
      }
      const payload = (await tRes.json()) as { samples?: unknown };
      series = Array.isArray(payload.samples) ? payload.samples : [];
    }
  } catch {
    return bandwidthUnavailable("orchestrator not reachable");
  }

  return {
    ok: true,
    data: {
      type: "get_bandwidth_usage",
      current: {
        wanDownBps: summary.wanDownBps,
        wanUpBps: summary.wanUpBps,
        lastSampleAt: summary.lastSampleAt,
      },
      today: { dnsBlocked: summary.dnsBlockedToday },
      month: { offLanBytes: summary.offLanBytesThisMonth },
      clientCount: summary.clientCount,
      ...(series !== undefined ? { series } : {}),
    },
  };
}

const tool: Tool = {
  name: "get_bandwidth_usage",
  description:
    "WAN bandwidth usage: current down/up throughput, DNS queries blocked today, off-LAN bytes this month, and active client count. Pass `window` (1h, 6h, 24h, 7d) to also get the throughput time series for trend questions. WAN-aggregate only — the box does not track per-device bandwidth, so don't promise a per-device breakdown. Tier-1 read; safe to call without operator confirmation.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
