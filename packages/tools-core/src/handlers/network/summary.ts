/**
 * WARP-470 — `network_summary` LLM tool.
 *
 * Wraps the orchestrator's `GET /api/network/summary` into a Tier-1
 * read returning the FEATURES.md §2.2.3 `network_check` card shape:
 * rolled-up KPI grid + a one-paragraph summary the LLM can riff on.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

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
  properties: {},
  additionalProperties: false,
} as const;

function fmtBps(v: number | string): string {
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n) || n <= 0) return "0 bps";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} Gbps`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} Mbps`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} Kbps`;
  return `${n} bps`;
}

async function handler(
  _args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const res = await ctx.http.orchestrator.get("/api/network/summary", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "NETWORK_SUMMARY_FAILED",
        message: `orchestrator returned ${res.status}`,
      },
    };
  }
  const data = (await res.json()) as NetworkSummaryResponse;
  const summary =
    data.lastSampleAt === null
      ? "No WAN throughput samples yet — the routing service sampler hasn't recorded any data."
      : `WAN ${fmtBps(data.wanDownBps)} down / ${fmtBps(data.wanUpBps)} up, ${data.clientCount} active client(s), ${data.dnsBlockedToday} DNS query/queries blocked today, ${data.offLanBytesThisMonth} byte(s) off-LAN this month.`;
  return {
    ok: true,
    data: {
      type: "network_check",
      kpis: {
        wanDownBps: data.wanDownBps,
        wanUpBps: data.wanUpBps,
        wanDownLabel: fmtBps(data.wanDownBps),
        wanUpLabel: fmtBps(data.wanUpBps),
        clientCount: data.clientCount,
        dnsBlockedToday: data.dnsBlockedToday,
        offLanBytesThisMonth: data.offLanBytesThisMonth,
      },
      summary,
      lastSampleAt: data.lastSampleAt,
    },
  };
}

const tool: Tool = {
  name: "network_summary",
  description:
    "Get a one-shot snapshot of network health: WAN throughput, active client count, DNS queries blocked today, off-LAN bytes this month. Returns a network_check card the dashboard renders as a KPI grid + summary. Tier-1 read; safe to call without operator confirmation. Use when the user asks status-shape questions like 'how's the network?' or 'anything weird?'",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
