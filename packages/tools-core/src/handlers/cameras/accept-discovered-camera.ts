import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Camera id from list_discovered_cameras." },
  },
  required: ["id"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const id = typeof args.id === "string" ? args.id : null;
  if (!id) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "id is required" },
    };
  }
  try {
    const camera = await ctx.prisma.camera.update({
      where: { id },
      data: { enabled: true },
    });
    return { ok: true, data: { status: "accepted", camera: (camera as { name: string }).name } };
  } catch (err) {
    return {
      ok: false,
      status: "error",
      error: { code: "ACCEPT_FAILED", message: err instanceof Error ? err.message : String(err) },
    };
  }
}

const tool: Tool = {
  name: "accept_discovered_camera",
  description:
    "Accept a discovered camera into the Frigate config so it starts recording. Pass the `id` from list_discovered_cameras.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;
