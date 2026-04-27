import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const res = await ctx.http.switchSvc.post("/wan/detect", undefined);
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "DETECT_FAILED", message: `switch returned ${res.status}` },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const tool: Tool = {
  name: "detect_wan_port",
  description:
    "Auto-detect which switch port is the WAN uplink to the router. Checks SFP ports first, then copper ports with active links. Mutates persisted state.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;
