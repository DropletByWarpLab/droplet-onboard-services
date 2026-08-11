import type { Tool, ToolContext, ToolResult } from "../../types.js";

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
 */
async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
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
  description:
    "Live GPU status: utilisation, VRAM used/total, power, temperature — plus " +
    "the processes currently holding the card and which container each belongs " +
    "to. Use when the user asks why the GPU is busy or hot, whether anything is " +
    "using it, or whether a model is actually running on the GPU. Values can be " +
    "null: an idle card is often runtime-suspended and cannot be read, which is " +
    "not the same as 0%. `available: false` means no GPU could be read at all.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
