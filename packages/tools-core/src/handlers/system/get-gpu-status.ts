import type { Tool, ToolContext, ToolResult } from "../../types.js";

/** WARP-845 — audience ladder (same table as handlers/network/list-threat-events.ts). */
const ROLE_RANK: Record<string, number> = {
  owner: 3,
  admin: 2,
  family: 1,
  service: 1,
  guest: 0,
};
const ADMIN_RANK = 2;

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

/**
 * WARP-1861 — answer "why is the GPU busy?" without an SSH session.
 *
 * Reads the orchestrator's GET /api/hardware/gpu, which proxies the host
 * device-bridge's read-only /gpu. Dispatched from the orchestrator like every
 * other tool: ai-gateway is a thin provider router and never grows tool
 * dispatch, and the orchestrator is banned from probing /dev/dri itself, so
 * the bridge is the only sanctioned source.
 *
 * The attribution half is the point. `get_system_health` can already say a
 * component is up; nothing could say WHICH PROCESS was holding the card. On
 * this appliance the honest answer to a pinned GPU is usually a named
 * container — the inference runtime serving a chat, or the nightly RAG eval —
 * and without that the user is left guessing at their own hardware.
 *
 * ROLE GATE (WARP-845 / WARP-1443): only `ctx.role` owner or admin may
 * proceed — the ROLE_RANK ladder mirrors handlers/network/list-threat-events.ts.
 * That attribution half is precisely why. It is host process data — pids,
 * comm, full argv, container ids — and ADR-004 keeps host internals to the
 * privileged tiers. The route is owner/admin-gated too, but on a tool call it
 * only ever sees the mcp-server's `_service:mcp` principal, so
 * `requireRoleOrMcpService` short-circuits and its role arm never runs: THIS
 * check is the only thing that sees the human in the chat. Absent role →
 * guest view, i.e. refused.
 *
 * Tier-1 read — no writes, no confirmation.
 */
async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  // Role gate FIRST — see the header comment. Absent role → guest view.
  if ((ROLE_RANK[ctx.role ?? ""] ?? 0) < ADMIN_RANK) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "FORBIDDEN",
        message: "GPU status is visible to owners and admins only",
      },
    };
  }

  const res = await ctx.http.orchestrator.get("/api/hardware/gpu", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "GPU_STATUS_FAILED", message: `gpu endpoint returned ${res.status}` },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const tool: Tool = {
  name: "get_gpu_status",
  // WARP-1891 — kept tight on purpose. Every char here rides in `tools[]` on
  // EVERY chat turn and is charged against the shipping 16384 window (see
  // apps/orchestrator/src/services/base-prompt-budget.test.ts). The verbose
  // first cut of this string put the worst-case turn 19 tokens over the
  // ceiling. Say what it returns, who may call it, when to reach for it, and
  // how to read a null — nothing else.
  description:
    "Live GPU utilisation, VRAM used/total, power, temperature, plus the processes " +
    "holding the card and their containers. Owner/admin only. Use when asked why the " +
    "GPU is busy or hot, or whether a model is running on it. Nulls mean an idle, " +
    "suspended card, not 0%; `available: false` means no GPU was readable.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
