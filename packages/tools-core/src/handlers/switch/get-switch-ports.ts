import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const res = await ctx.http.switchSvc.get("/ports", { headers: { Accept: "application/json" } });
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "SWITCH_UNAVAILABLE", message: `switch returned ${res.status}` },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const tool: Tool = {
  name: "get_switch_ports",
  description:
    "Get the status of all ports on the managed PoE switch, including link state, speed, VLAN assignment, and PoE power delivery. The switch has 8 copper PoE ports (1-8) and 2 SFP uplinks (9-10).",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
