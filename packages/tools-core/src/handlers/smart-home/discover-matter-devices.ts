import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const data = await ctx.matter.discover();
  return { ok: true, data };
}

const tool: Tool = {
  name: "discover_matter_devices",
  description:
    "Scan the local Wi-Fi network for new Matter-compatible devices that haven't been commissioned yet. Returns a list of discovered devices with their discriminator, vendor/product info, and network addresses. The scan takes about 15 seconds.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
